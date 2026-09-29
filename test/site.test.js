// Tests for the public marketing site: it loads without signing in, and
// "Book a demo" turns into a new customer (source: Website) in the store's
// CRM -- with a hidden field for bots and a limit per address.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('site tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let base, manager;
before(async () => {
  base = await h.startServer();
  manager = await h.createUser('sales_manager');
});
after(() => h.stopServer());

test('the site loads without signing in', async () => {
  const res = await fetch(`${base}/site/`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Run the whole store from one place/);
  assert.strictEqual((await fetch(`${base}/site/img/recon.jpg`)).status, 200);
});

test('a demo request becomes a hot website lead', async () => {
  const r = await h.api('POST', '/public/demo-request', { name: 'Pat Dealer', dealership: 'Sunset Motors', email: 'pat@sunset.example', phone: '555-0100', role: 'General manager', stores: '2-5', message: 'Recon and pricing' });
  assert.strictEqual(r.status, 201);
  const lead = (await h.api('GET', '/leads', null, manager.cookie)).body.find(l => l.email === 'pat@sunset.example');
  assert.ok(lead);
  assert.deepStrictEqual([lead.name, lead.source, lead.hot], ['Pat Dealer', 'website', true]);
  assert.match(lead.notes, /Sunset Motors/);
  assert.match(lead.notes, /Recon and pricing/);
});

test('bad requests, bots, and too many requests', async () => {
  assert.strictEqual((await h.api('POST', '/public/demo-request', { name: 'X', dealership: 'Y', email: 'nope' })).status, 400);
  const before = (await h.api('GET', '/leads', null, manager.cookie)).body.length;
  assert.strictEqual((await h.api('POST', '/public/demo-request', { name: 'Bot', dealership: 'Spam', email: 'b@b.co', website: 'http://spam' })).status, 201);
  assert.strictEqual((await h.api('GET', '/leads', null, manager.cookie)).body.length, before, 'bot requests are dropped quietly');
  let last;
  for (let i = 0; i < 6; i++) last = await h.api('POST', '/public/demo-request', { name: `P${i}`, dealership: 'D', email: `p${i}@d.co` });
  assert.strictEqual(last.status, 429);
});
