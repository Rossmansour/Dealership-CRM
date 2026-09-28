// parts-ui.js
// Parts screens: the shelf (part list, part card with receive / count /
// history), counter tickets, special orders and the reorder list, plus the
// "find in stock" box used on repair orders. Loaded after app.js and
// service-ui.js and uses their helpers.

let partsList = [];
let partsLoaded = false;
let editingPart = null;
let ticketsList = [];
let currentTicket = null;
let ticketDirty = false;
let soList = [];
let soContext = {};

const canWriteParts = () => userCan('writeParts');
const hidesCost = () => currentUser && currentUser.role === 'technician';
const qtyFmt = v => (v === null || v === undefined ? '--' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const SALE_TYPE_LABELS = { retail: 'Retail', wholesale: 'Wholesale', internal: 'Internal (shop use)' };
const SO_STATUS_LABELS = { requested: 'Requested', ordered: 'Ordered', received: 'Received', notified: 'Customer notified', done: 'Done', cancelled: 'Cancelled' };
const MOVE_LABELS = { receive: 'Received', ro: 'Used on RO', ticket: 'Counter sale', adjust: 'Adjusted' };

async function loadParts() {
  partsList = await fetch(`${API}/parts?active=0`).then(svcJson);
  partsLoaded = true;
  return partsList;
}

// ---------- Find in stock (used on ROs, tickets, special orders) ----------

function createPartPicker({ onPick, placeholder = 'Find in stock: part # or description...' }) {
  const wrap = document.createElement('div');
  wrap.className = 'search-picker part-picker';
  wrap.innerHTML = html`<input type="text" class="search-picker-input" autocomplete="off" spellcheck="false" placeholder="${placeholder}" />
    <div class="search-picker-results" role="listbox" hidden></div>`;
  const input = wrap.querySelector('input');
  const results = wrap.querySelector('.search-picker-results');
  let shown = [];
  let active = 0;
  function render() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = partsList.filter(p => !p.inactive).filter(p => {
      const hay = `${p.number} ${p.description || ''} ${p.brand || ''} ${p.bin || ''}`.toLowerCase();
      return words.every(w => hay.includes(w));
    }).slice(0, 10);
    active = 0;
    results.innerHTML = shown.length ? shown.map((p, i) => html`<div class="picker-result ${i === 0 ? 'active' : ''}" data-i="${i}">
        <div class="picker-main">${p.number} · ${p.description || ''}</div>
        <div class="picker-sub">${[`${qtyFmt(p.available)} available`, p.bin ? `bin ${p.bin}` : '', svcMoney(p.price)].filter(Boolean).join(' · ')}</div></div>`).join('')
      : html`<div class="picker-empty">${partsLoaded ? `No parts match "${input.value}"` : 'Loading parts...'}</div>`;
    results.hidden = false;
  }
  function choose(p) { results.hidden = true; input.value = ''; if (p) onPick(p); }
  input.addEventListener('focus', () => { if (!partsLoaded) loadParts().then(render).catch(() => {}); render(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const rows = results.querySelectorAll('.picker-result');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
    else if (e.key === 'Escape') { results.hidden = true; }
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  results.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.picker-result');
    if (!row) return;
    e.preventDefault();
    choose(shown[Number(row.dataset.i)]);
  });
  return wrap;
}

// On an RO: a find-in-stock box per job, and a special order link.
function attachRoPartPickers() {
  if (!userCan('viewParts')) return;
  if (!partsLoaded) loadParts().catch(() => {});
  document.querySelectorAll('#roDetailView [data-part-find]').forEach(slot => {
    const i = Number(slot.dataset.partFind);
    slot.appendChild(createPartPicker({
      onPick: (p) => {
        currentRO.jobs[i].parts.push({ partId: p.id, number: p.number, description: p.description || '', qty: 1, cost: p.cost ?? 0, price: p.price });
        renderRoDetail();
        markRoDirty();
      }
    }));
  });
}

// ---------- The shelf ----------

function openPartsView() {
  document.getElementById('newPartBtn').hidden = !canWriteParts();
  document.querySelectorAll('.parts-cost-col').forEach(el => { el.hidden = hidesCost(); });
  loadParts().then(renderPartsList).catch(err => {
    document.getElementById('partsTableBody').innerHTML = html`<tr><td colspan="9" class="send-text-status-error">${err.message}</td></tr>`;
  });
}

function renderPartsList() {
  const filter = document.getElementById('partsFilter').value;
  const words = document.getElementById('partsSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const active = partsList.filter(p => !p.inactive);
  const list = partsList
    .filter(p => (filter === 'inactive' ? p.inactive : !p.inactive))
    .filter(p => filter !== 'low' || p.low)
    .filter(p => words.every(w => `${p.number} ${p.description || ''} ${p.bin || ''} ${p.brand || ''} ${p.vendor || ''}`.toLowerCase().includes(w)))
    .sort((a, b) => a.number.localeCompare(b.number));
  const value = active.reduce((s, p) => s + Math.max(0, Number(p.onHand) || 0) * (Number(p.cost) || 0), 0);
  document.getElementById('partsSummary').innerHTML = html`
    <span><strong>${active.length}</strong> parts stocked</span>
    ${hidesCost() ? '' : html`<span><strong>${svcMoney(value)}</strong> on the shelf at cost</span>`}
    <span class="${active.some(p => p.low) ? 'ro-late' : ''}"><strong>${active.filter(p => p.low).length}</strong> low stock</span>
    <span><strong>${active.filter(p => p.committed > 0).length}</strong> on open ROs / tickets</span>`;
  document.getElementById('partsEmpty').hidden = list.length > 0;
  document.getElementById('partsTableBody').innerHTML = list.map(p => html`<tr class="ro-row" data-part-id="${p.id}">
    <td><strong>${p.number}</strong>${p.source && p.source !== 'oem' ? html` <span class="cp-chip">${p.source === 'used' ? 'Used' : 'Aftermarket'}</span>` : ''}</td>
    <td>${p.description || ''}${p.brand ? html`<div class="inventory-trim">${p.brand}</div>` : ''}</td>
    <td>${p.bin || '--'}</td>
    <td>${qtyFmt(p.onHand)}</td>
    <td>${p.committed ? qtyFmt(p.committed) : '--'}</td>
    <td class="${p.low ? 'ro-late' : ''}"><strong>${qtyFmt(p.available)}</strong></td>
    ${hidesCost() ? '' : html`<td>${svcMoney(p.cost)}</td>`}
    <td>${svcMoney(p.price)}</td>
    <td>${p.reorderPoint ? qtyFmt(p.reorderPoint) : '--'}</td></tr>`).join('');
}

document.getElementById('partsSearch').addEventListener('input', renderPartsList);
document.getElementById('partsFilter').addEventListener('change', renderPartsList);
document.getElementById('partsTableBody').addEventListener('click', (e) => {
  const row = e.target.closest('[data-part-id]');
  if (row) openPartModal(row.dataset.partId);
});
document.getElementById('newPartBtn').addEventListener('click', () => openPartModal(null));

async function openPartModal(id) {
  editingPart = null;
  const write = canWriteParts();
  const set = (elId, v) => { document.getElementById(elId).value = v ?? ''; };
  document.getElementById('pmMsg').textContent = '';
  document.getElementById('partModalTitle').textContent = id ? 'Part' : 'New Part';
  document.getElementById('pmOnHandLabel').hidden = !!id;
  document.getElementById('pmCostLabel').hidden = hidesCost();
  document.getElementById('pmCost').disabled = !!id; // cost changes by receiving
  document.getElementById('pmStock').hidden = !id;
  document.getElementById('pmSaveBtn').hidden = !write;
  document.querySelectorAll('#partForm input, #partForm select').forEach(el => { el.disabled = !write || (el.id === 'pmCost' && !!id); });
  if (!id) {
    ['pmNumber', 'pmDescription', 'pmBrand', 'pmBin', 'pmVendor', 'pmCost', 'pmPrice', 'pmOnHand', 'pmReorderPoint', 'pmReorderQty', 'pmNotes'].forEach(f => set(f, ''));
    set('pmSource', 'oem');
    document.getElementById('pmInactive').checked = false;
  } else {
    try {
      editingPart = await fetch(`${API}/parts/${id}`).then(svcJson);
    } catch (err) { alert(err.message); return; }
    const p = editingPart;
    set('pmNumber', p.number); set('pmDescription', p.description); set('pmBrand', p.brand); set('pmBin', p.bin); set('pmVendor', p.vendor);
    set('pmCost', p.cost); set('pmPrice', p.price); set('pmReorderPoint', p.reorderPoint || ''); set('pmReorderQty', p.reorderQty || ''); set('pmNotes', p.notes);
    set('pmSource', p.source || 'oem');
    document.getElementById('pmInactive').checked = !!p.inactive;
    renderPartStock();
  }
  document.getElementById('pmActions').hidden = !write;
  document.getElementById('partModal').classList.add('active');
}

function renderPartStock() {
  const p = editingPart;
  document.getElementById('pmStockLine').innerHTML = html`
    <span><strong>${qtyFmt(p.onHand)}</strong> on hand</span><span><strong>${qtyFmt(p.committed)}</strong> on open ROs / tickets</span>
    <span class="${p.low ? 'ro-late' : ''}"><strong>${qtyFmt(p.available)}</strong> available</span>
    ${hidesCost() ? '' : html`<span>Avg cost <strong>${svcMoney(p.cost)}</strong>${p.lastCost !== undefined ? ` · last ${svcMoney(p.lastCost)}` : ''}</span>`}`;
  document.getElementById('pmMoves').innerHTML = (p.moves || []).length ? html`<table class="data-table pm-moves"><thead><tr><th>When</th><th>What</th><th>Qty</th><th>On hand after</th><th>Ref</th><th>By</th></tr></thead><tbody>
    ${p.moves.map(m => html`<tr><td>${shortWhen(m.at)}</td><td>${MOVE_LABELS[m.type] || m.type}${m.note ? html`<div class="inventory-trim">${m.note}</div>` : ''}</td>
      <td class="${m.qty < 0 ? 'ro-late' : ''}">${m.qty > 0 ? '+' : ''}${qtyFmt(m.qty)}</td><td>${qtyFmt(m.onHandAfter)}</td><td>${m.ref || ''}</td><td>${m.by ? m.by.name : ''}</td></tr>`)}</tbody></table>`
    : html`<p class="audit-note">No stock movement yet.</p>`;
}

document.getElementById('pmCancelBtn').addEventListener('click', () => document.getElementById('partModal').classList.remove('active'));
document.getElementById('partForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = id => document.getElementById(id).value;
  const body = {
    number: v('pmNumber'), description: v('pmDescription'), brand: v('pmBrand'), bin: v('pmBin'), vendor: v('pmVendor'),
    price: v('pmPrice'), reorderPoint: v('pmReorderPoint'), reorderQty: v('pmReorderQty'), notes: v('pmNotes'), source: v('pmSource'),
    inactive: document.getElementById('pmInactive').checked
  };
  if (!editingPart) { body.cost = v('pmCost'); body.onHand = v('pmOnHand'); }
  try {
    await fetch(editingPart ? `${API}/parts/${editingPart.id}` : `${API}/parts`, {
      method: editingPart ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(svcJson);
    document.getElementById('partModal').classList.remove('active');
    await loadParts();
    if (currentView === 'parts') renderPartsList();
  } catch (err) { document.getElementById('pmMsg').textContent = err.message; }
});

async function partStockAction(path, body) {
  try {
    await fetch(`${API}/parts/${editingPart.id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(svcJson);
    editingPart = await fetch(`${API}/parts/${editingPart.id}`).then(svcJson);
    renderPartStock();
    await loadParts();
    if (currentView === 'parts') renderPartsList();
    return true;
  } catch (err) { document.getElementById('pmMsg').textContent = err.message; return false; }
}
document.getElementById('pmRecvBtn').addEventListener('click', async () => {
  const ok = await partStockAction('receive', { qty: document.getElementById('pmRecvQty').value, cost: document.getElementById('pmRecvCost').value, invoice: document.getElementById('pmRecvInvoice').value });
  if (ok) ['pmRecvQty', 'pmRecvCost', 'pmRecvInvoice'].forEach(id => { document.getElementById(id).value = ''; });
});
document.getElementById('pmAdjBtn').addEventListener('click', async () => {
  const count = document.getElementById('pmCount').value;
  if (count === '') { document.getElementById('pmMsg').textContent = 'Enter the actual count.'; return; }
  const ok = await partStockAction('adjust', { count, reason: document.getElementById('pmAdjReason').value });
  if (ok) ['pmCount', 'pmAdjReason'].forEach(id => { document.getElementById(id).value = ''; });
});

// ---------- Counter tickets ----------

function openTicketsView() {
  document.getElementById('newTicketBtn').hidden = !canWriteParts();
  if (!showTicketList()) return;
  loadTickets();
}

async function loadTickets() {
  const status = document.getElementById('ticketFilter').value;
  try {
    ticketsList = await fetch(`${API}/parts/tickets/list${status ? `?status=${status}` : ''}`).then(svcJson);
  } catch (err) { document.getElementById('ticketTableBody').innerHTML = html`<tr><td colspan="7" class="send-text-status-error">${err.message}</td></tr>`; return; }
  document.getElementById('ticketEmpty').hidden = ticketsList.length > 0;
  document.getElementById('ticketTableBody').innerHTML = ticketsList.map(t => html`<tr class="ro-row" data-ticket-id="${t.id}">
    <td><button type="button" class="deal-number-link">P-${t.ticketNumber}</button></td>
    <td>${new Date(t.openedAt).toLocaleDateString()}</td><td>${t.customerName}</td><td>${SALE_TYPE_LABELS[t.saleType] || t.saleType}</td>
    <td>${(t.lines || []).length}</td><td>${svcMoney(t.totals.total)}</td><td>${roStatusBadge(t.status)}</td></tr>`).join('');
}
document.getElementById('ticketFilter').addEventListener('change', loadTickets);
document.getElementById('ticketTableBody').addEventListener('click', (e) => {
  const row = e.target.closest('[data-ticket-id]');
  if (row) showTicket(ticketsList.find(t => t.id === row.dataset.ticketId));
});
document.getElementById('newTicketBtn').addEventListener('click', () => {
  if (!partsLoaded) loadParts().catch(() => {});
  showTicket({ id: null, status: 'open', leadId: null, customerName: '', saleType: 'retail', notes: '', lines: [] });
});

function showTicketList() {
  if (ticketDirty && !confirm('Leave this ticket without saving your changes?')) return false;
  ticketDirty = false;
  currentTicket = null;
  document.getElementById('ticketListView').hidden = false;
  document.getElementById('ticketDetailView').hidden = true;
  return true;
}

function showTicket(t) {
  currentTicket = JSON.parse(JSON.stringify(t));
  ticketDirty = false;
  document.getElementById('ticketListView').hidden = true;
  document.getElementById('ticketDetailView').hidden = false;
  renderTicket();
}

function ticketPreview(t) {
  const sale = t.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const cfg = serviceCfg || { taxParts: true, taxRate: appSettings.taxRate || 0 };
  const tax = t.saleType === 'retail' && cfg.taxParts !== false ? Math.round(sale * (Number(cfg.taxRate ?? appSettings.taxRate) || 0)) / 100 : 0;
  return { sale, tax, total: sale + tax };
}

function renderTicket() {
  const t = currentTicket;
  const edit = t.status === 'open' && canWriteParts();
  const dis = edit ? '' : html`disabled`;
  const tot = t.id && !ticketDirty && t.totals ? t.totals : ticketPreview(t);
  document.getElementById('ticketDetailView').innerHTML = html`
    <div class="appraisal-topbar ro-topbar">
      <button type="button" class="btn-secondary" data-tk="back">&larr; Tickets</button>
      <h2>${t.id ? `P-${t.ticketNumber}` : 'New Counter Ticket'}</h2>
      ${t.id ? roStatusBadge(t.status) : ''}
      <span class="appraisal-dirty">${ticketDirty ? 'Unsaved changes' : ''}</span>
      <span class="ro-top-actions">
        ${t.id && edit ? html`<button type="button" class="btn-secondary" data-tk="void">Void</button><button type="button" class="btn-secondary" data-tk="close">Close ticket</button>` : ''}
        ${edit ? html`<button type="button" class="btn-primary" data-tk="save">${t.id ? 'Save' : 'Open ticket'}</button>` : ''}
      </span>
    </div>
    <div class="ro-layout">
      <div class="ro-main">
        <div class="ro-card">
          <div class="ro-card-title">Customer</div>
          <div class="ro-grid ro-grid-2">
            <label>Customer on file <div id="tkCustomerPicker"></div></label>
            <label>Or name (walk-in / shop) <input type="text" data-tk-field="customerName" value="${t.leadId ? '' : t.customerName}" ${t.leadId || !edit ? html`disabled` : ''} /></label>
            <label>Sale type <select data-tk-field="saleType" ${dis}>${Object.entries(SALE_TYPE_LABELS).map(([k, l]) => html`<option value="${k}" ${t.saleType === k ? html`selected` : ''}>${l}</option>`)}</select></label>
            <label>Notes <input type="text" data-tk-field="notes" value="${t.notes || ''}" ${dis} /></label>
          </div>
        </div>
        <div class="ro-card">
          <div class="ro-card-title">Parts</div>
          ${edit ? html`<div class="tk-find" id="tkFind"></div>` : ''}
          ${t.lines.length ? html`<table class="ro-parts-table"><thead><tr><th>Part #</th><th>Description</th><th>Qty</th><th>Cost</th><th>Price</th><th>Total</th><th></th></tr></thead><tbody>
            ${t.lines.map((l, k) => html`<tr data-line="${k}">
              <td><input type="text" data-line-field="number" value="${l.number || ''}" ${l.partId || !edit ? html`disabled` : ''} /></td>
              <td class="ro-part-desc"><input type="text" data-line-field="description" value="${l.description || ''}" ${dis} /></td>
              <td><input type="number" min="0" step="1" data-line-field="qty" value="${l.qty ?? 1}" ${dis} /></td>
              <td><input type="number" min="0" step="0.01" data-line-field="cost" value="${l.cost ?? ''}" ${l.partId || !edit ? html`disabled` : ''} /></td>
              <td><input type="number" min="0" step="0.01" data-line-field="price" value="${l.price ?? ''}" ${dis} /></td>
              <td class="ro-num">${svcMoney((Number(l.qty) || 0) * (Number(l.price) || 0))}</td>
              <td>${edit ? html`<button type="button" class="recon-remove" data-remove-line aria-label="Remove">✕</button>` : ''}</td></tr>`)}</tbody></table>`
            : html`<p class="audit-note">No parts yet. Find them in stock above${edit ? ', or add a line by hand' : ''}.</p>`}
          ${edit ? html`<button type="button" class="btn-secondary btn-small" data-tk="add-line">+ Line by hand</button>` : ''}
        </div>
      </div>
      <aside class="ro-side"><div class="ro-card" id="tkTotals">
        <div class="ro-card-title">Totals</div>
        <div class="ro-tline"><span>Parts</span><strong>${svcMoney(tot.sale)}</strong></div>
        <div class="ro-tline"><span>Tax</span><strong>${svcMoney(tot.tax)}</strong></div>
        <div class="ro-tline ro-tline-total"><span>Total</span><strong>${svcMoney(tot.total)}</strong></div>
        ${t.totals && !ticketDirty && t.totals.gross !== undefined ? html`<div class="ro-tline"><span>Gross</span><strong>${svcMoney(t.totals.gross)}</strong></div>` : ''}
      </div></aside>
    </div>`;
  const picker = createSearchPicker({
    kind: 'lead', getIds: () => leads.map(l => l.id),
    onPick: (id) => {
      const l = leads.find(x => x.id === id);
      currentTicket.leadId = id || null;
      currentTicket.customerName = l ? l.name : '';
      ticketDirty = true;
      renderTicket();
    }
  });
  document.getElementById('tkCustomerPicker').appendChild(picker.element);
  const l = leads.find(x => x.id === t.leadId);
  if (l) picker.setLabel(leadPickLabel(l));
  picker.setDisabled(!edit);
  if (edit) {
    document.getElementById('tkFind').appendChild(createPartPicker({
      onPick: (p) => {
        currentTicket.lines.push({ partId: p.id, number: p.number, description: p.description || '', qty: 1, cost: p.cost ?? 0, price: p.price });
        ticketDirty = true;
        renderTicket();
      }
    }));
  }
}

const tkView = document.getElementById('ticketDetailView');
tkView.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.tkField) { currentTicket[t.dataset.tkField] = t.value; ticketDirty = true; if (t.dataset.tkField === 'saleType') renderTicket(); return; }
  if (t.dataset.lineField) {
    const line = currentTicket.lines[Number(t.closest('[data-line]').dataset.line)];
    line[t.dataset.lineField] = t.value;
    ticketDirty = true;
    t.closest('tr').querySelector('.ro-num').textContent = svcMoney((Number(line.qty) || 0) * (Number(line.price) || 0));
    const tot = ticketPreview(currentTicket);
    document.getElementById('tkTotals').innerHTML = html`<div class="ro-card-title">Totals</div>
      <div class="ro-tline"><span>Parts</span><strong>${svcMoney(tot.sale)}</strong></div>
      <div class="ro-tline"><span>Tax</span><strong>${svcMoney(tot.tax)}</strong></div>
      <div class="ro-tline ro-tline-total"><span>Total</span><strong>${svcMoney(tot.total)}</strong></div><p class="audit-note">Save to update.</p>`;
  }
});
tkView.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tk]');
  if (e.target.closest('[data-remove-line]')) {
    currentTicket.lines.splice(Number(e.target.closest('[data-line]').dataset.line), 1);
    ticketDirty = true; renderTicket(); return;
  }
  if (!b) return;
  const t = currentTicket;
  const call = async (url, method, body) => {
    try {
      const saved = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(svcJson);
      ticketDirty = false;
      showTicket(saved);
      loadParts().catch(() => {});
      return saved;
    } catch (err) { alert(err.message); return null; }
  };
  const payload = () => ({ leadId: t.leadId, customerName: t.customerName, saleType: t.saleType, notes: t.notes, lines: t.lines });
  if (b.dataset.tk === 'back') { if (showTicketList()) loadTickets(); }
  else if (b.dataset.tk === 'add-line') { t.lines.push({ partId: null, number: '', description: '', qty: 1, cost: '', price: '' }); ticketDirty = true; renderTicket(); }
  else if (b.dataset.tk === 'save') await call(t.id ? `${API}/parts/tickets/${t.id}` : `${API}/parts/tickets`, t.id ? 'PUT' : 'POST', payload());
  else if (b.dataset.tk === 'close') {
    if (ticketDirty && !await call(`${API}/parts/tickets/${t.id}`, 'PUT', payload())) return;
    if (!confirm(`Close P-${currentTicket.ticketNumber} for ${svcMoney(currentTicket.totals.total)}? The parts come off the shelf.`)) return;
    await call(`${API}/parts/tickets/${t.id}/close`, 'POST');
  } else if (b.dataset.tk === 'void') {
    const reason = prompt(`Void P-${t.ticketNumber}? Why?`);
    if (reason !== null) { ticketDirty = false; await call(`${API}/parts/tickets/${t.id}/void`, 'POST', { reason }); }
  }
});

// ---------- Special orders & reorder ----------

function openOrdersView() {
  document.getElementById('newSoBtn').hidden = !(canWriteParts() || userCan('writeRepairOrders'));
  document.getElementById('reorderSection').hidden = !canWriteParts();
  loadOrders();
}

async function loadOrders() {
  const open = document.getElementById('soFilter').value === 'open';
  try {
    soList = await fetch(`${API}/parts/special-orders/list${open ? '?open=1' : ''}`).then(svcJson);
  } catch (err) { document.getElementById('soTableBody').innerHTML = html`<tr><td colspan="7" class="send-text-status-error">${err.message}</td></tr>`; return; }
  const write = canWriteParts();
  document.getElementById('soEmpty').hidden = soList.length > 0;
  document.getElementById('soTableBody').innerHTML = soList.map(o => html`<tr data-so="${o.id}">
    <td>${new Date(o.requestedAt).toLocaleDateString()}<div class="inventory-trim">${o.requestedBy ? o.requestedBy.name : ''}</div></td>
    <td><strong>${o.number || '--'}</strong><div class="inventory-trim">${o.description || ''}</div></td>
    <td>${qtyFmt(o.qty)}</td>
    <td>${o.customerName || '--'}${o.roNumber ? html`<div><button type="button" class="link-btn" data-so-ro="${o.roId}">RO-${o.roNumber}</button></div>` : ''}</td>
    <td>${o.vendor || '--'}${o.poNumber ? html`<div class="inventory-trim">${o.poNumber}</div>` : ''}</td>
    <td><span class="so-status so-${o.status}">${SO_STATUS_LABELS[o.status]}</span></td>
    <td class="so-actions">${write ? html`
      ${o.status === 'requested' ? html`<button type="button" class="btn-secondary btn-small" data-so-act="ordered">Ordered</button>` : ''}
      ${['requested', 'ordered'].includes(o.status) ? html`<button type="button" class="btn-primary btn-small" data-so-act="receive">Receive</button>` : ''}
      ${o.status === 'received' && o.leadId ? html`<button type="button" class="btn-secondary btn-small" data-so-act="notified">Customer notified</button>` : ''}
      ${['received', 'notified'].includes(o.status) ? html`<button type="button" class="btn-secondary btn-small" data-so-act="done">Done</button>` : ''}
      ${['requested', 'ordered'].includes(o.status) ? html`<button type="button" class="btn-secondary btn-small" data-so-act="cancelled">Cancel</button>` : ''}` : ''}</td></tr>`).join('');
  if (write) loadReorder();
}

async function loadReorder() {
  let list = [];
  try { list = await fetch(`${API}/parts/reorder`).then(svcJson); } catch { return; }
  document.getElementById('reorderEmpty').hidden = list.length > 0;
  document.getElementById('reorderTableBody').innerHTML = list.map(p => html`<tr>
    <td><strong>${p.number}</strong></td><td>${p.description || ''}</td><td>${p.vendor || '--'}</td>
    <td class="ro-late">${qtyFmt(p.available)}</td><td>${qtyFmt(p.reorderPoint)}</td><td><strong>${qtyFmt(p.suggestedQty)}</strong></td>
    <td><button type="button" class="btn-secondary btn-small" data-reorder-part="${p.id}">Receive…</button></td></tr>`).join('');
}

document.getElementById('soFilter').addEventListener('change', loadOrders);
document.getElementById('reorderTableBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reorder-part]');
  if (b) openPartModal(b.dataset.reorderPart);
});
document.getElementById('soTableBody').addEventListener('click', async (e) => {
  const ro = e.target.closest('[data-so-ro]');
  if (ro) { openRoById(ro.dataset.soRo); return; }
  const b = e.target.closest('[data-so-act]');
  if (!b) return;
  const id = b.closest('[data-so]').dataset.so;
  const o = soList.find(x => x.id === id);
  try {
    if (b.dataset.soAct === 'receive') {
      const cost = prompt(`Receive ${o.qty} × ${o.number || o.description}. Cost each:`, o.cost ?? '');
      if (cost === null) return;
      await fetch(`${API}/parts/special-orders/${id}/receive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cost }) }).then(svcJson);
      loadParts().catch(() => {});
    } else if (b.dataset.soAct === 'ordered') {
      const vendor = prompt('Ordered from (vendor):', o.vendor || '');
      if (vendor === null) return;
      const poNumber = prompt('PO number (optional):', '') || '';
      await fetch(`${API}/parts/special-orders/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ordered', vendor, poNumber }) }).then(svcJson);
    } else {
      await fetch(`${API}/parts/special-orders/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.soAct }) }).then(svcJson);
    }
    loadOrders();
  } catch (err) { alert(err.message); }
});

