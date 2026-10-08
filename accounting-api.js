// accounting-api.js -- Accounting Domus routes: the office's screens.
//
//   overview          what needs doing: unbooked deals, contracts in transit
//                     waiting, bills due, cash, this month's net
//   book deals        sold-not-booked deals and wholesale cars, chargebacks;
//                     preview the entry, book, unbook
//   cashier           money in (payments on receivables, deposits) and out
//                     (checks and payments against what's owed)
//   payables          vendors, their bills, paying them
//   schedules         every scheduled account item by item, with aging
//   journal / ledger  every entry; account detail with running balance
//   statements        financial statement by department, balance sheet,
//                     trial balance
//   bank              reconcile the bank statement
//   titles            title and registration tracking on delivered deals
//   setup             chart of accounts, month-end close, starting balances

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const acct = require('./accounting');
const postings = require('./postings');
const { n, round2, text, money, BooksError } = acct;

const router = express.Router();
const allow = auth.requirePermission;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof BooksError) return res.status(err.status).json({ error: err.message });
  next(err);
});
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

router.use('/accounting', allow('viewAccounting'));

// ---------- Reading the ledger ----------

// Signed balance per account (+ debit) for lines dated in [from, to].
async function balances(q, dealershipId, from, to) {
  const { rows } = await q.query(
    `SELECT account, sum(amount) AS bal FROM journal_lines
     WHERE dealership_id = $1 AND ($2::date IS NULL OR posted_on >= $2) AND ($3::date IS NULL OR posted_on <= $3)
     GROUP BY account`, [dealershipId, from || null, to || null]);
  return new Map(rows.map(r => [r.account, round2(r.bal)]));
}
const natural = (a, signed) => round2(acct.DEBIT_NORMAL.has(a.type) ? signed : -signed); // shown as a positive normal balance
const yearStart = month => `${month.slice(0, 4)}-01-01`;
const shiftMonth = (month, d) => { const [y, m] = month.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`; };
async function thisMonth(q, dealershipId) { const cfg = await acct.settingsOf(q, dealershipId); return acct.monthOf(acct.localDay(null, cfg.tz)); }
async function pickMonth(q, req) { return MONTH.test(req.query.month || '') ? req.query.month : thisMonth(q, req.dealershipId); }

// ---------- Financial statements ----------

// Income statement by department: this month, year to date, and the same
// month / YTD a year ago.
async function incomeStatement(q, dealershipId, month) {
  const accounts = (await acct.chartOf(q, dealershipId)).filter(a => ['income', 'cogs', 'expense'].includes(a.type));
  const ly = shiftMonth(month, -12);
  const [m, ytd, lym, lyytd] = await Promise.all([
    balances(q, dealershipId, `${month}-01`, acct.monthEnd(month)), balances(q, dealershipId, yearStart(month), acct.monthEnd(month)),
    balances(q, dealershipId, `${ly}-01`, acct.monthEnd(ly)), balances(q, dealershipId, yearStart(ly), acct.monthEnd(ly))
  ]);
  const cols = ['month', 'ytd', 'lyMonth', 'lyYtd'];
  const src = { month: m, ytd, lyMonth: lym, lyYtd: lyytd };
  const zero = () => Object.fromEntries(cols.map(c => [c, 0]));
  const depts = Object.entries(acct.DEPTS).map(([key, label]) => ({ key, label, sales: zero(), cost: zero(), gross: zero(), expenses: zero(), net: zero(), lines: [] }));
  const byKey = new Map(depts.map(d => [d.key, d]));
  for (const a of accounts) {
    const d = byKey.get(a.dept) || byKey.get('');
    const vals = Object.fromEntries(cols.map(c => [c, natural(a, src[c].get(a.number) || 0)]));
    if (cols.every(c => !vals[c]) && !a.active) continue;
    d.lines.push({ number: a.number, name: a.name, type: a.type, grp: a.grp, ...vals });
    for (const c of cols) {
      if (a.type === 'income') d.sales[c] += vals[c];
      else if (a.type === 'cogs') d.cost[c] += vals[c];
      else d.expenses[c] += vals[c];
    }
  }
  const total = { key: 'total', label: 'Total store', sales: zero(), cost: zero(), gross: zero(), expenses: zero(), net: zero() };
  for (const d of depts) {
    for (const c of cols) {
      d.gross[c] = round2(d.sales[c] - d.cost[c]); d.net[c] = round2(d.gross[c] - d.expenses[c]);
      for (const k of ['sales', 'cost', 'gross', 'expenses', 'net']) { d[k][c] = round2(d[k][c]); total[k][c] = round2(total[k][c] + d[k][c]); }
    }
  }
  // Units booked this month, for gross per unit.
  const units = await unitsBooked(q, dealershipId, month);
  const g = k => (byKey.get(k) || {}).gross || zero();
  const fixedGross = round2(g('service').month + g('parts').month);
  const overhead = round2(accounts.filter(a => a.type === 'expense' && ['personnel', 'semi_fixed', 'fixed'].includes(a.grp)).reduce((s, a) => s + natural(a, m.get(a.number) || 0), 0));
  return {
    month, depts, total, units,
    keyNumbers: {
      newGrossPerUnit: units.new ? round2(g('new').month / units.new) : null,
      usedGrossPerUnit: units.used ? round2(g('used').month / units.used) : null,
      fiPerUnit: units.new + units.used ? round2(g('fi').month / (units.new + units.used)) : null,
      fixedAbsorption: overhead ? round2(fixedGross / overhead * 100) : null,
      expenseToGross: total.gross.month ? round2(total.expenses.month / total.gross.month * 100) : null,
      netToSales: total.sales.month ? round2(total.net.month / total.sales.month * 100) : null
    }
  };
}

async function unitsBooked(q, dealershipId, month) {
  const { rows } = await q.query(
    `SELECT a.system_key AS key, count(DISTINCT e.id) AS c FROM journal_entries e
     JOIN journal_lines l ON l.dealership_id = e.dealership_id AND l.entry_id = e.id
     JOIN gl_accounts a ON a.dealership_id = l.dealership_id AND a.number = l.account
     WHERE e.dealership_id = $1 AND e.source_type IN ('deal', 'wholesale') AND e.reverses IS NULL AND e.reversed_by IS NULL
       AND e.posted_on BETWEEN $2 AND $3 AND a.system_key IN ('sale_new', 'sale_used', 'sale_wholesale')
     GROUP BY a.system_key`, [dealershipId, `${month}-01`, acct.monthEnd(month)]);
  const c = Object.fromEntries(rows.map(r => [r.key, Number(r.c)]));
  return { new: c.sale_new || 0, used: c.sale_used || 0, wholesale: c.sale_wholesale || 0 };
}

async function balanceSheet(q, dealershipId, month) {
  const accounts = await acct.chartOf(q, dealershipId);
  const end = acct.monthEnd(month);
  const [all, ytd] = await Promise.all([balances(q, dealershipId, null, end), balances(q, dealershipId, yearStart(month), end)]);
  const plAccounts = accounts.filter(a => ['income', 'cogs', 'expense'].includes(a.type));
  const netOf = map => round2(plAccounts.reduce((s, a) => s - (map.get(a.number) || 0), 0)); // income is credit (-)
  const currentYear = netOf(ytd);
  const priorYears = round2(netOf(all) - currentYear);
  const section = type => {
    const groups = new Map();
    for (const a of accounts.filter(x => x.type === type)) {
      const bal = natural(a, all.get(a.number) || 0);
      if (!bal && !a.active) continue;
      if (!groups.has(a.grp)) groups.set(a.grp, { grp: a.grp, label: acct.GROUP_LABELS[a.grp] || a.grp, total: 0, lines: [] });
      const gr = groups.get(a.grp);
      gr.lines.push({ number: a.number, name: a.name, balance: bal });
      gr.total = round2(gr.total + bal);
    }
    const list = [...groups.values()];
    return { groups: list, total: round2(list.reduce((s, x) => s + x.total, 0)) };
  };
  const assets = section('asset'), liabilities = section('liability'), equity = section('equity');
  equity.groups.push({ grp: 'earnings', label: 'Earnings', total: round2(priorYears + currentYear), lines: [
    { number: '', name: 'Prior years\' earnings not yet closed to retained earnings', balance: priorYears },
    { number: '', name: `Net income ${month.slice(0, 4)} to date`, balance: currentYear }
  ] });
  equity.total = round2(equity.total + priorYears + currentYear);
  return { month, asOf: end, assets, liabilities, equity, balanced: round2(assets.total - liabilities.total - equity.total) === 0, difference: round2(assets.total - liabilities.total - equity.total) };
}

async function trialBalance(q, dealershipId, month) {
  const accounts = await acct.chartOf(q, dealershipId);
  const end = acct.monthEnd(month);
  const [all, ytd, mtd] = await Promise.all([balances(q, dealershipId, null, end), balances(q, dealershipId, yearStart(month), end), balances(q, dealershipId, `${month}-01`, end)]);
  // Balance sheet accounts carry everything; income and expense accounts
  // start the year at zero, their earlier years rolled into retained earnings.
  const pl = a => ['income', 'cogs', 'expense'].includes(a.type);
  let priorPl = 0;
  for (const a of accounts.filter(pl)) priorPl += (all.get(a.number) || 0) - (ytd.get(a.number) || 0);
  const rows = accounts.map(a => {
    let bal = pl(a) ? (ytd.get(a.number) || 0) : (all.get(a.number) || 0);
    if (a.key === 'retained') bal += priorPl;
    bal = round2(bal);
    return { number: a.number, name: a.name, type: a.type, dept: a.dept, debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0, month: round2(mtd.get(a.number) || 0), active: a.active };
  }).filter(r => r.debit || r.credit || r.month || r.active);
  const debits = round2(rows.reduce((s, r) => s + r.debit, 0)), credits = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { month, asOf: end, rows, debits, credits, balanced: debits === credits };
}

router.get('/accounting/statement', wrap(async (req, res) => res.json(await incomeStatement(store.pool, req.dealershipId, await pickMonth(store.pool, req)))));
router.get('/accounting/balance-sheet', wrap(async (req, res) => res.json(await balanceSheet(store.pool, req.dealershipId, await pickMonth(store.pool, req)))));
router.get('/accounting/trial-balance', wrap(async (req, res) => res.json(await trialBalance(store.pool, req.dealershipId, await pickMonth(store.pool, req)))));

// ---------- Schedules ----------

const BUCKETS = [[0, 30, '0-30'], [31, 60, '31-60'], [61, 90, '61-90'], [91, Infinity, '90+']];
async function scheduleItems(q, dealershipId, account, asOf) {
  const { rows } = await q.query(
    `SELECT account, control, max(control_name) AS name, sum(amount) AS bal, min(posted_on) AS first, max(posted_on) AS last, count(*) AS lines
     FROM journal_lines WHERE dealership_id = $1 AND posted_on <= $2 AND ($3::text IS NULL OR account = $3)
     GROUP BY account, control HAVING round(sum(amount), 2) <> 0 ORDER BY min(posted_on)`, [dealershipId, asOf, account || null]);
  const today = new Date(`${asOf}T00:00:00Z`).getTime();
  return rows.map(r => {
    const first = acct.dayStr(r.first);
    const age = Math.max(0, Math.round((today - new Date(`${first}T00:00:00Z`).getTime()) / 86400000));
    return { account: r.account, control: r.control, name: r.name || '', balance: round2(r.bal), first, last: acct.dayStr(r.last), age, bucket: BUCKETS.find(b => age >= b[0] && age <= b[1])[2], lines: Number(r.lines) };
  });
}

router.get('/accounting/schedules', wrap(async (req, res) => {
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const asOf = acct.isDay(req.query.asOf) ? req.query.asOf : acct.localDay(null, cfg.tz);
  const accounts = (await acct.chartOf(store.pool, req.dealershipId)).filter(a => a.scheduled);
  const items = await scheduleItems(store.pool, req.dealershipId, null, asOf);
  res.json({
    asOf, schedules: accounts.map(a => {
      const mine = items.filter(i => i.account === a.number);
      const buckets = Object.fromEntries(BUCKETS.map(b => [b[2], round2(mine.filter(i => i.bucket === b[2]).reduce((s, i) => s + natural(a, i.balance), 0))]));
      return { number: a.number, name: a.name, type: a.type, key: a.key, items: mine.length, total: round2(mine.reduce((s, i) => s + natural(a, i.balance), 0)), buckets, oldest: mine.length ? Math.max(...mine.map(i => i.age)) : 0 };
    })
  });
}));

router.get('/accounting/schedules/:account', wrap(async (req, res) => {
  const a = (await acct.chartOf(store.pool, req.dealershipId)).find(x => x.number === req.params.account);
  if (!a) return res.status(404).json({ error: 'Account not found.' });
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const asOf = acct.isDay(req.query.asOf) ? req.query.asOf : acct.localDay(null, cfg.tz);
  const items = (await scheduleItems(store.pool, req.dealershipId, a.number, asOf)).map(i => ({ ...i, balance: natural(a, i.balance) }));
  res.json({ account: a, asOf, items, total: round2(items.reduce((s, i) => s + i.balance, 0)), buckets: BUCKETS.map(b => ({ label: b[2], total: round2(items.filter(i => i.bucket === b[2]).reduce((s, i) => s + i.balance, 0)) })) });
}));

// ---------- Journal and ledger ----------

async function entryLines(q, dealershipId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await q.query(
    `SELECT l.entry_id, l.line_no, l.account, a.name AS account_name, l.amount, l.control, l.control_name, l.memo, l.cleared_in
     FROM journal_lines l LEFT JOIN gl_accounts a ON a.dealership_id = l.dealership_id AND a.number = l.account
     WHERE l.dealership_id = $1 AND l.entry_id = ANY($2) ORDER BY l.line_no`, [dealershipId, ids]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.entry_id)) out.set(r.entry_id, []);
    const amt = round2(r.amount);
    out.get(r.entry_id).push({ lineNo: r.line_no, account: r.account, accountName: r.account_name || '', debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, control: r.control, controlName: r.control_name, memo: r.memo, cleared: !!r.cleared_in });
  }
  return out;
}
const presentEntry = (e, lines) => ({
  id: e.id, entryNumber: e.entry_number, journal: e.journal, journalLabel: acct.JOURNALS[e.journal] || e.journal, postedOn: acct.dayStr(e.posted_on), memo: e.memo,
  sourceType: e.source_type, sourceId: e.source_id, reverses: e.reverses, reversedBy: e.reversed_by, createdBy: e.created_by, createdAt: e.created_at,
  lines: lines || [], total: round2((lines || []).reduce((s, l) => s + l.debit, 0))
});

router.get('/accounting/entries', wrap(async (req, res) => {
  const where = ['e.dealership_id = $1'], args = [req.dealershipId];
  if (acct.isDay(req.query.from)) { args.push(req.query.from); where.push(`e.posted_on >= $${args.length}`); }
  if (acct.isDay(req.query.to)) { args.push(req.query.to); where.push(`e.posted_on <= $${args.length}`); }
  if (acct.JOURNALS[req.query.journal]) { args.push(req.query.journal); where.push(`e.journal = $${args.length}`); }
  if (req.query.source) { args.push(String(req.query.source)); where.push(`e.source_id = $${args.length}`); }
  const search = text(req.query.q, 60);
  if (search) {
    args.push(`%${search.toLowerCase()}%`);
    const num = Number(search.replace(/^J-/i, ''));
    where.push(`(lower(e.memo) LIKE $${args.length} OR EXISTS (SELECT 1 FROM journal_lines l WHERE l.dealership_id = e.dealership_id AND l.entry_id = e.id AND (lower(l.control) LIKE $${args.length} OR lower(l.control_name) LIKE $${args.length}))${Number.isInteger(num) && num > 0 ? ` OR e.entry_number = ${num}` : ''})`);
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const { rows } = await store.pool.query(`SELECT e.* FROM journal_entries e WHERE ${where.join(' AND ')} ORDER BY e.posted_on DESC, e.entry_number DESC LIMIT ${limit}`, args);
  const lines = await entryLines(store.pool, req.dealershipId, rows.map(r => r.id));
  res.json(rows.map(e => presentEntry(e, lines.get(e.id))));
}));

router.get('/accounting/entries/:id', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT * FROM journal_entries WHERE dealership_id = $1 AND (id = $2 OR entry_number::text = $2)', [req.dealershipId, String(req.params.id).replace(/^J-/i, '')]);
  if (!rows[0]) return res.status(404).json({ error: 'Entry not found.' });
  const lines = await entryLines(store.pool, req.dealershipId, [rows[0].id]);
  res.json(presentEntry(rows[0], lines.get(rows[0].id)));
}));

// A journal entry typed in by the office.
router.post('/accounting/entries', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 200).map(l => ({
    account: text(l.account, 20), amount: round2(money(l.debit) - money(l.credit)), control: l.control, controlName: l.controlName, memo: l.memo
  })).filter(l => l.account && l.amount);
  if (lines.length < 2) return res.status(400).json({ error: 'An entry needs at least two lines with amounts.' });
  if (!acct.isDay(b.date)) return res.status(400).json({ error: 'Pick the date for this entry.' });
  const entry = await store.tx(async q => {
    const e = await acct.postEntry(q, req, { journal: acct.JOURNALS[b.journal] ? b.journal : 'general', date: b.date, memo: b.memo, lines, manual: true });
    await audit.record(q, req, { action: 'create', entityType: 'journal_entry', entityId: e.id, label: `J-${e.entryNumber}`, details: text(b.memo, 200) || 'Journal entry' });
    return e;
  });
  res.status(201).json(entry);
}));

const OWN_SCREENS = { deal: 'Unbook it from Book Deals instead.', wholesale: 'This is a wholesale booking.', bill: 'Void the bill from Payables instead.' };
router.post('/accounting/entries/:id/reverse', allow('postAccounting'), wrap(async (req, res) => {
  const rev = await store.tx(async q => {
    const { rows } = await q.query('SELECT * FROM journal_entries WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.id]);
    if (!rows[0]) throw new BooksError('Entry not found.', 404);
    if (OWN_SCREENS[rows[0].source_type] && !rows[0].reverses) throw new BooksError(OWN_SCREENS[rows[0].source_type]);
    const r = await acct.reverseEntry(q, req, req.params.id, text((req.body || {}).memo, 200));
    await audit.record(q, req, { action: 'update', entityType: 'journal_entry', entityId: req.params.id, label: `J-${rows[0].entry_number}`, details: `Reversed by J-${r.entryNumber}` });
    return r;
  });
  res.status(201).json(rev);
}));

// One account's lines with a running balance (optionally one control #).
router.get('/accounting/ledger', wrap(async (req, res) => {
  const a = (await acct.chartOf(store.pool, req.dealershipId)).find(x => x.number === String(req.query.account || ''));
  if (!a) return res.status(404).json({ error: 'Pick an account.' });
  const month = await thisMonth(store.pool, req.dealershipId);
  const from = acct.isDay(req.query.from) ? req.query.from : `${month}-01`;
  const to = acct.isDay(req.query.to) ? req.query.to : acct.monthEnd(month);
  const control = req.query.control !== undefined ? String(req.query.control) : null;
  const args = [req.dealershipId, a.number, from, to, control];
  const { rows: open } = await store.pool.query(
    `SELECT coalesce(sum(amount), 0) AS bal FROM journal_lines WHERE dealership_id = $1 AND account = $2 AND posted_on < $3 AND ($4::text IS NULL OR control = $4)`, [req.dealershipId, a.number, from, control]);
  const { rows } = await store.pool.query(
    `SELECT l.*, e.entry_number, e.journal, e.memo AS entry_memo, e.source_type, e.source_id FROM journal_lines l
     JOIN journal_entries e ON e.dealership_id = l.dealership_id AND e.id = l.entry_id
     WHERE l.dealership_id = $1 AND l.account = $2 AND l.posted_on BETWEEN $3 AND $4 AND ($5::text IS NULL OR l.control = $5)
     ORDER BY l.posted_on, e.entry_number, l.line_no`, args);
  let run = round2(open[0].bal);
  const opening = natural(a, run);
  const lines = rows.map(r => {
    const amt = round2(r.amount); run = round2(run + amt);
    return { entryId: r.entry_id, entryNumber: r.entry_number, journal: r.journal, date: acct.dayStr(r.posted_on), memo: r.memo || r.entry_memo, control: r.control, controlName: r.control_name, debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, balance: natural(a, run), sourceType: r.source_type, sourceId: r.source_id };
  });
  res.json({ account: a, from, to, control, opening, closing: natural(a, run), lines });
}));

// ---------- Book deals ----------

router.get('/accounting/unbooked', wrap(async (req, res) => {
  const [deals, cars, leads] = await Promise.all([store.list(store.pool, 'deals', req.dealershipId), store.list(store.pool, 'cars', req.dealershipId), store.list(store.pool, 'leads', req.dealershipId)]);
  const carById = new Map(cars.map(c => [c.id, c])), leadById = new Map(leads.map(l => [l.id, l]));
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const today = acct.localDay(null, cfg.tz);
  const days = iso => (iso ? Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${acct.localDay(iso, cfg.tz)}T00:00:00Z`)) / 86400000)) : 0);
  const row = d => {
    const car = carById.get(d.carId) || {};
    return {
      id: d.id, dealNumber: d.dealNumber, status: d.status, customer: (leadById.get(d.leadId) || {}).name || d.buyerName || '--',
      vehicle: postings.carName(car), stockNumber: car.id ? postings.stockControl(car) : '', type: postings.carType(car),
      dealType: d.dealType || 'retail', lender: d.lender || '', deliveredAt: d.deliveredAt, days: days(d.deliveredAt),
      price: n(d.vehiclePrice), amountFinanced: n(d.amountFinanced), booked: d.booked || null
    };
  };
  const sold = deals.filter(d => postings.SOLD.includes(d.status));
  res.json({
    deals: sold.filter(d => !d.booked).map(row).sort((a, b) => b.days - a.days),
    recentlyBooked: sold.filter(d => d.booked).sort((a, b) => String(b.booked.at).localeCompare(String(a.booked.at))).slice(0, 25).map(row),
    // Edited after it was booked: the books may not match the deal anymore.
    changedSinceBooked: sold.filter(d => d.booked && d.dateUpdated && d.dateUpdated > d.booked.at).map(row),
    wholesale: cars.filter(c => c.status === 'sold' && c.soldAs === 'wholesale' && !c.wholesaleBooked).map(c => ({
      id: c.id, stockNumber: postings.stockControl(c), vehicle: postings.carName(c), cost: n(c.cost), price: n(c.wholesalePrice), buyer: c.wholesaleBuyer || '', soldAt: c.dateSold, days: days(c.dateSold)
    })),
    chargebacks: deals.filter(d => d.booked && n(d.chargebackAmount) && (!d.chargebackPosted || round2(d.chargebackPosted.amount) !== round2(Math.abs(n(d.chargebackAmount))))).map(d => ({
      ...row(d), chargeback: Math.abs(n(d.chargebackAmount)), posted: d.chargebackPosted ? n(d.chargebackPosted.amount) : 0, chargebackDate: d.chargebackDate
    })),
    autoBookFinalized: cfg.autoBookFinalized
  });
}));

