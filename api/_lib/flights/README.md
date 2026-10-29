# Flights backend contract

Backend researched 28 October 2026. The static UI is `flights/index.html`,
served at `/flights` without a build step. No credentials or live account
integration is included.

## HTTP

`GET /api/flights?action=search|anywhere|flex` (default action: `search`).
All responses are JSON, private/no-store and noindex. Other methods return 405.
The page and API are open, with no password, API token, session or login proxy.
An absent `Origin` header is allowed; when present it must be a valid origin
matching the request's scheme, Host and port, otherwise the API returns 403.
This supports the production host, preview hosts and local development without
wildcard CORS. Vercel supplies `x-forwarded-proto`; other reverse proxies must
overwrite that header (and `x-real-ip`). Without it, the socket determines the
scheme. Forwarded host headers are not used. Origin checks and the local
throttle are defence in depth, not authentication or durable abuse prevention.

Common parameters:

| Parameter | Meaning |
| --- | --- |
| `origin` | Any 3-letter IATA code, or up to 7 comma-separated codes; normalized to uppercase. Omit for LHR, LGW, LCY, STN, LTN, SEN and IBZ. An implicit origin equal to the destination is skipped. Explicit self-routes are rejected. |
| `departureDate` | Required real `YYYY-MM-DD`, today through 366 days ahead, UTC. |
| `returnDate` | Optional return date, on/after departure, within the same horizon. |
| `earningOnly` | Literal `true` (default) or `false`. Search defaults to eligible carriers; false requests all airlines and retains non-earning fares with `earns:false`. Discovery accepts the flag for context/cache separation but remains unverified. |

Search parameters:

| Parameter | Meaning |
| --- | --- |
| `destination` | Required IATA code. |
| `fareClass` | `basic-economy`, `economy` (default), `premium`, `business`, `first`. A search filter, not proof of the ticket cabin. |
| `limit`, `offset` | Per-origin provider page: 1–100 (default 25), 0–99 (default 0). |
| `maxStops` | Provider enum `none`, `one`, `many` (default). |
| `includeHiddenCity` | Literal `true` or `false` (default true for one-way; always false when `returnDate` is set). |
| `airlines` | Optional comma-separated subset of eligible marketing codes. Sent as `preferredAirlines: string[]`, exactly as tools/list specifies; final eligibility is still checked locally. With `earningOnly=false`, no default airline preference is sent; an explicit subset still applies. |

Search always asks the provider for price order, one adult, standard flights,
and no virtual interlining. It ranks the returned candidates by unrounded
`priceGbp / estimate.tierPoints`, then by total GBP price. Hidden-city fares
participate in the same ranking without a penalty or a separate bucket. It is not an exhaustive
search of every fare: `pages` exposes upstream pagination. Zero/unavailable TP
have a null ratio. Earning fares always precede non-earning fares; non-earning
fares sort by price and never receive a GBP/TP ratio. A malformed itinerary is
always excluded. A non-earning itinerary is excluded by default, with only its
exclusion reason counted in `excluded` (no payload logging). With
`earningOnly=false`, carrier, published flight-series and operator earning
failures instead produce `earns:false`, `eligibility:"non-earning"`, zero TP,
null Avios and an empty earning breakdown. Structural checks, hidden-city
safeguards and virtual-interlining exclusion still apply to all fares.

Anywhere accepts `fareClass` but no destination, airline or calendar options.
Flex accepts `destination`, `mode=depart|return` (default depart), and
`sort=date|price` (default date). `mode=return` requires `returnDate`. The provider
does **not** accept a cabin filter for flex. Unknown, duplicate and empty query
parameters are rejected rather than silently ignored.

Successful envelope:

