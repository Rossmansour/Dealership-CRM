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
//   store        the whole store's month: gross by department, expenses
//                (from the books, else the GM's numbers), net, where the
//                month will land, and fixed absorption
//   fixed        service & parts: ROs, hours, effective labor rate, tech
//                productivity, advisors, parts by sale type, open RO aging
//   heartbeat    today, live: ups, visits, appointments set and shown, deals
//                sold, and each salesperson's calls / texts / emails
//   trades       trade-in % for the store and each salesperson, by source
//   people       each salesperson's month against the goals a manager sets
//                for them, with pace, and a one-page review
//   parts        parts inventory: value, turns, what isn't moving, top sellers
//   expenses     key expenses by account: 6-month and 3-month averages, this
//                month, last year; and cash: what's owed to the store and how
//                old it is, unbooked deals, deposits, we-owes, titles
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
  const [deals, cars, leads, appraisals, ros, dealership, users, tickets] = await Promise.all([
    store.list(store.pool, 'deals', dealershipId), store.list(store.pool, 'cars', dealershipId), store.list(store.pool, 'leads', dealershipId),
    store.list(store.pool, 'appraisals', dealershipId), store.list(store.pool, 'repair_orders', dealershipId), store.getDealership(store.pool, dealershipId),
    store.pool.query('SELECT id::text AS id, name, role, active, pay FROM users WHERE dealership_id = $1', [dealershipId]).then(r => r.rows),
    store.list(store.pool, 'parts_tickets', dealershipId)
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
      productProfit: productProfit(d),
      hasTrade: !!d.hasTrade || (Array.isArray(d.trades) && d.trades.length > 0), sourceGroup: sourceGroup(lead.source),
      front: round2(g.front), back: round2(g.finance), incentives: round2(g.incentives), reserve: round2(d.reserve),
      chargeback: -Math.abs(n(d.chargebackAmount)), chargebackAt: d.chargebackDate ? new Date(d.chargebackDate).getTime() : null,
      vehicle: carName(car), stockNumber: car ? car.stockNumber || '' : '', model: car ? modelKey(car) : 'Unknown',
      daysInStock: car && car.dateAdded ? Math.max(0, Math.round((new Date(soldAt) - new Date(car.dateAdded)) / DAY)) : null
    });
  }
  return { deals, cars, leads, ros, tickets, settings, tz, sold, staff, carById };
}

// What the store made on each F&I product on a deal. With itemized product
// lines, each line's price less its cost; otherwise the premium less a share
// of the deal's product cost (shared by premium).
function productProfit(d) {
  const lines = (list, pick) => (Array.isArray(list) ? list.filter(pick).reduce((t, x) => t + n(x.premium ?? x.price) - n(x.cost), 0) : null);
  const ci = d.creditInsurance && typeof d.creditInsurance === 'object' ? [d.creditInsurance.life, d.creditInsurance.ah, d.creditInsurance.iui].filter(Boolean) : null;
  const itemized = {
    service: lines(d.warranties, w => w && w.kind !== 'maintenance'), maintenance: lines(d.warranties, w => w && w.kind === 'maintenance'),
    gap: d.gap && typeof d.gap === 'object' ? n(d.gap.premium) - n(d.gap.cost) : (d.gap === null ? 0 : null),
    creditIns: ci ? lines(ci, () => true) : (d.creditInsurance === null ? 0 : null), aftermarket: lines(d.aftermarkets, () => true)
  };
  const premium = Object.fromEntries(PRODUCTS.map(([k, f]) => [k, n(d[f])]));
  const loose = PRODUCTS.filter(([k]) => itemized[k] === null);
  const itemizedCost = PRODUCTS.filter(([k]) => itemized[k] !== null).reduce((t, [k]) => t + premium[k] - itemized[k], 0);
  const leftCost = Math.max(0, n(d.fiProductCost) - itemizedCost);
  const loosePremium = loose.reduce((t, [k]) => t + premium[k], 0);
  return Object.fromEntries(PRODUCTS.map(([k]) => [k, round2(itemized[k] !== null ? itemized[k] : premium[k] - (loosePremium ? leftCost * premium[k] / loosePremium : 0))]));
}

