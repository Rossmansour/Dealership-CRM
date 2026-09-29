// taskplan.js -- AI task planning.
//
// Every morning when the store opens (and whenever someone asks), each
// salesperson and BDC agent gets their own tasks for the day from the
// customers assigned to them. BDC agents work new and not-yet-reached
// customers they're on; everything else goes to the salesperson (Sales 1).
//
//  - New / Attempted: a call, a text, and an email every day.
//  - Engaged / Visit / Proposal: a plan from their notes and what they've
//    asked for (the AI reads them); a text and an email when there are none.
//  - Every customer: one video, carried day to day until it's sent.
//  - Appointments: confirmed a few days before and the day of.
//
// The AI (the same one the rest of the CRM uses) only sees first names,
// pipeline facts, and notes -- never phone numbers, emails, or credit apps.
// Without an AI key (or if it fails), rules plan the same day.
//
// It never piles on: channels already done today are skipped, yesterday's
// unfinished tasks are replaced, logging a contact finishes its task, and
// each person gets at most the store's number of customers a day.

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const alerts = require('./alerts');
const hours = require('./hours');
const { inBucket } = require('./duplicates');

const DAY = 86400000;
const PLANNER = { id: null, name: 'AI planner' };

function defaultSettings() {
  return { enabled: false, maxPerPerson: 15, confirmDaysBefore: 2 };
}
function settingsFrom(s) {
  const p = (s && s.aiTasks) || {};
  const d = defaultSettings();
  const days = Number(p.confirmDaysBefore);
  return {
    enabled: !!p.enabled,
    maxPerPerson: Math.max(1, Math.min(40, Math.round(Number(p.maxPerPerson) || d.maxPerPerson))),
    // Confirm appointments this many days ahead (and always the day of). 0 = only the day of.
    confirmDaysBefore: p.confirmDaysBefore === undefined || p.confirmDaysBefore === '' || Number.isNaN(days) ? d.confirmDaysBefore : Math.max(0, Math.min(7, Math.round(days))),
    lastRun: p.lastRun || null
  };
}

// ---------- Who's where ----------

const OUTREACH = ['call', 'text', 'email', 'video'];
// Same steps as the Sales Pipeline screen.
function stageOf(lead, deals, openAppointments) {
  const mine = deals.filter(d => d.leadId === lead.id);
  if (lead.status === 'won' || mine.some(d => ['delivered', 'closed', 'finalized'].includes(d.status))) return 'delivered';
  if (lead.status === 'lost') return null;
  if (mine.some(d => d.status === 'working')) return 'proposal';
  const acts = lead.activities || [];
  if (acts.some(a => a.type === 'visit')) return 'visit';
  if (acts.some(a => a.reached || a.type === 'appointment') || lead.status === 'negotiating' || openAppointments.has(lead.id)) return 'engaged';
  if (acts.some(a => OUTREACH.includes(a.type)) || lead.status === 'contacted') return 'attempted';
  return 'new';
}

const lastTouch = lead => {
  const touches = (lead.activities || []).filter(a => a.type !== 'status');
  return new Date(touches.length ? touches[0].date : lead.dateAdded).getTime();
};
const daysSince = ms => Math.floor((Date.now() - ms) / DAY);
// A calendar day in the store's time zone, as a number (for "today", "Saturday is 4 days away").
function dayNumber(ms, tz) {
  const t = hours.localDate(ms, tz);
  return Math.round(Date.UTC(t.y, t.m, t.d) / DAY);
}
const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'Customer';

// Who works this customer today: BDC on new / not-reached customers when
// there is one, otherwise the salesperson.
function ownerOf(lead, stage, people) {
  const has = id => id && people.has(String(id));
  if ((stage === 'new' || stage === 'attempted') && has(lead.bdc1Id)) return String(lead.bdc1Id);
  if (has(lead.sales1Id)) return String(lead.sales1Id);
  if (has(lead.bdc1Id)) return String(lead.bdc1Id);
  return null;
}

