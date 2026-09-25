// Tests for the round robin: separate Sales 1 and BDC 1 rotations on the
// same lead, skipping people who aren't taking leads, lead-source rules,
// who can change it, and the BDC Agent role.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('round robin tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, s1, s2, s3, b1, b2;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const newLead = async (by, body = {}) => (await as(by, 'POST', '/leads', { name: 'Rotation Lead', source: 'website', ...body })).body;

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  s1 = await h.createUser('salesperson');
  s2 = await h.createUser('salesperson');
  s3 = await h.createUser('salesperson');
  b1 = await h.createUser('bdc');
  b2 = await h.createUser('bdc');
});
after(() => h.stopServer());

test('off by default: nothing is assigned automatically', async () => {
  const l = await newLead(manager);
  assert.deepStrictEqual([l.sales1Id, l.bdc1Id], [null, null]);
});

test('each new lead gets both a salesperson and a BDC agent, taking turns', async () => {
  const saved = (await as(manager, 'PUT', '/rotations', {
    sales: { enabled: true, memberIds: [s1.id, s2.id, s3.id, 'not-a-user'] },
    bdc: { enabled: true, memberIds: [b1.id, b2.id] }
  })).body;
  assert.deepStrictEqual(saved.sales.memberIds, [s1.id, s2.id, s3.id], 'unknown people are dropped');

  const picks = [];
  for (let i = 0; i < 4; i++) {
    const l = await newLead(manager);
    picks.push([l.sales1Id, l.bdc1Id]);
    if (i === 0) {
      assert.match(l.activities[0].text, /Assigned by round robin -- Sales 1: Test salesperson \d+, BDC 1: Test bdc \d+/);
    }
  }
  assert.deepStrictEqual(picks, [[s1.id, b1.id], [s2.id, b2.id], [s3.id, b1.id], [s1.id, b2.id]]);
  // Both people are alerted
  const alertsFor = async u => (await as(u, 'GET', '/alerts')).body.filter(a => a.type === 'lead_assigned');
  assert.ok((await alertsFor(s1)).length >= 2);
  assert.ok((await alertsFor(b2)).length >= 2);
  const r = (await as(s1, 'GET', '/rotations')).body;
  assert.strictEqual(r.rotations.sales.nextUpId, s2.id, 'anyone can see who is next');
  assert.strictEqual(r.rotations.bdc.nextUpId, b1.id);
});

test("people who aren't taking leads are skipped, and come back in turn", async () => {
  await as(s2, 'PUT', '/availability', { available: false });
  const staff = (await as(s1, 'GET', '/staff')).body;
  assert.strictEqual(staff.find(u => u.id === s2.id).available, false);
  const l = await newLead(manager);
  assert.strictEqual(l.sales1Id, s3.id, 's2 is skipped');
  assert.strictEqual((await as(s1, 'PUT', '/availability', { userId: s2.id, available: true })).status, 403, "can't change someone else's");
  await as(manager, 'PUT', '/availability', { userId: s2.id, available: true });
  assert.strictEqual((await newLead(manager)).sales1Id, s1.id);
  assert.strictEqual((await newLead(manager)).sales1Id, s2.id);

  await as(manager, 'PUT', '/availability', { userId: b1.id, available: false });
  await as(manager, 'PUT', '/availability', { userId: b2.id, available: false });
  const none = await newLead(manager);
  assert.strictEqual(none.bdc1Id, null, 'nobody available: left for a manager to assign');
  assert.ok(none.sales1Id, 'the sales rotation still runs');
  await as(manager, 'PUT', '/availability', { userId: b1.id, available: true });
  await as(manager, 'PUT', '/availability', { userId: b2.id, available: true });
});

test("the rotation doesn't overwrite a chosen person, and walk-ins keep their salesperson", async () => {
  const chosen = await newLead(manager, { sales1Id: s3.id });
  assert.strictEqual(chosen.sales1Id, s3.id);
  assert.ok(chosen.bdc1Id, 'BDC still filled');
  const walkIn = await newLead(s1, { source: 'walk-in' });
  assert.strictEqual(walkIn.sales1Id, s1.id, 'the salesperson who added them');
  const byBdc = await newLead(b2);
  assert.strictEqual(byBdc.bdc1Id, b2.id, 'a BDC agent adding a lead is their BDC 1');
});

test('each rotation can be limited to certain lead sources', async () => {
  await as(manager, 'PUT', '/rotations', {
    sales: { enabled: true, memberIds: [s1.id, s2.id, s3.id] },
    bdc: { enabled: true, memberIds: [b1.id, b2.id], sources: ['website', 'cargurus'] }
  });
  const phone = await newLead(manager, { source: 'phone' });
  assert.ok(phone.sales1Id);
  assert.strictEqual(phone.bdc1Id, null, 'phone leads skip the BDC rotation here');
  const web = await newLead(manager, { source: 'cargurus' });
  assert.ok(web.bdc1Id);
});

test('only managers and admins change the rotation; changes are logged; BDC is a role', async () => {
  assert.strictEqual((await as(s1, 'PUT', '/rotations', { sales: { enabled: false } })).status, 403);
  assert.strictEqual((await as(b1, 'PUT', '/rotations', { sales: { enabled: false } })).status, 403);
  await as(admin, 'PUT', '/rotations', { sales: { enabled: false, memberIds: [s1.id] } });
  assert.strictEqual((await newLead(manager, { source: 'phone' })).sales1Id, null);
  const withRotations = (await as(admin, 'PUT', '/settings', { rotations: { sales: { enabled: true } } })).body;
  assert.strictEqual(withRotations.rotations.sales.enabled, false, 'settings saves cannot change the rotation');
  const log = (await as(admin, 'GET', '/audit-log?entityType=settings')).body.entries;
  assert.ok(log.some(e => e.label === 'Fee defaults' || e.details === 'Round robin'));
  const me = (await as(b1, 'GET', '/auth/me')).body;
  assert.deepStrictEqual([me.role, me.roleLabel, me.available], ['bdc', 'BDC Agent', true]);
  assert.ok(!me.permissions.includes('viewAllReports'));
});

test('two leads at the same moment go to different people', async () => {
  await as(manager, 'PUT', '/rotations', { sales: { enabled: true, memberIds: [s1.id, s2.id] }, bdc: { enabled: false, memberIds: [] } });
  const [a, b] = await Promise.all([newLead(manager, { source: 'phone' }), newLead(manager, { source: 'phone' })]);
  assert.notStrictEqual(a.sales1Id, b.sales1Id);
});
