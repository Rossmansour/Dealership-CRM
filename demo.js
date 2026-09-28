// demo.js
// Demo data, so the store can see the whole system working before its own
// data is in: staff (salespeople, BDC, F&I, advisors, technicians, parts),
// cars, customers with activity, sold and working deals, repair orders
// (open and closed, with tech time and recon), service appointments, parts
// on the shelf, counter tickets, and special orders.
//
// Everything it creates is marked demo: true (staff get an
// @demo.dealerdomus.app email), and "Remove demo data" deletes exactly
// that -- nothing the store entered itself. Demo staff get random
// passwords; an admin can set one under Users to sign in as them.

const express = require('express');
const crypto = require('crypto');
const store = require('./db');
const auth = require('./auth');
const audit = require('./audit');
const service = require('./service');

const DEMO_DOMAIN = '@demo.dealerdomus.app';
const DEMO_TABLES = ['recon_units', 'special_orders', 'parts_tickets', 'part_moves', 'parts', 'service_appointments', 'repair_orders', 'tasks', 'deals', 'leads', 'cars'];

const uuid = () => crypto.randomUUID();
const DAY = 86400000;
const at = (daysAgo, hour = 10, minute = 0) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const fakeVin = (seed) => {
  let x = seed * 7919 + 17;
  let out = '';
  for (let i = 0; i < 17; i++) { x = (x * 48271) % 2147483647; out += VIN_CHARS[x % VIN_CHARS.length]; }
  return out;
};
const address = (street, city, state, zip) => ({ street, unit: '', city, state, zip, county: '' });

const STAFF = [
  ['rob', 'Rob Carter', 'sales_manager'], ['jake', 'Jake Miller', 'salesperson'], ['ashley', 'Ashley Green', 'salesperson'],
  ['chris', 'Chris Johnson', 'salesperson'], ['nina', 'Nina Lopez', 'bdc'], ['karen', 'Karen White', 'finance'],
  ['dana', 'Dana Brooks', 'service_advisor'], ['luis', 'Luis Ortega', 'service_advisor'],
  ['mike', 'Mike Chen', 'technician', { type: 'flat', rate: 32 }], ['tony', 'Tony Russo', 'technician', { type: 'flat', rate: 28 }],
  ['sam', 'Sam Patel', 'technician', { type: 'hourly', rate: 26 }], ['gary', 'Gary Hill', 'parts_manager']
];

// [stock, type, year, make, model, trim, color, miles, cost, price, daysInStock]
const CARS = [
  ['N2501', 'new', 2025, 'Ford', 'F-150', 'XLT SuperCrew', 'Agate Black', 12, 48900, 54995, 18],
  ['N2502', 'new', 2025, 'Ford', 'Explorer', 'ST-Line', 'Carbonized Gray', 8, 41200, 45995, 34],
  ['N2503', 'new', 2025, 'Ford', 'Escape', 'Active', 'Oxford White', 15, 28900, 31995, 9],
  ['N2504', 'new', 2025, 'Ford', 'Bronco Sport', 'Big Bend', 'Cactus Gray', 11, 30100, 33495, 71],
  ['N2505', 'new', 2025, 'Ford', 'Mustang', 'GT Fastback', 'Race Red', 6, 44800, 49995, 27],
  ['U2401', 'used', 2021, 'Chevrolet', 'Silverado 1500', 'LT', 'Summit White', 38210, 31500, 36995, 12],
  ['U2402', 'used', 2020, 'Toyota', 'Camry', 'SE', 'Celestial Silver', 41877, 19800, 23495, 6],
  ['U2403', 'used', 2019, 'Honda', 'Accord', 'Sport', 'Modern Steel', 52330, 17900, 21495, 22],
  ['U2404', 'used', 2018, 'Jeep', 'Wrangler Unlimited', 'Sahara', 'Firecracker Red', 61200, 24500, 29995, 64],
  ['U2405', 'used', 2022, 'Hyundai', 'Tucson', 'SEL', 'Amazon Gray', 24410, 22300, 26495, 3],
  ['U2406', 'used', 2019, 'BMW', 'X3', 'xDrive30i', 'Alpine White', 47800, 23900, 28495, 40],
  ['U2407', 'used', 2017, 'Nissan', 'Altima', '2.5 SV', 'Gun Metallic', 78900, 9800, 13495, 2],
  // sold (for deals)
  ['U2380', 'used', 2020, 'Ford', 'Edge', 'SEL', 'Rapid Red', 36100, 20500, 24995, 30],
  ['N2480', 'new', 2025, 'Ford', 'Maverick', 'XLT Hybrid', 'Azure Gray', 9, 27900, 31495, 25],
  ['U2381', 'used', 2021, 'Toyota', 'RAV4', 'XLE', 'Blueprint', 29800, 24100, 28995, 20],
  ['N2481', 'new', 2025, 'Ford', 'F-150', 'Lariat', 'Star White', 5, 58900, 65495, 14],
  ['U2382', 'used', 2018, 'Honda', 'CR-V', 'EX', 'Lunar Silver', 58400, 16200, 20495, 33],
  ['U2383', 'used', 2019, 'Chevrolet', 'Equinox', 'LT', 'Mosaic Black', 44100, 14800, 18995, 45]
];

