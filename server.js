// server.js
// Simple Express backend for a Car Dealership Inventory + CRM tool.
// Data is stored in a JSON file (data/db.json) instead of a real database,
// which keeps setup dead simple (no install/config needed) while still
// exercising real REST API patterns (GET/POST/PUT/DELETE).

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

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
// Car photos are saved to disk under public/uploads/cars, which Express
// already serves statically -- so a saved file at
// public/uploads/cars/abc123.jpg is reachable at /uploads/cars/abc123.jpg
// with zero extra routing. NOTE: on a host with an ephemeral filesystem
// (like Render's free tier), these files disappear on restart, same as
// data/db.json -- fine for a demo, not for real production use.
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'cars');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per photo
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Tiny JSON "database" helpers ----------

// Bumping this forces every existing db.json (including ones already
// deployed) to pick up a fresh seedTaxRates() on next read, rather than
// treating "some array already exists" as "nothing to do." This is what
// closes the actual bug: a stale, partially-seeded taxRates array from an
// earlier version silently persisted forever because the old check only
// asked "is it missing?", not "is it current?".
const TAX_RATES_SEED_VERSION = 2;

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = { cars: [], leads: [], deals: [], nextDealNumber: 1001, settings: defaultFeeSettings() };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(raw);
  if (!db.settings) db.settings = defaultFeeSettings();
  if (!db.taxRates || db.taxRatesVersion !== TAX_RATES_SEED_VERSION) {
    db.taxRates = seedTaxRates();
    db.taxRatesVersion = TAX_RATES_SEED_VERSION;
    writeDB(db); // persist the migration immediately, not just in memory
  }
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
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
    dmvFeePercentage: 1.5
  };
}

app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json(db.settings);
});

app.put('/api/settings', (req, res) => {
  const db = readDB();
  db.settings = { ...defaultFeeSettings(), ...db.settings, ...req.body };
  writeDB(db);
  res.json(db.settings);
});

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

app.get('/api/tax-rates', (req, res) => {
  const db = readDB();
  const { state } = req.query;
  let rates = db.taxRates;
  if (state) rates = rates.filter(r => r.state.toUpperCase() === state.toUpperCase());
  res.json(rates);
});

app.post('/api/tax-rates', (req, res) => {
  const db = readDB();
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
  db.taxRates.push(newRate);
  writeDB(db);
  res.status(201).json(newRate);
});

app.put('/api/tax-rates/:id', (req, res) => {
  const db = readDB();
  const idx = db.taxRates.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Tax rate not found' });

  db.taxRates[idx] = { ...db.taxRates[idx], ...req.body };
  writeDB(db);
  res.json(db.taxRates[idx]);
});

app.delete('/api/tax-rates/:id', (req, res) => {
  const db = readDB();
  const idx = db.taxRates.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Tax rate not found' });

  db.taxRates.splice(idx, 1);
  writeDB(db);
  res.status(204).send();
});

// Finds the best-matching reference record for a customer's address:
// exact state+county+city match first, then state+county with no city
// specified (a county-wide default), then a bare state-level default.
// Returns null if nothing at all matches that state.
function findBestTaxRateMatch(db, state, county, city) {
  const normalizedState = (state || '').toUpperCase();
  const normalizedCounty = (county || '').trim();
  const normalizedCity = (city || '').trim();

  const inState = db.taxRates.filter(r => r.state === normalizedState);
  if (inState.length === 0) return null;

  const exact = inState.find(r => r.county === normalizedCounty && r.city && r.city === normalizedCity);
  if (exact) return exact;

  const countyMatch = inState.find(r => r.county === normalizedCounty && !r.city);
  if (countyMatch) return countyMatch;

  const stateDefault = inState.find(r => !r.county && !r.city);
  return stateDefault || inState[0];
}

// ---------- CARS (Inventory) ----------

// GET all cars, with optional ?status= and ?search= filters
app.get('/api/cars', (req, res) => {
  const db = readDB();
  let cars = db.cars;

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
});

