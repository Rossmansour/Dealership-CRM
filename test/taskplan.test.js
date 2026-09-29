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

const planned = async (user, leadId) => (await openTasksFor(user)).filter(t => t.leadId === leadId && t.planned).map(t => t.type).sort();

test('before engaged: a call, a text, and an email a day (what we have contact info for), plus one video', async () => {
  const a = await lead(manager, { name: 'Alice Moss', sales1Id: s1.id, bdc1Id: b1.id, phone: '602-555-0101', email: 'alice@example.com' });
  const b = await lead(manager, { name: 'Ben Ortiz', sales1Id: s1.id, phone: '602-555-1000' });
  const n = await lead(manager, { name: 'Nia Noinfo', sales1Id: s1.id });
  const busy = await lead(manager, { name: 'Dan Busy', sales1Id: s2.id, phone: '602-555-0103' });
  await as(s2, 'POST', '/tasks', { leadId: busy.id, type: 'call', dueAt: '2030-01-01T15:00:00Z', assignedToId: s2.id });
  const dead = await lead(manager, { name: 'Eve Dead', sales1Id: s1.id, phone: '602-555-0104' });
  await as(manager, 'PUT', `/leads/${dead.id}`, { status: 'lost' });
  const dup = await lead(manager, { name: 'Ben O', sales1Id: s1.id, phone: '(602) 555-1000' }); // goes to Duplicate Leads

  assert.strictEqual((await as(s1, 'POST', '/ai-tasks/run', { everyone: true })).status, 403, 'managers only for everyone');
  const r = (await as(manager, 'POST', '/ai-tasks/run', { everyone: true })).body;
  assert.strictEqual(r.source, 'rules');

  assert.deepStrictEqual(await planned(b1, a.id), ['call', 'email', 'text', 'video'], 'BDC agent works the new lead');
  const first = (await openTasksFor(b1)).find(t => t.type === 'call');
  assert.match(first.title, /First call/);
  assert.ok(first.notes, 'says why');
  assert.deepStrictEqual(await planned(s1, b.id), ['call', 'text', 'video'], 'no email address: no email');
  assert.deepStrictEqual(await planned(s1, n.id), ['video'], 'no phone or email: just the video');
  assert.deepStrictEqual(await planned(s2, busy.id), ['video'], 'a task set by hand covers the outreach');
  assert.deepStrictEqual(await planned(s1, dead.id), []);
  assert.deepStrictEqual(await planned(s1, dup.id), []);
  assert.ok((await as(b1, 'GET', '/alerts')).body.some(x => /Your day is planned: 4 tasks/.test(x.title)));

  // Running again the same day adds nothing.
  assert.strictEqual((await as(manager, 'POST', '/ai-tasks/run', { everyone: true })).body.created, 0);
});

test("channels already done today are skipped; logging one finishes only that task; the video carries over until it's sent", async () => {
  const did = await h.defaultDealershipId();
  const c = await lead(manager, { name: 'Cara Diaz', sales1Id: s2.id, phone: '602-555-0105', email: 'cara@example.com' });
  await as(s2, 'POST', `/leads/${c.id}/activities`, { type: 'call', text: 'Voicemail' });
  await as(s2, 'POST', '/ai-tasks/run', {});
  assert.deepStrictEqual(await planned(s2, c.id), ['email', 'text', 'video'], 'already called today');
  await as(s2, 'POST', `/leads/${c.id}/activities`, { type: 'text', text: 'Sent a hello' });
  assert.deepStrictEqual(await planned(s2, c.id), ['email', 'video'], 'the text finished the text task only');

  // Next day: yesterday's email is replaced; the same video task carries over.
  for (const t of (await openTasksFor(s2)).filter(t => t.leadId === c.id)) {
    const stored = await h.store.get(h.store.pool, 'tasks', did, t.id);
    await h.store.save(h.store.pool, 'tasks', did, t.id, { ...stored, dueAt: new Date(Date.now() - 86400000).toISOString() });
  }
  const video = (await openTasksFor(s2)).find(t => t.leadId === c.id && t.type === 'video');
  const email = (await openTasksFor(s2)).find(t => t.leadId === c.id && t.type === 'email');
  await as(s2, 'POST', '/ai-tasks/run', {});
  const carried = await h.store.get(h.store.pool, 'tasks', did, video.id);
  assert.strictEqual(carried.status, 'open');
  assert.strictEqual(carried.renewedCount, 1);
  assert.ok(new Date(carried.dueAt).getTime() > Date.now() - 3600000, 'moved to today');
  assert.match((await h.store.get(h.store.pool, 'tasks', did, email.id)).outcome, /Replaced/);
  assert.strictEqual((await openTasksFor(s2)).filter(t => t.leadId === c.id && t.type === 'video').length, 1, 'still one video');

  await as(s2, 'POST', `/leads/${c.id}/activities`, { type: 'video', text: 'Walkaround sent' });
  assert.strictEqual((await h.store.get(h.store.pool, 'tasks', did, video.id)).status, 'done');
  await as(s2, 'POST', '/ai-tasks/run', {});
  assert.ok(!(await planned(s2, c.id)).includes('video'), 'one video per customer, ever');
});

