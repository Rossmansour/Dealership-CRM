// Tests for signing in, roles, user management, and keeping each
// dealership's data separate.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('auth tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

before(() => h.startServer());
after(() => h.stopServer());

test('first admin is created through the one-time setup link', async () => {
  assert.strictEqual((await h.api('GET', '/auth/setup-status')).body.needsSetup, true);

  const token = await h.auth.announceSetupIfNeeded('http://localhost');
  const bad = await h.api('POST', '/auth/setup', { token: 'wrong', name: 'X', email: 'x@example.com', password: 'password123' });
  assert.strictEqual(bad.status, 403);

  const weak = await h.api('POST', '/auth/setup', { token, name: 'Owner', email: 'owner@example.com', password: 'short' });
  assert.strictEqual(weak.status, 400);

  const ok = await h.api('POST', '/auth/setup', { token, name: 'Owner', email: 'Owner@Example.com', password: 'password123' });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.role, 'admin');
  assert.strictEqual(ok.body.email, 'owner@example.com');
  assert.ok(!('password_hash' in ok.body), 'password hash is never sent to the browser');

  const reuse = await h.api('POST', '/auth/setup', { token, name: 'Intruder', email: 'i@example.com', password: 'password123' });
  assert.strictEqual(reuse.status, 403, 'the setup link only works once');
  assert.strictEqual((await h.api('GET', '/auth/setup-status')).body.needsSetup, false);
});

test('signed-out visitors get nothing', async () => {
  assert.strictEqual((await h.api('GET', '/cars')).status, 401);
  assert.strictEqual((await h.api('GET', '/deals')).status, 401);
  assert.strictEqual((await h.api('POST', '/leads', { name: 'x' })).status, 401);

  const home = await h.page('/');
  assert.strictEqual(home.status, 302);
  assert.strictEqual(home.location, '/login.html');
  assert.strictEqual((await h.page('/login.html')).status, 200);
});

test('sign in, sign out, and wrong passwords', async () => {
  const user = await h.createUser('salesperson');
  assert.strictEqual((await h.api('GET', '/auth/me', null, user.cookie)).body.role, 'salesperson');
  assert.strictEqual((await h.page('/', user.cookie)).status, 200);

  assert.strictEqual(await h.login(user.email, 'wrong-password'), null);
  assert.strictEqual(await h.login('nobody@example.com', 'password123'), null);

  await h.api('POST', '/auth/logout', null, user.cookie);
  assert.strictEqual((await h.api('GET', '/cars', null, user.cookie)).status, 401, 'session ends on sign out');
});

test('salesperson can work leads and deals but not inventory, deletes, settings, or users', async () => {
  const { cookie } = await h.createUser('salesperson');
  const as = (method, path, body) => h.api(method, path, body, cookie);

  assert.strictEqual((await as('GET', '/cars')).status, 200);
  const lead = await as('POST', '/leads', { name: 'Walk-in Customer' });
  assert.strictEqual(lead.status, 201);
  assert.strictEqual((await as('POST', `/leads/${lead.body.id}/activities`, { text: 'Called' })).status, 201);
  const deal = await as('POST', '/deals', { leadId: lead.body.id });
  assert.strictEqual(deal.status, 201);
  assert.strictEqual((await as('PUT', `/deals/${deal.body.id}/credit-app`, { status: 'pending' })).status, 200);

  assert.strictEqual((await as('POST', '/cars', { make: 'A', model: 'B', year: 2020, price: 1 })).status, 403);
  assert.strictEqual((await as('DELETE', `/leads/${lead.body.id}`)).status, 403);
  assert.strictEqual((await as('DELETE', `/deals/${deal.body.id}`)).status, 403);
  assert.strictEqual((await as('PUT', '/settings', { docFee: 1 })).status, 403);
  assert.strictEqual((await as('POST', '/tax-rates', { state: 'CA' })).status, 403);
  assert.strictEqual((await as('GET', '/users')).status, 403);
  assert.strictEqual((await as('POST', '/users', { name: 'x', email: 'x@y.com', role: 'admin', password: 'password123' })).status, 403);
});

test('sales manager can manage inventory and delete, but not settings or users', async () => {
  const { cookie } = await h.createUser('sales_manager');
  const as = (method, path, body) => h.api(method, path, body, cookie);

  const car = await as('POST', '/cars', { make: 'Ford', model: 'F-150', year: 2021, price: 30000 });
  assert.strictEqual(car.status, 201);
  assert.strictEqual((await as('DELETE', `/cars/${car.body.id}`)).status, 204);
  assert.strictEqual((await as('PUT', '/settings', { docFee: 1 })).status, 403);
  assert.strictEqual((await as('GET', '/users')).status, 403);
});

