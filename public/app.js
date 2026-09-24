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
let appraisals = [];
let openTasks = []; // every open task and appointment at the store
let providerList = []; // outside data sources and whether each is live yet
let currentAppraisal = null; // the appraisal open on screen (with unsaved edits)
let appraisalDirty = false;
let staffList = []; // who works here, for the appraiser / salesperson pickers
let retailPerformance = null; // this store's own sales of similar cars, for the open appraisal
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
// The left sidebar picks a module (CRM, Sales & F&I, Vehicle Management,
// Service, Accounting...). The icon bar at the top shows that module's
// screens ("views"). Adding a module = one entry here, its icons in the
// top bar (data-module="..."), and its panel.
//
// Most views are one panel; "leads" and "board" are the same Customers
// panel shown as a table or as a board.

const MODULES = [
  { key: 'crm', label: 'CRM', views: ['pipeline', 'leads', 'board', 'reports', 'assistant'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M17.5 14.4c2.3.7 4 2.8 4 5.6"/></svg>' },
  { key: 'sales', label: 'Sales & F&I', views: ['deals'],
    icon: '<svg viewBox="0 0 24 24"><path d="M3 12.5l4.5-4 3 1.5 3-2.5 3 1 4.5 4"/><path d="M5 11l5.5 5.5a1.6 1.6 0 0 0 2.2 0l.3-.3a1.6 1.6 0 0 0 0-2.2L10 11"/><path d="M13 16.5l1 1a1.6 1.6 0 0 0 2.2 0l.3-.3a1.6 1.6 0 0 0 0-2.2L13.5 12"/><path d="M16.5 15l.5.5a1.6 1.6 0 0 0 2.3-2.3l-2.8-2.7"/></svg>' },
  { key: 'vehicles', label: 'Vehicle Management', views: ['inventory', 'appraisals'],
    icon: '<svg viewBox="0 0 24 24"><path d="M4 16.5v-4.2L6.3 7a2 2 0 0 1 1.8-1.2h7.8A2 2 0 0 1 17.7 7L20 12.3v4.2"/><path d="M3 12.5h18v4H3z"/><path d="M5.5 16.5v2M18.5 16.5v2"/><path d="M6.5 14.5h.01M17.5 14.5h.01"/></svg>' },
  { key: 'service', label: 'Service', views: ['service'],
    icon: '<svg viewBox="0 0 24 24"><path d="M15 3.5a5 5 0 0 0-4.6 6.9L3.8 17a1.8 1.8 0 0 0 0 2.5l.7.7a1.8 1.8 0 0 0 2.5 0l6.6-6.6a5 5 0 0 0 6.9-4.6l-3.1 3.1-2.9-.6-.6-2.9z"/></svg>' },
  { key: 'accounting', label: 'Accounting', views: ['accounting'],
    icon: '<svg viewBox="0 0 24 24"><path d="M4 4.5h16v15H4z"/><path d="M4 9h16M9 9v10.5"/><path d="M12 13h5M12 16h3"/></svg>' }
];

const VIEW_PANELS = {
  pipeline: 'pipeline', leads: 'leads', board: 'leads', deals: 'deals', inventory: 'inventory', appraisals: 'appraisals',
  reports: 'dashboard', assistant: 'assistant', service: 'service', accounting: 'accounting'
};
let currentView = 'pipeline';

const moduleOfView = view => MODULES.find(m => m.views.includes(view));

function renderModuleNav() {
  document.getElementById('moduleNav').innerHTML = MODULES.map(m => html`
    <button type="button" class="rail-item rail-module" data-module="${m.key}" onclick="showModule(${js(m.key)})" title="${m.label}">
      ${new SafeHtml(m.icon)}<span class="rail-label">${m.label}</span>
    </button>`).join('');
}

window.showModule = function(moduleKey) {
  const module = MODULES.find(m => m.key === moduleKey);
  if (module.views.includes('leads')) clearLeadsListFilter();
  if (module.views.includes('inventory')) clearInventoryListFilter();
  showView(module.views[0]);
};

function showView(view) {
  if (currentView === 'appraisals' && view !== 'appraisals' && appraisalDirty &&
      !confirm('Leave this appraisal without saving your changes?')) return;
  if (view !== 'appraisals') { document.body.classList.remove('wide-page'); setAppraisalDirty(false); }
  currentView = view;
  const module = moduleOfView(view);
  document.querySelectorAll('.rail-module').forEach(b => b.classList.toggle('active', b.dataset.module === module.key));
  document.querySelectorAll('.nav-icon[data-view]').forEach(b => { b.style.display = b.dataset.module === module.key ? '' : 'none'; });
  document.getElementById('currentModuleName').textContent = module.label;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(VIEW_PANELS[view]).classList.add('active');
  document.querySelectorAll('.nav-icon[data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
  if (view === 'leads') setLeadsView('table');
  if (view === 'board') setLeadsView('kanban');
  if (view === 'appraisals') showAppraisalList();
  window.scrollTo(0, 0);
}

document.querySelectorAll('.nav-icon[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    // Choosing a screen from the bar shows everything, not a leftover filter.
    if (btn.dataset.view === 'leads' || btn.dataset.view === 'board') clearLeadsListFilter();
    if (btn.dataset.view === 'inventory') clearInventoryListFilter();
    showView(btn.dataset.view);
  });
});

document.getElementById('brandHomeBtn').addEventListener('click', () => showView('pipeline'));
renderModuleNav();
showView('pipeline');

// ---------- Data loading ----------

async function loadAll() {
  const [carsRes, leadsRes, dealsRes, statsRes, keysRes, appraisalsRes, tasksRes] = await Promise.all([
    fetch(`${API}/cars`).then(r => r.json()),
    fetch(`${API}/leads`).then(r => r.json()),
    fetch(`${API}/deals`).then(r => r.json()),
    fetch(`${API}/stats`).then(r => r.json()),
    fetch(`${API}/keys`).then(r => r.json()),
    fetch(`${API}/appraisals`).then(r => r.json()),
    fetch(`${API}/tasks?status=open`).then(r => r.json())
  ]);
  openTasks = Array.isArray(tasksRes) ? tasksRes : [];
  cars = carsRes;
  vehicleKeys = Array.isArray(keysRes) ? keysRes : [];
  appraisals = Array.isArray(appraisalsRes) ? appraisalsRes : [];
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
  renderAppraisalList();
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
  // Snoozed, or someone already has a follow-up scheduled: not "forgotten".
  if (lead.snoozedUntil && new Date(lead.snoozedUntil) > new Date()) return false;
  if (openTasks.some(t => t.leadId === lead.id)) return false;
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
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M8.5 14l2.5 2.5 4.5-4.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  calc: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8.5 6.5h7v3h-7z"/><path d="M8.5 13.5h.01M12 13.5h.01M15.5 13.5h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21.5V4"/><path d="M5 4.5h11l-2 3.5 2 3.5H5"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  userPlus: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6 1.6 0 3 .5 4.1 1.3"/><path d="M18.5 13v7M15 16.5h7"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M6 4l7 8-7 8M12 4l7 8-7 8"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M15 3.5V7h3.5"/><path d="M9 12.5h6M9 16h4"/><path d="M9 9h2.5"/></svg>'
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

// Hot: flagged 🔥 on their page, or activity in the last 24 hours.
const isHot = lead => !!lead.hot || Date.now() - lastTouch(lead) < DAY_MS;
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
  renderPipelineTasks();
}

// My tasks and appointments: overdue and today, soonest first. Managers
// can switch to everyone's.
let pipelineTasksScope = 'mine';
function renderPipelineTasks() {
  const el = document.getElementById('pipelineTasks');
  if (!el) return;
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const now = new Date();
  const mine = pipelineTasksScope === 'mine';
  const due = openTasks
    .filter(t => new Date(t.dueAt) <= endOfToday)
    .filter(t => !mine || (t.assignedTo && currentUser && t.assignedTo.id === currentUser.id));
  const upcoming = openTasks.filter(t => new Date(t.dueAt) > endOfToday && (!mine || (t.assignedTo && currentUser && t.assignedTo.id === currentUser.id))).length;
  el.innerHTML = html`
    <div class="pipeline-tasks-head">
      <h2>${mine ? 'My' : "Everyone's"} tasks today <span class="cp-count">${due.length}</span></h2>
      <div class="view-toggle">
        <button type="button" class="view-toggle-btn ${mine ? 'active' : ''}" onclick="setPipelineTasksScope('mine')">Mine</button>
        <button type="button" class="view-toggle-btn ${mine ? '' : 'active'}" onclick="setPipelineTasksScope('all')">Everyone</button>
      </div>
    </div>
    ${due.length ? html`<div class="pipeline-task-list">${due.map(t => {
      const when = new Date(t.dueAt);
      const overdue = when < now;
      const lead = leads.find(l => l.id === t.leadId);
      return html`<button type="button" class="pipeline-task ${overdue ? 'overdue' : ''}" onclick="openLeadProfile(${js(t.leadId)})">
        <span class="pipeline-task-icon">${TASK_ICONS[t.type] || '☑️'}</span>
        <span class="pipeline-task-main"><strong>${lead ? lead.name : t.leadName}</strong> · ${TASK_LABELS[t.type] || 'Task'}${t.title ? ` -- ${t.title}` : ''}</span>
        <span class="pipeline-task-when">${overdue ? `Overdue · ${when.toLocaleDateString()} ` : ''}${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${mine ? '' : ` · ${t.assignedTo ? t.assignedTo.name : ''}`}</span>
      </button>`;
    })}</div>` : html`<p class="audit-note">Nothing due today.${upcoming ? ` ${upcoming} coming up later.` : ''} Schedule follow-ups from a customer's page.</p>`}`;
}
window.setPipelineTasksScope = function(scope) {
  pipelineTasksScope = scope;
  renderPipelineTasks();
};

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
  const openAppraisals = appraisals.filter(a => a.status === 'open');
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const myDue = openTasks.filter(t => new Date(t.dueAt) <= endOfToday && t.assignedTo && currentUser && t.assignedTo.id === currentUser.id);
  return [
    { key: 'tasks', label: 'My Tasks Due', icon: ICONS.calendar, color: myDue.some(t => new Date(t.dueAt) < new Date()) ? 'red' : 'blue', count: myDue.length,
      open: () => { showView('pipeline'); const el = document.getElementById('pipelineTasks'); pipelineTasksScope = 'mine'; renderPipelineTasks(); if (el) el.scrollIntoView({ behavior: 'smooth' }); } },
    { key: 'followup', label: 'Follow-Up Due', icon: ICONS.bell, color: 'amber', count: followUp.length,
      open: () => { setLeadsListFilter('Follow-up due', followUp.map(l => l.id)); showView('leads'); } },
    { key: 'newtoday', label: 'New Today', icon: ICONS.userPlus, color: 'blue', count: newToday.length,
      open: () => { setLeadsListFilter('New today', newToday.map(l => l.id)); showView('leads'); } },
    { key: 'proposals', label: 'Open Proposals', icon: ICONS.calc, color: 'violet', count: proposals.length, railOnly: true,
      open: () => { showView('deals'); document.getElementById('dealStatusFilter').value = 'working'; renderDeals(); } },
    { key: 'appraisals', label: 'Open Appraisals', icon: ICONS.clipboard, color: 'violet', count: openAppraisals.length, railOnly: true,
      open: () => { showView('appraisals'); document.getElementById('appraisalStatusFilter').value = 'open'; renderAppraisalList(); } },
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
      <span class="rail-label">${a.label}</span>
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
  for (const a of appraisals) {
    const lead = leads.find(l => l.id === a.leadId);
    const vehicle = [a.year, a.make, a.model, a.trim].filter(Boolean).join(' ');
    if (`a-${a.appraisalNumber}`.includes(q) || (a.vin || '').toLowerCase().includes(q) ||
        (vehicle && vehicle.toLowerCase().includes(q)) || (lead && lead.name.toLowerCase().includes(q))) {
      results.push({ type: 'Appraisal', title: `A-${a.appraisalNumber}${vehicle ? ' · ' + vehicle : ''}`,
        sub: [lead && lead.name, a.vin].filter(Boolean).join(' · '), run: () => openAppraisal(a.id) });
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

// ---------- Appraisals (Vehicle Management) ----------
// Book out a trade or purchase: decode the VIN, pick trim and equipment,
// see market, book values, history, and recalls, work out recon and the
// offer, then mark it Acquired (creates the inventory car) or Lost.
// Outside data sources (market, KBB, Carfax...) each have a slot; until a
// source is connected its slot says "Not available yet".

const money = n => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)))
  ? '--' : `${Number(n) < 0 ? '-' : ''}$${Math.abs(Math.round(Number(n))).toLocaleString()}`;

const APPRAISAL_STATUS_LABELS = { open: 'Open', acquired: 'Acquired', lost: 'Lost' };
const CONDITION_LABELS = { excellent: 'Excellent', very_good: 'Very Good', good: 'Good', fair: 'Fair', poor: 'Poor' };
const APPRAISAL_SOURCE_LABELS = { trade_in: 'Trade-in', street_purchase: 'Street Purchase', service_drive: 'Service Drive' };
const APPRAISAL_CATEGORY_LABELS = { undecided: 'Decide Later', retail: 'Retail', wholesale: 'Wholesale' };

// Common equipment, grouped. When a factory-options source is connected,
// its exact option list for the VIN replaces this.
const EQUIPMENT_GROUPS = [
  { name: 'Comfort', items: ['Leather Seats', 'Heated Seats', 'Ventilated Seats', 'Heated Steering Wheel', 'Power Seats', 'Memory Seats', 'Third Row Seating', 'Dual-Zone Climate', 'Remote Start'] },
  { name: 'Technology', items: ['Navigation', 'Apple CarPlay / Android Auto', 'Premium Audio', 'Backup Camera', '360° Camera', 'Head-Up Display', 'Wireless Charging', 'Keyless Entry / Push Start'] },
  { name: 'Safety', items: ['Blind Spot Monitor', 'Adaptive Cruise Control', 'Lane Keep Assist', 'Parking Sensors', 'Automatic Emergency Braking'] },
  { name: 'Exterior', items: ['Sunroof / Moonroof', 'Panoramic Roof', 'Alloy Wheels', 'Tow Package', 'Running Boards', 'Roof Rack', 'Power Liftgate', 'LED Headlights'] }
];

const AP_FIELDS = [
  ['vin', 'apVin'], ['year', 'apYear'], ['make', 'apMake'], ['model', 'apModel'], ['trim', 'apTrim'],
  ['bodyStyle', 'apBodyStyle'], ['drivetrain', 'apDrivetrain'], ['engine', 'apEngine'], ['transmission', 'apTransmission'],
  ['fuelType', 'apFuelType'], ['mileage', 'apMileage'], ['exteriorColor', 'apExteriorColor'], ['interiorColor', 'apInteriorColor'],
  ['condition', 'apCondition'], ['leadId', 'apLeadId'], ['notes', 'apNotes'],
  ['source', 'apSource'], ['category', 'apCategory'],
  ['payoff', 'apPayoff'], ['lienholder', 'apLienholder'], ['customerExpects', 'apCustomerExpects'],
  ['targetRetail', 'apTargetRetail'], ['otherCosts', 'apOtherCosts'], ['targetGross', 'apTargetGross'], ['offer', 'apOffer']
];


function appraisalVehicle(a) {
  return [a.year, a.make, a.model, a.trim].filter(Boolean).join(' ') || 'Vehicle not entered yet';
}

// ----- List -----

function showAppraisalList() {
  if (appraisalDirty && currentAppraisal && !confirm('Leave this appraisal without saving your changes?')) return false;
  currentAppraisal = null;
  setAppraisalDirty(false);
  document.getElementById('appraisalDetailView').style.display = 'none';
  document.getElementById('appraisalListView').style.display = 'block';
  document.body.classList.remove('wide-page');
  renderAppraisalList();
  return true;
}

function renderAppraisalList() {
  const status = document.getElementById('appraisalStatusFilter').value;
  const q = document.getElementById('appraisalSearch').value.trim().toLowerCase();
  const rows = appraisals.filter(a => {
    if (status && a.status !== status) return false;
    if (!q) return true;
    const lead = leads.find(l => l.id === a.leadId);
    return `a-${a.appraisalNumber}`.includes(q) || (a.vin || '').toLowerCase().includes(q) ||
      appraisalVehicle(a).toLowerCase().includes(q) || (lead && lead.name.toLowerCase().includes(q));
  }).slice().reverse(); // newest first

  document.getElementById('appraisalTableBody').innerHTML = rows.map(a => {
    const lead = leads.find(l => l.id === a.leadId);
    return html`
      <tr>
        <td><button class="deal-number-link" onclick="openAppraisal(${js(a.id)})">A-${a.appraisalNumber}</button></td>
        <td>${new Date(a.dateCreated).toLocaleDateString()}</td>
        <td>${appraisalVehicle(a)}${a.vin ? html`<div class="inventory-trim">${a.vin}</div>` : ''}</td>
        <td>${a.mileage ? Number(a.mileage).toLocaleString() : '--'}</td>
        <td>${lead ? lead.name : '--'}</td>
        <td>${a.appraisedBy ? a.appraisedBy.name : html`<span class="needs-appraiser">Needs appraiser</span>`}${a.requestedBy ? html`<div class="inventory-trim">from ${a.requestedBy.name}</div>` : ''}</td>
        <td>${money(a.offer)}</td>
        <td><span class="badge appraisal-${a.status}">${APPRAISAL_STATUS_LABELS[a.status]}</span></td>
      </tr>`;
  }).join('');
  document.getElementById('appraisalEmpty').style.display = rows.length ? 'none' : 'block';
}