// GET a single car by id
app.get('/api/cars/:id', (req, res) => {
  const db = readDB();
  const car = db.cars.find(c => c.id === req.params.id);
  if (!car) return res.status(404).json({ error: 'Car not found' });
  res.json(car);
});

// POST a new car
app.post('/api/cars', (req, res) => {
  const db = readDB();
  const { make, model, year, vin, stockNumber, mileage, cost, price, status } = req.body;

  if (!make || !model || !year || !price) {
    return res.status(400).json({ error: 'make, model, year, and price are required' });
  }

  const newCar = {
    id: crypto.randomUUID(),
    make,
    model,
    year: Number(year),
    vin: vin || '',
    stockNumber: stockNumber || '',
    mileage: Number(mileage) || 0,
    cost: Number(cost) || 0,
    price: Number(price),
    status: status || 'available', // available | pending | sold
    photos: [], // array of paths like /uploads/cars/abc123.jpg
    openROs: [], // groundwork for the future Service module -- empty until Service exists
    dateAdded: new Date().toISOString(),
    dateSold: null
  };

  db.cars.push(newCar);
  writeDB(db);
  res.status(201).json(newCar);
});

// PUT (update) an existing car
app.put('/api/cars/:id', (req, res) => {
  const db = readDB();
  const idx = db.cars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Car not found' });

  const updates = req.body;

  // If status is changing to "sold" for the first time, stamp the date.
  if (updates.status === 'sold' && db.cars[idx].status !== 'sold') {
    updates.dateSold = new Date().toISOString();
  }

  db.cars[idx] = { ...db.cars[idx], ...updates };
  writeDB(db);
  res.json(db.cars[idx]);
});

// DELETE a car
app.delete('/api/cars/:id', (req, res) => {
  const db = readDB();
  const idx = db.cars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Car not found' });

  db.cars.splice(idx, 1);
  writeDB(db);
  res.status(204).send();
});

// ---------- Car photos ----------

// Upload one or more photos for a car. Field name must be "photos".
app.post('/api/cars/:id/photos', upload.array('photos', 8), (req, res) => {
  const db = readDB();
  const car = db.cars.find(c => c.id === req.params.id);
  if (!car) return res.status(404).json({ error: 'Car not found' });

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No photos were uploaded.' });
  }

  if (!car.photos) car.photos = [];
  const newPaths = req.files.map(f => `/uploads/cars/${f.filename}`);
  car.photos.push(...newPaths);

  writeDB(db);
  res.status(201).json({ photos: car.photos });
});

// Delete one photo from a car (removes both the DB reference and the file on disk).
app.delete('/api/cars/:id/photos', (req, res) => {
  const db = readDB();
  const car = db.cars.find(c => c.id === req.params.id);
  if (!car) return res.status(404).json({ error: 'Car not found' });

  const { photoPath } = req.body;
  if (!photoPath) return res.status(400).json({ error: 'photoPath is required' });

  car.photos = (car.photos || []).filter(p => p !== photoPath);
  writeDB(db);

  // Best-effort cleanup of the actual file -- if it's already gone
  // (e.g. wiped by a host restart), that's fine, just move on.
  const filename = path.basename(photoPath);
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.unlink(filePath, () => {});

  res.status(204).send();
});

// ---------- LEADS (CRM) ----------

app.get('/api/leads', (req, res) => {
  const db = readDB();
  let leads = db.leads;

  const { status } = req.query;
  if (status) {
    leads = leads.filter(l => l.status === status);
  }

  res.json(leads);
});

app.post('/api/leads', (req, res) => {
  const db = readDB();
  const { name, phone, email, carId, notes, status, source, type } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const newLead = {
    id: crypto.randomUUID(),
    name,
    type: type === 'business' ? 'business' : 'individual',
    phone: phone || '',
    email: email || '',
    carId: carId || null,
    notes: notes || '',
    status: status || 'new', // new | contacted | negotiating | won | lost
    source: source || 'other', // walk-in | phone | website | referral | autotrader | cargurus | facebook | other
    activities: [], // communication log: { id, type, text, date }
    dateAdded: new Date().toISOString()
  };

  db.leads.push(newLead);
  writeDB(db);
  res.status(201).json(newLead);
});

