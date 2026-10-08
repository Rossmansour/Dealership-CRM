// recon.js
// Recon: getting each used car from "just arrived" to the front line.
//
// A car's recon ("unit") moves through the store's steps -- by default
// check-in & inspection, estimate approval, mechanical, body/paint/glass,
// detail, photos & online -- and then to the front line. Every step has a
// time goal, and so does the whole trip (days to the front line), so
// everyone can see what's stuck and where.
//
// Work items (brakes, windshield, detail...) carry an estimate. A used-car
// manager approves or declines them. Approved mechanical work goes to the
// service department as an internal RO -- its cost reaches the car when the
// RO closes. Outside work (body shop, glass, detailer) is marked done with
// its actual cost, which is added to the car right then. Either way the
// car's cost includes its recon, so the gross is right when it sells.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');

const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const text = (v, max = 300) => String(v ?? '').trim().slice(0, max);

const READY = 'ready'; // the front line -- the end of a retail car's trip
const WHOLESALE = 'wholesale'; // or out the back door: leaves recon, not counted in days-to-front-line
// Work item phases. (Older items used finer categories; they map onto these.)
const PHASES = ['mechanical', 'detail', 'cosmetic', 'other'];
const OLD_CATEGORY = { tires: 'mechanical', body: 'cosmetic', glass: 'cosmetic' };
const phaseOf = c => (PHASES.includes(c) ? c : OLD_CATEGORY[c] || 'other');
const TO_SERVICE = ['mechanical'];
const STORE_FIELDS = ['other1', 'other2', 'other3', 'other4', 'other5', 'other6'];

// The work items to pick from, by phase. Stores can change the list.
const DEFAULT_CATALOG = {
  mechanical: ['Safety Inspection', 'CPO Inspection', 'Tire/Brake Measurement', 'Oil Change', 'Brakes (Front)', 'Brakes (Rear)',
    'Rotors (Front)', 'Rotors (Rear)', 'Tires (2)', 'Tires (4)', 'Alignment', 'Battery', 'A/C Service', 'Air Filter (Engine)',
    'Air Filter (Cabin)', 'Wiper Blades', 'Check Engine Light', 'Engine Diagnosis', 'Suspension', 'Steering', 'Exhaust', 'Fluids',
    'Belts', 'Transmission', 'Cooling System', 'Electrical', 'Lights / Bulbs', 'Recalls', 'Key (Spare)', 'Key Fob', 'Smog / Emissions',
    'Seat Belts', 'Spare Tire', 'Shop Supplies'],
  detail: ['Used Car Detail', 'New Car Detail', 'Interior Shampoo', 'Odor Removal', 'Paint Protection', 'Photos'],
  cosmetic: ['PDR (Dent Repair)', 'Body Repair', 'Paint', 'Touch Up', 'Bumper Repair', 'Wheel Repair', 'Windshield (Repair)',
    'Windshield (Replace)', 'Glass', 'Interior Repair', 'Tint', 'Tint (Remove)', 'Bedliner'],
  other: ['Title', 'Registration', "Owner's Manual", 'Floor Mats', 'Transport', 'Sublet']
};
const itemTotal = i => (n(i.partsPrice) || n(i.laborHours) ? round2(n(i.partsPrice) + n(i.laborHours) * n(i.laborRate)) : n(i.estimate));
const ITEM_STATUSES = ['proposed', 'approved', 'declined', 'done'];

