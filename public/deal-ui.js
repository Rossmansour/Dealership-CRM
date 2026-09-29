// deal-ui.js
// The deal screen (the Desking tab). Four blocks -- the deal (with its
// vehicle and buyer), the sales price, the down payment, and the payment --
// recalculate as you type. Lines marked ▤ open their details: customer and
// co-buyer, vehicle, up to three trades, a prior lease payoff, rebates,
// dealer fees, taxes & state fees, deferred down payments, F&I products
// (service contracts, maintenance, GAP, credit insurance, aftermarkets --
// each with price and cost), insurance, miscellaneous, titling, third
// parties, the people on the deal, and (managers) store gross. Every section's page keeps the
// section list on the left and the payment on the right.
// Loaded after app.js and uses its helpers and data (deals, leads, cars,
// appraisals, staffList).

const dx = { deal: null, w: null, section: 'main', dirty: false, preview: null, timer: null, seq: 0 };

const DX_SECTIONS = [
  ['main', 'Deal'], ['customer', 'Customer'], ['vehicle', 'Vehicle'], ['trades', 'Trade-in'], ['priorLease', 'Prior lease'],
  ['rebates', 'Rebates'], ['dealerFees', 'Dealer fees'], ['taxes', 'Taxes & fees'], ['deferred', 'Deferred payments'],
  ['warranty', 'Service & maintenance'], ['gapSec', 'GAP'], ['creditIns', 'Credit insurance'], ['aftermarkets', 'Aftermarkets'],
  ['insurance', 'Insurance'], ['misc', 'Miscellaneous'], ['titling', 'Titling'], ['thirdParties', 'Third parties'],
  ['employees', 'Employees'], ['gross', 'Store gross']
];
// Sections with F&I products (and their costs): F&I and managers change them.
const DX_PRODUCT_SECTIONS = ['warranty', 'gapSec', 'creditIns', 'aftermarkets'];
const DX_EMPLOYEES = [
  ['sales1', 'Salesperson 1'], ['sales2', 'Salesperson 2'], ['sales3', 'Salesperson 3'], ['sales4', 'Salesperson 4'],
  ['deskManager', 'Desk manager'], ['salesManager', 'Sales manager'], ['internetManager', 'Internet manager'], ['teamManager', 'Team manager'],
  ['fiManager', 'F&I manager'], ['closer1', 'Closer 1'], ['closer2', 'Closer 2']
];
const DX_GOV_KEYS = [['license', 'License fee'], ['registration', 'Registration fee'], ['title', 'Title fee']];
const dxN = v => Number(String(v ?? '').replace(/[$,\s]/g, '')) || 0;
const dxM = v => `${dxN(v) < 0 ? '−' : ''}$${Math.abs(dxN(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dxToday = () => new Date().toISOString().slice(0, 10);
const dxCanGross = () => userCan('editDealAccounting');

// ---------- A working copy of the deal, in its itemized form ----------
// Deals saved before the itemized lines existed get their totals turned
// into single lines (one trade, one rebate line...) the first time they open.
function dxWorking(d) {
  const lead = leads.find(l => l.id === d.leadId);
  const v = x => (x === null || x === undefined ? '' : x);
  const trades = Array.isArray(d.trades) ? d.trades : d.hasTrade ? [{
    vin: d.tradeVin || '', year: d.tradeYear || '', make: d.tradeMake || '', model: d.tradeModel || '', mileage: d.tradeMileage || '',
    allowance: d.tradeInValue || 0, payoff: d.tradeInPayoff || 0, acv: d.tradeAcv || ''
  }] : [];
  const govFees = Array.isArray(d.govFees) ? d.govFees : [
    { key: 'license', description: 'License fee', amount: d.licenseFee || 0 },
    { key: 'registration', description: 'Registration fee', amount: d.registrationFee || 0 },
    { key: 'title', description: 'Title fee', amount: d.titleFee || 0 }
  ];
  const hasSplit = d.stateTaxRate !== undefined && d.stateTaxRate !== null;
  // F&I products as lines. Older deals only have a premium per product (and
  // one F&I cost for all of them), so the cost goes on the first product.
  const hasLines = Array.isArray(d.warranties) || Array.isArray(d.aftermarkets) || d.gap !== undefined || d.creditInsurance !== undefined;
  let legacyCost = hasLines ? 0 : dxN(d.fiProductCost);
  const takeCost = () => { const c = legacyCost; legacyCost = 0; return c; };
  const warranties = hasLines ? (d.warranties || []) : [
    ...(dxN(d.servicePremium) ? [{ kind: 'service', premium: d.servicePremium, cost: takeCost() }] : []),
    ...(dxN(d.maintenancePremium) ? [{ kind: 'maintenance', premium: d.maintenancePremium, cost: takeCost() }] : [])];
  const gap = hasLines ? (d.gap || null) : dxN(d.gapPremium) ? { premium: d.gapPremium, cost: takeCost() } : null;
  const aftermarkets = hasLines ? (d.aftermarkets || []) : dxN(d.aftermarketAmount) ? [{ description: 'Aftermarket', price: d.aftermarketAmount, cost: takeCost() }] : [];
  return {
    leadId: d.leadId || '', coLeadId: d.coLeadId || '', carId: d.carId || '', dealType: d.dealType || 'retail',
    dealDate: d.dealDate || String(d.dateCreated || '').slice(0, 10) || dxToday(), lender: d.lender || '', program: d.program || 'Normal',
    state: d.state || (lead && lead.address && lead.address.state) || '', county: d.county || (lead && lead.address && lead.address.county) || '', city: d.city || '',
    vehiclePrice: v(d.vehiclePrice), msrp: v(d.msrp), docFee: v(d.docFee), servicePremium: v(d.servicePremium), maintenancePremium: v(d.maintenancePremium),
    gapPremium: v(d.gapPremium), aftermarketAmount: v(d.aftermarketAmount),
    cashDown: v(d.cashDown ?? (dxN(d.downPayment) - dxN(d.deferredDown) || '')), deposit: v(d.deposit),
    trades: trades.map(t => ({ ...t })),
    rebates: Array.isArray(d.rebates) ? d.rebates.map(r => ({ ...r })) : d.rebate ? [{ description: 'Rebate', amount: d.rebate }] : [],
    dealerFeeLines: Array.isArray(d.dealerFeeLines) ? d.dealerFeeLines.map(f => ({ ...f })) : d.dealerFees ? [{ description: 'Dealer fees', amount: d.dealerFees, taxable: false, paidTo: '' }] : [],
    govFees: govFees.map(f => ({ ...f })),
    stateTaxRate: hasSplit ? d.stateTaxRate : v(d.taxRate), countyTaxRate: hasSplit ? d.countyTaxRate : 0, cityTaxRate: hasSplit ? d.cityTaxRate : 0,
    priorLease: { ...(d.priorLease || {}) },
    deferred: Array.isArray(d.deferred) ? d.deferred.map(x => ({ ...x })) : [],
    termMonths: v(d.termMonths), apr: v(d.apr), firstPaymentDate: d.firstPaymentDate || '',
    acquisitionFee: v(d.acquisitionFee), cashBack: v(d.cashBack), residualPercent: v(d.residualPercent), annualMiles: d.annualMiles || 12000,
    moneyFactor: v(d.moneyFactor), securityDeposit: v(d.securityDeposit), advancedPayments: v(d.advancedPayments),
    employees: { ...(d.employees || { sales1: lead ? lead.sales1Id || '' : '', sales2: lead ? lead.sales2Id || '' : '' }) },
    fiProductCost: v(d.fiProductCost), reserve: v(d.reserve), incentives: v(d.incentives), chargebackAmount: v(d.chargebackAmount),
    chargebackDate: d.chargebackDate ? String(d.chargebackDate).slice(0, 10) : '',
    _productLines: hasLines,
    warranties: warranties.map(x => ({ ...x })), gap: gap ? { ...gap } : null, aftermarkets: aftermarkets.map(x => ({ ...x })),
    creditInsurance: d.creditInsurance ? { company: d.creditInsurance.company || '', life: { ...(d.creditInsurance.life || {}) }, ah: { ...(d.creditInsurance.ah || {}) }, iui: { ...(d.creditInsurance.iui || {}) } } : null,
    insurance: { ...(d.insurance || {}) }, misc: { ...(d.misc || {}) }, titling: { ...(d.titling || {}) },
    thirdParties: Array.isArray(d.thirdParties) ? d.thirdParties.map(x => ({ ...x })) : []
  };
}

function dxPayload() {
  const w = dx.w;
  const p = { ...w, leadId: w.leadId || null, coLeadId: w.coLeadId || null, carId: w.carId || null };
  for (const k of ['fiProductCost', 'reserve', 'incentives', 'chargebackAmount', 'chargebackDate', '_productLines']) delete p[k];
  // Product lines go only once they've been used (older deals keep their F&I cost until then).
  if (!w._productLines) for (const k of ['warranties', 'gap', 'creditInsurance', 'aftermarkets']) delete p[k];
  if (dxCanGross()) {
    Object.assign(p, { ...(w._productLines ? {} : { fiProductCost: w.fiProductCost }), reserve: w.reserve, incentives: w.incentives, chargebackAmount: w.chargebackAmount,
      chargebackDate: w.chargebackDate ? `${w.chargebackDate}T12:00:00` : null });
  }
  return p;
}

// ---------- Open / save ----------
window.openDealScreen = function(deal) {
  dx.deal = deal;
  dx.w = dxWorking(deal);
  dx.section = 'main';
  dx.dirty = false;
  dx.preview = deal;
  renderDx();
  dxRecalc(0);
};
window.dxHasUnsaved = () => dx.dirty;
window.dxSetState = function(state) {
  if (!dx.w || !state || dx.w.state === state) return;
  dx.w.state = state;
  dx.dirty = true;
  if (dx.section === 'taxes') renderDx();
};

async function dxSave() {
  const btn = document.getElementById('saveDealBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/deals/${dx.deal.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dxPayload()) });
    const saved = await res.json();
    if (!res.ok) throw new Error(saved.error || 'Could not save the deal.');
    await loadAll();
    dx.deal = deals.find(d => d.id === saved.id) || saved;
    dx.w = dxWorking(dx.deal);
    dx.preview = dx.deal;
    dx.dirty = false;
    renderDx();
  } catch (err) { alert(err.message); }
  btn.disabled = false;
}
document.getElementById('saveDealBtn').addEventListener('click', dxSave);
document.getElementById('dealTypeSelect').addEventListener('change', (e) => {
  if (!dx.w) return;
  dx.w.dealType = e.target.value;
  dx.dirty = true;
  renderDx();
  dxRecalc(0);
});

// What the deal works out to with what's on screen (nothing saved).
function dxRecalc(delay = 300) {
  clearTimeout(dx.timer);
  dx.timer = setTimeout(async () => {
    const seq = ++dx.seq;
    try {
      const res = await fetch(`${API}/deals/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dxPayload()) });
      if (!res.ok || seq !== dx.seq) return;
      dx.preview = await res.json();
      dxUpdateOutputs();
    } catch { /* offline: keep the last numbers */ }
  }, delay);
}

