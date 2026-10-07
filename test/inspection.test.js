// Tests for vehicle inspections: starting one on an RO, technicians marking
// items and adding photos, advisors pricing them, sending the customer the
// link (texted when texting is set up), and the customer approving or
// declining -- approved items become jobs on the RO and the advisor is told.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('inspection tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
delete process.env.CLOUDINARY_URL; // local disk
const h = require('./helpers');
const { setSmsClient } = require('../server');

let base, advisor, tech, sales, lead, ro;
const sent = [];
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const item = name => ro.inspection.items.find(i => i.name === name);

before(async () => {
  base = await h.startServer();
  advisor = await h.createUser('service_advisor');
  tech = await h.createUser('technician');
  sales = await h.createUser('salesperson');
  lead = (await as(sales, 'POST', '/leads', { name: 'Omar Haddad', phone: '602-555-3131' })).body;
  ro = (await as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2019', make: 'Honda', model: 'Accord', mileageIn: 61000 }, jobs: [{ concern: 'Oil change', hours: 0.5 }] })).body;
});
after(() => h.stopServer());

test('the technician inspects: marks items, notes, and photos; prices are the advisor\'s', async () => {
  assert.strictEqual((await as(sales, 'POST', `/service/ros/${ro.id}/inspection`)).status, 403);
  ro = (await as(tech, 'POST', `/service/ros/${ro.id}/inspection`)).body;
  assert.ok(ro.inspection.items.length > 20, 'starts from the checklist');
  assert.strictEqual((await as(tech, 'POST', `/service/ros/${ro.id}/inspection`)).status, 400, 'only one per RO');

  ro = (await as(tech, 'PUT', `/service/ros/${ro.id}/inspection/items/${item('Front brake pads').id}`, { status: 'now', note: '2mm left', hours: 9 })).body;
  assert.strictEqual(item('Front brake pads').status, 'now');
  assert.strictEqual(item('Front brake pads').hours, 0, 'techs don\'t set prices');
  ro = (await as(tech, 'PUT', `/service/ros/${ro.id}/inspection/items/${item('Wiper blades').id}`, { status: 'soon', note: 'Streaking' })).body;
  ro = (await as(tech, 'PUT', `/service/ros/${ro.id}/inspection/items/${item('Battery').id}`, { status: 'ok' })).body;

  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(1024, 3)], { type: 'image/jpeg' }), 'pads.jpg');
  const up = await fetch(`${base}/api/service/ros/${ro.id}/inspection/items/${item('Front brake pads').id}/media`, { method: 'POST', headers: { Cookie: tech.cookie }, body: form });
  assert.strictEqual(up.status, 200);
  ro = await up.json();
  assert.strictEqual(item('Front brake pads').media.length, 1);
});

test('sending: every Soon/Now item needs a price; texted when texting is set up', async () => {
  let r = await as(advisor, 'POST', `/service/ros/${ro.id}/inspection/send`);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Front brake pads/);

  ro = (await as(advisor, 'PUT', `/service/ros/${ro.id}/inspection/items/${item('Front brake pads').id}`, { hours: 1.5, parts: 120 })).body;
  ro = (await as(advisor, 'PUT', `/service/ros/${ro.id}/inspection/items/${item('Wiper blades').id}`, { parts: 40 })).body;

  // No texting set up: the link comes back to send another way.
  r = await as(advisor, 'POST', `/service/ros/${ro.id}/inspection/send`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.texted, false);
  assert.match(r.body.link, new RegExp(`^${base}/i/[A-Za-z0-9_-]{20,}$`));

  setSmsClient({ messages: { create: async m => { sent.push(m); return { sid: 'SM1' }; } } });
  r = await as(advisor, 'POST', `/service/ros/${ro.id}/inspection/send`);
  assert.strictEqual(r.body.texted, true);
  assert.match(sent[0].body, /Hi Omar, your vehicle inspection/);
  assert.ok(sent[0].body.includes(r.body.link), 'same link as before');
  ro = r.body.ro;
});

test('the customer approves or declines; approved items become jobs; the advisor is alerted', async () => {
  const token = ro.inspection.token;
  const page = await fetch(`${base}/i/${token}`);
  assert.strictEqual(page.status, 200);
  const htmlText = await page.text();
  assert.match(htmlText, /Hi Omar/);
  assert.match(htmlText, /Front brake pads/);
  assert.match(htmlText, /\$345\.00/, '1.5 h x $150 + $120 parts');
  assert.strictEqual((await fetch(`${base}/i/not-a-real-token-here`)).status, 404);

  const brakes = item('Front brake pads').id;
  const wipers = item('Wiper blades').id;
  const battery = item('Battery').id;
  const r = await fetch(`${base}/i/${token}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: { [brakes]: 'approved', [wipers]: 'declined', [battery]: 'approved' } }) });
  assert.strictEqual(r.status, 204);

  ro = (await as(advisor, 'GET', `/service/ros/${ro.id}`)).body;
  assert.strictEqual(item('Front brake pads').decision, 'approved');
  assert.strictEqual(item('Wiper blades').decision, 'declined');
  assert.strictEqual(item('Battery').decision, null, 'good items aren\'t for approval');
  const job = ro.jobs.find(j => j.fromInspection === brakes);
  assert.ok(job, 'approved item added as a job');
  assert.deepStrictEqual([job.payType, job.hours, job.rate, job.parts[0].price], ['customer', 1.5, 150, 120]);
  assert.strictEqual(ro.jobs.length, 2);

  // Answers can't be changed or repeated; answered items are locked.
  await fetch(`${base}/i/${token}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: { [wipers]: 'approved' } }) });
  assert.strictEqual((await as(advisor, 'GET', `/service/ros/${ro.id}`)).body.jobs.length, 2);
  assert.strictEqual((await as(advisor, 'PUT', `/service/ros/${ro.id}/inspection/items/${brakes}`, { status: 'ok' })).status, 400);

  const alerts = (await as(advisor, 'GET', '/alerts')).body;
  assert.ok(alerts.some(a => a.type === 'inspection_decided' && /approved 1 \(\$345\.00\), declined 1 \(\$40\.00\)/.test(a.body)));
  const customer = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id);
  assert.ok(customer.activities.some(a => /Inspection on RO-\d+: approved 1/.test(a.text)));

  // A normal RO save doesn't wipe the inspection.
  await as(advisor, 'PUT', `/service/ros/${ro.id}`, { notes: 'Waiting', inspection: null });
  assert.ok((await as(advisor, 'GET', `/service/ros/${ro.id}`)).body.inspection.items.length > 20);
});
