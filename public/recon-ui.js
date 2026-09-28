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
let tab = 'board';
let openUnitId = null;

// ---------- Loading ----------
async function refresh() {
  board = await api('/recon/board');
  document.getElementById('rcSetupBtn').hidden = !board.can.approve;
  render();
  if (openUnitId) renderDrawer();
}

function matches(u) {
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
  const active = board.units.filter(u => u.status === 'active');
  const pending = active.flatMap(u => u.items.filter(i => i.status === 'proposed'));
  document.getElementById('rcApprovalCount').textContent = pending.length;
  document.getElementById('rcWaitingCount').textContent = board.notStarted.length;
  const goalH = board.settings.goalDays * 24;
  const avg = active.length ? active.reduce((s, u) => s + u.totalHours, 0) / active.length : 0;
  document.getElementById('rcStrip').innerHTML = html`
    <div class="rc-stat"><strong>${active.length}</strong><span>in recon</span></div>
    <div class="rc-stat ${active.some(u => u.late) ? 'rc-stat-bad' : ''}"><strong>${active.filter(u => u.late).length}</strong><span>past the ${board.settings.goalDays}-day goal</span></div>
    <div class="rc-stat"><strong>${active.length ? daysText(avg) : '--'}</strong><span>average time in recon so far</span></div>
    <div class="rc-stat ${pending.length ? 'rc-stat-warn' : ''}"><strong>${pending.length}</strong><span>items waiting on approval · ${money(pending.reduce((s, i) => s + i.estimate, 0))}</span></div>
    <div class="rc-stat"><strong>${board.notStarted.length}</strong><span>used cars not started</span></div>
    <div class="rc-stat"><strong>${money(active.reduce((s, u) => s + u.spent, 0))}</strong><span>spent on cars in recon</span></div>`;
  document.querySelectorAll('.rc-view').forEach(v => { v.hidden = v.dataset.rcView !== tab; });
  document.querySelectorAll('.rc-tab').forEach(t => t.classList.toggle('active', t.dataset.rcTab === tab));
  if (tab === 'board') renderBoard(active, goalH);
  if (tab === 'approvals') renderApprovals(active);
  if (tab === 'waiting') renderWaiting();
  if (tab === 'finished') renderFinished();
  if (tab === 'performance') renderPerformance();
}

// ---------- Board ----------
function renderBoard(active, goalH) {
  const cols = board.settings.steps.map(s => ({ ...s, units: active.filter(u => u.step === s.key && matches(u)) }));
  const orphans = active.filter(u => !board.settings.steps.some(s => s.key === u.step) && matches(u));
  if (orphans.length) cols.unshift({ key: '__other', label: 'Other steps', goalHours: 0, units: orphans });
  document.getElementById('rcBoard').innerHTML = html`${cols.map(c => html`
    <div class="rc-col" data-drop-step="${c.key}">
      <div class="rc-col-head"><span>${c.label}</span><span class="rc-col-meta">${c.goalHours ? `goal ${hoursText(c.goalHours)}` : ''}<span class="rc-count">${c.units.length}</span></span></div>
      <div class="rc-col-body">
        ${c.units.sort((a, b) => b.hoursInStep - a.hoursInStep).map(u => card(u, goalH))}
        ${c.units.length ? '' : html`<p class="rc-empty">Nothing here</p>`}
      </div>
    </div>`)}
    <div class="rc-col rc-col-ready" data-drop-step="ready">
      <div class="rc-col-head"><span>✓ Front line</span></div>
      <div class="rc-col-body"><p class="rc-empty">Drop a car here when it's ready to sell.</p></div>
    </div>`;
}