// ---------- Numbers shown on screen ----------
function dxFigures() {
  const p = dx.preview || {};
  const w = dx.w;
  const type = w.dealType;
  const lease = type === 'lease';
  const products = dxN(p.servicePremium) + dxN(p.maintenancePremium) + dxN(p.gapPremium) + dxN(p.aftermarketAmount) + dxN(p.creditInsPremium);
  const gov = dxN(p.licenseFee) + dxN(p.registrationFee) + dxN(p.titleFee) + dxN(p.otherGovFees);
  const fees = dxN(p.docFee) + gov + dxN(p.dealerFees) + (lease ? dxN(p.acquisitionFee) : 0);
  const netTrade = dxN(p.tradeInValue) - dxN(p.tradeInPayoff);
  const tax = lease ? dxN(p.monthlyTax) * dxN(p.termMonths) : dxN(p.salesTax);
  const totalPrice = dxN(p.vehiclePrice) + products + fees + tax + dxN(p.priorLeaseBalance);
  const totalDown = dxN(p.downPayment) + dxN(p.rebate) + netTrade;
  return {
    products, gov, fees, netTrade, tax, totalPrice, totalDown,
    taxRate: dxN(p.taxRate), dealerFees: dxN(p.dealerFees), priorLease: dxN(p.priorLeaseBalance), rebate: dxN(p.rebate),
    allowance: dxN(p.tradeInValue), payoff: dxN(p.tradeInPayoff), acv: dxN(p.tradeAcv), deferred: dxN(p.deferredDown), license: dxN(p.licenseFee),
    tradeDiff: dxN(p.vehiclePrice) - dxN(p.tradeInValue),
    financed: lease ? dxN(p.netCapCost) : dxN(p.amountFinanced),
    financeCharge: Math.max(0, dxN(p.totalOfPayments) - dxN(p.amountFinanced)),
    totalOfPayments: dxN(p.totalOfPayments), payment: dxN(p.monthlyPayment), totalDealCost: dxN(p.totalDealCost),
    grossCap: dxN(p.grossCapCost), residual: dxN(p.residualAmount), dueAtSigning: dxN(p.dueAtSigning), capReduction: dxN(p.totalCapReduction),
    days: p.daysToFirstPayment,
    service: dxN(p.servicePremium), maintenance: dxN(p.maintenancePremium), gap: dxN(p.gapPremium), aftermarket: dxN(p.aftermarketAmount),
    creditIns: dxN(p.creditInsPremium), productCost: dxN(p.fiProductCost)
  };
}
function dxUpdateOutputs() {
  const f = dxFigures();
  document.querySelectorAll('#dx [data-out]').forEach(el => {
    const k = el.dataset.out;
    el.textContent = k === 'taxRate' ? `${f.taxRate}%` : k === 'days' ? (f.days === null || f.days === undefined ? '' : `${f.days} days`) : dxM(f[k]);
  });
}

function dxMarkDirty() {
  dx.dirty = true;
  document.getElementById('dx').classList.add('dx-dirty');
}

