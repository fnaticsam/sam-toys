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
| `limit`, `offset` | Per-origin provider page: 1–100 (default 100), 0–99 (default 0). |
| `maxStops` | Provider enum `none`, `one`, `many` (default). |
| `includeHiddenCity` | Literal `true` or `false` (default true for one-way; always false when `returnDate` is set). |
| `airlines` | Optional comma-separated subset of eligible marketing codes. Sent as `preferredAirlines: string[]`, exactly as tools/list specifies; final eligibility is still checked locally. With `earningOnly=false`, no default airline preference is sent; an explicit subset still applies. |

City codes in the shared `flights/cities.js` catalogue (re-exported by
`api/_lib/flights/cities.js`) are queried once, without expanding airports into
provider calls. Both endpoints and return legs accept group members; individual
airport codes stay exact. Actual airport endpoints drive mileage and hidden-city
checks. Response `origin`/`destination` preserve the searched group and
`meta.airports` supplies its city name.

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

All-airline search merges an eligible-carrier page and an unfiltered page for
each origin, then deduplicates by normalized trip `id` before ranking. The
eligible copy wins a duplicate regardless of completion order; the union is not
truncated to `limit` (that limit applies separately to each upstream page).
Explicit `airlines` selections constrain the eligible query; the broad query
omits `preferredAirlines`. All other search arguments match between queries.
There are at most **7 provider calls per request**, with at most **3 in flight**.
Every origin's eligible query takes priority, then remaining capacity goes to
unfiltered queries in origin order. An uncached all-airline search therefore
uses `min(2 × origin count, 7)` initial calls, unless aborted before dispatch. Skipped
unfiltered queries produce `partial:true` and a `provider-call-cap` failure;
such responses are not cached. Union `pages` and failures identify `scope` as
`eligible` or `all`; pagination totals describe each provider query, not a
deduplicated combined total. After the initial pages, if an origin has accepted fares but no itinerary
with one flown sector on every leg, search makes at most **one** supplemental
`maxStops=none`, `limit=100`, `offset=0` query for the first such origin. This
bounded probe also covers routes whose nonstop timetable is unknown. Existing
airline preferences and return/hidden-city safeguards are retained. It uses
only remaining capacity within the same **7 total calls / 3 concurrent** caps;
explicit nonstop requests are never probed again. Its deduplicated fares join
the initial results, and its page/failure is marked `maxStops:"none"`. A failed
or cap-skipped probe leaves the initial fares visible with `partial:true`,
and the response is not cached. Empty initial results are not probed.

`meta.providerCalls` records calls actually made
to build the response (a cached response makes zero new calls).

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
  "pages": [{"origin":"LHR","offset":0,"limit":100,"totalAvailable":14,"hasMoreResults":true}],
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
Neither discovery tool accepts an airline filter in its provider schema, so
both toggle values use the same single query per origin; duplicating it would
not add earning candidates. Cache entries still distinguish `earningOnly`.

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

The page sends the selected city code once (London defaults to `LON`),
or a selected airport. City groups are available in both pickers. New searches
reset stop/time/airline filters while keeping the persisted oneworld toggle;
the results heading follows the first visible sorted fare, or explicitly says
that no flights match the filters. A first calendar tap selects one way; a later second tap
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

## City/coverage regression evidence (29 October 2026)

Four live `sk_flights_search` calls only, recorded with timestamps, exact
arguments and response/error under `tests/flights/fixtures/live-2026-10-29/`:

| Route (5 Nov 2026, economy) | Limit / stops | Provider rows | Nonstop rows | Accepted earning rows |
| --- | --- | ---: | ---: | ---: |
| NYC–LHR | 100 / many | 100 | 12 | 99 |
| JFK–LHR | 25 / many | 25 | 7 | 25 |
| JFK–LHR | 100 / many | 42 | 12 | 41 |
| JFK–LHR | 100 / none | timeout (6 s) | unavailable | unavailable |

