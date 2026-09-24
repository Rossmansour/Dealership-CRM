// app.js
// All frontend logic: tab switching, fetching data from the API,
// rendering tables, and handling the add/edit modals.
// Plain JS + fetch on purpose -- no framework needed for a project this size.

const API = '/api';

// ---------- Safe HTML ----------
// Customer names, notes, VINs, AI replies, etc. are typed by people (or
// generated from what people typed), so they must never be inserted into
// the page as raw HTML -- otherwise text like <img onerror=...> in a lead's
// name would run as code in the browser of whoever views it, with their
// permissions. Every template that puts data into HTML uses the html`` tag
// below, which escapes each ${value} automatically. (Templates built only
// from fixed values in this file, like the credit app's dropdown options,
// don't need it.) Nested html`` results (and
// arrays of them) are inserted as-is, since they were already escaped.
//
// Values passed to inline click handlers need js() instead, which turns
// them into a safe JavaScript string: onclick="editCar(${js(c.id)})".

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function toHtml(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => { out += toHtml(value) + strings[i + 1]; });
  return new SafeHtml(out);
}

function js(value) {
  return new SafeHtml(escapeHtml(JSON.stringify(value ?? null)));
}

// ---------- Signed-in user ----------
// Every API call goes through fetch, so this one wrapper handles the two
// login-related responses everywhere: a 401 (signed out, or the session
// expired) goes back to the sign-in page, and a 403 (this role isn't
// allowed to do that) shows the server's explanation.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) {
    window.location.href = '/login.html';
  } else if (res.status === 403) {
    res.clone().json()
      .then(body => alert(body.error || "You don't have permission to do that."))
      .catch(() => alert("You don't have permission to do that."));
  }
  return res;
};

let currentUser = null;

function userCan(permission) {
  return !!currentUser && currentUser.permissions.includes(permission);
}

// Hides buttons for things this user's role can't do. The server enforces
// the same rules regardless -- this just avoids offering dead ends.
function applyPermissionsToUI() {
  for (const permission of ['editInventory', 'deleteRecords', 'editSettings', 'manageUsers', 'viewAuditLog', 'manageIntegrations']) {
    document.body.classList.toggle(`cannot-${permission}`, !userCan(permission));
  }
  document.getElementById('currentUserName').textContent = currentUser.name;
  document.getElementById('currentUserInitials').textContent =
    currentUser.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  document.getElementById('adminMenuBtn').style.display =
    (userCan('editSettings') || userCan('manageUsers') || userCan('viewAuditLog') || userCan('manageIntegrations')) ? '' : 'none';
  document.getElementById('adminUsersBtn').style.display = userCan('manageUsers') ? '' : 'none';
  document.getElementById('adminAuditLogBtn').style.display = userCan('viewAuditLog') ? '' : 'none';
  document.getElementById('adminIntegrationsBtn').style.display = userCan('manageIntegrations') ? '' : 'none';
  document.getElementById('adminFeeDefaultsBtn').style.display = userCan('editSettings') ? '' : 'none';
  document.getElementById('adminTaxRatesBtn').style.display = userCan('editSettings') ? '' : 'none';
}

let cars = [];
let vehicleKeys = []; // key status from the key machine (see Key column)
let appSettings = {};
let leads = [];
let deals = [];

// ---------- Dark mode ----------
// The initial theme is already applied by an inline script in <head>
// (so there's no flash of light mode on page load) -- this just wires
// up the toggle button and keeps the choice saved for next time.

const themeToggleBtn = document.getElementById('themeToggleBtn');

const SUN_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7L5.3 5.3"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

function updateThemeButtonLabel() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  themeToggleBtn.innerHTML = isDark ? SUN_ICON : MOON_ICON;
  themeToggleBtn.title = isDark ? 'Light mode' : 'Dark mode';
  themeToggleBtn.setAttribute('aria-label', themeToggleBtn.title);
}
updateThemeButtonLabel();

themeToggleBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('theme', 'dark');
  }
  updateThemeButtonLabel();
});

// ---------- Navigation ----------
// The icon bar at the top switches between screens ("views"). Most views
// are one panel; "leads" and "board" are the same Customers panel shown as
// a table or as a board.

const VIEW_PANELS = {
  pipeline: 'pipeline', leads: 'leads', board: 'leads', deals: 'deals',
  inventory: 'inventory', reports: 'dashboard', assistant: 'assistant', service: 'service'
};
let currentView = 'pipeline';

function showView(view) {
  currentView = view;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(VIEW_PANELS[view]).classList.add('active');
  document.querySelectorAll('.nav-icon[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
  if (view === 'leads') setLeadsView('table');
  if (view === 'board') setLeadsView('kanban');
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-icon[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    // Choosing a screen from the bar shows everything, not a leftover filter.
    if (btn.dataset.view === 'leads' || btn.dataset.view === 'board') clearLeadsListFilter(false);
    if (btn.dataset.view === 'inventory') clearInventoryListFilter(false);
    showView(btn.dataset.view);
  });
});

document.getElementById('brandHomeBtn').addEventListener('click', () => showView('pipeline'));

// ---------- Data loading ----------

async function loadAll() {
  const [carsRes, leadsRes, dealsRes, statsRes, keysRes] = await Promise.all([
    fetch(`${API}/cars`).then(r => r.json()),
    fetch(`${API}/leads`).then(r => r.json()),
    fetch(`${API}/deals`).then(r => r.json()),
    fetch(`${API}/stats`).then(r => r.json()),
    fetch(`${API}/keys`).then(r => r.json())
  ]);
  cars = carsRes;
  vehicleKeys = Array.isArray(keysRes) ? keysRes : [];
  leads = leadsRes;
  deals = dealsRes;
  renderStats(statsRes);
  renderCars();
  renderLeads();
  renderLeadsKanban();
  renderDeals();
  populateLeadCarOptions();
  renderPipeline();
  renderRail();
}

// ---------- Needs-follow-up detection ----------
// A lead "needs follow-up" if it's still an open opportunity (not
// won/lost) and nobody has logged a call/text/email/note in the last
// few days. This is computed entirely client-side since the leads
// array already carries everything needed (activities, dateAdded).

const FOLLOWUP_THRESHOLD_DAYS = 3;

function daysSinceLastContact(lead) {
  const activities = lead.activities || [];
  const lastDate = activities.length > 0 ? activities[0].date : lead.dateAdded;
  return Math.floor((new Date() - new Date(lastDate)) / (1000 * 60 * 60 * 24));
}

function needsFollowUp(lead) {
  if (lead.status === 'won' || lead.status === 'lost') return false;
  return daysSinceLastContact(lead) >= FOLLOWUP_THRESHOLD_DAYS;
}

// ---------- Dashboard ----------

function renderStats(stats) {
  const followUpCount = leads.filter(needsFollowUp).length;

  const cards = [
    { label: 'Available Cars', value: stats.availableCars },
    { label: 'Inventory Value', value: `$${stats.inventoryValue.toLocaleString()}` },
    { label: 'Cars Sold', value: stats.soldCars },
    { label: 'Total Profit', value: `$${stats.totalProfit.toLocaleString()}` },
    { label: 'Avg Days on Lot', value: stats.avgDaysOnLot },
    { label: 'Lead Conversion Rate', value: `${stats.conversionRate}%` },
    { label: 'Needs Follow-Up', value: followUpCount, warn: followUpCount > 0 },
  ];
  document.getElementById('statsGrid').innerHTML = cards.map(c => html`
    <div class="stat-card ${c.warn ? 'stat-card-warn' : ''}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
    </div>
  `).join('');
}

// ---------- Inventory table ----------

