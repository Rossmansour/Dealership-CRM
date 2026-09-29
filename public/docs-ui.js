// docs-ui.js
// The Deal Jacket tab on a deal: print the store's forms filled from the
// deal (buyer's order, we-owe, recap), scan or upload documents, add blank
// forms from the form library, and keep track of what's signed. Documents
// marked "wet signature only" (REG 262 by default) are printed for ink.
// Loaded after app.js and uses its helpers and data (deals, leads, cars).

let jacket = null;     // { documents, settings, storeName }
let formLibrary = null; // { forms, settings, canManage }

async function jkApi(path, opts = {}) {
  const res = await fetch(`${API}${path}`, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const jkJson = (path, method, body) => jkApi(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const jkDeal = () => deals.find(d => d.id === currentWorkspaceDealId);
const jkSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function openJacket() {
  const deal = jkDeal();
  if (!deal) return;
  document.getElementById('jkDocs').innerHTML = html`<p class="audit-note">Loading…</p>`;
  document.getElementById('jkRecapBtn').style.display = userCan('editDealAccounting') ? '' : 'none';
  try {
    [jacket, formLibrary] = await Promise.all([jkApi(`/deals/${deal.id}/documents`), jkApi('/forms')]);
    renderJacket();
  } catch (err) { document.getElementById('jkDocs').innerHTML = html`<p class="send-text-status-error">${err.message}</p>`; }
}
document.querySelector('.sub-tab-btn[data-subtab="jacket"]').addEventListener('click', openJacket);

function renderJacket() {
  const deal = jkDeal();
  const docs = jacket.documents;
  document.getElementById('jkCount').textContent = docs.length;
  document.getElementById('jkFormPick').innerHTML = html`<option value="">${formLibrary.forms.length ? 'Pick a form from your library…' : 'No forms in your library yet'}</option>
    ${formLibrary.forms.map(f => html`<option value="${f.id}">${f.name}${f.wetSignature ? ' (wet signature)' : ''}</option>`)}`;
  document.getElementById('jkManageForms').style.display = formLibrary.canManage || formLibrary.forms.length ? '' : 'none';
  renderWeOwe(deal);
  document.getElementById('jkDocs').innerHTML = docs.length ? html`<table class="data-table jk-table">
    <thead><tr><th>Document</th><th>Added</th><th>Signing</th><th>Status</th><th></th></tr></thead><tbody>
    ${docs.map(d => html`<tr>
      <td><a href="${API}/documents/${d.id}/file" target="_blank" rel="noopener"><strong>${d.name}</strong></a>
        <div class="audit-note">${d.source === 'form' ? 'From form library' : 'Uploaded'} · ${d.mime === 'application/pdf' ? 'PDF' : 'Image'} · ${jkSize(d.size)}</div></td>
      <td>${new Date(d.addedAt).toLocaleDateString()}<div class="audit-note">${d.addedBy ? d.addedBy.name : ''}</div></td>
      <td>${d.wetSignature
        ? html`<span class="jk-wet" title="Print and sign in ink">✍ Wet signature only</span>`
        : html`<span class="jk-esign">E-sign OK</span> <button type="button" class="btn-secondary btn-small" disabled title="Coming with DocuSign">Send for signature</button>`}
        <button type="button" class="link-btn" data-jk-wet="${d.id}">${d.wetSignature ? 'Allow e-sign' : 'Make wet only'}</button></td>
      <td><select data-jk-status="${d.id}" aria-label="Signed?"><option value="unsigned" ${d.status === 'unsigned' ? html`selected` : ''}>Not signed</option>
        <option value="signed" ${d.status === 'signed' ? html`selected` : ''}>Signed</option></select>
        ${d.status === 'signed' && d.signedMarkedBy ? html`<div class="audit-note">${d.signedMarkedBy.name} · ${new Date(d.signedAt).toLocaleDateString()}</div>` : ''}</td>
      <td class="jk-row-actions"><a class="btn-secondary btn-small" href="${API}/documents/${d.id}/file" target="_blank" rel="noopener">${d.wetSignature ? 'Print' : 'View'}</a>
        <a class="btn-secondary btn-small" href="${API}/documents/${d.id}/file?download=1">Download</a>
        <button type="button" class="link-btn" data-jk-del="${d.id}">Remove</button></td>
    </tr>`)}</tbody></table>`
    : html`<p class="audit-note">Nothing in the jacket yet. Upload a scan or add a form.</p>`;
}

document.getElementById('jkDocs').addEventListener('change', async (e) => {
  const s = e.target.closest('[data-jk-status]');
  if (!s) return;
  try { await jkJson(`/documents/${s.dataset.jkStatus}`, 'PUT', { status: s.value }); await openJacket(); } catch (err) { alert(err.message); }
});
document.getElementById('jkDocs').addEventListener('click', async (e) => {
  const wet = e.target.closest('[data-jk-wet]');
  const del = e.target.closest('[data-jk-del]');
  try {
    if (wet) {
      const d = jacket.documents.find(x => x.id === wet.dataset.jkWet);
      await jkJson(`/documents/${d.id}`, 'PUT', { wetSignature: !d.wetSignature });
      return openJacket();
    }
    if (del) {
      const d = jacket.documents.find(x => x.id === del.dataset.jkDel);
      if (!confirm(`Remove "${d.name}" from this deal's jacket?`)) return;
      await jkApi(`/documents/${d.id}`, { method: 'DELETE' });
      return openJacket();
    }
  } catch (err) { alert(err.message); }
});

document.getElementById('jkUpload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    await jkApi(`/deals/${currentWorkspaceDealId}/documents`, { method: 'POST', body: new FormData(form) });
    form.reset();
    await openJacket();
  } catch (err) { alert(err.message); }
  btn.disabled = false; btn.textContent = 'Upload';
});
document.getElementById('jkAddForm').addEventListener('click', async () => {
  const formId = document.getElementById('jkFormPick').value;
  if (!formId) return alert('Pick a form first.');
  try { await jkJson(`/deals/${currentWorkspaceDealId}/documents/from-form`, 'POST', { formId }); await openJacket(); } catch (err) { alert(err.message); }
});

// ---------- We owe ----------
function renderWeOwe(deal) {
  const items = deal.weOwe || [];
  document.getElementById('jkWeOwe').innerHTML = items.length ? html`<table class="jk-weowe">
    <thead><tr><th>What we owe</th><th>By</th><th></th></tr></thead><tbody>
    ${items.map((w, i) => html`<tr><td><input type="text" data-wo="${i}" data-k="item" value="${w.item}" maxlength="200" /></td>
      <td><input type="date" data-wo="${i}" data-k="due" value="${w.due || ''}" /></td>
      <td><button type="button" class="link-btn" data-wo-del="${i}">Remove</button></td></tr>`)}</tbody></table>`
    : html`<p class="audit-note">Nothing owed to the customer.</p>`;
}
async function saveWeOwe(items) {
  const deal = jkDeal();
  const saved = await jkJson(`/deals/${deal.id}`, 'PUT', { weOwe: items.map(w => ({ item: String(w.item || '').slice(0, 200), due: w.due || '' })).slice(0, 30) });
  Object.assign(deal, { weOwe: saved.weOwe });
  renderWeOwe(deal);
}
document.getElementById('jkAddWeOwe').addEventListener('click', () => saveWeOwe([...(jkDeal().weOwe || []), { item: '', due: '' }]).catch(err => alert(err.message)));
document.getElementById('jkWeOwe').addEventListener('change', (e) => {
  const i = e.target.dataset.wo;
  if (i === undefined) return;
  const items = (jkDeal().weOwe || []).map(w => ({ ...w }));
  items[i][e.target.dataset.k] = e.target.value;
  saveWeOwe(items).catch(err => alert(err.message));
});
document.getElementById('jkWeOwe').addEventListener('click', (e) => {
  const d = e.target.closest('[data-wo-del]');
  if (!d) return;
  const items = (jkDeal().weOwe || []).filter((_, i) => i !== Number(d.dataset.woDel));
  saveWeOwe(items).catch(err => alert(err.message));
});

// ---------- Printed forms (from the saved deal) ----------
const jkMoney = v => `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function printPage(title, body) {
  const w = window.open('', '_blank');
  if (!w) return alert('Allow pop-ups for this site to print.');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    body { font: 12px/1.45 Arial, Helvetica, sans-serif; color: #111; margin: 28px; }
    h1 { font-size: 18px; margin: 0 0 2px; } .sub { color: #555; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; margin-bottom: 12px; }
    .box { border: 1px solid #999; padding: 8px 10px; } .box h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; color: #333; }
    table { width: 100%; border-collapse: collapse; } td, th { padding: 3px 4px; border-bottom: 1px solid #ddd; text-align: left; } td.r, th.r { text-align: right; }
    tr.total td { font-weight: bold; border-top: 2px solid #111; }
    .sig { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; margin-top: 36px; } .sig div { border-top: 1px solid #111; padding-top: 4px; font-size: 11px; }
    .note { margin-top: 18px; font-size: 10px; color: #666; } @media print { body { margin: 12mm; } }
  </style></head><body>${body}<script>window.onload = () => window.print();<\/script></body></html>`);
  w.document.close();
}