const namedLines = async (q, dealershipId, lines) => {
  const accounts = await acct.chartOf(q, dealershipId);
  const byKey = new Map(accounts.map(a => [a.key, a])), byNumber = new Map(accounts.map(a => [a.number, a]));
  return lines.map(l => {
    const a = l.account ? byNumber.get(String(l.account)) : byKey.get(l.key);
    const amt = round2(l.amount);
    return { account: a ? a.number : '', accountName: a ? a.name : l.key, debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, control: l.control || '', controlName: l.controlName || '', memo: l.memo || '' };
  });
};

router.get('/accounting/deals/:id/preview', wrap(async (req, res) => {
  const deal = await store.get(store.pool, 'deals', req.dealershipId, req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found.' });
  const built = await postings.dealLines(store.pool, req.dealershipId, deal);
  const lines = await namedLines(store.pool, req.dealershipId, built.lines);
  res.json({ dealNumber: deal.dealNumber, memo: built.memo, date: built.date, warnings: built.warnings, lines, total: round2(lines.reduce((s, l) => s + l.debit, 0)), booked: deal.booked || null });
}));

router.post('/accounting/deals/:id/book', allow('postAccounting'), wrap(async (req, res) => {
  const out = await store.tx(async q => {
    const r = await postings.bookDeal(q, req, req.params.id);
    await audit.record(q, req, { action: 'update', entityType: 'deal', entityId: req.params.id, label: r.entry.memo.split(' ')[0], details: `Booked: J-${r.entry.entryNumber}` });
    return r;
  });
  res.status(201).json(out);
}));

router.post('/accounting/deals/:id/unbook', allow('postAccounting'), wrap(async (req, res) => {
  const reason = text((req.body || {}).reason, 200);
  if (!reason) return res.status(400).json({ error: 'Say why it is being unbooked.' });
  const rev = await store.tx(async q => {
    const r = await postings.unbookDeal(q, req, req.params.id, reason);
    await audit.record(q, req, { action: 'update', entityType: 'deal', entityId: req.params.id, label: 'Deal', details: `Unbooked (J-${r.entryNumber}): ${reason}` });
    return r;
  });
  res.status(201).json(rev);
}));

router.post('/accounting/wholesale/:carId/book', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const entry = await store.tx(async q => {
    const e = await postings.bookWholesale(q, req, req.params.carId, { price: b.price, buyer: text(b.buyer, 120) });
    await audit.record(q, req, { action: 'update', entityType: 'car', entityId: req.params.carId, label: 'Wholesale', details: `Booked: J-${e.entryNumber}` });
    return e;
  });
  res.status(201).json(entry);
}));

