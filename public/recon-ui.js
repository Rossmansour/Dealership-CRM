// recon-ui.js
// The Recon app (its own tab): a board of used cars moving through the
// store's recon steps toward the front line, with time in each step against
// its goal; one car's panel (steps, work items, approvals, service RO,
// notes); the approval queue; cars not started; cars that made it; and
// performance (days to the front line, where time goes, spend).

const API = '/api';

// ---------- Small helpers (the main app's aren't loaded here) ----------
class SafeHtml { constructor(v) { this.value = v; } toString() { return this.value; } }
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toHtml = v => (v instanceof SafeHtml ? v.value : Array.isArray(v) ? v.map(toHtml).join('') : esc(v));
function html(strings, ...values) { let out = strings[0]; values.forEach((v, i) => { out += toHtml(v) + strings[i + 1]; }); return new SafeHtml(out); }
const money = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : `$${Math.round(Number(v)).toLocaleString()}`);
const hoursText = h => (h === null || h === undefined ? '--' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h / 24 * 10) / 10}d`);
const daysText = h => `${(Math.round(h / 24 * 10) / 10).toFixed(1)}d`;
const vehicle = u => (u.car ? `${u.car.year} ${u.car.make} ${u.car.model}` : u.vehicleLabel || 'Car');
const CATEGORY_LABELS = { mechanical: 'Mechanical', tires: 'Tires', body: 'Body & paint', glass: 'Glass', detail: 'Detail', other: 'Other' };
const ITEM_LABELS = { proposed: 'Needs approval', approved: 'Approved', declined: 'Declined', done: 'Done' };

async function api(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Please sign in.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

let board = null;      // { settings, can, units, notStarted }
let me = null;
let tab = 'cars';
let carType = 'all';   // all | new | used -- splits every list and number
let stepFilter = 'all';
let openUnitId = null;
const READY = 'ready';
const WHOLESALE = 'wholesale';
try { carType = localStorage.getItem('reconType') || 'all'; } catch { /* private window */ }

// ---------- Loading ----------
async function refresh() {
  board = await api('/recon/board');
  document.getElementById('rcSetupBtn').hidden = !board.can.approve;
  render();
}

const typeOk = u => carType === 'all' || ((u.car && u.car.stockType) || u.stockType || 'used') === carType;

function matches(u) {
  if (!typeOk(u)) return false;
  const words = document.getElementById('rcSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const c = u.car || {};
  const hay = `${c.stockNumber || u.stockNumber || ''} ${c.vin || ''} ${c.year || ''} ${c.make || ''} ${c.model || ''} ${c.trim || ''} ${u.vehicleLabel || ''}`.toLowerCase();
  return words.every(w => hay.includes(w));
}

// Green under 75% of the goal, amber up to it, red past it.
function paceClass(hours, goal) {
  if (!goal) return 'rc-ok';
  const r = hours / goal;
  return r > 1 ? 'rc-late' : r > 0.75 ? 'rc-warn' : 'rc-ok';
}

function render() {
  const active = board.units.filter(u => u.status === 'active' && typeOk(u));
  const pending = active.flatMap(u => u.items.filter(i => i.status === 'proposed'));
  const waiting = board.notStarted.filter(c => carType === 'all' || c.stockType === carType);
  document.getElementById('rcApprovalCount').textContent = pending.length;
  document.getElementById('rcWaitingCount').textContent = waiting.length;
  document.querySelectorAll('.rc-type').forEach(t => t.classList.toggle('active', t.dataset.type === carType));
  const goalH = board.settings.goalDays * 24;
  const avg = active.length ? active.reduce((s, u) => s + u.totalHours, 0) / active.length : 0;
  const since = Date.now() - 30 * 86400000;
  const finished = board.units.filter(u => u.status === 'done' && typeOk(u) && new Date(u.doneAt).getTime() >= since);
  const adr = finished.length ? finished.reduce((s, u) => s + u.totalHours, 0) / finished.length : null;
  const typeWord = carType === 'all' ? '' : carType === 'new' ? 'new ' : 'used ';
  document.getElementById('rcStrip').innerHTML = html`
    <div class="rc-stat"><strong>${active.length}</strong><span>${typeWord}cars in recon</span></div>
    <div class="rc-stat ${active.some(u => u.late) ? 'rc-stat-bad' : ''}"><strong>${active.filter(u => u.late).length}</strong><span>past the ${board.settings.goalDays}-day goal</span></div>
    <div class="rc-stat"><strong>${active.length ? daysText(avg) : '--'}</strong><span>average days in recon now</span></div>
    <div class="rc-stat"><strong class="${adr === null ? '' : paceClass(adr, goalH)}">${adr === null ? '--' : daysText(adr)}</strong><span>ADR · days to frontline, last 30 days</span></div>
    <div class="rc-stat ${pending.length ? 'rc-stat-warn' : ''}"><strong>${pending.length}</strong><span>to approve · ${money(pending.reduce((s, i) => s + i.estimate, 0))}</span></div>
    <div class="rc-stat"><strong>${waiting.length}</strong><span>${typeWord}cars not started</span></div>`;
  document.querySelectorAll('.rc-view').forEach(v => { v.hidden = v.dataset.rcView !== tab; });
  document.querySelectorAll('.rc-tab').forEach(t => t.classList.toggle('active', t.dataset.rcTab === tab));
  if (tab === 'cars') renderCars();
  if (tab === 'approvals') renderApprovals(active);
  if (tab === 'waiting') renderWaiting();
  if (tab === 'performance') renderPerformance();
  if (tab === 'car') renderCarPage();
  document.getElementById('rcStrip').hidden = tab === 'car';
  document.getElementById('rcTabs').classList.toggle('rc-tabs-car', tab === 'car');
}

// ---------- Steps (left) and cars (right) ----------
function unitsInStep(key) {
  if (key === 'all') return board.units.filter(u => matches(u)); // in recon, frontline ready, and wholesale
  if (key === READY) return board.units.filter(u => u.status === 'done' && matches(u));
  if (key === WHOLESALE) return board.units.filter(u => u.status === 'removed' && u.step === WHOLESALE && matches(u));
  return board.units.filter(u => u.status === 'active' && u.step === key && matches(u));
}

function renderCars() {
  const steps = board.settings.steps;
  const known = new Set(steps.map(s => s.key));
  const other = board.units.filter(u => u.status === 'active' && !known.has(u.step) && matches(u));
  const rows = [
    { key: 'all', n: 0, label: 'All' },
    ...steps.map((st, i) => ({ key: st.key, n: i + 1, label: st.label, goal: st.goalHours })),
    ...(other.length ? [{ key: '__other', n: '–', label: 'Other steps' }] : []),
    { key: READY, n: '✓', label: 'Frontline Ready', exit: true },
    { key: WHOLESALE, n: '⇥', label: 'Wholesale', exit: true }
  ];
  document.getElementById('rcSteps').innerHTML = html`
    <div class="rc-steps-head"><span>Step</span><span title="Cars">Cars</span><span title="Past the step's goal">Late</span></div>
    ${rows.map(r => {
      const list = r.key === '__other' ? other : unitsInStep(r.key);
      const late = r.exit ? 0 : list.filter(u => u.stepLate).length;
      return html`<button type="button" class="rc-step ${stepFilter === r.key ? 'active' : ''} ${list.length ? '' : 'rc-step-empty'} ${r.exit ? 'rc-step-exit' : ''}" data-step="${r.key}" data-drop-step="${r.key === 'all' || r.key === '__other' ? '' : r.key}">
        <span class="rc-step-label"><em>${r.n}.</em> ${r.label}</span>
        <span class="rc-step-num">${list.length || ''}</span>
        <span class="rc-step-late">${late || ''}</span></button>`;
    })}`;
  // Cars still in recon first (longest in their step on top), then finished ones, newest first.
  const rank = u => (u.status === 'active' ? 0 : u.status === 'done' ? 1 : 2);
  const list = (stepFilter === '__other' ? other : unitsInStep(stepFilter)).sort((a, b) => rank(a) - rank(b) ||
    (a.status === 'active' ? b.hoursInStep - a.hoursInStep : new Date(b.doneAt) - new Date(a.doneAt)));
  const title = (rows.find(r => r.key === stepFilter) || rows[0]).label;
  const goalH = board.settings.goalDays * 24;
  document.getElementById('rcList').innerHTML = html`
    <div class="rc-list-head"><h2>${title}</h2><span class="rc-muted">${list.length} car${list.length === 1 ? '' : 's'} · drag a car onto a step on the left to move it</span></div>
    ${list.length ? html`<table class="data-table rc-table rc-units"><thead><tr>
      <th></th><th>Step</th><th></th><th>Stock #</th><th>Vehicle</th><th title="Time in this step">In step</th><th title="Time in recon">In recon</th><th title="Days in stock">In stock</th><th>Work</th><th>Notes</th></tr></thead><tbody>
      ${list.map(u => {
        const notes = (u.notes || []).slice().reverse();
        const c = u.car || {};
        const stepN = board.settings.steps.findIndex(s2 => s2.key === u.step);
        const nxt = u.status === 'active' ? nextStepOf(u) : null;
        return html`<tr class="rc-row" draggable="${board.can.work && u.status === 'active' ? 'true' : 'false'}" data-unit="${u.id}">
          <td class="rc-move-cell">${board.can.work && u.status === 'active' ? html`<button type="button" class="rc-move-btn" data-row-move="${u.id}" title="${nxt ? `Move to ${nxt.label}` : 'Move to…'}" aria-label="Move">▾</button>` : ''}</td>
          <td><span class="rc-step-chip">${stepN >= 0 ? `${stepN + 1}. ` : ''}${u.stepLabel}</span></td>
          <td class="rc-thumb-cell">${(c.photos || [])[0] ? html`<img class="rc-thumb" src="${c.photos[0]}" alt="" />` : html`<span class="rc-thumb rc-thumb-empty">🚗</span>`}</td>
          <td><strong class="rc-stock-link">${c.stockNumber || u.stockNumber || ''}</strong><div><span class="rc-type-chip rc-type-${c.stockType}">${c.stockType === 'new' ? 'New' : 'Used'}</span></div></td>
          <td class="rc-veh"><strong>${vehicle(u)}</strong>${c.trim ? ` ${c.trim}` : ''}<div class="rc-muted">${c.vin || ''}</div><div class="rc-muted">${[c.color, c.mileage ? `${Number(c.mileage).toLocaleString()} mi` : ''].filter(Boolean).join(' · ')}</div>
            ${c.status === 'sold' ? html`<span class="rc-flag">Sold</span>` : ''}</td>
          <td>${u.status === 'active' ? html`<span class="rc-timer ${paceClass(u.hoursInStep, u.stepGoalHours)}">${hoursText(u.hoursInStep)}</span>` : html`<span class="rc-muted">${new Date(u.doneAt).toLocaleDateString()}</span>`}</td>
          <td><span class="rc-timer ${paceClass(u.totalHours, goalH)}">${daysText(u.totalHours)}</span></td>
          <td>${c.daysInStock ?? '--'}</td>
          <td class="rc-work">${u.needsApproval ? html`<span class="rc-flag rc-flag-warn">${u.needsApproval} to approve</span>` : ''}
            ${u.items.some(i => i.roId && !['done', 'declined'].includes(i.status)) ? html`<span class="rc-flag">In service</span>` : ''}
            <div class="rc-muted">Est ${money(u.estimate)} · Spent ${money(u.spent)}</div></td>
          <td class="rc-note-cell"><div class="rc-notes-log">${notes.length ? notes.slice(0, 4).map(nt => html`<div class="rc-log-entry"><span class="rc-muted">${nt.by} · ${fmtDate(nt.at)}</span><div>${nt.text}</div></div>`) : html`<span class="rc-muted">No notes</span>`}
            ${notes.length > 4 ? html`<div class="rc-muted">+ ${notes.length - 4} more (open the car)</div>` : ''}</div>
            ${board.can.work ? html`<button type="button" class="rc-note-plus" data-row-note="${u.id}" title="Add a note" aria-label="Add a note">+</button>` : ''}</td>
        </tr>`;
      })}</tbody></table>` : html`<p class="rc-empty-big">No cars here.</p>`}`;
}

const carsEl = document.querySelector('.rc-cars');
carsEl.addEventListener('click', async (e) => {
  const mv = e.target.closest('[data-row-move]');
  if (mv) { e.stopPropagation(); openMoveMenu(mv, board.units.find(x => x.id === mv.dataset.rowMove)); return; }
  const nb = e.target.closest('[data-row-note]');
  if (nb) {
    e.stopPropagation();
    const text = prompt('Add a note:');
    if (text && text.trim()) { try { await api(`/recon/units/${nb.dataset.rowNote}/notes`, 'POST', { text }); await refresh(); } catch (err) { alert(err.message); } }
    return;
  }
  const st = e.target.closest('[data-step]');
  if (st) { stepFilter = st.dataset.step; renderCars(); return; }
  const row = e.target.closest('[data-unit]');
  if (row) openUnit(row.dataset.unit);
});
carsEl.addEventListener('dragstart', (e) => {
  const r = e.target.closest('[data-unit]');
  if (!r) return;
  e.dataTransfer.setData('text/plain', r.dataset.unit);
  r.classList.add('rc-dragging');
});
carsEl.addEventListener('dragend', (e) => { const r = e.target.closest('[data-unit]'); if (r) r.classList.remove('rc-dragging'); });
carsEl.addEventListener('dragover', (e) => {
  const st = e.target.closest('[data-drop-step]');
  if (!st || !st.dataset.dropStep) return;
  e.preventDefault();
  document.querySelectorAll('.rc-step.rc-drop').forEach(x => x.classList.remove('rc-drop'));
  st.classList.add('rc-drop');
});
carsEl.addEventListener('dragleave', (e) => { const st = e.target.closest('[data-drop-step]'); if (st && !st.contains(e.relatedTarget)) st.classList.remove('rc-drop'); });
carsEl.addEventListener('drop', async (e) => {
  const st = e.target.closest('[data-drop-step]');
  if (!st || !st.dataset.dropStep) return;
  e.preventDefault();
  st.classList.remove('rc-drop');
  const u = board.units.find(x => x.id === e.dataTransfer.getData('text/plain'));
  if (u && u.step !== st.dataset.dropStep) await moveUnit(u, st.dataset.dropStep);
});

// The ▾ on a car: next step first, then any step, then the ways out.
function openMoveMenu(anchor, u) {
  document.querySelectorAll('.rc-move-menu').forEach(m => m.remove());
  const steps = board.settings.steps;
  const nxt = nextStepOf(u);
  const menu = document.createElement('div');
  menu.className = 'rc-move-menu';
  menu.innerHTML = html`${nxt ? html`<button type="button" data-to="${nxt.key}" class="rc-move-next">Next: ${steps.indexOf(nxt) + 1}. ${nxt.label} ▸</button>` : ''}
    <div class="rc-move-list">${steps.filter(s2 => s2.key !== u.step).map(s2 => html`<button type="button" data-to="${s2.key}">${steps.indexOf(s2) + 1}. ${s2.label}</button>`)}</div>
    <button type="button" data-to="ready" class="rc-move-ready">✓ Frontline Ready</button><button type="button" data-to="wholesale">Wholesale</button>`.toString();
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(window.innerHeight - 20 - Math.min(menu.offsetHeight, 420), r.bottom + 4) + window.scrollY}px`;
  menu.style.left = `${r.left + window.scrollX}px`;
  menu.addEventListener('click', (ev) => { const b = ev.target.closest('[data-to]'); if (b) { menu.remove(); moveUnit(u, b.dataset.to); } });
  setTimeout(() => document.addEventListener('click', function close(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } }), 0);
}