// Lead sources grouped the way the floor talks about them.
const SOURCE_GROUPS = [['internet', 'Internet'], ['walkin', 'Walk-in'], ['phone', 'Phone up'], ['other', 'Other']];
function sourceGroup(src) {
  if (src === 'walk-in') return 'walkin';
  if (src === 'phone') return 'phone';
  if (['website', 'autotrader', 'cargurus', 'facebook', 'internet', 'email', 'chat'].includes(src)) return 'internet';
  return 'other';
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
// Sales reports are for sales and F&I management; the whole-store numbers
// for the GM; service & parts for fixed ops; expenses and cash for whoever
// can read the books.
const PERMISSION = { store: 'viewDashboardStore', fixed: 'viewDashboardFixed', parts: 'viewDashboardFixed', expenses: 'viewAccounting' };
router.use('/insight/:report', (req, res, next) => auth.requirePermission(PERMISSION[req.params.report] || 'viewAllReports')(req, res, next));

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
  const type = ['new', 'used'].includes(req.query.type) ? req.query.type : '';
  const ofType = s => !type || s.type === type;
  const deals = data.sold.filter(s => ofType(s) && inRange(s.soldAt, r));
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
  // The summary: back gross and per deal, final vs not, against the same
  // dates last year and (this month) where it's headed; products per deal
  // against the store's target; chargebacks that came back in the range.
  const lastYear = { start: dayStart(addYears(r.from, -1), data.tz), end: dayStart(addDays(addYears(r.to, -1), 1), data.tz) };
  const lyDeals = data.sold.filter(s => ofType(s) && inRange(s.soldAt, lastYear));
  const productTotal = list => round2(list.reduce((t, s) => t + PRODUCTS.reduce((u, [k]) => u + s.productProfit[k], 0), 0));
  const per = (v, list) => (list.length ? round2(v / list.length) : null);
  const t = today(data.tz);
  let paceFactor = null;
  if (r.from === `${t.slice(0, 7)}-01` && r.to === t) {
    const days = dashboard.openDays(t.slice(0, 7), hours.cleanStoreHours(data.settings.storeHours));
    paceFactor = days.elapsed ? days.total / days.elapsed : null;
  }
  const finals = deals.filter(s => s.final), notFinals = deals.filter(s => !s.final);
  const back = sumOf(deals, 'back'), lyBack = sumOf(lyDeals, 'back');
  const productCount = list => list.reduce((x, s) => x + s.productCount, 0);
  const target = data.settings.fiTargets && data.settings.fiTargets.penetration !== undefined ? n(data.settings.fiTargets.penetration) : 100;
  const summary = {
    gross: { notFinal: sumOf(notFinals, 'back'), final: sumOf(finals, 'back'), actual: back, pace: paceFactor ? round2(back * paceFactor) : null, lastYear: lyDeals.length ? lyBack : null },
    pvr: { notFinal: per(sumOf(notFinals, 'back'), notFinals), final: per(sumOf(finals, 'back'), finals), actual: per(back, deals), product: per(productTotal(deals), deals), lastYear: per(lyBack, lyDeals) },
    penetration: { current: deals.length ? round2(productCount(deals) / deals.length * 100) : null, lastYear: lyDeals.length ? round2(productCount(lyDeals) / lyDeals.length * 100) : null, target },
    chargebacks: round2(data.sold.filter(s => ofType(s) && s.chargeback && inRange(s.chargebackAt || s.soldAt, r)).reduce((x, s) => x + s.chargeback, 0))
  };
  // Each F&I manager's deals, with what each product made.
  const dealRow = s => ({
    id: s.id, dealNumber: s.dealNumber, stockNumber: s.stockNumber, customer: s.customer, type: s.type, final: s.final, vehicle: s.vehicle,
    front: round2(s.front + s.incentives), reserve: s.reserve, profit: s.productProfit, sold: s.products,
    product: round2(PRODUCTS.reduce((u, [k]) => u + s.productProfit[k], 0)), back: s.back, total: round2(s.front + s.incentives + s.back)
  });
  const rollup = list => {
    const rows = list.map(dealRow);
    const add = f => round2(rows.reduce((x, d) => x + n(d[f]), 0));
    return {
      deals: rows.length, front: add('front'), reserve: add('reserve'), product: add('product'), back: add('back'), total: add('total'),
      reserveCount: list.filter(s => s.reserve > 0).length,
      profit: Object.fromEntries(PRODUCTS.map(([k]) => [k, round2(rows.reduce((x, d) => x + d.profit[k], 0))])),
      counts: Object.fromEntries(PRODUCTS.map(([k]) => [k, list.filter(s => s.products[k]).length])),
      productCount: productCount(list), list: rows.sort((a, b) => String(a.dealNumber).localeCompare(String(b.dealNumber), undefined, { numeric: true }))
    };
  };
  const team = [...byFi.entries()].map(([id, list]) => ({ id, name: id ? (data.staff.get(String(id)) || {}).name || 'Former employee' : 'No F&I manager on the deal', ...rollup(list) }))
    .sort((a, b) => b.back - a.back);
  res.json({
    type, summary, team, totals: rollup(deals),
    canSetTarget: auth.can(req.user, 'manageRotation'),
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

// ---------- The books (Accounting Domus) ----------

// Expenses posted by department (or by account), for one month.
async function bookExpenses(dealershipId, month, byAccount = false) {
  const { rows } = await store.pool.query(
    `SELECT ${byAccount ? 'a.number, a.name, a.dept, a.grp' : 'a.dept, a.grp'}, sum(l.amount) AS amt FROM journal_lines l
     JOIN gl_accounts a ON a.dealership_id = l.dealership_id AND a.number = l.account
     WHERE l.dealership_id = $1 AND a.type = 'expense' AND l.posted_on >= $2::date AND l.posted_on < ($2::date + interval '1 month')
     GROUP BY ${byAccount ? 'a.number, a.name, a.dept, a.grp' : 'a.dept, a.grp'}`, [dealershipId, `${month}-01`]);
  return rows.map(r => ({ ...r, amt: round2(r.amt) }));
}
const DEPT_KEYS = ['new', 'used', 'fi', 'service', 'parts', ''];
const DEPT_LABELS = { new: 'New Vehicles', used: 'Used Vehicles', fi: 'F&I', service: 'Service', parts: 'Parts', '': 'Store / Admin' };
const PLAN_FIELD = { new: 'newVariable', used: 'usedVariable', service: 'service', parts: 'parts', '': 'general' };

// Gross by department for a month, from the work itself (live).
function monthGross(data, month) {
  const [from, to] = dashboard.monthRange(month, data.tz);
  const v = summarize(data, { start: from, end: to });
  const f = dashboard.fixedSummary({ repairOrders: data.ros, partsTickets: data.tickets }, from, to);
  const usedWholesale = data.cars.filter(c => c.status === 'sold' && c.soldAs === 'wholesale' && c.dateSold && new Date(c.dateSold) >= from && new Date(c.dateSold) < to)
    .reduce((t, c) => t + n(c.wholesalePrice) - n(c.cost), 0);
  return {
    new: round2(v.new.front + v.new.incentives), used: round2(v.used.front + v.used.incentives + usedWholesale), fi: round2(v.total.back + v.total.chargebacks),
    service: round2(f.serviceGross), parts: round2(f.partsGross), '': 0, units: { new: v.new.units, used: v.used.units }, ros: f.ros
  };
}

// Expenses for a month by department: the books when anything's posted,
// otherwise what the GM entered on the dashboard.
async function monthExpenses(data, dealershipId, month) {
  const rows = await bookExpenses(dealershipId, month);
  if (rows.length) {
    const out = Object.fromEntries(DEPT_KEYS.map(k => [k, 0]));
    let variable = 0;
    for (const r of rows) { out[r.dept] = round2((out[r.dept] || 0) + r.amt); if (r.grp === 'variable') variable += r.amt; }
    return { by: out, variable: round2(variable), source: 'books' };
  }
  const plan = ((data.settings.monthlyPlan || {})[month] || {}).expenses || {};
  const out = Object.fromEntries(DEPT_KEYS.map(k => [k, PLAN_FIELD[k] ? n(plan[PLAN_FIELD[k]]) : 0]));
  return { by: out, variable: round2(out.new + out.used), source: Object.keys(plan).length ? 'entered' : 'none' };
}

router.get('/insight/store', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const t = today(data.tz);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : t.slice(0, 7);
  const current = month === t.slice(0, 7);
  const days = dashboard.openDays(month, hours.cleanStoreHours(data.settings.storeHours));
  const factor = current && days.elapsed ? days.total / days.elapsed : 1;
  const [gross, exp, lm, ly] = await Promise.all([
    monthGross(data, month), monthExpenses(data, req.dealershipId, month),
    (async () => ({ gross: monthGross(data, dashboard.shiftMonth(month, -1)), exp: await monthExpenses(data, req.dealershipId, dashboard.shiftMonth(month, -1)) }))(),
    (async () => ({ gross: monthGross(data, dashboard.shiftMonth(month, -12)), exp: await monthExpenses(data, req.dealershipId, dashboard.shiftMonth(month, -12)) }))()
  ]);
  // Where expenses will land: the last 3 months' average, or this month's pace.
  const prior3 = await Promise.all([1, 2, 3].map(k => monthExpenses(data, req.dealershipId, dashboard.shiftMonth(month, -k))));
  const rows = DEPT_KEYS.map(k => {
    const avg3 = prior3.some(p => p.source !== 'none') ? round2(prior3.reduce((s, p) => s + n(p.by[k]), 0) / 3) : null;
    const expForecast = current ? round2(Math.max(exp.by[k], avg3 !== null ? avg3 : exp.by[k] * factor)) : exp.by[k];
    const grossForecast = round2(gross[k] * factor);
    return {
      key: k, label: DEPT_LABELS[k], gross: gross[k], grossForecast, expenses: exp.by[k], expensesForecast: expForecast,
      net: round2(gross[k] - exp.by[k]), netForecast: round2(grossForecast - expForecast),
      lastMonthNet: round2(lm.gross[k] - lm.exp.by[k]), lastYearNet: round2(ly.gross[k] - ly.exp.by[k])
    };
  });
  const total = Object.fromEntries(['gross', 'grossForecast', 'expenses', 'expensesForecast', 'net', 'netForecast', 'lastMonthNet', 'lastYearNet'].map(f => [f, round2(rows.reduce((s, r) => s + r[f], 0))]));
  const fixedGross = gross.service + gross.parts;
  const overhead = round2(rows.reduce((s, r) => s + r.expenses, 0) - exp.variable);
  res.json({
    month, current, pace: { elapsed: days.elapsed, total: days.total }, expensesFrom: exp.source, rows, total,
    units: gross.units, ros: gross.ros, absorption: overhead > 0 ? round2(fixedGross / overhead * 100) : null
  });
}));

router.get('/insight/fixed', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const service = require('./service');
  const settings = await service.settingsOf(store.pool, req.dealershipId);
  const pay = new Map([...data.staff.values()].map(u => [u.id, u.pay || {}]));
  const name = id => (data.staff.get(String(id)) || {}).name || 'Unassigned';
  const closed = data.ros.filter(ro => ro.status === 'closed' && ro.closedTotals && inRange(new Date(ro.closedAt).getTime(), r));
  const sum = (list, fn) => round2(list.reduce((t, x) => t + n(fn(x)), 0));
  const byType = ['customer', 'warranty', 'internal'].map(k => {
    const list = closed.filter(ro => n(ro.closedTotals[k] && (ro.closedTotals[k].labor + ro.closedTotals[k].parts)));
    const labor = sum(closed, ro => ro.closedTotals[k] && ro.closedTotals[k].labor), hoursSold = sum(closed, ro => ro.closedTotals[k] && ro.closedTotals[k].hours);
    const laborCost = sum(closed, ro => ro.closedTotals[k] && ro.closedTotals[k].laborCost);
    const parts = sum(closed, ro => ro.closedTotals[k] && ro.closedTotals[k].parts), partsCost = sum(closed, ro => ro.closedTotals[k] && ro.closedTotals[k].partsCost);
    return { type: k, ros: list.length, hours: hoursSold, labor, laborGross: round2(labor - laborCost), elr: hoursSold ? round2(labor / hoursSold) : null, hoursPerRo: list.length ? round2(hoursSold / list.length) : null, parts, partsGross: round2(parts - partsCost) };
  });
  // Technicians: hours flagged on closed ROs vs hours on the clock.
  const techs = new Map();
  const tech = id => { if (!techs.has(id)) techs.set(id, { id, name: name(id), flagged: 0, clocked: 0, labor: 0, jobs: 0 }); return techs.get(id); };
  for (const ro of closed) for (const j of ro.jobs || []) if (j.techId) { const x = tech(String(j.techId)); x.flagged += n(j.hours); x.labor += n(j.hours) * n(j.rate); x.jobs++; }
  for (const ro of data.ros) for (const j of ro.jobs || []) for (const p of j.punches || []) {
    const st = new Date(p.start).getTime();
    if (!inRange(st, r) || !(p.techId || j.techId)) continue;
    tech(String(p.techId || j.techId)).clocked += Math.max(0, ((p.end ? new Date(p.end).getTime() : Date.now()) - st) / 3600000);
  }
  const techList = [...techs.values()].map(x => ({ ...x, flagged: round2(x.flagged), clocked: round2(x.clocked), labor: round2(x.labor), productivity: x.clocked ? round2(x.flagged / x.clocked * 100) : null, payType: (pay.get(x.id) || {}).type || '' }))
    .sort((a, b) => b.flagged - a.flagged);
  // Advisors.
  const adv = new Map();
  for (const ro of closed) {
    const k = String(ro.advisorId || (ro.openedBy && ro.openedBy.id) || '');
    if (!adv.has(k)) adv.set(k, { id: k, name: name(k), ros: 0, cpRos: 0, cpLabor: 0, cpHours: 0, parts: 0, total: 0 });
    const x = adv.get(k), c = ro.closedTotals.customer || {};
    x.ros++; if (n(c.labor) + n(c.parts)) x.cpRos++; x.cpLabor += n(c.labor); x.cpHours += n(c.hours); x.parts += n(ro.closedTotals.partsSale); x.total += n(ro.closedTotals.customerTotal) + n(ro.closedTotals.warrantyTotal);
  }
  const advisors = [...adv.values()].map(x => ({ ...x, cpLabor: round2(x.cpLabor), cpHours: round2(x.cpHours), parts: round2(x.parts), total: round2(x.total), elr: x.cpHours ? round2(x.cpLabor / x.cpHours) : null, hoursPerRo: x.cpRos ? round2(x.cpHours / x.cpRos) : null })).sort((a, b) => b.ros - a.ros);
  // Counter sales by type.
  const tickets = data.tickets.filter(t => t.status === 'closed' && t.closedTotals && inRange(new Date(t.closedAt).getTime(), r));
  const counter = ['retail', 'wholesale', 'internal'].map(k => {
    const list = tickets.filter(t => (t.saleType || 'retail') === k);
    return { type: k, tickets: list.length, sale: sum(list, t => t.closedTotals.sale), gross: round2(sum(list, t => t.closedTotals.sale) - sum(list, t => t.closedTotals.cost)) };
  });
  // Open ROs, oldest first.
  const now = Date.now();
  const open = data.ros.filter(ro => service.OPEN_STATUSES.includes(ro.status)).map(ro => {
    const tt = service.totals(ro, settings, new Map([...pay.entries()]));
    return { id: ro.id, roNumber: ro.roNumber, customer: ro.customerName || (ro.carId ? 'Internal / recon' : '--'), advisor: name(ro.advisorId), status: ro.status,
      days: Math.max(0, Math.floor((now - new Date(ro.openedAt)) / DAY)), vehicle: [ro.vehicle && ro.vehicle.year, ro.vehicle && ro.vehicle.make, ro.vehicle && ro.vehicle.model].filter(Boolean).join(' '),
      sale: round2(tt.laborSale + tt.partsSale), internal: !!ro.carId && !ro.leadId };
  }).sort((a, b) => b.days - a.days);
  const laborSale = sum(byType, x => x.labor), partsSale = round2(sum(byType, x => x.parts) + sum(counter, x => x.sale));
  const serviceGross = sum(byType, x => x.laborGross), partsGross = round2(sum(byType, x => x.partsGross) + sum(counter, x => x.gross));
  const cp = byType[0];
  res.json({
    from: r.from, to: r.to, ros: closed.length, hours: sum(byType, x => x.hours), laborSale, serviceGross, partsSale, partsGross,
    laborMargin: laborSale ? round2(serviceGross / laborSale * 100) : null, partsMargin: partsSale ? round2(partsGross / partsSale * 100) : null,
    elr: cp.elr, cpHoursPerRo: cp.hoursPerRo, byType, techs: techList, advisors, counter, open,
    openBuckets: [[0, 1, 'Today / 1 day'], [2, 3, '2-3 days'], [4, 7, '4-7 days'], [8, Infinity, '8+ days']].map(([lo, hi, label]) => ({ label, ros: open.filter(o => o.days >= lo && o.days <= hi).length }))
  });
}));

