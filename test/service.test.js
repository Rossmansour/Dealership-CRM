// Tests for the Service module: repair orders and their money (labor,
// parts, shop supplies, tax), who can do what, technician clock-in/out and
// pay (flat rate vs hourly), closing, recon cost flowing to the car, the
// customer's vehicle history, appointments, and the fixed-ops dashboard.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('service tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const service = require('../service');

let admin, manager, advisor, tech, tech2, sales, serviceManager;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
let lead;

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  serviceManager = await h.createUser('service_manager');
  advisor = await h.createUser('service_advisor');
  tech = await h.createUser('technician');
  tech2 = await h.createUser('technician');
  sales = await h.createUser('salesperson');
  await as(admin, 'PUT', '/settings', { taxRate: 8 });
  await as(serviceManager, 'PUT', '/service/settings', { customerLaborRate: 150, internalLaborRate: 90, shopSuppliesPct: 10, shopSuppliesCap: 50, taxParts: true, taxLabor: false });
  await as(serviceManager, 'PUT', `/service/techs/${tech.id}/pay`, { type: 'flat', rate: 30 });
  await as(serviceManager, 'PUT', `/service/techs/${tech2.id}/pay`, { type: 'hourly', rate: 25 });
  lead = (await as(sales, 'POST', '/leads', { name: 'Sam Service', phone: '555-2000' })).body;
});
after(() => h.stopServer());

test('RO money: labor, parts, shop supplies (capped), tax on parts only', () => {
  const ro = { jobs: [
    { payType: 'customer', hours: 2, rate: 150, parts: [{ qty: 1, cost: 40, price: 100 }] },
    { payType: 'warranty', hours: 1, rate: 120, parts: [] }
  ] };
  const t = service.totals(ro, { taxRate: 8, service: { shopSuppliesPct: 10, shopSuppliesCap: 50, taxParts: true, taxLabor: false } });
  assert.strictEqual(t.customer.labor, 300);
  assert.strictEqual(t.shopSupplies, 30);
  assert.strictEqual(t.tax, 10.4, '8% of parts 100 + supplies 30');
  assert.strictEqual(t.customerTotal, 440.4);
  assert.strictEqual(t.warrantyTotal, 120);
  const capped = service.totals({ jobs: [{ payType: 'customer', hours: 10, rate: 150, parts: [] }] }, { taxRate: 8, service: { shopSuppliesPct: 10, shopSuppliesCap: 50 } });
  assert.strictEqual(capped.shopSupplies, 50);
  const laborTaxed = service.totals({ jobs: [{ payType: 'customer', hours: 1, rate: 100, parts: [] }] }, { taxRate: 10, service: { taxLabor: true } });
  assert.strictEqual(laborTaxed.tax, 10);
});

test('who can write ROs', async () => {
  const body = { leadId: lead.id, vehicle: { vin: '1hgcm82633a004352', year: '2019', make: 'Honda', model: 'Civic', mileageIn: 42000 }, jobs: [{ concern: 'Oil change' }] };
  assert.strictEqual((await as(sales, 'POST', '/service/ros', body)).status, 403);
  assert.strictEqual((await as(tech, 'POST', '/service/ros', body)).status, 403);
  assert.strictEqual((await as(sales, 'GET', '/service/ros')).status, 403);
  const made = await as(advisor, 'POST', '/service/ros', body);
  assert.strictEqual(made.status, 201);
  assert.ok(made.body.roNumber >= 5001);
  assert.strictEqual(made.body.vehicle.vin, '1HGCM82633A004352');
  assert.strictEqual(made.body.customerName, 'Sam Service');
  assert.strictEqual(made.body.jobs[0].rate, 150, 'customer jobs start at the customer labor rate');
  assert.strictEqual((await as(advisor, 'POST', '/service/ros', { jobs: [{}] })).status, 400, 'needs a customer or an inventory car');
});

