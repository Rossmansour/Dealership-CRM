// server.js
// Simple Express backend for a Car Dealership Inventory + CRM tool.
// Data is stored in a JSON file (data/db.json) instead of a real database,
// which keeps setup dead simple (no install/config needed) while still
// exercising real REST API patterns (GET/POST/PUT/DELETE).

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Tiny JSON "database" helpers ----------

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = { cars: [], leads: [], deals: [], nextDealNumber: 1001 };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
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
  const { make, model, year, vin, mileage, cost, price, status } = req.body;

  if (!make || !model || !year || !price) {
    return res.status(400).json({ error: 'make, model, year, and price are required' });
  }

  const newCar = {
    id: crypto.randomUUID(),
    make,
    model,
    year: Number(year),
    vin: vin || '',
    mileage: Number(mileage) || 0,
    cost: Number(cost) || 0,
    price: Number(price),
    status: status || 'available', // available | pending | sold
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

// ---------- DEALS (Deal Calculator + Proposals) ----------
//
// A "deal" bundles together a car, a lead, and the numbers needed to
// figure out the customer's monthly payment: trade-in, rebate, down
// payment, tax, and fees. The math is done here on the server so there's
// one source of truth -- the frontend just displays whatever this
// function calculates, it never re-does the math itself.

function calculateDeal(input) {
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

  // Net trade-in equity: what the trade is actually worth toward the deal
  // after paying off whatever is still owed on it. Can be negative if the
  // customer owes more than the trade is worth (negative equity).
  const netTradeIn = tradeInValue - tradeInPayoff;

  // Most states apply sales tax to the price AFTER trade-in credit, but
  // BEFORE manufacturer rebates (rebates are still taxed in most states).
  // This is a simplification worth calling out -- actual rules vary by state.
  const taxableAmount = Math.max(vehiclePrice - netTradeIn, 0);
  const salesTax = taxableAmount * (taxRate / 100);

  const totalFees = docFee + titleFee + registrationFee;

  // What's left to finance after trade-in, rebate, and down payment are
  // subtracted, then tax and fees are added back in.
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
    totalFees,
    amountFinanced: round2(amountFinanced),
    apr,
    termMonths,
    monthlyPayment: round2(monthlyPayment),
    totalOfPayments: round2(totalOfPayments),
    totalDealCost: round2(totalDealCost)
  };
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

  const { leadId, carId } = req.body;
  if (!leadId || !carId) {
    return res.status(400).json({ error: 'leadId and carId are required' });
  }

  const car = db.cars.find(c => c.id === carId);
  const calculated = calculateDeal({
    vehiclePrice: req.body.vehiclePrice || (car ? car.price : 0),
    taxRate: req.body.taxRate ?? 7,
    docFee: req.body.docFee ?? 150,
    titleFee: req.body.titleFee ?? 75,
    registrationFee: req.body.registrationFee ?? 50,
    apr: req.body.apr ?? 6.5,
    termMonths: req.body.termMonths ?? 60
  });

  const newDeal = {
    id: crypto.randomUUID(),
    dealNumber: db.nextDealNumber,
    leadId,
    carId,
    status: 'working', // working | credit_submitted | approved | declined | finalized
    hasTrade: false,
    ...calculated,
    creditApp: defaultCreditApp(),
    dateCreated: new Date().toISOString()
  };

  db.nextDealNumber += 1;
  db.deals.push(newDeal);
  writeDB(db);
  res.status(201).json(newDeal);
});

// PUT (update/recalculate) an existing deal's desking numbers or status.
// Credit app fields are preserved automatically since they're not part
// of req.body in a normal desking update -- see the dedicated
// /credit-app route below for updating that section specifically.
app.put('/api/deals/:id', (req, res) => {
  const db = readDB();
  if (!db.deals) db.deals = [];
  const idx = db.deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Deal not found' });

  const merged = { ...db.deals[idx], ...req.body };
  const calculated = calculateDeal(merged);

  db.deals[idx] = { ...merged, ...calculated };
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

app.listen(PORT, () => {
  console.log(`Car CRM server running at http://localhost:${PORT}`);
});
