// Tests for the customer page <-> DMS (Sales & F&I) flow: the customer's
// credit app, Push Deal, Push Credit, F&I changes coming back to the
// customer, and trades that go straight to Appraisals.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('DMS sync tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, sales, finance;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  finance = await h.createUser('finance');
});
after(() => h.stopServer());

async function customer(body = {}) {
  return (await as(sales, 'POST', '/leads', {
    name: 'Maria Lopez', phone: '555-0101', email: 'maria@example.com',
    address: { street: '10 Elm St', unit: '2B', city: 'Tempe', state: 'AZ', zip: '85281', county: 'Maricopa' }, ...body
  })).body;
}
const creditApp = (overrides = {}) => ({
  applicantType: 'individual', status: 'approved', // sales can't set the status
  applicant: {
    firstName: 'Maria', lastName: 'Lopez', ssn: '123-45-6789', dob: '1990-01-02', phone: '555-0101', email: 'maria@example.com',
    address1: '10 Elm St', address2: '2B', city: 'Tempe', state: 'AZ', zip: '85281', county: 'Maricopa',
    employer: 'Acme', salary: 60000, housingStatus: 'rent', housingPayment: 1400, ...overrides
  }
});

test('sales saves the credit app on the customer; the SSN is encrypted and kept away from the AI', async () => {
  const lead = await customer();
  const saved = (await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, creditApp({ phone: '555-9999' }))).body;
  assert.strictEqual(saved.creditApp.applicant.ssn, '123-45-6789', 'staff see it');
  assert.strictEqual(saved.creditApp.status, 'not_submitted', 'the approval status belongs to F&I');
  assert.strictEqual(saved.phone, '555-9999', 'the applicant phone is the customer phone');
  assert.ok(saved.creditAppSync.savedAt);

  const { rows } = await h.store.pool.query('SELECT data FROM leads WHERE id = $1', [lead.id]);
  assert.notStrictEqual(rows[0].data.creditApp.applicant.ssn, '123-45-6789', 'encrypted at rest');
  assert.ok(!JSON.stringify(rows[0].data).includes('123-45-6789'));

  const log = (await as(admin, 'GET', `/audit-log?entityType=lead&entityId=${lead.id}`)).body.entries;
  assert.ok(!JSON.stringify(log).includes('123-45-6789'), 'never in the audit log');
  const edit = (await as(sales, 'PUT', `/leads/${lead.id}`, { creditApp: { hacked: true } })).body;
  assert.strictEqual(edit.creditApp.hacked, undefined, 'only changes through /credit-app');
});

test('Push Deal opens a numbered deal with the car, the trade, and the credit app', async () => {
  const lead = await customer();
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, creditApp());
  const car = (await as(manager, 'POST', '/cars', { year: 2022, make: 'Toyota', model: 'RAV4', price: 31000, cost: 27000, mileage: 20000, stockNumber: 'R-1' })).body;
  const trade = (await as(sales, 'POST', `/leads/${lead.id}/trades`, {
    vin: '1HGCV1F34JA000001', year: 2018, make: 'Honda', model: 'Accord', mileage: '52,000', payoff: '$8,500', lienholder: 'Chase', customerExpects: 15000
  })).body;
  await as(manager, 'PUT', `/appraisals/${trade.id}`, { offer: 14000 });

  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/push-deal`, { tradeId: 'nope' })).status, 400);
  const res = await as(sales, 'POST', `/leads/${lead.id}/push-deal`, { carId: car.id, tradeId: trade.id, dealType: 'retail', downPayment: '2,000' });
  assert.strictEqual(res.status, 201);
  const deal = res.body;
  assert.ok(Number.isInteger(deal.dealNumber));
  assert.deepStrictEqual([deal.leadId, deal.carId, deal.vehiclePrice, deal.downPayment], [lead.id, car.id, car.price, 2000]);
  assert.deepStrictEqual([deal.hasTrade, deal.tradeVin, deal.tradeMake, deal.tradeMileage, deal.tradeInValue, deal.tradeInPayoff],
    [true, '1HGCV1F34JA000001', 'Honda', 52000, 14000, 8500]);
  assert.strictEqual(deal.creditApp.applicant.ssn, '123-45-6789');
  assert.strictEqual(deal.creditApp.applicant.address2, '2B');
  assert.strictEqual((await as(sales, 'GET', `/appraisals/${trade.id}`)).body.dealId, deal.id, 'the trade is linked to the deal');
  const updated = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id);
  assert.match(updated.activities[0].text, new RegExp(`Deal D-${deal.dealNumber} pushed to the DMS`));
  assert.strictEqual(updated.creditAppSync.dealId, deal.id);
  assert.strictEqual(updated.carId, car.id, "the deal's car becomes the car they're interested in");
  assert.strictEqual((await as(sales, 'GET', '/cars')).body.find(c => c.id === car.id).status, 'pending');
});

test('Push Credit sends changed info to the deal, keeping the status F&I set', async () => {
  const lead = await customer();
  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/push-credit`, { dealId: 'x' })).status, 400, 'needs a credit app');
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, creditApp());
  const deal = (await as(sales, 'POST', `/leads/${lead.id}/push-deal`, {})).body;
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, { ...deal.creditApp, status: 'pending' });

  await as(sales, 'PUT', `/leads/${lead.id}`, { email: 'new@example.com', address: { street: '99 Oak Ave', city: 'Mesa', state: 'AZ', zip: '85201' } });
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, { ...creditApp({ email: 'new@example.com', address1: '99 Oak Ave', city: 'Mesa', zip: '85201', address2: '' }), });
  const pushed = (await as(sales, 'POST', `/leads/${lead.id}/push-credit`, { dealId: deal.id })).body;
  assert.strictEqual(pushed.creditApp.applicant.email, 'new@example.com');
  assert.strictEqual(pushed.creditApp.applicant.address1, '99 Oak Ave');
  assert.strictEqual(pushed.creditApp.status, 'pending', "sales can't change F&I's status");
  assert.ok(pushed.creditPushedAt);

  const other = await customer({ name: 'Someone Else' });
  await as(sales, 'PUT', `/leads/${other.id}/credit-app`, creditApp());
  assert.strictEqual((await as(sales, 'POST', `/leads/${other.id}/push-credit`, { dealId: deal.id })).status, 400, "can't push onto someone else's deal");
});

