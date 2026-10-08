// inspection.js -- Digital vehicle inspections with customer approvals.
//
// On a repair order the technician goes down a checklist (tires, brakes,
// fluids...) and marks each item Good, Soon, or Now, with a note and photos
// or videos. The advisor puts a price on the Soon and Now items (labor
// hours at the customer labor rate, plus parts) and sends the customer a
// link. On that page -- no sign-in, the link is the key -- the customer sees
// what was found, with the pictures, and approves or declines each item.
// Approved items become jobs on the RO; the advisor gets an alert either way,
// and declined items stay on the RO for a follow-up later.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const alerts = require('./alerts');
const photos = require('./photos');
const { serviceSettings, OPEN_STATUSES } = require('./service');

const allow = auth.requirePermission;
const STATUSES = ['', 'ok', 'soon', 'now']; // '' = not checked yet
const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);

const DEFAULT_TEMPLATE = [
  ['Tires & wheels', ['Left front tire', 'Right front tire', 'Left rear tire', 'Right rear tire', 'Tire pressure', 'Spare tire']],
  ['Brakes', ['Front brake pads', 'Rear brake pads', 'Rotors', 'Brake lines & hoses']],
  ['Fluids', ['Engine oil', 'Coolant', 'Brake fluid', 'Transmission fluid', 'Power steering fluid', 'Washer fluid']],
  ['Under the hood', ['Battery', 'Belts', 'Hoses', 'Engine air filter', 'Cabin air filter']],
  ['Lights & wipers', ['Headlights', 'Brake lights', 'Turn signals', 'Wiper blades']],
  ['Under the vehicle', ['Suspension', 'Steering', 'Exhaust', 'Leaks', 'CV axles & boots']]
];

function freshInspection(who) {
  return {
    startedAt: new Date().toISOString(), startedBy: who,
    items: DEFAULT_TEMPLATE.flatMap(([section, names]) => names.map(name => blankItem(section, name))),
    token: null, sentAt: null, sentBy: null, viewedAt: null, decidedAt: null
  };
}
function blankItem(section, name) {
  return { id: crypto.randomUUID(), section, name, status: '', note: '', media: [], hours: 0, parts: 0, decision: null, decidedAt: null, jobId: null };
}

// What an item costs the customer (before tax).
const itemPrice = (item, rate) => round2(n(item.hours) * n(rate) + n(item.parts));
const needsWork = item => item.status === 'soon' || item.status === 'now';

const canInspect = user => auth.can(user, 'writeRepairOrders') || user.role === 'technician';

