// parts.js
// The Parts department: parts on the shelf, every stock movement, counter
// sales (tickets P-1001...), special orders, and the reorder list.
//
// On hand only changes through a movement, and every movement is kept:
//   receive  -- stock in from a vendor; cost becomes the weighted average
//   ro       -- used on a repair order (when the RO closes)
//   ticket   -- sold over the counter (when the ticket closes)
//   adjust   -- counted / damaged / found, with a reason
// "Committed" = on open ROs and open tickets but not taken off the shelf
// yet; "available" = on hand - committed. The reorder list is parts whose
// available count is at or below their reorder point.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');

const n = v => Number(v) || 0;
const round2 = v => Math.round(n(v) * 100) / 100;
const round4 = v => Math.round(n(v) * 10000) / 10000;
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const normNumber = v => text(v, 40).toUpperCase();

const OPEN_RO = ['open', 'in_progress', 'waiting_parts', 'ready'];
const SALE_TYPES = ['retail', 'wholesale', 'internal'];
const ORDER_STATUSES = ['requested', 'ordered', 'received', 'notified', 'done', 'cancelled'];

// ---------- Stock ----------

// Moves stock in or out of a part (qty is signed) and records it.
async function moveStock(q, req, partId, qty, { type, cost = null, ref = '', note = '' }) {
  const part = await store.get(q, 'parts', req.dealershipId, partId, { forUpdate: true });
  if (!part) return null;
  const before = n(part.onHand);
  const next = { ...part, onHand: round4(before + qty) };
  if (type === 'receive' && qty > 0 && cost !== null) {
    // Weighted average cost of what's on the shelf plus what just came in.
    const onShelf = Math.max(0, before);
    next.cost = round2((onShelf * n(part.cost) + qty * n(cost)) / (onShelf + qty));
    next.lastCost = round2(cost);
    next.lastReceivedAt = new Date().toISOString();
  }
  if (qty < 0) next.lastSoldAt = new Date().toISOString();
  await store.save(q, 'parts', req.dealershipId, part.id, next);
  await store.insert(q, 'part_moves', req.dealershipId, {
    id: crypto.randomUUID(), partId: part.id, number: part.number, type, qty: round4(qty),
    cost: cost === null ? n(part.cost) : round2(cost), onHandAfter: next.onHand,
    ref: text(ref, 60), note: text(note, 300),
    at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name }
  });
  // Stock in from a vendor and count corrections post to the books here;
  // what's used on ROs and tickets posts when those close.
  if (type === 'receive' || type === 'adjust') {
    await require('./postings').partsMoved(q, req, part, qty, type, type === 'receive' && cost !== null ? cost : n(part.cost), ref);
  }
  return next;
}

// Quantity of each part on open ROs and open tickets.
function committedByPart(ros, tickets) {
  const out = new Map();
  const add = (id, qty) => { if (id) out.set(id, (out.get(id) || 0) + n(qty)); };
  for (const ro of ros) if (OPEN_RO.includes(ro.status)) for (const j of ro.jobs || []) for (const p of j.parts || []) add(p.partId, p.qty);
  for (const t of tickets) if (t.status === 'open') for (const l of t.lines || []) add(l.partId, l.qty);
  return out;
}

function withAvailability(part, committed) {
  const c = round4(committed.get(part.id) || 0);
  return { ...part, committed: c, available: round4(n(part.onHand) - c), low: n(part.reorderPoint) > 0 && n(part.onHand) - c <= n(part.reorderPoint) };
}

async function loadStock(q, dealershipId) {
  const [parts, ros, tickets] = await Promise.all([
    store.list(q, 'parts', dealershipId),
    store.list(q, 'repair_orders', dealershipId),
    store.list(q, 'parts_tickets', dealershipId)
  ]);
  const committed = committedByPart(ros, tickets);
  return parts.filter(p => !p.inactive).map(p => withAvailability(p, committed)).concat(parts.filter(p => p.inactive).map(p => withAvailability(p, committed)));
}

// ---------- Cleaning ----------

function cleanPartFields(b, saved) {
  const out = {};
  const str = (f, max) => { if (f in b) out[f] = text(b[f], max); };
  if ('number' in b) out.number = normNumber(b.number);
  str('description', 120); str('brand', 40); str('category', 40); str('bin', 20); str('vendor', 60); str('notes', 500);
  for (const f of ['price', 'reorderPoint', 'reorderQty']) if (f in b) out[f] = Math.max(0, round2(b[f]));
  if ('source' in b) out.source = ['oem', 'aftermarket', 'used'].includes(b.source) ? b.source : 'oem';
  if ('inactive' in b) out.inactive = !!b.inactive;
  if (!saved && 'cost' in b) out.cost = Math.max(0, round2(b.cost));
  return out;
}