test("F&I's changes on the deal go back to the customer -- only what they changed", async () => {
  const lead = await customer();
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, creditApp());
  const deal = (await as(sales, 'POST', `/leads/${lead.id}/push-deal`, {})).body;
  // Meanwhile sales updates the employer on the customer (not pushed yet).
  await as(sales, 'PUT', `/leads/${lead.id}/credit-app`, creditApp({ employer: 'New Job LLC' }));

  const dealCa = JSON.parse(JSON.stringify(deal.creditApp));
  dealCa.status = 'approved';
  dealCa.applicant.phone = '555-2222';
  dealCa.applicant.salary = 65000;
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, dealCa);

  const back = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id);
  assert.strictEqual(back.creditApp.status, 'approved');
  assert.strictEqual(back.creditApp.applicant.salary, 65000);
  assert.strictEqual(back.creditApp.applicant.employer, 'New Job LLC', "sales' unpushed change is kept");
  assert.strictEqual(back.phone, '555-2222', 'contact changes update the customer too');
  assert.match(back.activities[0].text, /F&I updated the credit app on D-\d+ -- status: approved/);
  assert.ok(back.creditAppSync.fromDmsAt);

  const before = back.activities.length;
  await as(finance, 'PUT', `/deals/${deal.id}/credit-app`, dealCa);
  assert.strictEqual((await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id).activities.length, before, 'saving without changes sends nothing back');
});

test('a trade goes straight to Appraisals for a manager; removing it from the customer keeps the appraisal', async () => {
  const lead = await customer();
  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/trades`, { mileage: 1 })).status, 400);
  const trade = (await as(sales, 'POST', `/leads/${lead.id}/trades`, {
    vin: '5fnrl6h72lb000123', year: 2020, make: 'Honda', model: 'Odyssey', mileage: 41000, condition: 'good', payoff: 12000, lienholder: 'Ally', customerExpects: '$22,000', notes: 'Small dent'
  })).body;
  assert.deepStrictEqual([trade.status, trade.source, trade.leadId, trade.appraisedBy, trade.requestedBy.id], ['open', 'trade_in', lead.id, null, sales.id],
    'waiting for an appraiser');
  assert.deepStrictEqual([trade.vin, trade.payoff, trade.lienholder, trade.customerExpects], ['5FNRL6H72LB000123', 12000, 'Ally', 22000]);
  assert.ok((await as(manager, 'GET', '/appraisals')).body.some(a => a.id === trade.id));

  const appraised = (await as(manager, 'PUT', `/appraisals/${trade.id}`, { offer: 20500 })).body;
  assert.strictEqual(appraised.appraisedBy.id, manager.id, 'whoever puts the first number on it is the appraiser');
  assert.strictEqual((await as(sales, 'PUT', `/appraisals/${trade.id}`, { requestedBy: null, removedFromLead: { at: 'x' } })).body.requestedBy.id, sales.id);

  const removed = (await as(sales, 'DELETE', `/leads/${lead.id}/trades/${trade.id}`)).body;
  assert.ok(removed.removedFromLead.at);
  const kept = (await as(manager, 'GET', `/appraisals/${trade.id}`)).body;
  assert.deepStrictEqual([kept.status, kept.offer, kept.leadId], ['open', 20500, lead.id], 'the appraisal is untouched');
  assert.strictEqual((await as(sales, 'DELETE', `/leads/${lead.id}/trades/${trade.id}`)).status, 404, 'already removed');
  const notes = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id).activities.map(a => a.text).join(' | ');
  assert.match(notes, /Trade added: 2020 Honda Odyssey -- sent to Appraisals/);
  assert.match(notes, /Trade removed: A-\d+ \(still in Appraisals\)/);
});

test('the AI never sees customer credit apps', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const safeLeads = leads\.map\(\(\{ creditApp, \.\.\.lead \}\) => lead\)/);
  assert.match(src, /LEADS \(customers\/prospects, credit applications removed\):\n\$\{JSON\.stringify\(safeLeads/);
});
