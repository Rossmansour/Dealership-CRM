// Tests for two-way texting: each employee's own number (texts go out from
// it), customers texting back (matched by phone, or a new customer for an
// unknown number) landing in the Conversation and Messages with an alert,
// STOP/START, only requests really signed by Twilio being accepted, and
// calls: forwarding to the employee's cell, click-to-call, and call logging.
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
const mailer = require('../mailer');

const TOKEN = 'test-twilio-auth-token';
let base, admin, sales, manager, lead;
const sent = [];
const calls = [];
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);

// Posts to the webhook the way Twilio does, signed (or not).
async function inbound(params, { sign = true, path = '/twilio/sms' } = {}) {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sign) headers['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(TOKEN, url, params);
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}

before(async () => {
  base = await h.startServer();
  phone.setWebhookToken(TOKEN);
  setSmsClient({
    messages: { create: async m => { sent.push(m); return { sid: `SM${sent.length}`, status: 'queued' }; } },
    calls: { create: async c => { calls.push(c); return { sid: `CA${calls.length}` }; } }
  }, '+16025550000');
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

// ---------- Calls ----------

const voice = (params, path = '/twilio/voice') => inbound(params, { path });
// The URL Twilio is told to come back to, out of the TwiML.
const actionOf = xml => xml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&');
const leadById = async id => (await as(sales, 'GET', '/leads')).body.find(x => x.id === id);
const unamp = u => u.replace(/&amp;/g, '&');
// Someone's phone picks up and they press 1 (or don't). `who`: whose number in the Dial.
async function pickUp(twimlText, digits = '1', nth = 0) {
  const screenUrl = unamp([...twimlText.matchAll(/<Number url="([^"]+)"/g)][nth][1]);
  const screen = await inbound({ CallStatus: 'in-progress' }, { path: screenUrl });
  const gather = unamp(screen.text.match(/<Gather[^>]* action="([^"]+)"/)[1]);
  return { screen, accept: await inbound({ Digits: digits }, { path: gather }) };
}
// The whole inbound call: picked up and taken, then ends after `secs`.
async function answered(twimlText, secs) {
  await pickUp(twimlText);
  return inbound({ DialCallStatus: 'completed', DialCallDuration: String(secs) }, { path: actionOf(twimlText) });
}

test("a customer calling an employee's number rings their cell, and the call is logged with its length", async () => {
  const r = await voice({ From: '+16025552020', To: '+16025550001', CallSid: 'CAin1' });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<Dial callerId="\+16025552020"[^>]*><Number url="[^"]*\/twilio\/voice\/screen[^"]*">\+14805550002<\/Number><\/Dial>/, "rings the cell, showing the customer's number");
  assert.strictEqual((await leadById(lead.id)).activities[0].status, 'ringing');

  const { screen } = await pickUp(r.text);
  assert.match(screen.text, /call from Lena Brooks. Press 1 to take it/);
  const done = await inbound({ DialCallStatus: 'completed', DialCallDuration: '75' }, { path: actionOf(r.text) });
  assert.strictEqual(done.status, 200);
  const call = (await leadById(lead.id)).activities[0];
  assert.deepStrictEqual([call.type, call.direction, call.text, call.reached, call.seconds], ['call', 'in', 'Incoming call · 1m 15s', true, 75]);
  // Twilio retrying the same callback changes nothing.
  await inbound({ DialCallStatus: 'no-answer' }, { path: actionOf(r.text) });
  assert.strictEqual((await leadById(lead.id)).activities[0].text, 'Incoming call · 1m 15s');
});

test('a missed call alerts whoever has the customer; unknown callers become customers', async () => {
  const r = await voice({ From: '+16025552020', To: '+16025550001' });
  const done = await inbound({ DialCallStatus: 'no-answer', DialCallDuration: '0' }, { path: actionOf(r.text) });
  assert.match(done.text, /<Say>Sorry we missed you/);
  assert.strictEqual((await leadById(lead.id)).activities[0].text, 'Missed call');
  assert.ok((await as(sales, 'GET', '/alerts')).body.some(a => a.type === 'missed_call' && /Missed call from Lena Brooks/.test(a.title)));

  await voice({ From: '+14805557700', To: '+16025550001' });
  const l = (await as(sales, 'GET', '/leads')).body.find(x => x.phone === '+14805557700');
  assert.match(l.name, /Call from \(480\) 555-7700/);
  assert.strictEqual(String(l.sales1Id), String(sales.id));

  // A voicemail picking up never presses 1: still a missed call.
  const vm = await voice({ From: '+16025552020', To: '+16025550001' });
  const { accept } = await pickUp(vm.text, '');
  assert.match(accept.text, /<Hangup\/>/);
  await inbound({ DialCallStatus: 'completed', DialCallDuration: '30' }, { path: actionOf(vm.text) });
  assert.strictEqual((await leadById(lead.id)).activities[0].text, 'Missed call');
  assert.strictEqual((await inbound({ From: '+1', To: '+1' }, { path: '/twilio/voice', sign: false })).status, 403, 'signed only');
});

test("Call on a customer page rings my cell, then connects me from my business number", async () => {
  assert.strictEqual((await as(manager, 'POST', `/leads/${lead.id}/call`)).status, 400, 'needs a cell on file');
  const r = await as(sales, 'POST', `/leads/${lead.id}/call`);
  assert.strictEqual(r.status, 201);
  assert.match(r.body.message, /\(480\) 555-0002\) is ringing/);
  const c = calls.at(-1);
  assert.deepStrictEqual([c.to, c.from], ['+14805550002', '+16025550001']);

  // They pick up: Twilio asks what to do, and we dial the customer.
  const connect = await inbound({ CallStatus: 'in-progress' }, { path: c.url });
  assert.match(connect.text, /Connecting you to Lena Brooks/);
  assert.match(connect.text, /<Dial callerId="\+16025550001"[^>]*><Number>\(602\) 555-2020<\/Number>/);
  await inbound({ DialCallStatus: 'completed', DialCallDuration: '30' }, { path: actionOf(connect.text) });
  const call = (await leadById(lead.id)).activities[0];
  assert.deepStrictEqual([call.direction, call.text, call.reached, String(call.by.id)], ['out', 'Call · 30s', true, String(sales.id)]);

  // They don't pick up their own phone: nothing happened.
  await as(sales, 'POST', `/leads/${lead.id}/call`);
  await inbound({ CallStatus: 'no-answer' }, { path: calls.at(-1).statusCallback });
  assert.match((await leadById(lead.id)).activities[0].text, /you didn't pick up/);
});

// ---------- Recording and AI call summaries ----------

test('incoming calls are recorded (after the notice); outgoing record only the employee', async () => {
  const r = await voice({ From: '+16025552020', To: '+16025550001' });
  assert.match(r.text, /<Say>This call may be recorded for quality and training.<\/Say><Dial[^>]* record="record-from-answer-dual"/);
  assert.match(r.text, /recordingStatusCallback="[^"]*\/twilio\/voice\/recording/);
  await answered(r.text, 40);
  const recUrl = r.text.match(/recordingStatusCallback="([^"]+)"/)[1].replace(/&amp;/g, '&');
  await inbound({ RecordingStatus: 'completed', RecordingSid: 'RE1', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1', RecordingDuration: '40' }, { path: recUrl });
  const call = (await leadById(lead.id)).activities[0];
  assert.deepStrictEqual([call.text, call.recording.sid, call.recording.sides], ['Incoming call · 40s', 'RE1', 'both']);
  assert.ok(!call.summary, 'summaries are off until the store turns them on');

  phone.use({ recordingAudio: async () => Buffer.from('fake-mp3') });
  const play = await fetch(`${base}/api/leads/${lead.id}/calls/${call.id}/recording`, { headers: { Cookie: sales.cookie } });
  assert.deepStrictEqual([play.status, play.headers.get('content-type'), await play.text()], [200, 'audio/mpeg', 'fake-mp3']);

  await as(sales, 'POST', `/leads/${lead.id}/call`);
  const c = calls.at(-1);
  assert.deepStrictEqual([c.record, c.recordingTrack], [true, 'inbound'], "only what comes from the employee's phone");

  // Turned off: no notice, no recording.
  assert.strictEqual((await as(sales, 'PUT', '/phone-settings', { recordInbound: false })).status, 403);
  await as(admin, 'PUT', '/phone-settings', { recordInbound: false, recordOutbound: false });
  assert.doesNotMatch((await voice({ From: '+16025552020', To: '+16025550001' })).text, /record|Say/);
  await as(sales, 'POST', `/leads/${lead.id}/call`);
  assert.ok(!calls.at(-1).record);
  await as(admin, 'PUT', '/phone-settings', { recordInbound: true, recordOutbound: true });
});

test('AI summary of an incoming call is saved and emailed', async () => {
  const mails = [];
  mailer.setTransport(async m => { mails.push(m); return { sent: true }; });
  let heard = null;
  phone.use({ aiReady: () => true, recordingAudio: async () => Buffer.from('audio'), summarizeAudio: async (audio, type, prompt) => { heard = { audio: audio.toString(), type, prompt }; return '- Lena wants to test drive the Tacoma Saturday at 11.'; } });
  const s = (await as(admin, 'PUT', '/phone-settings', { summaries: true, summaryEmails: 'gm@store.com, BAD, sm@store.com' })).body;
  assert.deepStrictEqual(s.summaryEmails, ['gm@store.com', 'sm@store.com']);

  const r = await voice({ From: '+16025552020', To: '+16025550001' });
  await answered(r.text, 95);
  await inbound({ RecordingSid: 'RE2', RecordingUrl: 'https://api.twilio.com/x/RE2', RecordingDuration: '95' }, { path: r.text.match(/recordingStatusCallback="([^"]+)"/)[1].replace(/&amp;/g, '&') });
  await phone.pendingSummary();

  assert.strictEqual(heard.type, 'audio/mpeg');
  assert.match(heard.prompt, /\[withheld\]/, 'never repeats SSNs and the like');
  const call = (await leadById(lead.id)).activities[0];
  assert.match(call.summary.text, /test drive the Tacoma/);
  assert.strictEqual(call.summary.emailed, true);
  assert.strictEqual(mails.length, 1);
  assert.deepStrictEqual(mails[0].to.slice(0, 2), ['gm@store.com', 'sm@store.com']);
  assert.ok(mails[0].to.includes(sales.email), 'and the employee who took it');
  assert.match(mails[0].subject, /Call summary: Lena Brooks · \(602\) 555-2020 · 1m 35s/);

  // Outgoing calls aren't summarized.
  await as(sales, 'POST', `/leads/${lead.id}/call`);
  await inbound({ RecordingSid: 'RE3', RecordingUrl: 'https://api.twilio.com/x/RE3', RecordingDuration: '20' }, { path: calls.at(-1).recordingStatusCallback });
  await phone.pendingSummary();
  assert.strictEqual(mails.length, 1);

  // Email not set up: the summary is still kept, marked not sent.
  mailer.setTransport(null);
  const before = { key: process.env.RESEND_API_KEY }; delete process.env.RESEND_API_KEY;
  const r2 = await voice({ From: '+16025552020', To: '+16025550001' });
  await answered(r2.text, 10);
  await inbound({ RecordingSid: 'RE4', RecordingUrl: 'https://api.twilio.com/x/RE4', RecordingDuration: '10' }, { path: r2.text.match(/recordingStatusCallback="([^"]+)"/)[1].replace(/&amp;/g, '&') });
  await phone.pendingSummary();
  const c2 = (await leadById(lead.id)).activities[0];
  assert.deepStrictEqual([!!c2.summary.text, c2.summary.emailed], [true, false]);
  assert.match(c2.summary.emailNote, /isn't set up yet/);
  if (before.key) process.env.RESEND_API_KEY = before.key;
});

// ---------- Who gets the customer ----------

test("the store line rings everyone taking leads; whoever takes it gets the new customer, and they're Engaged", async () => {
  const s2 = await h.createUser('salesperson');
  await as(admin, 'PUT', `/users/${s2.id}`, { cellPhone: '4805550003' });
  const r = await voice({ From: '+14805556600', To: '+16025550000' });
  const nums = [...r.text.matchAll(/<Number url="[^"]+">([^<]+)<\/Number>/g)].map(m => m[1]);
  assert.ok(nums.includes('+14805550002') && nums.includes('+14805550003'), 'rings everyone with a cell at once');
  const fresh = (await as(manager, 'GET', '/leads')).body.find(x => x.phone === '+14805556600');
  assert.ok(!fresh.sales1Id, 'nobody yet -- not the round robin either');

  // The second salesperson takes it.
  const idx = nums.indexOf('+14805550003');
  await pickUp(r.text, '1', idx);
  await inbound({ DialCallStatus: 'completed', DialCallDuration: '120' }, { path: actionOf(r.text) });
  const l = (await as(manager, 'GET', '/leads')).body.find(x => x.id === fresh.id);
  assert.strictEqual(String(l.sales1Id), String(s2.id));
  assert.match(l.activities.find(a => a.type === 'status').text, /took their call/);
  const call = l.activities.find(a => a.type === 'call');
  assert.deepStrictEqual([call.reached, String(call.by.id)], [true, String(s2.id)]);
  assert.strictEqual(require('../taskplan').stageOf(l, [], new Set()), 'engaged');

  // Someone who already has a salesperson keeps them.
  const r2 = await voice({ From: '+16025552020', To: '+16025550000' });
  await pickUp(r2.text, '1', [...r2.text.matchAll(/<Number url="[^"]+">([^<]+)<\/Number>/g)].map(m => m[1]).indexOf('+14805550003'));
  assert.strictEqual(String((await leadById(lead.id)).sales1Id), String(sales.id));
});

test('nobody takes it: a new caller stays New, and the managers hear about it', async () => {
  const r = await voice({ From: '+14805556611', To: '+16025550000' });
  await inbound({ DialCallStatus: 'no-answer' }, { path: actionOf(r.text) });
  const l = (await as(manager, 'GET', '/leads')).body.find(x => x.phone === '+14805556611');
  assert.ok(!l.sales1Id);
  assert.strictEqual(l.activities[0].text, 'Missed call');
  assert.strictEqual(require('../taskplan').stageOf(l, [], new Set()), 'new', 'their missed call is not us reaching out');
  assert.ok((await as(manager, 'GET', '/alerts')).body.some(a => a.type === 'missed_call' && a.link.id === l.id));
});
