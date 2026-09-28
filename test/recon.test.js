// Tests for Recon: starting a car, moving it through steps to the front
// line (with time in each step), work items with estimates, manager
// approval, sending mechanical work to service as an internal RO, outside
// work posting its cost to the car, notes, steps & goals, and who can do what.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('recon tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, advisor, tech, sales, car, unit;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const carNow = async () => (await as(manager, 'GET', '/cars')).body.find(c => c.id === car.id);

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  advisor = await h.createUser('service_advisor');
  tech = await h.createUser('technician');
  sales = await h.createUser('salesperson');
  car = (await as(manager, 'POST', '/cars', { year: 2019, make: 'Honda', model: 'Accord', price: 21000, cost: 17000, mileage: 52000, stockType: 'used', stockNumber: 'U100' })).body;
});
after(() => h.stopServer());

test('sales managers and service see the board and start recon; salespeople do not', async () => {
  assert.strictEqual((await as(sales, 'GET', '/recon/board')).status, 403);
  const board = (await as(advisor, 'GET', '/recon/board')).body;
  assert.ok(board.notStarted.some(c => c.id === car.id), 'a used car in stock waits to start');
  assert.strictEqual(board.settings.steps[0].label, 'New - Import');
  assert.strictEqual((await as(sales, 'POST', '/recon/units', { carId: car.id })).status, 403);
  const made = await as(tech, 'POST', '/recon/units', { carId: car.id });
  assert.strictEqual(made.status, 201);
  unit = made.body;
  assert.deepStrictEqual([unit.step, unit.status, unit.car.stockNumber, unit.car.stockType], ['purchase_trade', 'active', 'U100', 'used'], 'used cars start at Purchase / Trade');
  assert.strictEqual((await as(tech, 'POST', '/recon/units', { carId: car.id })).status, 400, 'only once at a time');
  assert.ok(!(await as(manager, 'GET', '/recon/board')).body.notStarted.some(c => c.id === car.id));
});

test('work items: estimates, manager approval, and outside work posts to the car', async () => {
  let u = (await as(tech, 'POST', `/recon/units/${unit.id}/items`, { category: 'mechanical', description: 'Front brakes', estimate: 300 })).body;
  const brakes = u.items[0];
  assert.strictEqual(brakes.status, 'proposed');
  assert.strictEqual(u.needsApproval, 1);
  assert.strictEqual((await as(tech, 'PUT', `/recon/units/${unit.id}/items/${brakes.id}`, { status: 'approved' })).status, 403, 'managers approve');
  u = (await as(manager, 'PUT', `/recon/units/${unit.id}/items/${brakes.id}`, { status: 'approved' })).body;
  assert.strictEqual(u.items[0].status, 'approved');
  u = (await as(manager, 'POST', `/recon/units/${unit.id}/items`, { category: 'glass', description: 'Windshield', estimate: 400, vendor: 'Safelite', approve: true })).body;
  const glass = u.items[1];
  assert.strictEqual(glass.status, 'approved', "a manager's own item is approved right away");
  u = (await as(tech, 'PUT', `/recon/units/${unit.id}/items/${glass.id}`, { status: 'done', actual: 380 })).body;
  assert.strictEqual(u.spent, 380);
  assert.strictEqual((await carNow()).cost, 17000 + 380, 'outside work is added to the car right away');
  await as(tech, 'PUT', `/recon/units/${unit.id}/items/${glass.id}`, { status: 'done', actual: 999 });
  assert.strictEqual((await carNow()).cost, 17000 + 380, 'marking it done again charges nothing');
});

test('mechanical work goes to service as an internal RO; its cost arrives when the RO closes', async () => {
  assert.strictEqual((await as(tech, 'POST', `/recon/units/${unit.id}/send-to-service`)).status, 403, 'an advisor opens the RO');
  const u = (await as(advisor, 'POST', `/recon/units/${unit.id}/send-to-service`)).body;
  const brakes = u.items[0];
  assert.ok(brakes.roNumber);
  const ro = (await as(advisor, 'GET', `/service/ros/${brakes.roId}`)).body;
  assert.strictEqual(ro.carId, car.id);
  assert.strictEqual(ro.jobs[0].payType, 'internal');
  assert.strictEqual(ro.jobs[0].concern, 'Recon: Front brakes');
  const job = { ...ro.jobs[0], hours: 2, rate: 90, parts: [{ description: 'Pads', qty: 1, cost: 40, price: 60 }] };
  await as(advisor, 'PUT', `/service/ros/${ro.id}`, { jobs: [job] });
  await as(advisor, 'POST', `/service/ros/${ro.id}/close`);
  const board = (await as(manager, 'GET', '/recon/board')).body;
  const mine = board.units.find(x => x.id === unit.id);
  assert.strictEqual(mine.items[0].status, 'done');
  assert.strictEqual(mine.items[0].actual, 240);
  assert.strictEqual(mine.spent, 380 + 240);
  assert.strictEqual((await carNow()).cost, 17000 + 380 + 240);
});

