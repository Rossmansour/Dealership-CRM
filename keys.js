// keys.js
// Shows who has each car's key, using the dealership's key machine
// (KeyTrak, KeyWatcher, Traka...) as the source of truth. The CRM only
// displays key status -- checking keys in and out, and everything else
// about keys, stays in the key machine's own system.
//
// The key machine (or a small connector for it) sends each check-out /
// check-in to POST /api/integrations/keys/events with an integration token.
// Events are matched to a key by its tag code, or to a car by stock # or
// VIN; keys are created automatically the first time they're seen.

const crypto = require('crypto');
const store = require('./db');
const audit = require('./audit');

// Key machines word things differently; accept the common variants.
const ACTION_ALIASES = {
  check_out: 'check_out', checkout: 'check_out', checked_out: 'check_out', out: 'check_out', removed: 'check_out', taken: 'check_out',
  check_in: 'check_in', checkin: 'check_in', checked_in: 'check_in', in: 'check_in', returned: 'check_in', return: 'check_in',
  missing: 'missing', lost: 'missing', overdue_missing: 'missing'
};

function normalizeAction(action) {
  return ACTION_ALIASES[String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_')] || null;
}

function carLabel(car) {
  return audit.labelFor('car', car);
}

// All keys for a dealership, with the car each belongs to, for the Key
// Board and the inventory Key column.
async function listKeys(dealershipId) {
  const { rows } = await store.pool.query(
    `SELECT k.*, c.data AS car
     FROM vehicle_keys k JOIN cars c ON c.dealership_id = k.dealership_id AND c.id = k.car_id
     WHERE k.dealership_id = $1
     ORDER BY c.seq, k.created_at`,
    [dealershipId]
  );
  return rows.map(publicKey);
}

function publicKey(row) {
  return {
    id: row.id,
    carId: row.car_id,
    carLabel: row.car ? carLabel(row.car) : null,
    label: row.label,
    tagCode: row.tag_code || '',
    slot: row.slot || '',
    status: row.status,
    holderUserId: row.holder_user_id,
    holderName: row.holder_name,
    statusSince: row.status_since
  };
}

function cleanTag(tag) {
  const t = String(tag ?? '').trim();
  return t || null;
}

async function addKey(q, who, car, { label, tagCode, slot } = {}) {
  const { rows: existing } = await q.query(
    'SELECT count(*)::int AS n FROM vehicle_keys WHERE dealership_id = $1 AND car_id = $2', [who.dealershipId, car.id]);
  const { rows } = await q.query(
    `INSERT INTO vehicle_keys (dealership_id, car_id, label, tag_code, slot)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [who.dealershipId, car.id, String(label || '').trim() || `Key ${existing[0].n + 1}`, cleanTag(tagCode), String(slot || '').trim() || null]
  );
  return rows[0];
}

// Key events aren't copied into the audit log: a busy store produces
// hundreds a day, and their history already lives in key_events (and in
// the key machine itself).
//
// Records one key event and, unless it's older than what's already been
// applied (events can arrive late or out of order from a key machine),
// moves the key to its new status.
//
//   event: { action, source, externalEventId, personUserId, personName, slot, occurredAt, raw }
// Returns { duplicate: true } if this exact machine event was already received.
async function applyEvent(q, who, key, event) {
  const occurredAt = event.occurredAt || new Date();
  const { rows: inserted } = await q.query(
    `INSERT INTO key_events
       (dealership_id, key_id, car_id, action, source, external_event_id, person_user_id, person_name, slot, occurred_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dealership_id, source, external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [who.dealershipId, key.id, key.car_id, event.action, event.source || 'manual', event.externalEventId || null,
      event.personUserId || null, event.personName || null, event.slot || null, occurredAt, event.raw || null]
  );
  if (!inserted.length) return { duplicate: true };

  const isLatest = !key.last_event_at || new Date(occurredAt) >= new Date(key.last_event_at);
  if (isLatest) {
    const holding = event.action === 'check_out';
    await q.query(
      `UPDATE vehicle_keys SET status = $2, holder_user_id = $3, holder_name = $4,
         slot = COALESCE($5, slot), status_since = $6, last_event_at = $6
       WHERE id = $1`,
      [key.id, event.action === 'check_in' ? 'in' : event.action === 'check_out' ? 'out' : 'missing',
        holding ? event.personUserId || null : null, holding ? event.personName || null : null,
        event.action === 'check_in' ? event.slot || null : null, occurredAt]
    );
  }

  return { applied: isLatest };
}

// ---------- Integration tokens (for key machines and other systems) ----------

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function createToken(q, who, name) {
  const token = `crm_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows } = await q.query(
    `INSERT INTO integration_tokens (dealership_id, name, token_hash, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, name, created_at`,
    [who.dealershipId, name, sha256(token), who.user ? who.user.id : null]
  );
  await audit.record(q, who, { action: 'create', entityType: 'integration', entityId: rows[0].id, label: name, details: 'Integration token created' });
  return { ...rows[0], token };
}

// The dealership + token for a request's "Authorization: Bearer <token>"
// header, or null.
async function authenticateToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const { rows } = await store.pool.query(
    `UPDATE integration_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, dealership_id, name`,
    [sha256(match[1])]
  );
  return rows[0] || null;
}

// ---------- Events from a key machine ----------

// Finds the key an incoming machine event is about:
//   1. a key with that tag code;
//   2. otherwise the car by stock # or VIN -- its only key, or a new key
//      carrying the event's tag code if the car has none with that tag.
// Returns { key, car } or null when it can't be tied to a car.
async function matchEvent(q, dealershipId, { tagCode, stockNumber, vin }) {
  if (tagCode) {
    const { rows } = await q.query(
      `SELECT k.*, c.data AS car FROM vehicle_keys k
       JOIN cars c ON c.dealership_id = k.dealership_id AND c.id = k.car_id
       WHERE k.dealership_id = $1 AND lower(k.tag_code) = lower($2) FOR UPDATE OF k`,
      [dealershipId, tagCode]
    );
    if (rows[0]) return { key: rows[0], car: rows[0].car };
  }

  const stock = String(stockNumber || '').trim();
  const cleanVin = String(vin || '').toUpperCase().replace(/[\s-]/g, '');
  if (!stock && !cleanVin) return null;
  const { rows: cars } = await q.query(
    `SELECT data FROM cars WHERE dealership_id = $1 AND (
       ($2 <> '' AND lower(data->>'stockNumber') = lower($2)) OR ($3 <> '' AND upper(data->>'vin') = $3))`,
    [dealershipId, stock, cleanVin]
  );
  if (cars.length !== 1) return null; // unknown, or ambiguous
  const car = cars[0].data;

  const { rows: carKeys } = await q.query(
    'SELECT * FROM vehicle_keys WHERE dealership_id = $1 AND car_id = $2 ORDER BY created_at FOR UPDATE',
    [dealershipId, car.id]
  );
  if (!tagCode) {
    if (carKeys.length === 1) return { key: carKeys[0], car };
    if (carKeys.length > 1) return null; // which key? needs a tag code
    return { key: null, car };
  }
  // A tag we haven't seen: if the car's only key has no tag yet, that's the
  // one -- give it this tag. Otherwise it's another key for this car.
  if (carKeys.length === 1 && !carKeys[0].tag_code) {
    await q.query('UPDATE vehicle_keys SET tag_code = $2 WHERE id = $1', [carKeys[0].id, tagCode]);
    return { key: { ...carKeys[0], tag_code: tagCode }, car };
  }
  return { key: null, car, createWithTag: tagCode };
}

// Validates and normalizes one incoming event. Returns { event } or { error }.
function parseMachineEvent(body, sourceName) {
  const b = body || {};
  const action = normalizeAction(b.action);
  if (!action) return { error: 'action must be check_out, check_in, or missing.' };
  if (!b.tagCode && !b.stockNumber && !b.vin) return { error: 'Include tagCode, stockNumber, or vin so the key can be matched to a car.' };

  let occurredAt = new Date();
  if (b.occurredAt) {
    occurredAt = new Date(b.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) return { error: 'occurredAt must be a date and time, e.g. 2026-09-24T14:05:00Z.' };
    if (occurredAt > new Date(Date.now() + 5 * 60 * 1000)) occurredAt = new Date(); // machine clock ahead: use now
  }
  return {
    event: {
      action,
      source: String(b.source || sourceName || 'key machine').slice(0, 60),
      externalEventId: b.eventId ? String(b.eventId).slice(0, 200) : null,
      tagCode: cleanTag(b.tagCode),
      stockNumber: b.stockNumber,
      vin: b.vin,
      personName: b.personName ? String(b.personName).slice(0, 120) : null,
      personEmail: b.personEmail ? String(b.personEmail).trim().toLowerCase() : null,
      slot: b.slot ? String(b.slot).slice(0, 40) : null,
      occurredAt,
      raw: b
    }
  };
}

async function ingestMachineEvent(tokenRow, body) {
  const parsed = parseMachineEvent(body, tokenRow.name);
  if (parsed.error) return { status: 400, body: { error: parsed.error } };
  try {
    return await ingestParsedEvent(tokenRow, parsed.event);
  } catch (err) {
    // Two events for a brand-new key tag arriving at the same moment can
    // both try to create the key; the second one just needs to retry and
    // will find the key the first one made.
    if (err.code === '23505') return ingestParsedEvent(tokenRow, parsed.event);
    throw err;
  }
}

async function ingestParsedEvent(tokenRow, event) {
  const who = { dealershipId: tokenRow.dealership_id };

  return store.tx(async q => {
    // The person, if the machine knows their email and they're a CRM user.
    if (event.personEmail) {
      const { rows } = await q.query(
        'SELECT id, name FROM users WHERE dealership_id = $1 AND email = $2', [who.dealershipId, event.personEmail]);
      if (rows[0]) {
        event.personUserId = rows[0].id;
        event.personName = event.personName || rows[0].name;
      }
    }

    const match = await matchEvent(q, who.dealershipId, event);
    if (!match) {
      const { rows } = await q.query(
        `INSERT INTO key_events (dealership_id, action, source, external_event_id, person_user_id, person_name, slot, occurred_at, matched, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
         ON CONFLICT (dealership_id, source, external_event_id) WHERE external_event_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [who.dealershipId, event.action, event.source, event.externalEventId, event.personUserId || null,
          event.personName, event.slot, event.occurredAt, event.raw]
      );
      if (!rows.length) return { status: 200, body: { status: 'duplicate' } };
      return { status: 202, body: { status: 'unmatched', message: 'Saved for review: no car in inventory matches this key.' } };
    }

    let { key, car } = match;
    if (!key) key = await addKey(q, who, car, { tagCode: match.createWithTag });
    const result = await applyEvent(q, who, key, event);
    if (result.duplicate) return { status: 200, body: { status: 'duplicate' } };
    return { status: 200, body: { status: result.applied ? 'applied' : 'recorded_late', keyId: key.id, carId: car.id } };
  });
}

// Events that couldn't be matched to a car, for an admin to sort out.
async function listUnmatched(dealershipId) {
  const { rows } = await store.pool.query(
    `SELECT id, action, source, person_name, slot, occurred_at, received_at, raw FROM key_events
     WHERE dealership_id = $1 AND NOT matched ORDER BY received_at DESC LIMIT 100`,
    [dealershipId]
  );
  return rows.map(r => ({
    id: Number(r.id), action: r.action, source: r.source, personName: r.person_name, slot: r.slot,
    at: r.occurred_at, receivedAt: r.received_at,
    tagCode: r.raw && r.raw.tagCode, stockNumber: r.raw && r.raw.stockNumber, vin: r.raw && r.raw.vin
  }));
}

module.exports = {
  normalizeAction,
  listKeys,
  createToken,
  authenticateToken,
  ingestMachineEvent,
  listUnmatched
};