async function moveUnit(u, step) {
  if (step === READY) {
    const open = u.items.filter(i => i.status === 'proposed' || i.status === 'approved');
    if (open.length && !confirm(`${vehicle(u)} still has ${open.length} work item${open.length === 1 ? '' : 's'} not done. Send it to the front line anyway?`)) return;
  }
  if (step === WHOLESALE && !confirm(`Wholesale ${vehicle(u)}? It leaves recon (and isn't counted in days to frontline).`)) return;
  try { await api(`/recon/units/${u.id}/move`, 'POST', { step }); await refresh(); } catch (err) { alert(err.message); }
}

// ---------- One car (its own page) ----------
const PHASE_LABELS = { mechanical: 'Mechanical', detail: 'Detail', cosmetic: 'Cosmetic repair', other: 'Other' };
const STATUS_LABELS = { proposed: 'Needs approval', approved: 'Approved', declined: 'Declined', done: 'Done' };
let prevTab = 'cars';
let phaseFilter = '';
const selectedItems = new Set();

function openUnit(id) {
  openUnitId = id;
  if (tab !== 'car') prevTab = tab;
  tab = 'car';
  selectedItems.clear();
  phaseFilter = '';
  history.replaceState(null, '', `#unit=${id}`);
  render();
  window.scrollTo(0, 0);
}
function closeUnit() {
  openUnitId = null;
  tab = prevTab;
  history.replaceState(null, '', location.pathname);
  render();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tab === 'car' && !document.querySelector('.modal.active')) closeUnit();
});

