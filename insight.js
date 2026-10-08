// insight.js -- Insight Domus: the numbers managers run the store by.
//
//   sales        units and gross (front, back, incentives, chargebacks, per
//                vehicle) for any date range, against the period before and
//                the same period last year, final vs not final, the pace for
//                this month, and the daily sales log
//   leaderboard  salespeople (split deals count as shares), sales managers,
//                and F&I managers, ranked
//   F&I          product penetration by F&I manager, back gross per deal,
//                reserve, and the lender report
//   inventory    stock with or without cost (by role), aging, model pacing
//                (sold vs in stock = days of supply), turn, new-model aging,
//                wholesale results, and open ROs on stock cars
//   marketing    sales by ZIP code, by customer age range, and by lead source
//   trend        gross by month against the goals, month and year to date
//
// Live from the deals, cars, and ROs -- nothing waits for an overnight pull.
// Customers' birthdates never leave the server: only age ranges do.

const express = require('express');
const store = require('./db');
const auth = require('./auth');
const hours = require('./hours');
const dashboard = require('./dashboard');

const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const DAY = 86400000;
const SOLD = ['delivered', 'closed', 'finalized'];
const PRODUCTS = [['service', 'servicePremium', 'Service contract'], ['gap', 'gapPremium', 'GAP'], ['maintenance', 'maintenancePremium', 'Maintenance'],
  ['aftermarket', 'aftermarketAmount', 'Aftermarket'], ['creditIns', 'creditInsPremium', 'Credit insurance']];
const SALES_ROLES = ['sales1', 'sales2', 'sales3', 'sales4'];
const AGE_BANDS = [[18, 24], [25, 34], [35, 44], [45, 54], [55, 64], [65, 200]];
const carName = c => (c ? [c.year, c.make, c.model].filter(Boolean).join(' ') : '');
const modelKey = c => [c.make, c.model].filter(Boolean).join(' ') || 'Unknown';

// ---------- Data ----------

async function loadAll(dealershipId) {
  const [deals, cars, leads, appraisals, ros, dealership, users] = await Promise.all([
    store.list(store.pool, 'deals', dealershipId), store.list(store.pool, 'cars', dealershipId), store.list(store.pool, 'leads', dealershipId),
    store.list(store.pool, 'appraisals', dealershipId), store.list(store.pool, 'repair_orders', dealershipId), store.getDealership(store.pool, dealershipId),
    store.pool.query('SELECT id::text AS id, name, role, active FROM users WHERE dealership_id = $1', [dealershipId]).then(r => r.rows)
  ]);
  const settings = (dealership && dealership.settings) || {};
  const tz = hours.cleanStoreHours(settings.storeHours).timezone;
  const carById = new Map(cars.map(c => [c.id, c]));
  const leadById = new Map(leads.map(l => [l.id, l]));
  const acvByDeal = new Map(appraisals.filter(a => a.dealId && a.status === 'acquired' && a.acquiredFor).map(a => [a.dealId, a.acquiredFor]));
  const staff = new Map(users.map(u => [u.id, u]));
  const sold = [];
  for (const d of deals) {
    const car = carById.get(d.carId);
    if (!SOLD.includes(d.status) || (car && car.soldAs === 'wholesale')) continue;
    const soldAt = d.deliveredAt || (car && car.dateSold);
    if (!soldAt) continue;
    const lead = leadById.get(d.leadId) || {};
    const g = dashboard.dealGross(d, car, settings, acvByDeal.get(d.id));
    const emp = d.employees || {};
    const salespeople = SALES_ROLES.map(r => emp[r]).filter(Boolean);
    if (!salespeople.length && lead.sales1Id) salespeople.push(String(lead.sales1Id));
    const products = Object.fromEntries(PRODUCTS.map(([k, f]) => [k, n(d[f]) > 0]));
    sold.push({
      id: d.id, leadId: d.leadId, dealNumber: d.dealNumber, status: d.status, final: d.status === 'finalized', soldAt: new Date(soldAt).getTime(),
      type: g.type, customer: lead.name || '--', source: lead.source || 'other',
      zip: String((lead.address && lead.address.zip) || (d.creditApp && d.creditApp.applicant && d.creditApp.applicant.zip) || '').slice(0, 5),
      ageBand: ageBand((d.creditApp && d.creditApp.applicant && d.creditApp.applicant.dob) || (lead.creditApp && lead.creditApp.applicant && lead.creditApp.applicant.dob), soldAt),
      salespeople, fi: emp.fiManager || null, manager: emp.salesManager || emp.deskManager || null,
      lender: d.dealType === 'cash' ? '' : String(d.lender || '').trim(), dealType: d.dealType || 'retail',
      apr: n(d.apr), term: n(d.termMonths), financed: d.dealType === 'cash' ? 0 : n(d.amountFinanced),
      products, productCount: Object.values(products).filter(Boolean).length,
      front: round2(g.front), back: round2(g.finance), incentives: round2(g.incentives), reserve: round2(d.reserve),
      chargeback: -Math.abs(n(d.chargebackAmount)), chargebackAt: d.chargebackDate ? new Date(d.chargebackDate).getTime() : null,
      vehicle: carName(car), stockNumber: car ? car.stockNumber || '' : '', model: car ? modelKey(car) : 'Unknown',
      daysInStock: car && car.dateAdded ? Math.max(0, Math.round((new Date(soldAt) - new Date(car.dateAdded)) / DAY)) : null
    });
  }
  return { deals, cars, leads, ros, settings, tz, sold, staff, carById };
}

