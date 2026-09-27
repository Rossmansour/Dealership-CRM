// Tests for the management dashboard: gross per deal (front, finance,
// incentives, chargebacks, pack, trade over-allowance), new vs pre-owned,
// final vs not final, wholesale, last month / last year, pace by open
// days, goals and expenses, and who sees which tab.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('dashboard tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const dash = require('../dashboard');

let admin, gm, manager, finance, sales, service, parts;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const MONTH = '2031-05';

// A delivered deal: car (new/used, cost), selling price, and extras; sold on `when`.
async function sale({ type = 'used', cost, price, when, status = 'delivered', extra = {}, trade }) {
  const car = (await as(manager, 'POST', '/cars', { year: 2024, make: 'Test', model: type, price, cost, stockType: type, mileage: 5 })).body;
  const deal = (await as(manager, 'POST', '/deals', { carId: car.id, vehiclePrice: price })).body;
  const body = { status, docFee: 0, ...extra, ...(trade ? { hasTrade: true, tradeInValue: trade.allowance } : {}) };
  const saved = (await as(finance, 'PUT', `/deals/${deal.id}`, body)).body;
  await h.store.pool.query(`UPDATE deals SET data = data || jsonb_build_object('deliveredAt', $2::text) WHERE id = $1`, [deal.id, when]);
  if (trade) {
    const a = (await as(manager, 'POST', '/appraisals', { year: 2015, make: 'Old', model: 'Trade', dealId: deal.id })).body;
    await h.store.pool.query(`UPDATE appraisals SET data = data || jsonb_build_object('status', 'acquired', 'acquiredFor', $2::int) WHERE id = $1`, [a.id, trade.acv]);
  }
  return { car, deal: saved };
}

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  gm = await h.createUser('general_manager');
  manager = await h.createUser('sales_manager');
  finance = await h.createUser('finance');
  sales = await h.createUser('salesperson');
  service = await h.createUser('service_manager');
  parts = await h.createUser('parts_manager');
  await as(admin, 'PUT', '/settings', { appraisalPack: 500, newCarPack: 200 });

  // May 2031
  await sale({ type: 'new', cost: 30000, price: 32000, when: '2031-05-05T18:00:00Z', status: 'finalized',
    extra: { gapPremium: 800, servicePremium: 1500, fiProductCost: 900, reserve: 600, incentives: 1000, docFee: 499 } });
  // front 32000-30000-200+499 = 2299; finance 800+1500-900+600 = 2000; incentives 1000
  await sale({ type: 'used', cost: 18000, price: 21000, when: '2031-05-10T18:00:00Z',
    extra: { chargebackAmount: 300, chargebackDate: '2031-05-20T18:00:00Z' }, trade: { allowance: 9000, acv: 8000 } });
  // front 21000-18000-500-(9000-8000) = 1500
  await sale({ type: 'used', cost: 10000, price: 11000, when: '2031-04-15T18:00:00Z' }); // last month: front 500
  await sale({ type: 'used', cost: 10000, price: 12500, when: '2030-05-15T18:00:00Z' }); // last year: 2000
  // A wholesaled car in May
  const w = (await as(manager, 'POST', '/cars', { year: 2012, make: 'Auction', model: 'Car', price: 5000, cost: 4000, mileage: 1 })).body;
  await as(manager, 'PUT', `/cars/${w.id}`, { status: 'sold', soldAs: 'wholesale', wholesalePrice: 3500 });
  await h.store.pool.query(`UPDATE cars SET data = data || jsonb_build_object('dateSold', '2031-05-12T18:00:00Z') WHERE id = $1`, [w.id]);
});
after(() => h.stopServer());

test('variable: gross per deal, new vs pre-owned, final vs not final, wholesale', async () => {
  const r = (await as(manager, 'GET', `/dashboard/variable?month=${MONTH}`)).body;
  const { mtd } = r;
  assert.deepStrictEqual([mtd.new.units, mtd.new.front, mtd.new.finance, mtd.new.incentives, mtd.new.gross], [1, 2299, 2000, 1000, 5299]);
  assert.deepStrictEqual([mtd.new.finalUnits, mtd.new.notFinalUnits], [1, 0]);
  assert.deepStrictEqual([mtd.used.units, mtd.used.front, mtd.used.chargebacks, mtd.used.gross], [1, 1500, -300, 1200], 'trade over-allowance and chargebacks count');
  assert.deepStrictEqual([mtd.used.finalUnits, mtd.used.notFinalUnits], [0, 1]);
  assert.deepStrictEqual([mtd.wholesale.used.units, mtd.wholesale.used.gross], [1, -500]);
  assert.deepStrictEqual([r.lastMonth.used.units, r.lastMonth.used.front], [1, 500]);
  assert.deepStrictEqual([r.lastYear.used.units, r.lastYear.used.front], [1, 2000]);
  assert.strictEqual(r.pace.totalDays, 27, 'May 2031: 31 days minus 4 closed Sundays');
  assert.strictEqual(r.trend.length, 12, 'the 12 months before, for trend lines');
  assert.strictEqual(r.trend[11].month, '2031-04');
  assert.strictEqual(r.trend[11].usedUnits, 1);
  // Review lists: finished deals worth a second look
  assert.strictEqual(r.exceptions.noProducts.ids.length, 1, 'the pre-owned deal had no F&I products');
  assert.strictEqual(r.exceptions.chargebacks.ids.length, 1);
  assert.strictEqual(r.exceptions.negativeFront.ids.length, 0);
  assert.strictEqual(r.exceptions.overAllowance.ids.length, 0, '$1,000 over is not over the $1,000 limit');
  assert.ok(r.exceptions.noProducts.ids.every(id => r.deals.some(d => d.id === id)), 'the deals behind them come along');
  assert.strictEqual(r.deals.length, 2);
  const noCb = (await as(manager, 'GET', `/dashboard/variable?month=${MONTH}&chargebacks=0`)).body;
  assert.strictEqual(noCb.mtd.used.gross, 1500);
  assert.ok(!JSON.stringify(r).includes('creditApp'));
});