test('moving through steps to the front line, with a note, and reopening', async () => {
  await as(tech, 'POST', `/recon/units/${unit.id}/notes`, { text: 'Small door ding, leave it' });
  await as(tech, 'POST', `/recon/units/${unit.id}/move`, { step: 'repair' });
  assert.strictEqual((await as(tech, 'POST', `/recon/units/${unit.id}/move`, { step: 'nowhere' })).status, 400);
  const done = (await as(tech, 'POST', `/recon/units/${unit.id}/move`, { step: 'ready' })).body;
  assert.strictEqual(done.status, 'done');
  assert.deepStrictEqual(done.history.map(x => x.step), ['purchase_trade', 'repair', 'ready']);
  assert.ok(done.history.every(x => x.leftAt), 'every step has an end time');
  assert.strictEqual(done.notes[0].text, 'Small door ding, leave it');
  assert.ok((await carNow()).frontLineAt);
  const back = (await as(tech, 'POST', `/recon/units/${unit.id}/reopen`, { step: 'detail_ready' })).body;
  assert.deepStrictEqual([back.status, back.step], ['active', 'detail_ready']);
});

test('new cars go through recon too, starting at a "new" step; wholesale is a way out', async () => {
  const fresh = (await as(manager, 'POST', '/cars', { year: 2025, make: 'Ford', model: 'Escape', price: 32000, cost: 29000, mileage: 10, stockType: 'new' })).body;
  const board = (await as(manager, 'GET', '/recon/board')).body;
  assert.strictEqual(board.notStarted.find(c => c.id === fresh.id).stockType, 'new');
  const u = (await as(manager, 'POST', '/recon/units', { carId: fresh.id })).body;
  assert.strictEqual(u.step, 'new_import');
  const out = (await as(manager, 'POST', `/recon/units/${u.id}/move`, { step: 'wholesale' })).body;
  assert.deepStrictEqual([out.status, out.removedReason], ['removed', 'Wholesale']);
  assert.ok((await as(manager, 'GET', '/recon/board')).body.units.some(x => x.id === u.id && x.step === 'wholesale'), 'shows under Wholesale');
});