// An age range from a birthdate, as of the sale -- the birthdate itself stays here.
function ageBand(dob, at) {
  const born = dob ? new Date(dob) : null;
  if (!born || Number.isNaN(born.getTime())) return 'Unknown';
  const age = Math.floor((new Date(at) - born) / (365.25 * DAY));
  const band = AGE_BANDS.find(([lo, hi]) => age >= lo && age <= hi);
  return band ? (band[1] >= 200 ? `${band[0]}+` : `${band[0]}-${band[1]}`) : 'Unknown';
}

// ---------- Date ranges ----------

const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function dayStart(day, tz) { const [y, m, d] = day.split('-').map(Number); return hours.zonedToUtc(y, m - 1, d, 0, 0, tz); }
function today(tz) { const t = hours.localDate(Date.now(), tz); return `${t.y}-${String(t.m + 1).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`; }
const addDays = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const addYears = (day, k) => `${Number(day.slice(0, 4)) + k}${day.slice(4)}`;
// From/to (inclusive days) -> [start, end) in time; defaults to this month so far.
function range(req, tz) {
  const t = today(tz);
  const from = isDay(req.query.from) ? req.query.from : `${t.slice(0, 7)}-01`;
  const to = isDay(req.query.to) ? req.query.to : t;
  return { from, to, start: dayStart(from, tz), end: dayStart(addDays(to, 1), tz), days: Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1 };
}
const inRange = (ms, r) => ms >= r.start && ms < r.end;

// ---------- Sales ----------