The single NYC query returned JFK, EWR and LGA departures, confirming city-code
querying without airport fan-out. A Condor-marketed DE/BA connection is excluded
from each larger page. BA112, BA178 and AA100 appear in the 100-limit JFK page.
The reported all-connections 25-row slice was not reproduced in this snapshot: it
already had seven directs. Supplemental query success/union/caps are tested
with synthetic selections of recorded rows; its live success remains unverified
because call four timed out and the four-call research budget was not exceeded.
The provider reports NYC `totalAvailable:107` but `hasMoreResults:false` for
100 returned rows, so that upstream pagination is not evidence of completeness.
All tests inject fixtures; none calls the live provider.

BA's Aer Lingus/Emerald economy chart was rechecked on 29 October: **4%** of
miles for A/G/O/Z, **7%** for Q/N/F/S/V/L/M/K and **15%** for Y/B/H. The existing
chart is correct and unknown economy booking class keeps the 4% assumption,
with an explicit warning that some actual classes may earn zero. JFK–LHR's
3,442-mile direct-distance floor gives **137 TP**, or **136 TP** for synthetic
JFK–SNN–LHR detailed sectors rounded down separately. **860 TP** matches the
25% business assumption exactly; it is not a valid unknown-class economy
estimate. UI economy parameters, request snapshots, cancellation and cabin cache
separation are covered by tests; the original screen's cause cannot be established
without its original request/result. At the £3,440 price implied by 860 × £4,
137 TP would cost about **£25.11/TP**. No speculative chart-rate change was made.
See the sourced BA chart above and `tests/flights/aer-lingus.test.js`.

## Starlink estimates (30 October 2026)

Every normalized **search** result includes `starlink: {p, basis, note}`. `p` is
0–1 or `null`; `basis` is `fleet-share`, `route`, `lower-bound`, or `unknown`. For example,
`&starlinkMin=0.8` keeps **p >= 0.8**, excluding unknowns. The boundary is
inclusive (the UI label should say “at least 80%” if it uses this value).
Omission disables the filter; `0` retains known zeroes but still excludes null.
Only strict decimal numbers from 0 through 1 are accepted. Duplicate/empty,
invalid or discovery (`anywhere`/`flex`) thresholds return 400. The normalized
threshold participates in the cache key; it is never sent to Skiplagged.
Filtering happens locally after normalization and deduplication, preserving
ranking and provider-call limits. It does not request additional provider pages
just because the filtered results are empty, and cannot find candidates absent
from those returned pages.

The evidence table lives in [starlink.js](starlink.js); the complete
[carrier/sub-fleet report and source ledger](STARLINK-SOURCES.md) records source
URLs, publication/update dates and access dates (29–30 October 2026). Every carrier in
carriers.js is covered, plus HA, UA, AF, NZ, WS, BT, EK, VS, TP, DL, SK, AC and
ZG. “Unknown” is distinct from confirmed “no Starlink”. Generic free Wi-Fi,
another provider, a contract, a completion target or a share of *flights* does
not establish an installed fleet percentage. Dates in the data are observation
dates, not forecasts; no scheduled target is automatically marked complete.

`starlinkProbability(row)` additionally returns deduplicated `sources` objects
(`url`, `published`, `accessed`) for audit use; HTTP rows omit this repeated
payload. It consumes normalized `legs[].units`, uses a supplied operating
carrier before a marketing prefix, and never maps the merged **AS** code to
Hawaiian’s Airbus fleet. **HA** remains a legacy/operator evidence key, not a
change to earning eligibility. When an operator is absent it uses the marketing
carrier’s fleet as an explicit assumption, with a verify-codeshares note. Thus
an equipped-fleet prior is not a verified operator or aircraft assignment.

