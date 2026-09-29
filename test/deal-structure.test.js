// Tests for the deal screen's itemized structure: up to 3 trades, rebates,
// dealer fees (taxable or not), state fee lines, the tax rate in parts, a
// prior lease payoff, deferred down payments, cash down + deposit, days to
// the first payment, employees and a co-buyer -- and that the live preview
// works out the same numbers as saving.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('deal structure tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let manager, deal;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

before(async () => {
  await h.startServer();
  manager = await h.createUser('sales_manager');
  const car = (await as(manager, 'POST', '/cars', { year: 2022, make: 'Toyota', model: 'Tacoma', price: 30000, cost: 26000, mileage: 20000, stockType: 'used' })).body;
  deal = (await as(manager, 'POST', '/deals', { carId: car.id })).body;
});
after(() => h.stopServer());

const structure = {
  dealType: 'retail', vehiclePrice: 30000, docFee: 85, apr: 0, termMonths: 60, state: 'CA',
  trades: [
    { make: 'Acura', model: 'MDX', vin: '2hnyd2h62ah530635', allowance: 3000, payoff: 1000, acv: 2800, lienholder: 'Chase', goodThru: '2026-10-10' },
    { make: 'Honda', model: 'Civic', allowance: '2,000', payoff: 0, acv: 2000 },
    { make: '', model: '', allowance: '' } // blank lines are dropped
  ],
  rebates: [{ description: 'Loyalty', amount: 500 }, { description: 'College grad', amount: 250 }],
  dealerFeeLines: [{ description: 'Nitrogen', amount: 200, taxable: true }, { description: 'Etch', amount: 100, taxable: false, paidTo: 'Vendor Co' }],
  govFees: [{ key: 'license', description: 'License fee', amount: 300 }, { key: 'registration', description: 'Registration fee', amount: 150 },
    { key: 'title', description: 'Title fee', amount: 25 }, { key: '', description: 'Smog cert', amount: 8 }],
  stateTaxRate: 6, countyTaxRate: 1, cityTaxRate: 0.25,
  priorLease: { remaining: 1200, earlyTermination: 300 },
  deferred: [{ amount: 500, date: '2026-11-01' }],
  cashDown: 1000, deposit: 500,
  dealDate: '2026-10-01', firstPaymentDate: '2026-11-15',
  employees: { sales1: 'u1', fiManager: 'u2', bogus: 'x' },
  lender: 'Credit Union'
};

test('itemized lines roll up into the deal totals, and the payment follows', async () => {
  const r = await as(manager, 'PUT', `/deals/${deal.id}`, structure);
  assert.strictEqual(r.status, 200);
  const d = r.body;
  assert.strictEqual(d.trades.length, 2, 'blank trade line dropped');
  assert.strictEqual(d.trades[0].vin, '2HNYD2H62AH530635');
  assert.deepStrictEqual([d.hasTrade, d.tradeInValue, d.tradeInPayoff, d.tradeAcv, d.tradeMake], [true, 5000, 1000, 4800, 'Acura']);
  assert.strictEqual(d.rebate, 750);
  assert.deepStrictEqual([d.dealerFees, d.taxableDealerFees], [300, 200]);
  assert.deepStrictEqual([d.licenseFee, d.registrationFee, d.titleFee, d.otherGovFees], [300, 150, 25, 8]);
  assert.strictEqual(d.taxRate, 7.25);
  assert.strictEqual(d.priorLeaseBalance, 1500);
  assert.deepStrictEqual([d.cashDown, d.deposit, d.deferredDown, d.downPayment], [1000, 500, 500, 2000]);
  assert.strictEqual(d.daysToFirstPayment, 45);
  assert.deepStrictEqual(Object.keys(d.employees).includes('bogus'), false);
  assert.strictEqual(d.employees.fiManager, 'u2');
  // CA: tax on the price plus taxable dealer fees; trade doesn't reduce it.
  assert.strictEqual(d.salesTax, Math.round((30000 + 200) * 0.0725 * 100) / 100);
  const fees = 85 + 150 + 25 + 8 + 300 + 300; // doc, registration, title, smog, dealer fees, license
  const expected = 30000 - (5000 - 1000) - 750 - 2000 + d.salesTax + fees + 1500;
  assert.strictEqual(d.amountFinanced, Math.round(expected * 100) / 100);
  assert.strictEqual(d.monthlyPayment, Math.round((expected / 60) * 100) / 100, '0% APR: straight division');
});