// ---------- Rendering ----------
const dxIn = (field, { type = 'text', step, cls = '', attrs = '' } = {}) => html`<input type="${type}" ${step ? html`step="${step}"` : ''} data-f="${field}" value="${dx.w[field] ?? ''}" class="${cls}" ${new SafeHtml(attrs)} />`;
// name: the row's plain name (for the ▤ button's label) when label has markup in it.
const dxRow = (label, inner, go, name = label) => html`<div class="dx-row"><span class="dx-l">${label}${go ? html` <button type="button" class="dx-go" data-go="${go}" title="Open ${name} details" aria-label="Open ${name} details">▤</button>` : ''}</span><span class="dx-v">${inner}</span></div>`;
const dxOut = key => html`<strong data-out="${key}"></strong>`;
const dxStaffOptions = sel => html`<option value="">--</option>${staffList.map(u => html`<option value="${u.id}" ${u.id === sel ? html`selected` : ''}>${u.name}</option>`)}`;

function renderDx() {
  const el = document.getElementById('dx');
  if (!dx.w) return;
  el.classList.toggle('dx-dirty', dx.dirty);
  const sections = DX_SECTIONS.filter(([k]) => k !== 'gross' || dxCanGross());
  el.innerHTML = dx.section === 'main' ? dxMain() : html`<div class="dx-sec">
      <nav class="dx-nav" aria-label="Deal sections">${sections.map(([k, l]) => html`<button type="button" class="dx-nav-item ${dx.section === k ? 'active' : ''}" data-go="${k}">${l}</button>`)}</nav>
      <div class="dx-page">${dxSection(dx.section)}</div>
      <aside class="dx-mini">${dxPaymentBox()}</aside>
    </div>`;
  dxMountPickers();
  dxUpdateOutputs();
}

function dxPaymentBox() {
  const lease = dx.w.dealType === 'lease';
  const cash = dx.w.dealType === 'cash';
  return html`<div class="dx-paybox">
    ${cash ? html`<span>Total due</span><div class="dx-pay" data-out="financed"></div>`
      : html`<span>Payment</span><div class="dx-pay" data-out="payment"></div><span>${dx.w.termMonths || 0} months${lease ? '' : ` at ${dx.w.apr || 0}%`}</span>`}
    <div class="dx-row"><span class="dx-l">${lease ? 'Net cap cost' : cash ? 'Total price' : 'Amount financed'}</span>${dxOut(cash ? 'totalPrice' : 'financed')}</div>
    <div class="dx-row"><span class="dx-l">Total down</span>${dxOut('totalDown')}</div>
    <p class="dx-unsaved">Not saved yet</p>
    <button type="button" class="btn-primary dx-save" data-act="save">Save deal</button>
  </div>`;
}

function dxMain() {
  const w = dx.w;
  const lease = w.dealType === 'lease';
  const cash = w.dealType === 'cash';
  const car = cars.find(c => c.id === w.carId);
  const days = car && car.dateAdded ? Math.floor((Date.now() - new Date(car.dateAdded)) / 86400000) : null;
  return html`<div class="dx-main">
    <section class="dx-block">
      <h3>Deal</h3>
      ${dxRow('Deal #', html`<strong>D-${dx.deal.dealNumber}</strong>`)}
      ${dxRow('Deal date', dxIn('dealDate', { type: 'date' }))}
      ${dxRow('Lender', dxIn('lender', { attrs: 'placeholder="Cash, or bank / credit union" maxlength="80"' }))}
      ${dxRow('Program', html`<select data-f="program">${['Normal', 'Special rate', 'Subvented', 'First-time buyer', 'Commercial'].map(o => html`<option ${w.program === o ? html`selected` : ''}>${o}</option>`)}</select>`)}
      <h4>Vehicle <button type="button" class="dx-go" data-go="vehicle" aria-label="Vehicle details">▤</button></h4>
      <div class="dx-picker" data-picker="car"></div>
      ${car ? html`<p class="dx-sub">${car.stockType === 'new' ? 'New' : 'Used'} · ${Number(car.mileage || 0).toLocaleString()} mi${days !== null ? ` · ${days} days in stock` : ''}${dxCanGross() ? ` · cost ${money(car.cost)}` : ''}</p>` : ''}
      <h4>Buyer <button type="button" class="dx-go" data-go="customer" aria-label="Customer details">▤</button></h4>
      <div class="dx-picker" data-picker="lead"></div>
      ${w.coLeadId ? html`<p class="dx-sub">Co-buyer: ${(leads.find(l => l.id === w.coLeadId) || {}).name || ''}</p>` : ''}
      ${dxRow('Reg. state', html`<input type="text" data-f="state" value="${w.state}" maxlength="2" class="dx-short" />`, 'taxes')}
    </section>

    <section class="dx-block">
      <h3>Sales price</h3>
      ${lease ? dxRow('MSRP', dxIn('msrp', { type: 'number', cls: 'dx-money' })) : ''}
      ${dxRow('Selling price', dxIn('vehiclePrice', { type: 'number', cls: 'dx-money dx-big' }))}
      ${dxRow('Aftermarkets', dxOut('aftermarket'), 'aftermarkets')}
      ${dxRow('Doc fee', dxIn('docFee', { type: 'number', cls: 'dx-money' }))}
      ${dxRow('Service contract', dxOut('service'), 'warranty')}
      ${dxRow('Maintenance', dxOut('maintenance'), 'warranty')}
      ${dxRow('GAP', dxOut('gap'), 'gapSec')}
      ${dxRow('Credit insurance', dxOut('creditIns'), 'creditIns')}
      ${dxRow('Prior lease balance', dxOut('priorLease'), 'priorLease')}
      ${dxRow('License fee', dxOut('license'), 'taxes')}
      ${dxRow('Dealer fees', dxOut('dealerFees'), 'dealerFees')}
      ${dxRow('Total fees', dxOut('fees'), 'taxes')}
      ${dxRow(html`Total taxes <small data-out="taxRate"></small>`, dxOut('tax'), 'taxes', 'Total taxes')}
      <div class="dx-total">${dxRow('Total price', dxOut('totalPrice'))}</div>
      ${dxRow('Trade difference', dxOut('tradeDiff'))}
    </section>

    <section class="dx-block">
      <h3>Down payment</h3>
      ${dxRow('Cash down', dxIn('cashDown', { type: 'number', cls: 'dx-money' }))}
      ${dxRow('Deposit', dxIn('deposit', { type: 'number', cls: 'dx-money' }))}
      ${dxRow('Rebates', dxOut('rebate'), 'rebates')}
      ${dxRow('Trade allowance', dxOut('allowance'), 'trades')}
      ${dxRow('Trade payoff', dxOut('payoff'), 'trades')}
      ${dxRow('Net trade', dxOut('netTrade'))}
      ${dxRow('Trade ACV', dxOut('acv'), 'trades')}
      ${dxRow('Deferred down', dxOut('deferred'), 'deferred')}
      <div class="dx-total">${dxRow('Total down', dxOut('totalDown'))}</div>
    </section>

    <section class="dx-block">
      <h3>Payment</h3>
      ${cash ? html`<p class="dx-sub">Cash deal: no financing.</p>` : html`
        ${dxRow('Term (months)', dxIn('termMonths', { type: 'number', cls: 'dx-short' }))}
        ${lease ? html`
          ${dxRow('Money factor', dxIn('moneyFactor', { type: 'number', step: '0.00001', cls: 'dx-money' }))}
          ${dxRow('Residual %', dxIn('residualPercent', { type: 'number', step: '0.01', cls: 'dx-short' }))}
          ${dxRow('Miles per year', html`<select data-f="annualMiles">${[7500, 10000, 12000, 15000, 18000].map(m => html`<option value="${m}" ${Number(w.annualMiles) === m ? html`selected` : ''}>${m.toLocaleString()}</option>`)}</select>`)}
          ${dxRow('Acquisition fee', dxIn('acquisitionFee', { type: 'number', cls: 'dx-money' }))}
          ${dxRow('Cash back', dxIn('cashBack', { type: 'number', cls: 'dx-money' }))}
          ${dxRow('Security deposit', dxIn('securityDeposit', { type: 'number', cls: 'dx-money' }))}
          ${dxRow('Advance payments', dxIn('advancedPayments', { type: 'number', cls: 'dx-short' }))}`
        : dxRow('APR %', dxIn('apr', { type: 'number', step: '0.01', cls: 'dx-short' }))}
        ${dxRow('1st payment', html`${dxIn('firstPaymentDate', { type: 'date' })} <small data-out="days"></small>`)}
        ${lease ? html`${dxRow('Gross cap cost', dxOut('grossCap'))}${dxRow('Cap reduction', dxOut('capReduction'))}${dxRow('Net cap cost', dxOut('financed'))}
          ${dxRow('Residual', dxOut('residual'))}${dxRow('Due at signing', dxOut('dueAtSigning'))}`
        : html`${dxRow('Amount financed', dxOut('financed'))}${dxRow('Finance charge', dxOut('financeCharge'))}`}
        ${dxRow('Total of payments', dxOut('totalOfPayments'))}`}
      <div class="dx-paybig">
        <span>${cash ? 'Total due' : 'Payment'}</span>
        <strong data-out="${cash ? 'financed' : 'payment'}"></strong>
      </div>
      <p class="dx-unsaved">Not saved yet</p>
      <div class="dx-actions">
        <button type="button" class="btn-primary" data-act="save">Save deal</button>
        <button type="button" class="btn-secondary" data-act="proposal">Proposal</button>
        <button type="button" class="btn-secondary" data-act="duplicate">Copy as new deal</button>
      </div>
    </section>
  </div>`;
}

