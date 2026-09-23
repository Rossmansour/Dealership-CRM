// Shared setup for the API tests: a fresh database, a running server,
// and helpers to create users and make signed-in requests.
//
// WARNING: this wipes every table in the TEST_DATABASE_URL database.

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || 'test-only-key-0123456789abcdef0123456789';

const store = require('../db');
const auth = require('../auth');
const { app, bootstrap } = require('../server');

let server;
let base;

async function startServer() {
  await store.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await bootstrap();
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  return base;
}

async function stopServer() {
  server.close();
  await store.pool.end();
}

// Sends an API request (path is relative to /api), optionally as a
// signed-in user (pass their cookie).
async function api(method, path, body, cookie) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

// Requests a page (not the API) without following redirects.
async function page(path, cookie) {
  const res = await fetch(`${base}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual'
  });
  return { status: res.status, location: res.headers.get('location') };
}

async function defaultDealershipId() {
  const { rows } = await store.pool.query('SELECT id FROM dealerships ORDER BY created_at LIMIT 1');
  return rows[0].id;
}

let userCounter = 0;

// Creates a user directly in the database and returns them with a
// signed-in session cookie.
async function createUser(role, { dealershipId, password = 'password123' } = {}) {
  userCounter += 1;
  const email = `${role}${userCounter}@example.com`;
  const { rows } = await store.pool.query(
    `INSERT INTO users (dealership_id, name, email, role, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [dealershipId || await defaultDealershipId(), `Test ${role} ${userCounter}`, email, role, await auth.hashPassword(password)]
  );
  const cookie = await login(email, password);
  return { id: rows[0].id, email, password, cookie };
}

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) return null;
  return res.headers.get('set-cookie').split(';')[0];
}

module.exports = { store, auth, bootstrap, startServer, stopServer, api, page, createUser, login, defaultDealershipId };