app.put('/api/leads/:id', (req, res) => {
  const db = readDB();
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });

  db.leads[idx] = { ...db.leads[idx], ...req.body };
  writeDB(db);
  res.json(db.leads[idx]);
});

app.delete('/api/leads/:id', (req, res) => {
  const db = readDB();
  const idx = db.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lead not found' });

  db.leads.splice(idx, 1);
  writeDB(db);
  res.status(204).send();
});

// ---------- Lead activity log (calls, texts, emails, notes) ----------

app.post('/api/leads/:id/activities', (req, res) => {
  const db = readDB();
  const lead = db.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const { type, text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  if (!lead.activities) lead.activities = [];
  const activity = {
    id: crypto.randomUUID(),
    type: type || 'note', // call | text | email | note
    text,
    date: new Date().toISOString()
  };
  lead.activities.unshift(activity); // newest first
  writeDB(db);
  res.status(201).json(activity);
});

app.delete('/api/leads/:id/activities/:activityId', (req, res) => {
  const db = readDB();
  const lead = db.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  lead.activities = (lead.activities || []).filter(a => a.id !== req.params.activityId);
  writeDB(db);
  res.status(204).send();
});

// ---------- Real SMS sending (Twilio) ----------
//
// This is deliberately separate from the manual "log a text I already
// sent" flow above -- this one actually dials out to Twilio and sends a
// real message, so it needs its own explicit action rather than being
// folded into the general activity log form.

app.post('/api/leads/:id/send-text', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({
      error: 'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in your .env file to enable this feature.'
    });
  }

  const db = readDB();
  const lead = db.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (!lead.phone) return res.status(400).json({ error: 'This lead has no phone number on file.' });

  const { text, photoPath } = req.body;
  if (!text && !photoPath) return res.status(400).json({ error: 'text or photoPath is required' });

  try {
    const messagePayload = {
      body: text || '',
      from: TWILIO_PHONE_NUMBER,
      to: lead.phone
    };

    // Sending a photo turns this into an MMS -- Twilio needs a full,
    // publicly-reachable URL for the image, not a relative path, so we
    // build one from the incoming request's own host.
    if (photoPath) {
      const publicUrl = `${req.protocol}://${req.get('host')}${photoPath}`;
      messagePayload.mediaUrl = [publicUrl];
    }

    const message = await twilioClient.messages.create(messagePayload);

    // Log it in the activity feed automatically so the send is part of
    // the same history as manually-logged calls/texts/notes.
    if (!lead.activities) lead.activities = [];
    const logText = photoPath
      ? `${text ? text + ' ' : ''}[photo attached] (sent via ${text ? 'MMS' : 'MMS, no caption'})`
      : `${text} (sent via SMS)`;
    const activity = {
      id: crypto.randomUUID(),
      type: 'text',
      text: logText,
      date: new Date().toISOString()
    };
    lead.activities.unshift(activity);
    writeDB(db);

    res.status(201).json({ activity, twilioSid: message.sid, status: message.status });
  } catch (err) {
    // Twilio errors are usually about trial account restrictions
    // (unverified recipient number) or a malformed phone number --
    // pass the real message through so it's actionable, not just "failed".
    res.status(500).json({ error: err.message });
  }
});

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
function calculateCaliforniaFees(price) {
  const vlf = price * 0.0065;
  let tif;
  if (price < 5000) tif = 28;
  else if (price < 25000) tif = 56;
  else if (price < 35000) tif = 112;
  else if (price < 60000) tif = 168;
  else tif = 224;

  return {
    taxRate: null, // filled in by caller from the ZIP lookup
    registrationFee: round2(74 + 29 + tif),
    titleFee: 28,
    licenseFee: round2(vlf)
  };
}