function cleanLine(l) {
  l = l || {};
  return {
    id: text(l.id, 40) || crypto.randomUUID(),
    partId: l.partId ? text(l.partId, 60) : null,
    number: normNumber(l.number), description: text(l.description, 120),
    qty: Math.max(0, round4(l.qty === undefined || l.qty === '' ? 1 : l.qty)),
    cost: Math.max(0, round2(l.cost)), price: Math.max(0, round2(l.price))
  };
}

function ticketTotals(t, settings) {
  const sale = (t.lines || []).reduce((s, l) => s + n(l.qty) * n(l.price), 0);
  const cost = (t.lines || []).reduce((s, l) => s + n(l.qty) * n(l.cost), 0);
  const service = (settings && settings.service) || {};
  const taxable = t.saleType === 'retail' && service.taxParts !== false;
  const tax = taxable ? sale * n(settings && settings.taxRate) / 100 : 0;
  return { sale: round2(sale), cost: round2(cost), gross: round2(sale - cost), tax: round2(tax), total: round2(sale + tax) };
}

async function settingsOf(q, dealershipId) {
  const d = await store.getDealership(q, dealershipId);
  return { taxRate: 7, ...((d && d.settings) || {}) };
}

async function customerName(q, dealershipId, leadId) {
  if (!leadId) return '';
  const lead = await store.get(q, 'leads', dealershipId, leadId);
  return lead ? lead.name : '';
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const allow = auth.requirePermission;
const hideCost = req => req.user.role === 'technician';
const forViewer = (req, part) => {
  if (!hideCost(req)) return part;
  const { cost, lastCost, ...rest } = part;
  return rest;
};

// ----- The shelf -----

router.get('/parts', allow('viewParts'), wrap(async (req, res) => {
  let list = await loadStock(store.pool, req.dealershipId);
  if (req.query.low === '1') list = list.filter(p => p.low && !p.inactive);
  if (req.query.active !== '0') list = list.filter(p => !p.inactive);
  res.json(list.map(p => forViewer(req, p)));
}));

// Parts that need ordering: available at or below the reorder point.
router.get('/parts/reorder', allow('writeParts'), wrap(async (req, res) => {
  const list = (await loadStock(store.pool, req.dealershipId)).filter(p => p.low && !p.inactive);
  res.json(list.map(p => ({
    ...p,
    suggestedQty: Math.max(n(p.reorderQty) || 1, Math.ceil(n(p.reorderPoint) - p.available + (n(p.reorderQty) ? 0 : 1)))
  })));
}));

router.get('/parts/:id', allow('viewParts'), wrap(async (req, res) => {
  const list = await loadStock(store.pool, req.dealershipId);
  const part = list.find(p => p.id === req.params.id);
  if (!part) return res.status(404).json({ error: 'Part not found.' });
  const moves = (await store.list(store.pool, 'part_moves', req.dealershipId)).filter(m => m.partId === part.id).reverse().slice(0, 200);
  res.json({ ...forViewer(req, part), moves: hideCost(req) ? moves.map(({ cost, ...m }) => m) : moves });
}));

router.post('/parts', allow('writeParts'), wrap(async (req, res) => {
  const b = req.body || {};
  const fields = cleanPartFields(b, null);
  if (!fields.number) return res.status(400).json({ error: 'Enter a part number.' });
  const result = await store.tx(async q => {
    const existing = (await store.list(q, 'parts', req.dealershipId)).find(p => p.number === fields.number);
    if (existing) return { error: `Part ${fields.number} is already in stock. Receive more on that part instead.` };
    const part = { id: crypto.randomUUID(), source: 'oem', cost: 0, price: 0, reorderPoint: 0, reorderQty: 0, ...fields, onHand: 0, createdAt: new Date().toISOString() };
    await store.insert(q, 'parts', req.dealershipId, part);
    await audit.created(q, req, 'part', part);
    const qty = round4(b.onHand);
    const saved = qty > 0 ? await moveStock(q, req, part.id, qty, { type: 'receive', cost: part.cost, note: 'Starting count' }) : part;
    return { part: saved };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(withAvailability(result.part, new Map()));
}));

router.put('/parts/:id', allow('writeParts'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const part = await store.get(q, 'parts', req.dealershipId, req.params.id, { forUpdate: true });
    if (!part) return { status: 404, error: 'Part not found.' };
    const fields = cleanPartFields(req.body || {}, part);
    if ('number' in fields) {
      if (!fields.number) return { status: 400, error: 'Enter a part number.' };
      const clash = (await store.list(q, 'parts', req.dealershipId)).find(p => p.number === fields.number && p.id !== part.id);
      if (clash) return { status: 400, error: `Part ${fields.number} already exists.` };
    }
    const saved = await store.save(q, 'parts', req.dealershipId, part.id, { ...part, ...fields });
    await audit.updated(q, req, 'part', part, saved);
    return { part: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.part);
}));

// Stock in from a vendor.
router.post('/parts/:id/receive', allow('writeParts'), wrap(async (req, res) => {
  const b = req.body || {};
  const qty = round4(b.qty);
  if (!(qty > 0)) return res.status(400).json({ error: 'Enter how many came in.' });
  const saved = await store.tx(async q => {
    const part = await store.get(q, 'parts', req.dealershipId, req.params.id);
    if (!part) return null;
    const cost = b.cost === '' || b.cost === undefined || b.cost === null ? n(part.cost) : Math.max(0, round2(b.cost));
    const next = await moveStock(q, req, part.id, qty, { type: 'receive', cost, ref: b.invoice, note: b.note });
    await audit.record(q, req, { action: 'update', entityType: 'part', entityId: part.id, label: audit.labelFor('part', part), details: `Received ${qty} @ $${cost}` });
    return next;
  });
  if (!saved) return res.status(404).json({ error: 'Part not found.' });
  res.json(saved);
}));

// Count correction, damage, found stock. Send { count } to set the number on
// the shelf, or { qty } to add/remove. A reason is required.
router.post('/parts/:id/adjust', allow('writeParts'), wrap(async (req, res) => {
  const b = req.body || {};
  const reason = text(b.reason, 200);
  if (!reason) return res.status(400).json({ error: 'Say why the count is changing.' });
  const saved = await store.tx(async q => {
    const part = await store.get(q, 'parts', req.dealershipId, req.params.id);
    if (!part) return null;
    const qty = 'count' in b ? round4(n(b.count) - n(part.onHand)) : round4(b.qty);
    if (!qty) return part;
    const next = await moveStock(q, req, part.id, qty, { type: 'adjust', note: reason });
    await audit.record(q, req, { action: 'update', entityType: 'part', entityId: part.id, label: audit.labelFor('part', part), details: `Adjusted ${qty > 0 ? '+' : ''}${qty}: ${reason}` });
    return next;
  });
  if (!saved) return res.status(404).json({ error: 'Part not found.' });
  res.json(saved);
}));

// ----- Counter tickets -----

router.get('/parts/tickets/list', allow('viewParts'), wrap(async (req, res) => {
  const [tickets, settings] = await Promise.all([store.list(store.pool, 'parts_tickets', req.dealershipId), settingsOf(store.pool, req.dealershipId)]);
  let list = tickets;
  if (req.query.status) list = list.filter(t => t.status === req.query.status);
  if (req.query.leadId) list = list.filter(t => t.leadId === req.query.leadId);
  res.json(list.reverse().map(t => ({ ...t, totals: t.closedTotals || ticketTotals(t, settings) })));
}));

async function saveTicket(q, req, saved, b) {
  const settings = await settingsOf(q, req.dealershipId);
  const next = { ...(saved || {}) };
  if ('leadId' in b || !saved) {
    next.leadId = b.leadId ? text(b.leadId, 60) : null;
    next.customerName = next.leadId ? await customerName(q, req.dealershipId, next.leadId) : text(b.customerName, 80);
    if (next.leadId && !next.customerName) return { error: 'Customer not found.' };
  } else if ('customerName' in b && !next.leadId) next.customerName = text(b.customerName, 80);
  if ('saleType' in b || !saved) next.saleType = SALE_TYPES.includes(b.saleType) ? b.saleType : 'retail';
  if ('notes' in b) next.notes = text(b.notes, 500);
  if ('lines' in b || !saved) next.lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 80).map(cleanLine).filter(l => l.number || l.description || l.partId);
  // Lines from stock carry the part's number and description.
  const parts = await store.list(q, 'parts', req.dealershipId);
  for (const l of next.lines) {
    const p = l.partId && parts.find(x => x.id === l.partId);
    if (l.partId && !p) return { error: 'A part on this ticket is no longer in inventory.' };
    if (p) { l.number = p.number; l.description = l.description || p.description; }
  }
  return { ticket: next, settings };
}

router.post('/parts/tickets', allow('writeParts'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const made = await saveTicket(q, req, null, req.body || {});
    if (made.error) return made;
    const ticket = {
      id: crypto.randomUUID(), ticketNumber: await store.takeNextTicketNumber(q, req.dealershipId), status: 'open',
      ...made.ticket, openedAt: new Date().toISOString(), openedBy: { id: req.user.id, name: req.user.name }, closedAt: null
    };
    if (!ticket.customerName) return { error: 'Pick a customer or enter a name.' };
    await store.insert(q, 'parts_tickets', req.dealershipId, ticket);
    await audit.created(q, req, 'parts_ticket', ticket);
    return { ticket, settings: made.settings };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json({ ...result.ticket, totals: ticketTotals(result.ticket, result.settings) });
}));