router.get('/insight/expenses', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const t = today(data.tz);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : t.slice(0, 7);
  const back = k => dashboard.shiftMonth(month, -k);
  const monthsBack = [1, 2, 3, 4, 5, 6].map(back);
  const [mtd, ly, ...prior] = await Promise.all([bookExpenses(req.dealershipId, month, true), bookExpenses(req.dealershipId, back(12), true), ...monthsBack.map(m => bookExpenses(req.dealershipId, m, true))]);
  const accounts = new Map();
  const add = (r, field) => {
    if (!accounts.has(r.number)) accounts.set(r.number, { number: r.number, name: r.name, dept: r.dept, deptLabel: DEPT_LABELS[r.dept] || r.dept, grp: r.grp, mtd: 0, lastYear: 0, months: [0, 0, 0, 0, 0, 0] });
    const a = accounts.get(r.number);
    if (typeof field === 'number') a.months[field] = r.amt; else a[field] = r.amt;
  };
  mtd.forEach(r => add(r, 'mtd')); ly.forEach(r => add(r, 'lastYear')); prior.forEach((list, i) => list.forEach(r => add(r, i)));
  const lines = [...accounts.values()].map(a => {
    const avg6 = round2(a.months.reduce((s, v) => s + v, 0) / 6), avg3 = round2((a.months[0] + a.months[1] + a.months[2]) / 3);
    return { ...a, avg6, avg3, last3: a.months.slice(0, 3).reverse(), vs3: round2(a.mtd - avg3), vsLastYear: round2(a.mtd - a.lastYear) };
  }).sort((x, y) => DEPT_KEYS.indexOf(x.dept) - DEPT_KEYS.indexOf(y.dept) || x.number.localeCompare(y.number));
  // Cash: what's owed to the store, from the books' schedules.
  const api = require('./accounting-api');
  const acct = require('./accounting');
  const chart = await acct.chartOf(store.pool, req.dealershipId);
  const items = await api.scheduleItems(store.pool, req.dealershipId, null, t);
  const nat = (a, v) => (acct.DEBIT_NORMAL.has(a.type) ? v : -v);
  const schedules = chart.filter(a => a.scheduled && ['cit', 'vehicle_ar', 'factory_ar', 'reserve_ar', 'wholesale_ar', 'service_ar', 'warranty_ar', 'other_ar', 'deposits', 'we_owe', 'payoff_ap', 'fi_ap', 'dmv_ap'].includes(a.key)).map(a => {
    const mine = items.filter(i => i.account === a.number);
    return { number: a.number, name: a.name, key: a.key, side: a.type === 'asset' ? 'owed to us' : 'we owe', items: mine.length, total: round2(mine.reduce((s, i) => s + nat(a, i.balance), 0)),
      over30: round2(mine.filter(i => i.age > 30).reduce((s, i) => s + nat(a, i.balance), 0)), oldest: mine.length ? Math.max(...mine.map(i => i.age)) : 0 };
  });
  const citAcct = chart.find(a => a.key === 'cit');
  const oldestCit = citAcct ? items.filter(i => i.account === citAcct.number).sort((a, b) => b.age - a.age).slice(0, 10).map(i => ({ control: i.control, name: i.name, balance: i.balance, age: i.age })) : [];
  const now = Date.now();
  const unbooked = data.deals.filter(d => SOLD.includes(d.status) && !d.booked && d.deliveredAt).map(d => {
    const lead = data.leads.find(l => l.id === d.leadId) || {};
    return { dealNumber: d.dealNumber, customer: lead.name || '--', lender: d.lender || 'Cash', amount: n(d.amountFinanced), days: Math.floor((now - new Date(d.deliveredAt)) / DAY) };
  }).sort((a, b) => b.days - a.days).slice(0, 10);
  const titlesOpen = data.deals.filter(d => SOLD.includes(d.status) && !((d.titleTracking || {}).dmvSubmitted)).length;
  res.json({ month, months: monthsBack.slice(0, 3).reverse(), lines, totals: { mtd: round2(lines.reduce((s, l) => s + l.mtd, 0)), avg3: round2(lines.reduce((s, l) => s + l.avg3, 0)), lastYear: round2(lines.reduce((s, l) => s + l.lastYear, 0)) },
    schedules, oldestCit, unbooked, titlesOpen });
}));