document.getElementById('appraisalStatusFilter').addEventListener('change', renderAppraisalList);
document.getElementById('appraisalSearch').addEventListener('input', renderAppraisalList);

// Starts a new appraisal (optionally already tied to a customer / deal /
// trade details) and opens it.
async function startAppraisal(prefill = {}) {
  const res = await fetch(`${API}/appraisals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prefill)
  });
  if (!res.ok) return;
  const created = await res.json();
  appraisals.push(created);
  renderRail();
  await openAppraisal(created.id);
  // Trade details from a deal often include the VIN already. The VIN is the
  // source of truth, so decode it even if older year/make/model came along.
  if (created.vin && VIN_PATTERN.test(created.vin)) decodeAppraisalVin({ overwrite: true });
}

document.getElementById('newAppraisalBtn').addEventListener('click', () => startAppraisal());

// ----- Detail -----

window.openAppraisal = async function(id) {
  const a = appraisals.find(x => x.id === id);
  if (!a) return;
  if (currentView !== 'appraisals') showView('appraisals');
  document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
  if (document.getElementById('dealFullPage').classList.contains('active')) closeDealFullPage();
  currentAppraisal = JSON.parse(JSON.stringify(a));
  document.getElementById('appraisalListView').style.display = 'none';
  document.getElementById('appraisalDetailView').style.display = 'block';
  document.body.classList.add('wide-page'); // three columns need more than the normal page width
  renderAppraisalDetail();
  setAppraisalDirty(false);
  window.scrollTo(0, 0);
};

function setAppraisalDirty(dirty) {
  appraisalDirty = dirty;
  document.getElementById('appraisalDirty').textContent = dirty ? 'Unsaved changes' : '';
}

function renderAppraisalDetail() {
  const a = currentAppraisal;
  document.getElementById('appraisalTitle').textContent = `Appraisal A-${a.appraisalNumber}`;
  document.getElementById('appraisalStatusBadge').innerHTML =
    html`<span class="badge appraisal-${a.status}">${APPRAISAL_STATUS_LABELS[a.status]}</span>`;

  document.getElementById('apLeadId').innerHTML = html`<option value="">-- None --</option>` +
    leads.map(l => html`<option value="${l.id}">${l.name}</option>`).join('');
  for (const [field, inputId] of AP_FIELDS) {
    document.getElementById(inputId).value = a[field] ?? '';
  }
  if (!a.source) document.getElementById('apSource').value = 'trade_in';
  if (!a.category) document.getElementById('apCategory').value = 'undecided';
  // The appraiser: anyone on staff (plus whoever it is now, even if they've since left).
  const appraiserOptions = [...staffList];
  if (a.appraisedBy && !appraiserOptions.some(u => u.id === a.appraisedBy.id)) appraiserOptions.unshift(a.appraisedBy);
  document.getElementById('apAppraiser').innerHTML = (a.appraisedBy ? '' : html`<option value="">-- Needs an appraiser --</option>`) +
    appraiserOptions.map(u => html`<option value="${u.id}">${u.name}</option>`).join('');
  document.getElementById('apAppraiser').value = a.appraisedBy ? a.appraisedBy.id : '';
  // Older appraisals didn't store this; if they had an offer, keep it and work out the profit.
  const solveFor = a.calcSolveFor || (a.offer ? 'profit' : 'appraisal');
  document.querySelectorAll('input[name="apSolveFor"]').forEach(r => { r.checked = r.value === solveFor; });
  document.getElementById('apVinStatus').innerHTML = '';
  document.getElementById('apOfferHistory').hidden = true;

  const locked = a.status !== 'open';
  document.querySelectorAll('#appraisalDetailView input, #appraisalDetailView select, #appraisalDetailView textarea')
    .forEach(el => { if (!el.closest('#apOutcome')) el.disabled = locked; });
  document.getElementById('apDecodeBtn').disabled = locked;
  document.getElementById('apAddReconBtn').disabled = locked;
  document.getElementById('appraisalSaveBtn').style.display = locked ? 'none' : '';

  renderEquipment();
  renderProviderSlots();
  renderRecalls();
  renderReconLines();
  renderSummaryHeader();
  updateOfferCalc();
  renderOfferHistory();
  renderCustomerOffer();
  renderOutcome();
  loadRetailPerformance();
}

// Reads the form back into currentAppraisal.
function collectAppraisalForm() {
  const a = currentAppraisal;
  for (const [field, inputId] of AP_FIELDS) a[field] = document.getElementById(inputId).value;
  a.leadId = a.leadId || null;
  a.appraiserId = document.getElementById('apAppraiser').value || null;
  a.calcSolveFor = (document.querySelector('input[name="apSolveFor"]:checked') || {}).value || 'appraisal';
  a.recon = [...document.querySelectorAll('.recon-line')].map(row => ({
    description: row.querySelector('.recon-desc').value,
    cost: Number(row.querySelector('.recon-cost').value) || 0
  })).filter(r => r.description || r.cost);
  a.equipment = [...document.querySelectorAll('.equipment-chip.selected')].map(b => b.dataset.item);
  return a;
}

async function saveAppraisal() {
  const a = collectAppraisalForm();
  const res = await fetch(`${API}/appraisals/${a.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(a)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status !== 403) alert(body.error || 'Could not save the appraisal.');
    return false;
  }
  const saved = await res.json();
  const vehicleChanged = ['year', 'make', 'model'].some(f => String(saved[f] ?? '') !== String((appraisals.find(x => x.id === saved.id) || {})[f] ?? ''));
  replaceAppraisal(saved);
  currentAppraisal = JSON.parse(JSON.stringify(saved));
  setAppraisalDirty(false);
  renderSummaryHeader();
  renderOfferHistory();
  if (vehicleChanged) loadRetailPerformance();
  // Pre-fill "Bought for" / "Asking price" from the saved offer and target
  // retail, unless someone already typed there.
  const acquiredFor = document.getElementById('apAcquiredFor');
  const asking = document.getElementById('apAskingPrice');
  if (acquiredFor && !acquiredFor.value && saved.offer) acquiredFor.value = saved.offer;
  if (asking && !asking.value && saved.targetRetail) asking.value = saved.targetRetail;
  const coAmount = document.getElementById('apCoAmount');
  if (coAmount && !coAmount.value && saved.offer) coAmount.value = saved.offer;
  return true;
}

function replaceAppraisal(updated) {
  const i = appraisals.findIndex(x => x.id === updated.id);
  if (i >= 0) appraisals[i] = updated; else appraisals.push(updated);
}

