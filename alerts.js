// alerts.js
// The bell: alerts for the things people need to act on -- a lead
// assigned to them, a trade appraised, F&I approving a credit app, a
// task coming due, a new lead nobody has contacted yet.
//
// Alerts are made by notify() from the routes where things happen, and by
// sweep() (run every minute) for anything time-based. Each person chooses
// which alert types they get, their priority, and whether they make a
// sound. In-app is the only delivery for now; email, text, and phone push
// show "Not available yet" until those services are connected.

const crypto = require('crypto');
const express = require('express');
const store = require('./db');

// Who gets each type by default: 'assigned' means the person the thing is
// for (the salesperson on the lead, the task's assignee); roles mean
// everyone in those roles.
const ALERT_TYPES = [
  { key: 'lead_assigned', category: 'Customers', label: 'Customer assigned to you', description: 'Someone makes you Sales 1/2 or BDC 1/2 on a customer, or transfers one to you.', audience: 'assigned' },
  { key: 'lead_escalation', category: 'Customers', label: 'New lead not contacted', description: 'A new lead has had no call, text, email, or note for longer than the store allows (Admin → Fee Defaults).', audience: ['admin', 'sales_manager'], priority: 'high' },
  { key: 'task_assigned', category: 'Tasks & appointments', label: 'Task or appointment assigned to you', description: 'Someone else schedules a task or appointment for you.', audience: 'assigned' },
  { key: 'task_due', category: 'Tasks & appointments', label: 'Task or appointment due', description: 'One of your tasks or appointments is due now.', audience: 'assigned', priority: 'high', sound: true },
  { key: 'trade_needs_appraisal', category: 'Appraisals', label: 'Trade waiting for appraisal', description: 'Sales sent a trade over from a customer page.', audience: ['admin', 'sales_manager'] },
  { key: 'trade_appraised', category: 'Appraisals', label: 'Your trade was appraised', description: 'A manager put a number on a trade for your customer.', audience: 'assigned' },
  { key: 'deal_pushed', category: 'Deals & credit', label: 'Deal pushed to the DMS', description: 'Sales pushed a deal from a customer page.', audience: ['admin', 'sales_manager', 'finance'] },
  { key: 'credit_pushed', category: 'Deals & credit', label: 'Credit app pushed', description: 'Sales pushed a credit app to a deal.', audience: ['admin', 'sales_manager', 'finance'] },
  { key: 'credit_status', category: 'Deals & credit', label: 'Credit app status changed', description: 'F&I marked your customer’s credit app pending, approved, conditional, or declined.', audience: 'assigned', priority: 'high' },
  // Not available yet: need a service connected first.
  { key: 'text_reply', category: 'Customers', label: 'Customer texted back', description: 'Needs receiving texts set up (Twilio).', audience: 'assigned', available: false },
  { key: 'internet_lead', category: 'Customers', label: 'New internet lead', description: 'Needs internet lead intake (leads from your website and listing sites).', audience: 'assigned', available: false },
  { key: 'email_opened', category: 'Customers', label: 'Customer opened your email', description: 'Needs sending email from the CRM.', audience: 'assigned', available: false }
];
const TYPE_BY_KEY = Object.fromEntries(ALERT_TYPES.map(t => [t.key, t]));
const PRIORITIES = ['normal', 'high'];
const DELIVERY_LATER = ['email', 'text', 'push'];

// A person's effective setting for one type.
function settingFor(type, saved, role) {
  const s = (saved || {})[type.key] || {};
  const forRole = type.audience === 'assigned' || type.audience.includes(role);
  return {
    enabled: type.available === false ? false : ('enabled' in s ? !!s.enabled : forRole),
    priority: PRIORITIES.includes(s.priority) ? s.priority : (type.priority || 'normal'),
    sound: 'sound' in s ? !!s.sound : !!type.sound
  };
}

