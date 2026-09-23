// auth.js
// Logins, sessions, roles, and user management.
//
// - Passwords are hashed with scrypt (built into Node) -- never stored or
//   logged in plain text.
// - Signing in creates a random session token. The browser keeps it in an
//   httpOnly cookie (page scripts can't read it); the database only keeps
//   a SHA-256 hash of it, so a leaked database can't be used to log in.
// - Every user belongs to exactly one dealership. The middleware sets
//   req.dealershipId from the signed-in user, which is what keeps each
//   store's data separate.

const crypto = require('crypto');
const express = require('express');
const store = require('./db');

const SESSION_COOKIE = 'crm_session';
const SESSION_HOURS = 12; // roughly one working day, then sign in again
const MIN_PASSWORD_LENGTH = 8;

// Role keys stored in the database, and the names shown on screen.
const ROLES = {
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  salesperson: 'Salesperson',
  finance: 'F&I Manager'
};

// Which roles can do the actions that aren't open to everyone. Anything
// not listed here is available to every signed-in user. Changing who can
// do what means editing this table only.
const PERMISSIONS = {
  editInventory: ['admin', 'sales_manager'],   // add/edit/delete cars and photos
  deleteRecords: ['admin', 'sales_manager'],   // delete leads, deals, activity log entries
  editSettings: ['admin'],                     // fee defaults and tax rate tables
  manageUsers: ['admin']
};

function can(user, permission) {
  return !!user && PERMISSIONS[permission].includes(user.role);
}

// ---------- Passwords ----------

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise(resolve => {
    const [scheme, saltHex, keyHex] = (stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !keyHex) return resolve(false);
    const expected = Buffer.from(keyHex, 'hex');
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, (err, key) => {
      resolve(!err && crypto.timingSafeEqual(key, expected));
    });
  });
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

// ---------- Sessions ----------

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), userId, SESSION_HOURS]
  );
  await store.pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  // Housekeeping: clear out sessions that have already expired.
  await store.pool.query('DELETE FROM sessions WHERE expires_at < now()');
  setSessionCookie(req, res, token, SESSION_HOURS * 3600);
}

// The signed-in, active user for this request, or null.
async function userFromRequest(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const { rows } = await store.pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)]
  );
  return rows[0] || null;
}

// What the browser is allowed to see about a user -- never the hash.
function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLES[u.role] || u.role,
    active: u.active,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    permissions: Object.keys(PERMISSIONS).filter(p => can(u, p))
  };
}

// ---------- Brute-force protection ----------
// After too many failed sign-ins for one account from one address, further
// attempts are refused for a while. Counting per account (not just per
// address) means a showroom sharing one internet connection isn't locked
// out because a few people mistyped. Kept in memory: it resets on restart,
// which is fine for slowing down password guessing.

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedLogins = new Map(); // 'ip|email' -> { count, firstAt }

function isLockedOut(key) {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(key) {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedLogins.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

// ---------- First admin account ----------
// A brand-new install has no users, so nobody could sign in. Instead of
// leaving an open "create admin" page on the internet, startup prints a
// one-time setup link to the server logs, which only the owner of the
// hosting account can read.

let setupToken = null;

async function countUsers() {
  const { rows } = await store.pool.query('SELECT count(*)::int AS n FROM users');
  return rows[0].n;
}

async function announceSetupIfNeeded(baseUrl) {
  if ((await countUsers()) > 0) {
    setupToken = null;
    return null;
  }
  setupToken = crypto.randomBytes(24).toString('hex');
  const link = `${baseUrl}/login.html?setup=${setupToken}`;
  console.log('');
  console.log('No user accounts exist yet. To create the first admin account, open:');
  console.log(`  ${link}`);
  console.log('This link works once, and a new one is printed each time the server restarts until an admin exists.');
  console.log('');
  return setupToken;
}

// ---------- Middleware ----------

// Routes under /api that work without being signed in.
const PUBLIC_API_PATHS = new Set(['/auth/login', '/auth/logout', '/auth/setup', '/auth/setup-status']);

async function requireLogin(req, res, next) {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  try {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    req.user = user;
    req.dealershipId = user.dealership_id;
    next();
  } catch (err) {
    next(err);
  }
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (can(req.user, permission)) return next();
    res.status(403).json({ error: "Your role doesn't allow this. Ask an admin if you need access." });
  };
}

// For the app's HTML page: send signed-out visitors to the login page
// instead of showing an empty app shell.
async function requireLoginForPage(req, res, next) {
  try {
    if (await userFromRequest(req)) return next();
    res.redirect('/login.html');
  } catch (err) {
    next(err);
  }
}

// ---------- Routes ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const normalizeEmail = email => String(email || '').trim().toLowerCase();

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const attemptKey = `${req.ip}|${normalizeEmail(email)}`;
  if (isLockedOut(attemptKey)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
  }

  const { rows } = await store.pool.query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
  const user = rows[0];
  const ok = user && user.active && await verifyPassword(String(password || ''), user.password_hash);
  if (!ok) {
    recordFailedLogin(attemptKey);
    // Same message whether the email exists or not, so it can't be used
    // to discover who has an account.
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  failedLogins.delete(attemptKey);
  await startSession(req, res, user.id);
  res.json(publicUser(user));
}));

