// Independent Londonplan tokens; old constant lp_session cookies are not accepted.
const crypto = require('crypto');
const SESSION_TTL_MS = 30 * 86400000;
const CLOCK_SKEW_MS = 60000;
const COOKIE = 'lp_session_v2';
const COOKIE_ATTRS = 'Path=/londonplan; HttpOnly; Secure; SameSite=Lax';
const LEGACY_CLEAR = 'lp_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
function matches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(candidate).digest(), crypto.createHash('sha256').update(expected).digest());
}
function sign(secret, issuedAt) {
  return crypto.createHmac('sha256', secret).update(`londonplan-session-v2|${issuedAt}`).digest('hex');
}
function issueToken(secret) {
  const time = Date.now(); return `${time}.${sign(secret, time)}`;
}
function tokenIsValid(secret, token) {
  if (typeof token !== 'string') return false;
  const found = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(token);
  if (!found || found[0] !== token) return false;
  const time = Number(found[1]);
  if (!Number.isSafeInteger(time) || String(time) !== found[1] || time > Date.now() + CLOCK_SKEW_MS || Date.now() - time > SESSION_TTL_MS) return false;
  return matches(found[2], sign(secret, time));
}
function cookieValue(header) {
  if (typeof header !== 'string') return null;
  const prefix = `${COOKIE}=`;
  const value = header.split(';').map(s => s.trim()).find(s => s.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}
function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
module.exports = { SESSION_TTL_MS, COOKIE, COOKIE_ATTRS, LEGACY_CLEAR, matches, sign, issueToken, tokenIsValid, cookieValue, privateHeaders };