function bucket() { return { units: 0, final: 0, notFinal: 0, front: 0, back: 0, incentives: 0, chargebacks: 0, products: 0 }; }
function summarize(data, r) {
  const out = { new: bucket(), used: bucket(), total: bucket(), wholesale: { units: 0, gross: 0 } };
  for (const s of data.sold) {
    if (!inRange(s.soldAt, r)) continue;
    for (const b of [out[s.type], out.total]) {
      b.units++; b[s.final ? 'final' : 'notFinal']++;
      b.front += s.front; b.back += s.back; b.incentives += s.incentives; b.products += s.productCount;
    }
  }
  // Chargebacks count when they come back.
  for (const s of data.sold) {
    if (s.chargeback && inRange(s.chargebackAt || s.soldAt, r)) { out[s.type].chargebacks += s.chargeback; out.total.chargebacks += s.chargeback; }
  }
  for (const c of data.cars) {
    if (c.status === 'sold' && c.soldAs === 'wholesale' && c.dateSold && inRange(new Date(c.dateSold).getTime(), r)) { out.wholesale.units++; out.wholesale.gross += n(c.wholesalePrice) - n(c.cost); }
  }
  for (const k of ['new', 'used', 'total']) {
    const b = out[k];
    b.gross = round2(b.front + b.back + b.incentives + b.chargebacks);
    for (const f of ['front', 'back', 'incentives', 'chargebacks']) b[f] = round2(b[f]);
    b.pvr = { front: b.units ? round2(b.front / b.units) : null, back: b.units ? round2(b.back / b.units) : null, total: b.units ? round2(b.gross / b.units) : null };
    b.productsPerDeal = b.units ? round2(b.products / b.units) : null;
  }
  out.wholesale.gross = round2(out.wholesale.gross);
  return out;
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use('/insight', auth.requirePermission('viewAllReports'));

router.get('/insight/sales', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const prior = { start: r.start - (r.end - r.start), end: r.start };
  const lastYear = { start: dayStart(addYears(r.from, -1), data.tz), end: dayStart(addDays(addYears(r.to, -1), 1), data.tz) };
  // This month so far: where it's headed at this pace (open days only).
  const t = today(data.tz);
  let pace = null;
  if (r.from === `${t.slice(0, 7)}-01` && r.to === t) {
    const days = dashboard.openDays(t.slice(0, 7), hours.cleanStoreHours(data.settings.storeHours));
    pace = { elapsed: days.elapsed, total: days.total, factor: days.elapsed ? days.total / days.elapsed : null };
  }
  const plan = ((data.settings.monthlyPlan || {})[r.from.slice(0, 7)] || {}).goals || {};
  // The daily log: every deal in the range, newest first.
  const name = id => (data.staff.get(String(id)) || {}).name || '';
  const log = data.sold.filter(s => inRange(s.soldAt, r)).sort((a, b) => b.soldAt - a.soldAt).map(s => ({
    id: s.id, dealNumber: s.dealNumber, day: new Date(s.soldAt).toISOString(), customer: s.customer, vehicle: s.vehicle, stockNumber: s.stockNumber, type: s.type,
    final: s.final, salespeople: s.salespeople.map(name).filter(Boolean), fi: name(s.fi), lender: s.lender, front: s.front, back: s.back, total: round2(s.front + s.back + s.incentives), products: s.productCount
  }));
  res.json({ from: r.from, to: r.to, current: summarize(data, r), prior: summarize(data, prior), lastYear: summarize(data, lastYear), pace, goals: plan, log });
}));

router.get('/insight/leaderboard', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const rows = new Map();
  const row = (id, kind) => {
    const k = `${kind}|${id}`;
    if (!rows.has(k)) rows.set(k, { id, kind, name: (data.staff.get(String(id)) || {}).name || 'Former employee', units: 0, new: 0, used: 0, front: 0, back: 0, total: 0, products: 0, deals: 0 });
    return rows.get(k);
  };
  for (const s of data.sold) {
    if (!inRange(s.soldAt, r)) continue;
    const share = s.salespeople.length ? 1 / s.salespeople.length : 0;
    for (const id of s.salespeople) {
      const x = row(id, 'sales');
      x.units += share; x[s.type] += share; x.front += s.front * share; x.back += s.back * share; x.total += (s.front + s.back + s.incentives) * share; x.products += s.productCount * share; x.deals++;
    }
    for (const [id, kind] of [[s.manager, 'manager'], [s.fi, 'fi']]) {
      if (!id) continue;
      const x = row(id, kind);
      x.units++; x[s.type]++; x.front += s.front; x.back += s.back; x.total += s.front + s.back + s.incentives; x.products += s.productCount; x.deals++;
    }
  }
  // Leads each salesperson got in the range and how many of them bought.
  for (const l of data.leads) {
    if (!l.sales1Id || !l.dateAdded || !inRange(new Date(l.dateAdded).getTime(), r)) continue;
    const x = row(String(l.sales1Id), 'sales');
    x.leads = (x.leads || 0) + 1;
    if (data.sold.some(s => s.leadId === l.id)) x.leadsSold = (x.leadsSold || 0) + 1;
  }
  const finish = x => ({
    ...x, units: round2(x.units), new: round2(x.new), used: round2(x.used), front: round2(x.front), back: round2(x.back), total: round2(x.total),
    pvr: x.units ? round2(x.total / x.units) : null, productsPerDeal: x.units ? round2(x.products / x.units) : null,
    closeRate: x.leads ? round2((x.leadsSold || 0) / x.leads * 100) : null
  });
  const list = kind => [...rows.values()].filter(x => x.kind === kind).map(finish).sort((a, b) => b.units - a.units || b.total - a.total);
  res.json({ from: r.from, to: r.to, salespeople: list('sales'), managers: list('manager'), fi: list('fi') });
}));

