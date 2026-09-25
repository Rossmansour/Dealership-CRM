// reports.js
// The Reports center: lead response time, lead sources, each person's
// activity, appointments, and sold units -- for a date range, a lead
// source, and a person. Every number comes with the records behind it
// (ids), so clicking a number shows exactly which customers it counts.
//
// Managers, admins, and F&I see everyone. Everyone else sees their own
// numbers (their customers, their activity).

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const auth = require('./auth');
const storeHours = require('./hours');

const MIN = 60000;
const HOUR = 60 * MIN;
const SOLD_DEAL = ['delivered', 'closed', 'finalized'];
// What counts as reaching out to a customer (a note or a status change doesn't).
const CONTACT_TYPES = ['call', 'text', 'email', 'visit'];
const isContact = a => CONTACT_TYPES.includes(a.type) ||
  (a.type === 'task' && a.taskStatus !== 'cancelled' && ['call', 'text', 'email'].includes(a.taskType));

// Response time: from when the lead came in to the first call, text,
// email, or showroom visit. null = nobody has reached out yet. With store
// hours, only open-store minutes count (an 11pm lead called at 9:05am
// took 5 minutes).
function firstResponse(lead, hours = null) {
  const added = new Date(lead.dateAdded).getTime();
  const times = (lead.activities || []).filter(isContact).map(a => new Date(a.date).getTime()).filter(t => !Number.isNaN(t));
  if (!times.length) return null;
  const first = Math.min(...times);
  const minutes = hours ? storeHours.businessMinutesBetween(added, first, hours) : Math.max(0, (first - added) / MIN);
  return { at: new Date(first).toISOString(), minutes };
}

const RESPONSE_BUCKETS = [
  { key: 'm5', label: 'Within 5 min', max: 5 },
  { key: 'm15', label: '5-15 min', max: 15 },
  { key: 'h1', label: '15-60 min', max: 60 },
  { key: 'h24', label: '1-24 hours', max: 24 * 60 },
  { key: 'later', label: 'Over 24 hours', max: Infinity }
];

const avg = list => (list.length ? list.reduce((s, n) => s + n, 0) / list.length : null);
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const cell = ids => ({ n: ids.length, ids });
const inRange = (iso, from, to) => { const t = new Date(iso).getTime(); return t >= from && t < to; };

async function loadData(q, dealershipId) {
  const [leads, deals, cars, tasks, users] = await Promise.all([
    store.list(q, 'leads', dealershipId),
    store.list(q, 'deals', dealershipId),
    store.list(q, 'cars', dealershipId),
    store.list(q, 'tasks', dealershipId),
    q.query('SELECT id::text AS id, name, role, active FROM users WHERE dealership_id = $1 ORDER BY name', [dealershipId]).then(r => r.rows)
  ]);
  // Customers' credit apps never go into reports.
  return { leads: leads.map(({ creditApp, ...l }) => l), deals, cars, tasks, users };
}

function isSold(lead, deals) {
  return lead.status === 'won' || deals.some(d => d.leadId === lead.id && SOLD_DEAL.includes(d.status));
}

// ---------- The reports ----------

