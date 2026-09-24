// server.js
// Simple Express backend for a Car Dealership Inventory + CRM tool.
// Data lives in Postgres (see db.js). Every record belongs to a
// dealership, so the same install can serve multiple stores.

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const encryption = require('./encryption');
const vinDecoder = require('./vin');
const photos = require('./photos');
const keys = require('./keys');
const providers = require('./providers');

const app = express();
const PORT = process.env.PORT || 3000;
// Legacy JSON data file. Only read once, on first startup against an
// empty database, to carry existing data over into Postgres.
const LEGACY_JSON_PATH = path.join(__dirname, 'data', 'db.json');

// ---------- AI provider config ----------
// Everything AI-related funnels through the single callAI() function below.
// Swapping providers later (e.g. to OpenAI or Anthropic) only means
// rewriting that one function -- nothing else in this file needs to change.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// ---------- SMS (Twilio) config ----------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// ---------- Photo uploads ----------
// Uploads are held in memory just long enough to hand to photos.js, which
// stores them in Cloudinary (or on local disk when Cloudinary isn't set
// up). Up to 8 photos of 5MB each per upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    if (!photos.ALLOWED_TYPES.has(file.mimetype)) {
      const err = new Error('Photos must be JPEG, PNG, WebP, GIF, or HEIC images.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

// Render (and most hosts) sit behind a proxy -- this lets Express see the
// real https scheme and client IP, needed for secure cookies and for the
// failed-login lockout.
app.set('trust proxy', 1);

app.use(express.json());

// The app page itself requires signing in; the login page, styles, and
// car photos stay public (Twilio needs to fetch photos to send MMS).
app.get(['/', '/index.html'], auth.requireLoginForPage);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Request plumbing ----------

// Bumping this re-seeds every dealership's tax rate table from
// seedTaxRates() on next startup, rather than treating "some rates already
// exist" as "nothing to do." This is what closes the original bug: a stale,
// partially-seeded tax table from an earlier version silently persisted
// forever because the old check only asked "is it missing?", not "is it
// current?".
const TAX_RATES_SEED_VERSION = 2;

// Every /api route except signing in requires a signed-in user, and acts
// for that user's dealership (req.dealershipId).
app.use('/api', auth.requireLogin);
app.use('/api', auth.router);

// Shorthand for routes limited to certain roles (see PERMISSIONS in auth.js).
const allow = auth.requirePermission;

// The dealership that data/db.json is imported into and that the first
// admin account is created in.
let defaultDealershipId = null;

// Express 4 doesn't catch errors thrown from async handlers on its own --
// this forwards them to the JSON error handler at the bottom of the file
// instead of leaving the request hanging.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Fields the server manages itself. Edits sent from the browser can't
// overwrite them -- e.g. a lead's activity history only changes through
// the activity routes, so it (and its audit trail) can't be rewritten by
// a general "update lead" request.
const SERVER_MANAGED_FIELDS = {
  cars: ['id', 'photos', 'openROs', 'dateAdded', 'dateSold', 'sourceAppraisalId'],
  // Road to the Sale steps change through /roadmap; the customer number is assigned once.
  leads: ['id', 'activities', 'dateAdded', 'customerNumber', 'roadmap'],
  deals: ['id', 'dealNumber', 'creditApp', 'dateCreated'],
  tax_rates: ['id'],
  // Status changes go through /acquire, /lost, and /reopen; recalls through /recalls.
  // The appraiser changes through "appraiserId"; customer offers through /customer-offer.
  appraisals: ['id', 'appraisalNumber', 'dateCreated', 'appraisedBy', 'status', 'recalls',
    'carId', 'acquiredFor', 'acquiredAt', 'lostReason', 'closedAt', 'offerHistory', 'customerOffers']
};

function editableFields(table, body) {
  const out = { ...(body || {}) };
  for (const field of SERVER_MANAGED_FIELDS[table]) delete out[field];
  return out;
}

async function getSettings(q, dealershipId) {
  const dealership = await store.getDealership(q, dealershipId);
  return { ...defaultFeeSettings(), ...(dealership ? dealership.settings : {}) };
}

// Store-level fee defaults. These are the numbers a dealership charges
// (almost) every customer, so new deals should start with them already
// filled in instead of a blank/arbitrary number a rep has to remember to
// enter every single time. Editable via /api/settings -- not yet
// restricted to admins (that access-control layer is planned but out of
// scope for this pass; today anyone can edit these).
function defaultFeeSettings() {
  return {
    docFee: 85,
    titleFee: 75,
    registrationFee: 50,
    licenseFee: 0,
    dealerFees: 0,
    acquisitionFee: 595,
    taxRate: 7,
    // DMV/registration fee calculation is a documented simplification, not
    // an attempt to replicate any specific state's real fee schedule --
    // actual DMV fees vary by state and can involve vehicle weight, county,
    // or age-based depreciation tables. "flat" uses registrationFee as-is
    // (the default); "percentage" calculates it from the vehicle's price.
    dmvFeeMethod: 'flat', // 'flat' | 'percentage'
    dmvFeePercentage: 1.5,
    // Appraisal offer calculator: max offer = target retail - recon - pack - target gross
    appraisalPack: 0,
    appraisalTargetGross: 2500,
    // Road to the Sale: the 7 steps shown on each customer. Stores can rename them.
    roadmapLabels: ['Greet', 'Needs', 'Vehicle', 'Demo Drive', 'Trade', 'Write-up', 'Delivery']
  };
}

app.get('/api/settings', wrap(async (req, res) => {
  res.json(await getSettings(store.pool, req.dealershipId));
}));

app.put('/api/settings', allow('editSettings'), wrap(async (req, res) => {
  const settings = await store.tx(async q => {
    await q.query('SELECT 1 FROM dealerships WHERE id = $1 FOR UPDATE', [req.dealershipId]);
    const current = await getSettings(q, req.dealershipId);
    const incoming = { ...(req.body || {}) };
    if ('roadmapLabels' in incoming) {
      const labels = Array.isArray(incoming.roadmapLabels) ? incoming.roadmapLabels : [];
      incoming.roadmapLabels = Array.from({ length: ROADMAP_STEPS }, (_, i) =>
        String(labels[i] ?? '').trim().slice(0, 24) || defaultFeeSettings().roadmapLabels[i]);
    }
    const saved = await store.saveSettings(q, req.dealershipId, { ...current, ...incoming });
    await audit.updated(q, req, 'settings', { ...current, id: 'fee-defaults' }, { ...saved, id: 'fee-defaults' });
    return saved;
  });
  res.json(settings);
}));

// ---------- Tax Rates reference table (State / County / City) ----------
//
// This replaces a hardcoded formula-guess with the way real DMS platforms
// actually do it: an admin-configurable table a dealer sets up once, with
// separate State/County/City tax rate line items that sum to the combined
// rate. Seeded with a handful of real reference points derived from the
// same published CDTFA/ADOR rates the earlier formula version used, but
// now every number here is visible and editable, not buried in code.

function seedTaxRates() {
  return [
    { id: 'tr-ca-alameda', state: 'CA', county: 'Alameda', city: '', stateTaxRate: 7.25, countyTaxRate: 3.0, cityTaxRate: 0 },
    { id: 'tr-ca-alpine', state: 'CA', county: 'Alpine', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-amador', state: 'CA', county: 'Amador', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-butte', state: 'CA', county: 'Butte', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-calaveras', state: 'CA', county: 'Calaveras', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-colusa', state: 'CA', county: 'Colusa', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-contracosta', state: 'CA', county: 'Contra Costa', city: '', stateTaxRate: 7.25, countyTaxRate: 1.5, cityTaxRate: 0 },
    { id: 'tr-ca-delnorte', state: 'CA', county: 'Del Norte', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-eldorado', state: 'CA', county: 'El Dorado', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-fresno', state: 'CA', county: 'Fresno', city: '', stateTaxRate: 7.25, countyTaxRate: 0.725, cityTaxRate: 0 },
    { id: 'tr-ca-glenn', state: 'CA', county: 'Glenn', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-humboldt', state: 'CA', county: 'Humboldt', city: '', stateTaxRate: 7.25, countyTaxRate: 1.5, cityTaxRate: 0 },
    { id: 'tr-ca-imperial', state: 'CA', county: 'Imperial', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-inyo', state: 'CA', county: 'Inyo', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-kern', state: 'CA', county: 'Kern', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-kings', state: 'CA', county: 'Kings', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-lake', state: 'CA', county: 'Lake', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-lassen', state: 'CA', county: 'Lassen', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-losangeles', state: 'CA', county: 'Los Angeles', city: '', stateTaxRate: 7.25, countyTaxRate: 2.5, cityTaxRate: 0 },
    { id: 'tr-ca-madera', state: 'CA', county: 'Madera', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-marin', state: 'CA', county: 'Marin', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-mariposa', state: 'CA', county: 'Mariposa', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-mendocino', state: 'CA', county: 'Mendocino', city: '', stateTaxRate: 7.25, countyTaxRate: 0.625, cityTaxRate: 0 },
    { id: 'tr-ca-merced', state: 'CA', county: 'Merced', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-modoc', state: 'CA', county: 'Modoc', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-mono', state: 'CA', county: 'Mono', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-monterey', state: 'CA', county: 'Monterey', city: '', stateTaxRate: 7.25, countyTaxRate: 1.5, cityTaxRate: 0 },
    { id: 'tr-ca-napa', state: 'CA', county: 'Napa', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-nevada', state: 'CA', county: 'Nevada', city: '', stateTaxRate: 7.25, countyTaxRate: 0.25, cityTaxRate: 0 },
    { id: 'tr-ca-orange', state: 'CA', county: 'Orange', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-placer', state: 'CA', county: 'Placer', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-plumas', state: 'CA', county: 'Plumas', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-riverside', state: 'CA', county: 'Riverside', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-sacramento', state: 'CA', county: 'Sacramento', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-sanbenito', state: 'CA', county: 'San Benito', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-sanbernardino', state: 'CA', county: 'San Bernardino', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-sandiego', state: 'CA', county: 'San Diego', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-sanfrancisco', state: 'CA', county: 'San Francisco', city: '', stateTaxRate: 7.25, countyTaxRate: 1.375, cityTaxRate: 0 },
    { id: 'tr-ca-sanjoaquin', state: 'CA', county: 'San Joaquin', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-sanluisobispo', state: 'CA', county: 'San Luis Obispo', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-sanmateo', state: 'CA', county: 'San Mateo', city: '', stateTaxRate: 7.25, countyTaxRate: 2.125, cityTaxRate: 0 },
    { id: 'tr-ca-santabarbara', state: 'CA', county: 'Santa Barbara', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-santaclara', state: 'CA', county: 'Santa Clara', city: '', stateTaxRate: 7.25, countyTaxRate: 2.5, cityTaxRate: 0 },
    { id: 'tr-ca-santacruz', state: 'CA', county: 'Santa Cruz', city: '', stateTaxRate: 7.25, countyTaxRate: 2.25, cityTaxRate: 0 },
    { id: 'tr-ca-shasta', state: 'CA', county: 'Shasta', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-sierra', state: 'CA', county: 'Sierra', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-siskiyou', state: 'CA', county: 'Siskiyou', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-solano', state: 'CA', county: 'Solano', city: '', stateTaxRate: 7.25, countyTaxRate: 0.125, cityTaxRate: 0 },
    { id: 'tr-ca-sonoma', state: 'CA', county: 'Sonoma', city: '', stateTaxRate: 7.25, countyTaxRate: 2.0, cityTaxRate: 0 },
    { id: 'tr-ca-stanislaus', state: 'CA', county: 'Stanislaus', city: '', stateTaxRate: 7.25, countyTaxRate: 0.625, cityTaxRate: 0 },
    { id: 'tr-ca-sutter', state: 'CA', county: 'Sutter', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-tehama', state: 'CA', county: 'Tehama', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-trinity', state: 'CA', county: 'Trinity', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-tulare', state: 'CA', county: 'Tulare', city: '', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-ca-tuolumne', state: 'CA', county: 'Tuolumne', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-ventura', state: 'CA', county: 'Ventura', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-yolo', state: 'CA', county: 'Yolo', city: '', stateTaxRate: 7.25, countyTaxRate: 0.0, cityTaxRate: 0 },
    { id: 'tr-ca-yuba', state: 'CA', county: 'Yuba', city: '', stateTaxRate: 7.25, countyTaxRate: 1.0, cityTaxRate: 0 },
    { id: 'tr-ca-default', state: 'CA', county: '', city: '', stateTaxRate: 7.25, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-apache', state: 'AZ', county: 'Apache', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-cochise', state: 'AZ', county: 'Cochise', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-coconino', state: 'AZ', county: 'Coconino', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-gila', state: 'AZ', county: 'Gila', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-graham', state: 'AZ', county: 'Graham', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-greenlee', state: 'AZ', county: 'Greenlee', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-lapaz', state: 'AZ', county: 'La Paz', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-maricopa', state: 'AZ', county: 'Maricopa', city: '', stateTaxRate: 5.6, countyTaxRate: 0.7, cityTaxRate: 0 },
    { id: 'tr-az-mohave', state: 'AZ', county: 'Mohave', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-navajo', state: 'AZ', county: 'Navajo', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-pima', state: 'AZ', county: 'Pima', city: '', stateTaxRate: 5.6, countyTaxRate: 0.5, cityTaxRate: 0 },
    { id: 'tr-az-pinal', state: 'AZ', county: 'Pinal', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-santacruz', state: 'AZ', county: 'Santa Cruz', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-yavapai', state: 'AZ', county: 'Yavapai', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-yuma', state: 'AZ', county: 'Yuma', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-az-default', state: 'AZ', county: '', city: '', stateTaxRate: 5.6, countyTaxRate: 0, cityTaxRate: 0 },
    { id: 'tr-ca-monterey-city', state: 'CA', county: 'Monterey', city: 'Monterey', stateTaxRate: 7.25, countyTaxRate: 0.5, cityTaxRate: 1.5 },
  ];
}

app.get('/api/tax-rates', wrap(async (req, res) => {
  const { state } = req.query;
  let rates = await store.list(store.pool, 'tax_rates', req.dealershipId);
  if (state) rates = rates.filter(r => r.state.toUpperCase() === state.toUpperCase());
  res.json(rates);
}));

app.post('/api/tax-rates', allow('editSettings'), wrap(async (req, res) => {
  const { state, county, city, stateTaxRate, countyTaxRate, cityTaxRate } = req.body;
  if (!state) return res.status(400).json({ error: 'state is required' });

  const newRate = {
    id: crypto.randomUUID(),
    state: state.toUpperCase(),
    county: county || '',
    city: city || '',
    stateTaxRate: Number(stateTaxRate) || 0,
    countyTaxRate: Number(countyTaxRate) || 0,
    cityTaxRate: Number(cityTaxRate) || 0
  };
  await store.tx(async q => {
    await store.insert(q, 'tax_rates', req.dealershipId, newRate);
    await audit.created(q, req, 'tax_rate', newRate);
  });
  res.status(201).json(newRate);
}));

app.put('/api/tax-rates/:id', allow('editSettings'), wrap(async (req, res) => {
  const updated = await store.tx(async q => {
    const rate = await store.get(q, 'tax_rates', req.dealershipId, req.params.id, { forUpdate: true });
    if (!rate) return null;
    const saved = await store.save(q, 'tax_rates', req.dealershipId, rate.id, { ...rate, ...editableFields('tax_rates', req.body) });
    await audit.updated(q, req, 'tax_rate', rate, saved);
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Tax rate not found' });
  res.json(updated);
}));

app.delete('/api/tax-rates/:id', allow('editSettings'), wrap(async (req, res) => {
  const deleted = await store.tx(async q => {
    const removed = await store.remove(q, 'tax_rates', req.dealershipId, req.params.id);
    if (removed) await audit.deleted(q, req, 'tax_rate', removed);
    return removed;
  });
  if (!deleted) return res.status(404).json({ error: 'Tax rate not found' });
  res.status(204).send();
}));

// Finds the best-matching reference record for a customer's address:
// exact state+county+city match first, then state+county with no city
// specified (a county-wide default), then a bare state-level default.
// Returns null if nothing at all matches that state.
function findBestTaxRateMatch(taxRates, state, county, city) {
  const normalizedState = (state || '').toUpperCase();
  const normalizedCounty = (county || '').trim();
  const normalizedCity = (city || '').trim();

  const inState = taxRates.filter(r => r.state === normalizedState);
  if (inState.length === 0) return null;

  const exact = inState.find(r => r.county === normalizedCounty && r.city && r.city === normalizedCity);
  if (exact) return exact;

  const countyMatch = inState.find(r => r.county === normalizedCounty && !r.city);
  if (countyMatch) return countyMatch;

  const stateDefault = inState.find(r => !r.county && !r.city);
  return stateDefault || inState[0];
}

// ---------- VIN decoder ----------

// Decodes a VIN into year/make/model/trim and specs (see vin.js), and says
// whether that VIN is already in this dealership's inventory so the same
// car isn't entered twice. Pass ?excludeCarId= when editing that car.
app.get('/api/vin/:vin', wrap(async (req, res) => {
  try {
    const decoded = await vinDecoder.decodeVin(req.params.vin);
    const cars = await store.list(store.pool, 'cars', req.dealershipId);
    const match = cars.find(c => vinDecoder.normalizeVin(c.vin) === decoded.vin && c.id !== req.query.excludeCarId);
    res.json({
      ...decoded,
      inInventory: match ? { id: match.id, label: audit.labelFor('car', match), status: match.status } : null
    });
  } catch (err) {
    if (err instanceof vinDecoder.VinError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// Details that describe the vehicle beyond make/model/year. Most are
// filled in by the VIN decoder; colors are entered by hand.
const CAR_DETAIL_FIELDS = ['trim', 'bodyStyle', 'drivetrain', 'engine', 'fuelType', 'transmission', 'exteriorColor', 'interiorColor'];

function carDetails(body) {
  const details = {};
  for (const field of CAR_DETAIL_FIELDS) details[field] = String(body[field] ?? '').trim();
  details.doors = Number(body.doors) || null;
  return details;
}

// ---------- CARS (Inventory) ----------

// GET all cars, with optional ?status= and ?search= filters
app.get('/api/cars', wrap(async (req, res) => {
  let cars = await store.list(store.pool, 'cars', req.dealershipId);

  const { status, search } = req.query;

  if (status) {
    cars = cars.filter(c => c.status === status);
  }

  if (search) {
    const term = search.toLowerCase();
    cars = cars.filter(c =>
      c.make.toLowerCase().includes(term) ||
      c.model.toLowerCase().includes(term) ||
      (c.vin || '').toLowerCase().includes(term)
    );
  }

  res.json(cars);
}));

// GET a single car by id
app.get('/api/cars/:id', wrap(async (req, res) => {
  const car = await store.get(store.pool, 'cars', req.dealershipId, req.params.id);
  if (!car) return res.status(404).json({ error: 'Car not found' });
  res.json(car);
}));

// POST a new car
// A new inventory car from form fields. Shared by "+ Add Car" and by
// acquiring an appraisal, so both create cars exactly the same way.
function buildCar(fields) {
  const { make, model, year, vin, stockNumber, mileage, cost, price, status } = fields;
  return {
    id: crypto.randomUUID(),
    make,
    model,
    year: Number(year),
    ...carDetails(fields),
    vin: vinDecoder.normalizeVin(vin),
    stockNumber: stockNumber || '',
    mileage: Number(mileage) || 0,
    cost: Number(cost) || 0,
    price: Number(price) || 0,
    status: status || 'available', // available | pending | sold
    photos: [], // array of paths like /uploads/cars/abc123.jpg
    openROs: [], // groundwork for the future Service module -- empty until Service exists
    dateAdded: new Date().toISOString(),
    dateSold: null
  };
}

app.post('/api/cars', allow('editInventory'), wrap(async (req, res) => {
  const { make, model, year, price } = req.body;

  if (!make || !model || !year || !price) {
    return res.status(400).json({ error: 'make, model, year, and price are required' });
  }

  const newCar = buildCar(req.body);

  await store.tx(async q => {
    await store.insert(q, 'cars', req.dealershipId, newCar);
    await audit.created(q, req, 'car', newCar);
  });
  res.status(201).json(newCar);
}));

// PUT (update) an existing car
app.put('/api/cars/:id', allow('editInventory'), wrap(async (req, res) => {
  const updated = await store.tx(async q => {
    const car = await store.get(q, 'cars', req.dealershipId, req.params.id, { forUpdate: true });
    if (!car) return null;

    const updates = editableFields('cars', req.body);
    // The edit form sends numbers as text; store real numbers, same as
    // when a car is added (otherwise dashboard totals add up "1" + "2" as "12").
    for (const field of ['year', 'mileage', 'cost', 'price']) {
      if (field in updates) updates[field] = Number(updates[field]) || 0;
    }
    if ('vin' in updates) updates.vin = vinDecoder.normalizeVin(updates.vin);
    if ('doors' in updates) updates.doors = Number(updates.doors) || null;

    // If status is changing to "sold" for the first time, stamp the date.
    if (updates.status === 'sold' && car.status !== 'sold') {
      updates.dateSold = new Date().toISOString();
    }

    const saved = await store.save(q, 'cars', req.dealershipId, car.id, { ...car, ...updates });
    await audit.updated(q, req, 'car', car, saved);
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Car not found' });
  res.json(updated);
}));

// DELETE a car
app.delete('/api/cars/:id', allow('editInventory'), wrap(async (req, res) => {
  const deleted = await store.tx(async q => {
    const removed = await store.remove(q, 'cars', req.dealershipId, req.params.id);
    if (removed) await audit.deleted(q, req, 'car', removed);
    return removed;
  });
  if (!deleted) return res.status(404).json({ error: 'Car not found' });
  await Promise.all((deleted.photos || []).map(photos.deletePhoto));
  res.status(204).send();
}));

// ---------- Car photos ----------

// Upload one or more photos for a car. Field name must be "photos".
app.post('/api/cars/:id/photos', allow('editInventory'), upload.array('photos', 8), wrap(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No photos were uploaded.' });
  }
  if (!await store.get(store.pool, 'cars', req.dealershipId, req.params.id)) {
    return res.status(404).json({ error: 'Car not found' });
  }
  // CLOUDINARY_URL is set but unusable: refuse rather than quietly saving
  // to a disk that the host wipes.
  if (photos.cloudinaryProblem()) {
    return res.status(503).json({ error: "Photo storage isn't set up correctly, so photos can't be uploaded right now. An admin needs to fix the CLOUDINARY_URL setting on the server." });
  }

  // Store the files first (a network call to Cloudinary), then record
  // them on the car in a short transaction.
  const results = await Promise.allSettled(req.files.map(file =>
    photos.savePhoto(file, { dealershipId: req.dealershipId, carId: req.params.id })));
  const newPaths = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failure = results.find(r => r.status === 'rejected');
  if (failure) {
    // All or nothing: don't leave half a batch stored but not on the car.
    await Promise.all(newPaths.map(photos.deletePhoto));
    console.error('Photo upload failed:', failure.reason);
    const { reason, hint } = failure.reason || {};
    return res.status(502).json({
      error: `Couldn't save the photos to storage${reason ? ` (Cloudinary says: ${reason})` : ''}.${hint ? ' ' + hint : ' Please try again.'}`
    });
  }

  const updated = await store.tx(async q => {
    const car = await store.get(q, 'cars', req.dealershipId, req.params.id, { forUpdate: true });
    if (!car) return null;
    const saved = await store.save(q, 'cars', req.dealershipId, car.id, { ...car, photos: [...(car.photos || []), ...newPaths] });
    await audit.record(q, req, {
      action: 'add_photos', entityType: 'car', entityId: car.id, label: audit.labelFor('car', car),
      details: `Added ${newPaths.length} photo${newPaths.length === 1 ? '' : 's'}`
    });
    return saved;
  });
  if (!updated) {
    // The car was deleted while the photos were uploading.
    await Promise.all(newPaths.map(photos.deletePhoto));
    return res.status(404).json({ error: 'Car not found' });
  }
  res.status(201).json({ photos: updated.photos });
}));

// Delete one photo from a car (removes it from the car and from storage).
app.delete('/api/cars/:id/photos', allow('editInventory'), wrap(async (req, res) => {
  const { photoPath } = req.body;
  if (!photoPath) return res.status(400).json({ error: 'photoPath is required' });

  const result = await store.tx(async q => {
    const car = await store.get(q, 'cars', req.dealershipId, req.params.id, { forUpdate: true });
    if (!car) return null;
    const wasOnCar = (car.photos || []).includes(photoPath);
    if (wasOnCar) {
      await store.save(q, 'cars', req.dealershipId, car.id,
        { ...car, photos: car.photos.filter(p => p !== photoPath) });
      await audit.record(q, req, {
        action: 'remove_photo', entityType: 'car', entityId: car.id, label: audit.labelFor('car', car),
        details: `Removed photo ${photoPath}`
      });
    }
    return { wasOnCar };
  });
  if (!result) return res.status(404).json({ error: 'Car not found' });

  // Only delete the stored file if it really belonged to this car, so a
  // request can't delete some other car's (or dealership's) photo.
  if (result.wasOnCar) await photos.deletePhoto(photoPath);

  res.status(204).send();
}));

// ---------- LEADS (CRM) ----------

app.get('/api/leads', wrap(async (req, res) => {
  let leads = await store.list(store.pool, 'leads', req.dealershipId);

  const { status } = req.query;
  if (status) {
    leads = leads.filter(l => l.status === status);
  }

  res.json(leads);
}));

// Who a customer is assigned to: two salespeople and two BDC reps.
const LEAD_ASSIGNMENTS = ['sales1Id', 'sales2Id', 'bdc1Id', 'bdc2Id'];
const LEAD_BEST_CONTACT = ['', 'text', 'call', 'email'];
const ROADMAP_STEPS = 7;

// Cleans up the lead fields people edit.
function leadFields(body) {
  const b = editableFields('leads', body);
  const out = { ...b };
  const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  for (const f of ['name', 'phone', 'email', 'address', 'source', 'lostReason']) {
    if (f in b) out[f] = text(b[f], f === 'address' ? 300 : 200);
  }
  if ('notes' in b) out.notes = text(b.notes, 4000);
  if ('type' in b) out.type = b.type === 'business' ? 'business' : 'individual';
  if ('hot' in b) out.hot = b.hot === true || b.hot === 'true';
  if ('bestContact' in b && !LEAD_BEST_CONTACT.includes(b.bestContact)) out.bestContact = '';
  if ('carId' in b) out.carId = b.carId ? text(b.carId) : null;
  if ('wishList' in b) {
    out.wishList = Array.isArray(b.wishList)
      ? [...new Set(b.wishList.map(id => text(id)).filter(Boolean))].slice(0, 20) : [];
  }
  if ('snoozedUntil' in b) {
    const d = b.snoozedUntil ? new Date(b.snoozedUntil) : null;
    out.snoozedUntil = d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  }
  for (const f of LEAD_ASSIGNMENTS) if (f in b) out[f] = b[f] ? text(b[f]) : null;
  return out;
}

// Assignments must be active staff at this store. Returns an error message or null.
async function checkLeadAssignments(q, req, fields) {
  const ids = LEAD_ASSIGNMENTS.map(f => fields[f]).filter(Boolean);
  if (!ids.length) return null;
  const { rows } = await q.query(
    'SELECT id::text AS id FROM users WHERE dealership_id = $1 AND active AND id::text = ANY($2)',
    [req.dealershipId, ids]);
  const found = new Set(rows.map(r => r.id));
  return ids.every(id => found.has(id)) ? null : 'Assign customers only to active staff at your store.';
}

// Builds and saves a new customer. Used by "Add Lead" and by appraisal
// customer offers, so every customer gets the same fields and a number.
async function createLead(q, req, fields) {
  const clean = leadFields(fields);
  // A salesperson adding a customer is their salesperson unless they pick someone else.
  if (!('sales1Id' in clean) && req.user.role === 'salesperson') clean.sales1Id = req.user.id;
  const lead = {
    name: '', type: 'individual', phone: '', email: '', address: '', carId: null, notes: '',
    status: 'new', // new | contacted | negotiating | won | lost
    source: 'other', // walk-in | phone | website | referral | autotrader | cargurus | facebook | other
    hot: false, bestContact: '', wishList: [], snoozedUntil: null, lostReason: '',
    sales1Id: null, sales2Id: null, bdc1Id: null, bdc2Id: null,
    ...clean,
    id: crypto.randomUUID(),
    customerNumber: await store.takeNextCustomerNumber(q, req.dealershipId),
    roadmap: Array(ROADMAP_STEPS).fill(null),
    activities: [], // communication log: { id, type, text, date, by }
    dateAdded: new Date().toISOString()
  };
  if (lead.carId && !lead.wishList.includes(lead.carId)) lead.wishList = [lead.carId, ...lead.wishList];
  await store.insert(q, 'leads', req.dealershipId, lead);
  return lead;
}

app.post('/api/leads', wrap(async (req, res) => {
  if (!req.body || !String(req.body.name || '').trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const result = await store.tx(async q => {
    const problem = await checkLeadAssignments(q, req, leadFields(req.body));
    if (problem) return { error: problem };
    const lead = await createLead(q, req, req.body);
    await audit.created(q, req, 'lead', lead);
    return lead;
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
}));

app.put('/api/leads/:id', wrap(async (req, res) => {
  const updated = await store.tx(async q => {
    const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
    if (!lead) return null;
    const fields = leadFields(req.body);
    const problem = await checkLeadAssignments(q, req, fields);
    if (problem) return { error: problem };
    const next = { ...lead, ...fields };
    if (next.carId && !(next.wishList || []).includes(next.carId)) next.wishList = [next.carId, ...(next.wishList || [])];
    const saved = await store.save(q, 'leads', req.dealershipId, lead.id, next);
    await audit.updated(q, req, 'lead', lead, saved);
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Lead not found' });
  if (updated.error) return res.status(400).json({ error: updated.error });
  res.json(updated);
}));

app.delete('/api/leads/:id', allow('deleteRecords'), wrap(async (req, res) => {
  const deleted = await store.tx(async q => {
    const removed = await store.remove(q, 'leads', req.dealershipId, req.params.id);
    if (removed) {
      await audit.deleted(q, req, 'lead', removed);
      await q.query(`DELETE FROM tasks WHERE dealership_id = $1 AND data->>'leadId' = $2`, [req.dealershipId, removed.id]);
    }
    return removed;
  });
  if (!deleted) return res.status(404).json({ error: 'Lead not found' });
  res.status(204).send();
}));

// Adds an entry to the top of a lead's communication log. Returns false
// if the lead doesn't exist.
async function addLeadActivity(req, leadId, activity, action = 'add_activity') {
  return store.tx(async q => {
    const lead = await store.get(q, 'leads', req.dealershipId, leadId, { forUpdate: true });
    if (!lead) return false;
    lead.activities = [activity, ...(lead.activities || [])]; // newest first
    await store.save(q, 'leads', req.dealershipId, lead.id, lead);
    await audit.record(q, req, {
      action, entityType: 'lead', entityId: lead.id, label: audit.labelFor('lead', lead),
      details: `${activity.type}: ${activity.text}`
    });
    return true;
  });
}

// ---------- Lead activity log (calls, texts, emails, notes) ----------

// visit = showroom check-in; task / appointment = a completed task.
const ACTIVITY_TYPES = ['call', 'text', 'email', 'note', 'visit', 'task', 'appointment', 'status'];

// Road to the Sale: mark a step done (or not done), with who and when.
app.post('/api/leads/:id/roadmap', wrap(async (req, res) => {
  const step = Number((req.body || {}).step);
  if (!Number.isInteger(step) || step < 0 || step >= ROADMAP_STEPS) {
    return res.status(400).json({ error: 'Pick a Road to the Sale step.' });
  }
  const done = (req.body || {}).done !== false;
  const saved = await store.tx(async q => {
    const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
    if (!lead) return null;
    const roadmap = Array.from({ length: ROADMAP_STEPS }, (_, i) => (lead.roadmap || [])[i] || null);
    roadmap[step] = done ? { at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name } } : null;
    const updated = await store.save(q, 'leads', req.dealershipId, lead.id, { ...lead, roadmap });
    const labels = (await getSettings(q, req.dealershipId)).roadmapLabels || [];
    await audit.record(q, req, {
      action: 'roadmap', entityType: 'lead', entityId: lead.id, label: audit.labelFor('lead', lead),
      details: `${labels[step] || `Step ${step + 1}`} ${done ? 'done' : 'not done'}`
    });
    return updated;
  });
  if (!saved) return res.status(404).json({ error: 'Lead not found' });
  res.json(saved);
}));

app.post('/api/leads/:id/activities', wrap(async (req, res) => {
  const { type, text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const activity = {
    id: crypto.randomUUID(),
    type: ACTIVITY_TYPES.includes(type) ? type : 'note',
    text: String(text).slice(0, 4000),
    date: new Date().toISOString(),
    by: { id: req.user.id, name: req.user.name }
  };
  const found = await addLeadActivity(req, req.params.id, activity);
  if (!found) return res.status(404).json({ error: 'Lead not found' });
  res.status(201).json(activity);
}));

app.delete('/api/leads/:id/activities/:activityId', allow('deleteRecords'), wrap(async (req, res) => {
  const found = await store.tx(async q => {
    const lead = await store.get(q, 'leads', req.dealershipId, req.params.id, { forUpdate: true });
    if (!lead) return false;
    const removed = (lead.activities || []).find(a => a.id === req.params.activityId);
    lead.activities = (lead.activities || []).filter(a => a.id !== req.params.activityId);
    await store.save(q, 'leads', req.dealershipId, lead.id, lead);
    if (removed) {
      await audit.record(q, req, {
        action: 'delete_activity', entityType: 'lead', entityId: lead.id, label: audit.labelFor('lead', lead),
        details: `${removed.type}: ${removed.text}`
      });
    }
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Lead not found' });
  res.status(204).send();
}));

// ---------- Real SMS sending (Twilio) ----------
//
// This is deliberately separate from the manual "log a text I already
// sent" flow above -- this one actually dials out to Twilio and sends a
// real message, so it needs its own explicit action rather than being
// folded into the general activity log form.

app.post('/api/leads/:id/send-text', wrap(async (req, res) => {
  const lead = await store.get(store.pool, 'leads', req.dealershipId, req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!lead.phone) return res.status(400).json({ error: 'This lead has no phone number on file.' });

  const { text, photoPath } = req.body;
  if (!text && !photoPath) return res.status(400).json({ error: 'text or photoPath is required' });

  // Only this dealership's own car photos can be sent.
  if (photoPath) {
    const cars = await store.list(store.pool, 'cars', req.dealershipId);
    if (!cars.some(c => (c.photos || []).includes(photoPath))) {
      return res.status(400).json({ error: 'That photo is not on any vehicle in your inventory.' });
    }
  }

  if (!twilioClient) {
    return res.status(500).json({
      error: 'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in your .env file to enable this feature.'
    });
  }

  try {
    const messagePayload = {
      body: text || '',
      from: TWILIO_PHONE_NUMBER,
      to: lead.phone
    };

    // Sending a photo turns this into an MMS -- Twilio needs a full,
    // publicly-reachable URL for the image.
    if (photoPath) {
      messagePayload.mediaUrl = [photos.publicPhotoUrl(photoPath, req)];
    }

    const message = await twilioClient.messages.create(messagePayload);

    // Log it in the activity feed automatically so the send is part of
    // the same history as manually-logged calls/texts/notes.
    const logText = photoPath
      ? `${text ? text + ' ' : ''}[photo attached] (sent via ${text ? 'MMS' : 'MMS, no caption'})`
      : `${text} (sent via SMS)`;
    const activity = {
      id: crypto.randomUUID(),
      type: 'text',
      text: logText,
      date: new Date().toISOString(),
      by: { id: req.user.id, name: req.user.name },
      // For the Conversation view: what was actually sent, and which way.
      direction: 'out', message: text || '', photo: photoPath || null
    };
    await addLeadActivity(req, lead.id, activity, 'send_text');

    res.status(201).json({ activity, twilioSid: message.sid, status: message.status });
  } catch (err) {
    // Twilio errors are usually about trial account restrictions
    // (unverified recipient number) or a malformed phone number --
    // pass the real message through so it's actionable, not just "failed".
    res.status(500).json({ error: err.message });
  }
}));

// ---------- TASKS & APPOINTMENTS (follow-ups on a customer) ----------
// Each task is for one customer and assigned to one staff member, with a
// due time. Completing it notes the outcome in the customer's log.

const TASK_TYPES = ['call', 'text', 'email', 'appointment', 'todo'];
const TASK_TYPE_LABELS = { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment', todo: 'To-do' };

async function taskFields(q, req, body, current = {}) {
  const b = body || {};
  const out = {};
  if ('type' in b || !current.type) out.type = TASK_TYPES.includes(b.type) ? b.type : 'call';
  if ('title' in b) out.title = String(b.title || '').trim().slice(0, 200);
  if ('notes' in b) out.notes = String(b.notes || '').trim().slice(0, 2000);
  if ('dueAt' in b || !current.dueAt) {
    const due = new Date(b.dueAt);
    if (!b.dueAt || Number.isNaN(due.getTime())) return { error: 'Pick when it is due.' };
    out.dueAt = due.toISOString();
  }
  if ('assignedToId' in b || !current.assignedTo) {
    const id = b.assignedToId || req.user.id;
    const { rows } = await q.query(
      'SELECT id, name FROM users WHERE id::text = $1 AND dealership_id = $2 AND active', [String(id), req.dealershipId]);
    if (!rows.length) return { error: 'Assign it to someone at your store.' };
    out.assignedTo = { id: rows[0].id, name: rows[0].name };
  }
  return { fields: out };
}

app.get('/api/tasks', wrap(async (req, res) => {
  let tasks = await store.list(store.pool, 'tasks', req.dealershipId);
  const { leadId, status, assignedTo } = req.query;
  if (leadId) tasks = tasks.filter(t => t.leadId === leadId);
  if (status) tasks = tasks.filter(t => t.status === status);
  if (assignedTo) {
    const who = assignedTo === 'me' ? req.user.id : assignedTo;
    tasks = tasks.filter(t => t.assignedTo && t.assignedTo.id === who);
  }
  res.json(tasks.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt))));
}));

app.post('/api/tasks', wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const lead = await store.get(q, 'leads', req.dealershipId, String((req.body || {}).leadId || ''));
    if (!lead) return { status: 400, error: 'Pick the customer this is for.' };
    const { fields, error } = await taskFields(q, req, req.body);
    if (error) return { status: 400, error };
    const task = {
      title: '', notes: '', ...fields,
      id: crypto.randomUUID(), leadId: lead.id, leadName: lead.name,
      status: 'open', // open | done | cancelled
      createdBy: { id: req.user.id, name: req.user.name }, createdAt: new Date().toISOString(),
      completedAt: null, completedBy: null, outcome: ''
    };
    await store.insert(q, 'tasks', req.dealershipId, task);
    await audit.created(q, req, 'task', task);
    return { task };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.task);
}));

app.put('/api/tasks/:id', wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const task = await store.get(q, 'tasks', req.dealershipId, req.params.id, { forUpdate: true });
    if (!task) return { status: 404, error: 'Task not found' };
    if (task.status !== 'open') return { status: 409, error: 'Only open tasks can be changed.' };
    const { fields, error } = await taskFields(q, req, req.body, task);
    if (error) return { status: 400, error };
    const saved = await store.save(q, 'tasks', req.dealershipId, task.id, { ...task, ...fields });
    await audit.updated(q, req, 'task', task, saved);
    return { task: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.task);
}));

// Done (with what happened) or cancelled. Done tasks go in the customer's log.
async function closeTask(req, res, status) {
  const outcome = String((req.body || {}).outcome || '').trim().slice(0, 2000);
  const result = await store.tx(async q => {
    const task = await store.get(q, 'tasks', req.dealershipId, req.params.id, { forUpdate: true });
    if (!task) return { status: 404, error: 'Task not found' };
    if (task.status !== 'open') return { status: 409, error: 'This task is already closed.' };
    const saved = await store.save(q, 'tasks', req.dealershipId, task.id, {
      ...task, status, outcome, completedAt: new Date().toISOString(), completedBy: { id: req.user.id, name: req.user.name }
    });
    const lead = await store.get(q, 'leads', req.dealershipId, task.leadId, { forUpdate: true });
    if (lead) {
      const label = `${TASK_TYPE_LABELS[task.type] || 'Task'}${task.type === 'appointment' || task.type === 'todo' ? '' : ' task'}`;
      lead.activities = [{
        id: crypto.randomUUID(),
        type: task.type === 'appointment' ? 'appointment' : 'task',
        text: `${label} ${status === 'done' ? 'completed' : 'cancelled'}${task.title ? ` -- ${task.title}` : ''}${outcome ? `: ${outcome}` : ''}`,
        date: new Date().toISOString(), by: { id: req.user.id, name: req.user.name }, taskId: task.id
      }, ...(lead.activities || [])];
      await store.save(q, 'leads', req.dealershipId, lead.id, lead);
    }
    await audit.record(q, req, {
      action: status === 'done' ? 'complete' : 'cancel', entityType: 'task', entityId: task.id,
      label: audit.labelFor('task', task), details: outcome || null
    });
    return { task: saved, lead };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}
app.post('/api/tasks/:id/complete', wrap((req, res) => closeTask(req, res, 'done')));
app.post('/api/tasks/:id/cancel', wrap((req, res) => closeTask(req, res, 'cancelled')));

app.delete('/api/tasks/:id', allow('deleteRecords'), wrap(async (req, res) => {
  const removed = await store.tx(async q => {
    const task = await store.remove(q, 'tasks', req.dealershipId, req.params.id);
    if (task) await audit.deleted(q, req, 'task', task);
    return task;
  });
  if (!removed) return res.status(404).json({ error: 'Task not found' });
  res.status(204).send();
}));

// ---------- DEALS (Deal Calculator + Proposals) ----------
//
// A "deal" bundles together a car, a lead, and the numbers needed to
// figure out the customer's monthly payment: trade-in, rebate, down
// payment, tax, and fees. The math is done here on the server so there's
// one source of truth -- the frontend just displays whatever this
// function calculates, it never re-does the math itself.

// F&I menu products apply to both retail and lease deals -- pulled into
// their own helper so both calculators build this part identically instead
// of two copies of the same six fields drifting apart over time.
function extractFiProducts(input) {
  return {
    gapPremium: Number(input.gapPremium) || 0,
    servicePremium: Number(input.servicePremium) || 0, // extended service contract (ESC)
    maintenancePremium: Number(input.maintenancePremium) || 0,
    aftermarketAmount: Number(input.aftermarketAmount) || 0, // accessories/other aftermarket products
    dealerFees: Number(input.dealerFees) || 0,
    licenseFee: Number(input.licenseFee) || 0
  };
}

// ---------- State-specific sales tax & DMV fee lookup (CA and AZ) ----------
//
// Real DMV/registration fees and sales tax vary enormously by state --
// there is no single national formula. This implements two states
// accurately based on their actual published rules (CDTFA for California,
// ADOT/AZDOR for Arizona). Any other state falls back to California's
// numbers as a stand-in until it gets built out for real -- an explicit,
// documented placeholder rather than a silent wrong guess.
//
// County/city rates are approximated from published county-level
// reference rates using ZIP-code prefixes, not an exact address-level
// CDTFA/ADOR lookup -- that would require a live rate API. This is a
// reasonable approximation for a portfolio project, not a compliance-grade
// tax engine, and is documented as such wherever it's surfaced.

// ZIP prefix -> county name, then county name -> combined sales tax rate.
// Splitting it this way (instead of ZIP straight to a rate number) means
// the county name itself can be shown/auto-filled in the UI, not just used
// as an invisible lookup key.
const CA_COUNTY_BY_ZIP_PREFIX = [
  { prefixes: ['900', '901', '902', '903', '904', '905', '906', '907', '908', '910', '911', '912', '913'], county: 'Los Angeles' },
  { prefixes: ['945', '946'], county: 'Alameda' },
  { prefixes: ['940', '941'], county: 'San Francisco' },
  { prefixes: ['942', '943', '944'], county: 'San Mateo' },
  { prefixes: ['950', '951', '952', '953'], county: 'Santa Clara' },
  { prefixes: ['920', '921'], county: 'San Diego' },
  { prefixes: ['926', '927', '928'], county: 'Orange' },
  { prefixes: ['956', '957', '958'], county: 'Sacramento' },
];
const CA_STATEWIDE_BASE_RATE = 7.25;

const AZ_COUNTY_BY_ZIP_PREFIX = [
  { prefixes: ['850', '851', '852', '853'], county: 'Maricopa' },
  { prefixes: ['855', '856', '857'], county: 'Pima' },
];
const AZ_STATEWIDE_BASE_RATE = 5.6;

function lookupCounty(zip, table) {
  const prefix = (zip || '').toString().slice(0, 3);
  const match = table.find(entry => entry.prefixes.includes(prefix));
  return match ? match.county : '';
}

app.get('/api/fees/county-lookup', (req, res) => {
  const { state, zip } = req.query;
  const normalizedState = (state || '').trim().toUpperCase();
  const county = normalizedState === 'AZ'
    ? lookupCounty(zip, AZ_COUNTY_BY_ZIP_PREFIX)
    : lookupCounty(zip, CA_COUNTY_BY_ZIP_PREFIX); // CA table doubles as the fallback lookup too
  res.json({ county });
});

// California: $74 base registration + $29 CHP fee + a value-tiered
// Transportation Improvement Fee, title $28, and the Vehicle License Fee
// (0.65% of the vehicle's value) mapped onto our "License Fee" field,
// since VLF literally *is* California's vehicle license fee.
// California's Vehicle License Fee is NOT 0.65% of the raw price -- by
// statute (Rev. & Tax. Code section 10753.2(b)) a vehicle is placed into a
// $200-wide valuation bracket and taxed on the BRACKET'S MIDPOINT, not the
// exact price. This rounds a price into that bracket before applying the
// VLF rate.
//
// VLF is also always calculated at "year 1" (100% of value) for a sale
// like this one, not the vehicle's actual age -- CA law resets the VLF
// depreciation clock to year one every time a vehicle changes ownership
// (section 10753.2(c)), and a dealership sale IS an ownership transfer.
// A car's age only matters for VLF on a *renewal*, which isn't what this
// calculator is pricing.
function vlfValuationBracketMidpoint(price) {
  if (price < 50) return 25;
  if (price < 200) return 125;
  const bracketStart = Math.floor(price / 200) * 200;
  return bracketStart + 100; // midpoint of a $200-wide bracket
}

function calculateCaliforniaFees(price) {
  const vlfValue = vlfValuationBracketMidpoint(price);
  const vlf = vlfValue * 0.0065;

  let tif;
  if (price < 5000) tif = 28;
  else if (price < 25000) tif = 56;
  else if (price < 35000) tif = 112;
  else if (price < 60000) tif = 168;
  else tif = 224;

  // $74 base registration + $34 CHP fee (Veh. Code sections 9250.8,
  // 9250.13) + $3 Alternative Fuel/Technology surcharge (Veh. Code
  // section 9250.1, a recurring charge on every registration that's
  // easy to miss in simplified fee breakdowns) + the value-tiered TIF.
  return {
    taxRate: null, // filled in by caller from the ZIP lookup
    registrationFee: round2(74 + 34 + 3 + tif),
    titleFee: 28,
    licenseFee: round2(vlf)
  };
}

// Arizona's Vehicle License Tax rate split ($2.80 vs $2.89 per $100) is
// NOT "new car vs. used car" -- Arizona's own tax documentation (JLBC Tax
// Handbook) is explicit that $2.80 applies during a vehicle's first 12
// months of REGISTRATION, and $2.89 applies to every renewal after that,
// "regardless of whether the car itself is new or used." A dealership
// sale is always a fresh registration for the buyer -- whether the car
// itself is factory-new or a 10-year-old trade-in someone else owned --
// so every sale calculated here uses the first-year rate and the full
// 60%-of-price assessed value, with no age-based depreciation applied.
// A vehicle's age only matters for VLT on a *renewal*, which isn't what
// this calculator is pricing. There's also a statutory $10 minimum.
function calculateArizonaFees(price) {
  const assessedValue = price * 0.60;
  const vlt = Math.max((assessedValue / 100) * 2.80, 10);

  return {
    taxRate: null,
    registrationFee: round2(9 + 5 + 1.50), // base registration + plate + air quality
    titleFee: 4,
    licenseFee: round2(vlt)
  };
}

// Single entry point: given a state, ZIP, price, and vehicle year, returns
// the calculated tax rate and DMV-style fees. Anything other than CA/AZ
// uses California's numbers as the documented fallback.
function calculateStateFees(taxRates, state, zip, price, vehicleYear, county, city) {
  const normalizedState = (state || '').trim().toUpperCase();

  if (normalizedState === 'AZ') {
    const resolvedCounty = county || lookupCounty(zip, AZ_COUNTY_BY_ZIP_PREFIX);
    const fees = calculateArizonaFees(price);
    const rateMatch = findBestTaxRateMatch(taxRates, 'AZ', resolvedCounty, city);
    fees.county = resolvedCounty;
    fees.taxRate = rateMatch ? round2(rateMatch.stateTaxRate + rateMatch.countyTaxRate + rateMatch.cityTaxRate) : AZ_STATEWIDE_BASE_RATE;
    fees.rateSource = rateMatch ? rateMatch.id : 'no match -- using statewide base';
    fees.stateUsed = 'AZ';
    fees.tradeInReducesTaxableAmount = true; // Arizona credits trade-in value against the taxable amount
    return fees;
  }

  // CA, or any other/unrecognized state -- California is the documented fallback.
  const resolvedCounty = county || lookupCounty(zip, CA_COUNTY_BY_ZIP_PREFIX);
  const fees = calculateCaliforniaFees(price);
  const rateMatch = findBestTaxRateMatch(taxRates, 'CA', resolvedCounty, city);
  fees.county = resolvedCounty;
  fees.taxRate = rateMatch ? round2(rateMatch.stateTaxRate + rateMatch.countyTaxRate + rateMatch.cityTaxRate) : CA_STATEWIDE_BASE_RATE;
  fees.rateSource = rateMatch ? rateMatch.id : 'no match -- using statewide base';
  fees.stateUsed = (normalizedState === 'CA') ? 'CA' : `CA (fallback -- ${normalizedState || 'no state on file'} not yet built)`;
  fees.tradeInReducesTaxableAmount = false; // California taxes the full price; trade-in does not reduce it
  return fees;
}

app.post('/api/fees/calculate', wrap(async (req, res) => {
  const { state, zip, price, vehicleYear, county, city } = req.body;
  if (!price) return res.status(400).json({ error: 'price is required' });

  const taxRates = await store.list(store.pool, 'tax_rates', req.dealershipId);
  const result = calculateStateFees(taxRates, state, zip, Number(price), vehicleYear, county, city);
  res.json(result);
}));

function calculateRetailDeal(input) {
  const vehiclePrice = Number(input.vehiclePrice) || 0;
  const tradeInValue = Number(input.tradeInValue) || 0;
  const tradeInPayoff = Number(input.tradeInPayoff) || 0;
  const rebate = Number(input.rebate) || 0;
  const downPayment = Number(input.downPayment) || 0;
  const taxRate = Number(input.taxRate) || 0;
  const docFee = Number(input.docFee) || 0;
  const titleFee = Number(input.titleFee) || 0;
  const registrationFee = Number(input.registrationFee) || 0;
  const apr = Number(input.apr) || 0;
  const termMonths = Number(input.termMonths) || 60;
  const fi = extractFiProducts(input);
  const state = (input.state || '').trim().toUpperCase();

  // Net trade-in equity: what the trade is actually worth toward the deal
  // after paying off whatever is still owed on it. Can be negative if the
  // customer owes more than the trade is worth (negative equity).
  const netTradeIn = tradeInValue - tradeInPayoff;

  // Whether trade-in reduces the taxable amount is genuinely state-specific,
  // not a minor rounding detail: Arizona credits trade-in value against the
  // taxable amount (the general rule most states follow), but California
  // taxes the full vehicle price regardless of trade-in (Rev. & Tax. Code
  // section 6012). Anything other than AZ defaults to California's rule,
  // matching the documented CA fallback used for unbuilt states.
  const taxableAmount = state === 'AZ'
    ? Math.max(vehiclePrice - netTradeIn, 0)
    : vehiclePrice;
  const salesTax = taxableAmount * (taxRate / 100);

  const totalFees = docFee + titleFee + registrationFee +
    fi.gapPremium + fi.servicePremium + fi.maintenancePremium + fi.aftermarketAmount + fi.dealerFees + fi.licenseFee;

  // What's left to finance after trade-in, rebate, and down payment are
  // subtracted, then tax and fees (including F&I products, which are
  // typically financed into the deal) are added back in.
  let amountFinanced = vehiclePrice - netTradeIn - rebate - downPayment + salesTax + totalFees;
  if (amountFinanced < 0) amountFinanced = 0;

  // Standard amortized loan payment formula.
  const monthlyRate = (apr / 100) / 12;
  let monthlyPayment;
  if (monthlyRate === 0) {
    monthlyPayment = amountFinanced / termMonths;
  } else {
    monthlyPayment =
      (amountFinanced * monthlyRate) /
      (1 - Math.pow(1 + monthlyRate, -termMonths));
  }

  const totalOfPayments = monthlyPayment * termMonths;
  const totalDealCost = totalOfPayments + downPayment;

  return {
    dealType: 'retail',
    state: input.state || '',
    vehiclePrice,
    tradeInValue,
    tradeInPayoff,
    netTradeIn,
    rebate,
    downPayment,
    taxRate,
    taxableAmount,
    salesTax: round2(salesTax),
    docFee,
    titleFee,
    registrationFee,
    ...fi,
    totalFees: round2(totalFees),
    amountFinanced: round2(amountFinanced),
    apr,
    termMonths,
    monthlyPayment: round2(monthlyPayment),
    totalOfPayments: round2(totalOfPayments),
    totalDealCost: round2(totalDealCost)
  };
}

// Lease math follows the standard industry formula used across DMS
// platforms (capitalized cost, cap cost reduction, residual, money
// factor) -- this is well-established math, not something proprietary to
// any one system.
function calculateLeaseDeal(input) {
  const msrp = Number(input.msrp) || 0;
  const vehiclePrice = Number(input.vehiclePrice) || 0; // negotiated selling price
  const docFee = Number(input.docFee) || 0;
  const acquisitionFee = Number(input.acquisitionFee) || 0;
  const fi = extractFiProducts(input);

  const cashDown = Number(input.downPayment) || 0;
  const rebate = Number(input.rebate) || 0;
  const tradeInValue = Number(input.tradeInValue) || 0;
  const tradeInPayoff = Number(input.tradeInPayoff) || 0;
  const cashBack = Number(input.cashBack) || 0;

  const residualPercent = Number(input.residualPercent) || 0;
  const annualMiles = Number(input.annualMiles) || 12000;
  const moneyFactor = Number(input.moneyFactor) || 0;
  const termMonths = Number(input.termMonths) || 36;
  const securityDeposit = Number(input.securityDeposit) || 0;
  const advancedPayments = Number(input.advancedPayments) || 0;
  const taxRate = Number(input.taxRate) || 0;

  // Gross capitalized cost: the negotiated price plus everything being
  // rolled into the lease (fees, F&I products) instead of paid upfront.
  const grossCapCost = vehiclePrice + docFee + acquisitionFee +
    fi.gapPremium + fi.servicePremium + fi.maintenancePremium + fi.aftermarketAmount + fi.dealerFees + fi.licenseFee;

  const netTradeIn = tradeInValue - tradeInPayoff;

  // Cap cost reduction: everything that reduces what actually gets
  // capitalized into the lease -- cash down, rebates, and net trade
  // equity all lower it; cash back to the customer raises it.
  const totalCapReduction = cashDown + rebate + netTradeIn - cashBack;
  const netCapCost = Math.max(grossCapCost - totalCapReduction, 0);

  const residualAmount = msrp * (residualPercent / 100);

  // Depreciation: the vehicle's projected loss in value over the lease
  // term, spread evenly across the monthly payments.
  const monthlyDepreciation = (netCapCost - residualAmount) / termMonths;

  // Rent charge: the lease's equivalent of interest, based on the money
  // factor (roughly APR / 2400) applied to the sum of net cap cost and
  // residual, not just the financed portion.
  const monthlyRentCharge = (netCapCost + residualAmount) * moneyFactor;

  const baseMonthlyPayment = monthlyDepreciation + monthlyRentCharge;

  // Tax-on-monthly-payment is the most common method across states, and
  // the one implemented here -- some states instead tax the cap cost
  // reduction upfront (or a mix of both), which is a documented
  // simplification, the same spirit as the retail tax assumption.
  const monthlyTax = baseMonthlyPayment * (taxRate / 100);
  const totalMonthlyPayment = baseMonthlyPayment + monthlyTax;

  // Due at signing: whatever isn't capitalized into the lease -- the cap
  // cost reduction itself, any advance payments, and the security deposit.
  const dueAtSigning = totalCapReduction + (totalMonthlyPayment * advancedPayments) + securityDeposit;

  const totalOfPayments = totalMonthlyPayment * termMonths;
  const totalDealCost = totalOfPayments + totalCapReduction;

  return {
    dealType: 'lease',
    state: input.state || '',
    msrp,
    vehiclePrice,
    docFee,
    acquisitionFee,
    ...fi,
    downPayment: cashDown,
    rebate,
    tradeInValue,
    tradeInPayoff,
    netTradeIn,
    cashBack,
    grossCapCost: round2(grossCapCost),
    totalCapReduction: round2(totalCapReduction),
    netCapCost: round2(netCapCost),
    residualPercent,
    residualAmount: round2(residualAmount),
    annualMiles,
    moneyFactor,
    termMonths,
    securityDeposit,
    advancedPayments,
    taxRate,
    monthlyDepreciation: round2(monthlyDepreciation),
    monthlyRentCharge: round2(monthlyRentCharge),
    baseMonthlyPayment: round2(baseMonthlyPayment),
    monthlyTax: round2(monthlyTax),
    monthlyPayment: round2(totalMonthlyPayment), // shared field name with retail so the UI can display either uniformly
    dueAtSigning: round2(dueAtSigning),
    totalOfPayments: round2(totalOfPayments),
    totalDealCost: round2(totalDealCost)
  };
}

// Cash deals have no financing at all -- whatever's left after trade,
// rebate, and down payment (plus tax and fees) is simply due in full,
// with no monthly payment to calculate.
function calculateCashDeal(input) {
  const vehiclePrice = Number(input.vehiclePrice) || 0;
  const tradeInValue = Number(input.tradeInValue) || 0;
  const tradeInPayoff = Number(input.tradeInPayoff) || 0;
  const rebate = Number(input.rebate) || 0;
  const downPayment = Number(input.downPayment) || 0;
  const taxRate = Number(input.taxRate) || 0;
  const docFee = Number(input.docFee) || 0;
  const titleFee = Number(input.titleFee) || 0;
  const registrationFee = Number(input.registrationFee) || 0;
  const fi = extractFiProducts(input);
  const state = (input.state || '').trim().toUpperCase();

  const netTradeIn = tradeInValue - tradeInPayoff;
  const taxableAmount = state === 'AZ'
    ? Math.max(vehiclePrice - netTradeIn, 0)
    : vehiclePrice;
  const salesTax = taxableAmount * (taxRate / 100);
  const totalFees = docFee + titleFee + registrationFee +
    fi.gapPremium + fi.servicePremium + fi.maintenancePremium + fi.aftermarketAmount + fi.dealerFees + fi.licenseFee;

  let totalDue = vehiclePrice - netTradeIn - rebate - downPayment + salesTax + totalFees;
  if (totalDue < 0) totalDue = 0;

  return {
    dealType: 'cash',
    state: input.state || '',
    vehiclePrice,
    tradeInValue,
    tradeInPayoff,
    netTradeIn,
    rebate,
    downPayment,
    taxRate,
    taxableAmount,
    salesTax: round2(salesTax),
    docFee,
    titleFee,
    registrationFee,
    ...fi,
    totalFees: round2(totalFees),
    amountFinanced: round2(totalDue), // same field name as retail for UI consistency; here it's just "amount due"
    apr: 0,
    termMonths: 0,
    monthlyPayment: 0,
    totalOfPayments: 0,
    totalDealCost: round2(totalDue + downPayment)
  };
}

// Single entry point the routes call -- picks the right calculator based
// on dealType so nothing outside this function needs to know there are
// multiple math paths.
function calculateDeal(input) {
  const dealType = input.dealType || 'retail';
  if (dealType === 'lease') return calculateLeaseDeal(input);
  if (dealType === 'cash') return calculateCashDeal(input);
  return calculateRetailDeal({ ...input, dealType: 'retail' });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// One applicant's full credit application fields -- used for both the
// primary applicant and an optional co-applicant, since a joint
// application asks the same questions of both people.
function defaultApplicant() {
  return {
    firstName: '',
    middleInitial: '',
    lastName: '',
    suffix: '',
    ssn: '',
    dob: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    county: '',
    zip: '',
    phone: '',
    homeDisclosure: false,
    mobileDisclosure: false,
    email: '',
    emailNotProvided: false,
    licenseState: '',
    licenseNumber: '',

    housingStatus: 'rent', // mortgage | rent | family | own_outright | other | military
    yrsAtAddress: '',
    mosAtAddress: '',
    housingPayment: 0,
    hasPreviousAddress: false,
    previousAddress: { address1: '', address2: '', zip: '', yrsAtAddress: '', mosAtAddress: '' },

    employmentStatus: 'employed', // employed | unemployed | retired | active_military | other | self_employed | student | retired_military
    employer: '',
    yrsAtEmployer: '',
    mosAtEmployer: '',
    businessPhone: '',
    occupation: '',
    salary: 0,
    expectedSalary: 0,
    payFrequency: 'biweekly', // weekly | biweekly | semimonthly | monthly | annually
    otherMonthlyIncome: 0,
    otherIncome: 0,
    sourceOfOtherIncome: '',
    hasPreviousEmployer: false,
    previousEmployer: { employer: '', yrsAtEmployer: '', mosAtEmployer: '', occupation: '', businessPhone: '' }
  };
}

function defaultCreditApp() {
  return {
    applicantType: 'individual', // individual | business
    businessName: '',
    businessEIN: '',
    businessAddress: '',
    businessPhone: '',
    yearsInBusiness: '',
    annualRevenue: 0,

    applicant: defaultApplicant(),
    hasCoApplicant: false,
    coApplicant: defaultApplicant(),

    status: 'not_submitted', // not_submitted | pending | approved | conditional | declined
    dateSubmitted: null
  };
}

app.get('/api/deals', wrap(async (req, res) => {
  res.json(await store.list(store.pool, 'deals', req.dealershipId));
}));

app.get('/api/deals/:id', wrap(async (req, res) => {
  const deal = await store.get(store.pool, 'deals', req.dealershipId, req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json(deal);
}));

// POST a new deal: just needs a lead + car to start. This generates the
// deal number and creates a "working" deal with the vehicle price
// pre-filled and everything else at sensible defaults -- the sales rep
// fills in the rest in the desking tool.
app.post('/api/deals', wrap(async (req, res) => {
  // Customer and vehicle are both optional at creation -- a deal number
  // can be opened before either is known and filled in later from the
  // Desking tab, matching how a desk sometimes starts a deal before all
  // the paperwork is in hand.
  const { leadId, carId } = req.body;

  const newDeal = await store.tx(async q => {
    const car = carId ? await store.get(q, 'cars', req.dealershipId, carId) : null;
    const fees = await getSettings(q, req.dealershipId);
    const calculated = calculateDeal({
      vehiclePrice: req.body.vehiclePrice || (car ? car.price : 0),
      taxRate: req.body.taxRate ?? fees.taxRate,
      docFee: req.body.docFee ?? fees.docFee,
      titleFee: req.body.titleFee ?? fees.titleFee,
      registrationFee: req.body.registrationFee ?? fees.registrationFee,
      licenseFee: req.body.licenseFee ?? fees.licenseFee,
      dealerFees: req.body.dealerFees ?? fees.dealerFees,
      acquisitionFee: req.body.acquisitionFee ?? fees.acquisitionFee,
      apr: req.body.apr ?? 6.5,
      termMonths: req.body.termMonths ?? 60
    });

    const deal = {
      id: crypto.randomUUID(),
      dealNumber: await store.takeNextDealNumber(q, req.dealershipId),
      leadId: leadId || null,
      carId: carId || null,
      status: 'working', // working | delivered | closed | finalized
      hasTrade: false,
      ...calculated,
      creditApp: defaultCreditApp(),
      dateCreated: new Date().toISOString()
    };

    await store.insert(q, 'deals', req.dealershipId, deal);
    await audit.created(q, req, 'deal', deal);
    await syncCarStatusToDeal(q, req, deal);
    return deal;
  });
  res.status(201).json(newDeal);
}));

// PUT (update/recalculate) an existing deal's desking numbers or status.
// Credit app fields are preserved automatically since they're not part
// of req.body in a normal desking update -- see the dedicated
// /credit-app route below for updating that section specifically.
// Vehicle Management tie-in: a deal's progress should be reflected on the
// actual vehicle record without a sales manager having to update both
// places by hand. Working a deal on a car takes it off the available
// list; delivering/closing/finalizing it marks the car sold. Shared by
// both deal creation and deal updates so the rule only lives in one place.
async function syncCarStatusToDeal(q, req, deal) {
  if (!deal.carId) return;
  const car = await store.get(q, 'cars', req.dealershipId, deal.carId, { forUpdate: true });
  if (!car) return;

  const updated = { ...car };
  if (['delivered', 'closed', 'finalized'].includes(deal.status) && car.status !== 'sold') {
    updated.status = 'sold';
    updated.dateSold = car.dateSold || new Date().toISOString();
  } else if (deal.status === 'working' && car.status === 'available') {
    updated.status = 'pending';
  } else {
    return;
  }
  await store.save(q, 'cars', req.dealershipId, car.id, updated);
  await audit.updated(q, req, 'car', car, updated, `Automatic, from deal D-${deal.dealNumber}`);
}

app.put('/api/deals/:id', wrap(async (req, res) => {
  const updated = await store.tx(async q => {
    const deal = await store.get(q, 'deals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!deal) return null;

    // The deal number, credit app, and creation date can't be changed
    // here (the credit app has its own route below).
    const merged = { ...deal, ...editableFields('deals', req.body) };
    const calculated = calculateDeal(merged);

    const saved = await store.save(q, 'deals', req.dealershipId, deal.id, { ...merged, ...calculated });
    await audit.updated(q, req, 'deal', deal, saved);
    await syncCarStatusToDeal(q, req, saved);
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Deal not found' });
  res.json(updated);
}));

// PUT the credit application section of a deal. The frontend sends the
// whole creditApp object each time (it's really one form), so this
// merges it over the defaults rather than doing a shallow patch --
// that way any field the frontend didn't know about yet still gets a
// safe default instead of `undefined`.
app.put('/api/deals/:id/credit-app', wrap(async (req, res) => {
  const body = req.body || {};
  const defaults = defaultCreditApp();

  function mergeApplicant(incoming) {
    const base = defaultApplicant();
    const merged = { ...base, ...(incoming || {}) };
    merged.previousAddress = { ...base.previousAddress, ...((incoming && incoming.previousAddress) || {}) };
    merged.previousEmployer = { ...base.previousEmployer, ...((incoming && incoming.previousEmployer) || {}) };
    return merged;
  }

  const updatedCreditApp = {
    ...defaults,
    ...body,
    applicant: mergeApplicant(body.applicant),
    coApplicant: mergeApplicant(body.coApplicant)
  };

  const updated = await store.tx(async q => {
    const deal = await store.get(q, 'deals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!deal) return null;

    // Stamp the submission date the first time status moves off "not_submitted"
    const existing = deal.creditApp || defaults;
    if (updatedCreditApp.status !== 'not_submitted' && !existing.dateSubmitted) {
      updatedCreditApp.dateSubmitted = new Date().toISOString();
    } else {
      updatedCreditApp.dateSubmitted = existing.dateSubmitted || null;
    }

    const saved = await store.save(q, 'deals', req.dealershipId, deal.id, { ...deal, creditApp: updatedCreditApp });
    await audit.updated(q, req, 'deal', deal, saved, 'Credit application');
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Deal not found' });
  res.json(updated);
}));

app.delete('/api/deals/:id', allow('deleteRecords'), wrap(async (req, res) => {
  const deleted = await store.tx(async q => {
    const removed = await store.remove(q, 'deals', req.dealershipId, req.params.id);
    if (removed) await audit.deleted(q, req, 'deal', removed);
    return removed;
  });
  if (!deleted) return res.status(404).json({ error: 'Deal not found' });
  res.status(204).send();
}));

// ---------- KEYS (from the key machine) ----------

// Where each car's keys are right now, for the inventory Key column.
app.get('/api/keys', wrap(async (req, res) => {
  res.json(await keys.listKeys(req.dealershipId));
}));

// The key machine (or its connector) sends each check-out / check-in here,
// authenticated with an integration token instead of a user login:
//   Authorization: Bearer crm_...
//   { "action": "check_out", "tagCode": "A-114", "stockNumber": "ST-4821",
//     "personName": "Sam Sales", "occurredAt": "2026-09-24T14:05:00Z", "eventId": "kt-99812" }
// See "Key machine integration" in the README for every field.
app.post('/api/integrations/keys/events', wrap(async (req, res) => {
  const token = await keys.authenticateToken(req);
  if (!token) return res.status(401).json({ error: 'Missing or invalid integration token.' });
  const result = await keys.ingestMachineEvent(token, req.body);
  res.status(result.status).json(result.body);
}));

// Admin: tokens that let outside systems (like the key machine) send data in.
app.get('/api/integrations/tokens', allow('manageIntegrations'), wrap(async (req, res) => {
  const { rows } = await store.pool.query(
    `SELECT id, name, created_at, last_used_at FROM integration_tokens
     WHERE dealership_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [req.dealershipId]
  );
  res.json(rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })));
}));

// The token itself is only returned here, once. Only a hash is stored.
app.post('/api/integrations/tokens', allow('manageIntegrations'), wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Give the connection a name, e.g. "KeyTrak".' });
  const created = await store.tx(q => keys.createToken(q, req, name));
  res.status(201).json({ id: created.id, name: created.name, createdAt: created.created_at, token: created.token });
}));

app.delete('/api/integrations/tokens/:id', allow('manageIntegrations'), wrap(async (req, res) => {
  const revoked = await store.tx(async q => {
    const { rows } = await q.query(
      `UPDATE integration_tokens SET revoked_at = now()
       WHERE dealership_id = $1 AND id::text = $2 AND revoked_at IS NULL RETURNING id, name`,
      [req.dealershipId, req.params.id]
    );
    if (rows[0]) {
      await audit.record(q, req, { action: 'delete', entityType: 'integration', entityId: rows[0].id, label: rows[0].name, details: 'Integration token revoked' });
    }
    return rows[0];
  });
  if (!revoked) return res.status(404).json({ error: 'Token not found.' });
  res.status(204).send();
}));

// Key events that couldn't be matched to a car (e.g. a stock # that isn't
// in the CRM's inventory), to help an admin spot setup problems.
app.get('/api/integrations/keys/unmatched', allow('manageIntegrations'), wrap(async (req, res) => {
  res.json(await keys.listUnmatched(req.dealershipId));
}));

// ---------- APPRAISALS (trade / purchase "book outs") ----------
// A car being considered for purchase (usually a trade-in). If the store
// buys it, "acquire" turns it into an inventory car with everything filled
// in; otherwise it's marked lost. Every appraisal is kept -- over time
// that's the store's own record of what cars were worth and what it paid.

const APPRAISAL_CONDITIONS = ['excellent', 'very_good', 'good', 'fair', 'poor'];
const APPRAISAL_SOURCES = ['trade_in', 'street_purchase', 'service_drive'];
const APPRAISAL_CATEGORIES = ['undecided', 'retail', 'wholesale'];
// The offer calculator works out one of these from the others.
const APPRAISAL_SOLVE_FOR = ['appraisal', 'profit', 'asking'];

// Cleans up the fields an appraiser edits: numbers as numbers, VIN in
// standard form, recon lines and equipment as tidy lists.
function appraisalFields(body) {
  const b = editableFields('appraisals', body);
  const out = { ...b };
  // People type "41,000" or "$19,500" -- accept those as numbers.
  const toNumber = v => Number(String(v).replace(/[$,\s]/g, '')) || 0;
  for (const f of ['year', 'mileage', 'targetRetail', 'targetGross', 'offer', 'otherCosts']) {
    if (f in b) out[f] = b[f] === '' || b[f] === null ? null : toNumber(b[f]);
  }
  if ('vin' in b) out.vin = vinDecoder.normalizeVin(b.vin);
  if ('condition' in b && !APPRAISAL_CONDITIONS.includes(b.condition)) out.condition = '';
  if ('source' in b && !APPRAISAL_SOURCES.includes(b.source)) out.source = 'trade_in';
  if ('category' in b && !APPRAISAL_CATEGORIES.includes(b.category)) out.category = 'undecided';
  if ('calcSolveFor' in b && !APPRAISAL_SOLVE_FOR.includes(b.calcSolveFor)) out.calcSolveFor = 'appraisal';
  delete out.appraiserId; // handled by applyAppraiser
  if ('equipment' in b) {
    out.equipment = Array.isArray(b.equipment)
      ? [...new Set(b.equipment.map(e => String(e).trim()).filter(Boolean))].slice(0, 100) : [];
  }
  if ('recon' in b) {
    out.recon = Array.isArray(b.recon)
      ? b.recon.slice(0, 50).map(r => ({ description: String((r && r.description) || '').trim().slice(0, 120), cost: Number(r && r.cost) || 0 }))
        .filter(r => r.description || r.cost)
      : [];
  }
  for (const f of ['make', 'model', 'trim', 'bodyStyle', 'engine', 'drivetrain', 'transmission', 'fuelType',
    'exteriorColor', 'interiorColor', 'notes', 'leadId', 'dealId']) {
    if (f in b) out[f] = b[f] === null ? null : String(b[f]).trim().slice(0, f === 'notes' ? 4000 : 200);
  }
  return out;
}

// Picking a different appraiser: must be an active user at this store.
async function applyAppraiser(q, req, appraisal, appraiserId) {
  if (!appraiserId || (appraisal.appraisedBy && appraisal.appraisedBy.id === appraiserId)) return null;
  const { rows } = await q.query(
    'SELECT id, name FROM users WHERE id::text = $1 AND dealership_id = $2 AND active',
    [String(appraiserId), req.dealershipId]);
  if (!rows.length) return 'Pick an appraiser from your store.';
  appraisal.appraisedBy = { id: rows[0].id, name: rows[0].name };
  return null;
}

// Every change to the appraisal amount is kept: who, when, and how much.
function trackOfferChange(before, after, req) {
  const was = before ? before.offer : null;
  if ((after.offer ?? null) === (was ?? null)) return;
  after.offerHistory = [...(after.offerHistory || []), {
    amount: after.offer ?? null, previous: was ?? null,
    at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name }
  }].slice(-200);
}

app.get('/api/appraisals', wrap(async (req, res) => {
  res.json(await store.list(store.pool, 'appraisals', req.dealershipId));
}));

app.get('/api/appraisals/:id', wrap(async (req, res) => {
  const appraisal = await store.get(store.pool, 'appraisals', req.dealershipId, req.params.id);
  if (!appraisal) return res.status(404).json({ error: 'Appraisal not found' });
  res.json(appraisal);
}));

app.post('/api/appraisals', wrap(async (req, res) => {
  const created = await store.tx(async q => {
    const settings = await getSettings(q, req.dealershipId);
    const appraisal = {
      vin: '', year: null, make: '', model: '', trim: '', bodyStyle: '', engine: '', drivetrain: '',
      transmission: '', fuelType: '', exteriorColor: '', interiorColor: '', mileage: null, condition: '',
      equipment: [], recon: [], notes: '', leadId: null, dealId: null,
      source: 'trade_in', category: 'undecided', calcSolveFor: 'appraisal',
      targetRetail: null, targetGross: Number(settings.appraisalTargetGross) || 0, otherCosts: 0, offer: null,
      ...appraisalFields(req.body || {}),
      id: crypto.randomUUID(),
      appraisalNumber: await store.takeNextAppraisalNumber(q, req.dealershipId),
      status: 'open', // open | acquired | lost
      appraisedBy: { id: req.user.id, name: req.user.name },
      recalls: null,
      carId: null,
      offerHistory: [],
      customerOffers: [],
      dateCreated: new Date().toISOString()
    };
    trackOfferChange(null, appraisal, req);
    await store.insert(q, 'appraisals', req.dealershipId, appraisal);
    await audit.created(q, req, 'appraisal', appraisal);
    return appraisal;
  });
  res.status(201).json(created);
}));

app.put('/api/appraisals/:id', wrap(async (req, res) => {
  const updated = await store.tx(async q => {
    const appraisal = await store.get(q, 'appraisals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appraisal) return null;
    const next = { ...appraisal, ...appraisalFields(req.body || {}), dateUpdated: new Date().toISOString() };
    const problem = await applyAppraiser(q, req, next, (req.body || {}).appraiserId);
    if (problem) return { error: problem };
    trackOfferChange(appraisal, next, req);
    const saved = await store.save(q, 'appraisals', req.dealershipId, appraisal.id, next);
    await audit.updated(q, req, 'appraisal',
      { ...appraisal, dateUpdated: undefined, offerHistory: undefined },
      { ...saved, dateUpdated: undefined, offerHistory: undefined });
    return saved;
  });
  if (!updated) return res.status(404).json({ error: 'Appraisal not found' });
  if (updated.error) return res.status(400).json({ error: updated.error });
  res.json(updated);
}));

app.delete('/api/appraisals/:id', allow('deleteRecords'), wrap(async (req, res) => {
  const deleted = await store.tx(async q => {
    const removed = await store.remove(q, 'appraisals', req.dealershipId, req.params.id);
    if (removed) await audit.deleted(q, req, 'appraisal', removed);
    return removed;
  });
  if (!deleted) return res.status(404).json({ error: 'Appraisal not found' });
  res.status(204).send();
}));

// Looks up open safety recalls (NHTSA, free) and saves them on the appraisal.
app.post('/api/appraisals/:id/recalls', wrap(async (req, res) => {
  const appraisal = await store.get(store.pool, 'appraisals', req.dealershipId, req.params.id);
  if (!appraisal) return res.status(404).json({ error: 'Appraisal not found' });
  let recalls;
  try {
    recalls = await providers.fetchRecalls(appraisal);
  } catch (err) {
    if (err instanceof providers.ProviderError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const saved = await store.tx(async q => {
    const current = await store.get(q, 'appraisals', req.dealershipId, appraisal.id, { forUpdate: true });
    if (!current) return null;
    return store.save(q, 'appraisals', req.dealershipId, current.id, { ...current, recalls });
  });
  if (!saved) return res.status(404).json({ error: 'Appraisal not found' });
  res.json(saved);
}));

// The offer made to the customer. Saves it on the appraisal, and ties it to
// the customer: the linked one, or a new customer created from the name,
// phone, and email given. Also noted in the customer's activity log.
app.post('/api/appraisals/:id/customer-offer', wrap(async (req, res) => {
  const b = req.body || {};
  const amount = Number(String(b.amount ?? '').replace(/[$,\s]/g, ''));
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the offer amount.' });
  const clean = (v, max = 200) => String(v || '').trim().slice(0, max);
  const name = [clean(b.firstName, 100), clean(b.lastName, 100)].filter(Boolean).join(' ');
  const phone = clean(b.phone, 40);
  const email = clean(b.email);

  const result = await store.tx(async q => {
    const appraisal = await store.get(q, 'appraisals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appraisal) return { status: 404, error: 'Appraisal not found' };
    if (appraisal.status !== 'open') return { status: 409, error: 'Offers can only be made on open appraisals.' };

    let salesperson = null;
    if (b.salespersonId) {
      const { rows } = await q.query(
        'SELECT id, name FROM users WHERE id::text = $1 AND dealership_id = $2 AND active',
        [String(b.salespersonId), req.dealershipId]);
      if (!rows.length) return { status: 400, error: 'Pick a salesperson from your store.' };
      salesperson = { id: rows[0].id, name: rows[0].name };
    }

    let lead = appraisal.leadId ? await store.get(q, 'leads', req.dealershipId, appraisal.leadId, { forUpdate: true }) : null;
    let leadCreated = false;
    if (!lead) {
      if (!name) return { status: 400, error: "Enter the customer's name (or pick the customer on the appraisal)." };
      lead = await createLead(q, req, {
        name, phone, email, source: 'walk-in', ...(salesperson ? { sales1Id: salesperson.id } : {})
      });
      await audit.created(q, req, 'lead', lead, `From appraisal A-${appraisal.appraisalNumber}`);
      leadCreated = true;
    } else if ((phone && !lead.phone) || (email && !lead.email)) {
      const before = { ...lead };
      lead = { ...lead, phone: lead.phone || phone, email: lead.email || email };
      await audit.updated(q, req, 'lead', before, lead, `From appraisal A-${appraisal.appraisalNumber}`);
    }

    const vehicle = [appraisal.year, appraisal.make, appraisal.model].filter(Boolean).join(' ') || 'their vehicle';
    const moneyText = `$${amount.toLocaleString('en-US')}`;
    lead.activities = [{
      id: crypto.randomUUID(), type: 'note', by: { id: req.user.id, name: req.user.name },
      text: `Offered ${moneyText} for their ${vehicle} (appraisal A-${appraisal.appraisalNumber})${salesperson ? ` -- salesperson ${salesperson.name}` : ''}`,
      date: new Date().toISOString()
    }, ...(lead.activities || [])];
    await store.save(q, 'leads', req.dealershipId, lead.id, lead);

    const offer = { amount, at: new Date().toISOString(), by: { id: req.user.id, name: req.user.name }, salesperson, leadId: lead.id };
    const saved = await store.save(q, 'appraisals', req.dealershipId, appraisal.id, {
      ...appraisal, leadId: lead.id, customerOffers: [...(appraisal.customerOffers || []), offer]
    });
    await audit.record(q, req, {
      action: 'customer_offer', entityType: 'appraisal', entityId: appraisal.id, label: audit.labelFor('appraisal', saved),
      details: `${moneyText} to ${lead.name}`
    });
    return { appraisal: saved, lead, leadCreated };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result);
}));

// How this store has done on cars like this one, from its own inventory
// and deals: same make, a matching model, within two model years.
const squashName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function similarModel(a, b) {
  const x = squashName(String(a).replace(/[-\s]*class$/i, ''));
  const y = squashName(String(b).replace(/[-\s]*class$/i, ''));
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x)));
}

app.get('/api/appraisals/:id/retail-performance', wrap(async (req, res) => {
  const appraisal = await store.get(store.pool, 'appraisals', req.dealershipId, req.params.id);
  if (!appraisal) return res.status(404).json({ error: 'Appraisal not found' });
  const { year, make, model } = appraisal;
  if (!make || !model) return res.json({ ready: false });

  const cars = (await store.list(store.pool, 'cars', req.dealershipId)).filter(c =>
    c.id !== appraisal.carId &&
    squashName(c.make) === squashName(make) && similarModel(c.model, model) &&
    (!year || !c.year || Math.abs(Number(c.year) - Number(year)) <= 2));
  const deals = await store.list(store.pool, 'deals', req.dealershipId);
  const days = (from, to) => Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000));
  const avg = list => list.length ? Math.round(list.reduce((s, n) => s + n, 0) / list.length) : null;

  const sold = cars.filter(c => c.status === 'sold').map(c => {
    const deal = deals.filter(d => d.carId === c.id && ['delivered', 'closed', 'finalized'].includes(d.status)).slice(-1)[0];
    const salePrice = Number(deal && deal.vehiclePrice) || Number(c.price) || 0;
    return {
      id: c.id, year: c.year, make: c.make, model: c.model, trim: c.trim || '', mileage: c.mileage ?? null,
      stockNumber: c.stockNumber || '', salePrice, cost: Number(c.cost) || 0,
      gross: salePrice - (Number(c.cost) || 0),
      daysToSell: c.dateSold && c.dateAdded ? days(c.dateAdded, c.dateSold) : null,
      dateSold: c.dateSold || null
    };
  }).sort((a, b) => String(b.dateSold).localeCompare(String(a.dateSold)));
  const inStock = cars.filter(c => c.status !== 'sold');

  res.json({
    ready: true,
    matching: `${year ? `${Number(year) - 2}-${Number(year) + 2} ` : ''}${make} ${model}`,
    sold: {
      count: sold.length,
      avgDaysToSell: avg(sold.filter(s => s.daysToSell !== null).map(s => s.daysToSell)),
      avgSalePrice: avg(sold.map(s => s.salePrice)),
      avgGross: avg(sold.map(s => s.gross)),
      recent: sold.slice(0, 5)
    },
    inStock: {
      count: inStock.length,
      avgAskingPrice: avg(inStock.map(c => Number(c.price) || 0)),
      avgDaysInStock: avg(inStock.filter(c => c.dateAdded).map(c => days(c.dateAdded, new Date())))
    }
  });
}));

// The store bought it: create the inventory car from the appraisal and
// link the two both ways.
app.post('/api/appraisals/:id/acquire', allow('editInventory'), wrap(async (req, res) => {
  const { acquiredFor, stockNumber, askingPrice } = req.body || {};
  if (!(Number(acquiredFor) > 0)) return res.status(400).json({ error: 'Enter what the store paid (the ACV).' });

  const result = await store.tx(async q => {
    const appraisal = await store.get(q, 'appraisals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appraisal) return { status: 404, error: 'Appraisal not found' };
    if (appraisal.status === 'acquired') return { status: 409, error: 'This appraisal was already acquired.' };
    if (!appraisal.year || !appraisal.make || !appraisal.model) {
      return { status: 400, error: 'Year, make, and model are needed before it can go into inventory.' };
    }

    const car = {
      ...buildCar({
        ...appraisal,
        stockNumber,
        cost: acquiredFor,
        price: Number(askingPrice) || appraisal.targetRetail || 0,
        status: 'available'
      }),
      equipment: appraisal.equipment || [],
      sourceAppraisalId: appraisal.id
    };
    await store.insert(q, 'cars', req.dealershipId, car);
    await audit.created(q, req, 'car', car, `From appraisal A-${appraisal.appraisalNumber}`);

    const saved = await store.save(q, 'appraisals', req.dealershipId, appraisal.id, {
      ...appraisal, status: 'acquired', acquiredFor: Number(acquiredFor), acquiredAt: new Date().toISOString(),
      carId: car.id, closedAt: new Date().toISOString()
    });
    await audit.record(q, req, {
      action: 'acquire', entityType: 'appraisal', entityId: appraisal.id, label: audit.labelFor('appraisal', saved),
      details: `Acquired for $${Number(acquiredFor).toLocaleString()} -- added to inventory${stockNumber ? ` as stock #${stockNumber}` : ''}`
    });
    return { appraisal: saved, car };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
}));

app.post('/api/appraisals/:id/lost', wrap(async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  const result = await store.tx(async q => {
    const appraisal = await store.get(q, 'appraisals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appraisal) return { status: 404, error: 'Appraisal not found' };
    if (appraisal.status !== 'open') return { status: 409, error: 'Only open appraisals can be marked lost.' };
    const saved = await store.save(q, 'appraisals', req.dealershipId, appraisal.id,
      { ...appraisal, status: 'lost', lostReason: reason, closedAt: new Date().toISOString() });
    await audit.record(q, req, {
      action: 'lost', entityType: 'appraisal', entityId: appraisal.id, label: audit.labelFor('appraisal', saved),
      details: reason ? `Lost: ${reason}` : 'Lost'
    });
    return { appraisal: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.appraisal);
}));

app.post('/api/appraisals/:id/reopen', wrap(async (req, res) => {
  const result = await store.tx(async q => {
    const appraisal = await store.get(q, 'appraisals', req.dealershipId, req.params.id, { forUpdate: true });
    if (!appraisal) return { status: 404, error: 'Appraisal not found' };
    if (appraisal.status !== 'lost') return { status: 409, error: 'Only lost appraisals can be reopened.' };
    const saved = await store.save(q, 'appraisals', req.dealershipId, appraisal.id,
      { ...appraisal, status: 'open', lostReason: null, closedAt: null });
    await audit.record(q, req, { action: 'reopen', entityType: 'appraisal', entityId: appraisal.id, label: audit.labelFor('appraisal', saved) });
    return { appraisal: saved };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.appraisal);
}));

// Which outside data sources are live and which are "not available yet".
app.get('/api/providers', (req, res) => {
  res.json(providers.listProviders());
});

// ---------- AUDIT LOG ----------
// Read-only: entries are written by the routes above as changes happen,
// and there is deliberately no way to edit or delete them.

app.get('/api/audit-log', allow('viewAuditLog'), wrap(async (req, res) => {
  const { entityType, entityId, userId, from, to, search, before, limit } = req.query;
  res.json(await audit.list(req.dealershipId, { entityType, entityId, userId, from, to, search, before, limit }));
}));

// ---------- DASHBOARD STATS ----------

app.get('/api/stats', wrap(async (req, res) => {
  const cars = await store.list(store.pool, 'cars', req.dealershipId);
  const leads = await store.list(store.pool, 'leads', req.dealershipId);

  const available = cars.filter(c => c.status === 'available');
  const sold = cars.filter(c => c.status === 'sold');

  const inventoryValue = available.reduce((sum, c) => sum + c.price, 0);

  const totalProfit = sold.reduce((sum, c) => sum + (c.price - c.cost), 0);

  // Average days on lot for sold cars
  const daysOnLot = sold
    .filter(c => c.dateSold)
    .map(c => {
      const added = new Date(c.dateAdded);
      const sold = new Date(c.dateSold);
      return (sold - added) / (1000 * 60 * 60 * 24);
    });
  const avgDaysOnLot = daysOnLot.length
    ? Math.round(daysOnLot.reduce((a, b) => a + b, 0) / daysOnLot.length)
    : 0;

  const wonLeads = leads.filter(l => l.status === 'won').length;
  const closedLeads = leads.filter(l => l.status === 'won' || l.status === 'lost').length;
  const conversionRate = closedLeads ? Math.round((wonLeads / closedLeads) * 100) : 0;

  res.json({
    totalCars: cars.length,
    availableCars: available.length,
    soldCars: sold.length,
    inventoryValue,
    totalProfit,
    avgDaysOnLot,
    totalLeads: leads.length,
    conversionRate
  });
}));

// ---------- AI Assistant ----------
//
// Two features live here:
// 1. A general Q&A / report assistant that can see a snapshot of the
//    dealership's data and answer questions about it in plain English.
// 2. A "suggested reply" generator for a single lead, used from that
//    lead's profile.
//
// Both funnel through callAI() below, which is the ONLY function that
// knows how to talk to Gemini. To swap providers later (OpenAI,
// Anthropic, etc.), this is the only function that needs to change --
// everything above it (redaction, context building, the routes) stays
// exactly the same, since they just call callAI(systemInstruction, history, message).

async function callAI(systemInstruction, history, userMessage) {
  if (!GEMINI_API_KEY) {
    throw new Error('AI is not configured. Set GEMINI_API_KEY in your .env file to enable this feature.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  // Gemini's chat format: prior turns go in `contents` alternating
  // user/model, with the current message appended as the latest user turn.
  const contents = [
    ...history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

// Strip sensitive fields before anything gets sent to a third-party AI
// provider. The AI doesn't need a real SSN to answer "how many leads are
// in negotiation" or draft a follow-up text -- so it never sees one.
function redactApplicant(a) {
  if (!a) return a;
  const { ssn, licenseNumber, ...safe } = a;
  return { ...safe, ssn: ssn ? '[redacted]' : '', licenseNumber: licenseNumber ? '[redacted]' : '' };
}

function redactDeal(deal) {
  if (!deal.creditApp) return deal;
  return {
    ...deal,
    creditApp: {
      ...deal.creditApp,
      applicant: redactApplicant(deal.creditApp.applicant),
      coApplicant: redactApplicant(deal.creditApp.coApplicant)
    }
  };
}

// Builds the plain-English + JSON snapshot the AI sees for every general
// question. The dataset here is small enough to send in full each time --
// at real dealership scale you'd summarize or paginate this instead of
// dumping every record into the prompt.
async function buildDataContext(dealershipId) {
  const cars = await store.list(store.pool, 'cars', dealershipId);
  const leads = await store.list(store.pool, 'leads', dealershipId);
  const deals = await store.list(store.pool, 'deals', dealershipId);
  const today = new Date().toISOString().split('T')[0];

  const safeDeals = deals.map(redactDeal);

  return `
Today's date is ${today}.

CARS (inventory):
${JSON.stringify(cars, null, 2)}

LEADS (customers/prospects):
${JSON.stringify(leads, null, 2)}

DEALS (SSNs and license numbers redacted):
${JSON.stringify(safeDeals, null, 2)}
`;
}

app.post('/api/ai/query', async (req, res) => {
  try {
    const { question, history } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    const systemInstruction = `You are an assistant embedded in a small used-car dealership's CRM tool.
Answer questions about the dealership's inventory, leads, and deals using ONLY the data provided below.
If asked to "create a report," format your answer clearly with headings/bullet points as plain text (no markdown tables).
If the data doesn't contain what's needed to answer, say so plainly instead of guessing.
Keep answers concise and business-relevant -- this is being used by a salesperson or manager, not a developer.

${await buildDataContext(req.dealershipId)}`;

    const answer = await callAI(systemInstruction, history || [], question);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/suggest-reply', async (req, res) => {
  try {
    const { leadId } = req.body;
    const lead = leadId ? await store.get(store.pool, 'leads', req.dealershipId, leadId) : null;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const car = lead.carId ? await store.get(store.pool, 'cars', req.dealershipId, lead.carId) : null;
    const deals = await store.list(store.pool, 'deals', req.dealershipId);
    const relatedDeals = deals.filter(d => d.leadId === leadId).map(redactDeal);

    const systemInstruction = `You are a sales assistant at a used-car dealership, helping a salesperson draft a
reply or follow-up message to a specific customer. Write ONE short, professional, friendly message
(2-4 sentences) they could send by text or email. Do not invent facts not present in the data below --
only reference the vehicle, deal status, or past communications that are actually there.
Return ONLY the message text, no preamble like "Here's a draft:".

CUSTOMER: ${JSON.stringify({ name: lead.name, type: lead.type, status: lead.status, notes: lead.notes }, null, 2)}
VEHICLE THEY'RE INTERESTED IN: ${car ? JSON.stringify({ year: car.year, make: car.make, model: car.model, price: car.price, status: car.status }, null, 2) : 'None linked'}
RECENT COMMUNICATION LOG (newest first): ${JSON.stringify((lead.activities || []).slice(0, 5), null, 2)}
RELATED DEALS: ${JSON.stringify(relatedDeals, null, 2)}`;

    const suggestion = await callAI(systemInstruction, [], 'Draft the follow-up message now.');
    res.json({ suggestion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Lead Snapshot: a short summary of where things stand with this
// customer -- their situation, momentum, and a recommended next action --
// so a salesperson doesn't have to re-read the whole activity log to get
// back up to speed on a lead they haven't touched in a few days.
app.post('/api/ai/lead-snapshot', async (req, res) => {
  try {
    const { leadId } = req.body;
    const lead = leadId ? await store.get(store.pool, 'leads', req.dealershipId, leadId) : null;
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const car = lead.carId ? await store.get(store.pool, 'cars', req.dealershipId, lead.carId) : null;
    const deals = await store.list(store.pool, 'deals', req.dealershipId);
    const relatedDeals = deals.filter(d => d.leadId === leadId).map(redactDeal);
    const today = new Date().toISOString().split('T')[0];

    const systemInstruction = `You are a sales assistant at a used-car dealership. Summarize this customer's
situation for a salesperson who is about to contact them, in 3-4 sentences: where things stand, how
engaged/warm they seem based on communication recency and content, and ONE concrete recommended next action.
Do not invent facts not present in the data below. Return ONLY the summary text, no preamble or headers.

Today's date is ${today}.
CUSTOMER: ${JSON.stringify({ name: lead.name, type: lead.type, status: lead.status, source: lead.source, notes: lead.notes, dateAdded: lead.dateAdded }, null, 2)}
VEHICLE THEY'RE INTERESTED IN: ${car ? JSON.stringify({ year: car.year, make: car.make, model: car.model, price: car.price, status: car.status }, null, 2) : 'None linked'}
FULL COMMUNICATION LOG (newest first): ${JSON.stringify(lead.activities || [], null, 2)}
RELATED DEALS: ${JSON.stringify(relatedDeals, null, 2)}`;

    const snapshot = await callAI(systemInstruction, [], 'Write the snapshot now.');
    res.json({ snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unknown API addresses answer in the same { error } JSON shape as
// everything else, instead of Express's default HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Any error thrown by a route ends up here as a JSON response, matching
// the { error } shape every route already uses.
app.use((err, req, res, next) => {
  // Mistakes in a request (wrong file type, too large...) aren't server
  // problems, so only real failures go to the log.
  if (!(err instanceof multer.MulterError) && !(err.status && err.status < 500)) console.error(err);
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Each photo must be 5 MB or smaller.',
      LIMIT_FILE_COUNT: 'You can upload up to 8 photos at a time.'
    };
    return res.status(400).json({ error: messages[err.code] || err.message });
  }
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

// ---------- Startup ----------

// Makes sure there is a dealership to act for, and that it has current
// tax rate reference data. On the very first run against an empty
// database, carries over whatever was in the old data/db.json file.
async function bootstrap() {
  // Fails fast with a clear message if the encryption key isn't set,
  // rather than failing later on the first credit app save.
  encryption.getKey();

  await store.migrate();
  await encryptStoredSensitiveFields();
  await fixCarNumbersSavedAsText();

  await store.tx(async q => {
    // Serializes startup across instances so two servers booting at once
    // can't both create a default dealership or both import the JSON file.
    await q.query('SELECT pg_advisory_xact_lock(727002)');

    let { rows } = await q.query('SELECT id FROM dealerships ORDER BY created_at LIMIT 1');
    if (rows.length === 0) {
      ({ rows } = await q.query(
        'INSERT INTO dealerships (name, settings) VALUES ($1, $2) RETURNING id',
        ['My Dealership', defaultFeeSettings()]
      ));
      console.log('Created default dealership');
    }
    defaultDealershipId = rows[0].id;

    await importLegacyJson(q, defaultDealershipId);

    const dealership = await store.getDealership(q, defaultDealershipId);
    if (dealership.tax_rates_version !== TAX_RATES_SEED_VERSION) {
      await q.query('DELETE FROM tax_rates WHERE dealership_id = $1', [defaultDealershipId]);
      for (const rate of seedTaxRates()) {
        await store.insert(q, 'tax_rates', defaultDealershipId, rate);
      }
      await q.query('UPDATE dealerships SET tax_rates_version = $2 WHERE id = $1',
        [defaultDealershipId, TAX_RATES_SEED_VERSION]);
    }
  });
  await assignMissingCustomerNumbers();
}

// Customers added before customer numbers existed get one, oldest first.
async function assignMissingCustomerNumbers() {
  const { rows } = await store.pool.query(
    `SELECT dealership_id, id FROM leads WHERE NOT (data ? 'customerNumber') ORDER BY seq`);
  for (const row of rows) {
    await store.tx(async q => {
      const number = await store.takeNextCustomerNumber(q, row.dealership_id);
      await q.query(
        `UPDATE leads SET data = data || jsonb_build_object('customerNumber', $3::int)
         WHERE dealership_id = $1 AND id = $2 AND NOT (data ? 'customerNumber')`,
        [row.dealership_id, row.id, number]);
    });
  }
  if (rows.length) console.log(`Numbered ${rows.length} existing customer${rows.length === 1 ? '' : 's'}`);
}

// Credit apps saved before encryption existed have SSNs and license
// numbers in plain text. This encrypts them in place; once everything is
// encrypted it finds nothing to do.
async function encryptStoredSensitiveFields() {
  const { rows } = await store.pool.query('SELECT dealership_id, id, data FROM deals');
  let count = 0;
  for (const row of rows) {
    if (!encryption.needsSealing(row.data)) continue;
    // Only if nobody changed the deal since it was read above.
    const { rowCount } = await store.pool.query(
      'UPDATE deals SET data = $3 WHERE dealership_id = $1 AND id = $2 AND data = $4',
      [row.dealership_id, row.id, encryption.sealDeal(row.data), row.data]);
    count += rowCount;
  }
  if (count) console.log(`Encrypted SSNs/license numbers on ${count} existing deal${count === 1 ? '' : 's'}`);
}

// Before car edits converted numbers, editing a car saved year, mileage,
// cost, and price as text, which broke dashboard totals. This converts any
// such values back to numbers; once none are left it finds nothing to do.
async function fixCarNumbersSavedAsText() {
  const { rows } = await store.pool.query(
    `SELECT dealership_id, id, data FROM cars
     WHERE jsonb_typeof(data->'year') = 'string' OR jsonb_typeof(data->'mileage') = 'string'
        OR jsonb_typeof(data->'cost') = 'string' OR jsonb_typeof(data->'price') = 'string'`
  );
  let count = 0;
  for (const row of rows) {
    const fixed = { ...row.data };
    for (const field of ['year', 'mileage', 'cost', 'price']) {
      if (typeof fixed[field] === 'string') fixed[field] = Number(fixed[field]) || 0;
    }
    const { rowCount } = await store.pool.query(
      'UPDATE cars SET data = $3 WHERE dealership_id = $1 AND id = $2 AND data = $4',
      [row.dealership_id, row.id, fixed, row.data]);
    count += rowCount;
  }
  if (count) console.log(`Fixed numbers saved as text on ${count} car${count === 1 ? '' : 's'}`);
}

// One-time carry-over from the old JSON file into Postgres. Only runs if
// this dealership has never imported and has no records yet, so it can
// never duplicate or overwrite data that's already in the database.
async function importLegacyJson(q, dealershipId) {
  const dealership = await store.getDealership(q, dealershipId);
  if (dealership.imported_from_json_at) return;

  const markDone = () => q.query(
    'UPDATE dealerships SET imported_from_json_at = now() WHERE id = $1', [dealershipId]);

  const { rows } = await q.query(
    `SELECT (SELECT count(*) FROM cars WHERE dealership_id = $1)
          + (SELECT count(*) FROM leads WHERE dealership_id = $1)
          + (SELECT count(*) FROM deals WHERE dealership_id = $1) AS n`,
    [dealershipId]
  );
  if (Number(rows[0].n) > 0 || !fs.existsSync(LEGACY_JSON_PATH)) return markDone();

  const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf-8'));
  for (const car of legacy.cars || []) await store.insert(q, 'cars', dealershipId, car);
  for (const lead of legacy.leads || []) await store.insert(q, 'leads', dealershipId, lead);
  for (const deal of legacy.deals || []) await store.insert(q, 'deals', dealershipId, deal);

  // Keep the admin's tax table only if it's already on the current seed
  // version; otherwise bootstrap() re-seeds it right after this.
  if (legacy.taxRatesVersion === TAX_RATES_SEED_VERSION && Array.isArray(legacy.taxRates)) {
    for (const rate of legacy.taxRates) await store.insert(q, 'tax_rates', dealershipId, rate);
    await q.query('UPDATE dealerships SET tax_rates_version = $2 WHERE id = $1',
      [dealershipId, TAX_RATES_SEED_VERSION]);
  }

  const maxDealNumber = Math.max(1000, ...(legacy.deals || []).map(d => Number(d.dealNumber) || 0));
  await q.query(
    'UPDATE dealerships SET settings = $2, next_deal_number = $3 WHERE id = $1',
    [
      dealershipId,
      { ...defaultFeeSettings(), ...(legacy.settings || {}) },
      Math.max(Number(legacy.nextDealNumber) || 1001, maxDealNumber + 1)
    ]
  );
  await markDone();
  console.log(`Imported ${(legacy.cars || []).length} cars, ${(legacy.leads || []).length} leads, ` +
    `and ${(legacy.deals || []).length} deals from data/db.json`);
}

// Tests import the app without starting a listener.
if (require.main === module) {
  bootstrap()
    .then(() => auth.announceSetupIfNeeded(process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`))
    .then(() => {
      app.listen(PORT, () => {
        if (photos.cloudinaryProblem()) {
          console.error(`Car photos: ${photos.cloudinaryProblem()} Photo uploads are turned off until it's fixed.`);
        } else {
          console.log(photos.usingCloudinary()
            ? `Car photos: stored in Cloudinary (${photos.cloudinaryConfig().cloudName})`
            : 'Car photos: stored on this server\'s disk (set CLOUDINARY_URL to keep them across redeploys)');
        }
        console.log(`Car CRM server running at http://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}

module.exports = { app, bootstrap };
