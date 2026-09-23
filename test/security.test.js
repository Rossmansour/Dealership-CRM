// Tests for SSN/license encryption, the audit log, and server-managed
// fields that edits can't overwrite.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('security tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const encryption = require('../encryption');

const SSN = '123-45-6789';
const CO_SSN = '987-65-4321';
const LICENSE = 'D1234567';

let admin, manager, sales, finance;

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  finance = await h.createUser('finance');
});
after(() => h.stopServer());

const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

async function rawDeal(id) {
  const { rows } = await h.store.pool.query('SELECT data::text AS text FROM deals WHERE id = $1', [id]);
  return rows[0].text;
}

async function auditEntries(query = '') {
  return (await as(admin, 'GET', `/audit-log${query}`)).body.entries;
}

test('encryption round-trips, and tampered values are rejected', () => {
  const sealed = encryption.encrypt(SSN);
  assert.ok(sealed.startsWith('enc:v1:'));
  assert.notStrictEqual(sealed, encryption.encrypt(SSN), 'same value encrypts differently each time');
  assert.strictEqual(encryption.decrypt(sealed), SSN);
  assert.strictEqual(encryption.decrypt('plain old value'), 'plain old value');
  const tampered = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => encryption.decrypt(tampered));
});

test('SSNs and license numbers are encrypted in the database but every role sees them', async () => {
  const deal = (await as(sales, 'POST', '/deals', {})).body;
  const saved = await as(sales, 'PUT', `/deals/${deal.id}/credit-app`, {
    status: 'pending',
    hasCoApplicant: true,
    applicant: { firstName: 'Jane', ssn: SSN, licenseNumber: LICENSE },
    coApplicant: { firstName: 'John', ssn: CO_SSN }
  });
  assert.strictEqual(saved.body.creditApp.applicant.ssn, SSN);

  const stored = await rawDeal(deal.id);
  assert.ok(!stored.includes(SSN) && !stored.includes(CO_SSN) && !stored.includes(LICENSE),
    'no SSN or license number in plain text in the database');
  assert.ok(stored.includes('enc:v1:'));
  assert.ok(stored.includes('Jane'), 'other fields are stored normally');

  for (const user of [admin, manager, sales, finance]) {
    const seen = (await as(user, 'GET', `/deals/${deal.id}`)).body.creditApp;
    assert.strictEqual(seen.applicant.ssn, SSN);
    assert.strictEqual(seen.applicant.licenseNumber, LICENSE);
    assert.strictEqual(seen.coApplicant.ssn, CO_SSN);
  }
  const listed = (await as(sales, 'GET', '/deals')).body.find(d => d.id === deal.id);
  assert.strictEqual(listed.creditApp.applicant.ssn, SSN);

  // Desking updates keep the encrypted values intact.
  await as(sales, 'PUT', `/deals/${deal.id}`, { rebate: 500 });
  assert.strictEqual((await as(sales, 'GET', `/deals/${deal.id}`)).body.creditApp.applicant.ssn, SSN);
  assert.ok(!(await rawDeal(deal.id)).includes(SSN));
});

test('SSNs saved before encryption existed are encrypted on startup', async () => {
  const dealership = await h.defaultDealershipId();
  await h.store.pool.query(
    `INSERT INTO deals (dealership_id, id, deal_number, data) VALUES ($1, 'legacy-deal', 9001, $2)`,
    [dealership, { id: 'legacy-deal', dealNumber: 9001, creditApp: { applicant: { ssn: SSN, licenseNumber: LICENSE }, coApplicant: { ssn: '' } } }]
  );
  assert.ok((await rawDeal('legacy-deal')).includes(SSN));

  await h.bootstrap();
  assert.ok(!(await rawDeal('legacy-deal')).includes(SSN), 'encrypted in place');
  assert.strictEqual((await as(admin, 'GET', '/deals/legacy-deal')).body.creditApp.applicant.ssn, SSN);

  await h.bootstrap(); // running again changes nothing
  assert.strictEqual((await as(admin, 'GET', '/deals/legacy-deal')).body.creditApp.applicant.ssn, SSN);
});

test('changes are logged field by field with who made them', async () => {
  const car = (await as(manager, 'POST', '/cars', { make: 'Honda', model: 'Accord', year: 2021, price: 24000, stockNumber: 'A-77' })).body;
  await as(manager, 'PUT', `/cars/${car.id}`, { price: 22500, mileage: 30000 });
  await as(manager, 'DELETE', `/cars/${car.id}`);

  const entries = await auditEntries(`?entityType=car&entityId=${car.id}`);
  assert.deepStrictEqual(entries.map(e => e.action), ['delete', 'update', 'create'], 'newest first');
  const [del, upd, crt] = entries;
  assert.strictEqual(crt.label, '2021 Honda Accord (Stock #A-77)');
  assert.strictEqual(crt.userId, manager.id);
  assert.ok(crt.userName);
  assert.deepStrictEqual(upd.changes.price, { from: 24000, to: 22500 });
  assert.deepStrictEqual(upd.changes.mileage, { from: 0, to: 30000 });
  assert.strictEqual(del.changes.deletedRecord.from.model, 'Accord', 'deleted records keep a copy');
});