// Arizona: Vehicle License Tax (VLT) is 60% of the vehicle's value in
// year one, depreciating 16.25% per year after that, taxed at $2.80 per
// $100 for a new vehicle or $2.89 per $100 once it's a renewal/used
// vehicle -- genuinely age-dependent, calculated here from the vehicle's
// model year, not just a flat guess.
function calculateArizonaFees(price, vehicleYear) {
  const currentYear = new Date().getFullYear();
  const age = Math.max(currentYear - (Number(vehicleYear) || currentYear), 0);

  let assessedValue = price * 0.60;
  for (let i = 0; i < age; i++) {
    assessedValue *= 0.8375; // 16.25% annual depreciation
  }
  const vltRate = age === 0 ? 2.80 : 2.89;
  const vlt = (assessedValue / 100) * vltRate;

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
function calculateStateFees(db, state, zip, price, vehicleYear, county, city) {
  const normalizedState = (state || '').trim().toUpperCase();

  if (normalizedState === 'AZ') {
    const resolvedCounty = county || lookupCounty(zip, AZ_COUNTY_BY_ZIP_PREFIX);
    const fees = calculateArizonaFees(price, vehicleYear);
    const rateMatch = findBestTaxRateMatch(db, 'AZ', resolvedCounty, city);
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
  const rateMatch = findBestTaxRateMatch(db, 'CA', resolvedCounty, city);
  fees.county = resolvedCounty;
  fees.taxRate = rateMatch ? round2(rateMatch.stateTaxRate + rateMatch.countyTaxRate + rateMatch.cityTaxRate) : CA_STATEWIDE_BASE_RATE;
  fees.rateSource = rateMatch ? rateMatch.id : 'no match -- using statewide base';
  fees.stateUsed = (normalizedState === 'CA') ? 'CA' : `CA (fallback -- ${normalizedState || 'no state on file'} not yet built)`;
  fees.tradeInReducesTaxableAmount = false; // California taxes the full price; trade-in does not reduce it
  return fees;
}

app.post('/api/fees/calculate', (req, res) => {
  const { state, zip, price, vehicleYear, county, city } = req.body;
  if (!price) return res.status(400).json({ error: 'price is required' });

  const db = readDB();
  const result = calculateStateFees(db, state, zip, Number(price), vehicleYear, county, city);
  res.json(result);
});

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

app.get('/api/deals', (req, res) => {
  const db = readDB();
  res.json(db.deals || []);
});

app.get('/api/deals/:id', (req, res) => {
  const db = readDB();
  const deal = (db.deals || []).find(d => d.id === req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json(deal);
});

// POST a new deal: just needs a lead + car to start. This generates the
// deal number and creates a "working" deal with the vehicle price
// pre-filled and everything else at sensible defaults -- the sales rep
// fills in the rest in the desking tool.
app.post('/api/deals', (req, res) => {
  const db = readDB();
  if (!db.deals) db.deals = [];
  if (!db.nextDealNumber) db.nextDealNumber = 1001;

  // Customer and vehicle are both optional at creation -- a deal number
  // can be opened before either is known and filled in later from the
  // Desking tab, matching how a desk sometimes starts a deal before all
  // the paperwork is in hand.
  const { leadId, carId } = req.body;

  const car = carId ? db.cars.find(c => c.id === carId) : null;
  const fees = db.settings || defaultFeeSettings();
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

  const newDeal = {
    id: crypto.randomUUID(),
    dealNumber: db.nextDealNumber,
    leadId: leadId || null,
    carId: carId || null,
    status: 'working', // working | delivered | closed | finalized
    hasTrade: false,
    ...calculated,
    creditApp: defaultCreditApp(),
    dateCreated: new Date().toISOString()
  };

  db.nextDealNumber += 1;
  db.deals.push(newDeal);
  syncCarStatusToDeal(db, newDeal);
  writeDB(db);
  res.status(201).json(newDeal);
});

// PUT (update/recalculate) an existing deal's desking numbers or status.
// Credit app fields are preserved automatically since they're not part
// of req.body in a normal desking update -- see the dedicated
// /credit-app route below for updating that section specifically.
// Vehicle Management tie-in: a deal's progress should be reflected on the
// actual vehicle record without a sales manager having to update both
// places by hand. Working a deal on a car takes it off the available
// list; delivering/closing/finalizing it marks the car sold. Shared by
// both deal creation and deal updates so the rule only lives in one place.
function syncCarStatusToDeal(db, deal) {
  if (!deal.carId) return;
  const car = db.cars.find(c => c.id === deal.carId);
  if (!car) return;

  if (['delivered', 'closed', 'finalized'].includes(deal.status) && car.status !== 'sold') {
    car.status = 'sold';
    car.dateSold = car.dateSold || new Date().toISOString();
  } else if (deal.status === 'working' && car.status === 'available') {
    car.status = 'pending';
  }
}

app.put('/api/deals/:id', (req, res) => {
  const db = readDB();
  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });

  const merged = { ...db.deals[idx], ...req.body };
  const calculated = calculateDeal(merged);

  db.deals[idx] = { ...merged, ...calculated };
  syncCarStatusToDeal(db, db.deals[idx]);

  writeDB(db);
  res.json(db.deals[idx]);
});

// PUT the credit application section of a deal. The frontend sends the
// whole creditApp object each time (it's really one form), so this
// merges it over the defaults rather than doing a shallow patch --
// that way any field the frontend didn't know about yet still gets a
// safe default instead of `undefined`.
app.put('/api/deals/:id/credit-app', (req, res) => {
  const db = readDB();
  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });

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

  // Stamp the submission date the first time status moves off "not_submitted"
  const existing = db.deals[idx].creditApp || defaults;
  if (updatedCreditApp.status !== 'not_submitted' && !existing.dateSubmitted) {
    updatedCreditApp.dateSubmitted = new Date().toISOString();
  } else {
    updatedCreditApp.dateSubmitted = existing.dateSubmitted || null;
  }

  db.deals[idx].creditApp = updatedCreditApp;
  writeDB(db);
  res.json(db.deals[idx]);
});

