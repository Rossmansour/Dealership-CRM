// dashboard.js
// The management dashboard: the whole store (GM), variable (sales & F&I),
// and fixed (service & parts, from closed repair orders), month by month -- MTD, pace, forecast
// (goals), last month, and last year, with the deals behind each number.
//
// Gross, per retail deal:
//   front   = selling price - vehicle cost - pack + doc fee - trade over-allowance
//   finance = F&I product sales - F&I product cost + lender reserve
//   incentives = factory cash to the dealer
//   chargebacks = cancelled F&I products, counted in the month they come back
// A deal counts in the month it was delivered; "final" once it's finalized.
// Wholesale = cars sold to other dealers/auction: price - cost.
// Pace = MTD / open days so far x open days in the month (store hours).

const express = require('express');
const store = require('./db');
const auth = require('./auth');
const hours = require('./hours');

const SOLD = ['delivered', 'closed', 'finalized'];
const TYPES = ['new', 'used'];
const n = v => Number(v) || 0;

// ---------- Months in the store's time zone ----------
function monthKey(y, m) { const d = new Date(Date.UTC(y, m, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function parseMonth(key) { const [y, m] = String(key).split('-').map(Number); return { y, m: m - 1 }; }
function shiftMonth(key, delta) { const { y, m } = parseMonth(key); return monthKey(y, m + delta); }
function monthRange(key, tz) {
  const { y, m } = parseMonth(key);
  return [hours.zonedToUtc(y, m, 1, 0, 0, tz), hours.zonedToUtc(y, m + 1, 1, 0, 0, tz)];
}
function currentMonth(tz) { const d = hours.localDate(Date.now(), tz); return monthKey(d.y, d.m); }

// Open days in the month, and how many of them have started so far.
function openDays(key, storeHours) {
  const tz = storeHours.timezone;
  const { y, m } = parseMonth(key);
  const today = hours.localDate(Date.now(), tz);
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let total = 0, elapsed = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    if ((storeHours.days[hours.DAYS[dow]] || {}).closed) continue;
    total++;
    const past = y < today.y || (y === today.y && (m < today.m || (m === today.m && d <= today.d)));
    if (past) elapsed++;
  }
  return { total, elapsed };
}

// ---------- Gross per deal ----------
function dealGross(deal, car, settings, tradeAcv) {
  const type = car && car.stockType === 'new' ? 'new' : 'used';
  const pack = type === 'new' ? n(settings.newCarPack) : n(settings.appraisalPack);
  const overAllowance = tradeAcv !== null && tradeAcv !== undefined && deal.hasTrade ? n(deal.tradeInValue) - n(tradeAcv) : 0;
  const front = n(deal.vehiclePrice) - n(car && car.cost) - pack + n(deal.docFee) - overAllowance;
  const products = n(deal.gapPremium) + n(deal.servicePremium) + n(deal.maintenancePremium) + n(deal.aftermarketAmount) + n(deal.creditInsPremium);
  const finance = products - n(deal.fiProductCost) + n(deal.reserve);
  return { type, front, finance, incentives: n(deal.incentives), pack, overAllowance };
}

function emptyBucket() {
  return { units: 0, finalUnits: 0, notFinalUnits: 0, front: 0, finance: 0, incentives: 0, chargebacks: 0, finalGross: 0, notFinalGross: 0, dealIds: [], chargebackDealIds: [] };
}

// Everything sold in [from, to): retail by new/used, and wholesale.
function summarize(data, from, to, includeChargebacks) {
  const { deals, cars, appraisals, settings } = data;
  const carById = new Map(cars.map(c => [c.id, c]));
  const acvByDeal = new Map(appraisals.filter(a => a.dealId && a.status === 'acquired' && a.acquiredFor).map(a => [a.dealId, a.acquiredFor]));
  const out = { new: emptyBucket(), used: emptyBucket(), wholesale: { new: { units: 0, gross: 0, carIds: [] }, used: { units: 0, gross: 0, carIds: [] } } };
  const inRange = iso => { if (!iso) return false; const t = new Date(iso).getTime(); return t >= from && t < to; };
  for (const d of deals) {
    const car = carById.get(d.carId);
    const soldAt = d.deliveredAt || (car && car.status === 'sold' && car.dateSold) || null;
    const g = dealGross(d, car, settings, acvByDeal.get(d.id));
    if (SOLD.includes(d.status) && inRange(soldAt) && !(car && car.soldAs === 'wholesale')) {
      const b = out[g.type];
      const total = g.front + g.finance + g.incentives;
      b.units++; b.front += g.front; b.finance += g.finance; b.incentives += g.incentives; b.dealIds.push(d.id);
      if (d.status === 'finalized') { b.finalUnits++; b.finalGross += total; } else { b.notFinalUnits++; b.notFinalGross += total; }
    }
    if (includeChargebacks && n(d.chargebackAmount) && inRange(d.chargebackDate || soldAt)) {
      out[g.type].chargebacks -= Math.abs(n(d.chargebackAmount));
      out[g.type].chargebackDealIds.push(d.id);
    }
  }
  for (const c of cars) {
    if (c.status !== 'sold' || c.soldAs !== 'wholesale' || !inRange(c.dateSold)) continue;
    const w = out.wholesale[c.stockType === 'new' ? 'new' : 'used'];
    w.units++; w.gross += n(c.wholesalePrice) - n(c.cost); w.carIds.push(c.id);
  }
  for (const t of TYPES) {
    const b = out[t];
    b.gross = b.front + b.finance + b.incentives + b.chargebacks;
  }
  return out;
}

// ---------- Data loading ----------
async function loadData(dealershipId) {
  const [deals, cars, appraisals, leads, repairOrders, partsTickets, parts, dealership] = await Promise.all([
    store.list(store.pool, 'deals', dealershipId),
    store.list(store.pool, 'cars', dealershipId),
    store.list(store.pool, 'appraisals', dealershipId),
    store.list(store.pool, 'leads', dealershipId),
    store.list(store.pool, 'repair_orders', dealershipId),
    store.list(store.pool, 'parts_tickets', dealershipId),
    store.list(store.pool, 'parts', dealershipId),
    store.getDealership(store.pool, dealershipId)
  ]);
  const settings = (dealership && dealership.settings) || {};
  return {
    deals: deals.map(({ creditApp, ...d }) => d), cars, appraisals, leads: leads.map(({ creditApp, ...l }) => l), repairOrders, partsTickets, parts,
    settings, storeHours: hours.cleanStoreHours(settings.storeHours)
  };
}

const PLAN_FIELDS = {
  goals: ['newUnits', 'newGross', 'usedUnits', 'usedGross', 'serviceGross', 'partsGross', 'repairOrders'],
  expenses: ['newVariable', 'usedVariable', 'service', 'parts', 'general']
};
function planFor(settings, key) {
  const p = ((settings.monthlyPlan || {})[key]) || {};
  return {
    goals: Object.fromEntries(PLAN_FIELDS.goals.map(f => [f, p.goals && p.goals[f] !== undefined ? n(p.goals[f]) : null])),
    expenses: Object.fromEntries(PLAN_FIELDS.expenses.map(f => [f, p.expenses && p.expenses[f] !== undefined ? n(p.expenses[f]) : null]))
  };
}

// Deal details for drill-downs.
function dealRows(data, ids) {
  const carById = new Map(data.cars.map(c => [c.id, c]));
  const leadById = new Map(data.leads.map(l => [l.id, l]));
  const acvByDeal = new Map(data.appraisals.filter(a => a.dealId && a.status === 'acquired' && a.acquiredFor).map(a => [a.dealId, a.acquiredFor]));
  return data.deals.filter(d => ids.has(d.id)).map(d => {
    const car = carById.get(d.carId);
    const lead = leadById.get(d.leadId);
    const g = dealGross(d, car, data.settings, acvByDeal.get(d.id));
    return {
      id: d.id, dealNumber: d.dealNumber, status: d.status, soldAt: d.deliveredAt || (car && car.dateSold) || null,
      customer: lead ? lead.name : '--', leadId: lead ? lead.id : null, type: g.type,
      vehicle: car ? [car.year, car.make, car.model].filter(Boolean).join(' ') : '--', stockNumber: car ? car.stockNumber || '' : '',
      front: g.front, finance: g.finance, incentives: g.incentives, chargeback: -Math.abs(n(d.chargebackAmount)),
      total: g.front + g.finance + g.incentives
    };
  });
}
function carRows(data, ids) {
  return data.cars.filter(c => ids.has(c.id)).map(c => ({
    id: c.id, vehicle: [c.year, c.make, c.model].filter(Boolean).join(' '), stockNumber: c.stockNumber || '',
    soldAt: c.dateSold, price: n(c.wholesalePrice), cost: n(c.cost), gross: n(c.wholesalePrice) - n(c.cost), type: c.stockType === 'new' ? 'new' : 'used'
  }));
}

// Finished deals worth a second look: money review, not work in progress.
function reviewList(data, key, from, to) {
  const carById = new Map(data.cars.map(c => [c.id, c]));
  const acvByDeal = new Map(data.appraisals.filter(a => a.dealId && a.status === 'acquired' && a.acquiredFor).map(a => [a.dealId, a.acquiredFor]));
  const overLimit = Math.max(0, n(data.settings.overAllowanceReview) || 1000);
  const finalizeDays = Math.max(1, n(data.settings.finalizeReviewDays) || 3);
  const out = { noProducts: [], negativeFront: [], overAllowance: [], notFinalized: [], chargebacks: [] };
  for (const d of data.deals) {
    if (!SOLD.includes(d.status)) continue;
    const car = carById.get(d.carId);
    const soldAt = d.deliveredAt || (car && car.dateSold);
    const t = soldAt ? new Date(soldAt).getTime() : NaN;
    const g = dealGross(d, car, data.settings, acvByDeal.get(d.id));
    if (t >= from && t < to && !(car && car.soldAs === 'wholesale')) {
      const products = n(d.gapPremium) + n(d.servicePremium) + n(d.maintenancePremium) + n(d.aftermarketAmount) + n(d.creditInsPremium);
      if (!products) out.noProducts.push(d.id);
      if (g.front < 0) out.negativeFront.push(d.id);
      if (g.overAllowance > overLimit) out.overAllowance.push(d.id);
    }
    // Delivered but not finalized for too long (any month): holds up funding.
    if (d.status !== 'finalized' && soldAt && Date.now() - t > finalizeDays * 86400000) out.notFinalized.push(d.id);
    const cbAt = d.chargebackDate || soldAt;
    if (n(d.chargebackAmount) && cbAt && new Date(cbAt).getTime() >= from && new Date(cbAt).getTime() < to) out.chargebacks.push(d.id);
  }
  return {
    noProducts: { label: 'Delivered with no F&I products', ids: out.noProducts },
    negativeFront: { label: 'Negative front gross', ids: out.negativeFront },
    overAllowance: { label: `Trade over-allowance over $${overLimit.toLocaleString('en-US')}`, ids: out.overAllowance },
    notFinalized: { label: `Delivered, not finalized after ${finalizeDays} days`, ids: out.notFinalized },
    chargebacks: { label: 'Chargebacks this month', ids: out.chargebacks }
  };
}

function variableReport(data, key, includeChargebacks) {
  const tz = data.storeHours.timezone;
  const range = k => monthRange(k, tz);
  const [from, to] = range(key);
  const mtd = summarize(data, from, to, includeChargebacks);
  const lastMonth = summarize(data, ...range(shiftMonth(key, -1)), includeChargebacks);
  const lastYear = summarize(data, ...range(shiftMonth(key, -12)), includeChargebacks);
  const days = openDays(key, data.storeHours);
  // The 12 months before this one, for trend lines.
  const trend = [];
  for (let i = 12; i >= 1; i--) {
    const k = shiftMonth(key, -i);
    const s = summarize(data, ...range(k), includeChargebacks);
    trend.push({
      month: k, new: s.new.gross + s.wholesale.new.gross, used: s.used.gross + s.wholesale.used.gross,
      newUnits: s.new.units, usedUnits: s.used.units,
      newFront: s.new.front, usedFront: s.used.front, newFinance: s.new.finance, usedFinance: s.used.finance
    });
  }
  const exceptions = reviewList(data, key, from, to);
  const ids = new Set([...mtd.new.dealIds, ...mtd.used.dealIds, ...mtd.new.chargebackDealIds, ...mtd.used.chargebackDealIds,
    ...Object.values(exceptions).flatMap(x => x.ids)]);
  const carIds = new Set([...mtd.wholesale.new.carIds, ...mtd.wholesale.used.carIds]);
  return {
    month: key, pace: { elapsedDays: days.elapsed, totalDays: days.total, factor: days.elapsed ? days.total / days.elapsed : 0 },
    mtd, lastMonth, lastYear, trend, exceptions, plan: planFor(data.settings, key),
    lastYearPlan: planFor(data.settings, shiftMonth(key, -12)),
    deals: dealRows(data, ids), wholesaleCars: carRows(data, carIds),
    includeChargebacks
  };
}

function storeReport(data, key) {
  const v = variableReport(data, key, true);
  const fixed = fixedReport(data, key);
  const tz = data.storeHours.timezone;
  const [from, to] = monthRange(key, tz);
  const inMonth = iso => { const t = new Date(iso).getTime(); return t >= from && t < to; };
  const stock = data.cars.filter(c => c.status !== 'sold');
  const aged = stock.filter(c => c.dateAdded && Date.now() - new Date(c.dateAdded) >= 60 * 86400000);
  const newLeads = data.leads.filter(l => inMonth(l.dateAdded));
  return {
    ...v,
    fixed: { mtd: fixed.mtd, lastMonth: fixed.lastMonth, lastYear: fixed.lastYear, trend: fixed.trend, ros: fixed.ros },
    inventory: {
      units: stock.length, newUnits: stock.filter(c => c.stockType === 'new').length, usedUnits: stock.filter(c => c.stockType !== 'new').length,
      value: stock.reduce((s, c) => s + n(c.cost), 0), aged: aged.length
    },
    leads: { count: newLeads.length, sold: newLeads.filter(l => l.status === 'won' || data.deals.some(d => d.leadId === l.id && SOLD.includes(d.status))).length }
  };
}

// ---------- Fixed ops (service & parts), from closed repair orders ----------
// Service gross = labor sold - what the techs are paid for it. Parts gross =
// parts sold - parts cost, on ROs and over the counter. Counted in the month
// the RO or ticket closed.
function fixedSummary(data, from, to) {
  const out = {
    ros: 0, roIds: [], hours: 0, customerHours: 0,
    customerLabor: 0, warrantyLabor: 0, internalLabor: 0, laborSale: 0, laborCost: 0,
    partsSale: 0, partsCost: 0, counterSale: 0, counterCost: 0, tickets: 0, ticketIds: []
  };
  for (const ro of data.repairOrders || []) {
    if (ro.status !== 'closed' || !ro.closedTotals) continue;
    const t = new Date(ro.closedAt).getTime();
    if (!(t >= from && t < to)) continue;
    const c = ro.closedTotals;
    out.ros++; out.roIds.push(ro.id);
    out.hours += n(c.hours); out.customerHours += n(c.customer && c.customer.hours);
    out.customerLabor += n(c.customer && c.customer.labor);
    out.warrantyLabor += n(c.warranty && c.warranty.labor);
    out.internalLabor += n(c.internal && c.internal.labor);
    out.laborSale += n(c.laborSale); out.laborCost += n(c.laborCost);
    out.partsSale += n(c.partsSale); out.partsCost += n(c.partsCost);
  }
  // Counter sales (parts tickets) count toward parts.
  for (const t of data.partsTickets || []) {
    if (t.status !== 'closed' || !t.closedTotals) continue;
    const at = new Date(t.closedAt).getTime();
    if (!(at >= from && at < to)) continue;
    out.tickets++; out.ticketIds.push(t.id);
    out.counterSale += n(t.closedTotals.sale); out.counterCost += n(t.closedTotals.cost);
  }
  out.partsSale += out.counterSale; out.partsCost += out.counterCost;
  out.serviceGross = out.laborSale - out.laborCost;
  out.partsGross = out.partsSale - out.partsCost;
  out.gross = out.serviceGross + out.partsGross;
  out.elr = out.customerHours ? out.customerLabor / out.customerHours : null; // effective labor rate
  out.hoursPerRo = out.ros ? out.hours / out.ros : null;
  return out;
}

function fixedReport(data, key) {
  const tz = data.storeHours.timezone;
  const range = k => monthRange(k, tz);
  const [from, to] = range(key);
  const days = openDays(key, data.storeHours);
  const trend = [];
  for (let i = 12; i >= 1; i--) {
    const k = shiftMonth(key, -i);
    const f = fixedSummary(data, ...range(k));
    trend.push({ month: k, serviceGross: f.serviceGross, partsGross: f.partsGross, ros: f.ros, hours: f.hours, elr: f.elr });
  }
  const mtd = fixedSummary(data, from, to);
  const roById = new Map((data.repairOrders || []).map(r => [r.id, r]));
  return {
    month: key, available: true,
    partsStock: (() => {
      const live = (data.parts || []).filter(p => !p.inactive);
      return { skus: live.length, value: live.reduce((s, p) => s + Math.max(0, n(p.onHand)) * n(p.cost), 0) };
    })(),
    pace: { elapsedDays: days.elapsed, totalDays: days.total, factor: days.elapsed ? days.total / days.elapsed : 0 },
    mtd, lastMonth: fixedSummary(data, ...range(shiftMonth(key, -1))), lastYear: fixedSummary(data, ...range(shiftMonth(key, -12))),
    trend, plan: planFor(data.settings, key),
    ros: mtd.roIds.map(id => roById.get(id)).map(r => ({
      id: r.id, roNumber: r.roNumber, customer: r.customerName || (r.carId ? 'Internal' : '--'),
      vehicle: [r.vehicle && r.vehicle.year, r.vehicle && r.vehicle.make, r.vehicle && r.vehicle.model].filter(Boolean).join(' '),
      closedAt: r.closedAt, hours: n(r.closedTotals.hours), labor: n(r.closedTotals.laborSale), laborCost: n(r.closedTotals.laborCost),
      parts: n(r.closedTotals.partsSale), partsCost: n(r.closedTotals.partsCost),
      gross: n(r.closedTotals.laborSale) - n(r.closedTotals.laborCost) + n(r.closedTotals.partsSale) - n(r.closedTotals.partsCost)
    }))
  };
}

// ---------- Routes ----------
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const TAB_PERMISSION = { store: 'viewDashboardStore', variable: 'viewDashboardVariable', fixed: 'viewDashboardFixed' };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

router.get('/dashboard/:tab', wrap(async (req, res) => {
  const perm = TAB_PERMISSION[req.params.tab];
  if (!perm) return res.status(404).json({ error: 'Not found.' });
  if (!auth.can(req.user, perm)) return res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  const data = await loadData(req.dealershipId);
  const key = MONTH.test(req.query.month || '') ? req.query.month : currentMonth(data.storeHours.timezone);
  if (req.params.tab === 'variable') return res.json(variableReport(data, key, req.query.chargebacks !== '0'));
  if (req.params.tab === 'store') return res.json(storeReport(data, key));
  res.json(fixedReport(data, key));
}));

// Monthly goals (forecast) and expenses. Variable goals: sales managers /
// F&I; fixed goals: service & parts managers; expenses: the GM.
router.put('/dashboard/plan/:month', wrap(async (req, res) => {
  const key = req.params.month;
  if (!MONTH.test(key)) return res.status(400).json({ error: 'Pick a month.' });
  const b = req.body || {};
  const allowed = {
    newUnits: 'viewDashboardVariable', newGross: 'viewDashboardVariable', usedUnits: 'viewDashboardVariable', usedGross: 'viewDashboardVariable',
    serviceGross: 'viewDashboardFixed', partsGross: 'viewDashboardFixed', repairOrders: 'viewDashboardFixed'
  };
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const plan = { ...(settings.monthlyPlan || {}) };
    const month = { goals: { ...((plan[key] || {}).goals || {}) }, expenses: { ...((plan[key] || {}).expenses || {}) } };
    let changed = 0, refused = 0;
    for (const [f, v] of Object.entries(b.goals || {})) {
      if (!allowed[f]) continue;
      if (!auth.can(req.user, allowed[f])) { refused++; continue; }
      month.goals[f] = v === '' || v === null ? undefined : n(String(v).replace(/[$,\s]/g, ''));
      changed++;
    }
    for (const [f, v] of Object.entries(b.expenses || {})) {
      if (!PLAN_FIELDS.expenses.includes(f)) continue;
      if (!auth.can(req.user, 'viewDashboardStore')) { refused++; continue; }
      month.expenses[f] = v === '' || v === null ? undefined : n(String(v).replace(/[$,\s]/g, ''));
      changed++;
    }
    if (refused && !changed) return { error: true };
    plan[key] = JSON.parse(JSON.stringify(month));
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, monthlyPlan: plan }]);
    await require('./audit').record(q, req, { action: 'update', entityType: 'settings', entityId: `plan-${key}`, label: `Goals & expenses ${key}`, details: `${changed} value${changed === 1 ? '' : 's'}` });
    return planFor({ monthlyPlan: plan }, key);
  });
  if (saved.error) return res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  res.json(saved);
}));

module.exports = { router, dealGross, summarize, fixedSummary, openDays, monthRange, shiftMonth };
