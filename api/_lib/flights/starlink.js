// Evidence snapshot, not a live aircraft assignment service. See STARLINK-SOURCES.md.
const { distanceMiles } = require('./earn');
const { parseFlightNumber } = require('./carriers');
const AS_OF = '2026-10-30';
const SOURCES = Object.freeze(
{
  "QRfleet": {
    "url": "https://d21buns5ku92am.cloudfront.net/69647/documents/60300-1767676532-Factsheet%20January%202026-506f0e.pdf",
    "published": "2026-01",
    "accessed": "2026-10-30"
  },
  "QRlhr": {
    "url": "https://www.flightconnections.com/flights-from-lhr-to-doh",
    "published": "2026-10-29",
    "accessed": "2026-10-30"
  },
  "BAjfk": {
    "url": "https://www.flightroutes.com/business-first-class-flights-us",
    "published": "2026-10-19",
    "accessed": "2026-10-30"
  },
  "BA777200": {
    "url": "https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-777-200",
    "published": null,
    "accessed": "2026-10-30"
  },
  "BA777300": {
    "url": "https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-777-300",
    "published": null,
    "accessed": "2026-10-30"
  },
  "BA7879": {
    "url": "https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-787-9",
    "published": null,
    "accessed": "2026-10-30"
  },
  "BA78710": {
    "url": "https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-787-10",
    "published": null,
    "accessed": "2026-10-30"
  },
  "BAA380": {
    "url": "https://www.britishairways.com/content/information/about-ba/fleet-facts/airbus-a380-800",
    "published": null,
    "accessed": "2026-10-30"
  },
  "QR": {
    "url": "https://www.qatarairways.com/press-releases/en-WW/269475-qatar-airways-150-starlink-equipped-widebody-aircraft-now-include-world-s-first-starlink-equipped-boeing-787-9/",
    "published": "2026-08-20",
    "accessed": "2026-10-29"
  },
  "QRwifi": {
    "url": "https://www.qatarairways.com/en/onboard/connectivity.html",
    "published": null,
    "accessed": "2026-10-29"
  },
  "AS": {
    "url": "https://news.alaskaair.com/alaska-airlines-wifi-connectivity/",
    "published": "2026-10-26",
    "accessed": "2026-10-29"
  },
  "HA717": {
    "url": "https://news.alaskaair.com/guest-experience/atmos-rewards-members-unlock-free-inflight-wi-fi-on-alaska-hawaiian-airlines-thanks-to-t-mobile/",
    "published": "2026-06-25",
    "accessed": "2026-10-29"
  },
  "BA": {
    "url": "https://www.paddleyourownkanoo.com/2026/10/21/flying-on-a-british-airways-airbus-a350-you-are-now-guaranteed-ultra-fast-starlink-wi-fi-as-airline-completes-rollout-across-the-fleet/",
    "published": "2026-10-21",
    "accessed": "2026-10-29"
  },
  "AA": {
    "url": "https://news.aa.com/news/news-details/2026/Full-fleet-full-speed-full-connection-American-Airlines-will-bring-Starlink-to-every-mainline-jet-MKG-OB-10/?pubDate=20261008",
    "published": "2026-10-08",
    "accessed": "2026-10-29"
  },
  "AAregional": {
    "url": "https://www.satellitetoday.com/mobility/2026/10/08/american-airlines-to-adopt-starlink-for-full-mainline-fleet/",
    "published": "2026-10-15",
    "accessed": "2026-10-29"
  },
  "IB": {
    "url": "https://grupo.iberia.com/news/24062026/iberias-first-aircraft-with-free-high-speed-starlink-wi-fi-takes-off",
    "published": "2026-06-24",
    "accessed": "2026-10-29"
  },
  "IBxlr": {
    "url": "https://agencias.iberia.com/es-es/campanas-y-ofertas/listado/oferta-fortaleza-recife/",
    "published": "2026-10-15",
    "accessed": "2026-10-29"
  },
  "IAG": {
    "url": "https://www.iairgroup.com/media/j4maszp4/20251106-iag-starlink-partnership-press-notice.pdf",
    "published": "2025-11-06",
    "accessed": "2026-10-29"
  },
  "AY": {
    "url": "https://yle.fi/a/74-20230326",
    "published": "2026-06-08",
    "accessed": "2026-10-29"
  },
  "EI": {
    "url": "https://onemileatatime.com/news/aer-lingus-free-starlink-wi-fi/",
    "published": "2026-10-24",
    "accessed": "2026-10-29"
  },
  "EIremaining": {
    "url": "https://www.insideflyer.com/posts/aer-lingus-nears-starlink-coverage-across-transatlantic-fleet/",
    "published": "2026-10-24",
    "accessed": "2026-10-29"
  },
  "BACity": {
    "url": "https://www.paddleyourownkanoo.com/2026/06/06/british-airways-pauses-ultra-fast-starlink-wi-fi-rollout-until-october-with-just-five-planes-equipped/",
    "published": "2026-06-06",
    "accessed": "2026-10-29"
  },
  "EA": {
    "url": "https://mediacentre.aerlingus.com/pressrelease/details/108/25071",
    "published": "2026-03-29",
    "accessed": "2026-10-29"
  },
  "CX": {
    "url": "https://www.cathaypacific.com/cx/en_TW/inspiration/cathay-stories/how-inflight-wifi-works.html",
    "published": "2026-07",
    "accessed": "2026-10-29"
  },
  "FJ": {
    "url": "https://www.pax-intl.com/assets/pdf/ife-connectivity/connectivity-and-satellites/fiji-airways-connects-economy-passengers-to-free-inflight-wi-fi.pdf",
    "published": null,
    "accessed": "2026-10-29"
  },
  "JL": {
    "url": "https://www.ses.com/news/press-release/ses-japan-airlines-to-expand-multiorbit-inflight-connectivity-to-longhaul-fleet",
    "published": "2026-04-14",
    "accessed": "2026-10-29"
  },
  "NU": {
    "url": "https://en.jta-okinawa.com/",
    "published": null,
    "accessed": "2026-10-29"
  },
  "MH": {
    "url": "https://www.malaysiaairlines.com/hk/en/experience/in-flight-offerings/wi-fi.html",
    "published": null,
    "accessed": "2026-10-29"
  },
  "WY": {
    "url": "https://services.omanair.com/be/en/inflight-connectivity",
    "published": null,
    "accessed": "2026-10-29"
  },
  "QF": {
    "url": "https://www.executivetraveller.com/news/qantas-viasat-wi-fi",
    "published": "2026-09-29",
    "accessed": "2026-10-29"
  },
  "AT": {
    "url": "https://www.royalairmaroc.com/lr-en/connectivity",
    "published": null,
    "accessed": "2026-10-29"
  },
  "RJ": {
    "url": "https://www.prnewswire.com/news-releases/royal-jordanian-airlines-to-elevate-passenger-experience-with-viasats-state-of-the-art-in-flight-wi-fi-across-multiple-fleets-302088822.html",
    "published": "2024-03-14",
    "accessed": "2026-10-29"
  },
  "UL": {
    "url": "https://onboard.srilankan.com/en_uk/flying-with-us/in-flight-wifi",
    "published": null,
    "accessed": "2026-10-29"
  },
  "UA": {
    "url": "https://starlinktracker.united.com/program/starlink",
    "published": "2026-10-29",
    "accessed": "2026-10-29"
  },
  "AF": {
    "url": "https://onemileatatime.com/news/air-france-free-starlink-wi-fi/",
    "published": "2026-06-24",
    "accessed": "2026-10-29"
  },
  "NZ": {
    "url": "https://ebs.publicnow.com/view/EC7511662B4E949F8CAC3D90265793A25D44D11E",
    "published": "2025-06-10",
    "accessed": "2026-10-29"
  },
  "WS": {
    "url": "https://www.westjet.com/en-ca/help/westjet-wifi",
    "published": null,
    "accessed": "2026-10-29"
  },
  "BT": {
    "url": "https://a.storyblok.com/f/236210/x/bc36fc220f/air-baltic-corporation-2026-q1-results-presentation.pdf",
    "published": "2026-05-13",
    "accessed": "2026-10-29"
  },
  "EK": {
    "url": "https://www.wam.ae/en/article/c29cjlf-emirates-connects-aircraft-starlink-targets-232",
    "published": "2026-09-15",
    "accessed": "2026-10-29"
  },
  "VS": {
    "url": "https://www.virginatlantic.com/experience/inflight-entertainment/connectivity/starlink",
    "published": null,
    "accessed": "2026-10-29"
  },
  "TP": {
    "url": "https://www.flytap.com/-/media/Flytap/AIRchannel/Airchannel_20241001_100.pdf",
    "published": "2024-10",
    "accessed": "2026-10-29"
  },
  "DL": {
    "url": "https://www.travelweekly.com/Travel-News/Airline-News/Delta-CEO-addresses-Starlink-WiFi-controversy",
    "published": "2026-10-09",
    "accessed": "2026-10-29"
  },
  "SK": {
    "url": "https://www.sasgroup.net/newsroom/press-releases/2026/sas-completes-starlink-installation-across-entire-airbus-a320neo-fleet-in-just-six-months/",
    "published": "2026-09-01",
    "accessed": "2026-10-29"
  },
  "AC": {
    "url": "https://paxex.aero/air-canada-jetz-starlink-service/",
    "published": "2025-09-11",
    "accessed": "2026-10-29"
  },
  "ACq": {
    "url": "https://paxex.aero/air-canada-q400-starlink/",
    "published": "2025-09-17",
    "accessed": "2026-10-29"
  },
  "ZG": {
    "url": "https://zipair-pdf.s3-ap-northeast-1.amazonaws.com/a8ef04b6-ca0f-4bf3-9d45-372bd86f06b12026-05-08T03%3A11%3A41.pdf",
    "published": "2026-05-08",
    "accessed": "2026-10-29"
  }
});

