// insight-ui.js -- Insight Domus screens. Loaded after app.js (and
// accounting-ui.js, whose card and table styles it shares).
//
// Sales Summary, Leaderboard, F&I & Lenders, Inventory Analysis, Marketing,
// and Gross Trend -- each with a date range (this month by default), print,
// and CSV.

const ins = { view: 'insightsales', from: '', to: '', invType: '', leaderTab: 'salespeople', last: null };

const inMoney = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--'
  : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const inNum = (v, d = 1) => (v === null || v === undefined ? '--' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const inPct = v => (v === null || v === undefined ? '--' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
const inDay = d => { const t = new Date(); t.setDate(t.getDate() + d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const inShortDate = iso => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

async function inGet(path) {
  const res = await fetch(`${API}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
const inRangeQs = () => new URLSearchParams(Object.entries({ from: ins.from, to: ins.to }).filter(([, v]) => v)).toString();

// A change against an earlier period: +/- sign and words carry it, color only helps.
function inDelta(now, then, money) {
  if (then === null || then === undefined || now === null || now === undefined) return html`<span class="in-delta">--</span>`;
  const d = Number(now) - Number(then);
  if (!d) return html`<span class="in-delta">same</span>`;
  return html`<span class="in-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲ +' : '▼ −'}${money ? inMoney(Math.abs(d)) : inNum(Math.abs(d))}</span>`;
}
// A thin bar for a value against the biggest in its column, with its own label.
const inBar = (v, max, label) => html`<span class="in-bar" title="${label || ''}"><span style="width:${max > 0 && Number(v) > 0 ? Math.max(2, Math.round(Number(v) / max * 100)) : 0}%"></span></span>`;

function inHead(title, sub, { range = true, extra = '' } = {}) {
  document.getElementById('inTitle').textContent = title;
  document.getElementById('inSub').textContent = sub || '';
  document.getElementById('inTools').innerHTML = String(html`${range ? html`
    <select id="inPreset" title="Quick ranges"><option value="">Range…</option><option value="mtd">This month</option><option value="last">Last month</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="ytd">This year</option></select>
    <label class="deal-date-label">From <input type="date" id="inFrom" value="${ins.from || `${inDay(0).slice(0, 7)}-01`}" /></label>
    <label class="deal-date-label">To <input type="date" id="inTo" value="${ins.to || inDay(0)}" /></label>` : ''}${extra}
    <button type="button" class="btn-secondary" data-in-csv>CSV</button><button type="button" class="btn-secondary" onclick="window.print()">Print</button>`);
}
const inBody = () => document.getElementById('inBody');

async function openInsightView(view) {
  ins.view = view;
  inBody().innerHTML = html`<p class="audit-note">Loading…</p>`;
  try {
    await ({ insightheartbeat: inHeartbeat, insightpeople: inPeople, insighttrades: inTrades, insightparts: inParts, insightstore: inStore, insightfixed: inFixed, insightexpenses: inExpenses, insightsales: inSales, insightleaders: inLeaders, insightfi: inFi, insightinventory: inInventory, insightmarketing: inMarketing, insighttrend: inTrend })[view]();
  } catch (err) { inBody().innerHTML = html`<p class="ac-error">${err.message}</p>`; }
}

// ---------- Sales summary ----------

async function inSales() {
  const s = await inGet(`/insight/sales?${inRangeQs()}`);
  inHead('Sales Summary', `${inShortDate(`${s.from}T12:00`)} – ${inShortDate(`${s.to}T12:00`)} · against the period before and the same dates last year`);
  const c = s.current, p = s.prior, ly = s.lastYear;
  const paced = v => (s.pace && s.pace.factor ? Math.round(v * s.pace.factor) : null);
  const tile = (label, now, before, lastYr, money, pace, goal) => html`<div class="ac-card in-tile">
    <span class="ac-card-label">${label}</span><span class="ac-card-value">${money ? inMoney(now) : inNum(now)}</span>
    <span class="in-cmp"><span>Prior period</span>${inDelta(now, before, money)}</span>
    <span class="in-cmp"><span>Last year</span>${inDelta(now, lastYr, money)}</span>
    ${pace !== null && pace !== undefined ? html`<span class="in-cmp"><span>Pace</span><strong>${money ? inMoney(pace) : inNum(pace, 0)}</strong></span>` : ''}
    ${goal ? html`<span class="in-cmp"><span>Goal</span><strong>${money ? inMoney(goal) : inNum(goal, 0)}</strong></span>` : ''}</div>`;
  const goals = s.goals || {};
  const unitGoal = (Number(goals.newUnits) || 0) + (Number(goals.usedUnits) || 0) || null;
  const grossGoal = (Number(goals.newGross) || 0) + (Number(goals.usedGross) || 0) || null;
  const row = (label, b) => html`<tr><td><strong>${label}</strong></td><td class="num">${inNum(b.units)}</td><td class="num">${inNum(b.final)}</td><td class="num">${inNum(b.notFinal)}</td>
    <td class="num">${inMoney(b.front)}</td><td class="num">${inMoney(b.back)}</td><td class="num">${inMoney(b.incentives)}</td><td class="num">${inMoney(b.chargebacks)}</td>
    <td class="num"><strong>${inMoney(b.gross)}</strong></td><td class="num">${inMoney(b.pvr.front)}</td><td class="num">${inMoney(b.pvr.back)}</td><td class="num"><strong>${inMoney(b.pvr.total)}</strong></td><td class="num">${inNum(b.productsPerDeal)}</td></tr>`;
  ins.last = { name: `sales-${s.from}-${s.to}`, rows: [['Deal', 'Date', 'Customer', 'Vehicle', 'Stock', 'Type', 'Salespeople', 'F&I', 'Lender', 'Front', 'Back', 'Total', 'Final'],
    ...s.log.map(d => [`D-${d.dealNumber}`, d.day.slice(0, 10), d.customer, d.vehicle, d.stockNumber, d.type, d.salespeople.join(' / '), d.fi, d.lender, d.front, d.back, d.total, d.final ? 'yes' : 'no'])] };
  inBody().innerHTML = html`
    <div class="ac-cards">
      ${tile('Retail units', c.total.units, p.total.units, ly.total.units, false, paced(c.total.units), unitGoal)}
      ${tile('New', c.new.units, p.new.units, ly.new.units, false, paced(c.new.units), goals.newUnits)}
      ${tile('Used', c.used.units, p.used.units, ly.used.units, false, paced(c.used.units), goals.usedUnits)}
      ${tile('Total gross', c.total.gross, p.total.gross, ly.total.gross, true, paced(c.total.gross), grossGoal)}
      ${tile('Front per vehicle', c.total.pvr.front, p.total.pvr.front, ly.total.pvr.front, true)}
      ${tile('Back per vehicle', c.total.pvr.back, p.total.pvr.back, ly.total.pvr.back, true)}
      ${tile('Total per vehicle', c.total.pvr.total, p.total.pvr.total, ly.total.pvr.total, true)}
      ${tile('Wholesale gross', c.wholesale.gross, p.wholesale.gross, ly.wholesale.gross, true)}
    </div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th></th><th class="num">Units</th><th class="num">Final</th><th class="num">Not final</th><th class="num">Front</th><th class="num">Back</th>
      <th class="num">Incentives</th><th class="num">Chargebacks</th><th class="num">Gross</th><th class="num">Front PVR</th><th class="num">Back PVR</th><th class="num">Total PVR</th><th class="num">Products / deal</th></tr></thead>
      <tbody>${row('New', c.new)}${row('Used', c.used)}${row('Total', c.total)}</tbody></table></div>
    ${s.pace ? html`<p class="audit-note">Pace: ${s.pace.elapsed} of ${s.pace.total} open days gone this month.</p>` : ''}
    <div class="ca-section-title">Sales log (${s.log.length})</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Date</th><th>Deal</th><th>Customer</th><th>Vehicle</th><th>Salespeople</th><th>F&amp;I</th><th class="num">Front</th><th class="num">Back</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${s.log.length ? s.log.map(d => html`<tr><td>${inShortDate(d.day)}</td><td><strong>D-${d.dealNumber}</strong></td><td>${d.customer}</td><td>${d.vehicle}<div class="audit-note">#${d.stockNumber} · ${d.type === 'new' ? 'New' : 'Used'}${d.lender ? ` · ${d.lender}` : ' · Cash'}</div></td>
        <td>${d.salespeople.join(', ') || '--'}</td><td>${d.fi || '--'}</td><td class="num">${inMoney(d.front)}</td><td class="num">${inMoney(d.back)}</td><td class="num"><strong>${inMoney(d.total)}</strong></td>
        <td>${d.final ? html`<span class="ac-badge ac-badge-blue">Final</span>` : html`<span class="ac-badge">Not final</span>`}</td></tr>`) : html`<tr><td colspan="10" class="audit-note">No deals in this range.</td></tr>`}</tbody></table></div>`;
}

// ---------- Leaderboard ----------

async function inLeaders() {
  const b = await inGet(`/insight/leaderboard?${inRangeQs()}`);
  inHead('Leaderboard', 'Split deals count as a share for each salesperson.');
  const tabs = [['salespeople', 'Salespeople'], ['managers', 'Sales managers'], ['fi', 'F&I managers']];
  const list = b[ins.leaderTab];
  const maxUnits = Math.max(0, ...list.map(x => x.units));
  ins.last = { name: `leaderboard-${ins.leaderTab}-${b.from}-${b.to}`, rows: [['Rank', 'Name', 'Units', 'New', 'Used', 'Front', 'Back', 'Total gross', 'Per vehicle', 'Products / deal', 'Leads', 'Close %'],
    ...list.map((x, i) => [i + 1, x.name, x.units, x.new, x.used, x.front, x.back, x.total, x.pvr, x.productsPerDeal, x.leads || '', x.closeRate ?? ''])] };
  inBody().innerHTML = html`<div class="view-toggle ac-tabs">${tabs.map(([k, l]) => html`<button type="button" class="view-toggle-btn ${ins.leaderTab === k ? 'active' : ''}" data-in-leader="${k}">${l}</button>`)}</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>#</th><th>Name</th><th>Units</th><th class="num">New</th><th class="num">Used</th><th class="num">Front</th><th class="num">Back</th><th class="num">Total gross</th><th class="num">Per vehicle</th><th class="num">Products / deal</th>
      ${ins.leaderTab === 'salespeople' ? html`<th class="num">Leads</th><th class="num">Close %</th>` : ''}</tr></thead><tbody>
      ${list.length ? list.map((x, i) => html`<tr><td class="in-rank">${i + 1}</td><td><strong>${x.name}</strong></td>
        <td class="in-bar-cell"><span class="in-bar-num">${inNum(x.units)}</span>${inBar(x.units, maxUnits, `${inNum(x.units)} units`)}</td>
        <td class="num">${inNum(x.new)}</td><td class="num">${inNum(x.used)}</td><td class="num">${inMoney(x.front)}</td><td class="num">${inMoney(x.back)}</td><td class="num"><strong>${inMoney(x.total)}</strong></td>
        <td class="num">${inMoney(x.pvr)}</td><td class="num">${inNum(x.productsPerDeal)}</td>
        ${ins.leaderTab === 'salespeople' ? html`<td class="num">${x.leads || '--'}</td><td class="num">${inPct(x.closeRate)}</td>` : ''}</tr>`)
        : html`<tr><td colspan="12" class="audit-note">No deals in this range${ins.leaderTab !== 'salespeople' ? ' with this role on them' : ''}.</td></tr>`}</tbody></table></div>`;
}

// ---------- F&I and lenders ----------

// The finance summary: four tiles, then one table read five ways (gross,
// per deal, penetration, per product sold, counts), each F&I manager
// opening to their deals; and the lender report.
const FI_TABS = [['gross', 'Gross'], ['pvr', 'Per deal'], ['pen', 'Penetration'], ['per', '$ per product sold'], ['counts', 'Counts'], ['lenders', 'Lenders']];
async function inFi() {
  const qs = new URLSearchParams(Object.entries({ from: ins.from, to: ins.to, type: ins.fiType || '' }).filter(([, v]) => v));
  const f = await inGet(`/insight/fi?${qs}`);
  ins.fi = f;
  const tab = ins.fiTab || 'gross';
  inHead('F&I Summary', `${inShortDate(`${f.from}T12:00`)} – ${inShortDate(`${f.to}T12:00`)} · retail deals (wholesale left out) · back gross = product profit + reserve`, {
    extra: html`<select id="inFiType"><option value="">New &amp; used</option><option value="new" ${f.type === 'new' ? html`selected` : ''}>New</option><option value="used" ${f.type === 'used' ? html`selected` : ''}>Used</option></select>`
  });
  const S = f.summary;
  const penMax = Math.max(150, S.penetration.target * 1.25, S.penetration.current || 0, S.penetration.lastYear || 0);
  const penRow = (label, v) => html`<div class="in-fi-pen"><span>${label}</span><span class="in-fi-track"><span class="in-fi-fill ${v !== null && v >= S.penetration.target ? 'good' : 'low'}" style="width:${v ? Math.min(100, v / penMax * 100) : 0}%"></span>
    <span class="in-fi-target" style="left:${Math.min(100, S.penetration.target / penMax * 100)}%" title="Target ${S.penetration.target}%"></span></span><strong>${inPct(v)}</strong></div>`;
  const tiles = html`<div class="in-fi-tiles">
    <div class="ac-box in-fi-tile"><div class="ca-section-title">Back gross</div><div class="in-fi-split">
      <dl><dt>Not final</dt><dd>${inMoney(S.gross.notFinal)}</dd><dt>Final</dt><dd>${inMoney(S.gross.final)}</dd><dt>Actual</dt><dd><strong>${inMoney(S.gross.actual)}</strong></dd></dl>
      <div class="in-fi-big"><span class="ac-card-label">${S.gross.pace !== null ? 'At this pace' : 'Actual'}</span><span class="in-fi-num">${inMoney(S.gross.pace ?? S.gross.actual)}</span>
        <span class="audit-note">${S.gross.lastYear === null ? 'No deals these dates last year' : html`Last year ${inMoney(S.gross.lastYear)} ${inDelta(S.gross.pace ?? S.gross.actual, S.gross.lastYear, true)}`}</span></div></div></div>
    <div class="ac-box in-fi-tile"><div class="ca-section-title">Back per deal</div><div class="in-fi-split">
      <dl><dt>Not final</dt><dd>${inMoney(S.pvr.notFinal)}</dd><dt>Final</dt><dd>${inMoney(S.pvr.final)}</dd><dt>Products only</dt><dd>${inMoney(S.pvr.product)}</dd></dl>
      <div class="in-fi-big"><span class="ac-card-label">Actual</span><span class="in-fi-num">${inMoney(S.pvr.actual)}</span>
        <span class="audit-note">${S.pvr.lastYear === null ? 'No deals these dates last year' : html`Last year ${inMoney(S.pvr.lastYear)} ${inDelta(S.pvr.actual, S.pvr.lastYear, true)}`}</span></div></div></div>
    <div class="ac-box in-fi-tile"><div class="ca-section-title">Products per deal
      ${f.canSetTarget ? html`<button type="button" class="btn-secondary in-fi-target-btn" data-in-fi-target>Target ${S.penetration.target}%</button>` : html`<span class="audit-note">Target ${S.penetration.target}%</span>`}</div>
      ${penRow('This period', S.penetration.current)}${penRow('Last year', S.penetration.lastYear)}
      <p class="audit-note">100% = one product per deal. Reserve isn't counted.</p></div>
    <div class="ac-box in-fi-tile"><div class="ca-section-title">Chargebacks</div>
      <div class="in-fi-big"><span class="in-fi-num ${S.chargebacks < 0 ? 'neg' : ''}">${inMoney(S.chargebacks)}</span><span class="audit-note">Products cancelled and charged back in this range</span></div></div>
  </div>`;
  const tabs = html`<div class="in-tabs" role="tablist">${FI_TABS.map(([k, label]) => html`<button type="button" role="tab" class="${k === tab ? 'active' : ''}" aria-selected="${k === tab ? 'true' : 'false'}" data-in-fi-tab="${k}">${label}</button>`)}</div>`;
  inBody().innerHTML = html`${tiles}${tabs}<div class="ac-box in-scroll">${tab === 'lenders' ? inFiLenders(f) : inFiTable(f, tab)}</div>`;
}

// One way of reading the team table. Each value comes from a rollup
// (a manager, a deal, or the whole department).
function inFiColumns(f, tab) {
  const SHORT = { service: 'Service', creditIns: 'Credit ins.' };
  const P = f.products.map(p => ({ ...p, label: SHORT[p.key] || p.label }));
  const div = (a, b) => (b ? a / b : null);
  const pct = (a, b) => (b ? a / b * 100 : null);
  const cnt = r => ('counts' in r ? r : { counts: Object.fromEntries(P.map(p => [p.key, r.sold[p.key] ? 1 : 0])), reserveCount: r.reserve > 0 ? 1 : 0, productCount: P.filter(p => r.sold[p.key]).length, deals: 1 });
  if (tab === 'gross') return [['Front', r => r.front, 'money'], ['Reserve', r => r.reserve, 'money'], ...P.map(p => [p.label, r => r.profit[p.key], 'money']), ['Products', r => r.product, 'money'], ['Products & reserve', r => r.back, 'money'], ['Total', r => r.total, 'money']];
  if (tab === 'pvr') return [['Reserve', r => div(r.reserve, r.deals), 'money'], ...P.map(p => [p.label, r => div(r.profit[p.key], r.deals), 'money']), ['Products', r => div(r.product, r.deals), 'money'], ['Products & reserve', r => div(r.back, r.deals), 'money']];
  if (tab === 'pen') return [['Reserve', r => pct(r.reserveCount, r.deals), 'pct'], ...P.map(p => [p.label, r => pct(r.counts[p.key], r.deals), 'pct']), ['Products', r => pct(r.productCount, r.deals), 'pct'], ['Products & reserve', r => pct(r.productCount + r.reserveCount, r.deals), 'pct']];
  if (tab === 'per') return [['Reserve', r => div(r.reserve, r.reserveCount), 'money'], ...P.map(p => [p.label, r => div(r.profit[p.key], r.counts[p.key]), 'money']), ['Products', r => div(r.product, r.productCount), 'money'], ['Products & reserve', r => div(r.back, r.productCount + r.reserveCount), 'money']];
  return [['Reserve', r => cnt(r).reserveCount, 'num'], ...P.map(p => [p.label, r => cnt(r).counts[p.key], 'num']), ['Products', r => cnt(r).productCount, 'num'], ['Products & reserve', r => cnt(r).productCount + cnt(r).reserveCount, 'num']];
}
function inFiTable(f, tab) {
  const cols = inFiColumns(f, tab);
  const fmt = (v, kind) => (kind === 'money' ? inMoney(v) : kind === 'pct' ? inPct(v) : inNum(v, 0));
  const drill = tab === 'gross' || tab === 'counts';
  const open = ins.fiOpen || (ins.fiOpen = new Set());
  const filter = (ins.fiFilter || '').toLowerCase();
  const team = f.team.filter(m => !filter || m.name.toLowerCase().includes(filter) || m.list.some(d => [d.customer, d.dealNumber, d.stockNumber].join(' ').toLowerCase().includes(filter)));
  ins.last = { name: `fi-${tab}-${f.from}-${f.to}`, rows: [['F&I manager', 'Deals', ...cols.map(c => c[0])], ['Department', f.totals.deals, ...cols.map(c => c[1](f.totals) ?? '')],
    ...team.map(m => [m.name, m.deals, ...cols.map(c => c[1](m) ?? '')])] };
  const cells = r => cols.map(([, get, kind]) => html`<td class="num ${kind === 'money' && Number(get(r)) < 0 ? 'ac-late' : ''}">${fmt(get(r), kind)}</td>`);
  return html`<div class="in-fi-bar"><input type="search" id="inFiFilter" placeholder="Filter by name, customer, deal, or stock #" value="${ins.fiFilter || ''}" aria-label="Filter" />
      ${drill ? html`<button type="button" class="btn-secondary" data-in-fi-all>${open.size ? 'Hide deals' : 'Show every deal'}</button>` : ''}</div>
    <div class="table-scroll"><table class="data-table ac-table in-fi-table"><thead><tr><th>F&amp;I manager</th><th class="num">Deals</th>${cols.map(c => html`<th class="num">${c[0]}</th>`)}</tr></thead><tbody>
      <tr class="in-fi-total"><td><strong>Department</strong></td><td class="num"><strong>${f.totals.deals}</strong></td>${cells(f.totals)}</tr>
      ${team.length ? team.map(m => html`<tr><td>${drill ? html`<button type="button" class="in-fi-toggle" data-in-fi-open="${m.id}" aria-expanded="${open.has(m.id) ? 'true' : 'false'}">${open.has(m.id) ? '▾' : '▸'} ${m.name}</button>` : html`<strong>${m.name}</strong>`}</td><td class="num">${m.deals}</td>${cells(m)}</tr>
        ${drill && open.has(m.id) ? m.list.map(d => html`<tr class="in-fi-deal"><td><a href="/#deal=${d.id}" target="dealerdomus-main">Deal ${d.dealNumber || '--'}</a> · ${d.customer}
          <div class="audit-note">${d.stockNumber ? `#${d.stockNumber} · ` : ''}${d.type === 'new' ? 'New' : 'Used'} · ${d.final ? 'Final' : 'Not final'}</div></td><td class="num">1</td>${cells({ ...d, deals: 1 })}</tr>`) : ''}`)
        : html`<tr><td colspan="${cols.length + 2}" class="audit-note">${f.team.length ? 'Nothing matches the filter.' : 'No deals in this range.'}</td></tr>`}
    </tbody></table></div>
    <p class="audit-note">Products made = price less cost, line by line when the deal has product lines. Front includes incentives.</p>`;
}
// Redraw the table part only (tabs, filter, open rows) -- no new fetch.
function inFiRender() {
  const f = ins.fi, tab = ins.fiTab || 'gross';
  document.querySelectorAll('[data-in-fi-tab]').forEach(b => { b.classList.toggle('active', b.dataset.inFiTab === tab); b.setAttribute('aria-selected', b.dataset.inFiTab === tab ? 'true' : 'false'); });
  inBody().querySelector('.in-scroll').innerHTML = String(tab === 'lenders' ? inFiLenders(f) : inFiTable(f, tab));
}
async function inFiTarget() {
  const v = prompt('Products per deal target, in % (100 = one product per deal):', ins.fi.summary.penetration.target);
  if (v === null) return;
  const res = await fetch(`${API}/insight/fi-target`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ penetration: v }) });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Could not save.'); return; }
  openInsightView('insightfi');
}
function inFiLenders(f) {
  ins.last = { name: `lenders-${f.from}-${f.to}`, rows: [['Lender', 'Deals', 'Amount financed', 'Avg financed', 'Avg APR', 'Avg term', 'Reserve', 'Reserve / deal'], ...f.lenders.map(l => [l.lender, l.deals, l.financed, l.avgFinanced, l.avgApr, l.avgTerm, l.reserve, l.reservePerDeal])] };
  const maxFinanced = Math.max(0, ...f.lenders.map(l => l.financed));
  return html`<div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Lender</th><th class="num">Deals</th><th>Amount financed</th><th class="num">Avg financed</th><th class="num">Avg APR</th><th class="num">Avg term</th><th class="num">Reserve</th><th class="num">Reserve / deal</th></tr></thead><tbody>
      ${f.lenders.length ? f.lenders.map(l => html`<tr><td><strong>${l.lender}</strong></td><td class="num">${l.deals}</td><td class="in-bar-cell"><span class="in-bar-num">${inMoney(l.financed)}</span>${inBar(l.financed, maxFinanced, inMoney(l.financed))}</td>
        <td class="num">${inMoney(l.avgFinanced)}</td><td class="num">${inPct(l.avgApr)}</td><td class="num">${l.avgTerm} mo</td><td class="num">${inMoney(l.reserve)}</td><td class="num">${inMoney(l.reservePerDeal)}</td></tr>`)
        : html`<tr><td colspan="8" class="audit-note">No financed deals in this range.</td></tr>`}</tbody></table></div>
    <p class="audit-note">${f.deals - f.cash} financed · ${f.cash} cash · ${inMoney(f.reserve)} reserve.</p>`;
}

// ---------- Trade-ins ----------

async function inTrades() {
  const qs = new URLSearchParams(Object.entries({ from: ins.from, to: ins.to, type: ins.tradeType || '' }).filter(([, v]) => v));
  const t = await inGet(`/insight/trades?${qs}`);
  inHead('Trade-ins', 'Share of sold deals with a trade. Split deals count as shares.', {
    extra: html`<select id="inTradeType"><option value="">New &amp; used</option><option value="new" ${t.type === 'new' ? html`selected` : ''}>New</option><option value="used" ${t.type === 'used' ? html`selected` : ''}>Used</option></select>`
  });
  const cols = [{ key: 'all', label: 'All deals' }, ...t.groups];
  ins.last = { name: `trade-ins-${t.from}-${t.to}`, rows: [['Salesperson', ...cols.flatMap(c => [`${c.label} deals`, `${c.label} trades`, `${c.label} trade %`])],
    ['Store', ...cols.flatMap(c => [t.store[c.key].deals, t.store[c.key].trades, t.store[c.key].pct ?? ''])],
    ...t.people.map(p => [p.name, ...cols.flatMap(c => [p[c.key].deals, p[c.key].trades, p[c.key].pct ?? ''])])] };
  const cell = v => html`<td class="num">${v.deals ? html`<strong>${inPct(v.pct)}</strong><div class="audit-note">${inNum(v.trades)} of ${inNum(v.deals)}</div>` : html`<span class="audit-note">--</span>`}</td>`;
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      ${cols.map(c => html`<div class="ac-card"><span class="ac-card-label">${c.key === 'all' ? 'Store trade %' : c.label}</span><span class="ac-card-value">${inPct(t.store[c.key].pct)}</span>
        <span class="ac-card-sub">${inNum(t.store[c.key].trades)} trades on ${inNum(t.store[c.key].deals)} deals</span></div>`)}
    </div>
    <div class="ac-box in-scroll"><div class="ca-section-title">By salesperson</div>
      <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Salesperson</th>${cols.map(c => html`<th class="num">${c.label}</th>`)}</tr></thead><tbody>
        <tr class="in-fi-total"><td><strong>Store</strong></td>${cols.map(c => cell(t.store[c.key]))}</tr>
        ${t.people.length ? t.people.map(p => html`<tr><td><strong>${p.name}</strong></td>${cols.map(c => cell(p[c.key]))}</tr>`)
          : html`<tr><td colspan="${cols.length + 1}" class="audit-note">No deals in this range.</td></tr>`}</tbody></table></div>
      <p class="audit-note">Internet = website, Autotrader, CarGurus, Facebook. Other = referral and anything else.</p></div>
    <div class="ac-box in-scroll"><div class="ca-section-title">Deals</div>
      <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Deal</th><th>Customer</th><th>Vehicle</th><th>Source</th><th>Salesperson</th><th>Trade</th></tr></thead><tbody>
        ${t.deals.length ? t.deals.map(d => html`<tr><td><a href="/#deal=${d.id}" target="dealerdomus-main">Deal ${d.dealNumber || '--'}</a></td><td>${d.customer}</td><td>${d.vehicle}<div class="audit-note">${d.type === 'new' ? 'New' : 'Used'}</div></td>
          <td>${formatSource(d.source)}</td><td>${d.salespeople.join(', ') || '--'}</td><td>${d.trade ? html`<strong>Yes</strong>` : 'No'}</td></tr>`)
          : html`<tr><td colspan="6" class="audit-note">No deals in this range.</td></tr>`}</tbody></table></div></div>`;
}

// ---------- Inventory ----------

async function inInventory() {
  const v = await inGet(`/insight/inventory?${new URLSearchParams(Object.entries({ type: ins.invType, from: ins.from, to: ins.to }).filter(([, x]) => x))}`);
  inHead('Inventory Analysis', v.seeCost ? 'Aging, model pacing, and turn. Wholesale uses the date range.' : 'Cost is hidden for your role.', {
    extra: html`<select id="inInvType"><option value="">New &amp; used</option><option value="new" ${ins.invType === 'new' ? html`selected` : ''}>New</option><option value="used" ${ins.invType === 'used' ? html`selected` : ''}>Used</option></select>`
  });
  ins.last = { name: `inventory${ins.invType ? `-${ins.invType}` : ''}`, rows: [['Stock', 'Vehicle', 'Type', 'Days', 'Miles', 'Price', ...(v.seeCost ? ['Cost', 'Margin'] : []), 'Open ROs'],
    ...v.list.map(c => [c.stockNumber, c.vehicle, c.type, c.age, c.miles, c.price, ...(v.seeCost ? [c.cost, c.margin] : []), c.openROs.map(r => `RO-${r.roNumber}`).join(' ')])] };
  const maxBucket = Math.max(0, ...v.buckets.map(b => b.units));
  const maxSupply = Math.max(0, ...v.pacing.map(m => m.daysSupply || 0));
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">In stock</span><span class="ac-card-value">${v.units}</span>${v.seeCost ? html`<span class="ac-card-sub">${inMoney(v.value)} at cost</span>` : ''}</div>
      <div class="ac-card"><span class="ac-card-label">Average age</span><span class="ac-card-value">${v.avgAge ?? '--'} days</span></div>
      <div class="ac-card"><span class="ac-card-label">Turn</span><span class="ac-card-value">${inNum(v.turn)}×</span><span class="ac-card-sub">A year of sales ÷ what's in stock</span></div>
      <div class="ac-card"><span class="ac-card-label">Days of supply</span><span class="ac-card-value">${v.daysSupply ?? '--'}</span><span class="ac-card-sub">At the last year's selling rate</span></div>
      <div class="ac-card"><span class="ac-card-label">In service / recon</span><span class="ac-card-value">${v.reconOpen}</span><span class="ac-card-sub">Cars with an open RO</span></div>
    </div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Aging</div>
        ${v.buckets.map(b => html`<div class="in-pen"><span>${b.label} days</span>${inBar(b.units, maxBucket, `${b.units} cars`)}<strong>${b.units}${v.seeCost ? html` · ${inMoney(b.cost)}` : ''}</strong></div>`)}</div>
      <div class="ac-box"><div class="ca-section-title">Wholesale ${inShortDate(`${v.wholesale.from}T12:00`)} – ${inShortDate(`${v.wholesale.to}T12:00`)}</div>
        ${v.wholesale.cars.length ? html`<table class="data-table ac-table"><thead><tr><th>Vehicle</th><th class="num">Sold for</th>${v.seeCost ? html`<th class="num">Gross</th>` : ''}<th class="num">Days</th></tr></thead><tbody>
          ${v.wholesale.cars.map(c => html`<tr><td>${c.vehicle}<div class="audit-note">#${c.stockNumber}${c.buyer ? ` · ${c.buyer}` : ''}</div></td><td class="num">${inMoney(c.price)}</td>${v.seeCost ? html`<td class="num ${c.gross < 0 ? 'ac-neg' : ''}">${inMoney(c.gross)}</td>` : ''}<td class="num">${c.daysInStock ?? '--'}</td></tr>`)}
          ${v.seeCost ? html`<tr class="ac-strong"><td>Total</td><td></td><td class="num">${inMoney(v.wholesale.gross)}</td><td></td></tr>` : ''}</tbody></table>` : html`<p class="audit-note">Nothing wholesaled in this range.</p>`}</div>
    </div>
    <div class="ca-section-title">Model pacing</div>
    <p class="audit-note">Days of supply = in stock ÷ what sold a day over the last 90 days. High means too many; low (or none in stock with sales) means order more.</p>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Model</th><th class="num">In stock</th><th class="num">Avg age</th><th class="num">Sold 30 days</th><th class="num">Sold 90 days</th><th>Days of supply</th><th class="num">Turn</th></tr></thead><tbody>
      ${v.pacing.map(m => html`<tr><td><strong>${m.model}</strong>${m.new && m.used ? '' : html`<div class="audit-note">${m.new ? 'New' : m.used ? 'Used' : ''}</div>`}</td><td class="num">${m.inStock}</td><td class="num">${m.avgAge ?? '--'}</td><td class="num">${m.sold30}</td><td class="num">${m.sold90}</td>
        <td class="in-bar-cell">${m.daysSupply === null ? html`<span class="in-bar-num">no recent sales</span>` : !m.inStock ? html`<span class="in-bar-num ac-late">none in stock</span>` : html`<span class="in-bar-num ${m.daysSupply > 90 ? 'ac-late' : ''}">${m.daysSupply}</span>${inBar(m.daysSupply, maxSupply, `${m.daysSupply} days`)}`}</td>
        <td class="num">${inNum(m.turn)}</td></tr>`)}</tbody></table></div>
    <div class="ca-section-title">In stock, oldest first</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Stock #</th><th>Vehicle</th><th class="num">Days</th><th class="num">Miles</th><th class="num">Price</th>${v.seeCost ? html`<th class="num">Cost</th><th class="num">Margin</th>` : ''}<th>Open ROs</th></tr></thead><tbody>
      ${v.list.map(c => html`<tr><td><strong>${c.stockNumber}</strong></td><td>${c.vehicle}<div class="audit-note">${c.type === 'new' ? 'New' : 'Used'}${c.status === 'pending' ? ' · deal pending' : ''}</div></td>
        <td class="num ${c.age > 60 ? 'ac-late' : ''}">${c.age}</td><td class="num">${inNum(c.miles, 0)}</td><td class="num">${inMoney(c.price)}</td>
        ${v.seeCost ? html`<td class="num">${inMoney(c.cost)}</td><td class="num ${c.margin < 0 ? 'ac-neg' : ''}">${inMoney(c.margin)}</td>` : ''}
        <td>${c.openROs.map(r => html`<span class="ac-badge" title="${r.status}">RO-${r.roNumber} · ${r.days}d</span> `)}</td></tr>`)}</tbody></table></div>`;
}

// ---------- Marketing ----------

async function inMarketing() {
  const m = await inGet(`/insight/marketing?${inRangeQs()}`);
  inHead('Marketing', 'Where buyers come from. Ages come from credit applications, shown only as ranges.');
  ins.last = { name: `sales-by-zip-${m.from}-${m.to}`, rows: [['ZIP', 'Units', 'New', 'Used', 'Gross', 'Per vehicle'], ...m.byZip.map(z => [z.zip, z.units, z.new, z.used, z.gross, z.pvr])] };
  const maxZip = Math.max(0, ...m.byZip.map(z => z.units)), maxAge = Math.max(0, ...m.byAge.map(a => a.units)), maxLeads = Math.max(0, ...m.leadSources.map(s => s.leads));
  const label = s => (typeof formatSource === 'function' ? formatSource(s) : s);
  inBody().innerHTML = html`<div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Sales by ZIP code</div>
        ${m.byZip.length ? html`<table class="data-table ac-table"><thead><tr><th>ZIP</th><th>Units</th><th class="num">Gross</th><th class="num">Per vehicle</th></tr></thead><tbody>
          ${m.byZip.map(z => html`<tr><td><strong>${z.zip}</strong></td><td class="in-bar-cell"><span class="in-bar-num">${z.units}</span>${inBar(z.units, maxZip, `${z.units} sold`)}</td><td class="num">${inMoney(z.gross)}</td><td class="num">${inMoney(z.pvr)}</td></tr>`)}</tbody></table>` : html`<p class="audit-note">No sales in this range.</p>`}</div>
      <div class="ac-box"><div class="ca-section-title">Sales by age</div>
        ${m.byAge.length ? m.byAge.map(a => html`<div class="in-pen"><span>${a.band}</span>${inBar(a.units, maxAge, `${a.units} sold`)}<strong>${a.units} · ${inMoney(a.pvr)}/unit</strong></div>`) : html`<p class="audit-note">No sales in this range.</p>`}</div>
    </div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Sales by lead source</div>
        <table class="data-table ac-table"><thead><tr><th>Source</th><th class="num">Units</th><th class="num">Gross</th><th class="num">Per vehicle</th></tr></thead><tbody>
          ${m.bySource.length ? m.bySource.map(x => html`<tr><td>${label(x.source)}</td><td class="num">${x.units}</td><td class="num">${inMoney(x.gross)}</td><td class="num">${inMoney(x.pvr)}</td></tr>`) : html`<tr><td colspan="4" class="audit-note">No sales in this range.</td></tr>`}</tbody></table></div>
      <div class="ac-box"><div class="ca-section-title">Leads in and how many bought</div>
        <table class="data-table ac-table"><thead><tr><th>Source</th><th>Leads</th><th class="num">Bought</th><th class="num">Close %</th></tr></thead><tbody>
          ${m.leadSources.length ? m.leadSources.map(x => html`<tr><td>${label(x.source)}</td><td class="in-bar-cell"><span class="in-bar-num">${x.leads}</span>${inBar(x.leads, maxLeads, `${x.leads} leads`)}</td><td class="num">${x.sold}</td><td class="num">${inPct(x.closeRate)}</td></tr>`) : html`<tr><td colspan="4" class="audit-note">No leads in this range.</td></tr>`}</tbody></table></div>
    </div>`;
}

// ---------- Gross trend ----------

async function inTrend() {
  const t = await inGet('/insight/trend');
  inHead('Gross Trend', 'The last 12 months, against the monthly goals.', { range: false });
  ins.last = { name: 'gross-trend', rows: [['Month', 'New units', 'Used units', 'Front', 'Back', 'Gross', 'Per vehicle', 'Goal', 'Unit goal'], ...t.months.map(x => [x.month, x.newUnits, x.usedUnits, x.front, x.back, x.gross, x.pvr, x.goal ?? '', x.goalUnits ?? ''])] };
  const max = Math.max(1, ...t.months.map(x => Math.max(x.gross, x.goal || 0)));
  const monthLabel = k => new Date(`${k}-15T12:00`).toLocaleDateString([], { month: 'short', year: '2-digit' });
  const hasGoal = t.months.some(x => x.goal);
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">Units this year</span><span class="ac-card-value">${t.ytd.units}</span>${t.ytd.goalUnits ? html`<span class="ac-card-sub">Goal ${t.ytd.goalUnits}</span>` : ''}</div>
      <div class="ac-card"><span class="ac-card-label">Gross this year</span><span class="ac-card-value">${inMoney(t.ytd.gross)}</span>${t.ytd.goal ? html`<span class="ac-card-sub">Goal ${inMoney(t.ytd.goal)} · ${t.ytd.gross >= t.ytd.goal ? '▲ ahead' : '▼ behind'} by ${inMoney(Math.abs(t.ytd.gross - t.ytd.goal))}</span>` : ''}</div>
    </div>
    <div class="ac-box"><div class="ca-section-title">Gross by month ${hasGoal ? html`<span class="in-legend"><span class="in-key in-key-bar"></span>Gross <span class="in-key in-key-goal"></span>Goal</span>` : ''}</div>
      <div class="in-chart" role="img" aria-label="Gross by month for the last 12 months">
        ${t.months.map(x => html`<div class="in-col" title="${monthLabel(x.month)}: ${inMoney(x.gross)} gross, ${x.units} units${x.goal ? `, goal ${inMoney(x.goal)}` : ''}">
          <div class="in-col-plot">${x.goal ? html`<span class="in-goal" style="bottom:${Math.round(x.goal / max * 100)}%"></span>` : ''}<span class="in-col-bar" style="height:${Math.max(0, Math.round(Math.max(0, x.gross) / max * 100))}%"></span></div>
          <div class="in-col-label">${monthLabel(x.month)}</div></div>`)}
      </div></div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Month</th><th class="num">New</th><th class="num">Used</th><th class="num">Front</th><th class="num">Back</th><th class="num">Gross</th><th class="num">Per vehicle</th><th class="num">Goal</th><th class="num">vs goal</th></tr></thead><tbody>
      ${t.months.slice().reverse().map(x => html`<tr><td>${monthLabel(x.month)}</td><td class="num">${x.newUnits}</td><td class="num">${x.usedUnits}</td><td class="num">${inMoney(x.front)}</td><td class="num">${inMoney(x.back)}</td>
        <td class="num"><strong>${inMoney(x.gross)}</strong></td><td class="num">${inMoney(x.pvr)}</td><td class="num">${x.goal ? inMoney(x.goal) : '--'}</td><td class="num">${x.goal ? inDelta(x.gross, x.goal, true) : '--'}</td></tr>`)}</tbody></table></div>`;
}

// ---------- Store summary ----------

ins.month = '';
const inMonthPicker = () => html`<input type="month" id="inMonth" value="${ins.month || inDay(0).slice(0, 7)}" />`;
async function inStore() {
  const s = await inGet(`/insight/store${ins.month ? `?month=${ins.month}` : ''}`);
  const fromBooks = { books: 'Expenses come from the books (Accounting Domus).', entered: 'Expenses are the ones entered on the dashboard.', none: 'No expenses yet -- post them in Accounting or enter them on the dashboard.' }[s.expensesFrom];
  inHead('Store Summary', `${s.month}${s.current ? ` · ${s.pace.elapsed} of ${s.pace.total} open days gone` : ''} · ${fromBooks}`, { range: false, extra: inMonthPicker() });
  const cols = s.current ? ['gross', 'grossForecast', 'expenses', 'expensesForecast', 'net', 'netForecast', 'lastMonthNet', 'lastYearNet'] : ['gross', 'expenses', 'net', 'lastMonthNet', 'lastYearNet'];
  const heads = { gross: 'Gross', grossForecast: 'Gross forecast', expenses: 'Expenses', expensesForecast: 'Expenses forecast', net: 'Net', netForecast: 'Net forecast', lastMonthNet: 'Last month net', lastYearNet: 'Last year net' };
  ins.last = { name: `store-summary-${s.month}`, rows: [['Department', ...cols.map(c => heads[c])], ...s.rows.map(r => [r.label, ...cols.map(c => r[c])]), ['Total', ...cols.map(c => s.total[c])]] };
  const cell = (v, strong) => html`<td class="num ${Number(v) < 0 ? 'ac-neg' : ''}">${strong ? html`<strong>${inMoney(v)}</strong>` : inMoney(v)}</td>`;
  inBody().innerHTML = html`<div class="ac-cards">
      <div class="ac-card"><span class="ac-card-label">Net profit${s.current ? ' so far' : ''}</span><span class="ac-card-value ${s.total.net < 0 ? 'ac-neg' : ''}">${inMoney(s.total.net)}</span>
        <span class="in-cmp"><span>Last month</span>${inDelta(s.total.net, s.total.lastMonthNet, true)}</span><span class="in-cmp"><span>Last year</span>${inDelta(s.total.net, s.total.lastYearNet, true)}</span></div>
      ${s.current ? html`<div class="ac-card"><span class="ac-card-label">Net forecast</span><span class="ac-card-value ${s.total.netForecast < 0 ? 'ac-neg' : ''}">${inMoney(s.total.netForecast)}</span><span class="ac-card-sub">Where the month lands at this pace</span></div>` : ''}
      <div class="ac-card"><span class="ac-card-label">Total gross</span><span class="ac-card-value">${inMoney(s.total.gross)}</span>${s.current ? html`<span class="ac-card-sub">Forecast ${inMoney(s.total.grossForecast)}</span>` : ''}</div>
      <div class="ac-card"><span class="ac-card-label">Expenses</span><span class="ac-card-value">${inMoney(s.total.expenses)}</span>${s.current ? html`<span class="ac-card-sub">Forecast ${inMoney(s.total.expensesForecast)}</span>` : ''}</div>
      <div class="ac-card"><span class="ac-card-label">Fixed absorption</span><span class="ac-card-value">${inPct(s.absorption)}</span><span class="ac-card-sub">Service + parts gross ÷ overhead</span></div>
      <div class="ac-card"><span class="ac-card-label">Units · ROs</span><span class="ac-card-value">${s.units.new + s.units.used} · ${s.ros}</span><span class="ac-card-sub">${s.units.new} new · ${s.units.used} used</span></div>
    </div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Department</th>${cols.map(c => html`<th class="num">${heads[c]}</th>`)}</tr></thead><tbody>
      ${s.rows.map(r => html`<tr><td><strong>${r.label}</strong></td>${cols.map(c => cell(r[c], c.startsWith('net')))}</tr>`)}
      <tr class="ac-strong"><td>Total store</td>${cols.map(c => cell(s.total[c], true))}</tr></tbody></table></div>
    <p class="audit-note">Gross is live from deals, repair orders, and counter tickets -- it doesn't wait for deals to be booked. ${s.current ? 'Expense forecast: the average of the last 3 months, or this month at its pace if higher.' : ''}</p>`;
}

// ---------- Service & parts ----------

async function inFixed() {
  const f = await inGet(`/insight/fixed?${inRangeQs()}`);
  inHead('Service & Parts', 'Closed repair orders and counter sales in the range; open ROs as of now.');
  ins.last = { name: `technicians-${f.from}-${f.to}`, rows: [['Technician', 'Pay', 'Jobs', 'Hours flagged', 'Hours clocked', 'Productivity %', 'Labor sold'], ...f.techs.map(t => [t.name, t.payType, t.jobs, t.flagged, t.clocked, t.productivity ?? '', t.labor])] };
  const label = { customer: 'Customer pay', warranty: 'Warranty', internal: 'Internal', retail: 'Counter retail', wholesale: 'Wholesale', internal_: 'Internal' };
  const maxOpen = Math.max(0, ...f.openBuckets.map(b => b.ros));
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">ROs closed</span><span class="ac-card-value">${f.ros}</span><span class="ac-card-sub">${inNum(f.hours)} hours sold</span></div>
      <div class="ac-card"><span class="ac-card-label">Effective labor rate</span><span class="ac-card-value">${inMoney(f.elr)}</span><span class="ac-card-sub">Customer-pay labor ÷ hours</span></div>
      <div class="ac-card"><span class="ac-card-label">CP hours per RO</span><span class="ac-card-value">${inNum(f.cpHoursPerRo)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Service gross</span><span class="ac-card-value">${inMoney(f.serviceGross)}</span><span class="ac-card-sub">${inPct(f.laborMargin)} of labor sold</span></div>
      <div class="ac-card"><span class="ac-card-label">Parts gross</span><span class="ac-card-value">${inMoney(f.partsGross)}</span><span class="ac-card-sub">${inPct(f.partsMargin)} of parts sold</span></div>
    </div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Labor type</th><th class="num">ROs</th><th class="num">Hours</th><th class="num">Hours / RO</th><th class="num">Labor sold</th><th class="num">ELR</th><th class="num">Labor gross</th><th class="num">Parts sold</th><th class="num">Parts gross</th></tr></thead><tbody>
      ${f.byType.map(x => html`<tr><td><strong>${label[x.type]}</strong></td><td class="num">${x.ros}</td><td class="num">${inNum(x.hours)}</td><td class="num">${inNum(x.hoursPerRo)}</td><td class="num">${inMoney(x.labor)}</td><td class="num">${inMoney(x.elr)}</td><td class="num">${inMoney(x.laborGross)}</td><td class="num">${inMoney(x.parts)}</td><td class="num">${inMoney(x.partsGross)}</td></tr>`)}
      ${f.counter.map(x => html`<tr><td><strong>Counter: ${x.type === 'internal' ? 'internal' : x.type}</strong></td><td class="num">${x.tickets} tickets</td><td></td><td></td><td></td><td></td><td></td><td class="num">${inMoney(x.sale)}</td><td class="num">${inMoney(x.gross)}</td></tr>`)}
    </tbody></table></div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Technicians</div>
        <table class="data-table ac-table"><thead><tr><th>Technician</th><th class="num">Flagged</th><th class="num">Clocked</th><th>Productivity</th><th class="num">Labor sold</th></tr></thead><tbody>
          ${f.techs.length ? f.techs.map(t => html`<tr><td><strong>${t.name}</strong><div class="audit-note">${t.payType === 'flat' ? 'Flat rate' : t.payType === 'hourly' ? 'Hourly' : ''} · ${t.jobs} jobs</div></td><td class="num">${inNum(t.flagged)}</td><td class="num">${inNum(t.clocked)}</td>
            <td class="in-bar-cell">${t.productivity === null ? '--' : html`<span class="in-bar-num">${inPct(t.productivity)}</span>${inBar(Math.min(t.productivity, 150), 150, `${inPct(t.productivity)} of clocked time flagged`)}`}</td><td class="num">${inMoney(t.labor)}</td></tr>`)
            : html`<tr><td colspan="5" class="audit-note">No technician work in this range.</td></tr>`}</tbody></table>
        <p class="audit-note">Productivity = hours flagged on closed ROs ÷ hours on the clock.</p></div>
      <div class="ac-box"><div class="ca-section-title">Advisors</div>
        <table class="data-table ac-table"><thead><tr><th>Advisor</th><th class="num">ROs</th><th class="num">CP hours / RO</th><th class="num">ELR</th><th class="num">Sold</th></tr></thead><tbody>
          ${f.advisors.length ? f.advisors.map(a => html`<tr><td><strong>${a.name}</strong></td><td class="num">${a.ros}</td><td class="num">${inNum(a.hoursPerRo)}</td><td class="num">${inMoney(a.elr)}</td><td class="num">${inMoney(a.total)}</td></tr>`)
            : html`<tr><td colspan="5" class="audit-note">No ROs closed in this range.</td></tr>`}</tbody></table></div>
    </div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Open ROs by age</div>
        ${f.openBuckets.map(b => html`<div class="in-pen"><span>${b.label}</span>${inBar(b.ros, maxOpen, `${b.ros} ROs`)}<strong>${b.ros}</strong></div>`)}</div>
      <div class="ac-box"><div class="ca-section-title">Oldest open ROs</div>
        ${f.open.length ? html`<table class="data-table ac-table"><thead><tr><th>RO</th><th>Customer</th><th>Advisor</th><th class="num">Days</th><th class="num">So far</th></tr></thead><tbody>
          ${f.open.slice(0, 12).map(o => html`<tr><td><strong>RO-${o.roNumber}</strong><div class="audit-note">${o.status.replace('_', ' ')}</div></td><td>${o.customer}<div class="audit-note">${o.vehicle}</div></td><td>${o.advisor}</td><td class="num ${o.days > 3 ? 'ac-late' : ''}">${o.days}</td><td class="num">${inMoney(o.sale)}</td></tr>`)}</tbody></table>`
          : html`<p class="audit-note">No open ROs.</p>`}</div>
    </div>`;
}

// ---------- Expenses & cash ----------

async function inExpenses() {
  const e = await inGet(`/insight/expenses${ins.month ? `?month=${ins.month}` : ''}`);
  const monthLabel = k => new Date(`${k}-15T12:00`).toLocaleDateString([], { month: 'short', year: '2-digit' });
  inHead('Expenses & Cash', `Expenses from the books for ${monthLabel(e.month)} against recent months; cash as of today.`, { range: false, extra: inMonthPicker() });
  ins.last = { name: `expenses-${e.month}`, rows: [['Account', 'Department', '6-mo avg', ...e.months.map(monthLabel), '3-mo avg', 'This month', 'vs 3-mo avg', 'Last year', 'vs last year'],
    ...e.lines.map(l => [`${l.number} ${l.name}`, l.deptLabel, l.avg6, ...l.last3, l.avg3, l.mtd, l.vs3, l.lastYear, l.vsLastYear])] };
  // More spent than usual reads as a warning; the sign says which way.
  const diff = v => (Number(v) ? html`<span class="in-delta ${v > 0 ? 'down' : 'up'}">${v > 0 ? '▲ +' : '▼ −'}${inMoney(Math.abs(v))}</span>` : html`<span class="in-delta">--</span>`);
  let lastDept = null;
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">Expenses this month</span><span class="ac-card-value">${inMoney(e.totals.mtd)}</span></div>
      <div class="ac-card"><span class="ac-card-label">3-month average</span><span class="ac-card-value">${inMoney(e.totals.avg3)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Same month last year</span><span class="ac-card-value">${inMoney(e.totals.lastYear)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Deals not booked</span><span class="ac-card-value">${e.unbooked.length}</span><span class="ac-card-sub">Oldest 10 below</span></div>
      <div class="ac-card"><span class="ac-card-label">Titles not at DMV</span><span class="ac-card-value">${e.titlesOpen}</span><span class="ac-card-sub">Delivered deals</span></div>
    </div>
    <div class="ca-section-title">Key expenses</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Account</th><th class="num">6-mo avg</th>${e.months.map(m => html`<th class="num">${monthLabel(m)}</th>`)}<th class="num">3-mo avg</th><th class="num">This month</th><th class="num">vs 3-mo avg</th><th class="num">Last year</th><th class="num">vs last year</th></tr></thead><tbody>
      ${e.lines.length ? e.lines.map(l => {
        const head = l.dept !== lastDept ? html`<tr class="ac-sub"><td colspan="10">${l.deptLabel}</td></tr>` : '';
        lastDept = l.dept;
        return html`${head}<tr><td>${l.number} ${l.name}</td><td class="num">${inMoney(l.avg6)}</td>${l.last3.map(v => html`<td class="num">${inMoney(v)}</td>`)}<td class="num">${inMoney(l.avg3)}</td><td class="num"><strong>${inMoney(l.mtd)}</strong></td><td class="num">${diff(l.vs3)}</td><td class="num">${inMoney(l.lastYear)}</td><td class="num">${diff(l.vsLastYear)}</td></tr>`;
      }) : html`<tr><td colspan="10" class="audit-note">No expenses posted in the books yet. Bills and journal entries in Accounting Domus show up here.</td></tr>`}</tbody></table></div>
    <div class="ca-section-title">Cash: what's owed, and how old</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Schedule</th><th></th><th class="num">Items</th><th class="num">Total</th><th class="num">Over 30 days</th><th class="num">Oldest</th></tr></thead><tbody>
      ${e.schedules.map(x => html`<tr><td><strong>${x.number} ${x.name}</strong></td><td class="audit-note">${x.side}</td><td class="num">${x.items}</td><td class="num">${inMoney(x.total)}</td><td class="num ${x.over30 ? 'ac-late' : ''}">${inMoney(x.over30)}</td><td class="num ${x.oldest > 30 ? 'ac-late' : ''}">${x.items ? `${x.oldest}d` : '--'}</td></tr>`)}</tbody></table></div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">10 oldest contracts in transit</div>
        ${e.oldestCit.length ? html`<table class="data-table ac-table"><thead><tr><th>Deal</th><th>Lender -- customer</th><th class="num">Amount</th><th class="num">Days</th></tr></thead><tbody>
          ${e.oldestCit.map(c => html`<tr><td><strong>${c.control}</strong></td><td>${c.name}</td><td class="num">${inMoney(c.balance)}</td><td class="num ${c.age > 10 ? 'ac-late' : ''}">${c.age}</td></tr>`)}</tbody></table>` : html`<p class="audit-note">Nothing waiting on a lender.</p>`}</div>
      <div class="ac-box"><div class="ca-section-title">10 oldest deals not booked</div>
        ${e.unbooked.length ? html`<table class="data-table ac-table"><thead><tr><th>Deal</th><th>Customer</th><th class="num">Amount</th><th class="num">Days</th></tr></thead><tbody>
          ${e.unbooked.map(d => html`<tr><td><strong>D-${d.dealNumber}</strong><div class="audit-note">${d.lender}</div></td><td>${d.customer}</td><td class="num">${inMoney(d.amount)}</td><td class="num ${d.days > 3 ? 'ac-late' : ''}">${d.days}</td></tr>`)}</tbody></table>` : html`<p class="audit-note">Every delivered deal is booked.</p>`}</div>
    </div>`;
}

// ---------- Heartbeat: today ----------

ins.day = '';
async function inHeartbeat() {
  const b = await inGet(`/insight/heartbeat${ins.day ? `?date=${ins.day}` : ''}`);
  const isToday = b.date === inDay(0);
  inHead('Heartbeat', `${isToday ? 'Today' : new Date(`${b.date}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}, live. ${b.month.units} sold this month · ${inMoney(b.month.gross)} gross.`, {
    range: false, extra: html`<input type="date" id="inDayPick" value="${b.date}" /><button type="button" class="btn-secondary" data-in-refresh>↻ Refresh</button>`
  });
  ins.last = { name: `heartbeat-${b.date}`, rows: [['Person', 'Ups', 'Calls', 'Texts', 'Emails', 'Talked with', 'Visits', 'Appts due', 'Shown', 'Sold'],
    ...b.people.map(p => [p.name, p.ups, p.calls, p.texts, p.emails, p.talked, p.visits, p.apptsDue, p.shown, p.sold])] };
  const card = (label, value, sub) => html`<div class="ac-card"><span class="ac-card-label">${label}</span><span class="ac-card-value">${value}</span>${sub ? html`<span class="ac-card-sub">${sub}</span>` : ''}</div>`;
  const label = s => (typeof formatSource === 'function' ? formatSource(s) : s);
  const maxSold = Math.max(0, ...b.people.map(p => p.sold));
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      ${card('Ups', b.ups, Object.entries(b.bySource).map(([k, v]) => `${label(k)} ${v}`).join(' · ') || 'New customers today')}
      ${card('Showroom visits', b.visits)}
      ${card('Appointments', `${b.appointments.shown} / ${b.appointments.due}`, `shown · ${b.appointments.waiting} still coming${b.appointments.missed ? ` · ${b.appointments.missed} missed` : ''}`)}
      ${card('Sold', b.sold, b.sold ? `${inMoney(b.soldGross)} gross` : '')}
      ${card('Calls · texts · emails', `${b.calls} · ${b.texts} · ${b.emails}`)}
      ${card('Deals working', b.working)}
    </div>
    <div>
      <div class="ac-box in-scroll"><div class="ca-section-title">The floor</div>
        <table class="data-table ac-table"><thead><tr><th>Person</th><th class="num">Ups</th><th class="num">Calls</th><th class="num">Texts</th><th class="num">Emails</th><th class="num">Talked</th><th class="num">Visits</th><th class="num">Appts</th><th>Sold</th></tr></thead><tbody>
          ${b.people.map(p => html`<tr><td><strong>${p.name}</strong></td><td class="num">${p.ups}</td><td class="num">${p.calls}</td><td class="num">${p.texts}</td><td class="num">${p.emails}</td><td class="num">${p.talked}</td><td class="num">${p.visits}</td>
            <td class="num">${p.apptsDue ? `${p.shown}/${p.apptsDue}` : '--'}</td><td class="in-bar-cell"><span class="in-bar-num">${inNum(p.sold)}</span>${inBar(p.sold, maxSold, `${inNum(p.sold)} sold`)}</td></tr>`)}</tbody></table></div>
      <div class="ac-box"><div class="ca-section-title">Appointments still coming</div>
        ${b.upcoming.length ? html`<table class="data-table ac-table"><tbody>${b.upcoming.map(a => html`<tr><td><strong>${new Date(a.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong></td><td>${a.customer}<div class="audit-note">${a.title}</div></td><td>${a.with}</td></tr>`)}</tbody></table>`
          : html`<p class="audit-note">No more appointments ${isToday ? 'today' : 'that day'}.</p>`}</div>
    </div>`;
}

// ---------- People: goals and reviews ----------

async function inPeople() {
  const p = await inGet(`/insight/people${ins.month ? `?month=${ins.month}` : ''}`);
  inHead('People & Goals', `${p.month} · ${p.pace.elapsed} of ${p.pace.total} open days gone. Split deals count as shares.`, {
    range: false, extra: html`${inMonthPicker()}${p.canSetGoals ? html`<button type="button" class="btn-primary" data-in-goals>Set goals</button>` : ''}`
  });
  ins.people = p;
  ins.last = { name: `people-${p.month}`, rows: [['Person', 'Units', 'Goal units', '% to goal', 'Paced units', 'Gross', 'Goal gross', 'Per vehicle', 'Products / deal', 'Leads', 'Close %', 'Calls', 'Texts', 'Emails', 'Visits', 'Appts set', 'Shown'],
    ...p.people.map(x => [x.name, x.units, x.goal.units ?? '', x.toGoal.units ?? '', x.pace.units, x.gross, x.goal.gross ?? '', x.pvr ?? '', x.productsPerDeal ?? '', x.leads, x.closeRate ?? '', x.calls, x.texts, x.emails, x.visits, x.apptsSet, x.apptsShown])] };
  const meter = (v, goal, money) => (goal ? html`<div class="in-goalmeter" title="${money ? inMoney(v) : inNum(v)} of ${money ? inMoney(goal) : inNum(goal)}"><span style="width:${Math.min(100, Math.max(0, Math.round(v / goal * 100)))}%"></span></div>` : '');
  inBody().innerHTML = html`<div class="in-people">${p.people.length ? p.people.map(x => html`<div class="ac-box in-person">
      <div class="in-person-head"><span class="msg-avatar">${x.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('')}</span><div><strong>${x.name}</strong><div class="audit-note">${x.role === 'bdc' ? 'BDC' : 'Sales'}</div></div></div>
      <div class="in-person-goal"><span>Units</span><strong>${inNum(x.units)}${x.goal.units ? html` <span class="audit-note">of ${x.goal.units}</span>` : ''}</strong></div>
      ${meter(x.units, x.goal.units)}
      <div class="in-person-goal"><span>Gross</span><strong>${inMoney(x.gross)}${x.goal.gross ? html` <span class="audit-note">of ${inMoney(x.goal.gross)}</span>` : ''}</strong></div>
      ${meter(x.gross, x.goal.gross, true)}
      <div class="in-person-grid">
        <span>Pace</span><strong>${inNum(x.pace.units)} units</strong>
        <span>Per vehicle</span><strong>${inMoney(x.pvr)}</strong>
        <span>Products / deal</span><strong>${inNum(x.productsPerDeal)}</strong>
        <span>Leads · close</span><strong>${x.leads} · ${inPct(x.closeRate)}</strong>
        <span>Appts set · shown</span><strong>${x.apptsSet} · ${x.apptsShown}${x.showRate !== null ? ` (${inPct(x.showRate)})` : ''}</strong>
        <span>Calls · texts · emails</span><strong>${x.calls} · ${x.texts} · ${x.emails}</strong>
        <span>Visits logged</span><strong>${x.visits}</strong>
      </div></div>`) : html`<p class="audit-note">No salespeople or BDC agents yet.</p>`}</div>`;
}

function inGoalsForm() {
  const p = ins.people;
  const box = document.getElementById('inModal');
  box.querySelector('.modal-content').innerHTML = String(html`<h2>Goals for ${p.month}</h2>
    <form id="inGoalsForm"><table class="data-table ac-table"><thead><tr><th>Person</th><th>Units</th><th>Gross</th></tr></thead><tbody>
      ${p.people.map(x => html`<tr><td>${x.name}</td><td><input type="number" min="0" step="0.5" name="u-${x.id}" value="${x.goal.units ?? ''}" class="ac-input-num" /></td><td><input type="number" min="0" step="100" name="g-${x.id}" value="${x.goal.gross ?? ''}" class="ac-input-num" /></td></tr>`)}</tbody></table>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-in-close>Cancel</button><button type="submit" class="btn-primary">Save goals</button></div></form>`);
  box.classList.add('active');
}

// ---------- Parts inventory ----------

async function inParts() {
  const p = await inGet('/insight/parts');
  inHead('Parts Inventory', 'What the shelf is worth, how fast it turns, and what isn\'t moving.', { range: false });
  ins.last = { name: 'parts-not-moving', rows: [['Part #', 'Description', 'Bin', 'On hand', 'Value', 'Days since sale'], ...p.oldest.map(x => [x.number, x.description, x.bin, x.onHand, x.value, x.daysSinceSale ?? 'never'])] };
  const maxIdle = Math.max(0, ...p.idle.map(i => i.value));
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">Stock value</span><span class="ac-card-value">${inMoney(p.value)}</span><span class="ac-card-sub">${p.onHandSkus} of ${p.skus} parts on hand</span></div>
      <div class="ac-card"><span class="ac-card-label">Turns</span><span class="ac-card-value">${inNum(p.turns)}×</span><span class="ac-card-sub">A year of cost sold ÷ stock value</span></div>
      <div class="ac-card"><span class="ac-card-label">Cost sold, 12 months</span><span class="ac-card-value">${inMoney(p.costSold365)}</span></div>
    </div>
    <div class="ac-box"><div class="ca-section-title">Not moving</div>
      ${p.idle.map(i => html`<div class="in-pen"><span>${i.label}</span>${inBar(i.value, maxIdle, inMoney(i.value))}<strong>${i.skus} parts · ${inMoney(i.value)}</strong></div>`)}</div>
    <div class="ac-grid2">
      <div class="ac-box"><div class="ca-section-title">Most value sitting (no sale in 180+ days)</div>
        ${p.oldest.length ? html`<table class="data-table ac-table"><thead><tr><th>Part</th><th class="num">On hand</th><th class="num">Value</th><th class="num">Last sale</th></tr></thead><tbody>
          ${p.oldest.map(x => html`<tr><td><strong>${x.number}</strong><div class="audit-note">${x.description}${x.bin ? ` · ${x.bin}` : ''}</div></td><td class="num">${inNum(x.onHand)}</td><td class="num">${inMoney(x.value)}</td><td class="num">${x.daysSinceSale === null ? 'never' : `${x.daysSinceSale}d`}</td></tr>`)}</tbody></table>` : html`<p class="audit-note">Everything on the shelf has sold in the last 180 days.</p>`}</div>
      <div class="ac-box"><div class="ca-section-title">Top sellers, last 90 days</div>
        ${p.topSellers.length ? html`<table class="data-table ac-table"><thead><tr><th>Part</th><th class="num">Sold</th><th class="num">On hand</th><th class="num">Months supply</th></tr></thead><tbody>
          ${p.topSellers.map(x => html`<tr><td><strong>${x.number}</strong><div class="audit-note">${x.description}</div></td><td class="num">${inNum(x.sold90)}</td><td class="num">${inNum(x.onHand)}</td><td class="num ${x.monthsSupply !== null && x.monthsSupply < 0.5 ? 'ac-late' : ''}">${inNum(x.monthsSupply)}</td></tr>`)}</tbody></table>` : html`<p class="audit-note">Nothing sold in the last 90 days.</p>`}</div>
    </div>
    ${p.overstock.length ? html`<div class="ac-box"><div class="ca-section-title">Overstocked (over 6 months of supply)</div><table class="data-table ac-table"><thead><tr><th>Part</th><th class="num">On hand</th><th class="num">Sold 90 days</th><th class="num">Months supply</th><th class="num">Value</th></tr></thead><tbody>
      ${p.overstock.map(x => html`<tr><td><strong>${x.number}</strong> ${x.description}</td><td class="num">${inNum(x.onHand)}</td><td class="num">${inNum(x.sold90)}</td><td class="num">${inNum(x.monthsSupply)}</td><td class="num">${inMoney(x.value)}</td></tr>`)}</tbody></table></div>` : ''}`;
}

// ---------- Events ----------

const inRoot = document.getElementById('insightPanel');
inRoot.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'inFrom' || t.id === 'inTo') { ins.from = document.getElementById('inFrom').value; ins.to = document.getElementById('inTo').value; return openInsightView(ins.view); }
  if (t.id === 'inInvType') { ins.invType = t.value; return openInsightView(ins.view); }
  if (t.id === 'inFiType') { ins.fiType = t.value; return openInsightView(ins.view); }
  if (t.id === 'inTradeType') { ins.tradeType = t.value; return openInsightView(ins.view); }
  if (t.id === 'inMonth') { ins.month = t.value; return openInsightView(ins.view); }
  if (t.id === 'inDayPick') { ins.day = t.value; return openInsightView(ins.view); }
  if (t.id === 'inPreset' && t.value) {
    const today = inDay(0), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    if (t.value === 'mtd') { ins.from = `${today.slice(0, 7)}-01`; ins.to = today; }
    if (t.value === 'ytd') { ins.from = `${y}-01-01`; ins.to = today; }
    if (t.value === '30' || t.value === '90') { ins.from = inDay(-(Number(t.value) - 1)); ins.to = today; }
    if (t.value === 'last') {
      const ly = m === 1 ? y - 1 : y, lm = m === 1 ? 12 : m - 1;
      ins.from = `${ly}-${String(lm).padStart(2, '0')}-01`;
      ins.to = `${ly}-${String(lm).padStart(2, '0')}-${String(new Date(ly, lm, 0).getDate()).padStart(2, '0')}`;
    }
    return openInsightView(ins.view);
  }
});
inRoot.addEventListener('input', (e) => {
  if (e.target.id !== 'inFiFilter') return;
  ins.fiFilter = e.target.value;
  const at = e.target.selectionStart;
  inFiRender();
  const box = document.getElementById('inFiFilter');
  box.focus(); box.setSelectionRange(at, at);
});
inRoot.addEventListener('click', (e) => {
  if (e.target.closest('[data-in-refresh]')) return openInsightView(ins.view);
  if (e.target.closest('[data-in-goals]')) return inGoalsForm();
  const fiTab = e.target.closest('[data-in-fi-tab]');
  if (fiTab) { ins.fiTab = fiTab.dataset.inFiTab; return inFiRender(); }
  const fiOpen = e.target.closest('[data-in-fi-open]');
  if (fiOpen) { const id = fiOpen.dataset.inFiOpen; ins.fiOpen.has(id) ? ins.fiOpen.delete(id) : ins.fiOpen.add(id); return inFiRender(); }
  if (e.target.closest('[data-in-fi-all]')) { ins.fiOpen = ins.fiOpen && ins.fiOpen.size ? new Set() : new Set(ins.fi.team.map(m => m.id)); return inFiRender(); }
  if (e.target.closest('[data-in-fi-target]')) return inFiTarget();
  const tab = e.target.closest('[data-in-leader]');
  if (tab) { ins.leaderTab = tab.dataset.inLeader; return openInsightView('insightleaders'); }
  if (e.target.closest('[data-in-csv]') && ins.last) {
    const esc = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ins.last.rows.map(r => r.map(esc).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = `${ins.last.name}.csv`;
    a.click();
  }
});



// Goals dialog.
document.getElementById('inModal').addEventListener('click', (e) => {
  if (e.target.id === 'inModal' || e.target.closest('[data-in-close]')) document.getElementById('inModal').classList.remove('active');
});
document.getElementById('inModal').addEventListener('submit', async (e) => {
  if (e.target.id !== 'inGoalsForm') return;
  e.preventDefault();
  const f = e.target;
  const goals = Object.fromEntries(ins.people.people.map(x => [x.id, { units: f.elements[`u-${x.id}`].value, gross: f.elements[`g-${x.id}`].value }]));
  const res = await fetch(`${API}/insight/goals`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: ins.people.month, goals }) });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Could not save.'); return; }
  document.getElementById('inModal').classList.remove('active');
  openInsightView('insightpeople');
});
