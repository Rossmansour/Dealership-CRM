// app.js
// All frontend logic: tab switching, fetching data from the API,
// rendering tables, and handling the add/edit modals.
// Plain JS + fetch on purpose -- no framework needed for a project this size.

const API = '/api';
let cars = [];
let leads = [];
let deals = [];

// ---------- Dark mode ----------
// The initial theme is already applied by an inline script in <head>
// (so there's no flash of light mode on page load) -- this just wires
// up the toggle button and keeps the choice saved for next time.

const themeToggleBtn = document.getElementById('themeToggleBtn');

function updateThemeButtonLabel() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  themeToggleBtn.textContent = isDark ? '☀️ Light Mode' : '🌙 Dark Mode';
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

// ---------- Tab switching ----------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// ---------- Data loading ----------

async function loadAll() {
  const [carsRes, leadsRes, dealsRes, statsRes] = await Promise.all([
    fetch(`${API}/cars`).then(r => r.json()),
    fetch(`${API}/leads`).then(r => r.json()),
    fetch(`${API}/deals`).then(r => r.json()),
    fetch(`${API}/stats`).then(r => r.json())
  ]);
  cars = carsRes;
  leads = leadsRes;
  deals = dealsRes;
  renderStats(statsRes);
  renderCars();
  renderLeads();
  renderDeals();
  populateLeadCarOptions();
}

// ---------- Dashboard ----------

