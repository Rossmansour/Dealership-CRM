// taskplan.js -- AI task planning.
//
// Every morning when the store opens (and whenever someone asks), each
// salesperson and BDC agent gets their own list of calls, texts, and emails
// for the day, picked from the customers assigned to them: who to reach,
// how, what about, and why. BDC agents work new and not-yet-reached
// customers they're on; everything else goes to the salesperson (Sales 1).
//
// The AI (the same one the rest of the CRM uses) reads a short summary of
// each person's customers -- first name, where they are in the pipeline,
// how long since anyone touched them, the last few notes, the car -- and
// chooses and words the tasks. Phone numbers, emails, and credit apps are
// never sent. Without an AI key (or if it fails), the same lists are planned
// by simple rules instead, so the feature still works.
//
// It never piles on: customers who already have an open task are skipped,
// and each person gets at most the store's daily limit.

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const alerts = require('./alerts');
const hours = require('./hours');
const { inBucket } = require('./duplicates');

const DAY = 86400000;
const TYPES = ['call', 'text', 'email', 'todo'];
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

const OUTREACH = ['call', 'text', 'email'];
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

// ---------- Planning by rules (no AI, or AI failed) ----------

// One touch for a customer nobody has touched today. Their best contact
// method wins; customers who aren't answering alternate call and text.
function ruleTask(c) {
  const lastOut = (c.lead.activities || []).find(a => OUTREACH.includes(a.type));
  const attempts = (c.lead.activities || []).filter(a => OUTREACH.includes(a.type)).length;
  const preferred = ['call', 'text', 'email'].includes(c.lead.bestContact) ? c.lead.bestContact : null;
  const car = c.car ? ` about the ${c.car}` : '';
  const ago = c.idle === 0 ? 'yesterday or earlier today' : `${c.idle} day${c.idle === 1 ? '' : 's'} ago`;
  switch (c.stage) {
    case 'new': return { type: preferred || 'call', title: `First contact${car}`, why: `New ${c.lead.source || ''} lead, nobody has reached out yet.`.replace('  ', ' '), score: 100 };
    case 'attempted':
      return { type: preferred || (lastOut && lastOut.type === 'call' ? 'text' : 'call'), title: `Try again${car}`, why: `${attempts} attempt${attempts === 1 ? '' : 's'} so far with no conversation; last touch ${ago}.`, score: 60 - Math.min(attempts, 10) * 3 + c.idle * 2 };
    case 'engaged': return { type: preferred || 'call', title: `Set an appointment${car}`, why: `Talked before; last contact ${ago}.`, score: 65 + c.idle * 3 };
    case 'visit': return { type: preferred || 'call', title: 'Follow up on the visit', why: `Came in; last contact ${ago}.`, score: 85 + c.idle * 3 };
    case 'proposal': return { type: preferred || 'call', title: 'Follow up on the deal', why: `A deal is being worked; last contact ${ago}.`, score: 90 + c.idle * 3 };
    default: return null;
  }
}

function planByRules(candidates, max) {
  return candidates
    .map(c => ({ c, t: ruleTask(c) }))
    .filter(x => x.t)
    .map(x => ({ ...x, score: x.t.score + (x.c.lead.hot ? 15 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ c, t }) => ({ leadId: c.lead.id, type: t.type, title: t.title, why: t.why }));
}

// ---------- Planning by AI ----------

let aiCall = null;        // (systemInstruction, history, message) => text; set by server.js
let aiConnected = () => false;
function useAI(fn, connected) { aiCall = fn; aiConnected = connected; }

// What the AI sees about one customer. No phone, email, address, or credit app.
function summaryFor(c, i) {
  return {
    ref: i + 1,
    name: firstName(c.lead.name),
    stage: c.stage,
    source: c.lead.source || 'other',
    hot: !!c.lead.hot,
    daysSinceAdded: daysSince(new Date(c.lead.dateAdded).getTime()),
    daysSinceLastTouch: c.idle,
    bestContact: c.lead.bestContact || '',
    vehicle: c.car || '',
    notes: String(c.lead.notes || '').slice(0, 300),
    recent: (c.lead.activities || []).filter(a => a.type !== 'status').slice(0, 4)
      .map(a => ({ type: a.type, daysAgo: daysSince(new Date(a.date).getTime()), talked: !!a.reached, text: String(a.text || '').slice(0, 160) }))
  };
}

function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('The AI did not return a task list.');
  return JSON.parse(t.slice(start, end + 1));
}