function renderCars() {
  const search = document.getElementById('carSearch').value.toLowerCase();
  const statusFilter = document.getElementById('statusFilter').value;

  let filtered = cars.filter(c => {
    const matchesSearch = !search ||
      c.make.toLowerCase().includes(search) ||
      c.model.toLowerCase().includes(search) ||
      (c.trim || '').toLowerCase().includes(search) ||
      (c.vin || '').toLowerCase().includes(search) ||
      (c.stockNumber || '').toLowerCase().includes(search);
    const matchesStatus = !statusFilter || c.status === statusFilter;
    const matchesListFilter = !inventoryListFilter || inventoryListFilter.ids.has(c.id);
    return matchesSearch && matchesStatus && matchesListFilter;
  });

  document.getElementById('carTableBody').innerHTML = filtered.map(c => {
    const daysListed = Math.round((new Date() - new Date(c.dateAdded)) / (1000 * 60 * 60 * 24));
    const thumb = (c.photos && c.photos[0])
      ? html`<img class="inventory-thumb" src="${photoThumb(c.photos[0], 48, 36)}" alt="${c.make} ${c.model}" loading="lazy" />`
      : html`<div class="inventory-thumb-placeholder">🚗</div>`;
    return html`
      <tr>
        <td>${thumb}</td>
        <td>${c.make}</td>
        <td>${c.model}${c.trim ? html` <span class="inventory-trim">${c.trim}</span>` : ''}</td>
        <td>${c.year}</td>
        <td>${c.stockNumber || '-'}</td>
        <td>${c.mileage.toLocaleString()}</td>
        <td>$${c.price.toLocaleString()}</td>
        <td><span class="badge ${c.status}">${c.status}</span></td>
        <td class="key-status">${keyStatusHtml(c.id)}</td>
        <td>${c.status === 'sold' ? '-' : daysListed}</td>
        <td class="row-actions">
          <button onclick="editCar(${js(c.id)})">Edit</button>
          <button class="delete" onclick="deleteCar(${js(c.id)})">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

document.getElementById('carSearch').addEventListener('input', renderCars);
document.getElementById('statusFilter').addEventListener('change', renderCars);

// ---------- Leads table ----------

function renderLeads() {
  const statusFilter = document.getElementById('leadStatusFilter').value;
  let filtered = leads.filter(l =>
    (!statusFilter || l.status === statusFilter) && (!leadsListFilter || leadsListFilter.ids.has(l.id)));

  document.getElementById('leadTableBody').innerHTML = filtered.map(l => {
    const car = cars.find(c => c.id === l.carId);
    const carLabel = car ? `${car.year} ${car.make} ${car.model}` : '-';
    const followUpFlag = needsFollowUp(l) ? html`<span class="followup-badge">Needs Follow-Up</span>` : '';
    return html`
      <tr>
        <td><button class="deal-number-link" onclick="openLeadProfile(${js(l.id)})">${l.name}</button></td>
        <td><span class="badge ${l.type === 'business' ? 'finalized' : 'working'}">${l.type === 'business' ? 'Business' : 'Individual'}</span></td>
        <td>${l.phone || l.email || '-'}</td>
        <td>${formatSource(l.source)}</td>
        <td>${carLabel}</td>
        <td><span class="badge ${l.status}">${l.status}</span>${followUpFlag}</td>
        <td>${l.notes || ''}</td>
        <td class="row-actions">
          <button onclick="editLead(${js(l.id)})">Edit</button>
          <button class="delete" onclick="deleteLead(${js(l.id)})">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

function formatSource(source) {
  const labels = {
    'walk-in': 'Walk-in', 'phone': 'Phone', 'website': 'Website',
    'referral': 'Referral', 'autotrader': 'Autotrader', 'cargurus': 'CarGurus',
    'facebook': 'Facebook', 'other': 'Other'
  };
  return labels[source] || 'Other';
}

document.getElementById('leadStatusFilter').addEventListener('change', renderLeads);

// ---------- Leads pipeline (Kanban board) ----------

const LEAD_PIPELINE_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'negotiating', label: 'Negotiating' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' }
];

document.getElementById('leadsViewTableBtn').addEventListener('click', () => setLeadsView('table'));
document.getElementById('leadsViewKanbanBtn').addEventListener('click', () => setLeadsView('kanban'));

function setLeadsView(view) {
  document.getElementById('leadsTableView').style.display = view === 'table' ? 'block' : 'none';
  document.getElementById('leadsKanbanView').style.display = view === 'kanban' ? 'flex' : 'none';
  document.getElementById('leadStatusFilter').style.display = view === 'table' ? 'inline-block' : 'none';
  document.getElementById('leadsViewTableBtn').classList.toggle('active', view === 'table');
  document.getElementById('leadsViewKanbanBtn').classList.toggle('active', view === 'kanban');
}

function renderLeadsKanban() {
  const board = document.getElementById('leadsKanbanView');

  board.innerHTML = LEAD_PIPELINE_STAGES.map(stage => {
    const stageLeads = leads.filter(l => l.status === stage.key && (!leadsListFilter || leadsListFilter.ids.has(l.id)));
    return html`
      <div class="kanban-column" data-status="${stage.key}">
        <div class="kanban-column-header"><span>${stage.label}</span><span>${stageLeads.length}</span></div>
        <div class="kanban-column-body">
          ${stageLeads.map(l => {
            const car = cars.find(c => c.id === l.carId);
            const followUpFlag = needsFollowUp(l) ? html`<span class="followup-badge">Follow-up</span>` : '';
            return html`
              <div class="kanban-card" draggable="true" data-lead-id="${l.id}">
                <button class="kanban-card-name" onclick="openLeadProfile(${js(l.id)})">${l.name}</button>
                <div class="kanban-card-meta">${car ? `${car.year} ${car.make} ${car.model}` : 'No vehicle linked'}</div>
                <div class="kanban-card-meta">${formatSource(l.source)}${followUpFlag}</div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }).join('');

  wireKanbanDragAndDrop();
}

function wireKanbanDragAndDrop() {
  document.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.leadId);
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  document.querySelectorAll('.kanban-column').forEach(column => {
    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => {
      column.classList.remove('drag-over');
    });
    column.addEventListener('drop', async (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const leadId = e.dataTransfer.getData('text/plain');
      const newStatus = column.dataset.status;
      const lead = leads.find(l => l.id === leadId);
      if (!lead || lead.status === newStatus) return;

      await fetch(`${API}/leads/${leadId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      await loadAll();
    });
  });
}

// Relabel "Name" -> "Business Name" when Business is selected, since a
// business lead doesn't have a first/last name the way a person does.
document.getElementById('leadType').addEventListener('change', updateLeadNameLabel);
function updateLeadNameLabel() {
  const type = document.getElementById('leadType').value;
  const label = document.querySelector('label[for="leadNameLabel"]') || document.getElementById('leadNameLabelText');
  if (label) label.textContent = type === 'business' ? 'Business Name' : 'Name';
}

function populateLeadCarOptions() {
  const select = document.getElementById('leadCarId');
  const current = select.value;
  select.innerHTML = '<option value="">-- None --</option>' + cars
    .filter(c => c.status !== 'sold')
    .map(c => html`<option value="${c.id}">${c.year} ${c.make} ${c.model}</option>`)
    .join('');
  select.value = current;
}

// ---------- Key status (from the key machine) ----------
// The key machine (KeyTrak etc.) reports check-outs and check-ins; this
// just shows them. A key out longer than this is highlighted.
const KEY_OVERDUE_MINUTES = 120;

function formatKeyTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function keyStatusHtml(carId) {
  const carKeys = vehicleKeys.filter(k => k.carId === carId);
  if (!carKeys.length) return html`<span class="key-none">—</span>`;
  const several = carKeys.length > 1;
  return carKeys.map(k => {
    const name = several ? `${k.label}: ` : '';
    if (k.status === 'out') {
      const minutesOut = (Date.now() - new Date(k.statusSince)) / 60000;
      const overdue = minutesOut > KEY_OVERDUE_MINUTES;
      const text = `${name}${k.holderName || 'Out'} · ${formatKeyTime(k.statusSince)}`;
      return html`<div class="${overdue ? 'key-overdue' : 'key-out'}" title="${text}${overdue ? ' (out longer than 2 hours)' : ''}">🔑 ${text}</div>`;
    }
    if (k.status === 'missing') return html`<div class="key-missing">🔑 ${name}Missing</div>`;
    return html`<div class="key-in">🔑 ${name}In${k.slot ? ` · slot ${k.slot}` : ''}</div>`;
  });
}

// Keep key status current without reloading: check every 30 seconds while
// the page is open in front of someone.
async function refreshKeys() {
  if (document.hidden || !currentUser) return;
  const res = await fetch(`${API}/keys`);
  if (!res.ok) return;
  vehicleKeys = await res.json();
  renderCars();
  renderPipelineTiles();
  renderRail();
}
setInterval(refreshKeys, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshKeys(); });

// ---------- Sales Pipeline (home screen) ----------
// Every open customer sits in exactly one stage, from how far along they
// are: Engaged (in contact) -> Visit (came to the showroom) -> Proposal
// (a deal is being worked) -> Delivered (bought -- a delivered/closed deal,
// or marked Won). Lost customers aren't in the pipeline.

const ICONS = {
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  calc: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8.5 6.5h7v3h-7z"/><path d="M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21.5V4"/><path d="M5 4.5h11l-2 3.5 2 3.5H5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6 1.6 0 3 .5 4.1 1.3"/><path d="M18.5 13v7M15 16.5h7"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 4l7 8-7 8M12 4l7 8-7 8"/></svg>'
};

const PIPELINE_STAGES = [
  { key: 'engaged', label: 'Engaged', icon: ICONS.chat },
  { key: 'visit', label: 'Visit', icon: ICONS.pin },
  { key: 'proposal', label: 'Proposal', icon: ICONS.calc },
  { key: 'delivered', label: 'Delivered', icon: ICONS.flag }
];
const AGED_INVENTORY_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function pipelineStageOf(lead) {
  const leadDeals = deals.filter(d => d.leadId === lead.id);
  if (lead.status === 'won' || leadDeals.some(d => ['delivered', 'closed', 'finalized'].includes(d.status))) return 'delivered';
  if (lead.status === 'lost') return null;
  if (leadDeals.some(d => d.status === 'working')) return 'proposal';
  if ((lead.activities || []).some(a => a.type === 'visit')) return 'visit';
  return 'engaged';
}

function lastTouch(lead) {
  const activities = lead.activities || [];
  return new Date(activities.length ? activities[0].date : lead.dateAdded);
}

const isHot = lead => Date.now() - lastTouch(lead) < DAY_MS;
const isToday = iso => new Date(iso).toDateString() === new Date().toDateString();

// Customers in the pipeline after the Source / "Customers added" filters.
function pipelineLeads() {
  const source = document.getElementById('pipelineSourceFilter').value;
  const period = document.getElementById('pipelinePeriodFilter').value;
  const now = new Date();
  return leads.filter(l => {
    if (source && l.source !== source) return false;
    const added = new Date(l.dateAdded);
    if (period === 'today') return isToday(l.dateAdded);
    if (period === 'week') return now - added < 7 * DAY_MS;
    if (period === 'month') return added.getFullYear() === now.getFullYear() && added.getMonth() === now.getMonth();
    if (period === '30' || period === '90') return now - added < Number(period) * DAY_MS;
    return true;
  });
}

function stageGroups() {
  const groups = Object.fromEntries(PIPELINE_STAGES.map(st => [st.key, []]));
  for (const lead of pipelineLeads()) {
    const stage = pipelineStageOf(lead);
    if (stage) groups[stage].push(lead);
  }
  return groups;
}

function renderPipeline() {
  const groups = stageGroups();
  document.getElementById('pipelineStages').innerHTML = PIPELINE_STAGES.map((st, i) => {
    const list = groups[st.key];
    const attention = list.filter(needsFollowUp).length;
    const hot = list.filter(isHot).length;
    const open = st.key !== 'delivered';
    return html`
      ${i > 0 ? html`<div class="pipeline-chevron ${i === PIPELINE_STAGES.length - 1 ? 'into-delivered' : ''}" aria-hidden="true">${new SafeHtml(ICONS.chevron)}</div>` : ''}
      <div class="pipeline-stage stage-${st.key}">
        <div class="pipeline-stage-icon">${new SafeHtml(st.icon)}</div>
        <button type="button" class="pipeline-count" onclick="openPipelineList(${js(st.key)}, 'all')" title="Show these customers">${list.length.toLocaleString()}</button>
        <div class="pipeline-stage-label">${st.label}</div>
        <div class="pipeline-stage-sub">
          ${open ? html`
            <button type="button" class="pipeline-sub attention" onclick="openPipelineList(${js(st.key)}, 'attention')" title="Need follow-up: no contact in 3+ days">⚠ ${attention}</button>
            <button type="button" class="pipeline-sub hot" onclick="openPipelineList(${js(st.key)}, 'hot')" title="Hot: activity in the last 24 hours">🔥 ${hot}</button>`
          : html`<span class="pipeline-sub muted">bought</span>`}
        </div>
      </div>`;
  }).join('');
  renderPipelineTiles();
}

window.openPipelineList = function(stageKey, kind) {
  const stage = PIPELINE_STAGES.find(st => st.key === stageKey);
  let list = stageGroups()[stageKey];
  let label = stage.label;
  if (kind === 'attention') { list = list.filter(needsFollowUp); label += ' · needs follow-up'; }
  if (kind === 'hot') { list = list.filter(isHot); label += ' · hot'; }
  setLeadsListFilter(label, list.map(l => l.id));
  showView('leads');
};

// Store-wide counts used by the tiles and the left rail. Each one knows
// how to open the list behind its number.
function attentionCounts() {
  const followUp = leads.filter(needsFollowUp);
  const newToday = leads.filter(l => isToday(l.dateAdded));
  const keysOutCarIds = new Set(vehicleKeys.filter(k => k.status === 'out').map(k => k.carId));
  const keysOut = cars.filter(c => keysOutCarIds.has(c.id));
  const aged = cars.filter(c => c.status !== 'sold' && (Date.now() - new Date(c.dateAdded)) / DAY_MS >= AGED_INVENTORY_DAYS);
  const proposals = deals.filter(d => d.status === 'working');
  return [
    { key: 'followup', label: 'Follow-Up Due', icon: ICONS.bell, color: 'amber', count: followUp.length,
      open: () => { setLeadsListFilter('Follow-up due', followUp.map(l => l.id)); showView('leads'); } },
    { key: 'newtoday', label: 'New Today', icon: ICONS.userPlus, color: 'blue', count: newToday.length,
      open: () => { setLeadsListFilter('New today', newToday.map(l => l.id)); showView('leads'); } },
    { key: 'proposals', label: 'Open Proposals', icon: ICONS.calc, color: 'violet', count: proposals.length, railOnly: true,
      open: () => { showView('deals'); document.getElementById('dealStatusFilter').value = 'working'; renderDeals(); } },
    { key: 'keysout', label: 'Keys Out', icon: ICONS.key, color: 'teal', count: keysOut.length,
      open: () => { setInventoryListFilter('Keys out', keysOut.map(c => c.id)); showView('inventory'); } },
    { key: 'aged', label: `Aged Inventory (${AGED_INVENTORY_DAYS}+ days)`, icon: ICONS.clock, color: 'red', count: aged.length,
      open: () => { setInventoryListFilter(`On the lot ${AGED_INVENTORY_DAYS}+ days`, aged.map(c => c.id)); showView('inventory'); } }
  ];
}

window.openAttention = function(key) {
  const item = attentionCounts().find(a => a.key === key);
  if (item) item.open();
};

function renderPipelineTiles() {
  document.getElementById('pipelineTiles').innerHTML = attentionCounts().filter(a => !a.railOnly).map(a => html`
    <button type="button" class="pipeline-tile" onclick="openAttention(${js(a.key)})">
      <span class="pipeline-tile-icon tile-${a.color}">${new SafeHtml(a.icon)}</span>
      <span class="pipeline-tile-text"><strong>${a.count.toLocaleString()}</strong><span>${a.label}</span></span>
    </button>`).join('');
}

function renderRail() {
  document.getElementById('appRail').innerHTML = attentionCounts().map(a => html`
    <button type="button" class="rail-item" onclick="openAttention(${js(a.key)})" title="${a.label}: ${a.count}" aria-label="${a.label}: ${a.count}">
      ${new SafeHtml(a.icon)}
      ${a.count ? html`<span class="rail-badge rail-${a.color}">${a.count > 99 ? '99+' : a.count}</span>` : ''}
    </button>`).join('');
}

document.getElementById('pipelineSourceFilter').addEventListener('change', renderPipeline);
document.getElementById('pipelinePeriodFilter').addEventListener('change', renderPipeline);

// ---------- Filtered lists ----------
// Clicking a number (a pipeline stage, a tile, a rail badge) opens the
// Customers or Inventory list showing exactly those records, with a chip
// that says what's filtered and an x to show everything again.

let leadsListFilter = null;     // { label, ids: Set }
let inventoryListFilter = null;

function renderFilterChip(elementId, filter, clearFnName) {
  const chip = document.getElementById(elementId);
  chip.style.display = filter ? 'inline-flex' : 'none';
  chip.innerHTML = filter
    ? html`Showing: <strong>${filter.label}</strong> (${filter.ids.size}) <button type="button" onclick="${new SafeHtml(clearFnName)}()" title="Show all" aria-label="Clear filter">✕</button>`
    : '';
}

function setLeadsListFilter(label, ids) {
  leadsListFilter = { label, ids: new Set(ids) };
  document.getElementById('leadStatusFilter').value = '';
  renderFilterChip('leadsFilterChip', leadsListFilter, 'clearLeadsListFilter');
  renderLeads();
  renderLeadsKanban();
}

function clearLeadsListFilter(rerender = true) {
  leadsListFilter = null;
  renderFilterChip('leadsFilterChip', null);
  if (rerender) { renderLeads(); renderLeadsKanban(); }
}
window.clearLeadsListFilter = clearLeadsListFilter;

function setInventoryListFilter(label, ids) {
  inventoryListFilter = { label, ids: new Set(ids) };
  document.getElementById('carSearch').value = '';
  document.getElementById('statusFilter').value = '';
  renderFilterChip('inventoryFilterChip', inventoryListFilter, 'clearInventoryListFilter');
  renderCars();
}

function clearInventoryListFilter(rerender = true) {
  inventoryListFilter = null;
  renderFilterChip('inventoryFilterChip', null);
  if (rerender) renderCars();
}
window.clearInventoryListFilter = clearInventoryListFilter;

// ---------- Quick search (top bar) ----------
// Finds customers (name, phone, email), deals (deal #), and vehicles
// (stock #, VIN, year/make/model) as you type. Press "/" to jump here.

const quickSearchInput = document.getElementById('quickSearchInput');
const quickSearchResultsEl = document.getElementById('quickSearchResults');
let quickResults = [];
let quickActive = 0;

const digitsOnly = v => String(v || '').replace(/\D/g, '');

function quickSearch(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const qDigits = digitsOnly(q);
  const results = [];

  for (const l of leads) {
    const phoneMatch = qDigits.length >= 3 && digitsOnly(l.phone).includes(qDigits);
    if (l.name.toLowerCase().includes(q) || (l.email || '').toLowerCase().includes(q) || phoneMatch) {
      results.push({ type: 'Customer', title: l.name, sub: [l.phone, l.email].filter(Boolean).join(' · '), run: () => openLeadProfile(l.id) });
    }
  }
  for (const d of deals) {
    const lead = leads.find(l => l.id === d.leadId);
    if (`d-${d.dealNumber}`.includes(q) || (qDigits && String(d.dealNumber).includes(qDigits) && qDigits.length >= 3)) {
      results.push({ type: 'Deal', title: `D-${d.dealNumber}`, sub: lead ? lead.name : 'No customer yet', run: () => openDealWorkspace(d.id) });
    }
  }
  for (const c of cars) {
    const label = [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ');
    if ((c.stockNumber || '').toLowerCase().includes(q) || (c.vin || '').toLowerCase().includes(q) || label.toLowerCase().includes(q)) {
      results.push({
        type: 'Vehicle', title: label, sub: [c.stockNumber && `Stock ${c.stockNumber}`, c.vin].filter(Boolean).join(' · '),
        run: () => {
          if (userCan('editInventory')) return editCar(c.id);
          clearInventoryListFilter(false);
          document.getElementById('carSearch').value = c.stockNumber || c.vin || c.model;
          showView('inventory');
          renderCars();
        }
      });
    }
  }
  return results.slice(0, 12);
}

function renderQuickResults() {
  if (!quickSearchInput.value.trim() || document.activeElement !== quickSearchInput) {
    quickSearchResultsEl.classList.remove('open');
    return;
  }
  quickSearchResultsEl.classList.add('open');
  quickSearchResultsEl.innerHTML = quickResults.length
    ? quickResults.map((r, i) => html`
        <button type="button" class="quick-result ${i === quickActive ? 'active' : ''}" data-index="${i}" role="option">
          <span class="quick-result-type">${r.type}</span>
          <span class="quick-result-main"><strong>${r.title}</strong>${r.sub ? html`<span>${r.sub}</span>` : ''}</span>
        </button>`).join('')
    : html`<div class="quick-empty">No matches</div>`;
}

function runQuickResult(index) {
  const result = quickResults[index];
  if (!result) return;
  quickSearchInput.value = '';
  quickSearchInput.blur();
  quickResults = [];
  renderQuickResults();
  result.run();
}

quickSearchInput.addEventListener('input', () => {
  quickResults = quickSearch(quickSearchInput.value);
  quickActive = 0;
  renderQuickResults();
});
quickSearchInput.addEventListener('focus', renderQuickResults);
quickSearchInput.addEventListener('blur', () => setTimeout(renderQuickResults, 150));
quickSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { quickActive = Math.min(quickActive + 1, quickResults.length - 1); renderQuickResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { quickActive = Math.max(quickActive - 1, 0); renderQuickResults(); e.preventDefault(); }
  if (e.key === 'Enter') { runQuickResult(quickActive); e.preventDefault(); }
  if (e.key === 'Escape') { quickSearchInput.value = ''; quickSearchInput.blur(); }
});
// mousedown (not click) so it fires before the input's blur hides the list.
quickSearchResultsEl.addEventListener('mousedown', (e) => {
  const item = e.target.closest('.quick-result');
  if (item) { e.preventDefault(); runQuickResult(Number(item.dataset.index)); }
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (e.key === '/' && !typing) { e.preventDefault(); quickSearchInput.focus(); }
});

document.getElementById('newCustomerBtn').addEventListener('click', () => {
  document.getElementById('addLeadBtn').click();
});

// ---------- Photo thumbnails ----------
// Photos stored in Cloudinary can be resized on the fly by adding a size
// to the URL, so lists load small thumbnails instead of full-size photos.
// (Photos stored on the server's own disk are shown as-is.)
function photoThumb(url, width, height) {
  if (!/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url)) return url;
  // Double size for sharp results on high-resolution (retina) screens.
  return url.replace('/image/upload/', `/image/upload/c_fill,w_${width * 2},h_${height * 2},q_auto,f_auto/`);
}

// ---------- VIN decoder ----------
// Used by the car form and the deal's trade-in section. Looks the VIN up
// in NHTSA's database (through our server) and fills in the fields.

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
const cleanVin = value => value.toUpperCase().replace(/[\s-]/g, '');

// [car record field, form input id] for the details the decoder can fill.
const CAR_DETAIL_INPUTS = [
  ['trim', 'carTrim'], ['bodyStyle', 'carBodyStyle'], ['drivetrain', 'carDrivetrain'],
  ['engine', 'carEngine'], ['transmission', 'carTransmission'], ['fuelType', 'carFuelType'],
  ['exteriorColor', 'carExteriorColor'], ['interiorColor', 'carInteriorColor']
];

async function decodeVinInto({ inputId, statusId, excludeCarId, fill }) {
  const input = document.getElementById(inputId);
  const statusEl = document.getElementById(statusId);
  const vin = cleanVin(input.value);
  input.value = vin;
  if (!VIN_PATTERN.test(vin)) {
    statusEl.innerHTML = html`<div class="err">A VIN is 17 letters and numbers (never I, O, or Q).</div>`;
    return;
  }

  statusEl.innerHTML = html`<div>Looking up VIN...</div>`;
  try {
    const query = excludeCarId ? `?excludeCarId=${encodeURIComponent(excludeCarId)}` : '';
    const res = await fetch(`${API}/vin/${vin}${query}`);
    const data = await res.json();
    if (cleanVin(input.value) !== vin) return; // they changed the VIN while we were looking it up
    if (!res.ok) {
      statusEl.innerHTML = html`<div class="err">${data.error || 'Could not decode this VIN.'}</div>`;
      return;
    }

    fill(data);
    const summary = [data.year, data.make, data.model, data.trim].filter(Boolean).join(' ');
    const specs = [data.bodyStyle, data.engine, data.drivetrain].filter(Boolean).join(' · ');
    statusEl.innerHTML = html`
      <div class="ok">✓ ${summary}${specs ? html` <span class="audit-note">(${specs})</span>` : ''}</div>
      ${data.warnings.map(w => html`<div class="warn">⚠️ ${w}</div>`)}
      ${data.inInventory ? html`<div class="warn">⚠️ This VIN is already in inventory: ${data.inInventory.label} -- ${data.inInventory.status}.</div>` : ''}
    `;
  } catch (err) {
    statusEl.innerHTML = html`<div class="err">Could not reach the server.</div>`;
  }
}

function fillCarFormFromVin(data) {
  const set = (id, value) => { if (value) document.getElementById(id).value = value; };
  set('carYear', data.year);
  set('carMake', data.make);
  set('carModel', data.model);
  for (const [field, inputId] of CAR_DETAIL_INPUTS) set(inputId, data[field]);
  set('carDoors', data.doors);
}

function decodeCarVin() {
  return decodeVinInto({
    inputId: 'carVin',
    statusId: 'carVinStatus',
    excludeCarId: document.getElementById('carId').value || null,
    fill: fillCarFormFromVin
  });
}

document.getElementById('decodeCarVinBtn').addEventListener('click', decodeCarVin);

// When adding a car, decode as soon as a full VIN is typed or pasted.
// (When editing, only on the button, so it never overwrites edits.)
document.getElementById('carVin').addEventListener('input', (e) => {
  const isNewCar = !document.getElementById('carId').value;
  if (isNewCar && VIN_PATTERN.test(cleanVin(e.target.value))) decodeCarVin();
});

document.getElementById('decodeTradeVinBtn').addEventListener('click', () => decodeVinInto({
  inputId: 'dealTradeVin',
  statusId: 'dealTradeVinStatus',
  fill: data => {
    if (data.year) document.getElementById('dealTradeYear').value = data.year;
    if (data.make) document.getElementById('dealTradeMake').value = data.make;
    if (data.model) document.getElementById('dealTradeModel').value = [data.model, data.trim].filter(Boolean).join(' ');
  }
}));

// ---------- Car modal ----------

const carModal = document.getElementById('carModal');

document.getElementById('addCarBtn').addEventListener('click', () => {
  document.getElementById('carModalTitle').textContent = 'Add Car';
  document.getElementById('carForm').reset();
  document.getElementById('carId').value = '';
  document.getElementById('carDoors').value = '';
  document.getElementById('carVinStatus').innerHTML = '';
  setCarPhotosMode(false);
  document.getElementById('carPhotoCount').textContent = '';
  updateCarGross();
  carModal.classList.add('active');
});

document.getElementById('cancelCarBtn').addEventListener('click', () => {
  carModal.classList.remove('active');
});

window.editCar = function(id) {
  const car = cars.find(c => c.id === id);
  document.getElementById('carModalTitle').textContent =
    `Edit Car -- ${[car.year, car.make, car.model, car.trim].filter(Boolean).join(' ')}`;
  document.getElementById('carId').value = car.id;
  document.getElementById('carMake').value = car.make;
  document.getElementById('carModel').value = car.model;
  document.getElementById('carYear').value = car.year;
  document.getElementById('carVin').value = car.vin || '';
  document.getElementById('carVinStatus').innerHTML = '';
  for (const [field, inputId] of CAR_DETAIL_INPUTS) {
    document.getElementById(inputId).value = car[field] || '';
  }
  document.getElementById('carDoors').value = car.doors || '';
  document.getElementById('carStockNumber').value = car.stockNumber || '';
  document.getElementById('carMileage').value = car.mileage;
  document.getElementById('carCost').value = car.cost;
  document.getElementById('carPrice').value = car.price;
  document.getElementById('carStatus').value = car.status;
  updateCarGross();

  // Photos can only be attached to a car that already exists (it needs
  // an id to upload against), so this section is Edit-only.
  setCarPhotosMode(true);
  document.getElementById('carPhotoInput').value = '';
  document.getElementById('carPhotoUploadStatus').innerHTML = '';
  renderCarPhotoGrid(car);

  carModal.classList.add('active');
};

// Photos need a saved car to attach to, so a new car shows a note instead.
function setCarPhotosMode(isExistingCar) {
  document.getElementById('carPhotosSection').style.display = isExistingCar ? 'block' : 'none';
  document.getElementById('carPhotosNewCarNote').style.display = isExistingCar ? 'none' : 'block';
}

// Live "gross profit" readout under the pricing row: asking price - cost.
function updateCarGross() {
  const price = Number(document.getElementById('carPrice').value);
  const cost = Number(document.getElementById('carCost').value);
  const el = document.getElementById('carGross');
  if (!price || !cost) {
    el.innerHTML = '';
    return;
  }
  const gross = price - cost;
  const margin = Math.round((gross / price) * 100);
  el.innerHTML = html`Gross profit at asking price: <strong class="${gross < 0 ? 'negative' : ''}">${gross < 0 ? '-' : ''}$${Math.abs(gross).toLocaleString()}</strong> (${margin}%)`;
}
document.getElementById('carPrice').addEventListener('input', updateCarGross);
document.getElementById('carCost').addEventListener('input', updateCarGross);

function renderCarPhotoGrid(car) {
  const grid = document.getElementById('carPhotoGrid');
  const photos = car.photos || [];
  document.getElementById('carPhotoCount').textContent = photos.length ? `(${photos.length})` : '';
  if (photos.length === 0) {
    grid.innerHTML = `<p style="font-size:13px;color:var(--text-muted);">No photos yet.</p>`;
    return;
  }
  grid.innerHTML = photos.map(p => html`
    <div class="photo-thumb">
      <img src="${photoThumb(p, 160, 160)}" alt="Car photo" loading="lazy" />
      <button type="button" class="photo-delete-btn" onclick="deleteCarPhoto(${js(car.id)}, ${js(p)})">×</button>
    </div>
  `).join('');
}

document.getElementById('uploadCarPhotosBtn').addEventListener('click', async () => {
  const carId = document.getElementById('carId').value;
  const fileInput = document.getElementById('carPhotoInput');
  const statusEl = document.getElementById('carPhotoUploadStatus');
  if (!fileInput.files || fileInput.files.length === 0) return;

  const formData = new FormData();
  for (const file of fileInput.files) {
    formData.append('photos', file);
  }

  statusEl.innerHTML = `<div style="font-size:13px;color:var(--text-muted);">Uploading...</div>`;

  try {
    const res = await fetch(`${API}/cars/${carId}/photos`, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      statusEl.innerHTML = html`<div class="send-text-status-error">${data.error}</div>`;
      return;
    }

    statusEl.innerHTML = '';
    fileInput.value = '';
    await loadAll();
    const car = cars.find(c => c.id === carId);
    if (car) renderCarPhotoGrid(car);
  } catch (err) {
    statusEl.innerHTML = `<div class="send-text-status-error">Upload failed. Is the server running?</div>`;
  }
});

window.deleteCarPhoto = async function(carId, photoPath) {
  if (!confirm('Remove this photo?')) return;
  await fetch(`${API}/cars/${carId}/photos`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photoPath })
  });
  await loadAll();
  const car = cars.find(c => c.id === carId);
  if (car) renderCarPhotoGrid(car);
};

window.deleteCar = async function(id) {
  if (!confirm('Delete this car from inventory?')) return;
  await fetch(`${API}/cars/${id}`, { method: 'DELETE' });
  await loadAll();
};

document.getElementById('carForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('carId').value;
  const payload = {
    make: document.getElementById('carMake').value,
    model: document.getElementById('carModel').value,
    year: document.getElementById('carYear').value,
    vin: document.getElementById('carVin').value,
    ...Object.fromEntries(CAR_DETAIL_INPUTS.map(([field, inputId]) => [field, document.getElementById(inputId).value])),
    doors: document.getElementById('carDoors').value,
    stockNumber: document.getElementById('carStockNumber').value,
    mileage: document.getElementById('carMileage').value,
    cost: document.getElementById('carCost').value,
    price: document.getElementById('carPrice').value,
    status: document.getElementById('carStatus').value,
  };

  if (id) {
    await fetch(`${API}/cars/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    await fetch(`${API}/cars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  carModal.classList.remove('active');
  await loadAll();
});

// ---------- Lead modal ----------

const leadModal = document.getElementById('leadModal');

document.getElementById('addLeadBtn').addEventListener('click', () => {
  document.getElementById('leadModalTitle').textContent = 'Add Lead';
  document.getElementById('leadForm').reset();
  document.getElementById('leadId').value = '';
  document.getElementById('leadType').value = 'individual';
  updateLeadNameLabel();
  leadModal.classList.add('active');
});

document.getElementById('cancelLeadBtn').addEventListener('click', () => {
  leadModal.classList.remove('active');
});

window.editLead = function(id) {
  const lead = leads.find(l => l.id === id);
  document.getElementById('leadModalTitle').textContent = 'Edit Lead';
  document.getElementById('leadId').value = lead.id;
  document.getElementById('leadType').value = lead.type || 'individual';
  updateLeadNameLabel();
  document.getElementById('leadName').value = lead.name;
  document.getElementById('leadPhone').value = lead.phone;
  document.getElementById('leadEmail').value = lead.email;
  document.getElementById('leadSource').value = lead.source || 'other';
  document.getElementById('leadCarId').value = lead.carId || '';
  document.getElementById('leadStatus').value = lead.status;
  document.getElementById('leadNotes').value = lead.notes;
  leadModal.classList.add('active');
};

window.deleteLead = async function(id) {
  if (!confirm('Delete this lead?')) return;
  await fetch(`${API}/leads/${id}`, { method: 'DELETE' });
  await loadAll();
};

document.getElementById('leadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('leadId').value;
  const payload = {
    name: document.getElementById('leadName').value,
    type: document.getElementById('leadType').value,
    phone: document.getElementById('leadPhone').value,
    email: document.getElementById('leadEmail').value,
    source: document.getElementById('leadSource').value,
    carId: document.getElementById('leadCarId').value || null,
    status: document.getElementById('leadStatus').value,
    notes: document.getElementById('leadNotes').value,
  };

  if (id) {
    await fetch(`${API}/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    await fetch(`${API}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  leadModal.classList.remove('active');
  await loadAll();

  // If this edit was launched from the lead profile, hop back to it
  // afterward instead of just closing, so the flow feels continuous.
  if (returnToProfileAfterEdit) {
    returnToProfileAfterEdit = false;
    openLeadProfile(id);
  }
});

// ---------- Lead Profile (activity log + related deals) ----------

let returnToProfileAfterEdit = false;
let currentProfileLeadId = null;
const leadProfileModal = document.getElementById('leadProfileModal');

const ACTIVITY_ICONS = { call: '📞', text: '💬', email: '✉️', note: '📝', visit: '🏢' };
const ACTIVITY_LABELS = { call: 'Call', text: 'Text', email: 'Email', note: 'Note', visit: 'Showroom Visit' };

window.openLeadProfile = function(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  currentProfileLeadId = leadId;

  document.getElementById('profileName').textContent = lead.name;
  document.getElementById('profileBadges').innerHTML = html`
    <span class="badge ${lead.type === 'business' ? 'finalized' : 'working'}">${lead.type === 'business' ? 'Business' : 'Individual'}</span>
    <span class="badge ${lead.status}">${lead.status}</span>
  `;

  const car = cars.find(c => c.id === lead.carId);
  document.getElementById('profileInfoGrid').innerHTML = html`
    <div class="info-item"><div class="label">Phone</div><div class="value">${lead.phone || '-'}</div></div>
    <div class="info-item"><div class="label">Email</div><div class="value">${lead.email || '-'}</div></div>
    <div class="info-item"><div class="label">Source</div><div class="value">${formatSource(lead.source)}</div></div>
    <div class="info-item"><div class="label">Interested In</div><div class="value">${car ? `${car.year} ${car.make} ${car.model}` : '-'}</div></div>
    <div class="info-item"><div class="label">Added</div><div class="value">${new Date(lead.dateAdded).toLocaleDateString()}</div></div>
    <div class="info-item"><div class="label">Notes</div><div class="value">${lead.notes || '-'}</div></div>
  `;

  renderProfileDeals(lead);
  renderActivityLog(lead);

  const suggestionBox = document.getElementById('aiSuggestionBox');
  suggestionBox.style.display = 'none';
  suggestionBox.innerHTML = '';

  const snapshotBox = document.getElementById('aiSnapshotBox');
  snapshotBox.style.display = 'none';
  snapshotBox.innerHTML = '';

  document.getElementById('sendTextInput').value = '';
  document.getElementById('sendTextStatus').innerHTML = '';
  renderSendTextPhotoPicker(car);

  leadProfileModal.classList.add('active');
};

let selectedSendTextPhoto = null;

function renderSendTextPhotoPicker(car) {
  selectedSendTextPhoto = null;
  const container = document.getElementById('sendTextPhotoPicker');

  if (!car || !car.photos || car.photos.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = html`
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Attach a photo of the ${car.year} ${car.make} ${car.model} (optional):</div>
    <div class="photo-picker-grid">
      ${car.photos.map(p => html`<img src="${photoThumb(p, 56, 42)}" class="photo-picker-thumb" data-photo="${p}" onclick="toggleSendTextPhoto(this)" loading="lazy" />`)}
    </div>
  `;
}

window.toggleSendTextPhoto = function(imgEl) {
  const photo = imgEl.dataset.photo;
  const alreadySelected = selectedSendTextPhoto === photo;
  document.querySelectorAll('.photo-picker-thumb').forEach(el => el.classList.remove('selected'));
  if (alreadySelected) {
    selectedSendTextPhoto = null;
  } else {
    selectedSendTextPhoto = photo;
    imgEl.classList.add('selected');
  }
};

function renderProfileDeals(lead) {
  const relatedDeals = deals.filter(d => d.leadId === lead.id);
  const listEl = document.getElementById('profileDealsList');
  const noCarNotice = document.getElementById('profileNoCarNotice');
  const createBtn = document.getElementById('profileCreateDealBtn');

  if (relatedDeals.length === 0) {
    listEl.innerHTML = `<p class="no-deals-note">No deals yet for this customer.</p>`;
  } else {
    listEl.innerHTML = relatedDeals.map(d => {
      const car = cars.find(c => c.id === d.carId);
      return html`
        <div class="related-deal-row">
          <span><button class="deal-number-link" onclick="closeProfileAndOpenDeal(${js(d.id)})">D-${d.dealNumber}</button> -- ${car ? `${car.year} ${car.make} ${car.model}` : 'Unknown vehicle'}</span>
          <span class="badge ${d.status}">${DEAL_STATUS_LABELS[d.status] || d.status}</span>
        </div>
      `;
    }).join('');
  }

  // Creating a deal needs a vehicle. If the lead already has one attached,
  // skip straight to it; otherwise let the create button fall back to the
  // full picker on the Deals tab instead of guessing a vehicle for them.
  if (lead.carId && cars.find(c => c.id === lead.carId && c.status !== 'sold')) {
    noCarNotice.style.display = 'none';
    createBtn.style.display = 'inline-block';
    createBtn.onclick = () => createDealFromProfile(lead.id, lead.carId);
  } else {
    noCarNotice.style.display = 'block';
    noCarNotice.innerHTML = `<p class="no-car-note">This customer isn't linked to an available vehicle yet -- set "Interested Car" via Edit Details, or use "+ Create Deal" on the Deals tab to pick one.</p>`;
    createBtn.style.display = 'none';
  }
}

async function createDealFromProfile(leadId, carId) {
  const res = await fetch(`${API}/deals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, carId })
  });
  const newDeal = await res.json();
  leadProfileModal.classList.remove('active');
  await loadAll();
  openDealWorkspace(newDeal.id);
}

window.closeProfileAndOpenDeal = function(dealId) {
  leadProfileModal.classList.remove('active');
  openDealWorkspace(dealId);
};

function renderActivityLog(lead) {
  const activities = lead.activities || [];
  const listEl = document.getElementById('activityLogList');

  if (activities.length === 0) {
    listEl.innerHTML = `<p class="no-deals-note">No calls, texts, or notes logged yet.</p>`;
    return;
  }

  listEl.innerHTML = activities.map(a => html`
    <div class="activity-entry">
      <div class="activity-icon">${ACTIVITY_ICONS[a.type] || '📝'}</div>
      <div class="activity-body">
        <div class="activity-meta">
          <span>${ACTIVITY_LABELS[a.type] || 'Note'} -- ${new Date(a.date).toLocaleString()}</span>
          <button class="activity-delete" onclick="deleteActivity(${js(lead.id)}, ${js(a.id)})">Delete</button>
        </div>
        <div class="activity-text">${a.text}</div>
      </div>
    </div>
  `).join('');
}

document.getElementById('activityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = document.getElementById('activityType').value;
  const text = document.getElementById('activityText').value;
  if (!text.trim()) return;

  await fetch(`${API}/leads/${currentProfileLeadId}/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, text })
  });

  document.getElementById('activityText').value = '';
  await loadAll();
  // Re-render just the log in place so the modal doesn't visibly reopen
  const lead = leads.find(l => l.id === currentProfileLeadId);
  if (lead) renderActivityLog(lead);
});

window.deleteActivity = async function(leadId, activityId) {
  await fetch(`${API}/leads/${leadId}/activities/${activityId}`, { method: 'DELETE' });
  await loadAll();
  const lead = leads.find(l => l.id === leadId);
  if (lead) renderActivityLog(lead);
};

document.getElementById('editFromProfileBtn').addEventListener('click', () => {
  leadProfileModal.classList.remove('active');
  returnToProfileAfterEdit = true;
  editLead(currentProfileLeadId);
});

document.getElementById('closeProfileBtn').addEventListener('click', () => {
  leadProfileModal.classList.remove('active');
});

// ---------- Deals (Deal #, Desking, Credit App, Proposals) ----------

const DEAL_STATUS_LABELS = {
  working: 'Stored / Working', delivered: 'Delivered', closed: 'Closed', finalized: 'Finalized'
};
const CREDIT_STATUS_LABELS = {
  not_submitted: 'Not Submitted', pending: 'Pending', approved: 'Approved',
  conditional: 'Conditional', declined: 'Declined'
};

// Search matches across name (first/last/partial), company name (leads reuse
// the same `name` field for business leads), VIN, stock #, deal #, phone,
// and email -- all with one search box, since that's how a salesperson
// actually looks something up ("was it Ro... something, or the Camry VIN?").
function dealMatchesSearch(deal, lead, car, searchTerm) {
  if (!searchTerm) return true;
  const term = searchTerm.toLowerCase().trim();

  // Phone gets matched on digits only, so "887-2201", "8872201", and
  // "(555) 887-2201" all find the same customer regardless of formatting.
  const digitsOnly = (s) => (s || '').replace(/\D/g, '');
  const termDigits = digitsOnly(term);

  const haystacks = [
    lead ? lead.name : '',
    lead ? lead.email : '',
    car ? car.vin : '',
    car ? car.stockNumber : '',
    `d-${deal.dealNumber}`,
    String(deal.dealNumber)
  ].map(s => (s || '').toLowerCase());

  const textMatch = haystacks.some(h => h.includes(term));
  const phoneMatch = termDigits.length > 0 && digitsOnly(lead ? lead.phone : '').includes(termDigits);

  return textMatch || phoneMatch;
}

function dealMatchesDateRange(deal, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  const created = new Date(deal.dateCreated);
  const createdDateOnly = new Date(created.getFullYear(), created.getMonth(), created.getDate());

  if (dateFrom && createdDateOnly < new Date(dateFrom + 'T00:00:00')) return false;
  if (dateTo && createdDateOnly > new Date(dateTo + 'T00:00:00')) return false;
  return true;
}

function renderDeals() {
  const searchTerm = document.getElementById('dealSearchInput').value;
  const dateFrom = document.getElementById('dealDateFrom').value;
  const dateTo = document.getElementById('dealDateTo').value;
  const statusFilter = document.getElementById('dealStatusFilter').value;

  const filtered = deals.filter(d => {
    const lead = leads.find(l => l.id === d.leadId);
    const car = cars.find(c => c.id === d.carId);
    if (statusFilter && d.status !== statusFilter) return false;
    return dealMatchesSearch(d, lead, car, searchTerm) && dealMatchesDateRange(d, dateFrom, dateTo);
  });

  document.getElementById('dealTableBody').innerHTML = filtered.map(d => {
    const lead = leads.find(l => l.id === d.leadId);
    const car = cars.find(c => c.id === d.carId);
    const customerName = lead ? lead.name : '-- No customer --';
    const vehicleLabel = car ? `${car.year} ${car.make} ${car.model}` : '-- No vehicle --';
    const date = new Date(d.dateCreated).toLocaleDateString();
    const creditStatus = d.creditApp ? d.creditApp.status : 'not_submitted';
    return html`
      <tr>
        <td><button class="deal-number-link" onclick="openDealWorkspace(${js(d.id)})">D-${d.dealNumber}</button></td>
        <td>${customerName}</td>
        <td>${vehicleLabel}</td>
        <td><span class="badge ${d.status}">${DEAL_STATUS_LABELS[d.status] || d.status}</span></td>
        <td>$${d.monthlyPayment.toLocaleString()}/mo</td>
        <td><span class="badge ${creditStatus}">${CREDIT_STATUS_LABELS[creditStatus]}</span></td>
        <td>${date}</td>
        <td class="row-actions">
          <button class="delete" onclick="deleteDeal(${js(d.id)})">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

document.getElementById('dealSearchInput').addEventListener('input', renderDeals);
document.getElementById('dealDateFrom').addEventListener('change', renderDeals);
document.getElementById('dealDateTo').addEventListener('change', renderDeals);
document.getElementById('dealStatusFilter').addEventListener('change', renderDeals);
document.getElementById('clearDealFiltersBtn').addEventListener('click', () => {
  document.getElementById('dealSearchInput').value = '';
  document.getElementById('dealDateFrom').value = '';
  document.getElementById('dealDateTo').value = '';
  document.getElementById('dealStatusFilter').value = '';
  renderDeals();
});

// ---------- New Deal (instant create -> generates Deal #, fill in details later) ----------

document.getElementById('addDealBtn').addEventListener('click', async () => {
  // No picker -- create a bare deal immediately and open straight into the
  // workspace. Customer and vehicle can be assigned from the Desking tab
  // whenever they're actually known, which matches how a desk sometimes
  // starts a deal number before all the paperwork is in hand.
  const res = await fetch(`${API}/deals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const newDeal = await res.json();

  await loadAll();
  openDealWorkspace(newDeal.id);
});

window.deleteDeal = async function(id) {
  if (!confirm('Delete this deal?')) return;
  await fetch(`${API}/deals/${id}`, { method: 'DELETE' });
  await loadAll();
};

// ---------- Deal Full Page (Desking + Credit Application) ----------

const dealFullPage = document.getElementById('dealFullPage');
let currentWorkspaceDealId = null;

window.openDealWorkspace = function(dealId) {
  const deal = deals.find(d => d.id === dealId);
  if (!deal) return;
  currentWorkspaceDealId = dealId;

  document.getElementById('workspaceTitle').textContent = `Deal #D-${deal.dealNumber}`;
  document.getElementById('dealStatusSelect').value = deal.status;
  document.getElementById('dealTypeSelect').value = deal.dealType || 'retail';
  document.getElementById('workingDealId').value = deal.id;

  // Customer/Vehicle can be assigned now or left blank and filled in later --
  // populate the pickers with everything available, defaulting to "none"
  // when the deal doesn't have one yet.
  const leadSelect = document.getElementById('dealAssignedLeadId');
  leadSelect.innerHTML = '<option value="">-- No customer assigned yet --</option>' +
    leads.map(l => html`<option value="${l.id}">${l.name}</option>`).join('');
  leadSelect.value = deal.leadId || '';

  const carSelect = document.getElementById('dealAssignedCarId');
  carSelect.innerHTML = '<option value="">-- No vehicle assigned yet --</option>' +
    cars.filter(c => c.status !== 'sold' || c.id === deal.carId)
      .map(c => html`<option value="${c.id}" data-price="${c.price}">${c.year} ${c.make} ${c.model} - $${c.price.toLocaleString()}</option>`)
      .join('');
  carSelect.value = deal.carId || '';
  updateServiceTieIn(deal.carId);

  // Shared fields
  document.getElementById('dealVehiclePrice').value = deal.vehiclePrice;
  document.getElementById('dealRebate').value = deal.rebate;
  document.getElementById('dealTradeInValue').value = deal.tradeInValue;
  document.getElementById('dealTradeInPayoff').value = deal.tradeInPayoff;
  document.getElementById('dealTradeVin').value = deal.tradeVin || '';
  document.getElementById('dealTradeVinStatus').innerHTML = '';
  document.getElementById('dealTradeYear').value = deal.tradeYear || '';
  document.getElementById('dealTradeMake').value = deal.tradeMake || '';
  document.getElementById('dealTradeModel').value = deal.tradeModel || '';
  document.getElementById('dealTradeMileage').value = deal.tradeMileage || '';
  document.getElementById('dealDownPayment').value = deal.downPayment;
  document.getElementById('dealTaxRate').value = deal.taxRate;
  document.getElementById('dealTermMonths').value = deal.termMonths;
  document.getElementById('dealState').value = deal.state || (deal.creditApp && deal.creditApp.applicant ? deal.creditApp.applicant.state : '') || '';

  // Retail-only fields
  document.getElementById('dealTitleFee').value = deal.titleFee || 75;
  document.getElementById('dealRegistrationFee').value = deal.registrationFee || 50;
  document.getElementById('dealApr').value = deal.apr || 6.5;

  // Lease-only fields
  document.getElementById('dealMsrp').value = deal.msrp || 0;
  document.getElementById('dealAcquisitionFee').value = deal.acquisitionFee || 595;
  document.getElementById('dealCashBack').value = deal.cashBack || 0;
  document.getElementById('dealResidualPercent').value = deal.residualPercent || 50;
  document.getElementById('dealAnnualMiles').value = deal.annualMiles || 12000;
  document.getElementById('dealMoneyFactor').value = deal.moneyFactor || 0;
  document.getElementById('dealSecurityDeposit').value = deal.securityDeposit || 0;
  document.getElementById('dealAdvancedPayments').value = deal.advancedPayments || 0;

  // F&I products (shared)
  document.getElementById('dealDocFee').value = deal.docFee || 150;
  document.getElementById('dealLicenseFee').value = deal.licenseFee || 0;
  document.getElementById('dealDealerFees').value = deal.dealerFees || 0;
  document.getElementById('dealGapPremium').value = deal.gapPremium || 0;
  document.getElementById('dealServicePremium').value = deal.servicePremium || 0;
  document.getElementById('dealMaintenancePremium').value = deal.maintenancePremium || 0;
  document.getElementById('dealAftermarketAmount').value = deal.aftermarketAmount || 0;

  const hasTradeCheckbox = document.getElementById('hasTradeCheckbox');
  hasTradeCheckbox.checked = !!deal.hasTrade;
  document.getElementById('tradeFields').style.display = deal.hasTrade ? 'grid' : 'none';

  updateDealTypePanels(deal.dealType || 'retail');
  renderDealSummary(deal);

  // Build the credit application form fresh each time, since its shape
  // (business vs individual, with or without a co-applicant) changes
  // per deal.
  renderCreditAppFields(deal.creditApp);

  // Always open back on the Desking sub-tab
  switchSubTab('desking');

  // Full page takeover: hide the normal app chrome so the deal gets the
  // whole screen (this is a lot of fields -- a modal was too cramped).
  document.querySelector('.rail').style.display = 'none';
  document.querySelector('.appbar').style.display = 'none';
  document.querySelector('main').style.display = 'none';
  document.body.style.marginLeft = '0';
  dealFullPage.classList.add('active');
};

function closeDealFullPage() {
  dealFullPage.classList.remove('active');
  // Back to the stylesheet's own display (which hides the rail on phones).
  document.querySelector('.rail').style.display = '';
  document.querySelector('.appbar').style.display = '';
  document.querySelector('main').style.display = 'block';
  document.body.style.marginLeft = '';
}

document.getElementById('backToDealsBtn').addEventListener('click', async () => {
  closeDealFullPage();
  await loadAll();
  showView('deals');
});

// Switching deal type shows/hides the panels that only apply to that type,
// and swaps a couple of field labels ("Vehicle Price" vs "Selling Price",
// "Down Payment" vs "Cash Down") so the same shared inputs read naturally
// either way instead of needing two separate sets of fields.
function updateDealTypePanels(dealType) {
  const isLease = dealType === 'lease';
  const isCash = dealType === 'cash';

  document.getElementById('retailPanel').style.display = isLease ? 'none' : 'block';
  document.getElementById('leasePanel').style.display = isLease ? 'block' : 'none';
  document.getElementById('msrpLabel').style.display = isLease ? 'block' : 'none';
  document.getElementById('termLabel').style.display = isCash ? 'none' : 'block';
  document.getElementById('aprLabel').style.display = isCash ? 'none' : 'block';

  document.getElementById('vehiclePriceLabel').firstChild.textContent = isLease ? 'Selling Price ' : 'Vehicle Price ';
  document.getElementById('downPaymentLabel').firstChild.textContent = isLease ? 'Cash Down ' : 'Down Payment ';

  // Cash deals have no financing at all -- there's no monthly payment to
  // show, just a lump sum due. Retail/lease both show a monthly figure.
  document.getElementById('readoutAmountFinancedRow').style.display = (isLease || isCash) ? 'none' : 'flex';
  document.getElementById('paymentHighlightBox').style.display = isCash ? 'none' : 'block';
}

document.getElementById('dealTypeSelect').addEventListener('change', (e) => {
  updateDealTypePanels(e.target.value);
});

// Populates the read-only computed figures (gross cap cost, net cap cost,
// residual, amount financed, monthly payment, etc.) from the deal's last
// saved calculation. These only update after a Save, same limitation the
// desking form always had -- there's no live recalculation as you type.
function renderDealSummary(deal) {
  const isLease = (deal.dealType || 'retail') === 'lease';
  const isCash = (deal.dealType || 'retail') === 'cash';

  if (isLease) {
    document.getElementById('readoutGrossCapCost').textContent = `$${(deal.grossCapCost || 0).toLocaleString()}`;
    document.getElementById('readoutCapReduction').textContent = `$${(deal.totalCapReduction || 0).toLocaleString()}`;
    document.getElementById('readoutNetCapCost').textContent = `$${(deal.netCapCost || 0).toLocaleString()}`;
    document.getElementById('readoutResidualAmount').textContent = `$${(deal.residualAmount || 0).toLocaleString()}`;
    document.getElementById('readoutDueAtSigning').textContent = `$${(deal.dueAtSigning || 0).toLocaleString()}`;
  }

  if (isCash) {
    // No financing at all for a cash deal -- "amount financed" becomes the
    // one lump sum due, shown via the Total Deal Cost readout instead of
    // a monthly payment that doesn't apply.
    document.getElementById('readoutTotalDealCost').previousElementSibling.textContent = 'Total Due';
  } else {
    document.getElementById('readoutTotalDealCost').previousElementSibling.textContent = 'Total Deal Cost';
    document.getElementById('readoutAmountFinanced').textContent = `$${(deal.amountFinanced || 0).toLocaleString()}`;
    document.getElementById('readoutMonthlyPayment').textContent = `$${(deal.monthlyPayment || 0).toLocaleString()}/mo`;
    document.getElementById('readoutTermLine').textContent = `for ${deal.termMonths} months`;
  }

  document.getElementById('readoutTotalDealCost').textContent = `$${(deal.totalDealCost || 0).toLocaleString()}`;
}

// Groundwork for the future Service module: this reads a car's openROs
// field (an empty array today, since Service doesn't exist yet) so a
// sales manager can eventually see "this trade/vehicle has an open repair
// order" right from the deal page. The data seam exists now; the Service
// module that actually populates it is a separate, later build.
function updateServiceTieIn(carId) {
  const container = document.getElementById('serviceTieIn');
  const textEl = document.getElementById('serviceTieInText');
  const car = cars.find(c => c.id === carId);

  if (!car) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  const openROs = car.openROs || [];
  textEl.textContent = openROs.length > 0
    ? `${openROs.length} open RO${openROs.length > 1 ? 's' : ''}`
    : 'No open ROs';
}

// Picking a vehicle auto-fills its price, same convenience as before --
// just now it can happen anytime from within the workspace, not only at
// deal creation.
document.getElementById('dealAssignedCarId').addEventListener('change', (e) => {
  const selected = e.target.options[e.target.selectedIndex];
  if (selected && selected.dataset.price) {
    document.getElementById('dealVehiclePrice').value = selected.dataset.price;
  }
  updateServiceTieIn(e.target.value);
});

// Sub-tab switching within the workspace
function switchSubTab(name) {
  document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.sub-tab-btn[data-subtab="${name}"]`).classList.add('active');
  document.getElementById(name).classList.add('active');
}

document.querySelectorAll('.sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
});

// Trade-in toggle
document.getElementById('hasTradeCheckbox').addEventListener('change', (e) => {
  document.getElementById('tradeFields').style.display = e.target.checked ? 'grid' : 'none';
  if (!e.target.checked) {
    document.getElementById('dealTradeInValue').value = 0;
    document.getElementById('dealTradeInPayoff').value = 0;
  }
});

// Deal status dropdown (in the header) saves immediately on change
document.getElementById('dealStatusSelect').addEventListener('change', async (e) => {
  await fetch(`${API}/deals/${currentWorkspaceDealId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: e.target.value })
  });
  await loadAll();
});