// ---------- What each customer gets today ----------
//
// Before they're engaged (New, Attempted): a call, a text, and an email every
// day, skipping any channel already done today or that we have no phone /
// email for. Once engaged (Engaged, Visit, Proposal): the plan comes from
// their notes and what they've asked for (the AI reads them); with no notes,
// a text and an email. Every customer also gets one video, carried day to day
// until it's sent.

const PRE_ENGAGED = ['new', 'attempted'];
const hasPhone = lead => String(lead.phone || '').replace(/\D/g, '').length >= 7;
const hasEmail = lead => /\S+@\S+\.\S+/.test(String(lead.email || ''));

function channelsFor(lead, doneToday) {
  return ['call', 'text', 'email'].filter(t => !doneToday.has(t) && (t === 'email' ? hasEmail(lead) : hasPhone(lead)));
}

// What staff wrote about this customer: the notes box and the log (calls,
// texts, emails, notes, visits), newest first.
function notesOf(lead) {
  const log = (lead.activities || []).filter(a => ['note', 'call', 'text', 'email', 'visit'].includes(a.type) && String(a.text || '').trim().length > 3);
  return { notes: String(lead.notes || '').trim(), log };
}
const hasNotes = lead => { const n = notesOf(lead); return !!(n.notes || n.log.length); };

// Who goes first when there isn't room for everyone.
function priority(c) {
  const base = { proposal: 90, visit: 85, new: 100, engaged: 65, attempted: 60 }[c.stage] || 50;
  return base + (c.lead.hot ? 15 : 0) + c.idle * 2;
}

function outreachTasks(c, channels) {
  const car = c.car ? ` the ${c.car}` : '';
  const attempts = (c.lead.activities || []).filter(a => OUTREACH.includes(a.type)).length;
  const first = c.stage === 'new';
  const why = first ? `New ${c.lead.source && c.lead.source !== 'other' ? `${c.lead.source} ` : ''}lead -- nobody has reached them yet.`
    : `${attempts} attempt${attempts === 1 ? '' : 's'} so far with no conversation.`;
  const titles = first
    ? { call: `First call${car ? ` about${car}` : ''}`, text: 'Intro text', email: `Intro email${car ? ` with${car} details` : ''}` }
    : { call: `Call again (attempt ${attempts + 1})`, text: 'Follow-up text', email: `Follow-up email${car ? ` about${car}` : ''}` };
  return channels.map(type => ({ type, title: titles[type], why }));
}

function basicTasks(c, channels) {
  const car = c.car ? ` about the ${c.car}` : '';
  return channels.filter(t => t !== 'call').map(type => ({ type, title: type === 'text' ? `Check-in text${car}` : `Follow-up email${car}`, why: 'Engaged, no notes to go on yet -- keep in touch.' }));
}

// Without the AI: keep in touch by text and email, pointing at the latest note.
function notedTasks(c, channels) {
  const n = notesOf(c.lead);
  const latest = String((n.log[0] && n.log[0].text) || n.notes).replace(/\s+/g, ' ').slice(0, 50);
  return channels.filter(t => t !== 'call').map(type => ({ type, title: `Follow up${type === 'text' ? ' by text' : ' by email'}: ${latest}`, why: 'Based on the latest note.' }));
}

function videoTask(c) {
  return { type: 'video', title: c.car ? `Send a walkaround video of the ${c.car}` : 'Send a personal intro video', why: 'Every customer gets one video; this stays on the list until it is sent.' };
}

// ---------- Planning by AI (engaged customers with notes) ----------

let aiCall = null;        // (systemInstruction, history, message) => text; set by server.js
let aiConnected = () => false;
function useAI(fn, connected) { aiCall = fn; aiConnected = connected; }

