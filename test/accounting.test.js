// Tests for Accounting Domus: the chart of accounts, automatic posting
// (cars, deals, ROs, parts), schedules, the cashier, payables, the bank
// reconciliation, statements, closing a month, and who can do what.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('accounting tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');

let admin, office, gm, sales, advisor, partsMgr, tech;
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
const ok = async (p, status = [200, 201]) => { const r = await p; assert.ok([].concat(status).includes(r.status), `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

// Everything the books hold for one schedule account, by control #.
async function schedule(number) { return (await as(office, 'GET', `/accounting/schedules/${number}`)).body; }
async function balanceOf(number) { return (await as(office, 'GET', '/accounting/accounts')).body.accounts.find(a => a.number === number).balance; }
async function trialBalanced() {
  const tb = (await as(office, 'GET', '/accounting/trial-balance')).body;
  assert.ok(tb.balanced, `trial balance off: debits ${tb.debits} credits ${tb.credits}`);
  const bs = (await as(office, 'GET', '/accounting/balance-sheet')).body;
  assert.ok(bs.balanced, `balance sheet off by ${bs.difference}`);
}

before(async () => {
  await h.startServer();
  admin = await h.createUser('admin');
  office = await h.createUser('accounting');
  gm = await h.createUser('general_manager');
  sales = await h.createUser('salesperson');
  advisor = await h.createUser('service_advisor');
  partsMgr = await h.createUser('parts_manager');
  tech = await h.createUser('technician');
});
after(() => h.stopServer());

test('who sees and keeps the books', async () => {
  assert.strictEqual((await as(sales, 'GET', '/accounting/overview')).status, 403);
  assert.strictEqual((await as(gm, 'GET', '/accounting/overview')).status, 200, 'the GM can read the books');
  assert.strictEqual((await as(gm, 'POST', '/accounting/receipts', { account: '1100', amount: 1 })).status, 403, '...but not post to them');
  const chart = (await as(office, 'GET', '/accounting/accounts')).body;
  assert.ok(chart.accounts.length > 80, 'a full dealership chart of accounts is set up');
  assert.ok(chart.accounts.some(a => a.number === '1100' && a.name === 'Contracts in transit' && a.scheduled));
});

test('cars into stock: new cars are floor planned, used cars owed to the seller; edits follow', async () => {
  const newCar = await ok(as(admin, 'POST', '/cars', { make: 'Toyota', model: 'Camry', year: 2027, price: 32000, cost: 28000, stockType: 'new', stockNumber: 'N100' }));
  const used = await ok(as(admin, 'POST', '/cars', { make: 'Honda', model: 'Civic', year: 2021, price: 21000, cost: 17000, stockType: 'used', stockNumber: 'U200' }));
  assert.strictEqual((await schedule('1200')).items.find(i => i.control === 'N100').balance, 28000);
  assert.strictEqual((await schedule('2200')).items.find(i => i.control === 'N100').balance, 28000, 'floor plan owed');
  assert.strictEqual((await schedule('2010')).items.find(i => i.control === 'U200').balance, 17000, 'owed for the used car');
  // A cost change by hand, and a new stock number.
  await ok(as(admin, 'PUT', `/cars/${used.id}`, { cost: 17500, stockNumber: 'U201' }));
  const inv = await schedule('1210');
  assert.ok(!inv.items.some(i => i.control === 'U200'), 'old stock # moved');
  assert.strictEqual(inv.items.find(i => i.control === 'U201').balance, 17500);
  assert.deepStrictEqual((await as(office, 'GET', '/accounting/inventory-check')).body.filter(x => ['U201', 'N100'].includes(x.stockNumber)), [], 'books match the cars');
  await trialBalanced();
  return newCar;
});

let deal, dealNumber, lead;
test('booking a deal: sale, trade, F&I, tax, fees, payoff, contract in transit, cost, floor plan payoff', async () => {
  lead = await ok(as(admin, 'POST', '/leads', { name: 'Ada Buyer', phone: '6025551111', source: 'website' }));
  const car = (await as(admin, 'GET', '/cars')).body.find(c => c.stockNumber === 'N100');
  deal = await ok(as(admin, 'POST', '/deals', { carId: car.id, leadId: lead.id }));
  dealNumber = deal.dealNumber;
  deal = await ok(as(admin, 'PUT', `/deals/${deal.id}`, {
    dealType: 'retail', lender: 'Ally Financial', vehiclePrice: 31000, docFee: 499, taxRate: 8, state: 'CA', downPayment: 2000,
    titleFee: 25, registrationFee: 300, gapPremium: 900, servicePremium: 2000, fiProductCost: 1100, reserve: 650,
    trades: [{ year: '2018', make: 'Ford', model: 'Escape', allowance: 10000, payoff: 4000 }]
  }));
  assert.strictEqual((await as(office, 'GET', '/accounting/unbooked')).body.deals.length, 0, 'not delivered yet: nothing to book');
  deal = await ok(as(admin, 'PUT', `/deals/${deal.id}`, { status: 'delivered' }));
  // The trade went into used inventory at its value, through trade-in clearing.
  assert.strictEqual((await schedule('2300')).items.find(i => i.control === `D-${dealNumber}`).balance, 10000);
  const unbooked = (await as(office, 'GET', '/accounting/unbooked')).body;
  assert.deepStrictEqual(unbooked.deals.map(d => d.dealNumber), [dealNumber]);

  const preview = (await as(office, 'GET', `/accounting/deals/${deal.id}/preview`)).body;
  const credits = preview.lines.reduce((s, l) => s + l.credit, 0), debits = preview.lines.reduce((s, l) => s + l.debit, 0);
  assert.strictEqual(Math.round(credits * 100), Math.round(debits * 100), 'the entry balances');
  const line = num => preview.lines.filter(l => l.account === num).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.strictEqual(line('4000'), -31000, 'new vehicle sale');
  assert.strictEqual(line('4210'), -900, 'GAP');
  assert.strictEqual(line('2020'), -4000, 'payoff owed on the trade');
  assert.strictEqual(Math.round(line('1100') * 100) / 100, deal.amountFinanced, 'contract in transit = amount financed');
  assert.strictEqual(line('1110'), 2000, 'down payment');
  assert.strictEqual(line('5000'), 28000, 'the car\'s cost');
  assert.strictEqual(line('2200'), 28000, 'floor plan paid off');

  assert.strictEqual((await as(gm, 'POST', `/accounting/deals/${deal.id}/book`)).status, 403);
  const booked = await ok(as(office, 'POST', `/accounting/deals/${deal.id}/book`));
  assert.ok(booked.entry.entryNumber >= 1001);
  assert.strictEqual((await as(office, 'POST', `/accounting/deals/${deal.id}/book`)).status, 400, 'only once');
  assert.ok(!(await schedule('1200')).items.some(i => i.control === 'N100'), 'out of new inventory');
  assert.ok(!(await schedule('2200')).items.some(i => i.control === 'N100'), 'floor plan paid');
  assert.ok(!(await schedule('2300')).items.some(i => i.control === `D-${dealNumber}`), 'trade-in clearing cleared');
  const cit = (await schedule('1100')).items.find(i => i.control === `D-${dealNumber}`);
  assert.strictEqual(cit.balance, deal.amountFinanced);
  assert.match(cit.name, /Ally Financial/);
  assert.strictEqual((await schedule('1130')).items.find(i => i.control === 'ALLY FINANCIAL').balance, 650, 'reserve owed by the lender');
  await trialBalanced();

  const st = (await as(office, 'GET', '/accounting/statement')).body;
  assert.strictEqual(st.units.new, 1);
  const fi = st.depts.find(d => d.key === 'fi');
  assert.strictEqual(fi.gross.month, 900 + 2000 + 650 - 1100, 'F&I gross: products + reserve - cost');
});

test('cashier: the lender funds the contract, the payoff is paid by check; unbook and rebook', async () => {
  const before = await balanceOf('1000');
  await ok(as(office, 'POST', '/accounting/receipts', { account: '1100', control: `D-${dealNumber}`, from: 'Ally Financial', amount: deal.amountFinanced, method: 'ach' }));
  assert.ok(!(await schedule('1100')).items.some(i => i.control === `D-${dealNumber}`), 'contract funded');
  const pay = await ok(as(office, 'POST', '/accounting/payments', { account: '2020', control: `D-${dealNumber}`, payee: 'Ford Credit', amount: 4000 }));
  assert.ok(pay.checkNumber >= 10001);
  assert.strictEqual(Math.round((await balanceOf('1000') - before) * 100) / 100, Math.round((deal.amountFinanced - 4000) * 100) / 100);
  assert.strictEqual((await as(office, 'POST', '/accounting/receipts', { account: '1000', amount: 5 })).status, 400, 'not into the bank account itself');

  // Unbooking needs a reason and puts it back on the list.
  assert.strictEqual((await as(office, 'POST', `/accounting/deals/${deal.id}/unbook`, {})).status, 400);
  await ok(as(office, 'POST', `/accounting/deals/${deal.id}/unbook`, { reason: 'Wrong lender' }));
  assert.ok((await as(office, 'GET', '/accounting/unbooked')).body.deals.some(d => d.id === deal.id));
  const entry = (await as(office, 'GET', `/accounting/entries?source=${deal.id}`)).body.find(e => e.reversedBy);
  assert.strictEqual((await as(office, 'POST', `/accounting/entries/${entry.id}/reverse`)).status, 400, 'already reversed');
  await ok(as(office, 'POST', `/accounting/deals/${deal.id}/book`));
  await trialBalanced();
});

test('service and parts post themselves: RO, counter ticket, parts received and counted', async () => {
  const filter = await ok(as(partsMgr, 'POST', '/parts', { number: 'OF-1', description: 'Oil filter', cost: 5, price: 12, vendor: 'OEM Parts Co' }));
  await ok(as(partsMgr, 'POST', `/parts/${filter.id}/receive`, { qty: 10, cost: 5, invoice: 'INV-9' }));
  assert.strictEqual(await balanceOf('1240'), 50);
  assert.strictEqual((await schedule('2000')).items.find(i => i.control === 'OEM PARTS CO').balance, 50, 'owed to the vendor');
  await ok(as(partsMgr, 'POST', `/parts/${filter.id}/adjust`, { qty: -1, reason: 'Damaged' }));
  assert.strictEqual(await balanceOf('1240'), 45);

  const ro = await ok(as(advisor, 'POST', '/service/ros', { leadId: lead.id, vehicle: { year: '2020', make: 'Ford', model: 'F-150', mileageIn: 40000 },
    jobs: [{ concern: 'Oil change', payType: 'customer', hours: 1, techId: tech.id, parts: [{ partId: filter.id, number: 'OF-1', qty: 1, cost: 5, price: 12 }] }] }));
  const closed = await ok(as(advisor, 'POST', `/service/ros/${ro.id}/close`));
  const ar = (await schedule('1150')).items.find(i => i.control === `RO-${ro.roNumber}`);
  assert.strictEqual(ar.balance, closed.closedTotals.customerTotal, 'the customer owes the RO total');
  assert.strictEqual(await balanceOf('1240'), 40, 'the filter came off the shelf');

  const ticket = await ok(as(partsMgr, 'POST', '/parts/tickets', { customerName: 'Walk-in buyer', saleType: 'retail', lines: [{ partId: filter.id, qty: 2, cost: 5, price: 12 }] }));
  const tclosed = await ok(as(partsMgr, 'POST', `/parts/tickets/${ticket.id}/close`));
  assert.strictEqual((await schedule('1150')).items.find(i => i.control === `P-${ticket.ticketNumber}`).balance, tclosed.totals.total);
  const st = (await as(office, 'GET', '/accounting/statement')).body;
  assert.ok(st.depts.find(d => d.key === 'service').sales.month >= closed.closedTotals.customer.labor);
  assert.strictEqual(st.depts.find(d => d.key === 'parts').lines.find(l => l.number === '4530').month, 24);
  await trialBalanced();
});

test('payables: vendors, bills to expense accounts, paying them, no duplicate invoices, voiding', async () => {
  const v = await ok(as(office, 'POST', '/accounting/vendors', { name: 'Desert Properties', terms: 10 }));
  const bill = await ok(as(office, 'POST', '/accounting/bills', { vendorId: v.id, invoice: 'R-10', date: '2026-10-01', lines: [{ account: '6500', amount: 8000, memo: 'October rent' }] }));
  assert.strictEqual(bill.dueDate, '2026-10-11', 'due by the vendor\'s terms');
  assert.strictEqual((await as(office, 'POST', '/accounting/bills', { vendorId: v.id, invoice: 'R-10', date: '2026-10-01', lines: [{ account: '6500', amount: 8000 }] })).status, 400, 'same invoice twice');
  assert.strictEqual((await as(office, 'GET', '/accounting/vendors')).body.find(x => x.id === v.id).open, 8000);
  const paid = await ok(as(office, 'POST', `/accounting/bills/${bill.id}/pay`, { amount: 3000 }));
  assert.strictEqual(paid.bill.status, 'open');
  const done = await ok(as(office, 'POST', `/accounting/bills/${bill.id}/pay`, {}));
  assert.strictEqual(done.bill.status, 'paid');
  assert.strictEqual((await as(office, 'POST', `/accounting/bills/${bill.id}/void`)).status, 400, 'paid bills stay');
  const extra = await ok(as(office, 'POST', '/accounting/bills', { vendorId: v.id, invoice: 'R-11', date: '2026-10-02', lines: [{ account: '6510', amount: 400 }] }));
  await ok(as(office, 'POST', `/accounting/bills/${extra.id}/void`));
  assert.ok(!(await schedule('2000')).items.some(i => i.control === 'DESERT PROPERTIES'), 'nothing owed to the landlord');
  await trialBalanced();
});

test('journal entries: must balance, can be reversed; closed months take nothing', async () => {
  assert.strictEqual((await as(office, 'POST', '/accounting/entries', { date: '2026-10-05', lines: [{ account: '6540', debit: 100 }, { account: '1000', credit: 90 }] })).status, 400, 'unbalanced');
  const e = await ok(as(office, 'POST', '/accounting/entries', { date: '2026-10-05', memo: 'Office supplies paid by card', lines: [{ account: '6540', debit: 100 }, { account: '1000', credit: 100 }] }));
  const rev = await ok(as(office, 'POST', `/accounting/entries/${e.id}/reverse`, {}));
  assert.ok(rev.entryNumber > e.entryNumber);
  // Close September; nothing can be dated in it anymore.
  assert.strictEqual((await as(gm, 'POST', '/accounting/close', { month: '2026-09' })).status, 403);
  const cur = (await as(office, 'GET', '/accounting/settings')).body.currentMonth;
  assert.strictEqual((await as(office, 'POST', '/accounting/close', { month: cur })).status, 400, 'not the month we are in');
  await ok(as(office, 'POST', '/accounting/close', { month: '2026-09' }));
  const blocked = await as(office, 'POST', '/accounting/entries', { date: '2026-09-15', lines: [{ account: '6540', debit: 1 }, { account: '1000', credit: 1 }] });
  assert.strictEqual(blocked.status, 400);
  assert.match(blocked.body.error, /closed/);
  assert.strictEqual((await as(office, 'POST', '/accounting/reopen', { month: '2026-09' })).status, 400, 'needs a reason');
  await ok(as(office, 'POST', '/accounting/reopen', { month: '2026-09', reason: 'Late invoice' }));
  await ok(as(office, 'POST', '/accounting/entries', { date: '2026-09-15', lines: [{ account: '6540', debit: 1 }, { account: '1000', credit: 1 }] }));
  await trialBalanced();
});

test('bank reconciliation: the statement balance has to equal what clears', async () => {
  const bank = (await as(office, 'GET', '/accounting/bank?account=1000')).body;
  assert.ok(bank.open.length > 2);
  const pick = bank.open.slice(0, 2);
  const cleared = Math.round(pick.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const off = await as(office, 'POST', '/accounting/bank/reconcile', { account: '1000', statementDate: bank.through, statementBalance: cleared + 1, lines: pick.map(l => l.id) });
  assert.strictEqual(off.status, 400);
  assert.match(off.body.error, /Off by/);
  await ok(as(office, 'POST', '/accounting/bank/reconcile', { account: '1000', statementDate: bank.through, statementBalance: cleared, lines: pick.map(l => l.id) }));
  const after = (await as(office, 'GET', '/accounting/bank?account=1000')).body;
  assert.strictEqual(after.clearedBalance, cleared);
  assert.strictEqual(after.open.length, bank.open.length - 2);
});

test('starting balances bring cars and parts already on hand onto the books; wholesale; titles', async () => {
  // A car that got in without the books (demo data, or from before the books started).
  const id = require('crypto').randomUUID();
  const dealershipId = (await h.store.pool.query('SELECT id FROM dealerships LIMIT 1')).rows[0].id;
  await h.store.insert(h.store.pool, 'cars', dealershipId, { id, make: 'Mazda', model: 'CX-5', year: 2019, stockNumber: 'W300', cost: 12000, price: 0, status: 'available', stockType: 'used', soldAs: 'retail', photos: [], openROs: [], dateAdded: new Date().toISOString() });
  const missing = (await as(office, 'GET', '/accounting/inventory-check')).body;
  assert.ok(missing.some(x => x.stockNumber === 'W300' && x.difference === 12000));
  const start = await ok(as(office, 'POST', '/accounting/starting-balances'));
  assert.strictEqual(start.carsFixed, missing.filter(x => x.carId).length, 'every car the books were missing (the sample cars too)');
  assert.deepStrictEqual((await as(office, 'GET', '/accounting/inventory-check')).body, []);
  assert.strictEqual((await ok(as(office, 'POST', '/accounting/starting-balances'))).entry, null, 'nothing left to add');

  // It's wholesaled at auction.
  await ok(as(admin, 'PUT', `/cars/${id}`, { status: 'sold', soldAs: 'wholesale', wholesalePrice: 11000 }));
  assert.ok((await as(office, 'GET', '/accounting/unbooked')).body.wholesale.some(c => c.id === id));
  await ok(as(office, 'POST', `/accounting/wholesale/${id}/book`, { buyer: 'Metro Auction' }));
  assert.strictEqual((await schedule('1140')).items.find(i => i.control === 'W300').balance, 11000);
  assert.ok(!(await schedule('1210')).items.some(i => i.control === 'W300'));

  // Title tracking on the delivered deal with a trade and a payoff.
  const titles = (await as(office, 'GET', '/accounting/titles')).body;
  const row = titles.find(t => t.id === deal.id);
  assert.deepStrictEqual(row.needs, ['tradeTitleReceived', 'payoffSent', 'lienReleased', 'dmvSubmitted', 'platesIssued', 'titleMailed']);
  await ok(as(office, 'PUT', `/accounting/titles/${deal.id}`, Object.fromEntries(row.needs.map(f => [f, '2026-10-06']))));
  assert.ok(!(await as(office, 'GET', '/accounting/titles')).body.some(t => t.id === deal.id), 'complete: off the list');
  assert.strictEqual((await as(sales, 'PUT', `/deals/${deal.id}`, { booked: null, titleTracking: {} })).status, 200);
  const d = (await as(admin, 'GET', `/deals/${deal.id}`)).body;
  assert.ok(d.booked && d.titleTracking.dmvSubmitted, "accounting marks can't be changed from the deal");
  await trialBalanced();
});

test('chart of accounts: add, rename; automatic accounts stay active; overview', async () => {
  assert.strictEqual((await as(gm, 'POST', '/accounting/accounts', { number: '6905', name: 'Donations', type: 'expense' })).status, 403);
  await ok(as(office, 'POST', '/accounting/accounts', { number: '6905', name: 'Donations', type: 'expense', dept: '', grp: 'semi_fixed' }));
  assert.strictEqual((await as(office, 'POST', '/accounting/accounts', { number: '6905', name: 'Again', type: 'expense' })).status, 400);
  await ok(as(office, 'PUT', '/accounting/accounts/6905', { name: 'Charitable donations' }));
  assert.strictEqual((await as(office, 'PUT', '/accounting/accounts/1100', { active: false })).status, 400);
  const o = (await as(office, 'GET', '/accounting/overview')).body;
  assert.strictEqual(o.unbooked.count, 0);
  assert.ok(o.inventory.used > 0);
  assert.strictEqual(typeof o.month_.net, 'number');
});
