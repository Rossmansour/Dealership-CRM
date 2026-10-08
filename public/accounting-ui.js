// accounting-ui.js -- Accounting Domus screens. Loaded after app.js.
//
// One panel (#accounting) whose content changes with the screen picked in
// the sidebar: Overview, Book Deals, Cashier, Payables, Schedules, Journal
// Entries, General Ledger, Financial Statement, Bank Reconciliation, Title
// Tracking, and Setup & Month-End. A shared dialog (#acModal) shows entry
// previews and forms.

const ac = {
  view: 'accounting',
  chart: null,               // { accounts, types, depts, groups, journals }
  settings: null,
  // Hand-offs between screens (e.g. a schedule item → the cashier).
  cashier: null, ledger: null, schedule: null, statementTab: 'income', bookTab: 'deals', billFilter: 'open'
};

const acMoney = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '--'
  : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const acAmt = v => (Number(v) ? acMoney(v) : '');
const acNum = v => html`<span class="${Number(v) < 0 ? 'ac-neg' : ''}">${acMoney(v)}</span>`;
const acPct = v => (v === null || v === undefined ? '--' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
const acDate = d => (d ? new Date(String(d).length === 10 ? `${d}T12:00:00` : d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '--');
const acCanPost = () => userCan('postAccounting');
const acCanClose = () => userCan('closeBooks');
const acToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const acMonthNow = () => acToday().slice(0, 7);

async function acGet(path) {
  const res = await fetch(`${API}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
async function acSend(method, path, data) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
async function acChart(force) {
  if (!ac.chart || force) ac.chart = await acGet('/accounting/accounts');
  return ac.chart;
}
const acAccount = number => (ac.chart ? ac.chart.accounts.find(a => a.number === number) : null);
const acAccountOptions = (filter, selected) => (ac.chart ? ac.chart.accounts.filter(a => a.active && (!filter || filter(a))) : [])
  .map(a => html`<option value="${a.number}" ${a.number === selected ? html`selected` : ''}>${a.number} ${a.name}</option>`);

function acHead(title, sub, tools) {
  document.getElementById('acTitle').textContent = title;
  document.getElementById('acSub').textContent = sub || '';
  document.getElementById('acTools').innerHTML = tools ? String(tools) : '';
}
const acBody = () => document.getElementById('acBody');
function acError(err) { acBody().innerHTML = html`<p class="ac-error">${err.message || err}</p>`; }
function acFlash(msg, bad) {
  let el = document.getElementById('acFlash');
  if (!el) { el = document.createElement('div'); el.id = 'acFlash'; document.body.appendChild(el); }
  el.className = `ac-flash ${bad ? 'bad' : ''}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(acFlash.t);
  acFlash.t = setTimeout(() => { el.hidden = true; }, 4000);
}
function acModal(content) {
  document.getElementById('acModalBody').innerHTML = String(content);
  document.getElementById('acModal').classList.add('active');
}
function acCloseModal() { document.getElementById('acModal').classList.remove('active'); }
document.getElementById('acModal').addEventListener('click', e => { if (e.target.id === 'acModal' || e.target.closest('[data-ac-close]')) acCloseModal(); });

// Lines of an entry as a table.
function acLinesTable(lines, { cleared = false } = {}) {
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0), cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  return html`<div class="table-scroll"><table class="data-table ac-table">
    <thead><tr><th>Account</th><th>Control</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th>${cleared ? html`<th></th>` : ''}</tr></thead>
    <tbody>${lines.map(l => html`<tr>
      <td><a href="#" class="ac-link" data-ac-ledger="${l.account}">${l.account}</a> ${l.accountName}</td>
      <td>${l.control}${l.controlName && l.controlName !== l.control ? html`<div class="audit-note">${l.controlName}</div>` : ''}</td>
      <td>${l.memo}</td><td class="num">${acAmt(l.debit)}</td><td class="num">${acAmt(l.credit)}</td>${cleared ? html`<td>${l.cleared ? '✓' : ''}</td>` : ''}</tr>`)}</tbody>
    <tfoot><tr><td colspan="3"><strong>Totals</strong></td><td class="num"><strong>${acMoney(dr)}</strong></td><td class="num"><strong>${acMoney(cr)}</strong></td>${cleared ? html`<td></td>` : ''}</tr></tfoot>
  </table></div>`;
}

function acCsv(name, rows) {
  const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Entry point ----------

async function openAccountingView(view) {
  ac.view = view;
  acBody().innerHTML = html`<p class="audit-note">Loading…</p>`;
  try {
    await acChart();
    const screens = {
      accounting: acOverview, acctbook: acBook, acctcashier: acCashier, acctpayables: acPayables, acctschedules: acSchedules,
      acctjournal: acJournal, acctledger: acLedger, acctstatements: acStatements, acctbank: acBank, accttitles: acTitles, acctsetup: acSetup
    };
    await screens[view]();
  } catch (err) { acError(err); }
}
const acGo = view => showView(view);

// ---------- Overview ----------

async function acOverview() {
  const [o, check] = await Promise.all([acGet('/accounting/overview'), acGet('/accounting/inventory-check')]);
  acHead('Accounting Overview', `${acDate(o.today)} · ${o.closedThrough ? `Closed through ${o.closedThrough}` : 'No months closed yet'}`);
  const k = o.month_.keyNumbers;
  const card = (label, value, sub, view, warn) => html`<button type="button" class="ac-card ${warn ? 'warn' : ''}" ${view ? html`data-ac-go="${view}"` : ''}>
    <span class="ac-card-label">${label}</span><span class="ac-card-value">${value}</span><span class="ac-card-sub">${sub || ''}</span></button>`;
  const todo = [];
  if (o.unbooked.count) todo.push([`${o.unbooked.count} delivered deal${o.unbooked.count === 1 ? '' : 's'} not booked`, 'acctbook']);
  if (o.unbooked.wholesale) todo.push([`${o.unbooked.wholesale} wholesale car${o.unbooked.wholesale === 1 ? '' : 's'} to book`, 'acctbook']);
  if (o.cit.over10) todo.push([`${o.cit.over10} contract${o.cit.over10 === 1 ? '' : 's'} in transit over 10 days (oldest ${o.cit.oldest} days)`, 'acctschedules']);
  if (o.bills.overdue) todo.push([`${o.bills.overdue} bill${o.bills.overdue === 1 ? '' : 's'} past due`, 'acctpayables']);
  if (o.suspense) todo.push([`${acMoney(o.suspense)} sitting in suspense`, 'acctschedules']);
  if (check.length) todo.push([`${check.length} car${check.length === 1 ? '' : 's'} where the books and inventory disagree`, 'acctsetup']);
  const lastMonth = (() => { const [y, m] = o.month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
  if (!o.closedThrough || o.closedThrough < lastMonth) todo.push([`${lastMonth} hasn't been closed`, 'acctsetup']);
  if (!o.startedOn) todo.push(['Bring cars and parts already on hand onto the books (starting balances)', 'acctsetup']);
  acBody().innerHTML = html`
    <div class="ac-cards">
      ${card('Cash', acMoney(o.cash), 'Operating + petty cash', 'acctbank')}
      ${card('Contracts in transit', acMoney(o.cit.total), `${o.cit.items} waiting${o.cit.over10 ? ` · ${o.cit.over10} over 10 days` : ''}`, 'acctschedules', o.cit.over10)}
      ${card('Receivables', acMoney(o.receivables), 'Customers, factory, lenders, warranty', 'acctschedules')}
      ${card('Vehicle inventory', acMoney(o.inventory.new + o.inventory.used), `New ${acMoney(o.inventory.new)} · Used ${acMoney(o.inventory.used)}`, 'acctschedules')}
      ${card('Parts inventory', acMoney(o.inventory.parts), '', 'acctledger')}
      ${card('Floor plan', acMoney(o.floorPlan), 'Owed on new cars in stock', 'acctschedules')}
      ${card('Owed', acMoney(o.owed), 'Vendors, payoffs, products, taxes, accruals', 'acctschedules')}
      ${card('Bills to pay', acMoney(o.bills.due), `${o.bills.open} open${o.bills.overdue ? ` · ${o.bills.overdue} past due` : ''}`, 'acctpayables', o.bills.overdue)}
      ${card('Deals to book', String(o.unbooked.count), o.unbooked.wholesale ? `+ ${o.unbooked.wholesale} wholesale` : 'Delivered, not booked', 'acctbook', o.unbooked.count)}
    </div>
    <div class="ac-grid2">
      <div class="ac-box">
        <div class="ca-section-title">To do</div>
        ${todo.length ? html`<ul class="ac-todo">${todo.map(([t, v]) => html`<li><a href="#" class="ac-link" data-ac-go="${v}">${t}</a></li>`)}</ul>` : html`<p class="audit-note">All caught up.</p>`}
      </div>
      <div class="ac-box">
        <div class="ca-section-title">${o.month} so far <a href="#" class="ac-link ac-small" data-ac-go="acctstatements">Financial statement →</a></div>
        <div class="ac-kv"><span>Gross profit</span><strong>${acNum(o.month_.gross)}</strong></div>
        <div class="ac-kv"><span>Expenses</span><strong>${acNum(o.month_.expenses)}</strong></div>
        <div class="ac-kv ac-kv-total"><span>Net profit</span><strong>${acNum(o.month_.net)}</strong></div>
        <div class="ac-kv"><span>Units booked</span><strong>${o.month_.units.new} new · ${o.month_.units.used} used${o.month_.units.wholesale ? ` · ${o.month_.units.wholesale} wholesale` : ''}</strong></div>
        <div class="ac-kv"><span>Gross per new / used unit</span><strong>${acMoney(k.newGrossPerUnit)} / ${acMoney(k.usedGrossPerUnit)}</strong></div>
        <div class="ac-kv"><span>F&amp;I per unit</span><strong>${acMoney(k.fiPerUnit)}</strong></div>
        <div class="ac-kv"><span>Fixed absorption</span><strong>${acPct(k.fixedAbsorption)}</strong></div>
      </div>
    </div>`;
}

// ---------- Book deals ----------

async function acBook() {
  const u = await acGet('/accounting/unbooked');
  acHead('Book Deals', 'Delivered deals post to the books when they are booked. Check the entry, then book it.');
  const tabs = [['deals', `To book (${u.deals.length})`], ['wholesale', `Wholesale (${u.wholesale.length})`], ['chargebacks', `Chargebacks (${u.chargebacks.length})`],
    ['changed', `Changed since booked (${u.changedSinceBooked.length})`], ['booked', 'Recently booked']];
  const dealRow = (d, action) => html`<tr>
    <td><strong>D-${d.dealNumber}</strong></td><td>${d.customer}</td><td>${d.vehicle}<div class="audit-note">#${d.stockNumber} · ${d.type === 'new' ? 'New' : 'Used'}</div></td>
    <td>${d.dealType === 'lease' ? 'Lease' : d.dealType === 'cash' || !d.lender ? 'Cash' : 'Finance'}${d.lender ? html`<div class="audit-note">${d.lender}</div>` : ''}</td>
    <td>${acDate(d.deliveredAt)}<div class="audit-note ${d.days > 3 ? 'ac-late' : ''}">${d.days} day${d.days === 1 ? '' : 's'}</div></td>
    <td class="num">${acMoney(d.price)}</td><td class="ac-actions">${action}</td></tr>`;
  const head = html`<thead><tr><th>Deal</th><th>Customer</th><th>Vehicle</th><th>Type</th><th>Delivered</th><th class="num">Price</th><th></th></tr></thead>`;
  let content;
  if (ac.bookTab === 'deals') {
    content = u.deals.length ? html`<table class="data-table ac-table">${head}<tbody>${u.deals.map(d => dealRow(d, html`<button type="button" class="btn-primary btn-small" data-ac-preview="${d.id}">Review &amp; book</button>`))}</tbody></table>`
      : html`<p class="audit-note">Every delivered deal is booked.</p>`;
  } else if (ac.bookTab === 'wholesale') {
    content = u.wholesale.length ? html`<table class="data-table ac-table"><thead><tr><th>Stock #</th><th>Vehicle</th><th>Sold</th><th class="num">Cost</th><th class="num">Sold for</th><th>Buyer</th><th></th></tr></thead><tbody>
      ${u.wholesale.map(c => html`<tr><td><strong>${c.stockNumber}</strong></td><td>${c.vehicle}</td><td>${acDate(c.soldAt)}</td><td class="num">${acMoney(c.cost)}</td>
        <td class="num"><input type="number" step="0.01" class="ac-input-num" data-ws-price="${c.id}" value="${c.price || ''}" /></td>
        <td><input type="text" class="ac-input" data-ws-buyer="${c.id}" value="${c.buyer}" placeholder="Auction / dealer" /></td>
        <td>${acCanPost() ? html`<button type="button" class="btn-primary btn-small" data-ws-book="${c.id}">Book</button>` : ''}</td></tr>`)}</tbody></table>`
      : html`<p class="audit-note">No wholesale cars waiting.</p>`;
  } else if (ac.bookTab === 'chargebacks') {
    content = u.chargebacks.length ? html`<table class="data-table ac-table"><thead><tr><th>Deal</th><th>Customer</th><th>Charged back</th><th class="num">Amount</th><th class="num">Already posted</th><th></th></tr></thead><tbody>
      ${u.chargebacks.map(d => html`<tr><td><strong>D-${d.dealNumber}</strong></td><td>${d.customer}</td><td>${acDate(d.chargebackDate)}</td><td class="num">${acMoney(d.chargeback)}</td><td class="num">${acMoney(d.posted)}</td>
        <td>${acCanPost() ? html`<button type="button" class="btn-primary btn-small" data-ac-chargeback="${d.id}">Post</button>` : ''}</td></tr>`)}</tbody></table>`
      : html`<p class="audit-note">No chargebacks waiting to post.</p>`;
  } else {
    const list = ac.bookTab === 'changed' ? u.changedSinceBooked : u.recentlyBooked;
    content = list.length ? html`<table class="data-table ac-table">${head}<tbody>${list.map(d => dealRow(d, html`
      <button type="button" class="btn-secondary btn-small" data-ac-entry="${d.booked.entryId}">J-${d.booked.entryNumber}</button>
      ${acCanPost() ? html`<button type="button" class="btn-secondary btn-small" data-ac-unbook="${d.id}">Unbook</button>` : ''}`))}</tbody></table>
      ${ac.bookTab === 'changed' ? html`<p class="audit-note">These deals were edited after they were booked. Unbook and book again if the money changed.</p>` : ''}`
      : html`<p class="audit-note">${ac.bookTab === 'changed' ? 'No booked deals were changed afterwards.' : 'Nothing booked yet.'}</p>`;
  }
  acBody().innerHTML = html`
    <div class="view-toggle ac-tabs">${tabs.map(([k, l]) => html`<button type="button" class="view-toggle-btn ${ac.bookTab === k ? 'active' : ''}" data-book-tab="${k}">${l}</button>`)}</div>
    <div class="table-scroll">${content}</div>
    ${acCanClose() ? html`<label class="ac-check ac-setting"><input type="checkbox" id="acAutoBook" ${u.autoBookFinalized ? html`checked` : ''} /> Book deals automatically when F&amp;I finalizes them</label>` : ''}`;
}

async function acPreviewDeal(id) {
  const p = await acGet(`/accounting/deals/${id}/preview`);
  acModal(html`<h2>Book D-${p.dealNumber}</h2>
    <p class="audit-note">${p.memo} · posts on ${acDate(p.date)}</p>
    ${p.warnings.length ? html`<div class="ac-warn">${p.warnings.map(w => html`<div>⚠ ${w}</div>`)}</div>` : ''}
    ${acLinesTable(p.lines)}
    <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button>
      ${acCanPost() ? html`<button type="button" class="btn-primary" data-ac-book="${id}">Book it</button>` : ''}</div>`);
}

async function acShowEntry(id) {
  const e = await acGet(`/accounting/entries/${id}`);
  acModal(html`<h2>J-${e.entryNumber} <span class="ac-badge">${e.journalLabel}</span>${e.reversedBy ? html` <span class="ac-badge ac-badge-warn">Reversed</span>` : ''}${e.reverses ? html` <span class="ac-badge">Reversal</span>` : ''}</h2>
    <p class="audit-note">${acDate(e.postedOn)} · ${e.memo} · by ${(e.createdBy || {}).name || 'Automatic'}</p>
    ${acLinesTable(e.lines, { cleared: true })}
    <div class="modal-actions">
      ${acCanPost() && !e.reversedBy && !e.reverses && !['deal', 'wholesale', 'bill'].includes(e.sourceType) ? html`<button type="button" class="btn-secondary" data-ac-reverse="${e.id}">Reverse this entry</button>` : ''}
      <button type="button" class="btn-primary" data-ac-close>Close</button></div>`);
}

// ---------- Cashier ----------

const RECEIVE_KEYS = ['cit', 'vehicle_ar', 'factory_ar', 'reserve_ar', 'wholesale_ar', 'service_ar', 'warranty_ar', 'other_ar', 'deposits', 'other_income', 'suspense'];
const PAY_KEYS = ['ap', 'vehicle_ap', 'payoff_ap', 'fi_ap', 'dmv_ap', 'sales_tax', 'deposits', 'we_owe', 'deal_accrual', 'commissions_ap', 'payroll_ap', 'floor_plan', 'notes_payable', 'suspense'];

async function acCashier() {
  acHead('Cashier', 'Money in and money out. Pick what it is for; open items fill themselves in.');
  const pre = ac.cashier || {};
  ac.cashier = null;
  const recv = acAccountOptions(a => RECEIVE_KEYS.includes(a.key) || (a.type === 'asset' && a.scheduled && !['new_inventory', 'used_inventory'].includes(a.key)), pre.mode === 'in' ? pre.account : '1100');
  const pay = acAccountOptions(a => PAY_KEYS.includes(a.key) || (a.type === 'liability' && a.key !== 'trade_clearing'), pre.mode === 'out' ? pre.account : '2020');
  const form = (mode, options) => html`<form class="ac-box ac-form" data-cash-form="${mode}">
    <div class="ca-section-title">${mode === 'in' ? 'Receive money' : 'Pay out'}</div>
    <label>${mode === 'in' ? 'For' : 'Paying'} <select name="account">${options}</select></label>
    <div class="ac-open" data-open-items="${mode}"></div>
    <div class="ac-row2">
      <label>Control # <input name="control" placeholder="D-1001, RO-5001, stock #…" value="${pre.mode === mode ? pre.control || '' : ''}" /></label>
      <label>${mode === 'in' ? 'From' : 'To (payee)'} <input name="name" value="${pre.mode === mode ? pre.name || '' : ''}" ${mode === 'out' ? html`required` : ''} /></label>
    </div>
    <div class="ac-row2">
      <label>Amount <input name="amount" type="number" step="0.01" min="0.01" required value="${pre.mode === mode && pre.amount ? pre.amount : ''}" /></label>
      <label>How <select name="method">${(mode === 'in' ? ['check', 'ach', 'card', 'cash', 'wire'] : ['check', 'ach', 'wire', 'card', 'cash']).map(m => html`<option value="${m}">${{ check: 'Check', ach: 'ACH', card: 'Card', cash: 'Cash', wire: 'Wire' }[m]}</option>`)}</select></label>
    </div>
    <div class="ac-row2">
      <label>${mode === 'in' ? 'Check / reference #' : 'Check # (blank = next)'} <input name="reference" /></label>
      <label>Date <input name="date" type="date" value="${acToday()}" /></label>
    </div>
    <label>Memo <input name="memo" /></label>
    <div class="modal-actions">${acCanPost() ? html`<button type="submit" class="btn-primary">${mode === 'in' ? 'Receive' : 'Pay'}</button>` : html`<span class="audit-note">View only</span>`}</div>
  </form>`;
  const recent = await acGet('/accounting/entries?limit=15&journal=cash');
  const paid = await acGet('/accounting/entries?limit=15&journal=disbursements');
  acBody().innerHTML = html`<div class="ac-grid2">${form('in', recv)}${form('out', pay)}</div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Recent receipts</div>${acEntryList(recent, true)}</div>
      <div class="ac-box"><div class="ca-section-title">Recent checks &amp; payments</div>${acEntryList(paid, true)}</div>
    </div>`;
  for (const mode of ['in', 'out']) acLoadOpenItems(mode, pre.mode === mode ? pre.control : null);
}

async function acLoadOpenItems(mode, selectControl) {
  const form = document.querySelector(`[data-cash-form="${mode}"]`);
  if (!form) return;
  const account = form.account.value;
  const box = form.querySelector(`[data-open-items="${mode}"]`);
  const a = acAccount(account);
  if (!a || !a.scheduled) { box.innerHTML = ''; return; }
  const s = await acGet(`/accounting/schedules/${account}`);
  box.innerHTML = s.items.length ? html`<div class="ac-open-title">Open items (${s.items.length}) -- click to fill in</div>
    <div class="ac-open-list">${s.items.slice(0, 40).map(i => html`<button type="button" class="ac-open-item ${i.control === selectControl ? 'active' : ''}" data-fill-control="${i.control}" data-fill-name="${i.name}" data-fill-amount="${i.balance}">
      <span>${i.control || '(no control #)'} ${i.name ? `· ${i.name}` : ''}</span><span>${acMoney(i.balance)} · ${i.age}d</span></button>`)}</div>`
    : html`<div class="ac-open-title">Nothing open on this account.</div>`;
}

function acEntryList(entries, compact) {
  if (!entries.length) return html`<p class="audit-note">None yet.</p>`;
  return html`<table class="data-table ac-table ac-click"><thead><tr><th>Entry</th><th>Date</th>${compact ? '' : html`<th>Journal</th>`}<th>Memo</th><th class="num">Amount</th></tr></thead><tbody>
    ${entries.map(e => html`<tr data-ac-entry="${e.id}"><td><strong>J-${e.entryNumber}</strong>${e.reversedBy ? html` <span class="ac-badge ac-badge-warn">Reversed</span>` : ''}${e.reverses ? html` <span class="ac-badge">Reversal</span>` : ''}</td>
      <td>${acDate(e.postedOn)}</td>${compact ? '' : html`<td>${e.journalLabel}</td>`}<td>${e.memo}</td><td class="num">${acMoney(e.total)}</td></tr>`)}</tbody></table>`;
}

// ---------- Payables ----------

async function acPayables() {
  const [vendors, bills] = await Promise.all([acGet('/accounting/vendors'), acGet(`/accounting/bills${ac.billFilter ? `?status=${ac.billFilter}` : ''}`)]);
  ac.vendors = vendors;
  acHead('Payables', 'Vendor bills go to their expense accounts and are owed until paid.',
    acCanPost() ? html`<button type="button" class="btn-secondary" data-ac-newvendor>+ Vendor</button><button type="button" class="btn-primary" data-ac-newbill>+ Enter a bill</button>` : '');
  const due = bills.filter(b => b.status === 'open').reduce((s, b) => s + b.balance, 0);
  acBody().innerHTML = html`
    <div class="ro-summary"><span>Open bills <strong>${bills.filter(b => b.status === 'open').length}</strong></span><span>Owed <strong>${acMoney(due)}</strong></span>
      <span class="${bills.some(b => b.overdue) ? 'ro-late' : ''}">Past due <strong>${bills.filter(b => b.overdue).length}</strong></span></div>
    <div class="view-toggle ac-tabs">${[['open', 'Open'], ['paid', 'Paid'], ['void', 'Voided'], ['', 'All']].map(([k, l]) => html`<button type="button" class="view-toggle-btn ${ac.billFilter === k ? 'active' : ''}" data-bill-filter="${k}">${l}</button>`)}</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Vendor</th><th>Invoice</th><th>Date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th></th></tr></thead><tbody>
      ${bills.length ? bills.map(b => html`<tr><td><strong>${b.vendorName}</strong>${b.memo ? html`<div class="audit-note">${b.memo}</div>` : ''}</td><td>${b.invoice || '--'}</td><td>${acDate(b.date)}</td>
        <td class="${b.overdue ? 'ac-late' : ''}">${acDate(b.dueDate)}</td><td class="num">${acMoney(b.total)}</td><td class="num">${acMoney(b.balance)}</td>
        <td><span class="ac-badge ${b.status === 'open' ? (b.overdue ? 'ac-badge-warn' : 'ac-badge-blue') : ''}">${b.status === 'open' ? (b.overdue ? 'Past due' : 'Open') : b.status === 'paid' ? 'Paid' : 'Void'}</span></td>
        <td class="ac-actions"><button type="button" class="btn-secondary btn-small" data-ac-entry="${b.entryId}">J-${b.entryNumber}</button>
          ${acCanPost() && b.status === 'open' ? html`<button type="button" class="btn-primary btn-small" data-ac-paybill="${b.id}">Pay</button>${!b.paid ? html`<button type="button" class="btn-secondary btn-small" data-ac-voidbill="${b.id}">Void</button>` : ''}` : ''}</td></tr>`)
        : html`<tr><td colspan="8" class="audit-note">No bills here.</td></tr>`}</tbody></table></div>
    <div class="ca-section-title">Vendors</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Vendor</th><th>Contact</th><th>Terms</th><th>Usual account</th><th class="num">Owed</th><th></th></tr></thead><tbody>
      ${vendors.length ? vendors.map(v => html`<tr><td><strong>${v.name}</strong>${v.active === false ? html` <span class="ac-badge">Inactive</span>` : ''}</td><td>${[v.contact, v.phone, v.email].filter(Boolean).join(' · ')}</td><td>Net ${v.terms}</td>
        <td>${v.defaultAccount ? `${v.defaultAccount} ${(acAccount(v.defaultAccount) || {}).name || ''}` : '--'}</td><td class="num">${acMoney(v.open)}</td>
        <td>${acCanPost() ? html`<button type="button" class="btn-secondary btn-small" data-ac-editvendor="${v.id}">Edit</button>` : ''}</td></tr>`)
        : html`<tr><td colspan="6" class="audit-note">No vendors yet.</td></tr>`}</tbody></table></div>`;
}

function acVendorForm(v = {}) {
  acModal(html`<h2>${v.id ? 'Edit vendor' : 'New vendor'}</h2>
    <form id="acVendorForm" data-id="${v.id || ''}">
      <label>Name <input name="name" required value="${v.name || ''}" /></label>
      <div class="ac-row2"><label>Contact <input name="contact" value="${v.contact || ''}" /></label><label>Phone <input name="phone" value="${v.phone || ''}" /></label></div>
      <div class="ac-row2"><label>Email <input name="email" type="email" value="${v.email || ''}" /></label><label>Terms (days) <input name="terms" type="number" min="0" value="${v.terms ?? 30}" /></label></div>
      <label>Address <input name="address" value="${v.address || ''}" /></label>
      <label>Usual account for their bills <select name="defaultAccount"><option value="">--</option>${acAccountOptions(a => ['expense', 'asset', 'cogs'].includes(a.type), v.defaultAccount)}</select></label>
      ${v.id ? html`<label class="ac-check"><input type="checkbox" name="active" ${v.active !== false ? html`checked` : ''} /> Active</label>` : ''}
      <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button><button type="submit" class="btn-primary">Save</button></div>
    </form>`);
}

function acBillForm() {
  if (!ac.vendors || !ac.vendors.length) { acVendorForm(); acFlash('Add the vendor first.'); return; }
  const line = () => html`<div class="ac-bill-line"><select name="account">${acAccountOptions(a => ['expense', 'asset', 'cogs', 'liability'].includes(a.type))}</select>
    <input name="lineMemo" placeholder="What for" /><input name="lineAmount" type="number" step="0.01" placeholder="0.00" /></div>`;
  acModal(html`<h2>Enter a bill</h2>
    <form id="acBillForm">
      <div class="ac-row2"><label>Vendor <select name="vendorId" required>${ac.vendors.filter(v => v.active !== false).map(v => html`<option value="${v.id}" data-acct="${v.defaultAccount || ''}">${v.name}</option>`)}</select></label>
        <label>Invoice # <input name="invoice" /></label></div>
      <div class="ac-row2"><label>Bill date <input name="date" type="date" required value="${acToday()}" /></label><label>Due (blank = by terms) <input name="dueDate" type="date" /></label></div>
      <div class="ac-open-title">Charged to</div>
      <div id="acBillLines">${line()}${line()}</div>
      <button type="button" class="link-btn" data-ac-billline>+ Another line</button>
      <label>Memo <input name="memo" /></label>
      <div class="ac-total">Total <strong id="acBillTotal">$0.00</strong></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button><button type="submit" class="btn-primary">Save bill</button></div>
    </form>`);
  acBillDefaults();
}
function acBillDefaults() {
  const f = document.getElementById('acBillForm');
  if (!f) return;
  const acctNo = f.vendorId.selectedOptions[0] && f.vendorId.selectedOptions[0].dataset.acct;
  if (acctNo) f.querySelectorAll('[name="account"]').forEach(s => { if (!s.dataset.touched) s.value = acctNo; });
}

// ---------- Schedules ----------

async function acSchedules() {
  if (ac.schedule) return acScheduleDetail(ac.schedule);
  const s = await acGet('/accounting/schedules');
  acHead('Schedules', `Everything tracked item by item, as of ${acDate(s.asOf)}. Click one to see its items.`);
  acBody().innerHTML = html`<div class="table-scroll"><table class="data-table ac-table ac-click"><thead><tr><th>Account</th><th class="num">Items</th><th class="num">0-30</th><th class="num">31-60</th><th class="num">61-90</th><th class="num">90+</th><th class="num">Total</th></tr></thead><tbody>
    ${s.schedules.map(x => html`<tr data-ac-schedule="${x.number}"><td><strong>${x.number}</strong> ${x.name}</td><td class="num">${x.items}</td>
      ${['0-30', '31-60', '61-90', '90+'].map(b => html`<td class="num ${b !== '0-30' && x.buckets[b] ? 'ac-late' : ''}">${acAmt(x.buckets[b])}</td>`)}<td class="num"><strong>${acMoney(x.total)}</strong></td></tr>`)}</tbody></table></div>`;
}

async function acScheduleDetail(number) {
  const s = await acGet(`/accounting/schedules/${number}`);
  const a = s.account;
  const receivable = a.type === 'asset';
  acHead(`${a.number} ${a.name}`, `${s.items.length} open item${s.items.length === 1 ? '' : 's'} · ${acMoney(s.total)} · as of ${acDate(s.asOf)}`,
    html`<button type="button" class="btn-secondary" data-ac-back-schedules>← All schedules</button><button type="button" class="btn-secondary" data-ac-csv-schedule>Export CSV</button>`);
  ac.lastSchedule = s;
  acBody().innerHTML = html`<div class="ro-summary">${s.buckets.map(b => html`<span>${b.label} days <strong>${acMoney(b.total)}</strong></span>`)}</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Control #</th><th>Name</th><th>Since</th><th class="num">Age</th><th class="num">Balance</th><th></th></tr></thead><tbody>
    ${s.items.length ? s.items.map(i => html`<tr><td><strong>${i.control || '(none)'}</strong></td><td>${i.name}</td><td>${acDate(i.first)}</td><td class="num ${i.age > 30 ? 'ac-late' : ''}">${i.age}d</td><td class="num">${acNum(i.balance)}</td>
      <td class="ac-actions"><button type="button" class="btn-secondary btn-small" data-ac-ledger="${a.number}" data-ac-control="${i.control}">Detail</button>
        ${acCanPost() && (receivable || a.type === 'liability') ? html`<button type="button" class="btn-primary btn-small" data-ac-settle="${receivable ? 'in' : 'out'}" data-account="${a.number}" data-control="${i.control}" data-name="${i.name}" data-amount="${Math.abs(i.balance)}">${receivable ? 'Receive' : 'Pay'}</button>` : ''}</td></tr>`)
      : html`<tr><td colspan="6" class="audit-note">Nothing open.</td></tr>`}</tbody></table></div>`;
}

// ---------- Journal ----------

ac.journalFilter = { from: '', to: '', journal: '', q: '' };
async function acJournal() {
  const f = ac.journalFilter;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const entries = await acGet(`/accounting/entries${qs ? `?${qs}` : ''}`);
  acHead('Journal Entries', 'Every entry in the books. Automatic ones post themselves; mistakes are fixed by reversing.',
    acCanPost() ? html`<button type="button" class="btn-primary" data-ac-newentry>+ Journal entry</button>` : '');
  acBody().innerHTML = html`<form class="panel-header" id="acJournalFilter">
      <input name="q" placeholder="Search memo, control #, J-number…" value="${f.q}" />
      <select name="journal"><option value="">All journals</option>${Object.entries(ac.chart.journals).map(([k, l]) => html`<option value="${k}" ${f.journal === k ? html`selected` : ''}>${l}</option>`)}</select>
      <label class="deal-date-label">From <input type="date" name="from" value="${f.from}" /></label>
      <label class="deal-date-label">To <input type="date" name="to" value="${f.to}" /></label>
      <button type="submit" class="btn-secondary">Show</button>
    </form>
    <div class="table-scroll">${acEntryList(entries)}</div>
    ${entries.length >= 200 ? html`<p class="audit-note">Showing the latest 200. Narrow the dates to see more.</p>` : ''}`;
}

function acEntryForm() {
  const line = () => html`<tr class="ac-je-line"><td><select name="account"><option value="">--</option>${acAccountOptions()}</select></td>
    <td><input name="control" placeholder="Control #" /></td><td><input name="memo" placeholder="Memo" /></td>
    <td><input name="debit" type="number" step="0.01" class="ac-input-num" /></td><td><input name="credit" type="number" step="0.01" class="ac-input-num" /></td></tr>`;
  acModal(html`<h2>Journal entry</h2>
    <form id="acEntryForm">
      <div class="ac-row2"><label>Date <input name="date" type="date" required value="${acToday()}" /></label>
        <label>Journal <select name="journal">${Object.entries(ac.chart.journals).map(([k, l]) => html`<option value="${k}" ${k === 'general' ? html`selected` : ''}>${l}</option>`)}</select></label></div>
      <label>Memo <input name="entryMemo" required placeholder="What this entry is for" /></label>
      <div class="table-scroll"><table class="data-table ac-table ac-je"><thead><tr><th>Account</th><th>Control</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody id="acEntryLines">${line()}${line()}${line()}</tbody></table></div>
      <button type="button" class="link-btn" data-ac-entryline>+ Another line</button>
      <div class="ac-total" id="acEntryTotals"></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button><button type="submit" class="btn-primary">Post entry</button></div>
    </form>`);
  ac.entryLine = line;
  acEntryTotals();
}
function acEntryTotals() {
  const rows = [...document.querySelectorAll('#acEntryLines tr')];
  const dr = rows.reduce((s, r) => s + (Number(r.querySelector('[name="debit"]').value) || 0), 0);
  const cr = rows.reduce((s, r) => s + (Number(r.querySelector('[name="credit"]').value) || 0), 0);
  const off = Math.round((dr - cr) * 100) / 100;
  const el = document.getElementById('acEntryTotals');
  if (el) el.innerHTML = html`Debits <strong>${acMoney(dr)}</strong> · Credits <strong>${acMoney(cr)}</strong> · ${off ? html`<span class="ac-late">Off by ${acMoney(Math.abs(off))}</span>` : html`<span class="ac-good">Balanced</span>`}`;
}

// ---------- General ledger ----------

async function acLedger() {
  const pre = ac.ledger || {};
  const month = acMonthNow();
  const account = pre.account || (ac.lastLedger && ac.lastLedger.account) || '1000';
  const params = new URLSearchParams({ account, from: pre.from || `${month}-01`, to: pre.to || acToday() });
  if (pre.control !== undefined && pre.control !== null) params.set('control', pre.control);
  const g = await acGet(`/accounting/ledger?${params}`);
  ac.lastLedger = { account, from: g.from, to: g.to, control: g.control };
  ac.ledger = null;
  ac.ledgerData = g;
  acHead('General Ledger', `${g.account.number} ${g.account.name}${g.control !== null ? ` · control ${g.control || '(none)'}` : ''}`, html`<button type="button" class="btn-secondary" data-ac-csv-ledger>Export CSV</button>`);
  acBody().innerHTML = html`<form class="panel-header" id="acLedgerFilter">
      <select name="account">${acAccountOptions(null, g.account.number)}</select>
      <label class="deal-date-label">From <input type="date" name="from" value="${g.from}" /></label>
      <label class="deal-date-label">To <input type="date" name="to" value="${g.to}" /></label>
      <input name="control" placeholder="Control # (blank = all)" value="${g.control || ''}" />
      <button type="submit" class="btn-secondary">Show</button>
    </form>
    <div class="table-scroll"><table class="data-table ac-table ac-click"><thead><tr><th>Date</th><th>Entry</th><th>Memo</th><th>Control</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      <tr class="ac-sub"><td colspan="6">Opening balance</td><td class="num">${acNum(g.opening)}</td></tr>
      ${g.lines.map(l => html`<tr data-ac-entry="${l.entryId}"><td>${acDate(l.date)}</td><td>J-${l.entryNumber}</td><td>${l.memo}</td><td>${l.control}${l.controlName ? html`<div class="audit-note">${l.controlName}</div>` : ''}</td>
        <td class="num">${acAmt(l.debit)}</td><td class="num">${acAmt(l.credit)}</td><td class="num">${acNum(l.balance)}</td></tr>`)}
      <tr class="ac-sub"><td colspan="6"><strong>Closing balance</strong></td><td class="num"><strong>${acNum(g.closing)}</strong></td></tr>
    </tbody></table></div>`;
}

// ---------- Financial statement ----------

ac.statementMonth = '';
async function acStatements() {
  const month = ac.statementMonth || acMonthNow();
  const tabs = [['income', 'Income statement'], ['balance', 'Balance sheet'], ['trial', 'Trial balance']];
  acHead('Financial Statement', '', html`<input type="month" id="acStatementMonth" value="${month}" class="ac-month" /><button type="button" class="btn-secondary" onclick="window.print()">Print</button>`);
  const tabBar = html`<div class="view-toggle ac-tabs">${tabs.map(([k, l]) => html`<button type="button" class="view-toggle-btn ${ac.statementTab === k ? 'active' : ''}" data-st-tab="${k}">${l}</button>`)}</div>`;
  if (ac.statementTab === 'balance') {
    const b = await acGet(`/accounting/balance-sheet?month=${month}`);
    document.getElementById('acSub').textContent = `As of ${acDate(b.asOf)}${b.balanced ? '' : ` · OUT OF BALANCE by ${acMoney(b.difference)}`}`;
    const side = (title, sec) => html`<div class="ac-box"><div class="ca-section-title">${title}</div>
      ${sec.groups.map(g => html`<div class="ac-bs-group"><div class="ac-kv ac-kv-head"><span>${g.label}</span><strong>${acNum(g.total)}</strong></div>
        ${g.lines.filter(l => l.balance).map(l => html`<div class="ac-kv ac-kv-line"><span>${l.number ? html`<a href="#" class="ac-link" data-ac-ledger="${l.number}">${l.number}</a> ` : ''}${l.name}</span><span>${acNum(l.balance)}</span></div>`)}</div>`)}
      <div class="ac-kv ac-kv-total"><span>Total ${title.toLowerCase()}</span><strong>${acNum(sec.total)}</strong></div></div>`;
    acBody().innerHTML = html`${tabBar}<div class="ac-grid2">${side('Assets', b.assets)}<div>${side('Liabilities', b.liabilities)}${side('Equity', b.equity)}
      <div class="ac-box"><div class="ac-kv ac-kv-total"><span>Liabilities + equity</span><strong>${acNum(b.liabilities.total + b.equity.total)}</strong></div></div></div></div>`;
    return;
  }
  if (ac.statementTab === 'trial') {
    const t = await acGet(`/accounting/trial-balance?month=${month}`);
    document.getElementById('acSub').textContent = `As of ${acDate(t.asOf)} · ${t.balanced ? 'In balance' : 'OUT OF BALANCE'}`;
    acBody().innerHTML = html`${tabBar}<div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Account</th><th>Type</th><th class="num">This month</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
      ${t.rows.map(r => html`<tr><td><a href="#" class="ac-link" data-ac-ledger="${r.number}">${r.number}</a> ${r.name}</td><td>${r.type}</td><td class="num">${acAmt(r.month)}</td><td class="num">${acAmt(r.debit)}</td><td class="num">${acAmt(r.credit)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="3"><strong>Totals</strong></td><td class="num"><strong>${acMoney(t.debits)}</strong></td><td class="num"><strong>${acMoney(t.credits)}</strong></td></tr></tfoot></table></div>`;
    return;
  }
  const s = await acGet(`/accounting/statement?month=${month}`);
  document.getElementById('acSub').textContent = `${month} · month, year to date, and the same periods last year`;
  const depts = s.depts.filter(d => d.lines.some(l => l.month || l.ytd || l.lyMonth || l.lyYtd) || d.key !== '');
  const cols = [...depts, s.total];
  const rowOf = (label, k, strong) => html`<tr class="${strong ? 'ac-strong' : ''}"><td>${label}</td>${cols.map(d => html`<td class="num">${acNum(d[k].month)}<div class="audit-note">YTD ${acMoney(d[k].ytd)}</div></td>`)}</tr>`;
  const k = s.keyNumbers;
  acBody().innerHTML = html`${tabBar}
    <div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">Units booked</span><span class="ac-card-value">${s.units.new + s.units.used}</span><span class="ac-card-sub">${s.units.new} new · ${s.units.used} used · ${s.units.wholesale} wholesale</span></div>
      <div class="ac-card"><span class="ac-card-label">Gross / new unit</span><span class="ac-card-value">${acMoney(k.newGrossPerUnit)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Gross / used unit</span><span class="ac-card-value">${acMoney(k.usedGrossPerUnit)}</span></div>
      <div class="ac-card"><span class="ac-card-label">F&amp;I / unit</span><span class="ac-card-value">${acMoney(k.fiPerUnit)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Fixed absorption</span><span class="ac-card-value">${acPct(k.fixedAbsorption)}</span><span class="ac-card-sub">Service + parts gross ÷ overhead</span></div>
      <div class="ac-card"><span class="ac-card-label">Expenses ÷ gross</span><span class="ac-card-value">${acPct(k.expenseToGross)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Net ÷ sales</span><span class="ac-card-value">${acPct(k.netToSales)}</span></div>
    </div>
    <div class="table-scroll"><table class="data-table ac-table ac-statement"><thead><tr><th></th>${cols.map(d => html`<th class="num">${d.label}</th>`)}</tr></thead><tbody>
      ${rowOf('Sales', 'sales')}${rowOf('Cost of sales', 'cost')}${rowOf('Gross profit', 'gross', true)}${rowOf('Expenses', 'expenses')}${rowOf('Net profit', 'net', true)}
    </tbody></table></div>
    ${depts.map(d => html`<details class="ac-dept"><summary><strong>${d.label}</strong> · gross ${acMoney(d.gross.month)} · net ${acMoney(d.net.month)}</summary>
      <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Account</th><th class="num">Month</th><th class="num">YTD</th><th class="num">Last year month</th><th class="num">Last year YTD</th></tr></thead><tbody>
        ${['income', 'cogs', 'expense'].map(type => {
          const lines = d.lines.filter(l => l.type === type && (l.month || l.ytd || l.lyMonth || l.lyYtd));
          if (!lines.length) return '';
          return html`<tr class="ac-sub"><td colspan="5">${{ income: 'Sales', cogs: 'Cost of sales', expense: 'Expenses' }[type]}</td></tr>
            ${lines.map(l => html`<tr><td><a href="#" class="ac-link" data-ac-ledger="${l.number}">${l.number}</a> ${l.name}</td><td class="num">${acNum(l.month)}</td><td class="num">${acNum(l.ytd)}</td><td class="num">${acNum(l.lyMonth)}</td><td class="num">${acNum(l.lyYtd)}</td></tr>`)}`;
        })}
        <tr class="ac-strong"><td>Gross profit</td><td class="num">${acNum(d.gross.month)}</td><td class="num">${acNum(d.gross.ytd)}</td><td class="num">${acNum(d.gross.lyMonth)}</td><td class="num">${acNum(d.gross.lyYtd)}</td></tr>
        <tr class="ac-strong"><td>Net profit</td><td class="num">${acNum(d.net.month)}</td><td class="num">${acNum(d.net.ytd)}</td><td class="num">${acNum(d.net.lyMonth)}</td><td class="num">${acNum(d.net.lyYtd)}</td></tr>
      </tbody></table></div></details>`)}`;
}

// ---------- Bank reconciliation ----------

async function acBank() {
  const account = (ac.bankAccount || '1000');
  const b = await acGet(`/accounting/bank?account=${account}&through=${ac.bankThrough || acToday()}`);
  ac.bankData = b;
  acHead('Bank Reconciliation', `${b.account.number} ${b.account.name} · book balance ${acMoney(b.bookBalance)} · cleared so far ${acMoney(b.clearedBalance)}`);
  acBody().innerHTML = html`<form class="ac-box ac-form" id="acBankForm">
      <div class="ac-row3">
        <label>Bank account <select name="account">${acAccountOptions(a => a.grp === 'cash', b.account.number)}</select></label>
        <label>Statement date <input type="date" name="statementDate" value="${b.through}" /></label>
        <label>Statement ending balance <input type="number" step="0.01" name="statementBalance" placeholder="0.00" /></label>
      </div>
      <div class="ac-total" id="acBankTotals"></div>
      <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th><input type="checkbox" id="acBankAll" title="Check all" /></th><th>Date</th><th>Entry</th><th>Memo</th><th class="num">Deposits</th><th class="num">Checks &amp; payments</th></tr></thead><tbody>
        ${b.open.length ? b.open.map(l => html`<tr><td><input type="checkbox" data-bank-line="${l.id}" data-amount="${l.amount}" /></td><td>${acDate(l.date)}</td><td>J-${l.entryNumber}</td><td>${l.memo}${l.payee ? html`<div class="audit-note">${l.payee}</div>` : ''}</td>
          <td class="num">${l.amount > 0 ? acMoney(l.amount) : ''}</td><td class="num">${l.amount < 0 ? acMoney(-l.amount) : ''}</td></tr>`)
          : html`<tr><td colspan="6" class="audit-note">Everything through this date has cleared.</td></tr>`}</tbody></table></div>
      <div class="modal-actions">${acCanPost() ? html`<button type="submit" class="btn-primary" id="acBankFinish" disabled>Finish reconciliation</button>` : ''}</div>
    </form>
    ${b.history.length ? html`<div class="ca-section-title">Past reconciliations</div><table class="data-table ac-table"><thead><tr><th>Statement date</th><th class="num">Statement balance</th><th class="num">Items cleared</th><th>By</th></tr></thead><tbody>
      ${b.history.map(r => html`<tr><td>${acDate(r.statementDate)}</td><td class="num">${acMoney(r.statementBalance)}</td><td class="num">${r.cleared}</td><td>${(r.by || {}).name || ''}</td></tr>`)}</tbody></table>` : ''}`;
  acBankTotals();
}
function acBankTotals() {
  const form = document.getElementById('acBankForm');
  if (!form) return;
  const picked = [...form.querySelectorAll('[data-bank-line]:checked')].reduce((s, c) => s + Number(c.dataset.amount), 0);
  const cleared = Math.round((ac.bankData.clearedBalance + picked) * 100) / 100;
  const stmt = form.statementBalance.value === '' ? null : Number(form.statementBalance.value);
  const diff = stmt === null ? null : Math.round((stmt - cleared) * 100) / 100;
  document.getElementById('acBankTotals').innerHTML = html`Cleared balance <strong>${acMoney(cleared)}</strong> · Statement <strong>${stmt === null ? '--' : acMoney(stmt)}</strong> ·
    ${diff === null ? 'Enter the statement balance' : diff ? html`<span class="ac-late">Difference ${acMoney(diff)}</span>` : html`<span class="ac-good">Balanced</span>`}`;
  const btn = document.getElementById('acBankFinish');
  if (btn) btn.disabled = diff !== 0;
}

// ---------- Titles ----------

const TITLE_LABELS = { tradeTitleReceived: 'Trade title in', payoffSent: 'Payoff sent', lienReleased: 'Lien released', dmvSubmitted: 'DMV submitted', platesIssued: 'Plates issued', titleMailed: 'Title / reg mailed' };
async function acTitles() {
  const list = await acGet(`/accounting/titles${ac.titlesAll ? '?all=1' : ''}`);
  acHead('Title Tracking', 'Titles, payoffs, and registration on delivered deals. Enter the date each step is done.',
    html`<label class="ac-check"><input type="checkbox" id="acTitlesAll" ${ac.titlesAll ? html`checked` : ''} /> Show finished ones too</label>`);
  acBody().innerHTML = list.length ? html`<div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Deal</th><th>Delivered</th>${Object.values(TITLE_LABELS).map(l => html`<th>${l}</th>`)}</tr></thead><tbody>
    ${list.map(d => html`<tr><td><strong>D-${d.dealNumber}</strong> ${d.customer}<div class="audit-note">${d.vehicle}${d.payoff ? ` · payoff ${acMoney(d.payoff)}` : ''}</div></td>
      <td>${acDate(d.deliveredAt)}<div class="audit-note ${d.days > 20 && !d.complete ? 'ac-late' : ''}">${d.days} days</div></td>
      ${Object.keys(TITLE_LABELS).map(f => d.needs.includes(f) ? html`<td><input type="date" class="ac-input-date" data-title-deal="${d.id}" data-title-field="${f}" value="${d.tracking[f] || ''}" ${acCanPost() ? '' : html`disabled`} /></td>` : html`<td class="audit-note">n/a</td>`)}</tr>`)}</tbody></table></div>`
    : html`<p class="audit-note">Every delivered deal's titles and registration are done.</p>`;
}

// ---------- Setup & month-end ----------

async function acSetup() {
  const [s, chart, check] = await Promise.all([acGet('/accounting/settings'), acChart(true), acGet('/accounting/inventory-check')]);
  acHead('Setup & Month-End', `Current month ${s.currentMonth} · ${s.closedThrough ? `closed through ${s.closedThrough}` : 'no months closed yet'}${s.startedOn ? ` · books started ${acDate(s.startedOn)}` : ''}`);
  const prev = (() => { const [y, m] = s.currentMonth.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
  acBody().innerHTML = html`<div class="ac-grid2 ac-form">
    <div class="ac-box">
      <div class="ca-section-title">Close a month</div>
      <p class="audit-note">A closed month is final: nothing can be dated in it. Automatic entries for it land on the first open day.</p>
      ${acCanClose() ? html`<div class="ac-row2"><label>Month <input type="month" id="acCloseMonth" value="${prev}" max="${prev}" /></label>
        <div class="ac-btn-row"><button type="button" class="btn-primary" data-ac-closemonth>Close month</button></div></div>
        ${s.closedThrough ? html`<button type="button" class="link-btn" data-ac-reopen="${s.closedThrough}">Reopen ${s.closedThrough}…</button>` : ''}` : html`<p class="audit-note">Only the office can close months.</p>`}
    </div>
    <div class="ac-box">
      <div class="ca-section-title">Starting balances</div>
      <p class="audit-note">Cars and parts already on hand from before the books started go on as starting balances. Running it again only adds what's missing.</p>
      ${check.length ? html`<p><strong>${check.length}</strong> car${check.length === 1 ? '' : 's'} where the books and inventory disagree:</p>
        <ul class="ac-todo">${check.slice(0, 8).map(c => html`<li>#${c.stockNumber} ${c.vehicle}: cost ${acMoney(c.cost)}, books ${acMoney(c.books)}</li>`)}</ul>` : html`<p class="ac-good">The books match every car in stock.</p>`}
      ${acCanClose() ? html`<button type="button" class="btn-secondary" data-ac-starting>Bring inventory onto the books</button>` : ''}
    </div>
    <div class="ac-box">
      <div class="ca-section-title">Settings</div>
      <label class="ac-check"><input type="checkbox" id="acAutoBook" ${s.autoBookFinalized ? html`checked` : ''} ${acCanClose() ? '' : html`disabled`} /> Book deals automatically when F&amp;I finalizes them</label>
      <div class="ac-row2"><label>Next check number <input type="number" id="acNextCheck" value="${s.nextCheckNumber}" ${acCanClose() ? '' : html`disabled`} /></label>
        <div class="ac-btn-row">${acCanClose() ? html`<button type="button" class="btn-secondary" data-ac-savecheck>Save</button>` : ''}</div></div>
    </div>
  </div>
  <div class="ca-section-title">Chart of accounts ${acCanClose() ? html`<button type="button" class="btn-secondary btn-small" data-ac-newaccount>+ Account</button>` : ''}</div>
  <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>Department</th><th>Tracked by item</th><th class="num">Balance</th><th></th></tr></thead><tbody>
    ${chart.accounts.map(a => html`<tr class="${a.active ? '' : 'ac-inactive'}"><td><a href="#" class="ac-link" data-ac-ledger="${a.number}">${a.number}</a></td><td>${a.name}${a.key ? html` <span class="ac-badge" title="Automatic posting uses this account">auto</span>` : ''}</td>
      <td>${a.type}</td><td>${chart.depts[a.dept] || ''}</td><td>${a.scheduled ? 'Yes' : ''}</td><td class="num">${acAmt(a.balance)}</td>
      <td>${acCanClose() ? html`<button type="button" class="btn-secondary btn-small" data-ac-editaccount="${a.number}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div>`;
}

function acAccountForm(a) {
  const c = ac.chart;
  acModal(html`<h2>${a ? `Account ${a.number}` : 'New account'}</h2>
    <form id="acAccountForm" data-number="${a ? a.number : ''}">
      ${a ? '' : html`<label>Number <input name="number" required pattern="[0-9A-Za-z.\\-]{2,12}" /></label>`}
      <label>Name <input name="name" required value="${a ? a.name : ''}" /></label>
      ${a ? '' : html`<label>Type <select name="type">${c.types.map(t => html`<option value="${t}">${t}</option>`)}</select></label>`}
      <label>Department <select name="dept">${Object.entries(c.depts).map(([k, l]) => html`<option value="${k}" ${a && a.dept === k ? html`selected` : ''}>${l}</option>`)}</select></label>
      <label>Statement group <select name="grp"><option value="">--</option>${Object.entries(c.groups).map(([k, l]) => html`<option value="${k}" ${a && a.grp === k ? html`selected` : ''}>${l}</option>`)}</select></label>
      <label class="ac-check"><input type="checkbox" name="scheduled" ${a && a.scheduled ? html`checked` : ''} /> Track item by item (a schedule)</label>
      ${a ? html`<label class="ac-check"><input type="checkbox" name="active" ${a.active ? html`checked` : ''} ${a.key ? html`disabled` : ''} /> Active${a.key ? ' (used by automatic posting)' : ''}</label>` : ''}
      <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button><button type="submit" class="btn-primary">Save</button></div>
    </form>`);
}

// ---------- Clicks, changes, and forms ----------

async function acRun(fn, okMsg) {
  try { const r = await fn(); if (okMsg) acFlash(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; } catch (err) { acFlash(err.message, true); return null; }
}

const acRoot = document.getElementById('accounting');
for (const root of [acRoot, document.getElementById('acModal')]) {
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ac-go],[data-ac-preview],[data-ac-book],[data-ac-entry],[data-ac-unbook],[data-ac-reverse],[data-book-tab],[data-ws-book],[data-ac-chargeback],[data-fill-control],[data-ac-newvendor],[data-ac-editvendor],[data-ac-newbill],[data-ac-billline],[data-ac-paybill],[data-ac-voidbill],[data-bill-filter],[data-ac-schedule],[data-ac-back-schedules],[data-ac-ledger],[data-ac-settle],[data-ac-csv-schedule],[data-ac-csv-ledger],[data-ac-newentry],[data-ac-entryline],[data-st-tab],[data-ac-closemonth],[data-ac-reopen],[data-ac-starting],[data-ac-savecheck],[data-ac-newaccount],[data-ac-editaccount]');
    if (!t) return;
    if (t.tagName === 'A') e.preventDefault();
    const d = t.dataset;
    if (d.acGo) return acGo(d.acGo);
    if (d.acPreview) return acRun(() => acPreviewDeal(d.acPreview));
    if (d.acBook) {
      t.disabled = true;
      const r = await acRun(() => acSend('POST', `/accounting/deals/${d.acBook}/book`), x => `Booked: J-${x.entry.entryNumber}`);
      t.disabled = false;
      if (r) { acCloseModal(); openAccountingView(ac.view); }
      return;
    }
    if (d.acEntry) return acRun(() => acShowEntry(d.acEntry));
    if (d.acUnbook) {
      const reason = prompt('Why is this deal being unbooked?');
      if (!reason) return;
      if (await acRun(() => acSend('POST', `/accounting/deals/${d.acUnbook}/unbook`, { reason }), 'Unbooked. It is back on the list to book.')) openAccountingView(ac.view);
      return;
    }
    if (d.acReverse) {
      const memo = prompt('Why is this entry being reversed?');
      if (memo === null) return;
      if (await acRun(() => acSend('POST', `/accounting/entries/${d.acReverse}/reverse`, { memo }), x => `Reversed by J-${x.entryNumber}`)) { acCloseModal(); openAccountingView(ac.view); }
      return;
    }
    if (d.bookTab) { ac.bookTab = d.bookTab; return acBook(); }
    if (d.wsBook) {
      const price = document.querySelector(`[data-ws-price="${d.wsBook}"]`).value, buyer = document.querySelector(`[data-ws-buyer="${d.wsBook}"]`).value;
      if (await acRun(() => acSend('POST', `/accounting/wholesale/${d.wsBook}/book`, { price, buyer }), x => `Booked: J-${x.entryNumber}`)) acBook();
      return;
    }
    if (d.acChargeback) { if (await acRun(() => acSend('POST', `/accounting/deals/${d.acChargeback}/chargeback`), x => `Posted: J-${x.entryNumber}`)) acBook(); return; }
    if (d.fillControl !== undefined) {
      const form = t.closest('form');
      form.control.value = d.fillControl; form.name.value = d.fillName || ''; form.amount.value = Math.abs(Number(d.fillAmount)).toFixed(2);
      form.querySelectorAll('.ac-open-item').forEach(b => b.classList.toggle('active', b === t));
      return;
    }
    if (d.acNewvendor !== undefined) return acVendorForm();
    if (d.acEditvendor) return acVendorForm(ac.vendors.find(v => v.id === d.acEditvendor));
    if (d.acNewbill !== undefined) return acBillForm();
    if (d.acBillline !== undefined) {
      const first = document.querySelector('#acBillLines .ac-bill-line');
      const copy = first.cloneNode(true);
      copy.querySelectorAll('input').forEach(i => { i.value = ''; });
      document.getElementById('acBillLines').appendChild(copy);
      return;
    }
    if (d.acPaybill) {
      const bill = (await acGet('/accounting/bills')).find(b => b.id === d.acPaybill);
      acModal(html`<h2>Pay ${bill.vendorName}</h2><p class="audit-note">Invoice ${bill.invoice || '--'} · due ${acDate(bill.dueDate)} · balance ${acMoney(bill.balance)}</p>
        <form id="acPayBillForm" data-id="${bill.id}">
          <div class="ac-row2"><label>Amount <input name="amount" type="number" step="0.01" value="${bill.balance.toFixed(2)}" /></label>
            <label>How <select name="method"><option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option><option value="card">Card</option></select></label></div>
          <div class="ac-row2"><label>Check # (blank = next) <input name="checkNumber" type="number" /></label><label>Date <input name="date" type="date" value="${acToday()}" /></label></div>
          <div class="modal-actions"><button type="button" class="btn-secondary" data-ac-close>Cancel</button><button type="submit" class="btn-primary">Pay</button></div>
        </form>`);
      return;
    }
    if (d.acVoidbill) {
      if (!confirm('Void this bill? Its entry is reversed.')) return;
      if (await acRun(() => acSend('POST', `/accounting/bills/${d.acVoidbill}/void`), 'Bill voided.')) acPayables();
      return;
    }
    if (d.billFilter !== undefined) { ac.billFilter = d.billFilter; return acPayables(); }
    if (d.acSchedule) { ac.schedule = d.acSchedule; return acRun(() => acScheduleDetail(d.acSchedule)); }
    if (d.acBackSchedules !== undefined) { ac.schedule = null; return acSchedules(); }
    if (d.acLedger) {
      acCloseModal();
      ac.ledger = { account: d.acLedger, control: d.acControl !== undefined ? d.acControl : null, from: d.acControl !== undefined ? '2000-01-01' : '' };
      if (ac.view === 'acctledger') return acRun(acLedger);
      return acGo('acctledger');
    }
    if (d.acSettle) { ac.cashier = { mode: d.acSettle, account: d.account, control: d.control, name: d.name, amount: d.amount }; return acGo('acctcashier'); }
    if (d.acCsvSchedule !== undefined) {
      const s = ac.lastSchedule;
      return acCsv(`schedule-${s.account.number}-${s.asOf}`, [['Control', 'Name', 'Since', 'Age (days)', 'Balance'], ...s.items.map(i => [i.control, i.name, i.first, i.age, i.balance])]);
    }
    if (d.acCsvLedger !== undefined) {
      const g = ac.ledgerData;
      return acCsv(`ledger-${g.account.number}-${g.from}-${g.to}`, [['Date', 'Entry', 'Memo', 'Control', 'Name', 'Debit', 'Credit', 'Balance'], ['', '', 'Opening balance', '', '', '', '', g.opening],
        ...g.lines.map(l => [l.date, `J-${l.entryNumber}`, l.memo, l.control, l.controlName, l.debit, l.credit, l.balance])]);
    }
    if (d.acNewentry !== undefined) return acEntryForm();
    if (d.acEntryline !== undefined) { document.getElementById('acEntryLines').insertAdjacentHTML('beforeend', String(ac.entryLine())); return; }
    if (d.stTab) { ac.statementTab = d.stTab; return acRun(acStatements); }
    if (d.acClosemonth !== undefined) {
      const month = document.getElementById('acCloseMonth').value;
      if (!month || !confirm(`Close ${month}? Nothing more can be dated in it.`)) return;
      if (await acRun(() => acSend('POST', '/accounting/close', { month }), `${month} closed.`)) acSetup();
      return;
    }
    if (d.acReopen) {
      const reason = prompt(`Why is ${d.acReopen} being reopened?`);
      if (!reason) return;
      if (await acRun(() => acSend('POST', '/accounting/reopen', { month: d.acReopen, reason }), `${d.acReopen} reopened.`)) acSetup();
      return;
    }
    if (d.acStarting !== undefined) {
      if (await acRun(() => acSend('POST', '/accounting/starting-balances'), r => (r.entry ? `Posted J-${r.entry.entryNumber}: ${r.carsFixed} cars${r.partsDiff ? ' and parts' : ''}.` : 'Nothing to add: the books already match.'))) acSetup();
      return;
    }
    if (d.acSavecheck !== undefined) { await acRun(() => acSend('PUT', '/accounting/settings', { nextCheckNumber: document.getElementById('acNextCheck').value }), 'Saved.'); return; }
    if (d.acNewaccount !== undefined) return acAccountForm(null);
    if (d.acEditaccount) return acAccountForm(ac.chart.accounts.find(a => a.number === d.acEditaccount));
  });
}

acRoot.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'acAutoBook') { await acRun(() => acSend('PUT', '/accounting/settings', { autoBookFinalized: t.checked }), t.checked ? 'Deals will book when finalized.' : 'Deals wait to be booked by hand.'); return; }
  if (t.matches('[data-cash-form] [name="account"]')) { const form = t.closest('form'); form.control.value = ''; form.name.value = ''; return acLoadOpenItems(form.dataset.cashForm); }
  if (t.id === 'acStatementMonth') { ac.statementMonth = t.value; return acRun(acStatements); }
  if (t.dataset.titleField) { await acRun(() => acSend('PUT', `/accounting/titles/${t.dataset.titleDeal}`, { [t.dataset.titleField]: t.value }), 'Saved.'); return; }
  if (t.id === 'acTitlesAll') { ac.titlesAll = t.checked; return acTitles(); }
  if (t.closest('#acBankForm')) {
    if (t.name === 'account' || t.name === 'statementDate') { ac.bankAccount = t.form.account.value; ac.bankThrough = t.form.statementDate.value; return acRun(acBank); }
    if (t.id === 'acBankAll') t.form.querySelectorAll('[data-bank-line]').forEach(c => { c.checked = t.checked; });
    return acBankTotals();
  }
});
acRoot.addEventListener('input', (e) => { if (e.target.closest('#acBankForm')) acBankTotals(); });

const acModalEl = document.getElementById('acModal');
acModalEl.addEventListener('input', (e) => {
  if (e.target.closest('#acEntryForm')) acEntryTotals();
  if (e.target.closest('#acBillForm')) {
    const total = [...document.querySelectorAll('#acBillForm [name="lineAmount"]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
    document.getElementById('acBillTotal').textContent = acMoney(total);
  }
});
acModalEl.addEventListener('change', (e) => {
  if (e.target.name === 'vendorId') acBillDefaults();
  if (e.target.closest('#acBillForm') && e.target.name === 'account') e.target.dataset.touched = '1';
});

// Forms on the page and in the dialog.
document.addEventListener('submit', async (e) => {
  const f = e.target;
  const val = name => (f.elements[name] ? f.elements[name].value : '');
  if (f.matches('[data-cash-form]')) {
    e.preventDefault();
    const mode = f.dataset.cashForm;
    const body = { account: val('account'), control: val('control'), amount: val('amount'), method: val('method'), memo: val('memo'), date: val('date') === acToday() ? '' : val('date') };
    if (mode === 'in') Object.assign(body, { from: val('name'), reference: val('reference') });
    else Object.assign(body, { payee: val('name'), checkNumber: val('reference') });
    const r = await acRun(() => acSend('POST', mode === 'in' ? '/accounting/receipts' : '/accounting/payments', body), x => `${mode === 'in' ? 'Received' : x.checkNumber ? `Check #${x.checkNumber} written` : 'Paid'}: J-${x.entryNumber}`);
    if (r) acCashier();
    return;
  }
  if (f.id === 'acVendorForm') {
    e.preventDefault();
    const body = { name: val('name'), contact: val('contact'), phone: val('phone'), email: val('email'), terms: val('terms'), address: val('address'), defaultAccount: val('defaultAccount') };
    if (f.elements.active) body.active = f.elements.active.checked;
    if (await acRun(() => (f.dataset.id ? acSend('PUT', `/accounting/vendors/${f.dataset.id}`, body) : acSend('POST', '/accounting/vendors', body)), 'Vendor saved.')) { acCloseModal(); acPayables(); }
    return;
  }
  if (f.id === 'acBillForm') {
    e.preventDefault();
    const lines = [...f.querySelectorAll('.ac-bill-line')].map(l => ({ account: l.querySelector('[name="account"]').value, memo: l.querySelector('[name="lineMemo"]').value, amount: l.querySelector('[name="lineAmount"]').value })).filter(l => Number(l.amount));
    if (await acRun(() => acSend('POST', '/accounting/bills', { vendorId: val('vendorId'), invoice: val('invoice'), date: val('date'), dueDate: val('dueDate'), memo: val('memo'), lines }), x => `Bill saved: J-${x.entryNumber}`)) { acCloseModal(); acPayables(); }
    return;
  }
  if (f.id === 'acPayBillForm') {
    e.preventDefault();
    if (await acRun(() => acSend('POST', `/accounting/bills/${f.dataset.id}/pay`, { amount: val('amount'), method: val('method'), checkNumber: val('checkNumber'), date: val('date') === acToday() ? '' : val('date') }), x => (x.checkNumber ? `Check #${x.checkNumber} written.` : 'Paid.'))) { acCloseModal(); acPayables(); }
    return;
  }
  if (f.id === 'acEntryForm') {
    e.preventDefault();
    const lines = [...f.querySelectorAll('#acEntryLines tr')].map(r => ({ account: r.querySelector('[name="account"]').value, control: r.querySelector('[name="control"]').value, memo: r.querySelector('[name="memo"]').value, debit: r.querySelector('[name="debit"]').value, credit: r.querySelector('[name="credit"]').value })).filter(l => l.account && (Number(l.debit) || Number(l.credit)));
    if (await acRun(() => acSend('POST', '/accounting/entries', { date: val('date'), journal: val('journal'), memo: val('entryMemo'), lines }), x => `Posted J-${x.entryNumber}`)) { acCloseModal(); acJournal(); }
    return;
  }
  if (f.id === 'acJournalFilter') {
    e.preventDefault();
    ac.journalFilter = { q: val('q'), journal: val('journal'), from: val('from'), to: val('to') };
    return acRun(acJournal);
  }
  if (f.id === 'acLedgerFilter') {
    e.preventDefault();
    ac.ledger = { account: val('account'), from: val('from'), to: val('to'), control: val('control') ? val('control') : null };
    return acRun(acLedger);
  }
  if (f.id === 'acBankForm') {
    e.preventDefault();
    const lines = [...f.querySelectorAll('[data-bank-line]:checked')].map(c => c.dataset.bankLine);
    if (await acRun(() => acSend('POST', '/accounting/bank/reconcile', { account: val('account'), statementDate: val('statementDate'), statementBalance: val('statementBalance'), lines }), x => `Reconciled: ${x.cleared} items cleared.`)) acBank();
    return;
  }
  if (f.id === 'acAccountForm') {
    e.preventDefault();
    const body = { name: val('name'), dept: val('dept'), grp: val('grp'), scheduled: f.elements.scheduled.checked };
    if (f.elements.active && !f.elements.active.disabled) body.active = f.elements.active.checked;
    const r = await acRun(() => (f.dataset.number ? acSend('PUT', `/accounting/accounts/${f.dataset.number}`, body) : acSend('POST', '/accounting/accounts', { ...body, number: val('number'), type: val('type') })), 'Account saved.');
    if (r) { acCloseModal(); await acChart(true); acSetup(); }
  }
});

// Started straight on an Accounting screen (a reload).
if (VIEW_PANELS[currentView] === 'accounting') openAccountingView(currentView);