// [name, phone, email, source, status, sales, bdc, hot, daysAgo, carStock, activity]
const LEADS = [
  ['Maria Gonzalez', '(602) 555-0142', 'maria.g@example.com', 'website', 'negotiating', 'jake', 'nina', true, 2, 'U2401', 'Wants to see the Silverado Saturday. Trade: 2014 Tacoma.'],
  ['David Kim', '(602) 555-0177', 'dkim@example.com', 'cargurus', 'contacted', 'ashley', 'nina', false, 1, 'U2402', 'Asked for out-the-door price on the Camry.'],
  ['Jessica Moore', '(480) 555-0110', 'jmoore@example.com', 'walk-in', 'new', 'chris', null, false, 0, 'N2503', ''],
  ['Brian Thompson', '(480) 555-0199', 'brian.t@example.com', 'phone', 'contacted', 'jake', null, true, 3, 'N2501', 'Needs a truck for work, pre-approved with his credit union.'],
  ['Emily Davis', '(623) 555-0134', 'emily.davis@example.com', 'autotrader', 'new', null, 'nina', false, 0, 'U2405', ''],
  ['Carlos Ramirez', '(602) 555-0156', 'cramirez@example.com', 'facebook', 'negotiating', 'ashley', null, false, 5, 'U2404', 'Countered at $28,000. Waiting on manager.'],
  ['Ashley Nguyen', '(480) 555-0121', 'anguyen@example.com', 'referral', 'contacted', 'chris', 'nina', false, 8, 'N2505', 'Referred by Tom Baker. Test drive booked.'],
  ['Kevin Walsh', '(623) 555-0188', 'kwalsh@example.com', 'website', 'lost', 'jake', 'nina', false, 20, 'U2406', 'Bought elsewhere.'],
  ['Laura Chen', '(602) 555-0163', 'laura.chen@example.com', 'cargurus', 'new', null, null, false, 0, 'U2403', ''],
  ['Tom Baker', '(480) 555-0105', 'tbaker@example.com', 'referral', 'won', 'jake', null, false, 26, null, 'Bought the Edge. Great customer.'],
  ['Sarah Johnson', '(623) 555-0147', 'sjohnson@example.com', 'website', 'won', 'ashley', 'nina', false, 22, null, 'Delivered the Maverick.'],
  ['Mark Wilson', '(602) 555-0171', 'mwilson@example.com', 'walk-in', 'won', 'chris', null, false, 18, null, ''],
  ['Rachel Adams', '(480) 555-0138', 'radams@example.com', 'phone', 'won', 'jake', null, false, 12, null, ''],
  ['Daniel Lee', '(623) 555-0159', 'dlee@example.com', 'autotrader', 'won', 'ashley', null, false, 40, null, ''],
  ['Olivia Martinez', '(602) 555-0114', 'omartinez@example.com', 'facebook', 'won', 'chris', null, false, 45, null, ''],
  ['Frank Russo', '(480) 555-0182', 'frusso@example.com', 'phone', 'contacted', 'jake', null, false, 60, null, 'Service customer. 2016 F-150 with 98k miles -- good trade candidate.']
];

// Sold deals: [lead, carStock, daysAgo, status, gap, service, fiCost, reserve, incentives]
const SOLD = [
  ['Tom Baker', 'U2380', 4, 'finalized', 895, 1995, 1100, 650, 0],
  ['Sarah Johnson', 'N2480', 9, 'finalized', 0, 1495, 700, 420, 1000],
  ['Mark Wilson', 'U2381', 2, 'delivered', 795, 0, 350, 510, 0],
  ['Rachel Adams', 'N2481', 6, 'finalized', 995, 2495, 1400, 880, 1500],
  ['Daniel Lee', 'U2382', 35, 'finalized', 0, 0, 0, 300, 0],
  ['Olivia Martinez', 'U2383', 41, 'finalized', 795, 1795, 950, 450, 0]
];

// Parts: [number, description, brand, bin, cost, price, onHand, reorderPoint, reorderQty]
const PARTS = [
  ['FL-820S', 'Oil filter', 'Motorcraft', 'A1-03', 6.5, 14.99, 36, 12, 24],
  ['FL-500S', 'Oil filter (EcoBoost)', 'Motorcraft', 'A1-04', 7.1, 15.99, 18, 10, 24],
  ['XO-5W20-QSP', '5W-20 synthetic blend, 1 qt', 'Motorcraft', 'B2-01', 4.1, 9.5, 64, 40, 48],
  ['XO-5W30-QSP', '5W-30 synthetic blend, 1 qt', 'Motorcraft', 'B2-02', 4.2, 9.5, 22, 40, 48],
  ['FA-1884', 'Engine air filter', 'Motorcraft', 'A3-10', 11.8, 29.99, 9, 4, 8],
  ['FP-78', 'Cabin air filter', 'Motorcraft', 'A3-11', 9.4, 34.99, 14, 4, 8],
  ['BRF-1414', 'Front brake pads', 'Motorcraft', 'C4-11', 42, 109, 6, 2, 4],
  ['BRR-282', 'Rear brake pads', 'Motorcraft', 'C4-12', 38, 99, 3, 2, 4],
  ['BRRF-460', 'Front brake rotor', 'Motorcraft', 'C5-01', 61, 149, 4, 2, 4],
  ['BXT-65-650', 'Battery, 650 CCA', 'Motorcraft', 'D1-02', 118, 219, 5, 3, 6],
  ['WW-22', 'Wiper blade 22"', 'Trico', 'D2-01', 7, 19.99, 12, 4, 12],
  ['SP-580', 'Spark plug', 'Motorcraft', 'A2-05', 6.2, 16.5, 40, 16, 32],
  ['VC-13DL-G', 'Coolant, 1 gal', 'Motorcraft', 'B3-01', 14.5, 32, 8, 4, 12],
  ['TIRE-2656518', 'Tire 265/65R18', 'Michelin', 'T-RACK', 172, 259, 8, 4, 8]
];

