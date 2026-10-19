const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const session = require('./_lib/playa-session');
const { createStore, ID } = require('./_lib/playa-store');

// Renders only the static login form and its optional failure message.
function loginPage(failed) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>',
    'Playa · Private gallery',
    '</title>',
    '<style>',
    'body{',
    'background:#14110e;',
    'color:#ece4d6;',
    'font:18px system-ui;',
    'margin:0;',
    'min-height:100vh;',
    'display:grid;',
    'place-items:center}',
    'main{',
    'width:min(340px,85vw)}',
    'input,button{',
    'box-sizing:border-box;',
    'width:100%;',
    'min-height:48px;',
    'margin:8px 0;',
    'padding:12px;',
    'border:1px solid #a39886;',
    'border-radius:6px;',
    'font:inherit}',
    'button{',
    'background:#ff6a2b;',
    'color:#14110e}',
    'a{',
    'color:#ff6a2b}',
    '</style>',
    '<main>',
    '<h1>',
    'PLAYA',
    '</h1>',
    '<p>',
    'Private gallery. Enter the password to continue.',
    '</p>',
    '<form method="post" action="/playa">',
    '<label for="password">',
    'Password',
    '</label>',
    '<input id="password" type="password" name="password" autocomplete="current-password" autofocus required>',
    '<button type="submit">',
    'Enter',
    '</button>',
    '</form>',
    failed ? '<p role="alert">Wrong password — try again.</p>' : '',
    '</main></html>',
  ].join('');
}

// Stops collecting request chunks as soon as the byte limit is crossed.
function body(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;
    const fail = (status) => {
      if (!finished) {
        finished = true;
        reject(Object.assign(new Error('request'), { status }));
      }
    };
    if (Number(req.headers['content-length']) > limit) return fail(413);
    req.on('data', (chunk) => {
      if (finished) return;
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) return fail(413);
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (!finished) {
        finished = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', () => fail(400));
    req.on('aborted', () => fail(400));
  });
}

// req.url preserves the incoming path in the Node runtime. Ignore original-path
// headers: even a forged routing hint must never select a login exception.
function originalPath(req) {
  const raw = (req.url || '').split('?')[0];
  if (
    !raw.startsWith('/') ||
    /[%\\\u0000-\u0020]/.test(raw) ||
    raw.includes('//') ||
    raw.split('/').some((p) => p === '.' || p === '..')
  )
    return null;
  return raw;
}
// Requires the existing same-origin evidence for cookie-authenticated writes.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (!origin) return site === 'same-origin';
  // Production is HTTPS; use Host, never client-controlled forwarded-host.
  try {
    return origin === `https://${req.headers.host}` && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}
// Applies the existing bounded form parsing and fixed failed-login delay.
async function handleLogin(req, secret, send, redirect, cookie) {
  const raw = await body(req, 4096);
  const form = /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || '');
  const password = form ? new URLSearchParams(raw).get('password') : null;
  if (!session.matches(password === null ? null : password.trim(), secret)) {
    // Constant delay; process-local throttles are defence in depth only.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return send(401, loginPage(true), 'text/html; charset=utf-8');
  }
  return redirect(cookie(secret));
}

// Uses one fresh nonce for both the shell script and its CSP.
function serveShell(req, res, send) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const html = fs.readFileSync(path.join(__dirname, '_lib', 'playa.html'), 'utf8').replaceAll('__PLAYA_NONCE__', nonce);
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; img-src 'self' https://*.blob.vercel-storage.com; style-src 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  return send(200, html, 'text/html; charset=utf-8');
}

// Preserves conditional catalog reads and empty HEAD responses.
async function serveCatalog(req, res, send, store) {
  const result = await store.catalog(req.headers['if-none-match']);
  if (!result) return send(503, { error: 'catalog-not-published' });
  res.setHeader('ETag', result.blob.etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (result.statusCode === 304) return send(304, '');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;
  if (req.method === 'HEAD') {
    await result.stream.cancel();
    return res.end();
  }
  return await pipeline(Readable.fromWeb(result.stream), res);
}

// Keeps the existing origin, size and ID checks before shortlist writes.
async function serveShortlist(req, send, store) {
  if (req.method !== 'PUT') return send(200, await store.shortlist());
  if (!sameOrigin(req)) return send(403, { error: 'cross-site' });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(415, { error: 'content-type' });
  const raw = await body(req, 256 * 1024);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return send(400, { error: 'invalid-json' });
  }
  if (
    !value ||
    !Array.isArray(value.ids) ||
    value.ids.length > 5000 ||
    value.ids.some((id) => typeof id !== 'string' || id.length !== 64 || !ID.test(id))
  )
    return send(400, { error: 'invalid-ids' });
  return send(200, await store.saveShortlist([...new Set(value.ids)], req.headers['if-match']));
}