// Creates alerts. Recipients: specific userIds and/or everyone in the
// type's roles -- minus whoever caused it, anyone inactive, and anyone
// who turned this type off. `q` is the caller's transaction.
async function notify(q, { dealershipId, type, userIds = [], useRoles = false, actorId = null, title, body = '', link = null, dueAt = null }) {
  const def = TYPE_BY_KEY[type];
  if (!def || def.available === false) return [];
  const roles = useRoles && Array.isArray(def.audience) ? def.audience : [];
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length && !roles.length) return [];
  const { rows } = await q.query(
    `SELECT id, role, alert_settings FROM users
     WHERE dealership_id = $1 AND active AND (id::text = ANY($2) OR role = ANY($3))`,
    [dealershipId, ids, roles]);
  const created = [];
  for (const user of rows) {
    if (actorId && String(user.id) === String(actorId)) continue;
    const setting = settingFor(def, user.alert_settings, user.role);
    if (!setting.enabled) continue;
    const alert = {
      id: crypto.randomUUID(), type, title: String(title).slice(0, 200), body: String(body || '').slice(0, 500),
      link, dueAt, priority: setting.priority, sound: setting.sound, // dueAt: shown in each person's own time zone
      createdAt: new Date().toISOString(), readAt: null, dismissedAt: null, snoozedUntil: null
    };
    await q.query('INSERT INTO alerts (dealership_id, id, user_id, data) VALUES ($1, $2, $3, $4)',
      [dealershipId, alert.id, user.id, alert]);
    created.push(alert);
  }
  return created;
}

// Time-based alerts: tasks that just came due, and new leads nobody has
// contacted within the store's limit. Each is alerted once (marked on the
// record), so running this on several servers at once is harmless.
async function sweep(getSettings) {
  const now = new Date();
  // Tasks due
  await store.tx(async q => {
    const { rows } = await q.query(
      `SELECT dealership_id, id, data FROM tasks
       WHERE data->>'status' = 'open' AND (data->>'dueAt')::timestamptz <= now() AND NOT (data ? 'dueAlertedAt')
       FOR UPDATE SKIP LOCKED`);
    for (const row of rows) {
      const t = row.data;
      await q.query(`UPDATE tasks SET data = data || jsonb_build_object('dueAlertedAt', $3::text) WHERE dealership_id = $1 AND id = $2`,
        [row.dealership_id, row.id, now.toISOString()]);
      // Long-overdue tasks (e.g. from before alerts existed) don't set off a pile of alerts.
      if (now - new Date(t.dueAt) > 24 * 3600000) continue;
      const labels = { call: 'Call', text: 'Text', email: 'Email', appointment: 'Appointment', todo: 'To-do' };
      await notify(q, {
        dealershipId: row.dealership_id, type: 'task_due', userIds: [t.assignedTo && t.assignedTo.id],
        title: `${labels[t.type] || 'Task'} due: ${t.leadName || 'customer'}`, body: t.title || '',
        link: { kind: 'lead', id: t.leadId }, dueAt: t.dueAt
      });
    }
  });
  // New leads not contacted
  await store.tx(async q => {
    const { rows } = await q.query(
      `SELECT dealership_id, id, data FROM leads
       WHERE data->>'status' = 'new' AND NOT (data ? 'escalatedAt')
         AND (data->>'dateAdded')::timestamptz > now() - interval '1 day'
       FOR UPDATE SKIP LOCKED`);
    const contactTypes = ['call', 'text', 'email', 'note', 'visit', 'task', 'appointment'];
    for (const row of rows) {
      const lead = row.data;
      const settings = await getSettings(q, row.dealership_id);
      const limit = Math.max(1, Number(settings.leadEscalationMinutes) || 15);
      if (now - new Date(lead.dateAdded) < limit * 60000) continue;
      if ((lead.activities || []).some(a => contactTypes.includes(a.type))) continue;
      await q.query(`UPDATE leads SET data = data || jsonb_build_object('escalatedAt', $3::text) WHERE dealership_id = $1 AND id = $2`,
        [row.dealership_id, row.id, now.toISOString()]);
      await notify(q, {
        dealershipId: row.dealership_id, type: 'lead_escalation', useRoles: true,
        title: `Not contacted in ${limit}+ min: ${lead.name}`,
        body: `New ${lead.source || ''} lead${lead.sales1Id ? '' : ', not assigned to anyone'}.`.replace('  ', ' '),
        link: { kind: 'lead', id: lead.id }
      });
    }
  });
}

// ---------- Routes (each person only ever sees their own alerts) ----------

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Visible = not dismissed, and not snoozed into the future.
const VISIBLE = `user_id = $1 AND dealership_id = $2 AND data->>'dismissedAt' IS NULL
  AND (data->>'snoozedUntil' IS NULL OR (data->>'snoozedUntil')::timestamptz <= now())`;