// What the AI sees about one customer. No phone, email, address, or credit app.
function summaryFor(c, i) {
  const n = notesOf(c.lead);
  return {
    ref: i + 1,
    name: firstName(c.lead.name),
    stage: c.stage,
    hot: !!c.lead.hot,
    daysSinceLastTouch: c.idle,
    vehicle: c.car || '',
    canUse: c.channels,
    notes: n.notes.slice(0, 500),
    log: n.log.slice(0, 8).map(a => ({ type: a.type, daysAgo: daysSince(new Date(a.date).getTime()), talked: !!a.reached, text: String(a.text || '').slice(0, 240) }))
  };
}

function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('The AI did not return a task list.');
  return JSON.parse(t.slice(start, end + 1));
}

// Returns Map(leadId -> [{ type, title, why }]) built from each customer's notes.
async function planByAI(person, list) {
  const system = `You plan today's follow-up for a car dealership ${person.role === 'bdc' ? 'BDC agent' : 'salesperson'} named ${firstName(person.name)}.
Each customer below has already talked with us. Read their notes and log, find what they asked for or what was promised
(photos, a trade value, numbers, a test drive, a co-signer, a callback time...), and write today's work plan for each:
1 to 3 tasks, each using one of the channels listed in that customer's "canUse", never the same channel twice for a customer.
If nothing specific is pending, a text and an email to keep in touch. Appointment confirmations and videos are handled separately.
Titles: under 60 characters, the concrete thing to do. "why": one sentence pointing at the note it came from.
Only use facts from the data. Return ONLY a JSON array like:
[{"ref": 2, "type": "text", "title": "Send payment options on the Tacoma", "why": "Asked for numbers under $450/mo on Monday's call."}]`;
  const text = await aiCall(system, [], `Customers:\n${JSON.stringify(list.map(summaryFor))}`);
  const out = new Map();
  for (const t of parseJson(text)) {
    const c = list[Number(t && t.ref) - 1];
    if (!c || !c.channels.includes(t.type)) continue;
    const mine = out.get(c.lead.id) || [];
    if (mine.length >= 3 || mine.some(x => x.type === t.type)) continue;
    mine.push({ type: t.type, title: String(t.title || 'Follow up').trim().slice(0, 120), why: String(t.why || '').trim().slice(0, 300) });
    out.set(c.lead.id, mine);
  }
  return out;
}

// ---------- When tasks are due ----------

// Spread through the day: from now (or opening) every 10 minutes, before close.
// After closing, they start at tomorrow's opening instead.
function dueTimes(count, storeHours, now = Date.now()) {
  const h = storeHours && storeHours.days ? storeHours : hours.defaultStoreHours();
  const tz = h.timezone;
  for (let i = 0; i < 8; i++) {
    const noon = hours.localDate(now + i * DAY, tz);
    const rule = h.days[hours.DAYS[noon.dow]];
    if (!rule || rule.closed) continue;
    const [oh, om] = rule.open.split(':').map(Number);
    const [ch, cm] = rule.close.split(':').map(Number);
    const open = hours.zonedToUtc(noon.y, noon.m, noon.d, oh, om, tz);
    const close = hours.zonedToUtc(noon.y, noon.m, noon.d, ch, cm, tz);
    if (now >= close - 30 * 60000) continue;
    const start = Math.max(open, Math.ceil(now / (15 * 60000)) * 15 * 60000);
    return Array.from({ length: count }, (_, k) => new Date(Math.min(start + k * 10 * 60000, close - 15 * 60000)).toISOString());
  }
  return Array.from({ length: count }, (_, k) => new Date(now + (k + 1) * 10 * 60000).toISOString());
}

// ---------- The plan ----------