router.put('/parts/tickets/:id', allow('writeParts'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const t = await store.get(q, 'parts_tickets', req.dealershipId, req.params.id, { forUpdate: true });
    if (!t) return { status: 404, error: 'Ticket not found.' };
    if (t.status !== 'open') return { status: 400, error: 'This ticket is closed.' };
    const made = await saveTicket(q, req, t, req.body || {});
    if (made.error) return { status: 400, error: made.error };
    const saved = await store.save(q, 'parts_tickets', req.dealershipId, t.id, made.ticket);
    await audit.updated(q, req, 'parts_ticket', t, saved);
    return { ticket: saved, settings: made.settings };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ...result.ticket, totals: ticketTotals(result.ticket, result.settings) });
}));

// Close (invoice) a ticket: parts come off the shelf, totals are locked.
router.post('/parts/tickets/:id/close', allow('writeParts'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const t = await store.get(q, 'parts_tickets', req.dealershipId, req.params.id, { forUpdate: true });
    if (!t) return { status: 404, error: 'Ticket not found.' };
    if (t.status !== 'open') return { status: 400, error: 'This ticket is already closed.' };
    if (!(t.lines || []).length) return { status: 400, error: 'Add parts before closing.' };
    const settings = await settingsOf(q, req.dealershipId);
    for (const l of t.lines) {
      if (l.partId) await moveStock(q, req, l.partId, -n(l.qty), { type: 'ticket', cost: l.cost, ref: `P-${t.ticketNumber}` });
    }
    const before = { ...t };
    t.status = 'closed';
    t.closedAt = new Date().toISOString();
    t.closedBy = { id: req.user.id, name: req.user.name };
    t.closedTotals = ticketTotals(t, settings);
    const saved = await store.save(q, 'parts_tickets', req.dealershipId, t.id, t);
    await audit.updated(q, req, 'parts_ticket', before, saved, 'Closed');
    await require('./postings').ticketClosed(q, req, saved);
    return { ticket: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ...result.ticket, totals: result.ticket.closedTotals });
}));

