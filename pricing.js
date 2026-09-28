// pricing.js
// Market pricing: each car priced against the same cars for sale near the
// store, by the store's own rules.
//
// For every car in stock we pull similar cars listed nearby (the market),
// adjust each one's price for miles, and take the middle price. The store's
// rules turn that into a suggested price: a target % of market that steps
// down as the car ages, never below cost + recon + a minimum gross, rounded
// off. With auto-pricing on, once a day every car that isn't locked is moved
// to its suggested price (by at most a set amount at a time).
//
// The market comes from MarketCheck (MARKETCHECK_API_KEY). Without a key,
// demo cars get made-up demo listings so the screen can be tried out, and
// everything else waits for the key.

const express = require('express');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');

const n = v => Number(v) || 0;
const DAY = 86400000;
const SOLD = ['sold'];

function defaultPricingSettings() {
  return {
    auto: false,           // move prices on their own once a day
    zip: '',               // where "near the store" is
    radius: 100,           // miles
    yearRange: 1,          // model years either side
    targetPct: 100,        // % of market for a fresh car
    aging: [{ days: 30, pct: 98 }, { days: 45, pct: 96 }, { days: 60, pct: 94 }, { days: 75, pct: 92 }],
    perMile: 0.1,          // $ per mile difference when comparing cars
    minGross: 1000,        // never price below cost + recon + this
    maxChange: 1500,       // auto-pricing moves a price at most this much at once
    roundTo: 100,
    includeNew: false,     // price new cars too
    minComps: 3            // fewer similar cars than this: no suggestion
  };
}

function pricingSettings(settings) {
  const d = defaultPricingSettings();
  const p = (settings && settings.pricing) || {};
  const num = (v, def, min, max) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? def : Math.min(max, Math.max(min, Number(v))));
  const aging = Array.isArray(p.aging) ? p.aging.map(a => ({ days: Math.round(num(a.days, 0, 1, 999)), pct: num(a.pct, 100, 50, 150) }))
    .filter(a => a.days > 0).sort((a, b) => a.days - b.days).slice(0, 10) : d.aging;
  return {
    auto: !!p.auto,
    zip: String(p.zip || '').replace(/[^0-9]/g, '').slice(0, 5),
    radius: Math.round(num(p.radius, d.radius, 10, 500)),
    yearRange: Math.round(num(p.yearRange, d.yearRange, 0, 3)),
    targetPct: num(p.targetPct, d.targetPct, 50, 150),
    aging,
    perMile: num(p.perMile, d.perMile, 0, 1),
    minGross: num(p.minGross, d.minGross, -100000, 100000),
    maxChange: num(p.maxChange, d.maxChange, 0, 100000),
    roundTo: Math.round(num(p.roundTo, d.roundTo, 1, 1000)),
    includeNew: !!p.includeNew,
    minComps: Math.round(num(p.minComps, d.minComps, 1, 20)),
    lastRun: p.lastRun || null
  };
}

// ---------- The market ----------

const marketKey = () => process.env.MARKETCHECK_API_KEY || '';

async function marketcheck(car, cfg) {
  const years = [];
  for (let y = n(car.year) - cfg.yearRange; y <= n(car.year) + cfg.yearRange; y++) years.push(y);
  const params = new URLSearchParams({
    api_key: marketKey(), make: car.make || '', model: car.model || '', year: years.join(','),
    car_type: car.stockType === 'new' ? 'new' : 'used', zip: cfg.zip, radius: String(cfg.radius), rows: '50', start: '0'
  });
  if (car.trim) params.set('trim', car.trim);
  const res = await fetch(`https://mc-api.marketcheck.com/v2/search/car/active?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Market data: ${res.status} ${res.statusText}`);
  const body = await res.json();
  return (body.listings || []).map(l => ({
    vin: l.vin || '', title: l.heading || [l.build && l.build.year, l.build && l.build.make, l.build && l.build.model].filter(Boolean).join(' '),
    price: n(l.price), miles: n(l.miles), daysListed: l.dom === undefined ? null : n(l.dom),
    dealer: l.dealer ? [l.dealer.name, l.dealer.city, l.dealer.state].filter(Boolean).join(', ') : '',
    distance: l.dist === undefined ? null : n(l.dist), url: l.vdp_url || ''
  }));
}