function renderStats(stats) {
  const cards = [
    { label: 'Available Cars', value: stats.availableCars },
    { label: 'Inventory Value', value: `$${stats.inventoryValue.toLocaleString()}` },
    { label: 'Cars Sold', value: stats.soldCars },
    { label: 'Total Profit', value: `$${stats.totalProfit.toLocaleString()}` },
    { label: 'Avg Days on Lot', value: stats.avgDaysOnLot },
    { label: 'Lead Conversion Rate', value: `${stats.conversionRate}%` },
  ];
  document.getElementById('statsGrid').innerHTML = cards.map(c => `
    <div class="stat-card">
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
      (c.vin || '').toLowerCase().includes(search);
    const matchesStatus = !statusFilter || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  document.getElementById('carTableBody').innerHTML = filtered.map(c => {
    const daysListed = Math.round((new Date() - new Date(c.dateAdded)) / (1000 * 60 * 60 * 24));
    return `
      <tr>
        <td>${c.make}</td>
        <td>${c.model}</td>
        <td>${c.year}</td>
        <td>${c.mileage.toLocaleString()}</td>
        <td>$${c.price.toLocaleString()}</td>
        <td><span class="badge ${c.status}">${c.status}</span></td>
        <td>${c.status === 'sold' ? '-' : daysListed}</td>
        <td class="row-actions">
          <button onclick="editCar('${c.id}')">Edit</button>
          <button class="delete" onclick="deleteCar('${c.id}')">Delete</button>
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
  let filtered = leads.filter(l => !statusFilter || l.status === statusFilter);

  document.getElementById('leadTableBody').innerHTML = filtered.map(l => {
    const car = cars.find(c => c.id === l.carId);
    const carLabel = car ? `${car.year} ${car.make} ${car.model}` : '-';
    return `
      <tr>
        <td><button class="deal-number-link" onclick="openLeadProfile('${l.id}')">${l.name}</button></td>
        <td><span class="badge ${l.type === 'business' ? 'finalized' : 'working'}">${l.type === 'business' ? 'Business' : 'Individual'}</span></td>
        <td>${l.phone || l.email || '-'}</td>
        <td>${formatSource(l.source)}</td>
        <td>${carLabel}</td>
        <td><span class="badge ${l.status}">${l.status}</span></td>
        <td>${l.notes || ''}</td>
        <td class="row-actions">
          <button onclick="editLead('${l.id}')">Edit</button>
          <button class="delete" onclick="deleteLead('${l.id}')">Delete</button>
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
    .map(c => `<option value="${c.id}">${c.year} ${c.make} ${c.model}</option>`)
    .join('');
  select.value = current;
}

// ---------- Car modal ----------

const carModal = document.getElementById('carModal');

document.getElementById('addCarBtn').addEventListener('click', () => {
  document.getElementById('carModalTitle').textContent = 'Add Car';
  document.getElementById('carForm').reset();
  document.getElementById('carId').value = '';
  carModal.classList.add('active');
});

document.getElementById('cancelCarBtn').addEventListener('click', () => {
  carModal.classList.remove('active');
});

window.editCar = function(id) {
  const car = cars.find(c => c.id === id);
  document.getElementById('carModalTitle').textContent = 'Edit Car';
  document.getElementById('carId').value = car.id;
  document.getElementById('carMake').value = car.make;
  document.getElementById('carModel').value = car.model;
  document.getElementById('carYear').value = car.year;
  document.getElementById('carVin').value = car.vin;
  document.getElementById('carMileage').value = car.mileage;
  document.getElementById('carCost').value = car.cost;
  document.getElementById('carPrice').value = car.price;
  document.getElementById('carStatus').value = car.status;
  carModal.classList.add('active');
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

const ACTIVITY_ICONS = { call: '📞', text: '💬', email: '✉️', note: '📝' };
const ACTIVITY_LABELS = { call: 'Call', text: 'Text', email: 'Email', note: 'Note' };

window.openLeadProfile = function(leadId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) return;
  currentProfileLeadId = leadId;

  document.getElementById('profileName').textContent = lead.name;
  document.getElementById('profileBadges').innerHTML = `
    <span class="badge ${lead.type === 'business' ? 'finalized' : 'working'}">${lead.type === 'business' ? 'Business' : 'Individual'}</span>
    <span class="badge ${lead.status}">${lead.status}</span>
  `;

  const car = cars.find(c => c.id === lead.carId);
  document.getElementById('profileInfoGrid').innerHTML = `
    <div class="info-item"><div class="label">Phone</div><div class="value">${lead.phone || '-'}</div></div>
    <div class="info-item"><div class="label">Email</div><div class="value">${lead.email || '-'}</div></div>
    <div class="info-item"><div class="label">Source</div><div class="value">${formatSource(lead.source)}</div></div>
    <div class="info-item"><div class="label">Interested In</div><div class="value">${car ? `${car.year} ${car.make} ${car.model}` : '-'}</div></div>
    <div class="info-item"><div class="label">Added</div><div class="value">${new Date(lead.dateAdded).toLocaleDateString()}</div></div>
    <div class="info-item"><div class="label">Notes</div><div class="value">${lead.notes || '-'}</div></div>
  `;

  renderProfileDeals(lead);
  renderActivityLog(lead);

  leadProfileModal.classList.add('active');
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
      return `
        <div class="related-deal-row">
          <span><button class="deal-number-link" onclick="closeProfileAndOpenDeal('${d.id}')">D-${d.dealNumber}</button> -- ${car ? `${car.year} ${car.make} ${car.model}` : 'Unknown vehicle'}</span>
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

  listEl.innerHTML = activities.map(a => `
    <div class="activity-entry">
      <div class="activity-icon">${ACTIVITY_ICONS[a.type] || '📝'}</div>
      <div class="activity-body">
        <div class="activity-meta">
          <span>${ACTIVITY_LABELS[a.type] || 'Note'} -- ${new Date(a.date).toLocaleString()}</span>
          <button class="activity-delete" onclick="deleteActivity('${lead.id}','${a.id}')">Delete</button>
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
  working: 'Working', credit_submitted: 'Credit Submitted', approved: 'Approved',
  conditional: 'Conditional', declined: 'Declined', finalized: 'Finalized'
};
const CREDIT_STATUS_LABELS = {
  not_submitted: 'Not Submitted', pending: 'Pending', approved: 'Approved',
  conditional: 'Conditional', declined: 'Declined'
};

function renderDeals() {
  document.getElementById('dealTableBody').innerHTML = deals.map(d => {
    const lead = leads.find(l => l.id === d.leadId);
    const car = cars.find(c => c.id === d.carId);
    const customerName = lead ? lead.name : 'Unknown';
    const vehicleLabel = car ? `${car.year} ${car.make} ${car.model}` : 'Unknown';
    const date = new Date(d.dateCreated).toLocaleDateString();
    const creditStatus = d.creditApp ? d.creditApp.status : 'not_submitted';
    return `
      <tr>
        <td><button class="deal-number-link" onclick="openDealWorkspace('${d.id}')">D-${d.dealNumber}</button></td>
        <td>${customerName}</td>
        <td>${vehicleLabel}</td>
        <td><span class="badge ${d.status}">${DEAL_STATUS_LABELS[d.status] || d.status}</span></td>
        <td>$${d.monthlyPayment.toLocaleString()}/mo</td>
        <td><span class="badge ${creditStatus}">${CREDIT_STATUS_LABELS[creditStatus]}</span></td>
        <td>${date}</td>
        <td class="row-actions">
          <button class="delete" onclick="deleteDeal('${d.id}')">Delete</button>
        </td>
      </tr>
    `;
  }).join('');
}

// ---------- New Deal (quick create -> generates Deal #) ----------

const newDealModal = document.getElementById('newDealModal');

document.getElementById('addDealBtn').addEventListener('click', () => {
  if (leads.length === 0) {
    alert('Add a lead first so you have a customer to attach this deal to.');
    return;
  }
  if (cars.filter(c => c.status !== 'sold').length === 0) {
    alert('Add a car to inventory first.');
    return;
  }
  document.getElementById('newDealForm').reset();

  const leadSelect = document.getElementById('newDealLeadId');
  leadSelect.innerHTML = leads.map(l => `<option value="${l.id}">${l.name}</option>`).join('');

  const carSelect = document.getElementById('newDealCarId');
  carSelect.innerHTML = cars
    .filter(c => c.status !== 'sold')
    .map(c => `<option value="${c.id}">${c.year} ${c.make} ${c.model} - $${c.price.toLocaleString()}</option>`)
    .join('');

  newDealModal.classList.add('active');
});

document.getElementById('cancelNewDealBtn').addEventListener('click', () => {
  newDealModal.classList.remove('active');
});

document.getElementById('newDealForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    leadId: document.getElementById('newDealLeadId').value,
    carId: document.getElementById('newDealCarId').value,
  };

  const res = await fetch(`${API}/deals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const newDeal = await res.json();

  newDealModal.classList.remove('active');
  await loadAll();

  // Jump straight into the desking tool for the deal that was just created
  openDealWorkspace(newDeal.id);
});

window.deleteDeal = async function(id) {
  if (!confirm('Delete this deal?')) return;
  await fetch(`${API}/deals/${id}`, { method: 'DELETE' });
  await loadAll();
};

// ---------- Deal Workspace (Desking + Credit Application) ----------

const dealWorkspaceModal = document.getElementById('dealWorkspaceModal');
let currentWorkspaceDealId = null;

window.openDealWorkspace = function(dealId) {
  const deal = deals.find(d => d.id === dealId);
  if (!deal) return;
  currentWorkspaceDealId = dealId;

  document.getElementById('workspaceTitle').textContent = `Deal #D-${deal.dealNumber}`;
  document.getElementById('dealStatusSelect').value = deal.status;
  document.getElementById('workingDealId').value = deal.id;

  // Fill desking fields
  document.getElementById('dealVehiclePrice').value = deal.vehiclePrice;
  document.getElementById('dealRebate').value = deal.rebate;
  document.getElementById('dealTradeInValue').value = deal.tradeInValue;
  document.getElementById('dealTradeInPayoff').value = deal.tradeInPayoff;
  document.getElementById('dealDownPayment').value = deal.downPayment;
  document.getElementById('dealTaxRate').value = deal.taxRate;
  document.getElementById('dealDocFee').value = deal.docFee;
  document.getElementById('dealTitleFee').value = deal.titleFee;
  document.getElementById('dealRegistrationFee').value = deal.registrationFee;
  document.getElementById('dealApr').value = deal.apr;
  document.getElementById('dealTermMonths').value = deal.termMonths;

  const hasTradeCheckbox = document.getElementById('hasTradeCheckbox');
  hasTradeCheckbox.checked = !!deal.hasTrade;
  document.getElementById('tradeFields').style.display = deal.hasTrade ? 'grid' : 'none';

  // Build the credit application form fresh each time, since its shape
  // (business vs individual, with or without a co-applicant) changes
  // per deal.
  renderCreditAppFields(deal.creditApp);

  // Always open back on the Desking sub-tab
  switchSubTab('desking');

  dealWorkspaceModal.classList.add('active');
};

document.getElementById('closeWorkspaceBtn').addEventListener('click', () => {
  dealWorkspaceModal.classList.remove('active');
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

// Deal status dropdown (in the workspace header) saves immediately on change
document.getElementById('dealStatusSelect').addEventListener('change', async (e) => {
  await fetch(`${API}/deals/${currentWorkspaceDealId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: e.target.value })
  });
  await loadAll();
});

// Desking form: save & recalculate
document.getElementById('deskingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    vehiclePrice: document.getElementById('dealVehiclePrice').value,
    rebate: document.getElementById('dealRebate').value,
    hasTrade: document.getElementById('hasTradeCheckbox').checked,
    tradeInValue: document.getElementById('dealTradeInValue').value,
    tradeInPayoff: document.getElementById('dealTradeInPayoff').value,
    downPayment: document.getElementById('dealDownPayment').value,
    taxRate: document.getElementById('dealTaxRate').value,
    docFee: document.getElementById('dealDocFee').value,
    titleFee: document.getElementById('dealTitleFee').value,
    registrationFee: document.getElementById('dealRegistrationFee').value,
    apr: document.getElementById('dealApr').value,
    termMonths: document.getElementById('dealTermMonths').value,
  };

  await fetch(`${API}/deals/${currentWorkspaceDealId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  await loadAll();
  dealWorkspaceModal.classList.remove('active');
});

document.getElementById('viewProposalFromWorkspaceBtn').addEventListener('click', () => {
  dealWorkspaceModal.classList.remove('active');
  viewProposal(currentWorkspaceDealId);
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
        <label>Zip <input type="text" id="${prefix}Zip" /></label>
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
document.getElementById('creditAppForm').addEventListener('submit', async (e) => {
  e.preventDefault();

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

  await loadAll();
  dealWorkspaceModal.classList.remove('active');
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

  document.getElementById('proposalContent').innerHTML = `
    <h2>Deal Proposal</h2>
    <div class="proposal-meta">
      <span><strong>Customer:</strong> ${customerName}</span>
      <span><strong>Vehicle:</strong> ${vehicleLabel}</span>
      <span><strong>Date:</strong> ${date}</span>
    </div>

    <table>
      <tr><td>Vehicle Price</td><td>$${deal.vehiclePrice.toLocaleString()}</td></tr>
      <tr><td>Trade-In Value</td><td>-$${deal.tradeInValue.toLocaleString()}</td></tr>
      <tr><td>Trade-In Payoff Owed</td><td>+$${deal.tradeInPayoff.toLocaleString()}</td></tr>
      <tr><td>Rebate / Discount</td><td>-$${deal.rebate.toLocaleString()}</td></tr>
      <tr><td>Down Payment</td><td>-$${deal.downPayment.toLocaleString()}</td></tr>
      <tr><td>Sales Tax (${deal.taxRate}%)</td><td>+$${deal.salesTax.toLocaleString()}</td></tr>
      <tr><td>Fees (doc, title, registration)</td><td>+$${deal.totalFees.toLocaleString()}</td></tr>
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

  proposalModal.classList.add('active');
};

document.getElementById('closeProposalBtn').addEventListener('click', () => {
  proposalModal.classList.remove('active');
});

document.getElementById('printProposalBtn').addEventListener('click', () => {
  window.print();
});

// ---------- Init ----------

loadAll();
