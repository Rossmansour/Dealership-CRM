// Tests for Insight Domus: sales summary, leaderboard (split deals), F&I
// penetration and lenders, inventory analysis (cost only for managers),
// marketing (age ranges, never birthdates), and the gross trend.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('insight tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, manager, fi, sales, sales2;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const ok = async p => { const r = await p; assert.ok([200, 201].includes(r.status), `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

async function sell({ make, model, cost, price, type = 'used', zip, dob, lender, products = {}, employees, reserve = 0 }) {
  const car = await ok(as(admin, 'POST', '/cars', { make, model, year: 2022, cost, price, stockType: type, stockNumber: `${make[0]}${Math.floor(Math.random() * 1e6)}` }));
  const lead = await ok(as(admin, 'POST', '/leads', { name: `${make} Buyer ${Math.random().toString(36).slice(2, 6)}`, source: 'website', address: { zip } }));
  const deal = await ok(as(admin, 'POST', '/deals', { carId: car.id, leadId: lead.id }));
  if (dob) await ok(as(admin, 'PUT', `/deals/${deal.id}/credit-app`, { applicant: { firstName: 'A', lastName: 'B', dob, zip } }));
  await ok(as(admin, 'PUT', `/deals/${deal.id}`, { vehiclePrice: price, docFee: 0, dealType: lender ? 'retail' : 'cash', lender: lender || '', apr: 6, termMonths: 72, reserve, employees, ...products }));
  return ok(as(admin, 'PUT', `/deals/${deal.id}`, { status: 'delivered' }));
}

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  fi = await h.createUser('finance');
  sales = await h.createUser('salesperson');
  sales2 = await h.createUser('salesperson');
  await sell({ make: 'Toyota', model: 'Tacoma', cost: 30000, price: 34000, zip: '85001', dob: '1990-05-01', lender: 'Ally Financial', reserve: 500,
    products: { servicePremium: 2000, gapPremium: 800, fiProductCost: 900 }, employees: { sales1: sales.id, sales2: sales2.id, fiManager: fi.id, salesManager: manager.id } });
  await sell({ make: 'Toyota', model: 'Tacoma', cost: 28000, price: 30000, zip: '85001', dob: '1960-01-01', employees: { sales1: sales.id, fiManager: fi.id } });
  await sell({ make: 'Honda', model: 'Civic', cost: 20000, price: 21000, type: 'new', zip: '85250', lender: 'Chase Auto', reserve: 300, products: { gapPremium: 700 }, employees: { sales1: sales2.id, fiManager: fi.id } });
  // Still in stock.
  await ok(as(admin, 'POST', '/cars', { make: 'Toyota', model: 'Tacoma', year: 2023, cost: 31000, price: 35000, stockType: 'used', stockNumber: 'TAC9' }));
});
after(() => h.stopServer());

test('managers and F&I see Insight; salespeople do not', async () => {
  assert.strictEqual((await as(sales, 'GET', '/insight/sales')).status, 403);
  assert.strictEqual((await as(manager, 'GET', '/insight/sales')).status, 200);
  assert.strictEqual((await as(fi, 'GET', '/insight/fi')).status, 200);
});

test('sales summary: units, front / back / per vehicle, the daily log', async () => {
  const s = (await as(manager, 'GET', '/insight/sales')).body;
  assert.strictEqual(s.current.total.units, 3);
  assert.deepStrictEqual([s.current.new.units, s.current.used.units], [1, 2]);
  assert.strictEqual(s.current.used.front, (34000 - 30000) + (30000 - 28000), 'front: price - cost');
  assert.strictEqual(s.current.used.back, 2000 + 800 - 900 + 500, 'back: products - cost + reserve');
  assert.strictEqual(s.current.total.pvr.total, Math.round(s.current.total.gross / 3 * 100) / 100);
  assert.strictEqual(s.log.length, 3);
  assert.ok(s.log[0].dealNumber);
  assert.ok(s.pace, 'month to date gets a pace');
  assert.strictEqual(s.lastYear.total.units, 0);
});