test('an update that changes nothing writes no entry', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'No Change' })).body;
  await as(sales, 'PUT', `/leads/${lead.id}`, { name: 'No Change' });
  const entries = await auditEntries(`?entityType=lead&entityId=${lead.id}`);
  assert.deepStrictEqual(entries.map(e => e.action), ['create']);
});

test('credit app changes are logged without ever storing the SSN in the log', async () => {
  const deal = (await as(finance, 'POST', '/deals', {})).body;
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, { applicant: { firstName: 'Ana', ssn: SSN, licenseNumber: LICENSE } });
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, { applicant: { firstName: 'Ana', ssn: CO_SSN, licenseNumber: LICENSE } });

  const entries = await auditEntries(`?entityType=deal&entityId=${deal.id}`);
  const ssnChange = entries[0].changes['creditApp.applicant.ssn'];
  assert.deepStrictEqual(ssnChange, { from: '(hidden)', to: '(hidden)', hidden: true });
  assert.strictEqual(entries[0].details, 'Credit application');

  await as(admin, 'DELETE', `/deals/${deal.id}`);
  const { rows } = await h.store.pool.query('SELECT count(*)::int AS n FROM audit_log WHERE changes::text LIKE $1 OR changes::text LIKE $2 OR changes::text LIKE $3',
    [`%${SSN}%`, `%${CO_SSN}%`, `%${LICENSE}%`]);
  assert.strictEqual(rows[0].n, 0, 'no SSN or license number anywhere in the audit log, including deleted-record copies');
});

test('activities, texts, photos, deals, and automatic car status changes are logged', async () => {
  const car = (await as(manager, 'POST', '/cars', { make: 'Kia', model: 'Soul', year: 2022, price: 19000 })).body;
  const lead = (await as(sales, 'POST', '/leads', { name: 'Logged Lead', carId: car.id })).body;
  const activity = (await as(sales, 'POST', `/leads/${lead.id}/activities`, { type: 'call', text: 'Left voicemail' })).body;
  await as(manager, 'DELETE', `/leads/${lead.id}/activities/${activity.id}`);
  const deal = (await as(sales, 'POST', '/deals', { leadId: lead.id, carId: car.id })).body;

  const leadActions = (await auditEntries(`?entityType=lead&entityId=${lead.id}`)).map(e => [e.action, e.details]);
  assert.deepStrictEqual(leadActions, [
    ['delete_activity', 'call: Left voicemail'],
    ['add_activity', 'call: Left voicemail'],
    ['create', null]
  ]);

  const carEntries = await auditEntries(`?entityType=car&entityId=${car.id}`);
  assert.strictEqual(carEntries[0].details, `Automatic, from deal D-${deal.dealNumber}`);
  assert.deepStrictEqual(carEntries[0].changes.status, { from: 'available', to: 'pending' });
  assert.strictEqual(carEntries[0].userId, sales.id, 'credited to the person who worked the deal');
});

test('sign-ins, failed sign-ins, sign-outs, and account changes are logged -- never passwords', async () => {
  const user = await h.createUser('salesperson', { password: 'secretpass1' });
  await h.login(user.email, 'wrong-password');
  await h.api('POST', '/auth/logout', null, user.cookie);
  await as(admin, 'PUT', `/users/${user.id}`, { role: 'finance' });
  await as(admin, 'PUT', `/users/${user.id}`, { password: 'resetpass99' });
  await as(admin, 'PUT', `/users/${user.id}`, { active: false });

  const entries = await auditEntries(`?entityType=user&entityId=${user.id}`);
  assert.deepStrictEqual(entries.map(e => e.action),
    ['update', 'reset_password', 'update', 'sign_out', 'sign_in_failed', 'sign_in']);
  assert.deepStrictEqual(entries[0].changes.active, { from: true, to: false });
  assert.deepStrictEqual(entries[2].changes.role, { from: 'Salesperson', to: 'F&I Manager' });
  assert.strictEqual(entries[4].details, 'Wrong password');

  const { rows } = await h.store.pool.query(
    "SELECT count(*)::int AS n FROM audit_log WHERE coalesce(changes::text, '') || coalesce(details, '') ~ '(secretpass1|resetpass99|wrong-password|scrypt\\$)'");
  assert.strictEqual(rows[0].n, 0, 'no passwords or hashes in the log');
});