// ---------- Heartbeat: today ----------

const SALES_FLOOR = ['salesperson', 'bdc', 'sales_manager'];
router.get('/insight/heartbeat', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const tasks = await store.list(store.pool, 'tasks', req.dealershipId);
  const day = isDay(req.query.date) ? req.query.date : today(data.tz);
  const r = { start: dayStart(day, data.tz), end: dayStart(addDays(day, 1), data.tz) };
  const at = iso => (iso ? new Date(iso).getTime() : NaN);
  const people = new Map();
  const person = id => {
    const k = String(id || '');
    if (!people.has(k)) {
      const u = data.staff.get(k);
      people.set(k, { id: k, name: u ? u.name : 'Unassigned', role: u ? u.role : '', ups: 0, calls: 0, texts: 0, emails: 0, visits: 0, apptsDue: 0, shown: 0, sold: 0, talked: 0 });
    }
    return people.get(k);
  };
  for (const u of data.staff.values()) if (u.active && SALES_FLOOR.includes(u.role)) person(u.id);
  const ups = data.leads.filter(l => inRange(at(l.dateAdded), r));
  const bySource = {};
  for (const l of ups) { person(l.sales1Id).ups++; bySource[l.source || 'other'] = (bySource[l.source || 'other'] || 0) + 1; }
  let calls = 0, texts = 0, emails = 0, visits = 0;
  for (const l of data.leads) for (const a of l.activities || []) {
    if (!inRange(at(a.date), r) || a.direction === 'in' && !a.reached) continue;
    const x = a.by && a.by.id ? person(a.by.id) : null;
    if (a.type === 'call') { calls++; if (x) x.calls++; } else if (a.type === 'text' && a.direction !== 'in') { texts++; if (x) x.texts++; } else if (a.type === 'email') { emails++; if (x) x.emails++; } else if (a.type === 'visit') { visits++; if (x) x.visits++; }
    if (a.reached && x) x.talked++;
  }
  const appts = tasks.filter(t => t.type === 'appointment' && inRange(at(t.dueAt), r));
  for (const t of appts) { const x = person(t.assignedTo && t.assignedTo.id); x.apptsDue++; if (t.status === 'done') x.shown++; }
  const soldToday = data.sold.filter(s => inRange(s.soldAt, r));
  for (const s of soldToday) for (const id of s.salespeople) person(id).sold += 1 / s.salespeople.length;
  // The month so far, for context.
  const month = summarize(data, { start: dayStart(`${day.slice(0, 7)}-01`, data.tz), end: r.end });
  const nowMs = Date.now();
  res.json({
    date: day, ups: ups.length, bySource, visits, calls, texts, emails,
    appointments: { due: appts.length, shown: appts.filter(t => t.status === 'done').length, cancelled: appts.filter(t => t.status === 'cancelled').length,
      waiting: appts.filter(t => t.status === 'open' && at(t.dueAt) > nowMs).length, missed: appts.filter(t => t.status === 'open' && at(t.dueAt) <= nowMs).length },
    sold: soldToday.length, soldGross: round2(soldToday.reduce((t, s) => t + s.front + s.back + s.incentives, 0)),
    working: data.deals.filter(d => d.status === 'working').length,
    month: { units: month.total.units, gross: month.total.gross },
    people: [...people.values()].map(x => ({ ...x, sold: round2(x.sold) })).sort((a, b) => b.sold - a.sold || b.ups - a.ups || a.name.localeCompare(b.name)),
    upcoming: appts.filter(t => t.status === 'open').sort((a, b) => at(a.dueAt) - at(b.dueAt)).map(t => ({ id: t.id, time: t.dueAt, customer: t.leadName || '', title: t.title || '', with: t.assignedTo ? t.assignedTo.name : '' }))
  });
}));

