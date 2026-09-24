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
    key: 'recalls', name: 'Safety Recalls', category: 'recalls', live: true,
    description: 'Open safety recalls for this year, make, and model, from NHTSA (the US government).'
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
// https://api.nhtsa.gov/recalls/recallsByVehicle?make=Honda&model=Accord&modelYear=2020
// Recalls are listed for the year/make/model; whether a specific VIN has
// had the fix done is checked on nhtsa.gov/recalls or with the manufacturer.

const nhtsaBaseUrl = () => process.env.NHTSA_API_URL || 'https://api.nhtsa.gov';
const TIMEOUT_MS = 10000;

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchRecalls({ year, make, model }) {
  if (!year || !make || !model) {
    throw new ProviderError('Recalls need the year, make, and model. Decode the VIN or fill them in first.', 400);
  }
  const url = `${nhtsaBaseUrl()}/recalls/recallsByVehicle?make=${encodeURIComponent(make)}` +
    `&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, { signal: controller.signal });
    // NHTSA answers 400 when it has nothing for that model name; treat as no recalls.
    if (res.status === 400) return { checkedAt: new Date().toISOString(), items: [] };
    if (!res.ok) throw new Error(`NHTSA responded ${res.status}`);
    data = await res.json();
  } catch (err) {
    throw new ProviderError("Couldn't reach NHTSA's recall database right now. Try again in a minute.", 502);
  } finally {
    clearTimeout(timer);
  }
  const results = Array.isArray(data && data.results) ? data.results : [];
  return {
    checkedAt: new Date().toISOString(),
    items: results.map(r => ({
      campaign: String(r.NHTSACampaignNumber || ''),
      component: String(r.Component || ''),
      summary: String(r.Summary || ''),
      consequence: String(r.Consequence || ''),
      remedy: String(r.Remedy || ''),
      reportDate: String(r.ReportReceivedDate || '')
    }))
  };
}

module.exports = { listProviders, fetchRecalls, ProviderError };
