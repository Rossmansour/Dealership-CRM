// Tests for key status from the key machine (KeyTrak etc.): the machine
// sends check-out / check-in events with an integration token, and the
// CRM shows who has each car's key.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('key tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, sales, token, base;

before(async () => {
  base = await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  token = (await as(admin, 'POST', '/integrations/tokens', { name: 'KeyTrak' })).body.token;
});
after(() => h.stopServer());

const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

// Sends an event the way the key machine's connector would.
async function machine(body, withToken = token) {
  const res = await fetch(`${base}/api/integrations/keys/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withToken ? { Authorization: `Bearer ${withToken}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function keysFor(carId, user = sales) {
  return (await as(user, 'GET', '/keys')).body.filter(k => k.carId === carId);
}

let carCount = 0;
async function newCar(extra = {}) {
  carCount += 1;
  return (await as(manager, 'POST', '/cars', { make: 'Lexus', model: 'RX', year: 2022, price: 41000, stockNumber: `K-${carCount}`, ...extra })).body;
}

test('only admins create integration tokens, and a token is shown only once', async () => {
  assert.strictEqual((await as(sales, 'POST', '/integrations/tokens', { name: 'x' })).status, 403);
  assert.strictEqual((await as(manager, 'GET', '/integrations/tokens')).status, 403);
  assert.match(token, /^crm_[A-Za-z0-9_-]{40,}$/);

  const listed = (await as(admin, 'GET', '/integrations/tokens')).body;
  assert.ok(listed.some(t => t.name === 'KeyTrak'));
  assert.ok(!JSON.stringify(listed).includes(token), 'the token is never listed again');
  const { rows } = await h.store.pool.query('SELECT count(*)::int AS n FROM integration_tokens WHERE token_hash = $1', [token]);
  assert.strictEqual(rows[0].n, 0, 'only a hash is stored');
});

test('events need a valid, unrevoked token', async () => {
  const car = await newCar();
  assert.strictEqual((await machine({ action: 'check_out', stockNumber: car.stockNumber }, null)).status, 401);
  assert.strictEqual((await machine({ action: 'check_out', stockNumber: car.stockNumber }, 'crm_wrong')).status, 401);
  assert.strictEqual((await h.api('POST', '/integrations/keys/events', { action: 'check_out', stockNumber: car.stockNumber }, sales.cookie)).status, 401,
    'a user login is not enough');

  const temp = (await as(admin, 'POST', '/integrations/tokens', { name: 'Temp' })).body;
  assert.strictEqual((await machine({ action: 'check_in', stockNumber: car.stockNumber }, temp.token)).status, 200);
  await as(admin, 'DELETE', `/integrations/tokens/${temp.id}`);
  assert.strictEqual((await machine({ action: 'check_in', stockNumber: car.stockNumber }, temp.token)).status, 401, 'revoked tokens stop working');
});

test('a checkout shows whose name the key is under, and a return clears it', async () => {
  const car = await newCar();
  const out = await machine({ action: 'check_out', stockNumber: car.stockNumber, personName: 'Sam Sales', occurredAt: '2026-09-20T14:05:00Z' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.status, 'applied');

  let [key] = await keysFor(car.id);
  assert.strictEqual(key.label, 'Key 1', 'created the first time the machine mentions it');
  assert.strictEqual(key.status, 'out');
  assert.strictEqual(key.holderName, 'Sam Sales');
  assert.strictEqual(new Date(key.statusSince).toISOString(), '2026-09-20T14:05:00.000Z');
  assert.strictEqual(key.carLabel, `2022 Lexus RX (Stock #${car.stockNumber})`);

  await machine({ action: 'Returned', stockNumber: car.stockNumber, slot: '42', occurredAt: '2026-09-20T15:30:00Z' });
  [key] = await keysFor(car.id);
  assert.strictEqual(key.status, 'in', '"Returned" is understood as a check-in');
  assert.strictEqual(key.holderName, null);
  assert.strictEqual(key.slot, '42');
});

test('keys are matched by tag code, stock #, or VIN', async () => {
  const car = await newCar({ vin: '5fnrl6h72lb000123' });
  await machine({ action: 'check_in', vin: '5FNRL-6H72LB000123' });
  // The machine's own tag id for that key: the car's only key adopts it...
  await machine({ action: 'check_out', tagCode: 'TAG-77', stockNumber: car.stockNumber, personName: 'Ana' });
  let carKeys = await keysFor(car.id);
  assert.strictEqual(carKeys.length, 1);
  assert.strictEqual(carKeys[0].tagCode, 'TAG-77');

  // ...so later events can use just the tag.
  await machine({ action: 'check_in', tagCode: 'tag-77' });
  carKeys = await keysFor(car.id);
  assert.strictEqual(carKeys[0].status, 'in');

  // A second tag for the same car is its second key.
  await machine({ action: 'check_out', tagCode: 'TAG-78', stockNumber: car.stockNumber, personName: 'Ben' });
  carKeys = await keysFor(car.id);
  assert.deepStrictEqual(carKeys.map(k => [k.label, k.tagCode, k.status, k.holderName]),
    [['Key 1', 'TAG-77', 'in', null], ['Key 2', 'TAG-78', 'out', 'Ben']]);
});

test('the same event sent twice is only counted once', async () => {
  const car = await newCar();
  await machine({ action: 'check_out', stockNumber: car.stockNumber, personName: 'Sam', eventId: 'kt-1001' });
  await machine({ action: 'check_in', stockNumber: car.stockNumber, eventId: 'kt-1002' });
  const repeat = await machine({ action: 'check_out', stockNumber: car.stockNumber, personName: 'Sam', eventId: 'kt-1001' });
  assert.strictEqual(repeat.body.status, 'duplicate');
  assert.strictEqual((await keysFor(car.id))[0].status, 'in', 'the resent old checkout did not undo the return');
});

test('an event that arrives late does not overwrite newer status', async () => {
  const car = await newCar();
  await machine({ action: 'check_in', stockNumber: car.stockNumber, occurredAt: '2026-09-20T16:00:00Z' });
  const late = await machine({ action: 'check_out', stockNumber: car.stockNumber, personName: 'Old News', occurredAt: '2026-09-20T09:00:00Z' });
  assert.strictEqual(late.body.status, 'recorded_late');
  assert.strictEqual((await keysFor(car.id))[0].status, 'in');
});

test("if the machine knows the person's email, it's linked to their CRM account", async () => {
  const car = await newCar();
  await machine({ action: 'check_out', stockNumber: car.stockNumber, personEmail: sales.email.toUpperCase() });
  const [key] = await keysFor(car.id);
  assert.strictEqual(key.holderUserId, sales.id);
  assert.match(key.holderName, /^Test salesperson/);
});

test('events for unknown cars are kept for review, not lost', async () => {
  const res = await machine({ action: 'check_out', stockNumber: 'NOT-IN-CRM', personName: 'Someone', eventId: 'kt-unknown-1' });
  assert.strictEqual(res.status, 202);
  assert.strictEqual(res.body.status, 'unmatched');
  assert.strictEqual((await machine({ action: 'check_out', stockNumber: 'NOT-IN-CRM', eventId: 'kt-unknown-1' })).body.status, 'duplicate');

  const unmatched = (await as(admin, 'GET', '/integrations/keys/unmatched')).body;
  assert.strictEqual(unmatched.filter(u => u.stockNumber === 'NOT-IN-CRM').length, 1);
  assert.strictEqual((await as(sales, 'GET', '/integrations/keys/unmatched')).status, 403);
});

test('bad events get clear errors', async () => {
  assert.match((await machine({ action: 'dance', stockNumber: 'K-1' })).body.error, /check_out, check_in, or missing/);
  assert.match((await machine({ action: 'check_out' })).body.error, /tagCode, stockNumber, or vin/);
  assert.match((await machine({ action: 'check_out', stockNumber: 'K-1', occurredAt: 'yesterday-ish' })).body.error, /occurredAt/);
});

test("one dealership's key machine can't touch another dealership's cars", async () => {
  const car = await newCar();
  const other = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Other Motors') RETURNING id");
  const otherAdmin = await h.createUser('admin', { dealershipId: other.rows[0].id });
  const otherToken = (await as(otherAdmin, 'POST', '/integrations/tokens', { name: 'Their KeyTrak' })).body.token;

  const res = await machine({ action: 'check_out', stockNumber: car.stockNumber, personName: 'Intruder' }, otherToken);
  assert.strictEqual(res.body.status, 'unmatched', 'their stock numbers only match their own inventory');
  assert.deepStrictEqual(await keysFor(car.id), []);
  assert.strictEqual((await as(otherAdmin, 'GET', '/keys')).body.length, 0);
  assert.ok(!(await as(admin, 'GET', '/integrations/keys/unmatched')).body.some(u => u.personName === 'Intruder'));
});

test('key status needs a sign-in, and deleting a car removes its keys', async () => {
  assert.strictEqual((await h.api('GET', '/keys')).status, 401);
  const car = await newCar();
  await machine({ action: 'check_in', stockNumber: car.stockNumber });
  assert.strictEqual((await keysFor(car.id)).length, 1);
  await as(manager, 'DELETE', `/cars/${car.id}`);
  assert.strictEqual((await keysFor(car.id)).length, 0);
});

test("a key machine whose clock runs ahead can't set a time in the future", async () => {
  const car = await newCar();
  await machine({ action: 'check_out', stockNumber: car.stockNumber, occurredAt: '2099-01-01T00:00:00Z' });
  const [key] = await keysFor(car.id);
  assert.ok(new Date(key.statusSince) <= new Date(), 'uses the time it was received instead');
});
