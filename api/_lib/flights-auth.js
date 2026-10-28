const { configuration, FlightsAuthConfigError, SamSessionRequiredError, requireSamSession,
  issueSession, clearSession, transactionCookies, clearTransactions } = require('./flights-session');

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}
function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.end();
}
function requestUrl(req, config) {
  // Do not use forwarded host headers or client-supplied return destinations.
  const url = new URL(req.url, config.origin);
  const host = req.headers?.host;
  const protocol = req.headers?.['x-forwarded-proto'] ?? (req.socket?.encrypted ? 'https' : 'http');
  if (typeof host !== 'string' || /[\s\\/@?#]/.test(host) ||
      !['https', 'http'].includes(protocol) ||
      new URL(`${protocol}://${host}`).origin !== config.origin || url.origin !== config.origin) throw new Error();
  return url;
}

function createAuthHandlers({ env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
  // Stable fetch identity preserves the client's per-issuer JWKS cache. Both
  // token and JWKS requests have an abort deadline and refuse redirects.
  const boundedFetch = async (url, options = {}) => {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
    return fetcher(url, { ...options, signal, redirect: 'error', cache: 'no-store' });
  };
  function route(method, action) {
    return async (req, res) => {
      privateHeaders(res);
      if (req.method !== method) {
        res.setHeader('Allow', method);
        return json(res, 405, { error: 'Method not allowed.' });
      }
      try { return await action(req, res, configuration(env)); }
      catch (error) {
        return json(res, error instanceof FlightsAuthConfigError ? 503 : 400,
          { error: error instanceof FlightsAuthConfigError ? error.message : 'Sam ID sign-in could not be verified. Please try again.' });
      }
    };
  }
  const login = route('GET', async (req, res, config) => {
    requestUrl(req, config);
    const { createSamIdClient } = await import('./samid/index.mjs');
    const client = createSamIdClient({ issuer: config.issuer, cookies: transactionCookies(req, res), fetch: boundedFetch });
    return redirect(res, await client.startSignIn({ clientId: config.clientId, redirectUri: config.redirectUri }));
  });
  const callback = route('GET', async (req, res, config) => {
    // Also clear on URL/import failures before the vendored client's finally.
    let client;
    try {
      const url = requestUrl(req, config);
      const { createSamIdClient } = await import('./samid/index.mjs');
      client = createSamIdClient({ issuer: config.issuer, cookies: transactionCookies(req, res), fetch: boundedFetch });
      const claims = await client.finishSignIn(new Request(url), {
        clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
      });
      issueSession(res, claims, config, now());
      return redirect(res, '/flights');
    } finally { if (!client) clearTransactions(res); }
  });
  const logout = route('POST', (req, res, config) => {
    requestUrl(req, config);
    const origin = req.headers?.origin, site = req.headers?.['sec-fetch-site'];
    if (origin !== config.origin || (site !== undefined && site !== 'same-origin')) {
      return json(res, 403, { error: 'Same-origin POST required.' });
    }
    clearSession(res);
    clearTransactions(res);
    return redirect(res, '/flights');
  });
  const me = route('GET', (req, res) => {
    try {
      const session = requireSamSession(req, { env, now });
      return json(res, 200, { signedIn: true, name: session.name });
    } catch (error) {
      if (!(error instanceof SamSessionRequiredError)) throw error;
      return json(res, 200, { signedIn: false });
    }
  });
  return { login, callback, logout, me };
}

module.exports = { createAuthHandlers };
