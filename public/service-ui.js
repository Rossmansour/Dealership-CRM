// service-ui.js
// Service screens: the repair order list, the RO page (customer, vehicle,
// jobs with labor and parts, technician clock-in/out, totals), service
// appointments, service setup (rates, tax, tech pay), and the Service tab
// on the customer page. Loaded after app.js and uses its helpers (html,
// js, money, userCan, staffList, leads, cars, search pickers).

const RO_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting on parts', ready: 'Ready', closed: 'Closed', void: 'Void' };
const RO_OPEN = ['open', 'in_progress', 'waiting_parts', 'ready'];
const PAY_LABELS = { customer: 'Customer pay', warranty: 'Warranty', internal: 'Internal' };
const JOB_STATUS_LABELS = { pending: 'Not started', working: 'Working', done: 'Done' };
const APPT_STATUS_LABELS = { scheduled: 'Scheduled', arrived: 'Arrived', no_show: 'No-show', cancelled: 'Cancelled' };

let serviceROs = [];
let serviceTechs = [];
let serviceCfg = null;
let roFilter = 'open';
let currentRO = null;     // the RO on screen, with unsaved edits
let roDirty = false;

const isTechUser = () => currentUser && currentUser.role === 'technician';
const canWriteRO = () => userCan('writeRepairOrders');
const svcMoney = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : `${Number(v) < 0 ? '-' : ''}$${Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const vehicleLabel = v => [v && v.year, v && v.make, v && v.model].filter(Boolean).join(' ') || 'Vehicle not entered';
const techName = id => (serviceTechs.find(t => t.id === id) || staffList.find(u => u.id === id) || {}).name || (id ? 'Former employee' : '');
const roStatusBadge = s => html`<span class="ro-status ro-st-${s}">${RO_STATUS_LABELS[s] || s}</span>`;
const advisors = () => staffList.filter(u => ['service_advisor', 'service_manager', 'admin', 'general_manager'].includes(u.role));
const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const shortWhen = iso => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '--');

async function svcJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}

async function loadServiceData() {
  const [ros, techs, cfg] = await Promise.all([
    fetch(`${API}/service/ros`).then(svcJson),
    fetch(`${API}/service/techs`).then(svcJson),
    serviceCfg ? Promise.resolve(serviceCfg) : fetch(`${API}/service/settings`).then(svcJson)
  ]);
  serviceROs = ros;
  serviceTechs = techs;
  serviceCfg = cfg;
}

// ---------- RO list ----------

function openServiceView() {
  document.getElementById('serviceSetupBtn').hidden = !userCan('editServiceSettings');
  document.getElementById('newRoBtn').hidden = !canWriteRO();
  if (isTechUser() && roFilter === 'open') roFilter = 'mine';
  showRoList();
  loadServiceData().then(renderRoList).catch(err => {
    document.getElementById('roTableBody').innerHTML = html`<tr><td colspan="9" class="send-text-status-error">${err.message}</td></tr>`;
  });
}

function showRoList() {
  if (roDirty && !confirm('Leave this repair order without saving your changes?')) return false;
  roDirty = false;
  currentRO = null;
  document.getElementById('roListView').hidden = false;
  document.getElementById('roDetailView').hidden = true;
  return true;
}

function roFilterMatches(ro, f) {
  if (f === 'open') return RO_OPEN.includes(ro.status);
  if (f === 'mine') {
    if (isTechUser()) return RO_OPEN.includes(ro.status) && (ro.jobs || []).some(j => j.techId === currentUser.id);
    return RO_OPEN.includes(ro.status) && ro.advisorId === currentUser.id;
  }
  if (f === 'closed') return ro.status === 'closed';
  if (f === 'all') return true;
  return ro.status === f;
}

function renderRoList() {
  const filters = [['open', 'All open'], ['mine', isTechUser() ? 'My jobs' : 'My ROs'], ['in_progress', 'In progress'],
    ['waiting_parts', 'Waiting on parts'], ['ready', 'Ready'], ['closed', 'Closed'], ['all', 'All']];
  document.getElementById('roFilters').innerHTML = filters.map(([k, label]) => html`
    <button type="button" class="ro-filter ${roFilter === k ? 'active' : ''}" data-ro-filter="${k}">${label}
      <span class="cp-count">${serviceROs.filter(r => roFilterMatches(r, k)).length}</span></button>`).join('');
  const words = document.getElementById('roSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = serviceROs.filter(r => roFilterMatches(r, roFilter)).filter(r => {
    if (!words.length) return true;
    const hay = [`ro-${r.roNumber}`, String(r.roNumber), r.customerName, r.vehicle && r.vehicle.vin, vehicleLabel(r.vehicle), r.vehicle && r.vehicle.plate].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  const open = serviceROs.filter(r => RO_OPEN.includes(r.status));
  const late = open.filter(r => r.promisedAt && new Date(r.promisedAt) < new Date() && r.status !== 'ready');
  document.getElementById('roSummary').innerHTML = html`
    <span><strong>${open.length}</strong> open</span>
    <span><strong>${open.filter(r => r.status === 'ready').length}</strong> ready for pickup</span>
    <span class="${late.length ? 'ro-late' : ''}"><strong>${late.length}</strong> past promise time</span>
    <span><strong>${open.reduce((s, r) => s + (r.jobs || []).filter(j => j.clockedIn).length, 0)}</strong> techs clocked in</span>`;
  document.getElementById('roEmpty').hidden = list.length > 0;
  document.getElementById('roTableBody').innerHTML = list.map(r => {
    const techs = [...new Set((r.jobs || []).map(j => j.techId).filter(Boolean))].map(techName);
    const total = r.totals ? r.totals.customerTotal + r.totals.warrantyTotal + r.totals.internalTotal : 0;
    const late = r.promisedAt && RO_OPEN.includes(r.status) && r.status !== 'ready' && new Date(r.promisedAt) < new Date();
    return html`<tr class="ro-row" data-ro-id="${r.id}">
      <td><button type="button" class="deal-number-link" data-ro-open="${r.id}">RO-${r.roNumber}</button></td>
      <td>${new Date(r.openedAt).toLocaleDateString()}</td>
      <td>${r.customerName || (r.carId ? html`<span class="ro-internal">Internal · recon</span>` : '--')}</td>
      <td>${vehicleLabel(r.vehicle)}${r.vehicle && r.vehicle.vin ? html`<div class="inventory-trim">VIN …${r.vehicle.vin.slice(-8)}</div>` : ''}</td>
      <td>${staffName(r.advisorId) || '--'}</td>
      <td>${techs.join(', ') || '--'}${(r.jobs || []).some(j => j.clockedIn) ? html` <span class="ro-clock-dot" title="Clocked in"></span>` : ''}</td>
      <td class="${late ? 'ro-late' : ''}">${r.promisedAt ? shortWhen(r.promisedAt) : '--'}</td>
      <td>${roStatusBadge(r.status)}</td>
      <td>${svcMoney(total)}</td></tr>`;
  }).join('');
}

document.getElementById('roFilters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ro-filter]');
  if (!b) return;
  roFilter = b.dataset.roFilter;
  renderRoList();
});
document.getElementById('roSearch').addEventListener('input', renderRoList);
document.getElementById('roTableBody').addEventListener('click', (e) => {
  const row = e.target.closest('[data-ro-id]');
  if (row) openRoById(row.dataset.roId);
});
document.getElementById('newRoBtn').addEventListener('click', () => startNewRO({}));

// ---------- RO page ----------

// Opens an RO from anywhere (dashboard, customer page).
window.openRoById = async function(id) {
  if (currentView !== 'service') {
    showView('service');
  }
  try {
    const ro = await fetch(`${API}/service/ros/${id}`).then(svcJson);
    if (!serviceCfg || !serviceTechs.length) await loadServiceData();
    showRoDetail(ro);
  } catch (err) { alert(err.message); }
};

function blankJob(payType = 'customer') {
  return { id: null, concern: '', cause: '', correction: '', opCode: '', payType, techId: null, hours: 0,
    rate: serviceCfg ? serviceCfg[`${payType}LaborRate`] : 0, status: 'pending', parts: [], punches: [] };
}

window.startNewRO = function({ leadId = null, carId = null, vehicle = null } = {}) {
  if (currentView !== 'service') showView('service');
  const begin = () => showRoDetail({
    id: null, roNumber: null, status: 'open', leadId, carId, customerName: leadId ? (leads.find(l => l.id === leadId) || {}).name : '',
    vehicle: vehicle || {}, advisorId: currentUser.id, promisedAt: null, notes: '',
    jobs: [blankJob(carId && !leadId ? 'internal' : 'customer')]
  });
  if (!serviceCfg) loadServiceData().then(begin).catch(err => alert(err.message)); else begin();
};

function showRoDetail(ro) {
  currentRO = JSON.parse(JSON.stringify(ro));
  roDirty = false;
  document.getElementById('roListView').hidden = true;
  document.getElementById('roDetailView').hidden = false;
  renderRoDetail();
  window.scrollTo(0, 0);
}

const roEditable = () => currentRO && RO_OPEN.includes(currentRO.status) && canWriteRO();

// Totals as the RO is being edited (the server's figures come back on save).
function previewTotals(ro) {
  const cfg = serviceCfg || {};
  const by = { customer: { labor: 0, parts: 0 }, warranty: { labor: 0, parts: 0 }, internal: { labor: 0, parts: 0 } };
  for (const j of ro.jobs || []) {
    const b = by[j.payType] || by.customer;
    b.labor += (Number(j.hours) || 0) * (Number(j.rate) || 0);
    for (const p of j.parts || []) b.parts += (Number(p.qty) || 0) * (Number(p.price) || 0);
  }
  let supplies = by.customer.labor * (Number(cfg.shopSuppliesPct) || 0) / 100;
  if (Number(cfg.shopSuppliesCap) > 0) supplies = Math.min(supplies, Number(cfg.shopSuppliesCap));
  const taxable = (cfg.taxParts ? by.customer.parts + supplies : 0) + (cfg.taxLabor ? by.customer.labor : 0);
  const tax = Math.round(taxable * (Number(cfg.taxRate) || 0)) / 100;
  return {
    customer: by.customer, warranty: by.warranty, internal: by.internal, shopSupplies: supplies, tax,
    customerTotal: by.customer.labor + by.customer.parts + supplies + tax,
    warrantyTotal: by.warranty.labor + by.warranty.parts,
    internalTotal: by.internal.labor + by.internal.parts
  };
}

function renderRoDetail() {
  const ro = currentRO;
  const edit = roEditable();
  const isNew = !ro.id;
  const dis = edit ? '' : html`disabled`;
  const car = ro.carId ? cars.find(c => c.id === ro.carId) : null;
  const advisorOpts = advisors();
  if (ro.advisorId && !advisorOpts.some(u => u.id === ro.advisorId)) advisorOpts.push({ id: ro.advisorId, name: staffName(ro.advisorId) || 'Former employee' });
  document.getElementById('roDetailView').innerHTML = html`
    <div class="appraisal-topbar ro-topbar">
      <button type="button" class="btn-secondary" id="roBackBtn">&larr; Repair Orders</button>
      <h2>${isNew ? 'New Repair Order' : `RO-${ro.roNumber}`}</h2>
      ${isNew ? '' : roStatusBadge(ro.status)}
      ${!isNew && edit ? html`<select id="roStatusSel" class="ro-status-sel" aria-label="Status">
        ${RO_OPEN.map(s => html`<option value="${s}" ${ro.status === s ? html`selected` : ''}>${RO_STATUS_LABELS[s]}</option>`)}</select>` : ''}
      <span class="appraisal-dirty" id="roDirtyNote"></span>
      <span class="ro-top-actions">
        ${isNew ? '' : html`<button type="button" class="btn-secondary" id="roPrintBtn">Print</button>`}
        ${!isNew && edit ? html`<button type="button" class="btn-secondary" id="roVoidBtn">Void</button>` : ''}
        ${!isNew && edit ? html`<button type="button" class="btn-secondary" id="roCloseBtn">Close RO</button>` : ''}
        ${edit ? html`<button type="button" class="btn-primary" id="roSaveBtn">${isNew ? 'Open RO' : 'Save'}</button>` : ''}
      </span>
    </div>
    ${ro.status === 'closed' ? html`<p class="ro-banner">Closed ${shortWhen(ro.closedAt)}${ro.closedBy ? ` by ${ro.closedBy.name}` : ''}. Closed ROs are locked.</p>` : ''}
    ${ro.status === 'void' ? html`<p class="ro-banner ro-banner-void">Voided ${shortWhen(ro.closedAt)}${ro.closedBy ? ` by ${ro.closedBy.name}` : ''}.</p>` : ''}
    <div class="ro-layout">
      <div class="ro-main">
        <div class="ro-card">
          <div class="ro-card-title">Customer &amp; vehicle</div>
          ${isNew ? html`
            <div class="ro-who-toggle">
              <label><input type="radio" name="roWho" value="customer" ${ro.carId && !ro.leadId ? '' : html`checked`} /> Customer</label>
              <label><input type="radio" name="roWho" value="internal" ${ro.carId && !ro.leadId ? html`checked` : ''} /> Internal / recon (car in inventory)</label>
            </div>
            <div id="roWhoPicker"></div>
            <div id="roTheirVehicles"></div>` : html`
            <div class="ro-who">
              ${ro.leadId ? html`<button type="button" class="link-btn" data-ro-lead="${ro.leadId}">${ro.customerName || 'Customer'}</button>` : ''}
              ${car ? html`<span class="cp-chip">Internal · ${carPickLabel(car)}</span>` : ''}
            </div>`}
          <div class="ro-grid">
            <label class="ro-span-2">VIN <span class="ro-vin-row"><input type="text" data-veh="vin" maxlength="17" value="${ro.vehicle.vin || ''}" ${dis} />
              ${edit ? html`<button type="button" class="btn-secondary btn-small" id="roDecodeBtn">Decode</button>` : ''}</span></label>
            <label>Year <input type="text" data-veh="year" maxlength="4" value="${ro.vehicle.year || ''}" ${dis} /></label>
            <label>Make <input type="text" data-veh="make" value="${ro.vehicle.make || ''}" ${dis} /></label>
            <label>Model <input type="text" data-veh="model" value="${ro.vehicle.model || ''}" ${dis} /></label>
            <label>Color <input type="text" data-veh="color" value="${ro.vehicle.color || ''}" ${dis} /></label>
            <label>Plate <input type="text" data-veh="plate" value="${ro.vehicle.plate || ''}" ${dis} /></label>
            <label>Miles in <input type="number" data-veh="mileageIn" min="0" value="${ro.vehicle.mileageIn ?? ''}" ${dis} /></label>
            <label>Miles out <input type="number" data-veh="mileageOut" min="0" value="${ro.vehicle.mileageOut ?? ''}" ${dis} /></label>
          </div>
          <p class="send-text-status-error" id="roVinMsg"></p>
          <div class="ro-grid ro-grid-3">
            <label>Advisor <select data-ro="advisorId" ${dis}>
              <option value="">--</option>
              ${advisorOpts.map(u => html`<option value="${u.id}" ${u.id === ro.advisorId ? html`selected` : ''}>${u.name}</option>`)}</select></label>
            <label>Promised <input type="datetime-local" data-ro="promisedAt" value="${toLocalInput(ro.promisedAt)}" ${dis} /></label>
            <label>Notes <input type="text" data-ro="notes" value="${ro.notes || ''}" placeholder="Waiting, loaner, pickup..." ${dis} /></label>
          </div>
        </div>

        <div id="roJobs">${ro.jobs.map((j, i) => renderJob(j, i))}</div>
        ${edit ? html`<button type="button" class="btn-secondary" id="roAddJobBtn">+ Add job</button>` : ''}
      </div>
      <aside class="ro-side" id="roTotals"></aside>
    </div>`;
  renderRoTotals();
  if (isNew) renderWhoPicker();
  if (edit && typeof attachRoPartPickers === 'function') attachRoPartPickers();
}

function renderJob(j, i) {
  const edit = roEditable();
  const dis = edit ? '' : html`disabled`;
  const me = currentUser.id;
  const techCanWork = RO_OPEN.includes(currentRO.status) && currentRO.id && j.id &&
    (isTechUser() ? (!j.techId || j.techId === me) : canWriteRO() && !!j.techId);
  const notesEditable = RO_OPEN.includes(currentRO.status) && (edit || (isTechUser() && (!j.techId || j.techId === me)));
  const ndis = notesEditable ? '' : html`disabled`;
  const techOpts = [...serviceTechs];
  if (j.techId && !techOpts.some(t => t.id === j.techId)) techOpts.push({ id: j.techId, name: techName(j.techId) });
  const labor = (Number(j.hours) || 0) * (Number(j.rate) || 0);
  const parts = (j.parts || []).reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.price) || 0), 0);
  const showCost = !isTechUser();
  return html`<div class="ro-card ro-job" data-job="${i}">
    <div class="ro-job-head">
      <span class="ro-job-num">Job ${i + 1}</span>
      <select data-job-field="payType" ${dis} aria-label="Who pays">
        ${Object.entries(PAY_LABELS).map(([k, l]) => html`<option value="${k}" ${j.payType === k ? html`selected` : ''}>${l}</option>`)}
      </select>
      <span class="ro-job-status ro-js-${j.status}">${JOB_STATUS_LABELS[j.status] || j.status}</span>
      ${j.clockedHours ? html`<span class="ro-clocked">${Number(j.clockedHours).toFixed(2)} h clocked</span>` : ''}
      <span class="ro-job-actions">
        ${techCanWork && j.clockedIn ? html`<button type="button" class="btn-secondary btn-small" data-clock="out">Clock out</button>
          <button type="button" class="btn-primary btn-small" data-clock="done">Clock out &amp; done</button>` : ''}
        ${techCanWork && !j.clockedIn && j.status !== 'done' ? html`<button type="button" class="btn-primary btn-small" data-clock="in">▶ Clock in</button>` : ''}
        ${edit && !(j.punches || []).length ? html`<button type="button" class="recon-remove" data-remove-job title="Remove job" aria-label="Remove job">✕</button>` : ''}
      </span>
    </div>
    <label>Concern (what the customer says) <textarea rows="2" data-job-field="concern" ${dis}>${j.concern || ''}</textarea></label>
    <div class="ro-grid ro-grid-2">
      <label>Cause <textarea rows="2" data-job-field="cause" ${ndis}>${j.cause || ''}</textarea></label>
      <label>Correction <textarea rows="2" data-job-field="correction" ${ndis}>${j.correction || ''}</textarea></label>
    </div>
    ${!edit && notesEditable && j.id ? html`<div class="ro-tech-save"><button type="button" class="btn-secondary btn-small" data-tech-save>Save notes</button>
      ${j.status !== 'done' ? html`<button type="button" class="btn-secondary btn-small" data-tech-done>Mark done</button>` : ''}</div>` : ''}
    <div class="ro-grid ro-grid-4">
      <label>Technician <select data-job-field="techId" ${dis}>
        <option value="">Unassigned</option>
        ${techOpts.map(t => html`<option value="${t.id}" ${t.id === j.techId ? html`selected` : ''}>${t.name}</option>`)}</select></label>
      <label>Op code <input type="text" data-job-field="opCode" value="${j.opCode || ''}" ${dis} /></label>
      <label>Hours sold <input type="number" step="0.1" min="0" data-job-field="hours" value="${j.hours || ''}" ${dis} /></label>
      <label>Rate / hr <input type="number" step="0.01" min="0" data-job-field="rate" value="${j.rate ?? ''}" ${dis} /></label>
    </div>
    <div class="ro-parts">
      <div class="ro-parts-head"><span>Parts</span></div>
      ${(j.parts || []).length ? html`<table class="ro-parts-table"><thead><tr><th>Part #</th><th>Description</th><th>Qty</th>${showCost ? html`<th>Cost</th>` : ''}<th>Price</th><th>Total</th><th></th></tr></thead><tbody>
        ${j.parts.map((p, k) => html`<tr data-part="${k}">
          <td><input type="text" data-part-field="number" placeholder="Part #" value="${p.number || ''}" ${dis} /></td>
          <td class="ro-part-desc"><input type="text" data-part-field="description" placeholder="Description" value="${p.description || ''}" ${dis} /></td>
          <td><input type="number" step="0.01" min="0" data-part-field="qty" placeholder="Qty" value="${p.qty ?? 1}" ${dis} /></td>
          ${showCost ? html`<td><input type="number" step="0.01" min="0" data-part-field="cost" placeholder="Cost" value="${p.cost ?? ''}" ${dis} /></td>` : ''}
          <td><input type="number" step="0.01" min="0" data-part-field="price" placeholder="Price" value="${p.price ?? ''}" ${dis} /></td>
          <td class="ro-num">${svcMoney((Number(p.qty) || 0) * (Number(p.price) || 0))}</td>
          <td>${edit ? html`<button type="button" class="recon-remove" data-remove-part title="Remove part" aria-label="Remove part">✕</button>` : ''}</td></tr>`)}
      </tbody></table>` : html`<p class="audit-note">No parts on this job.</p>`}
      ${edit ? html`<div class="ro-part-tools">
        ${userCan('viewParts') ? html`<div class="ro-part-find" data-part-find="${i}"></div>` : ''}
        <button type="button" class="btn-secondary btn-small" data-add-part>+ Part by hand</button>
        ${currentRO.id && userCan('viewParts') ? html`<button type="button" class="btn-secondary btn-small" data-special-order>Special order</button>` : ''}
      </div>` : ''}
    </div>
    <div class="ro-job-foot">Labor ${svcMoney(labor)} · Parts ${svcMoney(parts)}</div>
  </div>`;
}

function renderRoTotals() {
  const ro = currentRO;
  const t = ro.id && !roDirty && ro.totals ? ro.totals : previewTotals(ro);
  const showCost = !isTechUser() && ro.totals && ro.totals.laborCost !== undefined && !roDirty;
  const line = (label, v, cls = '') => html`<div class="ro-tline ${cls}"><span>${label}</span><strong>${svcMoney(v)}</strong></div>`;
  document.getElementById('roTotals').innerHTML = html`
    <div class="ro-card">
      <div class="ro-card-title">Customer pays</div>
      ${line('Labor', t.customer.labor)}${line('Parts', t.customer.parts)}
      ${line('Shop supplies', t.shopSupplies)}${line('Tax', t.tax)}
      ${line('Total', t.customerTotal, 'ro-tline-total')}
      ${t.warrantyTotal ? html`<div class="ro-card-title ro-card-sub">Warranty (billed to the maker)</div>${line('Labor', t.warranty.labor)}${line('Parts', t.warranty.parts)}${line('Total', t.warrantyTotal, 'ro-tline-total')}` : ''}
      ${t.internalTotal ? html`<div class="ro-card-title ro-card-sub">Internal${ro.carId ? ' (added to the car’s cost when closed)' : ''}</div>${line('Labor', t.internal.labor)}${line('Parts', t.internal.parts)}${line('Total', t.internalTotal, 'ro-tline-total')}` : ''}
      ${showCost ? html`<div class="ro-card-title ro-card-sub">Gross</div>
        ${line('Labor sold', ro.totals.laborSale)}${line('Tech pay', -ro.totals.laborCost)}
        ${line('Parts sold', ro.totals.partsSale)}${line('Parts cost', -ro.totals.partsCost)}
        ${line('Gross', ro.totals.laborSale - ro.totals.laborCost + ro.totals.partsSale - ro.totals.partsCost, 'ro-tline-total')}` : ''}
      ${roDirty ? html`<p class="audit-note">Save to update.</p>` : ''}
    </div>`;
}

function markRoDirty() {
  roDirty = true;
  const note = document.getElementById('roDirtyNote');
  if (note) note.textContent = 'Unsaved changes';
  renderRoTotals();
}

// Customer or inventory car picker on a new RO.
function renderWhoPicker() {
  const internal = document.querySelector('input[name="roWho"]:checked').value === 'internal';
  const holder = document.getElementById('roWhoPicker');
  holder.innerHTML = '';
  const picker = createSearchPicker(internal ? {
    kind: 'car', getIds: () => cars.filter(c => c.status !== 'sold').map(c => c.id),
    onPick: (id) => {
      currentRO.carId = id || null; currentRO.leadId = null;
      const c = cars.find(x => x.id === id);
      picker.setLabel(c ? carPickLabel(c) : '');
      if (c) {
        Object.assign(currentRO.vehicle, { vin: String(c.vin || '').toUpperCase(), year: String(c.year || ''), make: c.make || '', model: c.model || '', color: c.exteriorColor || c.color || '', mileageIn: c.mileage || '' });
        currentRO.jobs.forEach(j => { if (!j.id && j.payType === 'customer' && !j.hours) { j.payType = 'internal'; j.rate = serviceCfg.internalLaborRate; } });
        renderRoDetail(); markRoDirty();
      }
    }
  } : {
    kind: 'lead', getIds: () => leads.map(l => l.id),
    onPick: (id) => {
      currentRO.leadId = id || null; currentRO.carId = null;
      const l = leads.find(x => x.id === id);
      picker.setLabel(l ? leadPickLabel(l) : '');
      currentRO.customerName = l ? l.name : '';
      markRoDirty();
      loadTheirVehicles(id);
    }
  });
  holder.appendChild(picker.element);
  if (internal && currentRO.carId) { const c = cars.find(x => x.id === currentRO.carId); if (c) picker.setLabel(carPickLabel(c)); }
  if (!internal && currentRO.leadId) { const l = leads.find(x => x.id === currentRO.leadId); if (l) picker.setLabel(leadPickLabel(l)); loadTheirVehicles(currentRO.leadId); }
}

async function loadTheirVehicles(leadId) {
  const box = document.getElementById('roTheirVehicles');
  if (!box) return;
  box.innerHTML = '';
  if (!leadId) return;
  const list = await fetch(`${API}/service/customer/${leadId}/vehicles`).then(svcJson).catch(() => []);
  if (!list.length) return;
  box.innerHTML = html`<div class="ro-their">Their vehicles:
    ${list.map((v, i) => html`<button type="button" class="cp-chip ro-their-btn" data-their="${i}">${vehicleLabel(v)}${v.boughtHere ? ' · bought here' : ''}</button>`)}</div>`;
  box.onclick = (e) => {
    const b = e.target.closest('[data-their]');
    if (!b) return;
    const v = list[Number(b.dataset.their)];
    Object.assign(currentRO.vehicle, { vin: v.vin || '', year: v.year || '', make: v.make || '', model: v.model || '', color: v.color || '' });
    document.querySelectorAll('[data-veh]').forEach(inp => { if (inp.dataset.veh in currentRO.vehicle) inp.value = currentRO.vehicle[inp.dataset.veh] ?? ''; });
    markRoDirty();
  };
}

// ----- Editing -----

const detail = document.getElementById('roDetailView');

detail.addEventListener('input', (e) => {
  const t = e.target;
  if (!currentRO) return;
  if (t.dataset.veh) { currentRO.vehicle[t.dataset.veh] = t.value; markRoDirty(); return; }
  if (t.dataset.ro) { currentRO[t.dataset.ro] = t.dataset.ro === 'promisedAt' ? (t.value ? new Date(t.value).toISOString() : null) : t.value; markRoDirty(); return; }
  const jobEl = t.closest('[data-job]');
  if (!jobEl) return;
  const job = currentRO.jobs[Number(jobEl.dataset.job)];
  if (t.dataset.jobField) {
    const f = t.dataset.jobField;
    job[f] = ['hours', 'rate'].includes(f) ? t.value : (f === 'techId' ? (t.value || null) : t.value);
    if (f === 'payType') job.rate = serviceCfg[`${t.value}LaborRate`];
    if (f === 'payType' || f === 'techId') { renderRoDetail(); }
    markRoDirty();
    if (['hours', 'rate'].includes(f)) jobEl.querySelector('.ro-job-foot').textContent = jobFootText(job);
    return;
  }
  if (t.dataset.partField) {
    const part = job.parts[Number(t.closest('[data-part]').dataset.part)];
    part[t.dataset.partField] = t.value;
    const row = t.closest('[data-part]');
    row.querySelector('.ro-num').textContent = svcMoney((Number(part.qty) || 0) * (Number(part.price) || 0));
    jobEl.querySelector('.ro-job-foot').textContent = jobFootText(job);
    markRoDirty();
  }
});
detail.addEventListener('change', (e) => {
  if (e.target.name === 'roWho') { currentRO.leadId = null; currentRO.carId = null; renderWhoPicker(); return; }
  if (e.target.id === 'roStatusSel') { currentRO.status = e.target.value; markRoDirty(); }
});

function jobFootText(job) {
  const labor = (Number(job.hours) || 0) * (Number(job.rate) || 0);
  const parts = (job.parts || []).reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.price) || 0), 0);
  return `Labor ${svcMoney(labor)} · Parts ${svcMoney(parts)}`;
}

detail.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'roBackBtn') { if (showRoList()) renderRoList(); return; }
  if (t.closest('[data-ro-lead]')) { openLeadProfile(t.closest('[data-ro-lead]').dataset.roLead); return; }
  if (t.id === 'roAddJobBtn') { currentRO.jobs.push(blankJob(currentRO.carId && !currentRO.leadId ? 'internal' : 'customer')); renderRoDetail(); markRoDirty(); return; }
  if (t.id === 'roSaveBtn') { await saveRO(); return; }
  if (t.id === 'roCloseBtn') { await closeRO(); return; }
  if (t.id === 'roVoidBtn') { await voidRO(); return; }
  if (t.id === 'roPrintBtn') { printRO(); return; }
  if (t.id === 'roDecodeBtn') { await decodeRoVin(); return; }
  const jobEl = t.closest('[data-job]');
  if (!jobEl) return;
  const i = Number(jobEl.dataset.job);
  const job = currentRO.jobs[i];
  if (t.closest('[data-remove-job]')) { currentRO.jobs.splice(i, 1); if (!currentRO.jobs.length) currentRO.jobs.push(blankJob()); renderRoDetail(); markRoDirty(); return; }
  if (t.closest('[data-add-part]')) { job.parts.push({ number: '', description: '', qty: 1, cost: '', price: '' }); renderRoDetail(); markRoDirty(); return; }
  if (t.closest('[data-remove-part]')) { job.parts.splice(Number(t.closest('[data-part]').dataset.part), 1); renderRoDetail(); markRoDirty(); return; }
  if (t.closest('[data-special-order]')) { openSpecialOrderModal({ roId: currentRO.id, roNumber: currentRO.roNumber, leadId: currentRO.leadId }); return; }
  if (t.closest('[data-clock]')) { await clockJob(job, t.closest('[data-clock]').dataset.clock); return; }
  if (t.closest('[data-tech-save]') || t.closest('[data-tech-done]')) {
    const body = { cause: job.cause, correction: job.correction };
    if (t.closest('[data-tech-done]')) body.status = 'done';
    await roCall(`${API}/service/ros/${currentRO.id}/jobs/${job.id}/tech`, 'PUT', body);
  }
});

async function roCall(url, method, body) {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const saved = await svcJson(res);
    const i = serviceROs.findIndex(r => r.id === saved.id);
    if (i >= 0) serviceROs[i] = saved; else serviceROs.unshift(saved);
    showRoDetail(saved);
    return saved;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

function roPayload() {
  const ro = currentRO;
  return {
    leadId: ro.leadId, carId: ro.carId, vehicle: ro.vehicle, advisorId: ro.advisorId, promisedAt: ro.promisedAt, notes: ro.notes,
    status: ro.status,
    jobs: ro.jobs.map(j => ({ id: j.id, concern: j.concern, cause: j.cause, correction: j.correction, opCode: j.opCode, payType: j.payType,
      techId: j.techId, hours: j.hours, rate: j.rate, status: j.status,
      parts: (j.parts || []).filter(p => p.number || p.description || Number(p.price) || Number(p.cost)) }))
  };
}

async function saveRO() {
  if (!currentRO.id) {
    if (!currentRO.leadId && !currentRO.carId) { alert('Pick a customer, or a car in inventory for internal work.'); return null; }
    roDirty = false;
    return roCall(`${API}/service/ros`, 'POST', roPayload());
  }
  roDirty = false;
  return roCall(`${API}/service/ros/${currentRO.id}`, 'PUT', roPayload());
}

async function clockJob(job, action) {
  if (roDirty && canWriteRO()) { const saved = await saveRO(); if (!saved) return; job = saved.jobs.find(j => j.id === job.id) || job; }
  const body = { action: action === 'in' ? 'in' : 'out', done: action === 'done', techId: job.techId };
  await roCall(`${API}/service/ros/${currentRO.id}/jobs/${job.id}/clock`, 'POST', body);
}

async function closeRO() {
  if (roDirty) { const saved = await saveRO(); if (!saved) return; }
  const t = currentRO.totals;
  const miles = prompt(`Close RO-${currentRO.roNumber}?\nCustomer total ${svcMoney(t.customerTotal)}${t.warrantyTotal ? `, warranty ${svcMoney(t.warrantyTotal)}` : ''}${t.internalTotal ? `, internal ${svcMoney(t.internalTotal)}` : ''}.\n\nMiles out:`, currentRO.vehicle.mileageOut ?? currentRO.vehicle.mileageIn ?? '');
  if (miles === null) return;
  const saved = await roCall(`${API}/service/ros/${currentRO.id}/close`, 'POST', { mileageOut: miles });
  if (saved && saved.carId) loadAll();
}

async function voidRO() {
  const reason = prompt(`Void RO-${currentRO.roNumber}? Why?`);
  if (reason === null) return;
  roDirty = false;
  await roCall(`${API}/service/ros/${currentRO.id}/void`, 'POST', { reason });
}

async function decodeRoVin() {
  const vin = String(currentRO.vehicle.vin || '').trim();
  const msg = document.getElementById('roVinMsg');
  msg.textContent = '';
  if (vin.length !== 17) { msg.textContent = 'A VIN is 17 characters.'; return; }
  try {
    const d = await fetch(`${API}/vin/${encodeURIComponent(vin)}`).then(svcJson);
    Object.assign(currentRO.vehicle, { vin: d.vin || vin, year: d.year ? String(d.year) : currentRO.vehicle.year, make: d.make || currentRO.vehicle.make, model: d.model || currentRO.vehicle.model });
    document.querySelectorAll('[data-veh]').forEach(inp => { inp.value = currentRO.vehicle[inp.dataset.veh] ?? ''; });
    markRoDirty();
  } catch (err) { msg.textContent = err.message; }
}

function printRO() {
  const ro = currentRO;
  const t = ro.totals;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print.'); return; }
  const row = (a, b) => html`<tr><td>${a}</td><td class="r">${b}</td></tr>`;
  w.document.write(String(html`<!doctype html><html><head><title>RO-${ro.roNumber}</title><style>
    body{font-family:-apple-system,"Segoe UI",sans-serif;color:#111;margin:32px;font-size:13px}
    h1{font-size:22px;margin:0}.top{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}
    .job{border:1px solid #ccc;border-radius:6px;padding:10px;margin-bottom:10px}.job h3{margin:0 0 6px;font-size:14px}
    table{width:100%;border-collapse:collapse}td,th{padding:4px 6px;text-align:left;border-bottom:1px solid #eee}.r{text-align:right}
    .tot{width:320px;margin-left:auto}.tot tr:last-child td{font-weight:700;border-top:2px solid #111}.muted{color:#666}
  </style></head><body>
    <div class="top"><div><h1>${appSettings.dealershipName || 'DealerDomus'}</h1><div class="muted">Repair Order</div></div>
      <div class="r"><h1>RO-${ro.roNumber}</h1><div>${RO_STATUS_LABELS[ro.status]} · opened ${new Date(ro.openedAt).toLocaleDateString()}</div></div></div>
    <p><strong>${ro.customerName || 'Internal'}</strong><br>${vehicleLabel(ro.vehicle)}${ro.vehicle.vin ? ` · VIN ${ro.vehicle.vin}` : ''}<br>
      Miles in ${ro.vehicle.mileageIn ?? '--'} · out ${ro.vehicle.mileageOut ?? '--'} · Advisor ${staffName(ro.advisorId) || '--'}</p>
    ${ro.jobs.map((j, i) => html`<div class="job"><h3>Job ${i + 1} · ${PAY_LABELS[j.payType]}</h3>
      <div><strong>Concern:</strong> ${j.concern || '--'}</div><div><strong>Cause:</strong> ${j.cause || '--'}</div><div><strong>Correction:</strong> ${j.correction || '--'}</div>
      <table><tbody>${row(`Labor: ${Number(j.hours || 0)} h × ${svcMoney(j.rate)}${j.techId ? ` · Tech ${techName(j.techId)}` : ''}`, svcMoney((Number(j.hours) || 0) * (Number(j.rate) || 0)))}
      ${(j.parts || []).map(p => row(`${p.qty} × ${[p.number, p.description].filter(Boolean).join(' ')}`, svcMoney((Number(p.qty) || 0) * (Number(p.price) || 0))))}</tbody></table></div>`)}
    <table class="tot"><tbody>${row('Labor', svcMoney(t.customer.labor))}${row('Parts', svcMoney(t.customer.parts))}${row('Shop supplies', svcMoney(t.shopSupplies))}${row('Tax', svcMoney(t.tax))}${row('Customer total', svcMoney(t.customerTotal))}</tbody></table>
    ${t.warrantyTotal ? html`<p class="muted">Warranty work (no charge to customer): ${svcMoney(t.warrantyTotal)}</p>` : ''}
    <script>window.onload = () => window.print();<\/script></body></html>`));
  w.document.close();
}

// ---------- Service setup ----------

document.getElementById('serviceSetupBtn').addEventListener('click', async () => {
  try {
    const [cfg, techs] = await Promise.all([fetch(`${API}/service/settings`).then(svcJson), fetch(`${API}/service/techs`).then(svcJson)]);
    serviceCfg = cfg;
    serviceTechs = techs;
    document.getElementById('ssCustomerRate').value = cfg.customerLaborRate;
    document.getElementById('ssWarrantyRate').value = cfg.warrantyLaborRate;
    document.getElementById('ssInternalRate').value = cfg.internalLaborRate;
    document.getElementById('ssSuppliesPct').value = cfg.shopSuppliesPct;
    document.getElementById('ssSuppliesCap').value = cfg.shopSuppliesCap;
    document.getElementById('ssTaxParts').checked = !!cfg.taxParts;
    document.getElementById('ssTaxLabor').checked = !!cfg.taxLabor;
    document.getElementById('ssTaxRateNote').textContent = `The store's tax rate is ${cfg.taxRate}% (set in Admin → Fee Defaults).`;
    document.getElementById('ssMsg').textContent = '';
    renderSetupTechs();
    document.getElementById('serviceSetupModal').classList.add('active');
  } catch (err) { alert(err.message); }
});

function renderSetupTechs() {
  document.getElementById('ssTechs').innerHTML = serviceTechs.length ? html`<table class="data-table"><thead><tr><th>Technician</th><th>Paid</th><th>Rate ($/hr)</th><th></th></tr></thead><tbody>
    ${serviceTechs.map(t => html`<tr data-tech="${t.id}"><td>${t.name}</td>
      <td><select class="ss-pay-type"><option value="flat" ${t.pay.type === 'flat' ? html`selected` : ''}>Flat rate</option><option value="hourly" ${t.pay.type === 'hourly' ? html`selected` : ''}>Hourly</option></select></td>
      <td><input type="number" class="ss-pay-rate" min="0" step="0.01" value="${t.pay.rate || ''}" /></td>
      <td><button type="button" class="btn-secondary btn-small" data-save-pay>Save</button></td></tr>`)}</tbody></table>`
    : html`<p class="audit-note">No technicians yet.</p>`;
}

document.getElementById('ssTechs').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-save-pay]');
  if (!b) return;
  const row = b.closest('[data-tech]');
  try {
    const saved = await fetch(`${API}/service/techs/${row.dataset.tech}/pay`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: row.querySelector('.ss-pay-type').value, rate: row.querySelector('.ss-pay-rate').value })
    }).then(svcJson);
    const t = serviceTechs.find(x => x.id === saved.id);
    if (t) t.pay = saved.pay;
    b.textContent = 'Saved ✓';
    setTimeout(() => { b.textContent = 'Save'; }, 1500);
  } catch (err) { document.getElementById('ssMsg').textContent = err.message; }
});

