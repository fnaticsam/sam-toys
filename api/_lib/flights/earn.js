const airports = require('./airports.json');
const { SOURCES, parseFlightNumber } = require('./carriers');

// Planning constants, reviewed 2026-10-28, NOT live exchange quotes. BA uses
// its purchase-date IATA exchange rate; these intentionally remain explicit.
const FX = Object.freeze({ usdToGbp: 0.77, gbpToEur: 1.17, asOf: '2026-10-28', kind: 'planning-assumption' });
// Skiplagged quotes tax-inclusive totals, not eligible fare + carrier charges.
// 70% is a modelling assumption, NOT a published BA rate or guaranteed floor.
const ELIGIBLE_SPEND_FRACTION = 0.70;
const REVENUE_CODES = new Set(['BA', 'AA', 'IB', 'I2']);
const RULES_DATE = '2026-10-28';
const BONUS_SOURCE = 'https://www.britishairways.com/content/the-british-airways-club/about-the-club/terms-and-conditions';
const GOLD_SOURCE = 'https://www.britishairways.com/content/the-british-airways-club/about-tier-points';
// Current rules are percentages of flown miles, NOT the old pre-April-2025
// short/long-haul TP bands. Each row is [cabin, booking classes, TP %, Avios %].
// Transcribed from the BA TP and Avios pages linked in SOURCES (2026-10-28).
// Unknown booking class uses the lowest published eligible rate in its cabin;
// an unlisted *known* class earns zero. Unsupported cabins remain unestimated.
const ROWS = {
  EI: [['economy','AGOZ',4,25],['economy','QNF SVLMK'.replace(/ /g,''),7,50],['economy','YBH',15,100],['business','RI',25,150],['business','D',50,150],['business','JC',50,250]],
  AS: [['economy','QOGX',2,25],['economy','KMLVSN',3.5,50],['economy','YBH',7.5,100],['business','I',12.5,125],['business','JCD',25,125]],
  CX: [['economy','KLMNQSV',2,25],['economy','YBH',7.5,100],['premium','RE',6,100],['premium','W',12.5,110],['business','IP',12.5,125],['business','JCD',25,125],['first','A',20,150],['first','F',30,150]],
  FJ: [['economy','GNTV',2,25],['economy','KLMSOQW',3.5,50],['economy','YBH',7.5,100],['business','IZ',12.5,125],['business','JCD',25,125]],
  AY: [['economy','QOAGZ',4,25],['economy','KLMVSN',7,50],['economy','YBH',15,100],['premium','ETP',12,100],['premium','W',25,150],['business','RI',25,150],['business','JCD',50,250]],
  JL: [['economy','NQOGZ',4,25],['economy','KMLVS',7,50],['economy','H',15,70],['economy','YB',15,100],['premium','P',12,50],['premium','E',12,70],['premium','WR',25,100],['business','X',25,70],['business','I',25,125],['business','JCD',50,125],['first','A',40,150],['first','F',60,150]],
  MH: [['economy','LVSN',2,25],['economy','KM',3.5,50],['economy','YBH',7.5,100],['business','Z',12.5,100],['business','JCD',25,125],['first','A',20,150],['first','F',30,150]],
  WY: [['economy','E',2,10],['economy','NQORTG',2,25],['economy','MLVS',3.5,50],['economy','YBHK',7.5,100],['business','IP',12.5,125],['business','JCD',12.5,150],['business','FA',25,200]],
  QF: [['economy','MKLNGQSVO',2,25],['economy','YBH',7.5,100],['premium','TR',6,100],['premium','W',12.5,100],['business','I',12.5,125],['business','JCD',25,125],['first','A',20,150],['first','F',30,150]],
  QR: [['economy','TOWG',4,25],['economy','KMLVSNQ',7,50],['economy','YBH',15,100],['business','P',25,75],['business','RI',25,125],['business','JCD',50,125],['first','A',40,150],['first','F',60,150]],
  AT: [['economy','WPG',2,25],['economy','KMLVSNQOTR',3.5,50],['economy','YBH',7.5,100],['business','I',12.5,125],['business','JCD',25,125]],
  RJ: [['economy','HKLMNOQVWS',2,25],['economy','YB',7.5,100],['business','IZ',12.5,125],['business','JCD',25,125]],
  UL: [['economy','RSNQO',2,25],['economy','WMELV',3.5,50],['economy','YBPHK',7.5,100],['business','I',12.5,100],['business','JCD',25,125]],
};
const JL_DOMESTIC = [['economy','A',7,75],['economy','Y',15,100],['business','I',25,85],['business','J',50,110],['first','E',40,125],['first','F',60,150]];
const FJ_DOMESTIC = [['economy','HLQY',2,25]];