test('edits cannot overwrite history or server-managed fields', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'History Lead' })).body;
  await as(sales, 'POST', `/leads/${lead.id}/activities`, { text: 'Real call' });
  const forged = await as(sales, 'PUT', `/leads/${lead.id}`, { activities: [], dateAdded: '2000-01-01', notes: 'ok' });
  assert.strictEqual(forged.body.activities.length, 1, 'activity history kept');
  assert.notStrictEqual(forged.body.dateAdded, '2000-01-01');
  assert.strictEqual(forged.body.notes, 'ok', 'normal fields still update');

  const deal = (await as(sales, 'POST', '/deals', {})).body;
  await as(sales, 'PUT', `/deals/${deal.id}/credit-app`, { applicant: { ssn: SSN } });
  const desk = await as(sales, 'PUT', `/deals/${deal.id}`, { dealNumber: 1, creditApp: { applicant: { ssn: 'overwritten' } } });
  assert.strictEqual(desk.body.dealNumber, deal.dealNumber);
  assert.strictEqual(desk.body.creditApp.applicant.ssn, SSN, 'credit app only changes through its own screen');

  const car = (await as(manager, 'POST', '/cars', { make: 'VW', model: 'Golf', year: 2019, price: 15000 })).body;
  const edited = await as(manager, 'PUT', `/cars/${car.id}`, { photos: ['/evil.jpg'], price: 14000 });
  assert.deepStrictEqual(edited.body.photos, []);
  assert.strictEqual(edited.body.price, 14000);
});

test('who can read the audit log, and filtering it', async () => {
  assert.strictEqual((await as(sales, 'GET', '/audit-log')).status, 403);
  assert.strictEqual((await as(finance, 'GET', '/audit-log')).status, 403);
  assert.strictEqual((await as(manager, 'GET', '/audit-log')).status, 200);

  assert.strictEqual((await as(admin, 'PUT', '/audit-log/1', {})).status, 404, 'entries cannot be edited');
  assert.strictEqual((await as(admin, 'DELETE', '/audit-log/1')).status, 404, 'entries cannot be deleted');

  const bySales = await auditEntries(`?userId=${sales.id}`);
  assert.ok(bySales.length > 0 && bySales.every(e => e.userId === sales.id));
  const searched = await auditEntries('?search=History%20Lead');
  assert.ok(searched.length > 0 && searched.every(e => e.label === 'History Lead'));
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await auditEntries(`?from=${today}&to=${today}`)).length > 0);
  assert.strictEqual((await auditEntries('?to=2000-01-01')).length, 0);
  assert.strictEqual((await as(admin, 'GET', '/audit-log?from=not-a-date&before=abc')).status, 200, 'bad filters are ignored, not errors');

  const page1 = (await as(admin, 'GET', '/audit-log?limit=5')).body;
  assert.strictEqual(page1.entries.length, 5);
  const page2 = (await as(admin, 'GET', `/audit-log?limit=5&before=${page1.nextBefore}`)).body;
  assert.ok(page2.entries.every(e => e.id < page1.entries[4].id), 'next page continues where the last one stopped');
});

test("one dealership never sees another's audit log", async () => {
  const other = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Elsewhere Autos') RETURNING id");
  const otherAdmin = await h.createUser('admin', { dealershipId: other.rows[0].id });
  await as(otherAdmin, 'POST', '/leads', { name: 'Elsewhere Customer' });

  const mine = await auditEntries('?limit=500');
  assert.ok(!mine.some(e => e.label === 'Elsewhere Customer'));
  const theirs = (await as(otherAdmin, 'GET', '/audit-log?limit=500')).body.entries;
  assert.ok(theirs.some(e => e.label === 'Elsewhere Customer'));
  assert.ok(!theirs.some(e => e.label === 'History Lead'));
});

test('editing a car keeps numbers as numbers, and number-vs-text is not logged as a change', async () => {
  const car = (await as(manager, 'POST', '/cars', { make: 'Mazda', model: '3', year: 2020, price: 18000, cost: 15000, mileage: 25000 })).body;
  // Exactly what the edit form sends: every field, numbers as text, only price actually changed.
  const edited = (await as(manager, 'PUT', `/cars/${car.id}`, {
    make: 'Mazda', model: '3', year: '2020', vin: '', stockNumber: '', mileage: '25000', cost: '15000', price: '17500', status: 'available'
  })).body;
  assert.strictEqual(edited.price, 17500);
  assert.strictEqual(edited.year, 2020);

  const [entry] = await auditEntries(`?entityType=car&entityId=${car.id}`);
  assert.deepStrictEqual(Object.keys(entry.changes), ['price']);
  assert.deepStrictEqual(entry.changes.price, { from: 18000, to: 17500 });

  const stats = (await as(admin, 'GET', '/stats')).body;
  assert.strictEqual(typeof stats.inventoryValue, 'number');
});