test('technician clock in/out, flat vs hourly pay, closing locks totals', async () => {
  const ro = (await as(advisor, 'POST', '/service/ros', {
    leadId: lead.id, vehicle: { vin: 'JT2BF22K1Y0123456', year: '2020', make: 'Toyota', model: 'Camry' },
    jobs: [
      { concern: 'Brakes', payType: 'customer', hours: 2, techId: tech.id, parts: [{ description: 'Pads', qty: 1, cost: 40, price: 100 }] },
      { concern: 'Noise', payType: 'customer', hours: 1, techId: tech2.id }
    ]
  })).body;
  const [brakes, noise] = ro.jobs;
  assert.strictEqual((await as(tech, 'POST', `/service/ros/${ro.id}/jobs/${noise.id}/clock`, { action: 'in' })).status, 403, "can't clock someone else's job");
  const inRes = await as(tech, 'POST', `/service/ros/${ro.id}/jobs/${brakes.id}/clock`, { action: 'in' });
  assert.strictEqual(inRes.status, 200);
  assert.strictEqual(inRes.body.status, 'in_progress');
  assert.strictEqual(inRes.body.jobs[0].clockedIn, true);
  assert.strictEqual(inRes.body.totals.laborCost, undefined, "techs don't see labor cost");
  // Pretend tech2 worked 2 clocked hours on the noise job (hourly pay).
  await h.store.pool.query(
    `UPDATE repair_orders SET data = jsonb_set(data, '{jobs,1,punches}', $2::jsonb) WHERE id = $1`,
    [ro.id, JSON.stringify([{ techId: tech2.id, start: '2030-01-01T10:00:00Z', end: '2030-01-01T12:00:00Z' }])]
  );
  const outRes = await as(tech, 'POST', `/service/ros/${ro.id}/jobs/${brakes.id}/clock`, { action: 'out', done: true });
  assert.strictEqual(outRes.body.jobs[0].status, 'done');
  assert.strictEqual((await as(tech, 'PUT', `/service/ros/${ro.id}/jobs/${brakes.id}/tech`, { cause: 'Worn pads', correction: 'Replaced front pads' })).status, 200);
  assert.strictEqual((await as(advisor, 'POST', `/service/ros/${ro.id}/void`)).status, 400, 'time on it: close, not void');
  const closed = await as(advisor, 'POST', `/service/ros/${ro.id}/close`, { mileageOut: 51000 });
  assert.strictEqual(closed.status, 200);
  assert.strictEqual(closed.body.status, 'closed');
  const t = closed.body.closedTotals;
  assert.strictEqual(t.laborSale, 450);
  assert.strictEqual(t.laborCost, 2 * 30 + 2 * 25, 'flat: 2 sold hours x $30; hourly: 2 clocked hours x $25');
  assert.strictEqual(t.partsSale, 100);
  assert.strictEqual(closed.body.jobs[0].correction, 'Replaced front pads');
  assert.strictEqual((await as(advisor, 'PUT', `/service/ros/${ro.id}`, { notes: 'late edit' })).status, 400, 'closed ROs are locked');
});

test('internal recon RO adds its cost to the car', async () => {
  const car = (await as(manager, 'POST', '/cars', { year: 2018, make: 'Ford', model: 'F-150', price: 26000, cost: 20000, mileage: 60000, vin: '1FTFW1EF5JFA00001' })).body;
  const ro = (await as(advisor, 'POST', '/service/ros', { carId: car.id, jobs: [{ concern: 'Recon: tires + detail', hours: 2, parts: [{ description: 'Tires', qty: 4, cost: 100, price: 100 }] }] })).body;
  assert.strictEqual(ro.jobs[0].payType, 'internal');
  assert.strictEqual(ro.jobs[0].rate, 90);
  assert.strictEqual(ro.vehicle.make, 'Ford', 'filled in from the car');
  let saved = (await as(manager, 'GET', '/cars')).body.find(c => c.id === car.id);
  assert.deepStrictEqual(saved.openROs, [ro.id]);
  await as(advisor, 'POST', `/service/ros/${ro.id}/close`);
  saved = (await as(manager, 'GET', '/cars')).body.find(c => c.id === car.id);
  assert.strictEqual(saved.cost, 20000 + 2 * 90 + 400);
  assert.deepStrictEqual(saved.openROs, []);
  assert.strictEqual(saved.reconHistory[0].roNumber, ro.roNumber);
});