// Plans today's tasks for everyone (or just userIds) and saves them.
// Returns { source, people: [{ id, name, created }], created }.
async function plan(dealershipId, { userIds = null, by = PLANNER } = {}) {
  return store.tx(async q => {
    // One plan at a time per store.
    await q.query('SELECT 1 FROM dealerships WHERE id = $1 FOR UPDATE', [dealershipId]);
    const d = await store.getDealership(q, dealershipId);
    const settings = (d && d.settings) || {};
    const cfg = settingsFrom(settings);
    const { rows: users } = await q.query(
      `SELECT id::text AS id, name, role FROM users WHERE dealership_id = $1 AND active AND role IN ('salesperson', 'bdc')`, [dealershipId]);
    const people = new Map(users.filter(u => !userIds || userIds.includes(u.id)).map(u => [u.id, u]));
    // One at a time: they share this transaction's connection.
    const leads = await store.list(q, 'leads', dealershipId);
    const deals = await store.list(q, 'deals', dealershipId);
    const tasks = await store.list(q, 'tasks', dealershipId);
    const cars = await store.list(q, 'cars', dealershipId);
    const now = Date.now();
    const sh = settings.storeHours && settings.storeHours.days ? settings.storeHours : hours.defaultStoreHours();
    const tz = sh.timezone;
    const today = dayNumber(now, tz);
    const byId = new Map(leads.map(l => [l.id, l]));

    const dueDay = t => dayNumber(new Date(t.dueAt).getTime(), tz);
    const mineToPlan = t => !userIds || (t.assignedTo && userIds.includes(String(t.assignedTo.id)));

    // Yesterday's planned calls, texts, and emails nobody finished are replaced
    // by today's plan instead of piling up. A video carries over until it's sent.
    let renewed = 0;
    const firstSlot = dueTimes(1, settings.storeHours)[0];
    for (const t of tasks) {
      if (t.status !== 'open' || !t.planned || t.type === 'appointment' || !mineToPlan(t) || dueDay(t) >= today) continue;
      if (t.type === 'video') {
        t.dueAt = firstSlot;
        t.renewedCount = (t.renewedCount || 0) + 1;
        await store.save(q, 'tasks', dealershipId, t.id, t);
        renewed++;
        continue;
      }
      t.status = 'cancelled';
      await store.save(q, 'tasks', dealershipId, t.id, { ...t, completedAt: new Date().toISOString(), completedBy: by, outcome: "Replaced by today's plan" });
    }
    const open = tasks.filter(t => t.status === 'open');
    const appointments = open.filter(t => t.type === 'appointment');
    // A task someone set by hand means that customer is being handled.
    const busy = new Set(open.filter(t => t.type !== 'appointment' && !t.planned).map(t => t.leadId));
    // Planned already today (running it twice doesn't double up).
    const plannedToday = new Map();
    for (const t of open) if (t.planned && t.type !== 'video') plannedToday.set(t.leadId, new Set([...(plannedToday.get(t.leadId) || []), t.type]));
    const videoSent = new Set([
      ...tasks.filter(t => t.type === 'video' && t.status === 'done').map(t => t.leadId),
      ...leads.filter(l => (l.activities || []).some(a => a.type === 'video')).map(l => l.id)
    ]);
    const videoOpen = new Set(open.filter(t => t.type === 'video').map(t => t.leadId));
    const openAppointments = new Set(appointments.map(t => t.leadId));
    const carLabel = new Map(cars.map(c => [c.id, [c.year, c.make, c.model].filter(Boolean).join(' ')]));

    // ----- Must-do: confirm appointments a few days ahead and the day of -----
    const confirmations = new Map(); // person id -> [{ lead, type, title, why }]
    const confirmedLeads = new Set();
    for (const appt of appointments) {
      const lead = byId.get(appt.leadId);
      const personId = appt.assignedTo && String(appt.assignedTo.id);
      if (!lead || !people.has(personId)) continue;
      const at = new Date(appt.dueAt).getTime();
      if (at < now) continue;
      const daysUntil = dayNumber(at, tz) - today;
      const sent = appt.confirmPlanned || {};
      const booked = dayNumber(new Date(appt.createdAt || appt.dueAt).getTime(), tz);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(at));
      const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(at));
      const what = appt.title ? `${appt.title} -- ` : '';
      let task = null;
      if (daysUntil === 0 && !sent.dayOf) {
        task = { kind: 'dayOf', title: `Confirm today's ${time} appointment`, why: `${what}appointment today at ${time}. A quick confirmation cuts no-shows.` };
      } else if (cfg.confirmDaysBefore && daysUntil > 0 && daysUntil <= cfg.confirmDaysBefore && !sent.early && booked < today) {
        // Booked today for a day or two out: confirming right away is pointless (booked < today).
        task = { kind: 'early', title: `Confirm ${weekday}'s ${time} appointment`, why: `${what}appointment ${weekday} at ${time}, ${daysUntil} day${daysUntil === 1 ? '' : 's'} away.` };
      }
      confirmedLeads.add(lead.id); // an upcoming appointment: no daily outreach needed
      if (!task) continue;
      const preferred = ['call', 'text'].includes(lead.bestContact) ? lead.bestContact : 'call';
      if (!confirmations.has(personId)) confirmations.set(personId, []);
      confirmations.get(personId).push({ lead, type: preferred, title: task.title, why: task.why, appt, kind: task.kind });
    }

    // ----- Everyone's customers, with what's still to do today -----
    const byPerson = new Map();
    for (const lead of leads) {
      if (inBucket(lead)) continue;
      if (lead.snoozedUntil && new Date(lead.snoozedUntil).getTime() > now) continue;
      const stage = stageOf(lead, deals, openAppointments);
      if (!stage || stage === 'delivered') continue;
      const owner = ownerOf(lead, stage, people);
      if (!owner) continue;
      const doneToday = new Set((lead.activities || []).filter(a => dayNumber(new Date(a.date).getTime(), tz) === today).map(a => a.type));
      for (const t of plannedToday.get(lead.id) || []) doneToday.add(t);
      const outreach = busy.has(lead.id) || confirmedLeads.has(lead.id) || doneToday.has('visit') ? [] : channelsFor(lead, doneToday);
      const needsVideo = !videoSent.has(lead.id) && !videoOpen.has(lead.id);
      if (!outreach.length && !needsVideo) continue;
      const carId = lead.carId || (lead.wishList || [])[0];
      if (!byPerson.has(owner)) byPerson.set(owner, []);
      byPerson.get(owner).push({ lead, stage, idle: daysSince(lastTouch(lead)), car: carId ? carLabel.get(carId) || '' : '', channels: outreach, needsVideo });
    }

    let source = aiCall && aiConnected() ? 'ai' : 'rules';
    const results = [];
    let created = 0;
    for (const id of new Set([...confirmations.keys(), ...byPerson.keys()])) {
      const person = people.get(id);
      const confirms = confirmations.get(id) || [];
      // A realistic day: at most this many customers get today's outreach;
      // the rest are first in line tomorrow.
      const list = (byPerson.get(id) || []).sort((a, b) => priority(b) - priority(a)).slice(0, cfg.maxPerPerson);
      const left = (byPerson.get(id) || []).length - list.length;
      // Engaged customers with notes: the AI reads them and writes the plan.
      const noted = list.filter(c => !PRE_ENGAGED.includes(c.stage) && c.channels.length && hasNotes(c.lead));
      let fromNotes = new Map();
      let usedAI = false;
      if (noted.length && source === 'ai') {
        try { fromNotes = await planByAI(person, noted); usedAI = true; } catch (err) {
          console.error('AI task planning failed, using rules:', err.message);
          source = 'rules';
        }
      }
      const all = confirms.map(c => ({ leadId: c.lead.id, type: c.type, title: c.title, why: c.why, confirm: c, planned: 'confirm' }));
      for (const c of list) {
        let todo;
        if (PRE_ENGAGED.includes(c.stage)) todo = outreachTasks(c, c.channels).map(t => ({ ...t, planned: 'rules' }));
        else if (!hasNotes(c.lead)) todo = basicTasks(c, c.channels).map(t => ({ ...t, planned: 'rules' }));
        else if (usedAI && (fromNotes.get(c.lead.id) || []).length) todo = fromNotes.get(c.lead.id).map(t => ({ ...t, planned: 'ai' }));
        else todo = notedTasks(c, c.channels).map(t => ({ ...t, planned: 'rules' }));
        if (c.needsVideo) todo.push({ ...videoTask(c), planned: 'video' });
        for (const t of todo) all.push({ leadId: c.lead.id, ...t });
      }
      const due = dueTimes(all.length, settings.storeHours);
      for (const [k, p] of all.entries()) {
        const lead = byId.get(p.leadId);
        const task = {
          type: p.type, title: p.title, notes: p.why, dueAt: due[k],
          assignedTo: { id: person.id, name: person.name },
          id: crypto.randomUUID(), leadId: lead.id, leadName: lead.name, status: 'open',
          createdBy: by, createdAt: new Date().toISOString(), completedAt: null, completedBy: null, outcome: '',
          planned: p.planned // 'confirm', 'video', 'ai', or 'rules'
        };
        if (p.confirm) {
          task.appointmentId = p.confirm.appt.id;
          // A day-of confirmation is due before the appointment itself.
          const before = new Date(p.confirm.appt.dueAt).getTime() - 60 * 60000;
          if (p.confirm.kind === 'dayOf' && new Date(task.dueAt).getTime() > before) task.dueAt = new Date(Math.max(now, before)).toISOString();
          const appt = p.confirm.appt;
          appt.confirmPlanned = { ...(appt.confirmPlanned || {}), [p.confirm.kind]: new Date().toISOString() };
          await store.save(q, 'tasks', dealershipId, appt.id, appt);
        }
        await store.insert(q, 'tasks', dealershipId, task);
      }
      created += all.length;
      results.push({ id, name: person.name, created: all.length, confirmations: confirms.length, customers: list.length, left });
      if (all.length) {
        await alerts.notify(q, {
          dealershipId, type: 'task_assigned', userIds: [id], actorId: by.id,
          title: `Your day is planned: ${all.length} task${all.length === 1 ? '' : 's'}`,
          body: all.slice(0, 3).map(p => `${byId.get(p.leadId).name} -- ${p.title}`).join(' · '),
          link: null, dueAt: due[0]
        });
      }
    }

    const lastRun = { at: new Date().toISOString(), day: todayKey(settings.storeHours), created, source, by: by.name, people: results.length };
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1',
      [dealershipId, { ...settings, aiTasks: { ...(settings.aiTasks || {}), lastRun } }]);
    await audit.record(q, { dealershipId, user: by.id ? by : { id: null, name: by.name } }, {
      action: 'plan_tasks', entityType: 'settings', entityId: 'ai-tasks', label: 'AI task planning',
      details: `${created} task${created === 1 ? '' : 's'} for ${results.filter(r => r.created).length} people (${source === 'ai' ? 'AI' : 'rules'})`
    });
    return { source, created, renewed, people: results };
  });
}