function distanceMiles(from, to) {
  const a = airports[from], b = airports[to];
  if (!a || !b) return null;
  const r = Math.PI / 180, p = Math.sin((b[0] - a[0]) * r / 2) ** 2 +
    Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, p)));
}
function collectionYear(date) {
  const year = Number(date.slice(0, 4)) - (date.slice(5, 10) < '04-01' ? 1 : 0);
  return `${year}-${year + 1}`;
}
function goldThreshold(date) { return date >= '2027-04-01' ? 21000 : 20000; }
function rates(code, cabin, bookingClass, from, to) {
  if (code === 'EA') code = 'EI';
  if (code === 'NU') code = 'JL';
  if (code === 'AS' && cabin === 'first') cabin = 'business';
  if (cabin === 'basic-economy') cabin = 'economy';
  let rows = ROWS[code];
  const domestic = airports[from]?.[2] && airports[from][2] === airports[to]?.[2];
  if (domestic && airports[from][2] === 'JP' && code === 'JL') rows = JL_DOMESTIC;
  if (domestic && airports[from][2] === 'FJ' && code === 'FJ') rows = FJ_DOMESTIC;
  rows = rows?.filter((r) => r[0] === cabin);
  if (!rows?.length) return null;
  if (bookingClass) {
    const row = rows.find((r) => r[1].includes(bookingClass));
    return row ? { tp: row[2] / 100, avios: row[3] / 100, domestic } : { tp: 0, avios: 0, domestic };
  }
  return { tp: Math.min(...rows.map((r) => r[2])) / 100,
    avios: Math.min(...rows.map((r) => r[3])) / 100, domestic };
}
// At missing haul/fare-family detail, take the smallest published extra for
// the cabin across both hauls. Economy may be Basic, so include NO extra.
// No speculative 2025 promotional/registration bonuses or add-ons are counted.
function extraTierPoints(cabin, date) {
  if (date < '2026-04-01') return 0;
  // Short-haul First maps to Business, Premium to Economy (terms 8.8.1).
  // Use the across-haul floor for ALL marketing carriers without confirmed
  // product/haul. Do not assume the much larger long-haul awards. Published
  // 2027 rates and grandfathered bookings never reduce these minima.
  if (cabin === 'business' || cabin === 'first') return 175;
  if (cabin === 'premium') return 75;
  return 0;
}
function estimate(itinerary, priceGbp, cabin) {
  const assumptions = new Set(['great-circle-mileage', 'lowest-eligible-booking-class-if-unknown',
    'cabin-filter-is-not-a-confirmed-ticket-cabin', 'eligibility-subject-to-ticket-and-operator']);
  const units = itinerary.legs.flatMap((leg) => leg.units);
  const weights = units.map((u) => distanceMiles(u.from, u.to));
  if (weights.some((v) => v === null || v <= 0)) return { status: 'unavailable', tierPoints: null, avios: null, assumptions: ['airport-distance-unavailable'] };
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let tierPoints = 0, avios = 0;
  const byYear = {}, breakdown = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit.flown) continue;
    const miles = weights[i], codes = unit.flightNumbers.map((n) => parseFlightNumber(n).code);
    const revenue = codes.map((c) => REVENUE_CODES.has(c));
    if (revenue.some(Boolean) && !revenue.every(Boolean)) return { status: 'unavailable', tierPoints: null, avios: null, assumptions: ['connection-mixes-spend-and-mileage-without-segment-detail'] };
    const unitCabin = unit.cabin || cabin;
    let tp, av, eligibleSpendGbp = null;
    if (revenue.every(Boolean)) {
      assumptions.add('eligible-spend-assumed-70-percent-of-total');
      assumptions.add('fare-allocated-by-distance-not-actual-sector-fares');
      assumptions.add('lowest-fixed-cabin-extra-economy-extra-omitted');
      eligibleSpendGbp = priceGbp * ELIGIBLE_SPEND_FRACTION * miles / totalWeight;
      const extras = codes.map((c) => extraTierPoints(unitCabin, unit.date, c));
      const spendPerSector = eligibleSpendGbp / codes.length;
      // Terms 8.3.2 and 14.13.2: nearest whole number, per flown sector.
      // In opaque connections the missing sector fares are split equally.
      tp = Math.round(spendPerSector) * codes.length + extras.reduce((a, b) => a + b, 0);
      // IB Gold = 8 Avios per EUR, not BA/AA's 9 per GBP. Iberia route
      // bonuses and the Air Shuttle extra are deliberately not assumed.
      const aviosPerGbp = Math.min(...codes.map((c) => ['IB', 'I2'].includes(c) ? 8 * FX.gbpToEur : 9));
      av = Math.round(spendPerSector * aviosPerGbp) * codes.length;
    } else {
      const rs = codes.map((c) => rates(c, unitCabin, unit.bookingClass, unit.from, unit.to));
      if (rs.some((r) => r === null)) return { status: 'unavailable', tierPoints: null, avios: null, assumptions: ['no-published-chart-for-requested-cabin'] };
      // Opaque connections: direct distance for the WHOLE leg, multiplied
      // once by the smallest carrier rate. Never invent connecting airports
      // or award the full route mileage to every flight number.
      tp = Math.floor(miles * Math.min(...rs.map((r) => r.tp)));
      const avRates = rs.map((r, index) => {
        const code = codes[index];
        // Gold bonuses conservatively capped at the base distance award.
        const bonus = code === 'AY' ? 0.25 : (code === 'JL' && !r.domestic ? 1 : 0);
        return r.avios + Math.min(1, r.avios) * bonus;
      });
      av = Math.floor(miles * Math.min(...avRates));
      assumptions.add('partner-minimum-avios-guarantees-not-assumed');
      if (codes.some((c) => ['AY', 'JL'].includes(c))) assumptions.add('gold-partner-bonus-conservatively-capped-at-base-award');
    }
    if (unit.opaque) assumptions.add('connection-mileage-is-direct-leg-lower-bound');
    if (itinerary.hiddenCity) assumptions.add('hidden-city-only-flown-segments-no-credit-guarantee');
    tierPoints += tp; avios += av;
    const year = collectionYear(unit.date);
    byYear[year] = (byYear[year] || 0) + tp;
    breakdown.push({ flightNumbers: unit.flightNumbers, from: unit.from, to: unit.to,
      date: unit.date, miles: Math.floor(miles), tierPoints: tp, avios: av,
      eligibleSpendGbp: eligibleSpendGbp === null ? null : Math.round(eligibleSpendGbp * 100) / 100 });
  }
  return { status: 'estimated', tierPoints, avios, tierPointsByCollectionYear: byYear,
    breakdown, assumptions: [...assumptions] };
}
module.exports = { FX, ELIGIBLE_SPEND_FRACTION, RULES_DATE, ROWS, SOURCES, BONUS_SOURCE,
  GOLD_SOURCE, distanceMiles, collectionYear, goldThreshold, rates, extraTierPoints, estimate };