// ---------- Section pages ----------
function dxSection(k) {
  const w = dx.w;
  if (k === 'customer') {
    const who = (id, label) => {
      const l = leads.find(x => x.id === id);
      const a = l && l.address && typeof l.address === 'object' ? l.address : {};
      return html`<div class="dx-card"><h3>${label}</h3><div class="dx-picker" data-picker="${label === 'Buyer' ? 'lead' : 'colead'}"></div>
        ${l ? html`<div class="dx-facts">
          ${dxFact('Customer #', l.customerNumber ? `C-${l.customerNumber}` : '')}${dxFact('Phone', l.phone)}${dxFact('Email', l.email)}
          ${dxFact('Address', [a.street, a.unit, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' '))}${dxFact('County', a.county)}
        </div><button type="button" class="btn-secondary btn-small" onclick="openLeadProfile(${js(l.id)})">Open customer page</button>`
        : html`<p class="dx-sub">${label === 'Buyer' ? 'Pick the buyer.' : 'Add a co-buyer if there is one.'}</p>`}</div>`;
    };
    return html`<h2>Customer</h2><div class="dx-two">${who(w.leadId, 'Buyer')}${who(w.coLeadId, 'Co-buyer')}</div>
      <p class="dx-sub">Names, addresses, and phones are kept on each customer's page; SSN and license go on the Credit Application tab.</p>`;
  }
  if (k === 'vehicle') {
    const c = cars.find(x => x.id === w.carId);
    const days = c && c.dateAdded ? Math.floor((Date.now() - new Date(c.dateAdded)) / 86400000) : null;
    return html`<h2>Vehicle</h2><div class="dx-card"><div class="dx-picker" data-picker="car"></div>
      ${c ? html`<div class="dx-facts">
        ${dxFact('Stock #', c.stockNumber)}${dxFact('VIN', c.vin)}${dxFact('New / used', c.stockType === 'new' ? 'New' : 'Used')}
        ${dxFact('Year', c.year)}${dxFact('Make', c.make)}${dxFact('Model', c.model)}${dxFact('Trim', c.trim)}${dxFact('Color', c.exteriorColor)}
        ${dxFact('Odometer', c.mileage ? Number(c.mileage).toLocaleString() : '')}${dxFact('Asking price', money(c.price))}
        ${dxFact('Days in stock', days === null ? '' : days)}${dxCanGross() ? dxFact('Cost', money(c.cost)) : ''}
        ${dxFact('Open repair orders', (c.openROs || []).length ? (c.openROs || []).length : 'None')}
      </div>` : html`<p class="dx-sub">Pick the vehicle from inventory.</p>`}</div>`;
  }
  if (k === 'trades') {
    const linked = appraisals.filter(a => a.dealId === dx.deal.id);
    return html`<h2>Trade-in</h2>
      ${w.trades.map((t, i) => {
        const ap = linked.find(a => a.id === t.appraisalId) || (i === 0 && !t.appraisalId ? linked.slice(-1)[0] : null);
        const L = (label, key, type = 'text', extra = '') => html`<label>${label}<input type="${type}" data-list="trades" data-i="${i}" data-k="${key}" value="${t[key] ?? ''}" ${new SafeHtml(extra)} /></label>`;
        return html`<div class="dx-card"><h3>Trade ${i + 1} <button type="button" class="link-btn" data-del="trades|${i}">Remove</button></h3>
          <div class="dx-vin">${L('VIN', 'vin', 'text', 'maxlength="17" autocomplete="off" spellcheck="false"')}<button type="button" class="btn-secondary btn-small" data-decode="${i}">Decode VIN</button></div>
          <div class="dx-grid">${L('Year', 'year')}${L('Make', 'make')}${L('Model', 'model')}${L('Trim', 'trim')}${L('Odometer', 'mileage', 'number')}${L('Color', 'color')}</div>
          <div class="dx-grid dx-grid-money">${L('Allowance', 'allowance', 'number')}${L('Payoff', 'payoff', 'number')}${L('ACV', 'acv', 'number')}</div>
          <p class="dx-sub" data-tradenote="${i}">${new SafeHtml(dxTradeNoteHtml(t))}</p>
          <h4>Lienholder</h4>
          <div class="dx-grid">${L('Lienholder', 'lienholder')}${L('Phone', 'lienPhone')}${L('Account #', 'lienAccount')}${L('Payoff good thru', 'goodThru', 'date')}</div>
          <div class="dx-appraisal">${ap ? html`Appraisal <button type="button" class="link-btn" onclick="openAppraisal(${js(ap.id)})">A-${ap.appraisalNumber}</button> · ${APPRAISAL_STATUS_LABELS[ap.status]} · offer ${money(ap.offer)}
              ${ap.offer ? html`<button type="button" class="btn-secondary btn-small" data-useoffer="${i}|${ap.id}">Use offer as allowance &amp; ACV</button>` : ''}`
            : html`<button type="button" class="btn-secondary btn-small" data-appraise="${i}">Appraise this trade</button>`}</div>
        </div>`;
      })}
      ${w.trades.length < 3 ? html`<button type="button" class="btn-secondary" data-add="trades">+ Add ${w.trades.length ? 'another trade' : 'a trade'}</button>` : ''}`;
  }
  if (k === 'priorLease') {
    const p = w.priorLease;
    const L = (label, key, type = 'number') => html`<label>${label}<input type="${type}" data-obj="priorLease" data-k="${key}" value="${p[key] ?? ''}" /></label>`;
    return html`<h2>Prior lease balance</h2><p class="dx-sub">A lease the customer is getting out of, paid off and rolled into this deal.</p>
      <div class="dx-two"><div class="dx-card"><h3>Balance</h3><div class="dx-grid">
        ${L('Remaining payments', 'remaining')}${L('Early termination fee', 'earlyTermination')}${L('Excess mileage charge', 'excessMileage')}
        ${L('Excess wear charge', 'excessWear')}${L('Other charges', 'other')}</div>
        <p class="dx-sub">Prior lease balance: <strong data-out="priorLease"></strong></p></div>
      <div class="dx-card"><h3>Vehicle &amp; lease company</h3><div class="dx-grid">
        ${L('VIN', 'vin', 'text')}${L('Year', 'year', 'text')}${L('Make', 'make', 'text')}${L('Model', 'model', 'text')}${L('Odometer', 'mileage')}
        ${L('Lease company', 'company', 'text')}${L('Phone', 'phone', 'text')}${L('Account #', 'account', 'text')}${L('Good thru', 'goodThru', 'date')}</div></div></div>`;
  }
  if (k === 'rebates') {
    return html`<h2>Rebates</h2>${dxLines('rebates', [['description', 'Description', 'text'], ['amount', 'Amount', 'number'], ['program', 'Program', 'text'], ['code', 'Code', 'text']], 10)}
      <p class="dx-sub">Total rebates: <strong data-out="rebate"></strong></p>`;
  }
  if (k === 'dealerFees') {
    return html`<h2>Dealer fees</h2>${dxLines('dealerFeeLines', [['description', 'Description', 'text'], ['amount', 'Amount', 'number'], ['taxable', 'Taxable', 'checkbox'], ['paidTo', 'Paid to', 'text']], 10)}
      <p class="dx-sub">Dealer fees: <strong data-out="dealerFees"></strong>. Taxable ones are added to the taxed amount.</p>`;
  }
  if (k === 'taxes') {
    const rate = key => html`<label>${key === 'stateTaxRate' ? 'State' : key === 'countyTaxRate' ? 'County' : 'City'} rate %<input type="number" step="0.001" data-f="${key}" value="${w[key] ?? ''}" /></label>`;
    return html`<h2>Taxes &amp; fees</h2>
      <div class="dx-card"><div class="dx-grid">
        <label>Registered state<input type="text" maxlength="2" data-f="state" value="${w.state}" /></label>
        <label>County<input type="text" data-f="county" value="${w.county}" /></label>
        <label>City<input type="text" data-f="city" value="${w.city}" /></label>
      </div>
      <button type="button" class="btn-secondary" data-act="autofees">🧮 Look up tax &amp; state fees</button> <span class="dx-sub" id="dxFeeStatus"></span></div>
      <div class="dx-two">
        <div class="dx-card"><h3>Sales tax</h3><div class="dx-grid">${rate('stateTaxRate')}${rate('countyTaxRate')}${rate('cityTaxRate')}</div>
          <p class="dx-sub">Total rate <strong data-out="taxRate"></strong> · taxes <strong data-out="tax"></strong></p></div>
        <div class="dx-card"><h3>State fees</h3>
          ${dxLines('govFees', [['description', 'Fee', 'text'], ['amount', 'Amount', 'number']], 20, i => !!w.govFees[i].key)}
          <p class="dx-sub">Doc fee is on the deal screen; dealer fees have their own section. Total fees <strong data-out="fees"></strong></p></div>
      </div>`;
  }
  if (k === 'deferred') {
    return html`<h2>Deferred payments</h2><p class="dx-sub">Down payment the customer pays after delivery, on these dates. It counts toward the total down.</p>
      ${dxLines('deferred', [['amount', 'Amount', 'number'], ['date', 'Due date', 'date']], 3)}
      <p class="dx-sub">Deferred down: <strong data-out="deferred"></strong></p>`;
  }
  if (DX_PRODUCT_SECTIONS.includes(k)) {
    // Salespeople see the products; F&I and managers change them (and see cost).
    return html`<fieldset class="dx-fs" ${dxCanGross() ? '' : html`disabled`}>${dxProducts(k)}</fieldset>
      ${dxCanGross() ? '' : html`<p class="dx-sub">F&amp;I and managers set up products.</p>`}`;
  }
  if (k === 'insurance') {
    return html`<h2>Insurance</h2><p class="dx-sub">The customer's auto insurance on this vehicle.</p><div class="dx-card"><div class="dx-grid">
      ${dxObjField('insurance', 'company', 'Company')}${dxObjField('insurance', 'agent', 'Agent')}${dxObjField('insurance', 'phone', 'Phone')}${dxObjField('insurance', 'email', 'Email', 'email')}
      ${dxObjField('insurance', 'policyNumber', 'Policy #')}${dxObjField('insurance', 'effective', 'Effective', 'date')}${dxObjField('insurance', 'expires', 'Expires', 'date')}
      ${dxObjField('insurance', 'compDeductible', 'Comprehensive deductible', 'number')}${dxObjField('insurance', 'collDeductible', 'Collision deductible', 'number')}
      ${dxObjField('insurance', 'insuredParty', 'Insured party')}</div>${dxObjField('insurance', 'notes', 'Notes')}</div>`;
  }
  if (k === 'misc') {
    return html`<h2>Miscellaneous</h2><div class="dx-two">
      <div class="dx-card"><h3>Registration &amp; temp plate</h3><div class="dx-grid">
        ${dxObjField('misc', 'regClass', 'Registration class')}${dxObjField('misc', 'regEffDate', 'Registration effective', 'date')}${dxObjField('misc', 'regExpDate', 'Registration expires', 'date')}
        ${dxObjField('misc', 'tempPermit', 'Temp permit #')}${dxObjField('misc', 'tempPlate', 'Temp plate')}${dxObjField('misc', 'tempExpDate', 'Temp expires', 'date')}</div></div>
      <div class="dx-card"><h3>Inspection &amp; other</h3><div class="dx-grid">
        ${dxObjField('misc', 'inspectionCert', 'Inspection cert #')}${dxObjField('misc', 'inspectionDate', 'Inspection date', 'date')}${dxObjField('misc', 'inspectionStation', 'Inspection station')}
        ${dxObjField('misc', 'invoiceNumber', 'Invoice #')}${dxObjField('misc', 'advertisingCode', 'Advertising code')}
        <label>With recourse<select data-obj="misc" data-k="withRecourse">${['', 'No', 'Yes', 'Limited'].map(o => html`<option ${(dx.w.misc.withRecourse || '') === o ? html`selected` : ''}>${o}</option>`)}</select></label></div></div>
    </div>
    <div class="dx-card"><h3>Used vehicle defects to disclose on F&amp;I contracts</h3>
      ${dxObjField('misc', 'defect1', 'Defect 1')}${dxObjField('misc', 'defect2', 'Defect 2')}${dxObjField('misc', 'defect3', 'Defect 3')}</div>`;
  }
  if (k === 'titling') {
    return html`<h2>Titling</h2><div class="dx-two">
      <div class="dx-card"><h3>Title</h3>${dxObjField('titling', 'titleName', 'Titled to (name as it goes on the title)')}
        <div class="dx-grid">${dxObjField('titling', 'taxId', 'Tax ID #')}${dxObjField('titling', 'lienNumber', 'Lien #')}</div>
        <p class="dx-sub">Lender on the deal: ${dx.w.lender || 'cash'}</p></div>
      <div class="dx-card"><h3>Lienholder</h3>${dxObjField('titling', 'lienholderName', 'Name')}${dxObjField('titling', 'lienholderStreet', 'Street')}
        <div class="dx-grid">${dxObjField('titling', 'lienholderCity', 'City')}${dxObjField('titling', 'lienholderState', 'State')}${dxObjField('titling', 'lienholderZip', 'ZIP')}</div></div>
    </div>${dxObjField('titling', 'notes', 'Notes')}`;
  }
  if (k === 'thirdParties') {
    return html`<h2>Third parties</h2><p class="dx-sub">Anyone else on the deal: a cosigner's attorney, a business contact, a power of attorney...</p>
      ${dxLines('thirdParties', [['role', 'Role', 'text'], ['name', 'Name', 'text'], ['address', 'Address', 'text'], ['phone', 'Phone', 'text'], ['email', 'Email', 'email']], 20)}`;
  }
  if (k === 'employees') {
    return html`<h2>Employees</h2><div class="dx-card"><div class="dx-grid dx-grid-3">
      ${DX_EMPLOYEES.map(([role, label]) => html`<label>${label}<select data-obj="employees" data-k="${role}">${dxStaffOptions(w.employees[role] || '')}</select></label>`)}
      </div></div>`;
  }
  if (k === 'gross' && dxCanGross()) {
    const L = (label, key, type = 'number') => html`<label>${label}<input type="${type}" data-f="${key}" value="${w[key] ?? ''}" /></label>`;
    return html`<h2>Store gross</h2><p class="dx-sub">Managers and F&amp;I. Feeds the dashboard and the deal recap.</p>
      <div class="dx-card"><div class="dx-grid">${w._productLines
        ? html`<label>F&amp;I product cost<strong class="dx-readonly" data-out="productCost"></strong><small class="dx-sub">from the product lines</small></label>`
        : L('F&I product cost', 'fiProductCost')}${L('Lender reserve', 'reserve')}${L('Incentives (dealer cash)', 'incentives')}
        ${L('Chargeback amount', 'chargebackAmount')}${L('Chargeback date', 'chargebackDate', 'date')}</div></div>`;
  }
  return '';
}
const dxObjField = (obj, key, label, type = 'text') => html`<label class="dx-field">${label}<input type="${type}" data-obj="${obj}" data-k="${key}" value="${dx.w[obj][key] ?? ''}" /></label>`;