test('admin manages users: add, change role, reset password, deactivate', async () => {
  const admin = await h.createUser('admin');
  const as = (method, path, body) => h.api(method, path, body, admin.cookie);

  const created = await as('POST', '/users', { name: 'New Hire', email: 'NewHire@example.com', role: 'salesperson', password: 'password123' });
  assert.strictEqual(created.status, 201);
  const dup = await as('POST', '/users', { name: 'Dup', email: 'newhire@example.com', role: 'salesperson', password: 'password123' });
  assert.strictEqual(dup.status, 409, 'emails are unique, ignoring capitalization');
  assert.strictEqual((await as('POST', '/users', { name: 'Bad', email: 'b@example.com', role: 'owner', password: 'password123' })).status, 400);

  const hireCookie = await h.login('newhire@example.com', 'password123');
  assert.ok(hireCookie);

  assert.strictEqual((await as('PUT', `/users/${created.body.id}`, { role: 'sales_manager' })).body.role, 'sales_manager');
  assert.strictEqual((await h.api('GET', '/auth/me', null, hireCookie)).body.role, 'sales_manager', 'role change applies immediately');

  await as('PUT', `/users/${created.body.id}`, { password: 'newpassword456' });
  assert.strictEqual((await h.api('GET', '/cars', null, hireCookie)).status, 401, 'password reset signs them out');
  assert.strictEqual(await h.login('newhire@example.com', 'password123'), null);
  const newCookie = await h.login('newhire@example.com', 'newpassword456');
  assert.ok(newCookie);

  await as('PUT', `/users/${created.body.id}`, { active: false });
  assert.strictEqual((await h.api('GET', '/cars', null, newCookie)).status, 401, 'deactivating signs them out');
  assert.strictEqual(await h.login('newhire@example.com', 'newpassword456'), null, 'deactivated users cannot sign in');
});

test('the last active admin cannot be demoted or deactivated', async () => {
  const other = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Solo Motors') RETURNING id");
  const admin = await h.createUser('admin', { dealershipId: other.rows[0].id });
  const as = (method, path, body) => h.api(method, path, body, admin.cookie);

  assert.strictEqual((await as('PUT', `/users/${admin.id}`, { role: 'salesperson' })).status, 400);
  assert.strictEqual((await as('PUT', `/users/${admin.id}`, { active: false })).status, 400);
  assert.strictEqual((await as('GET', '/auth/me')).body.role, 'admin');
});

test('users change their own password with their current one', async () => {
  const user = await h.createUser('finance');
  const as = (method, path, body) => h.api(method, path, body, user.cookie);

  assert.strictEqual((await as('POST', '/auth/change-password', { currentPassword: 'nope', newPassword: 'another123' })).status, 400);
  assert.strictEqual((await as('POST', '/auth/change-password', { currentPassword: user.password, newPassword: 'short' })).status, 400);
  assert.strictEqual((await as('POST', '/auth/change-password', { currentPassword: user.password, newPassword: 'another123' })).status, 204);
  assert.strictEqual((await as('GET', '/auth/me')).status, 200, 'this browser stays signed in');
  assert.ok(await h.login(user.email, 'another123'));
});

test('each dealership only ever sees its own data', async () => {
  const storeA = await h.createUser('admin');
  const other = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Other Motors') RETURNING id");
  const storeB = await h.createUser('admin', { dealershipId: other.rows[0].id });
  const asA = (method, path, body) => h.api(method, path, body, storeA.cookie);
  const asB = (method, path, body) => h.api(method, path, body, storeB.cookie);

  const carA = (await asA('POST', '/cars', { make: 'Store A', model: 'Car', year: 2020, price: 1 })).body;
  const leadA = (await asA('POST', '/leads', { name: 'Store A Customer' })).body;
  const dealA = (await asA('POST', '/deals', {})).body;

  assert.ok(!(await asB('GET', '/cars')).body.some(c => c.id === carA.id));
  assert.ok(!(await asB('GET', '/leads')).body.some(l => l.id === leadA.id));
  assert.strictEqual((await asB('GET', '/deals')).body.length, 0);
  assert.strictEqual((await asB('GET', `/cars/${carA.id}`)).status, 404);
  assert.strictEqual((await asB('PUT', `/leads/${leadA.id}`, { name: 'hijacked' })).status, 404);
  assert.strictEqual((await asB('DELETE', `/deals/${dealA.id}`)).status, 404);
  assert.strictEqual((await asB('PUT', `/users/${storeA.id}`, { active: false })).status, 404);
  assert.ok(!(await asB('GET', '/users')).body.some(u => u.id === storeA.id));

  const dealB = (await asB('POST', '/deals', {})).body;
  assert.strictEqual(dealB.dealNumber, 1001, 'each dealership has its own deal numbers');
  assert.strictEqual((await asA('GET', `/leads`)).body.find(l => l.id === leadA.id).name, 'Store A Customer');
});

test('repeated wrong passwords get locked out', async () => {
  const user = await h.createUser('salesperson');
  for (let i = 0; i < 10; i++) await h.login(user.email, 'wrong');
  const locked = await h.api('POST', '/auth/login', { email: user.email, password: user.password });
  assert.strictEqual(locked.status, 429);
});

test('one account being locked out does not lock out coworkers on the same connection', async () => {
  const unlucky = await h.createUser('salesperson');
  const coworker = await h.createUser('salesperson');
  for (let i = 0; i < 10; i++) await h.login(unlucky.email, 'wrong');
  assert.ok(await h.login(coworker.email, coworker.password));
});