function dealParts(deal) {
  const lead = leads.find(l => l.id === deal.leadId) || {};
  const car = cars.find(c => c.id === deal.carId) || {};
  const a = lead.address || {};
  const addr = typeof a === 'string' ? a : [a.street, a.unit, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ');
  return { lead, car, addr };
}
function header(title, deal) {
  return html`<h1>${title}</h1><div class="sub">${jacket ? jacket.storeName : ''} · Deal D-${deal.dealNumber} · ${new Date().toLocaleDateString()}</div>`;
}

function buyersOrder(deal) {
  const { lead, car, addr } = dealParts(deal);
  const lease = deal.dealType === 'lease';
  const row = (label, v, sign = '') => (Number(v) ? html`<tr><td>${label}</td><td class="r">${sign}${jkMoney(v)}</td></tr>` : '');
  return html`${header("Buyer's Order", deal)}
    <div class="grid">
      <div class="box"><h2>Buyer</h2>${lead.name || '—'}<br />${addr || ''}<br />${lead.phone || ''} ${lead.email ? `· ${lead.email}` : ''}</div>
      <div class="box"><h2>Vehicle</h2>${[car.year, car.make, car.model, car.trim].filter(Boolean).join(' ') || '—'}<br />
        VIN ${car.vin || '—'} · Stock ${car.stockNumber || '—'}<br />${car.stockType === 'new' ? 'New' : 'Used'} · ${Number(car.mileage || 0).toLocaleString()} miles</div>
      ${deal.hasTrade ? html`<div class="box"><h2>Trade-in</h2>${[deal.tradeYear, deal.tradeMake, deal.tradeModel].filter(Boolean).join(' ')}<br />
        VIN ${deal.tradeVin || '—'} · ${Number(deal.tradeMileage || 0).toLocaleString()} miles<br />Allowance ${jkMoney(deal.tradeInValue)} · Payoff ${jkMoney(deal.tradeInPayoff)}</div>` : ''}
    </div>
    <div class="box"><h2>Price</h2><table>
      <tr><td>Vehicle price</td><td class="r">${jkMoney(deal.vehiclePrice)}</td></tr>
      ${row('Rebate / discount', deal.rebate, '−')}${row('Doc fee', deal.docFee)}${row('Dealer fees', deal.dealerFees)}
      ${row('GAP', deal.gapPremium)}${row('Service contract', deal.servicePremium)}${row('Maintenance plan', deal.maintenancePremium)}${row('Accessories', deal.aftermarketAmount)}
      ${row('Title fee', deal.titleFee)}${row('Registration fee', deal.registrationFee)}${row('License fee', deal.licenseFee)}
      ${row(`Sales tax (${deal.taxRate || 0}%)`, deal.salesTax)}
      ${deal.hasTrade ? row('Trade allowance', deal.tradeInValue, '−') : ''}${deal.hasTrade ? row('Trade payoff', deal.tradeInPayoff, '+') : ''}
      ${row('Down payment', deal.downPayment, '−')}
      <tr class="total"><td>${deal.dealType === 'cash' ? 'Balance due' : lease ? 'Due at signing' : 'Amount financed'}</td>
        <td class="r">${jkMoney(lease ? deal.dueAtSigning : deal.amountFinanced)}</td></tr>
    </table>
    ${deal.dealType === 'cash' ? '' : html`<p>${jkMoney(deal.monthlyPayment)} per month for ${deal.termMonths} months${lease ? '' : ` at ${deal.apr}% APR`}, subject to credit approval.</p>`}</div>
    <div class="sig"><div>Buyer</div><div>Co-buyer</div><div>Dealer</div></div>
    <p class="note">Sample buyer's order generated by DealerDomus. Have your attorney approve the wording for your state before using it on real deals.</p>`;
}

function weOweSheet(deal) {
  const { lead, car } = dealParts(deal);
  const items = (deal.weOwe || []).filter(w => w.item);
  return html`${header('We Owe', deal)}
    <div class="grid"><div class="box"><h2>Customer</h2>${lead.name || '—'}</div>
      <div class="box"><h2>Vehicle</h2>${[car.year, car.make, car.model].filter(Boolean).join(' ') || '—'} · Stock ${car.stockNumber || '—'}</div></div>
    <div class="box"><h2>The dealership owes the customer</h2><table><thead><tr><th>Item</th><th>By</th></tr></thead><tbody>
      ${items.length ? items.map(w => html`<tr><td>${w.item}</td><td>${w.due ? new Date(`${w.due}T12:00:00`).toLocaleDateString() : ''}</td></tr>`) : html`<tr><td colspan="2">Nothing owed.</td></tr>`}
    </tbody></table></div>
    <div class="sig"><div>Customer</div><div>Sales manager</div><div>Date</div></div>`;
}

async function recapSheet(deal) {
  const r = await jkApi(`/deals/${deal.id}/recap`);
  const { lead, car } = dealParts(deal);
  return html`${header('Deal Recap', deal)}
    <div class="grid"><div class="box"><h2>Customer</h2>${lead.name || '—'}</div>
      <div class="box"><h2>Vehicle</h2>${[car.year, car.make, car.model].filter(Boolean).join(' ') || '—'} · Stock ${car.stockNumber || '—'} · ${r.type === 'new' ? 'New' : 'Used'}</div></div>
    <div class="box"><h2>Gross</h2><table>
      <tr><td>Vehicle price</td><td class="r">${jkMoney(deal.vehiclePrice)}</td></tr>
      <tr><td>Car cost</td><td class="r">−${jkMoney(r.carCost)}</td></tr>
      ${r.pack ? html`<tr><td>Pack</td><td class="r">−${jkMoney(r.pack)}</td></tr>` : ''}
      <tr><td>Doc fee</td><td class="r">${jkMoney(deal.docFee)}</td></tr>
      ${r.overAllowance ? html`<tr><td>Trade over-allowance</td><td class="r">−${jkMoney(r.overAllowance)}</td></tr>` : ''}
      <tr class="total"><td>Front gross</td><td class="r">${jkMoney(r.front)}</td></tr>
      <tr><td>F&amp;I products, less cost, plus reserve</td><td class="r">${jkMoney(r.finance)}</td></tr>
      ${r.incentives ? html`<tr><td>Incentives</td><td class="r">${jkMoney(r.incentives)}</td></tr>` : ''}
      <tr class="total"><td>Total gross</td><td class="r">${jkMoney(r.total)}</td></tr>
    </table></div>`;
}

document.querySelector('#jacket').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-jk-print]');
  if (!b) return;
  const deal = jkDeal();
  try {
    const kind = b.dataset.jkPrint;
    if (kind === 'buyers-order') printPage("Buyer's Order", buyersOrder(deal));
    if (kind === 'we-owe') printPage('We Owe', weOweSheet(deal));
    if (kind === 'recap') printPage('Deal Recap', await recapSheet(deal));
  } catch (err) { alert(err.message); }
});