function responseTime({ leads }, f) {
  const inScope = leads.filter(l => inRange(l.dateAdded, f.from, f.to) && f.leadMatch(l));
  const rows = inScope.map(l => ({ lead: l, resp: firstResponse(l, f.hours) }));
  const responded = rows.filter(r => r.resp);
  const mins = responded.map(r => r.resp.minutes);
  const buckets = RESPONSE_BUCKETS.map((b, i) => {
    const lo = i ? RESPONSE_BUCKETS[i - 1].max : -1;
    return { key: b.key, label: b.label, ...cell(responded.filter(r => r.resp.minutes > lo && r.resp.minutes <= b.max).map(r => r.lead.id)) };
  });
  buckets.push({ key: 'none', label: 'No response yet', ...cell(rows.filter(r => !r.resp).map(r => r.lead.id)) });

  const groupBy = (keyFn, labelFn) => {
    const groups = new Map();
    for (const r of rows) {
      const k = keyFn(r.lead) || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.entries()].map(([k, list]) => {
      const done = list.filter(r => r.resp);
      const m = done.map(r => r.resp.minutes);
      return {
        key: k, label: labelFn(k),
        leads: cell(list.map(r => r.lead.id)),
        avgMinutes: avg(m), medianMinutes: median(m),
        within5: cell(done.filter(r => r.resp.minutes <= 5).map(r => r.lead.id)),
        within60: cell(done.filter(r => r.resp.minutes <= 60).map(r => r.lead.id)),
        none: cell(list.filter(r => !r.resp).map(r => r.lead.id)),
        pctWithin60: pct(done.filter(r => r.resp.minutes <= 60).length, list.length)
      };
    }).sort((a, b) => b.leads.n - a.leads.n);
  };

  return {
    kpis: [
      { key: 'leads', label: 'Leads', value: rows.length, ids: rows.map(r => r.lead.id) },
      { key: 'avg', label: 'Average response', minutes: avg(mins) },
      { key: 'median', label: 'Median response', minutes: median(mins) },
      { key: 'within5', label: 'Within 5 min', percent: pct(buckets[0].n, rows.length), ids: buckets[0].ids },
      { key: 'within60', label: 'Within 1 hour', percent: pct(responded.filter(r => r.resp.minutes <= 60).length, rows.length), ids: responded.filter(r => r.resp.minutes <= 60).map(r => r.lead.id) },
      { key: 'none', label: 'No response yet', value: buckets[5].n, ids: buckets[5].ids, warn: buckets[5].n > 0 }
    ],
    buckets,
    bySalesperson: groupBy(l => l.sales1Id, k => f.userName(k) || 'Unassigned'),
    bySource: groupBy(l => l.source, k => k || 'other')
  };
}