const nextStepOf = u => {
  const steps = board.settings.steps;
  const i = steps.findIndex(s2 => s2.key === u.step);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
};
const fmtDate = iso => (iso ? new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '--');
const daysAgo = iso => (iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null);
const infoRow = (label, value) => html`<div class="rc-info-row"><span>${label}</span><strong>${value === '' || value === null || value === undefined ? '—' : value}</strong></div>`;

function renderCarPage() {
  const el = document.getElementById('rcCar');
  const u = board.units.find(x => x.id === openUnitId);
  if (!u) { el.innerHTML = html`<p class="rc-empty-big">This car isn't in recon anymore. <button type="button" class="link-btn" data-d="close">Back</button></p>`; return; }
  const c = u.car || {};
  const work = board.can.work;
  const approve = board.can.approve;
  const active = u.status === 'active';
  const steps = board.settings.steps;
  const next = nextStepOf(u);
  const goalH = board.settings.goalDays * 24;
  const photo = (c.photos || [])[0];
  const items = u.items.filter(i => !phaseFilter || i.category === phaseFilter);
  const toService = u.items.filter(i => i.status === 'approved' && i.category === 'mechanical' && !i.roId);
  const f = u.fields || {};
  el.innerHTML = html`
    <div class="rc-car-head">
      <button type="button" class="btn-secondary btn-small" data-d="close">&larr; Back</button>
      <span class="rc-car-step">${active ? u.stepLabel : u.status === 'done' ? 'Frontline Ready' : u.removedReason || 'Out of recon'}</span>
      <strong class="rc-car-title">${c.stockNumber || u.stockNumber || ''}</strong>
      <span class="rc-car-sub">${vehicle(u)}${c.trim ? ` ${c.trim}` : ''}${c.color ? `, ${c.color}` : ''}${c.mileage ? `, ${Number(c.mileage).toLocaleString()} mi` : ''}</span>
      <span class="rc-car-actions">
        ${work && active && next ? html`<button type="button" class="btn-primary btn-small" data-move="${next.key}">Next: ${next.label} ▸</button>` : ''}
        ${work && active ? html`<select data-d="step" aria-label="Move to step"><option value="">Move to…</option>${steps.filter(s2 => s2.key !== u.step).map((s2, i) => html`<option value="${s2.key}">${steps.indexOf(s2) + 1}. ${s2.label}</option>`)}
          <option value="ready">✓ Frontline Ready</option><option value="wholesale">Wholesale</option></select>` : ''}
        ${work && !active ? html`<button type="button" class="btn-secondary btn-small" data-d="reopen">Back into recon</button>` : ''}
        <button type="button" class="btn-secondary btn-small" data-d="print">Print</button>
        ${work && active ? html`<button type="button" class="btn-secondary btn-small" data-d="remove" title="Take out of recon">Remove</button>` : ''}
      </span>
    </div>

    <div class="rc-info">
      <div class="rc-info-photo">
        ${photo ? html`<img src="${photo}" alt="" />` : html`<div class="rc-noimg">🚗<span>No photo yet</span></div>`}
        ${(c.photos || []).length > 1 ? html`<span class="rc-muted">${c.photos.length} photos</span>` : ''}
      </div>
      <div class="rc-info-col">
        ${infoRow('Stock #', c.stockNumber)}${infoRow('VIN', c.vin)}${infoRow('Recon step', active ? u.stepLabel : u.status === 'done' ? 'Frontline Ready' : u.removedReason)}
        ${infoRow('Year', c.year)}${infoRow('Make', c.make)}${infoRow('Model', c.model)}${infoRow('Trim', c.trim)}${infoRow('Body', c.bodyStyle)}${infoRow('Exterior', c.color)}
      </div>
      <div class="rc-info-col">
        ${infoRow('Interior', c.interiorColor)}${infoRow('Odometer', c.mileage ? Number(c.mileage).toLocaleString() : '')}${infoRow('Price', money(c.price))}
        ${infoRow('Transmission', c.transmission)}${infoRow('Engine', c.engine)}${infoRow('Drivetrain', c.drivetrain)}
        <div class="rc-info-row"><span>In step</span><strong class="${active ? paceClass(u.hoursInStep, u.stepGoalHours) : ''}">${active ? hoursText(u.hoursInStep) : '—'}</strong></div>
        <div class="rc-info-row"><span>In recon</span><strong class="${paceClass(u.totalHours, goalH)}">${daysText(u.totalHours)}</strong></div>
        ${infoRow('In stock', c.daysInStock === null || c.daysInStock === undefined ? '' : `${c.daysInStock} days`)}
      </div>
      <div class="rc-info-col">
        ${infoRow('New / used', c.stockType === 'new' ? 'New' : 'Used')}
        ${infoRow('Acquired', c.dateAdded ? `${new Date(c.dateAdded).toLocaleDateString()}, ${daysAgo(c.dateAdded)} days ago` : '')}
        ${infoRow('Started recon', `${fmtDate(u.startedAt)}${u.startedBy ? ` · ${u.startedBy.name}` : ''}`)}
        ${u.doneAt ? infoRow(u.status === 'done' ? 'Frontline' : 'Left recon', fmtDate(u.doneAt)) : ''}
        ${infoRow('Car cost', money(c.cost))}${infoRow('Work total', money(u.estimate))}${infoRow('Approved', money(u.approved))}${infoRow('Spent', money(u.spent))}
      </div>
      <div class="rc-info-col rc-info-store">
        ${['other1', 'other2', 'other3', 'other4', 'other5', 'other6'].map((k, i) => html`<label class="rc-info-row"><span>Other ${i + 1}</span>
          <input type="text" data-field="${k}" value="${f[k] || ''}" ${work ? '' : html`disabled`} /></label>`)}
        <label class="rc-info-row"><span>Inspection</span><input type="datetime-local" data-info="inspectionDate" value="${u.inspectionDate ? new Date(new Date(u.inspectionDate).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}" ${work ? '' : html`disabled`} /></label>
        <label class="rc-info-row"><span>Inspection RO #</span><input type="text" data-info="inspectionRo" value="${u.inspectionRo || ''}" ${work ? '' : html`disabled`} /></label>
      </div>
    </div>

    <div class="rc-work">
      <div class="rc-work-head">
        <h3>Work items <span class="rc-count">${u.items.length}</span></h3>
        <span>Total <strong>${money(u.estimate)}</strong> · Approved ${money(u.approved)} · Spent ${money(u.spent)}</span>
        ${u.needsApproval ? html`<span class="rc-flag rc-flag-warn">${u.needsApproval} need approval</span>` : ''}
      </div>
      <div class="rc-work-tools">
        ${work ? html`<label class="rc-inline"><input type="checkbox" data-d="all" ${items.length && items.every(i => selectedItems.has(i.id)) ? html`checked` : ''} /> Select all</label>
          <select data-d="bulk" aria-label="Change status"><option value="">Change status…</option>
            ${approve ? html`<option value="approved">Approved</option><option value="declined">Declined</option><option value="proposed">Needs approval</option>` : ''}
            <option value="done">Done</option></select>` : ''}
        <select data-d="phase" aria-label="Phase"><option value="">All phases</option>${Object.entries(PHASE_LABELS).map(([k, l]) => html`<option value="${k}" ${phaseFilter === k ? html`selected` : ''}>${l} (${u.items.filter(i => i.category === k).length})</option>`)}</select>
        <span class="rc-tools-right">
          ${work && toService.length ? html`<button type="button" class="btn-secondary btn-small" data-d="service">Send ${toService.length} to service</button>` : ''}
          ${work ? html`<button type="button" class="btn-primary btn-small" data-d="pick">+ Add work items</button>` : ''}
        </span>
      </div>
      ${items.length ? items.map(i => itemCard(u, i, work, approve)) : html`<p class="rc-empty-big">${u.items.length ? 'No work items in this phase.' : 'No work items yet. Add them from the list.'}</p>`}
    </div>

    <div class="rc-car-bottom">
      <div class="rc-d-section">
        <div class="rc-d-title">Steps</div>
        <ol class="rc-timeline">${u.history.map(h => {
          const end = h.leftAt ? new Date(h.leftAt) : new Date();
          const hrs = (end - new Date(h.enteredAt)) / 3600000;
          const goal = (steps.find(s2 => s2.key === h.step) || {}).goalHours;
          const exit = h.step === READY || h.step === WHOLESALE;
          return html`<li class="${h.leftAt ? '' : 'rc-tl-now'}"><span class="rc-tl-dot"></span><span class="rc-tl-label">${h.label}</span>
            <span class="rc-tl-time ${exit ? '' : paceClass(hrs, goal)}">${exit ? new Date(h.enteredAt).toLocaleDateString() : hoursText(hrs)}</span><span class="rc-tl-by">${h.by}</span></li>`;
        })}</ol>
      </div>
      <div class="rc-d-section">
        <div class="rc-d-title">Notes</div>
        ${work ? html`<form class="rc-add-note" id="rcAddNote"><input name="text" placeholder="Add a note..." required /><button type="submit" class="btn-secondary btn-small">Save</button></form>` : ''}
        ${(u.notes || []).slice().reverse().map(nt => html`<div class="rc-note"><div>${nt.text}</div><span class="rc-muted">${nt.by} · ${fmtDate(nt.at)}</span></div>`)}
      </div>
    </div>`;
}

