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
  // Shaped like api.nhtsa.gov:
  //   /products/vehicle/models?modelYear=..&make=..&issueType=r  (the model names NHTSA files recalls under)
  //   /recalls/recallsByVehicle?make=..&model=..&modelYear=..
  const airBag = {
    Manufacturer: 'Honda (American Honda Motor Co.)', NHTSACampaignNumber: '18V123000',
    ReportReceivedDate: '01/02/2018', Component: 'AIR BAGS',
    Summary: 'The passenger air bag inflator may rupture.', Consequence: 'Injury risk.', Remedy: 'Dealers will replace the inflator, free of charge.'
  };
  const recall = (campaign, component) => ({ ...airBag, NHTSACampaignNumber: campaign, Component: component });
  const MODELS = {
    'HONDA/2018': ['ACCORD', 'ACCORD HYBRID', 'CIVIC'],
    'TOYOTA/2021': ['CAMRY', 'COROLLA'],
    'MERCEDES-BENZ/2023': ['GLC300', 'GLC43 AMG', 'GLE350', 'C300']
  };
  const RECALLS = {
    'ACCORD/2018': [airBag],
    'ACCORD HYBRID/2018': [airBag, recall('18V555000', 'ELECTRICAL SYSTEM')],
    'GLC300/2023': [recall('23V100000', 'STEERING')],
    'GLC43 AMG/2023': [recall('23V200000', 'FUEL SYSTEM')],
    'GLE350/2023': [recall('23V999000', 'SHOULD NOT APPEAR')]
  };
  fakeNhtsa = http.createServer((req, res) => {
    nhtsaRequests.push(req.url);
    const u = new URL(req.url, 'http://x');
    const p = k => u.searchParams.get(k) || '';
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/products/vehicle/models') {
      const models = MODELS[`${p('make').toUpperCase()}/${p('modelYear')}`];
      if (!models) { res.statusCode = 400; return res.end('{}'); }
      return res.end(JSON.stringify({ count: models.length, results: models.map(model => ({ modelYear: p('modelYear'), make: p('make').toUpperCase(), model })) }));
    }
    if (p('model') === 'Nonsense') { res.statusCode = 400; return res.end('{}'); }
    const results = RECALLS[`${p('model').toUpperCase()}/${p('modelYear')}`] || [];
    res.end(JSON.stringify({ Count: results.length, Message: 'Results returned successfully', results }));
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

test('recalls come live from NHTSA, under the model names NHTSA actually uses', async () => {
  const a = await newAppraisal(sales, { year: 2018, make: 'Honda', model: 'Accord' });
  const res = await as(sales, 'POST', `/appraisals/${a.id}/recalls`);
  assert.strictEqual(res.status, 200);
  const r = res.body.recalls;
  assert.strictEqual(r.scope, 'model');
  assert.strictEqual(r.modelFound, true);
  assert.deepStrictEqual(r.matchedModels, ['ACCORD', 'ACCORD HYBRID'], 'Civic is not an Accord');
  // The air bag recall is filed under both names -- counted once.
  assert.deepStrictEqual(r.items.map(i => i.campaign), ['18V123000', '18V555000']);
  assert.deepStrictEqual(r.items[0], {
    campaign: '18V123000', component: 'AIR BAGS', summary: 'The passenger air bag inflator may rupture.',
    consequence: 'Injury risk.', remedy: 'Dealers will replace the inflator, free of charge.', reportDate: '01/02/2018',
    models: ['ACCORD', 'ACCORD HYBRID']
  });
  assert.deepStrictEqual(r.items[1].models, ['ACCORD HYBRID']);

  // The VIN decoder says "GLC-Class"; NHTSA files these under GLC300 / GLC43 AMG.
  const glc = await newAppraisal(sales, { year: 2023, make: 'Mercedes-Benz', model: 'GLC-Class' });
  const g = (await as(sales, 'POST', `/appraisals/${glc.id}/recalls`)).body.recalls;
  assert.deepStrictEqual(g.matchedModels, ['GLC300', 'GLC43 AMG']);
  assert.deepStrictEqual(g.items.map(i => i.campaign).sort(), ['23V100000', '23V200000']);

  const clean = await newAppraisal(sales, { year: 2021, make: 'Toyota', model: 'Camry' });
  const c = (await as(sales, 'POST', `/appraisals/${clean.id}/recalls`)).body.recalls;
  assert.strictEqual(c.items.length, 0);
  assert.strictEqual(c.modelFound, true, 'a real "no recalls" -- the model was found');

  // A model name NHTSA doesn't know is NOT an all-clear.
  const unknownModel = await newAppraisal(sales, { year: 2021, make: 'Toyota', model: 'Nonsense' });
  const u = (await as(sales, 'POST', `/appraisals/${unknownModel.id}/recalls`)).body.recalls;
  assert.strictEqual(u.items.length, 0);
  assert.strictEqual(u.modelFound, false);

  const empty = await newAppraisal();
  const missing = await as(sales, 'POST', `/appraisals/${empty.id}/recalls`);
  assert.strictEqual(missing.status, 400);
  assert.match(missing.body.error, /year, make, and model/);
});

test('decoded model names are matched to NHTSA recall model names', () => {
  const { matchModelNames } = require('../providers');
  assert.deepStrictEqual(matchModelNames('GLC-Class', ['GLC300', 'GLC43 AMG', 'GLC 300 COUPE', 'GLE350']), ['GLC300', 'GLC43 AMG', 'GLC 300 COUPE']);
  assert.deepStrictEqual(matchModelNames('Grand Cherokee', ['CHEROKEE', 'GRAND CHEROKEE', 'COMPASS']), ['GRAND CHEROKEE']);
  assert.deepStrictEqual(matchModelNames('F-150', ['F-150', 'F-150 LIGHTNING', 'F-250']), ['F-150', 'F-150 LIGHTNING']);
  assert.deepStrictEqual(matchModelNames('Model 3', ['MODEL 3', 'MODEL S']), ['MODEL 3']);
  assert.deepStrictEqual(matchModelNames('X', ['X5', 'X7']), [], 'too short to guess from');
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

test('source, category, other costs, and the calculator choice are saved -- and checked', async () => {
  const a = await newAppraisal();
  assert.deepStrictEqual([a.source, a.category, a.calcSolveFor, a.otherCosts], ['trade_in', 'undecided', 'appraisal', 0]);
  const saved = (await as(sales, 'PUT', `/appraisals/${a.id}`, {
    source: 'service_drive', category: 'wholesale', calcSolveFor: 'profit', otherCosts: '$1,200'
  })).body;
  assert.deepStrictEqual([saved.source, saved.category, saved.calcSolveFor, saved.otherCosts], ['service_drive', 'wholesale', 'profit', 1200]);
  const bad = (await as(sales, 'PUT', `/appraisals/${a.id}`, { source: 'auction', category: 'x', calcSolveFor: 'x' })).body;
  assert.deepStrictEqual([bad.source, bad.category, bad.calcSolveFor], ['trade_in', 'undecided', 'appraisal']);
});

test('the appraiser can be changed to someone at the store', async () => {
  const a = await newAppraisal(sales);
  const changed = (await as(sales, 'PUT', `/appraisals/${a.id}`, { appraiserId: manager.id })).body;
  assert.strictEqual(changed.appraisedBy.id, manager.id);
  assert.match(changed.appraisedBy.name, /sales_manager/);
  assert.strictEqual(changed.appraiserId, undefined, 'not stored as its own field');
  const bad = await as(sales, 'PUT', `/appraisals/${a.id}`, { appraiserId: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await as(sales, 'GET', `/appraisals/${a.id}`)).body.appraisedBy.id, manager.id);
  // direct edits to appraisedBy are ignored
  const hijack = (await as(sales, 'PUT', `/appraisals/${a.id}`, { appraisedBy: { id: 'x', name: 'Nobody' } })).body;
  assert.strictEqual(hijack.appraisedBy.id, manager.id);
});

test('every change to the appraisal amount is kept in its history', async () => {
  const a = await newAppraisal(sales, { offer: 15000 });
  assert.deepStrictEqual(a.offerHistory.map(h => [h.previous, h.amount]), [[null, 15000]]);
  await as(sales, 'PUT', `/appraisals/${a.id}`, { offer: 15000, notes: 'no amount change' });
  await as(manager, 'PUT', `/appraisals/${a.id}`, { offer: '16,250' });
  const saved = (await as(sales, 'PUT', `/appraisals/${a.id}`, { offerHistory: [] })).body;
  assert.deepStrictEqual(saved.offerHistory.map(h => [h.previous, h.amount]), [[null, 15000], [15000, 16250]],
    'unchanged saves add nothing, and the history cannot be edited');
  assert.strictEqual(saved.offerHistory[1].by.id, manager.id);
});

test('customer offer: creates the customer, notes it on them, and links the appraisal', async () => {
  const a = await newAppraisal(sales, { year: 2020, make: 'Honda', model: 'Odyssey', offer: 21000 });
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`, { amount: '' })).status, 400);
  const noName = await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`, { amount: 20000 });
  assert.strictEqual(noName.status, 400);
  assert.match(noName.body.error, /name/);
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`,
    { amount: 20000, firstName: 'X', salespersonId: '00000000-0000-0000-0000-000000000000' })).status, 400);

  const res = await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`, {
    amount: '$20,500', firstName: 'Dana', lastName: 'Rivera', phone: '555-0100', email: 'dana@example.com', salespersonId: sales.id
  });
  assert.strictEqual(res.status, 201);
  const { appraisal, lead, leadCreated } = res.body;
  assert.strictEqual(leadCreated, true);
  assert.deepStrictEqual([lead.name, lead.phone, lead.email, lead.status], ['Dana Rivera', '555-0100', 'dana@example.com', 'new']);
  assert.strictEqual(appraisal.leadId, lead.id);
  assert.strictEqual(appraisal.customerOffers[0].amount, 20500);
  assert.strictEqual(appraisal.customerOffers[0].salesperson.id, sales.id);
  assert.strictEqual(appraisal.offer, 21000, "the offer to the customer doesn't change the appraisal");
  const saved = (await as(sales, 'GET', `/leads`)).body.find(l => l.id === lead.id);
  assert.match(saved.activities[0].text, /Offered \$20,500 for their 2020 Honda Odyssey \(appraisal A-\d+\)/);

  // A second offer goes to the same customer; no new customer is created.
  const again = (await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`, { amount: 21000, firstName: 'Someone', lastName: 'Else' })).body;
  assert.strictEqual(again.leadCreated, false);
  assert.strictEqual(again.lead.id, lead.id);
  assert.strictEqual(again.appraisal.customerOffers.length, 2);

  await as(sales, 'POST', `/appraisals/${a.id}/lost`, {});
  assert.strictEqual((await as(sales, 'POST', `/appraisals/${a.id}/customer-offer`, { amount: 1 })).status, 409);
  const log = (await as(admin, 'GET', `/audit-log?entityType=appraisal&entityId=${a.id}`)).body.entries;
  assert.ok(log.some(e => e.action === 'customer_offer' && /\$20,500 to Dana Rivera/.test(e.details)));
});

test("retail performance comes from the store's own sales of similar cars", async () => {
  const car = async (body, sold) => {
    const c = (await as(manager, 'POST', '/cars', { make: 'Subaru', mileage: 30000, ...body })).body;
    if (sold) await as(manager, 'PUT', `/cars/${c.id}`, { status: 'sold' });
    return c;
  };
  await car({ year: 2019, model: 'Outback', cost: 20000, price: 24000 }, true);
  await car({ year: 2021, model: 'Outback Wilderness', cost: 26000, price: 29000 }, true);
  await car({ year: 2020, model: 'Outback', cost: 21000, price: 25500 }, false);
  await car({ year: 2012, model: 'Outback', cost: 5000, price: 8000 }, true); // too old
  await car({ year: 2020, model: 'Forester', cost: 20000, price: 23000 }, true); // different model

  const a = await newAppraisal(sales, { year: 2020, make: 'SUBARU', model: 'Outback' });
  const r = (await as(sales, 'GET', `/appraisals/${a.id}/retail-performance`)).body;
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.sold.count, 2);
  assert.strictEqual(r.sold.avgSalePrice, 26500);
  assert.strictEqual(r.sold.avgGross, 3500);
  assert.strictEqual(r.sold.avgDaysToSell, 0);
  assert.strictEqual(r.inStock.count, 1);
  assert.strictEqual(r.inStock.avgAskingPrice, 25500);

  const blank = await newAppraisal();
  assert.strictEqual((await as(sales, 'GET', `/appraisals/${blank.id}/retail-performance`)).body.ready, false);
});

test('everyone can see staff names (for appraiser and salesperson), but not their emails', async () => {
  const staff = (await as(sales, 'GET', '/staff')).body;
  const me = staff.find(u => u.id === sales.id);
  assert.ok(me && me.name);
  assert.ok(staff.some(u => u.id === manager.id));
  assert.strictEqual(me.email, undefined);
});

test('provider slots: model recalls live, everything else not available yet', async () => {
  const list = (await as(sales, 'GET', '/providers')).body;
  const status = Object.fromEntries(list.map(p => [p.key, p.status]));
  assert.deepStrictEqual(status, {
    market: 'not_available', options: 'not_available', kbb: 'not_available', jdpower: 'not_available',
    blackbook: 'not_available', mmr: 'not_available', carfax: 'not_available', autocheck: 'not_available',
    windowsticker: 'not_available', vin_recalls: 'not_available', recalls: 'live'
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