// The special order form. context: { roId, roNumber, leadId } when it comes from an RO.
window.openSpecialOrderModal = function(context = {}) {
  soContext = { partId: null, leadId: context.leadId || null, roId: context.roId || null };
  ['soNumber', 'soDescription', 'soCost', 'soPrice', 'soDeposit', 'soNotes'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('soQty').value = 1;
  document.getElementById('soMsg').textContent = '';
  document.getElementById('soRoNote').textContent = context.roNumber ? `For RO-${context.roNumber}` : '';
  document.querySelector('#soModal .so-money').hidden = hidesCost();
  const partHolder = document.getElementById('soPartPicker');
  partHolder.innerHTML = '';
  if (!partsLoaded) loadParts().catch(() => {});
  partHolder.appendChild(createPartPicker({
    onPick: (p) => {
      soContext.partId = p.id;
      document.getElementById('soNumber').value = p.number;
      document.getElementById('soDescription').value = p.description || '';
      document.getElementById('soCost').value = p.cost ?? '';
      document.getElementById('soPrice').value = p.price ?? '';
    }
  }));
  const custHolder = document.getElementById('soCustomerPicker');
  custHolder.innerHTML = '';
  const picker = createSearchPicker({
    kind: 'lead', getIds: () => leads.map(l => l.id),
    onPick: (id) => { soContext.leadId = id || null; const l = leads.find(x => x.id === id); picker.setLabel(l ? leadPickLabel(l) : ''); }
  });
  custHolder.appendChild(picker.element);
  const l = leads.find(x => x.id === soContext.leadId);
  if (l) picker.setLabel(leadPickLabel(l));
  document.getElementById('soModal').classList.add('active');
};
document.getElementById('newSoBtn').addEventListener('click', () => openSpecialOrderModal({}));
document.getElementById('soCancelBtn').addEventListener('click', () => document.getElementById('soModal').classList.remove('active'));
document.getElementById('soNumber').addEventListener('input', () => { soContext.partId = null; });
document.getElementById('soForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = id => document.getElementById(id).value;
  const body = { partId: soContext.partId, number: v('soNumber'), description: v('soDescription'), qty: v('soQty'), leadId: soContext.leadId, roId: soContext.roId, notes: v('soNotes') };
  if (!hidesCost()) Object.assign(body, { cost: v('soCost'), price: v('soPrice'), deposit: v('soDeposit') });
  try {
    await fetch(`${API}/parts/special-orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(svcJson);
    document.getElementById('soModal').classList.remove('active');
    if (currentView === 'partsorders') loadOrders();
  } catch (err) { document.getElementById('soMsg').textContent = err.message; }
});
