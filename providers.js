// providers.js
// Outside data sources for appraisals ("book outs"). Each one has a slot in
// the appraisal screen. A provider is either:
//   - live: working now (government recall data is free), or
//   - not available yet: needs a license / partner agreement first. Its
//     slot shows "Not available yet" until it's connected here.
// Connecting one later means giving it a fetch function (and its setting,
// e.g. an API key) -- the appraisal screen already has its place.

const PROVIDERS = [
  {
    key: 'market', name: 'Market Comparables', category: 'market',
    description: 'Similar cars for sale near you, market day supply, price to market, and a suggested retail price.',
    needs: 'a market data license (e.g. MarketCheck)'
  },
  {
    key: 'options', name: 'Factory Options', category: 'options',
    description: 'The exact trims and factory options for this VIN, to book the car out option by option.',
    needs: 'a vehicle data license (e.g. J.D. Power Chrome Data or DataOne)'
  },
  { key: 'kbb', name: 'Kelley Blue Book', category: 'book', description: 'Trade-in and retail values, and the printed KBB book sheet.', needs: 'a KBB data license' },
  { key: 'jdpower', name: 'J.D. Power', category: 'book', description: 'Clean trade-in and clean retail values.', needs: 'a J.D. Power valuation license' },
  { key: 'blackbook', name: 'Black Book', category: 'book', description: 'Wholesale and retail values.', needs: 'a Black Book data license' },
  { key: 'mmr', name: 'Manheim MMR', category: 'book', description: 'Manheim Market Report wholesale (auction) value.', needs: 'Manheim / Cox partner access' },
  { key: 'carfax', name: 'Carfax', category: 'history', description: 'Vehicle history: owners, accidents, service, title.', needs: 'a Carfax partner agreement' },
  { key: 'autocheck', name: 'AutoCheck', category: 'history', description: 'Vehicle history report and AutoCheck score.', needs: 'an AutoCheck partner agreement' },
  { key: 'windowsticker', name: 'Window Sticker', category: 'sticker', description: 'The original factory window sticker (Monroney label).', needs: 'a window sticker data source' },
  {
    key: 'vin_recalls', name: 'Open Recalls for this VIN', category: 'recalls',
    description: 'Which recalls are still unrepaired on this exact car, straight from the manufacturer data.',
    needs: 'a VIN recall data source (e.g. through Carfax, AutoCheck, or a recall data provider)'
  },
  {
    key: 'recalls', name: 'Recalls for this Model', category: 'recalls', live: true,
    description: 'Every safety recall issued for this year, make, and model, from NHTSA (the US government). Some may already be repaired on this car.'
  }
];

function listProviders() {
  return PROVIDERS.map(p => ({
    key: p.key,
    name: p.name,
    category: p.category,
    description: p.description,
    status: p.live ? 'live' : 'not_available',
    needs: p.needs || null
  }));
}

// ---------- NHTSA recalls (free, no key) ----------
// These are recalls ISSUED for a year/make/model -- every recall that
// applies to that model, whether or not it has already been repaired on a
// particular car. Which recalls are still OPEN on a specific VIN comes from
// the manufacturers; NHTSA shows it on nhtsa.gov/recalls, and dealer
// software gets it through licensed sources (the "vin_recalls" slot).
//
// NHTSA's recall database doesn't always use the VIN decoder's model name
// (the decoder says "GLC-Class", recalls are filed under "GLC300"; "Accord"
// vs "ACCORD HYBRID"). So first we ask NHTSA which model names it has for
// that make and year, match ours against them, and pull recalls for each.
//   GET /products/vehicle/models?modelYear=2023&make=MERCEDES-BENZ&issueType=r
//   GET /recalls/recallsByVehicle?make=..&model=..&modelYear=..

const nhtsaBaseUrl = () => process.env.NHTSA_API_URL || 'https://api.nhtsa.gov';
const TIMEOUT_MS = 10000;
const MAX_MODEL_NAMES = 8;

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function nhtsaGet(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${nhtsaBaseUrl()}${path}`, { signal: controller.signal });
    // NHTSA answers 400 when it has nothing for the name it was given.
    if (res.status === 400 || res.status === 404) return { results: [] };
    if (!res.ok) throw new Error(`NHTSA responded ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new ProviderError("Couldn't reach NHTSA's recall database right now. Try again in a minute.", 502);
  } finally {
    clearTimeout(timer);
  }
}

const squash = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// The NHTSA model names that correspond to our decoded model. Exact
// matches first, then names that start with the model's core ("GLC-Class"
// -> GLC300, GLC43 AMG; "Accord" -> ACCORD, ACCORD HYBRID).
function matchModelNames(ourModel, nhtsaModels) {
  const exact = squash(ourModel);
  const core = squash(String(ourModel).replace(/[-\s]*class$/i, ''));
  if (!core) return [];
  const names = [...new Set(nhtsaModels.map(m => String(m).trim()).filter(Boolean))];
  const exactMatches = names.filter(n => squash(n) === exact || squash(n) === core);
  const prefixMatches = core.length >= 2 ? names.filter(n => squash(n).startsWith(core) && !exactMatches.includes(n)) : [];
  return [...exactMatches, ...prefixMatches].slice(0, MAX_MODEL_NAMES);
}

async function fetchRecalls({ year, make, model }) {
  if (!year || !make || !model) {
    throw new ProviderError('Recalls need the year, make, and model. Decode the VIN or fill them in first.', 400);
  }
  const q = encodeURIComponent;
  const modelList = await nhtsaGet(`/products/vehicle/models?modelYear=${q(year)}&make=${q(make)}&issueType=r`);
  const nhtsaModels = (Array.isArray(modelList.results) ? modelList.results : []).map(r => r.model);
  let matched = matchModelNames(model, nhtsaModels);
  // If NHTSA's model list came back empty, still try the name as decoded.
  if (!nhtsaModels.length) matched = [model];

  const byCampaign = new Map();
  for (const name of matched) {
    const data = await nhtsaGet(`/recalls/recallsByVehicle?make=${q(make)}&model=${q(name)}&modelYear=${q(year)}`);
    for (const r of Array.isArray(data.results) ? data.results : []) {
      const campaign = String(r.NHTSACampaignNumber || '');
      const existing = byCampaign.get(campaign);
      if (existing) {
        if (!existing.models.includes(name)) existing.models.push(name);
        continue;
      }
      byCampaign.set(campaign, {
        campaign,
        component: String(r.Component || ''),
        summary: String(r.Summary || ''),
        consequence: String(r.Consequence || ''),
        remedy: String(r.Remedy || ''),
        reportDate: String(r.ReportReceivedDate || ''),
        models: [name]
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    scope: 'model', // recalls issued for the model, not open recalls on this VIN
    vehicle: `${year} ${make} ${model}`,
    matchedModels: matched,
    modelFound: nhtsaModels.length ? matched.length > 0 : null, // null: NHTSA had no model list to check against
    items: [...byCampaign.values()]
  };
}

module.exports = { listProviders, fetchRecalls, matchModelNames, ProviderError };
