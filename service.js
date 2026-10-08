// service.js
// The Service department: repair orders (ROs), service appointments,
// technician time, and the shop's labor rates and tax.
//
// An RO is for one vehicle (by VIN) and, for customer work, one customer
// -- the same customer record Sales uses, so their whole history is in one
// place. Each RO has jobs ("lines"): the customer's concern, the cause and
// correction, who pays (customer, warranty, or internal), the technician,
// the labor hours sold, and the parts used.
//
// Money on an RO:
//   labor sale  = hours sold x the job's labor rate
//   labor cost  = what the tech is paid for it: flat-rate techs get the
//                 hours sold x their rate; hourly techs get the hours they
//                 were actually clocked on the job x their rate
//   parts       = qty x price (sale) and qty x cost
//   shop supplies = a % of customer-pay labor, up to a cap
//   tax         = the store's tax rate on customer-pay parts (and labor, if
//                 the store taxes labor) and shop supplies
// Parts picked from the shelf come off it when the RO closes.
// Internal jobs on a car in inventory are reconditioning: when the RO
// closes, their total is added to that car's cost, so the car's gross is
// right when it sells.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');

const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const RO_STATUSES = ['open', 'in_progress', 'waiting_parts', 'ready', 'closed', 'void'];
const OPEN_STATUSES = ['open', 'in_progress', 'waiting_parts', 'ready'];
const PAY_TYPES = ['customer', 'warranty', 'internal'];
const JOB_STATUSES = ['pending', 'working', 'done'];
const APPT_STATUSES = ['scheduled', 'arrived', 'no_show', 'cancelled'];

function defaultServiceSettings() {
  return {
    customerLaborRate: 150,
    warrantyLaborRate: 120,
    internalLaborRate: 90,
    shopSuppliesPct: 0,
    shopSuppliesCap: 0,
    taxParts: true,
    taxLabor: false
  };
}
function serviceSettings(settings) {
  const s = { ...defaultServiceSettings(), ...((settings && settings.service) || {}) };
  return { ...s, taxRate: n(settings && settings.taxRate) };
}

// ---------- Money ----------

function clockedHours(job) {
  return (job.punches || []).reduce((sum, p) => {
    const end = p.end ? new Date(p.end).getTime() : Date.now();
    return sum + Math.max(0, end - new Date(p.start).getTime()) / 3600000;
  }, 0);
}

function laborCost(job, payById) {
  const pay = payById.get(job.techId) || {};
  if (!pay.rate) return 0;
  return pay.type === 'hourly' ? clockedHours(job) * n(pay.rate) : n(job.hours) * n(pay.rate);
}

// Totals for an RO. payById: tech user id -> { type, rate }.
function totals(ro, settings, payById = new Map()) {
  const cfg = serviceSettings(settings);
  const by = Object.fromEntries(PAY_TYPES.map(t => [t, { labor: 0, laborCost: 0, hours: 0, parts: 0, partsCost: 0 }]));
  for (const job of ro.jobs || []) {
    const b = by[job.payType] || by.customer;
    b.labor += n(job.hours) * n(job.rate);
    b.hours += n(job.hours);
    b.laborCost += laborCost(job, payById);
    for (const p of job.parts || []) {
      b.parts += n(p.qty) * n(p.price);
      b.partsCost += n(p.qty) * n(p.cost);
    }
  }
  const c = by.customer;
  let shopSupplies = c.labor * n(cfg.shopSuppliesPct) / 100;
  if (n(cfg.shopSuppliesCap) > 0) shopSupplies = Math.min(shopSupplies, n(cfg.shopSuppliesCap));
  const taxable = (cfg.taxParts ? c.parts + shopSupplies : 0) + (cfg.taxLabor ? c.labor : 0);
  const tax = taxable * cfg.taxRate / 100;
  const r = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]));
  const out = {
    customer: r(c), warranty: r(by.warranty), internal: r(by.internal),
    shopSupplies: round2(shopSupplies), tax: round2(tax),
    customerTotal: round2(c.labor + c.parts + shopSupplies + tax),
    warrantyTotal: round2(by.warranty.labor + by.warranty.parts),
    internalTotal: round2(by.internal.labor + by.internal.parts)
  };
  out.laborSale = round2(c.labor + by.warranty.labor + by.internal.labor);
  out.laborCost = round2(c.laborCost + by.warranty.laborCost + by.internal.laborCost);
  out.hours = round2(c.hours + by.warranty.hours + by.internal.hours);
  out.partsSale = round2(c.parts + by.warranty.parts + by.internal.parts);
  out.partsCost = round2(c.partsCost + by.warranty.partsCost + by.internal.partsCost);
  return out;
}