test('pace uses the store\'s open days', () => {
  const hrs = { timezone: 'America/Chicago', days: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { closed: d === 'sun', open: '09:00', close: '20:00' }])) };
  const past = dash.openDays('2020-02', hrs);
  assert.deepStrictEqual(past, { total: 25, elapsed: 25 }, 'Feb 2020: 29 days, 4 Sundays');
  assert.deepStrictEqual(dash.openDays('2099-01', hrs).elapsed, 0);
  assert.strictEqual(dash.shiftMonth('2031-01', -1), '2030-12');
});

test('goals and expenses: each side sets its own; the GM sets expenses', async () => {
  assert.strictEqual((await as(manager, 'PUT', `/dashboard/plan/${MONTH}`, { goals: { usedUnits: 40, usedGross: '$120,000' } })).status, 200);
  const r = (await as(service, 'PUT', `/dashboard/plan/${MONTH}`, { goals: { serviceGross: 90000, usedUnits: 1 } })).body;
  assert.deepStrictEqual([r.goals.serviceGross, r.goals.usedUnits, r.goals.usedGross], [90000, 40, 120000], "service can't change sales goals");
  assert.strictEqual((await as(manager, 'PUT', `/dashboard/plan/${MONTH}`, { expenses: { general: 5 } })).status, 403);
  const e = (await as(gm, 'PUT', `/dashboard/plan/${MONTH}`, { expenses: { newVariable: 30000, usedVariable: 25000, general: 10000 } })).body;
  assert.deepStrictEqual([e.expenses.newVariable, e.expenses.general, e.expenses.service], [30000, 10000, null]);
  const store = (await as(gm, 'GET', `/dashboard/store?month=${MONTH}`)).body;
  assert.strictEqual(store.plan.expenses.usedVariable, 25000);
  assert.strictEqual(store.plan.goals.usedUnits, 40);
  assert.ok(store.inventory.units >= 0);
  const blocked = (await as(admin, 'PUT', '/settings', { monthlyPlan: { [MONTH]: {} } })).body;
  assert.ok(blocked.monthlyPlan[MONTH].goals.usedUnits === 40, 'general settings saves cannot wipe the plan');
});

test('who sees which tab: GM everything, sales & F&I variable, service & parts fixed', async () => {
  const code = async (u, tab) => (await as(u, 'GET', `/dashboard/${tab}?month=${MONTH}`)).status;
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(gm, t))), [200, 200, 200]);
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(manager, t))), [403, 200, 403]);
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(finance, t))), [403, 200, 403]);
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(service, t))), [403, 403, 200]);
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(parts, t))), [403, 403, 200]);
  assert.deepStrictEqual(await Promise.all(['store', 'variable', 'fixed'].map(t => code(sales, t))), [403, 403, 403]);
  const fixed = (await as(service, 'GET', `/dashboard/fixed?month=${MONTH}`)).body;
  assert.strictEqual(fixed.available, false);
  assert.strictEqual(fixed.plan.goals.serviceGross, 90000);
  const me = (await as(gm, 'GET', '/auth/me')).body;
  assert.strictEqual(me.roleLabel, 'General Manager');
  assert.ok(me.permissions.includes('editInventory'));
});

test("only managers and F&I enter a deal's F&I cost, reserve, incentives, and chargebacks", async () => {
  const car = (await as(manager, 'POST', '/cars', { year: 2024, make: 'X', model: 'Y', price: 100, cost: 50, mileage: 1 })).body;
  const deal = (await as(sales, 'POST', '/deals', { carId: car.id })).body;
  const s = (await as(sales, 'PUT', `/deals/${deal.id}`, { reserve: 999, incentives: 5, fiProductCost: 1, chargebackAmount: 7 })).body;
  assert.deepStrictEqual([s.reserve, s.incentives, s.fiProductCost, s.chargebackAmount], [undefined, undefined, undefined, undefined]);
  const f = (await as(finance, 'PUT', `/deals/${deal.id}`, { reserve: '$1,200', status: 'delivered' })).body;
  assert.strictEqual(f.reserve, 1200);
  assert.ok(f.deliveredAt);
  const fin = (await as(finance, 'PUT', `/deals/${deal.id}`, { status: 'finalized' })).body;
  assert.ok(fin.finalizedAt);
  const back = (await as(finance, 'PUT', `/deals/${deal.id}`, { status: 'working' })).body;
  assert.deepStrictEqual([back.deliveredAt, back.finalizedAt], [null, null]);
  const c = (await as(manager, 'PUT', `/cars/${car.id}`, { stockType: 'new', soldAs: 'something' })).body;
  assert.deepStrictEqual([c.stockType, c.soldAs], ['new', 'retail']);
});