function itemCard(u, i, work, approve) {
  const locked = i.costPosted || i.roId || i.status === 'done';
  const dis = work && !locked ? '' : html`disabled`;
  const canStatus = work && !i.roId && !i.costPosted;
  const opts = ['proposed', 'approved', 'declined', 'done'].filter(s2 => s2 === i.status || s2 === 'done' || approve);
  return html`<div class="rc-item2 rc-item-${i.status}" data-item="${i.id}">
    <div class="rc-item2-head">
      ${work ? html`<input type="checkbox" data-sel ${selectedItems.has(i.id) ? html`checked` : ''} aria-label="Select" />` : ''}
      <strong>${i.description}</strong><span class="rc-cat">${PHASE_LABELS[i.category] || i.category}</span>
      ${i.roNumber ? html`<a href="/#ro=${i.roId}" target="dealerdomus" class="rc-ro-link">RO-${i.roNumber}${i.roStatus && i.roStatus !== 'closed' ? ` · ${i.roStatus.replace('_', ' ')}` : ''}</a>` : ''}
      ${work && !locked ? html`<button type="button" class="recon-remove rc-item-del" data-del title="Remove" aria-label="Remove">✕</button>` : ''}
    </div>
    <div class="rc-item2-body">
      <div class="rc-item2-status">
        <select data-status ${canStatus ? '' : html`disabled`} aria-label="Status">${opts.map(s2 => html`<option value="${s2}" ${i.status === s2 ? html`selected` : ''}>${STATUS_LABELS[s2]}</option>`)}</select>
        <span class="rc-muted">${i.approvedBy ? `${i.status === 'declined' ? 'Declined' : 'Approved'} by ${i.approvedBy} · ${fmtDate(i.approvedAt)}` : `Added by ${i.addedBy} · ${fmtDate(i.addedAt)}`}</span>
      </div>
      <label class="rc-item2-wide">Additional information<input type="text" data-f="info" value="${i.info || ''}" ${work ? '' : html`disabled`} /></label>
      <div class="rc-item2-money">
        <label>Parts $<input type="number" min="0" step="0.01" data-f="partsPrice" value="${i.partsPrice || ''}" ${dis} /></label>
        <label>Labor hrs<input type="number" min="0" step="0.1" data-f="laborHours" value="${i.laborHours || ''}" ${dis} /></label>
        <label>Labor rate<input type="number" min="0" step="0.01" data-f="laborRate" value="${i.laborRate ?? ''}" ${dis} /></label>
        <label>Total<input type="number" min="0" step="0.01" data-f="estimate" value="${i.estimate || ''}" ${dis || (Number(i.partsPrice) || Number(i.laborHours) ? html`disabled` : '')} title="Parts + labor hours × rate, or type a total" /></label>
        ${i.actual !== null && i.actual !== undefined ? html`<label>Actual<input type="text" value="${money(i.actual)}" disabled /></label>` : ''}
      </div>
      <label class="rc-item2-wide">Online description <span class="rc-muted">(for the listing)</span><input type="text" data-f="onlineDescription" value="${i.onlineDescription || ''}" ${work ? '' : html`disabled`} /></label>
      <label class="rc-item2-vendor">Vendor<input type="text" data-f="vendor" value="${i.vendor || ''}" ${dis} /></label>
    </div>
  </div>`;
}