function buildDeskingPayload() {
  return {
    leadId: document.getElementById('dealAssignedLeadId').value || null,
    carId: document.getElementById('dealAssignedCarId').value || null,
    dealType: document.getElementById('dealTypeSelect').value,
    vehiclePrice: document.getElementById('dealVehiclePrice').value,
    msrp: document.getElementById('dealMsrp').value,
    rebate: document.getElementById('dealRebate').value,
    hasTrade: document.getElementById('hasTradeCheckbox').checked,
    tradeInValue: document.getElementById('dealTradeInValue').value,
    tradeInPayoff: document.getElementById('dealTradeInPayoff').value,
    tradeVin: cleanVin(document.getElementById('dealTradeVin').value),
    tradeYear: document.getElementById('dealTradeYear').value,
    tradeMake: document.getElementById('dealTradeMake').value,
    tradeModel: document.getElementById('dealTradeModel').value,
    tradeMileage: document.getElementById('dealTradeMileage').value,
    downPayment: document.getElementById('dealDownPayment').value,
    taxRate: document.getElementById('dealTaxRate').value,
    termMonths: document.getElementById('dealTermMonths').value,
    state: document.getElementById('dealState').value,
    titleFee: document.getElementById('dealTitleFee').value,
    registrationFee: document.getElementById('dealRegistrationFee').value,
    apr: document.getElementById('dealApr').value,
    acquisitionFee: document.getElementById('dealAcquisitionFee').value,
    cashBack: document.getElementById('dealCashBack').value,
    residualPercent: document.getElementById('dealResidualPercent').value,
    annualMiles: document.getElementById('dealAnnualMiles').value,
    moneyFactor: document.getElementById('dealMoneyFactor').value,
    securityDeposit: document.getElementById('dealSecurityDeposit').value,
    advancedPayments: document.getElementById('dealAdvancedPayments').value,
    docFee: document.getElementById('dealDocFee').value,
    licenseFee: document.getElementById('dealLicenseFee').value,
    dealerFees: document.getElementById('dealDealerFees').value,
    gapPremium: document.getElementById('dealGapPremium').value,
    servicePremium: document.getElementById('dealServicePremium').value,
    maintenancePremium: document.getElementById('dealMaintenancePremium').value,
    aftermarketAmount: document.getElementById('dealAftermarketAmount').value,
  };
}