test('the preview works out the same numbers without saving', async () => {
  const before = (await as(manager, 'GET', `/deals/${deal.id}`)).body;
  const p = (await as(manager, 'POST', '/deals/preview', { ...structure, cashDown: 3000 })).body;
  assert.strictEqual(p.downPayment, 4000);
  assert.ok(p.amountFinanced < before.amountFinanced);
  assert.strictEqual((await as(manager, 'GET', `/deals/${deal.id}`)).body.amountFinanced, before.amountFinanced, 'nothing saved');
});

test('deals without itemized lines keep their totals', async () => {
  const plain = (await as(manager, 'POST', '/deals', {})).body;
  const d = (await as(manager, 'PUT', `/deals/${plain.id}`, { vehiclePrice: 20000, rebate: 400, dealerFees: 99, downPayment: 1000, taxRate: 7, apr: 0, termMonths: 10 })).body;
  assert.deepStrictEqual([d.rebate, d.dealerFees, d.downPayment, d.taxRate], [400, 99, 1000, 7]);
});

test('a prior lease payoff rolls into a lease too', async () => {
  const lease = (await as(manager, 'PUT', `/deals/${deal.id}`, { ...structure, dealType: 'lease', msrp: 32000, residualPercent: 55, moneyFactor: 0.002, termMonths: 36 })).body;
  const without = (await as(manager, 'POST', '/deals/preview', { ...structure, dealType: 'lease', msrp: 32000, residualPercent: 55, moneyFactor: 0.002, termMonths: 36, priorLease: {} })).body;
  assert.strictEqual(Math.round((lease.grossCapCost - without.grossCapCost) * 100) / 100, 1500);
});

test('F&I product lines: premiums into the deal, costs into F&I product cost, taxed aftermarkets', async () => {
  const car = (await as(manager, 'POST', '/cars', { year: 2023, make: 'Kia', model: 'Sorento', price: 25000, cost: 22000, mileage: 9000, stockType: 'used' })).body;
  const d0 = (await as(manager, 'POST', '/deals', { carId: car.id })).body;
  const d = (await as(manager, 'PUT', `/deals/${d0.id}`, {
    vehiclePrice: 25000, docFee: 0, apr: 0, termMonths: 10, state: 'CA', stateTaxRate: 10, countyTaxRate: 0, cityTaxRate: 0, govFees: [], cashDown: 0,
    warranties: [{ kind: 'service', premium: 2000, cost: 900, company: 'Fidelity' }, { kind: 'maintenance', premium: 600, cost: 200 }, { kind: 'service', premium: 0, cost: 0 }],
    gap: { premium: 800, cost: 300, term: 72 },
    creditInsurance: { company: 'Protective', life: { premium: 300, cost: 100 }, ah: { premium: 200, cost: 50 }, iui: {} },
    aftermarkets: [{ description: 'Tint', price: 400, cost: 100, taxable: true, weOwe: true }, { description: 'Mats', price: 100, cost: 20 }],
    insurance: { company: 'State Farm', policyNumber: 'SF1', hacker: 'x' }, misc: { tempPlate: 'T1', defect1: 'Chip' },
    titling: { lienholderName: 'Chase' }, thirdParties: [{ role: 'Attorney', name: 'Jane' }, { role: '', name: '' }]
  })).body;
  assert.strictEqual(d.warranties.length, 2, 'empty warranty dropped');
  assert.deepStrictEqual([d.servicePremium, d.maintenancePremium, d.gapPremium, d.creditInsPremium, d.aftermarketAmount, d.taxableProducts], [2000, 600, 800, 500, 500, 400]);
  assert.strictEqual(d.fiProductCost, 900 + 200 + 300 + 150 + 120);
  assert.strictEqual(d.salesTax, (25000 + 400) * 0.1, 'taxed aftermarket is in the taxed amount');
  assert.strictEqual(d.amountFinanced, 25000 + 2540 + 2000 + 600 + 800 + 500 + 500);
  assert.strictEqual(d.insurance.company, 'State Farm');
  assert.strictEqual(d.insurance.hacker, undefined);
  assert.deepStrictEqual([d.misc.tempPlate, d.titling.lienholderName, d.thirdParties.length], ['T1', 'Chase', 1]);
  const noGap = (await as(manager, 'PUT', `/deals/${d0.id}`, { gap: null })).body;
  assert.deepStrictEqual([noGap.gapPremium, noGap.fiProductCost], [0, 900 + 200 + 150 + 120]);

  // Products are F&I's and managers': a salesperson's changes to them are ignored.
  const sales = await h.createUser('salesperson');
  const r = (await as(sales, 'PUT', `/deals/${d0.id}`, { warranties: [], gapPremium: 5, aftermarketAmount: 1, fiProductCost: 0, vehiclePrice: 24900 })).body;
  assert.deepStrictEqual([r.warranties.length, r.servicePremium, r.aftermarketAmount, r.fiProductCost, r.vehiclePrice], [2, 2000, 500, 1370, 24900]);
});

