// duplicates.js -- Duplicate leads.
//
// When a new customer comes in (added by hand, from the website, from an
// appraisal) it's checked against the customers already in the CRM using the
// store's rules: same phone, same email, and/or same full name, optionally only
// against customers added in the last so many days. A match doesn't get handed
// out by round robin -- it goes to the Duplicate Leads bucket, and whoever has
// the existing customer is told they came in again.
//
// Anyone can also mark a customer as a duplicate of another by hand. Managers
// work the bucket: merge the duplicate into the existing customer (history,
// notes, vehicles, deals, tasks, appraisals, and service all move over) or say
// it's not a duplicate (then it's assigned like any new lead).

const crypto = require('crypto');
const express = require('express');
const store = require('./db');
const audit = require('./audit');
const auth = require('./auth');
const alerts = require('./alerts');

// Records that point at a customer; merging moves them to the one kept.
const LINKED_TABLES = ['deals', 'appraisals', 'tasks', 'repair_orders', 'service_appointments', 'parts_tickets', 'special_orders'];
const IN_BUCKET = ['suspected', 'marked'];

function defaultRules() {
  return {
    phone: true,       // same phone number (last 10 digits)
    email: true,       // same email (not case-sensitive)
    name: false,       // same first and last name
    lookbackDays: 0,   // only customers added in the last N days (0 = any time)
    holdFromRoundRobin: true // duplicates wait in the bucket instead of being assigned
  };
}

function rulesFrom(settings) {
  const d = defaultRules();
  const r = (settings && settings.duplicates) || {};
  const bool = (v, def) => (v === undefined ? def : v === true || v === 'true');
  return {
    phone: bool(r.phone, d.phone),
    email: bool(r.email, d.email),
    name: bool(r.name, d.name),
    lookbackDays: Math.max(0, Math.min(3650, Math.round(Number(r.lookbackDays) || 0))),
    holdFromRoundRobin: bool(r.holdFromRoundRobin, d.holdFromRoundRobin)
  };
}

// What two customers are compared on.
const phoneKey = p => { const digits = String(p || '').replace(/\D/g, ''); return digits.length >= 7 ? digits.slice(-10) : ''; };
const emailKey = e => { const v = String(e || '').trim().toLowerCase(); return /\S+@\S+\.\S+/.test(v) ? v : ''; };
const nameKey = n => { const words = String(n || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); return words.length >= 2 ? `${words[0]} ${words[words.length - 1]}` : ''; };

// Why these two look like the same person (empty = they don't).
function reasonsFor(a, b, rules) {
  const out = [];
  if (rules.phone && phoneKey(a.phone) && phoneKey(a.phone) === phoneKey(b.phone)) out.push('Same phone');
  if (rules.email && emailKey(a.email) && emailKey(a.email) === emailKey(b.email)) out.push('Same email');
  if (rules.name && nameKey(a.name) && nameKey(a.name) === nameKey(b.name)) out.push('Same name');
  return out;
}

const inBucket = lead => !!(lead.duplicate && IN_BUCKET.includes(lead.duplicate.status));

// The existing customer a lead duplicates, oldest first (the original), or null.
function findMatch(lead, existing, rules) {
  const since = rules.lookbackDays ? Date.now() - rules.lookbackDays * 86400000 : 0;
  const cleared = new Set((lead.notDuplicateOf || []).map(String));
  const candidates = existing
    .filter(o => o.id !== lead.id && !inBucket(o) && !cleared.has(o.id) && !(o.notDuplicateOf || []).includes(lead.id))
    .filter(o => !since || new Date(o.dateAdded).getTime() >= since)
    .sort((x, y) => new Date(x.dateAdded) - new Date(y.dateAdded));
  for (const o of candidates) {
    const reasons = reasonsFor(lead, o, rules);
    if (reasons.length) return { original: o, reasons };
  }
  return null;
}

async function loadRules(q, dealershipId) {
  const d = await store.getDealership(q, dealershipId);
  return rulesFrom(d && d.settings);
}