document.getElementById('appraisalSaveBtn').addEventListener('click', saveAppraisal);
document.getElementById('appraisalBackBtn').addEventListener('click', showAppraisalList);
// The outcome and customer-offer boxes act on their own (their buttons
// save), so typing there doesn't count as an unsaved appraisal change.
const apSeparateForm = el => el.closest('#apOutcome, #apCustomerOffer');
document.getElementById('appraisalDetailView').addEventListener('input', (e) => {
  if (apSeparateForm(e.target)) return;
  setAppraisalDirty(true);
  updateOfferCalc();
});
document.getElementById('appraisalDetailView').addEventListener('change', (e) => {
  if (apSeparateForm(e.target)) return;
  setAppraisalDirty(true);
  updateOfferCalc();
});
window.addEventListener('beforeunload', (e) => {
  if (appraisalDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ----- VIN decode (same decoder as inventory), then recalls -----

async function decodeAppraisalVin({ overwrite = false } = {}) {
  await decodeVinInto({
    inputId: 'apVin',
    statusId: 'apVinStatus',
    fill: data => {
      // Decoding replaces what the VIN determines; when starting from a deal's
      // trade, fields the VIN doesn't cover are cleared rather than left stale.
      const set = (id, v) => { if (v || overwrite) document.getElementById(id).value = v || ''; };
      set('apYear', data.year); set('apMake', data.make); set('apModel', data.model); set('apTrim', data.trim);
      set('apBodyStyle', data.bodyStyle); set('apDrivetrain', data.drivetrain); set('apEngine', data.engine);
      set('apTransmission', data.transmission); set('apFuelType', data.fuelType);
    }
  });
  if (document.getElementById('apMake').value) {
    setAppraisalDirty(true);
    if (await saveAppraisal()) await checkRecalls();
  }
}
document.getElementById('apDecodeBtn').addEventListener('click', () => decodeAppraisalVin({ overwrite: true }));
document.getElementById('apVin').addEventListener('input', (e) => {
  if (VIN_PATTERN.test(cleanVin(e.target.value)) && !document.getElementById('apMake').value) decodeAppraisalVin();
});

// ----- Equipment -----

function renderEquipment() {
  const selected = new Set(currentAppraisal.equipment || []);
  const locked = currentAppraisal.status !== 'open';
  document.getElementById('apEquipment').innerHTML = EQUIPMENT_GROUPS.map(g => html`
    <div class="equipment-group">
      <div class="equipment-group-name">${g.name}</div>
      <div class="equipment-chips">
        ${g.items.map(item => html`<button type="button" class="equipment-chip ${selected.has(item) ? 'selected' : ''}" data-item="${item}" ${locked ? html`disabled` : ''}>${item}</button>`)}
      </div>
    </div>`).join('');
}
document.getElementById('apEquipment').addEventListener('click', (e) => {
  const chip = e.target.closest('.equipment-chip');
  if (!chip || chip.disabled) return;
  chip.classList.toggle('selected');
  setAppraisalDirty(true);
});

// ----- Provider slots ("Not available yet" until connected) -----

function providerSlotHtml(p, big = false) {
  const live = p.status === 'live';
  return html`
    <div class="plug ${big ? 'plug-big' : ''}" data-provider="${p.key}">
      <button type="button" class="plug-head" onclick="togglePlugInfo(${js(p.key)})">
        <span class="plug-name">${p.name}</span>
        <span class="plug-status ${live ? 'live' : ''}">${live ? 'Live' : 'Not available yet'}</span>
      </button>
      <div class="plug-info" id="plug-info-${p.key}" hidden>
        <p>${p.description}</p>
        ${live ? '' : html`<p class="plug-needs">Not available yet -- this fills in automatically once ${p.needs} is connected.</p>`}
      </div>
    </div>`;
}

window.togglePlugInfo = function(key) {
  const el = document.getElementById(`plug-info-${key}`);
  if (el) el.hidden = !el.hidden;
};

// What a section will show once its source is connected -- laid out now,
// with dashes until then.
function pendingStats(labels) {
  return html`<div class="pending-stats">${labels.map(l => html`<div><span>${l}</span><strong>--</strong></div>`)}</div>`;
}

function renderProviderSlots() {
  const byCat = cat => providerList.filter(p => p.category === cat);
  const slots = cat => byCat(cat).map(p => providerSlotHtml(p)).join('');
  document.getElementById('apMarketPlug').innerHTML = byCat('market').map(p => providerSlotHtml(p, true)).join('') +
    pendingStats(['Comparables', 'Rank', '% of market', 'Market days supply', 'Low', 'Average', 'High']);
  document.getElementById('apOptionsPlug').innerHTML = slots('options');
  document.getElementById('apBookPlugs').innerHTML = slots('book') +
    html`<button type="button" class="btn-secondary btn-small" disabled title="Not available yet -- needs the book licenses">Print Book Sheets (not available yet)</button>`;
  document.getElementById('apAuctionPlugs').innerHTML = slots('auctions') +
    pendingStats(['Above', 'Average', 'Below', 'Last 30 days', 'Last 6 months', 'Last year']);
  document.getElementById('apHistoryPlugs').innerHTML = slots('history') + slots('sticker');
}

// ----- Recalls (live, NHTSA) -----

// Two different questions, answered separately and labeled plainly:
//  - "Recalls for this model": every recall NHTSA has issued for the
//    year/make/model (live, free). Some may already be fixed on this car.
//  - "Open recalls for this VIN": what's still unrepaired on this exact
//    car. That's the official NHTSA VIN search (one click away) until a
//    VIN-level data source is connected.
function nhtsaVinLink(vin) {
  return VIN_PATTERN.test(vin || '')
    ? html`<a class="btn-secondary btn-small nhtsa-vin-link" href="https://www.nhtsa.gov/recalls?vin=${encodeURIComponent(vin)}" target="_blank" rel="noopener noreferrer">Check this VIN for open recalls on NHTSA ↗</a>`
    : html`<span class="audit-note">Enter the VIN to check its open recalls on nhtsa.gov.</span>`;
}

function renderRecalls() {
  const a = currentAppraisal;
  const el = document.getElementById('apRecalls');
  const vinSlot = providerList.filter(p => p.key === 'vin_recalls').map(p => providerSlotHtml(p));
  const vinBlock = html`<div class="recall-vin">${vinSlot}${nhtsaVinLink(a.vin)}</div>`;

  if (!a.recalls) {
    el.innerHTML = html`${vinBlock}
      <p class="audit-note">Recalls for the model are checked automatically once the year, make, and model are in.</p>
      <button type="button" class="btn-secondary btn-small" onclick="checkRecalls()">Check model recalls</button>`;
    return;
  }
  const r = a.recalls;
  const items = r.items || [];
  const vehicle = r.vehicle || [a.year, a.make, a.model].filter(Boolean).join(' ');
  let summary;
  if (r.modelFound === false) {
    summary = html`<div class="recall-summary unknown">NHTSA doesn't list a model matching "${a.model}" for ${a.year} ${a.make}. This does not mean there are no recalls -- check the VIN on NHTSA.</div>`;
  } else if (items.length) {
    summary = html`<div class="recall-summary has-recalls">${items.length} recall${items.length === 1 ? '' : 's'} issued for the ${vehicle}</div>
      <div class="audit-note">These apply to the model in general. Some may already be repaired on this car -- the NHTSA VIN check shows which are still open.</div>`;
  } else {
    summary = html`<div class="recall-summary no-recalls">No recalls issued for the ${vehicle}</div>`;
  }
  const checked = (r.matchedModels || []).length
    ? html` NHTSA model names checked: ${(r.matchedModels || []).join(', ')}.` : '';
  el.innerHTML = html`
    ${vinBlock}
    <div class="recall-model-title">Recalls for this model</div>
    ${summary}
    ${items.map(item => html`
      <details class="recall-item">
        <summary><strong>${item.component || 'Recall'}</strong> <span class="audit-note">#${item.campaign}${item.models && item.models.length ? ` · ${item.models.join(', ')}` : ''}</span></summary>
        <p>${item.summary}</p>
        ${item.remedy ? html`<p><strong>Remedy:</strong> ${item.remedy}</p>` : ''}
      </details>`)}
    <p class="audit-note">Checked ${new Date(r.checkedAt).toLocaleString()}.${checked} <button type="button" class="link-btn" onclick="checkRecalls()">Check again</button></p>`;
}

window.checkRecalls = async function() {
  const a = currentAppraisal;
  if (!a) return;
  document.getElementById('apRecalls').innerHTML = html`<p class="audit-note">Checking NHTSA...</p>`;
  const res = await fetch(`${API}/appraisals/${a.id}/recalls`, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    document.getElementById('apRecalls').innerHTML = html`<p class="send-text-status-error">${body.error || 'Could not check recalls.'}</p>
      <button type="button" class="btn-secondary btn-small" onclick="checkRecalls()">Try again</button>`;
    return;
  }
  replaceAppraisal(body);
  currentAppraisal.recalls = body.recalls;
  renderRecalls();
};

// ----- Recon -----

function renderReconLines() {
  const lines = currentAppraisal.recon && currentAppraisal.recon.length ? currentAppraisal.recon : [{ description: '', cost: '' }];
  const locked = currentAppraisal.status !== 'open';
  document.getElementById('apReconLines').innerHTML = lines.map(r => html`
    <div class="recon-line">
      <input type="text" class="recon-desc" placeholder="e.g. Tires, detail, windshield" value="${r.description}" ${locked ? html`disabled` : ''} />
      <input type="number" class="recon-cost" placeholder="$" value="${r.cost}" ${locked ? html`disabled` : ''} />
      <button type="button" class="recon-remove" title="Remove line" aria-label="Remove line" ${locked ? html`disabled` : ''}>✕</button>
    </div>`).join('');
}
document.getElementById('apAddReconBtn').addEventListener('click', () => {
  collectAppraisalForm();
  currentAppraisal.recon = [...(currentAppraisal.recon || []), { description: '', cost: '' }];
  renderReconLines();
  setAppraisalDirty(true);
  const inputs = document.querySelectorAll('.recon-desc');
  inputs[inputs.length - 1].focus();
});
document.getElementById('apReconLines').addEventListener('click', (e) => {
  if (!e.target.classList.contains('recon-remove')) return;
  e.target.closest('.recon-line').remove();
  collectAppraisalForm();
  if (!currentAppraisal.recon.length) renderReconLines();
  setAppraisalDirty(true);
  updateOfferCalc();
});

// ----- Appraisal calculator -----
// asking price - recon - pack - other - profit = appraisal
// Pick which one to work out; it's calculated from the others.

function apNumber(id) { return Number(document.getElementById(id).value) || 0; }

function updateOfferCalc() {
  const reconTotal = [...document.querySelectorAll('.recon-cost')].reduce((sum, i) => sum + (Number(i.value) || 0), 0);
  const pack = Number(appSettings.appraisalPack) || 0;
  const solveFor = (document.querySelector('input[name="apSolveFor"]:checked') || {}).value || 'appraisal';
  const costs = reconTotal + pack + apNumber('apOtherCosts');
  const inputs = { appraisal: 'apOffer', profit: 'apTargetGross', asking: 'apTargetRetail' };

  document.getElementById('apReconTotal').textContent = money(reconTotal);
  document.getElementById('apCalcRecon').textContent = money(reconTotal);
  document.getElementById('apCalcPack').textContent = money(pack);

  const locked = currentAppraisal && currentAppraisal.status !== 'open';
  for (const [key, id] of Object.entries(inputs)) {
    const el = document.getElementById(id);
    el.readOnly = key === solveFor;
    el.closest('label').classList.toggle('calc-solved', key === solveFor);
    if (locked) el.readOnly = true;
  }

  let note = '';
  const asking = apNumber('apTargetRetail'), profit = apNumber('apTargetGross'), appraisal = apNumber('apOffer');
  if (!locked) {
    if (solveFor === 'appraisal') {
      if (asking) document.getElementById('apOffer').value = asking - costs - profit;
      else { document.getElementById('apOffer').value = ''; note = 'Enter the asking price to work out the appraisal.'; }
    } else if (solveFor === 'profit') {
      if (asking && appraisal) document.getElementById('apTargetGross').value = asking - costs - appraisal;
      else note = 'Enter the asking price and appraisal to work out the profit.';
    } else if (appraisal) {
      document.getElementById('apTargetRetail').value = appraisal + costs + profit;
    } else note = 'Enter the appraisal to work out the asking price.';
  }
  const gross = apNumber('apTargetGross');
  if (!note && gross < 0) note = html`<span class="offer-over">That's a ${money(-gross)} loss.</span>`;
  document.getElementById('apOfferNote').innerHTML = note;
  renderValues();
}

document.getElementById('apHistoryToggle').addEventListener('click', () => {
  const el = document.getElementById('apOfferHistory');
  el.hidden = !el.hidden;
  document.getElementById('apHistoryToggle').textContent = el.hidden ? 'View history' : 'Hide history';
});

// Every saved change to the appraisal amount, newest first.
function renderOfferHistory() {
  const a = currentAppraisal;
  document.getElementById('apCurrentValue').textContent = a.offer ? money(a.offer) : '--';
  const history = (a.offerHistory || []).slice().reverse();
  document.getElementById('apOfferHistory').innerHTML = history.length
    ? html`<table class="mini-table">${history.map(h => html`
        <tr><td>${new Date(h.at).toLocaleString()}</td><td>${h.by ? h.by.name : '--'}</td>
          <td>${h.previous !== null && h.previous !== undefined ? html`${money(h.previous)} → ` : ''}<strong>${h.amount === null ? 'cleared' : money(h.amount)}</strong></td></tr>`)}</table>`
    : html`<p class="audit-note">No appraisal amount saved yet.</p>`;
}

// ----- Summary header: vehicle, source, and values at a glance -----

function renderSummaryHeader() {
  const a = currentAppraisal;
  document.getElementById('apSummaryVehicle').textContent = appraisalVehicle(a);
  document.getElementById('apSummaryVin').textContent = [a.vin ? `VIN ${a.vin}` : 'No VIN yet',
    a.mileage ? `${Number(a.mileage).toLocaleString()} mi` : '', a.exteriorColor].filter(Boolean).join(' · ');
  document.getElementById('apHistoryChips').innerHTML = providerList.filter(p => p.category === 'history').map(p => html`
    <button type="button" class="history-chip" onclick="jumpToAppraisalCard('apCardHistory')" title="${p.status === 'live' ? p.name : `${p.name}: not available yet`}">
      ${p.name}<span>${p.status === 'live' ? '✓' : 'n/a'}</span></button>`).join('');
}

// Every value next to the appraisal, with the difference (value - appraisal).
function renderValues() {
  const appraisal = apNumber('apOffer');
  const provider = key => providerList.find(p => p.key === key);
  const rows = [
    { label: 'Asking price', value: apNumber('apTargetRetail') || null },
    { label: 'Customer hopes to get', value: apNumber('apCustomerExpects') || null },
    { label: 'Payoff (owed)', value: apNumber('apPayoff') || null },
    { label: 'Your avg sale, similar cars', value: retailPerformance && retailPerformance.ready ? retailPerformance.sold.avgSalePrice : null,
      empty: retailPerformance && retailPerformance.ready ? 'No sales yet' : '--' },
    { key: 'market', label: 'Market value' },
    { key: 'mmr', label: 'MMR' },
    { key: 'kbb', label: 'KBB trade-in' },
    { key: 'jdpower', label: 'J.D. Power clean trade-in' },
    { key: 'blackbook', label: 'Black Book' }
  ];
  document.getElementById('apValues').innerHTML = html`
    <div class="ap-value-row ap-value-main"><span>Appraisal</span><strong>${appraisal ? money(appraisal) : '--'}</strong><span></span></div>
    ${rows.map(r => {
      const p = r.key ? provider(r.key) : null;
      if (p && p.status !== 'live') {
        return html`<div class="ap-value-row muted"><span>${r.label}</span><span>Not available yet</span><span></span></div>`;
      }
      if (r.value === null || r.value === undefined) {
        return html`<div class="ap-value-row"><span>${r.label}</span><span>${r.empty || '--'}</span><span></span></div>`;
      }
      const diff = appraisal ? r.value - appraisal : null;
      return html`<div class="ap-value-row"><span>${r.label}</span><strong>${money(r.value)}</strong>
        <span class="${diff === null ? '' : diff < 0 ? 'diff-neg' : 'diff-pos'}">${diff === null ? '' : `${diff < 0 ? '-' : '+'}${money(Math.abs(diff))}`}</span></div>`;
    })}`;
}

// ----- Retail performance: this store's own sales of similar cars -----

async function loadRetailPerformance() {
  const a = currentAppraisal;
  retailPerformance = null;
  renderRetailPerformance();
  const res = await fetch(`${API}/appraisals/${a.id}/retail-performance`);
  if (!res.ok || !currentAppraisal || currentAppraisal.id !== a.id) return;
  retailPerformance = await res.json();
  renderRetailPerformance();
  renderValues();
}

function renderRetailPerformance() {
  const el = document.getElementById('apRetail');
  const r = retailPerformance;
  if (!r) { el.innerHTML = html`<p class="audit-note">Loading...</p>`; return; }
  if (!r.ready) { el.innerHTML = html`<p class="audit-note">Shows once the make and model are in.</p>`; return; }
  const days = n => n === null ? '--' : `${n} day${n === 1 ? '' : 's'}`;
  el.innerHTML = html`
    <div class="audit-note">Matching ${r.matching}</div>
    <div class="retail-stats">
      <div><span>Sold</span><strong>${r.sold.count}</strong></div>
      <div><span>Avg days to sell</span><strong>${days(r.sold.avgDaysToSell)}</strong></div>
      <div><span>Avg sale price</span><strong>${r.sold.avgSalePrice === null ? '--' : money(r.sold.avgSalePrice)}</strong></div>
      <div><span>Avg gross</span><strong>${r.sold.avgGross === null ? '--' : money(r.sold.avgGross)}</strong></div>
      <div><span>In stock now</span><strong>${r.inStock.count}</strong></div>
      <div><span>Avg asking (in stock)</span><strong>${r.inStock.avgAskingPrice === null ? '--' : money(r.inStock.avgAskingPrice)}</strong></div>
    </div>
    ${r.sold.recent.length ? html`<table class="mini-table">
      <tr><th>Sold</th><th>Car</th><th>Miles</th><th>Price</th><th>Gross</th><th>Days</th></tr>
      ${r.sold.recent.map(c => html`<tr>
        <td>${c.dateSold ? new Date(c.dateSold).toLocaleDateString() : '--'}</td>
        <td>${[c.year, c.model, c.trim].filter(Boolean).join(' ')}${c.stockNumber ? ` #${c.stockNumber}` : ''}</td>
        <td>${c.mileage ? Number(c.mileage).toLocaleString() : '--'}</td>
        <td>${money(c.salePrice)}</td><td>${money(c.gross)}</td><td>${c.daysToSell ?? '--'}</td></tr>`)}
    </table>` : html`<p class="audit-note">No sales of similar cars yet -- this fills in as you sell them.</p>`}`;
}

// ----- Customer offer -----

function renderCustomerOffer() {
  const a = currentAppraisal;
  const el = document.getElementById('apCustomerOffer');
  const lead = leads.find(l => l.id === a.leadId);
  const past = (a.customerOffers || []).slice().reverse();
  const pastHtml = past.length ? html`<table class="mini-table">${past.map(o => html`
      <tr><td>${new Date(o.at).toLocaleDateString()}</td><td><strong>${money(o.amount)}</strong></td>
        <td>${o.salesperson ? o.salesperson.name : (o.by ? o.by.name : '')}</td></tr>`)}</table>` : '';
  if (a.status !== 'open') {
    el.innerHTML = pastHtml || html`<p class="audit-note">No offers were made.</p>`;
    return;
  }
  const me = staffList.find(u => u.id === currentUser.id);
  el.innerHTML = html`
    <div class="customer-offer-form">
      <label>Offer <input type="number" id="apCoAmount" value="${a.offer ?? ''}" /></label>
      ${lead ? html`<div class="co-customer">Customer: <strong>${lead.name}</strong></div>
        ${lead.phone ? '' : html`<label>Phone <input type="tel" id="apCoPhone" /></label>`}
        ${lead.email ? '' : html`<label>Email <input type="email" id="apCoEmail" /></label>`}`
      : html`
        <label>First name <input type="text" id="apCoFirst" /></label>
        <label>Last name <input type="text" id="apCoLast" /></label>
        <label>Phone <input type="tel" id="apCoPhone" /></label>
        <label>Email <input type="email" id="apCoEmail" /></label>`}
      <label>Salesperson
        <select id="apCoSalesperson">
          <option value="">--</option>
          ${staffList.map(u => html`<option value="${u.id}" ${me && me.id === u.id ? html`selected` : ''}>${u.name}</option>`)}
        </select>
      </label>
    </div>
    <button type="button" class="btn-primary btn-small" id="apCoCreateBtn">Create Customer Offer</button>
    <span class="audit-note" id="apCoStatus"></span>
    ${lead ? '' : html`<p class="audit-note">Creates the customer in the CRM, or pick an existing one under Vehicle → Customer.</p>`}
    ${pastHtml}`;
  document.getElementById('apCoCreateBtn').onclick = createCustomerOffer;
}

async function createCustomerOffer() {
  if (appraisalDirty && !(await saveAppraisal())) return;
  const val = id => (document.getElementById(id) || {}).value || '';
  const res = await fetch(`${API}/appraisals/${currentAppraisal.id}/customer-offer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: val('apCoAmount'), firstName: val('apCoFirst'), lastName: val('apCoLast'),
      phone: val('apCoPhone'), email: val('apCoEmail'), salespersonId: val('apCoSalesperson') || null
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status !== 403) document.getElementById('apCoStatus').innerHTML = html`<span class="send-text-status-error">${body.error || 'Could not save the offer.'}</span>`;
    return;
  }
  const i = leads.findIndex(l => l.id === body.lead.id);
  if (i >= 0) leads[i] = body.lead; else leads.push(body.lead);
  replaceAppraisal(body.appraisal);
  renderRail();
  await openAppraisal(body.appraisal.id);
  document.getElementById('apCoStatus').textContent = body.leadCreated
    ? `Offer saved. ${body.lead.name} was added to your customers.` : 'Offer saved.';
}

// ----- Section tabs and collapsing -----

window.jumpToAppraisalCard = function(id) {
  const card = document.getElementById(id);
  if (!card) return;
  card.classList.remove('collapsed');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.getElementById('apTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-target]');
  if (btn) jumpToAppraisalCard(btn.dataset.target);
});
document.getElementById('apCollapseAllBtn').addEventListener('click', () => {
  const cards = [...document.querySelectorAll('#appraisalDetailView .appraisal-layout .appraisal-card')];
  const collapse = cards.some(c => !c.classList.contains('collapsed'));
  cards.forEach(c => c.classList.toggle('collapsed', collapse));
  document.getElementById('apCollapseAllBtn').textContent = collapse ? 'Expand all' : 'Collapse all';
});
document.querySelector('#appraisalDetailView .appraisal-layout').addEventListener('click', (e) => {
  const title = e.target.closest('.car-panel-title');
  if (title && !e.target.closest('button, a, input, select')) title.closest('.appraisal-card').classList.toggle('collapsed');
});

// ----- Outcome: acquire / lost / reopen -----

function renderOutcome() {
  const a = currentAppraisal;
  const el = document.getElementById('apOutcome');
  const lead = leads.find(l => l.id === a.leadId);
  const deal = deals.find(d => d.id === a.dealId);
  const links = html`
    ${lead ? html`<div class="outcome-link">Customer: <button class="link-btn" onclick="openLeadProfile(${js(lead.id)})">${lead.name}</button></div>` : ''}
    ${deal ? html`<div class="outcome-link">Deal: <button class="link-btn" onclick="openDealWorkspace(${js(deal.id)})">D-${deal.dealNumber}</button></div>` : ''}
    <div class="outcome-link audit-note">Appraised by ${a.appraisedBy ? a.appraisedBy.name : '--'} on ${new Date(a.dateCreated).toLocaleDateString()}</div>`;

  if (a.status === 'acquired') {
    const car = cars.find(c => c.id === a.carId);
    el.innerHTML = html`
      <div class="outcome-done acquired">✓ Acquired for ${money(a.acquiredFor)} on ${new Date(a.acquiredAt).toLocaleDateString()}</div>
      ${car ? html`<div class="outcome-link">In inventory: <button class="link-btn" onclick="openCarFromAppraisal(${js(car.id)})">${[car.year, car.make, car.model].join(' ')}${car.stockNumber ? ` · Stock #${car.stockNumber}` : ''}</button></div>` : ''}
      ${links}`;
    return;
  }
  if (a.status === 'lost') {
    el.innerHTML = html`
      <div class="outcome-done lost">Lost${a.lostReason ? ` -- ${a.lostReason}` : ''}</div>
      <button type="button" class="btn-secondary btn-small" id="apReopenBtn">Reopen</button>
      ${links}`;
    document.getElementById('apReopenBtn').onclick = () => appraisalAction('reopen');
    return;
  }
  el.innerHTML = html`
    ${userCan('editInventory') ? html`
      <div class="outcome-acquire">
        <label>Bought for (ACV) <input type="number" id="apAcquiredFor" value="${a.offer ?? ''}" /></label>
        <label>Stock # <input type="text" id="apStockNumber" /></label>
        <label>Asking price <input type="number" id="apAskingPrice" value="${a.targetRetail ?? ''}" /></label>
        <button type="button" class="btn-primary" id="apAcquireBtn">Acquire → add to inventory</button>
      </div>` : html`<p class="audit-note">A sales manager or admin marks it acquired.</p>`}
    <div class="outcome-lost">
      <input type="text" id="apLostReason" placeholder="Why it didn't happen (optional)" />
      <button type="button" class="btn-secondary" id="apLostBtn">Mark lost</button>
    </div>
    ${links}`;
  if (userCan('editInventory')) document.getElementById('apAcquireBtn').onclick = acquireAppraisal;
  document.getElementById('apLostBtn').onclick = () => appraisalAction('lost', { reason: document.getElementById('apLostReason').value });
}

window.openCarFromAppraisal = function(carId) {
  if (!showAppraisalList()) return;
  showView('inventory');
  if (userCan('editInventory')) editCar(carId);
};

async function acquireAppraisal() {
  if (appraisalDirty && !(await saveAppraisal())) return;
  const payload = {
    acquiredFor: document.getElementById('apAcquiredFor').value,
    stockNumber: document.getElementById('apStockNumber').value,
    askingPrice: document.getElementById('apAskingPrice').value
  };
  const res = await fetch(`${API}/appraisals/${currentAppraisal.id}/acquire`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status !== 403) alert(body.error || 'Could not acquire this appraisal.');
    return;
  }
  replaceAppraisal(body.appraisal);
  cars.push(body.car);
  await loadAll();
  openAppraisal(body.appraisal.id);
}