// Desking form: save & recalculate. Both the header Save button and the
// form's own submit button trigger this same save -- one authoritative
// save path regardless of which button was clicked.
async function saveDeskingForm() {
  const payload = buildDeskingPayload();

  const res = await fetch(`${API}/deals/${currentWorkspaceDealId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const updatedDeal = await res.json();

  await loadAll();
  renderDealSummary(updatedDeal);
}

document.getElementById('deskingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveDeskingForm();
});

document.getElementById('saveDealBtn').addEventListener('click', async () => {
  await saveDeskingForm();
});

document.getElementById('viewProposalFromWorkspaceBtn').addEventListener('click', () => {
  viewProposal(currentWorkspaceDealId);
});

document.getElementById('autoCalcFeesBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('autoCalcFeesStatus');

  // Save the Credit Application first, silently. This guarantees whatever
  // address was just typed in is actually persisted before anything reads
  // it -- removing the dependency on remembering a separate "Save Credit
  // Application" click, which is an easy step to skip and previously meant
  // a freshly-typed address could be lost the moment the page reloaded.
  await saveCreditAppForm();

  const dealStateField = document.getElementById('dealState');
  const primaryStateField = document.getElementById('primaryState');
  // The customer's address (and its state) lives on the Credit Application
  // tab -- that's the live source of truth. The Desking tab's own State
  // field is only a fallback for a deal with no customer/address on file
  // yet, and gets kept in sync below so both fields always agree.
  const state = (primaryStateField && primaryStateField.value) ? primaryStateField.value : (dealStateField ? dealStateField.value : '');
  if (dealStateField && state) dealStateField.value = state;
  const carId = document.getElementById('dealAssignedCarId').value;
  const price = document.getElementById('dealVehiclePrice').value;
  const car = cars.find(c => c.id === carId);
  const vehicleYear = car ? car.year : '';

  // Read the ZIP and County directly from the live Credit Application
  // fields, not from the last-saved deal data -- if the address was just
  // typed in but "Save Credit Application" hasn't been clicked yet, the
  // saved copy would still be blank/stale, and this button should use
  // whatever's actually on screen right now.
  const zipField = document.getElementById('primaryZip');
  const countyField = document.getElementById('primaryCounty');
  const cityField = document.getElementById('primaryCity');
  const zip = zipField ? zipField.value : '';
  const county = countyField ? countyField.value : '';
  const city = cityField ? cityField.value : '';

  if (!price) {
    statusEl.innerHTML = `<div class="send-text-status-error">Enter a vehicle price first.</div>`;
    return;
  }
  if (!zip) {
    statusEl.innerHTML = `<div class="send-text-status-error">No ZIP code found -- enter the customer's address on the Credit Application tab first (you don't need to save it, just fill it in).</div>`;
    return;
  }

  statusEl.innerHTML = `<div style="font-size:13px;color:var(--text-muted);">Calculating...</div>`;

  try {
    const res = await fetch(`${API}/fees/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, zip, price, vehicleYear, county, city })
    });
    const result = await res.json();

    if (!res.ok) {
      statusEl.innerHTML = html`<div class="send-text-status-error">${result.error}</div>`;
      return;
    }

    document.getElementById('dealTaxRate').value = result.taxRate;
    document.getElementById('dealLicenseFee').value = result.licenseFee;
    document.getElementById('dealTitleFee').value = result.titleFee;
    document.getElementById('dealRegistrationFee').value = result.registrationFee;

    const tradeNote = result.tradeInReducesTaxableAmount
      ? 'trade-in reduces taxable amount'
      : 'full price is taxable, trade-in does not reduce it';
    const countyNote = result.county ? `${result.county} County` : 'statewide base rate -- county not recognized';
    const sourceNote = result.rateSource && !result.rateSource.startsWith('no match') ? ` [rate: ${result.rateSource}]` : ' [no matching Taxes & Fees record -- add one via 🗺️ Taxes & Fees]';
    statusEl.innerHTML = html`<div class="send-text-status-success">✓ Calculated for ${result.stateUsed}, ${countyNote} (${tradeNote}).${sourceNote} Estimate only -- verify against your state's current DMV schedule.</div>`;
  } catch (err) {
    statusEl.innerHTML = `<div class="send-text-status-error">Could not reach the server.</div>`;
  }
});

