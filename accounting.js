// accounting.js -- Accounting Domus: the store's books.
//
// A chart of accounts (set up with a standard dealership chart the store
// can rename and add to) and a general ledger of journal entries. Every
// entry balances: debits = credits. Lines are signed, + debit / - credit,
// and can carry a control number -- the stock #, deal #, RO #, vendor or
// lender the line is about. Accounts marked "scheduled" are tracked item by
// item through their control numbers (contracts in transit, receivables,
// floor plan, payoffs...): that's what schedules and their aging are.
//
// Most entries post themselves, in the same transaction as the work:
//   cars       stocked in (floor plan / purchase / trade), cost changes,
//              recon work done by vendors
//   service    a closed RO: labor, parts, supplies, tax -- and their cost
//   parts      a closed counter ticket; stock received from a vendor; counts
//   deals      "booked" by the office from the Book Deals screen: the
//              sale, trade, F&I, taxes, fees, payoff, rebates, contract in
//              transit, cost of the car, commissions, and the floor plan
//              payoff -- previewed before it's posted
// and the office enters the rest: cash receipts, bills and checks, and
// journal entries. Months are closed once they're final; nothing can post
// into a closed month (automatic entries land on the first open day).
// Nothing is ever deleted: a mistake is fixed by reversing the entry.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const hours = require('./hours');

const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const money = v => (v === '' || v === null || v === undefined ? 0 : round2(String(v).replace(/[$,\s]/g, '')));

const TYPES = ['asset', 'liability', 'equity', 'income', 'cogs', 'expense'];
const DEBIT_NORMAL = new Set(['asset', 'cogs', 'expense']);
const DEPTS = { new: 'New Vehicles', used: 'Used Vehicles', fi: 'F&I', service: 'Service', parts: 'Parts', '': 'Store / Admin' };
const JOURNALS = {
  sales: 'Vehicle sales', inventory: 'Vehicle inventory', service: 'Service', parts: 'Parts',
  cash: 'Cash receipts', disbursements: 'Checks & payments', payables: 'Payables', general: 'General journal'
};