```json
{
  "action": "search",
  "results": [],
  "partial": false,
  "failures": [],
  "excluded": {},
  "pages": [{"origin":"LHR","offset":0,"limit":25,"totalAvailable":14,"hasMoreResults":true}],
  "meta": {
    "defaultOrigins": ["LHR","LGW","LCY","STN","LTN","SEN","IBZ"],
    "carriers": [],
    "rulesAsOf": "2026-10-28",
    "fx": {"usdToGbp":0.77,"gbpToEur":1.17,"asOf":"2026-10-28","kind":"planning-assumption"},
    "eligibleSpendFraction": 0.7,
    "memberTier": "Gold",
    "collectionYear": "2026-2027",
    "goldThreshold": 20000,
    "sources": {},
    "ranking": "GBP-per-estimated-tier-point-then-price",
    "discoveryOnly": false,
    "notice": "Estimates only; verify booking class, operator and earning with BA before buying. Search covers returned fares, not every fare available."
  }
}
```

A recorded £93.17 Iberia return result has these earning fields:

```json
{
  "flightNumbers": ["IB714","IB725"],
  "price": {"amount":121,"currency":"USD"},
  "priceGbp": 93.17,
  "eligibility": "conditional",
  "earns": true,
  "hiddenCity": false,
  "bookedArrival": null,
  "ticketedTo": "MAD",
  "leaveAt": "MAD",
  "gbpPerTierPoint": 1.4116666666666666,
  "estimate": {
    "status":"estimated",
    "tierPoints":66,
    "avios":610,
    "tierPointsByCollectionYear":{"2026-2027":66},
    "breakdown": [],
    "assumptions": []
  }
}
```

Actual results additionally contain `id`, `origin`, `destination`, `departure`,
`arrival`, `returnFlight`, `deepLink`, `warnings` and bounded provider `airlines`
display text (untrusted; the page HTML-escapes it). Breakdowns contain flight
numbers, airports, date, miles, eligible GBP spend (or null), TP and Avios. The
real assumptions arrays are populated; the empty arrays above abbreviate them.
`estimate.status=unavailable` has null TP/Avios and a reason in `assumptions`.
The `eligibility` field remains conditional whenever booking class or required
operator information is absent. A positive estimate is not a guarantee of credit.
Every normalized search row has an `earns` boolean describing whether all booked
segments pass the carrier/flight-series/operator earning checks. An earning row
may still have unavailable or zero estimated TP; it is not a guaranteed award.

Anywhere rows have `origin`, `destination`, USD `price`, `priceGbp`, `deepLink`,
`eligibility:"unverified"`, `estimate:null` and `requiresSearch:true`. Flex rows
instead add `departureDate` and `returnDate` (nullable) and omit the booking link.
Both are **unfiltered discovery prices**, can include non-earning airlines, and
have `meta.discoveryOnly:true` and `meta.ranking:null`. They cannot be used to
claim a status bargain until the caller runs search for that route/date. There
is no automatic discovery-to-search fan-out against the public MCP.

Errors are `{ "error": "generic message" }`: 400 bad input, 403 cross-origin,
405 method, 429 local throttle/concurrency, 502 provider/schema failure,
504 upstream timeout. 429 includes `Retry-After`. Every response, including
cache hits and every error, has `X-Robots-Tag: noindex, nofollow`.
Partial origin failures return 200 with `partial:true` and bounded
`{origin,code}` entries. Empty successful provider results remain a valid 200.

## Carriers and earning model

Eligible marketing codes: **AS AA BA CX FJ AY IB JL MH WY QF QR AT RJ UL EI EA I2
NU**. AS covers full-member Alaska and Hawaiian under their shared AS code;
HA is retired and is not automatically mapped. The first 15 codes are oneworld
members; EI is an earning partner, and EA, I2 and NU are explicitly included
affiliates in BA's partner charts. Parent-marketed affiliates such as Air Nostrum,
Horizon, Fiji Link and QantasLink qualify using the published parent code.

Sources:

