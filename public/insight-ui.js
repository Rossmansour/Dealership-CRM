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
    await ({ insightsales: inSales, insightleaders: inLeaders, insightfi: inFi, insightinventory: inInventory, insightmarketing: inMarketing, insighttrend: inTrend })[view]();
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

async function inFi() {
  const f = await inGet(`/insight/fi?${inRangeQs()}`);
  inHead('F&I & Lenders', 'Product penetration = share of deals with that product.');
  ins.last = { name: `lenders-${f.from}-${f.to}`, rows: [['Lender', 'Deals', 'Amount financed', 'Avg financed', 'Avg APR', 'Avg term', 'Reserve', 'Reserve / deal'], ...f.lenders.map(l => [l.lender, l.deals, l.financed, l.avgFinanced, l.avgApr, l.avgTerm, l.reserve, l.reservePerDeal])] };
  const maxFinanced = Math.max(0, ...f.lenders.map(l => l.financed));
  inBody().innerHTML = html`<div class="ac-cards ac-cards-small">
      <div class="ac-card"><span class="ac-card-label">Deals</span><span class="ac-card-value">${f.deals}</span><span class="ac-card-sub">${f.deals - f.cash} financed · ${f.cash} cash</span></div>
      <div class="ac-card"><span class="ac-card-label">Back gross</span><span class="ac-card-value">${inMoney(f.back)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Back per deal</span><span class="ac-card-value">${inMoney(f.backPerDeal)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Products per deal</span><span class="ac-card-value">${inNum(f.productsPerDeal)}</span></div>
      <div class="ac-card"><span class="ac-card-label">Reserve</span><span class="ac-card-value">${inMoney(f.reserve)}</span></div>
    </div>
    <div class="ac-box"><div class="ca-section-title">Product penetration</div>
      ${f.products.map(p => html`<div class="in-pen"><span>${p.label}</span>${inBar(f.penetration[p.key], 100, `${inPct(f.penetration[p.key])} of deals`)}<strong>${inPct(f.penetration[p.key])}</strong></div>`)}</div>
    <div class="ca-section-title">By F&amp;I manager</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>F&amp;I manager</th><th class="num">Deals</th><th class="num">Back gross</th><th class="num">Back / deal</th><th class="num">Products / deal</th>
      ${f.products.map(p => html`<th class="num">${p.label}</th>`)}<th class="num">Reserve</th></tr></thead><tbody>
      ${f.managers.length ? f.managers.map(m => html`<tr><td><strong>${m.name}</strong></td><td class="num">${m.deals}</td><td class="num">${inMoney(m.back)}</td><td class="num">${inMoney(m.backPerDeal)}</td><td class="num">${inNum(m.productsPerDeal)}</td>
        ${f.products.map(p => html`<td class="num">${inPct(m.penetration[p.key])}</td>`)}<td class="num">${inMoney(m.reserve)}</td></tr>`) : html`<tr><td colspan="11" class="audit-note">No deals in this range.</td></tr>`}</tbody></table></div>
    <div class="ca-section-title">Lenders</div>
    <div class="table-scroll"><table class="data-table ac-table"><thead><tr><th>Lender</th><th class="num">Deals</th><th>Amount financed</th><th class="num">Avg financed</th><th class="num">Avg APR</th><th class="num">Avg term</th><th class="num">Reserve</th><th class="num">Reserve / deal</th></tr></thead><tbody>
      ${f.lenders.length ? f.lenders.map(l => html`<tr><td><strong>${l.lender}</strong></td><td class="num">${l.deals}</td><td class="in-bar-cell"><span class="in-bar-num">${inMoney(l.financed)}</span>${inBar(l.financed, maxFinanced, inMoney(l.financed))}</td>
        <td class="num">${inMoney(l.avgFinanced)}</td><td class="num">${inPct(l.avgApr)}</td><td class="num">${l.avgTerm} mo</td><td class="num">${inMoney(l.reserve)}</td><td class="num">${inMoney(l.reservePerDeal)}</td></tr>`)
        : html`<tr><td colspan="8" class="audit-note">No financed deals in this range.</td></tr>`}</tbody></table></div>`;
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

// ---------- Events ----------

const inRoot = document.getElementById('insightPanel');
inRoot.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'inFrom' || t.id === 'inTo') { ins.from = document.getElementById('inFrom').value; ins.to = document.getElementById('inTo').value; return openInsightView(ins.view); }
  if (t.id === 'inInvType') { ins.invType = t.value; return openInsightView(ins.view); }
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
inRoot.addEventListener('click', (e) => {
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

if (VIEW_PANELS[currentView] === 'insightPanel') openInsightView(currentView);
