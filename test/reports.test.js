// Tests for the Reports center: response time (buckets, averages, per
// salesperson and source), lead sources, salesperson activity,
// appointments, sold units, drill-down ids, who sees what, and saved
// reports.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('report tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, sales, sales2;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const MIN = 60000;
const T0 = Date.parse('2031-03-10T15:00:00Z'); // a quiet week, far from the sample data
const range = `from=${new Date(T0 - 60 * MIN).toISOString()}&to=${new Date(T0 + 3 * 24 * 60 * MIN).toISOString()}`;
const L = {};

// A lead that came in at T0 + addedMin, with contact at the given minutes after it came in.
async function lead(key, { owner, source = 'website', addedMin = 0, contacts = [], notes = [] }) {
  const l = (await as(manager, 'POST', '/leads', { name: key, source, sales1Id: owner.id })).body;
  const added = T0 + addedMin * MIN;
  const acts = [
    ...contacts.map(([type, m, by]) => ({ id: `${key}-${type}-${m}`, type, text: 'x', date: new Date(added + m * MIN).toISOString(), by: { id: (by || owner).id, name: 'x' } })),
    ...notes.map(m => ({ id: `${key}-note-${m}`, type: 'note', text: 'n', date: new Date(added + m * MIN).toISOString(), by: { id: owner.id, name: 'x' } }))
  ].sort((a, b) => b.date.localeCompare(a.date));
  await h.store.pool.query(`UPDATE leads SET data = data || jsonb_build_object('dateAdded', $2::text, 'activities', $3::jsonb) WHERE id = $1`,
    [l.id, new Date(added).toISOString(), JSON.stringify(acts)]);
  L[key] = l.id;
  return l;
}

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  sales2 = await h.createUser('salesperson');

  await lead('Fast', { owner: sales, contacts: [['call', 3]] });                    // 3 min
  await lead('Quick', { owner: sales, source: 'phone', contacts: [['text', 12], ['call', 200]] }); // 12 min (first one counts)
  await lead('Slow', { owner: sales2, contacts: [['email', 90]] });                // 90 min
  await lead('NoteOnly', { owner: sales2, notes: [5] });                           // a note isn't contact
  await lead('Never', { owner: sales2, source: 'phone' });
  await lead('OutOfRange', { owner: sales, addedMin: -5 * 24 * 60, contacts: [['call', 1]] });
});
after(() => h.stopServer());

test('response time: buckets, averages, and who never got a response', async () => {
  const r = (await as(manager, 'GET', `/reports/response-time?${range}`)).body;
  const k = Object.fromEntries(r.kpis.map(x => [x.key, x]));
  assert.strictEqual(k.leads.value, 5, 'only leads that came in during the range');
  assert.strictEqual(Math.round(k.avg.minutes), 35, '(3 + 12 + 90) / 3');
  assert.strictEqual(k.median.minutes, 12);
  assert.strictEqual(k.within5.percent, 20);
  assert.strictEqual(k.within60.percent, 40);
  assert.strictEqual(k.none.value, 2);
  assert.deepStrictEqual(k.none.ids.sort(), [L.NoteOnly, L.Never].sort(), 'a note is not a response');
  const b = Object.fromEntries(r.buckets.map(x => [x.key, x.n]));
  assert.deepStrictEqual(b, { m5: 1, m15: 1, h1: 0, h24: 1, later: 0, none: 2 });

  const byPerson = Object.fromEntries(r.bySalesperson.map(x => [x.label, x]));
  assert.strictEqual(byPerson[`Test salesperson ${3}`] ? 1 : 1, 1);
  const s1 = r.bySalesperson.find(x => x.key === sales.id);
  assert.deepStrictEqual([s1.leads.n, Math.round(s1.avgMinutes * 10) / 10, s1.pctWithin60, s1.none.n], [2, 7.5, 100, 0]);
  const s2 = r.bySalesperson.find(x => x.key === sales2.id);
  assert.deepStrictEqual([s2.leads.n, s2.within60.n, s2.none.n], [3, 0, 2]);
  const phone = r.bySource.find(x => x.key === 'phone');
  assert.deepStrictEqual([phone.leads.n, phone.none.n], [2, 1]);
  assert.ok(r.leads.find(l => l.id === L.Quick).responseMinutes === 12, 'drill-down rows carry the response time');
  assert.ok(!JSON.stringify(r).includes('creditApp'));
});