const carEl = document.getElementById('rcCar');
carEl.addEventListener('click', async (e) => {
  const u = board.units.find(x => x.id === openUnitId);
  const t = e.target;
  try {
    if (t.closest('[data-d="close"]')) return closeUnit();
    if (t.closest('[data-d="print"]')) return window.print();
    const move = t.closest('[data-move]');
    if (move) return moveUnit(u, move.dataset.move);
    if (t.closest('[data-d="reopen"]')) { await api(`/recon/units/${u.id}/reopen`, 'POST', {}); return refresh(); }
    if (t.closest('[data-d="service"]')) { await api(`/recon/units/${u.id}/send-to-service`, 'POST'); return refresh(); }
    if (t.closest('[data-d="pick"]')) return openPicker(u);
    if (t.closest('[data-d="remove"]')) {
      const reason = prompt('Why is it leaving recon?', 'Sold');
      if (reason === null) return;
      await api(`/recon/units/${u.id}/remove`, 'POST', { reason });
      closeUnit();
      return refresh();
    }
    if (t.closest('[data-del]')) {
      const id = t.closest('[data-item]').dataset.item;
      if (!confirm('Remove this work item?')) return;
      await api(`/recon/units/${u.id}/items/${id}`, 'DELETE');
      return refresh();
    }
  } catch (err) { alert(err.message); }
});
carEl.addEventListener('change', async (e) => {
  const u = board.units.find(x => x.id === openUnitId);
  const t = e.target;
  try {
    if (t.dataset.d === 'step' && t.value) return moveUnit(u, t.value);
    if (t.dataset.d === 'phase') { phaseFilter = t.value; return renderCarPage(); }
    if (t.dataset.d === 'all') {
      u.items.filter(i => !phaseFilter || i.category === phaseFilter).forEach(i => (t.checked ? selectedItems.add(i.id) : selectedItems.delete(i.id)));
      return renderCarPage();
    }
    if (t.dataset.sel !== undefined) { const id = t.closest('[data-item]').dataset.item; if (t.checked) selectedItems.add(id); else selectedItems.delete(id); return; }
    if (t.dataset.d === 'bulk' && t.value) {
      if (!selectedItems.size) { alert('Select work items first.'); t.value = ''; return; }
      await api(`/recon/units/${u.id}/items/status`, 'POST', { ids: [...selectedItems], status: t.value });
      selectedItems.clear();
      return refresh();
    }
    if (t.dataset.field) { await api(`/recon/units/${u.id}/info`, 'PUT', { fields: { [t.dataset.field]: t.value } }); return refresh(); }
    if (t.dataset.info) { await api(`/recon/units/${u.id}/info`, 'PUT', { [t.dataset.info]: t.value ? new Date(t.value).toISOString() : '' }); return refresh(); }
    const itemEl = t.closest('[data-item]');
    if (!itemEl) return;
    const itemId = itemEl.dataset.item;
    if (t.dataset.status !== undefined) {
      const body = { status: t.value };
      if (t.value === 'done') {
        const item = u.items.find(i => i.id === itemId);
        const actual = prompt(`What did "${item.description}" actually cost? It's added to the car's cost.`, item.estimate || '');
        if (actual === null) { t.value = item.status; return; }
        body.actual = actual;
      }
      await api(`/recon/units/${u.id}/items/${itemId}`, 'PUT', body);
      return refresh();
    }
    if (t.dataset.f) { await api(`/recon/units/${u.id}/items/${itemId}`, 'PUT', { [t.dataset.f]: t.value }); return refresh(); }
  } catch (err) { alert(err.message); refresh().catch(() => {}); }
});
carEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api(`/recon/units/${openUnitId}/notes`, 'POST', { text: f.get('text') }); await refresh(); } catch (err) { alert(err.message); }
});