// "Duplicate as New Scenario" -- clones the current deal's numbers into a
// brand new deal (its own Deal #), so a rep can compare e.g. a 36 vs
// 48-month lease side by side instead of overwriting the only copy.
// This is a lighter-weight version of true side-by-side scenarios (like
// "Scenario #2" tabs in a real DMS) -- each alternative just gets its own
// full deal record rather than living inside one shared deal.
document.getElementById('duplicateScenarioBtn').addEventListener('click', async () => {
  const sourceDeal = deals.find(d => d.id === currentWorkspaceDealId);
  if (!sourceDeal) return;

  const payload = buildDeskingPayload();
  const createRes = await fetch(`${API}/deals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: payload.leadId, carId: payload.carId })
  });
  const newDeal = await createRes.json();

  // Now push the full set of current numbers onto the fresh deal, so the
  // "new scenario" starts as an exact copy the rep can then tweak (change
  // the term, switch retail to lease, etc.) to compare against the original.
  await fetch(`${API}/deals/${newDeal.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  await loadAll();
  openDealWorkspace(newDeal.id);
});

// ---------- Credit Application (dynamic: individual/business + co-applicant) ----------

const HOUSING_STATUS_OPTIONS = [
  ['mortgage', 'Mortgage'], ['rent', 'Rent'], ['family', 'Family'],
  ['own_outright', 'Own Outright'], ['other', 'Other'], ['military', 'Military']
];
const EMPLOYMENT_STATUS_OPTIONS = [
  ['employed', 'Employed'], ['unemployed', 'Unemployed'], ['retired', 'Retired'],
  ['active_military', 'Active Military'], ['other', 'Other'],
  ['self_employed', 'Self-Employed'], ['student', 'Student'], ['retired_military', 'Retired Military']
];
const PAY_FREQUENCY_OPTIONS = [
  ['weekly', 'Weekly'], ['biweekly', 'Bi-Weekly'], ['semimonthly', 'Semi-Monthly'],
  ['monthly', 'Monthly'], ['annually', 'Annually']
];
const SUFFIX_OPTIONS = ['', 'Jr', 'Sr', 'I', 'II', 'III', 'IV'];

function selectOptionsHtml(options, selected) {
  return options.map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`
  ).join('');
}

// Builds the full field set for ONE applicant (primary or co-applicant).
// Using one function for both means the two forms can never drift out
// of sync with each other.
// Keeps the Desking tab's State field in sync with the primary applicant's
// address on the Credit Application tab -- the address is the actual
// source of truth for which state's tax/DMV rules apply, so the two
// fields shouldn't be able to silently disagree with each other.
window.syncDealStateFromCreditApp = function(prefix) {
  if (prefix !== 'primary') return; // co-applicant's state doesn't drive the deal's state
  const dealStateField = document.getElementById('dealState');
  const primaryStateField = document.getElementById('primaryState');
  if (dealStateField && primaryStateField && primaryStateField.value) {
    dealStateField.value = primaryStateField.value;
  }
};

// Called when a ZIP field changes in the credit application -- looks up
// the county from the customer's ZIP (and whatever state is currently
// typed in) so the sales rep doesn't have to know or type it themselves.
// Only resolves for CA/AZ ZIPs today; other states just leave it blank
// for now, same as the rest of the state-fee engine.
window.autoFillCounty = async function(prefix) {
  const zip = document.getElementById(`${prefix}Zip`).value;
  const state = document.getElementById(`${prefix}State`).value;
  if (!zip) return;

  try {
    const res = await fetch(`${API}/fees/county-lookup?state=${encodeURIComponent(state)}&zip=${encodeURIComponent(zip)}`);
    const result = await res.json();
    if (result.county) {
      document.getElementById(`${prefix}County`).value = result.county;
    }
  } catch (err) {
    // Silent failure is fine here -- county is a convenience auto-fill,
    // not something that should interrupt filling out the rest of the form.
  }
};

function applicantFieldsHtml(prefix, title) {
  return `
    <div class="ca-applicant-block" id="${prefix}ApplicantBlock">
      <div class="ca-applicant-header">
        <h3>${title}</h3>
        ${prefix === 'co' ? `<button type="button" class="btn-secondary" id="removeCoApplicantBtn">Remove Co-Applicant</button>` : ''}
      </div>

      <div class="ca-section-title">Personal Info</div>
      <div class="form-grid form-grid-3">
        <label>First Name <input type="text" id="${prefix}FirstName" /></label>
        <label>Middle Initial <input type="text" maxlength="1" id="${prefix}MiddleInitial" /></label>
        <label>Last Name <input type="text" id="${prefix}LastName" /></label>
      </div>
      <div class="form-grid">
        <label>Suffix
          <select id="${prefix}Suffix">${SUFFIX_OPTIONS.map(s => `<option value="${s}">${s || '--'}</option>`).join('')}</select>
        </label>
        <label>SSN # <input type="text" id="${prefix}Ssn" /></label>
        <label>DOB <input type="date" id="${prefix}Dob" /></label>
        <label>License State <input type="text" maxlength="2" id="${prefix}LicenseState" /></label>
        <label>License # <input type="text" id="${prefix}LicenseNumber" /></label>
      </div>

      <label>Address 1 <input type="text" id="${prefix}Address1" /></label>
      <label>Address 2 <input type="text" id="${prefix}Address2" /></label>
      <div class="form-grid form-grid-3">
        <label>City <input type="text" id="${prefix}City" /></label>
        <label>State <input type="text" maxlength="2" id="${prefix}State" placeholder="CA" onchange="syncDealStateFromCreditApp('${prefix}')" /></label>
        <label>Zip <input type="text" id="${prefix}Zip" onchange="autoFillCounty('${prefix}')" /></label>
      </div>
      <div class="form-grid form-grid-3">
        <label>County <input type="text" id="${prefix}County" placeholder="auto-fills from ZIP for CA/AZ" /></label>
        <label>Phone <input type="text" id="${prefix}Phone" /></label>
        <label>Email <input type="email" id="${prefix}Email" /></label>
      </div>
      <div class="form-grid form-grid-3">
        <label class="ca-inline-checkbox"><input type="checkbox" id="${prefix}HomeDisclosure" /> OK to contact home phone</label>
        <label class="ca-inline-checkbox"><input type="checkbox" id="${prefix}MobileDisclosure" /> OK to contact mobile phone</label>
        <label class="ca-inline-checkbox"><input type="checkbox" id="${prefix}EmailNotProvided" /> Email not provided by customer</label>
      </div>

      <div class="ca-section-title">Housing & Employment Info</div>
      <div class="form-grid form-grid-3">
        <label>Housing Status
          <select id="${prefix}HousingStatus">${selectOptionsHtml(HOUSING_STATUS_OPTIONS)}</select>
        </label>
        <label>Yrs. at Address <input type="number" min="0" id="${prefix}YrsAtAddress" /></label>
        <label>Mos. at Address <input type="number" min="0" max="11" id="${prefix}MosAtAddress" /></label>
      </div>
      <label>Mort. Payment/Rent <input type="number" id="${prefix}HousingPayment" /></label>

      <div class="ca-toggle-row">
        <label class="ca-inline-checkbox">
          <input type="checkbox" id="${prefix}HasPreviousAddress" /> This applicant has been at their current address less than 2 years -- add previous address
        </label>
        <div class="ca-sub-block" id="${prefix}PreviousAddressBlock" style="display:none;">
          <label>Previous Address 1 <input type="text" id="${prefix}PrevAddress1" /></label>
          <label>Previous Address 2 <input type="text" id="${prefix}PrevAddress2" /></label>
          <div class="form-grid form-grid-3">
            <label>Zip <input type="text" id="${prefix}PrevZip" /></label>
            <label>Yrs. at Address <input type="number" min="0" id="${prefix}PrevYrsAtAddress" /></label>
            <label>Mos. at Address <input type="number" min="0" max="11" id="${prefix}PrevMosAtAddress" /></label>
          </div>
        </div>
      </div>

      <div class="form-grid">
        <label>Employment Status
          <select id="${prefix}EmploymentStatus">${selectOptionsHtml(EMPLOYMENT_STATUS_OPTIONS)}</select>
        </label>
        <label>Employer <input type="text" id="${prefix}Employer" /></label>
        <label>Yrs. at Employer <input type="number" min="0" id="${prefix}YrsAtEmployer" /></label>
        <label>Mos. at Employer <input type="number" min="0" max="11" id="${prefix}MosAtEmployer" /></label>
        <label>Business Phone <input type="text" id="${prefix}BusinessPhone" /></label>
        <label>Occupation <input type="text" id="${prefix}Occupation" /></label>
        <label>Salary <input type="number" id="${prefix}Salary" /></label>
        <label>Expected Salary <input type="number" id="${prefix}ExpectedSalary" /></label>
        <label>Pay Frequency
          <select id="${prefix}PayFrequency">${selectOptionsHtml(PAY_FREQUENCY_OPTIONS)}</select>
        </label>
        <label>Other Monthly Income <input type="number" id="${prefix}OtherMonthlyIncome" /></label>
      </div>

      <p class="ca-disclosure-text">
        In accordance with the General Terms and Conditions, you are required to read the following statement to the
        applicant before you can request from the applicant the amount, if any, of "Other Income" and the "Source of
        Other Income". Alimony, child support, or separate maintenance income need not be disclosed if you do not
        wish to have it considered as a basis for repaying this obligation.
      </p>
      <div class="form-grid">
        <label>Other Income <input type="number" id="${prefix}OtherIncome" /></label>
        <label>Source of Other Income <input type="text" id="${prefix}SourceOfOtherIncome" /></label>
      </div>

      <div class="ca-toggle-row">
        <label class="ca-inline-checkbox">
          <input type="checkbox" id="${prefix}HasPreviousEmployer" /> This applicant has been at their current job less than 2 years -- add previous employer
        </label>
        <div class="ca-sub-block" id="${prefix}PreviousEmployerBlock" style="display:none;">
          <div class="form-grid">
            <label>Previous Employer <input type="text" id="${prefix}PrevEmployer" /></label>
            <label>Yrs. at Employer <input type="number" min="0" id="${prefix}PrevYrsAtEmployer" /></label>
            <label>Mos. at Employer <input type="number" min="0" max="11" id="${prefix}PrevMosAtEmployer" /></label>
            <label>Occupation <input type="text" id="${prefix}PrevOccupation" /></label>
            <label>Business Phone <input type="text" id="${prefix}PrevBusinessPhone" /></label>
          </div>
        </div>
      </div>
    </div>
  `;
}

function fillApplicantFields(prefix, a) {
  document.getElementById(`${prefix}FirstName`).value = a.firstName || '';
  document.getElementById(`${prefix}MiddleInitial`).value = a.middleInitial || '';
  document.getElementById(`${prefix}LastName`).value = a.lastName || '';
  document.getElementById(`${prefix}Suffix`).value = a.suffix || '';
  document.getElementById(`${prefix}Ssn`).value = a.ssn || '';
  document.getElementById(`${prefix}Dob`).value = a.dob || '';
  document.getElementById(`${prefix}LicenseState`).value = a.licenseState || '';
  document.getElementById(`${prefix}LicenseNumber`).value = a.licenseNumber || '';
  document.getElementById(`${prefix}Address1`).value = a.address1 || '';
  document.getElementById(`${prefix}Address2`).value = a.address2 || '';
  document.getElementById(`${prefix}City`).value = a.city || '';
  document.getElementById(`${prefix}State`).value = a.state || '';
  document.getElementById(`${prefix}County`).value = a.county || '';
  document.getElementById(`${prefix}Zip`).value = a.zip || '';
  document.getElementById(`${prefix}Phone`).value = a.phone || '';
  document.getElementById(`${prefix}Email`).value = a.email || '';
  document.getElementById(`${prefix}HomeDisclosure`).checked = !!a.homeDisclosure;
  document.getElementById(`${prefix}MobileDisclosure`).checked = !!a.mobileDisclosure;
  document.getElementById(`${prefix}EmailNotProvided`).checked = !!a.emailNotProvided;

  document.getElementById(`${prefix}HousingStatus`).value = a.housingStatus || 'rent';
  document.getElementById(`${prefix}YrsAtAddress`).value = a.yrsAtAddress || '';
  document.getElementById(`${prefix}MosAtAddress`).value = a.mosAtAddress || '';
  document.getElementById(`${prefix}HousingPayment`).value = a.housingPayment || 0;

  document.getElementById(`${prefix}HasPreviousAddress`).checked = !!a.hasPreviousAddress;
  document.getElementById(`${prefix}PreviousAddressBlock`).style.display = a.hasPreviousAddress ? 'block' : 'none';
  const pa = a.previousAddress || {};
  document.getElementById(`${prefix}PrevAddress1`).value = pa.address1 || '';
  document.getElementById(`${prefix}PrevAddress2`).value = pa.address2 || '';
  document.getElementById(`${prefix}PrevZip`).value = pa.zip || '';
  document.getElementById(`${prefix}PrevYrsAtAddress`).value = pa.yrsAtAddress || '';
  document.getElementById(`${prefix}PrevMosAtAddress`).value = pa.mosAtAddress || '';

  document.getElementById(`${prefix}EmploymentStatus`).value = a.employmentStatus || 'employed';
  document.getElementById(`${prefix}Employer`).value = a.employer || '';
  document.getElementById(`${prefix}YrsAtEmployer`).value = a.yrsAtEmployer || '';
  document.getElementById(`${prefix}MosAtEmployer`).value = a.mosAtEmployer || '';
  document.getElementById(`${prefix}BusinessPhone`).value = a.businessPhone || '';
  document.getElementById(`${prefix}Occupation`).value = a.occupation || '';
  document.getElementById(`${prefix}Salary`).value = a.salary || 0;
  document.getElementById(`${prefix}ExpectedSalary`).value = a.expectedSalary || 0;
  document.getElementById(`${prefix}PayFrequency`).value = a.payFrequency || 'biweekly';
  document.getElementById(`${prefix}OtherMonthlyIncome`).value = a.otherMonthlyIncome || 0;
  document.getElementById(`${prefix}OtherIncome`).value = a.otherIncome || 0;
  document.getElementById(`${prefix}SourceOfOtherIncome`).value = a.sourceOfOtherIncome || '';

  document.getElementById(`${prefix}HasPreviousEmployer`).checked = !!a.hasPreviousEmployer;
  document.getElementById(`${prefix}PreviousEmployerBlock`).style.display = a.hasPreviousEmployer ? 'block' : 'none';
  const pe = a.previousEmployer || {};
  document.getElementById(`${prefix}PrevEmployer`).value = pe.employer || '';
  document.getElementById(`${prefix}PrevYrsAtEmployer`).value = pe.yrsAtEmployer || '';
  document.getElementById(`${prefix}PrevMosAtEmployer`).value = pe.mosAtEmployer || '';
  document.getElementById(`${prefix}PrevOccupation`).value = pe.occupation || '';
  document.getElementById(`${prefix}PrevBusinessPhone`).value = pe.businessPhone || '';
}

function collectApplicantFields(prefix) {
  return {
    firstName: document.getElementById(`${prefix}FirstName`).value,
    middleInitial: document.getElementById(`${prefix}MiddleInitial`).value,
    lastName: document.getElementById(`${prefix}LastName`).value,
    suffix: document.getElementById(`${prefix}Suffix`).value,
    ssn: document.getElementById(`${prefix}Ssn`).value,
    dob: document.getElementById(`${prefix}Dob`).value,
    licenseState: document.getElementById(`${prefix}LicenseState`).value,
    licenseNumber: document.getElementById(`${prefix}LicenseNumber`).value,
    address1: document.getElementById(`${prefix}Address1`).value,
    address2: document.getElementById(`${prefix}Address2`).value,
    city: document.getElementById(`${prefix}City`).value,
    state: document.getElementById(`${prefix}State`).value,
    county: document.getElementById(`${prefix}County`).value,
    zip: document.getElementById(`${prefix}Zip`).value,
    phone: document.getElementById(`${prefix}Phone`).value,
    email: document.getElementById(`${prefix}Email`).value,
    homeDisclosure: document.getElementById(`${prefix}HomeDisclosure`).checked,
    mobileDisclosure: document.getElementById(`${prefix}MobileDisclosure`).checked,
    emailNotProvided: document.getElementById(`${prefix}EmailNotProvided`).checked,

    housingStatus: document.getElementById(`${prefix}HousingStatus`).value,
    yrsAtAddress: document.getElementById(`${prefix}YrsAtAddress`).value,
    mosAtAddress: document.getElementById(`${prefix}MosAtAddress`).value,
    housingPayment: document.getElementById(`${prefix}HousingPayment`).value,
    hasPreviousAddress: document.getElementById(`${prefix}HasPreviousAddress`).checked,
    previousAddress: {
      address1: document.getElementById(`${prefix}PrevAddress1`).value,
      address2: document.getElementById(`${prefix}PrevAddress2`).value,
      zip: document.getElementById(`${prefix}PrevZip`).value,
      yrsAtAddress: document.getElementById(`${prefix}PrevYrsAtAddress`).value,
      mosAtAddress: document.getElementById(`${prefix}PrevMosAtAddress`).value,
    },

    employmentStatus: document.getElementById(`${prefix}EmploymentStatus`).value,
    employer: document.getElementById(`${prefix}Employer`).value,
    yrsAtEmployer: document.getElementById(`${prefix}YrsAtEmployer`).value,
    mosAtEmployer: document.getElementById(`${prefix}MosAtEmployer`).value,
    businessPhone: document.getElementById(`${prefix}BusinessPhone`).value,
    occupation: document.getElementById(`${prefix}Occupation`).value,
    salary: document.getElementById(`${prefix}Salary`).value,
    expectedSalary: document.getElementById(`${prefix}ExpectedSalary`).value,
    payFrequency: document.getElementById(`${prefix}PayFrequency`).value,
    otherMonthlyIncome: document.getElementById(`${prefix}OtherMonthlyIncome`).value,
    otherIncome: document.getElementById(`${prefix}OtherIncome`).value,
    sourceOfOtherIncome: document.getElementById(`${prefix}SourceOfOtherIncome`).value,
    hasPreviousEmployer: document.getElementById(`${prefix}HasPreviousEmployer`).checked,
    previousEmployer: {
      employer: document.getElementById(`${prefix}PrevEmployer`).value,
      yrsAtEmployer: document.getElementById(`${prefix}PrevYrsAtEmployer`).value,
      mosAtEmployer: document.getElementById(`${prefix}PrevMosAtEmployer`).value,
      occupation: document.getElementById(`${prefix}PrevOccupation`).value,
      businessPhone: document.getElementById(`${prefix}PrevBusinessPhone`).value,
    }
  };
}

let workspaceHasCoApplicant = false;

function renderCreditAppFields(creditApp) {
  const ca = creditApp || {};
  workspaceHasCoApplicant = !!ca.hasCoApplicant;

  const container = document.getElementById('creditAppFieldsContainer');
  container.innerHTML = `
    <div class="form-grid">
      <label>Application Type
        <select id="caApplicantType">
          <option value="individual">Individual</option>
          <option value="business">Business</option>
        </select>
      </label>
      <label>Approval Status
        <select id="caStatus">
          <option value="not_submitted">Not Submitted</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="conditional">Conditional</option>
          <option value="declined">Declined</option>
        </select>
      </label>
    </div>

    <div id="caBusinessFields" class="form-grid" style="display:none;">
      <label>Business Name <input type="text" id="caBusinessName" /></label>
      <label>EIN <input type="text" id="caBusinessEIN" /></label>
      <label>Business Address <input type="text" id="caBusinessAddress" /></label>
      <label>Business Phone <input type="text" id="caBusinessPhone" /></label>
      <label>Years in Business <input type="number" min="0" id="caYearsInBusiness" /></label>
      <label>Annual Revenue <input type="number" id="caAnnualRevenue" /></label>
    </div>

    ${applicantFieldsHtml('primary', 'Applicant')}

    <div id="coApplicantToggleRow" style="margin-bottom:16px;">
      <button type="button" class="btn-secondary" id="addCoApplicantBtn">+ Add Co-Applicant</button>
    </div>
    <div id="coApplicantContainer"></div>
  `;

  document.getElementById('caApplicantType').value = ca.applicantType || 'individual';
  document.getElementById('caStatus').value = ca.status || 'not_submitted';
  document.getElementById('caBusinessName').value = ca.businessName || '';
  document.getElementById('caBusinessEIN').value = ca.businessEIN || '';
  document.getElementById('caBusinessAddress').value = ca.businessAddress || '';
  document.getElementById('caBusinessPhone').value = ca.businessPhone || '';
  document.getElementById('caYearsInBusiness').value = ca.yearsInBusiness || '';
  document.getElementById('caAnnualRevenue').value = ca.annualRevenue || 0;
  document.getElementById('caBusinessFields').style.display = ca.applicantType === 'business' ? 'grid' : 'none';

  fillApplicantFields('primary', ca.applicant || {});

  if (workspaceHasCoApplicant) {
    showCoApplicantBlock(ca.coApplicant || {});
  }

  // Wire up: switching application type shows/hides business fields
  document.getElementById('caApplicantType').addEventListener('change', (e) => {
    document.getElementById('caBusinessFields').style.display = e.target.value === 'business' ? 'grid' : 'none';
  });

  // Wire up: primary applicant's previous-address / previous-employer toggles
  wireApplicantToggles('primary');

  document.getElementById('addCoApplicantBtn').addEventListener('click', () => {
    showCoApplicantBlock({});
  });
}

function showCoApplicantBlock(coApplicantData) {
  workspaceHasCoApplicant = true;
  document.getElementById('coApplicantToggleRow').style.display = 'none';
  document.getElementById('coApplicantContainer').innerHTML = applicantFieldsHtml('co', 'Co-Applicant');
  fillApplicantFields('co', coApplicantData);
  wireApplicantToggles('co');

  document.getElementById('removeCoApplicantBtn').addEventListener('click', () => {
    workspaceHasCoApplicant = false;
    document.getElementById('coApplicantContainer').innerHTML = '';
    document.getElementById('coApplicantToggleRow').style.display = 'block';
  });
}

function wireApplicantToggles(prefix) {
  document.getElementById(`${prefix}HasPreviousAddress`).addEventListener('change', (e) => {
    document.getElementById(`${prefix}PreviousAddressBlock`).style.display = e.target.checked ? 'block' : 'none';
  });
  document.getElementById(`${prefix}HasPreviousEmployer`).addEventListener('change', (e) => {
    document.getElementById(`${prefix}PreviousEmployerBlock`).style.display = e.target.checked ? 'block' : 'none';
  });
}

// Credit application form: save separately from desking numbers
async function saveCreditAppForm() {
  const payload = {
    applicantType: document.getElementById('caApplicantType').value,
    businessName: document.getElementById('caBusinessName').value,
    businessEIN: document.getElementById('caBusinessEIN').value,
    businessAddress: document.getElementById('caBusinessAddress').value,
    businessPhone: document.getElementById('caBusinessPhone').value,
    yearsInBusiness: document.getElementById('caYearsInBusiness').value,
    annualRevenue: document.getElementById('caAnnualRevenue').value,
    status: document.getElementById('caStatus').value,
    applicant: collectApplicantFields('primary'),
    hasCoApplicant: workspaceHasCoApplicant,
    coApplicant: workspaceHasCoApplicant ? collectApplicantFields('co') : {}
  };

  await fetch(`${API}/deals/${currentWorkspaceDealId}/credit-app`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

document.getElementById('creditAppForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveCreditAppForm();
  await loadAll();
  // Stay on the page (it's full-page now, not a modal) -- just quietly
  // re-render so any computed fields reflect the save.
});

// ---------- Printable Proposal ----------

const proposalModal = document.getElementById('proposalModal');

window.viewProposal = function(dealId) {
  const deal = deals.find(d => d.id === dealId);
  if (!deal) return;

  const lead = leads.find(l => l.id === deal.leadId);
  const car = cars.find(c => c.id === deal.carId);

  const customerName = lead ? lead.name : 'Unknown Customer';
  const vehicleLabel = car ? `${car.year} ${car.make} ${car.model}` : 'Unknown Vehicle';
  const date = new Date(deal.dateCreated).toLocaleDateString();
  const isLease = (deal.dealType || 'retail') === 'lease';

  const fiRows = html`
      <tr><td>Doc Fee</td><td>+$${(deal.docFee || 0).toLocaleString()}</td></tr>
      ${deal.licenseFee ? html`<tr><td>License Fee</td><td>+$${deal.licenseFee.toLocaleString()}</td></tr>` : ''}
      ${deal.dealerFees ? html`<tr><td>Dealer Fees</td><td>+$${deal.dealerFees.toLocaleString()}</td></tr>` : ''}
      ${deal.gapPremium ? html`<tr><td>GAP Premium</td><td>+$${deal.gapPremium.toLocaleString()}</td></tr>` : ''}
      ${deal.servicePremium ? html`<tr><td>Service Contract</td><td>+$${deal.servicePremium.toLocaleString()}</td></tr>` : ''}
      ${deal.maintenancePremium ? html`<tr><td>Maintenance Plan</td><td>+$${deal.maintenancePremium.toLocaleString()}</td></tr>` : ''}
      ${deal.aftermarketAmount ? html`<tr><td>Aftermarket / Accessories</td><td>+$${deal.aftermarketAmount.toLocaleString()}</td></tr>` : ''}
  `;

  const bodyHtml = isLease ? html`
    <table>
      <tr><td>MSRP</td><td>$${(deal.msrp || 0).toLocaleString()}</td></tr>
      <tr><td>Selling Price</td><td>$${deal.vehiclePrice.toLocaleString()}</td></tr>
      <tr><td>Acquisition Fee</td><td>+$${(deal.acquisitionFee || 0).toLocaleString()}</td></tr>
      ${fiRows}
      <tr class="total-row"><td>Gross Cap Cost</td><td>$${(deal.grossCapCost || 0).toLocaleString()}</td></tr>
    </table>
    <table>
      <tr><td>Cash Down</td><td>-$${deal.downPayment.toLocaleString()}</td></tr>
      <tr><td>Rebate</td><td>-$${deal.rebate.toLocaleString()}</td></tr>
      <tr><td>Net Trade Equity</td><td>-$${(deal.netTradeIn || 0).toLocaleString()}</td></tr>
      ${deal.cashBack ? html`<tr><td>Cash Back to Customer</td><td>+$${deal.cashBack.toLocaleString()}</td></tr>` : ''}
      <tr class="total-row"><td>Net Cap Cost</td><td>$${(deal.netCapCost || 0).toLocaleString()}</td></tr>
    </table>
    <table>
      <tr><td>Residual (${deal.residualPercent}% of MSRP)</td><td>$${(deal.residualAmount || 0).toLocaleString()}</td></tr>
      <tr><td>Annual Miles</td><td>${(deal.annualMiles || 0).toLocaleString()}</td></tr>
    </table>

    <div class="payment-highlight">
      <div class="amount">$${deal.monthlyPayment.toLocaleString()}/mo</div>
      <div>for ${deal.termMonths} months, money factor ${deal.moneyFactor}</div>
    </div>

    <table>
      <tr><td>Due at Signing</td><td>$${(deal.dueAtSigning || 0).toLocaleString()}</td></tr>
      <tr><td>Total of Payments</td><td>$${deal.totalOfPayments.toLocaleString()}</td></tr>
      <tr class="total-row"><td>Total Lease Cost</td><td>$${deal.totalDealCost.toLocaleString()}</td></tr>
    </table>

    <p class="fine-print">
      This proposal is an estimate for discussion purposes only and is not a binding offer to lease.
      Sales tax is calculated on the monthly payment, per the most common state tax treatment for
      leases; some states instead tax cap cost reduction upfront. Final terms are subject to credit approval.
    </p>
  ` : html`
    <table>
      <tr><td>Vehicle Price</td><td>$${deal.vehiclePrice.toLocaleString()}</td></tr>
      <tr><td>Trade-In Value</td><td>-$${deal.tradeInValue.toLocaleString()}</td></tr>
      <tr><td>Trade-In Payoff Owed</td><td>+$${deal.tradeInPayoff.toLocaleString()}</td></tr>
      <tr><td>Rebate / Discount</td><td>-$${deal.rebate.toLocaleString()}</td></tr>
      <tr><td>Down Payment</td><td>-$${deal.downPayment.toLocaleString()}</td></tr>
      <tr><td>Sales Tax (${deal.taxRate}%)</td><td>+$${deal.salesTax.toLocaleString()}</td></tr>
      ${fiRows}
      <tr><td>Title Fee</td><td>+$${(deal.titleFee || 0).toLocaleString()}</td></tr>
      <tr><td>Registration Fee</td><td>+$${(deal.registrationFee || 0).toLocaleString()}</td></tr>
      <tr class="total-row"><td>Amount Financed</td><td>$${deal.amountFinanced.toLocaleString()}</td></tr>
    </table>

    <div class="payment-highlight">
      <div class="amount">$${deal.monthlyPayment.toLocaleString()}/mo</div>
      <div>for ${deal.termMonths} months at ${deal.apr}% APR</div>
    </div>

    <table>
      <tr><td>Total of Payments</td><td>$${deal.totalOfPayments.toLocaleString()}</td></tr>
      <tr class="total-row"><td>Total Deal Cost (incl. down payment)</td><td>$${deal.totalDealCost.toLocaleString()}</td></tr>
    </table>

    <p class="fine-print">
      This proposal is an estimate for discussion purposes only and is not a binding offer of credit.
      Sales tax is calculated on vehicle price minus trade-in value, per typical state tax treatment;
      actual tax rules vary by state and jurisdiction. Final terms are subject to credit approval.
    </p>
  `;

  document.getElementById('proposalContent').innerHTML = html`
    <h2>Deal Proposal${isLease ? ' -- Lease' : ''}</h2>
    <div class="proposal-meta">
      <span><strong>Customer:</strong> ${customerName}</span>
      <span><strong>Vehicle:</strong> ${vehicleLabel}</span>
      <span><strong>Date:</strong> ${date}</span>
    </div>
    ${bodyHtml}
  `;

  proposalModal.classList.add('active');
};

document.getElementById('closeProposalBtn').addEventListener('click', () => {
  proposalModal.classList.remove('active');
});

document.getElementById('printProposalBtn').addEventListener('click', () => {
  window.print();
});

// ---------- AI Assistant (chat) ----------

let chatHistory = []; // { role: 'user' | 'assistant', text }

function renderChatBubble(role, text) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  document.getElementById('chatMessages').appendChild(div);
  document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
}

async function sendChatMessage(question) {
  renderChatBubble('user', question);
  chatHistory.push({ role: 'user', text: question });

  const loadingBubble = document.createElement('div');
  loadingBubble.className = 'chat-bubble assistant';
  loadingBubble.textContent = 'Thinking...';
  document.getElementById('chatMessages').appendChild(loadingBubble);
  document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;

  try {
    const res = await fetch(`${API}/ai/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history: chatHistory.slice(0, -1) })
    });
    const data = await res.json();
    loadingBubble.remove();

    if (!res.ok) {
      renderChatBubble('error', data.error || 'Something went wrong.');
      return;
    }
    renderChatBubble('assistant', data.answer);
    chatHistory.push({ role: 'assistant', text: data.answer });
  } catch (err) {
    loadingBubble.remove();
    renderChatBubble('error', 'Could not reach the AI assistant. Is the server running?');
  }
}

