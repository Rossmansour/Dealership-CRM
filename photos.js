// photos.js
// Where car photos are stored.
//
// With CLOUDINARY_URL set (production), photos go to Cloudinary, which
// keeps them permanently -- unlike the server's own disk, which hosts
// like Render wipe on every redeploy -- and resizes them on the fly for
// thumbnails. Without it (e.g. running locally), photos are saved to
// public/uploads/cars on disk as before.
//
// CLOUDINARY_URL is the "API environment variable" shown on Cloudinary's
// dashboard: cloudinary://<api key>:<api secret>@<cloud name>

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'cars');

// Formats phones and cameras actually produce. SVG is deliberately not
// allowed: it can contain scripts.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif' };

// Reads CLOUDINARY_URL and returns { config } when it's usable,
// { problem } when it's set but can't be used, or {} when it isn't set.
// Forgiving about how it was pasted (a leading "CLOUDINARY_URL=", quotes,
// spaces), and never throws -- a bad photo setting must not stop the
// whole app from starting. Read on each use so tests can point it elsewhere.
function cloudinarySetup() {
  const raw = String(process.env.CLOUDINARY_URL || '')
    .trim()
    .replace(/^CLOUDINARY_URL\s*=\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!raw) return {};

  const match = raw.match(/^cloudinary:\/\/([^:\s]+):([^@\s]+)@([^\s/]+)\/?$/);
  if (!match) {
    return { problem: 'CLOUDINARY_URL is not in the expected format. It should look like cloudinary://API_KEY:API_SECRET@CLOUD_NAME -- copy the "API environment variable" from the Cloudinary dashboard.' };
  }
  const [, apiKey, apiSecret, cloudName] = match;
  if (/^\*+$/.test(apiSecret) || /[<>]/.test(apiKey + apiSecret + cloudName)) {
    return { problem: 'CLOUDINARY_URL still contains a hidden (*****) or placeholder API secret. On the Cloudinary dashboard, reveal the secret, then copy the value again.' };
  }
  return {
    config: {
      apiKey,
      apiSecret,
      cloudName,
      apiBase: process.env.CLOUDINARY_API_BASE || 'https://api.cloudinary.com/v1_1'
    }
  };
}

function cloudinaryConfig() {
  return cloudinarySetup().config || null;
}

// A message explaining why photo storage can't be used, or null if it's fine.
function cloudinaryProblem() {
  return cloudinarySetup().problem || null;
}

function usingCloudinary() {
  return !!cloudinaryConfig();
}

// Cloudinary's request signature: the parameters sorted by name, joined
// as a query string, with the API secret appended, then SHA-1.
function sign(params, apiSecret) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

async function cloudinaryRequest(config, action, params, file) {
  const signed = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  for (const [k, v] of Object.entries(signed)) form.append(k, String(v));
  form.append('api_key', config.apiKey);
  form.append('signature', sign(signed, config.apiSecret));
  if (file) form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'photo');

  const res = await fetch(`${config.apiBase}/${config.cloudName}/image/${action}`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Photo storage error: ${(body.error && body.error.message) || res.status}`);
  return body;
}

// Saves one uploaded photo (a multer memory-storage file) and returns the
// URL to keep on the car record.
async function savePhoto(file, { dealershipId, carId }) {
  const config = cloudinaryConfig();
  const id = crypto.randomUUID();
  if (config) {
    const result = await cloudinaryRequest(config, 'upload', {
      public_id: `dealerships/${dealershipId}/cars/${carId}/${id}`
    }, file);
    return result.secure_url;
  }
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${id}${EXTENSIONS[file.mimetype] || '.jpg'}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
  return `/uploads/cars/${filename}`;
}

// The Cloudinary public_id inside a delivery URL, e.g.
// https://res.cloudinary.com/demo/image/upload/v1712/dealerships/x/cars/y/z.jpg
//   -> dealerships/x/cars/y/z
function cloudinaryPublicId(url) {
  const match = String(url).match(/\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(dealerships\/.+?)(?:\.[a-z0-9]+)?$/i);
  return match ? match[1] : null;
}

// Removes a photo from storage. Best effort: a photo that's already gone
// isn't an error, and failures are logged rather than failing the request
// (the car record no longer points at it either way).
async function deletePhoto(url) {
  try {
    const publicId = cloudinaryPublicId(url);
    if (publicId) {
      const config = cloudinaryConfig();
      if (config) await cloudinaryRequest(config, 'destroy', { public_id: publicId });
      return;
    }
    if (String(url).startsWith('/uploads/cars/')) {
      await fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(url))).catch(() => {});
    }
  } catch (err) {
    console.error(`Could not delete photo ${url}:`, err.message);
  }
}

// A publicly reachable link to send as a picture text (MMS). Cloudinary
// photos are resized so they stay well under carriers' size limits.
function publicPhotoUrl(url, req) {
  if (cloudinaryPublicId(url)) {
    return String(url).replace('/image/upload/', '/image/upload/c_limit,w_1600,q_auto,f_jpg/');
  }
  return `${req.protocol}://${req.get('host')}${url}`;
}

module.exports = {
  ALLOWED_TYPES,
  UPLOAD_DIR,
  usingCloudinary,
  cloudinaryConfig,
  cloudinaryProblem,
  savePhoto,
  deletePhoto,
  publicPhotoUrl,
  cloudinaryPublicId,
  sign
};