router.get('/insight/fi', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const deals = data.sold.filter(s => inRange(s.soldAt, r));
  const pen = list => Object.fromEntries(PRODUCTS.map(([k]) => [k, list.length ? round2(list.filter(s => s.products[k]).length / list.length * 100) : null]));
  const sumOf = (list, f) => round2(list.reduce((t, s) => t + n(s[f]), 0));
  const byFi = new Map();
  for (const s of deals) {
    const k = s.fi || '';
    if (!byFi.has(k)) byFi.set(k, []);
    byFi.get(k).push(s);
  }
  const managers = [...byFi.entries()].map(([id, list]) => ({
    id, name: id ? (data.staff.get(String(id)) || {}).name || 'Former employee' : 'No F&I manager on the deal',
    deals: list.length, financed: list.filter(s => s.lender).length, back: sumOf(list, 'back'), reserve: sumOf(list, 'reserve'),
    backPerDeal: list.length ? round2(sumOf(list, 'back') / list.length) : null, productsPerDeal: list.length ? round2(list.reduce((t, s) => t + s.productCount, 0) / list.length) : null,
    penetration: pen(list)
  })).sort((a, b) => b.back - a.back);
  const byLender = new Map();
  for (const s of deals.filter(x => x.lender)) {
    if (!byLender.has(s.lender)) byLender.set(s.lender, []);
    byLender.get(s.lender).push(s);
  }
  const lenders = [...byLender.entries()].map(([lender, list]) => ({
    lender, deals: list.length, financed: sumOf(list, 'financed'), reserve: sumOf(list, 'reserve'),
    avgFinanced: round2(sumOf(list, 'financed') / list.length), avgApr: round2(list.reduce((t, s) => t + s.apr, 0) / list.length), avgTerm: Math.round(list.reduce((t, s) => t + s.term, 0) / list.length),
    reservePerDeal: round2(sumOf(list, 'reserve') / list.length)
  })).sort((a, b) => b.deals - a.deals);
  res.json({
    from: r.from, to: r.to, deals: deals.length, cash: deals.filter(s => !s.lender).length,
    back: sumOf(deals, 'back'), reserve: sumOf(deals, 'reserve'), backPerDeal: deals.length ? round2(sumOf(deals, 'back') / deals.length) : null,
    productsPerDeal: deals.length ? round2(deals.reduce((t, s) => t + s.productCount, 0) / deals.length) : null,
    penetration: pen(deals), products: PRODUCTS.map(([k, , label]) => ({ key: k, label })), managers, lenders
  });
}));