// ---------- Cleaning what the browser sends ----------

function cleanVehicle(v) {
  v = v || {};
  return {
    vin: text(v.vin, 17).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    year: text(v.year, 4), make: text(v.make, 40), model: text(v.model, 60), trim: text(v.trim, 60),
    color: text(v.color, 30), plate: text(v.plate, 12).toUpperCase(),
    mileageIn: v.mileageIn === '' || v.mileageIn === undefined || v.mileageIn === null ? null : Math.max(0, Math.round(n(v.mileageIn))),
    mileageOut: v.mileageOut === '' || v.mileageOut === undefined || v.mileageOut === null ? null : Math.max(0, Math.round(n(v.mileageOut)))
  };
}

function cleanPart(p) {
  p = p || {};
  return {
    id: text(p.id, 40) || crypto.randomUUID(),
    partId: p.partId ? text(p.partId, 60) : null, // from the parts shelf
    number: text(p.number, 40), description: text(p.description, 120),
    qty: Math.max(0, round2(p.qty === undefined || p.qty === '' ? 1 : p.qty)),
    cost: Math.max(0, round2(p.cost)), price: Math.max(0, round2(p.price))
  };
}

// A job from the browser, merged onto the saved one. Clock punches only
// change through /clock, so they always come from the saved job.
function cleanJob(j, saved, cfg) {
  j = j || {};
  const payType = PAY_TYPES.includes(j.payType) ? j.payType : (saved && saved.payType) || 'customer';
  const defaultRate = cfg[`${payType}LaborRate`];
  return {
    id: (saved && saved.id) || crypto.randomUUID(),
    concern: text(j.concern, 1000), cause: text(j.cause, 1000), correction: text(j.correction, 1000),
    opCode: text(j.opCode, 20),
    payType,
    techId: j.techId ? text(j.techId, 60) : null,
    hours: Math.max(0, round2(j.hours)),
    rate: j.rate === '' || j.rate === undefined || j.rate === null ? n(defaultRate) : Math.max(0, round2(j.rate)),
    status: JOB_STATUSES.includes(j.status) ? j.status : (saved && saved.status) || 'pending',
    parts: Array.isArray(j.parts) ? j.parts.slice(0, 60).map(cleanPart) : (saved && saved.parts) || [],
    punches: (saved && saved.punches) || []
  };
}

// ---------- Loading ----------

async function payMap(q, dealershipId) {
  const { rows } = await q.query('SELECT id, pay FROM users WHERE dealership_id = $1', [dealershipId]);
  return new Map(rows.map(u => [String(u.id), u.pay || {}]));
}

async function settingsOf(q, dealershipId) {
  const d = await store.getDealership(q, dealershipId);
  return { taxRate: 7, ...((d && d.settings) || {}) };
}