document.getElementById('ssSaveBtn').addEventListener('click', async () => {
  try {
    serviceCfg = await fetch(`${API}/service/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerLaborRate: document.getElementById('ssCustomerRate').value, warrantyLaborRate: document.getElementById('ssWarrantyRate').value,
        internalLaborRate: document.getElementById('ssInternalRate').value, shopSuppliesPct: document.getElementById('ssSuppliesPct').value,
        shopSuppliesCap: document.getElementById('ssSuppliesCap').value,
        taxParts: document.getElementById('ssTaxParts').checked, taxLabor: document.getElementById('ssTaxLabor').checked
      })
    }).then(svcJson);
    document.getElementById('serviceSetupModal').classList.remove('active');
  } catch (err) { document.getElementById('ssMsg').textContent = err.message; }
});
document.getElementById('ssCancelBtn').addEventListener('click', () => document.getElementById('serviceSetupModal').classList.remove('active'));

// ---------- Appointments ----------

let apptDay = null;
let apptList = [];
let editingAppt = null;
let apptLeadId = null;
let apptVehicles = [];

function dayKey(d) { const pad = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function openServiceAppointments() {
  if (!apptDay) apptDay = dayKey(new Date());
  document.getElementById('apptDay').value = apptDay;
  document.getElementById('newApptBtn').hidden = !canWriteRO();
  loadAppointments();
}

async function loadAppointments() {
  const [y, m, d] = apptDay.split('-').map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 1);
  document.getElementById('apptDayTitle').textContent = from.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  try {
    apptList = await fetch(`${API}/service/appointments?from=${from.toISOString()}&to=${to.toISOString()}`).then(svcJson);
    if (!serviceCfg) await loadServiceData();
  } catch (err) { document.getElementById('apptList').innerHTML = html`<p class="send-text-status-error">${err.message}</p>`; return; }
  renderAppointments();
}

function renderAppointments() {
  const edit = canWriteRO();
  document.getElementById('apptList').innerHTML = apptList.length ? apptList.map(a => html`
    <div class="appt-card appt-${a.status}" data-appt="${a.id}">
      <div class="appt-time">${new Date(a.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
      <div class="appt-body">
        <div class="appt-who"><button type="button" class="link-btn" data-appt-lead="${a.leadId}">${a.customerName}</button>
          ${a.waiter ? html`<span class="cp-chip cp-chip-warn">Waiting</span>` : ''}
          <span class="appt-status">${APPT_STATUS_LABELS[a.status]}</span></div>
        <div class="appt-veh">${vehicleLabel(a.vehicle)}${a.advisorId ? ` · Advisor ${staffName(a.advisorId)}` : ''}</div>
        ${a.concern ? html`<div class="appt-concern">${a.concern}</div>` : ''}
      </div>
      <div class="appt-actions">
        ${a.roId ? html`<button type="button" class="btn-secondary btn-small" data-appt-ro="${a.roId}">Open RO</button>` : ''}
        ${edit && !a.roId && a.status === 'scheduled' ? html`
          <button type="button" class="btn-primary btn-small" data-appt-arrive>Arrived → RO</button>
          <button type="button" class="btn-secondary btn-small" data-appt-edit>Edit</button>
          <button type="button" class="btn-secondary btn-small" data-appt-set="no_show">No-show</button>
          <button type="button" class="btn-secondary btn-small" data-appt-set="cancelled">Cancel</button>` : ''}
        ${edit && !a.roId && ['no_show', 'cancelled'].includes(a.status) ? html`<button type="button" class="btn-secondary btn-small" data-appt-set="scheduled">Undo</button>` : ''}
      </div>
    </div>`).join('') : html`<p class="no-deals-note">No appointments this day.</p>`;
}

document.getElementById('apptDay').addEventListener('change', (e) => { if (e.target.value) { apptDay = e.target.value; loadAppointments(); } });
function shiftApptDay(n) {
  const [y, m, d] = apptDay.split('-').map(Number);
  apptDay = dayKey(new Date(y, m - 1, d + n));
  document.getElementById('apptDay').value = apptDay;
  loadAppointments();
}
document.getElementById('apptPrevDay').addEventListener('click', () => shiftApptDay(-1));
document.getElementById('apptNextDay').addEventListener('click', () => shiftApptDay(1));
document.getElementById('apptToday').addEventListener('click', () => { apptDay = dayKey(new Date()); document.getElementById('apptDay').value = apptDay; loadAppointments(); });

document.getElementById('apptList').addEventListener('click', async (e) => {
  const card = e.target.closest('[data-appt]');
  if (!card) return;
  const a = apptList.find(x => x.id === card.dataset.appt);
  if (e.target.closest('[data-appt-lead]')) { openLeadProfile(a.leadId); return; }
  if (e.target.closest('[data-appt-ro]')) { openRoById(a.roId); return; }
  if (e.target.closest('[data-appt-edit]')) { openApptModal({ appt: a }); return; }
  const set = e.target.closest('[data-appt-set]');
  try {
    if (set) {
      await fetch(`${API}/service/appointments/${a.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: set.dataset.apptSet }) }).then(svcJson);
      loadAppointments();
    }
    if (e.target.closest('[data-appt-arrive]')) {
      const miles = prompt('Miles in:', '');
      if (miles === null) return;
      const ro = await fetch(`${API}/service/appointments/${a.id}/open-ro`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vehicle: miles ? { mileageIn: miles } : {} })
      }).then(svcJson);
      serviceROs.unshift(ro);
      showView('service');
      showRoDetail(ro);
    }
  } catch (err) { alert(err.message); }
});