const UNREAD = `${VISIBLE} AND data->>'readAt' IS NULL`;

router.get('/alerts/count', wrap(async (req, res) => {
  const { rows } = await store.pool.query(
    `SELECT count(*)::int AS unread, max(seq)::text AS latest,
            bool_or(data->>'priority' = 'high') AS high, bool_or((data->>'sound')::boolean) AS sound
     FROM alerts WHERE ${UNREAD}`, [req.user.id, req.dealershipId]);
  res.json({ unread: rows[0].unread, latest: rows[0].latest, high: !!rows[0].high, sound: !!rows[0].sound });
}));

router.get('/alerts', wrap(async (req, res) => {
  const unreadOnly = req.query.filter === 'unread';
  const { rows } = await store.pool.query(
    `SELECT data, seq FROM alerts WHERE ${unreadOnly ? UNREAD : VISIBLE} ORDER BY seq DESC LIMIT 100`,
    [req.user.id, req.dealershipId]);
  res.json(rows.map(r => ({ ...r.data, seq: String(r.seq) })));
}));

async function updateMine(req, ids, patch) {
  const { rowCount } = await store.pool.query(
    `UPDATE alerts SET data = data || $4::jsonb WHERE user_id = $1 AND dealership_id = $2 AND id = ANY($3)`,
    [req.user.id, req.dealershipId, ids.map(String), JSON.stringify(patch)]);
  return rowCount;
}

router.post('/alerts/read', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.all) {
    await store.pool.query(`UPDATE alerts SET data = data || jsonb_build_object('readAt', now()::text) WHERE ${UNREAD}`, [req.user.id, req.dealershipId]);
  } else {
    await updateMine(req, Array.isArray(b.ids) ? b.ids : [], { readAt: new Date().toISOString() });
  }
  res.status(204).send();
}));

router.post('/alerts/dismiss', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.all) {
    await store.pool.query(`UPDATE alerts SET data = data || jsonb_build_object('dismissedAt', now()::text) WHERE ${VISIBLE}`, [req.user.id, req.dealershipId]);
  } else {
    await updateMine(req, Array.isArray(b.ids) ? b.ids : [], { dismissedAt: new Date().toISOString() });
  }
  res.status(204).send();
}));

// Snoozed alerts disappear and come back unread when the time is up.
router.post('/alerts/snooze', wrap(async (req, res) => {
  const b = req.body || {};
  const until = new Date(b.until);
  if (Number.isNaN(until.getTime()) || until <= new Date()) return res.status(400).json({ error: 'Pick a time in the future.' });
  const n = await updateMine(req, Array.isArray(b.ids) ? b.ids : [], { snoozedUntil: until.toISOString(), readAt: null });
  if (!n) return res.status(404).json({ error: 'Alert not found' });
  res.status(204).send();
}));

router.get('/alerts/settings', wrap(async (req, res) => {
  const { rows } = await store.pool.query('SELECT alert_settings FROM users WHERE id = $1', [req.user.id]);
  const saved = rows[0] ? rows[0].alert_settings : {};
  res.json(ALERT_TYPES.map(t => ({
    key: t.key, category: t.category, label: t.label, description: t.description,
    available: t.available !== false, delivery: { inApp: true, later: DELIVERY_LATER },
    ...settingFor(t, saved, req.user.role)
  })));
}));

router.put('/alerts/settings', wrap(async (req, res) => {
  const incoming = req.body || {};
  await store.tx(async q => {
    const { rows } = await q.query('SELECT alert_settings FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const saved = { ...(rows[0] ? rows[0].alert_settings : {}) };
    for (const [key, value] of Object.entries(incoming)) {
      const def = TYPE_BY_KEY[key];
      if (!def || def.available === false || !value || typeof value !== 'object') continue;
      saved[key] = {
        enabled: !!value.enabled,
        priority: PRIORITIES.includes(value.priority) ? value.priority : (def.priority || 'normal'),
        sound: !!value.sound
      };
    }
    await q.query('UPDATE users SET alert_settings = $2 WHERE id = $1', [req.user.id, saved]);
  });
  res.status(204).send();
}));

module.exports = { ALERT_TYPES, notify, sweep, router, settingFor };