router.post('/accounting/deals/:id/chargeback', allow('postAccounting'), wrap(async (req, res) => {
  const entry = await store.tx(q => postings.postChargeback(q, req, req.params.id));
  res.status(201).json(entry);
}));

// ---------- Cashier: money in and out ----------

const METHODS = ['cash', 'check', 'card', 'ach', 'wire'];
async function findAccount(q, dealershipId, number) {
  const a = (await acct.chartOf(q, dealershipId)).find(x => x.number === String(number || ''));
  if (!a) throw new BooksError('Pick an account.');
  if (!a.active) throw new BooksError(`Account ${a.number} is inactive.`);
  return a;
}
async function nextCheck(q, dealershipId) {
  const { rows } = await q.query('UPDATE dealerships SET next_check_number = next_check_number + 1 WHERE id = $1 RETURNING next_check_number - 1 AS n', [dealershipId]);
  return rows[0].n;
}

// Money in: a payment on something owed to the store (a contract in
// transit funding, a customer's down payment, an RO), or a deposit.
router.post('/accounting/receipts', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount received.' });
  const method = METHODS.includes(b.method) ? b.method : 'check';
  const entry = await store.tx(async q => {
    const a = await findAccount(q, req.dealershipId, b.account);
    if (a.key === 'cash') throw new BooksError('Pick what the money is for, not the bank account.');
    const from = text(b.from || b.controlName, 120);
    const memo = `Received ${method}${b.reference ? ` #${text(b.reference, 30)}` : ''}${from ? ` from ${from}` : ''}${b.memo ? ` -- ${text(b.memo, 120)}` : ''}`;
    const e = await acct.postEntry(q, req, {
      journal: 'cash', date: acct.isDay(b.date) ? b.date : null, memo, sourceType: 'receipt', manual: acct.isDay(b.date),
      lines: [
        { key: 'cash', amount, memo: `${method}${b.reference ? ` #${text(b.reference, 30)}` : ''}${from ? ` from ${from}` : ''}` },
        { account: a.number, amount: -amount, control: text(b.control, 40), controlName: from, memo: text(b.memo, 120) }
      ]
    });
    await audit.record(q, req, { action: 'create', entityType: 'receipt', entityId: e.id, label: `J-${e.entryNumber}`, details: memo });
    return e;
  });
  res.status(201).json(entry);
}));

