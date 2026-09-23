// db.js
// Postgres storage layer. Every record belongs to a dealership
// (dealership_id), so one install can serve many stores without them
// ever seeing each other's data.
//
// Records are stored one row per car / lead / deal / tax rate, with the
// record itself in a JSONB `data` column. That keeps the API shape exactly
// what the frontend already expects. Unlike the old single JSON file, data
// survives redeploys on hosts with a wiped disk (like Render), a save only
// touches the one record it changes, and read-then-write updates run in
// transactions with row locks, so they stay safe with several server
// instances. Individual fields can be promoted to real columns later as
// reporting needs them.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Add your Postgres connection string to .env ' +
    '(locally) or to the web service\'s Environment tab (on Render). See README.'
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A dropped idle connection (e.g. the database restarting) shouldn't take
// the whole server down -- the pool reconnects on the next query.
pool.on('error', err => console.error('Postgres connection error:', err.message));

// ---------- Schema migrations ----------
// Each entry runs exactly once per database, in order, tracked in
// schema_migrations. Never edit a migration that has already shipped --
// add a new one to the end instead.
const MIGRATIONS = [
  `
  CREATE TABLE dealerships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    next_deal_number integer NOT NULL DEFAULT 1001,
    tax_rates_version integer NOT NULL DEFAULT 0,
    imported_from_json_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE cars (
    dealership_id uuid NOT NULL REFERENCES dealerships(id) ON DELETE CASCADE,
    id text NOT NULL,
    seq bigserial,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dealership_id, id)
  );

  CREATE TABLE leads (
    dealership_id uuid NOT NULL REFERENCES dealerships(id) ON DELETE CASCADE,
    id text NOT NULL,
    seq bigserial,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dealership_id, id)
  );

  CREATE TABLE deals (
    dealership_id uuid NOT NULL REFERENCES dealerships(id) ON DELETE CASCADE,
    id text NOT NULL,
    seq bigserial,
    deal_number integer NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dealership_id, id),
    UNIQUE (dealership_id, deal_number)
  );

  CREATE TABLE tax_rates (
    dealership_id uuid NOT NULL REFERENCES dealerships(id) ON DELETE CASCADE,
    id text NOT NULL,
    seq bigserial,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (dealership_id, id)
  );
  `,
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dealership_id uuid NOT NULL REFERENCES dealerships(id) ON DELETE CASCADE,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    role text NOT NULL,
    password_hash text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX sessions_user_id_idx ON sessions (user_id);
  `
];

async function migrate() {
  const client = await pool.connect();
  try {
    // Only one server instance should run migrations at a time.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[i]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`Applied database migration ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

// Runs fn(client) inside a transaction. Anything that reads a record and
// then writes it back (or touches two records together, like a deal and
// its car) should go through here.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Record tables (cars, leads, deals, tax_rates) ----------
// Every function takes `q` -- either the pool or a transaction client --
// plus the dealership the request is acting for.

const RECORD_TABLES = new Set(['cars', 'leads', 'deals', 'tax_rates']);

function checkTable(table) {
  if (!RECORD_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
}

async function list(q, table, dealershipId) {
  checkTable(table);
  const { rows } = await q.query(
    `SELECT data FROM ${table} WHERE dealership_id = $1 ORDER BY seq`,
    [dealershipId]
  );
  return rows.map(r => r.data);
}

// Pass { forUpdate: true } inside tx() to lock the row until the
// transaction ends, so a concurrent save waits instead of being lost.
async function get(q, table, dealershipId, id, { forUpdate = false } = {}) {
  checkTable(table);
  const { rows } = await q.query(
    `SELECT data FROM ${table} WHERE dealership_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [dealershipId, id]
  );
  return rows[0] ? rows[0].data : null;
}

async function insert(q, table, dealershipId, record) {
  checkTable(table);
  if (table === 'deals') {
    await q.query(
      'INSERT INTO deals (dealership_id, id, deal_number, data) VALUES ($1, $2, $3, $4)',
      [dealershipId, record.id, record.dealNumber, record]
    );
  } else {
    await q.query(
      `INSERT INTO ${table} (dealership_id, id, data) VALUES ($1, $2, $3)`,
      [dealershipId, record.id, record]
    );
  }
  return record;
}

// Overwrites the stored record. The id always comes from the URL/row,
// never from the incoming body, so a stray "id" field can't re-point it.
async function save(q, table, dealershipId, id, record) {
  checkTable(table);
  const data = { ...record, id };
  await q.query(
    `UPDATE ${table} SET data = $3, updated_at = now() WHERE dealership_id = $1 AND id = $2`,
    [dealershipId, id, data]
  );
  return data;
}

// Returns true if a row was deleted, false if it didn't exist.
async function remove(q, table, dealershipId, id) {
  checkTable(table);
  const { rowCount } = await q.query(
    `DELETE FROM ${table} WHERE dealership_id = $1 AND id = $2`,
    [dealershipId, id]
  );
  return rowCount > 0;
}

// ---------- Dealerships ----------

async function getDealership(q, dealershipId) {
  const { rows } = await q.query('SELECT * FROM dealerships WHERE id = $1', [dealershipId]);
  return rows[0] || null;
}

async function saveSettings(q, dealershipId, settings) {
  await q.query('UPDATE dealerships SET settings = $2 WHERE id = $1', [dealershipId, settings]);
  return settings;
}

// Hands out the next deal number atomically -- two desks creating a deal
// at the same moment can never get the same number.
async function takeNextDealNumber(q, dealershipId) {
  const { rows } = await q.query(
    `UPDATE dealerships SET next_deal_number = next_deal_number + 1
     WHERE id = $1 RETURNING next_deal_number - 1 AS deal_number`,
    [dealershipId]
  );
  return rows[0].deal_number;
}

module.exports = {
  pool,
  migrate,
  tx,
  list,
  get,
  insert,
  save,
  remove,
  getDealership,
  saveSettings,
  takeNextDealNumber
};