// What the browser gets: the RO plus its totals.
function present(ro, settings, pays, { forTech = false } = {}) {
  const out = { ...ro, totals: ro.closedTotals || totals(ro, settings, pays) };
  if (ro.closedTotals) out.closedTotals = JSON.parse(JSON.stringify(ro.closedTotals));
  out.totals = JSON.parse(JSON.stringify(out.totals));
  out.jobs = (ro.jobs || []).map(j => ({ ...j, clockedHours: round2(clockedHours(j)), clockedIn: (j.punches || []).some(p => !p.end) }));
  // Technicians see the work, not the tech pay behind the labor cost.
  if (forTech) {
    for (const tot of [out.totals, out.closedTotals].filter(Boolean)) {
      for (const t of ['customer', 'warranty', 'internal']) if (tot[t]) delete tot[t].laborCost;
      delete tot.laborCost;
    }
  }
  return out;
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allow = auth.requirePermission;
const isTech = req => req.user.role === 'technician';

async function customerName(q, dealershipId, leadId) {
  if (!leadId) return '';
  const lead = await store.get(q, 'leads', dealershipId, leadId);
  return lead ? lead.name : '';
}

// Keeps a car's list of open ROs (shown on the car) in step.
async function linkCar(q, dealershipId, carId, roId, open) {
  if (!carId) return;
  const car = await store.get(q, 'cars', dealershipId, carId, { forUpdate: true });
  if (!car) return;
  const list = new Set(car.openROs || []);
  if (open) list.add(roId); else list.delete(roId);
  await store.save(q, 'cars', dealershipId, car.id, { ...car, openROs: [...list] });
}

router.get('/service/settings', allow('viewService'), wrap(async (req, res) => {
  const s = await settingsOf(store.pool, req.dealershipId);
  res.json(serviceSettings(s));
}));

router.put('/service/settings', allow('editServiceSettings'), wrap(async (req, res) => {
  const b = req.body || {};
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const before = { ...defaultServiceSettings(), ...(settings.service || {}) };
    const next = { ...before };
    for (const f of ['customerLaborRate', 'warrantyLaborRate', 'internalLaborRate', 'shopSuppliesPct', 'shopSuppliesCap']) {
      if (f in b) next[f] = Math.max(0, round2(b[f]));
    }
    for (const f of ['taxParts', 'taxLabor']) if (f in b) next[f] = !!b[f];
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, service: next }]);
    await audit.updated(q, req, 'settings', { ...before, id: 'service-settings' }, { ...next, id: 'service-settings' }, 'Service rates & tax');
    return serviceSettings({ ...settings, service: next });
  });
  res.json(saved);
}));

// Technicians, and (for managers) how each is paid.
router.get('/service/techs', allow('viewService'), wrap(async (req, res) => {
  const { rows } = await store.pool.query(
    "SELECT id, name, pay FROM users WHERE dealership_id = $1 AND active AND role = 'technician' ORDER BY name",
    [req.dealershipId]
  );
  const showPay = auth.can(req.user, 'editServiceSettings');
  res.json(rows.map(u => ({ id: u.id, name: u.name, ...(showPay ? { pay: { type: (u.pay && u.pay.type) || 'flat', rate: n(u.pay && u.pay.rate) } } : {}) })));
}));

router.put('/service/techs/:id/pay', allow('editServiceSettings'), wrap(async (req, res) => {
  const type = req.body && req.body.type === 'hourly' ? 'hourly' : 'flat';
  const rate = Math.max(0, round2(req.body && req.body.rate));
  const result = await store.tx(async q => {
    const { rows } = await q.query(
      "SELECT id, name, email, pay FROM users WHERE id::text = $1 AND dealership_id = $2 AND role = 'technician' FOR UPDATE",
      [req.params.id, req.dealershipId]
    );
    if (!rows[0]) return null;
    await q.query('UPDATE users SET pay = $2 WHERE id = $1', [rows[0].id, { type, rate }]);
    await audit.record(q, req, {
      action: 'update', entityType: 'user', entityId: String(rows[0].id), label: `${rows[0].name} (${rows[0].email})`,
      changes: { pay: { from: rows[0].pay || {}, to: { type, rate } } }, details: 'Technician pay'
    });
    return { id: rows[0].id, name: rows[0].name, pay: { type, rate } };
  });
  if (!result) return res.status(404).json({ error: 'Technician not found.' });
  res.json(result);
}));

// ----- Repair orders -----

