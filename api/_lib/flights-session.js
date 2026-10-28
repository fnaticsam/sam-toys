const { createHmac, timingSafeEqual } = require('node:crypto');

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE = '__Secure-flights-session';
const SESSION_PATHS = ['/flights', '/api/flights-account'];
const TRANSACTION_COOKIES = ['samid-state', 'samid-nonce', 'samid-verifier'];
const CALLBACK_PATH = '/flights/callback';

class FlightsAuthConfigError extends Error {
  constructor() { super('Flights sign-in is unavailable.'); this.statusCode = 503; }
}
class SamSessionRequiredError extends Error {
  constructor() { super('Sign in with Sam ID.'); this.statusCode = 401; }
}

function configuration(env = process.env) {
  const names = ['SAM_ID_ISSUER', 'SAM_ID_CLIENT_ID', 'SAM_ID_CLIENT_SECRET',
    'FLIGHTS_SESSION_SECRET', 'FLIGHTS_REDIRECT_URI'];
  if (names.some((name) => typeof env[name] !== 'string' || !env[name].trim()) ||
      Buffer.byteLength(env.FLIGHTS_SESSION_SECRET) < 32) throw new FlightsAuthConfigError();
  try {
    const issuer = new URL(env.SAM_ID_ISSUER), redirect = new URL(env.FLIGHTS_REDIRECT_URI);
    const permitted = (url) => url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
       env.NODE_ENV !== 'production' && !env.VERCEL);
    if (![issuer, redirect].every((url) => permitted(url) && !url.username && !url.password && !url.hash && !url.search) ||
        issuer.origin !== env.SAM_ID_ISSUER || redirect.pathname !== CALLBACK_PATH ||
        redirect.href !== env.FLIGHTS_REDIRECT_URI) throw new Error();
    return { issuer: issuer.origin, clientId: env.SAM_ID_CLIENT_ID,
      clientSecret: env.SAM_ID_CLIENT_SECRET, sessionSecret: env.FLIGHTS_SESSION_SECRET,
      redirectUri: redirect.href, origin: redirect.origin };
  } catch { throw new FlightsAuthConfigError(); }
}

// Reject duplicate cookies, including ambiguous names with different Path scopes.
function cookieValue(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}
function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
}
function setCookie(res, name, value, { path, maxAge }) {
  appendCookie(res, `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax${maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}`);
}
function transactionCookies(req, res) {
  return {
    get(name) { return cookieValue(req, name); },
    set(name, value, options) { setCookie(res, name, value, options); },
  };
}
function clearTransactions(res) {
  for (const name of TRANSACTION_COOKIES) setCookie(res, name, '', { path: CALLBACK_PATH, maxAge: 0 });
}
function mac(config, body) {
  return createHmac('sha256', config.sessionSecret).update(`flights-session-v1.${body}`).digest('base64url');
}
function issueSession(res, claims, config, now = Date.now()) {
  // Only the single-user provider's verified subject can create this session.
  if (claims.sub !== 'sam' || claims.iss !== config.issuer) throw new SamSessionRequiredError();
  const iat = Math.floor(now / 1000);
  const body = Buffer.from(JSON.stringify({ v: 1, sub: 'sam', name: 'Sam',
    iss: config.issuer, aud: config.clientId, iat, exp: iat + SESSION_TTL_SECONDS })).toString('base64url');
  const value = `v1.${body}.${mac(config, body)}`;
  for (const path of SESSION_PATHS) setCookie(res, SESSION_COOKIE, value, { path, maxAge: SESSION_TTL_SECONDS });
}
function clearSession(res) {
  for (const path of SESSION_PATHS) setCookie(res, SESSION_COOKIE, '', { path, maxAge: 0 });
}
function requireSamSession(req, { env = process.env, now = Date.now } = {}) {
  // Configuration is checked even for an absent/invalid session: no auth bypass
  // when an operator has only partially configured a deployment.
  const config = configuration(env), value = cookieValue(req, SESSION_COOKIE);
  if (typeof value !== 'string' || value.length > 2048) throw new SamSessionRequiredError();
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) throw new SamSessionRequiredError();
  const [, body, signature] = match;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(mac(config, body)))) throw new SamSessionRequiredError();
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const time = Math.floor(now() / 1000);
    if (session.v !== 1 || session.sub !== 'sam' || session.name !== 'Sam' ||
        session.iss !== config.issuer || session.aud !== config.clientId ||
        !Number.isSafeInteger(session.iat) || !Number.isSafeInteger(session.exp) ||
        session.iat < 0 || session.iat > time + 30 || session.exp <= time ||
        session.exp - session.iat !== SESSION_TTL_SECONDS) throw new Error();
    return Object.freeze({ sub: 'sam', name: 'Sam' });
  } catch { throw new SamSessionRequiredError(); }
}

module.exports = { configuration, FlightsAuthConfigError, SamSessionRequiredError,
  requireSamSession, issueSession, clearSession, transactionCookies, clearTransactions,
  SESSION_COOKIE, SESSION_PATHS, SESSION_TTL_SECONDS, CALLBACK_PATH };
