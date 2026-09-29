// dupes-ui.js -- Duplicate Leads (CRM Domus).
//
// The bucket: every lead that looks like a customer already in the CRM, side
// by side with that customer and why they match. Managers merge the two or
// say they're not the same person; they also set the rules. Anyone can mark
// a customer as a duplicate from the customer page. Loaded after app.js.

let dupData = null; // { rules, items: [{ lead, original }] }

async function dupApi(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function openDuplicatesView() {
  document.querySelectorAll('#duplicatesPanel [data-manager-only]').forEach(b => { b.hidden = !userCan('resolveDuplicates'); });
  document.getElementById('dupList').innerHTML = html`<p class="audit-note">Loading…</p>`;
  try { dupData = await dupApi('/duplicates'); renderDuplicates(); } catch (err) { document.getElementById('dupList').innerHTML = html`<p class="audit-note">${err.message}</p>`; }
}

const dupStaffName = id => { const u = staffList.find(s => String(s.id) === String(id)); return u ? u.name : ''; };
const dupWhen = iso => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

// One side of the comparison. Matching details are highlighted.
function dupSide(label, l, reasons) {
  if (!l) return html`<div class="dup-side"><div class="dup-side-label">${label}</div><p class="audit-note">That customer is no longer in the CRM.</p></div>`;
  const hit = r => (reasons.includes(r) ? 'dup-hit' : '');
  const assigned = [dupStaffName(l.sales1Id), dupStaffName(l.bdc1Id)].filter(Boolean).join(' · ');
  const dealCount = deals.filter(d => d.leadId === l.id).length;
  return html`<div class="dup-side">
    <div class="dup-side-label">${label}</div>
    <button type="button" class="dup-name ${hit('Same name')}" onclick="openLeadProfile(${js(l.id)})">${l.name}${l.hot ? ' 🔥' : ''}</button>
    <div class="dup-rows">
      <span>Phone</span><strong class="${hit('Same phone')}">${l.phone || '--'}</strong>
      <span>Email</span><strong class="${hit('Same email')}">${l.email || '--'}</strong>
      <span>Source</span><strong>${formatSource(l.source)}</strong>
      <span>Added</span><strong>${new Date(l.dateAdded).toLocaleDateString()}${l.customerNumber ? ` · C-${l.customerNumber}` : ''}</strong>
      <span>Status</span><strong>${l.status}</strong>
      <span>Assigned</span><strong>${assigned || '--'}</strong>
      <span>History</span><strong>${(l.activities || []).length} entries${dealCount ? ` · ${dealCount} deal${dealCount === 1 ? '' : 's'}` : ''}</strong>
    </div>
  </div>`;
}

function renderDuplicates() {
  const { items, rules } = dupData;
  const manager = userCan('resolveDuplicates');
  const on = [rules.phone && 'phone', rules.email && 'email', rules.name && 'name'].filter(Boolean);
  document.getElementById('dupCount').innerHTML = html`<strong>${items.length}</strong> waiting ·
    <span class="audit-note">${on.length ? `Matching on ${on.join(', ')}${rules.lookbackDays ? ` (customers from the last ${rules.lookbackDays} days)` : ''}` : 'Automatic checks are off'}</span>`;
  document.getElementById('dupList').innerHTML = items.length ? items.map(({ lead, original }) => {
    const d = lead.duplicate;
    const reasons = d.reasons || [];
    return html`<div class="dup-card" data-dup="${lead.id}">
      <div class="dup-card-head">
        ${reasons.length ? reasons.map(r => html`<span class="dup-reason">${r}</span>`) : html`<span class="dup-reason">Marked by hand</span>`}
        <span class="audit-note">${d.status === 'marked' ? 'Marked' : 'Found'} by ${d.by ? d.by.name : 'Automatic'} · ${dupWhen(d.at)}${d.note ? ` · “${d.note}”` : ''}</span>
      </div>
      <div class="dup-pair">
        ${dupSide('New lead', lead, reasons)}
        <div class="dup-arrow" aria-hidden="true">→</div>
        ${dupSide('Already in the CRM', original, reasons)}
      </div>
      <div class="dup-actions">
        ${manager ? html`
          ${original ? html`<button type="button" class="btn-primary btn-small" data-act="merge">Merge into ${original.name}</button>` : ''}
          <button type="button" class="btn-secondary btn-small" data-act="not">Not a duplicate</button>`
        : html`<span class="audit-note">A manager will merge these or send the new lead on.</span>
          ${d.by && currentUser && d.by.id === currentUser.id ? html`<button type="button" class="btn-secondary btn-small" data-act="undo">Undo my mark</button>` : ''}`}
      </div>
    </div>`;
  }).join('') : html`<div class="dup-empty"><strong>No duplicates waiting.</strong><p class="audit-note">New leads that match a customer already in the CRM show up here instead of going to a salesperson.</p></div>`;
}

document.getElementById('dupList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-dup]').dataset.dup;
  const item = dupData.items.find(x => x.lead.id === id);
  try {
    if (btn.dataset.act === 'merge') {
      if (!confirm(`Merge ${item.lead.name} into ${item.original.name}?\n\nIts history, notes, vehicles, deals, tasks, and appraisals move to ${item.original.name}, and the duplicate is removed.`)) return;
      btn.disabled = true;
      await dupApi(`/duplicates/${id}/merge`, 'POST', {});
    } else if (btn.dataset.act === 'not') {
      btn.disabled = true;
      await dupApi(`/duplicates/${id}/not-duplicate`, 'POST', {});
    } else if (btn.dataset.act === 'undo') {
      btn.disabled = true;
      await dupApi(`/leads/${id}/duplicate`, 'DELETE');
    }
    await loadAll();
    await openDuplicatesView();
  } catch (err) { alert(err.message); btn.disabled = false; }
});