async function planByAI(person, candidates, max) {
  const list = candidates.slice(0, 40);
  const system = `You plan the day for a car dealership ${person.role === 'bdc' ? 'BDC agent' : 'salesperson'} named ${firstName(person.name)}.
Nobody has touched any of the customers below yet today, and the store wants every customer touched once a day.
Pick at most ${max} of them (a realistic day), most important first, and write exactly one task for each.
Priorities: new leads nobody has reached; customers with a deal in progress or who visited; hot customers;
engaged customers going cold; then the rest, oldest contact first. Anyone left out rolls to the top tomorrow.
For each task choose "call", "text", or "email" (respect bestContact when it's set; a quick text is fine for
customers who haven't answered several calls). Appointment confirmations are handled separately -- don't add them.
Write a short task title (under 60 characters, what to do) and a one-sentence reason a manager would agree with.
Only use facts from the data. Return ONLY a JSON array like:
[{"ref": 3, "type": "call", "title": "Set a test drive for the Tacoma", "why": "Engaged last week, no contact in 4 days."}]`;
  const text = await aiCall(system, [], `Customers:\n${JSON.stringify(list.map(summaryFor))}`);
  const out = [];
  const seen = new Set();
  for (const t of parseJson(text)) {
    const c = list[Number(t && t.ref) - 1];
    if (!c || seen.has(c.lead.id)) continue;
    seen.add(c.lead.id);
    out.push({
      leadId: c.lead.id,
      type: TYPES.includes(t.type) ? t.type : 'call',
      title: String(t.title || 'Follow up').trim().slice(0, 120),
      why: String(t.why || '').trim().slice(0, 300)
    });
    if (out.length >= max) break;
  }
  return out;
}

// ---------- When tasks are due ----------