test('work items like the shop uses them: pick from the list, price parts and labor, bulk status, store fields', async () => {
  const c = (await as(manager, 'POST', '/cars', { year: 2020, make: 'Audi', model: 'Q5', price: 30000, cost: 25000, mileage: 40000, stockType: 'used' })).body;
  let u = (await as(advisor, 'POST', '/recon/units', { carId: c.id })).body;
  const board = (await as(advisor, 'GET', '/recon/board')).body;
  assert.ok(board.settings.catalog.mechanical.includes('Oil Change'), 'a list of work items by phase');
  u = (await as(advisor, 'POST', `/recon/units/${u.id}/items/bulk`, { items: [{ description: 'Oil Change', category: 'mechanical' }, { description: 'Used Car Detail', category: 'detail' }, { description: 'PDR (Dent Repair)', category: 'cosmetic' }] })).body;
  assert.strictEqual(u.items.length, 3);
  u = (await as(advisor, 'POST', `/recon/units/${u.id}/items/bulk`, { items: [{ description: 'oil change', category: 'mechanical' }] }));
  assert.strictEqual(u.status, 400, 'items already on the car are skipped');
  let unitNow = (await as(advisor, 'GET', '/recon/board')).body.units.find(x => x.car.id === c.id);
  const oil = unitNow.items[0];
  unitNow = (await as(advisor, 'PUT', `/recon/units/${unitNow.id}/items/${oil.id}`, { partsPrice: 60, laborHours: 0.5, laborRate: 100, info: 'Synthetic', onlineDescription: 'Fresh oil change' })).body;
  assert.strictEqual(unitNow.items[0].estimate, 110, 'parts + hours x rate');
  assert.strictEqual(unitNow.items[0].info, 'Synthetic');
  assert.strictEqual((await as(advisor, 'POST', `/recon/units/${unitNow.id}/items/status`, { ids: unitNow.items.map(i => i.id), status: 'approved' })).status, 403, 'managers approve');
  unitNow = (await as(manager, 'POST', `/recon/units/${unitNow.id}/items/status`, { ids: unitNow.items.slice(0, 2).map(i => i.id), status: 'approved' })).body;
  assert.deepStrictEqual(unitNow.items.map(i => i.status), ['approved', 'approved', 'proposed']);
  unitNow = (await as(advisor, 'DELETE', `/recon/units/${unitNow.id}/items/${unitNow.items[2].id}`)).body;
  assert.strictEqual(unitNow.items.length, 2);
  const sent = (await as(advisor, 'POST', `/recon/units/${unitNow.id}/send-to-service`)).body;
  const ro = (await as(advisor, 'GET', `/service/ros/${sent.items[0].roId}`)).body;
  assert.deepStrictEqual([ro.jobs[0].hours, ro.jobs[0].rate, ro.jobs[0].parts[0].price], [0.5, 100, 60], 'the RO gets the hours, rate, and parts');
  unitNow = (await as(advisor, 'PUT', `/recon/units/${unitNow.id}/info`, { fields: { other1: 'Lot B' }, inspectionDate: '2031-01-02T10:00:00Z', inspectionRo: '1690006' })).body;
  assert.deepStrictEqual([unitNow.fields.other1, unitNow.inspectionRo], ['Lot B', '1690006']);
});

test('every car that finished recon stays on the board, however long ago', async () => {
  const old = (await as(manager, 'POST', '/cars', { year: 2017, make: 'Kia', model: 'Soul', price: 12000, cost: 9000, mileage: 80000, stockType: 'used' })).body;
  const u = (await as(manager, 'POST', '/recon/units', { carId: old.id })).body;
  await as(manager, 'POST', `/recon/units/${u.id}/move`, { step: 'ready' });
  await h.store.pool.query(`UPDATE recon_units SET data = jsonb_set(data, '{doneAt}', to_jsonb('2020-01-01T00:00:00Z'::text)) WHERE id = $1`, [u.id]);
  const board = (await as(manager, 'GET', '/recon/board')).body;
  assert.ok(board.units.some(x => x.id === u.id && x.status === 'done'), 'a car finished years ago still shows under Frontline Ready');
});

test('steps and goals are the managers\' to set', async () => {
  assert.strictEqual((await as(tech, 'PUT', '/recon/settings', { goalDays: 3 })).status, 403);
  const s = (await as(manager, 'PUT', '/recon/settings', { goalDays: 4, steps: [{ label: 'Inspection', goalHours: 12 }, { label: 'Detail', goalHours: 24 }] })).body;
  assert.strictEqual(s.goalDays, 4);
  assert.deepStrictEqual(s.steps.map(x => x.key), ['inspection', 'detail']);
  assert.strictEqual((await as(manager, 'PUT', '/recon/settings', { steps: [] })).status, 400);
  const reset = (await as(manager, 'PUT', '/recon/settings', { reset: true })).body;
  assert.strictEqual(reset.steps.length, 19);
  assert.strictEqual(reset.steps[0].label, 'New - Import');
  // A store still on the very first step list is moved to the current steps.
  await h.store.pool.query(`UPDATE dealerships SET settings = settings || '{"recon":{"goalDays":5,"steps":[{"key":"inspect","label":"Check-in","goalHours":24},{"key":"detail","label":"Detail","goalHours":24}]}}'::jsonb`);
  assert.strictEqual((await as(manager, 'GET', '/recon/settings')).body.steps[0].label, 'New - Import');
  // Saving all the steps keeps all of them (an earlier version cut the list at 12).
  const all = (await as(manager, 'PUT', '/recon/settings', { steps: reset.steps })).body;
  assert.deepStrictEqual(all.steps.slice(-3).map(x => x.label), ['Repair', 'Offsite Sublet', 'Vendor']);
});
