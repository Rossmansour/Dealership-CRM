// Tests for appraisals ("book outs"): creating, editing, recalls (with a
// stand-in for NHTSA's recall service), acquiring into inventory, lost /
// reopen, provider slots, permissions, and dealership separation.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

if (!process.env.TEST_DATABASE_URL) {
  test('appraisal tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let fakeNhtsa;
let nhtsaRequests = [];
let admin, manager, sales;

before(async () => {
  // Shaped like https://api.nhtsa.gov/recalls/recallsByVehicle?make=..&model=..&modelYear=..
  fakeNhtsa = http.createServer((req, res) => {
    nhtsaRequests.push(req.url);
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (u.searchParams.get('model') === 'Accord' && u.searchParams.get('modelYear') === '2018') {
      return res.end(JSON.stringify({
        Count: 1, Message: 'Results returned successfully',
        results: [{
          Manufacturer: 'Honda (American Honda Motor Co.)', NHTSACampaignNumber: '18V123000',
          ReportReceivedDate: '01/02/2018', Component: 'AIR BAGS',
          Summary: 'The passenger air bag inflator may rupture.', Consequence: 'Injury risk.', Remedy: 'Dealers will replace the inflator, free of charge.'
        }]
      }));
    }
    if (u.searchParams.get('model') === 'Nonsense') { res.statusCode = 400; return res.end('{}'); }
    res.end(JSON.stringify({ Count: 0, Message: 'Results returned successfully', results: [] }));
  });
  await new Promise(resolve => fakeNhtsa.listen(0, resolve));
  process.env.NHTSA_API_URL = `http://localhost:${fakeNhtsa.address().port}`;

  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
});

after(async () => {
  fakeNhtsa.close();
  await h.stopServer();
});

const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

async function newAppraisal(user = sales, body = {}) {
  return (await as(user, 'POST', '/appraisals', body)).body;
}

test('anyone can start an appraisal; it gets a number and the store target gross', async () => {
  await as(admin, 'PUT', '/settings', { appraisalTargetGross: 3000, appraisalPack: 400 });
  const a = await newAppraisal(sales, { vin: '1hgcv1f3-4la000000', mileage: '41,000', targetRetail: '$19,500' });
  assert.strictEqual(a.mileage, 41000, 'commas are fine');
  assert.strictEqual(a.targetRetail, 19500, 'so are dollar signs');
  assert.match(String(a.appraisalNumber), /^\d{4}$/);
  assert.strictEqual(a.status, 'open');
  assert.strictEqual(a.vin, '1HGCV1F34LA000000');
  assert.strictEqual(a.targetGross, 3000);
  assert.strictEqual(a.appraisedBy.id, sales.id);
  const b = await newAppraisal(sales);
  assert.strictEqual(b.appraisalNumber, a.appraisalNumber + 1);
});

test('editing saves vehicle, equipment, recon, and offer -- but not status or history fields', async () => {
  const a = await newAppraisal();
  const saved = (await as(sales, 'PUT', `/appraisals/${a.id}`, {
    year: '2018', make: 'Honda', model: 'Accord', trim: 'EX-L', mileage: '52000', condition: 'good',
    equipment: ['Sunroof / Moonroof', 'Leather Seats', 'Leather Seats', ' '],
    recon: [{ description: 'Tires', cost: '600' }, { description: '', cost: '' }, { description: 'Detail', cost: 150 }],
    targetRetail: '19500', targetGross: '2500', offer: '15000',
    status: 'acquired', carId: 'hijack', appraisalNumber: 1, condition2: 'x'
  })).body;
  assert.strictEqual(saved.year, 2018);
  assert.strictEqual(saved.mileage, 52000);
  assert.deepStrictEqual(saved.equipment, ['Sunroof / Moonroof', 'Leather Seats']);
  assert.deepStrictEqual(saved.recon, [{ description: 'Tires', cost: 600 }, { description: 'Detail', cost: 150 }]);
  assert.strictEqual(saved.offer, 15000);
  assert.strictEqual(saved.status, 'open', 'status only changes through acquire / lost / reopen');
  assert.strictEqual(saved.carId, null);
  assert.strictEqual(saved.appraisalNumber, a.appraisalNumber);

  const bad = (await as(sales, 'PUT', `/appraisals/${a.id}`, { condition: 'amazing' })).body;
  assert.strictEqual(bad.condition, '', 'unknown condition values are dropped');
});

test('recalls come live from NHTSA for the year, make, and model', async () => {
  const a = await newAppraisal(sales, { year: 2018, make: 'Honda', model: 'Accord' });
  const res = await as(sales, 'POST', `/appraisals/${a.id}/recalls`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.recalls.items.length, 1);
  assert.deepStrictEqual(res.body.recalls.items[0], {
    campaign: '18V123000', component: 'AIR BAGS', summary: 'The passenger air bag inflator may rupture.',
    consequence: 'Injury risk.', remedy: 'Dealers will replace the inflator, free of charge.', reportDate: '01/02/2018'
  });
  assert.ok(nhtsaRequests.at(-1).includes('make=Honda&model=Accord&modelYear=2018'));

  const clean = await newAppraisal(sales, { year: 2021, make: 'Toyota', model: 'Camry' });
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${clean.id}/recalls`)).body.recalls.items.length, 0);

  const unknownModel = await newAppraisal(sales, { year: 2021, make: 'Toyota', model: 'Nonsense' });
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${unknownModel.id}/recalls`)).body.recalls.items.length, 0,
    "NHTSA's 400 for an unknown model means no recalls, not an error");

  const empty = await newAppraisal();
  const missing = await as(sales, 'POST', `/appraisals/${empty.id}/recalls`);
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.error, /year, make, and model/);
});