// Someone logged a call, text, email, or video on a customer: their planned
// task for that is done (nobody should have to tick it off separately). A
// showroom visit covers the day's calls, texts, and emails.
async function completeByTouch(q, req, leadId, activity) {
  const types = activity.type === 'visit' ? ['call', 'text', 'email'] : ['call', 'text', 'email', 'video'].includes(activity.type) ? [activity.type] : [];
  if (!types.length) return 0;
  const { rows } = await q.query(
    `SELECT id FROM tasks WHERE dealership_id = $1 AND data->>'leadId' = $2 AND data->>'status' = 'open' AND data ? 'planned' AND data->>'type' = ANY($3)`,
    [req.dealershipId, leadId, types]);
  for (const { id } of rows) {
    const t = await store.get(q, 'tasks', req.dealershipId, id, { forUpdate: true });
    if (!t || t.status !== 'open') continue;
    await store.save(q, 'tasks', req.dealershipId, t.id, {
      ...t, status: 'done', completedAt: new Date().toISOString(), completedBy: { id: req.user.id, name: req.user.name },
      outcome: `Done -- ${activity.type} logged${activity.reached ? ' (talked)' : ''}`
    });
  }
  return rows.length;
}

function todayKey(storeHours) {
  const tz = (storeHours && storeHours.timezone) || hours.defaultStoreHours().timezone;
  const t = hours.localDate(Date.now(), tz);
  return `${t.y}-${String(t.m + 1).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
}

// Every few minutes: stores with planning on get their day planned once,
// right when they open.
async function sweep() {
  const { rows } = await store.pool.query(`SELECT id, settings FROM dealerships WHERE (settings->'aiTasks'->>'enabled')::boolean IS TRUE`);
  for (const row of rows) {
    const settings = row.settings || {};
    const cfg = settingsFrom(settings);
    const h = settings.storeHours && settings.storeHours.days ? settings.storeHours : hours.defaultStoreHours();
    if (cfg.lastRun && cfg.lastRun.day === todayKey(h)) continue;
    const t = hours.localDate(Date.now(), h.timezone);
    const rule = h.days[hours.DAYS[t.dow]];
    if (!rule || rule.closed) continue;
    const [oh, om] = rule.open.split(':').map(Number);
    const [ch, cm] = rule.close.split(':').map(Number);
    const openAt = hours.zonedToUtc(t.y, t.m, t.d, oh, om, h.timezone);
    const closeAt = hours.zonedToUtc(t.y, t.m, t.d, ch, cm, h.timezone);
    if (Date.now() < openAt || Date.now() > closeAt) continue;
    await plan(row.id).catch(err => console.error('Task planning failed:', err.message));
  }
}

// ---------- Routes ----------

function router() {
  const r = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const manage = auth.requirePermission('manageRotation');

  r.get('/ai-tasks', wrap(async (req, res) => {
    const d = await store.getDealership(store.pool, req.dealershipId);
    res.json({ ...settingsFrom(d && d.settings), aiConnected: !!(aiCall && aiConnected()) });
  }));

  r.put('/ai-tasks', manage, wrap(async (req, res) => {
    const saved = await store.tx(async q => {
      const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
      const settings = rows[0].settings || {};
      const before = settingsFrom(settings);
      const b = req.body || {};
      const next = settingsFrom({ aiTasks: { ...before, ...('enabled' in b ? { enabled: b.enabled === true || b.enabled === 'true' } : {}), ...('maxPerPerson' in b ? { maxPerPerson: b.maxPerPerson } : {}), ...('confirmDaysBefore' in b ? { confirmDaysBefore: b.confirmDaysBefore } : {}) } });
      const { lastRun, ...keep } = next;
      await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, aiTasks: { ...keep, lastRun: before.lastRun } }]);
      await audit.updated(q, req, 'settings', { ...before, id: 'ai-tasks' }, { ...next, id: 'ai-tasks' }, 'AI task planning');
      return { ...keep, lastRun: before.lastRun };
    });
    res.json(saved);
  }));

  // Managers: plan everyone's day now. Salespeople and BDC: plan my own.
  r.post('/ai-tasks/run', wrap(async (req, res) => {
    const everyone = (req.body || {}).everyone === true;
    if (everyone && !auth.can(req.user, 'manageRotation')) return res.status(403).json({ error: 'Ask a manager to plan everyone\'s day.' });
    if (!everyone && !['salesperson', 'bdc'].includes(req.user.role)) return res.status(400).json({ error: 'Planning is for salespeople and BDC agents.' });
    const result = await plan(req.dealershipId, { userIds: everyone ? null : [String(req.user.id)], by: { id: req.user.id, name: req.user.name } });
    res.json(result);
  }));

  return r;
}

module.exports = { router, plan, sweep, useAI, stageOf, dueTimes, settingsFrom, completeByTouch };