// The standard chart: [number, name, type, department, group, scheduled, key].
// The key is how automatic posting finds an account, so the store can
// renumber or rename freely.
const CHART = [
  // Assets
  ['1000', 'Cash - operating account', 'asset', '', 'cash', false, 'cash'],
  ['1010', 'Cash - petty cash', 'asset', '', 'cash', false, 'petty_cash'],
  ['1100', 'Contracts in transit', 'asset', '', 'receivables', true, 'cit'],
  ['1110', 'Vehicle receivables - customers', 'asset', '', 'receivables', true, 'vehicle_ar'],
  ['1120', 'Factory rebates & incentives receivable', 'asset', '', 'receivables', true, 'factory_ar'],
  ['1130', 'Finance reserve receivable', 'asset', '', 'receivables', true, 'reserve_ar'],
  ['1140', 'Wholesale receivables', 'asset', '', 'receivables', true, 'wholesale_ar'],
  ['1150', 'Service & parts receivables', 'asset', '', 'receivables', true, 'service_ar'],
  ['1160', 'Warranty claims receivable', 'asset', '', 'receivables', true, 'warranty_ar'],
  ['1190', 'Other receivables', 'asset', '', 'receivables', true, 'other_ar'],
  ['1200', 'New vehicle inventory', 'asset', 'new', 'inventory', true, 'new_inventory'],
  ['1210', 'Used vehicle inventory', 'asset', 'used', 'inventory', true, 'used_inventory'],
  ['1240', 'Parts inventory', 'asset', 'parts', 'inventory', false, 'parts_inventory'],
  ['1300', 'Prepaid expenses', 'asset', '', 'other_current', false, 'prepaid'],
  ['1500', 'Furniture, fixtures & equipment', 'asset', '', 'fixed_assets', false, 'fixed_assets'],
  ['1510', 'Accumulated depreciation', 'asset', '', 'fixed_assets', false, 'accum_depreciation'],
  // Liabilities
  ['2000', 'Accounts payable - vendors', 'liability', '', 'current', true, 'ap'],
  ['2010', 'Vehicle purchases payable', 'liability', '', 'current', true, 'vehicle_ap'],
  ['2020', 'Trade payoffs payable', 'liability', '', 'current', true, 'payoff_ap'],
  ['2030', 'F&I products payable', 'liability', '', 'current', true, 'fi_ap'],
  ['2040', 'Title & registration fees payable', 'liability', '', 'current', true, 'dmv_ap'],
  ['2050', 'Sales tax payable', 'liability', '', 'current', false, 'sales_tax'],
  ['2060', 'Customer deposits', 'liability', '', 'current', true, 'deposits'],
  ['2070', 'We-owe accrued', 'liability', '', 'current', true, 'we_owe'],
  ['2080', 'Deal expenses accrued', 'liability', '', 'current', true, 'deal_accrual'],
  ['2090', 'Commissions payable', 'liability', '', 'current', true, 'commissions_ap'],
  ['2100', 'Accrued payroll', 'liability', '', 'current', false, 'payroll_ap'],
  ['2200', 'Floor plan payable', 'liability', '', 'floor_plan', true, 'floor_plan'],
  ['2300', 'Trade-in clearing', 'liability', '', 'current', true, 'trade_clearing'],
  ['2500', 'Notes payable - long term', 'liability', '', 'long_term', false, 'notes_payable'],
  ['2999', 'Suspense - to be researched', 'liability', '', 'current', true, 'suspense'],
  // Equity
  ['3000', "Owner's capital", 'equity', '', 'equity', false, 'capital'],
  ['3100', 'Retained earnings', 'equity', '', 'equity', false, 'retained'],
  ['3200', 'Opening balance equity', 'equity', '', 'equity', false, 'opening'],
  // Sales (income)
  ['4000', 'New vehicle sales - retail', 'income', 'new', 'vehicle', false, 'sale_new'],
  ['4050', 'New - doc & dealer fees', 'income', 'new', 'fees', false, 'fees_new'],
  ['4060', 'New - factory incentives', 'income', 'new', 'incentives', false, 'incentives_new'],
  ['4100', 'Used vehicle sales - retail', 'income', 'used', 'vehicle', false, 'sale_used'],
  ['4150', 'Used - doc & dealer fees', 'income', 'used', 'fees', false, 'fees_used'],
  ['4160', 'Used - incentives', 'income', 'used', 'incentives', false, 'incentives_used'],
  ['4190', 'Wholesale vehicle sales', 'income', 'used', 'wholesale', false, 'sale_wholesale'],
  ['4200', 'F&I - service contracts', 'income', 'fi', 'products', false, 'fi_service'],
  ['4210', 'F&I - GAP', 'income', 'fi', 'products', false, 'fi_gap'],
  ['4220', 'F&I - maintenance plans', 'income', 'fi', 'products', false, 'fi_maint'],
  ['4230', 'F&I - aftermarket & accessories', 'income', 'fi', 'products', false, 'fi_aftermarket'],
  ['4240', 'F&I - credit insurance', 'income', 'fi', 'products', false, 'fi_credit_ins'],
  ['4250', 'F&I - finance reserve', 'income', 'fi', 'reserve', false, 'fi_reserve'],
  ['4260', 'F&I - chargebacks', 'income', 'fi', 'chargebacks', false, 'fi_chargebacks'],
  ['4400', 'Service labor - customer pay', 'income', 'service', 'labor', false, 'labor_customer'],
  ['4410', 'Service labor - warranty', 'income', 'service', 'labor', false, 'labor_warranty'],
  ['4420', 'Service labor - internal', 'income', 'service', 'labor', false, 'labor_internal'],
  ['4430', 'Shop supplies', 'income', 'service', 'other', false, 'shop_supplies'],
  ['4500', 'Parts sales - customer pay', 'income', 'parts', 'parts', false, 'parts_customer'],
  ['4510', 'Parts sales - warranty', 'income', 'parts', 'parts', false, 'parts_warranty'],
  ['4520', 'Parts sales - internal', 'income', 'parts', 'parts', false, 'parts_internal'],
  ['4530', 'Parts sales - counter retail', 'income', 'parts', 'parts', false, 'parts_counter'],
  ['4540', 'Parts sales - wholesale', 'income', 'parts', 'parts', false, 'parts_wholesale'],
  ['4900', 'Other income', 'income', '', 'other', false, 'other_income'],
  // Cost of sales
  ['5000', 'Cost of new vehicle sales', 'cogs', 'new', 'vehicle', false, 'cos_new'],
  ['5050', 'New - over-allowance, we-owes & deal costs', 'cogs', 'new', 'adjustments', false, 'cos_adj_new'],
  ['5100', 'Cost of used vehicle sales', 'cogs', 'used', 'vehicle', false, 'cos_used'],
  ['5150', 'Used - over-allowance, we-owes & deal costs', 'cogs', 'used', 'adjustments', false, 'cos_adj_used'],
  ['5190', 'Cost of wholesale vehicles', 'cogs', 'used', 'wholesale', false, 'cos_wholesale'],
  ['5200', 'Cost of F&I products', 'cogs', 'fi', 'products', false, 'cos_fi'],
  ['5400', 'Cost of labor - customer pay', 'cogs', 'service', 'labor', false, 'cos_labor_customer'],
  ['5410', 'Cost of labor - warranty', 'cogs', 'service', 'labor', false, 'cos_labor_warranty'],
  ['5420', 'Cost of labor - internal', 'cogs', 'service', 'labor', false, 'cos_labor_internal'],
  ['5500', 'Cost of parts - customer pay', 'cogs', 'parts', 'parts', false, 'cos_parts_customer'],
  ['5510', 'Cost of parts - warranty', 'cogs', 'parts', 'parts', false, 'cos_parts_warranty'],
  ['5520', 'Cost of parts - internal', 'cogs', 'parts', 'parts', false, 'cos_parts_internal'],
  ['5530', 'Cost of parts - counter retail', 'cogs', 'parts', 'parts', false, 'cos_parts_counter'],
  ['5540', 'Cost of parts - wholesale', 'cogs', 'parts', 'parts', false, 'cos_parts_wholesale'],
  ['5590', 'Parts inventory adjustments', 'cogs', 'parts', 'adjustments', false, 'parts_adjust'],
  // Expenses
  ['6000', 'Sales commissions - new', 'expense', 'new', 'variable', false, 'comm_new'],
  ['6010', 'Sales commissions - used', 'expense', 'used', 'variable', false, 'comm_used'],
  ['6020', 'F&I commissions', 'expense', 'fi', 'variable', false, 'comm_fi'],
  ['6100', 'Delivery expense - new', 'expense', 'new', 'variable', false, 'delivery_new'],
  ['6110', 'Delivery expense - used', 'expense', 'used', 'variable', false, 'delivery_used'],
  ['6150', 'Policy expense - new', 'expense', 'new', 'variable', false, 'policy_new'],
  ['6160', 'Policy expense - used', 'expense', 'used', 'variable', false, 'policy_used'],
  ['6170', 'Policy expense - service', 'expense', 'service', 'variable', false, 'policy_service'],
  ['6180', 'Policy expense - parts', 'expense', 'parts', 'variable', false, 'policy_parts'],
  ['6200', 'Advertising - new', 'expense', 'new', 'variable', false, 'adv_new'],
  ['6210', 'Advertising - used', 'expense', 'used', 'variable', false, 'adv_used'],
  ['6220', 'Advertising - service & parts', 'expense', 'service', 'variable', false, 'adv_service'],
  ['6300', 'Floor plan interest', 'expense', 'new', 'variable', false, 'fp_interest'],
  ['6400', 'Salaries - sales & F&I', 'expense', 'used', 'personnel', false, 'salaries_sales'],
  ['6410', 'Salaries - service', 'expense', 'service', 'personnel', false, 'salaries_service'],
  ['6420', 'Salaries - parts', 'expense', 'parts', 'personnel', false, 'salaries_parts'],
  ['6430', 'Salaries - office & admin', 'expense', '', 'personnel', false, 'salaries_admin'],
  ['6440', 'Payroll taxes & benefits', 'expense', '', 'personnel', false, 'payroll_taxes'],
  ['6500', 'Rent', 'expense', '', 'fixed', false, 'rent'],
  ['6510', 'Utilities', 'expense', '', 'fixed', false, 'utilities'],
  ['6520', 'Insurance', 'expense', '', 'fixed', false, 'insurance'],
  ['6530', 'Depreciation', 'expense', '', 'fixed', false, 'depreciation'],
  ['6540', 'Office supplies & postage', 'expense', '', 'semi_fixed', false, 'office'],
  ['6550', 'Computers & software', 'expense', '', 'semi_fixed', false, 'software'],
  ['6560', 'Telephone & internet', 'expense', '', 'semi_fixed', false, 'telephone'],
  ['6570', 'Repairs & maintenance', 'expense', '', 'semi_fixed', false, 'repairs'],
  ['6580', 'Bank & credit card fees', 'expense', '', 'semi_fixed', false, 'bank_fees'],
  ['6590', 'Legal & accounting', 'expense', '', 'semi_fixed', false, 'professional'],
  ['6900', 'Miscellaneous expense', 'expense', '', 'semi_fixed', false, 'misc_expense']
];
const GROUP_LABELS = {
  cash: 'Cash', receivables: 'Receivables', inventory: 'Inventory', other_current: 'Other current assets', fixed_assets: 'Fixed assets',
  current: 'Current liabilities', floor_plan: 'Floor plan', long_term: 'Long-term debt', equity: 'Equity',
  vehicle: 'Vehicle sales', fees: 'Doc & dealer fees', incentives: 'Incentives', wholesale: 'Wholesale', products: 'F&I products',
  reserve: 'Finance reserve', chargebacks: 'Chargebacks', labor: 'Labor', parts: 'Parts', other: 'Other', adjustments: 'Adjustments',
  variable: 'Variable expenses', personnel: 'Personnel expenses', semi_fixed: 'Semi-fixed expenses', fixed: 'Fixed expenses'
};