router.post('/parts/tickets/:id/void', allow('writeParts'), wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const t = await store.get(q, 'parts_tickets', req.dealershipId, req.params.id, { forUpdate: true });
    if (!t) return { status: 404, error: 'Ticket not found.' };
    if (t.status !== 'open') return { status: 400, error: 'Only an open ticket can be voided.' };
    const before = { ...t };
    t.status = 'void';
    t.closedAt = new Date().toISOString();
    t.closedBy = { id: req.user.id, name: req.user.name };
    const saved = await store.save(q, 'parts_tickets', req.dealershipId, t.id, t);
    await audit.updated(q, req, 'parts_ticket', before, saved, text(req.body && req.body.reason, 200) || 'Voided');
    return { ticket: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.ticket);
}));

// ----- Special orders -----
// A part a customer (or an RO) needs that isn't on the shelf. Service can
// request one; the parts department orders it and receives it into stock.

router.get('/parts/special-orders/list', allow('viewParts'), wrap(async (req, res) => {
  let list = await store.list(store.pool, 'special_orders', req.dealershipId);
  if (req.query.open === '1') list = list.filter(o => !['done', 'cancelled'].includes(o.status));
  if (req.query.leadId) list = list.filter(o => o.leadId === req.query.leadId);
  if (req.query.roId) list = list.filter(o => o.roId === req.query.roId);
  res.json(list.reverse().map(o => (hideCost(req) ? (({ cost, ...r }) => r)(o) : o)));
}));

const canRequest = req => auth.can(req.user, 'writeParts') || auth.can(req.user, 'writeRepairOrders');

