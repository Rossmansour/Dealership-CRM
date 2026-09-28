// pricing-ui.js
// Market Pricing (Vehicle Management): every car against the same cars for
// sale nearby -- its market price, % of market, rank, and the suggested price
// from the store's rules. Apply suggestions, lock a car's price, refresh the
// market, and set the rules (including auto-pricing). Loaded after app.js.

let pricing = null;             // { settings, connected, cars }
const prSelected = new Set();
const prOpen = new Set();       // cars with their comparables showing

async function prApi(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

async function openPricingView() {
  document.getElementById('prBody').innerHTML = html`<tr><td colspan="11" class="rc-muted">Loading…</td></tr>`;
  try { pricing = await prApi('/pricing'); renderPricing(); } catch (err) { document.getElementById('prBody').innerHTML = html`<tr><td colspan="11">${err.message}</td></tr>`; }
}

const prDiffers = c => c.suggested !== null && c.suggested !== c.price;
function prFiltered() {
  const type = document.getElementById('prType').value;
  const show = document.getElementById('prShow').value;
  const q = document.getElementById('prSearch').value.trim().toLowerCase();
  return pricing.cars.filter(c => (!type || c.stockType === type) &&
    (!q || `${c.stockNumber} ${c.year} ${c.make} ${c.model} ${c.trim}`.toLowerCase().includes(q)) &&
    (!show || (show === 'over' && c.pctOfMarket > 103) || (show === 'under' && c.pctOfMarket !== null && c.pctOfMarket < 97) ||
      (show === 'change' && prDiffers(c)) || (show === 'nodata' && !(c.market && c.market.median)) || (show === 'locked' && c.locked)));
}
const prPctClass = p => (p === null ? '' : p > 103 ? 'pr-over' : p < 97 ? 'pr-under' : 'pr-at');

function renderPricing() {
  const s = pricing.settings;
  const cars = prFiltered().sort((a, b) => (b.inScope - a.inScope) || (b.days - a.days));
  const priced = pricing.cars.filter(c => c.inScope && c.market && c.market.median);
  const demo = pricing.cars.some(c => c.market && c.market.source === 'demo');
  const last = s.lastRun;
  document.getElementById('prBanner').innerHTML = html`<div class="pr-banner ${pricing.connected ? '' : 'pr-banner-warn'}">
    ${pricing.connected
      ? html`<strong>Market data connected.</strong> ${s.zip ? `Cars within ${s.radius} miles of ${s.zip}.` : html`<span class="ro-late">Set your store ZIP in Pricing rules.</span>`}`
      : html`<strong>Market data not connected yet.</strong> Add a MarketCheck API key (MARKETCHECK_API_KEY) to price your real cars. ${demo || pricing.cars.some(c => c.canPrice) ? 'Demo cars use made-up demo listings so you can try it.' : ''}`}
    <span class="pr-auto ${s.auto ? 'pr-auto-on' : ''}">Auto-pricing ${s.auto ? 'ON' : 'off'}${s.auto && last ? html` · last run ${new Date(last.at).toLocaleString()} (${last.changed} changed)` : ''}
      ${s.auto ? html` <button type="button" class="link-btn" id="prRunBtn">Run now</button>` : ''}</span>
  </div>`;
  const pcts = priced.filter(c => c.pctOfMarket !== null).map(c => c.pctOfMarket);
  document.getElementById('prSummary').innerHTML = html`
    <span><strong>${priced.length}</strong> of ${pricing.cars.filter(c => c.inScope).length} cars with market data</span>
    <span><strong>${pcts.length ? `${(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)}%` : '--'}</strong> average % of market</span>
    <span class="${priced.some(c => c.pctOfMarket > 103) ? 'ro-late' : ''}"><strong>${priced.filter(c => c.pctOfMarket > 103).length}</strong> over market</span>
    <span><strong>${priced.filter(c => c.pctOfMarket !== null && c.pctOfMarket < 97).length}</strong> under market</span>
    <span><strong>${pricing.cars.filter(c => c.inScope && prDiffers(c) && !c.locked).length}</strong> with a new suggested price</span>`;
  for (const id of [...prSelected]) if (!pricing.cars.some(c => c.id === id && prDiffers(c))) prSelected.delete(id);
  const applyBtn = document.getElementById('prApplyBtn');
  applyBtn.textContent = `Apply suggested (${prSelected.size})`;
  applyBtn.disabled = !prSelected.size;
  const selectable = cars.filter(prDiffers);
  document.getElementById('prAll').checked = selectable.length > 0 && selectable.every(c => prSelected.has(c.id));
  document.getElementById('prBody').innerHTML = cars.length ? html`${cars.map(c => {
    const m = c.market;
    const gross = c.suggested !== null ? c.suggested - c.allIn : null;
    const change = c.suggested !== null ? c.suggested - c.price : 0;
    return html`<tr class="pr-row ${c.inScope ? '' : 'pr-out'}" data-pr="${c.id}">
      <td>${prDiffers(c) ? html`<input type="checkbox" data-pr-sel="${c.id}" ${prSelected.has(c.id) ? html`checked` : ''} aria-label="Select" />` : ''}</td>
      <td><strong>${c.year} ${c.make} ${c.model}</strong> ${c.trim}<div class="rc-muted">${c.stockNumber ? `#${c.stockNumber} · ` : ''}${c.stockType === 'new' ? 'New' : 'Used'} · ${c.mileage.toLocaleString()} mi</div></td>
      <td>${c.days}</td>
      <td>${money0(c.allIn)}${c.reconPending ? html`<div class="rc-muted">incl. ${money0(c.reconPending)} recon</div>` : ''}</td>
      <td><strong>${c.price ? money0(c.price) : '--'}</strong>${c.lastChange ? html`<div class="rc-muted" title="${c.lastChange.reason || ''}">was ${money0(c.lastChange.previous)}</div>` : ''}</td>
      <td>${m && m.median ? html`${money0(m.median)}<div class="rc-muted">${m.count} cars${m.source === 'demo' ? ' · demo' : ''}</div>` : html`<span class="rc-muted">${!c.inScope ? 'Not priced' : c.canPrice ? 'Not pulled yet' : 'Needs market data'}</span>`}</td>
      <td class="${prPctClass(c.pctOfMarket)}">${c.pctOfMarket === null ? '--' : `${c.pctOfMarket}%`}</td>
      <td>${c.rank ? `${c.rank} of ${m.count + 1}` : '--'}</td>
      <td>${c.suggested === null ? html`<span class="rc-muted">${c.inScope ? c.reason : ''}</span>` : html`<strong>${money0(c.suggested)}</strong>
        ${change ? html`<div class="${change < 0 ? 'pr-down' : 'pr-up'}">${change < 0 ? '▼' : '▲'} ${money0(Math.abs(change))}</div>` : html`<div class="rc-muted">no change</div>`}
        ${c.atFloor ? html`<div class="pr-floor" title="${c.reason}">at gross floor</div>` : ''}`}</td>
      <td class="${gross !== null && gross < 0 ? 'ro-late' : ''}">${gross === null ? '--' : money0(gross)}</td>
      <td><button type="button" class="pr-lock ${c.locked ? 'pr-locked' : ''}" data-pr-lock="${c.id}" title="${c.locked ? 'Locked: auto-pricing leaves this price alone. Click to unlock.' : 'Auto-pricing can change this price. Click to lock it.'}">${c.locked ? '🔒 Locked' : 'Auto'}</button></td>
    </tr>
    ${prOpen.has(c.id) ? html`<tr class="pr-detail"><td></td><td colspan="10">${prDetail(c)}</td></tr>` : ''}`;
  })}` : html`<tr><td colspan="11" class="rc-muted">No cars here.</td></tr>`;
}

function prDetail(c) {
  const m = c.market;
  return html`<div class="pr-detail-box">
    <div class="pr-why">${c.suggested !== null ? html`<strong>Why ${money0(c.suggested)}:</strong> ${c.reason}. Floor: cost ${money0(c.allIn)} + ${money0(pricing.settings.minGross)} gross = ${money0(c.floor)}.` : c.reason}
      ${m ? html` <span class="rc-muted">Market pulled ${new Date(m.at).toLocaleString()} · range ${money0(m.low)}–${money0(m.high)}${m.avgDaysListed !== null ? ` · listed ${m.avgDaysListed} days on average` : ''}</span>` : ''}
      ${c.canPrice && c.inScope ? html` <button type="button" class="link-btn" data-pr-refresh="${c.id}">Refresh this car</button>` : ''}</div>
    ${m && m.comps.length ? html`<table class="pr-comps"><thead><tr><th>Similar car</th><th>Miles</th><th>Price</th><th>Adjusted for miles</th><th>Days listed</th><th>Dealer</th></tr></thead><tbody>
      ${(() => {
        const rows = m.comps.map(x => ({ ...x, mine: false }));
        if (c.price) rows.push({ title: 'This car', miles: c.mileage, price: c.price, adjusted: c.price, daysListed: c.days, dealer: 'You', mine: true });
        return rows.sort((a, b) => a.adjusted - b.adjusted).map(x => html`<tr class="${x.mine ? 'pr-mine' : ''}"><td>${x.url ? html`<a href="${x.url}" target="_blank" rel="noopener">${x.title}</a>` : x.title}</td>
          <td>${Number(x.miles).toLocaleString()}</td><td>${money0(x.price)}</td><td>${money0(x.adjusted)}</td><td>${x.daysListed ?? '--'}</td><td>${x.dealer}${x.distance ? ` · ${x.distance} mi` : ''}</td></tr>`);
      })()}</tbody></table>` : ''}
  </div>`;
}

document.getElementById('prBody').addEventListener('click', async (e) => {
  const sel = e.target.closest('[data-pr-sel]');
  if (sel) { if (sel.checked) prSelected.add(sel.dataset.prSel); else prSelected.delete(sel.dataset.prSel); return renderPricing(); }
  const lock = e.target.closest('[data-pr-lock]');
  if (lock) {
    const c = pricing.cars.find(x => x.id === lock.dataset.prLock);
    try { await prApi(`/pricing/cars/${c.id}/lock`, 'POST', { locked: !c.locked }); c.locked = !c.locked; renderPricing(); } catch (err) { alert(err.message); }
    return;
  }
  const one = e.target.closest('[data-pr-refresh]');
  if (one) {
    one.textContent = 'Refreshing…';
    try { const r = await prApi('/pricing/refresh', 'POST', { carIds: [one.dataset.prRefresh] }); if (r.errors.length) alert(r.errors.join('\n')); await openPricingView(); } catch (err) { alert(err.message); }
    return;
  }
  if (e.target.closest('a, button, input')) return;
  const row = e.target.closest('[data-pr]');
  if (row) { const id = row.dataset.pr; if (prOpen.has(id)) prOpen.delete(id); else prOpen.add(id); renderPricing(); }
});
document.getElementById('prAll').addEventListener('change', (e) => {
  prFiltered().filter(prDiffers).forEach(c => (e.target.checked ? prSelected.add(c.id) : prSelected.delete(c.id)));
  renderPricing();
});
['prType', 'prShow'].forEach(id => document.getElementById(id).addEventListener('change', () => pricing && renderPricing()));
document.getElementById('prSearch').addEventListener('input', () => pricing && renderPricing());

document.getElementById('prApplyBtn').addEventListener('click', async () => {
  const cars = pricing.cars.filter(c => prSelected.has(c.id));
  if (!confirm(`Change the price on ${cars.length} car${cars.length === 1 ? '' : 's'} to the suggested price?`)) return;
  try { await prApi('/pricing/apply', 'POST', { carIds: cars.map(c => c.id) }); prSelected.clear(); await openPricingView(); } catch (err) { alert(err.message); }
});
document.getElementById('prRefreshBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Pulling the market…';
  try {
    const r = await prApi('/pricing/refresh', 'POST', {});
    if (r.errors.length) alert(`Some cars couldn't be priced:\n${r.errors.join('\n')}`);
    await openPricingView();
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = '↻ Refresh market';
});
document.getElementById('prBanner').addEventListener('click', async (e) => {
  if (!e.target.closest('#prRunBtn')) return;
  if (!confirm('Run auto-pricing now? Every car that isn\'t locked moves toward its suggested price.')) return;
  try { const r = await prApi('/pricing/run', 'POST'); alert(`${r.changed} price${r.changed === 1 ? '' : 's'} changed.`); await openPricingView(); } catch (err) { alert(err.message); }
});

// ---------- Rules ----------
let prAgingDraft = [];
function renderAgingRows() {
  document.getElementById('prAgingRows').innerHTML = prAgingDraft.map((a, i) => html`<div class="pr-aging-row">
    After <input type="number" min="1" data-ag="${i}" data-k="days" value="${a.days}" /> days →
    <input type="number" min="50" max="150" step="0.5" data-ag="${i}" data-k="pct" value="${a.pct}" /> % of market
    <button type="button" class="link-btn" data-ag-del="${i}">Remove</button></div>`).join('');
}
document.getElementById('prRulesBtn').addEventListener('click', () => {
  const s = pricing.settings;
  const set = (id, v) => { document.getElementById(id).value = v; };
  document.getElementById('prAuto').checked = s.auto;
  document.getElementById('prNew').checked = s.includeNew;
  set('prZip', s.zip); set('prRadius', s.radius); set('prYears', s.yearRange); set('prPct', s.targetPct); set('prMinGross', s.minGross);
  set('prMaxChange', s.maxChange); set('prPerMile', s.perMile); set('prRound', String(s.roundTo)); set('prMinComps', s.minComps);
  prAgingDraft = s.aging.map(a => ({ ...a }));
  renderAgingRows();
  document.getElementById('prRulesMsg').textContent = '';
  document.getElementById('prRulesModal').classList.add('active');
});
document.getElementById('prAgingRows').addEventListener('input', (e) => {
  const i = e.target.dataset.ag;
  if (i !== undefined) prAgingDraft[i][e.target.dataset.k] = Number(e.target.value);
});
document.getElementById('prAgingRows').addEventListener('click', (e) => {
  const d = e.target.closest('[data-ag-del]');
  if (d) { prAgingDraft.splice(Number(d.dataset.agDel), 1); renderAgingRows(); }
});
document.getElementById('prAddAging').addEventListener('click', () => {
  const lastStep = prAgingDraft[prAgingDraft.length - 1] || { days: 15, pct: 100 };
  prAgingDraft.push({ days: lastStep.days + 15, pct: Math.max(50, lastStep.pct - 2) });
  renderAgingRows();
});
document.getElementById('prRulesCancel').addEventListener('click', () => document.getElementById('prRulesModal').classList.remove('active'));
document.getElementById('prRulesSave').addEventListener('click', async () => {
  const v = id => document.getElementById(id).value;
  const body = {
    auto: document.getElementById('prAuto').checked, includeNew: document.getElementById('prNew').checked,
    zip: v('prZip'), radius: v('prRadius'), yearRange: v('prYears'), targetPct: v('prPct'), minGross: v('prMinGross'),
    maxChange: v('prMaxChange'), perMile: v('prPerMile'), roundTo: v('prRound'), minComps: v('prMinComps'), aging: prAgingDraft
  };
  if (body.auto && !body.zip && pricing.connected) { document.getElementById('prRulesMsg').textContent = 'Enter your store ZIP so we know where "nearby" is.'; return; }
  try {
    await prApi('/pricing/settings', 'PUT', body);
    document.getElementById('prRulesModal').classList.remove('active');
    await openPricingView();
  } catch (err) { document.getElementById('prRulesMsg').textContent = err.message; }
});