router.get('/service/ros', allow('viewService'), wrap(async (req, res) => {
  const [ros, settings, pays] = await Promise.all([
    store.list(store.pool, 'repair_orders', req.dealershipId),
    settingsOf(store.pool, req.dealershipId),
    payMap(store.pool, req.dealershipId)
  ]);
  let list = ros;
  if (req.query.leadId) list = list.filter(r => r.leadId === req.query.leadId);
  if (req.query.carId) list = list.filter(r => r.carId === req.query.carId);
  if (req.query.vin) list = list.filter(r => r.vehicle && r.vehicle.vin === String(req.query.vin).toUpperCase());
  if (req.query.status === 'open') list = list.filter(r => OPEN_STATUSES.includes(r.status));
  else if (req.query.status) list = list.filter(r => r.status === req.query.status);
  res.json(list.reverse().map(r => present(r, settings, pays, { forTech: isTech(req) })));
}));

router.get('/service/ros/:id', allow('viewService'), wrap(async (req, res) => {
  const ro = await store.get(store.pool, 'repair_orders', req.dealershipId, req.params.id);
  if (!ro) return res.status(404).json({ error: 'Repair order not found.' });
  const [settings, pays] = await Promise.all([settingsOf(store.pool, req.dealershipId), payMap(store.pool, req.dealershipId)]);
  res.json(present(ro, settings, pays, { forTech: isTech(req) }));
}));

async function createRo(q, req, b, extra = {}) {
  const settings = await settingsOf(q, req.dealershipId);
  const cfg = serviceSettings(settings);
  const leadId = b.leadId ? text(b.leadId, 60) : null;
  if (leadId && !await store.get(q, 'leads', req.dealershipId, leadId)) return { error: 'Customer not found.' };
  let carId = b.carId ? text(b.carId, 60) : null;
  let vehicle = cleanVehicle(b.vehicle);
  if (carId) {
    const car = await store.get(q, 'cars', req.dealershipId, carId);
    if (!car) return { error: 'Vehicle not found in inventory.' };
    // An inventory car fills in its own details.
    vehicle = { ...vehicle, vin: vehicle.vin || String(car.vin || '').toUpperCase(), year: vehicle.year || String(car.year || ''),
      make: vehicle.make || car.make || '', model: vehicle.model || car.model || '', color: vehicle.color || car.color || '',
      mileageIn: vehicle.mileageIn ?? (car.mileage ? Number(car.mileage) : null) };
  }
  if (!leadId && !carId) return { error: 'Pick a customer, or a car in inventory for internal work.' };
  const jobs = (Array.isArray(b.jobs) && b.jobs.length ? b.jobs : [{}]).slice(0, 40)
    .map(j => cleanJob({ payType: carId && !leadId ? 'internal' : undefined, ...j }, null, cfg));
  const ro = {
    id: crypto.randomUUID(),
    roNumber: await store.takeNextRoNumber(q, req.dealershipId),
    status: 'open',
    leadId, carId,
    customerName: await customerName(q, req.dealershipId, leadId),
    vehicle,
    advisorId: b.advisorId ? text(b.advisorId, 60) : req.user.id,
    promisedAt: b.promisedAt ? new Date(b.promisedAt).toISOString() : null,
    notes: text(b.notes, 2000),
    jobs,
    openedAt: new Date().toISOString(),
    openedBy: { id: req.user.id, name: req.user.name },
    closedAt: null, closedBy: null,
    ...extra
  };
  await store.insert(q, 'repair_orders', req.dealershipId, ro);
  await linkCar(q, req.dealershipId, carId, ro.id, true);
  await audit.created(q, req, 'repair_order', ro);
  return { ro, settings };
}

router.post('/service/ros', allow('writeRepairOrders'), wrap(async (req, res) => {
  const result = await store.tx(q => createRo(q, req, req.body || {}));
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(present(result.ro, result.settings, await payMap(store.pool, req.dealershipId)));
}));

