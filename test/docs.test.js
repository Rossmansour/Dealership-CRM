// Tests for deal jackets: uploading scans (stored encrypted), the form
// library, wet-signature-only documents (REG 262 by default), marking
// signed, who can remove what, and the deal recap.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('docs tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let base, manager, sales, other, deal;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
async function uploadTo(user, path, name, bytes = PDF, type = 'application/pdf', extra = {}) {
  const fd = new FormData();
  if (name) fd.set('name', name);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.set('file', new Blob([bytes], { type }), 'scan.pdf');
  const res = await fetch(`${base}/api${path}`, { method: 'POST', body: fd, headers: { Cookie: user.cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  base = await h.startServer();
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  other = await h.createUser('salesperson');
  const car = (await as(manager, 'POST', '/cars', { year: 2021, make: 'Kia', model: 'Telluride', price: 38000, cost: 33000, mileage: 30000, stockType: 'used' })).body;
  deal = (await as(sales, 'POST', '/deals', { carId: car.id, vehiclePrice: 38000, docFee: 85 })).body;
});
after(() => h.stopServer());

test('scan a document into the jacket; the file is stored encrypted and comes back as sent', async () => {
  const r = await uploadTo(sales, `/deals/${deal.id}/documents`, 'Carfax');
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual([r.body.name, r.body.status, r.body.wetSignature], ['Carfax', 'unsigned', false]);
  const { rows } = await h.store.pool.query('SELECT content FROM deal_documents WHERE id = $1', [r.body.id]);
  assert.ok(!rows[0].content.includes(Buffer.from('%PDF')), 'encrypted at rest');
  const file = await fetch(`${base}/api/documents/${r.body.id}/file`, { headers: { Cookie: sales.cookie } });
  assert.strictEqual(file.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(PDF));
  assert.strictEqual((await fetch(`${base}/api/documents/${r.body.id}/file`)).status, 401, 'signed-in staff only');
});

test('only PDFs and images', async () => {
  const r = await uploadTo(sales, `/deals/${deal.id}/documents`, 'Script', Buffer.from('<script>'), 'text/html');
  assert.strictEqual(r.status, 400);
});

test('REG 262 is wet signature only by default; marking signed records who', async () => {
  const r = await uploadTo(sales, `/deals/${deal.id}/documents`, 'REG 262 Transfer');
  assert.strictEqual(r.body.wetSignature, true);
  const signed = (await as(sales, 'PUT', `/documents/${r.body.id}`, { status: 'signed' })).body;
  assert.strictEqual(signed.status, 'signed');
  assert.strictEqual(signed.signedMarkedBy.name, 'Test salesperson 2');
});

test('the form library: managers add forms, anyone adds them to a deal', async () => {
  assert.strictEqual((await uploadTo(sales, '/forms', 'LAW 553')).status, 403);
  const form = (await uploadTo(manager, '/forms', 'Retail contract', PDF, 'application/pdf', { wetSignature: 'false' })).body;
  const dmv = (await uploadTo(manager, '/forms', 'REG 262')).body;
  assert.deepStrictEqual([form.wetSignature, dmv.wetSignature], [false, true]);
  const added = await as(sales, 'POST', `/deals/${deal.id}/documents/from-form`, { formId: dmv.id });
  assert.strictEqual(added.status, 201);
  assert.deepStrictEqual([added.body.source, added.body.wetSignature], ['form', true]);
  await as(manager, 'PUT', '/forms-settings', { wetSignature: ['REG 262', 'Odometer'] });
  assert.strictEqual((await uploadTo(sales, `/deals/${deal.id}/documents`, 'Odometer statement')).body.wetSignature, true);
  const jacket = (await as(sales, 'GET', `/deals/${deal.id}/documents`)).body;
  assert.strictEqual(jacket.documents.length, 4);
});

test('removing: whoever added it or a manager', async () => {
  const doc = (await uploadTo(sales, `/deals/${deal.id}/documents`, 'Insurance card')).body;
  assert.strictEqual((await as(other, 'DELETE', `/documents/${doc.id}`)).status, 403);
  assert.strictEqual((await as(sales, 'DELETE', `/documents/${doc.id}`)).status, 204);
  const doc2 = (await uploadTo(sales, `/deals/${deal.id}/documents`, 'Stip')).body;
  assert.strictEqual((await as(manager, 'DELETE', `/documents/${doc2.id}`)).status, 204);
});

test('deal recap for managers: front gross from the car cost', async () => {
  assert.strictEqual((await as(sales, 'GET', `/deals/${deal.id}/recap`)).status, 403);
  const r = (await as(manager, 'GET', `/deals/${deal.id}/recap`)).body;
  assert.strictEqual(r.front, 38000 - 33000 + 85);
});

test("deleting a deal takes its jacket with it", async () => {
  await uploadTo(sales, `/deals/${deal.id}/documents`, 'Last one');
  assert.strictEqual((await as(manager, 'DELETE', `/deals/${deal.id}`)).status, 204);
  const { rows } = await h.store.pool.query('SELECT count(*)::int AS n FROM deal_documents WHERE deal_id = $1', [deal.id]);
  assert.strictEqual(rows[0].n, 0);
});