// Called while a new customer is being created, before round robin. Flags
// the lead (in place) and says whether round robin should skip it.
async function checkNew(q, dealershipId, lead) {
  const rules = await loadRules(q, dealershipId);
  if (!rules.phone && !rules.email && !rules.name) return { hold: false };
  const match = findMatch(lead, await store.list(q, 'leads', dealershipId), rules);
  if (!match) return { hold: false };
  lead.duplicate = {
    status: 'suspected', ofId: match.original.id, reasons: match.reasons,
    by: { id: null, name: 'Automatic' }, at: new Date().toISOString()
  };
  return { hold: rules.holdFromRoundRobin, original: match.original };
}

// Tell whoever has the existing customer that they came in again.
// Managers hear there's one waiting in the bucket.
async function alertOwners(q, req, lead, original) {
  const body = [lead.source && lead.source !== 'other' ? `New ${lead.source} lead` : 'New lead', (lead.duplicate.reasons || []).join(', ')].filter(Boolean).join(' · ');
  const userIds = ['sales1Id', 'bdc1Id'].map(f => original[f]).filter(Boolean);
  if (userIds.length) {
    await alerts.notify(q, {
      dealershipId: req.dealershipId, type: 'lead_came_back', userIds, actorId: req.user && req.user.id,
      title: `Your customer came in again: ${original.name}`, body, link: { kind: 'lead', id: original.id }
    });
  }
  await alerts.notify(q, {
    dealershipId: req.dealershipId, type: 'duplicate_found', useRoles: true, actorId: req.user && req.user.id,
    title: `Possible duplicate: ${lead.name}`, body: `Matches ${original.name} · ${body}`, link: { kind: 'duplicates', id: lead.id }
  });
}

// ---------- Merging ----------

const blank = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const addressBlank = a => !a || !String(a.street || '').trim();

// The duplicate's details fill in what the kept customer is missing; both
// histories stay (newest first); notes from both are kept.
function mergedLead(keep, dup, who) {
  const out = { ...keep };
  for (const f of ['phone', 'email', 'bestContact', 'carId', 'sales1Id', 'sales2Id', 'bdc1Id', 'bdc2Id', 'creditApp', 'creditAppSync']) {
    if (blank(out[f]) && !blank(dup[f])) out[f] = dup[f];
  }
  if (addressBlank(out.address) && !addressBlank(dup.address)) out.address = dup.address;
  if (dup.notes && !String(out.notes || '').includes(dup.notes)) out.notes = [out.notes, dup.notes].filter(Boolean).join('\n\n').slice(0, 4000);
  out.wishList = [...new Set([...(out.wishList || []), ...(dup.wishList || [])])].slice(0, 20);
  out.hot = !!(out.hot || dup.hot);
  // A customer who came back is open again.
  if (out.status === 'lost' && dup.status !== 'lost') { out.status = dup.status; out.lostReason = ''; }
  out.roadmap = (out.roadmap || []).map((step, i) => step || (dup.roadmap || [])[i] || null);
  const note = {
    id: crypto.randomUUID(), type: 'status', date: new Date().toISOString(), by: who,
    text: `Merged duplicate${dup.customerNumber ? ` C-${dup.customerNumber}` : ''} (${dup.source || 'other'} lead from ${new Date(dup.dateAdded).toLocaleDateString('en-US')})`
  };
  out.activities = [note, ...[...(keep.activities || []), ...(dup.activities || [])].sort((a, b) => new Date(b.date) - new Date(a.date))];
  delete out.duplicate;
  return out;
}