router.get('/insight/inventory', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const now = Date.now();
  const seeCost = auth.can(req.user, 'editInventory');
  const type = ['new', 'used'].includes(req.query.type) ? req.query.type : null;
  const stock = data.cars.filter(c => c.status !== 'sold' && (!type || (c.stockType === 'new' ? 'new' : 'used') === type));
  const age = c => (c.dateAdded ? Math.max(0, Math.floor((now - new Date(c.dateAdded)) / DAY)) : 0);
  const openRo = new Map();
  for (const ro of data.ros) if (ro.carId && ['open', 'in_progress', 'waiting_parts', 'ready'].includes(ro.status)) openRo.set(ro.carId, [...(openRo.get(ro.carId) || []), ro]);
  const list = stock.map(c => ({
    id: c.id, stockNumber: c.stockNumber || '', vehicle: [c.year, c.make, c.model, c.trim].filter(Boolean).join(' '), type: c.stockType === 'new' ? 'new' : 'used',
    status: c.status, age: age(c), miles: n(c.mileage), price: n(c.price), color: c.exteriorColor || c.color || '',
    ...(seeCost ? { cost: n(c.cost), margin: round2(n(c.price) - n(c.cost)) } : {}),
    openROs: (openRo.get(c.id) || []).map(ro => ({ roNumber: ro.roNumber, days: Math.max(0, Math.floor((now - new Date(ro.openedAt)) / DAY)), status: ro.status }))
  })).sort((a, b) => b.age - a.age);
  const buckets = [[0, 30, '0-30'], [31, 60, '31-60'], [61, 90, '61-90'], [91, Infinity, '90+']].map(([lo, hi, label]) => {
    const cars = list.filter(c => c.age >= lo && c.age <= hi);
    return { label, units: cars.length, ...(seeCost ? { cost: round2(cars.reduce((t, c) => t + c.cost, 0)) } : {}) };
  });
  // Model pacing: what sold in the last 30 / 90 days against what's in stock.
  const models = new Map();
  const m = k => { if (!models.has(k)) models.set(k, { model: k, inStock: 0, sold30: 0, sold90: 0, sold365: 0, ageTotal: 0, new: 0, used: 0 }); return models.get(k); };
  for (const c of stock) { const x = m(modelKey(c)); x.inStock++; x.ageTotal += age(c); x[c.stockType === 'new' ? 'new' : 'used']++; }
  for (const s of data.sold) {
    if (type && s.type !== type) continue;
    const ago = (now - s.soldAt) / DAY;
    if (ago > 365) continue;
    const x = m(s.model);
    x.sold365++; if (ago <= 90) x.sold90++; if (ago <= 30) x.sold30++;
  }
  const pacing = [...models.values()].map(x => ({
    ...x, avgAge: x.inStock ? Math.round(x.ageTotal / x.inStock) : null,
    daysSupply: x.sold90 ? Math.round(x.inStock / (x.sold90 / 90)) : (x.inStock ? null : 0),
    turn: x.inStock ? round2(x.sold365 / x.inStock) : null
  })).sort((a, b) => b.inStock - a.inStock || b.sold90 - a.sold90);
  // The store's turn: a year of retail sales over what's in stock now.
  const sold365 = data.sold.filter(s => (!type || s.type === type) && now - s.soldAt <= 365 * DAY).length;
  const r = range(req, data.tz);
  const wholesale = data.cars.filter(c => c.status === 'sold' && c.soldAs === 'wholesale' && c.dateSold && inRange(new Date(c.dateSold).getTime(), r)).map(c => ({
    id: c.id, stockNumber: c.stockNumber || '', vehicle: carName(c), soldAt: c.dateSold, price: n(c.wholesalePrice),
    ...(seeCost ? { cost: n(c.cost), gross: round2(n(c.wholesalePrice) - n(c.cost)) } : {}),
    daysInStock: c.dateAdded ? Math.round((new Date(c.dateSold) - new Date(c.dateAdded)) / DAY) : null, buyer: c.wholesaleBuyer || ''
  }));
  res.json({
    seeCost, type, units: list.length, avgAge: list.length ? Math.round(list.reduce((t, c) => t + c.age, 0) / list.length) : null,
    ...(seeCost ? { value: round2(list.reduce((t, c) => t + c.cost, 0)) } : {}),
    turn: list.length ? round2(sold365 / list.length) : null, daysSupply: sold365 ? Math.round(list.length / (sold365 / 365)) : null,
    buckets, list, pacing, wholesale: { from: r.from, to: r.to, cars: wholesale, ...(seeCost ? { gross: round2(wholesale.reduce((t, c) => t + c.gross, 0)) } : {}) },
    reconOpen: list.filter(c => c.openROs.length).length
  });
}));