// The appointment form. Pass { leadId } to start it for a customer.
window.openApptModal = function({ appt = null, leadId = null } = {}) {
  editingAppt = appt;
  apptLeadId = appt ? appt.leadId : leadId;
  document.getElementById('apptModalTitle').textContent = appt ? 'Edit Service Appointment' : 'New Service Appointment';
  const holder = document.getElementById('apptCustomerPicker');
  holder.innerHTML = '';
  const picker = createSearchPicker({
    kind: 'lead', getIds: () => leads.map(l => l.id),
    onPick: (id) => { apptLeadId = id || null; const l = leads.find(x => x.id === id); picker.setLabel(l ? leadPickLabel(l) : ''); loadApptVehicles(); }
  });
  holder.appendChild(picker.element);
  const l = leads.find(x => x.id === apptLeadId);
  if (l) picker.setLabel(leadPickLabel(l));
  const v = (appt && appt.vehicle) || {};
  document.getElementById('apptYear').value = v.year || '';
  document.getElementById('apptMake').value = v.make || '';
  document.getElementById('apptModel').value = v.model || '';
  document.getElementById('apptVin').value = v.vin || '';
  const start = appt ? new Date(appt.startsAt) : (() => { const [y, m, d] = (apptDay || dayKey(new Date())).split('-').map(Number); return new Date(y, m - 1, d, 9, 0); })();
  document.getElementById('apptStartsAt').value = toLocalInput(start.toISOString());
  document.getElementById('apptConcern').value = appt ? appt.concern : '';
  document.getElementById('apptWaiter').checked = !!(appt && appt.waiter);
  const adv = document.getElementById('apptAdvisor');
  adv.innerHTML = html`<option value="">--</option>` + advisors().map(u => html`<option value="${u.id}">${u.name}</option>`).join('');
  adv.value = (appt && appt.advisorId) || (advisors().some(u => u.id === currentUser.id) ? currentUser.id : '');
  document.getElementById('apptMsg').textContent = '';
  loadApptVehicles();
  document.getElementById('apptModal').classList.add('active');
};