// Trade-ins: the share of deals with a trade, for the store and each
// salesperson, overall and by where the customer came from (internet,
// walk-in, phone up). Split deals count as shares, like the leaderboard.
router.get('/insight/trades', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const r = range(req, data.tz);
  const type = ['new', 'used'].includes(req.query.type) ? req.query.type : '';
  const deals = data.sold.filter(s => (!type || s.type === type) && inRange(s.soldAt, r));
  const blank = () => Object.fromEntries([['all'], ...SOURCE_GROUPS].map(([k]) => [k, { deals: 0, trades: 0 }]));
  const add = (b, s, share) => { for (const k of ['all', s.sourceGroup]) { b[k].deals += share; if (s.hasTrade) b[k].trades += share; } };
  const finish = b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { deals: round2(v.deals), trades: round2(v.trades), pct: v.deals ? round2(v.trades / v.deals * 100) : null }]));
  const storeB = blank();
  const people = new Map();
  for (const s of deals) {
    add(storeB, s, 1);
    const ids = s.salespeople.length ? s.salespeople : [''];
    for (const id of ids) {
      if (!people.has(id)) people.set(id, blank());
      add(people.get(id), s, 1 / ids.length);
    }
  }
  const name = id => (id ? (data.staff.get(String(id)) || {}).name || 'Former employee' : 'No salesperson on the deal');
  res.json({
    from: r.from, to: r.to, type, groups: SOURCE_GROUPS.map(([key, label]) => ({ key, label })), store: finish(storeB),
    people: [...people.entries()].map(([id, b]) => ({ id, name: name(id), ...finish(b) })).sort((a, b) => b.all.deals - a.all.deals || a.name.localeCompare(b.name)),
    deals: deals.sort((a, b) => b.soldAt - a.soldAt).map(s => ({ id: s.id, dealNumber: s.dealNumber, customer: s.customer, vehicle: s.vehicle, type: s.type, source: s.source, group: s.sourceGroup, trade: s.hasTrade, salespeople: s.salespeople.map(name) }))
  });
}));

