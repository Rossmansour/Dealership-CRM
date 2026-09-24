// audit.js
// The audit log: an append-only record of who did what, and when. Every
// create, change, and delete in the app writes an entry, as do sign-ins
// (and failed sign-in attempts) and user-account changes. Entries are never
// edited or deleted through the app.
//
// Changes are recorded field by field ("price: 18,500 -> 17,900"). Values
// of sensitive fields (SSN, license number) are never copied into the log
// -- only the fact that they changed.

const store = require('./db');

// Field names whose values must never appear in the log.
const SENSITIVE_FIELDS = new Set(['ssn', 'licenseNumber', 'password', 'password_hash']);

// Readable names for records, shown in the log's "Record" column.
const LABELS = {
  car: c => [c.year, c.make, c.model].filter(Boolean).join(' ') + (c.stockNumber ? ` (Stock #${c.stockNumber})` : ''),
  lead: l => l.name,
  deal: d => `D-${d.dealNumber}`,
  tax_rate: r => [r.state, r.county || 'statewide', r.city].filter(Boolean).join(' / '),
  user: u => `${u.name} (${u.email})`,
  settings: () => 'Fee defaults',
  task: t => `${t.title || t.type}${t.leadName ? ` · ${t.leadName}` : ''}`,
  appraisal: a => `A-${a.appraisalNumber}${[a.year, a.make, a.model].some(Boolean) ? ' · ' + [a.year, a.make, a.model].filter(Boolean).join(' ') : ''}`
};

function labelFor(entityType, record) {
  try {
    return record && LABELS[entityType] ? LABELS[entityType](record) : null;
  } catch {
    return null;
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Forms send numbers as text, so 14500 and "14500" shouldn't count as a change.
const isNumberLike = v => (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const sameNumber = (a, b) => isNumberLike(a) && isNumberLike(b) && Number(a) === Number(b);

// Field-by-field differences between two versions of a record, as
// { "path.to.field": { from, to } }. Nested objects (like a credit app's
// applicant) are compared field by field; arrays are compared as a whole.
function diff(before, after, prefix = '') {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (isPlainObject(a) && isPlainObject(b)) {
      Object.assign(changes, diff(a, b, path));
      continue;
    }
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    if (sameNumber(a, b)) continue;
    changes[path] = SENSITIVE_FIELDS.has(key)
      ? { from: a ? '(hidden)' : '', to: b ? '(hidden)' : '', hidden: true }
      : { from: a ?? null, to: b ?? null };
  }
  return changes;
}

// Removes sensitive values from a whole record (used when logging what a
// deleted record looked like).
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_FIELDS.has(k) ? (v ? '(hidden)' : '') : redact(v);
  }
  return out;
}

// Writes one entry. `q` should be the same transaction as the change
// itself, so the change and its log entry are saved together or not at all.
//
//   entry: { action, entityType, entityId, label, changes, details }
//   who:   the request (uses req.user, req.dealershipId, req.ip), or an
//          object { dealershipId, userId, userName, ip }
async function record(q, who, entry) {
  const actor = who.user
    ? { dealershipId: who.dealershipId, userId: who.user.id, userName: who.user.name, ip: who.ip }
    : who;
  await q.query(
    `INSERT INTO audit_log
       (dealership_id, user_id, user_name, action, entity_type, entity_id, entity_label, changes, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.dealershipId,
      actor.userId || null,
      actor.userName || null,
      entry.action,
      entry.entityType,
      entry.entityId || null,
      entry.label || null,
      entry.changes && Object.keys(entry.changes).length ? entry.changes : null,
      entry.details || null,
      actor.ip || null
    ]
  );
}

// Shorthands for the three common cases.
function created(q, req, entityType, rec, details) {
  return record(q, req, {
    action: 'create', entityType, entityId: rec.id, label: labelFor(entityType, rec), details
  });
}

// Only writes an entry if something actually changed.
function updated(q, req, entityType, before, after, details) {
  const changes = diff(before, after);
  if (!Object.keys(changes).length) return Promise.resolve();
  return record(q, req, {
    action: 'update', entityType, entityId: after.id, label: labelFor(entityType, after), changes, details
  });
}

function deleted(q, req, entityType, rec, details) {
  return record(q, req, {
    action: 'delete', entityType, entityId: rec.id, label: labelFor(entityType, rec),
    changes: { deletedRecord: { from: redact(rec), to: null } }, details
  });
}

// Reads entries for one dealership, newest first, with optional filters.
// Pages with `before` (the id of the last entry already shown).
async function list(dealershipId, { entityType, entityId, userId, from, to, search, before, limit = 100 } = {}) {
  const where = ['dealership_id = $1'];
  const params = [dealershipId];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (entityType) add('entity_type = ?', entityType);
  if (entityId) add('entity_id = ?', entityId);
  if (userId) add('user_id::text = ?', userId);
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (isDate(from)) add('created_at >= ?::date', from);
  if (isDate(to)) add("created_at < ?::date + interval '1 day'", to);
  if (search) {
    params.push(`%${String(search).replace(/[\\%_]/g, ch => '\\' + ch)}%`);
    const n = params.length;
    where.push(`(entity_label ILIKE $${n} OR details ILIKE $${n} OR user_name ILIKE $${n})`);
  }
  if (Number.isInteger(Number(before)) && Number(before) > 0) add('id < ?', Number(before));

  const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
  params.push(pageSize + 1);
  const { rows } = await store.pool.query(
    `SELECT id, user_id, user_name, action, entity_type, entity_id, entity_label, changes, details, ip, created_at
     FROM audit_log WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > pageSize;
  const entries = rows.slice(0, pageSize).map(r => ({
    id: Number(r.id),
    userId: r.user_id,
    userName: r.user_name,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    label: r.entity_label,
    changes: r.changes,
    details: r.details,
    ip: r.ip,
    at: r.created_at
  }));
  return { entries, nextBefore: hasMore ? entries[entries.length - 1].id : null };
}

module.exports = { record, created, updated, deleted, diff, redact, labelFor, list };
