// Tests for the customer page's server side: customer numbers, assignments
// (Sales 1/2, BDC 1/2), wish list and other fields, Road to the Sale, and
// follow-up tasks and appointments.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('customer tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, sales, bdc;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  bdc = await h.createUser('salesperson');
});
after(() => h.stopServer());

test('customers get a number; imported ones were numbered on startup', async () => {
  const existing = (await as(admin, 'GET', '/leads')).body;
  assert.ok(existing.length > 0 && existing.every(l => Number.isInteger(l.customerNumber)), 'sample customers numbered');
  const a = (await as(sales, 'POST', '/leads', { name: 'Ann One' })).body;
  const b = (await as(sales, 'POST', '/leads', { name: 'Ben Two' })).body;
  assert.strictEqual(b.customerNumber, a.customerNumber + 1);
  const edited = (await as(sales, 'PUT', `/leads/${a.id}`, { customerNumber: 1, roadmap: ['x'] })).body;
  assert.strictEqual(edited.customerNumber, a.customerNumber, 'cannot be edited');
  assert.strictEqual(edited.roadmap.length, 7);
});

test('a salesperson adding a customer is their Sales 1; assignments must be staff here', async () => {
  const mine = (await as(sales, 'POST', '/leads', { name: 'Walk In' })).body;
  assert.strictEqual(mine.sales1Id, sales.id);
  const byManager = (await as(manager, 'POST', '/leads', { name: 'Phone Up' })).body;
  assert.strictEqual(byManager.sales1Id, null, 'managers adding customers are not assigned automatically');

  const assigned = (await as(manager, 'PUT', `/leads/${byManager.id}`, {
    sales1Id: sales.id, sales2Id: manager.id, bdc1Id: bdc.id, bdc2Id: null
  })).body;
  assert.deepStrictEqual([assigned.sales1Id, assigned.sales2Id, assigned.bdc1Id, assigned.bdc2Id], [sales.id, manager.id, bdc.id, null]);
  const bad = await as(manager, 'PUT', `/leads/${byManager.id}`, { bdc2Id: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.error, /active staff/);
});

test('hot, address, best contact, wish list, snooze, and dead reason are saved and cleaned up', async () => {
  const cars = (await as(admin, 'GET', '/cars')).body;
  const lead = (await as(sales, 'POST', '/leads', { name: 'Chris', carId: cars[0].id })).body;
  assert.deepStrictEqual(lead.wishList, [cars[0].id], 'the car they came in for starts the wish list');
  const saved = (await as(sales, 'PUT', `/leads/${lead.id}`, {
    hot: true, address: ' 1 Main St ', bestContact: 'text', wishList: [cars[1].id, cars[1].id, ''],
    snoozedUntil: '2030-01-02', status: 'lost', lostReason: 'Bought elsewhere'
  })).body;
  assert.strictEqual(saved.hot, true);
  assert.strictEqual(saved.address, '1 Main St');
  assert.strictEqual(saved.bestContact, 'text');
  assert.deepStrictEqual(saved.wishList, [cars[0].id, cars[1].id], 'duplicates dropped; the interested car stays on it');
  assert.match(saved.snoozedUntil, /^2030-01-02/);
  assert.strictEqual(saved.lostReason, 'Bought elsewhere');
  const cleaned = (await as(sales, 'PUT', `/leads/${lead.id}`, { bestContact: 'pigeon', snoozedUntil: 'never' })).body;
  assert.strictEqual(cleaned.bestContact, '');
  assert.strictEqual(cleaned.snoozedUntil, null);
});

test('Road to the Sale steps are checked off with who and when', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Dee' })).body;
  const done = (await as(sales, 'POST', `/leads/${lead.id}/roadmap`, { step: 3 })).body;
  assert.strictEqual(done.roadmap[3].by.id, sales.id);
  assert.ok(done.roadmap[3].at);
  const undone = (await as(sales, 'POST', `/leads/${lead.id}/roadmap`, { step: 3, done: false })).body;
  assert.strictEqual(undone.roadmap[3], null);
  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/roadmap`, { step: 7 })).status, 400);
  assert.deepStrictEqual((await as(sales, 'GET', '/settings')).body.roadmapLabels,
    ['Greet', 'Needs', 'Vehicle', 'Demo Drive', 'Trade', 'Write-up', 'Delivery']);
  const log = (await as(admin, 'GET', `/audit-log?entityType=lead&entityId=${lead.id}`)).body.entries;
  assert.ok(log.some(e => e.action === 'roadmap' && e.details === 'Demo Drive done'));

  const renamed = (await as(admin, 'PUT', '/settings', { roadmapLabels: ['Meet', '', 'Pick', 'Drive', 'Trade', 'Pencil', 'Deliver', 'Extra'] })).body;
  assert.deepStrictEqual(renamed.roadmapLabels, ['Meet', 'Needs', 'Pick', 'Drive', 'Trade', 'Pencil', 'Deliver'],
    'always 7; blanks go back to the default name');
});

test('tasks: schedule, change, complete into the customer log, and cancel', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Eve' })).body;
  assert.strictEqual((await as(sales, 'POST', '/tasks', { leadId: 'nope', dueAt: '2030-01-01T15:00:00Z' })).status, 400);
  assert.strictEqual((await as(sales, 'POST', '/tasks', { leadId: lead.id })).status, 400, 'needs a due time');

  const call = (await as(sales, 'POST', '/tasks', { leadId: lead.id, type: 'call', title: 'Follow up on trade', dueAt: '2030-01-01T15:00:00Z' })).body;
  assert.deepStrictEqual([call.status, call.assignedTo.id, call.leadName], ['open', sales.id, 'Eve'], 'assigned to whoever made it');
  const appt = (await as(manager, 'POST', '/tasks', { leadId: lead.id, type: 'appointment', title: 'Test drive', dueAt: '2029-12-30T18:00:00Z', assignedToId: sales.id })).body;
  assert.strictEqual(appt.assignedTo.id, sales.id);
  assert.strictEqual((await as(manager, 'POST', '/tasks', { leadId: lead.id, dueAt: '2030-01-01', assignedToId: 'x' })).status, 400);

  const open = (await as(sales, 'GET', `/tasks?leadId=${lead.id}&status=open`)).body;
  assert.deepStrictEqual(open.map(t => t.id), [appt.id, call.id], 'soonest first');
  assert.strictEqual((await as(manager, 'GET', '/tasks?assignedTo=me')).body.filter(t => t.leadId === lead.id).length, 0);

  const moved = (await as(sales, 'PUT', `/tasks/${call.id}`, { dueAt: '2030-01-02T15:00:00Z', status: 'done' })).body;
  assert.match(moved.dueAt, /^2030-01-02/);
  assert.strictEqual(moved.status, 'open', 'status only changes through complete / cancel');

  const { task, lead: updated } = (await as(sales, 'POST', `/tasks/${call.id}/complete`, { outcome: 'Left voicemail' })).body;
  assert.strictEqual(task.status, 'done');
  assert.strictEqual(task.completedBy.id, sales.id);
  assert.match(updated.activities[0].text, /Call task completed -- Follow up on trade: Left voicemail/);
  assert.strictEqual(updated.activities[0].type, 'task');
  assert.strictEqual((await as(sales, 'POST', `/tasks/${call.id}/complete`, {})).status, 409);
  assert.strictEqual((await as(sales, 'PUT', `/tasks/${call.id}`, { title: 'x' })).status, 409);

  const cancelled = (await as(sales, 'POST', `/tasks/${appt.id}/cancel`, {})).body;
  assert.strictEqual(cancelled.task.status, 'cancelled');
  assert.strictEqual(cancelled.lead.activities[0].type, 'appointment');

  assert.strictEqual((await as(sales, 'DELETE', `/tasks/${appt.id}`)).status, 403);
  assert.strictEqual((await as(manager, 'DELETE', `/tasks/${appt.id}`)).status, 204);
});

test('deleting a customer deletes their tasks; other stores never see them', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Gone Soon' })).body;
  await as(sales, 'POST', '/tasks', { leadId: lead.id, dueAt: '2030-01-01T15:00:00Z' });
  await as(manager, 'DELETE', `/leads/${lead.id}`);
  assert.strictEqual((await as(sales, 'GET', `/tasks?leadId=${lead.id}`)).body.length, 0);

  const { rows } = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Other Store') RETURNING id");
  const outsider = await h.createUser('admin', { dealershipId: rows[0].id });
  assert.strictEqual((await as(outsider, 'GET', '/tasks')).body.length, 0);
  const mine = (await as(sales, 'POST', '/leads', { name: 'Mine' })).body;
  assert.strictEqual((await as(outsider, 'POST', '/tasks', { leadId: mine.id, dueAt: '2030-01-01' })).status, 400);
  assert.strictEqual((await as(outsider, 'PUT', `/leads/${mine.id}`, { sales1Id: outsider.id })).status, 404);
});

test('activities record who logged them', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Fay' })).body;
  const a = (await as(sales, 'POST', `/leads/${lead.id}/activities`, { type: 'visit', text: 'Checked in' })).body;
  assert.strictEqual(a.type, 'visit');
  assert.strictEqual(a.by.id, sales.id);
  const odd = (await as(sales, 'POST', `/leads/${lead.id}/activities`, { type: 'carrier-pigeon', text: 'x' })).body;
  assert.strictEqual(odd.type, 'note');
});
