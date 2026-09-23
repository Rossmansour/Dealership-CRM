// Tests for the VIN decoder. NHTSA's real service isn't called: a small
// stand-in server returns responses in NHTSA's documented vPIC format.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

if (!process.env.TEST_DATABASE_URL) {
  test('VIN tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const vin = require('../vin');

// Shaped like https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/<vin>?format=json
const NHTSA_RESPONSES = {
  '1HGCM82633A004352': {
    ModelYear: '2003', Make: 'HONDA', Model: 'Accord', Trim: 'EX-V6', Trim2: '', Series: '',
    BodyClass: 'Coupe', Doors: '2', DriveType: 'FWD/Front-Wheel Drive',
    DisplacementL: '3.0', EngineCylinders: '6', EngineConfiguration: 'V-Shaped', EngineHP: '240',
    FuelTypePrimary: 'Gasoline', FuelTypeSecondary: '', TransmissionStyle: 'Automatic', TransmissionSpeeds: '5',
    VehicleType: 'PASSENGER CAR', Manufacturer: 'AMERICAN HONDA MOTOR CO., INC.', PlantCountry: 'UNITED STATES (USA)',
    ElectrificationLevel: '', ErrorCode: '0', ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct'
  },
  // Same car with a typo in it: NHTSA still decodes, but flags the check digit.
  '1HGCM82643A004352': {
    ModelYear: '2003', Make: 'HONDA', Model: 'Accord', Trim: 'EX-V6', BodyClass: 'Coupe',
    ErrorCode: '1', ErrorText: '1 - Check Digit (9th position) does not calculate properly'
  },
  '5FNRL6H72LB000123': {
    ModelYear: '2020', Make: 'HONDA', Model: 'Odyssey', Trim: 'EX-L', BodyClass: 'Minivan',
    ErrorCode: '0', ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct'
  },
  // A VIN NHTSA knows nothing about.
  '11111111111111111': {
    ModelYear: '', Make: '', Model: '',
    ErrorCode: '7,11', ErrorText: '7 - Manufacturer is not registered with NHTSA for sale or importation in the U.S.; 11 - Incorrect Model Year'
  }
};

let fakeNhtsa;
let requestCount = 0;
let admin;

before(async () => {
  fakeNhtsa = http.createServer((req, res) => {
    requestCount += 1;
    const match = req.url.match(/DecodeVinValuesExtended\/([A-Z0-9]+)\?format=json$/);
    const result = match && NHTSA_RESPONSES[match[1]];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ Count: 1, Message: 'Results returned successfully', Results: [result || { ErrorCode: '8', ErrorText: '8 - No detailed data available currently' }] }));
  });
  await new Promise(resolve => fakeNhtsa.listen(0, resolve));
  process.env.VIN_DECODER_URL = `http://localhost:${fakeNhtsa.address().port}/api/vehicles`;

  await h.startServer();
  admin = await h.createUser('admin');
});

after(async () => {
  fakeNhtsa.close();
  await h.stopServer();
});

const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

test('check digit catches typos', () => {
  assert.strictEqual(vin.checkDigitIsValid('1HGCM82633A004352'), true);
  assert.strictEqual(vin.checkDigitIsValid('1HGCM82643A004352'), false);
  assert.strictEqual(vin.isValidVinFormat('1HGCM82633A00435'), false, '16 characters');
  assert.strictEqual(vin.isValidVinFormat('1HGCM82633A0O4352'), false, 'letter O is never used');
});

test('the sample data car with this VIN is flagged as a duplicate', async () => {
  const res = await as(admin, 'GET', '/vin/1HGCM82633A004352');
  assert.strictEqual(res.body.inInventory.label, '2019 Honda Civic (Stock #ST-4821)');
});

