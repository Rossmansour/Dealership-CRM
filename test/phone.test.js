// Tests for two-way texting: each employee's own number (texts go out from
// it), customers texting back (matched by phone, or a new customer for an
// unknown number) landing in the Conversation and Messages with an alert,
// STOP/START, and only requests really signed by Twilio being accepted.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('phone tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
delete process.env.RENDER_EXTERNAL_URL;
const h = require('./helpers');
const { setSmsClient } = require('../server');
const phone = require('../phone');
const twilio = require('twilio');

const TOKEN = 'test-twilio-auth-token';
let base, admin, sales, manager, lead;
const sent = [];
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

// Posts to the webhook the way Twilio does, signed (or not).
async function inbound(params, { sign = true } = {}) {
  const url = `${base}/twilio/sms`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sign) headers['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(TOKEN, url, params);
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}

before(async () => {
  base = await h.startServer();
  phone.setWebhookToken(TOKEN);
  setSmsClient({ messages: { create: async m => { sent.push(m); return { sid: `SM${sent.length}`, status: 'queued' }; } } }, '+16025550000');
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
  lead = (await as(sales, 'POST', '/leads', { name: 'Lena Brooks', phone: '(602) 555-2020' })).body;
});
after(() => h.stopServer());

test("each employee gets their own number; texts go out from it", async () => {
  assert.strictEqual((await as(sales, 'PUT', `/users/${sales.id}`, { directNumber: '602-555-0001' })).status, 403, 'admins set numbers');
  const u = (await as(admin, 'PUT', `/users/${sales.id}`, { directNumber: '(602) 555-0001', cellPhone: '480 555 0002' })).body;
  assert.deepStrictEqual([u.directNumber, u.cellPhone], ['+16025550001', '+14805550002']);
  assert.strictEqual((await as(admin, 'PUT', `/users/${manager.id}`, { directNumber: '6025550001' })).status, 409, 'one person per number');
  assert.strictEqual((await as(admin, 'PUT', `/users/${manager.id}`, { directNumber: '12' })).status, 400);

  await as(sales, 'POST', `/leads/${lead.id}/send-text`, { text: 'Hi Lena!' });
  assert.strictEqual(sent.at(-1).from, '+16025550001', "from the salesperson's own number");
  await as(manager, 'POST', `/leads/${lead.id}/send-text`, { text: 'Hello from the store' });
  assert.strictEqual(sent.at(-1).from, '+16025550000', "no number of their own: the store's");
});

test('only Twilio can post texts in', async () => {
  const r = await inbound({ From: '+16025552020', To: '+16025550001', Body: 'fake' }, { sign: false });
  assert.strictEqual(r.status, 403);
  const forged = await fetch(`${base}/twilio/sms`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: 'From=%2B16025552020&To=%2B16025550001&Body=hi' });
  assert.strictEqual(forged.status, 403);
});

test("a customer's reply lands on them: conversation, unread, engaged, alert", async () => {
  const r = await inbound({ From: '+16025552020', To: '+16025550001', Body: 'Is the Tacoma still there?', MessageSid: 'SMx1', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/abc', MediaContentType0: 'image/jpeg' });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<Response><\/Response>/);
  const l = (await as(sales, 'GET', '/leads')).body.find(x => x.id === lead.id);
  const t = l.activities[0];
  assert.deepStrictEqual([t.type, t.direction, t.message, t.reached], ['text', 'in', 'Is the Tacoma still there?', true]);
  assert.deepStrictEqual(t.photos, ['https://api.twilio.com/media/abc']);
  assert.strictEqual(l.unreadTexts, 1);
  assert.ok((await as(sales, 'GET', '/alerts')).body.some(a => a.type === 'text_reply' && /Lena Brooks texted back/.test(a.title)));

  const inbox = (await as(sales, 'GET', '/messages')).body;
  assert.strictEqual(inbox.myNumber, '+16025550001');
  assert.strictEqual(inbox.conversations[0].leadId, lead.id);
  assert.strictEqual(inbox.conversations[0].unread, 1);
  assert.strictEqual(inbox.conversations[0].last.direction, 'in');
  await as(sales, 'POST', `/leads/${lead.id}/texts/read`);
  assert.strictEqual((await as(sales, 'GET', '/messages')).body.conversations[0].unread, 0);
  // Unread counts can't be edited by hand.
  await as(sales, 'PUT', `/leads/${lead.id}`, { unreadTexts: 9, smsOptOut: true });
  const after = (await as(sales, 'GET', '/leads')).body.find(x => x.id === lead.id);
  assert.deepStrictEqual([after.unreadTexts, !!after.smsOptOut], [0, false]);
});

test('a number we don\'t know becomes a new customer for the employee whose number it texted', async () => {
  await inbound({ From: '+14805559911', To: '+16025550001', Body: 'Saw your truck online' });
  const l = (await as(sales, 'GET', '/leads')).body.find(x => x.phone === '+14805559911');
  assert.ok(l, 'new customer');
  assert.match(l.name, /Text from \(480\) 555-9911/);
  assert.strictEqual(String(l.sales1Id), String(sales.id));
  assert.strictEqual(l.activities.find(a => a.direction === 'in').message, 'Saw your truck online');
  // The store's main number: still lands, nobody in particular.
  await inbound({ From: '+14805558800', To: '+16025550000', Body: 'Hours today?' });
  assert.ok((await as(manager, 'GET', '/leads')).body.some(x => x.phone === '+14805558800'));
  assert.ok((await as(manager, 'GET', '/messages?scope=all')).body.conversations.length >= 3, 'managers can see everyone\'s');
});

test('STOP and START', async () => {
  await inbound({ From: '+16025552020', To: '+16025550001', Body: 'STOP' });
  const r = await as(sales, 'POST', `/leads/${lead.id}/send-text`, { text: 'Still interested?' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /texted STOP/);
  await inbound({ From: '+16025552020', To: '+16025550001', Body: 'start' });
  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/send-text`, { text: 'Welcome back' })).status, 201);
});