function leadSource({ leads, deals, tasks }, f) {
  const inScope = leads.filter(l => inRange(l.dateAdded, f.from, f.to) && f.leadMatch(l));
  const groups = new Map();
  for (const l of inScope) {
    const k = l.source || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const rows = [...groups.entries()].map(([source, list]) => {
    const ids = new Set(list.map(l => l.id));
    const appts = tasks.filter(t => t.type === 'appointment' && ids.has(t.leadId) && t.status !== 'cancelled');
    const shownLeads = [...new Set(appts.filter(t => t.status === 'done').map(t => t.leadId))];
    const contacted = list.filter(l => firstResponse(l, f.hours));
    const sold = list.filter(l => isSold(l, deals));
    const m = contacted.map(l => firstResponse(l, f.hours).minutes);
    return {
      key: source, label: source,
      leads: cell(list.map(l => l.id)),
      contacted: cell(contacted.map(l => l.id)),
      apptsSet: cell([...new Set(appts.map(t => t.leadId))]),
      apptsShown: cell(shownLeads),
      sold: cell(sold.map(l => l.id)),
      closingPct: pct(sold.length, list.length),
      avgMinutes: avg(m)
    };
  }).sort((a, b) => b.leads.n - a.leads.n);
  const total = inScope.length;
  const sold = inScope.filter(l => isSold(l, deals));
  return {
    kpis: [
      { key: 'leads', label: 'Leads', value: total, ids: inScope.map(l => l.id) },
      { key: 'sold', label: 'Sold', value: sold.length, ids: sold.map(l => l.id) },
      { key: 'closing', label: 'Closing %', percent: pct(sold.length, total) },
      { key: 'sources', label: 'Sources', value: rows.length }
    ],
    rows
  };
}

function scorecard({ leads, deals, cars, tasks, users }, f) {
  const people = users.filter(u => (u.active || f.includesUser(u.id)) && f.personMatch(u.id));
  const rows = people.map(u => {
    const acts = [];
    for (const l of leads) {
      for (const a of l.activities || []) {
        if (a.by && String(a.by.id) === u.id && inRange(a.date, f.from, f.to)) acts.push({ a, leadId: l.id });
      }
    }
    const byType = type => cell([...new Set(acts.filter(x => x.a.type === type).map(x => x.leadId))]);
    const count = type => acts.filter(x => x.a.type === type).length;
    const done = tasks.filter(t => t.status === 'done' && t.completedBy && String(t.completedBy.id) === u.id && inRange(t.completedAt, f.from, f.to));
    const overdue = tasks.filter(t => t.status === 'open' && t.assignedTo && String(t.assignedTo.id) === u.id && new Date(t.dueAt) < new Date());
    const newLeads = leads.filter(l => l.sales1Id === u.id && inRange(l.dateAdded, f.from, f.to));
    const soldDeals = deals.filter(d => {
      if (!SOLD_DEAL.includes(d.status)) return false;
      const lead = leads.find(l => l.id === d.leadId);
      const car = cars.find(c => c.id === d.carId);
      return lead && lead.sales1Id === u.id && car && car.dateSold && inRange(car.dateSold, f.from, f.to);
    });
    return {
      key: u.id, label: u.name,
      newLeads: cell(newLeads.map(l => l.id)),
      calls: { n: count('call'), ids: byType('call').ids },
      texts: { n: count('text'), ids: byType('text').ids },
      emails: { n: count('email'), ids: byType('email').ids },
      visits: { n: count('visit'), ids: byType('visit').ids },
      tasksDone: cell([...new Set(done.map(t => t.leadId))]), tasksDoneCount: done.length,
      overdue: cell([...new Set(overdue.map(t => t.leadId))]), overdueCount: overdue.length,
      sold: cell([...new Set(soldDeals.map(d => d.leadId))]), soldCount: soldDeals.length
    };
  }).filter(r => f.person || r.newLeads.n || r.calls.n || r.texts.n || r.emails.n || r.visits.n || r.tasksDoneCount || r.overdueCount || r.soldCount);
  const sum = key => rows.reduce((s, r) => s + (typeof r[key] === 'number' ? r[key] : r[key].n), 0);
  return {
    kpis: [
      { key: 'calls', label: 'Calls', value: sum('calls') },
      { key: 'texts', label: 'Texts', value: sum('texts') },
      { key: 'emails', label: 'Emails', value: sum('emails') },
      { key: 'visits', label: 'Showroom visits', value: sum('visits') },
      { key: 'tasks', label: 'Tasks done', value: sum('tasksDoneCount') },
      { key: 'overdue', label: 'Overdue now', value: sum('overdueCount'), warn: sum('overdueCount') > 0 }
    ],
    rows
  };
}

function appointments({ leads, deals, tasks }, f) {
  const now = Date.now();
  const leadById = new Map(leads.map(l => [l.id, l]));
  const appts = tasks.filter(t => t.type === 'appointment' && inRange(t.dueAt, f.from, f.to) &&
    leadById.has(t.leadId) && f.leadMatch(leadById.get(t.leadId)) && f.personMatch(t.assignedTo && String(t.assignedTo.id)));
  const status = t => (t.status === 'done' ? 'shown' : t.status === 'cancelled' ? 'cancelled' : new Date(t.dueAt).getTime() < now ? 'missed' : 'upcoming');
  const idsOf = list => [...new Set(list.map(t => t.leadId))];
  const summarize = list => {
    const shown = list.filter(t => status(t) === 'shown');
    const cancelled = list.filter(t => status(t) === 'cancelled');
    const missed = list.filter(t => status(t) === 'missed');
    const soldAfterShown = shown.filter(t => isSold(leadById.get(t.leadId), deals));
    return {
      set: { n: list.length, ids: idsOf(list) },
      shown: { n: shown.length, ids: idsOf(shown) },
      cancelled: { n: cancelled.length, ids: idsOf(cancelled) },
      missed: { n: missed.length, ids: idsOf(missed) },
      upcoming: { n: list.filter(t => status(t) === 'upcoming').length, ids: idsOf(list.filter(t => status(t) === 'upcoming')) },
      showPct: pct(shown.length, shown.length + cancelled.length + missed.length),
      sold: { n: soldAfterShown.length, ids: idsOf(soldAfterShown) }
    };
  };
  const byPerson = new Map();
  for (const t of appts) {
    const k = t.assignedTo ? String(t.assignedTo.id) : '';
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(t);
  }
  const all = summarize(appts);
  return {
    kpis: [
      { key: 'set', label: 'Appointments', value: all.set.n, ids: all.set.ids },
      { key: 'shown', label: 'Shown', value: all.shown.n, ids: all.shown.ids },
      { key: 'showPct', label: 'Show rate', percent: all.showPct },
      { key: 'missed', label: 'Not marked (past)', value: all.missed.n, ids: all.missed.ids, warn: all.missed.n > 0 },
      { key: 'sold', label: 'Sold after showing', value: all.sold.n, ids: all.sold.ids }
    ],
    rows: [...byPerson.entries()].map(([k, list]) => ({ key: k, label: f.userName(k) || 'Unassigned', ...summarize(list) }))
      .sort((a, b) => b.set.n - a.set.n)
  };
}

function soldUnits({ leads, deals, cars }, f) {
  const rows = [];
  for (const d of deals) {
    if (!SOLD_DEAL.includes(d.status)) continue;
    const car = cars.find(c => c.id === d.carId);
    const lead = leads.find(l => l.id === d.leadId);
    if (!car || !car.dateSold || !inRange(car.dateSold, f.from, f.to)) continue;
    if (lead && !f.leadMatch(lead)) continue;
    if (!lead && (f.source || f.person)) continue;
    const price = Number(d.vehiclePrice) || Number(car.price) || 0;
    rows.push({
      dealId: d.id, dealNumber: d.dealNumber, leadId: lead ? lead.id : null, customer: lead ? lead.name : '--',
      salesperson: lead ? (f.userName(lead.sales1Id) || 'Unassigned') : 'Unassigned', salespersonId: lead ? lead.sales1Id || '' : '',
      vehicle: [car.year, car.make, car.model].filter(Boolean).join(' '), stockNumber: car.stockNumber || '',
      price, gross: price - (Number(car.cost) || 0), dateSold: car.dateSold,
      daysToSell: car.dateAdded ? Math.max(0, Math.round((new Date(car.dateSold) - new Date(car.dateAdded)) / (24 * HOUR))) : null
    });
  }
  rows.sort((a, b) => String(b.dateSold).localeCompare(String(a.dateSold)));
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.salespersonId)) byPerson.set(r.salespersonId, []);
    byPerson.get(r.salespersonId).push(r);
  }
  const days = rows.map(r => r.daysToSell).filter(n => n !== null);
  return {
    kpis: [
      { key: 'units', label: 'Units sold', value: rows.length, ids: [...new Set(rows.map(r => r.leadId).filter(Boolean))] },
      { key: 'gross', label: 'Total front gross', money: rows.reduce((s, r) => s + r.gross, 0) },
      { key: 'avgGross', label: 'Average gross', money: avg(rows.map(r => r.gross)) },
      { key: 'days', label: 'Average days to sell', value: days.length ? Math.round(avg(days)) : null }
    ],
    rows: [...byPerson.entries()].map(([k, list]) => ({
      key: k, label: list[0].salesperson, units: cell([...new Set(list.map(r => r.leadId).filter(Boolean))]), unitCount: list.length,
      gross: list.reduce((s, r) => s + r.gross, 0), avgGross: avg(list.map(r => r.gross))
    })).sort((a, b) => b.unitCount - a.unitCount),
    deals: rows
  };
}

