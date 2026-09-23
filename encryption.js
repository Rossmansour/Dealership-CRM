// encryption.js
// Encrypts the most sensitive credit application fields (SSN, driver's
// license number) before they're written to the database, and decrypts
// them when they're read back. Every signed-in user still sees the full
// values in the app -- this protects against someone reading the database
// directly (a leaked connection string, a backup, a hosting-side breach),
// who would only see scrambled text without the app's key.
//
// AES-256-GCM, with the key taken from the DATA_ENCRYPTION_KEY environment
// variable. Losing that key means the encrypted values can never be read
// again, so it must be kept somewhere safe outside this server.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SENSITIVE_APPLICANT_FIELDS = ['ssn', 'licenseNumber'];
const MIN_KEY_LENGTH = 32;

let key = null;

// Any sufficiently long random string works as the key (e.g. Render's
// "Generate" value); it's hashed down to exactly 32 bytes.
function getKey() {
  if (key) return key;
  const secret = process.env.DATA_ENCRYPTION_KEY || '';
  if (secret.length < MIN_KEY_LENGTH) {
    throw new Error(
      `DATA_ENCRYPTION_KEY must be set to a random value at least ${MIN_KEY_LENGTH} characters long. ` +
      'It encrypts SSNs and license numbers in the database. See "Setting up encryption" in the README.'
    );
  }
  key = crypto.createHash('sha256').update(secret).digest();
  return key;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(value) {
  if (value === null || value === undefined || value === '' || isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map(b => b.toString('base64')).join(':');
}

// Values saved before encryption existed are plain text; those pass
// through unchanged (and get encrypted on startup -- see bootstrap()).
function decrypt(value) {
  if (!isEncrypted(value)) return value;
  const [iv, tag, ciphertext] = value.slice(PREFIX.length).split(':').map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function mapApplicants(deal, fn) {
  if (!deal || !deal.creditApp) return deal;
  const mapApplicant = applicant => {
    if (!applicant) return applicant;
    const out = { ...applicant };
    for (const field of SENSITIVE_APPLICANT_FIELDS) {
      if (field in out) out[field] = fn(out[field]);
    }
    return out;
  };
  return {
    ...deal,
    creditApp: {
      ...deal.creditApp,
      applicant: mapApplicant(deal.creditApp.applicant),
      coApplicant: mapApplicant(deal.creditApp.coApplicant)
    }
  };
}

// A deal as it should be stored / as it should be used by the app.
const sealDeal = deal => mapApplicants(deal, encrypt);
const openDeal = deal => mapApplicants(deal, decrypt);

// True if a stored deal still has a sensitive field in plain text.
function needsSealing(deal) {
  if (!deal || !deal.creditApp) return false;
  return [deal.creditApp.applicant, deal.creditApp.coApplicant].some(a =>
    a && SENSITIVE_APPLICANT_FIELDS.some(f => a[f] && !isEncrypted(a[f])));
}

module.exports = {
  SENSITIVE_APPLICANT_FIELDS,
  getKey,
  encrypt,
  decrypt,
  isEncrypted,
  sealDeal,
  openDeal,
  needsSealing
};