- [BA tier-point partner charts](https://www.britishairways.com/content/the-british-airways-club/about-tier-points/flights)
- [BA Avios partner charts and codeshare conditions](https://www.britishairways.com/content/the-british-airways-club/avios/collecting-avios/flights)
- [oneworld members, including the S7 suspension](https://www.oneworld.com/members)
- [Hawaiian's full membership from April 2026](https://www.oneworld.com/news/oneworld-welcomes-hawaiian-airlines)
- [AS flight-code transition](https://www2.arccorp.com/articles-trends/agency-communications/archived-tac/2025-tac-messages/ped-101225/)
- [Loganair's own Avios programme and transfers](https://www.loganair.co.uk/loyalty/avios/)

VY/Vueling and LM/Loganair do not directly earn BA tier points simply because
they use Avios. BA-marketed codeshares can qualify. LEVEL is excluded under its
own code, and LEVEL-operated IB flights are explicitly excluded from TP by BA.
CZ/China Southern and LATAM are Avios-only for this purpose. S7 is suspended.
AY8100–8700 and published MH excluded series are rejected. Every flight number
on both outbound and return is checked, including all connections. A mixed
non-earning/unknown prefix or a known disallowed operator excludes the **whole**
result by default, or marks the whole row non-earning with `earningOnly=false`.
Missing operators are clearly flagged for booking verification.

The pre-April-2025 TP distance bands are obsolete. Current partner TP charts
are percentages of miles, selected by carrier, cabin and booking class. `ROWS`
in earn.js records eligible classes; missing classes use the **lowest eligible
published rate in that cabin**, not a flexible fare. Unknown classes can in
practice earn zero, so all such quotes carry a warning. Unsupported cabin charts
or unknown airport coordinates produce an unavailable estimate. Special JAL
and Fiji domestic charts and Alaska's First-as-Business treatment are included.
JAL Avios use the lower operator-dependent chart when operator details are
missing. Partner minimum Avios guarantees are omitted. Gold AY/JL bonuses are
capped at the lower of the fare award and base mileage, deliberately conservative.

BA/AA/IB marketed flights use eligible spend. BA earns 1 TP per eligible GBP;
Gold BA/AA earns 9 Avios per eligible GBP, Iberia Gold 8 per eligible EUR.
The 70% eligible-spend share and FX 0.77 USD→GBP / 1.17 GBP→EUR are **planning
assumptions**, not provider tax breakdowns, live rates, BA-published percentages
or guaranteed lower bounds. The real currency conversion uses the purchase-date
IATA rate. Fare is allocated by segment distance, or equally between flight
numbers in an opaque connection. Revenue TP and Avios round to the nearest
whole number per sector, following BA terms §§8.3.2 and 14.13.2.

Without confirmed haul/fare family, fixed revenue-flight extras use the minimum
across both hauls: 175 TP for Business/First, 75 for Premium, 0 for Economy/Basic
(an economy filter does not establish a non-Basic fare). This understates many
long-haul awards. No ancillary, registration, holiday, card, route-specific
Iberia or grandfathered higher booking-date bonuses are invented.
[BA terms, including short-haul cabin mappings](https://www.britishairways.com/content/the-british-airways-club/about-the-club/terms-and-conditions)
and the [published extras](https://www.britishairways.com/content/the-british-airways-club/about-tier-points/flights)
are authoritative; some older bonus URLs now return 404.

The collection year runs 1 April–31 March. Gold requires **20,000 TP for
2026–27**, and the published requirement from 1 April 2027 is **21,000**.
The current BA overview has both the future headline and the current-year FAQ;
do not accidentally apply the future figure to 2026. Estimates include
`tierPointsByCollectionYear` so a trip spanning 1 April is not represented as a
single-year qualification. [BA thresholds and current-year FAQ](https://www.britishairways.com/content/the-british-airways-club/about-tier-points)

Current FlightCards omit connecting airports. Such connections use the whole
leg's direct great-circle distance once and the lowest rate among its carrier
prefixes, rather than multiplying full-route mileage by its sector count.
This is an approximate mileage floor, not BA's exact flown-distance calculation
or per-sector rounding. Opaque connections mixing revenue and distance earning
remain unavailable. Detailed segment arrays, if supplied by the provider in
future, are checked against flight numbers, airport continuity and destination.

Hidden-city quotes default on for one-way searches; `includeHiddenCity=false` explicitly opts out.
With `returnDate`, hidden-city inclusion is forced off in provider requests even
if the caller sets `includeHiddenCity=true`. Results are independently checked
and hidden-city fares excluded, including provider cards missing a return leg.
Opaque hidden-city cards are excluded because
the MCP cannot prove where the passenger gets off. With explicit segment data,
only the flown prefix ending at the searched destination earns; the full ticket
price remains in the numerator and in fare allocation. All booked prefixes must
still pass eligibility. Hidden-city round trips are excluded because onward
cancellation cannot be assumed away. `arrival` is the flown endpoint with null
time when unknown; `bookedArrival` separately preserves the unflown endpoint.
Every search result has a factual `hiddenCity` boolean, `ticketedTo` (outbound
ticketed airport code) and `leaveAt` (searched destination airport code). For
standard fares both codes equal `destination`; for hidden-city fares they differ.
The flag uses provider attributes and a ticketed airport beyond the searched
destination, so an omitted provider label does not disguise a hidden-city fare.
Detailed segments must end at the reported ticketed airport. Discovery rows lack
itineraries and do not claim a hidden-city classification.

A synthetic LHR–DOH–BKK ticket searched to DOH exposes this endpoint shape:

```json
{
  "origin": "LHR",
  "destination": "DOH",
  "hiddenCity": true,
  "ticketedTo": "BKK",
  "leaveAt": "DOH",
  "arrival": {"airport":"DOH","dateTime":null},
  "bookedArrival": {"airport":"BKK","dateTime":"2026-11-19T12:40:00+07:00"}
}
```

Its estimate credits LHR–DOH only, while the full ticket price is used for its
GBP/TP ratio and spend allocation includes the unflown DOH–BKK sector. The result
warns that skipped sectors can invalidate the ticket and credit.

Airport coordinates/country codes in airports.json are a compact 28 October
2026 snapshot of [OurAirports public-domain data](https://ourairports.com/data/),
from `https://davidmegginson.github.io/ourairports-data/airports.csv`. Entries are
`IATA:[latitude,longitude,country,city?]`; duplicate codes prefer large, medium, small,
seaplane, heliport, then other records. 9,053 IATA entries; unknown three-letter
codes are accepted as search input but cannot fabricate a mileage award.
Optional display cities cover the search picker and recorded discovery routes,
with familiar city labels (for example Bordeaux for BOD and Milan for MXP).
Search responses include the relevant labels in `meta.airports`; discovery
uses the provider city when a catalogue label is absent. Normalized search fares
also expose `legs[].units` with flown flags, flight numbers and available
endpoints, so skipped hidden-city sectors remain separate in the UI.

## Operations and UI packet configuration

MCP tools/list was fetched directly, unauthenticated, on 28 October 2026. The
exact input/output schemas are recorded in tests/flights/fixtures/schemas.json.
The adapter posts JSON-RPC tools/call with Content-Type application/json and
Accept application/json, text/event-stream. It reads SSE data fields across
chunks, handles JSON responses, stops at its matching result, limits the body
to 2 MiB, and cancels at 6 seconds per call / 18 seconds per HTTP request.
No payloads, upstream errors or addresses are logged. No auth/IP
headers are forwarded to Skiplagged. There are no retries.

Per instance: at most 2 API requests and 3 provider calls per request in flight;
5 requests/IP/minute in a fixed window starting at first admission; bounded
512-entry hashed-IP map. Vercel's
overwritten x-real-ip is used, with socket/unknown fallback elsewhere. These
are defence in depth, not authentication or durable distributed abuse control.

A per-instance response cache retains at most **64 normalised queries**, with a
**10 minute (600,000 ms) TTL** from successful completion. It shares complete
200 responses (including empty results) across IPs. Parameter order, IATA/carrier
case, duplicates in origin/carrier sets, explicit defaults and numeric formatting
normalise to the same key; different actions, dates, routes, filters, pagination
and calendar modes remain distinct, as does the normalized `earningOnly` flag
(omission and explicit `true` share a key). Expired entries are pruned on access/write;
when full, the oldest insertion is evicted (reads do not extend TTL or recency).
Errors and partial origin responses are never cached. Throttling, Origin checks
and validation run before cache lookup, so cache hits still count toward the
per-IP limit. Concurrent misses may each call the provider, within the existing
concurrency caps. HTTP/CDN caches remain disabled by the response headers.

Both maps and concurrency counters are local to a warm function instance and
reset on restart; they are not a distributed provider-load guarantee. No browser
payloads are logged and no automatic retries or discovery fan-out are added.

`/api/flights?action=...` works without rewrites. The `/flights` page calls it
from the same origin without a password or proxy. Vercel rewrites `/flights`
and `/flights/` to the static page and gives the API 25 seconds.

The page sends the six London airports explicitly (excluding the destination),
or a selected airport. A first calendar tap selects one way; a later second tap
adds a return. It displays API totals and ranks positive earning estimates by
GBP/TP without multiplying a return. Unavailable or zero estimates are excluded
from the earning list. Turning off the persisted `oneworld only` filter includes
all structurally valid returned fares, with muted `No TP` for `earns:false`
and no tier-point ratio. Best value and Most tier points keep earning fares
first; Cheapest and Fastest mix all airlines. The desktop sticky filters become
a keyboard-accessible bottom sheet on phone. Go and Enter share submission
validation, close the calendar for a valid search, and focus an absent destination.
API errors and 429 with Retry-After have explicit states;
navigation aborts obsolete requests and stale replies cannot replace the page.

Anywhere and flex are **unverified discovery**, not earning quotes. Anywhere
shows price order and an explicit destination click runs search; it does not
silently fan out searches. The calendar's £/TP switch fetches flex once for the
current context: unverified dates show £ discovery prices, and dates previously
searched in the same route/cabin/trip context show their actual estimated ratio.
The note distinguishes them. No tier points are invented from a discovery price.

Gold values are entered by the user, defaulting to 0 TP, a 20,000 target and the
next 31 March. `goldData()` is the single localStorage data boundary to replace
when real BA balance access is added. Fare progress counts only dated backend
breakdown sectors in the saved collection year and before the entered deadline.
No login or balance claim is implied.

## Verification

The repo has no npm test script or build step. It uses plain Node assertions;
the complete discovery command is `node --test`, with dummy DEV_PASSWORD and
PLAYA_PASSWORD supplied for the existing suites. Flights tests additionally use
Node's built-in test functions and run with `node --test tests/flights/*.test.js`.
All flights network access is stubbed or forbidden, including transport tests.
Recorded fixtures are genuine tools/call structuredContent for LHR–MAD return,
LHR–BKK Qatar connection, IBZ-anywhere and LHR–MAD departure calendar. Mutation
cases and return-calendar sorting cases are explicitly synthetic, not claimed
as provider recordings. No private booking, ticket, account or credential data
was recorded. No production calls are made by tests.


### Local page QA

`node tests/flights/browser-check.cjs` starts a loopback fixture server, runs
Playwright at 1280 and 390 pixels, and captures screenshots plus a JSON report
under `/tmp/flights-browser-qa` (override with `FLIGHTS_SCREENSHOT_DIR`). It uses
`playwright` from the current installation, `FLIGHTS_PLAYWRIGHT_MODULE` when
set, or the existing ai-mac installation. Approved reference captures use the committed
`prototypes/flights/proto-v3.html` by default (override `approvedPath` when
creating the fixture server). The server uses the real handler with recorded
fixtures and labelled synthetic route/date/hidden-city mutations. It has an
explicit static-file allowlist and never contacts Skiplagged. It requires a
runtime permitted to bind loopback sockets and launch Chromium. The Node UI
tests use the shipping inline script and real handler without either permission.