const REPORTS = {
  'response-time': { name: 'Response Time', run: responseTime },
  'lead-source': { name: 'Lead Source', run: leadSource },
  scorecard: { name: 'Salesperson Activity', run: scorecard },
  appointments: { name: 'Appointments', run: appointments },
  'sold-units': { name: 'Sold Units', run: soldUnits }
};

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseFilters(req, users, settings) {
  const seeAll = auth.can(req.user, 'viewAllReports');
  const from = new Date(req.query.from || Date.now() - 30 * 24 * HOUR).getTime();
  const to = new Date(req.query.to || Date.now() + MIN).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) return { error: 'Pick a valid date range.' };
  // Salespeople always see their own numbers only.
  const person = seeAll ? (req.query.userId ? String(req.query.userId) : '') : String(req.user.id);
  const source = req.query.source ? String(req.query.source) : '';
  const names = new Map(users.map(u => [u.id, u.name]));
  const assigned = l => [l.sales1Id, l.sales2Id, l.bdc1Id, l.bdc2Id].includes(person);
  const useStoreHours = req.query.hours !== 'all';
  return {
    from, to, person, source, seeAll, useStoreHours,
    hours: useStoreHours ? storeHours.cleanStoreHours(settings.storeHours) : null,
    userName: id => names.get(String(id)) || (id ? 'Former employee' : ''),
    includesUser: id => !person || id === person,
    leadMatch: l => (!source || (l.source || 'other') === source) && (!person || assigned(l)),
    personMatch: id => !person || String(id) === person
  };
}