router.get('/insight/marketing', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const deals = data.sold.filter(s => inRange(s.soldAt, r));
  const group = (key, label) => {
    const m = new Map();
    for (const s of deals) {
      const k = s[key] || 'Unknown';
      if (!m.has(k)) m.set(k, { [label]: k, units: 0, gross: 0, new: 0, used: 0 });
      const x = m.get(k);
      x.units++; x[s.type]++; x.gross += s.front + s.back + s.incentives;
    }
    return [...m.values()].map(x => ({ ...x, gross: round2(x.gross), pvr: round2(x.gross / x.units) })).sort((a, b) => b.units - a.units);
  };
  // Lead sources: leads in, and how many bought.
  const leads = data.leads.filter(l => l.dateAdded && inRange(new Date(l.dateAdded).getTime(), r));
  const bySource = new Map();
  for (const l of leads) {
    const k = l.source || 'other';
    if (!bySource.has(k)) bySource.set(k, { source: k, leads: 0, sold: 0 });
    const x = bySource.get(k);
    x.leads++;
    if (data.deals.some(d => d.leadId === l.id && SOLD.includes(d.status))) x.sold++;
  }
  const order = AGE_BANDS.map(([lo, hi]) => (hi >= 200 ? `${lo}+` : `${lo}-${hi}`)).concat('Unknown');
  res.json({
    from: r.from, to: r.to, deals: deals.length,
    byZip: group('zip', 'zip'),
    byAge: group('ageBand', 'band').sort((a, b) => order.indexOf(a.band) - order.indexOf(b.band)),
    bySource: group('source', 'source'),
    leadSources: [...bySource.values()].map(x => ({ ...x, closeRate: round2(x.sold / x.leads * 100) })).sort((a, b) => b.leads - a.leads)
  });
}));

router.get('/insight/trend', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const t = today(data.tz);
  const months = [];
  const thisMonth = t.slice(0, 7);
  const year = thisMonth.slice(0, 4);
  for (let i = 11; i >= 0; i--) {
    const key = dashboard.shiftMonth(thisMonth, -i);
    const [from, to] = dashboard.monthRange(key, data.tz);
    const s = summarize(data, { start: from, end: to });
    const goals = ((data.settings.monthlyPlan || {})[key] || {}).goals || {};
    const goal = goals.newGross !== undefined || goals.usedGross !== undefined ? round2(n(goals.newGross) + n(goals.usedGross)) : null;
    const goalUnits = goals.newUnits !== undefined || goals.usedUnits !== undefined ? n(goals.newUnits) + n(goals.usedUnits) : null;
    months.push({ month: key, newUnits: s.new.units, usedUnits: s.used.units, units: s.total.units, front: s.total.front, back: s.total.back, gross: s.total.gross, pvr: s.total.pvr.total, wholesale: s.wholesale.gross, goal, goalUnits });
  }
  const ytd = months.filter(x => x.month.startsWith(year));
  const sum = (list, f) => round2(list.reduce((s, x) => s + n(x[f]), 0));
  res.json({ months, ytd: { units: sum(ytd, 'units'), gross: sum(ytd, 'gross'), goal: ytd.some(x => x.goal !== null) ? sum(ytd, 'goal') : null, goalUnits: ytd.some(x => x.goalUnits !== null) ? sum(ytd, 'goalUnits') : null } });
}));

module.exports = { router, ageBand };