// Made-up listings for demo cars only (no key needed), clearly labeled.
function demoListings(car) {
  let seed = [...String(car.vin || car.id)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const base = n(car.price) || n(car.cost) * 1.15 || 20000;
  const center = base * (0.93 + rnd() * 0.12);
  const count = 6 + Math.floor(rnd() * 10);
  const dealers = ['Valley Motors', 'Desert Auto Group', 'Camelback Cars', 'Sun City Pre-Owned', 'Mesa Auto Plaza', 'Tempe Motor Co'];
  return Array.from({ length: count }, (_, i) => ({
    vin: `DEMO${i}`, title: `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ''}`,
    price: Math.round(center * (0.88 + rnd() * 0.24) / 100) * 100 - 5,
    miles: Math.max(10, Math.round(n(car.mileage) * (0.6 + rnd() * 0.8))),
    daysListed: Math.floor(rnd() * 90), dealer: dealers[Math.floor(rnd() * dealers.length)], distance: Math.round(5 + rnd() * 80), url: ''
  }));
}

let marketSource = null; // tests can swap in their own
function setMarketSource(fn) { marketSource = fn; }

const canPrice = car => !!(marketSource || marketKey() || car.demo);

async function fetchMarket(car, cfg) {
  if (marketSource) return { source: 'test', listings: await marketSource(car, cfg) };
  if (marketKey()) {
    if (!cfg.zip) throw new Error("Set the store's ZIP code in pricing settings first.");
    return { source: 'marketcheck', listings: await marketcheck(car, cfg) };
  }
  if (car.demo) return { source: 'demo', listings: demoListings(car) };
  return null;
}

// Each similar car's price, adjusted for miles to compare with ours.
function snapshot(car, cfg, market) {
  const comps = market.listings
    .filter(l => l.price > 0 && (!car.vin || l.vin !== car.vin))
    .map(l => ({ ...l, adjusted: Math.round(l.price + (l.miles - n(car.mileage)) * cfg.perMile) }))
    .sort((a, b) => a.adjusted - b.adjusted);
  const prices = comps.map(c => c.adjusted);
  const median = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : Math.round((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2)) : null;
  const days = comps.filter(c => c.daysListed !== null).map(c => c.daysListed);
  return {
    at: new Date().toISOString(), source: market.source, count: comps.length, median,
    low: prices.length ? prices[0] : null, high: prices.length ? prices[prices.length - 1] : null,
    avgDaysListed: days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null,
    comps: comps.slice(0, 40)
  };
}

// ---------- The suggestion ----------

const daysInStock = car => (car.dateAdded ? Math.floor((Date.now() - new Date(car.dateAdded).getTime()) / DAY) : 0);
function targetPctFor(days, cfg) {
  let pct = cfg.targetPct;
  for (const a of cfg.aging) if (days >= a.days) pct = a.pct;
  return pct;
}

// reconPending: approved recon not yet in the car's cost.
function suggest(car, cfg, reconPending = 0) {
  const m = car.market;
  const days = daysInStock(car);
  const pct = targetPctFor(days, cfg);
  const allIn = n(car.cost) + n(reconPending);
  const floor = allIn + cfg.minGross;
  const out = { days, pct, allIn, floor, suggested: null, reason: '', atFloor: false, rank: null, pctOfMarket: null };
  if (!m || !m.median) { out.reason = m ? 'No similar cars found nearby' : 'No market data yet'; return out; }
  if (m.count < cfg.minComps) { out.reason = `Only ${m.count} similar car${m.count === 1 ? '' : 's'} nearby`; return out; }
  let price = Math.round((m.median * pct / 100) / cfg.roundTo) * cfg.roundTo;
  if (price < floor) { price = Math.ceil(floor / cfg.roundTo) * cfg.roundTo; out.atFloor = true; }
  out.suggested = price;
  out.reason = out.atFloor
    ? `Market says ${money(Math.round(m.median * pct / 100))}, but that's under cost + recon + ${money(cfg.minGross)} gross`
    : `${pct}% of the ${money(m.median)} market${days >= (cfg.aging[0] || {}).days ? ` (${days} days in stock)` : ''}`;
  if (n(car.price)) {
    out.pctOfMarket = Math.round(n(car.price) / m.median * 1000) / 10;
    out.rank = m.comps.filter(c => c.adjusted < n(car.price)).length + 1;
  }
  return out;
}
const money = v => `$${Math.round(v).toLocaleString('en-US')}`;

// Where auto-pricing moves a price this time: toward the suggestion, by at
// most maxChange.
function nextPrice(current, suggested, cfg) {
  if (!n(current) || !cfg.maxChange) return suggested;
  const diff = suggested - n(current);
  if (Math.abs(diff) <= cfg.maxChange) return suggested;
  return Math.round((n(current) + Math.sign(diff) * cfg.maxChange) / cfg.roundTo) * cfg.roundTo;
}

// ---------- Reading and changing cars ----------

async function reconPendingByCar(q, dealershipId) {
  const [units, ros] = await Promise.all([store.list(q, 'recon_units', dealershipId), store.list(q, 'repair_orders', dealershipId)]);
  const roStatus = new Map(ros.map(r => [r.id, r.status]));
  const out = new Map();
  for (const u of units) {
    // Work on an RO reaches the car's cost when the RO closes.
    const pending = (u.items || []).filter(i => i.status === 'approved' && !i.costPosted && !(i.roId && ['closed', 'void'].includes(roStatus.get(i.roId))))
      .reduce((s, i) => s + (n(i.partsPrice) || n(i.laborHours) ? n(i.partsPrice) + n(i.laborHours) * n(i.laborRate) : n(i.estimate)), 0);
    if (pending) out.set(u.carId, (out.get(u.carId) || 0) + pending);
  }
  return out;
}

const inScope = (car, cfg) => !SOLD.includes(car.status) && (cfg.includeNew || car.stockType !== 'new');

async function setPrice(q, who, dealershipId, car, price, reason) {
  const next = {
    ...car, price,
    priceHistory: [...(car.priceHistory || []), { price, previous: n(car.price), at: new Date().toISOString(), by: who.userName || (who.user && who.user.name) || 'Auto-pricing', reason }].slice(-100)
  };
  await store.save(q, 'cars', dealershipId, car.id, next);
  await audit.record(q, who, {
    action: 'update', entityType: 'car', entityId: car.id, label: [car.year, car.make, car.model, car.stockNumber && `#${car.stockNumber}`].filter(Boolean).join(' '),
    changes: { price: { from: n(car.price), to: price } }, details: `Price ${money(n(car.price))} → ${money(price)} (${reason})`
  });
  return next;
}

// Pull the market for cars (all in scope, or the ones asked for) and save it on each.
async function refreshMarket(dealershipId, cfg, carIds, { olderThanHours = 0 } = {}) {
  const cars = (await store.list(store.pool, 'cars', dealershipId)).filter(c => inScope(c, cfg) && (!carIds || carIds.includes(c.id)));
  const errors = [];
  let done = 0;
  for (const car of cars.slice(0, 300)) {
    if (olderThanHours && car.market && Date.now() - new Date(car.market.at).getTime() < olderThanHours * 3600000) continue;
    if (!canPrice(car)) continue;
    try {
      const market = await fetchMarket(car, cfg);
      if (!market) continue;
      await store.tx(async q => {
        const fresh = await store.get(q, 'cars', dealershipId, car.id, { forUpdate: true });
        if (fresh) await store.save(q, 'cars', dealershipId, car.id, { ...fresh, market: snapshot(fresh, cfg, market) });
      });
      done++;
    } catch (err) {
      errors.push(`${car.stockNumber || car.id}: ${err.message}`);
      if (/ZIP|401|403/.test(err.message)) break; // same problem for every car
    }
  }
  return { refreshed: done, errors: errors.slice(0, 5) };
}

// Auto-pricing for one store: fresh market, then every unlocked car to its suggestion.
async function autoPrice(dealershipId) {
  const d = await store.getDealership(store.pool, dealershipId);
  const cfg = pricingSettings(d && d.settings);
  if (!cfg.auto) return { skipped: true };
  const refreshed = await refreshMarket(dealershipId, cfg, null, { olderThanHours: 20 });
  const changed = await store.tx(async q => {
    const pending = await reconPendingByCar(q, dealershipId);
    const cars = (await store.list(q, 'cars', dealershipId)).filter(c => inScope(c, cfg) && !c.priceLocked);
    const who = { dealershipId, userName: 'Auto-pricing' };
    let count = 0;
    for (const car of cars) {
      const s = suggest(car, cfg, pending.get(car.id));
      if (s.suggested === null) continue;
      const price = nextPrice(car.price, s.suggested, cfg);
      if (Math.abs(price - n(car.price)) < 1) continue;
      await setPrice(q, who, dealershipId, car, price, `auto: ${s.reason}`);
      count++;
    }
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [dealershipId]);
    const settings = rows[0].settings || {};
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1',
      [dealershipId, { ...settings, pricing: { ...(settings.pricing || {}), lastRun: { at: new Date().toISOString(), changed: count, refreshed: refreshed.refreshed, errors: refreshed.errors } } }]);
    return count;
  });
  return { changed, ...refreshed };
}

