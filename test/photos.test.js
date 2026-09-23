// Tests for car photo storage. Cloudinary's real service isn't called: a
// stand-in server accepts uploads and deletes the way Cloudinary's API
// does, and rejects any request whose signature is wrong.
//
// Run with:  TEST_DATABASE_URL=postgres://... npm test
// WARNING: wipes every table in the TEST_DATABASE_URL database.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

if (!process.env.TEST_DATABASE_URL) {
  test('photo tests (skipped: set TEST_DATABASE_URL to run)', { skip: true }, () => {});
  return;
}
const h = require('./helpers');
const photos = require('../photos');

const API_KEY = 'test-key';
const API_SECRET = 'test-secret';
const CLOUD = 'demo-lot';

// Stand-in for Cloudinary's upload and destroy APIs.
const stored = new Map(); // public_id -> bytes
const destroyed = [];
let failNextUploads = 0;
let fakeCloudinary;

function verifySignature(body) {
  const { signature, api_key, file, ...params } = body;
  return api_key === API_KEY && signature === photos.sign(params, API_SECRET);
}

let admin, manager, sales;
let base;

before(async () => {
  const fake = express();
  const parse = multer({ storage: multer.memoryStorage() }).single('file');
  fake.post(`/v1_1/${CLOUD}/image/upload`, parse, (req, res) => {
    if (!verifySignature(req.body)) return res.status(401).json({ error: { message: 'Invalid Signature' } });
    if (failNextUploads > 0) { failNextUploads -= 1; return res.status(500).json({ error: { message: 'Temporary failure' } }); }
    stored.set(req.body.public_id, req.file.buffer);
    res.json({
      public_id: req.body.public_id,
      secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/${req.body.public_id}.jpg`
    });
  });
  fake.post(`/v1_1/${CLOUD}/image/destroy`, multer().none(), (req, res) => {
    if (!verifySignature(req.body)) return res.status(401).json({ error: { message: 'Invalid Signature' } });
    destroyed.push(req.body.public_id);
    const existed = stored.delete(req.body.public_id);
    res.json({ result: existed ? 'ok' : 'not found' });
  });
  fakeCloudinary = fake.listen(0);
  process.env.CLOUDINARY_URL = `cloudinary://${API_KEY}:${API_SECRET}@${CLOUD}`;
  process.env.CLOUDINARY_API_BASE = `http://localhost:${fakeCloudinary.address().port}/v1_1`;

  base = await h.startServer();
  admin = await h.createUser('admin');
  manager = await h.createUser('sales_manager');
  sales = await h.createUser('salesperson');
});

after(async () => {
  fakeCloudinary.close();
  await h.stopServer();
});

const as = (user, method, p, body) => h.api(method, p, body, user.cookie);

// Uploads files the way the browser's photo form does (multipart).
async function upload(user, carId, files) {
  const form = new FormData();
  for (const f of files) form.append('photos', new Blob([f.bytes], { type: f.type }), f.name);
  const res = await fetch(`${base}/api/cars/${carId}/photos`, { method: 'POST', body: form, headers: { Cookie: user.cookie } });
  return { status: res.status, body: await res.json() };
}

const jpeg = (name = 'front.jpg') => ({ name, type: 'image/jpeg', bytes: Buffer.from(`fake jpeg bytes for ${name}`) });

async function newCar() {
  return (await as(manager, 'POST', '/cars', { make: 'Subaru', model: 'Outback', year: 2021, price: 26000 })).body;
}

test("request signing matches the worked example in Cloudinary's documentation", () => {
  // https://cloudinary.com/documentation/authentication_signatures
  assert.strictEqual(
    photos.sign({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd'),
    'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

test('finds the Cloudinary id inside a photo link', () => {
  assert.strictEqual(
    photos.cloudinaryPublicId('https://res.cloudinary.com/demo-lot/image/upload/v1700000000/dealerships/d1/cars/c1/p1.jpg'),
    'dealerships/d1/cars/c1/p1');
  assert.strictEqual(photos.cloudinaryPublicId('/uploads/cars/abc.jpg'), null);
});

test('uploaded photos are stored in Cloudinary under the dealership and car', async () => {
  const car = await newCar();
  const res = await upload(manager, car.id, [jpeg('front.jpg'), jpeg('side.jpg')]);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.photos.length, 2);

  const dealership = await h.defaultDealershipId();
  for (const url of res.body.photos) {
    assert.match(url, new RegExp(`^https://res\\.cloudinary\\.com/${CLOUD}/image/upload/`));
    const publicId = photos.cloudinaryPublicId(url);
    assert.ok(publicId.startsWith(`dealerships/${dealership}/cars/${car.id}/`));
    assert.ok(stored.has(publicId), 'actually uploaded');
  }
  assert.deepStrictEqual((await as(admin, 'GET', `/cars/${car.id}`)).body.photos, res.body.photos);
});

test('deleting a photo removes it from Cloudinary', async () => {
  const car = await newCar();
  const [first, second] = (await upload(manager, car.id, [jpeg('a.jpg'), jpeg('b.jpg')])).body.photos;

  assert.strictEqual((await as(manager, 'DELETE', `/cars/${car.id}/photos`, { photoPath: first })).status, 204);
  assert.ok(destroyed.includes(photos.cloudinaryPublicId(first)));
  assert.ok(!stored.has(photos.cloudinaryPublicId(first)));
  assert.ok(stored.has(photos.cloudinaryPublicId(second)), 'the other photo is untouched');
  assert.deepStrictEqual((await as(admin, 'GET', `/cars/${car.id}`)).body.photos, [second]);
});

test("a photo that isn't on the car can't be deleted through it", async () => {
  const carA = await newCar();
  const carB = await newCar();
  const [photoOfB] = (await upload(manager, carB.id, [jpeg()])).body.photos;
  const before = destroyed.length;

  await as(manager, 'DELETE', `/cars/${carA.id}/photos`, { photoPath: photoOfB });
  assert.strictEqual(destroyed.length, before, 'nothing deleted from storage');
  assert.deepStrictEqual((await as(admin, 'GET', `/cars/${carB.id}`)).body.photos, [photoOfB]);
});

test("deleting a car removes all of its photos from Cloudinary", async () => {
  const car = await newCar();
  const urls = (await upload(manager, car.id, [jpeg('1.jpg'), jpeg('2.jpg'), jpeg('3.jpg')])).body.photos;
  await as(manager, 'DELETE', `/cars/${car.id}`);
  for (const url of urls) assert.ok(!stored.has(photos.cloudinaryPublicId(url)));
});

test('if any photo in a batch fails, none are kept', async () => {
  const car = await newCar();
  const storedBefore = stored.size;
  failNextUploads = 1;
  const res = await upload(manager, car.id, [jpeg('ok1.jpg'), jpeg('ok2.jpg'), jpeg('ok3.jpg')]);
  assert.strictEqual(res.status, 502);
  assert.match(res.body.error, /Couldn't save the photos/);
  assert.strictEqual(stored.size, storedBefore, 'the ones that did upload were removed again');
  assert.deepStrictEqual((await as(admin, 'GET', `/cars/${car.id}`)).body.photos, []);
});

test('only real photo formats, sizes, and counts are accepted', async () => {
  const car = await newCar();
  const svg = await upload(manager, car.id, [{ name: 'x.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg onload="alert(1)"/>') }]);
  assert.strictEqual(svg.status, 400);
  assert.match(svg.body.error, /JPEG, PNG, WebP, GIF, or HEIC/);

  const huge = await upload(manager, car.id, [{ name: 'big.jpg', type: 'image/jpeg', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) }]);
  assert.strictEqual(huge.status, 400);
  assert.match(huge.body.error, /5 MB or smaller/);

  const tooMany = await upload(manager, car.id, Array.from({ length: 9 }, (_, i) => jpeg(`${i}.jpg`)));
  assert.strictEqual(tooMany.status, 400);
  assert.match(tooMany.body.error, /up to 8 photos/);

  assert.strictEqual((await upload(manager, 'no-such-car', [jpeg()])).status, 404);
  assert.strictEqual((await upload(sales, car.id, [jpeg()])).status, 403, 'salespeople cannot change inventory photos');
});

test('picture texts only allow photos of your own cars, resized for texting', async () => {
  const lead = (await as(sales, 'POST', '/leads', { name: 'Photo Texter', phone: '555-000-1111' })).body;
  const foreign = await as(sales, 'POST', `/leads/${lead.id}/send-text`, { photoPath: 'https://example.com/anything.jpg' });
  assert.strictEqual(foreign.status, 400);
  assert.match(foreign.body.error, /not on any vehicle in your inventory/);

  // A real photo passes the check (and then stops only because Twilio isn't set up in tests).
  const car = await newCar();
  const [own] = (await upload(manager, car.id, [jpeg()])).body.photos;
  const ownRes = await as(sales, 'POST', `/leads/${lead.id}/send-text`, { photoPath: own });
  assert.match(ownRes.body.error, /SMS is not configured/);

  const url = 'https://res.cloudinary.com/demo-lot/image/upload/v1/dealerships/d/cars/c/p.jpg';
  assert.strictEqual(photos.publicPhotoUrl(url, {}),
    'https://res.cloudinary.com/demo-lot/image/upload/c_limit,w_1600,q_auto,f_jpg/v1/dealerships/d/cars/c/p.jpg');
});

test('without Cloudinary set up, photos are saved on the server disk', async () => {
  const saved = process.env.CLOUDINARY_URL;
  delete process.env.CLOUDINARY_URL;
  try {
    const car = await newCar();
    const [url] = (await upload(manager, car.id, [jpeg('local.jpg')])).body.photos;
    assert.match(url, /^\/uploads\/cars\/[0-9a-f-]+\.jpg$/);
    const file = path.join(photos.UPLOAD_DIR, path.basename(url));
    assert.ok(fs.existsSync(file));

    await as(manager, 'DELETE', `/cars/${car.id}/photos`, { photoPath: url });
    assert.ok(!fs.existsSync(file), 'removed from disk too');
  } finally {
    process.env.CLOUDINARY_URL = saved;
  }
});

test('CLOUDINARY_URL is accepted however it was pasted', () => {
  const saved = process.env.CLOUDINARY_URL;
  try {
    for (const pasted of [
      `CLOUDINARY_URL=cloudinary://${API_KEY}:${API_SECRET}@${CLOUD}`,
      `"cloudinary://${API_KEY}:${API_SECRET}@${CLOUD}"`,
      `  cloudinary://${API_KEY}:${API_SECRET}@${CLOUD}  `,
      `cloudinary://${API_KEY}:${API_SECRET}@${CLOUD}/`
    ]) {
      process.env.CLOUDINARY_URL = pasted;
      assert.deepStrictEqual(
        { ...photos.cloudinaryConfig(), apiBase: undefined },
        { apiKey: API_KEY, apiSecret: API_SECRET, cloudName: CLOUD, apiBase: undefined }, pasted);
      assert.strictEqual(photos.cloudinaryProblem(), null);
    }
  } finally {
    process.env.CLOUDINARY_URL = saved;
  }
});

test('a broken CLOUDINARY_URL never takes the app down, and says what is wrong', async () => {
  const saved = process.env.CLOUDINARY_URL;
  try {
    const car = await newCar();
    for (const [pasted, expected] of [
      [`cloudinary://${API_KEY}:**********@${CLOUD}`, /hidden \(\*\*\*\*\*\) or placeholder/],
      ['cloudinary://<your_api_key>:<your_api_secret>@demo', /hidden \(\*\*\*\*\*\) or placeholder/],
      ['my-cloud-name', /not in the expected format/]
    ]) {
      process.env.CLOUDINARY_URL = pasted;
      assert.doesNotThrow(() => photos.usingCloudinary());
      assert.match(photos.cloudinaryProblem(), expected);

      const res = await upload(manager, car.id, [jpeg()]);
      assert.strictEqual(res.status, 503);
      assert.match(res.body.error, /CLOUDINARY_URL setting/);
      assert.strictEqual((await as(admin, 'GET', '/cars')).status, 200, 'the rest of the app keeps working');
    }
    assert.deepStrictEqual((await as(admin, 'GET', `/cars/${car.id}`)).body.photos, [], 'nothing saved to disk instead');
  } finally {
    process.env.CLOUDINARY_URL = saved;
  }
});