// Haul is an explicit modelling assumption, not a timetable: >2,500 statute
// miles is long-haul. Narrowbodies capable of transcontinental/Hawaii service
// stay in BOTH cohorts; a long-haul flight does not imply a widebody.
// Counts are a uniform-aircraft prior, never a measured frequency-weighted rate.
function fleet(type, haul, status, equipped, total, share, asOf, refs, note = '') {
  // Deliberately broad model bands, not certified ranges or route assignments.
  // Keep mixed/unknown fleet records unbounded so uncertainty is never removed
  // merely because a type name happens to contain a narrowbody designation.
  const maxMiles = /^(737|A321$|Hawaiian A321neo)/.test(type) ? 4500 :
    type === '757' ? 5000 : type === 'A321LR/XLR' ? 5500 : null;
  return Object.freeze({ type, haul, maxMiles, status, equipped, total,
    share: share ?? (Number.isFinite(equipped) && total > 0 ? equipped / total : null),
    asOf, sources: Object.freeze(refs.map(id => SOURCES[id])), note });
}
const f = fleet;
const unknown = (type, ref, note, haul = 'both') => f(type, haul, 'unknown', null, null, null, AS_OF, [ref], note);
const AS_FLEET = [
  f('E175 regional', 'short', 'installed', 93, 93, null, '2026-10-26', ['AS']),
  f('737-800', 'both', 'rolling-out', 0, 59, null, '2026-10-26', ['AS']),
  f('737 MAX 8', 'both', 'rolling-out', 12, 20, null, '2026-10-26', ['AS']),
  f('737-900ER', 'both', 'rolling-out', 0, 79, null, '2026-10-26', ['AS']),
  f('737 MAX 9', 'both', 'rolling-out', 4, 80, null, '2026-10-26', ['AS']),
  f('Hawaiian A321neo', 'both', 'complete', 18, 18, null, '2026-10-26', ['AS']),
  f('Hawaiian A330', 'long', 'complete', 24, 24, null, '2026-10-26', ['AS']),
  f('787', 'long', 'rolling-out', 0, 5, null, '2026-10-26', ['AS']),
  unknown('Other / unenumerated AS aircraft (including 737-700)', 'AS', 'Official tracker is a programme scope, not an exhaustive merged-fleet census.'),
];
const CARRIER_FLEETS = Object.freeze({
  QR: [f('777', 'long', 'complete', 64, 64, null, '2026-08-20', ['QR', 'QRfleet']),
    f('A350', 'long', 'complete', 62, 62, null, '2026-08-20', ['QR', 'QRfleet']),
    f('787-8', 'long', 'complete', 32, 32, null, '2026-08-20', ['QR', 'QRfleet']),
    f('787-9', 'long', 'unknown', null, 26, null, '2026-08-20', ['QR', 'QRfleet'], 'Rollout started; numeric share unpublished.'),
    f('A330', 'long', 'unknown', null, 17, null, '2026-01', ['QRwifi', 'QRfleet'], 'Not covered by completed programme counts.'),
    f('A380', 'long', 'unknown', null, 10, null, '2026-01', ['QRwifi', 'QRfleet'], 'Not covered by completed programme counts.'),
    unknown('Narrowbodies', 'QRwifi', 'Do not apply the widebody-programme headline to short-haul flights.', 'short')],
  AS: AS_FLEET,
  HA: [AS_FLEET[5], AS_FLEET[6], AS_FLEET[7],
    f('717 interisland', 'short', 'no-starlink', null, null, 0, '2026-06-25', ['HA717'])],
  BA: [f('A350', 'long', 'complete', 18, 18, null, '2026-10-21', ['BA']),
    f('787-8', 'long', 'rolling-out', 10, 12, null, '2026-10-21', ['BA']),
    f('777-200', 'long', 'unknown', null, 43, null, AS_OF, ['BA', 'BA777200']),
    f('777-300ER', 'long', 'unknown', null, 16, null, AS_OF, ['BA', 'BA777300']),
    f('787-9', 'long', 'unknown', null, 18, null, AS_OF, ['BA', 'BA7879']),
    f('787-10', 'long', 'unknown', null, 12, null, AS_OF, ['BA', 'BA78710']),
    f('A380', 'long', 'unknown', null, 12, null, AS_OF, ['BA', 'BAA380']),
    unknown('A320 family / Euroflyer', 'IAG', 'Contracted, current equipped shares unknown.', 'short'),
    f('CityFlyer E190', 'short', 'no-starlink', null, null, 0, '2026-06-06', ['BACity'], 'Excluded from rollout.')],
  AA: [f('Mainline Airbus / Boeing', 'both', 'contracted', 0, null, 0, '2026-10-08', ['AA'], 'Installations begin early 2027.'),
    f('Regional Embraer / Bombardier', 'short', 'no-starlink', null, null, 0, '2026-10-15', ['AAregional'], 'SES programme, separate from mainline Starlink.')],
  IB: [unknown('A330-300', 'IB', 'First aircraft in service June; share unpublished.', 'long'),
    unknown('A321XLR', 'IBxlr', 'Advertised on REC/FOR; type-wide share unpublished.'),
    unknown('Other Iberia / affiliates', 'IAG', 'No verified equipped counts.')],
  I2: [unknown('Iberia Express A320 family', 'IAG', 'No verified installed share; parent agreement is not completion.')],
  AY: [unknown('All fleets', 'AY', 'Talks reported; no verified Starlink contract or installation census.')],
  EI: [f('A330', 'long', 'complete', 12, 12, null, '2026-10-24', ['EI']),
    f('A321LR/XLR', 'long', 'complete', 14, 14, null, '2026-10-24', ['EI']),
    unknown('A330-200 remaining / standby aircraft', 'EIremaining', 'Conflicting active-fleet scope: two unequipped A330-200s reportedly awaiting parking; no confirmed retirement at cutoff.', 'long'),
    unknown('A320 / A320neo', 'EI', 'Next rollout phase; share unpublished.', 'short'),
    unknown('Regional ATR / other operators', 'EA', 'Aer Lingus Regional is excluded from mainline rollout.', 'short')],
  EA: [unknown('Emerald ATR', 'EA', 'Excluded from EI contract; do not inherit EI long-haul coverage.')],
  CX: [unknown('A350 / 777 / A330 / A321neo', 'CX', 'Alternative connectivity documented; Starlink share unverified.')],
  FJ: [unknown('A350 / 737 MAX / A330', 'FJ', 'Ordinary Wi-Fi is not evidence of Starlink.')],
  JL: [unknown('A350 / 787 / 767 / 777 / 737', 'JL', 'SES / OneWeb contract, not ZIPAIR Starlink; no Starlink census.')],
  NU: [unknown('JTA 737-800', 'NU', 'Free Wi-Fi; no verified Starlink installation share.')],
  MH: [unknown('A350 / A330 / 737', 'MH', 'MHconnect / Viasat; Starlink share unverified.')],
  WY: [unknown('787 / 737', 'WY', 'OnAir Wi-Fi on 787; Starlink share unverified.')],
  QF: [unknown('A220 / A321XLR / 737 / A330 / 787 / A380', 'QF', 'Viasat programme, no verified Starlink census.')],
  AT: [f('Contracted 737 / 787 programme', 'both', 'contracted', 0, 41, null, AS_OF, ['AT'], 'First installations early 2027.')],
  RJ: [unknown('E2 / A320 / A321 / 787', 'RJ', 'Viasat contract; Starlink share unverified.')],
  UL: [unknown('A330 / A320', 'UL', 'OnAir / onboard content; Starlink share unverified.')],
  UA: [f('CRJ550', 'short', 'complete', 100, 100, null, AS_OF, ['UA']),
    f('E175', 'short', 'complete', 252, 252, null, AS_OF, ['UA']),
    f('737 non-MAX', 'both', 'rolling-out', 193, 328, null, AS_OF, ['UA']),
    f('737 MAX', 'both', 'rolling-out', 46, 300, null, AS_OF, ['UA']),
    f('A321', 'both', 'rolling-out', 68, 77, null, AS_OF, ['UA']),
    f('777', 'long', 'rolling-out', 4, 96, null, AS_OF, ['UA']),
    f('787', 'long', 'rolling-out', 2, 100, null, AS_OF, ['UA']),
    f('A319', 'short', 'not-started', 0, 67, null, AS_OF, ['UA']),
    f('A320', 'short', 'not-started', 0, 62, null, AS_OF, ['UA']),
    f('757', 'both', 'not-started', 0, 61, null, AS_OF, ['UA']),
    f('767', 'long', 'not-started', 0, 53, null, AS_OF, ['UA']),
    unknown('Other regional / unenumerated types', 'UA', 'No complete programme denominator for all regional partners.', 'short')],
  AF: [f('777-300ER', 'long', 'rolling-out', 28, 31, null, '2026-06-08', ['AF']),
    f('A220', 'short', 'rolling-out', 45, 56, null, '2026-06-08', ['AF']),
    f('HOP E190', 'short', 'rolling-out', 24, 30, null, '2026-06-08', ['AF']),
    f('A350', 'long', 'rolling-out', 30, 41, null, '2026-06-08', ['AF']),
    f('A320', 'short', 'rolling-out', 3, 28, null, '2026-06-08', ['AF']),
    unknown('Other AF / HOP types', 'AF', 'June non-installation / retirement plans do not establish October completion.')],
  NZ: [unknown('Domestic A320 / ATR trials; international fleets', 'NZ', 'One A320 trial live June 2025; current share unavailable.')],
  WS: [f('737 MAX 8 / 737-800', 'both', 'rolling-out', 100, null, null, AS_OF, ['WS'], 'Over 100 now; no matching denominator.'),
    unknown('787-9', 'WS', 'End-2026 completion is a target, not an equipped count.', 'long')],
  BT: [f('A220-300', 'both', 'rolling-out', 28, null, null, '2026-03-31', ['BT'], '58% of flights is NOT fleet share; denominator unavailable.')],
  EK: [f('777 + A380 programme', 'long', 'rolling-out', 53, 232, null, '2026-09-15', ['EK']),
    unknown('A350', 'EK', 'Programme scope excludes A350; current equipped share unverified.')],
  VS: [f('A350', 'long', 'complete', null, null, 1, AS_OF, ['VS']),
    unknown('787 / A330neo / remaining fleet', 'VS', 'Rollout through 2027; current counts unavailable.', 'long')],
  TP: [unknown('All fleets', 'TP', 'Wi-Fi documented, no verified Starlink evidence or reliable negative census.')],
  DL: [f('All fleets', 'both', 'no-starlink', null, null, 0, '2026-10-09', ['DL'], 'CEO explicitly declined Starlink; Amazon Leo starts 2028.')],
  SK: [f('A320neo', 'short', 'complete', 81, 81, null, '2026-09-01', ['SK']),
    unknown('Other aircraft', 'SK', 'Preparations / next phase; no equipped counts.')],
  AC: [f('Jetz charter A320', 'short', 'complete', 4, 4, null, '2025-09-11', ['AC']),
    unknown('Jazz Q400', 'ACq', 'Nine planned, not nine confirmed equipped.', 'short'),
    unknown('Scheduled mainline', 'AC', 'Charter installation does not establish scheduled-flight coverage.')],
  ZG: [f('787-8', 'both', 'complete', 8, 8, null, '2026-05-08', ['ZG'])],
});
for (const fleets of Object.values(CARRIER_FLEETS)) Object.freeze(fleets);

