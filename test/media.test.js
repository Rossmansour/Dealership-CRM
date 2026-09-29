// Tests for sending photos and videos to customers: uploading from the
// customer page, photos going out as a picture text, videos as a link to a
// watch page, only this customer's own uploads can be sent, and the
// customer pressing play being noted and alerted. Twilio isn't called: a
// stand-in records what would have been sent.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) {
  test('media tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
delete process.env.CLOUDINARY_URL; // local disk
const h = require('./helpers');
const { setSmsClient } = require('../server');

let base, sales, other, lead, otherLead;
const sent = [];
const as = (user, method, path, body) => h.api(method, path, body, user.cookie);
async function upload(user, leadId, name, type, bytes = 2048) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(bytes, 7)], { type }), name);
  const res = await fetch(`${base}/api/leads/${leadId}/media`, { method: 'POST', headers: { Cookie: user.cookie }, body: form });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  base = await h.startServer();
  setSmsClient({ messages: { create: async (m) => { sent.push(m); return { sid: `SM${sent.length}`, status: 'queued' }; } } });
  sales = await h.createUser('salesperson');
  other = await h.createUser('salesperson');
  lead = (await as(sales, 'POST', '/leads', { name: 'Rosa Vega', phone: '602-555-7788', sales1Id: sales.id })).body;
  otherLead = (await as(other, 'POST', '/leads', { name: 'Tim Other', phone: '602-555-7799' })).body;
});
after(() => h.stopServer());

test('photos: uploaded and sent as a picture text, logged in the conversation', async () => {
  assert.strictEqual((await upload(sales, lead.id, 'notes.txt', 'text/plain')).status, 400, 'only photos and videos');
  const pic = (await upload(sales, lead.id, 'engine.jpg', 'image/jpeg')).body;
  assert.strictEqual(pic.kind, 'photo');
  assert.match(pic.url, /^\/uploads\/media\/.+\.jpg$/);
  assert.strictEqual(pic.token, undefined, 'photos have no watch page');

  const r = await as(sales, 'POST', `/leads/${lead.id}/send-text`, { text: 'Here is the engine bay', mediaIds: [pic.id] });
  assert.strictEqual(r.status, 201);
  const msg = sent.at(-1);
  assert.strictEqual(msg.body, 'Here is the engine bay');
  assert.deepStrictEqual(msg.mediaUrl, [`${base}${pic.url}`]);
  assert.strictEqual(r.body.activity.type, 'text');
  assert.deepStrictEqual(r.body.activity.photos, [pic.url]);
});

test("videos: sent as a watch link; only this customer's uploads; finishes the video task", async () => {
  const vid = (await upload(sales, lead.id, 'walkaround.mov', 'video/quicktime')).body;
  assert.strictEqual(vid.kind, 'video');
  assert.ok(vid.token && vid.token.length >= 20);
  const theirs = (await upload(other, otherLead.id, 'x.mp4', 'video/mp4')).body;

  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/send-text`, { mediaIds: [theirs.id] })).status, 400, "another customer's video can't be sent");
  assert.strictEqual((await as(sales, 'POST', `/leads/${lead.id}/send-text`, { mediaIds: ['made-up'] })).status, 400);

  await as(sales, 'POST', '/ai-tasks/run', {});
  const videoTask = (await as(sales, 'GET', '/tasks?status=open')).body.find(t => t.leadId === lead.id && t.type === 'video');
  assert.ok(videoTask, 'the planner asked for a video');

  const r = await as(sales, 'POST', `/leads/${lead.id}/send-text`, { text: 'Quick walkaround for you!', mediaIds: [vid.id] });
  assert.strictEqual(r.status, 201);
  const msg = sent.at(-1);
  assert.strictEqual(msg.body, `Quick walkaround for you!\n${base}/v/${vid.token}`);
  assert.strictEqual(msg.mediaUrl, undefined, 'videos go as a link, not a picture text');
  assert.strictEqual(r.body.activity.type, 'video');
  const done = (await as(sales, 'GET', '/tasks?status=done')).body.find(t => t.id === videoTask.id);
  assert.ok(done, 'sending it finished the video task');
});

test('the watch page: no sign-in, plays the video, and pressing play is noted and alerted', async () => {
  const leadNow = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id);
  const vid = leadNow.media.find(m => m.kind === 'video');

  const page = await fetch(`${base}/v/${vid.token}`);
  assert.strictEqual(page.status, 200);
  const htmlText = await page.text();
  assert.match(htmlText, /Hi Rosa/);
  assert.ok(htmlText.includes(vid.url), 'plays the uploaded video');
  assert.strictEqual((await fetch(`${base}/v/not-a-real-token-at-all`)).status, 404);

  assert.strictEqual((await fetch(`${base}/v/${vid.token}/played`, { method: 'POST' })).status, 204);
  await fetch(`${base}/v/${vid.token}/played`, { method: 'POST' }); // replaying right away isn't a new view
  const after = (await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id);
  assert.strictEqual(after.media.find(m => m.id === vid.id).views, 1);
  assert.match(after.activities[0].text, /Watched the video/);
  const alerts = (await as(sales, 'GET', '/alerts')).body;
  assert.ok(alerts.some(a => a.type === 'video_watched' && /Rosa Vega just watched your video/.test(a.title)));

  // The media list can't be rewritten through a normal customer edit.
  await as(sales, 'PUT', `/leads/${lead.id}`, { media: [] });
  assert.ok((await as(sales, 'GET', '/leads')).body.find(l => l.id === lead.id).media.length >= 2);
});
