const { DEFAULT_ORIGINS, ELIGIBLE_CODES } = require('./carriers');
const CABINS = ['basic-economy', 'economy', 'premium', 'business', 'first'];
class InputError extends Error {}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function parseInput(rawUrl, now = Date.now()) {
  const bad = (message) => { throw new InputError(message); };
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) bad('Invalid request URL.');
  let params;
  try { params = new URL(rawUrl, 'https://sam.toys').searchParams; } catch { bad('Invalid request URL.'); }
  const action = params.get('action') || 'search';
  if (!['search', 'anywhere', 'flex'].includes(action)) bad('action must be search, anywhere or flex.');
  const shared = ['action','origin','departureDate','returnDate','earningOnly'];
  const allowed = new Set([...shared, ...(action === 'search' ? ['destination','fareClass','limit','offset','maxStops','includeHiddenCity','airlines','starlinkMin'] :
    action === 'anywhere' ? ['fareClass'] : ['destination','mode','sort'])]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1 || params.get(key) === '') bad('Unknown, duplicate or empty parameter.');
  }
  let origins = params.has('origin') ? [...new Set(params.get('origin').toUpperCase().split(','))] : [...DEFAULT_ORIGINS];
  if (origins.length > 7 || origins.some((o) => !/^[A-Z]{3}$/.test(o))) bad('origin must contain 1–7 comma-separated IATA codes.');
  const destination = params.get('destination')?.toUpperCase();
  if (action !== 'anywhere' && (!/^[A-Z]{3}$/.test(destination || '') || (params.has('origin') && origins.includes(destination)))) bad('destination must be a different IATA code.');
  if (action !== 'anywhere' && !params.has('origin')) origins = origins.filter((origin) => origin !== destination);
  const departureDate = params.get('departureDate'), returnDate = params.get('returnDate') || undefined;
  const today = new Date(now).toISOString().slice(0, 10);
  const latest = new Date(now + 366 * 86400000).toISOString().slice(0, 10);
  if (!validDate(departureDate) || departureDate < today || departureDate > latest) bad('departureDate must be a real YYYY-MM-DD within the next 366 days.');
  if (returnDate && (!validDate(returnDate) || returnDate < departureDate || returnDate > latest)) bad('returnDate must be a real YYYY-MM-DD on or after departureDate, within 366 days.');
  const fareClass = params.get('fareClass') || 'economy';
  if (!CABINS.includes(fareClass)) bad('Invalid fareClass.');
  const integer = (key, fallback, min, max) => {
    if (!params.has(key)) return fallback;
    const text = params.get(key);
    if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) bad(`Invalid ${key}.`);
    return Number(text);
  };
  const limit = integer('limit', 100, 1, 100), offset = integer('offset', 0, 0, 99);
  let starlinkMin;
  if (params.has('starlinkMin')) {
    const text = params.get('starlinkMin');
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) || Number(text) > 1) bad('starlinkMin must be a number between 0 and 1.');
    starlinkMin = Number(text);
  }
  const maxStops = params.get('maxStops') || 'many';
  if (!['none', 'one', 'many'].includes(maxStops)) bad('Invalid maxStops.');
  const hidden = params.get('includeHiddenCity');
  if (hidden !== null && !['true','false'].includes(hidden)) bad('includeHiddenCity must be true or false.');
  const earning = params.get('earningOnly');
  if (earning !== null && !['true','false'].includes(earning)) bad('earningOnly must be true or false.');
  const earningOnly = earning !== 'false';
  const airlines = params.has('airlines') ? [...new Set(params.get('airlines').toUpperCase().split(','))] : earningOnly ? [...ELIGIBLE_CODES] : [];
  if (params.has('airlines') && (!airlines.length || airlines.some((code) => !ELIGIBLE_CODES.includes(code)))) bad('airlines must contain eligible carrier codes.');
  const mode = params.get('mode') || 'depart', sort = params.get('sort') || 'date';
  if (!['depart','return'].includes(mode) || !['date','price'].includes(sort)) bad('Invalid calendar mode or sort.');
  if (action === 'flex' && mode === 'return' && !returnDate) bad('returnDate is required for a return calendar.');
  return { action, origins, destination, departureDate, returnDate, fareClass, limit, offset,
    maxStops, includeHiddenCity: !returnDate && hidden !== 'false', earningOnly, airlines, mode, sort, starlinkMin };
}
function toolInput(query, origin) {
  const q = query;
  if (q.action === 'anywhere') return { name: 'sk_destinations_anywhere', args: {
    from: origin, depart: q.departureDate, ...(q.returnDate ? { return: q.returnDate } : {}), fare_class: q.fareClass, adults: 1 } };
  const dates = { origin, destination: q.destination, departureDate: q.departureDate, ...(q.returnDate ? { returnDate: q.returnDate } : {}) };
  if (q.action === 'flex') return { name: q.mode === 'return' ? 'sk_flex_return_calendar' : 'sk_flex_departure_calendar', args: { ...dates, sort: q.sort, adults: 1 } };
  return { name: 'sk_flights_search', args: { ...dates, fareClass: q.fareClass, adults: 1,
    limit: q.limit, offset: q.offset, sort: 'price', ...(q.airlines.length ? { preferredAirlines: q.airlines } : {}),
    includeHiddenCity: !q.returnDate && q.includeHiddenCity, includeVirtualInterlining: false, includeStandard: true, maxStops: q.maxStops } };
}
function providerPlan(query) {
  // Reserve one eligible search for every origin before adding broad searches.
  // Discovery tools have no airline filter, so their query is already identical
  // for either toggle value; do not spend calls repeating it.
  const broaden = query.action === 'search' && !query.earningOnly;
  const calls = query.origins.map((origin) => ({ origin,
    ...(broaden ? { scope: 'eligible' } : {}),
    ...toolInput(broaden ? { ...query, airlines: query.airlines.length ? query.airlines : ELIGIBLE_CODES } : query, origin),
  }));
  if (broaden) calls.push(...query.origins.map((origin) => ({ origin, scope: 'all',
    ...toolInput({ ...query, airlines: [] }, origin),
  })));
  // Preserve the original maximum of seven provider calls per HTTP request.
  return { calls: calls.slice(0, 7), skipped: calls.slice(7).map(({ origin, scope }) =>
    ({ origin, scope, code: 'provider-call-cap' })) };
}
module.exports = { InputError, validDate, parseInput, toolInput, providerPlan };