test('leaderboard: a split deal counts half for each salesperson', async () => {
  const b = (await as(manager, 'GET', '/insight/leaderboard')).body;
  const one = b.salespeople.find(x => x.id === String(sales.id)), two = b.salespeople.find(x => x.id === String(sales2.id));
  assert.deepStrictEqual([one.units, two.units], [1.5, 1.5]);
  assert.strictEqual(b.fi.find(x => x.id === String(fi.id)).units, 3);
  assert.strictEqual(b.managers.find(x => x.id === String(manager.id)).units, 1);
});

test('F&I: product penetration by manager, and the lender report', async () => {
  const f = (await as(fi, 'GET', '/insight/fi')).body;
  assert.strictEqual(f.deals, 3);
  assert.strictEqual(f.cash, 1);
  assert.strictEqual(f.penetration.gap, Math.round(2 / 3 * 10000) / 100, 'GAP on 2 of 3');
  assert.strictEqual(f.penetration.service, Math.round(1 / 3 * 10000) / 100);
  const ally = f.lenders.find(l => l.lender === 'Ally Financial');
  assert.strictEqual(ally.deals, 1);
  assert.strictEqual(ally.reserve, 500);
  assert.strictEqual(f.managers.find(m => m.id === String(fi.id)).deals, 3);
});

test('inventory: cost only for managers; model pacing; aging', async () => {
  const mgr = (await as(manager, 'GET', '/insight/inventory')).body;
  assert.strictEqual(mgr.seeCost, true);
  const tac = mgr.list.find(c => c.stockNumber === 'TAC9');
  assert.strictEqual(tac.cost, 31000);
  const pace = mgr.pacing.find(m => m.model === 'Toyota Tacoma');
  assert.deepStrictEqual([pace.inStock, pace.sold30], [1, 2]);
  assert.strictEqual(pace.daysSupply, Math.round(1 / (2 / 90)), 'in stock ÷ daily sales over 90 days');
  const noCost = (await as(fi, 'GET', '/insight/inventory')).body;
  assert.strictEqual(noCost.seeCost, false);
  assert.ok(!('cost' in noCost.list[0]) && !('value' in noCost), 'F&I sees the list without cost');
});

test('marketing: ZIP codes and age ranges -- never the birthdate', async () => {
  const m = (await as(manager, 'GET', '/insight/marketing')).body;
  assert.strictEqual(m.byZip.find(z => z.zip === '85001').units, 2);
  assert.ok(m.byAge.find(a => a.band === '35-44'), '1990 birthday');
  assert.ok(m.byAge.find(a => a.band === '65+'), '1960 birthday');
  assert.ok(!JSON.stringify(m).includes('1990-05-01'), 'no birthdates in the report');
  const t = (await as(manager, 'GET', '/insight/trend')).body;
  assert.strictEqual(t.months.length, 12);
  assert.strictEqual(t.months.at(-1).units, 3);
});

test('store summary: gross by department, expenses from the books, net, absorption -- GM only', async () => {
  assert.strictEqual((await as(manager, 'GET', '/insight/store')).status, 403, 'whole-store net is for the GM');
  const today = new Date().toISOString().slice(0, 10);
  // Rent and a sales commission go on the books this month.
  await ok(as(admin, 'POST', '/accounting/entries', { date: today, memo: 'Rent', lines: [{ account: '6500', debit: 5000 }, { account: '1000', credit: 5000 }] }));
  await ok(as(admin, 'POST', '/accounting/entries', { date: today, memo: 'Ads', lines: [{ account: '6210', debit: 1000 }, { account: '1000', credit: 1000 }] }));
  const s = (await as(admin, 'GET', '/insight/store')).body;
  assert.strictEqual(s.expensesFrom, 'books');
  const used = s.rows.find(r => r.key === 'used'), admin_ = s.rows.find(r => r.key === '');
  assert.strictEqual(used.gross, (34000 - 30000) + (30000 - 28000));
  assert.strictEqual(used.expenses, 1000);
  assert.strictEqual(used.net, used.gross - 1000);
  assert.strictEqual(admin_.expenses, 5000);
  assert.strictEqual(s.total.net, Math.round((s.total.gross - 6000) * 100) / 100);
});