// The store's target for F&I products per deal (100% = one per deal).
router.put('/insight/fi-target', auth.requirePermission('manageRotation'), wrap(async (req, res) => {
  const v = Number(req.body && req.body.penetration);
  if (!Number.isFinite(v) || v < 0 || v > 1000) return res.status(400).json({ error: 'Enter a target from 0 to 1000%.' });
  await store.tx(async (q) => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = (rows[0] && rows[0].settings) || {};
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, fiTargets: { ...(settings.fiTargets || {}), penetration: round2(v) } }]);
    await require('./audit').record(q, req, { action: 'update', entityType: 'settings', entityId: 'fi-target', label: 'F&I product target', details: `${round2(v)}%` });
  });
  res.json({ penetration: round2(v) });
}));

// ---------- People: goals and reviews ----------

router.get('/insight/people', wrap(async (req, res) => {
  const data = await loadAll(req.dealershipId);
  const tasks = await store.list(store.pool, 'tasks', req.dealershipId);
  const t = today(data.tz);
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : t.slice(0, 7);
  const [from, to] = dashboard.monthRange(month, data.tz);
  const r = { start: from, end: to };
  const days = dashboard.openDays(month, hours.cleanStoreHours(data.settings.storeHours));
  const factor = month === t.slice(0, 7) && days.elapsed ? days.total / days.elapsed : 1;
  const goals = ((data.settings.salesGoals || {})[month]) || {};
  const at = iso => (iso ? new Date(iso).getTime() : NaN);
  const rows = new Map();
  const row = id => {
    const k = String(id);
    if (!rows.has(k)) {
      const u = data.staff.get(k);
      rows.set(k, { id: k, name: u ? u.name : 'Former employee', role: u ? u.role : '', units: 0, new: 0, used: 0, gross: 0, front: 0, back: 0, products: 0,
        leads: 0, leadsSold: 0, calls: 0, texts: 0, emails: 0, visits: 0, apptsSet: 0, apptsShown: 0, goal: goals[k] || null });
    }
    return rows.get(k);
  };
  for (const u of data.staff.values()) if (u.active && ['salesperson', 'bdc'].includes(u.role)) row(u.id);
  for (const s of data.sold) {
    if (!inRange(s.soldAt, r)) continue;
    const share = 1 / (s.salespeople.length || 1);
    for (const id of s.salespeople) {
      const x = row(id);
      x.units += share; x[s.type] += share; x.front += s.front * share; x.back += s.back * share; x.gross += (s.front + s.back + s.incentives) * share; x.products += s.productCount * share;
    }
  }
  for (const l of data.leads) {
    if (l.sales1Id && inRange(at(l.dateAdded), r)) { const x = row(l.sales1Id); x.leads++; if (data.sold.some(s => s.leadId === l.id)) x.leadsSold++; }
    for (const a of l.activities || []) {
      if (!a.by || !a.by.id || !inRange(at(a.date), r) || !rows.has(String(a.by.id))) continue;
      const x = rows.get(String(a.by.id));
      if (a.type === 'call') x.calls++; else if (a.type === 'text' && a.direction !== 'in') x.texts++; else if (a.type === 'email') x.emails++; else if (a.type === 'visit') x.visits++;
    }
  }
  for (const tk of tasks) {
    if (tk.type !== 'appointment' || !tk.assignedTo || !rows.has(String(tk.assignedTo.id)) || !inRange(at(tk.dueAt), r)) continue;
    const x = rows.get(String(tk.assignedTo.id));
    x.apptsSet++; if (tk.status === 'done') x.apptsShown++;
  }
  const out = [...rows.values()].map(x => {
    const units = round2(x.units), gross = round2(x.gross);
    const goalUnits = x.goal && x.goal.units !== undefined ? n(x.goal.units) : null, goalGross = x.goal && x.goal.gross !== undefined ? n(x.goal.gross) : null;
    return {
      ...x, units, new: round2(x.new), used: round2(x.used), gross, front: round2(x.front), back: round2(x.back),
      pvr: units ? round2(gross / units) : null, productsPerDeal: units ? round2(x.products / units) : null,
      closeRate: x.leads ? round2(x.leadsSold / x.leads * 100) : null, showRate: x.apptsSet ? round2(x.apptsShown / x.apptsSet * 100) : null,
      pace: { units: round2(units * factor), gross: round2(gross * factor) },
      goal: { units: goalUnits, gross: goalGross },
      toGoal: { units: goalUnits ? round2(units / goalUnits * 100) : null, gross: goalGross ? round2(gross / goalGross * 100) : null }
    };
  }).sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  res.json({ month, pace: { elapsed: days.elapsed, total: days.total }, canSetGoals: auth.can(req.user, 'manageRotation'), people: out });
}));