app.delete('/api/deals/:id', (req, res) => {
  const db = readDB();
  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });

  db.deals.splice(idx, 1);
  writeDB(db);
  res.status(204).send();
});

// ---------- DASHBOARD STATS ----------

app.get('/api/stats', (req, res) => {
  const db = readDB();
  const { cars, leads } = db;

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
});

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
  const { ssn, ...safe } = a;
  return { ...safe, ssn: ssn ? '[redacted]' : '' };
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
function buildDataContext() {
  const db = readDB();
  const today = new Date().toISOString().split('T')[0];

  const safeDeals = (db.deals || []).map(redactDeal);

  return `
Today's date is ${today}.

CARS (inventory):
${JSON.stringify(db.cars, null, 2)}

LEADS (customers/prospects):
${JSON.stringify(db.leads, null, 2)}

DEALS (SSNs redacted):
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

${buildDataContext()}`;

    const answer = await callAI(systemInstruction, history || [], question);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/suggest-reply', async (req, res) => {
  try {
    const { leadId } = req.body;
    const db = readDB();
    const lead = db.leads.find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const car = db.cars.find(c => c.id === lead.carId);
    const relatedDeals = (db.deals || []).filter(d => d.leadId === leadId).map(redactDeal);

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
    const db = readDB();
    const lead = db.leads.find(l => l.id === leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const car = db.cars.find(c => c.id === lead.carId);
    const relatedDeals = (db.deals || []).filter(d => d.leadId === leadId).map(redactDeal);
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

app.listen(PORT, () => {
  console.log(`Car CRM server running at http://localhost:${PORT}`);
});
