// Tests for AI task planning: each salesperson / BDC agent gets their own
// tasks from their own customers (BDC on new leads it's on), customers with
// an open task, dead, or waiting in Duplicate Leads are skipped, no phone or
// email goes to the AI, the rules fallback, limits, and who can do what.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('task planning tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const taskplan = require('../taskplan');

let manager, s1, s2, b1;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const lead = async (by, body) => (await as(by, 'POST', '/leads', { source: 'website', ...body })).body;
const openTasksFor = async (user) => (await as(manager, 'GET', '/tasks?status=open')).body.filter(t => t.assignedTo.id === user.id);

before(async () => {
  await h.startServer();
  manager = await h.createUser('sales_manager');
  s1 = await h.createUser('salesperson');
  s2 = await h.createUser('salesperson');
  b1 = await h.createUser('bdc');
});
after(() => { taskplan.useAI(null, () => false); return h.stopServer(); });

test('by rules: each person gets tasks from their own customers; BDC takes new leads it is on', async () => {
  const a = await lead(manager, { name: 'Alice Moss', sales1Id: s1.id, bdc1Id: b1.id });
  const b = await lead(manager, { name: 'Ben Ortiz', sales1Id: s1.id, phone: '602-555-1000' });
  const c = await lead(manager, { name: 'Cara Diaz', sales1Id: s2.id });
  const busy = await lead(manager, { name: 'Dan Busy', sales1Id: s2.id });
  await as(s2, 'POST', '/tasks', { leadId: busy.id, type: 'call', dueAt: '2030-01-01T15:00:00Z', assignedToId: s2.id });
  const dead = await lead(manager, { name: 'Eve Dead', sales1Id: s1.id });
  await as(manager, 'PUT', `/leads/${dead.id}`, { status: 'lost' });
  await lead(manager, { name: 'Ben O', sales1Id: s1.id, phone: '(602) 555-1000' }); // goes to Duplicate Leads

  assert.strictEqual((await as(s1, 'POST', '/ai-tasks/run', { everyone: true })).status, 403, 'managers only for everyone');
  const r = (await as(manager, 'POST', '/ai-tasks/run', { everyone: true })).body;
  assert.strictEqual(r.source, 'rules');
  assert.strictEqual(r.created, 3);

  const bdcTasks = await openTasksFor(b1);
  assert.deepStrictEqual(bdcTasks.map(t => t.leadId), [a.id], 'BDC agent works the new lead');
  assert.strictEqual(bdcTasks[0].planned, 'rules');
  assert.match(bdcTasks[0].title, /First contact/);
  assert.ok(bdcTasks[0].notes, 'says why');
  assert.deepStrictEqual((await openTasksFor(s1)).map(t => t.leadId), [b.id], 'not the dead one or the duplicate');
  assert.deepStrictEqual((await openTasksFor(s2)).filter(t => t.planned).map(t => t.leadId), [c.id], 'not the one that already had a task');
  assert.ok((await as(b1, 'GET', '/alerts')).body.some(x => /Your day is planned: 1 task/.test(x.title)));

  // Running again adds nothing: everyone now has an open task.
  assert.strictEqual((await as(manager, 'POST', '/ai-tasks/run', { everyone: true })).body.created, 0);
});

test('by AI: it picks and words the tasks, and never sees phone numbers or emails', async () => {
  let prompt = '';
  taskplan.useAI(async (system, history, message) => {
    prompt = system + message;
    return '```json\n[{"ref": 2, "type": "text", "title": "Send photos of the Civic", "why": "Asked for pictures."}, {"ref": 99, "type": "call", "title": "x"}, {"ref": 1, "type": "fax", "title": "Call about trade"}]\n```';
  }, () => true);
  await lead(manager, { name: 'Fran Lee', sales1Id: s2.id, phone: '480-555-2222', email: 'fran@example.com' });
  await lead(manager, { name: 'Gus Park', sales1Id: s2.id, email: 'gus@example.com' });

  assert.strictEqual((await as(manager, 'POST', '/ai-tasks/run', {})).status, 400, 'managers plan everyone, not "my day"');
  const r = (await as(s2, 'POST', '/ai-tasks/run', {})).body;
  assert.strictEqual(r.source, 'ai');
  assert.strictEqual(r.created, 2, 'the made-up ref is dropped');
  const mine = (await openTasksFor(s2)).filter(t => t.planned === 'ai');
  assert.ok(mine.some(t => t.type === 'text' && t.title === 'Send photos of the Civic' && t.notes === 'Asked for pictures.'));
  assert.ok(mine.some(t => t.type === 'call' && t.title === 'Call about trade'), 'unknown task types become calls');
  assert.ok(!/480-555-2222|fran@example|gus@example/.test(prompt), 'no phone or email sent');
  assert.ok(!/Lee|Park/.test(prompt), 'first names only');
  assert.strictEqual((await openTasksFor(s1)).filter(t => t.planned === 'ai').length, 0, 'only my own day');

  // If the AI fails, rules take over.
  taskplan.useAI(async () => { throw new Error('down'); }, () => true);
  await lead(manager, { name: 'Hal Kim', sales1Id: s1.id });
  assert.strictEqual((await as(s1, 'POST', '/ai-tasks/run', {})).body.source, 'rules');
  taskplan.useAI(null, () => false);
});