function makeRouter({ buildCar, calculateDeal, getSettings, defaultCreditApp, roadmapSteps }) {
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get('/demo', auth.requirePermission('manageUsers'), wrap(async (req, res) => {
    const { rows } = await store.pool.query("SELECT count(*)::int AS n FROM leads WHERE dealership_id = $1 AND data->>'demo' = 'true'", [req.dealershipId]);
    res.json({ loaded: rows[0].n > 0 });
  }));

  router.post('/demo', auth.requirePermission('manageUsers'), wrap(async (req, res) => {
    const d = req.dealershipId;
    const summary = await store.tx(async q => {
      const { rows: existing } = await q.query("SELECT 1 FROM leads WHERE dealership_id = $1 AND data->>'demo' = 'true' LIMIT 1", [d]);
      if (existing.length) return { error: 'Demo data is already loaded. Remove it first to load it again.' };
      const settings = await getSettings(q, d);

      // ----- Staff -----
      const staff = {};
      for (const [slug, name, role, pay] of STAFF) {
        const email = `demo-${slug}${DEMO_DOMAIN}`;
        const { rows } = await q.query(
          `INSERT INTO users (dealership_id, name, email, role, password_hash, pay) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id::text AS id`,
          [d, name, email, role, await auth.hashPassword(crypto.randomBytes(18).toString('base64')), pay || {}]);
        staff[slug] = { id: rows[0].id, name };
      }
      const by = s => ({ id: staff[s].id, name: staff[s].name });

      // ----- Cars -----
      const carByStock = {};
      CARS.forEach(([stock, type, year, make, model, trim, color, miles, cost, price, days], i) => {
        const car = buildCar({ stockNumber: stock, stockType: type, year, make, model, trim, exteriorColor: color, mileage: miles, cost, price, vin: fakeVin(i + 1) });
        car.dateAdded = at(days, 9);
        car.demo = true;
        carByStock[stock] = car;
      });

      // ----- Customers -----
      const leadByName = {};
      for (const [name, phone, email, source, status, sales, bdc, hot, days, carStock, note] of LEADS) {
        const lead = {
          name, type: 'individual', phone, email, address: address(`${100 + Math.floor(Math.random() * 8900)} E Camelback Rd`, 'Phoenix', 'AZ', '85016'),
          carId: carStock ? carByStock[carStock].id : null, notes: '', mailingDifferent: false, mailingAddress: address('', '', '', ''),
          creditApp: null, creditAppSync: null, status, source, hot, bestContact: phone ? 'call' : '', wishList: carStock ? [carByStock[carStock].id] : [],
          snoozedUntil: null, lostReason: status === 'lost' ? 'Bought elsewhere' : '',
          sales1Id: sales ? staff[sales].id : null, sales2Id: null, bdc1Id: bdc ? staff[bdc].id : null, bdc2Id: null,
          id: uuid(), customerNumber: await store.takeNextCustomerNumber(q, d),
          roadmap: Array(roadmapSteps).fill(null), activities: [], dateAdded: at(days, 9, 15), demo: true
        };
        if (note) lead.activities.push({ id: uuid(), type: status === 'new' ? 'note' : 'call', text: note, date: at(days, 11), by: by(sales || bdc || 'rob') });
        if (['contacted', 'negotiating', 'won'].includes(status)) {
          lead.activities.push({ id: uuid(), type: 'text', text: `Hi ${name.split(' ')[0]}, it's ${staff[sales || 'rob'].name.split(' ')[0]} from the dealership. When works for a test drive?`, date: at(days, 9, 40), by: by(sales || 'rob') });
          lead.roadmap[0] = { at: at(days, 9, 40), by: by(sales || 'rob') };
          lead.roadmap[1] = { at: at(days, 12), by: by(sales || 'rob') };
        }
        if (status === 'negotiating' || status === 'won') for (let s = 2; s < (status === 'won' ? roadmapSteps : 5); s++) lead.roadmap[s] = { at: at(Math.max(0, days - 1), 14), by: by(sales || 'rob') };
        leadByName[name] = lead;
      }

      // ----- Deals -----
      const deals = [];
      for (const [name, stock, days, status, gap, svc, fiCost, reserve, incentives] of SOLD) {
        const car = carByStock[stock];
        const lead = leadByName[name];
        const calc = calculateDeal({ vehiclePrice: car.price - 500, taxRate: settings.taxRate, docFee: settings.docFee, titleFee: settings.titleFee,
          registrationFee: settings.registrationFee, licenseFee: settings.licenseFee, dealerFees: settings.dealerFees, acquisitionFee: settings.acquisitionFee, apr: 6.9, termMonths: 72 });
        deals.push({
          hasTrade: false, id: uuid(), dealNumber: await store.takeNextDealNumber(q, d), leadId: lead.id, carId: car.id, status, ...calc,
          gapPremium: gap, servicePremium: svc, fiProductCost: fiCost, reserve, incentives,
          creditApp: defaultCreditApp(), dateCreated: at(days + 1, 15), deliveredAt: at(days, 17), finalizedAt: status === 'finalized' ? at(Math.max(0, days - 1), 12) : null, demo: true
        });
        car.status = 'sold';
        car.dateSold = at(days, 17);
        car.dateAdded = at(days + CARS.find(c => c[0] === stock)[10], 9);
      }
      for (const [name, stock] of [['Maria Gonzalez', 'U2401'], ['Carlos Ramirez', 'U2404']]) {
        const car = carByStock[stock];
        const calc = calculateDeal({ vehiclePrice: car.price, taxRate: settings.taxRate, docFee: settings.docFee, titleFee: settings.titleFee,
          registrationFee: settings.registrationFee, licenseFee: settings.licenseFee, dealerFees: settings.dealerFees, acquisitionFee: settings.acquisitionFee, apr: 7.4, termMonths: 72 });
        deals.push({ hasTrade: false, id: uuid(), dealNumber: await store.takeNextDealNumber(q, d), leadId: leadByName[name].id, carId: car.id, status: 'working', ...calc,
          creditApp: defaultCreditApp(), dateCreated: at(1, 16), demo: true });
        car.status = 'pending';
      }

      // ----- Parts -----
      const actor = { dealershipId: d, user: { id: staff.gary.id, name: staff.gary.name } };
      const partByNumber = {};
      for (const [number, description, brand, bin, cost, price, onHand, reorderPoint, reorderQty] of PARTS) {
        const part = { id: uuid(), number, description, brand, bin, source: 'oem', vendor: brand === 'Motorcraft' ? 'Ford Parts' : brand, cost, price, reorderPoint, reorderQty, onHand, createdAt: at(90), demo: true };
        partByNumber[number] = part;
        await store.insert(q, 'parts', d, part);
        await store.insert(q, 'part_moves', d, { id: uuid(), partId: part.id, number, type: 'receive', qty: onHand, cost, onHandAfter: onHand, ref: 'Starting count', note: '', at: at(90), by: actor.user, demo: true });
      }
      const pl = (number, qty) => { const p = partByNumber[number]; return { id: uuid(), partId: p.id, number, description: p.description, qty, cost: p.cost, price: p.price }; };

      // ----- Repair orders -----
      const cfg = service.serviceSettings(settings);
      const payById = new Map([['mike', STAFF[8][3]], ['tony', STAFF[9][3]], ['sam', STAFF[10][3]]].map(([s, p]) => [staff[s].id, p]));
      const ros = [];
      const job = (concern, payType, hours, tech, parts = [], extra = {}) => ({
        id: uuid(), concern, cause: extra.cause || '', correction: extra.correction || '', opCode: extra.op || '', payType,
        techId: tech ? staff[tech].id : null, hours, rate: cfg[`${payType}LaborRate`], status: extra.status || 'pending', parts,
        punches: extra.punches || []
      });
      const punch = (tech, daysAgo, hour, mins) => ({ techId: staff[tech].id, start: at(daysAgo, hour), end: mins === null ? null : new Date(new Date(at(daysAgo, hour)).getTime() + mins * 60000).toISOString() });
      const vehicleOf = (lead, year, make, model, miles, vinSeed) => ({ vin: fakeVin(100 + vinSeed), year: String(year), make, model, trim: '', color: '', plate: '', mileageIn: miles, mileageOut: null });
      const ro = async ({ lead, car, vehicle, advisor, daysAgo, status, jobs, promisedHours = 4 }) => {
        const r = {
          id: uuid(), roNumber: await store.takeNextRoNumber(q, d), status, leadId: lead ? lead.id : null, carId: car ? car.id : null,
          customerName: lead ? lead.name : '', vehicle: car ? { vin: car.vin, year: String(car.year), make: car.make, model: car.model, trim: '', color: car.exteriorColor, plate: '', mileageIn: car.mileage, mileageOut: null } : vehicle,
          advisorId: staff[advisor].id, promisedAt: at(daysAgo, 8 + promisedHours), notes: '', jobs,
          openedAt: at(daysAgo, 7, 45), openedBy: by(advisor), closedAt: null, closedBy: null, demo: true
        };
        if (status === 'closed') {
          r.closedAt = at(daysAgo, 16, 30);
          r.closedBy = by(advisor);
          r.jobs = r.jobs.map(j => ({ ...j, status: 'done' }));
          r.vehicle.mileageOut = r.vehicle.mileageIn ? r.vehicle.mileageIn + 3 : null;
          r.closedTotals = service.totals(r, settings, payById);
        }
        ros.push(r);
        return r;
      };
      const L = leadByName;
      // Closed this month and last month
      await ro({ lead: L['Frank Russo'], vehicle: vehicleOf(null, 2016, 'Ford', 'F-150', 98120, 1), advisor: 'dana', daysAgo: 3, status: 'closed', jobs: [
        job('Oil change and tire rotation', 'customer', 0.8, 'tony', [pl('FL-500S', 1), pl('XO-5W30-QSP', 6)], { correction: 'Changed oil and filter, rotated tires, set pressures.', punches: [punch('tony', 3, 9, 40)] }),
        job('Brakes grinding in front', 'customer', 1.8, 'mike', [pl('BRF-1414', 1), pl('BRRF-460', 2)], { cause: 'Front pads worn to backing plate, rotors scored.', correction: 'Replaced front pads and rotors.', punches: [punch('mike', 3, 10, 95)] })] });
      await ro({ lead: L['Tom Baker'], vehicle: vehicleOf(null, 2020, 'Ford', 'Edge', 36180, 2), advisor: 'luis', daysAgo: 2, status: 'closed', jobs: [
        job('First service -- oil change', 'customer', 0.5, 'sam', [pl('FL-820S', 1), pl('XO-5W20-QSP', 6)], { correction: 'Oil and filter, multipoint inspection green.', punches: [punch('sam', 2, 11, 35)] })] });
      await ro({ lead: L['Sarah Johnson'], vehicle: vehicleOf(null, 2025, 'Ford', 'Maverick', 1210, 3), advisor: 'dana', daysAgo: 5, status: 'closed', jobs: [
        job('Check engine light on', 'warranty', 1.2, 'mike', [], { cause: 'Loose EVAP purge valve connector.', correction: 'Secured connector, cleared codes, road tested.', punches: [punch('mike', 5, 13, 70)] })] });
      await ro({ lead: L['Olivia Martinez'], vehicle: vehicleOf(null, 2019, 'Chevrolet', 'Equinox', 44900, 4), advisor: 'luis', daysAgo: 8, status: 'closed', jobs: [
        job('Battery dead in the morning', 'customer', 0.6, 'tony', [pl('BXT-65-650', 1)], { cause: 'Battery failed load test.', correction: 'Replaced battery, tested charging system.', punches: [punch('tony', 8, 9, 30)] }),
        job('Replace wiper blades', 'customer', 0.2, 'tony', [pl('WW-22', 2)], { correction: 'Installed new blades.', punches: [punch('tony', 8, 9, 10)] })] });
      await ro({ lead: L['Daniel Lee'], vehicle: vehicleOf(null, 2018, 'Honda', 'CR-V', 59100, 5), advisor: 'dana', daysAgo: 32, status: 'closed', jobs: [
        job('30k service', 'customer', 2.2, 'sam', [pl('SP-580', 4), pl('FA-1884', 1), pl('FP-78', 1)], { correction: 'Plugs, air and cabin filters.', punches: [punch('sam', 32, 9, 150)] })] });
      await ro({ car: carByStock.U2403, advisor: 'luis', daysAgo: 18, status: 'closed', jobs: [
        job('Recon: safety inspection, brakes, detail', 'internal', 2.5, 'mike', [pl('BRR-282', 1), pl('WW-22', 2)], { correction: 'Rear pads, wipers, full detail.', punches: [punch('mike', 18, 10, 160)] })] });
      // Open ROs
      await ro({ lead: L['Brian Thompson'], vehicle: vehicleOf(null, 2014, 'Toyota', 'Tacoma', 132400, 6), advisor: 'dana', daysAgo: 0, status: 'in_progress', jobs: [
        job('A/C blowing warm', 'customer', 1.5, 'mike', [], { status: 'working', punches: [punch('mike', 0, 8, null)] }),
        job('Oil change', 'customer', 0.5, 'tony', [pl('FL-820S', 1), pl('XO-5W20-QSP', 6)])] });
      await ro({ lead: L['Ashley Nguyen'], vehicle: vehicleOf(null, 2017, 'Mazda', 'CX-5', 71800, 7), advisor: 'luis', daysAgo: 1, status: 'waiting_parts', promisedHours: -20, jobs: [
        job('Clunk over bumps, front end', 'customer', 2.4, 'sam', [], { cause: 'Front sway bar links worn.', status: 'working', punches: [punch('sam', 1, 10, 45)] })] });
      await ro({ lead: L['Jessica Moore'], vehicle: vehicleOf(null, 2020, 'Ford', 'Escape', 40120, 8), advisor: 'dana', daysAgo: 0, status: 'ready', jobs: [
        job('Oil change, rotate tires', 'customer', 0.8, 'tony', [pl('FL-500S', 1), pl('XO-5W30-QSP', 5)], { correction: 'Done, all tires at 6/32.', status: 'done', punches: [punch('tony', 0, 9, 45)] })] });
      await ro({ lead: L['David Kim'], vehicle: vehicleOf(null, 2019, 'Ford', 'Fusion', 58300, 9), advisor: 'luis', daysAgo: 0, status: 'open', jobs: [
        job('Check battery / slow crank', 'customer', 0, null), job('Recall 23S01 -- steering column', 'warranty', 0.9, null)] });
      await ro({ car: carByStock.U2406, advisor: 'luis', daysAgo: 2, status: 'in_progress', jobs: [
        job('Recon: front brakes, battery, detail', 'internal', 3, 'sam', [pl('BRF-1414', 1), pl('BXT-65-650', 1)], { status: 'working', punches: [punch('sam', 1, 13, 120)] })] });
      await ro({ car: carByStock.U2407, advisor: 'dana', daysAgo: 0, status: 'open', jobs: [job('Recon: inspect, oil change, detail', 'internal', 1.5, null, [pl('FL-820S', 1)])] });

      // Parts used on closed ROs come off the shelf; recon adds to car cost.
      for (const r of ros) {
        if (r.status === 'closed') {
          for (const j of r.jobs) for (const p of j.parts) {
            partByNumber[p.number].onHand -= p.qty;
            await store.insert(q, 'part_moves', d, { id: uuid(), partId: p.partId, number: p.number, type: 'ro', qty: -p.qty, cost: p.cost, onHandAfter: partByNumber[p.number].onHand, ref: `RO-${r.roNumber}`, note: '', at: r.closedAt, by: actor.user, demo: true });
          }
          if (r.carId) {
            const car = Object.values(carByStock).find(c => c.id === r.carId);
            car.cost += r.closedTotals.internalTotal;
            car.reconHistory = [...(car.reconHistory || []), { roId: r.id, roNumber: r.roNumber, amount: r.closedTotals.internalTotal, date: r.closedAt }];
          }
        } else if (r.carId) {
          const car = Object.values(carByStock).find(c => c.id === r.carId);
          car.openROs = [...(car.openROs || []), r.id];
        }
        await store.insert(q, 'repair_orders', d, r);
      }

      // Counter tickets
      const tickets = [
        { customerName: "Joe's Garage", saleType: 'wholesale', lines: [{ ...pl('BRF-1414', 2), price: 84 }, { ...pl('FL-820S', 6), price: 10.5 }], daysAgo: 4, closed: true },
        { lead: L['Mark Wilson'], saleType: 'retail', lines: [pl('WW-22', 2), pl('FP-78', 1)], daysAgo: 1, closed: true },
        { customerName: 'Walk-in', saleType: 'retail', lines: [pl('VC-13DL-G', 2)], daysAgo: 0, closed: false }
      ];
      for (const t of tickets) {
        const ticket = { id: uuid(), ticketNumber: await store.takeNextTicketNumber(q, d), status: t.closed ? 'closed' : 'open', leadId: t.lead ? t.lead.id : null,
          customerName: t.lead ? t.lead.name : t.customerName, saleType: t.saleType, notes: '', lines: t.lines,
          openedAt: at(t.daysAgo, 10), openedBy: actor.user, closedAt: t.closed ? at(t.daysAgo, 10, 20) : null, demo: true };
        if (t.closed) {
          ticket.closedBy = actor.user;
          ticket.closedTotals = require('./parts').ticketTotals(ticket, settings);
          for (const l of t.lines) {
            partByNumber[l.number].onHand -= l.qty;
            await store.insert(q, 'part_moves', d, { id: uuid(), partId: l.partId, number: l.number, type: 'ticket', qty: -l.qty, cost: l.cost, onHandAfter: partByNumber[l.number].onHand, ref: `P-${ticket.ticketNumber}`, note: '', at: ticket.closedAt, by: actor.user, demo: true });
          }
        }
        await store.insert(q, 'parts_tickets', d, ticket);
      }
      for (const p of Object.values(partByNumber)) await store.save(q, 'parts', d, p.id, p);

      // Special orders
      const openRos = ros.filter(r => r.status === 'waiting_parts');
      await store.insert(q, 'special_orders', d, { id: uuid(), status: 'ordered', partId: null, number: 'K-7307', description: 'Front sway bar links (pair)', qty: 1,
        leadId: L['Ashley Nguyen'].id, customerName: 'Ashley Nguyen', roId: openRos[0] ? openRos[0].id : null, roNumber: openRos[0] ? openRos[0].roNumber : null,
        vendor: 'Mazda Parts', poNumber: 'PO-4471', cost: 64, price: 139, deposit: 0, notes: 'ETA tomorrow AM', requestedAt: at(1, 11), requestedBy: by('luis'), history: [{ status: 'ordered', at: at(1, 12), by: staff.gary.name }], demo: true });
      await store.insert(q, 'special_orders', d, { id: uuid(), status: 'requested', partId: null, number: 'JL3Z-17K835-A', description: 'Rear bumper cover', qty: 1,
        leadId: L['Frank Russo'].id, customerName: 'Frank Russo', roId: null, roNumber: null, vendor: '', cost: 180, price: 320, deposit: 100, notes: 'Customer paid $100 deposit', requestedAt: at(0, 9), requestedBy: by('dana'), history: [], demo: true });

      // Service appointments
      const appts = [
        [L['Rachel Adams'], 0, 9, 30, 'First oil change', 'dana', true, [2025, 'Ford', 'F-150']],
        [L['Emily Davis'], 0, 11, 0, 'Squeaky brakes\nState inspection', 'luis', false, [2016, 'Honda', 'Civic']],
        [L['Carlos Ramirez'], -1, 8, 0, 'Check engine light', 'dana', true, [2012, 'Jeep', 'Liberty']],
        [L['Laura Chen'], -1, 13, 30, 'Tire rotation\nAlignment check', 'luis', false, [2021, 'Toyota', 'Corolla']],
        [L['Kevin Walsh'], -2, 10, 0, 'Recall check', 'dana', false, [2019, 'Ford', 'Explorer']]
      ];
      for (const [lead, days, hour, min, concern, advisor, waiter, [year, make, model]] of appts) {
        await store.insert(q, 'service_appointments', d, { id: uuid(), leadId: lead.id, vehicle: { vin: '', year: String(year), make, model, trim: '', color: '', plate: '', mileageIn: null, mileageOut: null },
          startsAt: at(days, hour, min), concern, advisorId: staff[advisor].id, waiter, status: 'scheduled', customerName: lead.name, roId: null, createdAt: at(Math.max(days, 0) + 2), createdBy: by(advisor), demo: true });
      }

      // ----- Recon: cars on their way to the front line -----
      const steps = require('./recon').reconSettings(settings).steps.map(x => x.key);
      const labelOf = k => (k === 'ready' ? 'Frontline Ready' : (require('./recon').reconSettings(settings).steps.find(x => x.key === k) || require('./recon').defaultReconSettings().steps.find(x => x.key === k) || { label: k }).label);
      const hoursAgo = h => new Date(Date.now() - h * 3600000).toISOString();
      const roOf = stock => ros.find(r => r.carId === carByStock[stock].id);
      const item = (category, description, estimate, status, extra = {}) => ({
        id: uuid(), category, description, estimate, actual: null, vendor: '', status, roId: null, roNumber: null, roJobId: null, costPosted: false,
        addedBy: 'Rob Carter', addedAt: hoursAgo(40), approvedBy: status === 'proposed' ? null : 'Rob Carter', approvedAt: status === 'proposed' ? null : hoursAgo(30), ...extra
      });
      const linkRo = (stock, i = 0) => { const r = roOf(stock); return r ? { roId: r.id, roNumber: r.roNumber, roJobId: r.jobs[i].id } : {}; };
      // segments: [step, hours spent]; the last one is where it is now unless done.
      const unitFor = (stock, segments, { done = false, items = [], notes = [] } = {}) => {
        const car = carByStock[stock];
        const total = segments.reduce((s2, [, h]) => s2 + h, 0);
        let t = total;
        const history = segments.map(([step, h], k) => {
          const entered = hoursAgo(t);
          t -= h;
          const last = k === segments.length - 1;
          return { step, label: labelOf(step), enteredAt: entered, leftAt: last && !done ? null : hoursAgo(t), by: k % 2 ? 'Mike Chen' : 'Dana Brooks' };
        });
        if (done) history.push({ step: 'ready', label: 'Frontline Ready', enteredAt: hoursAgo(t), leftAt: hoursAgo(t), by: 'Rob Carter' });
        if (done) car.frontLineAt = hoursAgo(t);
        return {
          id: uuid(), carId: car.id, stockNumber: car.stockNumber, vehicleLabel: `${car.year} ${car.make} ${car.model}`,
          status: done ? 'done' : 'active', step: done ? 'ready' : segments[segments.length - 1][0],
          stepEnteredAt: done ? hoursAgo(t) : history[history.length - 1].enteredAt, startedAt: hoursAgo(total), doneAt: done ? hoursAgo(t) : null,
          history, items, notes, startedBy: by('dana'), demo: true
        };
      };
      const units = [
        unitFor('U2404', [['purchase_trade', 20], ['ucm_approval', 10]], { items: [
          item('tires', 'Two front tires', 480, 'proposed'), item('body', 'Rear bumper scuff', 350, 'proposed', { vendor: 'Desert Collision' }), item('detail', 'Full detail', 180, 'approved')] }),
        unitFor('U2406', [['purchase_trade', 14], ['ucm_approval', 6], ['repair', 52]], { items: [
          item('mechanical', 'Front brakes, battery', 520, 'approved', linkRo('U2406')), item('detail', 'Full detail', 180, 'approved')],
          notes: [{ id: uuid(), text: 'Waiting on battery from parts -- should be here by noon.', at: hoursAgo(5), by: 'Sam Patel' }] }),
        unitFor('U2407', [['write_up', 5]], { items: [item('mechanical', 'Oil change, inspection', 150, 'approved', linkRo('U2407'))] }),
        unitFor('U2401', [['purchase_trade', 18], ['ucm_approval', 4], ['repair', 30], ['offsite_sublet', 26], ['detail_ready', 20]], { items: [
          item('body', 'Door ding (PDR)', 150, 'done', { actual: 150, costPosted: true, vendor: 'Dent Pros', doneAt: hoursAgo(22) }), item('detail', 'Full detail', 180, 'approved')] }),
        unitFor('U2402', [['used_transport', 22], ['write_up', 3], ['repair', 40], ['detail_ready', 10], ['detail_complete', 30], ['smog', 30]], { items: [
          item('detail', 'Full detail', 180, 'done', { actual: 175, costPosted: true, doneAt: hoursAgo(32) })] }),
        unitFor('U2403', [['purchase_trade', 16], ['ucm_approval', 5], ['repair', 40], ['detail_ready', 18], ['insp_ready', 12]], { done: true, items: [
          item('mechanical', 'Recon: safety inspection, brakes, detail', 360, 'approved', linkRo('U2403'))] }),
        unitFor('U2381', [['purchase_trade', 12], ['ucm_approval', 3], ['repair', 36], ['vendor', 20], ['detail_ready', 16], ['insp_ready', 14]], { done: true, items: [item('detail', 'Full detail', 180, 'done', { actual: 180, costPosted: true })] }),
        unitFor('N2502', [['new_import', 30], ['new_transport', 70]]),
        unitFor('N2504', [['new_transport', 96], ['detail_ready', 30]]),
        unitFor('N2503', [['new_transport', 20], ['new_pdi', 8]]),
        unitFor('U2380', [['trade_not_cleared', 30], ['ucm_approval', 20], ['parts_hold', 60], ['detail_ready', 24], ['insp_ready', 12]], { done: true, items: [item('mechanical', 'Timing belt', 900, 'done', { actual: 1040, costPosted: true })] })
      ];
      // Shift the finished ones back in time so they finished days ago.
      const shift = (u, days) => {
        const ms = days * 86400000;
        const back = iso => (iso ? new Date(new Date(iso).getTime() - ms).toISOString() : iso);
        u.startedAt = back(u.startedAt); u.stepEnteredAt = back(u.stepEnteredAt); u.doneAt = back(u.doneAt);
        u.history = u.history.map(x => ({ ...x, enteredAt: back(x.enteredAt), leftAt: back(x.leftAt) }));
        carByStock[u.stockNumber].frontLineAt = u.doneAt;
      };
      const byStock = k => units.find(x => x.stockNumber === k);
      shift(byStock('U2403'), 18); shift(byStock('U2381'), 10); shift(byStock('U2380'), 22);
      for (const u of units) {
        for (const i of u.items) if (i.costPosted && i.actual) carByStock[u.stockNumber].cost += i.actual;
        await store.insert(q, 'recon_units', d, u);
      }

      // Save cars, customers, deals
      for (const car of Object.values(carByStock)) await store.insert(q, 'cars', d, car);
      for (const lead of Object.values(leadByName)) await store.insert(q, 'leads', d, lead);
      for (const deal of deals) await store.insert(q, 'deals', d, deal);

      // Follow-up tasks
      for (const [lead, staffSlug, title, dueDays] of [[L['Maria Gonzalez'], 'jake', 'Confirm Saturday test drive', 0], [L['David Kim'], 'ashley', 'Send OTD price on the Camry', 0], [L['Emily Davis'], 'nina', 'First call -- new AutoTrader lead', 0], [L['Carlos Ramirez'], 'ashley', 'Follow up on $28k counter', -1]]) {
        await store.insert(q, 'tasks', d, { id: uuid(), type: 'call', title, leadId: lead.id, leadName: lead.name, assignedTo: by(staffSlug), dueAt: at(dueDays, 15), status: 'open', notes: '', createdAt: at(1), createdBy: by('rob'), completedAt: null, completedBy: null, outcome: '', demo: true });
      }

      await audit.record(q, req, { action: 'create', entityType: 'settings', entityId: 'demo-data', label: 'Demo data', details: 'Loaded demo data' });
      return { staff: STAFF.length, cars: CARS.length, customers: LEADS.length, deals: deals.length, repairOrders: ros.length, parts: PARTS.length, appointments: appts.length };
    });
    if (summary.error) return res.status(400).json({ error: summary.error });
    res.status(201).json(summary);
  }));

  router.delete('/demo', auth.requirePermission('manageUsers'), wrap(async (req, res) => {
    const d = req.dealershipId;
    const removed = await store.tx(async q => {
      const counts = {};
      // Demo cars that went into recon on their own (not marked demo) go too.
      await q.query(`DELETE FROM recon_units WHERE dealership_id = $1 AND data->>'carId' IN (SELECT id FROM cars WHERE dealership_id = $1 AND data->>'demo' = 'true')`, [d]);
      for (const table of DEMO_TABLES) {
        const { rowCount } = await q.query(`DELETE FROM ${table} WHERE dealership_id = $1 AND data->>'demo' = 'true'`, [d]);
        counts[table] = rowCount;
      }
      const { rowCount } = await q.query('DELETE FROM users WHERE dealership_id = $1 AND email LIKE $2', [d, `%${DEMO_DOMAIN}`]);
      counts.staff = rowCount;
      await audit.record(q, req, { action: 'delete', entityType: 'settings', entityId: 'demo-data', label: 'Demo data', details: 'Removed demo data' });
      return counts;
    });
    res.json(removed);
  }));

  return router;
}

module.exports = { makeRouter, DEMO_DOMAIN };