const HAWAII = new Set(['HNL', 'OGG', 'KOA', 'LIH', 'ITO', 'MKK', 'LNY', 'JHM']);
// Dated candidate sets, not aircraft assignments or flight-frequency weights.
// Retain both QR Dreamliner types as conservative substitution candidates;
// the Heathrow schedule also explicitly includes the unequipped-share A380.
const ROUTE_COHORTS = Object.freeze({
  'QR:DOH:LHR': { types: ['777', 'A350', '787-8', '787-9', 'A380'], source: SOURCES.QRlhr },
  'BA:JFK:LHR': { types: ['777-200', '777-300ER', '787-9', '787-10'], source: SOURCES.BAjfk },
});
const BASE_NOTE = `Evidence as of ${AS_OF}; aircraft-count prior, not a flight guarantee. Aircraft swaps and outages happen.`;
function uniqueSources(items) {
  return [...new Map(items.map(source => [source.url, source])).values()];
}
function starlinkProbability(row) {
  const sources = [], notes = [], probabilities = [];
  let routeBased = false, lowerBound = false, failure = null;
  const units = Array.isArray(row?.legs) ? row.legs.flatMap(leg => Array.isArray(leg?.units) ? leg.units : []) : [];
  const flown = units.filter(unit => unit?.flown === true);
  if (!flown.length) failure = 'No normalized flown segments.';
  for (const unit of flown) {
    if (unit.opaque || !Array.isArray(unit.flightNumbers) || unit.flightNumbers.length !== 1) {
      failure ||= 'Connecting airports unavailable; per-segment route cohorts cannot be inferred.';
      continue;
    }
    const marketing = parseFlightNumber(unit.flightNumbers[0])?.code;
    // An explicit unrecognised operator must not inherit the marketing fleet.
    const code = unit.operatingCarrier === undefined ? marketing : unit.operatingCarrier;
    const fleets = Object.hasOwn(CARRIER_FLEETS, code) ? CARRIER_FLEETS[code] : null;
    if (!fleets) { failure ||= `Unknown operating carrier or fleet: ${code || 'unavailable'}.`; continue; }
    sources.push(...fleets.flatMap(fleet => fleet.sources));
    const miles = distanceMiles(unit.from, unit.to);
    if (!Number.isFinite(miles) || miles <= 0) { failure ||= 'Segment distance unavailable.'; continue; }
    // The retired HA marketing code is accepted only as legacy data/operator
    // evidence. AS never aliases to HA: the merged code covers different fleets.
    if (code === 'HA' && HAWAII.has(unit.from) && HAWAII.has(unit.to)) {
      probabilities.push(0); routeBased = true;
      notes.push('HA neighbor-island service has no Wi-Fi.'); continue;
    }
    if (['AA', 'AT'].includes(code) && (!unit.date || unit.date >= '2027-01-01')) {
      failure ||= `${code} installations start in 2027; a pre-rollout zero cannot predict this departure.`; continue;
    }
    const haul = miles > 2500 ? 'long' : 'short';
    const cohort = ROUTE_COHORTS[`${code}:${[unit.from, unit.to].sort().join(':')}`];
    const candidates = fleets.filter(fleet => (fleet.haul === 'both' || fleet.haul === haul) &&
      (fleet.maxMiles === null || miles <= fleet.maxMiles) && (!cohort || cohort.types.includes(fleet.type)));
    if (cohort) {
      sources.push(cohort.source); routeBased = true;
      notes.push(`${code} ${unit.from}–${unit.to}: dated route candidate cohort; not a live timetable.`);
    }
    if (!candidates.length) { failure ||= `${code} compatible fleet is unknown.`; continue; }
    const unknownShares = candidates.filter(fleet => fleet.share === null);
    let p;
    if (!unknownShares.length && candidates.every(fleet => fleet.share === candidates[0].share)) p = candidates[0].share;
    else if (candidates.every(fleet => Number.isFinite(fleet.total) && fleet.total > 0)) {
      p = candidates.reduce((sum, fleet) => sum + (fleet.share ?? 0) * fleet.total, 0) /
        candidates.reduce((sum, fleet) => sum + fleet.total, 0);
      if (unknownShares.length) {
        lowerBound = true;
        notes.push(`${code} lower bound: unknown equipped share for ${unknownShares.map(fleet => fleet.type).join(', ')}; counted as not equipped.`);
      }
    } else { failure ||= `${code} compatible sub-fleet aircraft counts are unknown.`; continue; }
    probabilities.push(p);
    routeBased ||= candidates.length !== fleets.length;
    notes.push(`${code} ${haul}-haul: ${candidates.map(fleet => fleet.type).join(', ')}.`);
    if (unit.operatingCarrier === undefined) notes.push('Operator unavailable; assumes the marketing carrier operates, verify codeshares.');
  }
  return failure ? { p: null, basis: 'unknown', note: `${failure} ${BASE_NOTE}`, sources: uniqueSources(sources) } : {
    p: probabilities.reduce((product, p) => product * p, 1),
    basis: lowerBound ? 'lower-bound' : routeBased ? 'route' : 'fleet-share',
    note: `${[...new Set(notes)].join(' ')} Segment probabilities multiply, assuming independent assignments. ${BASE_NOTE}`,
    sources: uniqueSources(sources),
  };
}
module.exports = { AS_OF, SOURCES, CARRIER_FLEETS, starlinkProbability };