// Money out: paying something the store owes (a trade payoff, the DMV, an
// F&I product company, a vendor, commissions...) by check or otherwise.
router.post('/accounting/payments', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount paid.' });
  const payee = text(b.payee || b.controlName, 120);
  if (!payee) return res.status(400).json({ error: 'Who is it paid to?' });
  const method = METHODS.includes(b.method) ? b.method : 'check';
  const out = await store.tx(async q => {
    const a = await findAccount(q, req.dealershipId, b.account);
    if (a.key === 'cash') throw new BooksError('Pick what is being paid, not the bank account.');
    const checkNumber = method === 'check' ? (Number(b.checkNumber) > 0 ? Number(b.checkNumber) : await nextCheck(q, req.dealershipId)) : null;
    const how = checkNumber ? `Check #${checkNumber}` : method.toUpperCase();
    const e = await acct.postEntry(q, req, {
      journal: 'disbursements', date: acct.isDay(b.date) ? b.date : null, memo: `${how} to ${payee}${b.memo ? ` -- ${text(b.memo, 120)}` : ''}`, sourceType: 'payment', manual: acct.isDay(b.date),
      lines: [
        { account: a.number, amount, control: text(b.control, 40), controlName: payee, memo: text(b.memo, 120) },
        { key: 'cash', amount: -amount, memo: `${how} ${payee}` }
      ]
    });
    await audit.record(q, req, { action: 'create', entityType: 'payment', entityId: e.id, label: `J-${e.entryNumber}`, details: e.memo });
    return { ...e, checkNumber };
  });
  res.status(201).json(out);
}));