async function appraisalAction(action, payload = {}) {
  if (appraisalDirty && !(await saveAppraisal())) return;
  const res = await fetch(`${API}/appraisals/${currentAppraisal.id}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status !== 403) alert(body.error || 'Could not update this appraisal.');
    return;
  }
  replaceAppraisal(body);
  renderRail();
  openAppraisal(body.id);
}

// ----- Printable appraisal sheet -----

document.getElementById('appraisalPrintBtn').addEventListener('click', () => {
  const a = collectAppraisalForm();
  const lead = leads.find(l => l.id === a.leadId);
  const reconTotal = (a.recon || []).reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
  const pack = Number(appSettings.appraisalPack) || 0;
  document.getElementById('appraisalPrintContent').innerHTML = html`
    <h2>Vehicle Appraisal A-${a.appraisalNumber}</h2>
    <div class="proposal-meta">
      <span><strong>Customer:</strong> ${lead ? lead.name : '--'}</span>
      <span><strong>Appraiser:</strong> ${(staffList.find(u => u.id === a.appraiserId) || a.appraisedBy || {}).name || '--'}</span>
      <span><strong>Source:</strong> ${APPRAISAL_SOURCE_LABELS[a.source] || '--'}</span>
      <span><strong>Category:</strong> ${APPRAISAL_CATEGORY_LABELS[a.category] || '--'}</span>
      <span><strong>Date:</strong> ${new Date(a.dateCreated).toLocaleDateString()}</span>
    </div>
    <table>
      <tr><td>Vehicle</td><td>${appraisalVehicle(a)}</td></tr>
      <tr><td>VIN</td><td>${a.vin || '--'}</td></tr>
      <tr><td>Mileage</td><td>${a.mileage ? Number(a.mileage).toLocaleString() : '--'}</td></tr>
      <tr><td>Body / Engine / Drivetrain</td><td>${[a.bodyStyle, a.engine, a.drivetrain].filter(Boolean).join(' · ') || '--'}</td></tr>
      <tr><td>Colors</td><td>${[a.exteriorColor, a.interiorColor].filter(Boolean).join(' / ') || '--'}</td></tr>
      <tr><td>Condition</td><td>${CONDITION_LABELS[a.condition] || '--'}</td></tr>
      <tr><td>Equipment</td><td>${(a.equipment || []).join(', ') || '--'}</td></tr>
      <tr><td>Recalls issued for this model</td><td>${!a.recalls ? 'Not checked' : a.recalls.modelFound === false ? 'Model not matched -- check VIN at nhtsa.gov/recalls' : `${(a.recalls.items || []).length} (open recalls on this VIN: check nhtsa.gov/recalls)`}</td></tr>
    </table>
    <table>
      ${(a.recon || []).map(r => html`<tr><td>Recon: ${r.description || 'Item'}</td><td>${money(r.cost)}</td></tr>`)}
      <tr class="total-row"><td>Recon total</td><td>${money(reconTotal)}</td></tr>
    </table>
    <table>
      <tr><td>Asking price</td><td>${money(a.targetRetail)}</td></tr>
      <tr><td>Recon</td><td>${money(reconTotal)}</td></tr>
      <tr><td>Pack</td><td>${money(pack)}</td></tr>
      <tr><td>Other</td><td>${money(a.otherCosts)}</td></tr>
      <tr><td>Profit</td><td>${money(a.targetGross)}</td></tr>
      <tr class="total-row"><td>Appraisal</td><td>${money(a.offer)}</td></tr>
      ${(a.customerOffers || []).length ? html`<tr><td>Last offer to customer</td><td>${money(a.customerOffers[a.customerOffers.length - 1].amount)}</td></tr>` : ''}
    </table>
    ${a.notes ? html`<p><strong>Notes:</strong> ${a.notes}</p>` : ''}
    <p class="fine-print">Internal appraisal worksheet. Book values and vehicle history are not included until those sources are connected.</p>`;
  document.getElementById('appraisalPrintModal').classList.add('active');
});
document.getElementById('closeAppraisalPrintBtn').addEventListener('click', () => {
  document.getElementById('appraisalPrintModal').classList.remove('active');
});
document.getElementById('printAppraisalBtn').addEventListener('click', () => window.print());

// ----- Starting an appraisal from a customer or a deal's trade-in -----


// The deal page's trade-in section: start an appraisal from the trade
// details, or show the linked one with a button to use its offer.
function renderDealTradeAppraisal(deal) {
  const el = document.getElementById('dealTradeAppraisal');
  const linked = appraisals.filter(a => a.dealId === deal.id).slice(-1)[0];
  if (!linked) {
    el.innerHTML = html`<button type="button" class="btn-secondary btn-small" onclick="appraiseDealTrade()">Appraise this trade</button>`;
    return;
  }
  el.innerHTML = html`
    <div class="trade-appraisal-linked">
      <span>Appraisal <button type="button" class="link-btn" onclick="openAppraisal(${js(linked.id)})">A-${linked.appraisalNumber}</button>
        · ${APPRAISAL_STATUS_LABELS[linked.status]} · offer ${money(linked.offer)}</span>
      ${linked.offer ? html`<button type="button" class="btn-secondary btn-small" onclick="useAppraisalOffer(${js(linked.id)})">Use offer as trade value</button>` : ''}
    </div>`;
}

window.appraiseDealTrade = function() {
  const deal = deals.find(d => d.id === currentWorkspaceDealId);
  if (!deal) return;
  startAppraisal({
    dealId: deal.id,
    leadId: deal.leadId || null,
    vin: cleanVin(document.getElementById('dealTradeVin').value),
    year: document.getElementById('dealTradeYear').value,
    make: document.getElementById('dealTradeMake').value,
    model: document.getElementById('dealTradeModel').value,
    mileage: document.getElementById('dealTradeMileage').value
  });
};

window.useAppraisalOffer = function(appraisalId) {
  const a = appraisals.find(x => x.id === appraisalId);
  if (!a || !a.offer) return;
  document.getElementById('dealTradeInValue').value = a.offer;
  document.getElementById('dealTradeInValue').dispatchEvent(new Event('input', { bubbles: true }));
};

window.openAppraisalFromCar = function(appraisalId) {
  document.getElementById('carModal').classList.remove('active');
  openAppraisal(appraisalId);
};

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
  document.getElementById('carSourceAppraisal').innerHTML = '';
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
  const source = appraisals.find(a => a.id === car.sourceAppraisalId);
  document.getElementById('carSourceAppraisal').innerHTML = source
    ? html`From appraisal <button type="button" class="link-btn" onclick="openAppraisalFromCar(${js(source.id)})">A-${source.appraisalNumber}</button> · appraised ${new Date(source.dateCreated).toLocaleDateString()} by ${source.appraisedBy ? source.appraisedBy.name : '--'} · bought for ${money(source.acquiredFor)}`
    : '';
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

// ---------- Search pickers (type instead of scrolling a dropdown) ----------
// With hundreds of cars and customers a dropdown is too slow. These search
// boxes find a car by stock #, VIN (any part), year, make, model, trim, or
// color -- e.g. "H-2020", "odyssey silver", "19 camry" -- and a customer by
// name, phone, email, or customer #. Several words narrow it down.

function carSearchText(c) {
  return [c.stockNumber, c.vin, c.year, c.make, c.model, c.trim, c.exteriorColor, c.bodyStyle, c.status].filter(Boolean).join(' ').toLowerCase();
}
function leadSearchText(l) {
  return [l.name, l.phone, String(l.phone || '').replace(/\D/g, ''), l.email, l.customerNumber, l.customerNumber && `c-${l.customerNumber}`]
    .filter(Boolean).join(' ').toLowerCase();
}
function carPickLabel(c) {
  return `${c.stockNumber ? `#${c.stockNumber} · ` : ''}${[c.year, c.make, c.model, c.trim].filter(Boolean).join(' ')}`;
}
function leadPickLabel(l) {
  return `${l.name}${l.phone ? ` · ${l.phone}` : ''}`;
}

// Best matches first: exact stock # / customer #, then starts-with, then the rest.
function searchRecords(kind, ids, query, limit = 8) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const records = ids.map(id => (kind === 'car' ? cars : leads).find(r => r.id === id)).filter(Boolean);
  if (!words.length) return records.slice(-limit).reverse(); // newest first when nothing's typed
  const q = query.trim().toLowerCase();
  const scored = [];
  for (const r of records) {
    const hay = kind === 'car' ? carSearchText(r) : leadSearchText(r);
    // Customers: "(844) 674" also matches the phone's digits.
    const phoneDigits = w => kind === 'lead' && w.replace(/\D/g, '').length >= 3 && hay.includes(w.replace(/\D/g, ''));
    if (!words.every(w => hay.includes(w) || phoneDigits(w))) continue;
    const key = String((kind === 'car' ? r.stockNumber : r.customerNumber) || '').toLowerCase();
    const name = String((kind === 'car' ? r.vin : r.name) || '').toLowerCase();
    const score = key === q || key === q.replace(/^c-/, '') ? 0 : key.startsWith(q) ? 1 : name.startsWith(q) ? 2 : 3;
    scored.push({ r, score });
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map(x => x.r);
}

function pickerResultHtml(kind, r) {
  if (kind === 'car') {
    return html`<div class="picker-main">${carPickLabel(r)}</div>
      <div class="picker-sub">${[r.exteriorColor, r.mileage ? `${Number(r.mileage).toLocaleString()} mi` : '', r.price ? money(r.price) : '', r.vin ? `VIN …${String(r.vin).slice(-8)}` : '']
        .filter(Boolean).join(' · ')}${r.status && r.status !== 'available' ? html` <span class="picker-status">${r.status}</span>` : ''}</div>`;
  }
  return html`<div class="picker-main">${r.name}${r.hot ? ' 🔥' : ''}</div>
    <div class="picker-sub">${[r.phone, r.email, r.customerNumber ? `C-${r.customerNumber}` : ''].filter(Boolean).join(' · ')}</div>`;
}

// A search box. getIds() gives the records it can pick from; onPick(id)
// is called with the chosen one ('' when cleared).
function createSearchPicker({ kind, getIds, onPick, placeholder, clearable = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'search-picker';
  wrap.innerHTML = html`<input type="text" class="search-picker-input" autocomplete="off" spellcheck="false"
      placeholder="${placeholder || (kind === 'car' ? 'Type stock #, VIN, year, make, model, color...' : 'Type name, phone, email, or customer #...')}" />
    ${clearable ? html`<button type="button" class="search-picker-clear" aria-label="Clear" title="Clear">✕</button>` : ''}
    <div class="search-picker-results" role="listbox" hidden></div>`;
  const input = wrap.querySelector('input');
  const results = wrap.querySelector('.search-picker-results');
  let shown = [];
  let active = 0;
  let selectedLabel = '';

  function render() {
    shown = searchRecords(kind, getIds(), input.value);
    active = 0;
    results.innerHTML = shown.length
      ? shown.map((r, i) => html`<div class="picker-result ${i === 0 ? 'active' : ''}" role="option" data-i="${i}">${pickerResultHtml(kind, r)}</div>`).join('')
      : html`<div class="picker-empty">No ${kind === 'car' ? 'vehicles' : 'customers'} match "${input.value}"</div>`;
    results.hidden = false;
  }
  function choose(r) {
    results.hidden = true;
    onPick(r ? r.id : '');
  }
  function highlight(i) {
    const rows = results.querySelectorAll('.picker-result');
    if (!rows.length) return;
    active = (i + rows.length) % rows.length;
    rows.forEach((row, n) => row.classList.toggle('active', n === active));
    rows[active].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('focus', () => { input.select(); render(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.hidden) render(); else highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter') { if (!results.hidden) { e.preventDefault(); if (shown[active]) choose(shown[active]); } }
    else if (e.key === 'Escape') { results.hidden = true; input.value = selectedLabel; }
  });
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; input.value = selectedLabel; }, 150));
  // mousedown so it fires before the input's blur hides the list
  results.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.picker-result');
    if (!row) return;
    e.preventDefault();
    choose(shown[Number(row.dataset.i)]);
    input.blur();
  });
  const clear = wrap.querySelector('.search-picker-clear');
  if (clear) clear.addEventListener('click', () => { input.value = ''; choose(null); });

  return {
    element: wrap,
    input,
    setLabel(label) { selectedLabel = label || ''; input.value = selectedLabel; wrap.classList.toggle('has-value', !!label); },
    setDisabled(disabled) { input.disabled = disabled; if (clear) clear.disabled = disabled; }
  };
}

// Puts a search box in place of an existing car/customer <select>. The
// select stays (hidden) and keeps working as before: code reading or
// setting its value, and its "change" event, are unchanged.
const nativeSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const nativeSelectDisabled = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'disabled');
function attachSearchPicker(select, kind) {
  const picker = createSearchPicker({
    kind,
    getIds: () => [...select.options].map(o => o.value).filter(Boolean),
    onPick: (id) => {
      nativeSelectValue.set.call(select, id);
      sync();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  function sync() {
    const id = nativeSelectValue.get.call(select);
    const record = id && (kind === 'car' ? cars : leads).find(r => r.id === id);
    picker.setLabel(record ? (kind === 'car' ? carPickLabel(record) : leadPickLabel(record)) : '');
    picker.setDisabled(nativeSelectDisabled.get.call(select));
  }
  Object.defineProperty(select, 'value', {
    configurable: true,
    get: () => nativeSelectValue.get.call(select),
    set: (v) => { nativeSelectValue.set.call(select, v); sync(); }
  });
  Object.defineProperty(select, 'disabled', {
    configurable: true,
    get: () => nativeSelectDisabled.get.call(select),
    set: (v) => { nativeSelectDisabled.set.call(select, v); sync(); }
  });
  select.classList.add('picker-source');
  select.after(picker.element);
  if (select.form) select.form.addEventListener('reset', () => setTimeout(sync));
  sync();
}

attachSearchPicker(document.getElementById('leadCarId'), 'car');
attachSearchPicker(document.getElementById('dealAssignedLeadId'), 'lead');
attachSearchPicker(document.getElementById('dealAssignedCarId'), 'car');
attachSearchPicker(document.getElementById('apLeadId'), 'lead');

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
    const res = await fetch(`${API}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) { if (res.status !== 403) alert(created.error || 'Could not add the customer.'); return; }
    leadModal.classList.remove('active');
    await loadAll();
    openLeadProfile(created.id); // straight to their page to start working them
    return;
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

// ---------- Customer page (everything about one customer) ----------
// Header with contact and the car they want; the Road to the Sale; who
// they are on the left; activity, conversation, deals, and value in the
// middle; things to do on the right.

let returnToProfileAfterEdit = false;
let currentProfileLeadId = null;
let cpTasks = []; // this customer's tasks (open and closed)
let cpComposerKind = 'note';
let cpHistoryFilter = 'all';
let selectedSendTextPhoto = null;
const leadProfileModal = document.getElementById('leadProfileModal');

const ACTIVITY_ICONS = { call: '📞', text: '💬', email: '✉️', note: '📝', visit: '📍', task: '✅', appointment: '📅', status: '🏷', dms: '⇄' };
const ACTIVITY_LABELS = { call: 'Call', text: 'Text', email: 'Email', note: 'Note', visit: 'Showroom Visit', task: 'Task', appointment: 'Appointment', status: 'Status', dms: 'DMS' };
const TASK_ICONS = { call: '📞', text: '💬', email: '✉️', appointment: '📅', todo: '☑️' };
const TASK_LABELS = { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment', todo: 'To-do' };
const HISTORY_FILTERS = [
  ['all', 'All', () => true], ['note', 'Notes', a => a.type === 'note'], ['call', 'Calls', a => a.type === 'call'],
  ['text', 'Texts', a => a.type === 'text'], ['email', 'Emails', a => a.type === 'email'], ['visit', 'Visits', a => a.type === 'visit'],
  ['task', 'Tasks', a => a.type === 'task'], ['appointment', 'Appts', a => a.type === 'appointment'], ['status', 'Status', a => a.type === 'status'],
  ['dms', 'DMS', a => a.type === 'dms']
];
const ASSIGNMENT_SLOTS = [['sales1Id', 'Sales 1'], ['sales2Id', 'Sales 2'], ['bdc1Id', 'BDC 1'], ['bdc2Id', 'BDC 2']];
const DEFAULT_ROADMAP_LABELS = ['Greet', 'Needs', 'Vehicle', 'Demo Drive', 'Trade', 'Write-up', 'Delivery'];

const cpLead = () => leads.find(l => l.id === currentProfileLeadId);
const staffName = id => (staffList.find(u => u.id === id) || {}).name || (id ? 'Former employee' : '');
const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const isSnoozed = l => l.snoozedUntil && new Date(l.snoozedUntil) > new Date();
const cpCarLabel = c => [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ');

async function cpFetchTasks() {
  const res = await fetch(`${API}/tasks?leadId=${encodeURIComponent(currentProfileLeadId)}`);
  cpTasks = res.ok ? await res.json() : [];
}

// Saves some fields on the customer, then refreshes the page.
async function cpSaveLead(fields) {
  const res = await fetch(`${API}/leads/${currentProfileLeadId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status !== 403) alert(body.error || 'Could not save.'); return null; }
  const i = leads.findIndex(l => l.id === body.id);
  if (i >= 0) leads[i] = body;
  renderCustomerPage();
  return body;
}

async function cpLogActivity(type, text) {
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/activities`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, text })
  });
  return res.ok;
}

