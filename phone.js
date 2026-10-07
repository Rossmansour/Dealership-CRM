// phone.js -- Texts customers send back.
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

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const alerts = require('./alerts');

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'];
const START_WORDS = ['start', 'unstop', 'yes'];
const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);

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
    const { rows } = await store.pool.query('SELECT id::text AS id, name, dealership_id FROM users WHERE direct_number = $1 AND active', [to]);
    if (rows.length) return { dealershipId: rows[0].dealership_id, user: rows[0] };
  }
  // The store's main number (TWILIO_PHONE_NUMBER): the store set in
  // SITE_LEADS_DEALERSHIP_ID, or the first one.
  const dealershipId = process.env.SITE_LEADS_DEALERSHIP_ID ||
    ((await store.pool.query('SELECT id FROM dealerships ORDER BY created_at LIMIT 1')).rows[0] || {}).id;
  return dealershipId ? { dealershipId, user: null } : null;
}

// deps: { createLead(q, who, fields), publicBase(req) }
function publicRouter(deps) {
  const r = express.Router();
  const twiml = res => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

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
      // The customer with this phone number (the most recent one if there are several).
      const { rows } = await q.query(
        `SELECT id FROM leads WHERE dealership_id = $1 AND right(regexp_replace(coalesce(data->>'phone', ''), '\\D', '', 'g'), 10) = $2 ORDER BY seq DESC LIMIT 1`,
        [dealershipId, last10(from)]);
      let lead = rows.length ? await store.get(q, 'leads', dealershipId, rows[0].id, { forUpdate: true }) : null;
      let isNew = false;
      if (!lead) {
        lead = await deps.createLead(q, who, {
          name: `Text from ${from.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')}`, phone: from, source: 'phone',
          ...(user ? { sales1Id: user.id } : {})
        });
        await audit.created(q, who, 'lead', lead, 'New customer from a text message');
        lead = await store.get(q, 'leads', dealershipId, lead.id, { forUpdate: true });
        isNew = true;
      }
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

  return r;
}

// ---------- Messages inbox (signed in) ----------

function router() {
  const r = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