// ---------- F&I products ----------
function dxAftermarketTotals() {
  const price = dx.w.aftermarkets.reduce((t, a) => t + dxN(a.price), 0);
  const cost = dx.w.aftermarkets.reduce((t, a) => t + dxN(a.cost), 0);
  return html`Aftermarkets <strong>${dxM(price)}</strong>${dxCanGross() ? html` · cost ${dxM(cost)} · profit <strong>${dxM(price - cost)}</strong>` : ''}`.toString();
}
// Profit and totals on the product pages, as you type.
function dxProductNotes() {
  document.querySelectorAll('#dx [data-profit]').forEach(el => {
    const [list, i] = el.dataset.profit.split('|');
    const x = list === 'gap' ? dx.w.gap : dx.w[list][Number(i)];
    if (!x) return;
    const v = dxN(x.premium) - dxN(x.cost);
    el.textContent = dxM(v);
    el.classList.toggle('rc-late', v < 0);
  });
  const t = document.querySelector('#dx [data-amtotals]');
  if (t) t.innerHTML = dxAftermarketTotals();
}
function dxProducts(k) {
  const w = dx.w;
  const gross = dxCanGross();
  const profit = (price, cost, ref) => html`<span class="dx-profit ${dxN(price) - dxN(cost) < 0 ? 'rc-late' : ''}" data-profit="${ref}">${dxM(dxN(price) - dxN(cost))}</span>`;
  const F = (path, key, label, type = 'text', value) => html`<label>${label}<input type="${type}" ${new SafeHtml(path)} data-k="${key}" value="${value ?? ''}" /></label>`;
  if (k === 'warranty') {
    const cards = w.warranties.map((x, i) => {
      const path = `data-list="warranties" data-i="${i}"`;
      const n = w.warranties.slice(0, i + 1).filter(y => y.kind === x.kind).length;
      return html`<div class="dx-card"><h3>${x.kind === 'maintenance' ? 'Maintenance plan' : 'Service contract'} ${n} <button type="button" class="link-btn" data-del="warranties|${i}">Remove</button></h3>
        <div class="dx-grid dx-grid-money">${F(path, 'premium', 'Premium (customer pays)', 'number', x.premium)}${gross ? html`${F(path, 'cost', 'Cost', 'number', x.cost)}<label>Profit${profit(x.premium, x.cost, `warranties|${i}`)}</label>` : ''}</div>
        <div class="dx-grid">${F(path, 'company', 'Company', 'text', x.company)}${F(path, 'planName', 'Plan', 'text', x.planName)}${F(path, 'planCode', 'Plan code', 'text', x.planCode)}
          <label>Plan type<select ${new SafeHtml(path)} data-k="planType">${['', 'New', 'Used', 'CPO'].map(o => html`<option ${(x.planType || '') === o ? html`selected` : ''}>${o}</option>`)}</select></label>
          ${F(path, 'months', 'Months', 'number', x.months)}${F(path, 'miles', 'Miles', 'number', x.miles)}${F(path, 'deductible', 'Deductible', 'number', x.deductible)}${F(path, 'policyNumber', 'Policy #', 'text', x.policyNumber)}</div></div>`;
    });
    const count = kind => w.warranties.filter(x => x.kind === kind).length;
    return html`<h2>Service contracts &amp; maintenance</h2>${cards}
      ${w.warranties.length ? '' : html`<p class="dx-sub">No service contract or maintenance plan on this deal.</p>`}
      <div class="dx-add-row">${count('service') < 2 ? html`<button type="button" class="btn-secondary" data-add="service">+ Service contract</button>` : ''}
        ${count('maintenance') < 2 ? html`<button type="button" class="btn-secondary" data-add="maintenance">+ Maintenance plan</button>` : ''}</div>
      <p class="dx-sub">Service contracts <strong data-out="service"></strong> · maintenance <strong data-out="maintenance"></strong></p>`;
  }
  if (k === 'gapSec') {
    const g = w.gap;
    return html`<h2>GAP</h2>${g ? html`<div class="dx-card"><h3>GAP <button type="button" class="link-btn" data-del="gap|0">No GAP</button></h3>
        <div class="dx-grid dx-grid-money">${F('data-obj="gap"', 'premium', 'Premium (customer pays)', 'number', g.premium)}${gross ? html`${F('data-obj="gap"', 'cost', 'Cost', 'number', g.cost)}<label>Profit${profit(g.premium, g.cost, 'gap')}</label>` : ''}</div>
        <div class="dx-grid">${F('data-obj="gap"', 'company', 'Company', 'text', g.company)}${F('data-obj="gap"', 'term', 'Term (months)', 'number', g.term)}${F('data-obj="gap"', 'policyNumber', 'Policy #', 'text', g.policyNumber)}</div></div>`
      : html`<p class="dx-sub">No GAP on this deal.</p><button type="button" class="btn-secondary" data-add="gap">+ Add GAP</button>`}`;
  }
  if (k === 'creditIns') {
    const c = w.creditInsurance;
    if (!c) return html`<h2>Credit insurance</h2><p class="dx-sub">No credit insurance on this deal.</p><button type="button" class="btn-secondary" data-add="creditInsurance">+ Add credit insurance</button>`;
    const cov = (key, label) => html`<tr><th>${label}</th>
      <td><input type="text" data-obj="creditInsurance.${key}" data-k="type" value="${c[key].type || ''}" aria-label="${label} type" /></td>
      <td><input type="number" data-obj="creditInsurance.${key}" data-k="premium" value="${c[key].premium ?? ''}" aria-label="${label} premium" /></td>
      ${gross ? html`<td><input type="number" data-obj="creditInsurance.${key}" data-k="cost" value="${c[key].cost ?? ''}" aria-label="${label} cost" /></td>` : ''}</tr>`;
    return html`<h2>Credit insurance</h2><div class="dx-card"><h3>Coverage <button type="button" class="link-btn" data-del="creditInsurance|0">No insurance</button></h3>
      <label class="dx-field">Company<input type="text" data-obj="creditInsurance" data-k="company" value="${c.company || ''}" /></label>
      <table class="dx-lines"><thead><tr><th></th><th>Type</th><th>Premium</th>${gross ? html`<th>Cost</th>` : ''}</tr></thead><tbody>
        ${cov('life', 'Life')}${cov('ah', 'A&H (disability)')}${cov('iui', 'IUI (unemployment)')}</tbody></table>
      <p class="dx-sub">Total premium <strong data-out="creditIns"></strong>, financed with the deal.</p></div>`;
  }
  if (k === 'aftermarkets') {
    const cols = [['code', 'Code', 'text'], ['description', 'Description', 'text'], ['price', 'Price', 'number'], ...(gross ? [['cost', 'Cost', 'number']] : []),
      ['taxable', 'Tax', 'checkbox'], ['weOwe', 'We owe', 'checkbox'], ['vendor', 'Vendor', 'text'], ['months', 'Months', 'number'], ['miles', 'Miles', 'number'],
      ['itemize', 'Itemize', 'checkbox'], ['preInstalled', 'Pre-installed', 'checkbox']];
    return html`<h2>Aftermarkets</h2><p class="dx-sub">Add-ons: tint, wheel &amp; tire, accessories. Taxed items are added to the taxed amount; "we owe" items print on the We-Owe sheet.</p>
      <div class="dx-wide">${dxLines('aftermarkets', cols, 20)}</div>
      <p class="dx-sub" data-amtotals>${new SafeHtml(dxAftermarketTotals())}</p>`;
  }
  return '';
}