// ---------- Payables: vendors and bills ----------

const cleanVendor = (b, before = {}) => ({
  ...before, name: text(b.name ?? before.name, 120), contact: text(b.contact ?? before.contact, 80), phone: text(b.phone ?? before.phone, 30),
  email: text(b.email ?? before.email, 120), address: text(b.address ?? before.address, 200), terms: Math.max(0, Math.min(180, Math.round(n(b.terms ?? before.terms ?? 30)))),
  defaultAccount: text(b.defaultAccount ?? before.defaultAccount, 20), notes: text(b.notes ?? before.notes, 500),
  active: b.active === undefined ? before.active !== false : b.active !== false && b.active !== 'false'
});
const vendorControl = name => String(name).toUpperCase().slice(0, 40);

router.get('/accounting/vendors', wrap(async (req, res) => {
  const [vendors, bills] = await Promise.all([store.list(store.pool, 'vendors', req.dealershipId), store.list(store.pool, 'ap_bills', req.dealershipId)]);
  res.json(vendors.map(v => ({ ...v, open: round2(bills.filter(b => b.vendorId === v.id && b.status === 'open').reduce((s, b) => s + n(b.total) - n(b.paid), 0)) })).sort((a, b) => a.name.localeCompare(b.name)));
}));
router.post('/accounting/vendors', allow('postAccounting'), wrap(async (req, res) => {
  const v = { id: crypto.randomUUID(), ...cleanVendor(req.body || {}), createdAt: new Date().toISOString() };
  if (!v.name) return res.status(400).json({ error: 'Vendor name is required.' });
  await store.tx(async q => { await store.insert(q, 'vendors', req.dealershipId, v); await audit.created(q, req, 'vendor', v); });
  res.status(201).json(v);
}));
router.put('/accounting/vendors/:id', allow('postAccounting'), wrap(async (req, res) => {
  const saved = await store.tx(async q => {
    const v = await store.get(q, 'vendors', req.dealershipId, req.params.id, { forUpdate: true });
    if (!v) return null;
    const next = cleanVendor(req.body || {}, v);
    if (!next.name) throw new BooksError('Vendor name is required.');
    const s = await store.save(q, 'vendors', req.dealershipId, v.id, next);
    await audit.updated(q, req, 'vendor', v, s);
    return s;
  });
  if (!saved) return res.status(404).json({ error: 'Vendor not found.' });
  res.json(saved);
}));

router.get('/accounting/bills', wrap(async (req, res) => {
  const bills = await store.list(store.pool, 'ap_bills', req.dealershipId);
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const today = acct.localDay(null, cfg.tz);
  const status = ['open', 'paid', 'void'].includes(req.query.status) ? req.query.status : null;
  res.json(bills.filter(b => !status || b.status === status).map(b => ({ ...b, balance: round2(n(b.total) - n(b.paid)), overdue: b.status === 'open' && b.dueDate < today }))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))));
}));

// A vendor's bill: what it was for goes to its expense (or other) accounts,
// and it's owed to the vendor until paid.
router.post('/accounting/bills', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 50).map(l => ({ account: text(l.account, 20), amount: money(l.amount), memo: text(l.memo, 120), control: text(l.control, 40) })).filter(l => l.account && l.amount);
  if (!lines.length) return res.status(400).json({ error: 'Add what the bill is for and the amount.' });
  if (!acct.isDay(b.date)) return res.status(400).json({ error: 'Pick the bill date.' });
  const bill = await store.tx(async q => {
    const vendor = await store.get(q, 'vendors', req.dealershipId, String(b.vendorId || ''));
    if (!vendor) throw new BooksError('Pick the vendor.');
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));
    if (!(total > 0)) throw new BooksError('The bill total has to be more than zero.');
    const invoice = text(b.invoice, 40);
    const dupe = (await store.list(q, 'ap_bills', req.dealershipId)).find(x => x.vendorId === vendor.id && invoice && x.invoice === invoice && x.status !== 'void');
    if (dupe) throw new BooksError(`Invoice ${invoice} from ${vendor.name} was already entered.`);
    const due = acct.isDay(b.dueDate) ? b.dueDate : new Date(Date.parse(`${b.date}T00:00:00Z`) + n(vendor.terms) * 86400000).toISOString().slice(0, 10);
    const id = crypto.randomUUID();
    const e = await acct.postEntry(q, req, {
      journal: 'payables', date: b.date, manual: true, memo: `Bill ${invoice ? `#${invoice} ` : ''}from ${vendor.name}${b.memo ? ` -- ${text(b.memo, 120)}` : ''}`, sourceType: 'bill', sourceId: id,
      lines: [...lines.map(l => ({ account: l.account, amount: l.amount, memo: l.memo, control: l.control })), { key: 'ap', amount: -total, control: vendorControl(vendor.name), controlName: vendor.name, memo: invoice ? `Invoice ${invoice}` : '' }]
    });
    const made = { id, vendorId: vendor.id, vendorName: vendor.name, invoice, date: b.date, dueDate: due, memo: text(b.memo, 200), lines, total, paid: 0, payments: [], status: 'open', entryId: e.id, entryNumber: e.entryNumber, createdAt: new Date().toISOString() };
    await store.insert(q, 'ap_bills', req.dealershipId, made);
    await audit.created(q, req, 'bill', made);
    return made;
  });
  res.status(201).json(bill);
}));

router.post('/accounting/bills/:id/pay', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await store.tx(async q => {
    const bill = await store.get(q, 'ap_bills', req.dealershipId, req.params.id, { forUpdate: true });
    if (!bill) throw new BooksError('Bill not found.', 404);
    if (bill.status !== 'open') throw new BooksError('This bill is not open.');
    const owed = round2(n(bill.total) - n(bill.paid));
    const amount = b.amount === undefined || b.amount === '' ? owed : money(b.amount);
    if (!(amount > 0) || amount > owed) throw new BooksError(`Pay between 0.01 and ${owed.toFixed(2)}.`);
    const method = METHODS.includes(b.method) ? b.method : 'check';
    const checkNumber = method === 'check' ? (Number(b.checkNumber) > 0 ? Number(b.checkNumber) : await nextCheck(q, req.dealershipId)) : null;
    const how = checkNumber ? `Check #${checkNumber}` : method.toUpperCase();
    const e = await acct.postEntry(q, req, {
      journal: 'disbursements', date: acct.isDay(b.date) ? b.date : null, manual: acct.isDay(b.date), memo: `${how} to ${bill.vendorName}${bill.invoice ? ` -- invoice ${bill.invoice}` : ''}`, sourceType: 'bill_payment', sourceId: bill.id,
      lines: [{ key: 'ap', amount, control: vendorControl(bill.vendorName), controlName: bill.vendorName, memo: bill.invoice ? `Invoice ${bill.invoice}` : '' }, { key: 'cash', amount: -amount, memo: `${how} ${bill.vendorName}` }]
    });
    const paid = round2(n(bill.paid) + amount);
    const next = { ...bill, paid, status: paid >= n(bill.total) ? 'paid' : 'open', payments: [...(bill.payments || []), { entryId: e.id, entryNumber: e.entryNumber, amount, method, checkNumber, date: e.postedOn }] };
    await store.save(q, 'ap_bills', req.dealershipId, bill.id, next);
    await audit.updated(q, req, 'bill', bill, next, how);
    return { bill: next, checkNumber, entry: e };
  });
  res.status(201).json(out);
}));