test('decodes a VIN into readable details', async () => {
  const res = await as(admin, 'GET', '/vin/1hgcm8263-3a004352');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual({ ...res.body, inInventory: undefined }, {
    vin: '1HGCM82633A004352',
    year: 2003,
    make: 'Honda',
    model: 'Accord',
    trim: 'EX-V6',
    series: '',
    bodyStyle: 'Coupe',
    doors: 2,
    drivetrain: 'FWD/Front-Wheel Drive',
    engine: '3.0L V6 240 hp',
    fuelType: 'Gasoline',
    transmission: '5-speed Automatic',
    vehicleType: 'PASSENGER CAR',
    manufacturer: 'AMERICAN HONDA MOTOR CO., INC.',
    plantCountry: 'United States (USA)',
    warnings: [],
    inInventory: undefined
  });
});

test('repeat lookups are answered from memory', async () => {
  const before = requestCount;
  await as(admin, 'GET', '/vin/1HGCM82633A004352');
  await as(admin, 'GET', '/vin/1HGCM82633A004352');
  assert.strictEqual(requestCount, before, 'NHTSA not asked again');
});

test('bad and unknown VINs get clear messages', async () => {
  const before = requestCount;
  const short = await as(admin, 'GET', '/vin/1HGCM82633A00435');
  assert.strictEqual(short.status, 400);
  assert.match(short.body.error, /17 letters and numbers/);
  assert.strictEqual(requestCount, before, 'invalid VINs never reach NHTSA');

  const typo = await as(admin, 'GET', '/vin/1HGCM82643A004352');
  assert.strictEqual(typo.status, 200, 'still decodes what it can');
  assert.strictEqual(typo.body.warnings.length, 1, 'one check-digit warning, not two');
  assert.match(typo.body.warnings[0], /Check Digit/);

  const unknown = await as(admin, 'GET', '/vin/11111111111111111');
  assert.strictEqual(unknown.status, 404);
  assert.match(unknown.body.error, /No vehicle found/);
});

test('when NHTSA is unreachable, says so instead of failing silently', async () => {
  const saved = process.env.VIN_DECODER_URL;
  process.env.VIN_DECODER_URL = 'http://localhost:1/api/vehicles';
  const res = await as(admin, 'GET', '/vin/2HGFC2F59JH000001');
  process.env.VIN_DECODER_URL = saved;
  assert.strictEqual(res.status, 502);
  assert.match(res.body.error, /Couldn't reach the VIN database/);
});

test('warns when the VIN is already in inventory', async () => {
  const car = (await as(admin, 'POST', '/cars', {
    vin: '5fnrl6h72lb000123', make: 'Honda', model: 'Odyssey', year: 2020, price: 28500, stockNumber: 'T-1',
    trim: 'EX-L', bodyStyle: 'Minivan', engine: '3.5L V6 280 hp', drivetrain: 'FWD/Front-Wheel Drive',
    transmission: '5-speed Automatic', fuelType: 'Gasoline', exteriorColor: 'Silver', interiorColor: 'Black', doors: '2'
  })).body;
  assert.strictEqual(car.vin, '5FNRL6H72LB000123', 'VIN saved in standard form');
  assert.strictEqual(car.trim, 'EX-L');
  assert.strictEqual(car.exteriorColor, 'Silver');
  assert.strictEqual(car.doors, 2);

  const dup = (await as(admin, 'GET', '/vin/5FNRL6H72LB000123')).body;
  assert.deepStrictEqual(dup.inInventory, { id: car.id, label: '2020 Honda Odyssey (Stock #T-1)', status: 'available' });

  const editingSameCar = (await as(admin, 'GET', `/vin/5FNRL6H72LB000123?excludeCarId=${car.id}`)).body;
  assert.strictEqual(editingSameCar.inInventory, null, "a car doesn't warn about itself while being edited");

  const edited = (await as(admin, 'PUT', `/cars/${car.id}`, { vin: '5fnrl-6h72lb000123', doors: '4', interiorColor: 'Tan' })).body;
  assert.strictEqual(edited.vin, '5FNRL6H72LB000123');
  assert.strictEqual(edited.doors, 4);
  assert.strictEqual(edited.interiorColor, 'Tan');
});

test('decoding requires signing in', async () => {
  assert.strictEqual((await h.api('GET', '/vin/1HGCM82633A004352')).status, 401);
});