const dxFact = (label, value) => html`<div><span>${label}</span><strong>${value === '' || value === null || value === undefined ? '—' : value}</strong></div>`;

// A small table of lines (rebates, fees...). fixed(i): a line that can't be removed.
function dxLines(list, cols, max, fixed = () => false) {
  const rows = dx.w[list];
  return html`<div class="dx-card"><table class="dx-lines"><thead><tr>${cols.map(([, label]) => html`<th>${label}</th>`)}<th></th></tr></thead><tbody>
    ${rows.map((r, i) => html`<tr>${cols.map(([key, , type]) => html`<td>${type === 'checkbox'
      ? html`<input type="checkbox" data-list="${list}" data-i="${i}" data-k="${key}" ${r[key] ? html`checked` : ''} aria-label="${key}" />`
      : html`<input type="${type}" data-list="${list}" data-i="${i}" data-k="${key}" value="${r[key] ?? ''}" ${fixed(i) && key === 'description' ? html`readonly` : ''} />`}</td>`)}
      <td>${fixed(i) ? '' : html`<button type="button" class="link-btn" data-del="${list}|${i}">Remove</button>`}</td></tr>`)}
    </tbody></table>
    ${rows.length < max ? html`<button type="button" class="btn-secondary btn-small" data-add="${list}">+ Add line</button>` : ''}</div>`;
}