router.get('/reports/:key', wrap(async (req, res, next) => {
  if (req.params.key === 'saved') return next();
  const report = REPORTS[req.params.key];
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const data = await loadData(store.pool, req.dealershipId);
  const dealership = await store.getDealership(store.pool, req.dealershipId);
  const f = parseFilters(req, data.users, (dealership && dealership.settings) || {});
  if (f.error) return res.status(400).json({ error: f.error });
  const result = report.run(data, f);
  // The customers behind the numbers, for the drill-down lists.
  const ids = new Set();
  JSON.stringify(result, (k, v) => { if (k === 'ids' && Array.isArray(v)) v.forEach(id => ids.add(id)); return v; });
  const leadInfo = data.leads.filter(l => ids.has(l.id)).map(l => {
    const r = firstResponse(l, f.hours);
    return {
      id: l.id, name: l.name, source: l.source, status: l.status, dateAdded: l.dateAdded, phone: l.phone,
      salesperson: f.userName(l.sales1Id) || 'Unassigned', responseMinutes: r ? r.minutes : null, sold: isSold(l, data.deals)
    };
  });
  res.json({
    report: req.params.key, name: report.name, from: new Date(f.from).toISOString(), to: new Date(f.to).toISOString(),
    scope: f.seeAll ? (f.person ? 'person' : 'store') : 'mine', storeHoursOnly: f.useStoreHours, ...result, leads: leadInfo
  });
}));

// Saved report setups, per person.
router.get('/reports/saved', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT saved_reports FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0] ? rows[0].saved_reports : []);
}));

router.post('/reports/saved', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name the report.' });
  if (!REPORTS[b.report]) return res.status(400).json({ error: 'Pick a report.' });
  const filters = b.filters && typeof b.filters === 'object' ? b.filters : {};
  const item = {
    id: crypto.randomUUID(), name, report: b.report,
    filters: {
      range: String(filters.range || 'last30').slice(0, 20), source: String(filters.source || '').slice(0, 40),
      userId: String(filters.userId || '').slice(0, 60), from: String(filters.from || '').slice(0, 30), to: String(filters.to || '').slice(0, 30)
    },
    createdAt: new Date().toISOString()
  };
  await store.pool.query(
    `UPDATE users SET saved_reports = (saved_reports || $2::jsonb) WHERE id = $1 AND jsonb_array_length(saved_reports) < 50`,
    [req.user.id, JSON.stringify([item])]);
  res.status(201).json(item);
}));

router.delete('/reports/saved/:id', wrap(async (req, res) => {
  await store.pool.query(
    `UPDATE users SET saved_reports = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(saved_reports) x WHERE x->>'id' <> $2), '[]'::jsonb) WHERE id = $1`,
    [req.user.id, req.params.id]);
  res.status(204).send();
}));

module.exports = { router, REPORTS, firstResponse, RESPONSE_BUCKETS };