// Reloads everything (lists behind the page stay current) and redraws.
async function cpRefresh() {
  await Promise.all([loadAll(), cpFetchTasks()]);
  if (cpLead()) renderCustomerPage(); else closeCustomerPage();
}

window.openLeadProfile = async function(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  const switching = currentProfileLeadId !== leadId;
  currentProfileLeadId = leadId;
  if (switching) {
    cpComposerKind = 'note';
    cpHistoryFilter = 'all';
    selectedSendTextPhoto = null;
    cpSwitchTab('activity');
    document.getElementById('aiSnapshotBox').style.display = 'none';
    document.getElementById('cpActionPanel').hidden = true;
    document.getElementById('cpLaterNote').hidden = true;
  }
  cpTasks = [];
  renderCustomerPage();
  leadProfileModal.classList.add('active');
  await cpFetchTasks();
  if (currentProfileLeadId === leadId) { renderPlanned(); renderHistory(); }
};

function closeCustomerPage() {
  leadProfileModal.classList.remove('active');
}

function renderCustomerPage() {
  const lead = cpLead();
  if (!lead) return;
  renderCpHeader(lead);
  renderRoadmap(lead);
  renderCpContact(lead);
  renderWishList(lead);
  renderCpTrades(lead);
  renderBestContact(lead);
  renderCpDetails(lead);
  renderComposer();
  renderPlanned();
  renderHistory();
  renderThread(lead);
  renderProfileDeals(lead);
  renderCpValue(lead);
}

// ----- Header -----

function renderCpHeader(lead) {
  document.getElementById('cpAvatar').textContent = initials(lead.name);
  document.getElementById('profileName').textContent = lead.name;
  const hot = document.getElementById('cpHotBtn');
  hot.classList.toggle('on', !!lead.hot);
  hot.setAttribute('aria-pressed', lead.hot ? 'true' : 'false');
  hot.title = lead.hot ? 'Hot prospect -- click to turn off' : 'Mark as a hot prospect';
  const statusLabel = { new: 'New', contacted: 'Contacted', negotiating: 'Negotiating', won: 'Sold', lost: 'Dead' }[lead.status] || lead.status;
  document.getElementById('profileBadges').innerHTML = html`
    <span class="badge ${lead.status}">${statusLabel}</span>
    ${lead.customerNumber ? html`<span class="cp-chip">C-${lead.customerNumber}</span>` : ''}
    ${lead.type === 'business' ? html`<span class="cp-chip">Business</span>` : ''}
    ${isSnoozed(lead) ? html`<span class="cp-chip cp-chip-warn">Snoozed until ${new Date(lead.snoozedUntil).toLocaleDateString()}</span>` : ''}`;
  document.getElementById('cpHeaderContact').innerHTML = html`
    ${lead.phone ? html`<a href="tel:${lead.phone}">📞 ${lead.phone}</a>` : html`<span class="muted">No phone</span>`}
    ${lead.email ? html`<a href="mailto:${lead.email}">✉️ ${lead.email}</a>` : html`<span class="muted">No email</span>`}
    <span class="muted">${formatSource(lead.source)}</span>`;
  const car = cars.find(c => c.id === lead.carId) || cars.find(c => c.id === (lead.wishList || [])[0]);
  document.getElementById('cpHeaderSide').innerHTML = car ? html`
    <div class="cp-side-label">Interested in</div>
    <div class="cp-side-car">${cpCarLabel(car)}</div>
    <div class="cp-side-sub">${car.stockNumber ? `Stock #${car.stockNumber} · ` : ''}${money(car.price)}${car.status !== 'available' ? ` · ${car.status}` : ''}</div>`
    : html`<div class="cp-side-label">Interested in</div><div class="cp-side-sub">No vehicle picked yet</div>`;
}

document.getElementById('cpHotBtn').addEventListener('click', () => {
  const lead = cpLead();
  if (lead) cpSaveLead({ hot: !lead.hot });
});

// ----- Road to the Sale -----
// Some steps check themselves off from what's already happened; the
// rest are clicked. Either way the bar shows where the customer is.

function roadmapAuto(lead) {
  const leadDeals = deals.filter(d => d.leadId === lead.id);
  return [
    (lead.activities || []).some(a => a.type === 'visit') ? 'Checked in' : null,
    null,
    (lead.carId || (lead.wishList || []).length || leadDeals.some(d => d.carId)) ? 'Vehicle picked' : null,
    null,
    leadTrades(lead).length ? 'Trade entered' : null,
    leadDeals.length ? 'Deal written' : null,
    (lead.status === 'won' || leadDeals.some(d => ['delivered', 'closed', 'finalized'].includes(d.status))) ? 'Sold / delivered' : null
  ];
}

function renderRoadmap(lead) {
  const labels = (appSettings.roadmapLabels && appSettings.roadmapLabels.length === 7) ? appSettings.roadmapLabels : DEFAULT_ROADMAP_LABELS;
  const auto = roadmapAuto(lead);
  const manual = lead.roadmap || [];
  const done = labels.map((_, i) => !!(manual[i] || auto[i]));
  const current = done.indexOf(false);
  document.getElementById('cpRoadmap').innerHTML = html`
    <div class="cp-roadmap-title">Road to the Sale <span>${done.filter(Boolean).length} of 7</span></div>
    <ol class="cp-steps">
      ${labels.map((label, i) => {
        const how = manual[i] ? `Checked by ${manual[i].by ? manual[i].by.name : '--'} on ${new Date(manual[i].at).toLocaleDateString()}` : auto[i] ? `${auto[i]} (automatic)` : 'Click when done';
        return html`<li class="cp-step ${done[i] ? 'done' : ''} ${i === current ? 'current' : ''}">
          <button type="button" data-step="${i}" title="${how}" ${auto[i] && !manual[i] ? html`data-auto="1"` : ''}>
            <span class="cp-step-dot">${done[i] ? '✓' : i + 1}</span><span class="cp-step-label">${label}</span>
          </button></li>`;
      })}
    </ol>`;
}

document.getElementById('cpRoadmap').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-step]');
  if (!btn) return;
  const lead = cpLead();
  const step = Number(btn.dataset.step);
  if (btn.dataset.auto) return; // done automatically; nothing to undo
  const res = await fetch(`${API}/leads/${lead.id}/roadmap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step, done: !(lead.roadmap || [])[step] })
  });
  if (!res.ok) return;
  const saved = await res.json();
  leads[leads.findIndex(l => l.id === saved.id)] = saved;
  renderRoadmap(saved);
});

// ----- Left column -----

function renderCpContact(lead) {
  const row = (field, icon, label, value, type = 'text') => html`
    <div class="cp-field" data-field="${field}">
      <span class="cp-field-icon">${icon}</span>
      <span class="cp-field-label">${label}</span>
      ${value ? html`<span class="cp-field-value">${value}</span>` : html`<span class="cp-field-value muted">--</span>`}
      <button type="button" class="link-btn cp-field-edit" data-type="${type}">${value ? 'Edit' : 'Add'}</button>
    </div>`;
  const addr = leadAddress(lead);
  const mailing = lead.mailingDifferent ? leadAddress({ address: lead.mailingAddress }) : null;
  document.getElementById('cpContact').innerHTML =
    row('phone', '📞', 'Phone', lead.phone, 'tel') + row('email', '✉️', 'Email', lead.email, 'email') + html`
    <div class="cp-address" id="cpAddressBlock">
      <div class="cp-field">
        <span class="cp-field-icon">🏠</span><span class="cp-field-label">Address</span>
        ${formatAddress(addr) ? html`<span class="cp-field-value cp-address-lines">${formatAddress(addr)}</span>` : html`<span class="cp-field-value muted">--</span>`}
        <button type="button" class="link-btn" id="cpAddressEdit">${formatAddress(addr) ? 'Edit' : 'Add'}</button>
      </div>
      ${mailing ? html`<div class="cp-field"><span class="cp-field-icon">📬</span><span class="cp-field-label">Mailing</span>
        <span class="cp-field-value cp-address-lines">${formatAddress(mailing) || '--'}</span></div>` : ''}
    </div>`;
  document.getElementById('cpAddressEdit').onclick = () => editCpAddress(lead);
}

// Older customers have one line of text for an address; newer ones have parts.
function leadAddress(lead) {
  const a = lead.address;
  if (!a) return {};
  return typeof a === 'string' ? { street: a } : a;
}
function formatAddress(a) {
  const line1 = [a.street, a.unit].filter(Boolean).join(', ');
  const line2 = [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ');
  return [line1, line2, a.county ? `${a.county} County` : ''].filter(Boolean).join('\n');
}

function addressFieldsHtml(prefix, a) {
  return html`
    <label class="wide">Street <input type="text" id="${prefix}Street" value="${a.street || ''}" autocomplete="off" /></label>
    <label>Apt / Unit <input type="text" id="${prefix}Unit" value="${a.unit || ''}" /></label>
    <label>City <input type="text" id="${prefix}City" value="${a.city || ''}" /></label>
    <label>State <input type="text" id="${prefix}State" maxlength="2" value="${a.state || ''}" placeholder="AZ" /></label>
    <label>ZIP <input type="text" id="${prefix}Zip" maxlength="10" value="${a.zip || ''}" /></label>
    <label>County <input type="text" id="${prefix}County" value="${a.county || ''}" placeholder="Fills in from ZIP where known" /></label>`;
}
function readAddressFields(prefix) {
  const v = id => document.getElementById(`${prefix}${id}`).value.trim();
  return { street: v('Street'), unit: v('Unit'), city: v('City'), state: v('State').toUpperCase(), zip: v('Zip'), county: v('County') };
}
async function fillCountyFromZip(prefix) {
  const zip = document.getElementById(`${prefix}Zip`).value.trim();
  const county = document.getElementById(`${prefix}County`);
  if (!zip || county.value) return;
  try {
    const res = await fetch(`${API}/fees/county-lookup?state=${encodeURIComponent(document.getElementById(`${prefix}State`).value)}&zip=${encodeURIComponent(zip)}`);
    const result = await res.json();
    if (result.county && !county.value) county.value = result.county;
  } catch (err) { /* a convenience only */ }
}

function editCpAddress(lead) {
  const block = document.getElementById('cpAddressBlock');
  block.innerHTML = html`
    <div class="cp-address-form">
      ${addressFieldsHtml('cpAddr', leadAddress(lead))}
      <label class="wide cp-check"><input type="checkbox" id="cpMailingDifferent" ${lead.mailingDifferent ? html`checked` : ''} /> Mailing address is different</label>
      <div class="cp-mailing wide" id="cpMailingFields" ${lead.mailingDifferent ? '' : html`hidden`}>
        <div class="cp-address-form">${addressFieldsHtml('cpMail', lead.mailingAddress || {})}</div>
      </div>
      <div class="wide cp-panel-buttons">
        <button type="button" class="btn-primary btn-small" id="cpAddrSave">Save address</button>
        <button type="button" class="link-btn" id="cpAddrCancel">Cancel</button>
      </div>
    </div>`;
  document.getElementById('cpAddrZip').addEventListener('change', () => fillCountyFromZip('cpAddr'));
  document.getElementById('cpMailZip').addEventListener('change', () => fillCountyFromZip('cpMail'));
  document.getElementById('cpMailingDifferent').onchange = e => { document.getElementById('cpMailingFields').hidden = !e.target.checked; };
  document.getElementById('cpAddrCancel').onclick = () => renderCpContact(cpLead());
  document.getElementById('cpAddrSave').onclick = () => {
    const mailingDifferent = document.getElementById('cpMailingDifferent').checked;
    cpSaveLead({ address: readAddressFields('cpAddr'), mailingDifferent, ...(mailingDifferent ? { mailingAddress: readAddressFields('cpMail') } : {}) });
  };
  document.getElementById('cpAddrStreet').focus();
}

// Edit a contact field in place: Enter or leaving the box saves, Escape cancels.
document.getElementById('cpContact').addEventListener('click', (e) => {
  const btn = e.target.closest('.cp-field-edit');
  if (!btn) return;
  const row = btn.closest('.cp-field');
  const field = row.dataset.field;
  const lead = cpLead();
  const input = document.createElement('input');
  input.type = btn.dataset.type;
  input.value = lead[field] || '';
  input.className = 'cp-inline-input';
  row.querySelector('.cp-field-value').replaceWith(input);
  btn.remove();
  input.focus();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== (lead[field] || '')) cpSaveLead({ [field]: input.value.trim() });
    else renderCpContact(cpLead());
  };
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
});

let cpWishPicker = null;
function renderWishList(lead) {
  const list = (lead.wishList || []).map(id => cars.find(c => c.id === id)).filter(Boolean);
  document.getElementById('cpWishCount').textContent = list.length;
  document.getElementById('cpWishList').innerHTML = list.length ? list.map(c => html`
    <div class="cp-wish ${c.id === lead.carId ? 'primary' : ''}">
      <div class="cp-wish-main">
        <div class="cp-wish-car">${c.id === lead.carId ? '★ ' : ''}${cpCarLabel(c)}</div>
        <div class="cp-wish-sub">${c.stockNumber ? `#${c.stockNumber} · ` : ''}${money(c.price)}${c.exteriorColor ? ` · ${c.exteriorColor}` : ''}${c.status !== 'available' ? ` · ${c.status}` : ''}</div>
      </div>
      <div class="cp-wish-actions">
        ${c.id === lead.carId ? '' : html`<button type="button" class="link-btn" data-primary="${c.id}" title="The car they're most interested in">Make main</button>`}
        <button type="button" class="recon-remove" data-remove="${c.id}" aria-label="Remove" title="Remove">✕</button>
      </div>
    </div>`).join('') : html`<p class="audit-note">No vehicles yet. Search below to add one.</p>`;

  if (!cpWishPicker) {
    cpWishPicker = createSearchPicker({
      kind: 'car',
      placeholder: 'Add a vehicle: stock #, VIN, year, make, model...',
      clearable: false,
      getIds: () => { const l = cpLead(); return cars.filter(c => c.status !== 'sold' && !((l && l.wishList) || []).includes(c.id)).map(c => c.id); },
      onPick: (id) => {
        const l = cpLead();
        if (!id || !l) return;
        cpWishPicker.setLabel('');
        cpSaveLead({ wishList: [...(l.wishList || []), id], ...(l.carId ? {} : { carId: id }) });
      }
    });
    document.getElementById('cpWishPicker').appendChild(cpWishPicker.element);
  }
}

document.getElementById('cpWishList').addEventListener('click', (e) => {
  const lead = cpLead();
  const remove = e.target.closest('[data-remove]');
  const primary = e.target.closest('[data-primary]');
  if (remove) {
    const id = remove.dataset.remove;
    const wishList = (lead.wishList || []).filter(x => x !== id);
    cpSaveLead({ wishList, ...(lead.carId === id ? { carId: wishList[0] || null } : {}) });
  } else if (primary) {
    cpSaveLead({ carId: primary.dataset.primary });
  }
});

// Which way they've actually answered: counts what's in their log.
function suggestedContact(lead) {
  const counts = { text: 0, call: 0, email: 0 };
  for (const a of lead.activities || []) if (a.type in counts) counts[a.type] += 1;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n ? { method: best, n } : null;
}

function renderBestContact(lead) {
  const labels = { text: '💬 Text', call: '📞 Call', email: '✉️ Email' };
  const hint = suggestedContact(lead);
  document.getElementById('cpBestContact').innerHTML = html`
    <div class="cp-segment">
      ${['text', 'call', 'email'].map(m => html`<button type="button" data-method="${m}" class="${lead.bestContact === m ? 'on' : ''}">${labels[m]}</button>`)}
    </div>
    <div class="audit-note">${lead.bestContact
      ? html`Reach them by ${lead.bestContact}${lead.bestContact === 'email' ? (lead.email ? ` at ${lead.email}` : '') : (lead.phone ? ` at ${lead.phone}` : '')}.`
      : hint ? html`Not set. Most contact so far has been by ${hint.method} (${hint.n}).` : 'Not set yet.'}</div>`;
}

document.getElementById('cpBestContact').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-method]');
  if (!btn) return;
  const lead = cpLead();
  cpSaveLead({ bestContact: lead.bestContact === btn.dataset.method ? '' : btn.dataset.method });
});

function renderCpDetails(lead) {
  const lastContact = (lead.activities || [])[0];
  const staffOptions = (selected) => html`<option value="">-- None --</option>
    ${staffList.map(u => html`<option value="${u.id}" ${u.id === selected ? html`selected` : ''}>${u.name}</option>`)}
    ${selected && !staffList.some(u => u.id === selected) ? html`<option value="${selected}" selected>Former employee</option>` : ''}`;
  document.getElementById('cpDetails').innerHTML = html`
    ${ASSIGNMENT_SLOTS.map(([field, label]) => html`
      <label class="cp-detail-row"><span>${label}</span>
        <select data-assign="${field}">${staffOptions(lead[field])}</select></label>`)}
    <div class="cp-detail-row"><span>Customer #</span><strong>${lead.customerNumber ? `C-${lead.customerNumber}` : '--'}</strong></div>
    <div class="cp-detail-row"><span>Source</span><strong>${formatSource(lead.source)}</strong></div>
    <div class="cp-detail-row"><span>Added</span><strong>${new Date(lead.dateAdded).toLocaleDateString()}</strong></div>
    <div class="cp-detail-row"><span>Last contact</span><strong>${lastContact ? new Date(lastContact.date).toLocaleDateString() : 'Never'}</strong></div>
    ${lead.status === 'lost' && lead.lostReason ? html`<div class="cp-detail-row"><span>Dead reason</span><strong>${lead.lostReason}</strong></div>` : ''}
    ${lead.notes ? html`<div class="cp-detail-notes">${lead.notes}</div>` : ''}`;
}

document.getElementById('cpDetails').addEventListener('change', (e) => {
  const select = e.target.closest('select[data-assign]');
  if (select) cpSaveLead({ [select.dataset.assign]: select.value || null });
});

// ----- Middle tabs -----

function cpSwitchTab(name) {
  document.querySelectorAll('.cp-tab').forEach(t => t.classList.toggle('active', t.dataset.cptab === name));
  document.querySelectorAll('.cp-tabpanel').forEach(p => { p.hidden = p.dataset.cptab !== name; });
  if (name === 'conversation') {
    const thread = document.getElementById('cpThread');
    thread.scrollTop = thread.scrollHeight;
  }
}
document.querySelector('.cp-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.cp-tab');
  if (tab) cpSwitchTab(tab.dataset.cptab);
});

// ----- Composer: note, call, text, email, task, appointment -----

// A sensible default time: on the hour, and within business hours
// (9am-7pm) -- after hours it rolls to 10am the next morning.
function nextHour(hoursAhead = 1) {
  const d = new Date(Date.now() + hoursAhead * 3600000);
  d.setMinutes(0, 0, 0);
  if (d.getHours() >= 19) { d.setDate(d.getDate() + 1); d.setHours(10); }
  else if (d.getHours() < 9) d.setHours(10);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function sendTextBoxHtml(idPrefix) {
  return html`
    <textarea id="${idPrefix}Input" rows="3" placeholder="Type a text message..."></textarea>
    <div id="${idPrefix}Photos" class="cp-photo-picker"></div>
    <div class="cp-composer-actions">
      <button type="button" class="btn-secondary btn-small" data-ai-reply="${idPrefix}">✨ Suggest a reply</button>
      <span class="cp-composer-status" id="${idPrefix}Status"></span>
      <button type="button" class="btn-primary btn-small" data-send-text="${idPrefix}">Send Text</button>
    </div>`;
}

function renderComposer() {
  document.querySelectorAll('#cpComposerTabs button').forEach(b => b.classList.toggle('active', b.dataset.kind === cpComposerKind));
  const el = document.getElementById('cpComposer');
  const lead = cpLead();
  const kind = cpComposerKind;
  el.className = `cp-composer-body kind-${kind}`;
  const me = currentUser && currentUser.id;
  const staffOptions = staffList.map(u => html`<option value="${u.id}" ${u.id === me ? html`selected` : ''}>${u.name}</option>`);

  if (kind === 'text') {
    el.innerHTML = lead.phone ? sendTextBoxHtml('cpText') : html`<p class="audit-note">Add a phone number to text this customer.</p>`;
    if (lead.phone) renderTextPhotos('cpTextPhotos', lead);
  } else if (kind === 'task' || kind === 'appointment') {
    const appt = kind === 'appointment';
    el.innerHTML = html`
      <div class="cp-task-form">
        ${appt ? '' : html`<label>Type
          <select id="cpTaskType">
            <option value="call">📞 Call</option><option value="text">💬 Text</option>
            <option value="email">✉️ Email</option><option value="todo">☑️ To-do</option>
          </select></label>`}
        <label class="${appt ? 'wide' : ''}">${appt ? 'What' : 'About'} <input type="text" id="cpTaskTitle" placeholder="${appt ? 'e.g. Test drive the Odyssey' : 'e.g. Follow up on financing'}" /></label>
        <label>When <input type="datetime-local" id="cpTaskDue" value="${appt ? nextHour(24) : nextHour(1)}" /></label>
        <label>Assigned to <select id="cpTaskAssignee">${staffOptions}</select></label>
        <label class="wide">Notes <input type="text" id="cpTaskNotes" placeholder="Optional" /></label>
      </div>
      <div class="cp-composer-actions">
        <span class="cp-composer-status" id="cpTaskStatus"></span>
        <button type="button" class="btn-primary btn-small" id="cpTaskSave">${appt ? 'Set Appointment' : 'Schedule Task'}</button>
      </div>`;
    document.getElementById('cpTaskSave').onclick = () => scheduleTask(appt ? 'appointment' : document.getElementById('cpTaskType').value);
  } else if (kind === 'video') {
    el.innerHTML = html`<div class="cp-placeholder"><strong>Video messages -- not available yet</strong>
      <p>Record a quick walkaround video and text it to the customer. This needs a video messaging service connected first.</p></div>`;
  } else {
    const prompts = {
      note: 'Type a note about this customer...',
      call: 'How did the call go? e.g. Left voicemail about financing',
      email: 'What did you email them? (logged here -- sending email from the CRM comes later)'
    };
    el.innerHTML = html`
      <textarea id="cpNoteText" rows="3" placeholder="${prompts[kind]}"></textarea>
      <div class="cp-composer-actions">
        <span class="cp-composer-status" id="cpNoteStatus"></span>
        <button type="button" class="btn-primary btn-small" id="cpNoteSave">${kind === 'note' ? 'Save Note' : kind === 'call' ? 'Log Call' : 'Log Email'}</button>
      </div>`;
    document.getElementById('cpNoteSave').onclick = async () => {
      const text = document.getElementById('cpNoteText').value.trim();
      if (!text) return document.getElementById('cpNoteText').focus();
      if (await cpLogActivity(kind, text)) await cpRefresh();
    };
  }
}

document.getElementById('cpComposerTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  cpComposerKind = btn.dataset.kind;
  renderComposer();
  const first = document.querySelector('#cpComposer textarea, #cpComposer input');
  if (first) first.focus();
});

async function scheduleTask(type) {
  const due = document.getElementById('cpTaskDue').value;
  const res = await fetch(`${API}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      leadId: currentProfileLeadId, type,
      title: document.getElementById('cpTaskTitle').value,
      notes: document.getElementById('cpTaskNotes').value,
      dueAt: due ? new Date(due).toISOString() : '',
      assignedToId: document.getElementById('cpTaskAssignee').value
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('cpTaskStatus').innerHTML = html`<span class="send-text-status-error">${body.error || 'Could not schedule it.'}</span>`; return; }
  await cpRefresh();
}