async function serveExport(req, send, store) {
  if (!sameOrigin(req)) return send(403, { error: 'cross-site' });
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(415, { error: 'content-type' });
  const raw = await body(req, 256 * 1024);
  let value;
  try { value = JSON.parse(raw); }
  catch { return send(400, { error: 'invalid-json' }); }
  if (!value || typeof value !== 'object' || Object.keys(value).some((key) => !['kind', 'size', 'ids'].includes(key)))
    return send(400, { error: 'invalid-request' });
  return send(202, await store.requestExport(value));
}

// Redirects only the validated media match with its private cache policy.
async function serveMedia(res, store, media) {
  const url = await store.media(media[1], media[2]);
  res.setHeader('Location', url);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.statusCode = 302;
  return res.end();
}

// Runs admission once before dispatching any private data branch.
function createHandler(store = createStore()) {
  return async function handleRequest(req, res) {
    session.privateHeaders(res);
    res.setHeader('Cache-Control', 'private, no-store');
    // Suppresses bodies for HEAD and 304 while retaining response headers.
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      return res.end(req.method === 'HEAD' || status === 304 ? '' : typeof value === 'string' ? value : JSON.stringify(value));
    };
    // Clears or issues the scoped cookie and redirects only to the gallery root.
    const redirect = (cookie) => {
      res.setHeader('Set-Cookie', cookie);
      res.setHeader('Location', '/playa');
      res.statusCode = 303;
      res.end();
    };
    // Issues the existing stateless session cookie with the same scope and lifetime.
    const cookie = (secret) =>
      `${session.COOKIE}=${session.issueToken(secret)}; Max-Age=${session.SESSION_TTL_MS / 1000}; ${session.COOKIE_ATTRS}`;
    try {
      const secret = process.env.PLAYA_PASSWORD;
      if (!secret) return send(503, { error: 'password-not-configured' });
      // One admission check, before routing, reading a body, or any store call.
      const admission = session.authorize(req, secret);
      const route = originalPath(req);
      const root = ['/playa', '/playa/', '/api/playa', '/api/playa/'].includes(route);
      if (root && req.method === 'POST') {
        return await handleLogin(req, secret, send, redirect, cookie);
      }
      if (root && req.method === 'GET' && session.wantsLogout(req.url)) {
        return redirect(`${session.COOKIE}=; Max-Age=0; ${session.COOKIE_ATTRS}`);
      }
      if (!admission.ok) {
        if (route && /^\/playa(?:\/|$)/.test(route) && !/^\/playa\/(api|m)(\/|$)/.test(route))
          return send(401, loginPage(false), 'text/html; charset=utf-8');
        return send(401, { error: 'unauthorized' });
      }
      if (admission.trusted) res.setHeader('Set-Cookie', cookie(secret));
      if (!route) return send(404, { error: 'not-found' });
      const shortlist = route === '/playa/api/shortlist';
      const exporting = route === '/playa/api/export';
      const allowed = exporting ? ['POST'] : shortlist ? ['GET', 'HEAD', 'PUT'] : root ? ['GET', 'HEAD', 'POST'] : ['GET', 'HEAD'];
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        return send(405, 'Method not allowed.', 'text/plain; charset=utf-8');
      }
      if (root) {
        return serveShell(req, res, send);
      }
      if (route === '/playa/api/catalog') {
        return await serveCatalog(req, res, send, store);
      }
      if (shortlist) {
        return await serveShortlist(req, send, store);
      }
      if (exporting) return await serveExport(req, send, store);
      const exportStatus = /^\/playa\/api\/export\/([0-9a-f]{32})$/.exec(route);
      if (exportStatus) return send(200, await store.exportStatus(exportStatus[1]));
      const download = /^\/playa\/m\/dl\/2048\/([0-9a-f]{64})\.jpg$/.exec(route);
      if (download) {
        res.setHeader('Location', await store.download(download[1]));
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.statusCode = 302;
        return res.end();
      }
      const media = /^\/playa\/m\/(thumb|preview)\/([0-9a-f]{64})\.webp$/.exec(route);
      if (media) {
        return await serveMedia(res, store, media);
      }
      return send(404, { error: 'not-found' });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if ([400, 404, 429].includes(error.status) && ['invalid-request', 'not-published', 'not-found', 'export-busy'].includes(error.code))
        return send(error.status, { error: error.code });
      const status = [400, 412, 413].includes(error.status) ? error.status : 503;
      return send(status, {
        error: status === 412 ? 'shortlist-conflict' : status === 503 ? 'gallery-not-published' : 'invalid-request',
      });
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.originalPath = originalPath;
