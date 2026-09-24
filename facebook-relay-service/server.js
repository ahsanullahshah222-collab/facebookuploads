const express = require('express');
const multer = require('multer');

/**
 * Facebook Relay Service — deployed on Railway, standalone from the
 * main VPS-hosted app. Forwards Graph API requests to Facebook so the
 * actual request comes from Railway's own trusted IP, never the VPS's.
 * Two modes:
 *   POST /graph-post — small JSON forward, for text posts, photo/video
 *     posts by URL (file_url / url params) — the video/photo bytes
 *     themselves are never sent here, only a link Facebook fetches
 *     directly from wherever it's hosted (the VPS, never Railway).
 *   POST /graph-multipart — byte-upload forward, for anything that
 *     needs to hand Facebook an actual file directly (a small direct
 *     photo upload, a video thumbnail) rather than a URL.
 */

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB cap — generous for images/thumbnails; videos should never reach this endpoint at all, they're URL-only via /graph-post

const GRAPH_VERSION = 'v21.0'; // matches the main app's own facebook.js exactly, for consistent behavior
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET;
// Optional but recommended defense-in-depth: restricts which hosts a
// file_url/url param is allowed to point at, so a leaked secret can't
// be used to turn this into an open relay fetching arbitrary URLs.
// Comma-separated, e.g. "fbautopilot.online,drive.google.com".
const ALLOWED_MEDIA_HOSTS = (process.env.ALLOWED_MEDIA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);

if (!SHARED_SECRET) {
  console.error('[relay] FATAL: RELAY_SHARED_SECRET is not set. Refusing to start — this service would otherwise accept requests from anyone who finds its URL.');
  process.exit(1);
}

function checkMediaHost(url) {
  if (ALLOWED_MEDIA_HOSTS.length === 0) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    return 'not a valid URL';
  }
  if (!ALLOWED_MEDIA_HOSTS.includes(host)) return `host "${host}" is not in the allowed list`;
  return null;
}

async function forwardToFacebook(path, paramsOrFormData, isMultipart) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}`;
  const fbResponse = isMultipart
    ? await fetch(url, { method: 'POST', body: paramsOrFormData })
    : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: paramsOrFormData });
  const result = await fbResponse.json();
  if (!fbResponse.ok || result.error) {
    const message = result.error ? result.error.message : `Facebook returned HTTP ${fbResponse.status}`;
    const err = new Error(message);
    err.status = 400;
    throw err;
  }
  return result;
}

app.post('/graph-post', express.json(), async (req, res) => {
  const { secret, path, params } = req.body || {};
  if (secret !== SHARED_SECRET) {
    console.log('[relay] /graph-post rejected — invalid secret.');
    return res.status(403).json({ error: 'Invalid secret' });
  }
  if (!path || !params) return res.status(400).json({ error: 'path and params are required' });

  const mediaUrl = params.file_url || params.url;
  if (mediaUrl) {
    const hostError = checkMediaHost(mediaUrl);
    if (hostError) {
      console.log(`[relay] /graph-post rejected — ${hostError}`);
      return res.status(403).json({ error: `Media URL rejected: ${hostError}` });
    }
  }

  console.log(`[relay] POST ${path}${mediaUrl ? ` (media: ${mediaUrl})` : ''}`);
  try {
    const body = new URLSearchParams(params).toString();
    const result = await forwardToFacebook(path, body, false);
    console.log('[relay] Succeeded:', JSON.stringify(result));
    return res.json({ result });
  } catch (e) {
    console.log('[relay] Failed:', e.message);
    return res.status(e.status || 502).json({ error: e.message });
  }
});

app.post('/graph-multipart', upload.single('file'), async (req, res) => {
  const { secret, path, fields: fieldsJson, fileFieldName } = req.body || {};
  if (secret !== SHARED_SECRET) {
    console.log('[relay] /graph-multipart rejected — invalid secret.');
    return res.status(403).json({ error: 'Invalid secret' });
  }
  if (!path || !fieldsJson) return res.status(400).json({ error: 'path and fields are required' });

  let fields;
  try {
    fields = JSON.parse(fieldsJson);
  } catch (e) {
    return res.status(400).json({ error: 'fields must be valid JSON' });
  }

  console.log(`[relay] POST ${path} (multipart, ${req.file ? req.file.originalname + ', ' + (req.file.size / 1024).toFixed(0) + 'KB' : 'no file'})`);
  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.append(key, value);
    if (req.file) {
      formData.append(fileFieldName || 'source', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    }
    const result = await forwardToFacebook(path, formData, true);
    console.log('[relay] Succeeded:', JSON.stringify(result));
    return res.json({ result });
  } catch (e) {
    console.log('[relay] Failed:', e.message);
    return res.status(e.status || 502).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[relay] Facebook relay service listening on port ${PORT}`);
  console.log(`[relay] Allowed media hosts: ${ALLOWED_MEDIA_HOSTS.length > 0 ? ALLOWED_MEDIA_HOSTS.join(', ') : '(none configured — accepting any host, not recommended)'}`);
});