// The store's steps, in order. Front line and Wholesale are always the two
// ways out, so they aren't in the list.
function defaultReconSettings() {
  const step = (key, label, goalHours) => ({ key, label, goalHours });
  return {
    goalDays: 5,
    steps: [
      step('new_import', 'New - Import', 24), step('new_transport', 'New - In Transport', 120), step('new_pdi', 'New - PDI', 24),
      step('purchase_trade', 'Purchase / Trade', 24), step('used_transport', 'Used - In Transport', 120),
      step('trade_not_cleared', 'Trade Not Cleared', 48), step('loaner', 'Loaner', 0),
      step('write_up', 'Write Up', 8), step('detail_ready', 'Detail Ready', 24), step('detail_complete', 'Detail Complete', 8),
      step('smog', 'Smog', 24), step('insp_ready', 'Insp Ready / Dispatch', 8), step('parts_estimate', 'Parts Estimate', 8),
      step('ucm_approval', 'UCM Approval', 8), step('approved_declined', 'Approved / Declined', 4), step('order_parts', 'Order Parts', 8),
      step('parts_hold', 'Parts Hold', 72), step('repair', 'Repair', 24), step('offsite_sublet', 'Offsite Sublet', 72),
      step('vendor', 'Vendor', 48)
    ]
  };
}
// The first version's steps. A store still on exactly that list (never
// changed by hand) moves to the current defaults automatically.
const FIRST_VERSION_STEPS = ['inspect', 'approve', 'mechanical', 'body', 'detail', 'photos'];
// The second version's steps (before New - PDI). A store still on exactly
// that list gets New - PDI added after New - In Transport.
const SECOND_VERSION_KEYS = ['new_import', 'new_transport', 'purchase_trade', 'used_transport', 'trade_not_cleared', 'loaner', 'write_up',
  'detail_ready', 'detail_complete', 'smog', 'insp_ready', 'parts_estimate', 'ucm_approval', 'approved_declined', 'order_parts',
  'parts_hold', 'repair', 'offsite_sublet', 'vendor'];

function reconSettings(settings) {
  const r = (settings && settings.recon) || {};
  const d = defaultReconSettings();
  let steps = Array.isArray(r.steps) && r.steps.length ? r.steps : d.steps;
  if (steps.every(s => FIRST_VERSION_STEPS.includes(s.key))) steps = d.steps;
  const catalog = {};
  for (const ph of PHASES) catalog[ph] = Array.isArray(r.catalog && r.catalog[ph]) ? r.catalog[ph] : DEFAULT_CATALOG[ph];
  // An earlier version cut saved lists off at 12 steps. A list that is exactly
  // the first 12 defaults gets the rest back.
  const keys = steps.map(s => s.key).join('|');
  if (keys === SECOND_VERSION_KEYS.slice(0, 12).join('|')) steps = d.steps;
  else if (keys === SECOND_VERSION_KEYS.join('|')) {
    const at = steps.findIndex(s => s.key === 'new_transport') + 1;
    steps = [...steps.slice(0, at), d.steps.find(s => s.key === 'new_pdi'), ...steps.slice(at)];
  }
  return { goalDays: r.goalDays > 0 ? n(r.goalDays) : d.goalDays, steps, catalog };
}
const stepLabel = (cfg, key) => (key === READY ? 'Frontline Ready' : key === WHOLESALE ? 'Wholesale' : (cfg.steps.find(s => s.key === key) || {}).label || key);
// Where a car starts: new cars at New - PDI (or the first "new" step), used
// cars at Purchase / Trade (or the first step).
function firstStep(cfg, car) {
  if (car.stockType === 'new') return cfg.steps.find(s => s.key === 'new_pdi') || cfg.steps.find(s => /new/i.test(s.key)) || cfg.steps[0];
  return cfg.steps.find(s => s.key === 'purchase_trade') || cfg.steps[0];
}

function newUnit(car, step, by) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), carId: car.id, stockNumber: car.stockNumber || '', vehicleLabel: [car.year, car.make, car.model].filter(Boolean).join(' '),
    status: 'active', step: step.key, stepEnteredAt: now, startedAt: now, doneAt: null,
    history: [{ step: step.key, label: step.label, enteredAt: now, leftAt: null, by: by.name }],
    items: [], notes: [], startedBy: by
  };
}

// Every car added to inventory goes straight into recon at its first step.
async function addCar(q, req, car) {
  if (!car || car.status === 'sold') return null;
  const cfg = reconSettings((await store.getDealership(q, req.dealershipId)).settings);
  const unit = newUnit(car, firstStep(cfg, car), { id: req.user.id, name: req.user.name });
  await store.insert(q, 'recon_units', req.dealershipId, unit);
  await audit.created(q, req, 'recon_unit', unit);
  return unit;
}