// The standard chart goes in the first time the books are touched.
// Accounts added to the standard chart later are filled in for stores that
// already have their books.
const CHART_KEYS = CHART.filter(c => c[6]).length;
async function ensureChart(q, dealershipId) {
  const { rows } = await q.query('SELECT count(system_key) AS keys FROM gl_accounts WHERE dealership_id = $1', [dealershipId]);
  if (Number(rows[0].keys) >= CHART_KEYS) return;
  const { rows: have } = await q.query('SELECT system_key FROM gl_accounts WHERE dealership_id = $1 AND system_key IS NOT NULL', [dealershipId]);
  const known = new Set(have.map(r => r.system_key));
  for (const [number, name, type, dept, grp, scheduled, key] of CHART) {
    if (key && known.has(key)) continue;
    await q.query(
      `INSERT INTO gl_accounts (dealership_id, number, name, type, dept, grp, scheduled, system_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [dealershipId, number, name, type, dept, grp, scheduled, key]);
  }
}

async function chartOf(q, dealershipId) {
  await ensureChart(q, dealershipId);
  const { rows } = await q.query(
    `SELECT number, name, type, dept, grp, scheduled, active, system_key AS key FROM gl_accounts WHERE dealership_id = $1 ORDER BY number`,
    [dealershipId]);
  return rows;
}

// ---------- Dates and periods ----------

async function settingsOf(q, dealershipId) {
  const d = await store.getDealership(q, dealershipId);
  const s = (d && d.settings) || {};
  const a = s.accounting || {};
  return {
    tz: hours.cleanStoreHours(s.storeHours).timezone,
    closedThrough: /^\d{4}-\d{2}$/.test(a.closedThrough || '') ? a.closedThrough : '',
    autoBookFinalized: a.autoBookFinalized === true,
    startedOn: a.startedOn || '',
    raw: s
  };
}
const pad = v => String(v).padStart(2, '0');
// A moment as a calendar day (YYYY-MM-DD) in the store's time zone.
function localDay(iso, tz) {
  const t = iso ? new Date(iso).getTime() : Date.now();
  const d = hours.localDate(Number.isNaN(t) ? Date.now() : t, tz);
  return `${d.y}-${pad(d.m + 1)}-${pad(d.d)}`;
}
const monthOf = day => String(day).slice(0, 7);
function nextMonthStart(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
const dayStr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// ---------- Posting ----------

class BooksError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

// Posts one balanced entry. lines: [{ key | account, amount (+dr/-cr),
// control, controlName, memo }]. Zero lines are dropped. Automatic
// entries dated in a closed month move to the first open day; entries
// typed in by the office can't go into a closed month at all.
async function postEntry(q, who, { journal = 'general', date = null, memo = '', sourceType = '', sourceId = '', lines = [], manual = false, reverses = null }) {
  const dealershipId = who.dealershipId;
  const accounts = await chartOf(q, dealershipId);
  const byNumber = new Map(accounts.map(a => [a.number, a]));
  const byKey = new Map(accounts.filter(a => a.key).map(a => [a.key, a]));
  const clean = [];
  for (const l of lines) {
    const amount = round2(l.amount);
    if (!amount) continue;
    const acct = l.account !== undefined && l.account !== null && l.account !== '' ? byNumber.get(String(l.account)) : byKey.get(l.key);
    if (!acct) throw new BooksError(`Unknown account ${l.account || l.key}.`);
    if (manual && !acct.active) throw new BooksError(`Account ${acct.number} is inactive.`);
    clean.push({ account: acct.number, amount, control: text(l.control, 40), controlName: text(l.controlName, 120), memo: text(l.memo, 200) });
  }
  if (!clean.length) return null;
  const off = round2(clean.reduce((t, l) => t + l.amount, 0));
  if (off !== 0) throw new BooksError(`This entry doesn't balance: debits and credits are off by ${Math.abs(off).toFixed(2)}.`);
  const cfg = await settingsOf(q, dealershipId);
  let day = date && isDay(date) ? date : localDay(date, cfg.tz);
  if (cfg.closedThrough && monthOf(day) <= cfg.closedThrough) {
    if (manual) throw new BooksError(`${monthOf(day)} is closed. Date it in an open month.`);
    day = nextMonthStart(cfg.closedThrough);
  }
  const { rows } = await q.query(
    'UPDATE dealerships SET next_entry_number = next_entry_number + 1 WHERE id = $1 RETURNING next_entry_number - 1 AS n', [dealershipId]);
  const entry = {
    id: crypto.randomUUID(), entryNumber: rows[0].n, journal: JOURNALS[journal] ? journal : 'general', postedOn: day,
    memo: text(memo, 300), sourceType: text(sourceType, 30), sourceId: text(sourceId, 80)
  };
  const by = who.user ? { id: who.user.id, name: who.user.name } : { id: null, name: 'Automatic' };
  await q.query(
    `INSERT INTO journal_entries (dealership_id, id, entry_number, journal, posted_on, memo, source_type, source_id, reverses, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [dealershipId, entry.id, entry.entryNumber, entry.journal, day, entry.memo, entry.sourceType, entry.sourceId, reverses, by]);
  let i = 0;
  for (const l of clean) {
    await q.query(
      `INSERT INTO journal_lines (dealership_id, entry_id, line_no, account, amount, control, control_name, memo, posted_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [dealershipId, entry.id, ++i, l.account, l.amount, l.control, l.controlName, l.memo, day]);
  }
  return { ...entry, lines: clean };
}

// Undoes an entry with an equal and opposite one (dated today, or the
// first open day). The original stays, marked as reversed.
async function reverseEntry(q, who, entryId, memo = '') {
  const { rows } = await q.query('SELECT * FROM journal_entries WHERE dealership_id = $1 AND id = $2 FOR UPDATE', [who.dealershipId, entryId]);
  const e = rows[0];
  if (!e) throw new BooksError('Entry not found.', 404);
  if (e.reversed_by) throw new BooksError(`J-${e.entry_number} was already reversed.`);
  if (e.reverses) throw new BooksError(`J-${e.entry_number} is itself a reversal. Post a new entry instead.`);
  const { rows: lines } = await q.query('SELECT * FROM journal_lines WHERE dealership_id = $1 AND entry_id = $2 ORDER BY line_no', [who.dealershipId, entryId]);
  const rev = await postEntry(q, who, {
    journal: e.journal, memo: memo || `Reverses J-${e.entry_number}${e.memo ? `: ${e.memo}` : ''}`, sourceType: e.source_type, sourceId: e.source_id,
    reverses: e.id, lines: lines.map(l => ({ account: l.account, amount: -n(l.amount), control: l.control, controlName: l.control_name, memo: l.memo }))
  });
  await q.query('UPDATE journal_entries SET reversed_by = $3 WHERE dealership_id = $1 AND id = $2', [who.dealershipId, entryId, rev.id]);
  return rev;
}

// What's on an account for one control number (e.g. the floor plan owed on
// stock #1234), as a signed balance (+ debit).
async function controlBalance(q, dealershipId, key, control) {
  const { rows } = await q.query(
    `SELECT coalesce(sum(l.amount), 0) AS bal FROM journal_lines l JOIN gl_accounts a ON a.dealership_id = l.dealership_id AND a.number = l.account
     WHERE l.dealership_id = $1 AND a.system_key = $2 AND l.control = $3`, [dealershipId, key, control]);
  return round2(rows[0].bal);
}

module.exports = {
  CHART, TYPES, DEPTS, JOURNALS, GROUP_LABELS, DEBIT_NORMAL, BooksError,
  ensureChart, chartOf, settingsOf, localDay, monthOf, monthEnd, nextMonthStart, isDay, dayStr,
  postEntry, reverseEntry, controlBalance, n, round2, text, money
};