// Managers set each salesperson's goals for a month.
router.put('/insight/goals', auth.requirePermission('manageRotation'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(b.month || '')) return res.status(400).json({ error: 'Pick the month.' });
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const all = { ...(settings.salesGoals || {}) };
    const month = { ...(all[b.month] || {}) };
    const { rows: staff } = await q.query('SELECT id::text AS id FROM users WHERE dealership_id = $1', [req.dealershipId]);
    const ids = new Set(staff.map(u => u.id));
    for (const [id, g] of Object.entries(b.goals || {})) {
      if (!ids.has(String(id))) continue;
      const units = g && g.units !== '' && g.units !== null && g.units !== undefined ? Math.max(0, n(g.units)) : undefined;
      const gross = g && g.gross !== '' && g.gross !== null && g.gross !== undefined ? Math.max(0, round2(String(g.gross).replace(/[$,\s]/g, ''))) : undefined;
      if (units === undefined && gross === undefined) delete month[id];
      else month[id] = { ...(units !== undefined ? { units } : {}), ...(gross !== undefined ? { gross } : {}) };
    }
    all[b.month] = month;
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, salesGoals: all }]);
    await require('./audit').record(q, req, { action: 'update', entityType: 'settings', entityId: `goals-${b.month}`, label: `Sales goals ${b.month}`, details: `${Object.keys(b.goals || {}).length} people` });
    return month;
  });
  res.json(saved);
}));