// Edit an open RO: vehicle, advisor, promise time, notes, jobs, status.
router.put('/service/ros/:id', allow('writeRepairOrders'), wrap(async (req, res) => {
  const b = req.body || {};
  const result = await store.tx(async q => {
    const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!ro) return { status: 404, error: 'Repair order not found.' };
    if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This RO is closed and can no longer be changed.' };
    const settings = await settingsOf(q, req.dealershipId);
    const cfg = serviceSettings(settings);
    const next = { ...ro };
    if ('vehicle' in b) next.vehicle = cleanVehicle({ ...ro.vehicle, ...b.vehicle });
    if ('advisorId' in b) next.advisorId = b.advisorId ? text(b.advisorId, 60) : null;
    if ('promisedAt' in b) next.promisedAt = b.promisedAt ? new Date(b.promisedAt).toISOString() : null;
    if ('notes' in b) next.notes = text(b.notes, 2000);
    if ('status' in b && OPEN_STATUSES.includes(b.status)) next.status = b.status;
    if ('leadId' in b && b.leadId !== ro.leadId) {
      if (b.leadId && !await store.get(q, 'leads', req.dealershipId, b.leadId)) return { status: 400, error: 'Customer not found.' };
      next.leadId = b.leadId || null;
      next.customerName = await customerName(q, req.dealershipId, next.leadId);
    }
    if (Array.isArray(b.jobs)) {
      const savedById = new Map((ro.jobs || []).map(j => [j.id, j]));
      next.jobs = b.jobs.slice(0, 40).map(j => cleanJob(j, savedById.get(j && j.id), cfg));
      // A job with time on it can't just disappear.
      const kept = new Set(next.jobs.map(j => j.id));
      const dropped = (ro.jobs || []).filter(j => !kept.has(j.id) && (j.punches || []).length);
      if (dropped.length) return { status: 400, error: 'A job with technician time on it can\'t be removed.' };
    }
    const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, next);
    await audit.updated(q, req, 'repair_order', ro, saved);
    return { ro: saved, settings };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(present(result.ro, result.settings, await payMap(store.pool, req.dealershipId)));
}));