function card(u, goalH) {
  const stepPace = paceClass(u.hoursInStep, u.stepGoalHours);
  const tripPace = paceClass(u.totalHours, goalH);
  return html`<div class="rc-card ${u.car && u.car.status === 'sold' ? 'rc-card-sold' : ''}" draggable="${board.can.work ? 'true' : 'false'}" data-unit="${u.id}">
    <div class="rc-card-top"><strong>${vehicle(u)}</strong><span class="rc-stock">${u.car && u.car.stockNumber ? `#${u.car.stockNumber}` : ''}</span></div>
    <div class="rc-card-sub">${[u.car && u.car.trim, u.car && u.car.color, u.car && u.car.mileage ? `${Number(u.car.mileage).toLocaleString()} mi` : ''].filter(Boolean).join(' · ')}</div>
    <div class="rc-timers">
      <span class="rc-timer ${stepPace}" title="Time in this step (goal ${hoursText(u.stepGoalHours)})">⏱ ${hoursText(u.hoursInStep)}</span>
      <span class="rc-timer ${tripPace}" title="Total time in recon (goal ${board.settings.goalDays} days)">${daysText(u.totalHours)} total</span>
      ${u.car && u.car.status === 'sold' ? html`<span class="rc-flag">Sold</span>` : ''}
    </div>
    <div class="rc-card-money">
      ${u.needsApproval ? html`<span class="rc-flag rc-flag-warn">${u.needsApproval} to approve</span>` : ''}
      ${u.items.some(i => i.roId && i.status !== 'done' && i.status !== 'declined') ? html`<span class="rc-flag">In service</span>` : ''}
      <span>Est ${money(u.estimate)}</span><span>Spent ${money(u.spent)}</span>
    </div>
  </div>`;
}

const boardEl = document.getElementById('rcBoard');
boardEl.addEventListener('click', (e) => {
  const c = e.target.closest('[data-unit]');
  if (c) openUnit(c.dataset.unit);
});
boardEl.addEventListener('dragstart', (e) => {
  const c = e.target.closest('[data-unit]');
  if (!c) return;
  e.dataTransfer.setData('text/plain', c.dataset.unit);
  c.classList.add('rc-dragging');
});
boardEl.addEventListener('dragend', (e) => { const c = e.target.closest('[data-unit]'); if (c) c.classList.remove('rc-dragging'); });
boardEl.addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-drop-step]');
  if (!col || col.dataset.dropStep === '__other') return;
  e.preventDefault();
  document.querySelectorAll('.rc-col.rc-drop').forEach(x => x.classList.remove('rc-drop'));
  col.classList.add('rc-drop');
});
boardEl.addEventListener('dragleave', (e) => { const col = e.target.closest('[data-drop-step]'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('rc-drop'); });
boardEl.addEventListener('drop', async (e) => {
  const col = e.target.closest('[data-drop-step]');
  if (!col) return;
  e.preventDefault();
  col.classList.remove('rc-drop');
  const id = e.dataTransfer.getData('text/plain');
  const u = board.units.find(x => x.id === id);
  if (!u || u.step === col.dataset.dropStep) return;
  await moveUnit(u, col.dataset.dropStep);
});

async function moveUnit(u, step) {
  if (step === 'ready') {
    const open = u.items.filter(i => i.status === 'proposed' || i.status === 'approved');
    if (open.length && !confirm(`${vehicle(u)} still has ${open.length} work item${open.length === 1 ? '' : 's'} not done. Send it to the front line anyway?`)) return;
  }
  try { await api(`/recon/units/${u.id}/move`, 'POST', { step }); await refresh(); } catch (err) { alert(err.message); }
}

// ---------- One car ----------
function openUnit(id) {
  openUnitId = id;
  renderDrawer();
  document.getElementById('rcDrawer').hidden = false;
  document.getElementById('rcBackdrop').hidden = false;
}
function closeUnit() {
  openUnitId = null;
  document.getElementById('rcDrawer').hidden = true;
  document.getElementById('rcBackdrop').hidden = true;
}
document.getElementById('rcBackdrop').addEventListener('click', closeUnit);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openUnitId) closeUnit(); });

function renderDrawer() {
  const u = board.units.find(x => x.id === openUnitId);
  const el = document.getElementById('rcDrawer');
  if (!u) { closeUnit(); return; }
  const work = board.can.work;
  const approve = board.can.approve;
  const active = u.status === 'active';
  const steps = board.settings.steps;
  const idx = steps.findIndex(s => s.key === u.step);
  const next = idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null;
  const toService = u.items.filter(i => i.status === 'approved' && ['mechanical', 'tires'].includes(i.category) && !i.roId);
  el.innerHTML = html`
    <div class="rc-d-head">
      <div>
        <h2>${vehicle(u)}</h2>
        <div class="rc-card-sub">${[u.car && u.car.stockNumber ? `Stock #${u.car.stockNumber}` : '', u.car && u.car.vin, u.car && u.car.mileage ? `${Number(u.car.mileage).toLocaleString()} mi` : ''].filter(Boolean).join(' · ')}</div>
        <div class="rc-card-sub">Car cost ${money(u.car && u.car.cost)} · asking ${money(u.car && u.car.price)}</div>
      </div>
      <button type="button" class="rc-x" data-d="close" aria-label="Close">✕</button>
    </div>

    <div class="rc-d-section">
      <div class="rc-d-now">
        <div><span class="rc-d-label">${active ? 'Now in' : u.status === 'done' ? 'Finished' : 'Removed'}</span><strong>${active ? u.stepLabel : u.status === 'done' ? 'Front line' : 'Out of recon'}</strong></div>
        ${active ? html`<div><span class="rc-d-label">In this step</span><strong class="${paceClass(u.hoursInStep, u.stepGoalHours)}">${hoursText(u.hoursInStep)}</strong><em>goal ${hoursText(u.stepGoalHours)}</em></div>` : ''}
        <div><span class="rc-d-label">${active ? 'In recon' : 'Took'}</span><strong class="${paceClass(u.totalHours, board.settings.goalDays * 24)}">${daysText(u.totalHours)}</strong><em>goal ${board.settings.goalDays}d</em></div>
      </div>
      ${work && active ? html`<div class="rc-d-move">
        ${next ? html`<button type="button" class="btn-primary btn-small" data-move="${next.key}">Next: ${next.label} →</button>` : ''}
        <button type="button" class="btn-secondary btn-small rc-ready-btn" data-move="ready">✓ Front line</button>
        <select data-d="step" aria-label="Move to step"><option value="">Move to…</option>${steps.filter(s => s.key !== u.step).map(s => html`<option value="${s.key}">${s.label}</option>`)}</select>
      </div>` : ''}
      ${work && !active ? html`<div class="rc-d-move"><button type="button" class="btn-secondary btn-small" data-d="reopen">Back into recon</button></div>` : ''}
    </div>

    <div class="rc-d-section">
      <div class="rc-d-title">Steps</div>
      <ol class="rc-timeline">${u.history.map(h => {
        const end = h.leftAt ? new Date(h.leftAt) : new Date();
        const hrs = (end - new Date(h.enteredAt)) / 3600000;
        const goal = (steps.find(s => s.key === h.step) || {}).goalHours;
        return html`<li class="${h.leftAt ? '' : 'rc-tl-now'}"><span class="rc-tl-dot"></span><span class="rc-tl-label">${h.label}</span>
          <span class="rc-tl-time ${h.step === 'ready' ? '' : paceClass(hrs, goal)}">${h.step === 'ready' ? new Date(h.enteredAt).toLocaleDateString() : hoursText(hrs)}</span><span class="rc-tl-by">${h.by}</span></li>`;
      })}</ol>
    </div>

    <div class="rc-d-section">
      <div class="rc-d-title">Work <span class="rc-d-totals">Estimate ${money(u.estimate)} · Approved ${money(u.approved)} · Spent ${money(u.spent)}</span></div>
      ${u.items.length ? u.items.map(i => html`<div class="rc-item rc-item-${i.status}" data-item="${i.id}">
        <div class="rc-item-top">
          <span class="rc-cat">${CATEGORY_LABELS[i.category]}</span>
          <strong>${i.description}</strong>
          <span class="rc-item-status">${ITEM_LABELS[i.status] || i.status}</span>
        </div>
        <div class="rc-item-meta">
          <span>Estimate ${money(i.estimate)}</span>
          ${i.actual !== null && i.actual !== undefined ? html`<span>Actual ${money(i.actual)}</span>` : ''}
          ${i.vendor ? html`<span>${i.vendor}</span>` : ''}
          ${i.roNumber ? html`<a href="/" data-ro="${i.roId}">RO-${i.roNumber}${i.roStatus && i.roStatus !== 'closed' ? ` · ${i.roStatus.replace('_', ' ')}` : ''}</a>` : ''}
          <span class="rc-muted">added by ${i.addedBy}${i.approvedBy ? ` · ${i.status === 'declined' ? 'declined' : 'approved'} by ${i.approvedBy}` : ''}</span>
        </div>
        ${work ? html`<div class="rc-item-actions">
          ${approve && i.status === 'proposed' ? html`<button type="button" class="btn-primary btn-small" data-item-set="approved">Approve</button><button type="button" class="btn-secondary btn-small" data-item-set="declined">Decline</button>` : ''}
          ${i.status === 'approved' && !i.roId ? html`<button type="button" class="btn-secondary btn-small" data-item-set="done">Mark done…</button>` : ''}
        </div>` : ''}
      </div>`) : html`<p class="rc-empty">No work added yet.</p>`}
      ${work && toService.length ? html`<button type="button" class="btn-primary btn-small rc-service-btn" data-d="service">Send ${toService.length} approved item${toService.length === 1 ? '' : 's'} to service (internal RO)</button>` : ''}
      ${work && active ? html`<form class="rc-add-item" id="rcAddItem">
        <select name="category">${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
        <input name="description" placeholder="What needs doing, e.g. front brakes" required />
        <input name="estimate" type="number" min="0" step="1" placeholder="Estimate $" />
        <input name="vendor" placeholder="Vendor (optional)" />
        ${approve ? html`<label class="rc-inline"><input type="checkbox" name="approve" checked /> Approve</label>` : ''}
        <button type="submit" class="btn-secondary btn-small">Add</button>
      </form>` : ''}
    </div>

    <div class="rc-d-section">
      <div class="rc-d-title">Notes</div>
      ${(u.notes || []).slice().reverse().map(nt => html`<div class="rc-note"><div>${nt.text}</div><span class="rc-muted">${nt.by} · ${new Date(nt.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div>`)}
      ${work ? html`<form class="rc-add-note" id="rcAddNote"><input name="text" placeholder="Add a note..." required /><button type="submit" class="btn-secondary btn-small">Save</button></form>` : ''}
    </div>
    ${work && active ? html`<div class="rc-d-section rc-d-foot"><button type="button" class="link-btn" data-d="remove">Take out of recon (sold, wholesaled...)</button></div>` : ''}`;
}

const drawer = document.getElementById('rcDrawer');
drawer.addEventListener('click', async (e) => {
  const u = board.units.find(x => x.id === openUnitId);
  const t = e.target;
  try {
    if (t.closest('[data-d="close"]')) return closeUnit();
    const move = t.closest('[data-move]');
    if (move) return moveUnit(u, move.dataset.move);
    const ro = t.closest('[data-ro]');
    if (ro) { e.preventDefault(); window.open(`/#ro=${ro.dataset.ro}`, 'dealerdomus'); return; }
    if (t.closest('[data-d="reopen"]')) { await api(`/recon/units/${u.id}/reopen`, 'POST', {}); return refresh(); }
    if (t.closest('[data-d="service"]')) { await api(`/recon/units/${u.id}/send-to-service`, 'POST'); return refresh(); }
    if (t.closest('[data-d="remove"]')) {
      const reason = prompt('Why is it leaving recon?', 'Sold');
      if (reason === null) return;
      await api(`/recon/units/${u.id}/remove`, 'POST', { reason });
      closeUnit();
      return refresh();
    }
    const set = t.closest('[data-item-set]');
    if (set) {
      const itemId = t.closest('[data-item]').dataset.item;
      const body = { status: set.dataset.itemSet };
      if (body.status === 'done') {
        const item = u.items.find(i => i.id === itemId);
        const actual = prompt(`What did "${item.description}" actually cost? It's added to the car's cost.`, item.estimate || '');
        if (actual === null) return;
        body.actual = actual;
      }
      await api(`/recon/units/${u.id}/items/${itemId}`, 'PUT', body);
      return refresh();
    }
  } catch (err) { alert(err.message); }
});
drawer.addEventListener('change', (e) => {
  if (e.target.dataset.d === 'step' && e.target.value) moveUnit(board.units.find(x => x.id === openUnitId), e.target.value);
});
drawer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    if (e.target.id === 'rcAddItem') {
      await api(`/recon/units/${openUnitId}/items`, 'POST', { category: f.get('category'), description: f.get('description'), estimate: f.get('estimate'), vendor: f.get('vendor'), approve: f.get('approve') === 'on' });
    } else if (e.target.id === 'rcAddNote') {
      await api(`/recon/units/${openUnitId}/notes`, 'POST', { text: f.get('text') });
    }
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
  const list = board.notStarted.filter(c => matches({ car: c }));
  document.getElementById('rcWaiting').innerHTML = list.length ? html`
    <p class="send-text-hint">Used cars in stock that haven't started recon.</p>
    <table class="data-table rc-table"><thead><tr><th>Car</th><th>Stock #</th><th>Miles</th><th>In stock</th><th>Asking</th><th></th></tr></thead><tbody>
    ${list.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded)).map(c => {
      const days = c.dateAdded ? Math.floor((Date.now() - new Date(c.dateAdded)) / 86400000) : null;
      return html`<tr><td><strong>${c.year} ${c.make} ${c.model}</strong> ${c.trim}</td><td>${c.stockNumber}</td><td>${c.mileage ? Number(c.mileage).toLocaleString() : '--'}</td>
        <td class="${days >= 3 ? 'rc-late' : ''}">${days === null ? '--' : `${days} day${days === 1 ? '' : 's'}`}</td><td>${money(c.price)}</td>
        <td>${board.can.work ? html`<button type="button" class="btn-primary btn-small" data-start="${c.id}">Start recon</button>` : ''}</td></tr>`;
    })}</tbody></table>`
    : html`<p class="rc-empty-big">Every used car in stock is in recon or done.</p>`;
}
document.getElementById('rcWaiting').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-start]');
  if (!b) return;
  try { const u = await api('/recon/units', 'POST', { carId: b.dataset.start }); await refresh(); tab = 'board'; render(); openUnit(u.id); } catch (err) { alert(err.message); }
});