// ---------- Pickers (customer, co-buyer, vehicle) ----------
function dxMountPickers() {
  document.querySelectorAll('#dx [data-picker]').forEach(slot => {
    const kind = slot.dataset.picker;
    const field = kind === 'car' ? 'carId' : kind === 'lead' ? 'leadId' : 'coLeadId';
    const picker = createSearchPicker({
      kind: kind === 'car' ? 'car' : 'lead',
      getIds: () => (kind === 'car' ? cars.filter(c => c.status !== 'sold' || c.id === dx.w.carId).map(c => c.id) : leads.map(l => l.id)),
      placeholder: kind === 'colead' ? 'Co-buyer: name, phone, email...' : undefined,
      onPick: (id) => {
        dx.w[field] = id;
        if (kind === 'car') { const c = cars.find(x => x.id === id); if (c) dx.w.vehiclePrice = c.price; }
        if (kind === 'lead' && id) {
          const l = leads.find(x => x.id === id);
          if (l && l.address && typeof l.address === 'object') { dx.w.state = dx.w.state || l.address.state || ''; dx.w.county = dx.w.county || l.address.county || ''; }
        }
        dx.dirty = true;
        renderDx();
        dxRecalc(0);
      }
    });
    const id = dx.w[field];
    const rec = id && (kind === 'car' ? cars : leads).find(r => r.id === id);
    picker.setLabel(rec ? (kind === 'car' ? carPickLabel(rec) : leadPickLabel(rec)) : '');
    slot.appendChild(picker.element);
  });
}