async function loadApptVehicles() {
  const sel = document.getElementById('apptVehiclePick');
  apptVehicles = apptLeadId ? await fetch(`${API}/service/customer/${apptLeadId}/vehicles`).then(svcJson).catch(() => []) : [];
  sel.innerHTML = html`<option value="">${apptVehicles.length ? 'Pick one of theirs, or type it below' : 'Type the vehicle below'}</option>` +
    apptVehicles.map((v, i) => html`<option value="${i}">${vehicleLabel(v)}${v.vin ? ` · …${v.vin.slice(-6)}` : ''}</option>`).join('');
}
document.getElementById('apptVehiclePick').addEventListener('change', (e) => {
  const v = apptVehicles[Number(e.target.value)];
  if (!v) return;
  document.getElementById('apptYear').value = v.year || '';
  document.getElementById('apptMake').value = v.make || '';
  document.getElementById('apptModel').value = v.model || '';
  document.getElementById('apptVin').value = v.vin || '';
});

document.getElementById('newApptBtn').addEventListener('click', () => openApptModal({}));
document.getElementById('apptCancelBtn').addEventListener('click', () => document.getElementById('apptModal').classList.remove('active'));
document.getElementById('apptForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('apptMsg');
  if (!apptLeadId) { msg.textContent = 'Pick a customer.'; return; }
  const startsAt = document.getElementById('apptStartsAt').value;
  const body = {
    leadId: apptLeadId, startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    vehicle: { year: document.getElementById('apptYear').value, make: document.getElementById('apptMake').value, model: document.getElementById('apptModel').value, vin: document.getElementById('apptVin').value },
    concern: document.getElementById('apptConcern').value, advisorId: document.getElementById('apptAdvisor').value || null,
    waiter: document.getElementById('apptWaiter').checked
  };
  try {
    await fetch(editingAppt ? `${API}/service/appointments/${editingAppt.id}` : `${API}/service/appointments`, {
      method: editingAppt ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(svcJson);
    document.getElementById('apptModal').classList.remove('active');
    if (startsAt) apptDay = startsAt.slice(0, 10);
    if (currentView === 'serviceappts') { document.getElementById('apptDay').value = apptDay; loadAppointments(); }
    if (typeof cpLead === 'function' && cpLead()) renderCpService(cpLead());
  } catch (err) { msg.textContent = err.message; }
});

// ---------- Customer page: Service tab ----------

async function renderCpService(lead) {
  const box = document.getElementById('cpService');
  const count = document.getElementById('cpServiceCount');
  if (!box || !lead) return;
  box.innerHTML = html`<p class="audit-note">Loading...</p>`;
  const [vehicles, appts] = await Promise.all([
    fetch(`${API}/service/customer/${lead.id}/vehicles`).then(svcJson).catch(() => []),
    userCan('viewService') ? fetch(`${API}/service/appointments?leadId=${lead.id}`).then(svcJson).catch(() => []) : Promise.resolve([])
  ]);
  if (!cpLead() || cpLead().id !== lead.id) return;
  const upcoming = appts.filter(a => a.status === 'scheduled' && new Date(a.startsAt) >= new Date(Date.now() - 86400000));
  const roCount = vehicles.reduce((s, v) => s + v.ros.length, 0);
  count.textContent = roCount;
  const canOpen = userCan('viewService');
  box.innerHTML = html`
    ${canWriteRO() ? html`<div class="cp-service-actions">
      <button type="button" class="btn-primary btn-small" data-cps-new-ro>+ Open RO</button>
      <button type="button" class="btn-secondary btn-small" data-cps-book>+ Book service</button></div>` : ''}
    ${upcoming.length ? html`<div class="cp-section-head">Upcoming service</div>
      ${upcoming.map(a => html`<div class="cp-deal-row"><div>${shortWhen(a.startsAt)} · ${vehicleLabel(a.vehicle)}<div class="audit-note">${(a.concern || '').split(/\n+/).filter(Boolean).join(' · ')}</div></div></div>`)}` : ''}
    <div class="cp-section-head">Vehicles &amp; service history</div>
    ${vehicles.length ? vehicles.map((v, i) => html`<div class="cps-vehicle">
      <div class="cps-vehicle-head"><strong>${vehicleLabel(v)}</strong>
        ${v.boughtHere ? html`<span class="cp-chip">Bought here${v.dealNumber ? ` · D-${v.dealNumber}` : ''}</span>` : ''}
        ${v.vin ? html`<span class="audit-note">VIN ${v.vin}</span>` : ''}
        ${canWriteRO() ? html`<button type="button" class="link-btn" data-cps-ro-for="${i}">Open RO</button>` : ''}</div>
      ${v.ros.length ? v.ros.map(r => html`<div class="cps-ro">
        ${canOpen ? html`<button type="button" class="deal-number-link" data-cps-ro="${r.id}">RO-${r.roNumber}</button>` : html`<span>RO-${r.roNumber}</span>`}
        <span>${new Date(r.openedAt).toLocaleDateString()}</span>${r.mileage ? html`<span>${Number(r.mileage).toLocaleString()} mi</span>` : ''}
        ${roStatusBadge(r.status)}<span class="cps-ro-jobs">${r.jobs.join(' · ')}</span></div>`) : html`<div class="audit-note">No service here yet.</div>`}
    </div>`) : html`<div class="cp-empty">No vehicles yet. Cars they buy here and vehicles they bring in for service show up here.</div>`}`;
  box.onclick = (e) => {
    if (e.target.closest('[data-cps-new-ro]')) { closeCustomerPage(); startNewRO({ leadId: lead.id }); }
    else if (e.target.closest('[data-cps-book]')) openApptModal({ leadId: lead.id });
    else if (e.target.closest('[data-cps-ro]')) { const id = e.target.closest('[data-cps-ro]').dataset.cpsRo; closeCustomerPage(); openRoById(id); }
    else if (e.target.closest('[data-cps-ro-for]')) {
      const v = vehicles[Number(e.target.closest('[data-cps-ro-for]').dataset.cpsRoFor)];
      closeCustomerPage();
      startNewRO({ leadId: lead.id, vehicle: { vin: v.vin, year: v.year, make: v.make, model: v.model, color: v.color } });
    }
  };
}