// ---------- Front line (finished) ----------
function renderFinished() {
  const done = board.units.filter(u => u.status === 'done' && matches(u)).sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
  const goalH = board.settings.goalDays * 24;
  document.getElementById('rcFinished').innerHTML = done.length ? html`
    <p class="send-text-hint">Cars that reached the front line in the last 90 days.</p>
    <table class="data-table rc-table"><thead><tr><th>Car</th><th>Front line</th><th>Days in recon</th><th>Spent</th><th>Estimate</th><th>Status</th></tr></thead><tbody>
    ${done.map(u => html`<tr><td><button type="button" class="link-btn" data-open="${u.id}">${vehicle(u)}</button><div class="rc-muted">${u.car && u.car.stockNumber ? `#${u.car.stockNumber}` : ''}</div></td>
      <td>${new Date(u.doneAt).toLocaleDateString()}</td><td class="${paceClass(u.totalHours, goalH)}"><strong>${daysText(u.totalHours)}</strong></td>
      <td>${money(u.spent)}</td><td>${money(u.estimate)}</td><td>${u.car && u.car.status === 'sold' ? 'Sold' : 'For sale'}</td></tr>`)}</tbody></table>`
    : html`<p class="rc-empty-big">No cars finished recon yet.</p>`;
}
document.getElementById('rcFinished').addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) openUnit(o.dataset.open); });

