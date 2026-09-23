// API tests against a real Postgres database.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
//
// WARNING: this wipes every table in the TEST_DATABASE_URL database before
// running. Point it at a throwaway database, never the real one.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('API tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin;

// Every call in this file is made as a signed-in admin, who can do
// everything; role limits are tested in auth.test.js.
const api = (method, path, body) => h.api(method, path, body, admin.cookie);

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
});

after(() => h.stopServer());

test('first startup imports data/db.json, and restarting does not import it twice', async () => {
  const legacy = require('../data/db.json');
  const cars = (await api('GET', '/cars')).body;
  assert.deepStrictEqual(cars, legacy.cars);

  await h.bootstrap(); // same as a server restart
  assert.strictEqual((await api('GET', '/cars')).body.length, legacy.cars.length);
  assert.strictEqual((await api('GET', '/leads')).body.length, legacy.leads.length);
});

test('cars: create, read, update, delete', async () => {
  const created = await api('POST', '/cars', { make: 'Honda', model: 'Civic', year: 2019, price: 15000, cost: 12000 });
  assert.strictEqual(created.status, 201);
  const id = created.body.id;

  assert.strictEqual((await api('GET', `/cars/${id}`)).body.model, 'Civic');

  const sold = await api('PUT', `/cars/${id}`, { status: 'sold', id: 'someone-elses-id' });
  assert.strictEqual(sold.body.status, 'sold');
  assert.ok(sold.body.dateSold, 'dateSold is stamped when a car is first sold');
  assert.strictEqual(sold.body.id, id, 'an id in the body cannot re-point the record');

  assert.strictEqual((await api('DELETE', `/cars/${id}`)).status, 204);
  assert.strictEqual((await api('GET', `/cars/${id}`)).status, 404);
  assert.strictEqual((await api('DELETE', `/cars/${id}`)).status, 404);
});

test('missing fields and unknown records return clear errors', async () => {
  assert.strictEqual((await api('POST', '/cars', { make: 'Honda' })).status, 400);
  assert.strictEqual((await api('POST', '/leads', {})).status, 400);
  assert.strictEqual((await api('PUT', '/leads/nope', { name: 'x' })).status, 404);
  assert.strictEqual((await api('PUT', '/deals/nope', {})).status, 404);
  assert.strictEqual((await api('PUT', '/deals/nope/credit-app', {})).status, 404);
});

test('deal numbers stay unique when many deals are created at once', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => api('POST', '/deals', {})));
  const numbers = results.map(r => r.body.dealNumber);
  assert.strictEqual(new Set(numbers).size, 20);

  const legacy = require('../data/db.json');
  const maxLegacy = Math.max(...legacy.deals.map(d => d.dealNumber));
  assert.ok(Math.min(...numbers) > maxLegacy, 'new deal numbers continue after imported ones');
});

test('simultaneous activity logs on one lead are all kept', async () => {
  const lead = (await api('POST', '/leads', { name: 'Test Customer' })).body;
  await Promise.all(Array.from({ length: 15 }, (_, i) =>
    api('POST', `/leads/${lead.id}/activities`, { type: 'call', text: `call ${i}` })));

  const leads = (await api('GET', '/leads')).body;
  const saved = leads.find(l => l.id === lead.id);
  assert.strictEqual(saved.activities.length, 15);
});

test('working a deal marks the car pending, delivering it marks the car sold', async () => {
  const car = (await api('POST', '/cars', { make: 'Toyota', model: 'Camry', year: 2020, price: 20000 })).body;
  const deal = (await api('POST', '/deals', { carId: car.id })).body;
  assert.strictEqual(deal.vehiclePrice, 20000);
  assert.strictEqual((await api('GET', `/cars/${car.id}`)).body.status, 'pending');

  const delivered = await api('PUT', `/deals/${deal.id}`, { status: 'delivered', dealNumber: 1 });
  assert.strictEqual(delivered.body.dealNumber, deal.dealNumber, 'deal number cannot be edited');
  assert.strictEqual((await api('GET', `/cars/${car.id}`)).body.status, 'sold');
});

test('credit app saves and stamps the submission date once', async () => {
  const deal = (await api('POST', '/deals', {})).body;
  const first = await api('PUT', `/deals/${deal.id}/credit-app`, {
    status: 'pending',
    applicant: { firstName: 'Jane' }
  });
  assert.strictEqual(first.body.creditApp.applicant.firstName, 'Jane');
  const stamped = first.body.creditApp.dateSubmitted;
  assert.ok(stamped);

  const second = await api('PUT', `/deals/${deal.id}/credit-app`, { status: 'approved' });
  assert.strictEqual(second.body.creditApp.dateSubmitted, stamped);
});

test('settings and tax rates round-trip', async () => {
  const settings = (await api('PUT', '/settings', { docFee: 199 })).body;
  assert.strictEqual(settings.docFee, 199);
  assert.strictEqual((await api('GET', '/settings')).body.docFee, 199);

  const rate = (await api('POST', '/tax-rates', { state: 'nv', county: 'Clark', stateTaxRate: 6.85 })).body;
  assert.strictEqual(rate.state, 'NV');
  assert.strictEqual((await api('GET', '/tax-rates?state=NV')).body.length, 1);
  assert.strictEqual((await api('PUT', `/tax-rates/${rate.id}`, { countyTaxRate: 1.5 })).body.countyTaxRate, 1.5);
  assert.strictEqual((await api('DELETE', `/tax-rates/${rate.id}`)).status, 204);

  const fees = (await api('POST', '/fees/calculate', { state: 'CA', county: 'Los Angeles', price: 20000 })).body;
  assert.strictEqual(fees.taxRate, 9.75);
});

test('stats reflect the database', async () => {
  const stats = (await api('GET', '/stats')).body;
  const cars = (await api('GET', '/cars')).body;
  assert.strictEqual(stats.totalCars, cars.length);
});