test('recap: pack, adjustments, we-owe costs, reserve from the rate, commissions, advance', async () => {
  const admin = await h.createUser('admin');
  const s1 = await h.createUser('salesperson');
  const s2 = await h.createUser('salesperson');
  const fi = await h.createUser('finance');
  const car = (await as(manager, 'POST', '/cars', { year: 2021, make: 'Ford', model: 'Edge', price: 22000, cost: 18000, mileage: 30000, stockType: 'used' })).body;
  const d0 = (await as(manager, 'POST', '/deals', { carId: car.id })).body;
  const lead = (await as(manager, 'POST', '/leads', { name: 'Recap Rita', source: 'walk-in' })).body;
  const [e1, e2, eFi] = [s1, s2, fi].map(u => String(u.id));
  const body = {
    leadId: lead.id, vehiclePrice: 22000, docFee: 100, apr: 8, termMonths: 60, stateTaxRate: 0, countyTaxRate: 0, cityTaxRate: 0, govFees: [], cashDown: 0,
    packOverride: 500, adjustments: [{ description: 'Transport', amount: 300 }], weOwe: [{ item: 'Second key', cost: 200 }],
    incentiveLines: [{ description: 'Dealer cash', amount: 1000 }],
    warranties: [{ kind: 'service', premium: 2000, cost: 800 }],
    buyRate: 6, reserveMethod: 'rate', reserveSplit: 75, bookValue: 20000, maxLtv: 110,
    employees: { sales1: e1, sales2: e2, fiManager: eFi }, commissions: { sales1: { split: 60 } }
  };
  const d = (await as(manager, 'PUT', `/deals/${d0.id}`, body)).body;
  assert.ok(d.reserve > 0 && d.reserveMarkup > 0, 'reserve from the 8% sell vs 6% buy rate');
  assert.strictEqual(d.reserve, Math.round(d.reserveMarkup * 75) / 100);
  const r = (await as(manager, 'GET', `/deals/${d0.id}/gross`)).body;
  // front: 22000 - 18000 - 500 pack + 100 doc - 300 transport - 200 we owe
  assert.strictEqual(r.gross.front, 3100);
  assert.strictEqual(r.gross.finance, Math.round((2000 - 800 + d.reserve) * 100) / 100);
  assert.strictEqual(r.gross.incentives, 1000);
  const c = Object.fromEntries(r.commissions.map(x => [x.role, x]));
  assert.deepStrictEqual([c.sales1.split, c.sales2.split], [60, 40], 'the other salesperson gets what is left');
  assert.strictEqual(c.sales1.amount, Math.round(3100 * 0.25 * 60) / 100);
  assert.strictEqual(c.fiManager.amount, Math.round(r.gross.finance * 0.10 * 100) / 100);
  assert.strictEqual(r.advance.maxAdvance, 22000);
  assert.strictEqual(r.advance.over, Math.max(0, Math.round((d.amountFinanced - 22000) * 100) / 100));

  // The store's plan: a GM changes it; a sales manager can't.
  assert.strictEqual((await as(manager, 'PUT', '/commission-plan', { sales: { base: 'front', rate: 30, mini: 250 } })).status, 403);
  await as(admin, 'PUT', '/commission-plan', { sales: { base: 'front', rate: 30, mini: 250 } });
  const r2 = (await as(manager, 'GET', `/deals/${d0.id}/gross`)).body;
  assert.strictEqual(r2.commissions.find(x => x.role === 'sales1').amount, Math.round(3100 * 0.30 * 60) / 100);

  // A salesperson can't change the recap or see it.
  const sp = await h.createUser('salesperson');
  await as(sp, 'PUT', `/deals/${d0.id}`, { packOverride: 0, adjustments: [], commissions: {} });
  const still = (await as(manager, 'GET', `/deals/${d0.id}`)).body;
  assert.deepStrictEqual([still.packOverride, still.adjustments.length], [500, 1]);
  assert.strictEqual((await as(sp, 'GET', `/deals/${d0.id}/gross`)).status, 403);

  // A we-owe goes to service as an internal RO, once.
  const sent = await as(manager, 'POST', `/deals/${d0.id}/we-owe/0/service`);
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.body.ro.jobs[0].payType, 'internal');
  assert.strictEqual(sent.body.deal.weOwe[0].roNumber, sent.body.ro.roNumber);
  assert.strictEqual((await as(manager, 'POST', `/deals/${d0.id}/we-owe/0/service`)).status, 409);
});
