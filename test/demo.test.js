// Tests for demo data: only admins can load it, it fills every module,
// it can't be loaded twice, and removing it deletes exactly the demo
// records and demo staff -- nothing the store entered itself.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('demo tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
});
after(() => h.stopServer());

test('load, use, and remove demo data', async () => {
  const real = (await as(admin, 'POST', '/leads', { name: 'Real Customer' })).body;
  assert.strictEqual((await as(manager, 'POST', '/demo')).status, 403);
  const loaded = await as(admin, 'POST', '/demo');
  assert.strictEqual(loaded.status, 201);
  assert.ok(loaded.body.repairOrders >= 10);
  assert.strictEqual((await as(admin, 'POST', '/demo')).status, 400, 'only once');
  assert.strictEqual((await as(admin, 'GET', '/demo')).body.loaded, true);

  const staff = (await as(admin, 'GET', '/staff')).body;
  assert.ok(staff.some(u => u.role === 'technician') && staff.some(u => u.role === 'service_advisor'));
  const month = new Date().toISOString().slice(0, 7);
  const fixed = (await as(admin, 'GET', `/dashboard/fixed?month=${month}`)).body.mtd;
  assert.ok(fixed.ros > 0 && fixed.gross > 0, 'service numbers show up');
  const variable = (await as(admin, 'GET', `/dashboard/variable?month=${month}`)).body.mtd;
  assert.ok(variable.new.units + variable.used.units > 0, 'sales numbers show up');
  const parts = (await as(admin, 'GET', '/parts')).body;
  const filter = parts.find(p => p.number === 'FL-820S');
  assert.ok(filter.committed > 0, 'open ROs hold parts');
  const open = (await as(admin, 'GET', '/service/ros?status=open')).body;
  assert.ok(open.some(r => r.carId), 'there is recon in progress');

  const removed = await as(admin, 'DELETE', '/demo');
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(removed.body.staff, 12);
  const leftLeads = (await as(admin, 'GET', '/leads')).body;
  assert.ok(!leftLeads.some(l => l.name === 'Brian Thompson' || l.name === 'Frank Russo'), 'demo customers are gone');
  assert.ok(leftLeads.some(l => l.id === real.id), 'the real customer stays');
  assert.strictEqual((await as(admin, 'GET', '/service/ros')).body.length, 0);
  assert.strictEqual((await as(admin, 'GET', '/parts')).body.length, 0);
  assert.strictEqual((await as(admin, 'GET', '/staff')).body.filter(u => u.role === 'technician').length, 0);
  assert.strictEqual((await as(admin, 'GET', '/demo')).body.loaded, false);
});