router.post('/accounting/bills/:id/void', allow('postAccounting'), wrap(async (req, res) => {
  const saved = await store.tx(async q => {
    const bill = await store.get(q, 'ap_bills', req.dealershipId, req.params.id, { forUpdate: true });
    if (!bill) throw new BooksError('Bill not found.', 404);
    if (bill.status !== 'open' || n(bill.paid)) throw new BooksError('Only an unpaid bill can be voided.');
    const rev = await acct.reverseEntry(q, req, bill.entryId, `Voided bill ${bill.invoice ? `#${bill.invoice} ` : ''}from ${bill.vendorName}`);
    const next = { ...bill, status: 'void', voidedBy: rev.id, voidedAt: new Date().toISOString() };
    await store.save(q, 'ap_bills', req.dealershipId, bill.id, next);
    await audit.updated(q, req, 'bill', bill, next, 'Voided');
    return next;
  });
  res.json(saved);
}));

// ---------- Bank reconciliation ----------

router.get('/accounting/bank', wrap(async (req, res) => {
  const accounts = await acct.chartOf(store.pool, req.dealershipId);
  const a = accounts.find(x => x.number === String(req.query.account || '')) || accounts.find(x => x.key === 'cash');
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const through = acct.isDay(req.query.through) ? req.query.through : acct.localDay(null, cfg.tz);
  const { rows: [bal] } = await store.pool.query(
    `SELECT coalesce(sum(amount), 0) AS book, coalesce(sum(amount) FILTER (WHERE cleared_in <> ''), 0) AS cleared
     FROM journal_lines WHERE dealership_id = $1 AND account = $2 AND posted_on <= $3`, [req.dealershipId, a.number, through]);
  const { rows } = await store.pool.query(
    `SELECT l.entry_id, l.line_no, l.amount, l.posted_on, l.memo, l.control_name, e.entry_number, e.memo AS entry_memo FROM journal_lines l
     JOIN journal_entries e ON e.dealership_id = l.dealership_id AND e.id = l.entry_id
     WHERE l.dealership_id = $1 AND l.account = $2 AND l.cleared_in = '' AND l.posted_on <= $3 ORDER BY l.posted_on, e.entry_number`, [req.dealershipId, a.number, through]);
  const recs = (await store.list(store.pool, 'bank_recs', req.dealershipId)).filter(r => r.account === a.number).sort((x, y) => String(y.statementDate).localeCompare(String(x.statementDate)));
  res.json({
    account: { number: a.number, name: a.name }, through, bookBalance: round2(bal.book), clearedBalance: round2(bal.cleared),
    open: rows.map(r => ({ id: `${r.entry_id}:${r.line_no}`, entryNumber: r.entry_number, date: acct.dayStr(r.posted_on), memo: r.memo || r.entry_memo, payee: r.control_name, amount: round2(r.amount) })),
    lastRec: recs[0] || null, history: recs.slice(0, 24)
  });
}));

router.post('/accounting/bank/reconcile', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!acct.isDay(b.statementDate)) return res.status(400).json({ error: 'Enter the statement date.' });
  const statementBalance = money(b.statementBalance);
  const ids = (Array.isArray(b.lines) ? b.lines : []).map(String).filter(x => /^[\w-]+:\d+$/.test(x)).slice(0, 5000);
  const rec = await store.tx(async q => {
    const a = await findAccount(q, req.dealershipId, b.account);
    const { rows: [bal] } = await q.query(`SELECT coalesce(sum(amount) FILTER (WHERE cleared_in <> ''), 0) AS cleared FROM journal_lines WHERE dealership_id = $1 AND account = $2`, [req.dealershipId, a.number]);
    let clearing = 0;
    const pairs = [];
    for (const id of ids) {
      const [entryId, lineNo] = id.split(':');
      const { rows } = await q.query(`SELECT amount FROM journal_lines WHERE dealership_id = $1 AND entry_id = $2 AND line_no = $3 AND account = $4 AND cleared_in = '' AND posted_on <= $5 FOR UPDATE`, [req.dealershipId, entryId, Number(lineNo), a.number, b.statementDate]);
      if (!rows[0]) throw new BooksError('One of the items picked is already cleared or is not on this account.');
      clearing += n(rows[0].amount); pairs.push([entryId, Number(lineNo)]);
    }
    const difference = round2(statementBalance - (n(bal.cleared) + clearing));
    if (difference) throw new BooksError(`Off by ${difference.toFixed(2)}: the statement balance has to equal everything cleared.`);
    const id = crypto.randomUUID();
    for (const [entryId, lineNo] of pairs) await q.query('UPDATE journal_lines SET cleared_in = $4 WHERE dealership_id = $1 AND entry_id = $2 AND line_no = $3', [req.dealershipId, entryId, lineNo, id]);
    const made = { id, account: a.number, statementDate: b.statementDate, statementBalance, cleared: pairs.length, clearedAmount: round2(clearing), at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name } };
    await store.insert(q, 'bank_recs', req.dealershipId, made);
    await audit.record(q, req, { action: 'create', entityType: 'bank_rec', entityId: id, label: `Bank ${a.number} ${b.statementDate}`, details: `${pairs.length} items cleared; statement ${statementBalance.toFixed(2)}` });
    return made;
  });
  res.status(201).json(rec);
}));

// ---------- Title tracking ----------

