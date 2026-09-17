// app.js
// All frontend logic: tab switching, fetching data from the API,
// rendering tables, and handling the add/edit modals.
// Plain JS + fetch on purpose -- no framework needed for a project this size.

const API = '/api';
let cars = [];
let appSettings = {};
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

// Clicking the "Dealership CRM" title in the top left jumps back to the
// CRM module's Dashboard, keeping the sidebar and visible tabs in sync.
document.getElementById('brandHomeBtn').addEventListener('click', () => {
  setActiveModule('crm');
});

// ---------- Module sidebar (CRM / Sales & F&I / Vehicle Management / Service) ----------
//
// The left sidebar groups the app's tabs into DMS-style modules. Switching
// modules just filters which top-nav tab buttons are visible and jumps to
// the first one in that module -- the underlying tab-panel mechanism above
// is unchanged, so nothing about how pages render had to change.

function setActiveModule(moduleKey) {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.module === moduleKey);
  });

  const tabsInModule = document.querySelectorAll(`.tab-btn[data-module="${moduleKey}"]`);
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.style.display = btn.dataset.module === moduleKey ? 'inline-block' : 'none';
  });

  if (tabsInModule.length > 0) {
    tabsInModule[0].click();
  }
}

document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => setActiveModule(item.dataset.module));
});

// Start on the CRM module's Dashboard, matching the sidebar's default active state.
setActiveModule('crm');

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
  renderLeadsKanban();
  renderDeals();
  populateLeadCarOptions();
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
  document.getElementById('statsGrid').innerHTML = cards.map(c => `
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
      (c.vin || '').toLowerCase().includes(search) ||
      (c.stockNumber || '').toLowerCase().includes(search);
    const matchesStatus = !statusFilter || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  document.getElementById('carTableBody').innerHTML = filtered.map(c => {
    const daysListed = Math.round((new Date() - new Date(c.dateAdded)) / (1000 * 60 * 60 * 24));
    const thumb = (c.photos && c.photos[0])
      ? `<img class="inventory-thumb" src="${c.photos[0]}" alt="${c.make} ${c.model}" />`
      : `<div class="inventory-thumb-placeholder">🚗</div>`;
    return `
      <tr>
        <td>${thumb}</td>
        <td>${c.make}</td>
        <td>${c.model}</td>
        <td>${c.year}</td>
        <td>${c.stockNumber || '-'}</td>
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
    const followUpFlag = needsFollowUp(l) ? `<span class="followup-badge">Needs Follow-Up</span>` : '';
    return `
      <tr>
        <td><button class="deal-number-link" onclick="openLeadProfile('${l.id}')">${l.name}</button></td>
        <td><span class="badge ${l.type === 'business' ? 'finalized' : 'working'}">${l.type === 'business' ? 'Business' : 'Individual'}</span></td>
        <td>${l.phone || l.email || '-'}</td>
        <td>${formatSource(l.source)}</td>
        <td>${carLabel}</td>
        <td><span class="badge ${l.status}">${l.status}</span>${followUpFlag}</td>
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
    const stageLeads = leads.filter(l => l.status === stage.key);
    return `
      <div class="kanban-column" data-status="${stage.key}">
        <div class="kanban-column-header"><span>${stage.label}</span><span>${stageLeads.length}</span></div>
        <div class="kanban-column-body">
          ${stageLeads.map(l => {
            const car = cars.find(c => c.id === l.carId);
            const followUpFlag = needsFollowUp(l) ? `<span class="followup-badge">Follow-up</span>` : '';
            return `
              <div class="kanban-card" draggable="true" data-lead-id="${l.id}">
                <button class="kanban-card-name" onclick="openLeadProfile('${l.id}')">${l.name}</button>
                <div class="kanban-card-meta">${car ? `${car.year} ${car.make} ${car.model}` : 'No vehicle linked'}</div>
                <div class="kanban-card-meta">${formatSource(l.source)}${followUpFlag}</div>
              </div>
            `;
          }).join('')}
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
  document.getElementById('carPhotosSection').style.display = 'none';
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
  document.getElementById('carStockNumber').value = car.stockNumber || '';
  document.getElementById('carMileage').value = car.mileage;
  document.getElementById('carCost').value = car.cost;
  document.getElementById('carPrice').value = car.price;
  document.getElementById('carStatus').value = car.status;

  // Photos can only be attached to a car that already exists (it needs
  // an id to upload against), so this section is Edit-only.
  document.getElementById('carPhotosSection').style.display = 'block';
  document.getElementById('carPhotoInput').value = '';
  document.getElementById('carPhotoUploadStatus').innerHTML = '';
  renderCarPhotoGrid(car);

  carModal.classList.add('active');
};