test('engaged: the AI plans from the notes (text and email only when there are none); no phone, email, or last name sent', async () => {
  let prompt = '';
  taskplan.useAI(async (system, history, message) => {
    prompt = system + message;
    return '```json\n[{"ref": 1, "type": "text", "title": "Send photos of the Civic", "why": "Asked for pictures on the call."}, {"ref": 1, "type": "email", "title": "Payment options under $400", "why": "Wants under $400/mo."}, {"ref": 1, "type": "fax", "title": "x"}, {"ref": 99, "type": "call", "title": "y"}]\n```';
  }, () => true);
  const f = await lead(manager, { name: 'Fran Lee', sales1Id: s1.id, phone: '480-555-2222', email: 'fran@example.com' });
  await as(s1, 'POST', `/leads/${f.id}/activities`, { type: 'call', text: 'Wants photos of the Civic and payments under 400', reached: true });
  const g = await lead(manager, { name: 'Gus Park', sales1Id: s1.id, phone: '480-555-3333', email: 'gus@example.com' });
  await as(manager, 'PUT', `/leads/${g.id}`, { status: 'negotiating' }); // engaged, nothing written down

  assert.strictEqual((await as(manager, 'POST', '/ai-tasks/run', {})).status, 400, 'managers plan everyone, not "my day"');
  const r = (await as(s1, 'POST', '/ai-tasks/run', {})).body;
  assert.strictEqual(r.source, 'ai');
  const fTasks = (await openTasksFor(s1)).filter(t => t.leadId === f.id && t.planned === 'ai');
  assert.deepStrictEqual(fTasks.map(t => t.title).sort(), ['Payment options under $400', 'Send photos of the Civic']);
  assert.deepStrictEqual(await planned(s1, g.id), ['email', 'text', 'video'], 'no notes: text and email');
  assert.match(prompt, /photos of the Civic/, 'the AI reads the notes');
  assert.ok(!/480-555|fran@example|gus@example/.test(prompt), 'no phone or email sent');
  assert.ok(!/Lee|Park/.test(prompt), 'first names only');

  // If the AI fails, the notes still drive a text and an email.
  taskplan.useAI(async () => { throw new Error('down'); }, () => true);
  const hal = await lead(manager, { name: 'Hal Kim', sales1Id: s2.id, phone: '480-555-4444', email: 'hal@example.com' });
  await as(s2, 'POST', `/leads/${hal.id}/activities`, { type: 'call', text: 'Needs a co-signer', reached: true });
  assert.strictEqual((await as(s2, 'POST', '/ai-tasks/run', {})).body.source, 'rules');
  const halTasks = (await openTasksFor(s2)).filter(t => t.leadId === hal.id && t.planned === 'rules');
  assert.deepStrictEqual(halTasks.map(t => t.type).sort(), ['email', 'text']);
  assert.ok(halTasks.every(t => /co-signer/.test(t.title)));
  taskplan.useAI(null, () => false);
});

test('settings: managers only; the daily limit is customers per person', async () => {
  assert.strictEqual((await as(s1, 'PUT', '/ai-tasks', { enabled: true })).status, 403);
  const saved = (await as(manager, 'PUT', '/ai-tasks', { enabled: true, maxPerPerson: 1 })).body;
  assert.deepStrictEqual([saved.enabled, saved.maxPerPerson], [true, 1]);
  const i = await lead(manager, { name: 'Ivy One', sales1Id: b1.id, bdc1Id: b1.id, phone: '602-555-0201' });
  const j = await lead(manager, { name: 'Jay Two', sales1Id: b1.id, bdc1Id: b1.id, phone: '602-555-0202' });
  const r = (await as(b1, 'POST', '/ai-tasks/run', {})).body;
  const got = [(await planned(b1, i.id)).length, (await planned(b1, j.id)).length];
  assert.ok(got.filter(Boolean).length === 1, 'one customer today, the other first tomorrow');
  assert.strictEqual(r.people[0].left, 1);
  const cfg = (await as(b1, 'GET', '/ai-tasks')).body;
  assert.strictEqual(cfg.aiConnected, false);
  await as(manager, 'PUT', '/ai-tasks', { maxPerPerson: 15 });
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
  assert.deepStrictEqual(forKim.map(t => t.type).sort(), ['appointment', 'call', 'video'], 'the appointment, its confirmation, and the video -- no daily outreach');

  // Done by logging the call; planning again doesn't ask twice.
  await as(s2, 'POST', `/leads/${cust.id}/activities`, { type: 'call', text: 'Confirmed for Saturday', reached: true });
  assert.strictEqual((await openTasksFor(s2)).filter(t => t.leadId === cust.id && t.planned === 'confirm').length, 0, 'logging the call finished it');
  await as(s2, 'POST', '/ai-tasks/run', {});
  assert.strictEqual((await openTasksFor(s2)).filter(t => t.leadId === cust.id && t.planned === 'confirm').length, 0);

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

test('tasks are spread through open hours', () => {
  const hoursAllWeek = { timezone: 'America/Phoenix', days: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { closed: false, open: '09:00', close: '18:00' }])) };
  // 7am Phoenix (14:00 UTC): starts at opening, 10 minutes apart.
  const at7 = Date.UTC(2026, 8, 29, 14, 0);
  assert.deepStrictEqual(taskplan.dueTimes(3, hoursAllWeek, at7), ['2026-09-29T16:00:00.000Z', '2026-09-29T16:10:00.000Z', '2026-09-29T16:20:00.000Z']);
  // After closing: tomorrow at opening.
  const at8pm = Date.UTC(2026, 8, 30, 3, 0);
  assert.strictEqual(taskplan.dueTimes(1, hoursAllWeek, at8pm)[0], '2026-09-30T16:00:00.000Z');
});