test('service & parts: ROs, effective labor rate, tech productivity, open RO aging', async () => {
  const svc = await h.createUser('service_manager');
  const advisor = await h.createUser('service_advisor');
  const tech = await h.createUser('technician');
  assert.strictEqual((await as(manager, 'GET', '/insight/fixed')).status, 403);
  const lead = await ok(as(admin, 'POST', '/leads', { name: 'Fix Ops', source: 'phone' }));
  const ro = await ok(as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2019', make: 'Ford', model: 'F-150' },
    jobs: [{ concern: 'Brakes', payType: 'customer', hours: 2, techId: tech.id, parts: [{ description: 'Pads', qty: 1, cost: 40, price: 100 }] }] }));
  await ok(as(advisor, 'POST', `/service/ros/${ro.id}/close`));
  await ok(as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2020', make: 'Kia', model: 'Soul' }, jobs: [{ concern: 'Noise' }] }));
  const f = (await as(svc, 'GET', '/insight/fixed')).body;
  assert.strictEqual(f.ros, 1);
  const cp = f.byType.find(x => x.type === 'customer');
  assert.deepStrictEqual([cp.hours, cp.elr], [2, 150]);
  assert.strictEqual(f.techs.find(x => x.id === String(tech.id)).flagged, 2);
  assert.strictEqual(f.advisors.find(x => x.id === String(advisor.id)).ros, 1);
  assert.strictEqual(f.open.length, 1);
  assert.strictEqual(f.open[0].days, 0);
});

test('expenses & cash: averages by account and what is owed to the store -- for whoever reads the books', async () => {
  assert.strictEqual((await as(manager, 'GET', '/insight/expenses')).status, 403);
  const e = (await as(admin, 'GET', '/insight/expenses')).body;
  const rent = e.lines.find(l => l.number === '6500');
  assert.deepStrictEqual([rent.mtd, rent.avg3, rent.vs3], [5000, 0, 5000]);
  assert.strictEqual(e.months.length, 3);
  assert.ok(e.schedules.some(x => x.key === 'cit'));
  assert.ok(e.unbooked.length >= 3, 'delivered deals not booked yet');
});

test('Insight is its own app at /insight (signed in only)', async () => {
  assert.strictEqual((await h.page('/insight', manager.cookie)).status, 200);
  const out = await h.page('/insight');
  assert.notStrictEqual(out.status, 200, 'not without signing in');
});

test('heartbeat: today on the floor', async () => {
  const b = (await as(manager, 'GET', '/insight/heartbeat')).body;
  assert.strictEqual(b.sold, 3, 'all three sold today');
  assert.ok(b.ups >= 3);
  const one = b.people.find(p => p.id === String(sales.id));
  assert.strictEqual(one.sold, 1.5);
  assert.strictEqual((await as(sales, 'GET', '/insight/heartbeat')).status, 403);
});

test('people & goals: managers set goals; each person against theirs', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.strictEqual((await as(fi, 'PUT', '/insight/goals', { month, goals: {} })).status, 403, 'goals are set by sales management');
  await ok(as(manager, 'PUT', '/insight/goals', { month, goals: { [sales.id]: { units: 10, gross: 30000 } } }));
  const p = (await as(manager, 'GET', `/insight/people?month=${month}`)).body;
  const one = p.people.find(x => x.id === String(sales.id));
  assert.deepStrictEqual([one.goal.units, one.goal.gross, one.units, one.toGoal.units], [10, 30000, 1.5, 15]);
  assert.ok(p.canSetGoals);
});

test('parts inventory: value, turns, what is not moving', async () => {
  const svc = await h.createUser('service_manager');
  const pm = await h.createUser('parts_manager');
  const part = await ok(as(pm, 'POST', '/parts', { number: 'SLOW-1', description: 'Slow mover', cost: 10, price: 20 }));
  await ok(as(pm, 'POST', `/parts/${part.id}/receive`, { qty: 5, cost: 10 }));
  assert.strictEqual((await as(manager, 'GET', '/insight/parts')).status, 403);
  const r = (await as(svc, 'GET', '/insight/parts')).body;
  assert.ok(r.value >= 50);
  assert.ok(r.idle[0].skus >= 1, 'never sold: not moving');
});
