// hours.js
// Store hours, in the store's own time zone. Used to count response time
// and "not contacted yet" in open-store minutes only: a lead that comes
// in at 11pm and gets a call at 9:05am was answered 5 minutes after
// opening, not 10 hours later.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_TIMEZONE = 'America/Chicago';

function defaultStoreHours() {
  const open = { closed: false, open: '09:00', close: '20:00' };
  return {
    timezone: DEFAULT_TIMEZONE,
    days: { sun: { closed: true, open: '11:00', close: '17:00' }, mon: open, tue: open, wed: open, thu: open, fri: open, sat: { closed: false, open: '09:00', close: '19:00' } }
  };
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Tidies store hours from a settings form; anything invalid falls back to the default.
function cleanStoreHours(input) {
  const def = defaultStoreHours();
  const v = input && typeof input === 'object' ? input : {};
  const out = { timezone: validTimezone(v.timezone) ? v.timezone : def.timezone, days: {} };
  for (const d of DAYS) {
    const day = (v.days && v.days[d]) || {};
    const open = TIME.test(day.open) ? day.open : def.days[d].open;
    const close = TIME.test(day.close) ? day.close : def.days[d].close;
    out.days[d] = { closed: !!day.closed || close <= open, open, close };
  }
  return out;
}

// Minutes between a moment and UTC in a time zone (e.g. -420 for Phoenix).
function tzOffsetMinutes(utcMs, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

// The UTC moment of a local wall-clock time in a time zone (handles DST).
function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  let ms = guess - tzOffsetMinutes(guess, tz) * 60000;
  ms = guess - tzOffsetMinutes(ms, tz) * 60000;
  return ms;
}

function localDate(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, dow: DAYS.indexOf(p.weekday.slice(0, 3).toLowerCase()) };
}

// Open-store minutes between two moments.
function businessMinutesBetween(startMs, endMs, hours) {
  if (!(endMs > startMs)) return 0;
  const h = hours && hours.days ? hours : defaultStoreHours();
  const tz = h.timezone;
  let total = 0;
  const first = localDate(startMs, tz);
  // Walk day by day (in the store's calendar) until past the end.
  for (let i = 0; i < 400; i++) {
    const noon = zonedToUtc(first.y, first.m, first.d + i, 12, 0, tz);
    const day = localDate(noon, tz);
    const dayStart = zonedToUtc(day.y, day.m, day.d, 0, 0, tz);
    if (dayStart > endMs) break;
    const rule = h.days[DAYS[day.dow]];
    if (!rule || rule.closed) continue;
    const [oh, om] = rule.open.split(':').map(Number);
    const [ch, cm] = rule.close.split(':').map(Number);
    const open = zonedToUtc(day.y, day.m, day.d, oh, om, tz);
    const close = zonedToUtc(day.y, day.m, day.d, ch, cm, tz);
    const from = Math.max(open, startMs);
    const to = Math.min(close, endMs);
    if (to > from) total += (to - from) / 60000;
  }
  return total;
}

module.exports = { DAYS, defaultStoreHours, cleanStoreHours, businessMinutesBetween, validTimezone, tzOffsetMinutes };