// Spread through the day: from now (or opening) every 20 minutes, before close.
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
    return Array.from({ length: count }, (_, k) => new Date(Math.min(start + k * 20 * 60000, close - 15 * 60000)).toISOString());
  }
  return Array.from({ length: count }, (_, k) => new Date(now + (k + 1) * 20 * 60000).toISOString());
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
    const [leads, deals, tasks, cars] = await Promise.all([
      store.list(q, 'leads', dealershipId), store.list(q, 'deals', dealershipId),
      store.list(q, 'tasks', dealershipId), store.list(q, 'cars', dealershipId)
    ]);
    const now = Date.now();
    const sh = settings.storeHours && settings.storeHours.days ? settings.storeHours : hours.defaultStoreHours();
    const tz = sh.timezone;
    const today = dayNumber(now, tz);
    const byId = new Map(leads.map(l => [l.id, l]));

    // Yesterday's planned tasks nobody finished are replaced by today's plan
    // instead of piling up.
    for (const t of tasks) {
      if (t.status !== 'open' || !t.planned || t.type === 'appointment') continue;
      if (userIds && !(t.assignedTo && userIds.includes(String(t.assignedTo.id)))) continue;
      if (dayNumber(new Date(t.dueAt).getTime(), tz) >= today) continue;
      t.status = 'cancelled';
      await store.save(q, 'tasks', dealershipId, t.id, { ...t, completedAt: new Date().toISOString(), completedBy: by, outcome: "Replaced by today's plan" });
    }
    const open = tasks.filter(t => t.status === 'open');
    const appointments = open.filter(t => t.type === 'appointment');
    // An appointment doesn't stop a customer's confirmation call; anything else open does.
    const busy = new Set(open.filter(t => t.type !== 'appointment').map(t => t.leadId));
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
      confirmedLeads.add(lead.id); // an upcoming appointment: no other task needed
      if (!task) continue;
      const preferred = ['call', 'text'].includes(lead.bestContact) ? lead.bestContact : 'call';
      if (!confirmations.has(personId)) confirmations.set(personId, []);
      confirmations.get(personId).push({ lead, type: preferred, title: task.title, why: task.why, appt, kind: task.kind });
    }

    // ----- Everyone else: one touch each, for customers not touched today -----
    const byPerson = new Map();
    const touchedToday = lead => (lead.activities || []).some(a => a.type !== 'status' && dayNumber(new Date(a.date).getTime(), tz) === today);
    for (const lead of leads) {
      if (inBucket(lead) || busy.has(lead.id) || confirmedLeads.has(lead.id) || touchedToday(lead)) continue;
      if (lead.snoozedUntil && new Date(lead.snoozedUntil).getTime() > now) continue;
      const stage = stageOf(lead, deals, openAppointments);
      if (!stage || stage === 'delivered') continue;
      const owner = ownerOf(lead, stage, people);
      if (!owner) continue;
      const carId = lead.carId || (lead.wishList || [])[0];
      if (!byPerson.has(owner)) byPerson.set(owner, []);
      byPerson.get(owner).push({ lead, stage, idle: daysSince(lastTouch(lead)), car: carId ? carLabel.get(carId) || '' : '' });
    }

    let source = aiCall && aiConnected() ? 'ai' : 'rules';
    const results = [];
    let created = 0;
    for (const id of new Set([...confirmations.keys(), ...byPerson.keys()])) {
      const person = people.get(id);
      const list = byPerson.get(id) || [];
      const confirms = confirmations.get(id) || [];
      // Oldest untouched first, so the AI sees the ones that matter if the list is long.
      list.sort((a, b) => (b.lead.hot - a.lead.hot) || (b.idle - a.idle));
      const room = Math.max(0, cfg.maxPerPerson - confirms.length);
      let picks = null;
      if (!room || !list.length) picks = [];
      else if (source === 'ai') {
        try { picks = await planByAI(person, list, room); } catch (err) {
          console.error('AI task planning failed, using rules:', err.message);
          source = 'rules';
        }
      }
      if (!picks) picks = planByRules(list, room);
      const all = [...confirms.map(c => ({ leadId: c.lead.id, type: c.type, title: c.title, why: c.why, confirm: c })), ...picks];
      const due = dueTimes(all.length, settings.storeHours);
      for (const [k, p] of all.entries()) {
        const lead = byId.get(p.leadId);
        const task = {
          type: p.type, title: p.title, notes: p.why, dueAt: due[k],
          assignedTo: { id: person.id, name: person.name },
          id: crypto.randomUUID(), leadId: lead.id, leadName: lead.name, status: 'open',
          createdBy: by, createdAt: new Date().toISOString(), completedAt: null, completedBy: null, outcome: '',
          planned: p.confirm ? 'confirm' : source // 'confirm', 'ai', or 'rules'
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
      results.push({ id, name: person.name, created: all.length, confirmations: confirms.length, left: list.length - picks.length });
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
    return { source, created, people: results };
  });
}

// Someone logged a call, text, email, or visit on a customer: their planned
// task for it is done (nobody should have to tick it off separately).
async function completeByTouch(q, req, leadId, activity) {
  if (!['call', 'text', 'email', 'visit'].includes(activity.type)) return 0;
  const { rows } = await q.query(
    `SELECT id FROM tasks WHERE dealership_id = $1 AND data->>'leadId' = $2 AND data->>'status' = 'open' AND data ? 'planned' AND data->>'type' <> 'appointment'`,
    [req.dealershipId, leadId]);
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

module.exports = { router, plan, sweep, useAI, planByRules, stageOf, dueTimes, settingsFrom, completeByTouch };
