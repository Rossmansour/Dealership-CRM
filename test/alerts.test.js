// Tests for alerts (the bell): who gets which alert, never the person who
// caused it, per-person settings, snooze / dismiss / read, time-based
// alerts (tasks due, uncontacted leads), and privacy between people/stores.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('alert tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const { runAlertSweep } = require('../server');

let admin, manager, sales, sales2, finance;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const myAlerts = async user => (await as(user, 'GET', '/alerts')).body;
const count = async user => (await as(user, 'GET', '/alerts/count')).body.unread;

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  sales2 = await h.createUser('salesperson');
  finance = await h.createUser('finance');
});
after(() => h.stopServer());

test('assigning or transferring a customer alerts the new person -- never the one who did it', async () => {
  const lead = (await as(manager, 'POST', '/leads', { name: 'Ann Alert', phone: '555-1000', sales1Id: sales.id })).body;
  const a = (await myAlerts(sales)).find(x => x.link && x.link.id === lead.id);
  assert.ok(a, 'sales got it');
  assert.strictEqual(a.type, 'lead_assigned');
  assert.match(a.title, /Customer assigned to you: Ann Alert/);
  assert.match(a.body, /by Test sales_manager/);
  assert.ok(!(await myAlerts(manager)).some(x => x.link && x.link.id === lead.id), 'not the manager who assigned');

  await as(manager, 'PUT', `/leads/${lead.id}`, { sales1Id: sales2.id });
  assert.match((await myAlerts(sales2))[0].title, /Customer transferred to you: Ann Alert/);

  const own = (await as(sales, 'POST', '/leads', { name: 'Self Made' })).body;
  assert.strictEqual(own.sales1Id, sales.id);
  assert.ok(!(await myAlerts(sales)).some(x => x.link && x.link.id === own.id), 'adding your own customer is not an alert');
});

test('trades: managers hear about new ones; sales hears when theirs is appraised', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Trade Tom' })).body;
  const trade = (await as(sales, 'POST', `/leads/${lead.id}/trades`, { year: 2019, make: 'Ford', model: 'Escape', mileage: 60000 })).body;
  for (const u of [manager, admin]) {
    const a = (await myAlerts(u)).find(x => x.type === 'trade_needs_appraisal' && x.link.id === trade.id);
    assert.ok(a, 'managers and admins');
    assert.match(a.title, /Trade to appraise: 2019 Ford Escape/);
  }
  assert.ok(!(await myAlerts(finance)).some(x => x.type === 'trade_needs_appraisal'), 'not F&I');

  await as(manager, 'PUT', `/appraisals/${trade.id}`, { offer: 11000 });
  const a = (await myAlerts(sales)).find(x => x.type === 'trade_appraised');
  assert.match(a.title, /Trade appraised at \$11,000: 2019 Ford Escape/);
  assert.deepStrictEqual(a.link, { kind: 'lead', id: lead.id });
  const before = (await myAlerts(sales)).filter(x => x.type === 'trade_appraised').length;
  await as(manager, 'PUT', `/appraisals/${trade.id}`, { notes: 'no amount change' });
  assert.strictEqual((await myAlerts(sales)).filter(x => x.type === 'trade_appraised').length, before);
});

test('pushing a deal and credit alerts F&I and managers; F&I changing credit status alerts sales', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Credit Cara' })).body;
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, { applicant: { firstName: 'Credit', lastName: 'Cara' } });
  const deal = (await as(sales, 'POST', `/leads/${lead.id}/push-deal`, {})).body;
  const pushed = (await myAlerts(finance)).find(x => x.type === 'deal_pushed');
  assert.match(pushed.title, new RegExp(`Deal D-${deal.dealNumber} pushed: Credit Cara`));
  assert.deepStrictEqual(pushed.link, { kind: 'deal', id: deal.id });
  await as(sales, 'POST', `/leads/${lead.id}/push-credit`, { dealId: deal.id });
  assert.ok((await myAlerts(finance)).some(x => x.type === 'credit_pushed'));
  assert.ok(!(await myAlerts(sales)).some(x => x.type === 'deal_pushed'), 'not the salesperson who pushed');

  const ca = (await as(finance, 'GET', `/deals/${deal.id}`)).body.creditApp;
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, { ...ca, status: 'approved' });
  const status = (await myAlerts(sales)).find(x => x.type === 'credit_status');
  assert.match(status.title, /Credit approved: Credit Cara/);
  assert.strictEqual(status.priority, 'high');
});