function renderCarPhotoGrid(car) {
  const grid = document.getElementById('carPhotoGrid');
  const photos = car.photos || [];
  if (photos.length === 0) {
    grid.innerHTML = `<p style="font-size:13px;color:var(--text-muted);">No photos yet.</p>`;
    return;
  }
  grid.innerHTML = photos.map(p => `
    <div class="photo-thumb">
      <img src="${p}" alt="Car photo" />
      <button type="button" class="photo-delete-btn" onclick="deleteCarPhoto('${car.id}','${p}')">×</button>
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
      statusEl.innerHTML = `<div class="send-text-status-error">${data.error}</div>`;
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

  container.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">Attach a photo of the ${car.year} ${car.make} ${car.model} (optional):</div>
    <div class="photo-picker-grid">
      ${car.photos.map(p => `<img src="${p}" class="photo-picker-thumb" data-photo="${p}" onclick="toggleSendTextPhoto(this)" />`).join('')}
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
    leads.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  leadSelect.value = deal.leadId || '';

  const carSelect = document.getElementById('dealAssignedCarId');
  carSelect.innerHTML = '<option value="">-- No vehicle assigned yet --</option>' +
    cars.filter(c => c.status !== 'sold' || c.id === deal.carId)
      .map(c => `<option value="${c.id}" data-price="${c.price}">${c.year} ${c.make} ${c.model} - $${c.price.toLocaleString()}</option>`)
      .join('');
  carSelect.value = deal.carId || '';
  updateServiceTieIn(deal.carId);

  // Shared fields
  document.getElementById('dealVehiclePrice').value = deal.vehiclePrice;
  document.getElementById('dealRebate').value = deal.rebate;
  document.getElementById('dealTradeInValue').value = deal.tradeInValue;
  document.getElementById('dealTradeInPayoff').value = deal.tradeInPayoff;
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
  document.querySelector('.main-sidebar').style.display = 'none';
  document.querySelector('.topbar').style.display = 'none';
  document.querySelector('main').style.display = 'none';
  document.body.style.marginLeft = '0';
  dealFullPage.classList.add('active');
};

function closeDealFullPage() {
  dealFullPage.classList.remove('active');
  document.querySelector('.main-sidebar').style.display = 'flex';
  document.querySelector('.topbar').style.display = 'flex';
  document.querySelector('main').style.display = 'block';
  document.body.style.marginLeft = '';
}

document.getElementById('backToDealsBtn').addEventListener('click', async () => {
  closeDealFullPage();
  await loadAll();
  setActiveModule('sales-fi');
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
  const state = document.getElementById('dealState').value;
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
  const zip = zipField ? zipField.value : '';
  const county = countyField ? countyField.value : '';

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
      body: JSON.stringify({ state, zip, price, vehicleYear, county })
    });
    const result = await res.json();

    if (!res.ok) {
      statusEl.innerHTML = `<div class="send-text-status-error">${result.error}</div>`;
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
    statusEl.innerHTML = `<div class="send-text-status-success">✓ Calculated for ${result.stateUsed}, ${countyNote} (${tradeNote}). Estimate only -- verify against your state's current DMV schedule.</div>`;
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
        <label>State <input type="text" maxlength="2" id="${prefix}State" placeholder="CA" /></label>
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

  const fiRows = `
      <tr><td>Doc Fee</td><td>+$${(deal.docFee || 0).toLocaleString()}</td></tr>
      ${deal.licenseFee ? `<tr><td>License Fee</td><td>+$${deal.licenseFee.toLocaleString()}</td></tr>` : ''}
      ${deal.dealerFees ? `<tr><td>Dealer Fees</td><td>+$${deal.dealerFees.toLocaleString()}</td></tr>` : ''}
      ${deal.gapPremium ? `<tr><td>GAP Premium</td><td>+$${deal.gapPremium.toLocaleString()}</td></tr>` : ''}
      ${deal.servicePremium ? `<tr><td>Service Contract</td><td>+$${deal.servicePremium.toLocaleString()}</td></tr>` : ''}
      ${deal.maintenancePremium ? `<tr><td>Maintenance Plan</td><td>+$${deal.maintenancePremium.toLocaleString()}</td></tr>` : ''}
      ${deal.aftermarketAmount ? `<tr><td>Aftermarket / Accessories</td><td>+$${deal.aftermarketAmount.toLocaleString()}</td></tr>` : ''}
  `;

  const bodyHtml = isLease ? `
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
      ${deal.cashBack ? `<tr><td>Cash Back to Customer</td><td>+$${deal.cashBack.toLocaleString()}</td></tr>` : ''}
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
  ` : `
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

  document.getElementById('proposalContent').innerHTML = `
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
      box.innerHTML = `<div class="ai-suggestion-box">Couldn't generate a suggestion: ${data.error}</div>`;
      return;
    }

    box.innerHTML = `
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
      statusEl.innerHTML = `<div class="send-text-status-error">Couldn't send: ${data.error}</div>`;
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
      box.innerHTML = `<div class="ai-snapshot-box">Couldn't generate a snapshot: ${data.error}</div>`;
      return;
    }

    box.innerHTML = `<div class="ai-snapshot-box"><strong>🔍 Snapshot</strong><p>${data.snapshot}</p></div>`;
  } catch (err) {
    box.innerHTML = `<div class="ai-snapshot-box">Could not reach the AI assistant. Is the server running?</div>`;
  }
});

// ---------- Fee Defaults (Settings) ----------

const feeDefaultsModal = document.getElementById('feeDefaultsModal');

document.getElementById('feeDefaultsBtn').addEventListener('click', async () => {
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

// ---------- Init ----------

loadAll();
