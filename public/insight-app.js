// insight-app.js -- Insight Domus as its own app (/insight), like Recon
// Domus: its own tab, its own menu of reports grouped by area, favorites
// pinned to the top, and the report in the address (#sales) so it can be
// bookmarked. The reports themselves are in insight-ui.js.

const API = '/api';
class SafeHtml { constructor(value) { this.value = value; } toString() { return this.value; } }
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function toHtml(v) {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (v === null || v === undefined || v === false) return '';
  return escapeHtml(v);
}
function html(strings, ...values) { let out = strings[0]; values.forEach((v, i) => { out += toHtml(v) + strings[i + 1]; }); return new SafeHtml(out); }
const SOURCE_LABELS = { 'walk-in': 'Walk-in', phone: 'Phone', website: 'Website', referral: 'Referral', autotrader: 'Autotrader', cargurus: 'CarGurus', facebook: 'Facebook', other: 'Other' };
const formatSource = s => SOURCE_LABELS[s] || 'Other';

// Signed out (or the session ran out): back to sign in.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) location.href = '/login.html';
  return res;
};

let currentUser = null;
const userCan = p => !!currentUser && currentUser.permissions.includes(p);

// Every report, by area, and who can open it.
const IN_REPORTS = [
  { area: 'Store', key: 'store', view: 'insightstore', label: 'Store Summary', perm: 'viewDashboardStore' },
  { area: 'Store', key: 'expenses', view: 'insightexpenses', label: 'Expenses & Cash', perm: 'viewAccounting' },
  { area: 'Sales', key: 'heartbeat', view: 'insightheartbeat', label: 'Heartbeat (today)', perm: 'viewAllReports' },
  { area: 'Sales', key: 'sales', view: 'insightsales', label: 'Sales Summary', perm: 'viewAllReports' },
  { area: 'Sales', key: 'leaderboard', view: 'insightleaders', label: 'Leaderboard', perm: 'viewAllReports' },
  { area: 'Sales', key: 'people', view: 'insightpeople', label: 'People & Goals', perm: 'viewAllReports' },
  { area: 'Sales', key: 'trades', view: 'insighttrades', label: 'Trade-ins', perm: 'viewAllReports' },
  { area: 'Sales', key: 'trend', view: 'insighttrend', label: 'Gross Trend', perm: 'viewAllReports' },
  { area: 'F&I', key: 'fi', view: 'insightfi', label: 'F&I Summary', perm: 'viewAllReports' },
  { area: 'Inventory', key: 'inventory', view: 'insightinventory', label: 'Inventory Analysis', perm: 'viewAllReports' },
  { area: 'Service & Parts', key: 'fixed', view: 'insightfixed', label: 'Service & Parts', perm: 'viewDashboardFixed' },
  { area: 'Service & Parts', key: 'parts', view: 'insightparts', label: 'Parts Inventory', perm: 'viewDashboardFixed' },
  { area: 'Marketing', key: 'marketing', view: 'insightmarketing', label: 'Marketing', perm: 'viewAllReports' }
];
const visibleReports = () => IN_REPORTS.filter(r => userCan(r.perm));

// Favorites live in this browser.
function favorites() { try { return JSON.parse(localStorage.getItem('insightFavorites') || '[]'); } catch { return []; } }
function setFavorites(list) { try { localStorage.setItem('insightFavorites', JSON.stringify(list)); } catch { /* private window */ } }

function renderNav(active) {
  const reports = visibleReports();
  const favs = favorites().filter(k => reports.some(r => r.key === k));
  const item = r => html`<div class="in-nav-item ${r.key === active ? 'active' : ''}">
    <a href="#${r.key}" data-in-go="${r.key}">${r.label}</a>
    <button type="button" class="in-star ${favs.includes(r.key) ? 'on' : ''}" data-in-star="${r.key}" title="${favs.includes(r.key) ? 'Remove from favorites' : 'Add to favorites'}" aria-label="Favorite ${r.label}">${favs.includes(r.key) ? '★' : '☆'}</button></div>`;
  const areas = [...new Set(reports.map(r => r.area))];
  document.getElementById('inNav').innerHTML = String(html`
    ${favs.length ? html`<div class="in-nav-area">★ Favorites</div>${favs.map(k => item(reports.find(r => r.key === k)))}` : ''}
    ${areas.map(a => html`<div class="in-nav-area">${a}</div>${reports.filter(r => r.area === a).map(item)}`)}`);
  document.getElementById('inJump').innerHTML = String(html`${reports.map(r => html`<option value="${r.key}" ${r.key === active ? html`selected` : ''}>${r.area} · ${r.label}</option>`)}`);
}

function go(key) {
  const reports = visibleReports();
  const r = reports.find(x => x.key === key) || reports.find(x => favorites().includes(x.key)) || reports[0];
  if (!r) { document.getElementById('inBody').innerHTML = '<p class="audit-note">Your role doesn\'t include any Insight reports.</p>'; return; }
  if (location.hash !== `#${r.key}`) history.replaceState(null, '', `#${r.key}`);
  renderNav(r.key);
  document.title = `${r.label} · Insight Domus`;
  openInsightView(r.view);
}

async function startInsightApp() {
  const res = await fetch(`${API}/auth/me`);
  if (!res.ok) return;
  currentUser = await res.json();
  document.getElementById('inUser').textContent = currentUser.name;
  document.getElementById('inNav').addEventListener('click', (e) => {
    const star = e.target.closest('[data-in-star]');
    if (star) {
      const k = star.dataset.inStar, favs = favorites();
      setFavorites(favs.includes(k) ? favs.filter(x => x !== k) : [...favs, k]);
      return renderNav(location.hash.slice(1));
    }
    const link = e.target.closest('[data-in-go]');
    if (link) { e.preventDefault(); history.replaceState(null, '', `#${link.dataset.inGo}`); go(link.dataset.inGo); }
  });
  document.getElementById('inJump').addEventListener('change', e => go(e.target.value));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  go(location.hash.slice(1));
}
