// vin.js
// VIN decoding using NHTSA's free vPIC database (the US government's
// vehicle database -- no account or key needed):
// https://vpic.nhtsa.dot.gov/api/
//
// decodeVin() turns a 17-character VIN into year / make / model / trim and
// other specs. Results are cached in memory, since a VIN's specs never
// change and the same car gets looked up repeatedly (inventory, trade-ins).

// VIN_DECODER_URL only needs setting for tests, to point at a stand-in server.
const vpicBaseUrl = () => process.env.VIN_DECODER_URL || 'https://vpic.nhtsa.dot.gov/api/vehicles';
const TIMEOUT_MS = 10000;
const CACHE_LIMIT = 1000;

const cache = new Map();

// Upper-cases and strips spaces and dashes people often type or paste.
function normalizeVin(vin) {
  return String(vin || '').toUpperCase().replace(/[\s-]/g, '');
}

// 17 characters; the letters I, O, and Q are never used (too easy to
// confuse with 1 and 0).
function isValidVinFormat(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
}

// The 9th character is a check digit calculated from the rest, so most
// typos can be caught before even asking NHTSA. Required on every vehicle
// sold in North America since 1981.
const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigitIsValid(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const value = /[0-9]/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return vin[8] === expected;
}

// NHTSA returns makes in capitals ("HONDA"); show them normally, except
// brands that really are written in capitals.
const UPPERCASE_WORDS = new Set(['BMW', 'GMC', 'MINI', 'SRT', 'USA', 'UK']);

function titleCase(value) {
  if (!value) return '';
  return value.split(/(\s+|-)/).map(word => UPPERCASE_WORDS.has(word.replace(/[^A-Za-z]/g, '').toUpperCase())
    ? word.toUpperCase()
    : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join('');
}

const clean = value => {
  const v = String(value ?? '').trim();
  return v === 'Not Applicable' ? '' : v;
};

function describeEngine(r) {
  const parts = [];
  const liters = Number(clean(r.DisplacementL));
  if (liters) parts.push(`${liters.toFixed(1)}L`);
  if (clean(r.EngineConfiguration) && clean(r.EngineCylinders)) {
    parts.push(`${clean(r.EngineConfiguration).replace(/-Shaped$/, '')}${clean(r.EngineCylinders)}`);
  } else if (clean(r.EngineCylinders)) {
    parts.push(`${clean(r.EngineCylinders)}-cyl`);
  }
  if (clean(r.EngineHP)) parts.push(`${Math.round(Number(clean(r.EngineHP)))} hp`);
  if (/electric/i.test(clean(r.ElectrificationLevel)) && !parts.length) parts.push(clean(r.ElectrificationLevel));
  return parts.join(' ');
}

function describeTransmission(r) {
  const style = clean(r.TransmissionStyle);
  const speeds = clean(r.TransmissionSpeeds);
  if (style && speeds) return `${speeds}-speed ${style}`;
  return style;
}

// NHTSA ErrorCode "0" means a clean decode. Anything else comes with an
// explanation in ErrorText (e.g. check digit wrong, partial decode).
function nhtsaWarnings(r) {
  const codes = clean(r.ErrorCode).split(',').map(c => c.trim()).filter(Boolean);
  if (!codes.length || (codes.length === 1 && codes[0] === '0')) return [];
  return clean(r.ErrorText).split(';').map(t => t.trim()).filter(Boolean)
    .filter(t => !/^0 - /.test(t));
}

function mapResult(vin, r) {
  return {
    vin,
    year: Number(clean(r.ModelYear)) || null,
    make: titleCase(clean(r.Make)),
    model: clean(r.Model),
    trim: [clean(r.Trim), clean(r.Trim2)].filter(Boolean).join(' ') || clean(r.Series),
    series: clean(r.Series),
    bodyStyle: clean(r.BodyClass),
    doors: Number(clean(r.Doors)) || null,
    drivetrain: clean(r.DriveType),
    engine: describeEngine(r),
    fuelType: [clean(r.FuelTypePrimary), clean(r.FuelTypeSecondary)].filter(Boolean).join(' / '),
    transmission: describeTransmission(r),
    vehicleType: clean(r.VehicleType),
    manufacturer: clean(r.Manufacturer),
    plantCountry: titleCase(clean(r.PlantCountry)),
    warnings: nhtsaWarnings(r)
  };
}

class VinError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function decodeVin(rawVin) {
  const vin = normalizeVin(rawVin);
  if (!isValidVinFormat(vin)) {
    throw new VinError('A VIN is 17 letters and numbers (never I, O, or Q). Check it and try again.', 400);
  }
  if (cache.has(vin)) return cache.get(vin);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(`${vpicBaseUrl()}/DecodeVinValuesExtended/${vin}?format=json`, { signal: controller.signal });
    if (!res.ok) throw new Error(`NHTSA responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    throw new VinError("Couldn't reach the VIN database right now. Try again in a minute, or enter the details by hand.", 502);
  } finally {
    clearTimeout(timer);
  }

  const raw = data && Array.isArray(data.Results) ? data.Results[0] : null;
  if (!raw) throw new VinError('The VIN database returned no information for this VIN.', 502);

  const result = mapResult(vin, raw);
  const nhtsaFlaggedCheckDigit = result.warnings.some(w => /check digit/i.test(w));
  if (!checkDigitIsValid(vin) && !nhtsaFlaggedCheckDigit) {
    result.warnings.unshift("This VIN's check digit doesn't match -- it may have a typo. Double-check it against the vehicle.");
  }
  if (!result.make && !result.model) {
    throw new VinError(`No vehicle found for this VIN.${result.warnings.length ? ' ' + result.warnings[0] : ''}`, 404);
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(vin, result);
  return result;
}

module.exports = { decodeVin, normalizeVin, isValidVinFormat, checkDigitIsValid, VinError };
