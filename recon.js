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
const CATEGORIES = ['mechanical', 'tires', 'body', 'glass', 'detail', 'other'];
const TO_SERVICE = ['mechanical', 'tires'];
const ITEM_STATUSES = ['proposed', 'approved', 'declined', 'done'];

// The store's steps, in order. Front line and Wholesale are always the two
// ways out, so they aren't in the list.
function defaultReconSettings() {
  const step = (key, label, goalHours) => ({ key, label, goalHours });
  return {
    goalDays: 5,
    steps: [
      step('new_import', 'New - Import', 24), step('new_transport', 'New - In Transport', 120),
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

function reconSettings(settings) {
  const r = (settings && settings.recon) || {};
  const d = defaultReconSettings();
  let steps = Array.isArray(r.steps) && r.steps.length ? r.steps : d.steps;
  if (steps.every(s => FIRST_VERSION_STEPS.includes(s.key))) steps = d.steps;
  // An earlier version cut saved lists off at 12 steps. A list that is exactly
  // the first 12 defaults gets the rest back.
  const first12 = d.steps.slice(0, 12).map(s => s.key).join('|');
  if (steps.length === 12 && steps.map(s => s.key).join('|') === first12) steps = [...steps, ...d.steps.slice(12)];
  return { goalDays: r.goalDays > 0 ? n(r.goalDays) : d.goalDays, steps };
}
const stepLabel = (cfg, key) => (key === READY ? 'Frontline Ready' : key === WHOLESALE ? 'Wholesale' : (cfg.steps.find(s => s.key === key) || {}).label || key);
// Where a car starts: new cars at the first "new" step, everything else at Purchase / Trade (or the first step).
function firstStep(cfg, car) {
  const isNew = car.stockType === 'new';
  return cfg.steps.find(s => (isNew ? /new/i.test(s.key) : s.key === 'purchase_trade')) || cfg.steps[0];
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
  const items = (unit.items || []).map(i => ({ ...i, ...itemActual(i, roById) }));
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
  const { units, cars, ros, settings } = await load(store.pool, req.dealershipId);
  const cfg = reconSettings(settings);
  const carById = new Map(cars.map(c => [c.id, c]));
  const roById = new Map(ros.map(r => [r.id, r]));
  const recentCutoff = Date.now() - 90 * 86400000;
  const shown = units.filter(u => u.status === 'active' ||
    ((u.status === 'done' || (u.status === 'removed' && u.step === WHOLESALE)) && new Date(u.doneAt).getTime() >= recentCutoff));
  const inRecon = new Set(units.filter(u => u.status !== 'removed').map(u => u.carId));
  const notStarted = cars.filter(c => c.status !== 'sold' && !inRecon.has(c.id)).map(c => ({
    id: c.id, year: c.year, make: c.make, model: c.model, trim: c.trim || '', stockNumber: c.stockNumber || '', mileage: c.mileage,
    stockType: c.stockType === 'new' ? 'new' : 'used', vin: c.vin || '',
    dateAdded: c.dateAdded, price: n(c.price)
  }));
  res.json({
    settings: cfg,
    can: { work: auth.can(req.user, 'workRecon'), approve: auth.can(req.user, 'approveRecon') },
    units: shown.map(u => present(u, carById, roById, cfg)),
    notStarted
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
    const next = { goalDays: Math.max(1, Math.round(n(b.goalDays ?? before.goalDays) * 10) / 10), steps };
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
    const out = await fn(q, unit, reconSettings(settings));
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
    const now = new Date().toISOString();
    const first = cfg.steps.find(s => s.key === (req.body || {}).step) || firstStep(cfg, car);
    const unit = {
      id: crypto.randomUUID(), carId, stockNumber: car.stockNumber || '', vehicleLabel: [car.year, car.make, car.model].filter(Boolean).join(' '),
      status: 'active', step: first.key, stepEnteredAt: now, startedAt: now, doneAt: null,
      history: [{ step: first.key, label: first.label, enteredAt: now, leftAt: null, by: req.user.name }],
      items: [], notes: [], startedBy: { id: req.user.id, name: req.user.name }
    };
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

// Add a work item. A manager's own items can go straight to approved.
router.post('/recon/units/:id/items', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  await withUnit(req, res, async (q, unit) => {
    const description = text(b.description, 200);
    if (!description) return { error: 'Describe the work.' };
    const approve = !!b.approve && auth.can(req.user, 'approveRecon');
    const now = new Date().toISOString();
    unit.items = [...(unit.items || []), {
      id: crypto.randomUUID(), category: CATEGORIES.includes(b.category) ? b.category : 'other', description,
      estimate: Math.max(0, round2(b.estimate)), actual: null, vendor: text(b.vendor, 60), status: approve ? 'approved' : 'proposed',
      roId: null, roNumber: null, roJobId: null, costPosted: false,
      addedBy: req.user.name, addedAt: now, approvedBy: approve ? req.user.name : null, approvedAt: approve ? now : null
    }];
    return { details: `Added: ${description}` };
  });
}));

// Change a work item: approve / decline (managers), edit, or mark done with
// its actual cost -- which is added to the car's cost right then.
router.put('/recon/units/:id/items/:itemId', allow('workRecon'), wrap(async (req, res) => {
  const b = req.body || {};
  await withUnit(req, res, async (q, unit) => {
    const item = (unit.items || []).find(i => i.id === req.params.itemId);
    if (!item) return { error: 'Work item not found.' };
    if ('status' in b && b.status !== item.status) {
      if (!ITEM_STATUSES.includes(b.status)) return { error: 'Pick a status.' };
      if (['approved', 'declined'].includes(b.status) && !auth.can(req.user, 'approveRecon')) {
        return { status: 403, error: 'A manager approves or declines recon work.' };
      }
      if (item.costPosted || item.roId) return { error: item.roId ? `This work is on RO-${item.roNumber}; it finishes when the RO closes.` : 'This item is already done.' };
      if (b.status === 'done') {
        const actual = Math.max(0, round2(b.actual ?? item.estimate));
        item.actual = actual;
        item.doneAt = new Date().toISOString();
        if (actual > 0) {
          const car = await store.get(q, 'cars', req.dealershipId, unit.carId, { forUpdate: true });
          if (car) {
            const next = { ...car, cost: round2(n(car.cost) + actual),
              reconHistory: [...(car.reconHistory || []), { source: 'recon', description: item.description, vendor: item.vendor, amount: actual, date: item.doneAt }] };
            await store.save(q, 'cars', req.dealershipId, car.id, next);
            await audit.updated(q, req, 'car', car, next, `Recon: ${item.description}`);
          }
          item.costPosted = true;
        }
      }
      if (['approved', 'declined'].includes(b.status)) { item.approvedBy = req.user.name; item.approvedAt = new Date().toISOString(); }
      item.status = b.status;
    }
    if (!item.costPosted && !item.roId) {
      if ('description' in b) item.description = text(b.description, 200) || item.description;
      if ('estimate' in b && item.status === 'proposed') item.estimate = Math.max(0, round2(b.estimate));
      if ('vendor' in b) item.vendor = text(b.vendor, 60);
      if ('category' in b && CATEGORIES.includes(b.category)) item.category = b.category;
    }
    return { details: `${item.description}: ${item.status}` };
  });
}));

// Send approved mechanical and tire work to the service department as one
// internal RO on the car.
router.post('/recon/units/:id/send-to-service', allow('workRecon'), wrap(async (req, res) => {
  await withUnit(req, res, async (q, unit) => {
    const items = (unit.items || []).filter(i => i.status === 'approved' && TO_SERVICE.includes(i.category) && !i.roId);
    if (!items.length) return { error: 'Approve mechanical or tire work first.' };
    if (!auth.can(req.user, 'writeRepairOrders')) return { status: 403, error: 'A service advisor or manager opens the RO.' };
    const made = await require('./service').createRo(q, req, {
      carId: unit.carId, notes: 'From recon',
      jobs: items.map(i => ({ concern: `Recon: ${i.description}`, payType: 'internal' }))
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

module.exports = { router, reconSettings, defaultReconSettings, present, READY, WHOLESALE };