// ----- Add work items from the store's list -----
let pickUnit = null;
const picked = new Set();
function openPicker(u) {
  pickUnit = u;
  picked.clear();
  document.getElementById('rcPickFilter').value = '';
  document.getElementById('rcPickCustom').value = '';
  document.getElementById('rcPickPhases').innerHTML = html`${Object.entries(PHASE_LABELS).map(([k, l]) => html`<label class="rc-inline"><input type="checkbox" data-ph="${k}" checked /> ${l}</label>`)}`;
  document.getElementById('rcPickCustomPhase').innerHTML = html`${Object.entries(PHASE_LABELS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}`;
  renderPicker();
  document.getElementById('rcPickModal').classList.add('active');
  document.getElementById('rcPickFilter').focus();
}
function renderPicker() {
  const u = pickUnit;
  const words = document.getElementById('rcPickFilter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const alpha = document.querySelector('input[name="rcPickSort"]:checked').value === 'alpha';
  const shownPhases = [...document.querySelectorAll('[data-ph]')].filter(x => x.checked).map(x => x.dataset.ph);
  const have = new Set(u.items.map(i => i.description.toLowerCase()));
  document.getElementById('rcPickList').innerHTML = html`${shownPhases.map(ph => {
    let names = (board.settings.catalog[ph] || []).filter(nm => words.every(w => nm.toLowerCase().includes(w)));
    if (alpha) names = [...names].sort((a, b) => a.localeCompare(b));
    const all = board.settings.catalog[ph] || [];
    return html`<div class="rc-pick-group"><div class="rc-pick-head"><strong>${PHASE_LABELS[ph]}</strong>
      <span>${all.length} on the list</span><span>${all.filter(nm => have.has(nm.toLowerCase())).length} on the car</span>
      <span class="rc-pick-adding">adding ${[...picked].filter(k => k.startsWith(`${ph}|`)).length}</span></div>
      <div class="rc-pick-grid">${names.map(nm => {
        const onCar = have.has(nm.toLowerCase());
        return html`<label class="rc-pick-item ${onCar ? 'rc-pick-have' : ''}"><input type="checkbox" data-pick="${ph}|${nm}" ${onCar || picked.has(`${ph}|${nm}`) ? html`checked` : ''} ${onCar ? html`disabled` : ''} /> ${nm}</label>`;
      })}${names.length ? '' : html`<span class="rc-muted">Nothing matches.</span>`}</div></div>`;
  })}`;
}
document.getElementById('rcPickFilter').addEventListener('input', renderPicker);
document.getElementById('rcPickModal').addEventListener('change', (e) => {
  if (e.target.dataset.pick) { if (e.target.checked) picked.add(e.target.dataset.pick); else picked.delete(e.target.dataset.pick); renderPicker(); }
  else if (e.target.dataset.ph !== undefined || e.target.name === 'rcPickSort') renderPicker();
});
document.getElementById('rcPickCancel').addEventListener('click', () => document.getElementById('rcPickModal').classList.remove('active'));
document.getElementById('rcPickAdd').addEventListener('click', async () => {
  const items = [...picked].map(k => { const [category, ...rest] = k.split('|'); return { category, description: rest.join('|') }; });
  const custom = document.getElementById('rcPickCustom').value.trim();
  if (custom) items.push({ category: document.getElementById('rcPickCustomPhase').value, description: custom });
  if (!items.length) { alert('Pick at least one work item.'); return; }
  try {
    await api(`/recon/units/${pickUnit.id}/items/bulk`, 'POST', { items });
    document.getElementById('rcPickModal').classList.remove('active');
    await refresh();
  } catch (err) { alert(err.message); }
});

// ---------- Needs approval ----------
function renderApprovals(active) {
  const rows = active.flatMap(u => u.items.filter(i => i.status === 'proposed').map(i => ({ u, i }))).filter(x => matches(x.u));
  document.getElementById('rcApprovals').innerHTML = rows.length ? html`
    <p class="send-text-hint">${board.can.approve ? 'Approve or decline each item. Approved mechanical work can then go to service.' : 'Waiting on a used-car manager.'}</p>
    <table class="data-table rc-table"><thead><tr><th>Car</th><th>Work</th><th>Estimate</th><th>Added by</th><th>Car cost now</th><th></th></tr></thead><tbody>
    ${rows.map(({ u, i }) => html`<tr>
      <td><button type="button" class="link-btn" data-open="${u.id}">${vehicle(u)}</button><div class="rc-muted">${u.car && u.car.stockNumber ? `#${u.car.stockNumber}` : ''} · ${u.stepLabel}</div></td>
      <td><span class="rc-cat">${CATEGORY_LABELS[i.category]}</span> ${i.description}${i.vendor ? html`<div class="rc-muted">${i.vendor}</div>` : ''}</td>
      <td><strong>${money(i.estimate)}</strong></td><td>${i.addedBy}</td><td>${money(u.car && u.car.cost)} / asking ${money(u.car && u.car.price)}</td>
      <td class="rc-row-actions">${board.can.approve ? html`<button type="button" class="btn-primary btn-small" data-approve="${u.id}|${i.id}|approved">Approve</button>
        <button type="button" class="btn-secondary btn-small" data-approve="${u.id}|${i.id}|declined">Decline</button>` : ''}</td></tr>`)}
    </tbody></table>
    <p class="rc-total">Total waiting: <strong>${money(rows.reduce((s, x) => s + x.i.estimate, 0))}</strong></p>`
    : html`<p class="rc-empty-big">Nothing waiting on approval.</p>`;
}
document.getElementById('rcApprovals').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openUnit(open.dataset.open);
  const b = e.target.closest('[data-approve]');
  if (!b) return;
  const [unitId, itemId, status] = b.dataset.approve.split('|');
  try { await api(`/recon/units/${unitId}/items/${itemId}`, 'PUT', { status }); await refresh(); } catch (err) { alert(err.message); }
});