const TITLE_FIELDS = ['tradeTitleReceived', 'payoffSent', 'lienReleased', 'dmvSubmitted', 'platesIssued', 'titleMailed'];
router.get('/accounting/titles', wrap(async (req, res) => {
  const [deals, leads, cars] = await Promise.all([store.list(store.pool, 'deals', req.dealershipId), store.list(store.pool, 'leads', req.dealershipId), store.list(store.pool, 'cars', req.dealershipId)]);
  const leadById = new Map(leads.map(l => [l.id, l])), carById = new Map(cars.map(c => [c.id, c]));
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const today = acct.localDay(null, cfg.tz);
  const list = deals.filter(d => postings.SOLD.includes(d.status)).map(d => {
    const t = d.titleTracking || {};
    // A trade needs its title in; a trade with a loan needs the payoff sent and the lien released.
    const needs = TITLE_FIELDS.filter(f => {
      if (f === 'tradeTitleReceived') return !!d.hasTrade;
      if (f === 'payoffSent' || f === 'lienReleased') return !!d.hasTrade && n(d.tradeInPayoff) > 0;
      return true;
    });
    const done = needs.filter(f => t[f]);
    const car = carById.get(d.carId) || {};
    return {
      id: d.id, dealNumber: d.dealNumber, customer: (leadById.get(d.leadId) || {}).name || '--', vehicle: postings.carName(car), stockNumber: car.id ? postings.stockControl(car) : '',
      hasTrade: !!d.hasTrade, payoff: n(d.tradeInPayoff), deliveredAt: d.deliveredAt,
      days: d.deliveredAt ? Math.max(0, Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${acct.localDay(d.deliveredAt, cfg.tz)}T00:00:00Z`)) / 86400000)) : 0,
      tracking: t, needs, complete: done.length === needs.length
    };
  });
  res.json(list.filter(x => req.query.all === '1' || !x.complete).sort((a, b) => b.days - a.days));
}));

router.put('/accounting/titles/:dealId', allow('postAccounting'), wrap(async (req, res) => {
  const b = req.body || {};
  const saved = await store.tx(async q => {
    const deal = await store.get(q, 'deals', req.dealershipId, req.params.dealId, { forUpdate: true });
    if (!deal) return null;
    const t = { ...(deal.titleTracking || {}) };
    for (const f of TITLE_FIELDS) if (f in b) t[f] = acct.isDay(b[f]) ? b[f] : '';
    if ('notes' in b) t.notes = text(b.notes, 500);
    const next = await store.save(q, 'deals', req.dealershipId, deal.id, { ...deal, titleTracking: t });
    await audit.updated(q, req, 'deal', { id: deal.id, dealNumber: deal.dealNumber, titleTracking: deal.titleTracking || {} }, { id: deal.id, dealNumber: deal.dealNumber, titleTracking: t }, 'Title tracking');
    return next.titleTracking;
  });
  if (!saved) return res.status(404).json({ error: 'Deal not found.' });
  res.json(saved);
}));

// ---------- Setup: chart, settings, close, starting balances ----------

router.get('/accounting/accounts', wrap(async (req, res) => {
  const accounts = await acct.chartOf(store.pool, req.dealershipId);
  const all = await balances(store.pool, req.dealershipId, null, null);
  res.json({ accounts: accounts.map(a => ({ ...a, balance: natural(a, all.get(a.number) || 0) })), types: acct.TYPES, depts: acct.DEPTS, groups: acct.GROUP_LABELS, journals: acct.JOURNALS });
}));

router.post('/accounting/accounts', allow('closeBooks'), wrap(async (req, res) => {
  const b = req.body || {};
  const number = text(b.number, 12);
  if (!/^[0-9A-Za-z.-]{2,12}$/.test(number)) return res.status(400).json({ error: 'Account numbers are 2-12 letters or digits.' });
  if (!acct.TYPES.includes(b.type)) return res.status(400).json({ error: 'Pick the account type.' });
  if (!text(b.name, 120)) return res.status(400).json({ error: 'Name the account.' });
  const made = await store.tx(async q => {
    await acct.ensureChart(q, req.dealershipId);
    const { rowCount } = await q.query(
      `INSERT INTO gl_accounts (dealership_id, number, name, type, dept, grp, scheduled) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [req.dealershipId, number, text(b.name, 120), b.type, acct.DEPTS[b.dept] !== undefined ? b.dept : '', text(b.grp, 30), !!b.scheduled]);
    if (!rowCount) throw new BooksError(`Account ${number} already exists.`);
    await audit.record(q, req, { action: 'create', entityType: 'gl_account', entityId: number, label: `${number} ${text(b.name, 120)}`, details: b.type });
    return (await acct.chartOf(q, req.dealershipId)).find(a => a.number === number);
  });
  res.status(201).json(made);
}));

router.put('/accounting/accounts/:number', allow('closeBooks'), wrap(async (req, res) => {
  const b = req.body || {};
  const saved = await store.tx(async q => {
    const a = (await acct.chartOf(q, req.dealershipId)).find(x => x.number === req.params.number);
    if (!a) throw new BooksError('Account not found.', 404);
    const next = {
      name: 'name' in b ? text(b.name, 120) || a.name : a.name,
      dept: 'dept' in b && acct.DEPTS[b.dept] !== undefined ? b.dept : a.dept,
      grp: 'grp' in b ? text(b.grp, 30) : a.grp,
      scheduled: 'scheduled' in b ? !!b.scheduled : a.scheduled,
      active: 'active' in b ? b.active !== false && b.active !== 'false' : a.active
    };
    if (!next.active && a.key) throw new BooksError('This account is used by automatic posting and has to stay active.');
    await q.query('UPDATE gl_accounts SET name = $3, dept = $4, grp = $5, scheduled = $6, active = $7 WHERE dealership_id = $1 AND number = $2',
      [req.dealershipId, a.number, next.name, next.dept, next.grp, next.scheduled, next.active]);
    await audit.updated(q, req, 'gl_account', { id: a.number, ...a }, { id: a.number, ...a, ...next });
    return { ...a, ...next };
  });
  res.json(saved);
}));

router.get('/accounting/settings', wrap(async (req, res) => {
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  const { rows } = await store.pool.query('SELECT next_check_number FROM dealerships WHERE id = $1', [req.dealershipId]);
  res.json({ closedThrough: cfg.closedThrough, autoBookFinalized: cfg.autoBookFinalized, startedOn: cfg.startedOn, nextCheckNumber: rows[0].next_check_number, currentMonth: await thisMonth(store.pool, req.dealershipId) });
}));

async function saveAccountingSettings(q, req, change, details) {
  const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
  const settings = rows[0].settings || {};
  const next = { ...(settings.accounting || {}), ...change };
  await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, accounting: next }]);
  await audit.record(q, req, { action: 'update', entityType: 'settings', entityId: 'accounting', label: 'Accounting', details });
  return next;
}

router.put('/accounting/settings', allow('closeBooks'), wrap(async (req, res) => {
  const b = req.body || {};
  await store.tx(async q => {
    if ('autoBookFinalized' in b) await saveAccountingSettings(q, req, { autoBookFinalized: b.autoBookFinalized === true }, `Book deals when finalized: ${b.autoBookFinalized === true ? 'on' : 'off'}`);
    if (Number(b.nextCheckNumber) > 0) await q.query('UPDATE dealerships SET next_check_number = $2 WHERE id = $1', [req.dealershipId, Math.round(Number(b.nextCheckNumber))]);
  });
  const cfg = await acct.settingsOf(store.pool, req.dealershipId);
  res.json({ closedThrough: cfg.closedThrough, autoBookFinalized: cfg.autoBookFinalized });
}));

// Close a month: nothing more posts into it (or anything before it).
router.post('/accounting/close', allow('closeBooks'), wrap(async (req, res) => {
  const month = String((req.body || {}).month || '');
  if (!MONTH.test(month)) return res.status(400).json({ error: 'Pick the month to close.' });
  const out = await store.tx(async q => {
    if (month >= await thisMonth(q, req.dealershipId)) throw new BooksError("A month can be closed once it's over.");
    const cfg = await acct.settingsOf(q, req.dealershipId);
    if (cfg.closedThrough && month <= cfg.closedThrough) throw new BooksError(`${month} is already closed.`);
    const tb = await trialBalance(q, req.dealershipId, month);
    if (!tb.balanced) throw new BooksError('The trial balance is out of balance; it has to balance before closing.');
    return saveAccountingSettings(q, req, { closedThrough: month }, `Closed through ${month}`);
  });
  res.json(out);
}));

router.post('/accounting/reopen', allow('closeBooks'), wrap(async (req, res) => {
  const month = String((req.body || {}).month || '');
  const reason = text((req.body || {}).reason, 200);
  if (!MONTH.test(month)) return res.status(400).json({ error: 'Pick the month to reopen.' });
  if (!reason) return res.status(400).json({ error: 'Say why the month is being reopened.' });
  const out = await store.tx(async q => {
    const cfg = await acct.settingsOf(q, req.dealershipId);
    if (!cfg.closedThrough || month > cfg.closedThrough) throw new BooksError(`${month} isn't closed.`);
    return saveAccountingSettings(q, req, { closedThrough: month === '0000-00' ? '' : shiftMonth(month, -1) }, `Reopened ${month}: ${reason}`);
  });
  res.json(out);
}));

