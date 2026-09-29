// docs.js
// Deal jackets: every document on a deal -- scanned or uploaded (the Carfax,
// stips, the signed contract), or added from the store's form library -- and
// whether each one is signed yet.
//
// Some documents must be signed in ink (the DMV's REG 262, by default). The
// store keeps that list; those are marked "wet signature only" so they're
// printed, never sent out for e-signing.
//
// Files can carry customers' personal information, so they're kept in the
// database, encrypted with the same key as SSNs, and only ever sent to
// signed-in staff at the same store.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const { getKey } = require('./encryption');

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => cb(null, !!TYPES[file.mimetype])
});
// Upload errors get a plain answer here (the app-wide handler talks about photos).
const oneFile = (req, res, next) => upload.single('file')(req, res, err => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files can be up to 15 MB.' : 'Upload one file at a time.' });
});
const DEFAULT_WET = ['REG 262'];
const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);

// ---------- Files, encrypted at rest ----------
function seal(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function unseal(buf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

// ---------- Wet-signature-only list ----------
function docSettings(settings) {
  const d = (settings && settings.docs) || {};
  return { wetSignature: Array.isArray(d.wetSignature) ? d.wetSignature : DEFAULT_WET };
}
const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const needsInk = (name, cfg) => cfg.wetSignature.some(w => squash(w) && squash(name).includes(squash(w)));

async function loadCfg(q, dealershipId) {
  const d = await store.getDealership(q, dealershipId);
  return docSettings(d && d.settings);
}

const present = row => ({ id: row.id, dealId: row.deal_id, ...row.data });

// ---------- Routes ----------
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const manageForms = auth.requirePermission('editDealAccounting'); // managers and F&I

async function dealExists(q, dealershipId, dealId) {
  const { rows } = await q.query('SELECT 1 FROM deals WHERE dealership_id = $1 AND id = $2', [dealershipId, dealId]);
  return rows.length > 0;
}

function sendFile(res, data, content, disposition) {
  res.set({
    'Content-Type': data.mime,
    'Content-Disposition': `${disposition}; filename="${String(data.fileName || 'document').replace(/[^\w.\- ]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store'
  });
  res.send(unseal(content));
}

// The deal's jacket.
router.get('/deals/:id/documents', wrap(async (req, res) => {
  if (!(await dealExists(store.pool, req.dealershipId, req.params.id))) return res.status(404).json({ error: 'Deal not found' });
  const { rows } = await store.pool.query(
    'SELECT id, deal_id, data FROM deal_documents WHERE dealership_id = $1 AND deal_id = $2 ORDER BY seq', [req.dealershipId, req.params.id]);
  const d = await store.getDealership(store.pool, req.dealershipId);
  res.json({ documents: rows.map(present), settings: docSettings(d && d.settings), storeName: d ? d.name : '' });
}));

// Scan or upload a document into the jacket.
router.post('/deals/:id/documents', oneFile, wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pick a PDF, JPG, or PNG file (up to 15 MB).' });
  const saved = await store.tx(async q => {
    if (!(await dealExists(q, req.dealershipId, req.params.id))) return null;
    const cfg = await loadCfg(q, req.dealershipId);
    const name = text((req.body || {}).name) || text(req.file.originalname.replace(/\.[^.]+$/, '')) || 'Document';
    const doc = {
      name, fileName: text(req.file.originalname, 150) || `${name}.${TYPES[req.file.mimetype]}`, mime: req.file.mimetype, size: req.file.size,
      source: 'upload', wetSignature: needsInk(name, cfg), status: 'unsigned',
      addedBy: { id: req.user.id, name: req.user.name }, addedAt: new Date().toISOString()
    };
    const id = crypto.randomUUID();
    await q.query('INSERT INTO deal_documents (dealership_id, id, deal_id, data, content) VALUES ($1, $2, $3, $4, $5)',
      [req.dealershipId, id, req.params.id, doc, seal(req.file.buffer)]);
    await audit.record(q, req, { action: 'create', entityType: 'deal', entityId: req.params.id, label: 'Deal jacket', details: `Added "${name}" to the deal jacket` });
    return { id, deal_id: req.params.id, data: doc };
  });
  if (!saved) return res.status(404).json({ error: 'Deal not found' });
  res.status(201).json(present(saved));
}));

// Add a blank form from the library to the jacket.
router.post('/deals/:id/documents/from-form', wrap(async (req, res) => {
  const formId = text((req.body || {}).formId, 60);
  const saved = await store.tx(async q => {
    if (!(await dealExists(q, req.dealershipId, req.params.id))) return { status: 404, error: 'Deal not found' };
    const { rows } = await q.query('SELECT data, content FROM form_library WHERE dealership_id = $1 AND id = $2', [req.dealershipId, formId]);
    if (!rows.length) return { status: 404, error: 'Form not found' };
    const f = rows[0].data;
    const doc = {
      name: f.name, fileName: f.fileName, mime: f.mime, size: f.size, source: 'form', formId,
      wetSignature: !!f.wetSignature, status: 'unsigned', addedBy: { id: req.user.id, name: req.user.name }, addedAt: new Date().toISOString()
    };
    const id = crypto.randomUUID();
    await q.query('INSERT INTO deal_documents (dealership_id, id, deal_id, data, content) VALUES ($1, $2, $3, $4, $5)',
      [req.dealershipId, id, req.params.id, doc, rows[0].content]);
    await audit.record(q, req, { action: 'create', entityType: 'deal', entityId: req.params.id, label: 'Deal jacket', details: `Added form "${f.name}" to the deal jacket` });
    return { row: { id, deal_id: req.params.id, data: doc } };
  });
  if (saved.error) return res.status(saved.status).json({ error: saved.error });
  res.status(201).json(present(saved.row));
}));

router.get('/documents/:docId/file', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT data, content FROM deal_documents WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  sendFile(res, rows[0].data, rows[0].content, req.query.download ? 'attachment' : 'inline');
}));

// Rename, mark signed / unsigned, or set wet signature only.
router.put('/documents/:docId', wrap(async (req, res) => {
  const b = req.body || {};
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT id, deal_id, data FROM deal_documents WHERE dealership_id = $1 AND id = $2 FOR UPDATE', [req.dealershipId, req.params.docId]);
    if (!rows.length) return null;
    const before = rows[0].data;
    const next = { ...before };
    if ('name' in b && text(b.name)) next.name = text(b.name);
    if ('wetSignature' in b) next.wetSignature = !!b.wetSignature;
    if ('status' in b && ['unsigned', 'signed'].includes(b.status) && b.status !== before.status) {
      next.status = b.status;
      next.signedAt = b.status === 'signed' ? new Date().toISOString() : null;
      next.signedMarkedBy = b.status === 'signed' ? { id: req.user.id, name: req.user.name } : null;
    }
    await q.query('UPDATE deal_documents SET data = $3, updated_at = now() WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.docId, next]);
    const changed = [next.name !== before.name && `renamed to "${next.name}"`, next.status !== before.status && `marked ${next.status}`,
      next.wetSignature !== before.wetSignature && (next.wetSignature ? 'set to wet signature only' : 'set to e-sign OK')].filter(Boolean);
    if (changed.length) await audit.record(q, req, { action: 'update', entityType: 'deal', entityId: rows[0].deal_id, label: 'Deal jacket', details: `"${before.name}" ${changed.join(', ')}` });
    return { ...rows[0], data: next };
  });
  if (!saved) return res.status(404).json({ error: 'Document not found' });
  res.json(present(saved));
}));

// Whoever added it, or a manager, can take it out.
router.delete('/documents/:docId', wrap(async (req, res) => {
  const done = await store.tx(async q => {
    const { rows } = await q.query('SELECT deal_id, data FROM deal_documents WHERE dealership_id = $1 AND id = $2 FOR UPDATE', [req.dealershipId, req.params.docId]);
    if (!rows.length) return { status: 404, error: 'Document not found' };
    const d = rows[0].data;
    if (!auth.can(req.user, 'deleteRecords') && !(d.addedBy && d.addedBy.id === req.user.id)) return { status: 403, error: 'Only a manager or whoever added it can remove this document.' };
    await q.query('DELETE FROM deal_documents WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.docId]);
    await audit.record(q, req, { action: 'delete', entityType: 'deal', entityId: rows[0].deal_id, label: 'Deal jacket', details: `Removed "${d.name}" from the deal jacket` });
    return {};
  });
  if (done.error) return res.status(done.status).json({ error: done.error });
  res.status(204).send();
}));

// The deal recap (managers and F&I): front and back gross, the same way the
// dashboard counts them.
router.get('/deals/:id/recap', manageForms, wrap(async (req, res) => {
  const deal = await store.get(store.pool, 'deals', req.dealershipId, req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  const [car, dealership, appraisals] = await Promise.all([
    deal.carId ? store.get(store.pool, 'cars', req.dealershipId, deal.carId) : null,
    store.getDealership(store.pool, req.dealershipId),
    store.list(store.pool, 'appraisals', req.dealershipId)
  ]);
  const acv = (appraisals.find(a => a.dealId === deal.id && a.status === 'acquired') || {}).acquiredFor;
  const g = require('./dashboard').dealGross(deal, car, (dealership && dealership.settings) || {}, acv);
  res.json({ ...g, carCost: car ? Number(car.cost) || 0 : null, total: g.front + g.finance + g.incentives });
}));

// ---------- Form library ----------
router.get('/forms', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT id, data FROM form_library WHERE dealership_id = $1 ORDER BY seq', [req.dealershipId]);
  res.json({ forms: rows.map(r => ({ id: r.id, ...r.data })), settings: await loadCfg(store.pool, req.dealershipId), canManage: auth.can(req.user, 'editDealAccounting') });
}));

router.post('/forms', manageForms, oneFile, wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pick a PDF, JPG, or PNG file (up to 15 MB).' });
  const saved = await store.tx(async q => {
    const cfg = await loadCfg(q, req.dealershipId);
    const name = text((req.body || {}).name) || text(req.file.originalname.replace(/\.[^.]+$/, '')) || 'Form';
    const wet = (req.body || {}).wetSignature;
    const form = {
      name, fileName: text(req.file.originalname, 150), mime: req.file.mimetype, size: req.file.size,
      wetSignature: wet === undefined || wet === '' ? needsInk(name, cfg) : wet === 'true' || wet === true,
      addedBy: { id: req.user.id, name: req.user.name }, addedAt: new Date().toISOString()
    };
    const id = crypto.randomUUID();
    await q.query('INSERT INTO form_library (dealership_id, id, data, content) VALUES ($1, $2, $3, $4)', [req.dealershipId, id, form, seal(req.file.buffer)]);
    await audit.record(q, req, { action: 'create', entityType: 'settings', entityId: 'form-library', label: 'Form library', details: `Added form "${name}"` });
    return { id, ...form };
  });
  res.status(201).json(saved);
}));

router.get('/forms/:id/file', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT data, content FROM form_library WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Form not found' });
  sendFile(res, rows[0].data, rows[0].content, 'inline');
}));

router.put('/forms/:id', manageForms, wrap(async (req, res) => {
  const b = req.body || {};
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT data FROM form_library WHERE dealership_id = $1 AND id = $2 FOR UPDATE', [req.dealershipId, req.params.id]);
    if (!rows.length) return null;
    const next = { ...rows[0].data };
    if ('name' in b && text(b.name)) next.name = text(b.name);
    if ('wetSignature' in b) next.wetSignature = !!b.wetSignature;
    await q.query('UPDATE form_library SET data = $3, updated_at = now() WHERE dealership_id = $1 AND id = $2', [req.dealershipId, req.params.id, next]);
    return { id: req.params.id, ...next };
  });
  if (!saved) return res.status(404).json({ error: 'Form not found' });
  res.json(saved);
}));

router.delete('/forms/:id', manageForms, wrap(async (req, res) => {
  const removed = await store.tx(async q => {
    const { rows } = await q.query('DELETE FROM form_library WHERE dealership_id = $1 AND id = $2 RETURNING data', [req.dealershipId, req.params.id]);
    if (rows.length) await audit.record(q, req, { action: 'delete', entityType: 'settings', entityId: 'form-library', label: 'Form library', details: `Removed form "${rows[0].data.name}"` });
    return rows.length > 0;
  });
  if (!removed) return res.status(404).json({ error: 'Form not found' });
  res.status(204).send();
}));

// The wet-signature-only list: any document whose name contains one of these.
router.put('/forms-settings', manageForms, wrap(async (req, res) => {
  const list = Array.isArray((req.body || {}).wetSignature) ? req.body.wetSignature.map(x => text(x, 60)).filter(Boolean).slice(0, 50) : null;
  if (!list) return res.status(400).json({ error: 'Send the list of names.' });
  const saved = await store.tx(async q => {
    const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const settings = rows[0].settings || {};
    const before = docSettings(settings);
    const next = { ...(settings.docs || {}), wetSignature: [...new Set(list)] };
    await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, docs: next }]);
    await audit.updated(q, req, 'settings', { ...before, id: 'docs-settings' }, { ...next, id: 'docs-settings' }, 'Wet signature only list');
    return next;
  });
  res.json(saved);
}));

module.exports = { router, docSettings, needsInk, seal, unseal };
