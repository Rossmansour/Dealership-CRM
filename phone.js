// phone.js -- Texts customers send back, and calls.
//
// Each employee can have their own business number (Admin -> Users). Texts
// sent from the CRM go out from it, and when a customer texts that number
// (or the store's main number), Twilio hands the message to /twilio/sms
// here. It's matched to the customer by phone number -- a number we don't
// know becomes a new customer -- and lands in their Conversation, counts as
// them engaging, shows as unread in Messages, and alerts whoever has them.
//
// Customers who text STOP aren't texted again until they text START
// (Twilio also answers those words itself).
//
// Calls: a customer calling an employee's number rings that employee's own
// cell (Admin -> Users), showing the customer's number. "Call" on a customer
// page rings the employee's cell first, then connects them to the customer,
// who sees the employee's business number -- never their personal one.
// Every call is logged on the customer with how long it lasted; missed ones
// alert whoever has the customer.

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const alerts = require('./alerts');
const taskplan = require('./taskplan');
const { twiml: { VoiceResponse } } = require('twilio');

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'];
const START_WORDS = ['start', 'unstop', 'yes'];
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
const pretty = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
const duration = sec => { sec = Number(sec) || 0; return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`; };

let webhookToken = () => process.env.TWILIO_AUTH_TOKEN || '';
function setWebhookToken(token) { webhookToken = () => token; }

// Twilio signs every request with the account's auth token; anything
// unsigned or signed wrong is turned away.
function signedByTwilio(req, base) {
  const token = webhookToken();
  if (!token) return false;
  const url = `${base}${req.originalUrl}`;
  const signature = req.get('X-Twilio-Signature') || '';
  return require('twilio').validateRequest(token, signature, url, req.body || {});
}

// Which store and which employee a number belongs to.
async function ownerOf(number) {
  const to = auth.e164(number);
  if (to) {
    const { rows } = await store.pool.query('SELECT id::text AS id, name, dealership_id, cell_phone, direct_number FROM users WHERE direct_number = $1 AND active', [to]);
    if (rows.length) return { dealershipId: rows[0].dealership_id, user: rows[0] };
  }
  // The store's main number (TWILIO_PHONE_NUMBER): the store set in
  // SITE_LEADS_DEALERSHIP_ID, or the first one.
  const dealershipId = process.env.SITE_LEADS_DEALERSHIP_ID ||
    ((await store.pool.query('SELECT id FROM dealerships ORDER BY created_at LIMIT 1')).rows[0] || {}).id;
  return dealershipId ? { dealershipId, user: null } : null;
}

// The customer with this phone number (the most recent one if there are
// several), locked for the update. A number we don't know becomes a new
// customer for the employee whose number it reached.
async function customerFor(q, deps, who, user, from, how) {
  const { rows } = await q.query(
    `SELECT id FROM leads WHERE dealership_id = $1 AND right(regexp_replace(coalesce(data->>'phone', ''), '\\D', '', 'g'), 10) = $2 ORDER BY seq DESC LIMIT 1`,
    [who.dealershipId, last10(from)]);
  if (rows.length) return { lead: await store.get(q, 'leads', who.dealershipId, rows[0].id, { forUpdate: true }), isNew: false };
  const created = await deps.createLead(q, who, {
    name: `${how} from ${pretty(from)}`, phone: from, source: 'phone',
    ...(user ? { sales1Id: user.id } : {})
  });
  await audit.created(q, who, 'lead', created, `New customer from a ${how === 'Text' ? 'text message' : 'phone call'}`);
  return { lead: await store.get(q, 'leads', who.dealershipId, created.id, { forUpdate: true }), isNew: true };
}

// Changes one logged call on a customer once Twilio says how it went.
async function updateCall(q, dealershipId, leadId, activityId, change) {
  const lead = await store.get(q, 'leads', dealershipId, leadId, { forUpdate: true });
  const call = lead && (lead.activities || []).find(a => a.id === activityId);
  if (!call || call.status === 'done') return null;
  Object.assign(call, change(call));
  await store.save(q, 'leads', dealershipId, lead.id, lead);
  return { lead, call };
}

// deps: { createLead(q, who, fields), publicBase(req) }
function publicRouter(deps) {
  const r = express.Router();
  const twiml = res => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const voice = (res, vr) => res.type('text/xml').send(vr.toString());
  const form = express.urlencoded({ extended: false });
  const signed = (req, res, next) => signedByTwilio(req, deps.publicBase(req)) ? next() : res.status(403).send('Forbidden');
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  // Twilio comes back to these with what happened; the URL says which call.
  const back = (req, path, params) => `${deps.publicBase(req)}${path}?${new URLSearchParams(params)}`;

  r.post('/twilio/sms', express.urlencoded({ extended: false }), (req, res, next) => (async () => {
    if (!signedByTwilio(req, deps.publicBase(req))) return res.status(403).send('Forbidden');
    const b = req.body || {};
    const from = auth.e164(b.From);
    if (!from) return twiml(res);
    const owner = await ownerOf(b.To);
    if (!owner) return twiml(res);
    const { dealershipId, user } = owner;
    const body = String(b.Body || '').slice(0, 2000);
    const media = [];
    for (let i = 0; i < Math.min(Number(b.NumMedia) || 0, 10); i++) {
      if (b[`MediaUrl${i}`]) media.push({ url: String(b[`MediaUrl${i}`]), type: String(b[`MediaContentType${i}`] || '') });
    }
    const word = body.trim().toLowerCase();
    const who = { dealershipId, user: { id: null, name: 'Text message', role: 'system' }, ip: req.ip };

    await store.tx(async q => {
      const { lead, isNew } = await customerFor(q, deps, who, user, from, 'Text');
      const activity = {
        id: crypto.randomUUID(), type: 'text', direction: 'in', message: body,
        text: `${body}${media.length ? ` [${media.length} picture${media.length === 1 ? '' : 's'}]` : ''} (customer texted${user ? ` ${user.name}'s number` : ''})`,
        photos: media.filter(m => m.type.startsWith('image/')).map(m => m.url),
        media, date: new Date().toISOString(), by: { id: null, name: lead.name },
        reached: true, // they wrote back: they're engaged
        to: auth.e164(b.To), sid: String(b.MessageSid || '')
      };
      const next = { ...lead, activities: [activity, ...(lead.activities || [])], unreadTexts: (lead.unreadTexts || 0) + 1 };
      if (STOP_WORDS.includes(word)) next.smsOptOut = true;
      if (START_WORDS.includes(word)) next.smsOptOut = false;
      await store.save(q, 'leads', dealershipId, lead.id, next);
      const userIds = [user && user.id, lead.sales1Id, lead.bdc1Id].filter(Boolean).map(String);
      await alerts.notify(q, {
        dealershipId, type: 'text_reply', userIds: [...new Set(userIds)], actorId: null,
        title: `${isNew ? 'New text' : lead.name} ${isNew ? `from ${from}` : 'texted back'}`,
        body: body.slice(0, 140) || (media.length ? '(picture)' : ''), link: { kind: 'lead', id: lead.id }
      });
    });
    twiml(res);
  })().catch(next));

  // ---------- Calls ----------

  // A customer calls an employee's number (or the store's): ring the
  // employee's cell.
  r.post('/twilio/voice', form, signed, wrap(async (req, res) => {
    const b = req.body || {};
    const vr = new VoiceResponse();
    const owner = await ownerOf(b.To);
    const from = auth.e164(b.From);
    if (!owner || !from) { vr.say('Sorry, this number is not in service.'); return voice(res, vr); }
    const { dealershipId, user } = owner;
    const who = { dealershipId, user: { id: null, name: 'Phone call', role: 'system' }, ip: req.ip };
    const activity = {
      id: crypto.randomUUID(), type: 'call', direction: 'in', status: 'ringing',
      text: `Incoming call${user ? ` to ${user.name}` : ''} (ringing)`,
      date: new Date().toISOString(), by: user ? { id: user.id, name: user.name } : { id: null, name: 'Store line' },
      from, to: auth.e164(b.To), sid: String(b.CallSid || '')
    };
    const lead = await store.tx(async q => {
      const { lead } = await customerFor(q, deps, who, user, from, 'Call');
      await store.save(q, 'leads', dealershipId, lead.id, { ...lead, activities: [activity, ...(lead.activities || [])] });
      return lead;
    });
    const done = back(req, '/twilio/voice/done', { d: dealershipId, l: lead.id, a: activity.id });
    if (user && user.cell_phone) {
      // Their cell shows the customer's number, like any forwarded call.
      vr.dial({ callerId: from, timeout: 25, action: done }).number(user.cell_phone);
    } else {
      // Nobody to ring (the store line, or no cell on file): it's missed.
      vr.redirect(`${done}&DialCallStatus=no-answer`);
    }
    voice(res, vr);
  }));

  // "Call" on a customer page rang the employee's cell and they picked up:
  // now dial the customer.
  r.post('/twilio/voice/connect', form, signed, wrap(async (req, res) => {
    const { d, l, a } = req.query;
    const vr = new VoiceResponse();
    const lead = await store.get(store.pool, 'leads', String(d), String(l));
    const call = lead && (lead.activities || []).find(x => x.id === a);
    if (!lead || !call || !lead.phone) { vr.say('Sorry, that call could not be connected.'); return voice(res, vr); }
    await store.tx(q => updateCall(q, String(d), lead.id, call.id, () => ({ status: 'dialing', text: `Calling ${lead.name}…` })));
    vr.say(`Connecting you to ${lead.name}.`);
    vr.dial({ callerId: call.from, timeout: 30, action: back(req, '/twilio/voice/done', { d, l, a }) }).number(lead.phone);
    voice(res, vr);
  }));

  // How a call ended: logged with its length, or as missed.
  r.post('/twilio/voice/done', form, signed, wrap(async (req, res) => {
    const { d, l, a } = req.query;
    const b = req.body || {};
    const status = String(req.query.DialCallStatus || b.DialCallStatus || '');
    const secs = Number(b.DialCallDuration) || 0;
    const talked = status === 'completed' && secs > 0;
    const vr = new VoiceResponse();
    const result = await store.tx(async q => {
      const out = await updateCall(q, String(d), String(l), String(a), call => ({
        status: 'done', outcome: talked ? 'answered' : status === 'busy' ? 'busy' : 'missed', seconds: secs, reached: talked,
        text: call.direction === 'in'
          ? (talked ? `Incoming call · ${duration(secs)}` : 'Missed call')
          : (talked ? `Call · ${duration(secs)}` : `Called -- ${status === 'busy' ? 'busy' : 'no answer'}`)
      }));
      if (!out) return null;
      const { lead, call } = out;
      const by = call.by && call.by.id ? call.by : null;
      // A call -- answered or not -- is the day's call to this customer.
      if (talked || call.direction === 'out') {
        await taskplan.completeByTouch(q, { dealershipId: String(d), user: by || { id: null, name: 'Phone call' } }, lead.id, call);
      }
      if (call.direction === 'in' && !talked) {
        const userIds = [by && by.id, lead.sales1Id, lead.bdc1Id].filter(Boolean).map(String);
        await alerts.notify(q, {
          dealershipId: String(d), type: 'missed_call', userIds: [...new Set(userIds)], actorId: null,
          title: `Missed call from ${lead.name}`, body: pretty(call.from), link: { kind: 'lead', id: lead.id }
        });
      }
      return out;
    });
    if (result && result.call.direction === 'in' && !talked) vr.say("Sorry we missed you. We'll call you right back.");
    voice(res, vr);
  }));

  // The employee never picked up their own cell for a "Call": nothing happened.
  r.post('/twilio/voice/leg', form, signed, wrap(async (req, res) => {
    const { d, l, a } = req.query;
    const status = String((req.body || {}).CallStatus || '');
    if (['no-answer', 'busy', 'failed', 'canceled'].includes(status)) {
      await store.tx(q => updateCall(q, String(d), String(l), String(a), call =>
        call.status === 'ringing-you' ? { status: 'done', outcome: 'not-connected', text: "Call didn't go through -- you didn't pick up your phone" } : {}));
    }
    res.status(204).send();
  }));

  return r;
}

// ---------- Messages inbox (signed in) ----------

// deps: { twilio() -> client or null, storeNumber() -> the store's number, publicBase(req) }
function router(deps = {}) {
  const r = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // "Call": ring my cell, then connect me to the customer from my business number.
  r.post('/leads/:id/call', wrap(async (req, res) => {
    const lead = await store.get(store.pool, 'leads', req.dealershipId, req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.phone) return res.status(400).json({ error: 'This customer has no phone number on file.' });
    const client = deps.twilio && deps.twilio();
    if (!client) return res.status(503).json({ error: "Calling isn't set up yet (needs Twilio)." });
    const cell = req.user.cell_phone;
    if (!cell) return res.status(400).json({ error: 'Add your cell phone in Admin → Users first -- calls ring it, then connect you.' });
    const from = req.user.direct_number || deps.storeNumber();
    const activity = {
      id: crypto.randomUUID(), type: 'call', direction: 'out', status: 'ringing-you',
      text: `Calling ${lead.name}… (ringing your phone)`, date: new Date().toISOString(),
      by: { id: req.user.id, name: req.user.name }, from, to: auth.e164(lead.phone)
    };
    await store.tx(async q => {
      const l = await store.get(q, 'leads', req.dealershipId, lead.id, { forUpdate: true });
      await store.save(q, 'leads', req.dealershipId, l.id, { ...l, activities: [activity, ...(l.activities || [])] });
    });
    const ids = new URLSearchParams({ d: req.dealershipId, l: lead.id, a: activity.id });
    const base = deps.publicBase(req);
    try {
      const call = await client.calls.create({
        to: cell, from, url: `${base}/twilio/voice/connect?${ids}`,
        statusCallback: `${base}/twilio/voice/leg?${ids}`, statusCallbackEvent: ['completed']
      });
      await store.tx(q => updateCall(q, req.dealershipId, lead.id, activity.id, () => ({ sid: call.sid })));
    } catch (err) {
      await store.tx(q => updateCall(q, req.dealershipId, lead.id, activity.id, () => ({ status: 'done', outcome: 'failed', text: `Call failed: ${err.message}` })));
      return res.status(502).json({ error: `Couldn't place the call: ${err.message}` });
    }
    res.status(201).json({ activity, message: `Your phone (${pretty(cell)}) is ringing -- pick up and we'll connect you to ${lead.name}.` });
  }));

  // Every customer with texts, newest conversation first. "mine" means the
  // ones I'm assigned to or have texted; managers can see everyone's.
  r.get('/messages', wrap(async (req, res) => {
    const all = req.query.scope === 'all' && auth.can(req.user, 'viewAllReports');
    const me = String(req.user.id);
    const leads = await store.list(store.pool, 'leads', req.dealershipId);
    const out = [];
    for (const l of leads) {
      const texts = (l.activities || []).filter(a => a.type === 'text' || (a.type === 'video' && a.direction));
      if (!texts.length) continue;
      const mine = [l.sales1Id, l.sales2Id, l.bdc1Id, l.bdc2Id].map(String).includes(me) ||
        texts.some(t => (t.by && String(t.by.id) === me) || (t.to && t.to === req.user.direct_number));
      if (!all && !mine) continue;
      const lastText = texts[0];
      out.push({
        leadId: l.id, name: l.name, phone: l.phone || '', unread: l.unreadTexts || 0, optedOut: !!l.smsOptOut,
        last: { direction: lastText.direction || 'out', message: lastText.message ?? lastText.text, date: lastText.date, by: lastText.by ? lastText.by.name : '', photo: !!((lastText.photos || []).length || (lastText.videos || []).length) }
      });
    }
    out.sort((a, b) => new Date(b.last.date) - new Date(a.last.date));
    res.json({ conversations: out.slice(0, 300), myNumber: req.user.direct_number || '', unread: out.filter(c => c.unread).length });
  }));

  // Opening a conversation reads it.
  r.post('/leads/:id/texts/read', wrap(async (req, res) => {
    await store.tx(async q => {
      const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
      if (lead && lead.unreadTexts) await store.save(q, 'leads', req.dealershipId, lead.id, { ...lead, unreadTexts: 0 });
    });
    res.status(204).send();
  }));

  return r;
}

module.exports = { publicRouter, router, setWebhookToken, ownerOf };