test('tasks: assigned by someone else, and due now (once)', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Task Tina' })).body;
  await as(sales, 'POST', '/tasks', { leadId: lead.id, dueAt: new Date(Date.now() + 3600000).toISOString(), title: 'Mine' });
  assert.ok(!(await myAlerts(sales)).some(x => x.type === 'task_assigned'), 'scheduling your own task is not an alert');
  const t = (await as(manager, 'POST', '/tasks', { leadId: lead.id, type: 'appointment', title: 'Test drive', assignedToId: sales.id, dueAt: new Date(Date.now() - 60000).toISOString() })).body;
  assert.match((await myAlerts(sales))[0].title, /Appointment for you: Task Tina/);

  await runAlertSweep();
  await runAlertSweep();
  const due = (await myAlerts(sales)).filter(x => x.type === 'task_due');
  assert.strictEqual(due.length, 1, 'alerted once');
  assert.match(due[0].title, /Appointment due: Task Tina/);
  assert.strictEqual(due[0].sound, true);

  await as(sales, 'PUT', `/tasks/${t.id}`, { dueAt: new Date(Date.now() - 1000).toISOString() });
  await runAlertSweep();
  assert.strictEqual((await myAlerts(sales)).filter(x => x.type === 'task_due').length, 2, 'rescheduled tasks alert again');
});

test('new leads nobody contacted alert managers after the store limit', async () => {
  await as(admin, 'PUT', '/settings', { leadEscalationMinutes: 10 });
  const stale = (await as(manager, 'POST', '/leads', { name: 'Waiting Wendy', source: 'website' })).body;
  const contacted = (await as(manager, 'POST', '/leads', { name: 'Called Carl' })).body;
  await as(manager, 'POST', `/leads/${contacted.id}/activities`, { type: 'call', text: 'Talked' });
  const fresh = (await as(manager, 'POST', '/leads', { name: 'Fresh Fred' })).body;
  await h.store.pool.query(`UPDATE leads SET data = jsonb_set(data, '{dateAdded}', to_jsonb((now() - interval '11 minutes')::text)) WHERE id = ANY($1)`,
    [[stale.id, contacted.id]]);

  await runAlertSweep();
  const esc = (await myAlerts(admin)).filter(x => x.type === 'lead_escalation');
  assert.deepStrictEqual(esc.map(x => x.link.id), [stale.id], 'only the stale, uncontacted one');
  assert.match(esc[0].title, /Not contacted in 10\+ min: Waiting Wendy/);
  assert.ok((await myAlerts(manager)).some(x => x.type === 'lead_escalation' && x.link.id === stale.id));
  assert.ok(!(await myAlerts(sales)).some(x => x.type === 'lead_escalation'), 'salespeople are not escalated to');
  await runAlertSweep();
  assert.strictEqual((await myAlerts(admin)).filter(x => x.type === 'lead_escalation').length, 1, 'once per lead');
  assert.ok(fresh);
});