// ---------- Parts inventory ----------

router.get('/insight/parts', wrap(async (req, res) => {
  const [parts, moves] = await Promise.all([store.list(store.pool, 'parts', req.dealershipId), store.list(store.pool, 'part_moves', req.dealershipId)]);
  const now = Date.now();
  const live = parts.filter(p => !p.inactive);
  const value = p => Math.max(0, n(p.onHand)) * n(p.cost);
  // What went out (used on ROs or sold) in the last year and 90 days.
  const out = new Map();
  for (const m of moves) {
    if (!['ro', 'ticket'].includes(m.type)) continue;
    const ago = (now - new Date(m.at).getTime()) / DAY;
    if (ago > 365) continue;
    if (!out.has(m.partId)) out.set(m.partId, { qty365: 0, cost365: 0, qty90: 0 });
    const x = out.get(m.partId);
    x.qty365 += Math.abs(n(m.qty)); x.cost365 += Math.abs(n(m.qty)) * n(m.cost); if (ago <= 90) x.qty90 += Math.abs(n(m.qty));
  }
  const lastOut = new Map();
  for (const m of moves) if (['ro', 'ticket'].includes(m.type)) { const t = new Date(m.at).getTime(); if (!lastOut.has(m.partId) || t > lastOut.get(m.partId)) lastOut.set(m.partId, t); }
  const rows = live.map(p => {
    const o = out.get(p.id) || { qty365: 0, cost365: 0, qty90: 0 };
    const last = lastOut.get(p.id) || (p.lastSoldAt ? new Date(p.lastSoldAt).getTime() : null);
    return { id: p.id, number: p.number, description: p.description || '', bin: p.bin || '', onHand: n(p.onHand), cost: n(p.cost), value: round2(value(p)),
      sold365: round2(o.qty365), sold90: round2(o.qty90), costSold365: round2(o.cost365), daysSinceSale: last ? Math.floor((now - last) / DAY) : null,
      monthsSupply: o.qty90 ? round2(n(p.onHand) / (o.qty90 / 3)) : null };
  });
  const stockValue = round2(rows.reduce((t, x) => t + x.value, 0));
  const costSold = round2(rows.reduce((t, x) => t + x.costSold365, 0));
  const idle = days => rows.filter(x => x.onHand > 0 && (x.daysSinceSale === null || x.daysSinceSale > days));
  const sum = list => round2(list.reduce((t, x) => t + x.value, 0));
  res.json({
    skus: rows.length, onHandSkus: rows.filter(x => x.onHand > 0).length, value: stockValue, costSold365: costSold, turns: stockValue ? round2(costSold / stockValue) : null,
    idle: [[90, 'No sale in 90+ days'], [180, 'No sale in 180+ days'], [365, 'No sale in a year']].map(([d, label]) => ({ days: d, label, skus: idle(d).length, value: sum(idle(d)) })),
    oldest: idle(180).sort((a, b) => b.value - a.value).slice(0, 25),
    topSellers: rows.filter(x => x.sold90).sort((a, b) => b.sold90 - a.sold90).slice(0, 15),
    overstock: rows.filter(x => x.monthsSupply !== null && x.monthsSupply > 6).sort((a, b) => b.value - a.value).slice(0, 15)
  });
}));

module.exports = { router, ageBand };