document.getElementById('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  sendChatMessage(question);
});

window.askExample = function(btn) {
  sendChatMessage(btn.textContent);
};

// ---------- AI Suggested Reply (on a lead's profile) ----------

document.getElementById('aiSuggestReplyBtn').addEventListener('click', async () => {
  const box = document.getElementById('aiSuggestionBox');
  box.style.display = 'block';
  box.innerHTML = `<div class="ai-suggestion-box">Generating a suggestion...</div>`;

  try {
    const res = await fetch(`${API}/ai/suggest-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: currentProfileLeadId })
    });
    const data = await res.json();

    if (!res.ok) {
      box.innerHTML = html`<div class="ai-suggestion-box">Couldn't generate a suggestion: ${data.error}</div>`;
      return;
    }

    box.innerHTML = html`
      <div class="ai-suggestion-box">
        <strong>Suggested reply:</strong>
        <textarea id="aiSuggestionText">${data.suggestion}</textarea>
        <div class="ai-suggestion-actions">
          <button type="button" class="btn-secondary" id="dismissSuggestionBtn">Dismiss</button>
          <button type="button" class="btn-primary" id="logSuggestionBtn">Add as Activity</button>
        </div>
      </div>
    `;

    document.getElementById('dismissSuggestionBtn').addEventListener('click', () => {
      box.style.display = 'none';
      box.innerHTML = '';
    });

    document.getElementById('logSuggestionBtn').addEventListener('click', async () => {
      const text = document.getElementById('aiSuggestionText').value;
      await fetch(`${API}/leads/${currentProfileLeadId}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'note', text: `AI-suggested reply sent: ${text}` })
      });
      box.style.display = 'none';
      box.innerHTML = '';
      await loadAll();
      const lead = leads.find(l => l.id === currentProfileLeadId);
      if (lead) renderActivityLog(lead);
    });
  } catch (err) {
    box.innerHTML = `<div class="ai-suggestion-box">Could not reach the AI assistant. Is the server running?</div>`;
  }
});

document.getElementById('sendTextBtn').addEventListener('click', async () => {
  const text = document.getElementById('sendTextInput').value.trim();
  const statusEl = document.getElementById('sendTextStatus');
  if (!text && !selectedSendTextPhoto) return;

  statusEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;">Sending...</div>`;

  try {
    const res = await fetch(`${API}/leads/${currentProfileLeadId}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, photoPath: selectedSendTextPhoto })
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.innerHTML = html`<div class="send-text-status-error">Couldn't send: ${data.error}</div>`;
      return;
    }

    statusEl.innerHTML = `<div class="send-text-status-success">✓ ${selectedSendTextPhoto ? 'Picture text' : 'Text'} sent and logged.</div>`;
    document.getElementById('sendTextInput').value = '';
    selectedSendTextPhoto = null;
    document.querySelectorAll('.photo-picker-thumb').forEach(el => el.classList.remove('selected'));
    await loadAll();
    const lead = leads.find(l => l.id === currentProfileLeadId);
    if (lead) renderActivityLog(lead);
  } catch (err) {
    statusEl.innerHTML = `<div class="send-text-status-error">Could not reach the server.</div>`;
  }
});

document.getElementById('aiSnapshotBtn').addEventListener('click', async () => {
  const box = document.getElementById('aiSnapshotBox');
  box.style.display = 'block';
  box.innerHTML = `<div class="ai-snapshot-box">Reading through their history...</div>`;

  try {
    const res = await fetch(`${API}/ai/lead-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadId: currentProfileLeadId })
    });
    const data = await res.json();

    if (!res.ok) {
      box.innerHTML = html`<div class="ai-snapshot-box">Couldn't generate a snapshot: ${data.error}</div>`;
      return;
    }

    box.innerHTML = html`<div class="ai-snapshot-box"><strong>🔍 Snapshot</strong><p>${data.snapshot}</p></div>`;
  } catch (err) {
    box.innerHTML = `<div class="ai-snapshot-box">Could not reach the AI assistant. Is the server running?</div>`;
  }
});

// ---------- Taxes & Fees (reference table admin screen) ----------

const taxRatesModal = document.getElementById('taxRatesModal');
let cachedTaxRates = [];

async function loadAndRenderTaxRates() {
  const res = await fetch(`${API}/tax-rates`);
  cachedTaxRates = await res.json();

  document.getElementById('taxRatesTableBody').innerHTML = cachedTaxRates.map(r => {
    const combined = (r.stateTaxRate + r.countyTaxRate + r.cityTaxRate).toFixed(3);
    return html`
      <tr>
        <td>${r.state}</td>
        <td>${r.county || '-- default --'}</td>
        <td>${r.city || '-- all cities --'}</td>
        <td>${r.stateTaxRate}%</td>
        <td>${r.countyTaxRate}%</td>
        <td>${r.cityTaxRate}%</td>
        <td><strong>${combined}%</strong></td>
        <td class="row-actions">
          <button onclick="editTaxRate(${js(r.id)})">Edit</button>
          <button class="delete" onclick="deleteTaxRate(${js(r.id)})">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---------- Admin menu (entry point, separate from sales workflow) ----------

const adminMenuModal = document.getElementById('adminMenuModal');

document.getElementById('adminMenuBtn').addEventListener('click', () => {
  adminMenuModal.classList.add('active');
});

document.getElementById('closeAdminMenuBtn').addEventListener('click', () => {
  adminMenuModal.classList.remove('active');
});

document.getElementById('adminTaxRatesBtn').addEventListener('click', async () => {
  await loadAndRenderTaxRates();
  adminMenuModal.classList.remove('active');
  taxRatesModal.classList.add('active');
});

document.getElementById('closeTaxRatesBtn').addEventListener('click', () => {
  taxRatesModal.classList.remove('active');
});

document.getElementById('clearTaxRateFormBtn').addEventListener('click', () => {
  document.getElementById('taxRateForm').reset();
  document.getElementById('taxRateId').value = '';
});

window.editTaxRate = function(id) {
  const rate = cachedTaxRates.find(r => r.id === id);
  if (!rate) return;
  document.getElementById('taxRateId').value = rate.id;
  document.getElementById('taxRateState').value = rate.state;
  document.getElementById('taxRateCounty').value = rate.county;
  document.getElementById('taxRateCity').value = rate.city;
  document.getElementById('taxRateStateRate').value = rate.stateTaxRate;
  document.getElementById('taxRateCountyRate').value = rate.countyTaxRate;
  document.getElementById('taxRateCityRate').value = rate.cityTaxRate;
};

window.deleteTaxRate = async function(id) {
  if (!confirm('Delete this tax rate record?')) return;
  await fetch(`${API}/tax-rates/${id}`, { method: 'DELETE' });
  await loadAndRenderTaxRates();
};

document.getElementById('taxRateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('taxRateId').value;
  const payload = {
    state: document.getElementById('taxRateState').value,
    county: document.getElementById('taxRateCounty').value,
    city: document.getElementById('taxRateCity').value,
    stateTaxRate: document.getElementById('taxRateStateRate').value,
    countyTaxRate: document.getElementById('taxRateCountyRate').value,
    cityTaxRate: document.getElementById('taxRateCityRate').value,
  };

  if (id) {
    await fetch(`${API}/tax-rates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    await fetch(`${API}/tax-rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  document.getElementById('taxRateForm').reset();
  document.getElementById('taxRateId').value = '';
  await loadAndRenderTaxRates();
});

// ---------- Fee Defaults (Settings) ----------

const feeDefaultsModal = document.getElementById('feeDefaultsModal');

document.getElementById('adminFeeDefaultsBtn').addEventListener('click', async () => {
  const res = await fetch(`${API}/settings`);
  const settings = await res.json();
  appSettings = settings;
  document.getElementById('settingsDocFee').value = settings.docFee;
  document.getElementById('settingsTitleFee').value = settings.titleFee;
  document.getElementById('settingsRegistrationFee').value = settings.registrationFee;
  document.getElementById('settingsLicenseFee').value = settings.licenseFee;
  document.getElementById('settingsDealerFees').value = settings.dealerFees;
  document.getElementById('settingsAcquisitionFee').value = settings.acquisitionFee;
  document.getElementById('settingsTaxRate').value = settings.taxRate;
  document.getElementById('settingsDmvFeeMethod').value = settings.dmvFeeMethod || 'flat';
  document.getElementById('settingsDmvFeePercentage').value = settings.dmvFeePercentage || 1.5;
  document.getElementById('dmvPercentageField').style.display = (settings.dmvFeeMethod === 'percentage') ? 'block' : 'none';
  adminMenuModal.classList.remove('active');
  feeDefaultsModal.classList.add('active');
});

document.getElementById('settingsDmvFeeMethod').addEventListener('change', (e) => {
  document.getElementById('dmvPercentageField').style.display = (e.target.value === 'percentage') ? 'block' : 'none';
});

document.getElementById('cancelFeeDefaultsBtn').addEventListener('click', () => {
  feeDefaultsModal.classList.remove('active');
});

document.getElementById('feeDefaultsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    docFee: document.getElementById('settingsDocFee').value,
    titleFee: document.getElementById('settingsTitleFee').value,
    registrationFee: document.getElementById('settingsRegistrationFee').value,
    licenseFee: document.getElementById('settingsLicenseFee').value,
    dealerFees: document.getElementById('settingsDealerFees').value,
    acquisitionFee: document.getElementById('settingsAcquisitionFee').value,
    taxRate: document.getElementById('settingsTaxRate').value,
    dmvFeeMethod: document.getElementById('settingsDmvFeeMethod').value,
    dmvFeePercentage: document.getElementById('settingsDmvFeePercentage').value,
  };
  const res = await fetch(`${API}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  appSettings = await res.json();
  feeDefaultsModal.classList.remove('active');
});

// ---------- Users & Roles (admins) ----------

const usersModal = document.getElementById('usersModal');
const ROLE_OPTIONS = [
  ['salesperson', 'Salesperson'],
  ['finance', 'F&I Manager'],
  ['sales_manager', 'Sales Manager'],
  ['admin', 'Admin']
];

async function loadAndRenderUsers() {
  const res = await fetch(`${API}/users`);
  if (!res.ok) return;
  const users = await res.json();
  document.getElementById('usersTableBody').innerHTML = users.map(u => {
    const isMe = u.id === currentUser.id;
    const roleSelect = html`
      <select class="user-role-select" onchange="changeUserRole(${js(u.id)}, this)" ${isMe ? html`disabled title="You can't change your own role"` : ''}>
        ${ROLE_OPTIONS.map(([value, label]) =>
          html`<option value="${value}" ${u.role === value ? 'selected' : ''}>${label}</option>`)}
      </select>`;
    return html`
      <tr class="${u.active ? '' : 'user-inactive'}">
        <td>${u.name}${isMe ? ' (you)' : ''}</td>
        <td>${u.email}</td>
        <td>${roleSelect}</td>
        <td>${u.active ? 'Active' : 'Deactivated'}</td>
        <td>${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
        <td class="row-actions">
          <button onclick="resetUserPassword(${js(u.id)})">Reset Password</button>
          ${isMe ? '' : html`<button class="${u.active ? 'delete' : ''}" onclick="setUserActive(${js(u.id)}, ${js(!u.active)})">${u.active ? 'Deactivate' : 'Reactivate'}</button>`}
        </td>
      </tr>`;
  }).join('');
}

async function updateUser(id, changes) {
  const res = await fetch(`${API}/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes)
  });
  if (!res.ok && res.status !== 403) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || 'Could not update this user.');
  }
  await loadAndRenderUsers();
  return res.ok;
}

window.changeUserRole = function(id, select) {
  updateUser(id, { role: select.value });
};

window.setUserActive = function(id, active) {
  if (!active && !confirm('Deactivate this user? They will be signed out and unable to sign in until reactivated.')) return;
  updateUser(id, { active });
};

window.resetUserPassword = async function(id) {
  const password = prompt('New temporary password for this user (at least 8 characters). They will be signed out everywhere.');
  if (password === null) return;
  if (await updateUser(id, { password })) alert('Password reset. Give them the new password in person.');
};

document.getElementById('adminUsersBtn').addEventListener('click', async () => {
  await loadAndRenderUsers();
  adminMenuModal.classList.remove('active');
  usersModal.classList.add('active');
});

document.getElementById('closeUsersBtn').addEventListener('click', () => {
  usersModal.classList.remove('active');
});

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`${API}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('newUserName').value,
      email: document.getElementById('newUserEmail').value,
      role: document.getElementById('newUserRole').value,
      password: document.getElementById('newUserPassword').value
    })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status !== 403) alert(body.error || 'Could not add this user.');
    return;
  }
  document.getElementById('addUserForm').reset();
  await loadAndRenderUsers();
});

// ---------- Audit Log (admins and sales managers) ----------

const auditLogModal = document.getElementById('auditLogModal');
let auditNextBefore = null;

const AUDIT_ACTION_LABELS = {
  create: 'Created', update: 'Changed', delete: 'Deleted',
  add_activity: 'Logged activity', delete_activity: 'Deleted activity', send_text: 'Sent text',
  add_photos: 'Added photos', remove_photo: 'Removed photo',
  sign_in: 'Signed in', sign_in_failed: 'Failed sign-in', sign_out: 'Signed out',
  change_password: 'Changed own password', reset_password: 'Password reset by admin'
};
const AUDIT_TYPE_LABELS = {
  car: 'Vehicle', lead: 'Customer', deal: 'Deal', user: 'User', tax_rate: 'Tax rate', settings: 'Fee defaults'
};

// "creditApp.applicant.firstName" -> "Credit App › Applicant › First Name"
const FIELD_NAME_OVERRIDES = { ssn: 'SSN', vin: 'VIN', dob: 'Date of Birth', apr: 'APR', ein: 'EIN', businessEIN: 'Business EIN' };

function humanizeFieldPath(path) {
  return path.split('.').map(part => FIELD_NAME_OVERRIDES[part] || part
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, ch => ch.toUpperCase())
  ).join(' › ');
}

function formatAuditValue(value) {
  if (value === null || value === undefined || value === '') return '(blank)';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function auditChangesHtml(entry) {
  const changes = entry.changes || {};
  const parts = [];
  if (entry.details) parts.push(html`<div class="audit-note">${entry.details}</div>`);
  for (const [field, change] of Object.entries(changes)) {
    if (field === 'deletedRecord') {
      parts.push(html`<details><summary>What was deleted</summary><pre>${JSON.stringify(change.from, null, 2)}</pre></details>`);
    } else if (change.hidden) {
      parts.push(html`<div class="audit-change"><span class="field">${humanizeFieldPath(field)}:</span> changed (hidden for privacy)</div>`);
    } else {
      parts.push(html`<div class="audit-change"><span class="field">${humanizeFieldPath(field)}:</span>
        <span class="old">${formatAuditValue(change.from)}</span> → ${formatAuditValue(change.to)}</div>`);
    }
  }
  return parts;
}

async function loadAuditLog({ append = false } = {}) {
  const params = new URLSearchParams();
  const type = document.getElementById('auditTypeFilter').value;
  const search = document.getElementById('auditSearch').value.trim();
  const from = document.getElementById('auditFrom').value;
  const to = document.getElementById('auditTo').value;
  if (type) params.set('entityType', type);
  if (search) params.set('search', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (append && auditNextBefore) params.set('before', auditNextBefore);

  const res = await fetch(`${API}/audit-log?${params}`);
  if (!res.ok) return;
  const { entries, nextBefore } = await res.json();
  auditNextBefore = nextBefore;

  const rows = entries.map(e => html`
    <tr>
      <td>${new Date(e.at).toLocaleString()}</td>
      <td>${e.userName || '(system)'}</td>
      <td><span class="audit-action ${e.action}">${AUDIT_ACTION_LABELS[e.action] || e.action}</span></td>
      <td>${AUDIT_TYPE_LABELS[e.entityType] || e.entityType}${e.label ? html`<br><strong>${e.label}</strong>` : ''}</td>
      <td>${auditChangesHtml(e)}</td>
    </tr>
  `).join('');

  const body = document.getElementById('auditTableBody');
  body.innerHTML = append ? body.innerHTML + rows : rows;
  document.getElementById('auditEmpty').style.display = body.children.length ? 'none' : 'block';
  document.getElementById('auditLoadMoreBtn').style.display = nextBefore ? '' : 'none';
}

document.getElementById('adminAuditLogBtn').addEventListener('click', async () => {
  adminMenuModal.classList.remove('active');
  auditLogModal.classList.add('active');
  await loadAuditLog();
});

document.getElementById('closeAuditLogBtn').addEventListener('click', () => {
  auditLogModal.classList.remove('active');
});

document.getElementById('auditLoadMoreBtn').addEventListener('click', () => loadAuditLog({ append: true }));

let auditSearchTimer = null;
document.getElementById('auditSearch').addEventListener('input', () => {
  clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => loadAuditLog(), 300);
});
for (const id of ['auditTypeFilter', 'auditFrom', 'auditTo']) {
  document.getElementById(id).addEventListener('change', () => loadAuditLog());
}

// ---------- Integrations (admins): key machine connection ----------

const integrationsModal = document.getElementById('integrationsModal');
const KEY_ACTION_LABELS = { check_out: 'Checked out', check_in: 'Checked in', missing: 'Missing' };

async function loadIntegrations() {
  document.getElementById('integrationEndpoint').textContent = `${location.origin}/api/integrations/keys/events`;

  const [tokensRes, unmatchedRes] = await Promise.all([
    fetch(`${API}/integrations/tokens`), fetch(`${API}/integrations/keys/unmatched`)
  ]);
  if (!tokensRes.ok || !unmatchedRes.ok) return;
  const tokens = await tokensRes.json();
  const unmatched = await unmatchedRes.json();

  document.getElementById('integrationTokensBody').innerHTML = tokens.length
    ? tokens.map(t => html`
        <tr>
          <td>${t.name}</td>
          <td>${new Date(t.createdAt).toLocaleDateString()}</td>
          <td>${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'Never'}</td>
          <td class="row-actions"><button class="delete" onclick="revokeIntegrationToken(${js(t.id)}, ${js(t.name)})">Revoke</button></td>
        </tr>`).join('')
    : html`<tr><td colspan="4" class="audit-note">No tokens yet.</td></tr>`;

  document.getElementById('unmatchedKeyEventsBody').innerHTML = unmatched.length
    ? unmatched.map(u => html`
        <tr>
          <td>${new Date(u.receivedAt).toLocaleString()}</td>
          <td>${KEY_ACTION_LABELS[u.action] || u.action}</td>
          <td>${[u.stockNumber && `Stock ${u.stockNumber}`, u.vin && `VIN ${u.vin}`, u.tagCode && `Tag ${u.tagCode}`].filter(Boolean).join(' · ')}</td>
          <td>${u.personName || ''}</td>
          <td>${u.source}</td>
        </tr>`).join('')
    : html`<tr><td colspan="5" class="audit-note">None -- every key event matched a car.</td></tr>`;
}

document.getElementById('adminIntegrationsBtn').addEventListener('click', async () => {
  adminMenuModal.classList.remove('active');
  document.getElementById('newTokenResult').innerHTML = '';
  integrationsModal.classList.add('active');
  await loadIntegrations();
});

document.getElementById('closeIntegrationsBtn').addEventListener('click', () => {
  document.getElementById('newTokenResult').innerHTML = ''; // don't leave a token on screen
  integrationsModal.classList.remove('active');
});

document.getElementById('newTokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`${API}/integrations/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: document.getElementById('newTokenName').value })
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status !== 403) alert(data.error || 'Could not create the token.');
    return;
  }
  document.getElementById('newTokenForm').reset();
  document.getElementById('newTokenResult').innerHTML = html`
    <div class="new-token-box">
      <strong>Copy this token now -- it won't be shown again.</strong>
      <code>${data.token}</code>
      Give it only to whoever is setting up the ${data.name} connection. Treat it like a password.
    </div>`;
  await loadIntegrations();
});