// Every store with auto-pricing on, once a day.
async function autoPriceSweep() {
  const { rows } = await store.pool.query(`SELECT id, settings FROM dealerships WHERE (settings->'pricing'->>'auto')::boolean IS TRUE`);
  for (const row of rows) {
    const last = row.settings.pricing.lastRun && row.settings.pricing.lastRun.at;
    if (last && Date.now() - new Date(last).getTime() < 23 * 3600000) continue;
    await autoPrice(row.id).catch(err => console.error('Auto-pricing failed:', err.message));
  }
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allow = auth.requirePermission('editInventory');

async function loadCfg(dealershipId) {
  const d = await store.getDealership(store.pool, dealershipId);
  return pricingSettings(d && d.settings);
}

router.get('/pricing', allow, wrap(async (req, res) => {
  const cfg = await loadCfg(req.dealershipId);
  const [cars, pending] = await Promise.all([store.list(store.pool, 'cars', req.dealershipId), reconPendingByCar(store.pool, req.dealershipId)]);
  res.json({
    settings: cfg,
    connected: !!marketKey(),
    cars: cars.filter(c => !SOLD.includes(c.status)).map(c => {
      const s = suggest(c, cfg, pending.get(c.id));
      return {
        id: c.id, stockNumber: c.stockNumber || '', year: c.year, make: c.make, model: c.model, trim: c.trim || '', mileage: n(c.mileage),
        stockType: c.stockType === 'new' ? 'new' : 'used', status: c.status, price: n(c.price), cost: n(c.cost), reconPending: pending.get(c.id) || 0,
        photo: (c.photos || [])[0] || null, locked: !!c.priceLocked, inScope: inScope(c, cfg), canPrice: canPrice(c),
        market: c.market ? { ...c.market, comps: c.market.comps.slice(0, 15) } : null,
        lastChange: (c.priceHistory || []).slice(-1)[0] || null,
        ...s
      };
    })
  });
}));

router.post('/pricing/refresh', allow, wrap(async (req, res) => {
  const cfg = await loadCfg(req.dealershipId);
  const ids = Array.isArray((req.body || {}).carIds) ? req.body.carIds.map(String) : null;
  res.json(await refreshMarket(req.dealershipId, cfg, ids));
}));

// Set cars to their suggested price now.
router.post('/pricing/apply', allow, wrap(async (req, res) => {
  const cfg = await loadCfg(req.dealershipId);
  const ids = Array.isArray((req.body || {}).carIds) ? req.body.carIds.map(String) : [];
  const changed = await store.tx(async q => {
    const pending = await reconPendingByCar(q, req.dealershipId);
    let count = 0;
    for (const id of ids.slice(0, 500)) {
      const car = await store.get(q, 'cars', req.dealershipId, id, { forUpdate: true });
      if (!car || SOLD.includes(car.status)) continue;
      const s = suggest(car, cfg, pending.get(car.id));
      if (s.suggested === null || s.suggested === n(car.price)) continue;
      await setPrice(q, req, req.dealershipId, car, s.suggested, s.reason);
      count++;
    }
    return count;
  });
  res.json({ changed });
}));

// Locked cars keep their price; auto-pricing leaves them alone.
router.post('/pricing/cars/:id/lock', allow, wrap(async (req, res) => {
  const locked = !!(req.body || {}).locked;
  const saved = await store.tx(async q => {
    const car = await store.get(q, 'cars', req.dealershipId, req.params.id, { forUpdate: true });
    if (!car) return null;
    const next = await store.save(q, 'cars', req.dealershipId, car.id, { ...car, priceLocked: locked });
    await audit.updated(q, req, 'car', car, next, locked ? 'Price locked' : 'Price unlocked');
    return next;
  });
  if (!saved) return res.status(404).json({ error: 'Car not found' });
  res.json({ id: saved.id, locked });
}));

router.put('/pricing/settings', allow, wrap(async (req, res) => {
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const before = pricingSettings(settings);
    const { lastRun, ...rest } = pricingSettings({ pricing: { ...before, ...(req.body || {}) } });
    const next = { ...rest, lastRun: before.lastRun };
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, pricing: next }]);
    await audit.updated(q, req, 'settings', { ...before, id: 'pricing-settings' }, { ...next, id: 'pricing-settings' }, 'Market pricing rules');
    return next;
  });
  res.json(saved);
}));

// Run auto-pricing now (it also runs on its own once a day).
router.post('/pricing/run', allow, wrap(async (req, res) => {
  const cfg = await loadCfg(req.dealershipId);
  if (!cfg.auto) return res.status(400).json({ error: 'Turn auto-pricing on first.' });
  await store.pool.query(`UPDATE dealerships SET settings = jsonb_set(settings, '{pricing,lastRun}', 'null') WHERE id = $1`, [req.dealershipId]);
  res.json(await autoPrice(req.dealershipId));
}));

module.exports = { router, pricingSettings, defaultPricingSettings, suggest, nextPrice, snapshot, autoPrice, autoPriceSweep, setMarketSource };