// ---------- Editing ----------
function dxSet(t) {
  const val = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.f) dx.w[t.dataset.f] = val;
  else if (t.dataset.list) dx.w[t.dataset.list][Number(t.dataset.i)][t.dataset.k] = val;
  else if (t.dataset.obj) t.dataset.obj.split('.').reduce((o, k) => o[k], dx.w)[t.dataset.k] = val;
  else return false;
  if (['warranties', 'aftermarkets'].includes(t.dataset.list) || /^(gap|creditInsurance)/.test(t.dataset.obj || '')) dx.w._productLines = true;
  return true;
}
const dxRoot = document.getElementById('dx');
dxRoot.addEventListener('input', (e) => {
  if (!dxSet(e.target)) return;
  dxMarkDirty();
  if (e.target.dataset.list === 'trades') dxTradeNote(Number(e.target.dataset.i));
  if (DX_PRODUCT_SECTIONS.includes(dx.section)) dxProductNotes();
  dxRecalc();
});
// The net trade / over-under line under a trade, as you type.
function dxTradeNote(i) {
  const el = document.querySelector(`#dx [data-tradenote="${i}"]`);
  if (el) el.innerHTML = dxTradeNoteHtml(dx.w.trades[i]);
}
function dxTradeNoteHtml(t) {
  const net = dxN(t.allowance) - dxN(t.payoff);
  const acv = dxN(t.acv);
  return html`Net trade: <strong>${dxM(net)}</strong>${acv ? ` · ${dxN(t.allowance) >= acv ? 'over' : 'under'}-allowance ${dxM(Math.abs(dxN(t.allowance) - acv))}` : ''}`.toString();
}
dxRoot.addEventListener('change', (e) => {
  if (!dxSet(e.target)) return;
  if (DX_PRODUCT_SECTIONS.includes(dx.section)) dxProductNotes();
  dxMarkDirty();
  dxRecalc(0);
});

dxRoot.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { dx.section = go.dataset.go; renderDx(); window.scrollTo(0, 0); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const list = add.dataset.add;
    if (list === 'gap') { dx.w.gap = { company: '', premium: '', cost: '', term: '', policyNumber: '' }; dx.w._productLines = true; dx.dirty = true; renderDx(); return dxRecalc(0); }
    if (list === 'creditInsurance') { dx.w.creditInsurance = { company: '', life: {}, ah: {}, iui: {} }; dx.w._productLines = true; dx.dirty = true; return renderDx(); }
    const blank = { trades: { allowance: '', payoff: '', acv: '' }, rebates: { description: '', amount: '' }, dealerFeeLines: { description: '', amount: '', taxable: false, paidTo: '' },
      govFees: { key: '', description: '', amount: '' }, deferred: { amount: '', date: '' }, service: { kind: 'service', premium: '', cost: '' },
      maintenance: { kind: 'maintenance', premium: '', cost: '' }, aftermarkets: { description: '', price: '', cost: '', taxable: false, weOwe: false },
      thirdParties: { role: '', name: '', address: '', phone: '', email: '' } }[list];
    if (list === 'service' || list === 'maintenance') { dx.w.warranties.push({ ...blank }); dx.w._productLines = true; }
    else { dx.w[list].push({ ...blank }); if (list === 'aftermarkets') dx.w._productLines = true; }
    dx.dirty = true;
    return renderDx();
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const [list, i] = del.dataset.del.split('|');
    if (list === 'gap' || list === 'creditInsurance') dx.w[list] = null;
    else dx.w[list].splice(Number(i), 1);
    if (['warranties', 'aftermarkets', 'gap', 'creditInsurance'].includes(list)) dx.w._productLines = true;
    dx.dirty = true;
    renderDx();
    return dxRecalc(0);
  }
  const dec = e.target.closest('[data-decode]');
  if (dec) return dxDecodeTrade(Number(dec.dataset.decode), dec);
  const use = e.target.closest('[data-useoffer]');
  if (use) {
    const [i, id] = use.dataset.useoffer.split('|');
    const a = appraisals.find(x => x.id === id);
    Object.assign(dx.w.trades[Number(i)], { allowance: a.offer, acv: a.offer, appraisalId: a.id });
    dx.dirty = true;
    renderDx();
    return dxRecalc(0);
  }
  const ap = e.target.closest('[data-appraise]');
  if (ap) {
    const t = dx.w.trades[Number(ap.dataset.appraise)];
    if (dx.dirty) await dxSave();
    return startAppraisal({ dealId: dx.deal.id, leadId: dx.w.leadId || null, vin: cleanVin(t.vin || ''), year: t.year, make: t.make, model: t.model, mileage: t.mileage });
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'save') return dxSave();
  if (a === 'proposal') { if (dx.dirty) await dxSave(); return viewProposal(dx.deal.id); }
  if (a === 'duplicate') return dxDuplicate();
  if (a === 'autofees') return dxLookupFees();
});

async function dxDecodeTrade(i, btn) {
  const t = dx.w.trades[i];
  const vin = cleanVin(t.vin || '');
  if (!VIN_PATTERN.test(vin)) return alert('A VIN is 17 letters and numbers (never I, O, or Q).');
  btn.disabled = true; btn.textContent = 'Looking up…';
  try {
    const res = await fetch(`${API}/vin/${vin}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not decode this VIN.');
    Object.assign(t, { vin, year: data.year || t.year, make: data.make || t.make, model: data.model || t.model, trim: data.trim || t.trim });
    dx.dirty = true;
    renderDx();
  } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = 'Decode VIN'; }
}

// State fees and tax from the buyer's address (or the credit app's).
async function dxLookupFees() {
  const status = document.getElementById('dxFeeStatus');
  const w = dx.w;
  const lead = leads.find(l => l.id === w.leadId);
  const a = lead && lead.address && typeof lead.address === 'object' ? lead.address : {};
  const field = id => (document.getElementById(id) || {}).value || '';
  const zip = a.zip || field('primaryZip');
  const car = cars.find(c => c.id === w.carId);
  if (!dxN(w.vehiclePrice)) { status.textContent = 'Enter the selling price first.'; return; }
  if (!zip) { status.textContent = "No ZIP on the buyer's address yet -- add it on their customer page or the Credit Application."; return; }
  status.textContent = 'Looking up…';
  try {
    const res = await fetch(`${API}/fees/calculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: w.state || a.state || field('primaryState'), zip, price: dxN(w.vehiclePrice), vehicleYear: car ? car.year : '', county: w.county || a.county || field('primaryCounty'), city: w.city || a.city || field('primaryCity') }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || 'Could not look up fees.');
    Object.assign(w, { stateTaxRate: r.stateTaxRate, countyTaxRate: r.countyTaxRate, cityTaxRate: r.cityTaxRate, county: r.county || w.county, state: w.state || String(r.stateUsed || '').slice(0, 2) });
    for (const [key, field2] of [['license', 'licenseFee'], ['registration', 'registrationFee'], ['title', 'titleFee']]) {
      const line = w.govFees.find(f => f.key === key);
      if (line) line.amount = r[field2]; else w.govFees.push({ key, description: DX_GOV_KEYS.find(x => x[0] === key)[1], amount: r[field2] });
    }
    dx.dirty = true;
    renderDx();
    dxRecalc(0);
    document.getElementById('dxFeeStatus').textContent = `✓ ${r.stateUsed}${r.county ? `, ${r.county} County` : ''}. Estimate -- check your state's current schedule.`;
  } catch (err) { status.textContent = err.message; }
}

// A copy of this deal with its own Deal #, to compare two structures.
async function dxDuplicate() {
  try {
    const res = await fetch(`${API}/deals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: dx.w.leadId || null, carId: dx.w.carId || null }) });
    const copy = await res.json();
    if (!res.ok) throw new Error(copy.error || 'Could not copy the deal.');
    await fetch(`${API}/deals/${copy.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dxPayload()) });
    await loadAll();
    openDealWorkspace(copy.id);
  } catch (err) { alert(err.message); }
}