// Photos of the cars they're interested in, to attach to a text.
function renderTextPhotos(containerId, lead) {
  selectedSendTextPhoto = null;
  const carIds = [...new Set([lead.carId, ...(lead.wishList || [])].filter(Boolean))];
  const photos = carIds.flatMap(id => { const c = cars.find(x => x.id === id); return c ? (c.photos || []).map(p => ({ p, c })) : []; });
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = photos.length ? html`
    <div class="audit-note">Attach a photo (optional):</div>
    <div class="photo-picker-grid">${photos.slice(0, 24).map(({ p, c }) => html`<img src="${photoThumb(p, 56, 42)}" class="photo-picker-thumb" data-photo="${p}" title="${cpCarLabel(c)}" loading="lazy" />`)}</div>` : '';
}

// Clicks shared by both text boxes (composer and Conversation tab).
leadProfileModal.addEventListener('click', async (e) => {
  const thumb = e.target.closest('.photo-picker-thumb');
  if (thumb) {
    const same = selectedSendTextPhoto === thumb.dataset.photo;
    leadProfileModal.querySelectorAll('.photo-picker-thumb').forEach(t => t.classList.remove('selected'));
    selectedSendTextPhoto = same ? null : thumb.dataset.photo;
    if (!same) thumb.classList.add('selected');
    return;
  }
  const send = e.target.closest('[data-send-text]');
  if (send) return sendCustomerText(send.dataset.sendText);
  const ai = e.target.closest('[data-ai-reply]');
  if (ai) return suggestReply(ai.dataset.aiReply);
});

async function sendCustomerText(prefix) {
  const input = document.getElementById(`${prefix}Input`);
  const status = document.getElementById(`${prefix}Status`);
  const text = input.value.trim();
  if (!text && !selectedSendTextPhoto) return input.focus();
  status.textContent = 'Sending...';
  try {
    const res = await fetch(`${API}/leads/${currentProfileLeadId}/send-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, photoPath: selectedSendTextPhoto })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { status.innerHTML = html`<span class="send-text-status-error">Couldn't send: ${data.error}</span>`; return; }
    selectedSendTextPhoto = null;
    await cpRefresh();
    const again = document.getElementById(`${prefix}Status`);
    if (again) again.innerHTML = html`<span class="send-text-status-success">✓ Sent</span>`;
  } catch (err) {
    status.innerHTML = html`<span class="send-text-status-error">Could not reach the server.</span>`;
  }
}

async function suggestReply(prefix) {
  const input = document.getElementById(`${prefix}Input`);
  const status = document.getElementById(`${prefix}Status`);
  status.textContent = 'Writing a suggestion...';
  try {
    const res = await fetch(`${API}/ai/suggest-reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: currentProfileLeadId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { status.innerHTML = html`<span class="send-text-status-error">Couldn't suggest one: ${data.error}</span>`; return; }
    input.value = data.suggestion;
    status.textContent = 'Suggestion ready -- edit it, then send.';
    input.focus();
  } catch (err) {
    status.innerHTML = html`<span class="send-text-status-error">Could not reach the AI assistant.</span>`;
  }
}

document.getElementById('aiSnapshotBtn').addEventListener('click', async () => {
  const box = document.getElementById('aiSnapshotBox');
  box.style.display = 'block';
  box.innerHTML = html`<div class="ai-snapshot-box">Reading through their history...</div>`;
  try {
    const res = await fetch(`${API}/ai/lead-snapshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: currentProfileLeadId })
    });
    const data = await res.json().catch(() => ({}));
    box.innerHTML = res.ok
      ? html`<div class="ai-snapshot-box"><p>${data.snapshot}</p></div>`
      : html`<div class="ai-snapshot-box">Couldn't generate a summary: ${data.error}</div>`;
  } catch (err) {
    box.innerHTML = html`<div class="ai-snapshot-box">Could not reach the AI assistant.</div>`;
  }
});

// ----- Planned: open tasks and appointments -----

function renderPlanned() {
  const el = document.getElementById('cpPlanned');
  const open = cpTasks.filter(t => t.status === 'open');
  if (!open.length) {
    el.innerHTML = html`<div class="cp-empty">Nothing scheduled.
      <button type="button" class="link-btn" data-schedule="task">+ Schedule a task</button> or
      <button type="button" class="link-btn" data-schedule="appointment">set an appointment</button></div>`;
    return;
  }
  const now = new Date();
  el.innerHTML = open.map(t => {
    const due = new Date(t.dueAt);
    const overdue = due < now;
    const today = due.toDateString() === now.toDateString();
    return html`
      <div class="cp-task ${overdue ? 'overdue' : ''}" data-task="${t.id}">
        <div class="cp-task-icon">${TASK_ICONS[t.type] || '☑️'}</div>
        <div class="cp-task-body">
          <div class="cp-task-title">${TASK_LABELS[t.type] || 'Task'}${t.title ? html` -- ${t.title}` : ''}</div>
          <div class="cp-task-meta">${overdue ? 'Overdue · ' : today ? 'Today · ' : ''}${due.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${t.assignedTo ? t.assignedTo.name : '--'}</div>
          ${t.notes ? html`<div class="cp-task-notes">${t.notes}</div>` : ''}
          <div class="cp-task-inline" hidden></div>
        </div>
        <div class="cp-task-buttons">
          <button type="button" class="btn-primary btn-small" data-task-action="done">Done</button>
          <button type="button" class="btn-secondary btn-small" data-task-action="move">Reschedule</button>
          <button type="button" class="link-btn" data-task-action="cancel">Cancel</button>
        </div>
      </div>`;
  }).join('');
}

document.getElementById('cpPlanned').addEventListener('click', async (e) => {
  const schedule = e.target.closest('[data-schedule]');
  if (schedule) {
    cpComposerKind = schedule.dataset.schedule;
    renderComposer();
    document.getElementById('cpComposer').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const btn = e.target.closest('[data-task-action]');
  if (!btn) return;
  const row = btn.closest('[data-task]');
  const id = row.dataset.task;
  const inline = row.querySelector('.cp-task-inline');
  const action = btn.dataset.taskAction;
  if (action === 'done') {
    inline.hidden = false;
    inline.innerHTML = html`<input type="text" placeholder="What happened? (optional)" class="cp-inline-input" />
      <button type="button" class="btn-primary btn-small" data-confirm="complete">Save</button>`;
    inline.querySelector('input').focus();
  } else if (action === 'move') {
    const t = cpTasks.find(x => x.id === id);
    const d = new Date(t.dueAt);
    const pad = n => String(n).padStart(2, '0');
    inline.hidden = false;
    inline.innerHTML = html`<input type="datetime-local" class="cp-inline-input" value="${`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`}" />
      <button type="button" class="btn-primary btn-small" data-confirm="move">Save</button>`;
  } else if (action === 'cancel') {
    if (confirm('Cancel this task?')) await taskRequest(`/tasks/${id}/cancel`, 'POST', {});
  }
});
document.getElementById('cpPlanned').addEventListener('click', async (e) => {
  const confirmBtn = e.target.closest('[data-confirm]');
  if (!confirmBtn) return;
  const row = confirmBtn.closest('[data-task]');
  const value = row.querySelector('.cp-task-inline input').value;
  if (confirmBtn.dataset.confirm === 'complete') await taskRequest(`/tasks/${row.dataset.task}/complete`, 'POST', { outcome: value });
  else if (value) await taskRequest(`/tasks/${row.dataset.task}`, 'PUT', { dueAt: new Date(value).toISOString() });
});
document.getElementById('cpPlanned').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.cp-task-inline')) e.target.closest('.cp-task-inline').querySelector('[data-confirm]').click();
});

async function taskRequest(path, method, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const b = await res.json().catch(() => ({})); if (res.status !== 403) alert(b.error || 'Could not update the task.'); return; }
  await cpRefresh();
}

// ----- History -----

function renderHistory() {
  const lead = cpLead();
  if (!lead) return;
  const activities = lead.activities || [];
  document.getElementById('cpHistoryFilters').innerHTML = HISTORY_FILTERS.map(([key, label, match]) => {
    const n = activities.filter(match).length;
    return key !== 'all' && !n ? '' : html`<button type="button" data-filter="${key}" class="${cpHistoryFilter === key ? 'active' : ''}">${label} ${n}</button>`;
  }).join('');
  const match = (HISTORY_FILTERS.find(f => f[0] === cpHistoryFilter) || HISTORY_FILTERS[0])[2];
  const shown = activities.filter(match);
  const canDelete = userCan('deleteRecords');
  document.getElementById('activityLogList').innerHTML = shown.length ? shown.map(a => html`
    <div class="activity-entry">
      <div class="activity-icon">${ACTIVITY_ICONS[a.type] || '📝'}</div>
      <div class="activity-body">
        <div class="activity-meta">
          <span><strong>${ACTIVITY_LABELS[a.type] || 'Note'}</strong>${a.by ? ` · ${a.by.name}` : ''} · ${new Date(a.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
          ${canDelete ? html`<button class="activity-delete" onclick="deleteActivity(${js(lead.id)}, ${js(a.id)})">Delete</button>` : ''}
        </div>
        <div class="activity-text">${a.text}</div>
      </div>
    </div>`).join('') : html`<div class="cp-empty">Nothing logged yet.</div>`;
}

document.getElementById('cpHistoryFilters').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  cpHistoryFilter = btn.dataset.filter;
  renderHistory();
});

