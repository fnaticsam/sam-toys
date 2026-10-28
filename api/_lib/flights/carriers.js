// Reviewed 2026-10-28. Eligibility is about the MARKETING flight number,
// not the airline's display name or membership in an Avios currency programme.
// https://www.britishairways.com/content/the-british-airways-club/about-tier-points/flights
// https://www.britishairways.com/content/the-british-airways-club/avios/collecting-avios/flights
// https://www.oneworld.com/members (S7 remains suspended)
// https://www.oneworld.com/news/oneworld-welcomes-hawaiian-airlines
// Hawaiian is a full member from April 2026, but marketed under AS, not HA:
// https://www2.arccorp.com/articles-trends/agency-communications/archived-tac/2025-tac-messages/ped-101225/
const SOURCES = Object.freeze({
  tierPoints: 'https://www.britishairways.com/content/the-british-airways-club/about-tier-points/flights',
  avios: 'https://www.britishairways.com/content/the-british-airways-club/avios/collecting-avios/flights',
  members: 'https://www.oneworld.com/members',
});
const members = {
  AS: 'Alaska Airlines / Hawaiian Airlines', AA: 'American Airlines',
  BA: 'British Airways', CX: 'Cathay Pacific', FJ: 'Fiji Airways', AY: 'Finnair',
  IB: 'Iberia', JL: 'Japan Airlines', MH: 'Malaysia Airlines', WY: 'Oman Air',
  QF: 'Qantas', QR: 'Qatar Airways', AT: 'Royal Air Maroc', RJ: 'Royal Jordanian',
  UL: 'SriLankan Airlines',
};
const CARRIERS = Object.freeze({
  ...Object.fromEntries(Object.entries(members).map(([code, name]) => [code,
    Object.freeze({ code, name, why: 'oneworld full member; BA publishes Avios and tier-point earning', source: SOURCES.tierPoints })])),
  EI: Object.freeze({ code: 'EI', name: 'Aer Lingus', why: 'BA earning partner with a published tier-point chart', source: SOURCES.tierPoints }),
  EA: Object.freeze({ code: 'EA', name: 'Emerald Airlines', why: 'Explicitly included in BA’s Aer Lingus / Emerald earning chart', source: SOURCES.tierPoints }),
  I2: Object.freeze({ code: 'I2', name: 'Iberia Express', why: 'Explicitly included in BA’s Iberia earning agreement', source: SOURCES.tierPoints }),
  NU: Object.freeze({ code: 'NU', name: 'Japan Transocean Air', why: 'Explicitly included in BA’s Japan Airlines earning agreement', source: SOURCES.tierPoints }),
});
const ELIGIBLE_CODES = Object.freeze(Object.keys(CARRIERS));
const DEFAULT_ORIGINS = Object.freeze(['LHR', 'LGW', 'LCY', 'STN', 'LTN', 'SEN', 'IBZ']);
// VY (Vueling), LM (Loganair) and LL (LEVEL) are NOT direct BA tier-point
// partners. Being able to transfer Avios is insufficient. BA-coded Vueling or
// Loganair flights can qualify under BA's marketing rule. LEVEL operated IB
// flights are explicitly excluded from TP, even though some earn Avios.
// https://www.loganair.co.uk/loyalty/avios/
// HA is retired; YW/Air Nostrum, Fiji Link, Horizon and QantasLink are included
// when marketed using their parent's published code, not automatically by code.
const AFFILIATES = { AS: ['QX', 'OO'], EI: ['EI', 'EA'], EA: ['EI', 'EA'], IB: ['I2', 'YW'],
  I2: ['I2', 'IB', 'YW'], JL: ['NU'], NU: ['NU', 'JL'], FJ: ['FJ'], QF: ['QF'] };

function parseFlightNumber(value) {
  if (typeof value !== 'string') return null;
  const m = /^([A-Z0-9]{2})\s*(\d{1,4})([A-Z]?)$/.exec(value.trim().toUpperCase());
  return m && /[A-Z]/.test(m[1]) ? { code: m[1], number: Number(m[2]), flightNumber: `${m[1]}${m[2]}${m[3]}` } : null;
}
function checkSegment(segment) {
  const parsed = parseFlightNumber(segment.flightNumber);
  if (!parsed || !CARRIERS[parsed.code]) return { ok: false, reason: 'non-earning-or-unknown-flight-number' };
  const { code, number } = parsed;
  if ((code === 'AY' && number >= 8100 && number <= 8700) ||
      (code === 'MH' && ((number >= 3000 && number < 7000) || (number >= 8000 && number < 9000)))) {
    return { ok: false, reason: 'excluded-flight-number-range' };
  }
  const operator = segment.operatingCarrier;
  if (typeof operator === 'string') {
    // LEVEL-on-IB and Firefly-on-MH are excluded by BA even under these codes.
    if ((['IB', 'I2'].includes(code) && /^(LL|LEVEL)$/i.test(operator)) ||
        (code === 'MH' && /^(FY|FIREFLY)$/i.test(operator))) return { ok: false, reason: 'excluded-operator' };
    if (code !== 'BA' && !members[operator] && !(AFFILIATES[code] || []).includes(operator)) {
      return { ok: false, reason: 'non-earning-or-unknown-operator' };
    }
  }
  return { ok: true, ...parsed, operatorVerified: typeof operator === 'string' || code === 'BA' };
}
module.exports = { CARRIERS, ELIGIBLE_CODES, DEFAULT_ORIGINS, SOURCES, parseFlightNumber, checkSegment };