async function merge(q, req, dupId, keepId) {
  const dup = await store.get(q, 'leads', req.dealershipId, dupId, { forUpdate: true });
  if (!dup) return { status: 404, error: 'Customer not found' };
  const targetId = keepId || (dup.duplicate && dup.duplicate.ofId);
  if (!targetId || targetId === dup.id) return { status: 400, error: 'Pick the customer to keep.' };
  const keep = await store.get(q, 'leads', req.dealershipId, targetId, { forUpdate: true });
  if (!keep) return { status: 404, error: 'The customer to keep was not found.' };
  const who = { id: req.user.id, name: req.user.name };
  const saved = await store.save(q, 'leads', req.dealershipId, keep.id, mergedLead(keep, dup, who));
  for (const table of LINKED_TABLES) {
    await q.query(`UPDATE ${table} SET data = jsonb_set(data, '{leadId}', to_jsonb($3::text)) WHERE dealership_id = $1 AND data->>'leadId' = $2`,
      [req.dealershipId, dup.id, keep.id]);
  }
  // Anything else waiting in the bucket on the removed customer now points at the kept one.
  const { rows } = await q.query(`SELECT id FROM leads WHERE dealership_id = $1 AND data->'duplicate'->>'ofId' = $2`, [req.dealershipId, dup.id]);
  for (const r of rows) {
    const other = await store.get(q, 'leads', req.dealershipId, r.id, { forUpdate: true });
    if (other && other.id !== keep.id) await store.save(q, 'leads', req.dealershipId, other.id, { ...other, duplicate: { ...other.duplicate, ofId: keep.id } });
  }
  await store.remove(q, 'leads', req.dealershipId, dup.id);
  await audit.record(q, req, {
    action: 'merge', entityType: 'lead', entityId: keep.id, label: audit.labelFor('lead', saved),
    details: `Merged duplicate ${dup.name}${dup.customerNumber ? ` (C-${dup.customerNumber})` : ''} into this customer`
  });
  return { lead: saved, removedId: dup.id };
}

// ---------- Routes ----------