window.deleteActivity = async function(leadId, activityId) {
  if (!confirm('Delete this entry from their history?')) return;
  await fetch(`${API}/leads/${leadId}/activities/${activityId}`, { method: 'DELETE' });
  await cpRefresh();
};

// ----- Conversation: texts as a thread -----

function renderThread(lead) {
  const texts = (lead.activities || []).filter(a => a.type === 'text').slice().reverse(); // oldest first
  document.getElementById('cpThread').innerHTML = texts.length ? texts.map(t => html`
    <div class="cp-bubble ${t.direction === 'in' ? 'in' : 'out'}">
      <div>${t.message !== undefined ? (t.message || '(photo)') : t.text}</div>
      ${t.photo ? html`<img src="${photoThumb(t.photo, 160, 120)}" alt="" loading="lazy" />` : ''}
      <div class="cp-bubble-meta">${t.by ? `${t.by.name} · ` : ''}${new Date(t.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
    </div>`).join('') : html`<div class="cp-empty">No texts yet.</div>`;
  document.getElementById('cpThreadCompose').innerHTML = lead.phone ? sendTextBoxHtml('cpThreadText') : html`<p class="audit-note">Add a phone number to text this customer.</p>`;
  if (lead.phone) renderTextPhotos('cpThreadTextPhotos', lead);
}

// ----- Deals and Value -----

function renderProfileDeals(lead) {
  const related = deals.filter(d => d.leadId === lead.id);
  document.getElementById('cpDealCount').textContent = related.length;
  const credit = s => CREDIT_STATUS_LABELS[s] || s;
  document.getElementById('profileDealsList').innerHTML = related.length ? related.slice().reverse().map(d => {
    const car = cars.find(c => c.id === d.carId);
    const ca = d.creditApp || {};
    return html`
      <div class="related-deal-row cp-deal-row">
        <div>
          <button class="deal-number-link" onclick="closeProfileAndOpenDeal(${js(d.id)})">D-${d.dealNumber}</button>
          -- ${car ? cpCarLabel(car) : 'No vehicle yet'}${d.vehiclePrice ? ` · ${money(d.vehiclePrice)}` : ''}${d.hasTrade && d.tradeMake ? ` · trade ${[d.tradeYear, d.tradeMake, d.tradeModel].filter(Boolean).join(' ')}` : ''}
          <div class="audit-note">Credit: ${credit(ca.status || 'not_submitted')}${d.creditPushedAt ? ` · pushed ${new Date(d.creditPushedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ' · not pushed'}</div>
        </div>
        <div class="cp-deal-buttons">
          <span class="badge ${d.status}">${DEAL_STATUS_LABELS[d.status] || d.status}</span>
          ${d.status === 'working' ? html`<button type="button" class="btn-secondary btn-small" onclick="cpPushCreditFromDeals(${js(d.id)})">Push Credit</button>` : ''}
        </div>
      </div>`;
  }).join('') : html`<div class="cp-empty">No deals yet. Push one above.</div>`;
  renderPushDealForm(lead);
}

function renderCpValue(lead) {
  const trades = leadTrades(lead).slice().reverse();
  const sold = deals.filter(d => d.leadId === lead.id && ['delivered', 'closed', 'finalized'].includes(d.status));
  document.getElementById('cpValue').innerHTML = html`
    <div class="retail-stats">
      <div><span>Cars bought here</span><strong>${sold.length}</strong></div>
      <div><span>Total purchases</span><strong>${money(sold.reduce((s, d) => s + (Number(d.vehiclePrice) || 0), 0))}</strong></div>
      <div><span>Trades appraised</span><strong>${trades.length}</strong></div>
    </div>
    <div class="cp-section-head">Trades</div>
    ${trades.length ? html`<table class="mini-table">
      <tr><th>Appraisal</th><th>Vehicle</th><th>Miles</th><th>Appraised</th><th>Offered</th><th>Status</th></tr>
      ${trades.map(a => {
        const lastOffer = (a.customerOffers || []).slice(-1)[0];
        return html`<tr>
          <td><button class="link-btn" onclick="openAppraisal(${js(a.id)})">A-${a.appraisalNumber}</button></td>
          <td>${appraisalVehicle(a)}</td><td>${a.mileage ? Number(a.mileage).toLocaleString() : '--'}</td>
          <td>${money(a.offer)}</td><td>${lastOffer ? money(lastOffer.amount) : '--'}</td>
          <td>${APPRAISAL_STATUS_LABELS[a.status]}</td></tr>`;
      })}</table>` : html`<div class="cp-empty">No trades appraised. <button type="button" class="link-btn" onclick="cpAction('trade')">Appraise a trade</button></div>`}
    <p class="audit-note">Equity, payoff, and service history show here once those are connected.</p>`;
}

window.closeProfileAndOpenDeal = function(dealId) {
  closeCustomerPage();
  openDealWorkspace(dealId);
};

// ----- Right column: Add and Actions -----

function latestDeal(lead) {
  const related = deals.filter(d => d.leadId === lead.id);
  return related.find(d => d.status === 'working') || related.slice(-1)[0] || null;
}

function showActionPanel(content) {
  const panel = document.getElementById('cpActionPanel');
  panel.hidden = false;
  panel.innerHTML = content;
  panel.scrollIntoView({ block: 'nearest' });
  return panel;
}

window.cpAction = async function(action) {
  const lead = cpLead();
  if (!lead) return;
  document.getElementById('cpLaterNote').hidden = true;
  if (action === 'new-deal') {
    cpSwitchTab('deals');
    document.getElementById('cpPushDeal').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (cpPushDealPicker && !cpPushDealCarId) cpPushDealPicker.input.focus();
  } else if (action === 'vehicles') {
    cpWishPicker.input.focus();
  } else if (action === 'trade') {
    openTradeForm();
  } else if (action === 'credit-app') {
    openCpCreditApp();
  } else if (action === 'desk') {
    const deal = latestDeal(lead);
    if (!deal) {
      showActionPanel(html`<div class="cp-panel-title">No deal yet</div><p class="audit-note">Push a deal to the DMS first -- the desk lives on the deal.</p>
        <button type="button" class="btn-primary btn-small" onclick="cpAction('new-deal')">Push a Deal</button>`);
      return;
    }
    closeCustomerPage();
    openDealWorkspace(deal.id);
  } else if (action === 'check-in') {
    if (await cpLogActivity('visit', 'Checked in at the showroom')) await cpRefresh();
  } else if (action === 'sold') {
    if (!confirm(`Mark ${lead.name} as sold?`)) return;
    await cpLogActivity('status', 'Marked as sold');
    await cpSaveLead({ status: 'won', snoozedUntil: null });
    await cpRefresh();
  } else if (action === 'snooze') {
    const day = n => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(8, 0, 0, 0); return d.toISOString(); };
    showActionPanel(html`<div class="cp-panel-title">Snooze until</div>
      <div class="cp-panel-buttons">
        <button type="button" class="btn-secondary btn-small" data-snooze="${day(1)}">Tomorrow</button>
        <button type="button" class="btn-secondary btn-small" data-snooze="${day(3)}">3 days</button>
        <button type="button" class="btn-secondary btn-small" data-snooze="${day(7)}">1 week</button>
        <button type="button" class="btn-secondary btn-small" data-snooze="${day(30)}">1 month</button>
      </div>
      <input type="date" id="cpSnoozeDate" class="cp-inline-input" />
      <div class="cp-panel-buttons">
        <button type="button" class="btn-primary btn-small" data-snooze-custom>Snooze</button>
        ${isSnoozed(lead) ? html`<button type="button" class="btn-secondary btn-small" data-snooze="">Wake up now</button>` : ''}
        <button type="button" class="link-btn" data-panel-close>Cancel</button>
      </div>
      <p class="audit-note">Snoozed customers drop off the follow-up lists until then.</p>`);
  } else if (action === 'dead') {
    if (lead.status === 'lost') {
      await cpLogActivity('status', 'Brought back from dead');
      await cpSaveLead({ status: 'contacted', lostReason: '' });
      return cpRefresh();
    }
    showActionPanel(html`<div class="cp-panel-title">Mark as dead -- why?</div>
      <div class="cp-panel-buttons">
        ${['Bought elsewhere', 'Not in the market', 'Credit', 'Price', 'No response'].map(r => html`<button type="button" class="btn-secondary btn-small" data-dead="${r}">${r}</button>`)}
      </div>
      <input type="text" id="cpDeadReason" class="cp-inline-input" placeholder="Or type a reason" />
      <div class="cp-panel-buttons"><button type="button" class="btn-primary btn-small" data-dead-custom>Mark dead</button>
        <button type="button" class="link-btn" data-panel-close>Cancel</button></div>`);
  } else if (action === 'transfer') {
    showActionPanel(html`<div class="cp-panel-title">Transfer to</div>
      <select id="cpTransferTo" class="cp-inline-input">
        ${staffList.filter(u => u.id !== lead.sales1Id).map(u => html`<option value="${u.id}">${u.name}</option>`)}
      </select>
      <div class="cp-panel-buttons"><button type="button" class="btn-primary btn-small" data-transfer>Transfer</button>
        <button type="button" class="link-btn" data-panel-close>Cancel</button></div>
      <p class="audit-note">Makes them Sales 1. ${lead.sales1Id ? `Currently ${staffName(lead.sales1Id)}.` : 'Nobody is assigned now.'}</p>`);
  }
};

document.querySelector('.cp-right').addEventListener('click', async (e) => {
  const lead = cpLead();
  const actionBtn = e.target.closest('.cp-action[data-action]');
  if (actionBtn) return cpAction(actionBtn.dataset.action);
  const later = e.target.closest('.cp-later');
  if (later) {
    const note = document.getElementById('cpLaterNote');
    note.hidden = false;
    note.innerHTML = html`<strong>${later.dataset.later} -- not available yet.</strong> Needs ${later.dataset.needs}.`;
    return;
  }
  if (e.target.closest('[data-panel-close]')) { document.getElementById('cpActionPanel').hidden = true; return; }
  const snooze = e.target.closest('[data-snooze]');
  const snoozeCustom = e.target.closest('[data-snooze-custom]');
  if (snooze || snoozeCustom) {
    const until = snooze ? snooze.dataset.snooze : (document.getElementById('cpSnoozeDate').value ? new Date(`${document.getElementById('cpSnoozeDate').value}T08:00`).toISOString() : '');
    if (snoozeCustom && !until) return document.getElementById('cpSnoozeDate').focus();
    await cpLogActivity('status', until ? `Snoozed until ${new Date(until).toLocaleDateString()}` : 'Woken up from snooze');
    await cpSaveLead({ snoozedUntil: until || null });
    document.getElementById('cpActionPanel').hidden = true;
    return cpRefresh();
  }
  const dead = e.target.closest('[data-dead]');
  const deadCustom = e.target.closest('[data-dead-custom]');
  if (dead || deadCustom) {
    const reason = dead ? dead.dataset.dead : document.getElementById('cpDeadReason').value.trim();
    if (!reason) return document.getElementById('cpDeadReason').focus();
    await cpLogActivity('status', `Marked dead: ${reason}`);
    await cpSaveLead({ status: 'lost', lostReason: reason });
    document.getElementById('cpActionPanel').hidden = true;
    return cpRefresh();
  }
  if (e.target.closest('[data-transfer]')) {
    const to = document.getElementById('cpTransferTo').value;
    if (!to) return;
    await cpLogActivity('status', `Transferred${lead.sales1Id ? ` from ${staffName(lead.sales1Id)}` : ''} to ${staffName(to)}`);
    await cpSaveLead({ sales1Id: to });
    document.getElementById('cpActionPanel').hidden = true;
    return cpRefresh();
  }
});

// ----- Trades (go straight to Appraisals) -----

const leadTrades = lead => appraisals.filter(a => a.leadId === lead.id && !a.removedFromLead);
function tradeStatus(a) {
  if (a.status === 'acquired') return { label: `Acquired · ${money(a.acquiredFor)}`, cls: 'ok' };
  if (a.status === 'lost') return { label: 'Lost', cls: 'muted' };
  if (a.offer) return { label: `Appraised · ${money(a.offer)}`, cls: 'ok' };
  return { label: 'Waiting for appraisal', cls: 'wait' };
}

function renderCpTrades(lead) {
  const trades = leadTrades(lead);
  document.getElementById('cpTradeCount').textContent = trades.length;
  document.getElementById('cpTrades').innerHTML = trades.length ? trades.map(a => {
    const st = tradeStatus(a);
    return html`<div class="cp-trade">
      <div class="cp-wish-main">
        <div class="cp-wish-car">${appraisalVehicle(a)}</div>
        <div class="cp-wish-sub">${[a.mileage ? `${Number(a.mileage).toLocaleString()} mi` : '', a.payoff ? `owes ${money(a.payoff)}` : '', `A-${a.appraisalNumber}`].filter(Boolean).join(' · ')}</div>
        <span class="cp-trade-status ${st.cls}">${st.label}</span>
      </div>
      <button type="button" class="recon-remove" data-remove-trade="${a.id}" aria-label="Remove trade" title="Remove from this customer (the appraisal is kept)">✕</button>
    </div>`;
  }).join('') : html`<p class="audit-note">No trade yet.</p>`;
}

document.getElementById('cpTrades').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-trade]');
  if (!btn || !confirm('Remove this trade from the customer? The appraisal stays in Appraisals.')) return;
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/trades/${btn.dataset.removeTrade}`, { method: 'DELETE' });
  if (res.ok) await cpRefresh();
});

const TRADE_FIELDS = [['vin', 'trVin'], ['year', 'trYear'], ['make', 'trMake'], ['model', 'trModel'], ['trim', 'trTrim'],
  ['bodyStyle', 'trBodyStyle'], ['engine', 'trEngine'], ['drivetrain', 'trDrivetrain'], ['transmission', 'trTransmission'],
  ['fuelType', 'trFuelType'], ['mileage', 'trMileage'], ['exteriorColor', 'trExteriorColor'], ['interiorColor', 'trInteriorColor'],
  ['condition', 'trCondition'], ['payoff', 'trPayoff'], ['lienholder', 'trLienholder'], ['customerExpects', 'trCustomerExpects'], ['notes', 'trNotes']];

window.openTradeForm = function() {
  document.getElementById('tradeForm').reset();
  document.getElementById('trVinStatus').innerHTML = '';
  document.getElementById('trStatus').innerHTML = '';
  document.getElementById('tradeModal').classList.add('active');
  document.getElementById('trVin').focus();
};
async function decodeTradeVin() {
  await decodeVinInto({
    inputId: 'trVin', statusId: 'trVinStatus',
    fill: data => {
      const set = (id, v) => { document.getElementById(id).value = v || ''; };
      set('trYear', data.year); set('trMake', data.make); set('trModel', data.model); set('trTrim', data.trim);
      set('trBodyStyle', data.bodyStyle); set('trEngine', data.engine); set('trDrivetrain', data.drivetrain);
      set('trTransmission', data.transmission); set('trFuelType', data.fuelType);
    }
  });
}
document.getElementById('trDecodeBtn').addEventListener('click', decodeTradeVin);
document.getElementById('trVin').addEventListener('input', (e) => {
  if (VIN_PATTERN.test(cleanVin(e.target.value))) decodeTradeVin();
});
document.getElementById('trCancelBtn').addEventListener('click', () => document.getElementById('tradeModal').classList.remove('active'));
document.getElementById('tradeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(TRADE_FIELDS.map(([field, id]) => [field, document.getElementById(id).value]));
  body.vin = cleanVin(body.vin);
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/trades`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('trStatus').innerHTML = html`<p class="send-text-status-error">${data.error || 'Could not save the trade.'}</p>`; return; }
  document.getElementById('tradeModal').classList.remove('active');
  await cpRefresh();
});

// ----- Credit app (sales side) and pushing to the DMS -----

// The deal credit gets pushed to: their open deal, else their latest.
const pushTargetDeal = lead => latestDeal(lead);

function blankCreditAppFor(lead) {
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const a = leadAddress(lead);
  return {
    applicantType: lead.type === 'business' ? 'business' : 'individual',
    businessName: lead.type === 'business' ? lead.name : '',
    applicant: {
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || ''), lastName: parts.length > 1 ? parts[parts.length - 1] : '',
      phone: lead.phone || '', email: lead.email || '',
      address1: a.street || '', address2: a.unit || '', city: a.city || '', state: a.state || '', zip: a.zip || '', county: a.county || ''
    }
  };
}

function renderCreditSyncInfo(lead) {
  const ca = lead.creditApp;
  const sync = lead.creditAppSync || {};
  const deal = pushTargetDeal(lead);
  document.getElementById('cpCreditStatus').innerHTML = ca
    ? html`<span class="badge credit-${ca.status}">${CREDIT_STATUS_LABELS[ca.status] || ca.status}</span>` : '';
  const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  document.getElementById('cpCreditSync').innerHTML = html`
    ${sync.pushedAt ? html`<div>⬆ Pushed to the DMS ${when(sync.pushedAt)}${sync.pushedBy ? ` by ${sync.pushedBy.name}` : ''}</div>` : html`<div>Not pushed to the DMS yet.</div>`}
    ${sync.fromDmsAt ? html`<div>⬇ F&I updated it ${when(sync.fromDmsAt)}${sync.fromDmsBy ? ` (${sync.fromDmsBy.name})` : ''}</div>` : ''}
    <div class="audit-note">${deal ? html`Pushes to deal D-${deal.dealNumber}.` : 'No deal yet -- push a deal first (Deals tab), then push credit.'} Name, phone, email, and address here are the customer's -- saving updates them too.</div>`;
}

window.openCpCreditApp = function() {
  const lead = cpLead();
  if (!lead) return;
  const ca = lead.creditApp || blankCreditAppFor(lead);
  renderCreditAppFields(ca, 'crm');
  document.getElementById('cpCreditMsg').innerHTML = '';
  renderCreditSyncInfo(lead);
  document.getElementById('cpCreditModal').classList.add('active');
  document.querySelector('#cpCreditModal .modal-content').scrollTop = 0;
};

async function saveCpCreditApp() {
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/credit-app`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectCreditAppForm('crm'))
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { document.getElementById('cpCreditMsg').innerHTML = html`<p class="send-text-status-error">${body.error || 'Could not save.'}</p>`; return null; }
  const i = leads.findIndex(l => l.id === body.id);
  if (i >= 0) leads[i] = body;
  renderCreditSyncInfo(body);
  renderCustomerPage();
  return body;
}

async function pushCreditToDms(dealId) {
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/push-credit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealId })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || 'Could not push the credit app.' };
  await cpRefresh();
  return { deal: body };
}

document.getElementById('cpCreditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveCpCreditApp()) document.getElementById('cpCreditMsg').innerHTML = html`<p class="send-text-status-success">✓ Saved</p>`;
});
document.getElementById('cpPushCreditBtn').addEventListener('click', async () => {
  const lead = await saveCpCreditApp();
  if (!lead) return;
  const deal = pushTargetDeal(lead);
  if (!deal) {
    document.getElementById('cpCreditMsg').innerHTML = html`<p class="send-text-status-error">Saved. There's no deal to push it to yet -- push a deal from the Deals tab first.</p>`;
    return;
  }
  const result = await pushCreditToDms(deal.id);
  const msg = document.getElementById('cpCreditMsg');
  msg.innerHTML = result.error ? html`<p class="send-text-status-error">${result.error}</p>`
    : html`<p class="send-text-status-success">✓ Credit app pushed to D-${deal.dealNumber}. F&I can submit it to lenders from the deal.</p>`;
  renderCreditSyncInfo(cpLead());
});
document.getElementById('cpCreditCloseBtn').addEventListener('click', () => document.getElementById('cpCreditModal').classList.remove('active'));

