// Tests for Duplicate Leads: new leads matching a customer already in the
// CRM (phone, email, name) go to the bucket and skip round robin; anyone can
// mark one by hand; managers merge (everything moves to the kept customer)
// or send it on as not a duplicate; the rules and the check-everything scan.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('duplicate lead tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let manager, otherManager, s1, s2;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const newLead = async (by, body) => (await as(by, 'POST', '/leads', { source: 'website', ...body })).body;
const bucket = async () => (await as(manager, 'GET', '/duplicates')).body;

before(async () => {
  await h.startServer();
  manager = await h.createUser('sales_manager');
  otherManager = await h.createUser('sales_manager');
  s1 = await h.createUser('salesperson');
  s2 = await h.createUser('salesperson');
});
after(() => h.stopServer());

test('a lead with the same phone goes to the bucket, skips round robin, and alerts the salesperson', async () => {
  const original = await newLead(s1, { name: 'Maria Lopez', phone: '(602) 555-8841', email: 'maria@example.com' });
  assert.strictEqual(original.sales1Id, s1.id);
  await as(manager, 'PUT', '/rotations', { sales: { enabled: true, memberIds: [s2.id] } });

  const dup = await newLead(manager, { name: 'M Lopez', phone: '602.555.8841' });
  assert.strictEqual(dup.duplicate.status, 'suspected');
  assert.strictEqual(dup.duplicate.ofId, original.id);
  assert.deepStrictEqual(dup.duplicate.reasons, ['Same phone']);
  assert.strictEqual(dup.sales1Id, null, 'held out of round robin');

  const b = await bucket();
  assert.strictEqual(b.items.length, 1);
  assert.strictEqual(b.items[0].original.id, original.id);
  const alerts = (await as(s1, 'GET', '/alerts')).body;
  assert.ok(alerts.some(a => a.type === 'lead_came_back' && /Maria Lopez/.test(a.title)));
  assert.ok((await as(otherManager, 'GET', '/alerts')).body.some(a => a.type === 'duplicate_found'), 'managers hear one is waiting');

  // A different person goes out by round robin as usual.
  const other = await newLead(manager, { name: 'Someone Else', phone: '555-999-0000' });
  assert.strictEqual(other.duplicate, undefined);
  assert.strictEqual(other.sales1Id, s2.id);
});

test('not a duplicate: back with the other customers and assigned by round robin', async () => {
  const [item] = (await bucket()).items;
  assert.strictEqual((await as(s1, 'POST', `/duplicates/${item.lead.id}/not-duplicate`)).status, 403, 'managers only');
  const r = await as(manager, 'POST', `/duplicates/${item.lead.id}/not-duplicate`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.duplicate, undefined);
  assert.strictEqual(r.body.sales1Id, s2.id);
  assert.strictEqual((await bucket()).items.length, 0);
});

test('anyone can mark a duplicate; a manager merges it and everything moves over', async () => {
  const keep = await newLead(s1, { name: 'Tom Nguyen', email: 'tom@example.com' });
  const dup = await newLead(s2, { name: 'Tommy Nguyen', phone: '555-777-1212', notes: 'Wants a truck' });
  await as(s2, 'POST', `/leads/${dup.id}/activities`, { type: 'call', text: 'Left a voicemail' });
  const deal = (await as(s2, 'POST', '/deals', { leadId: dup.id, customerName: 'Tommy Nguyen' })).body;

  assert.strictEqual((await as(s2, 'POST', `/leads/${dup.id}/duplicate`, { ofId: dup.id })).status, 400, 'not itself');
  const marked = await as(s2, 'POST', `/leads/${dup.id}/duplicate`, { ofId: keep.id, note: 'Same guy' });
  assert.strictEqual(marked.status, 200);
  assert.strictEqual(marked.body.duplicate.status, 'marked');
  assert.strictEqual((await as(s2, 'POST', `/leads/${keep.id}/duplicate`, { ofId: dup.id })).status, 400, 'no loops');

  // Salespeople can't merge.
  assert.strictEqual((await as(s2, 'POST', `/duplicates/${dup.id}/merge`)).status, 403);
  const m = await as(manager, 'POST', `/duplicates/${dup.id}/merge`);
  assert.strictEqual(m.status, 200);
  const kept = m.body.lead;
  assert.strictEqual(kept.id, keep.id);
  assert.strictEqual(kept.phone, '555-777-1212', 'missing phone filled in');
  assert.strictEqual(kept.email, 'tom@example.com', 'existing details kept');
  assert.match(kept.notes, /Wants a truck/);
  assert.ok(kept.activities.some(a => a.text === 'Left a voicemail'), 'history moved');
  assert.match(kept.activities[0].text, /^Merged duplicate/);
  assert.strictEqual((await as(manager, 'GET', `/leads`)).body.some(l => l.id === dup.id), false, 'duplicate removed');
  const movedDeal = (await as(manager, 'GET', '/deals')).body.find(d => d.id === deal.id);
  assert.strictEqual(movedDeal.leadId, keep.id, 'deal moved to the kept customer');
});

test('whoever marked it can undo; the rules; checking every customer', async () => {
  const a = await newLead(s1, { name: 'Ann Park' });
  const b = await newLead(s1, { name: 'Ann Park' });
  assert.strictEqual(b.duplicate, undefined, 'names are not checked by default');
  await as(s1, 'POST', `/leads/${b.id}/duplicate`, { ofId: a.id });
  assert.strictEqual((await as(s2, 'DELETE', `/leads/${b.id}/duplicate`)).status, 403, 'someone else cannot undo it');
  assert.strictEqual((await as(s1, 'DELETE', `/leads/${b.id}/duplicate`)).status, 200);

  assert.strictEqual((await as(s1, 'PUT', '/duplicates/rules', { name: true })).status, 403);
  const rules = (await as(manager, 'PUT', '/duplicates/rules', { name: true, lookbackDays: 30 })).body;
  assert.deepStrictEqual([rules.phone, rules.email, rules.name, rules.lookbackDays], [true, true, true, 30]);

  const c = await newLead(s1, { name: 'ann  PARK' });
  assert.deepStrictEqual(c.duplicate.reasons, ['Same name']);
  assert.strictEqual(c.duplicate.ofId, a.id, 'matched to the oldest one');

  // The scan: b was cleared as "not a duplicate" of a, so only c is waiting.
  const scan = (await as(manager, 'POST', '/duplicates/scan')).body;
  assert.strictEqual(scan.found, 0, 'nothing new');
  const waiting = (await bucket()).items.map(x => x.lead.id);
  assert.deepStrictEqual(waiting, [c.id]);
});