async function loadRo(q, req, { forUpdate = false } = {}) {
  const ro = await store.get(q, 'repair_orders', req.dealershipId, req.params.id, { forUpdate });
  if (!ro) return { status: 404, error: 'Repair order not found.' };
  if (!OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This RO is closed.' };
  return { ro };
}

// ---------- Signed-in routes (Service) ----------

// deps: { mediaUpload, sendSms(to, body) -> Promise<bool>, publicBase(req), present(ro, req) }
function router(deps) {
  const r = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const inspector = (req, res, next) => (canInspect(req.user) ? next() : res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." }));
  const viewService = auth.requirePermission('viewService');

  // Runs fn(ro) on the locked RO, saves it, and answers with the RO.
  async function change(req, res, fn, auditNote) {
    const result = await store.tx(async q => {
      const loaded = await loadRo(q, req, { forUpdate: true });
      if (loaded.error) return loaded;
      const ro = loaded.ro;
      const problem = await fn(ro, q);
      if (problem) return { status: 400, error: problem };
      const saved = await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
      if (auditNote) await audit.record(q, req, { action: 'inspection', entityType: 'repair_order', entityId: ro.id, label: `RO-${ro.roNumber}`, details: typeof auditNote === 'function' ? auditNote(ro) : auditNote });
      return { ro: saved };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(await deps.present(result.ro, req));
  }

  r.post('/service/ros/:id/inspection', viewService, inspector, wrap((req, res) => change(req, res, ro => {
    if (ro.inspection) return 'This RO already has an inspection.';
    ro.inspection = freshInspection({ id: req.user.id, name: req.user.name });
  }, 'Inspection started')));

  // A line the checklist doesn't have ("Windshield chip").
  r.post('/service/ros/:id/inspection/items', viewService, inspector, wrap((req, res) => change(req, res, ro => {
    if (!ro.inspection) return 'Start the inspection first.';
    const name = text((req.body || {}).name, 80);
    if (!name) return 'Name the item.';
    ro.inspection.items.push(blankItem(text((req.body || {}).section, 60) || 'Other', name));
  })));

  r.put('/service/ros/:id/inspection/items/:itemId', viewService, inspector, wrap((req, res) => change(req, res, ro => {
    const item = ro.inspection && ro.inspection.items.find(i => i.id === req.params.itemId);
    if (!item) return 'Inspection item not found.';
    if (item.decision) return 'The customer already answered this item.';
    const b = req.body || {};
    if ('status' in b && STATUSES.includes(b.status)) item.status = b.status;
    if ('note' in b) item.note = text(b.note, 1000);
    // Prices are the advisor's call.
    if (auth.can(req.user, 'writeRepairOrders')) {
      if ('hours' in b) item.hours = Math.max(0, round2(b.hours));
      if ('parts' in b) item.parts = Math.max(0, round2(b.parts));
    }
    item.updatedAt = new Date().toISOString();
    item.updatedBy = { id: req.user.id, name: req.user.name };
  })));

  r.post('/service/ros/:id/inspection/items/:itemId/media', viewService, inspector, deps.mediaUpload.single('file'), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Pick a photo or video.' });
    let saved;
    try { saved = await photos.saveMedia(req.file, { dealershipId: req.dealershipId, leadId: `ro-${req.params.id}` }); } catch (err) {
      return res.status(502).json({ error: err.hint ? `${err.message} ${err.hint}` : err.message });
    }
    return change(req, res, ro => {
      const item = ro.inspection && ro.inspection.items.find(i => i.id === req.params.itemId);
      if (!item) return 'Inspection item not found.';
      if ((item.media || []).length >= 8) return 'Up to 8 photos or videos per item.';
      item.media = [...(item.media || []), { id: crypto.randomUUID(), kind: saved.kind, url: saved.url }];
    });
  }));

  r.delete('/service/ros/:id/inspection/items/:itemId/media/:mediaId', viewService, inspector, wrap((req, res) => change(req, res, ro => {
    const item = ro.inspection && ro.inspection.items.find(i => i.id === req.params.itemId);
    if (!item) return 'Inspection item not found.';
    item.media = (item.media || []).filter(m => m.id !== req.params.mediaId);
  })));

  // Advisor sends it: a link by text when texting is set up; otherwise the
  // link comes back to copy and send another way.
  r.post('/service/ros/:id/inspection/send', allow('writeRepairOrders'), wrap(async (req, res) => {
    let link = null;
    let lead = null;
    let ro = null;
    const result = await store.tx(async q => {
      const loaded = await loadRo(q, req, { forUpdate: true });
      if (loaded.error) return loaded;
      ro = loaded.ro;
      const insp = ro.inspection;
      if (!insp) return { status: 400, error: 'Start the inspection first.' };
      if (!ro.leadId) return { status: 400, error: 'Internal ROs have no customer to send it to.' };
      if (!insp.items.some(i => i.status)) return { status: 400, error: 'Check at least one item first.' };
      const unpriced = insp.items.filter(i => needsWork(i) && !i.decision && !(n(i.hours) || n(i.parts)));
      if (unpriced.length) return { status: 400, error: `Put a price on ${unpriced.map(i => i.name).join(', ')} first.` };
      insp.token = insp.token || crypto.randomBytes(18).toString('base64url');
      insp.sentAt = new Date().toISOString();
      insp.sentBy = { id: req.user.id, name: req.user.name };
      lead = await store.get(q, 'leads', req.dealershipId, ro.leadId);
      await store.save(q, 'repair_orders', req.dealershipId, ro.id, ro);
      await audit.record(q, req, { action: 'inspection_sent', entityType: 'repair_order', entityId: ro.id, label: `RO-${ro.roNumber}`, details: 'Inspection sent to the customer' });
      return { ok: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    link = `${deps.publicBase(req)}/i/${ro.inspection.token}`;
    const d = await store.getDealership(store.pool, req.dealershipId);
    const first = lead && String(lead.name || '').split(' ')[0];
    const body = `Hi${first ? ` ${first}` : ''}, your vehicle inspection${d && d.name ? ` from ${d.name}` : ''} is ready. See what we found and approve any work here: ${link}`;
    let texted = false;
    let textError = null;
    if (lead && lead.phone && !lead.smsOptOut) {
      try { texted = await deps.sendSms(lead.phone, body, req.user); } catch (err) { textError = err.message; }
    } else if (lead && lead.smsOptOut) textError = 'they texted STOP';
    if (lead) {
      await store.tx(async q => {
        const current = await store.get(q, 'leads', req.dealershipId, lead.id, { forUpdate: true });
        if (!current) return;
        const activity = { id: crypto.randomUUID(), type: texted ? 'text' : 'note', text: `${texted ? '' : 'Inspection link ready (not texted): '}Sent the inspection for RO-${ro.roNumber}${texted ? ' by text' : ''}`, date: new Date().toISOString(), by: { id: req.user.id, name: req.user.name }, ...(texted ? { direction: 'out', message: body } : {}) };
        await store.save(q, 'leads', req.dealershipId, current.id, { ...current, activities: [activity, ...(current.activities || [])] });
      });
    }
    res.json({ link, texted, textError, ro: await deps.present(await store.get(store.pool, 'repair_orders', req.dealershipId, ro.id), req) });
  }));

  return r;
}

// ---------- The customer's page (no sign-in) ----------

async function findByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return null;
  const { rows } = await store.pool.query(
    `SELECT r.dealership_id, r.id, d.name AS store, d.settings FROM repair_orders r JOIN dealerships d ON d.id = r.dealership_id
     WHERE r.data->'inspection'->>'token' = $1 LIMIT 1`, [token]);
  if (!rows.length) return null;
  const ro = await store.get(store.pool, 'repair_orders', rows[0].dealership_id, rows[0].id);
  return ro ? { dealershipId: rows[0].dealership_id, ro, store: rows[0].store, settings: { taxRate: 7, ...(rows[0].settings || {}) } } : null;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => `$${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS_TEXT = { now: 'Needs attention now', soon: 'Needs attention soon', ok: 'Looks good' };

function customerPage(found) {
  const { ro, store: storeName, settings } = found;
  const rate = serviceSettings(settings).customerLaborRate;
  const insp = ro.inspection;
  const items = insp.items.filter(i => i.status);
  const order = { now: 0, soon: 1, ok: 2 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  const open = OPEN_STATUSES.includes(ro.status);
  const v = ro.vehicle || {};
  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(' ');
  const first = String(ro.customerName || '').split(' ')[0];
  const count = s => items.filter(i => i.status === s).length;
  const card = i => {
    const price = itemPrice(i, rate);
    const decided = i.decision ? `<div class="decided ${i.decision}">${i.decision === 'approved' ? '✓ Approved' : 'Declined'}</div>` : '';
    const buttons = needsWork(i) && !i.decision && open ? `<div class="choose">
        <label><input type="radio" name="d-${esc(i.id)}" value="approved"> Approve</label>
        <label><input type="radio" name="d-${esc(i.id)}" value="declined"> Not now</label></div>` : '';
    const media = (i.media || []).map(m => (m.kind === 'video'
      ? `<video src="${esc(photos.playableVideoUrl(m.url))}" controls playsinline preload="metadata"></video>`
      : `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="${esc(i.name)}" loading="lazy"></a>`)).join('');
    return `<div class="item ${i.status}" data-id="${esc(i.id)}" data-price="${price}">
      <div class="row"><span class="dot"></span><div class="what"><strong>${esc(i.name)}</strong><span>${STATUS_TEXT[i.status]}</span></div>
        ${needsWork(i) ? `<div class="price">${money(price)}</div>` : ''}</div>
      ${i.note ? `<p class="note">${esc(i.note)}</p>` : ''}
      ${media ? `<div class="media">${media}</div>` : ''}${buttons}${decided}</div>`;
  };
  const pending = items.some(i => needsWork(i) && !i.decision) && open;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your vehicle inspection${storeName ? ` -- ${esc(storeName)}` : ''}</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--text:#1f2430;--muted:#5b6272;--border:#e2e5ec;--blue:#2563eb;--green:#16a34a;--amber:#d97706;--red:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1729;--card:#16213a;--text:#e6e9f0;--muted:#a3abbd;--border:#26324d}}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text)}
main{max-width:720px;margin:0 auto;padding:20px 16px 120px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 16px}
.sum{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}.sum span{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:5px 12px;font-size:14px;font-weight:600}
.sum .r{color:var(--red)}.sum .y{color:var(--amber)}.sum .g{color:var(--green)}
.item{background:var(--card);border:1px solid var(--border);border-left:5px solid var(--green);border-radius:12px;padding:12px 14px;margin-bottom:10px}
.item.now{border-left-color:var(--red)}.item.soon{border-left-color:var(--amber)}
.row{display:flex;align-items:center;gap:10px}.dot{width:12px;height:12px;border-radius:50%;background:var(--green);flex:none}.now .dot{background:var(--red)}.soon .dot{background:var(--amber)}
.what{flex:1;display:flex;flex-direction:column}.what span{font-size:13px;color:var(--muted)}.price{font-weight:700;font-size:16px}
.note{margin:8px 0 0;color:var(--muted);font-size:14px}.media{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.media img{width:110px;height:82px;object-fit:cover;border-radius:8px}.media video{width:100%;max-height:300px;border-radius:8px;background:#000}
.choose{display:flex;gap:10px;margin-top:10px}.choose label{flex:1;text-align:center;border:1px solid var(--border);border-radius:9px;padding:10px;font-weight:600;cursor:pointer}
.choose input{margin-right:6px}.choose label:has(input:checked){border-color:var(--blue);background:rgba(37,99,235,.1)}
.decided{margin-top:8px;font-weight:700;font-size:14px}.decided.approved{color:var(--green)}.decided.declined{color:var(--muted)}
h2{font-size:15px;margin:20px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--border);padding:12px 16px}
.bar div{max-width:720px;margin:0 auto;display:flex;align-items:center;gap:12px}.bar strong{flex:1}
button{background:var(--blue);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:16px;font-weight:700;cursor:pointer}button:disabled{opacity:.5}
.done{background:rgba(22,163,74,.12);color:var(--green);border-radius:10px;padding:12px;font-weight:600;margin-bottom:12px}
</style></head><body><main>
<h1>${first ? `Hi ${esc(first)}, here` : 'Here'}'s your inspection</h1>
<p class="sub">${esc(vehicle || 'Your vehicle')} · RO-${esc(ro.roNumber)}${storeName ? ` · ${esc(storeName)}` : ''}</p>
${insp.decidedAt && !pending ? `<div class="done">Thanks -- we've got your answers. Your advisor will take it from here.</div>` : ''}
<div class="sum">${count('now') ? `<span class="r">● ${count('now')} now</span>` : ''}${count('soon') ? `<span class="y">● ${count('soon')} soon</span>` : ''}<span class="g">● ${count('ok')} good</span></div>
${items.filter(needsWork).length ? `<h2>Recommended</h2>${items.filter(needsWork).map(card).join('')}` : ''}
${items.filter(i => i.status === 'ok').length ? `<h2>Looks good</h2>${items.filter(i => i.status === 'ok').map(card).join('')}` : ''}
<p class="sub" style="font-size:13px">Prices include parts and labor, plus tax and shop supplies where they apply.</p>
</main>
${pending ? `<div class="bar"><div><strong id="tot">Approved: $0.00</strong><button id="go" disabled>Send my answers</button></div></div>
<script>
var go=document.getElementById('go'),tot=document.getElementById('tot');
function upd(){var t=0,a=0,c=document.querySelectorAll('.choose');document.querySelectorAll('.item').forEach(function(el){var v=el.querySelector('input:checked');if(v){a++;if(v.value==='approved')t+=Number(el.dataset.price)}});
tot.textContent='Approved: $'+t.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});go.disabled=a===0;}
document.addEventListener('change',upd);
go.addEventListener('click',function(){var d={};document.querySelectorAll('.item').forEach(function(el){var v=el.querySelector('input:checked');if(v)d[el.dataset.id]=v.value});
go.disabled=true;go.textContent='Sending…';fetch(location.pathname+'/decide',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decisions:d})})
.then(function(r){if(!r.ok)throw 0;location.reload()}).catch(function(){go.disabled=false;go.textContent='Try again'});});
</script>` : ''}
</body></html>`;
}

function publicRouter() {
  const r = express.Router();
  const nf = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:sans-serif;padding:24px">This inspection link is no longer available.</p>';

  r.get('/i/:token', (req, res, next) => (async () => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).send(nf);
    if (!found.ro.inspection.viewedAt) {
      await store.tx(async q => {
        const ro = await store.get(q, 'repair_orders', found.dealershipId, found.ro.id, { forUpdate: true });
        if (ro && ro.inspection && !ro.inspection.viewedAt) {
          ro.inspection.viewedAt = new Date().toISOString();
          await store.save(q, 'repair_orders', found.dealershipId, ro.id, ro);
        }
      });
    }
    res.send(customerPage(found));
  })().catch(next));

  // The customer's answers: approve or decline each recommended item.
  r.post('/i/:token/decide', express.json(), (req, res, next) => (async () => {
    const found = await findByToken(req.params.token);
    if (!found) return res.status(404).json({ error: 'Not found' });
    const decisions = (req.body && req.body.decisions) || {};
    const result = await store.tx(async q => {
      const ro = await store.get(q, 'repair_orders', found.dealershipId, found.ro.id, { forUpdate: true });
      if (!ro || !OPEN_STATUSES.includes(ro.status)) return { status: 400, error: 'This repair order is closed.' };
      const d = await store.getDealership(q, found.dealershipId);
      const cfg = serviceSettings({ taxRate: 7, ...((d && d.settings) || {}) });
      const now = new Date().toISOString();
      const approved = [];
      const declined = [];
      for (const item of ro.inspection.items) {
        const choice = decisions[item.id];
        if (!needsWork(item) || item.decision || !['approved', 'declined'].includes(choice)) continue;
        item.decision = choice;
        item.decidedAt = now;
        if (choice === 'approved') {
          const job = {
            id: crypto.randomUUID(), concern: `${item.name}${item.note ? ` -- ${item.note}` : ''} (approved from inspection)`, cause: '', correction: '',
            opCode: '', payType: 'customer', techId: null, hours: n(item.hours), rate: n(cfg.customerLaborRate), status: 'pending',
            parts: n(item.parts) ? [{ id: crypto.randomUUID(), partId: null, number: '', description: `Parts -- ${item.name}`, qty: 1, cost: 0, price: n(item.parts) }] : [],
            punches: [], fromInspection: item.id
          };
          ro.jobs = [...(ro.jobs || []), job];
          item.jobId = job.id;
          approved.push(item);
        } else {
          declined.push(item);
        }
      }
      if (!approved.length && !declined.length) return { ok: true };
      ro.inspection.decidedAt = now;
      await store.save(q, 'repair_orders', found.dealershipId, ro.id, ro);
      const rate = cfg.customerLaborRate;
      const sum = list => list.reduce((s, i) => s + itemPrice(i, rate), 0);
      const summary = [approved.length ? `approved ${approved.length} (${money(sum(approved))})` : '', declined.length ? `declined ${declined.length} (${money(sum(declined))})` : ''].filter(Boolean).join(', ');
      const who = { dealershipId: found.dealershipId, user: { id: null, name: ro.customerName || 'Customer' }, ip: req.ip };
      await audit.record(q, who, { action: 'inspection_decided', entityType: 'repair_order', entityId: ro.id, label: `RO-${ro.roNumber}`, details: `Customer ${summary}` });
      if (ro.leadId) {
        const lead = await store.get(q, 'leads', found.dealershipId, ro.leadId, { forUpdate: true });
        if (lead) {
          const activity = { id: crypto.randomUUID(), type: 'status', text: `🔧 Inspection on RO-${ro.roNumber}: ${summary}`, date: now, by: { id: null, name: lead.name } };
          await store.save(q, 'leads', found.dealershipId, lead.id, { ...lead, activities: [activity, ...(lead.activities || [])] });
        }
      }
      const userIds = [ro.advisorId, ro.inspection.sentBy && ro.inspection.sentBy.id].filter(Boolean).map(String);
      await alerts.notify(q, {
        dealershipId: found.dealershipId, type: 'inspection_decided', userIds: [...new Set(userIds)], actorId: null,
        title: `${ro.customerName || 'Customer'} answered the inspection on RO-${ro.roNumber}`, body: summary, link: { kind: 'ro', id: ro.id }
      });
      return { ok: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(204).send();
  })().catch(next));

  return r;
}

module.exports = { router, publicRouter, itemPrice, DEFAULT_TEMPLATE };