// ---------- Not started ----------
function renderWaiting() {
  const list = board.notStarted.filter(c => matches({ car: c, stockType: c.stockType }));
  document.getElementById('rcWaiting').innerHTML = list.length ? html`
    <p class="send-text-hint">Cars in stock that haven't started recon. They start at ${carType === 'new' ? 'the first New step' : carType === 'used' ? 'Purchase / Trade' : 'the first New step (new cars) or Purchase / Trade (used)'}.</p>
    <table class="data-table rc-table"><thead><tr><th>Car</th><th>Stock #</th><th>Type</th><th>Miles</th><th>In stock</th><th>Asking</th><th></th></tr></thead><tbody>
    ${list.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)).map(c => {
      const days = c.dateAdded ? Math.floor((Date.now() - new Date(c.dateAdded)) / 86400000) : null;
      return html`<tr><td><strong>${c.year} ${c.make} ${c.model}</strong> ${c.trim}</td><td>${c.stockNumber}</td><td><span class="rc-type-chip rc-type-${c.stockType}">${c.stockType === 'new' ? 'New' : 'Used'}</span></td><td>${c.mileage ? Number(c.mileage).toLocaleString() : '--'}</td>
        <td class="${days >= 3 ? 'rc-late' : ''}">${days === null ? '--' : `${days} day${days === 1 ? '' : 's'}`}</td><td>${money(c.price)}</td>
        <td>${board.can.work ? html`<button type="button" class="btn-primary btn-small" data-start="${c.id}">Start recon</button>` : ''}</td></tr>`;
    })}</tbody></table>`
    : html`<p class="rc-empty-big">Every car here is in recon or done.</p>`;
}
document.getElementById('rcWaiting').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-start]');
  if (!b) return;
  try { const u = await api('/recon/units', 'POST', { carId: b.dataset.start }); await refresh(); tab = 'cars'; stepFilter = u.step; render(); openUnit(u.id); } catch (err) { alert(err.message); }
});

// ---------- Performance ----------
function renderPerformance() {
  const since = Date.now() - 30 * 86400000;
  const done = board.units.filter(u => u.status === 'done' && typeOk(u) && new Date(u.doneAt).getTime() >= since);
  const goalH = board.settings.goalDays * 24;
  const avgT2L = done.length ? done.reduce((s, u) => s + u.totalHours, 0) / done.length : null;
  const onGoal = done.filter(u => u.totalHours <= goalH).length;
  // Average hours per step across every car that went through it (last 30 days + in recon now).
  const pool = board.units.filter(u => typeOk(u) && (u.status === 'active' || (u.status === 'done' && new Date(u.doneAt).getTime() >= since)));
  const perStep = board.settings.steps.map(s => {
    if (!pool.some(u => u.history.some(h => h.step === s.key))) return { ...s, avg: null, cars: 0 };
    const spans = pool.flatMap(u => u.history.filter(h => h.step === s.key).map(h => ((h.leftAt ? new Date(h.leftAt) : new Date()) - new Date(h.enteredAt)) / 3600000));
    return { ...s, avg: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null, cars: spans.length };
  });
  const maxAvg = Math.max(1, ...perStep.map(s => Math.max(s.avg || 0, s.goalHours || 0)));
  const spent = done.reduce((s, u) => s + u.spent, 0);
  const est = done.reduce((s, u) => s + u.estimate, 0);
  const worst = perStep.filter(s => s.avg !== null && s.goalHours).sort((a, b) => b.avg / b.goalHours - a.avg / a.goalHours)[0];
  document.getElementById('rcPerformance').innerHTML = html`
    <div class="rc-perf-cards">
      <div class="rc-perf"><span>ADR -- ${carType === 'all' ? 'all cars' : carType === 'new' ? 'new cars' : 'used cars'}, days to frontline</span><strong class="${avgT2L === null ? '' : paceClass(avgT2L, goalH)}">${avgT2L === null ? '--' : daysText(avgT2L)}</strong><em>goal ${board.settings.goalDays} days · last 30 days</em></div>
      <div class="rc-perf"><span>Made the goal</span><strong>${done.length ? `${Math.round(onGoal / done.length * 100)}%` : '--'}</strong><em>${onGoal} of ${done.length} cars</em></div>
      <div class="rc-perf"><span>Recon spend per car</span><strong>${done.length ? money(spent / done.length) : '--'}</strong><em>${money(spent)} on ${done.length} cars</em></div>
      <div class="rc-perf"><span>Spent vs. estimate</span><strong class="${spent > est * 1.1 ? 'rc-late' : ''}">${est ? `${Math.round(spent / est * 100)}%` : '--'}</strong><em>${money(spent)} of ${money(est)} estimated</em></div>
    </div>
    <div class="rc-d-title">Where the time goes <span class="rc-d-totals">average per step, cars in the last 30 days</span></div>
    ${worst && worst.avg > worst.goalHours ? html`<p class="rc-callout">Slowest vs. its goal: <strong>${worst.label}</strong> — ${hoursText(worst.avg)} on average against a ${hoursText(worst.goalHours)} goal.</p>` : ''}
    <div class="rc-bars" role="table" aria-label="Average time per step">
      ${perStep.filter(s => s.cars).map(s => html`<div class="rc-bar-row" role="row">
        <span class="rc-bar-label" role="cell">${s.label}</span>
        <span class="rc-bar-track" role="cell" title="${s.label}: ${hoursText(s.avg)} average, goal ${hoursText(s.goalHours)} (${s.cars} cars)">
          <span class="rc-bar ${s.avg === null ? '' : paceClass(s.avg, s.goalHours)}" style="width:${s.avg === null ? 0 : Math.min(100, s.avg / maxAvg * 100)}%"></span>
          ${s.goalHours ? html`<span class="rc-bar-goal" style="left:${Math.min(100, s.goalHours / maxAvg * 100)}%"></span>` : ''}
        </span>
        <span class="rc-bar-val" role="cell">${hoursText(s.avg)} <em>/ ${hoursText(s.goalHours)}</em></span>
      </div>`)}
    </div>
    ${perStep.some(s => s.cars) ? '' : html`<p class="rc-empty">No cars yet.</p>`}
    <p class="rc-muted rc-legend-note">Bar = average time in the step · line = the step's goal · green on pace, amber close, red over. Steps no car went through are left out.</p>`;
}