router.post('/auth/logout', wrap(async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await store.pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(req, res, '', 0);
  res.status(204).send();
}));

router.get('/auth/setup-status', wrap(async (req, res) => {
  res.json({ needsSetup: (await countUsers()) === 0 });
}));

router.post('/auth/setup', wrap(async (req, res) => {
  const { token, name, email, password } = req.body || {};
  const tokenOk = setupToken && typeof token === 'string' && token.length === setupToken.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(setupToken));
  if (!tokenOk) {
    return res.status(403).json({ error: 'This setup link is invalid or has already been used. Check the server logs for the current link.' });
  }
  if (!name || !normalizeEmail(email)) return res.status(400).json({ error: 'Name and email are required.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  const user = await store.tx(async q => {
    await q.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const { rows: existing } = await q.query('SELECT 1 FROM users LIMIT 1');
    if (existing.length) return null;
    const { rows: dealerships } = await q.query('SELECT id FROM dealerships ORDER BY created_at LIMIT 1');
    const { rows } = await q.query(
      `INSERT INTO users (dealership_id, name, email, role, password_hash)
       VALUES ($1, $2, $3, 'admin', $4) RETURNING *`,
      [dealerships[0].id, String(name).trim(), normalizeEmail(email), await hashPassword(password)]
    );
    return rows[0];
  });
  if (!user) return res.status(409).json({ error: 'An admin account already exists. Please sign in.' });

  setupToken = null;
  await startSession(req, res, user.id);
  res.status(201).json(publicUser(user));
}));

router.get('/auth/me', (req, res) => {
  res.json(publicUser(req.user));
});

router.post('/auth/change-password', wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!await verifyPassword(String(currentPassword || ''), req.user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  await store.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1',
    [req.user.id, await hashPassword(newPassword)]);
  // Sign out everywhere else, keep this browser signed in.
  const token = readCookie(req, SESSION_COOKIE);
  await store.pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
    [req.user.id, sha256(token)]);
  res.status(204).send();
}));

// ----- User management (admins only, within their own dealership) -----

router.get('/users', requirePermission('manageUsers'), wrap(async (req, res) => {
  const { rows } = await store.pool.query(
    'SELECT * FROM users WHERE dealership_id = $1 ORDER BY active DESC, name',
    [req.dealershipId]
  );
  res.json(rows.map(publicUser));
}));

router.post('/users', requirePermission('manageUsers'), wrap(async (req, res) => {
  const { name, email, role, password } = req.body || {};
  if (!name || !normalizeEmail(email)) return res.status(400).json({ error: 'Name and email are required.' });
  if (!ROLES[role]) return res.status(400).json({ error: 'Pick a valid role.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const { rows } = await store.pool.query(
      `INSERT INTO users (dealership_id, name, email, role, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.dealershipId, String(name).trim(), normalizeEmail(email), role, await hashPassword(password)]
    );
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Someone already has an account with that email.' });
    throw err;
  }
}));

// Update name, role, active status, and/or set a new password.
router.put('/users/:id', requirePermission('manageUsers'), wrap(async (req, res) => {
  const { name, role, active, password } = req.body || {};
  if (role !== undefined && !ROLES[role]) return res.status(400).json({ error: 'Pick a valid role.' });
  if (password !== undefined) {
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
  }
  const passwordHash = password !== undefined ? await hashPassword(password) : null;

  const result = await store.tx(async q => {
    const { rows } = await q.query(
      'SELECT * FROM users WHERE id::text = $1 AND dealership_id = $2 FOR UPDATE',
      [req.params.id, req.dealershipId]
    );
    const user = rows[0];
    if (!user) return { status: 404, error: 'User not found.' };

    const next = {
      name: name !== undefined ? String(name).trim() : user.name,
      role: role !== undefined ? role : user.role,
      active: active !== undefined ? !!active : user.active
    };

    // Never leave a dealership without an active admin -- nobody would be
    // able to manage users or settings.
    const losingAdmin = user.role === 'admin' && user.active && (next.role !== 'admin' || !next.active);
    if (losingAdmin) {
      const { rows: admins } = await q.query(
        `SELECT count(*)::int AS n FROM users
         WHERE dealership_id = $1 AND role = 'admin' AND active AND id <> $2`,
        [req.dealershipId, user.id]
      );
      if (admins[0].n === 0) return { status: 400, error: 'This is the only active admin. Make someone else an admin first.' };
    }

    const { rows: updated } = await q.query(
      `UPDATE users SET name = $2, role = $3, active = $4, password_hash = COALESCE($5, password_hash)
       WHERE id = $1 RETURNING *`,
      [user.id, next.name, next.role, next.active, passwordHash]
    );
    // Deactivating someone or resetting their password signs them out.
    if (!next.active || passwordHash) {
      await q.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    }
    return { user: updated[0] };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(publicUser(result.user));
}));

module.exports = {
  ROLES,
  PERMISSIONS,
  router,
  requireLogin,
  requirePermission,
  requireLoginForPage,
  announceSetupIfNeeded,
  hashPassword
};
