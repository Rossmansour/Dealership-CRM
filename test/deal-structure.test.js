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