// Which cars the books should hold: everything in stock, and sold cars
// until their deal (or wholesale) is booked.
function onBooksExpected(cars, deals) {
  const bookedCar = new Set(deals.filter(d => d.booked).map(d => d.carId));
  const soldOnDeal = new Set(deals.filter(d => postings.SOLD.includes(d.status)).map(d => d.carId));
  return car => {
    if (car.status !== 'sold') return true;
    if (car.soldAs === 'wholesale') return !car.wholesaleBooked;
    return soldOnDeal.has(car.id) && !bookedCar.has(car.id);
  };
}

// Cars and parts on hand that the books don't hold yet (from before the
// books started, or loaded as demo data) go on as starting balances, against
// opening balance equity. Safe to run again: it only adds the difference.
router.post('/accounting/starting-balances', allow('closeBooks'), wrap(async (req, res) => {
  const out = await store.tx(async q => {
    const [cars, parts, deals] = await Promise.all([store.list(q, 'cars', req.dealershipId), store.list(q, 'parts', req.dealershipId), store.list(q, 'deals', req.dealershipId)]);
    const expected = onBooksExpected(cars, deals);
    const lines = [];
    let carsFixed = 0;
    const want = cars.filter(expected);
    for (const car of want) {
      const key = `${postings.carType(car)}_inventory`;
      const diff = round2(n(car.cost) - await acct.controlBalance(q, req.dealershipId, key, postings.stockControl(car)));
      if (!diff) continue;
      carsFixed++;
      lines.push({ key, amount: diff, control: postings.stockControl(car), controlName: postings.carName(car) });
      lines.push({ key: 'opening', amount: -diff, memo: `#${postings.stockControl(car)}` });
    }
    const partsValue = round2(parts.filter(p => !p.inactive).reduce((s, p) => s + Math.max(0, n(p.onHand)) * n(p.cost), 0));
    const { rows } = await q.query(
      `SELECT coalesce(sum(l.amount), 0) AS bal FROM journal_lines l JOIN gl_accounts a ON a.dealership_id = l.dealership_id AND a.number = l.account
       WHERE l.dealership_id = $1 AND a.system_key = 'parts_inventory'`, [req.dealershipId]);
    const partsDiff = round2(partsValue - round2(rows[0].bal));
    if (partsDiff) lines.push({ key: 'parts_inventory', amount: partsDiff }, { key: 'opening', amount: -partsDiff, memo: 'Parts on hand' });
    const cfg = await acct.settingsOf(q, req.dealershipId);
    // Dated when the oldest of these cars came in, so deals booked in earlier
    // months find their car on the books (a closed month moves it forward).
    const oldest = want.map(c => c.dateAdded).filter(Boolean).sort()[0];
    const date = acct.isDay((req.body || {}).date) ? req.body.date : acct.localDay(oldest || null, cfg.tz);
    const entry = lines.length ? await acct.postEntry(q, req, { journal: 'general', date, memo: 'Starting balances: inventory on hand brought onto the books', sourceType: 'starting', lines }) : null;
    if (!cfg.startedOn) await saveAccountingSettings(q, req, { startedOn: acct.localDay(null, cfg.tz) }, 'Books started');
    return { entry, carsFixed, partsDiff };
  });
  res.status(201).json(out);
}));

// Cars whose cost and the books disagree.
router.get('/accounting/inventory-check', wrap(async (req, res) => {
  const cars = await store.list(store.pool, 'cars', req.dealershipId);
  const items = await scheduleItems(store.pool, req.dealershipId, null, '9999-12-31');
  const accounts = await acct.chartOf(store.pool, req.dealershipId);
  const inv = new Map(accounts.filter(a => ['new_inventory', 'used_inventory'].includes(a.key)).map(a => [a.number, a.key]));
  const onBooks = new Map(items.filter(i => inv.has(i.account)).map(i => [`${inv.get(i.account)}|${i.control}`, i.balance]));
  // A sold car stays on the books until its deal (or wholesale) is booked.
  const belongs = onBooksExpected(cars, await store.list(store.pool, 'deals', req.dealershipId));
  const out = [];
  const seen = new Set();
  for (const car of cars) {
    const sold = car.status === 'sold';
    const off = !belongs(car);
    const k = `${postings.carType(car)}_inventory|${postings.stockControl(car)}`;
    seen.add(k);
    const want = off ? 0 : round2(car.cost);
    const books = round2(onBooks.get(k) || 0);
    if (books !== want) out.push({ stockNumber: postings.stockControl(car), vehicle: `${postings.carName(car)}${sold && !off ? ' (sold, not booked)' : sold ? ' (sold)' : ''}`, cost: want, books, difference: round2(want - books), carId: car.id, sold });
  }
  for (const [k, bal] of onBooks) if (!seen.has(k)) out.push({ stockNumber: k.split('|')[1], vehicle: '(no car with this stock #)', cost: 0, books: bal, difference: -bal, carId: null });
  res.json(out);
}));

// ---------- Overview ----------

router.get('/accounting/overview', wrap(async (req, res) => {
  const q = store.pool;
  const cfg = await acct.settingsOf(q, req.dealershipId);
  const today = acct.localDay(null, cfg.tz);
  const month = acct.monthOf(today);
  const accounts = await acct.chartOf(q, req.dealershipId);
  const keyed = new Map(accounts.map(a => [a.key, a]));
  const all = await balances(q, req.dealershipId, null, today);
  const bal = key => { const a = keyed.get(key); return a ? natural(a, all.get(a.number) || 0) : 0; };
  const items = await scheduleItems(q, req.dealershipId, null, today);
  const citItems = items.filter(i => i.account === (keyed.get('cit') || {}).number);
  const [deals, cars, bills] = await Promise.all([store.list(q, 'deals', req.dealershipId), store.list(q, 'cars', req.dealershipId), store.list(q, 'ap_bills', req.dealershipId)]);
  const unbooked = deals.filter(d => postings.SOLD.includes(d.status) && !d.booked);
  const statement = await incomeStatement(q, req.dealershipId, month);
  const sum = keys => round2(keys.reduce((s, k) => s + bal(k), 0));
  res.json({
    today, month, closedThrough: cfg.closedThrough, startedOn: cfg.startedOn,
    cash: bal('cash') + bal('petty_cash'),
    cit: { total: bal('cit'), items: citItems.length, over10: citItems.filter(i => i.age > 10).length, oldest: citItems.length ? Math.max(...citItems.map(i => i.age)) : 0 },
    receivables: sum(['vehicle_ar', 'factory_ar', 'reserve_ar', 'wholesale_ar', 'service_ar', 'warranty_ar', 'other_ar']),
    inventory: { new: bal('new_inventory'), used: bal('used_inventory'), parts: bal('parts_inventory') },
    floorPlan: bal('floor_plan'),
    owed: sum(['ap', 'vehicle_ap', 'payoff_ap', 'fi_ap', 'dmv_ap', 'sales_tax', 'we_owe', 'deal_accrual', 'commissions_ap']),
    deposits: bal('deposits'),
    unbooked: { count: unbooked.length, wholesale: cars.filter(c => c.status === 'sold' && c.soldAs === 'wholesale' && !c.wholesaleBooked).length },
    bills: { open: bills.filter(b => b.status === 'open').length, due: round2(bills.filter(b => b.status === 'open').reduce((s, b) => s + n(b.total) - n(b.paid), 0)), overdue: bills.filter(b => b.status === 'open' && b.dueDate < today).length },
    suspense: bal('suspense'),
    month_: { gross: statement.total.gross.month, expenses: statement.total.expenses.month, net: statement.total.net.month, units: statement.units, keyNumbers: statement.keyNumbers }
  });
}));

module.exports = { router, incomeStatement, balanceSheet, trialBalance, balances, scheduleItems };