test('void, customer vehicles, and appointments', async () => {
  const ro = (await as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2015', make: 'Mazda', model: '3' }, jobs: [{ concern: 'Check engine light' }] })).body;
  const voided = await as(advisor, 'POST', `/service/ros/${ro.id}/void`, { reason: 'Opened twice' });
  assert.strictEqual(voided.body.status, 'void');
  const vehicles = (await as(sales, 'GET', `/service/customer/${lead.id}/vehicles`)).body;
  assert.ok(vehicles.some(v => v.vin === 'JT2BF22K1Y0123456' && v.ros.length === 1), 'sales can see the service history');
  assert.ok(!vehicles.some(v => v.make === 'Mazda'), 'voided ROs are left out');

  const appt = await as(advisor, 'POST', '/service/appointments', { leadId: lead.id, startsAt: '2031-06-02T15:00:00Z', concern: 'Oil change\nRotate tires', vehicle: { year: '2019', make: 'Honda', model: 'Civic' } });
  assert.strictEqual(appt.status, 201);
  assert.strictEqual((await as(sales, 'POST', '/service/appointments', { leadId: lead.id, startsAt: '2031-06-02T15:00:00Z' })).status, 403);
  const opened = await as(advisor, 'POST', `/service/appointments/${appt.body.id}/open-ro`, { vehicle: { mileageIn: 43000 } });
  assert.strictEqual(opened.status, 201);
  assert.deepStrictEqual(opened.body.jobs.map(j => j.concern), ['Oil change', 'Rotate tires']);
  assert.strictEqual(opened.body.vehicle.mileageIn, 43000);
  const appts = (await as(advisor, 'GET', `/service/appointments?leadId=${lead.id}`)).body;
  assert.strictEqual(appts[0].status, 'arrived');
  assert.strictEqual(appts[0].roId, opened.body.id);
  assert.strictEqual((await as(advisor, 'POST', `/service/appointments/${appt.body.id}/open-ro`)).status, 400, 'only once');
});

test('settings: service rates only through /service/settings; tech pay is managers only', async () => {
  await as(admin, 'PUT', '/settings', { service: { customerLaborRate: 1 } });
  assert.strictEqual((await as(advisor, 'GET', '/service/settings')).body.customerLaborRate, 150);
  assert.strictEqual((await as(advisor, 'PUT', '/service/settings', { customerLaborRate: 1 })).status, 403);
  assert.strictEqual((await as(advisor, 'PUT', `/service/techs/${tech.id}/pay`, { rate: 99 })).status, 403);
  const techs = (await as(advisor, 'GET', '/service/techs')).body;
  assert.strictEqual(techs.length, 2);
  assert.strictEqual(techs[0].pay, undefined, 'advisors don\'t see tech pay');
  assert.ok((await as(serviceManager, 'GET', '/service/techs')).body[0].pay);
});

test('fixed dashboard counts closed ROs', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const r = await as(serviceManager, 'GET', `/dashboard/fixed?month=${month}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.available, true);
  const m = r.body.mtd;
  assert.strictEqual(m.ros, 2, 'the customer RO and the recon RO');
  assert.strictEqual(m.laborSale, 450 + 180);
  assert.strictEqual(m.serviceGross, 630 - 110 - 0, 'recon tech had no pay rate');
  assert.strictEqual(m.partsGross, 60);
  assert.strictEqual(m.elr, 150);
  assert.strictEqual(r.body.trend.length, 12);
  assert.strictEqual((await as(sales, 'GET', `/dashboard/fixed?month=${month}`)).status, 403);
  const store = (await as(admin, 'GET', `/dashboard/store?month=${month}`)).body;
  assert.strictEqual(store.fixed.mtd.ros, 2);
});