test('settings: managers only; the daily limit', async () => {
  assert.strictEqual((await as(s1, 'PUT', '/ai-tasks', { enabled: true })).status, 403);
  const saved = (await as(manager, 'PUT', '/ai-tasks', { enabled: true, maxPerPerson: 1 })).body;
  assert.deepStrictEqual([saved.enabled, saved.maxPerPerson], [true, 1]);
  await lead(manager, { name: 'Ivy One', sales1Id: s1.id });
  await lead(manager, { name: 'Jay Two', sales1Id: s1.id });
  assert.strictEqual((await as(s1, 'POST', '/ai-tasks/run', {})).body.created, 1, 'at most 1 per person');
  const cfg = (await as(s1, 'GET', '/ai-tasks')).body;
  assert.strictEqual(cfg.lastRun.created, 1);
  assert.strictEqual(cfg.aiConnected, false);
});

test('appointments: confirmed a couple of days before and the day of, with no other tasks for that customer', async () => {
  await as(manager, 'PUT', '/ai-tasks', { maxPerPerson: 15, confirmDaysBefore: 2 });
  const did = await h.defaultDealershipId();
  const cust = await lead(manager, { name: 'Kim Sato', sales1Id: s2.id });
  // Booked last week for 2 days from now.
  const appt = (await as(s2, 'POST', '/tasks', { leadId: cust.id, type: 'appointment', title: 'Test drive', dueAt: new Date(Date.now() + 2 * 86400000).toISOString(), assignedToId: s2.id })).body;
  const stored = await h.store.get(h.store.pool, 'tasks', did, appt.id);
  await h.store.save(h.store.pool, 'tasks', did, appt.id, { ...stored, createdAt: new Date(Date.now() - 6 * 86400000).toISOString() });

  await as(s2, 'POST', '/ai-tasks/run', {});
  const forKim = (await openTasksFor(s2)).filter(t => t.leadId === cust.id);
  const confirm = forKim.find(t => t.planned === 'confirm');
  assert.ok(confirm, 'a confirmation task');
  assert.match(confirm.title, /^Confirm \w+day's .+ appointment$/);
  assert.strictEqual(confirm.appointmentId, appt.id);
  assert.strictEqual(forKim.length, 2, 'the appointment and its confirmation -- nothing else');

  // Done by logging the call; planning again doesn't ask twice.
  await as(s2, 'POST', `/leads/${cust.id}/activities`, { type: 'call', text: 'Confirmed for Saturday', reached: true });
  assert.strictEqual((await openTasksFor(s2)).filter(t => t.leadId === cust.id && t.planned).length, 0, 'logging the call finished it');
  await as(s2, 'POST', '/ai-tasks/run', {});
  assert.strictEqual((await openTasksFor(s2)).filter(t => t.leadId === cust.id && t.planned).length, 0);

  // The day of (an hour from now): confirmed again, before the appointment.
  const later = await h.store.get(h.store.pool, 'tasks', did, appt.id);
  const at = Date.now() + 3 * 3600000;
  const tz = 'America/Chicago';
  const sameDay = JSON.stringify(require('../hours').localDate(at, tz)) === JSON.stringify(require('../hours').localDate(Date.now(), tz));
  await h.store.save(h.store.pool, 'tasks', did, appt.id, { ...later, dueAt: new Date(at).toISOString() });
  await as(s2, 'POST', '/ai-tasks/run', {});
  const dayOf = (await openTasksFor(s2)).find(t => t.leadId === cust.id && t.planned === 'confirm');
  if (sameDay) {
    assert.ok(dayOf, 'day-of confirmation');
    assert.match(dayOf.title, /^Confirm today's/);
    assert.ok(new Date(dayOf.dueAt).getTime() <= at - 3600000 + 1000, 'due before the appointment');
  }
});

test("one touch a day: touched customers are skipped and yesterday's leftovers are replaced", async () => {
  const did = await h.defaultDealershipId();
  const x = await lead(manager, { name: 'Lou Fox', sales1Id: s1.id });
  const y = await lead(manager, { name: 'May Cho', sales1Id: s1.id });
  await as(s1, 'POST', `/leads/${y.id}/activities`, { type: 'text', text: 'Sent photos' });
  await as(s1, 'POST', '/ai-tasks/run', {});
  const mine = await openTasksFor(s1);
  const forX = mine.find(t => t.leadId === x.id && t.planned);
  assert.ok(forX, 'untouched customer gets a task');
  assert.ok(!mine.some(t => t.leadId === y.id && t.planned), 'already touched today: no task');

  // Pretend it was yesterday's and nobody did it.
  const old = await h.store.get(h.store.pool, 'tasks', did, forX.id);
  await h.store.save(h.store.pool, 'tasks', did, forX.id, { ...old, dueAt: new Date(Date.now() - 86400000).toISOString() });
  await as(s1, 'POST', '/ai-tasks/run', {});
  const replaced = await h.store.get(h.store.pool, 'tasks', did, forX.id);
  assert.strictEqual(replaced.status, 'cancelled');
  assert.match(replaced.outcome, /Replaced/);
  assert.strictEqual((await openTasksFor(s1)).filter(t => t.leadId === x.id && t.planned).length, 1, 'one fresh task, not two');
});

test('tasks are spread through open hours', () => {
  const hoursAllWeek = { timezone: 'America/Phoenix', days: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { closed: false, open: '09:00', close: '18:00' }])) };
  // 7am Phoenix (14:00 UTC): starts at opening, 20 minutes apart.
  const at7 = Date.UTC(2026, 8, 29, 14, 0);
  assert.deepStrictEqual(taskplan.dueTimes(3, hoursAllWeek, at7), ['2026-09-29T16:00:00.000Z', '2026-09-29T16:20:00.000Z', '2026-09-29T16:40:00.000Z']);
  // After closing: tomorrow at opening.
  const at8pm = Date.UTC(2026, 8, 30, 3, 0);
  assert.strictEqual(taskplan.dueTimes(1, hoursAllWeek, at8pm)[0], '2026-09-30T16:00:00.000Z');
});