// Cars in stock that have never been in recon (added before this, or
// brought in some other way) are put in now.
async function catchUp(req) {
  await store.tx(async q => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recon-catch-up:${req.dealershipId}`]);
    const [cars, units] = await Promise.all([store.list(q, 'cars', req.dealershipId), store.list(q, 'recon_units', req.dealershipId)]);
    const seen = new Set(units.map(u => u.carId));
    for (const car of cars) if (car.status !== 'sold' && !seen.has(car.id)) await addCar(q, req, car);
  });
}

// ---------- Work items and money ----------

// What an item actually cost: its RO job once the RO closes, otherwise what
// was entered when it was marked done.
function itemActual(item, roById) {
  if (item.roId) {
    const ro = roById.get(item.roId);
    const job = ro && (ro.jobs || []).find(j => j.id === item.roJobId);
    if (!ro || !job) return { status: item.status, actual: null, roStatus: ro ? ro.status : 'missing' };
    const cost = n(job.hours) * n(job.rate) + (job.parts || []).reduce((s, p) => s + n(p.qty) * n(p.price), 0);
    return { status: ro.status === 'closed' ? 'done' : ro.status === 'void' ? 'declined' : item.status, actual: ro.status === 'closed' ? round2(cost) : null, estimateFromRo: round2(cost), roStatus: ro.status };
  }
  return { status: item.status, actual: item.status === 'done' ? n(item.actual) : null };
}

function present(unit, cars, roById, cfg) {
  const car = cars.get(unit.carId) || null;
  const now = Date.now();
  const items = (unit.items || []).map(i => ({ ...i, category: phaseOf(i.category), estimate: itemTotal(i), ...itemActual(i, roById) }));
  const live = items.filter(i => i.status !== 'declined');
  const step = cfg.steps.find(s => s.key === unit.step);
  const end = unit.status === 'active' ? now : new Date(unit.doneAt || unit.stepEnteredAt).getTime();
  const hoursInStep = unit.status === 'active' ? (now - new Date(unit.stepEnteredAt).getTime()) / 3600000 : 0;
  const totalHours = (end - new Date(unit.startedAt).getTime()) / 3600000;
  return {
    ...unit, items,
    car: car ? {
      id: car.id, year: car.year, make: car.make, model: car.model, trim: car.trim || '', stockNumber: car.stockNumber || '', vin: car.vin || '',
      mileage: car.mileage, color: car.exteriorColor || '', price: n(car.price), cost: n(car.cost), status: car.status, dateAdded: car.dateAdded,
      stockType: car.stockType === 'new' ? 'new' : 'used',
      bodyStyle: car.bodyStyle || '', transmission: car.transmission || '', engine: car.engine || '', drivetrain: car.drivetrain || '',
      interiorColor: car.interiorColor || '', photos: (car.photos || []).slice(0, 12), frontLineAt: car.frontLineAt || null,
      daysInStock: car.dateAdded ? Math.floor((now - new Date(car.dateAdded).getTime()) / 86400000) : null,
      photo: (car.photos || [])[0] || null
    } : null,
    stepLabel: stepLabel(cfg, unit.step),
    hoursInStep: round2(hoursInStep),
    stepGoalHours: step ? n(step.goalHours) : null,
    stepLate: !!(step && n(step.goalHours) && hoursInStep > n(step.goalHours)),
    totalHours: round2(totalHours),
    late: totalHours > cfg.goalDays * 24,
    estimate: round2(live.reduce((s, i) => s + (i.estimateFromRo !== undefined && i.status === 'done' ? i.actual : n(i.estimate)), 0)),
    approved: round2(live.filter(i => ['approved', 'done'].includes(i.status)).reduce((s, i) => s + n(i.estimate), 0)),
    spent: round2(items.reduce((s, i) => s + (i.actual || 0), 0)),
    needsApproval: items.filter(i => i.status === 'proposed').length
  };
}

async function load(q, dealershipId) {
  const [units, cars, ros, dealership] = await Promise.all([
    store.list(q, 'recon_units', dealershipId),
    store.list(q, 'cars', dealershipId),
    store.list(q, 'repair_orders', dealershipId),
    store.getDealership(q, dealershipId)
  ]);
  return { units, cars, ros, settings: (dealership && dealership.settings) || {} };
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allow = auth.requirePermission;

// Everything the recon screen shows.
router.get('/recon/board', allow('viewRecon'), wrap(async (req, res) => {
  await catchUp(req);
  const { units, cars, ros, settings } = await load(store.pool, req.dealershipId);
  const cfg = reconSettings(settings);
  const carById = new Map(cars.map(c => [c.id, c]));
  const roById = new Map(ros.map(r => [r.id, r]));
  // Every car in recon, every car that finished (Frontline Ready), and every
  // car wholesaled out of it. (Cars taken out for other reasons are left off.)
  const shown = units.filter(u => u.status === 'active' || u.status === 'done' || (u.status === 'removed' && u.step === WHOLESALE));
  res.json({
    settings: cfg,
    can: { work: auth.can(req.user, 'workRecon'), approve: auth.can(req.user, 'approveRecon'), price: auth.can(req.user, 'editInventory') },
    units: shown.map(u => present(u, carById, roById, cfg))
  });
}));

router.get('/recon/settings', allow('viewRecon'), wrap(async (req, res) => {
  const d = await store.getDealership(store.pool, req.dealershipId);
  res.json(reconSettings(d && d.settings));
}));

router.put('/recon/settings', allow('approveRecon'), wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  if (b.reset) b.steps = defaultReconSettings().steps;
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const before = reconSettings(settings);
    const seen = new Set();
    const steps = (Array.isArray(b.steps) ? b.steps : before.steps).slice(0, 40).map(s => {
      let key = text(s.key, 30).toLowerCase().replace(/[^a-z0-9_]/g, '') || text(s.label, 30).toLowerCase().replace(/[^a-z0-9]+/g, '_');
      while (!key || key === READY || key === WHOLESALE || seen.has(key)) key = `${key || 'step'}_${seen.size + 1}`;
      seen.add(key);
      return { key, label: text(s.label, 40) || key, goalHours: Math.max(0, Math.round(n(s.goalHours))) };
    }).filter(s => s.label);
    if (!steps.length) return { error: 'Keep at least one step.' };
    const catalog = {};
    for (const ph of PHASES) {
      const list = b.catalog && Array.isArray(b.catalog[ph]) ? b.catalog[ph] : before.catalog[ph];
      catalog[ph] = [...new Set(list.map(x => text(x, 60)).filter(Boolean))].slice(0, 150);
    }
    const next = { goalDays: Math.max(1, Math.round(n(b.goalDays ?? before.goalDays) * 10) / 10), steps, catalog };
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, recon: next }]);
    await audit.updated(q, req, 'settings', { ...before, id: 'recon-settings' }, { ...next, id: 'recon-settings' }, 'Recon steps & goals');
    return { settings: next };
  });
  if (saved.error) return res.status(400).json({ error: saved.error });
  res.json(saved.settings);
}));

async function withUnit(req, res, fn) {
  const result = await store.tx(async q => {
    const unit = await store.get(q, 'recon_units', req.dealershipId, req.params.id, { forUpdate: true });
    if (!unit) return { status: 404, error: 'This car is not in recon.' };
    const settings = (await store.getDealership(q, req.dealershipId)).settings || {};
    const before = JSON.parse(JSON.stringify(unit));
    const out = await fn(q, unit, reconSettings(settings), settings);
    if (out && out.error) return out;
    const saved = await store.save(q, 'recon_units', req.dealershipId, unit.id, unit);
    await audit.updated(q, req, 'recon_unit', before, saved, out && out.details);
    return { unit: saved };
  });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  const { cars, ros, settings } = await load(store.pool, req.dealershipId);
  res.json(present(result.unit, new Map(cars.map(c => [c.id, c])), new Map(ros.map(r => [r.id, r])), reconSettings(settings)));
}

// Start a car's recon (first step).
router.post('/recon/units', allow('workRecon'), wrap(async (req, res) => {
  const carId = text((req.body || {}).carId, 60);
  const result = await store.tx(async q => {
    const car = await store.get(q, 'cars', req.dealershipId, carId);
    if (!car) return { error: 'Car not found.' };
    if (car.status === 'sold') return { error: 'This car is sold.' };
    const existing = (await store.list(q, 'recon_units', req.dealershipId)).find(u => u.carId === carId && u.status === 'active');
    if (existing) return { error: 'This car is already in recon.' };
    const cfg = reconSettings((await store.getDealership(q, req.dealershipId)).settings);
    const first = cfg.steps.find(s => s.key === (req.body || {}).step) || firstStep(cfg, car);
    const unit = newUnit(car, first, { id: req.user.id, name: req.user.name });
    await store.insert(q, 'recon_units', req.dealershipId, unit);
    await audit.created(q, req, 'recon_unit', unit);
    return { unit };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  const { cars, ros, settings } = await load(store.pool, req.dealershipId);
  res.status(201).json(present(result.unit, new Map(cars.map(c => [c.id, c])), new Map(ros.map(r => [r.id, r])), reconSettings(settings)));
}));

// Move to another step (or to the front line).
router.post('/recon/units/:id/move', allow('workRecon'), wrap(async (req, res) => {
  const step = text((req.body || {}).step, 30);
  await withUnit(req, res, async (q, unit, cfg) => {
    if (unit.status !== 'active') return { error: 'This car already finished recon.' };
    if (step !== READY && step !== WHOLESALE && !cfg.steps.some(s => s.key === step)) return { error: 'Pick a step.' };
    if (step === unit.step) return { details: 'No change' };
    const now = new Date().toISOString();
    const open = unit.history.find(h => !h.leftAt);
    if (open) open.leftAt = now;
    unit.history.push({ step, label: stepLabel(cfg, step), enteredAt: now, leftAt: step === READY || step === WHOLESALE ? now : null, by: req.user.name });
    unit.step = step;
    unit.stepEnteredAt = now;
    if (step === WHOLESALE) {
      unit.status = 'removed';
      unit.removedReason = 'Wholesale';
      unit.doneAt = now;
    }
    if (step === READY) {
      unit.status = 'done';
      unit.doneAt = now;
      const car = await store.get(q, 'cars', req.dealershipId, unit.carId, { forUpdate: true });
      if (car) await store.save(q, 'cars', req.dealershipId, car.id, { ...car, frontLineAt: now });
    }
    return { details: `Moved to ${stepLabel(cfg, step)}` };
  });
}));

// Put a finished car back in recon (e.g. something found on a test drive).
router.post('/recon/units/:id/reopen', allow('workRecon'), wrap(async (req, res) => {
  await withUnit(req, res, async (q, unit, cfg) => {
    if (unit.status === 'active') return { error: 'This car is still in recon.' };
    const now = new Date().toISOString();
    const step = cfg.steps.find(s => s.key === text((req.body || {}).step, 30)) || cfg.steps[0];
    unit.status = 'active';
    unit.doneAt = null;
    unit.removedReason = '';
    unit.step = step.key;
    unit.stepEnteredAt = now;
    unit.history.push({ step: step.key, label: step.label, enteredAt: now, leftAt: null, by: req.user.name });
    return { details: 'Back into recon' };
  });
}));

router.post('/recon/units/:id/remove', allow('workRecon'), wrap(async (req, res) => {
  await withUnit(req, res, async (q, unit) => {
    unit.status = 'removed';
    unit.removedReason = text((req.body || {}).reason, 200);
    unit.doneAt = new Date().toISOString();
    const open = unit.history.find(h => !h.leftAt);
    if (open) open.leftAt = unit.doneAt;
    return { details: `Removed from recon${unit.removedReason ? `: ${unit.removedReason}` : ''}` };
  });
}));

// A new work item. Labor is priced at the store's internal labor rate
// unless another rate is given.
function newItem(req, b, settings, approve) {
  const now = new Date().toISOString();
  const rate = b.laborRate !== undefined && b.laborRate !== '' ? Math.max(0, round2(b.laborRate)) : n(((settings.service || {}).internalLaborRate) ?? 90);
  const item = {
    id: crypto.randomUUID(), category: phaseOf(b.category), description: text(b.description, 200),
    info: text(b.info, 1000), onlineDescription: text(b.onlineDescription, 500),
    partsPrice: Math.max(0, round2(b.partsPrice)), laborHours: Math.max(0, round2(b.laborHours)), laborRate: rate,
    estimate: Math.max(0, round2(b.estimate)), actual: null, vendor: text(b.vendor, 60), status: approve ? 'approved' : 'proposed',
    roId: null, roNumber: null, roJobId: null, costPosted: false,
    addedBy: req.user.name, addedAt: now, approvedBy: approve ? req.user.name : null, approvedAt: approve ? now : null
  };
  item.estimate = itemTotal(item);
  return item;
}

// Add a work item. A manager's own items can go straight to approved.
router.post('/recon/units/:id/items', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  await withUnit(req, res, async (q, unit, cfg, settings) => {
    if (!text(b.description)) return { error: 'Describe the work.' };
    unit.items = [...(unit.items || []), newItem(req, b, settings, !!b.approve && auth.can(req.user, 'approveRecon'))];
    return { details: `Added: ${text(b.description, 200)}` };
  });
}));

// Add several work items at once (from the list), skipping any already on the car.
router.post('/recon/units/:id/items/bulk', allow('workRecon'), wrap(async (req, res) => {
  const list = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 100) : [];
  await withUnit(req, res, async (q, unit, cfg, settings) => {
    const have = new Set((unit.items || []).map(i => i.description.toLowerCase()));
    const add = list.filter(x => text(x.description) && !have.has(text(x.description, 200).toLowerCase()));
    if (!add.length) return { error: 'Pick at least one new work item.' };
    unit.items = [...(unit.items || []), ...add.map(x => newItem(req, x, settings, false))];
    return { details: `Added ${add.length} work items` };
  });
}));

// Mark an item done with its actual cost, which is added to the car.
async function finishItem(q, req, unit, item, actualIn) {
  const actual = Math.max(0, round2(actualIn ?? itemTotal(item)));
  item.actual = actual;
  item.doneAt = new Date().toISOString();
  if (actual > 0) {
    const car = await store.get(q, 'cars', req.dealershipId, unit.carId, { forUpdate: true });
    if (car) {
      const next = { ...car, cost: round2(n(car.cost) + actual),
        reconHistory: [...(car.reconHistory || []), { source: 'recon', description: item.description, vendor: item.vendor, amount: actual, date: item.doneAt }] };
      await store.save(q, 'cars', req.dealershipId, car.id, next);
      await audit.updated(q, req, 'car', car, next, `Recon: ${item.description}`);
      // Owed to whoever did the work.
      const vendor = String(item.vendor || 'Recon vendor');
      await require('./postings').carCost(q, req, next, actual, { offsetKey: 'ap', offsetControl: vendor.toUpperCase().slice(0, 40), offsetName: vendor, memo: `Recon: ${item.description}` });
    }
    item.costPosted = true;
  }
}

// Change an item's status. Returns an error message or null.
async function setStatus(q, req, unit, item, status, actual) {
  if (status === item.status) return null;
  if (!ITEM_STATUSES.includes(status)) return 'Pick a status.';
  if (['approved', 'declined', 'proposed'].includes(status) && !auth.can(req.user, 'approveRecon')) return 'A manager approves or declines recon work.';
  if (item.costPosted || item.roId) return item.roId ? `This work is on RO-${item.roNumber}; it finishes when the RO closes.` : 'This item is already done.';
  if (status === 'done') await finishItem(q, req, unit, item, actual);
  if (['approved', 'declined'].includes(status)) { item.approvedBy = req.user.name; item.approvedAt = new Date().toISOString(); }
  if (status === 'proposed') { item.approvedBy = null; item.approvedAt = null; }
  item.status = status;
  return null;
}

// Change a work item: status (managers approve / decline), its notes and
// online description, and -- until it's done or on an RO -- its pricing.
router.put('/recon/units/:id/items/:itemId', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  await withUnit(req, res, async (q, unit) => {
    const item = (unit.items || []).find(i => i.id === req.params.itemId);
    if (!item) return { error: 'Work item not found.' };
    item.category = phaseOf(item.category);
    if ('status' in b) {
      const err = await setStatus(q, req, unit, item, b.status, b.actual);
      if (err) return { status: err.startsWith('A manager') ? 403 : 400, error: err };
    }
    if ('info' in b) item.info = text(b.info, 1000);
    if ('onlineDescription' in b) item.onlineDescription = text(b.onlineDescription, 500);
    if (!item.costPosted && !item.roId) {
      if ('description' in b) item.description = text(b.description, 200) || item.description;
      if ('vendor' in b) item.vendor = text(b.vendor, 60);
      if ('category' in b) item.category = phaseOf(b.category);
      for (const f of ['partsPrice', 'laborHours', 'laborRate']) if (f in b) item[f] = Math.max(0, round2(b[f]));
      if ('estimate' in b && !n(item.partsPrice) && !n(item.laborHours)) item.estimate = Math.max(0, round2(b.estimate));
      item.estimate = itemTotal(item);
    }
    return { details: `${item.description}: ${item.status}` };
  });
}));

// Change the status of several items at once.
router.post('/recon/units/:id/items/status', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  const ids = new Set(Array.isArray(b.ids) ? b.ids : []);
  await withUnit(req, res, async (q, unit) => {
    const items = (unit.items || []).filter(i => ids.has(i.id));
    if (!items.length) return { error: 'Select work items first.' };
    let changed = 0;
    const skipped = [];
    for (const item of items) {
      const err = await setStatus(q, req, unit, item, b.status);
      if (err && err.startsWith('A manager')) return { status: 403, error: err };
      if (err) skipped.push(item.description); else changed++;
    }
    return { details: `${changed} set to ${b.status}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}` };
  });
}));

router.delete('/recon/units/:id/items/:itemId', allow('workRecon'), wrap(async (req, res) => {
  await withUnit(req, res, async (q, unit) => {
    const item = (unit.items || []).find(i => i.id === req.params.itemId);
    if (!item) return { error: 'Work item not found.' };
    if (item.costPosted || item.roId) return { error: 'Work that is done or on an RO stays on the car.' };
    unit.items = unit.items.filter(i => i !== item);
    return { details: `Removed: ${item.description}` };
  });
}));

// The store's own fields on the car's recon (Other 1-6, inspection date and RO #).
router.put('/recon/units/:id/info', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  await withUnit(req, res, async (q, unit) => {
    unit.fields = { ...(unit.fields || {}) };
    for (const f of STORE_FIELDS) if (b.fields && f in b.fields) unit.fields[f] = text(b.fields[f], 120);
    if ('inspectionDate' in b) unit.inspectionDate = b.inspectionDate ? new Date(b.inspectionDate).toISOString() : null;
    if ('inspectionRo' in b) unit.inspectionRo = text(b.inspectionRo, 30);
    return { details: 'Details' };
  });
}));

// Send approved mechanical work to the service department as one
// internal RO on the car.
router.post('/recon/units/:id/send-to-service', allow('workRecon'), wrap(async (req, res) => {
  await withUnit(req, res, async (q, unit) => {
    const items = (unit.items || []).filter(i => i.status === 'approved' && TO_SERVICE.includes(phaseOf(i.category)) && !i.roId);
    if (!items.length) return { error: 'Approve mechanical work first.' };
    if (!auth.can(req.user, 'writeRepairOrders')) return { status: 403, error: 'A service advisor or manager opens the RO.' };
    const made = await require('./service').createRo(q, req, {
      carId: unit.carId, notes: 'From recon',
      jobs: items.map(i => ({
        concern: `Recon: ${i.description}${i.info ? ` -- ${i.info}` : ''}`, payType: 'internal',
        hours: n(i.laborHours) || undefined, rate: n(i.laborHours) ? n(i.laborRate) : undefined,
        parts: n(i.partsPrice) ? [{ description: `${i.description} parts`, qty: 1, cost: 0, price: n(i.partsPrice) }] : []
      }))
    });
    if (made.error) return { error: made.error };
    items.forEach((i, k) => { i.roId = made.ro.id; i.roNumber = made.ro.roNumber; i.roJobId = made.ro.jobs[k].id; });
    return { details: `Sent to service: RO-${made.ro.roNumber}` };
  });
}));

router.post('/recon/units/:id/notes', allow('workRecon'), wrap(async (req, res) => {
  const note = text((req.body || {}).text, 1000);
  if (!note) return res.status(400).json({ error: 'Write a note.' });
  await withUnit(req, res, async (q, unit) => {
    unit.notes = [...(unit.notes || []), { id: crypto.randomUUID(), text: note, at: new Date().toISOString(), by: req.user.name }];
    return { details: 'Note' };
  });
}));

module.exports = { router, reconSettings, defaultReconSettings, present, addCar, READY, WHOLESALE };