// ---------- Form library ----------
async function openFormLibrary() {
  formLibrary = await jkApi('/forms');
  const f = formLibrary;
  document.getElementById('jkFormUpload').style.display = f.canManage ? '' : 'none';
  document.getElementById('jkWetBox').style.display = f.canManage ? '' : 'none';
  document.getElementById('jkWetList').value = f.settings.wetSignature.join('\n');
  document.getElementById('jkFormsMsg').textContent = '';
  document.getElementById('jkFormList').innerHTML = f.forms.length ? html`<table class="data-table"><thead><tr><th>Form</th><th>Signing</th><th></th></tr></thead><tbody>
    ${f.forms.map(x => html`<tr><td><a href="${API}/forms/${x.id}/file" target="_blank" rel="noopener">${x.name}</a></td>
      <td>${f.canManage ? html`<label class="pr-toggle"><input type="checkbox" data-fl-wet="${x.id}" ${x.wetSignature ? html`checked` : ''} /><span>Wet signature only</span></label>`
        : x.wetSignature ? 'Wet signature only' : 'E-sign OK'}</td>
      <td>${f.canManage ? html`<button type="button" class="link-btn" data-fl-del="${x.id}">Remove</button>` : ''}</td></tr>`)}</tbody></table>`
    : html`<p class="audit-note">No forms yet.</p>`;
  document.getElementById('jkFormsModal').classList.add('active');
}
document.getElementById('jkManageForms').addEventListener('click', () => openFormLibrary().catch(err => alert(err.message)));
document.getElementById('jkFormsClose').addEventListener('click', () => { document.getElementById('jkFormsModal').classList.remove('active'); if (jacket) openJacket(); });
document.getElementById('jkFormUpload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  // Left unticked, the store's wet-signature list decides (REG 262 and so on).
  try { await jkApi('/forms', { method: 'POST', body: fd }); e.target.reset(); await openFormLibrary(); } catch (err) { document.getElementById('jkFormsMsg').textContent = err.message; }
});
document.getElementById('jkFormList').addEventListener('change', async (e) => {
  const c = e.target.closest('[data-fl-wet]');
  if (c) try { await jkJson(`/forms/${c.dataset.flWet}`, 'PUT', { wetSignature: c.checked }); } catch (err) { alert(err.message); }
});
document.getElementById('jkFormList').addEventListener('click', async (e) => {
  const d = e.target.closest('[data-fl-del]');
  if (!d || !confirm('Remove this form from the library? Deals that already have it keep their copy.')) return;
  try { await jkApi(`/forms/${d.dataset.flDel}`, { method: 'DELETE' }); await openFormLibrary(); } catch (err) { alert(err.message); }
});
document.getElementById('jkWetSave').addEventListener('click', async () => {
  const list = document.getElementById('jkWetList').value.split('\n').map(s => s.trim()).filter(Boolean);
  try { await jkJson('/forms-settings', 'PUT', { wetSignature: list }); document.getElementById('jkFormsMsg').textContent = 'Saved. New documents follow the list.'; } catch (err) { document.getElementById('jkFormsMsg').textContent = err.message; }
});