// assignFromRotations and alertAssignments live with the rest of the lead
// code in server.js; it hands them over here.
function router({ assignFromRotations, alertAssignments }) {
  const r = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const manage = auth.requirePermission('resolveDuplicates');

  // The bucket: each duplicate next to the customer it matches.
  r.get('/duplicates', wrap(async (req, res) => {
    const [leads, rules] = await Promise.all([store.list(store.pool, 'leads', req.dealershipId), loadRules(store.pool, req.dealershipId)]);
    const byId = new Map(leads.map(l => [l.id, l]));
    res.json({
      rules,
      items: leads.filter(inBucket).map(l => ({ lead: l, original: byId.get(l.duplicate.ofId) || null }))
        .sort((a, b) => new Date(b.lead.duplicate.at) - new Date(a.lead.duplicate.at))
    });
  }));

  // Anyone: "this customer is a duplicate of that one."
  r.post('/leads/:id/duplicate', wrap(async (req, res) => {
    const ofId = String((req.body || {}).ofId || '');
    const result = await store.tx(async q => {
      const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
      if (!lead) return { status: 404, error: 'Customer not found' };
      const original = ofId && ofId !== lead.id ? await store.get(q, 'leads', req.dealershipId, ofId) : null;
      if (!original) return { status: 400, error: 'Pick the customer this one duplicates.' };
      if (original.duplicate && IN_BUCKET.includes(original.duplicate.status) && original.duplicate.ofId === lead.id) {
        return { status: 400, error: `${original.name} is already waiting as a duplicate of this customer.` };
      }
      const rules = await loadRules(q, req.dealershipId);
      const reasons = reasonsFor(lead, original, { ...rules, phone: true, email: true, name: true });
      const saved = await store.save(q, 'leads', req.dealershipId, lead.id, {
        ...lead,
        duplicate: { status: 'marked', ofId: original.id, reasons, by: { id: req.user.id, name: req.user.name }, at: new Date().toISOString(), note: String((req.body || {}).note || '').trim().slice(0, 300) }
      });
      await audit.record(q, req, {
        action: 'mark_duplicate', entityType: 'lead', entityId: lead.id, label: audit.labelFor('lead', lead),
        details: `Marked as a duplicate of ${original.name}${original.customerNumber ? ` (C-${original.customerNumber})` : ''}`
      });
      return { lead: saved };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.lead);
  }));

  // Take it back out of the bucket (whoever marked it, or a manager).
  r.delete('/leads/:id/duplicate', wrap(async (req, res) => {
    const result = await store.tx(async q => {
      const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
      if (!lead) return { status: 404, error: 'Customer not found' };
      if (!inBucket(lead)) return { lead };
      const mine = lead.duplicate.by && lead.duplicate.by.id === req.user.id;
      if (!mine && !auth.can(req.user, 'resolveDuplicates')) return { status: 403, error: 'Ask a manager to take this out of Duplicate Leads.' };
      return notDuplicate(q, req, lead);
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.lead);
  }));

  // Managers: merge into the customer it matches (or another one picked).
  r.post('/duplicates/:id/merge', manage, wrap(async (req, res) => {
    const result = await store.tx(q => merge(q, req, req.params.id, (req.body || {}).keepId ? String(req.body.keepId) : null));
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  }));

  // Managers: not the same person. It stays a customer and, if round robin
  // held it back, gets assigned now.
  async function notDuplicate(q, req, lead) {
    const next = { ...lead, notDuplicateOf: [...new Set([...(lead.notDuplicateOf || []), lead.duplicate.ofId])].slice(-20) };
    delete next.duplicate;
    const unassigned = !['sales1Id', 'sales2Id', 'bdc1Id', 'bdc2Id'].some(f => next[f]);
    if (unassigned) await assignFromRotations(q, req, next);
    const saved = await store.save(q, 'leads', req.dealershipId, lead.id, next);
    if (unassigned) await alertAssignments(q, req, lead, saved);
    await audit.record(q, req, { action: 'not_duplicate', entityType: 'lead', entityId: lead.id, label: audit.labelFor('lead', lead), details: 'Not a duplicate -- back with the other customers' });
    return { lead: saved };
  }
  r.post('/duplicates/:id/not-duplicate', manage, wrap(async (req, res) => {
    const result = await store.tx(async q => {
      const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
      if (!lead) return { status: 404, error: 'Customer not found' };
      if (!inBucket(lead)) return { status: 400, error: 'This customer is not in Duplicate Leads.' };
      return notDuplicate(q, req, lead);
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.lead);
  }));

  // Managers: check every customer already in the CRM (e.g. after an import).
  // The newer of each matching pair goes to the bucket.
  r.post('/duplicates/scan', manage, wrap(async (req, res) => {
    const found = await store.tx(async q => {
      await q.query('SELECT 1 FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
      const rules = await loadRules(q, req.dealershipId);
      if (!rules.phone && !rules.email && !rules.name) return 0;
      const leads = (await store.list(q, 'leads', req.dealershipId)).sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
      const seen = [];
      let count = 0;
      for (const lead of leads) {
        if (inBucket(lead)) continue;
        const match = findMatch(lead, seen, { ...rules, lookbackDays: 0 });
        if (match) {
          lead.duplicate = { status: 'suspected', ofId: match.original.id, reasons: match.reasons, by: { id: req.user.id, name: `${req.user.name} (scan)` }, at: new Date().toISOString() };
          await store.save(q, 'leads', req.dealershipId, lead.id, lead);
          count++;
        } else {
          seen.push(lead);
        }
      }
      if (count) await audit.record(q, req, { action: 'scan_duplicates', entityType: 'settings', entityId: 'duplicates', label: 'Duplicate Leads', details: `Scan found ${count} possible duplicate${count === 1 ? '' : 's'}` });
      return count;
    });
    res.json({ found });
  }));

  // Managers: the rules.
  r.put('/duplicates/rules', manage, wrap(async (req, res) => {
    const saved = await store.tx(async q => {
      const { rows } = await q.query('SELECT settings FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
      const settings = rows[0].settings || {};
      const before = rulesFrom(settings);
      const next = rulesFrom({ duplicates: { ...before, ...(req.body || {}) } });
      await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [req.dealershipId, { ...settings, duplicates: next }]);
      await audit.updated(q, req, 'settings', { ...before, id: 'duplicate-rules' }, { ...next, id: 'duplicate-rules' }, 'Duplicate lead rules');
      return next;
    });
    res.json(saved);
  }));

  return r;
}

module.exports = { router, checkNew, alertOwners, findMatch, reasonsFor, rulesFrom, defaultRules, inBucket };