Skiplagged does not provide an aircraft type. The model uses great-circle
statute miles and explicit candidate cohorts: over **2,500 miles** is long-haul.
Regional and European narrowbody cohorts are short-haul; widebodies are
long-haul; transcontinental/Hawaii-capable narrowbodies stay in both. Broad
model caps exclude 737 / ordinary A321 cohorts above 4,500 miles, 757 above
5,000 and EI A321LR/XLR above 5,500. These are modelling bands, **not** certified
ranges or schedules. Unknown mixed fleets remain candidates at every distance
so that range inference cannot erase uncertainty. Dated route candidate sets
refine QR LHR–DOH and BA LHR–JFK in both directions. QR retains 777, A350,
both 787 types (including conservative substitution candidates) and A380;
BA JFK uses 777-200/-300ER and 787-9/-10, without credit from A350/787-8
aircraft serving other routes. These sets are snapshot assumptions, not live
aircraft assignments. Distance alone never identifies an AS Hawaii flight as
a Hawaiian A330.

Within a compatible cohort, the estimator divides summed equipped aircraft by
summed fleet aircraft. All-compatible-100% or all-compatible-0% needs no invented
weighting. When all candidate counts are known, unknown equipped shares contribute
zero to the numerator and their full aircraft count to the denominator. This
returns `basis: lower-bound` and names each unknown-share sub-fleet in the note;
the evidence shares themselves remain null. Missing candidate denominators still
return unknown. `starlinkMin` compares this lower bound directly, inclusively.
This uniform-aircraft prior is **not a measured route-frequency probability**:
aircraft utilization, sub-fleet deployment and the route’s actual type mixture
can differ. `basis: route` means distance or neighbor-island inference selected
a subset; it does not imply a live route schedule. Aircraft swaps happen, and
connectivity may be unavailable because of outages or regulatory restrictions.
Even `p=1` is an equipped-fleet model value, not guaranteed working internet.

Itinerary `p` is the product over **all flown sectors**, including a return,
assuming independent assignments. An unflown hidden-city continuation does not
participate. Any lower-bound sector makes the product a lower bound too.
**Any unknown flown sector makes the whole result null, even when
another sector is known zero.** Opaque connections without intermediate airports
are unknown rather than applying the whole journey distance to each flight
number. Missing airport geometry also yields null. AA/AT’s pre-installation
zeroes become unknown for departures in 2027, when installation is due to start.
Other numeric values remain explicitly dated snapshot priors, not rollout
forecasts for the requested date.

Illustrative direct sectors using the snapshot and a **November 2026** departure:

| Route / carrier | p | Basis | Explanation |
| --- | ---: | --- | --- |
| LHR–DOH QR | 81.44% | lower-bound | (64 777 + 62 A350 + 32 787-8) / (158 + 26 787-9 + 10 A380); unknown 787-9/A380 shares count as zero equipped. |
| LHR–JFK BA | 0% | lower-bound | 89 candidate 777/787-9/-10 aircraft have unknown equipped shares; no credit from A350/787-8. This does not establish no Starlink on JFK flights. |
| LHR–JFK AA | 0% | route | Mainline installations begin early 2027. |
| SEA–HNL AS | unknown | unknown | Shared AS code / incomplete merged-fleet census. |
| SEA–HNL HA | 89.36% | route | Legacy Hawaiian compatible-aircraft prior: 42 Airbus equipped / (42 Airbus + 5 unequipped 787). |
| LHR–MAD IB | unknown | unknown | Compatible short-haul aircraft counts are unknown. |
| LHR–ORD UA (oneworld off) | 30.84% | route | 313 / 1,015 compatible aircraft; includes transatlantic-range narrowbody candidates under the broad range model. |

For example, two Hawaiian long-haul sectors model as `(42/47)^2 = 79.86%`, so
that return does **not** pass `starlinkMin=0.8`. Explicit unknown operators always
return null rather than inheriting a completed marketing fleet.

Where reports conflict about active fleet scope, the estimator keeps the
uncertainty. For example EI's reported 12/12 completed A330s coexist with a
report of two unequipped A330-200s due to be parked; unverified parking is not
assumed complete, so equipment-unspecified EI long-haul rows remain null.