test('when NHTSA is unreachable, it says so', async () => {
  const saved = process.env.NHTSA_API_URL;
  process.env.NHTSA_API_URL = 'http://localhost:1';
  const a = await newAppraisal(sales, { year: 2018, make: 'Honda', model: 'Accord' });
  const res = await as(sales, 'POST', `/appraisals/${a.id}/recalls`);
  process.env.NHTSA_API_URL = saved;
  assert.strictEqual(res.status, 502);
  assert.match(res.body.error, /Couldn't reach NHTSA/);
});

test('acquiring creates the inventory car with everything filled in, linked both ways', async () => {
  const a = await newAppraisal(sales, {
    vin: '5FNRL6H72LB000123', year: 2020, make: 'Honda', model: 'Odyssey', trim: 'EX-L', bodyStyle: 'Minivan',
    engine: '3.5L V6 280 hp', drivetrain: 'FWD', mileage: 41000, exteriorColor: 'Silver',
    equipment: ['Third Row Seating', 'Power Liftgate'], targetRetail: 28900, offer: 22500
  });
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${a.id}/acquire`, { acquiredFor: 22500 })).status, 403,
    'salespeople appraise; managers acquire');
  assert.strictEqual((await as(manager, 'POST', `/appraisals/${a.id}/acquire`, {})).status, 400, 'needs what was paid');

  const res = await as(manager, 'POST', `/appraisals/${a.id}/acquire`, { acquiredFor: 22000, stockNumber: 'T-500' });
  assert.strictEqual(res.status, 200);
  const { appraisal, car } = res.body;
  assert.strictEqual(appraisal.status, 'acquired');
  assert.strictEqual(appraisal.carId, car.id);
  assert.strictEqual(appraisal.acquiredFor, 22000);
  assert.deepStrictEqual(
    [car.vin, car.year, car.make, car.model, car.trim, car.bodyStyle, car.mileage, car.exteriorColor, car.cost, car.price, car.stockNumber, car.status],
    ['5FNRL6H72LB000123', 2020, 'Honda', 'Odyssey', 'EX-L', 'Minivan', 41000, 'Silver', 22000, 28900, 'T-500', 'available']);
  assert.deepStrictEqual(car.equipment, ['Third Row Seating', 'Power Liftgate']);
  assert.strictEqual(car.sourceAppraisalId, a.id);
  assert.strictEqual((await as(admin, 'GET', `/cars/${car.id}`)).body.sourceAppraisalId, a.id);

  assert.strictEqual((await as(manager, 'POST', `/appraisals/${a.id}/acquire`, { acquiredFor: 1 })).status, 409, 'only once');
  const locked = (await as(sales, 'PUT', `/cars/${car.id}`, { sourceAppraisalId: 'other' }));
  assert.strictEqual(locked.status, 403);
  const managerEdit = (await as(manager, 'PUT', `/cars/${car.id}`, { sourceAppraisalId: 'other', price: 28500 })).body;
  assert.strictEqual(managerEdit.sourceAppraisalId, a.id, 'the link to the appraisal cannot be edited away');

  const log = (await as(admin, 'GET', `/audit-log?entityType=appraisal&entityId=${a.id}`)).body.entries;
  assert.strictEqual(log[0].action, 'acquire');
  assert.match(log[0].details, /Acquired for \$22,000.*stock #T-500/);
});

test('acquiring needs year, make, and model', async () => {
  const a = await newAppraisal(sales, { vin: '1HGCV1F34LA000000' });
  const res = await as(manager, 'POST', `/appraisals/${a.id}/acquire`, { acquiredFor: 10000 });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Year, make, and model/);
});

test('lost and reopen', async () => {
  const a = await newAppraisal();
  const lost = (await as(sales, 'POST', `/appraisals/${a.id}/lost`, { reason: 'Customer kept the car' })).body;
  assert.strictEqual(lost.status, 'lost');
  assert.strictEqual(lost.lostReason, 'Customer kept the car');
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${a.id}/lost`, {})).status, 409);
  const reopened = (await as(sales, 'POST', `/appraisals/${a.id}/reopen`)).body;
  assert.strictEqual(reopened.status, 'open');
  assert.strictEqual(reopened.lostReason, null);
});