// Push Deal: the form at the top of the Deals tab.
let cpPushDealPicker = null;
let cpPushDealCarId = '';
function renderPushDealForm(lead) {
  const el = document.getElementById('cpPushDeal');
  const trades = leadTrades(lead).filter(a => a.status !== 'lost');
  el.innerHTML = html`
    <div class="cp-push-deal">
      <div class="cp-panel-title">Push a deal to the DMS</div>
      <div class="cp-push-grid">
        <label class="wide">Vehicle <span id="cpPushCar"></span></label>
        <label>Trade
          <select id="cpPushTrade">
            <option value="">No trade</option>
            ${trades.map(a => html`<option value="${a.id}">${appraisalVehicle(a)} (${tradeStatus(a).label})</option>`)}
          </select>
        </label>
        <label>Type
          <select id="cpPushType"><option value="retail">Retail</option><option value="lease">Lease</option><option value="cash">Cash</option></select>
        </label>
        <label>Cash down <input type="number" id="cpPushDown" placeholder="0" /></label>
      </div>
      <div class="cp-panel-buttons">
        <button type="button" class="btn-primary btn-small" id="cpPushDealBtn">Push Deal → get a deal #</button>
        <span class="cp-composer-status" id="cpPushDealStatus"></span>
      </div>
      <p class="audit-note">Brings the car, the trade (with payoff), and the credit app to Sales &amp; F&amp;I.</p>
    </div>`;
  const available = cars.filter(c => c.status !== 'sold');
  const wanted = (lead.wishList || []).filter(id => available.some(c => c.id === id));
  cpPushDealCarId = lead.carId && wanted.includes(lead.carId) ? lead.carId : (wanted[0] || '');
  cpPushDealPicker = createSearchPicker({
    kind: 'car',
    getIds: () => [...available.map(c => c.id).filter(id => !wanted.includes(id)), ...wanted],
    onPick: (id) => {
      cpPushDealCarId = id;
      const car = cars.find(c => c.id === id);
      cpPushDealPicker.setLabel(car ? carPickLabel(car) : '');
    }
  });
  document.getElementById('cpPushCar').appendChild(cpPushDealPicker.element);
  const car = cars.find(c => c.id === cpPushDealCarId);
  cpPushDealPicker.setLabel(car ? carPickLabel(car) : '');
  if (trades.length === 1) document.getElementById('cpPushTrade').value = trades[0].id;
  document.getElementById('cpPushDealBtn').onclick = pushDealToDms;
}

async function pushDealToDms() {
  const status = document.getElementById('cpPushDealStatus');
  status.textContent = 'Pushing...';
  const res = await fetch(`${API}/leads/${currentProfileLeadId}/push-deal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      carId: cpPushDealCarId || null, tradeId: document.getElementById('cpPushTrade').value || null,
      dealType: document.getElementById('cpPushType').value, downPayment: document.getElementById('cpPushDown').value
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { status.innerHTML = html`<span class="send-text-status-error">${body.error || 'Could not push the deal.'}</span>`; return; }
  await cpRefresh();
  cpSwitchTab('deals');
  const again = document.getElementById('cpPushDealStatus');
  if (again) again.innerHTML = html`<span class="send-text-status-success">✓ Deal D-${body.dealNumber} is in the DMS</span>`;
}

window.cpPushCreditFromDeals = async function(dealId) {
  const lead = cpLead();
  if (!lead.creditApp) { openCpCreditApp(); return; }
  const result = await pushCreditToDms(dealId);
  if (result.error) alert(result.error);
};

// ----- Opening, editing, closing -----

document.getElementById('editFromProfileBtn').addEventListener('click', () => {
  closeCustomerPage();
  returnToProfileAfterEdit = true;
  editLead(currentProfileLeadId);
});

document.getElementById('closeProfileBtn').addEventListener('click', closeCustomerPage);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !leadProfileModal.classList.contains('active') || e.target.closest('input, textarea, select')) return;
  const overlay = document.querySelector('.modal.cp-overlay.active');
  if (overlay) overlay.classList.remove('active'); else closeCustomerPage();
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
  renderDealTradeAppraisal(deal);
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
  renderDealCreditSync(deal);

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

function applicantFieldsHtml(prefix, title, isCo = false) {
  return `
    <div class="ca-applicant-block" id="${prefix}ApplicantBlock">
      <div class="ca-applicant-header">
        <h3>${title}</h3>
        ${isCo ? `<button type="button" class="btn-secondary" id="${prefix}RemoveBtn">Remove Co-Applicant</button>` : ''}
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

// The credit app form appears twice: on the deal (the DMS side, where
// F&I also sets the approval status) and on the customer page (where
// sales fills it in and pushes it). Same form, separate element ids.
const CREDIT_FORMS = {
  deal: { top: 'ca', primary: 'primary', co: 'co', container: 'creditAppFieldsContainer', showStatus: true },
  crm: { top: 'crmCa', primary: 'crmPrimary', co: 'crmCo', container: 'cpCreditAppFields', showStatus: false }
};
const creditFormHasCo = { deal: false, crm: false };
let workspaceHasCoApplicant = false; // the deal form's (kept for existing callers)

function renderCreditAppFields(creditApp, formKey = 'deal') {
  const f = CREDIT_FORMS[formKey];
  const ca = creditApp || {};
  creditFormHasCo[formKey] = !!ca.hasCoApplicant;
  if (formKey === 'deal') workspaceHasCoApplicant = creditFormHasCo.deal;

  const container = document.getElementById(f.container);
  container.innerHTML = `
    <div class="form-grid">
      <label>Application Type
        <select id="${f.top}ApplicantType">
          <option value="individual">Individual</option>
          <option value="business">Business</option>
        </select>
      </label>
      ${f.showStatus ? `<label>Approval Status
        <select id="${f.top}Status">
          <option value="not_submitted">Not Submitted</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="conditional">Conditional</option>
          <option value="declined">Declined</option>
        </select>
      </label>` : ''}
    </div>

    <div id="${f.top}BusinessFields" class="form-grid" style="display:none;">
      <label>Business Name <input type="text" id="${f.top}BusinessName" /></label>
      <label>EIN <input type="text" id="${f.top}BusinessEIN" /></label>
      <label>Business Address <input type="text" id="${f.top}BusinessAddress" /></label>
      <label>Business Phone <input type="text" id="${f.top}BusinessPhone" /></label>
      <label>Years in Business <input type="number" min="0" id="${f.top}YearsInBusiness" /></label>
      <label>Annual Revenue <input type="number" id="${f.top}AnnualRevenue" /></label>
    </div>

    ${applicantFieldsHtml(f.primary, 'Applicant')}

    <div id="${f.top}CoToggleRow" style="margin-bottom:16px;">
      <button type="button" class="btn-secondary" id="${f.top}AddCoBtn">+ Add Co-Applicant</button>
    </div>
    <div id="${f.top}CoContainer"></div>
  `;

  document.getElementById(`${f.top}ApplicantType`).value = ca.applicantType || 'individual';
  if (f.showStatus) document.getElementById(`${f.top}Status`).value = ca.status || 'not_submitted';
  document.getElementById(`${f.top}BusinessName`).value = ca.businessName || '';
  document.getElementById(`${f.top}BusinessEIN`).value = ca.businessEIN || '';
  document.getElementById(`${f.top}BusinessAddress`).value = ca.businessAddress || '';
  document.getElementById(`${f.top}BusinessPhone`).value = ca.businessPhone || '';
  document.getElementById(`${f.top}YearsInBusiness`).value = ca.yearsInBusiness || '';
  document.getElementById(`${f.top}AnnualRevenue`).value = ca.annualRevenue || 0;
  document.getElementById(`${f.top}BusinessFields`).style.display = ca.applicantType === 'business' ? 'grid' : 'none';

  fillApplicantFields(f.primary, ca.applicant || {});
  if (creditFormHasCo[formKey]) showCoApplicantBlock(ca.coApplicant || {}, formKey);

  document.getElementById(`${f.top}ApplicantType`).addEventListener('change', (e) => {
    document.getElementById(`${f.top}BusinessFields`).style.display = e.target.value === 'business' ? 'grid' : 'none';
  });
  wireApplicantToggles(f.primary);
  document.getElementById(`${f.top}AddCoBtn`).addEventListener('click', () => showCoApplicantBlock({}, formKey));
}

function showCoApplicantBlock(coApplicantData, formKey = 'deal') {
  const f = CREDIT_FORMS[formKey];
  creditFormHasCo[formKey] = true;
  if (formKey === 'deal') workspaceHasCoApplicant = true;
  document.getElementById(`${f.top}CoToggleRow`).style.display = 'none';
  document.getElementById(`${f.top}CoContainer`).innerHTML = applicantFieldsHtml(f.co, 'Co-Applicant', true);
  fillApplicantFields(f.co, coApplicantData);
  wireApplicantToggles(f.co);
  document.getElementById(`${f.co}RemoveBtn`).addEventListener('click', () => {
    creditFormHasCo[formKey] = false;
    if (formKey === 'deal') workspaceHasCoApplicant = false;
    document.getElementById(`${f.top}CoContainer`).innerHTML = '';
    document.getElementById(`${f.top}CoToggleRow`).style.display = 'block';
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

function collectCreditAppForm(formKey = 'deal') {
  const f = CREDIT_FORMS[formKey];
  const val = id => document.getElementById(`${f.top}${id}`).value;
  const hasCo = creditFormHasCo[formKey];
  return {
    applicantType: val('ApplicantType'),
    businessName: val('BusinessName'),
    businessEIN: val('BusinessEIN'),
    businessAddress: val('BusinessAddress'),
    businessPhone: val('BusinessPhone'),
    yearsInBusiness: val('YearsInBusiness'),
    annualRevenue: val('AnnualRevenue'),
    ...(f.showStatus ? { status: val('Status') } : {}),
    applicant: collectApplicantFields(f.primary),
    hasCoApplicant: hasCo,
    coApplicant: hasCo ? collectApplicantFields(f.co) : {}
  };
}

// Deal (DMS side): where this credit app came from, and the lenders F&I
// submits it to (each "Not available yet" until that partner is approved).
function renderDealCreditSync(deal) {
  const lead = leads.find(l => l.id === deal.leadId);
  const when = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  document.getElementById('dealCreditSync').innerHTML = lead ? html`
    <div>${deal.creditPushedAt ? html`⬇ Pushed from ${lead.name}'s customer page ${when(deal.creditPushedAt)}.` : html`Not pushed from the customer page yet.`}</div>
    <div class="audit-note">Changes you save here go back to the customer page automatically.</div>`
    : html`<div class="audit-note">No customer on this deal yet.</div>`;
  document.getElementById('dealLenders').innerHTML = providerList.filter(p => p.category === 'lender').map(p => providerSlotHtml(p)).join('');
}

// Credit application form on the deal: saved separately from the desking numbers
async function saveCreditAppForm() {
  await fetch(`${API}/deals/${currentWorkspaceDealId}/credit-app`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectCreditAppForm('deal'))
  });
}

document.getElementById('creditAppForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveCreditAppForm();
  await loadAll();
  const savedDeal = deals.find(d => d.id === currentWorkspaceDealId);
  if (savedDeal) renderDealCreditSync(savedDeal);
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
  document.getElementById('settingsAppraisalPack').value = settings.appraisalPack ?? 0;
  document.getElementById('settingsAppraisalTargetGross').value = settings.appraisalTargetGross ?? 2500;
  const roadmapLabels = (settings.roadmapLabels && settings.roadmapLabels.length === 7) ? settings.roadmapLabels : DEFAULT_ROADMAP_LABELS;
  document.getElementById('settingsRoadmapLabels').innerHTML = roadmapLabels.map((label, i) =>
    html`<label>${i + 1} <input type="text" maxlength="24" data-roadmap-step="${i}" value="${label}" /></label>`).join('');
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
    appraisalPack: Number(document.getElementById('settingsAppraisalPack').value) || 0,
    appraisalTargetGross: Number(document.getElementById('settingsAppraisalTargetGross').value) || 0,
    roadmapLabels: [...document.querySelectorAll('[data-roadmap-step]')]
      .map((input, i) => input.value.trim().slice(0, 24) || DEFAULT_ROADMAP_LABELS[i]),
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
  car: 'Vehicle', lead: 'Customer', deal: 'Deal', user: 'User', tax_rate: 'Tax rate', settings: 'Fee defaults', appraisal: 'Appraisal', task: 'Task'
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
  document.getElementById('integrationDmsSlots').innerHTML = providerList.filter(p => p.category === 'dms').map(p => providerSlotHtml(p)).join('');
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
  const [providersRes, settingsRes, staffRes] = await Promise.all([fetch(`${API}/providers`), fetch(`${API}/settings`), fetch(`${API}/staff`)]);
  if (providersRes.ok) providerList = await providersRes.json();
  if (staffRes.ok) staffList = await staffRes.json();
  if (settingsRes.ok) appSettings = await settingsRes.json();
  loadAll();
}

init();