window.revokeIntegrationToken = async function(id, name) {
  if (!confirm(`Revoke the "${name}" token? Anything using it will stop sending key updates.`)) return;
  await fetch(`${API}/integrations/tokens/${id}`, { method: 'DELETE' });
  await loadIntegrations();
};

// ---------- My Account / Sign Out ----------

const accountModal = document.getElementById('accountModal');

document.getElementById('userMenuBtn').addEventListener('click', () => {
  document.getElementById('accountSummary').textContent =
    `${currentUser.name} · ${currentUser.email} · ${currentUser.roleLabel}`;
  accountModal.classList.add('active');
});

document.getElementById('closeAccountBtn').addEventListener('click', () => {
  document.getElementById('changePasswordForm').reset();
  accountModal.classList.remove('active');
});

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPassword = document.getElementById('newPassword').value;
  if (newPassword !== document.getElementById('confirmPassword').value) {
    alert("The new passwords don't match.");
    return;
  }
  const res = await fetch(`${API}/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: document.getElementById('currentPassword').value,
      newPassword
    })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert(body.error || 'Could not change your password.');
    return;
  }
  document.getElementById('changePasswordForm').reset();
  accountModal.classList.remove('active');
  alert('Password changed. Any other devices you were signed in on have been signed out.');
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  await fetch(`${API}/auth/logout`, { method: 'POST' });
  window.location.href = '/login.html';
});

// ---------- Init ----------

async function init() {
  const res = await fetch(`${API}/auth/me`);
  if (!res.ok) return; // the fetch wrapper is already sending them to sign in
  currentUser = await res.json();
  applyPermissionsToUI();
  loadAll();
}

init();
