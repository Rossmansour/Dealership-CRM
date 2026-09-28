// Tests for market pricing: the market from similar cars (adjusted for
// miles), the suggested price from the store's rules (target %, aging,
// gross floor, rounding), applying and locking, and auto-pricing.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('pricing tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const pricing = require('../pricing');

let manager, sales, car;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const row = async id => (await as(manager, 'GET', '/pricing')).body.cars.find(c => c.id === id);
// Ten similar cars, all at 50,000 miles, $20,000-$24,500 (middle: $22,250).
const listings = () => Array.from({ length: 10 }, (_, i) => ({ vin: `V${i}`, title: 'Similar', price: 20000 + i * 500, miles: 50000, daysListed: 20, dealer: 'Other store' }));

before(async () => {
  await h.startServer();
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  pricing.setMarketSource(async () => listings());
  car = (await as(manager, 'POST', '/cars', { year: 2020, make: 'Honda', model: 'Civic', price: 24000, cost: 17000, mileage: 40000, stockType: 'used', stockNumber: 'P1' })).body;
});
after(() => { pricing.setMarketSource(null); return h.stopServer(); });

test('managers only', async () => {
  assert.strictEqual((await as(sales, 'GET', '/pricing')).status, 403);
});

test('the market, adjusted for miles, and the suggested price', async () => {
  assert.strictEqual((await row(car.id)).reason, 'No market data yet');
  const r = (await as(manager, 'POST', '/pricing/refresh', {})).body;
  assert.ok(r.refreshed >= 1);
  const c = await row(car.id);
  // Ours has 10,000 fewer miles: each similar car counts $1,000 more at $0.10/mile.
  assert.strictEqual(c.market.median, 23250);
  assert.strictEqual(c.market.count, 10);
  assert.strictEqual(c.suggested, 23300, '100% of market, rounded to $100');
  assert.strictEqual(c.pctOfMarket, 103.2);
  assert.strictEqual(c.rank, 7, '6 similar cars are cheaper');
});

test('aging steps the price down; never under cost + recon + minimum gross', async () => {
  await as(manager, 'PUT', '/pricing/settings', { aging: [{ days: 30, pct: 95 }] });
  await h.store.pool.query(`UPDATE cars SET data = jsonb_set(data, '{dateAdded}', to_jsonb($2::text)) WHERE id = $1`, [car.id, new Date(Date.now() - 40 * 86400000).toISOString()]);
  let c = await row(car.id);
  assert.strictEqual(c.pct, 95);
  assert.strictEqual(c.suggested, 22100);
  await as(manager, 'PUT', '/pricing/settings', { minGross: 5500 });
  c = await row(car.id);
  assert.strictEqual(c.suggested, 22500, 'cost 17,000 + 5,500');
  assert.strictEqual(c.atFloor, true);
  await as(manager, 'PUT', '/pricing/settings', { minGross: 1000 });
});

test('apply the suggestion, keep the history; locked cars are left alone by auto-pricing', async () => {
  assert.strictEqual((await as(manager, 'POST', '/pricing/apply', { carIds: [car.id] })).body.changed, 1);
  let c = await row(car.id);
  assert.deepStrictEqual([c.price, c.lastChange.previous], [22100, 24000]);

  const other = (await as(manager, 'POST', '/cars', { year: 2020, make: 'Honda', model: 'Civic', price: 26000, cost: 17000, mileage: 50000, stockType: 'used' })).body;
  await as(manager, 'POST', `/pricing/cars/${car.id}/lock`, { locked: true });
  await as(manager, 'PUT', `/cars/${car.id}`, { price: 25000 });
  assert.strictEqual((await as(manager, 'POST', '/pricing/run')).status, 400, 'auto-pricing is off');
  await as(manager, 'PUT', '/pricing/settings', { auto: true, maxChange: 2000 });
  const run = (await as(manager, 'POST', '/pricing/run')).body;
  assert.ok(run.changed >= 1);
  assert.strictEqual((await row(car.id)).price, 25000, 'locked');
  c = await row(other.id);
  assert.strictEqual(c.price, 24000, 'moved toward 22,300 by at most $2,000');
  assert.strictEqual(c.lastChange.by, 'Auto-pricing');
  await pricing.autoPriceSweep();
  assert.strictEqual((await row(other.id)).price, 24000, 'once a day');
});

test('new cars are left out unless the store prices them too', async () => {
  const n = (await as(manager, 'POST', '/cars', { year: 2025, make: 'Honda', model: 'Civic', price: 28000, cost: 25000, mileage: 5, stockType: 'new' })).body;
  assert.strictEqual((await row(n.id)).inScope, false);
});