// ---------- Performance ----------
function renderPerformance() {
  const since = Date.now() - 30 * 86400000;
  const done = board.units.filter(u => u.status === 'done' && new Date(u.doneAt).getTime() >= since);
  const goalH = board.settings.goalDays * 24;
  const avgT2L = done.length ? done.reduce((s, u) => s + u.totalHours, 0) / done.length : null;
  const onGoal = done.filter(u => u.totalHours <= goalH).length;
  // Average hours per step across every car that went through it (last 30 days + in recon now).
  const pool = board.units.filter(u => u.status === 'active' || (u.status === 'done' && new Date(u.doneAt).getTime() >= since));
  const perStep = board.settings.steps.map(s => {
    const spans = pool.flatMap(u => u.history.filter(h => h.step === s.key).map(h => ((h.leftAt ? new Date(h.leftAt) : new Date()) - new Date(h.enteredAt)) / 3600000));
    return { ...s, avg: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null, cars: spans.length };
  });
  const maxAvg = Math.max(1, ...perStep.map(s => Math.max(s.avg || 0, s.goalHours || 0)));
  const spent = done.reduce((s, u) => s + u.spent, 0);
  const est = done.reduce((s, u) => s + u.estimate, 0);
  const worst = perStep.filter(s => s.avg !== null && s.goalHours).sort((a, b) => b.avg / b.goalHours - a.avg / a.goalHours)[0];
  document.getElementById('rcPerformance').innerHTML = html`
    <div class="rc-perf-cards">
      <div class="rc-perf"><span>Average days to the front line</span><strong class="${avgT2L === null ? '' : paceClass(avgT2L, goalH)}">${avgT2L === null ? '--' : daysText(avgT2L)}</strong><em>goal ${board.settings.goalDays} days · last 30 days</em></div>
      <div class="rc-perf"><span>Made the goal</span><strong>${done.length ? `${Math.round(onGoal / done.length * 100)}%` : '--'}</strong><em>${onGoal} of ${done.length} cars</em></div>
      <div class="rc-perf"><span>Recon spend per car</span><strong>${done.length ? money(spent / done.length) : '--'}</strong><em>${money(spent)} on ${done.length} cars</em></div>
      <div class="rc-perf"><span>Spent vs. estimate</span><strong class="${spent > est * 1.1 ? 'rc-late' : ''}">${est ? `${Math.round(spent / est * 100)}%` : '--'}</strong><em>${money(spent)} of ${money(est)} estimated</em></div>
    </div>
    <div class="rc-d-title">Where the time goes <span class="rc-d-totals">average per step, cars in the last 30 days</span></div>
    ${worst && worst.avg > worst.goalHours ? html`<p class="rc-callout">Slowest vs. its goal: <strong>${worst.label}</strong> — ${hoursText(worst.avg)} on average against a ${hoursText(worst.goalHours)} goal.</p>` : ''}
    <div class="rc-bars" role="table" aria-label="Average time per step">
      ${perStep.map(s => html`<div class="rc-bar-row" role="row">
        <span class="rc-bar-label" role="cell">${s.label}</span>
        <span class="rc-bar-track" role="cell" title="${s.label}: ${hoursText(s.avg)} average, goal ${hoursText(s.goalHours)} (${s.cars} cars)">
          <span class="rc-bar ${s.avg === null ? '' : paceClass(s.avg, s.goalHours)}" style="width:${s.avg === null ? 0 : Math.min(100, s.avg / maxAvg * 100)}%"></span>
          ${s.goalHours ? html`<span class="rc-bar-goal" style="left:${Math.min(100, s.goalHours / maxAvg * 100)}%"></span>` : ''}
        </span>
        <span class="rc-bar-val" role="cell">${hoursText(s.avg)} <em>/ ${hoursText(s.goalHours)}</em></span>
      </div>`)}
    </div>
    <p class="rc-muted rc-legend-note">Bar = average time in the step · line = the step's goal · green on pace, amber close, red over.</p>`;
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
  </div>`)}<div class="rc-step-row rc-step-final"><span class="rc-step-n">✓</span><span>Front line</span></div>`;
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

(async function init() {
  try {
    me = await api('/auth/me');
    document.getElementById('rcUser').textContent = me.name;
    const car = new URLSearchParams(location.hash.slice(1)).get('car');
    await refresh();
    if (car) {
      const u = board.units.find(x => x.car && x.car.id === car && x.status === 'active');
      if (u) openUnit(u.id); else if (board.notStarted.some(c => c.id === car)) { tab = 'waiting'; render(); }
    }
  } catch (err) {
    document.getElementById('rcStrip').innerHTML = '';
    document.getElementById('rcBoard').innerHTML = html`<p class="rc-empty-big">${err.message}<br><a href="/">Back to DealerDomus</a></p>`;
  }
  setInterval(() => { if (!document.hidden && !openUnitId) refresh().catch(() => {}); }, 60000);
})();