router.post('/parts/special-orders', allow('viewParts'), wrap(async (req, res) => {
  if (!canRequest(req)) return res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  const b = req.body || {};
  const result = await store.tx(async q => {
    let part = null;
    if (b.partId) {
      part = await store.get(q, 'parts', req.dealershipId, b.partId);
      if (!part) return { error: 'Part not found.' };
    }
    const number = part ? part.number : normNumber(b.number);
    if (!number && !text(b.description)) return { error: 'Enter a part number or description.' };
    let roNumber = null;
    if (b.roId) {
      const ro = await store.get(q, 'repair_orders', req.dealershipId, b.roId);
      if (!ro) return { error: 'Repair order not found.' };
      roNumber = ro.roNumber;
      if (!b.leadId && ro.leadId) b.leadId = ro.leadId;
    }
    const order = {
      id: crypto.randomUUID(), status: 'requested',
      partId: part ? part.id : null, number, description: text(b.description, 120) || (part ? part.description : ''),
      qty: Math.max(1, round4(b.qty || 1)),
      leadId: b.leadId ? text(b.leadId, 60) : null, customerName: await customerName(q, req.dealershipId, b.leadId),
      roId: b.roId ? text(b.roId, 60) : null, roNumber,
      vendor: text(b.vendor, 60), cost: Math.max(0, round2(b.cost !== undefined ? b.cost : part ? part.cost : 0)),
      price: Math.max(0, round2(b.price !== undefined ? b.price : part ? part.price : 0)),
      deposit: Math.max(0, round2(b.deposit)), notes: text(b.notes, 500),
      requestedAt: new Date().toISOString(), requestedBy: { id: req.user.id, name: req.user.name }, history: []
    };
    await store.insert(q, 'special_orders', req.dealershipId, order);
    await audit.created(q, req, 'special_order', order);
    return { order };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result.order);
}));

// Move a special order along (ordered, notified, done, cancelled) or edit it.
router.put('/parts/special-orders/:id', allow('writeParts'), wrap(async (req, res) => {
  const b = req.body || {};
  const result = await store.tx(async q => {
    const o = await store.get(q, 'special_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!o) return { status: 404, error: 'Special order not found.' };
    const next = { ...o };
    for (const f of ['vendor', 'notes', 'poNumber']) if (f in b) next[f] = text(b[f], f === 'notes' ? 500 : 60);
    for (const f of ['cost', 'price', 'deposit']) if (f in b) next[f] = Math.max(0, round2(b[f]));
    if ('eta' in b) next.eta = b.eta ? new Date(b.eta).toISOString() : null;
    if ('status' in b && b.status !== o.status) {
      if (!ORDER_STATUSES.includes(b.status) || b.status === 'received') return { status: 400, error: 'Use Receive when the part comes in.' };
      next.status = b.status;
      next.history = [...(o.history || []), { status: b.status, at: new Date().toISOString(), by: req.user.name }];
    }
    const saved = await store.save(q, 'special_orders', req.dealershipId, o.id, next);
    await audit.updated(q, req, 'special_order', o, saved);
    return { order: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.order);
}));

// The part came in: it goes on the shelf (a new part is set up if needed).
router.post('/parts/special-orders/:id/receive', allow('writeParts'), wrap(async (req, res) => {
  const b = req.body || {};
  const result = await store.tx(async q => {
    const o = await store.get(q, 'special_orders', req.dealershipId, req.params.id, { forUpdate: true });
    if (!o) return { status: 404, error: 'Special order not found.' };
    if (!['requested', 'ordered'].includes(o.status)) return { status: 400, error: 'This order was already received or closed.' };
    const cost = b.cost !== undefined && b.cost !== '' ? Math.max(0, round2(b.cost)) : n(o.cost);
    let part = o.partId ? await store.get(q, 'parts', req.dealershipId, o.partId) : null;
    if (!part && o.number) part = (await store.list(q, 'parts', req.dealershipId)).find(p => p.number === o.number) || null;
    if (!part) {
      if (!o.number) return { status: 400, error: 'Give this order a part number before receiving it.' };
      part = { id: crypto.randomUUID(), number: o.number, description: o.description, source: 'oem', cost, price: n(o.price), reorderPoint: 0, reorderQty: 0, bin: 'SPECIAL ORDER', vendor: o.vendor, onHand: 0, createdAt: new Date().toISOString() };
      await store.insert(q, 'parts', req.dealershipId, part);
      await audit.created(q, req, 'part', part, 'From special order');
    }
    await moveStock(q, req, part.id, n(o.qty), { type: 'receive', cost, ref: 'Special order', note: o.customerName ? `For ${o.customerName}` : '' });
    const next = { ...o, partId: part.id, cost, status: 'received', receivedAt: new Date().toISOString(),
      history: [...(o.history || []), { status: 'received', at: new Date().toISOString(), by: req.user.name }] };
    const saved = await store.save(q, 'special_orders', req.dealershipId, o.id, next);
    await audit.updated(q, req, 'special_order', o, saved, 'Received');
    return { order: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.order);
}));

module.exports = { router, moveStock, ticketTotals, committedByPart };