test('filters: source and salesperson; salespeople only see their own', async () => {
  const phone = (await as(manager, 'GET', `/reports/response-time?${range}&source=phone`)).body;
  assert.strictEqual(phone.kpis[0].value, 2);
  const person = (await as(manager, 'GET', `/reports/response-time?${range}&userId=${sales2.id}`)).body;
  assert.strictEqual(person.kpis[0].value, 3);
  assert.strictEqual(person.scope, 'person');

  const mine = (await as(sales, 'GET', `/reports/response-time?${range}&userId=${sales2.id}`)).body;
  assert.strictEqual(mine.scope, 'mine');
  assert.strictEqual(mine.kpis[0].value, 2, "asking for someone else's still shows your own");
  assert.ok(mine.leads.every(l => [L.Fast, L.Quick].includes(l.id)));
  assert.strictEqual((await as(manager, 'GET', '/reports/response-time?from=2031-01-02&to=2031-01-01')).status, 400);
  assert.strictEqual((await as(manager, 'GET', '/reports/nope')).status, 404);
});

test('lead source: contacted, appointments set and shown, sold, closing %', async () => {
  const appt = (await as(sales, 'POST', '/tasks', { leadId: L.Fast, type: 'appointment', dueAt: new Date(T0 + 60 * MIN).toISOString() })).body;
  await as(sales, 'POST', `/tasks/${appt.id}/complete`, { outcome: 'Came in' });
  await as(manager, 'PUT', `/leads/${L.Fast}`, { status: 'won' });
  const r = (await as(manager, 'GET', `/reports/lead-source?${range}`)).body;
  const web = r.rows.find(x => x.key === 'website');
  assert.deepStrictEqual([web.leads.n, web.contacted.n, web.apptsSet.n, web.apptsShown.n, web.sold.n, web.closingPct], [3, 2, 1, 1, 1, 33.3]);
  assert.deepStrictEqual(web.sold.ids, [L.Fast]);
  const k = Object.fromEntries(r.kpis.map(x => [x.key, x]));
  assert.deepStrictEqual([k.leads.value, k.sold.value, k.closing.percent], [5, 1, 20]);
});

test('salesperson activity counts what each person did in the range', async () => {
  const r = (await as(manager, 'GET', `/reports/scorecard?${range}`)).body;
  const s1 = r.rows.find(x => x.key === sales.id);
  assert.deepStrictEqual([s1.calls.n, s1.texts.n, s1.newLeads.n], [2, 1, 2], "the out-of-range lead's call isn't counted");
  const s2 = r.rows.find(x => x.key === sales2.id);
  assert.deepStrictEqual([s2.emails.n, s2.calls.n], [1, 0]);
  assert.ok(!r.rows.some(x => x.key === admin.id), 'people with nothing to show are left out');
});

test('appointments: set, shown, cancelled, not marked, and show rate', async () => {
  const mk = async (leadKey, minutes, who = sales) => (await as(manager, 'POST', '/tasks', { leadId: L[leadKey], type: 'appointment', assignedToId: who.id, dueAt: new Date(T0 + minutes * MIN).toISOString() })).body;
  const cancelled = await mk('Quick', 120);
  await as(sales, 'POST', `/tasks/${cancelled.id}/cancel`, {});
  await mk('Slow', 180, sales2); // in the past relative to now? no -- 2031 is the future: upcoming
  const r = (await as(manager, 'GET', `/reports/appointments?${range}`)).body;
  const k = Object.fromEntries(r.kpis.map(x => [x.key, x]));
  assert.deepStrictEqual([k.set.value, k.shown.value, k.showPct.percent, k.sold.value], [3, 1, 50, 1]);
  const s2 = r.rows.find(x => x.key === sales2.id);
  assert.strictEqual(s2.upcoming.n, 1);
});