// Technicians clock in and out of a job (advisors and managers can do it
// for them). Clocking in on one job clocks the tech out of any other.
router.post('/service/ros/:id/jobs/:jobId/clock', allow('viewService'), wrap(async (req, res) => {
  const action = req.body && req.body.action === 'out' ? 'out' : 'in';
  const techId = isTech(req) ? req.user.id : text((req.body && req.body.techId) || '', 60);
  if (!isTech(req) && !auth.can(req.user, 'writeRepairOrders')) return res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  const result = await store.tx(async q => {
    const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!ro) return { status: 404, error: 'Repair order not found.' };
    if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This RO is closed.' };
    const job = (ro.jobs || []).find(j => j.id === req.params.jobId);
    if (!job) return { status: 404, error: 'Job not found.' };
    const who = techId || job.techId;
    if (!who) return { status: 400, error: 'Assign a technician to this job first.' };
    if (isTech(req) && job.techId && job.techId !== req.user.id) return { status: 403, error: 'This job is assigned to another technician.' };
    const now = new Date().toISOString();
    if (action === 'in') {
      // Clock out of anything else this tech is on.
      const others = (await store.list(q, 'repair_orders', req.dealershipId))
        .filter(r => r.id !== ro.id && OPEN_STATUSES.includes(r.status) && (r.jobs || []).some(j => (j.punches || []).some(p => !p.end && p.techId === who)));
      for (const other of others) {
        const locked = await store.get(q, 'repair_orders', req.dealershipId, other.id, { forUpdate: true });
        locked.jobs = locked.jobs.map(j => ({ ...j, punches: (j.punches || []).map(p => (!p.end && p.techId === who ? { ...p, end: now } : p)) }));
        await store.save(q, 'repair_orders', req.dealershipId, locked.id, locked);
      }
      ro.jobs = ro.jobs.map(j => ({ ...j, punches: (j.punches || []).map(p => (!p.end && p.techId === who ? { ...p, end: now } : p)) }));
      const target = ro.jobs.find(j => j.id === job.id);
      target.punches.push({ techId: who, start: now, end: null });
      if (!target.techId) target.techId = who;
      if (target.status === 'pending') target.status = 'working';
      if (ro.status === 'open') ro.status = 'in_progress';
    } else {
      const target = ro.jobs.find(j => j.id === job.id);
      target.punches = (target.punches || []).map(p => (!p.end && p.techId === who ? { ...p, end: now } : p));
      if (req.body && req.body.done) target.status = 'done';
    }
    const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
    await audit.record(q, req, { action: 'update', entityType: 'repair_order', entityId: ro.id, label: audit.labelFor('repair_order', ro), details: `Clock ${action}` });
    return { ro: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const [settings, pays] = await Promise.all([settingsOf(store.pool, req.dealershipId), payMap(store.pool, req.dealershipId)]);
  res.json(present(result.ro, settings, pays, { forTech: isTech(req) }));
}));

// Technicians write the cause and correction and mark their job done.
router.put('/service/ros/:id/jobs/:jobId/tech', allow('viewService'), wrap(async (req, res) => {
  if (!isTech(req) && !auth.can(req.user, 'writeRepairOrders')) return res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  const b = req.body || {};
  const result = await store.tx(async q => {
    const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!ro) return { status: 404, error: 'Repair order not found.' };
    if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This RO is closed.' };
    const job = (ro.jobs || []).find(j => j.id === req.params.jobId);
    if (!job) return { status: 404, error: 'Job not found.' };
    if (isTech(req) && job.techId && job.techId !== req.user.id) return { status: 403, error: 'This job is assigned to another technician.' };
    const before = JSON.parse(JSON.stringify(ro));
    if ('cause' in b) job.cause = text(b.cause, 1000);
    if ('correction' in b) job.correction = text(b.correction, 1000);
    if ('status' in b && JOB_STATUSES.includes(b.status)) job.status = b.status;
    const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
    await audit.updated(q, req, 'repair_order', before, saved);
    return { ro: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const [settings, pays] = await Promise.all([settingsOf(store.pool, req.dealershipId), payMap(store.pool, req.dealershipId)]);
  res.json(present(result.ro, settings, pays, { forTech: isTech(req) }));
}));

// Close (invoice) an RO. Everyone is clocked out, the totals are locked in,
// and internal work on an inventory car is added to the car's cost.
router.post('/service/ros/:id/close', allow('writeRepairOrders'), wrap(async (req, res) => {
  const b = req.body || {};
  const result = await store.tx(async q => {
    const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!ro) return { status: 404, error: 'Repair order not found.' };
    if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This RO is already closed.' };
    if (!(ro.jobs || []).some(j => n(j.hours) || (j.parts || []).length)) return { status: 400, error: 'Add labor or parts before closing.' };
    const settings = await settingsOf(q, req.dealershipId);
    const pays = await payMap(q, req.dealershipId);
    const now = new Date().toISOString();
    const before = JSON.parse(JSON.stringify(ro));
    ro.jobs = ro.jobs.map(j => ({ ...j, status: 'done', punches: (j.punches || []).map(p => (p.end ? p : { ...p, end: now })) }));
    if ('mileageOut' in b) ro.vehicle = cleanVehicle({ ...ro.vehicle, mileageOut: b.mileageOut });
    ro.status = 'closed';
    ro.closedAt = now;
    ro.closedBy = { id: req.user.id, name: req.user.name };
    ro.closedTotals = totals(ro, settings, pays);
    // Parts from the shelf come off it now.
    for (const job of ro.jobs) {
      for (const p of job.parts || []) {
        if (p.partId && n(p.qty)) await require('./parts').moveStock(q, req, p.partId, -n(p.qty), { type: 'ro', cost: p.cost, ref: `RO-${ro.roNumber}` });
      }
    }
    if (ro.carId && ro.closedTotals.internalTotal > 0) {
      const car = await store.get(q, 'cars', req.dealershipId, ro.carId, { forUpdate: true });
      if (car) {
        const amount = ro.closedTotals.internalTotal;
        const nextCar = {
          ...car, cost: round2(n(car.cost) + amount),
          reconHistory: [...(car.reconHistory || []), { roId: ro.id, roNumber: ro.roNumber, amount, date: now }]
        };
        await store.save(q, 'cars', req.dealershipId, car.id, nextCar);
        await audit.updated(q, req, 'car', car, nextCar, `Recon from RO-${ro.roNumber}`);
      }
    }
    await linkCar(q, req.dealershipId, ro.carId, ro.id, false);
    const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
    await audit.updated(q, req, 'repair_order', before, saved, 'Closed');
    // Into the books: the sale, what it cost, and recon onto the car.
    const roCar = ro.carId ? await store.get(q, 'cars', req.dealershipId, ro.carId) : null;
    await require('./postings').roClosed(q, req, saved, roCar);
    return { ro: saved, settings, pays };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(present(result.ro, result.settings, result.pays));
}));

// Void an RO opened by mistake (only before it's closed, and only with no
// technician time on it).
router.post('/service/ros/:id/void', allow('writeRepairOrders'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!ro) return { status: 404, error: 'Repair order not found.' };
    if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'Only an open RO can be voided.' };
    if ((ro.jobs || []).some(j => (j.punches || []).length)) return { status: 400, error: 'This RO has technician time on it. Close it instead.' };
    const before = { ...ro };
    ro.status = 'void';
    ro.closedAt = new Date().toISOString();
    ro.closedBy = { id: req.user.id, name: req.user.name };
    await linkCar(q, req.dealershipId, ro.carId, ro.id, false);
    const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
    await audit.updated(q, req, 'repair_order', before, saved, text(req.body && req.body.reason, 200) || 'Voided');
    return { ro: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const [settings, pays] = await Promise.all([settingsOf(store.pool, req.dealershipId), payMap(store.pool, req.dealershipId)]);
  res.json(present(result.ro, settings, pays));
}));

// ----- A customer's vehicles: bought here, and seen in service -----

router.get('/service/customer/:leadId/vehicles', wrap(async (req, res) => {
  const [deals, cars, ros] = await Promise.all([
    store.list(store.pool, 'deals', req.dealershipId),
    store.list(store.pool, 'cars', req.dealershipId),
    store.list(store.pool, 'repair_orders', req.dealershipId)
  ]);
  const carById = new Map(cars.map(c => [c.id, c]));
  const byKey = new Map();
  const keyOf = v => (v.vin ? `vin:${v.vin}` : `ymm:${[v.year, v.make, v.model].join('|').toLowerCase()}`);
  for (const d of deals.filter(d => d.leadId === req.params.leadId && ['delivered', 'closed', 'finalized'].includes(d.status))) {
    const car = carById.get(d.carId);
    if (!car) continue;
    const v = { vin: String(car.vin || '').toUpperCase(), year: String(car.year || ''), make: car.make || '', model: car.model || '', color: car.color || '' };
    byKey.set(keyOf(v), { ...v, boughtHere: true, dealNumber: d.dealNumber, soldAt: d.deliveredAt || car.dateSold || null, ros: [] });
  }
  for (const ro of ros.filter(r => r.leadId === req.params.leadId && r.status !== 'void').reverse()) {
    const v = ro.vehicle || {};
    const k = keyOf(v);
    if (!byKey.has(k)) byKey.set(k, { vin: v.vin, year: v.year, make: v.make, model: v.model, color: v.color, boughtHere: false, ros: [] });
    byKey.get(k).ros.push({ id: ro.id, roNumber: ro.roNumber, status: ro.status, openedAt: ro.openedAt, closedAt: ro.closedAt, mileage: v.mileageIn, jobs: (ro.jobs || []).map(j => j.concern).filter(Boolean) });
  }
  res.json([...byKey.values()]);
}));

// ----- Service appointments -----

function cleanAppointment(b, saved) {
  return {
    leadId: b.leadId ? text(b.leadId, 60) : (saved && saved.leadId) || null,
    vehicle: cleanVehicle({ ...((saved && saved.vehicle) || {}), ...(b.vehicle || {}) }),
    startsAt: b.startsAt ? new Date(b.startsAt).toISOString() : (saved && saved.startsAt) || null,
    concern: 'concern' in b ? text(b.concern, 1000) : (saved && saved.concern) || '',
    advisorId: 'advisorId' in b ? (b.advisorId ? text(b.advisorId, 60) : null) : (saved && saved.advisorId) || null,
    waiter: 'waiter' in b ? !!b.waiter : !!(saved && saved.waiter),
    status: APPT_STATUSES.includes(b.status) ? b.status : (saved && saved.status) || 'scheduled'
  };
}

router.get('/service/appointments', allow('viewService'), wrap(async (req, res) => {
  let list = await store.list(store.pool, 'service_appointments', req.dealershipId);
  const from = req.query.from ? new Date(req.query.from).getTime() : null;
  const to = req.query.to ? new Date(req.query.to).getTime() : null;
  if (from) list = list.filter(a => new Date(a.startsAt).getTime() >= from);
  if (to) list = list.filter(a => new Date(a.startsAt).getTime() < to);
  if (req.query.leadId) list = list.filter(a => a.leadId === req.query.leadId);
  res.json(list.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt)));
}));

router.post('/service/appointments', allow('writeRepairOrders'), wrap(async (req, res) => {
  const b = req.body || {};
  const result = await store.tx(async q => {
    const a = cleanAppointment(b, null);
    if (!a.leadId) return { error: 'Pick a customer.' };
    if (!a.startsAt || Number.isNaN(new Date(a.startsAt).getTime())) return { error: 'Pick a date and time.' };
    const name = await customerName(q, req.dealershipId, a.leadId);
    if (!name) return { error: 'Customer not found.' };
    const appt = { id: crypto.randomUUID(), ...a, customerName: name, roId: null, createdAt: new Date().toISOString(), createdBy: { id: req.user.id, name: req.user.name } };
    await store.insert(q, 'service_appointments', req.dealershipId, appt);
    await audit.created(q, req, 'service_appointment', appt);
    return { appt };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.appt);
}));

router.put('/service/appointments/:id', allow('writeRepairOrders'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const saved = await store.get(q, 'service_appointments', req.dealershipId, req.params.id, { forUpdate: true });
    if (!saved) return { status: 404, error: 'Appointment not found.' };
    const next = { ...saved, ...cleanAppointment(req.body || {}, saved) };
    if (next.leadId !== saved.leadId) next.customerName = await customerName(q, req.dealershipId, next.leadId);
    const out = await store.save(q, 'service_appointments', req.dealershipId, saved.id, next);
    await audit.updated(q, req, 'service_appointment', saved, out);
    return { appt: out };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.appt);
}));

// The customer arrived: open an RO from the appointment.
router.post('/service/appointments/:id/open-ro', allow('writeRepairOrders'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const appt = await store.get(q, 'service_appointments', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appt) return { status: 404, error: 'Appointment not found.' };
    if (appt.roId) return { status: 400, error: 'An RO is already open for this appointment.' };
    const b = req.body || {};
    const made = await createRo(q, req, {
      leadId: appt.leadId, vehicle: { ...appt.vehicle, ...(b.vehicle || {}) }, advisorId: appt.advisorId || req.user.id,
      jobs: appt.concern ? appt.concern.split(/\n+/).filter(Boolean).map(concern => ({ concern })) : [{}]
    }, { appointmentId: appt.id });
    if (made.error) return { status: 400, error: made.error };
    const nextAppt = { ...appt, status: 'arrived', roId: made.ro.id };
    await store.save(q, 'service_appointments', req.dealershipId, appt.id, nextAppt);
    return made;
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(present(result.ro, result.settings, await payMap(store.pool, req.dealershipId)));
}));

module.exports = { router, createRo, totals, clockedHours, serviceSettings, defaultServiceSettings, OPEN_STATUSES, payMap, present, settingsOf };
