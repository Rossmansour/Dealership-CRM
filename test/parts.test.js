// Tests for the Parts module: the shelf (on hand, weighted average cost,
// committed/available), receiving and count adjustments, parts used on a
// repair order coming off the shelf when it closes, counter tickets (tax
// on retail only), the reorder list, special orders, who can do what, and
// counter sales on the fixed-ops dashboard.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('parts tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, partsMgr, advisor, tech, sales;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
let filter, lead;

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  partsMgr = await h.createUser('parts_manager');
  advisor = await h.createUser('service_advisor');
  tech = await h.createUser('technician');
  sales = await h.createUser('salesperson');
  await as(admin, 'PUT', '/settings', { taxRate: 8 });
  lead = (await as(sales, 'POST', '/leads', { name: 'Pat Parts', phone: '555-4000' })).body;
});
after(() => h.stopServer());

test('setting up a part, and who can see and change parts', async () => {
  assert.strictEqual((await as(sales, 'POST', '/parts', { number: 'x' })).status, 403);
  assert.strictEqual((await as(advisor, 'POST', '/parts', { number: 'x' })).status, 403);
  const made = await as(partsMgr, 'POST', '/parts', { number: 'fl-820s', description: 'Oil filter', bin: 'A1', cost: 20, price: 40, onHand: 10, reorderPoint: 3, reorderQty: 6 });
  assert.strictEqual(made.status, 201);
  filter = made.body;
  assert.strictEqual(filter.number, 'FL-820S');
  assert.strictEqual(filter.onHand, 10);
  assert.strictEqual((await as(partsMgr, 'POST', '/parts', { number: 'FL-820S' })).status, 400, 'no duplicate part numbers');
  assert.strictEqual((await as(sales, 'GET', '/parts')).status, 403);
  const techView = (await as(tech, 'GET', '/parts')).body[0];
  assert.strictEqual(techView.cost, undefined, "techs don't see cost");
  assert.strictEqual(techView.price, 40);
});

test('receiving averages the cost; adjustments need a reason', async () => {
  const r = await as(partsMgr, 'POST', `/parts/${filter.id}/receive`, { qty: 10, cost: 30, invoice: 'INV-77' });
  assert.strictEqual(r.body.onHand, 20);
  assert.strictEqual(r.body.cost, 25, '(10 x 20 + 10 x 30) / 20');
  assert.strictEqual((await as(partsMgr, 'POST', `/parts/${filter.id}/adjust`, { count: 18 })).status, 400);
  const adj = await as(partsMgr, 'POST', `/parts/${filter.id}/adjust`, { count: 18, reason: 'Cycle count' });
  assert.strictEqual(adj.body.onHand, 18);
  const detail = (await as(partsMgr, 'GET', `/parts/${filter.id}`)).body;
  assert.deepStrictEqual(detail.moves.map(m => [m.type, m.qty]), [['adjust', -2], ['receive', 10], ['receive', 10]]);
});

test('parts on a repair order are committed, then come off the shelf when it closes', async () => {
  const ro = (await as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2020', make: 'Ford', model: 'Escape' },
    jobs: [{ concern: 'Oil change', hours: 0.5, parts: [{ partId: filter.id, number: 'FL-820S', description: 'Oil filter', qty: 4, cost: 25, price: 40 }] }] })).body;
  let p = (await as(partsMgr, 'GET', `/parts/${filter.id}`)).body;
  assert.deepStrictEqual([p.onHand, p.committed, p.available], [18, 4, 14]);
  await as(advisor, 'POST', `/service/ros/${ro.id}/close`);
  p = (await as(partsMgr, 'GET', `/parts/${filter.id}`)).body;
  assert.deepStrictEqual([p.onHand, p.committed, p.available], [14, 0, 14]);
  assert.strictEqual(p.moves[0].type, 'ro');
  assert.strictEqual(p.moves[0].ref, `RO-${ro.roNumber}`);
});