test('sold units: units, gross, and days to sell by salesperson', async () => {
  const car = (await as(manager, 'POST', '/cars', { year: 2021, make: 'Kia', model: 'Soul', price: 20000, cost: 17000, stockNumber: 'K-1', mileage: 10 })).body;
  const deal = (await as(manager, 'POST', '/deals', { leadId: L.Slow, carId: car.id, vehiclePrice: 19500 })).body;
  await as(manager, 'PUT', `/deals/${deal.id}`, { status: 'delivered' });
  await h.store.pool.query(`UPDATE cars SET data = data || jsonb_build_object('dateSold', $2::text, 'dateAdded', $3::text) WHERE id = $1`,
    [car.id, new Date(T0 + 24 * 60 * MIN).toISOString(), new Date(T0 - 9 * 24 * 60 * MIN).toISOString()]);
  const r = (await as(manager, 'GET', `/reports/sold-units?${range}`)).body;
  const k = Object.fromEntries(r.kpis.map(x => [x.key, x]));
  assert.deepStrictEqual([k.units.value, k.gross.money, k.days.value], [1, 2500, 10]);
  assert.strictEqual(r.rows[0].key, sales2.id);
  assert.deepStrictEqual([r.deals[0].dealNumber, r.deals[0].vehicle, r.deals[0].customer], [deal.dealNumber, '2021 Kia Soul', 'Slow']);
  const theirs = (await as(sales, 'GET', `/reports/sold-units?${range}`)).body;
  assert.strictEqual(theirs.deals.length, 0, "a salesperson doesn't see someone else's sales");
});

test('completed call tasks count as a response', async () => {
  const l = await lead('TaskCall', { owner: sales, addedMin: 10 });
  const t = (await as(sales, 'POST', '/tasks', { leadId: l.id, type: 'call', dueAt: new Date(T0).toISOString() })).body;
  await as(sales, 'POST', `/tasks/${t.id}/complete`, { outcome: 'Left voicemail' });
  const r = (await as(manager, 'GET', `/reports/response-time?${range}`)).body;
  const row = r.leads.find(x => x.id === l.id);
  assert.ok(row && row.responseMinutes !== null);
});

test('saved reports are per person', async () => {
  assert.strictEqual((await as(sales, 'POST', '/reports/saved', { name: '', report: 'response-time' })).status, 400);
  assert.strictEqual((await as(sales, 'POST', '/reports/saved', { name: 'x', report: 'nope' })).status, 400);
  const saved = (await as(sales, 'POST', '/reports/saved', { name: 'My week', report: 'response-time', filters: { range: 'week', source: 'phone' } })).body;
  assert.deepStrictEqual([saved.name, saved.filters.range, saved.filters.source], ['My week', 'week', 'phone']);
  assert.deepStrictEqual((await as(sales, 'GET', '/reports/saved')).body.map(x => x.name), ['My week']);
  assert.deepStrictEqual((await as(manager, 'GET', '/reports/saved')).body, []);
  await as(manager, 'DELETE', `/reports/saved/${saved.id}`);
  assert.strictEqual((await as(sales, 'GET', '/reports/saved')).body.length, 1, "someone else can't delete it");
  await as(sales, 'DELETE', `/reports/saved/${saved.id}`);
  assert.strictEqual((await as(sales, 'GET', '/reports/saved')).body.length, 0);
  assert.strictEqual((await h.api('GET', '/reports/response-time')).status, 401);
});