// ----- Rules (managers) -----

document.getElementById('dupRulesBtn').addEventListener('click', () => {
  const form = document.getElementById('dupRulesForm');
  const r = dupData ? dupData.rules : {};
  for (const k of ['phone', 'email', 'name', 'holdFromRoundRobin']) form.elements[k].checked = !!r[k];
  form.elements.lookbackDays.value = r.lookbackDays || 0;
  form.hidden = !form.hidden;
});
document.getElementById('dupRulesCancel').addEventListener('click', () => { document.getElementById('dupRulesForm').hidden = true; });
document.getElementById('dupRulesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    dupData.rules = await dupApi('/duplicates/rules', 'PUT', {
      phone: f.phone.checked, email: f.email.checked, name: f.name.checked,
      lookbackDays: Number(f.lookbackDays.value) || 0, holdFromRoundRobin: f.holdFromRoundRobin.checked
    });
    e.target.hidden = true;
    renderDuplicates();
  } catch (err) { alert(err.message); }
});

document.getElementById('dupScanBtn').addEventListener('click', async (e) => {
  if (!confirm('Check every customer in the CRM against these rules? The newer of each matching pair goes to Duplicate Leads.')) return;
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await dupApi('/duplicates/scan', 'POST', {});
    await loadAll();
    await openDuplicatesView();
    alert(r.found ? `Found ${r.found} possible duplicate${r.found === 1 ? '' : 's'}.` : 'No duplicates found.');
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = 'Check all customers';
});

// ----- Mark as duplicate (anyone, from the customer page) -----

const dupMarkModal = document.getElementById('dupMarkModal');
let dupMarkOfId = '';
const dupMarkPicker = createSearchPicker({
  kind: 'lead',
  getIds: () => leads.filter(l => l.id !== currentProfileLeadId && !inDupBucket(l)).map(l => l.id),
  placeholder: 'Find the existing customer: name, phone, email, or C-#...',
  onPick: (id) => {
    dupMarkOfId = id;
    const l = leads.find(x => x.id === id);
    dupMarkPicker.setLabel(l ? l.name : '');
    document.getElementById('dupMarkPicked').innerHTML = l ? html`<strong>${l.name}</strong> · ${[l.phone, l.email, l.customerNumber ? `C-${l.customerNumber}` : '', `added ${new Date(l.dateAdded).toLocaleDateString()}`].filter(Boolean).join(' · ')}` : '';
    document.getElementById('dupMarkSave').disabled = !l;
  }
});
document.getElementById('dupMarkPicker').appendChild(dupMarkPicker.element);

document.getElementById('cpDupBtn').addEventListener('click', async () => {
  const lead = cpLead();
  if (!lead) return;
  if (inDupBucket(lead)) {
    try {
      if (userCan('resolveDuplicates')) await dupApi(`/duplicates/${lead.id}/not-duplicate`, 'POST', {});
      else await dupApi(`/leads/${lead.id}/duplicate`, 'DELETE');
      await cpRefresh();
    } catch (err) { alert(err.message); }
    return;
  }
  dupMarkOfId = '';
  dupMarkPicker.setLabel('');
  document.getElementById('dupMarkPicked').innerHTML = '';
  document.getElementById('dupMarkNote').value = '';
  document.getElementById('dupMarkMsg').textContent = '';
  document.getElementById('dupMarkSave').disabled = true;
  dupMarkModal.classList.add('active');
  dupMarkPicker.input.focus();
});
document.getElementById('dupMarkCancel').addEventListener('click', () => dupMarkModal.classList.remove('active'));
document.getElementById('dupMarkSave').addEventListener('click', async (e) => {
  const lead = cpLead();
  if (!lead || !dupMarkOfId) return;
  e.currentTarget.disabled = true;
  try {
    await dupApi(`/leads/${lead.id}/duplicate`, 'POST', { ofId: dupMarkOfId, note: document.getElementById('dupMarkNote').value });
    dupMarkModal.classList.remove('active');
    await cpRefresh();
  } catch (err) {
    document.getElementById('dupMarkMsg').textContent = err.message;
    e.currentTarget.disabled = false;
  }
});