test('appraisals can be tied to a customer and a deal', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Trade Customer' })).body;
  const deal = (await as(sales, 'POST', '/deals', { leadId: lead.id })).body;
  const a = await newAppraisal(sales, { leadId: lead.id, dealId: deal.id, year: '2019', make: 'Ford', model: 'Escape', mileage: '60000' });
  assert.strictEqual(a.leadId, lead.id);
  assert.strictEqual(a.dealId, deal.id);
  assert.strictEqual(a.year, 2019);
  const listed = (await as(sales, 'GET', '/appraisals')).body.find(x => x.id === a.id);
  assert.ok(listed);
});

test('provider slots: recalls live, everything else not available yet', async () => {
  const list = (await as(sales, 'GET', '/providers')).body;
  const status = Object.fromEntries(list.map(p => [p.key, p.status]));
  assert.deepStrictEqual(status, {
    market: 'not_available', options: 'not_available', kbb: 'not_available', jdpower: 'not_available',
    blackbook: 'not_available', mmr: 'not_available', carfax: 'not_available', autocheck: 'not_available',
    windowsticker: 'not_available', recalls: 'live'
  });
  assert.ok(list.find(p => p.key === 'kbb').needs);
});

test('only managers and admins delete; each dealership only sees its own appraisals', async () => {
  const a = await newAppraisal();
  assert.strictEqual((await as(sales, 'DELETE', `/appraisals/${a.id}`)).status, 403);

  const other = await h.store.pool.query("INSERT INTO dealerships (name) VALUES ('Other Motors') RETURNING id");
  const otherAdmin = await h.createUser('admin', { dealershipId: other.rows[0].id });
  assert.strictEqual((await as(otherAdmin, 'GET', `/appraisals/${a.id}`)).status, 404);
  assert.strictEqual((await as(otherAdmin, 'PUT', `/appraisals/${a.id}`, { make: 'x' })).status, 404);
  assert.strictEqual((await as(otherAdmin, 'POST', `/appraisals/${a.id}/acquire`, { acquiredFor: 1 })).status, 404);
  assert.strictEqual((await as(otherAdmin, 'GET', '/appraisals')).body.length, 0);
  const theirs = (await as(otherAdmin, 'POST', '/appraisals', {})).body;
  assert.strictEqual(theirs.appraisalNumber, 1001, 'numbering is per dealership');

  assert.strictEqual((await as(manager, 'DELETE', `/appraisals/${a.id}`)).status, 204);
  assert.strictEqual((await as(manager, 'GET', `/appraisals/${a.id}`)).status, 404);
});

test('appraisals need a sign-in', async () => {
  assert.strictEqual((await h.api('GET', '/appraisals')).status, 401);
  assert.strictEqual((await h.api('POST', '/appraisals', {})).status, 401);
});