test('read, snooze, dismiss, and bulk actions only touch your own alerts', async () => {
  const lead = (await as(manager, 'POST', '/leads', { name: 'Bulk Bob', sales1Id: sales2.id })).body;
  await as(manager, 'PUT', `/leads/${lead.id}`, { sales2Id: sales.id });
  const mine = await myAlerts(sales2);
  const unread = await count(sales2);
  assert.ok(unread >= 1);

  await as(sales2, 'POST', '/alerts/read', { ids: [mine[0].id] });
  assert.strictEqual(await count(sales2), unread - 1);
  assert.ok((await myAlerts(sales2)).find(x => x.id === mine[0].id).readAt);
  assert.strictEqual((await as(sales2, 'GET', '/alerts?filter=unread')).body.length, unread - 1);

  assert.strictEqual((await as(sales2, 'POST', '/alerts/snooze', { ids: [mine[0].id], until: '2000-01-01' })).status, 400);
  await as(sales2, 'POST', '/alerts/snooze', { ids: [mine[0].id], until: new Date(Date.now() + 3600000).toISOString() });
  assert.ok(!(await myAlerts(sales2)).some(x => x.id === mine[0].id), 'hidden while snoozed');
  await h.store.pool.query(`UPDATE alerts SET data = jsonb_set(data, '{snoozedUntil}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`, [mine[0].id]);
  const back = (await myAlerts(sales2)).find(x => x.id === mine[0].id);
  assert.ok(back && !back.readAt, 'comes back unread');

  // Someone else can't touch them
  await as(sales, 'POST', '/alerts/dismiss', { ids: mine.map(x => x.id) });
  assert.strictEqual((await myAlerts(sales2)).length, mine.length);
  assert.strictEqual((await as(sales, 'POST', '/alerts/snooze', { ids: [mine[0].id], until: new Date(Date.now() + 60000).toISOString() })).status, 404);

  await as(sales2, 'POST', '/alerts/read', { all: true });
  assert.strictEqual(await count(sales2), 0);
  await as(sales2, 'POST', '/alerts/dismiss', { ids: [mine[0].id] });
  assert.ok(!(await myAlerts(sales2)).some(x => x.id === mine[0].id));
  await as(sales2, 'POST', '/alerts/dismiss', { all: true });
  assert.strictEqual((await myAlerts(sales2)).length, 0);
  assert.ok((await myAlerts(sales)).length > 0, "dismiss-all didn't touch anyone else");
});

test('each person picks which alerts they get, their priority, and sound', async () => {
  const settings = (await as(sales, 'GET', '/alerts/settings')).body;
  const byKey = Object.fromEntries(settings.map(s => [s.key, s]));
  assert.strictEqual(byKey.lead_assigned.enabled, true);
  assert.strictEqual(byKey.trade_needs_appraisal.enabled, false, 'manager alerts are off for salespeople by default');
  assert.strictEqual(byKey.text_reply.available, false);
  assert.deepStrictEqual(byKey.lead_assigned.delivery, { inApp: true, later: ['email', 'text', 'push'] });

  await as(sales, 'PUT', '/alerts/settings', { lead_assigned: { enabled: false }, task_assigned: { enabled: true, priority: 'high', sound: true }, text_reply: { enabled: true } });
  const after2 = Object.fromEntries((await as(sales, 'GET', '/alerts/settings')).body.map(s => [s.key, s]));
  assert.strictEqual(after2.lead_assigned.enabled, false);
  assert.deepStrictEqual([after2.task_assigned.priority, after2.task_assigned.sound], ['high', true]);
  assert.strictEqual(after2.text_reply.enabled, false, "can't turn on what isn't available");

  const before = (await myAlerts(sales)).length;
  const lead = (await as(manager, 'POST', '/leads', { name: 'Muted Mia', sales1Id: sales.id })).body;
  assert.strictEqual((await myAlerts(sales)).length, before, 'turned off: no alert');
  await as(manager, 'POST', '/tasks', { leadId: lead.id, assignedToId: sales.id, dueAt: new Date(Date.now() + 86400000).toISOString() });
  const a = (await myAlerts(sales))[0];
  assert.deepStrictEqual([a.type, a.priority, a.sound], ['task_assigned', 'high', true]);
  const c = (await as(sales, 'GET', '/alerts/count')).body;
  assert.ok(c.high && c.sound && c.latest);
});

test("other stores never see or cause each other's alerts; alerts need a sign-in", async () => {
  const { rows } = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Other Store') RETURNING id");
  const outsider = await h.createUser('admin', { dealershipId: rows[0].id });
  assert.strictEqual((await myAlerts(outsider)).length, 0);
  const theirs = (await as(outsider, 'POST', '/leads', { name: 'Elsewhere', sales1Id: sales.id })).status;
  assert.strictEqual(theirs, 400, "can't assign to another store's staff");
  assert.strictEqual((await h.api('GET', '/alerts')).status, 401);
});