// ---------- Steps & goals ----------
let draftSteps = [];
document.getElementById('rcSetupBtn').addEventListener('click', () => {
  draftSteps = board.settings.steps.map(s => ({ ...s }));
  document.getElementById('rcGoalDays').value = board.settings.goalDays;
  document.getElementById('rcSetupMsg').textContent = '';
  renderStepRows();
  document.getElementById('rcSetupModal').classList.add('active');
});
function renderStepRows() {
  document.getElementById('rcStepRows').innerHTML = html`${draftSteps.map((s, i) => html`<div class="rc-step-row" data-i="${i}">
    <span class="rc-step-n">${i + 1}</span>
    <input type="text" data-f="label" value="${s.label}" placeholder="Step name" />
    <input type="number" data-f="goalHours" min="0" step="1" value="${s.goalHours}" title="Goal (hours)" /><span class="rc-muted">hrs</span>
    <button type="button" class="btn-secondary btn-small" data-mv="-1" ${i === 0 ? html`disabled` : ''} aria-label="Move up">▲</button>
    <button type="button" class="btn-secondary btn-small" data-mv="1" ${i === draftSteps.length - 1 ? html`disabled` : ''} aria-label="Move down">▼</button>
    <button type="button" class="recon-remove" data-rm aria-label="Remove">✕</button>
  </div>`)}<div class="rc-step-row rc-step-final"><span class="rc-step-n">✓</span><span>Frontline Ready · Wholesale (always the ways out)</span></div>`;
}
document.getElementById('rcStepRows').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]');
  if (row && e.target.dataset.f) draftSteps[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
});
document.getElementById('rcStepRows').addEventListener('click', (e) => {
  const row = e.target.closest('[data-i]');
  if (!row) return;
  const i = Number(row.dataset.i);
  const mv = e.target.closest('[data-mv]');
  if (mv) { const j = i + Number(mv.dataset.mv); [draftSteps[i], draftSteps[j]] = [draftSteps[j], draftSteps[i]]; renderStepRows(); }
  if (e.target.closest('[data-rm]')) { draftSteps.splice(i, 1); renderStepRows(); }
});
document.getElementById('rcAddStep').addEventListener('click', () => { draftSteps.push({ key: '', label: '', goalHours: 24 }); renderStepRows(); });
document.getElementById('rcResetSteps').addEventListener('click', async () => {
  if (!confirm('Replace the steps with the default list (New - Import through Vendor)? Cars in a step that no longer exists show under "Other steps" until you move them.')) return;
  try {
    await api('/recon/settings', 'PUT', { reset: true, goalDays: document.getElementById('rcGoalDays').value });
    document.getElementById('rcSetupModal').classList.remove('active');
    await refresh();
  } catch (err) { document.getElementById('rcSetupMsg').textContent = err.message; }
});
document.getElementById('rcSetupCancel').addEventListener('click', () => document.getElementById('rcSetupModal').classList.remove('active'));
document.getElementById('rcSetupSave').addEventListener('click', async () => {
  try {
    await api('/recon/settings', 'PUT', { goalDays: document.getElementById('rcGoalDays').value, steps: draftSteps.filter(s => String(s.label).trim()) });
    document.getElementById('rcSetupModal').classList.remove('active');
    await refresh();
  } catch (err) { document.getElementById('rcSetupMsg').textContent = err.message; }
});

// ---------- Start ----------
document.getElementById('rcTabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-rc-tab]');
  if (t) { tab = t.dataset.rcTab; render(); }
});
document.getElementById('rcSearch').addEventListener('input', () => render());
document.getElementById('rcTypes').addEventListener('click', (e) => {
  const t = e.target.closest('[data-type]');
  if (!t) return;
  carType = t.dataset.type;
  try { localStorage.setItem('reconType', carType); } catch { /* private window */ }
  render();
});

(async function init() {
  try {
    me = await api('/auth/me');
    document.getElementById('rcUser').textContent = me.name;
    const params = new URLSearchParams(location.hash.slice(1));
    const car = params.get('car');
    const unitParam = params.get('unit');
    await refresh();
    if (unitParam && board.units.some(x => x.id === unitParam)) openUnit(unitParam);
    else if (car) {
      const u = board.units.find(x => x.car && x.car.id === car && x.status === 'active');
      if (u) { stepFilter = u.step; render(); openUnit(u.id); } else if (board.notStarted.some(c => c.id === car)) { tab = 'waiting'; render(); }
    }
  } catch (err) {
    document.getElementById('rcStrip').innerHTML = '';
    document.getElementById('rcList').innerHTML = html`<p class="rc-empty-big">${err.message}<br><a href="/">Back to DealerDomus</a></p>`;
  }
  setInterval(() => { if (!document.hidden && !openUnitId) refresh().catch(() => {}); }, 60000);
})();