test('counter tickets: tax on retail only; closing takes stock', async () => {
  const retail = await as(partsMgr, 'POST', '/parts/tickets', { leadId: lead.id, saleType: 'retail', lines: [{ partId: filter.id, qty: 2, cost: 25, price: 40 }] });
  assert.strictEqual(retail.status, 201);
  assert.ok(retail.body.ticketNumber >= 1001);
  assert.deepStrictEqual([retail.body.totals.sale, retail.body.totals.tax, retail.body.totals.total], [80, 6.4, 86.4]);
  assert.strictEqual(retail.body.lines[0].number, 'FL-820S', 'filled in from the shelf');
  const wholesale = (await as(partsMgr, 'POST', '/parts/tickets', { customerName: 'Joe\'s Garage', saleType: 'wholesale', lines: [{ partId: filter.id, qty: 1, cost: 25, price: 32 }] })).body;
  assert.strictEqual(wholesale.totals.tax, 0);
  assert.strictEqual((await as(partsMgr, 'POST', '/parts/tickets', { lines: [] })).status, 400, 'needs a customer or a name');
  const closed = await as(partsMgr, 'POST', `/parts/tickets/${retail.body.id}/close`);
  assert.strictEqual(closed.body.status, 'closed');
  await as(partsMgr, 'POST', `/parts/tickets/${wholesale.id}/void`, { reason: 'Changed mind' });
  const p = (await as(partsMgr, 'GET', `/parts/${filter.id}`)).body;
  assert.strictEqual(p.onHand, 12, 'the voided ticket took nothing');
  assert.strictEqual((await as(partsMgr, 'PUT', `/parts/tickets/${retail.body.id}`, { notes: 'x' })).status, 400, 'closed tickets are locked');
});

test('reorder list', async () => {
  await as(partsMgr, 'PUT', `/parts/${filter.id}`, { reorderPoint: 12, reorderQty: 6 });
  const list = (await as(partsMgr, 'GET', '/parts/reorder')).body;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].suggestedQty, 6);
  assert.strictEqual((await as(advisor, 'GET', '/parts/reorder')).status, 403);
});

test('special orders: service requests, parts orders and receives into stock', async () => {
  const o = await as(advisor, 'POST', '/parts/special-orders', { number: 'bumper-99', description: 'Rear bumper cover', qty: 1, leadId: lead.id, cost: 180, price: 320 });
  assert.strictEqual(o.status, 201);
  assert.strictEqual(o.body.customerName, 'Pat Parts');
  assert.strictEqual((await as(sales, 'POST', '/parts/special-orders', { number: 'x' })).status, 403);
  assert.strictEqual((await as(advisor, 'PUT', `/parts/special-orders/${o.body.id}`, { status: 'ordered' })).status, 403);
  const ordered = await as(partsMgr, 'PUT', `/parts/special-orders/${o.body.id}`, { status: 'ordered', vendor: 'Ford Parts', poNumber: 'PO-1' });
  assert.strictEqual(ordered.body.status, 'ordered');
  const got = await as(partsMgr, 'POST', `/parts/special-orders/${o.body.id}/receive`, { cost: 175 });
  assert.strictEqual(got.body.status, 'received');
  const part = (await as(partsMgr, 'GET', '/parts')).body.find(p => p.number === 'BUMPER-99');
  assert.ok(part, 'a new part was set up');
  assert.deepStrictEqual([part.onHand, part.cost, part.bin], [1, 175, 'SPECIAL ORDER']);
  assert.strictEqual((await as(partsMgr, 'POST', `/parts/special-orders/${o.body.id}/receive`)).status, 400, 'only once');
});

test('counter sales count as parts gross on the dashboard', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const m = (await as(admin, 'GET', `/dashboard/fixed?month=${month}`)).body.mtd;
  assert.strictEqual(m.tickets, 1);
  assert.strictEqual(m.counterSale, 80);
  assert.strictEqual(m.partsSale, 160 + 80, 'RO parts 4 x 40 plus the counter ticket');
  assert.strictEqual(m.partsGross, (160 - 100) + (80 - 50));
});
