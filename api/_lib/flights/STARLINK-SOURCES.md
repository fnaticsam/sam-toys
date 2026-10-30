# Starlink evidence ledger

Snapshot: 30 October 2026. Original equipment research was accessed 2026-10-29;
the denominator and route update below was accessed 2026-10-30.
Unknown equipment share does not mean zero installations. If every candidate
aircraft count is known, the estimator now counts unknown shares as zero only
to compute a labelled lower bound; unknown counts still yield null.

## Denominator and route update (30 October 2026)

- QR's [January 2026 primary factsheet, page 3](https://d21buns5ku92am.cloudfront.net/69647/documents/60300-1767676532-Factsheet%20January%202026-506f0e.pdf)
  gives passenger counts: 777 64, A350 62, 787-8 32, 787-9 26, A330 17,
  A380 10. These are dated fleet counts, not a live active-tail census. Completion
  evidence below supplies the 777/A350/787-8 shares; 787-9/A330/A380 stay unknown.
- The [LHR–DOH schedule snapshot, updated 29 October](https://www.flightconnections.com/flights-from-lhr-to-doh)
  shows QR 777/A350/A380 service. The Heathrow model retains both 787 types as
  conservative substitution candidates, and excludes A330, which this schedule
  does not list. This explicitly modelled route cohort gives **158/194 = 81.44%**
  lower bound, counting the 26 787-9 and 10 A380 aircraft as unequipped. A380s
  must not be removed to inflate the result. Other QR long-haul routes retain
  the broad 211-aircraft cohort (**158/211 = 74.88%**). These are aircraft-count
  priors conditional on the cohorts, not bounds on measured route frequency.
- BA's primary fleet pages give [777-200 43](https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-777-200),
  [777-300ER 16](https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-777-300),
  [787-9 18](https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-787-9),
  [787-10 12](https://www.britishairways.com/content/information/about-ba/fleet-facts/boeing-787-10),
  and [A380 12](https://www.britishairways.com/content/information/about-ba/fleet-facts/airbus-a380-800).
  These pages are undated, accessed 30 October; counts include the stated fleet,
  not just Heathrow-based or currently serviceable aircraft.
- The [19 October carrier-specific route snapshot](https://www.flightroutes.com/business-first-class-flights-us)
  lists BA JFK service on 777, 777-300ER, 787-9 and 787-10. The model's 89-aircraft
  cohort has no confirmed installed count, hence **0/89 = 0% lower bound**.
  Do not import the equipped A350 or 787-8 into the JFK numerator. This zero
  lower bound is distinct from AA's confirmed pre-installation zero.

These route cohorts are dated modelling assumptions in both directions, with
aircraft swaps still possible. This update supersedes the earlier recommendation
to return unknown solely because a compatible sub-fleet's equipped share is unknown.

# Starlink research — selected oneworld / IAG carriers

Evidence cutoff and all access dates: **2026-10-29**. Dates below are publication/update dates. Distinguish equipped fleet counts from planned deadlines. No route or aircraft-type availability is guaranteed.

| Carrier | Sub-fleet | Status and equipped share | Source |
|---|---|---|---|
| QR Qatar | B777; A350; B787-8 | Programmes complete (100% of programme sub-fleets), by 2026-08-20; caution not a claim every leased-in aircraft is equipped | [QR release, 2026-08-20](https://www.qatarairways.com/press-releases/en-WW/269475-qatar-airways-150-starlink-equipped-widebody-aircraft-now-include-world-s-first-starlink-equipped-boeing-787-9/) |
| QR | B787-9 | First equipped in July 2026; numeric share unknown. Target end-2026 must not be treated as complete | Same QR release |
| QR | Whole widebody programme | 150 equipped; release says programme exceeds 83% completion. No exact denominator. Do not encode >83% as exact83% | Same QR release |
| QR | A380 / A330 / narrowbodies | Unknown Starlink count/current share; not included in the completed programmes above | [QR onboard page, undated](https://www.qatarairways.com/en/onboard/connectivity.html) describes Starlink only on selected B777/A350/B787 flights |
| AS/HA combined | E175 regional | 93/93,100% as of Oct26 | [Alaska official tracker, updated2026-10-26](https://news.alaskaair.com/alaska-airlines-wifi-connectivity/) |
| AS | B737-800 | 0/59,0% as of Oct26 | Same Alaska tracker |
| AS | B737-8 MAX | 12/20,60% as of Oct26 | Same Alaska tracker |
| AS | B737-900ER | 0/79,0% as of Oct26 | Same Alaska tracker |
| AS | B737-9 MAX | 4/80,5% as of Oct26 | Same Alaska tracker |
| HA / inherited Hawaiian | A321neo | 18/18,100% as of Oct26 | Same Alaska tracker |
| HA / inherited Hawaiian | A330 | 24/24,100% as of Oct26 | Same Alaska tracker |
| AS/HA | B787 Dreamliner | 0/5,0% as of Oct26 | Same Alaska tracker |
| HA | B717 interisland | No onboard Wi-Fi (therefore no Starlink); 0% | [Alaska release,2026-06-25](https://news.alaskaair.com/guest-experience/atmos-rewards-members-unlock-free-inflight-wi-fi-on-alaska-hawaiian-airlines-thanks-to-t-mobile/) explicitly says Hawaiian neighbor-island flights have no Wi-Fi |
| BA | A350 | 18/18,100% as of Oct21 | [PYOK,2026-10-21](https://www.paddleyourownkanoo.com/2026/10/21/flying-on-a-british-airways-airbus-a350-you-are-now-guaranteed-ultra-fast-starlink-wi-fi-as-airline-completes-rollout-across-the-fleet/) |
| BA | B787-8 | 10/12,83.33% as of Oct21 per aviation journalist; newer tracker claims11/12 lack comparable editorial evidence and conflict | Same PYOK Oct21 article |
| BA | Other mainline / Euroflyer | Contracted; present numeric share unknown, no start schedule for787-9 published | [BA launch,2026-03-19](https://mediacentre.britishairways.com/news/19032026/british-airways-first-starlink-flight-takes-off-making-the-airline-the-first-in-the-uk-to-launch-the-fastest-wi-fi-in-the-sky), [PYOK Oct21](https://www.paddleyourownkanoo.com/2026/10/21/flying-on-a-british-airways-airbus-a350-you-are-now-guaranteed-ultra-fast-starlink-wi-fi-as-airline-completes-rollout-across-the-fleet/) |
| BA CityFlyer | E190 | Excluded from rollout; current no Starlink | [PYOK,2026-06-06](https://www.paddleyourownkanoo.com/2026/06/06/british-airways-pauses-ultra-fast-starlink-wi-fi-rollout-until-october-with-just-five-planes-equipped/) |
| AA | All mainline Airbus narrowbodies; Boeing narrowbodies and widebodies | Contracted; installation starts early2027, current0%. >1030 mainline planned (>500Airbus,>400Boeing narrowbody,>130widebody) | [AA primary,2026-10-08](https://news.aa.com/news/news-details/2026/Full-fleet-full-speed-full-connection-American-Airlines-will-bring-Starlink-to-every-mainline-jet-MKG-OB-10/?pubDate=20261008) |
| AA regional | Bombardier / Embraer | No Starlink in present programme. SES multi-orbit on >520 regional jets; not affected by mainline Starlink | [Via Satellite,2026-10-08; updatedOct15](https://www.satellitetoday.com/mobility/2026/10/08/american-airlines-to-adopt-starlink-for-full-mainline-fleet/) |
| IB | A330-300 | First EC-MAA flew MAD-GRU Jun23; installation count/share unknown as of cutoff | [Iberia primary,2026-06-24](https://grupo.iberia.com/news/24062026/iberias-first-aircraft-with-free-high-speed-starlink-wi-fi-takes-off) |
| IB | A321XLR | Starlink advertised for Recife/Fortaleza routes; current type-wide equipped share unknown | [Iberia agent page,2026-10-15](https://agencias.iberia.com/es-es/campanas-y-ofertas/listado/oferta-fortaleza-recife/) |
| IB | Other fleets; short-haul / Iberia Express | IAG contract and IB fleet rollout confirmed, but no current short-haul or Express installed counts verified. Unknown, not0% | [IAG release,2025-11-06](https://www.iairgroup.com/media/j4maszp4/20251106-iag-starlink-partnership-press-notice.pdf), [Iberia launch,2026-06-24](https://grupo.iberia.com/news/24062026/iberias-first-aircraft-with-free-high-speed-starlink-wi-fi-takes-off) |
| AY | All | In talks with Starlink and Amazon; no selected provider/contract or installed share established in searched evidence. Unknown; do not label confirmed no Starlink | [Yle reporting Bloomberg,2026-06-08](https://yle.fi/a/74-20230326); [Finnair official onboard Wi-Fi page,undated](https://www.finnair.com/us-en/in-flight-entertainment-and-wi-fi/wi-fi) |
| EI | Long-haul A330 and A321LR/XLR | All12A330+14A321 long-haul equipped,100%, reportedOct24 | [One Mile at a Time,2026-10-24](https://onemileatatime.com/news/aer-lingus-free-starlink-wi-fi/) |
| EI | Short-haul A320/A320neo | Contracted, next rollout phase; numeric current share unknown | Same Oct24 OMaaT; [EI primary launch,2026-03-29](https://mediacentre.aerlingus.com/pressrelease/details/108/25071) |
| EI Regional (Emerald) | ATR | Explicitly excluded from Starlink contract; no equipped evidence | Same EI primary launch footnote |
| EA Emerald Airlines | ATR / Aer Lingus Regional | Explicitly excluded from EI Starlink programme; no equipped evidence, do not conflate Emerald with the mainline EI fleet | [EI primary launch,2026-03-29](https://mediacentre.aerlingus.com/pressrelease/details/108/25071) |

## Original route cautions (superseded by the 30 October model update above)

- LHR–DOH QR cannot safely be100% based on completed777/A350 programmes. QR's own connectivity page says selected777/A350/787 flights, while a current secondary schedule shows winter daily QR10 onA380. No adequate primary route mixture evidence supports a numeric route probability. Recommend **unknown** without aircraft: [QR onboard](https://www.qatarairways.com/en/onboard/connectivity.html), [secondary schedule accessed2026-10-29](https://zbordirect.com/en/tools/schedule?arrival_city=DOH&departure_city=LON). The airline's [Sep10 winter release](https://www.qatarairways.com/press-releases/en-WW/270452-qatar-airways-expands-global-network-to-over-170-destinations-this-winter-season/) confirms56weekly LHR flights fromOct25 but does not specify fleet mix.
- LHR–JFK BA: known equipped A350/787 counts do not supply a route fleet mixture; **unknown** is defensible. AA **0** as of cutoff because installs begin2027.
- SEA–HNL AS: compatible737 types have different equipped shares, and combinedAScode may include inheritedHawaiian aircraft. Avoid whole combined-fleet rate: E175 cannot operate this oceanic route. **Unknown** unless model has a justified compatible-type weighting. HA A330/A321neo **100%** only when known to be one of those subfleets;787 stays0/5. Do not silently assume HA code guarantees Airbus after merger.
- LHR–MAD IB: no validated compatible-subfleet equipped share; **unknown**, rather than assuming0 or copying35% year-end long-haul target.

## Evidence quality notes

Alaska's authoritative updated tracker takes precedence over the older June release (which says about150equipped and first50mainline and planned787installation). QR150is the latest exact primary count found; laterSep10release only says >150. BA's tracker sites disagree: StarlinkFlights29/261and10/11tail statements, Stardrift14/253, olderJune five; avoid merging these counts or treating undated tracker values as latest airline data. PYOKOct21is explicit18/18A350and10/12B788. OMaaTOct24reports EI's completed long-haul rollout, replacing March launch's planned Q12027target. IB35%byend2026is a target only; no equipped percent should be inferred.


# Other oneworld Starlink research

Research cutoff / every source accessed: **2026-10-29**. A statement that a carrier uses another provider is not proof that every tail lacks Starlink. Do not treat an absence of a release as a 0% installation census. This packet therefore recommends `unknown` except Royal Air Maroc's expressly future rollout. All percentages below concern **Starlink**, not ordinary Wi-Fi.

| Carrier | Sub-fleet | Evidence / status at cutoff | Starlink equipped share | Suggested estimator |
|---|---|---|---|---|
| CX Cathay Pacific | A350; B777/A330/A321neo | No verified Starlink announcement found. Official July 2026 explanation describes two connectivity suppliers and GEO polar outages; general Wi-Fi fleet-wide. | Unknown (alternative services documented, no current Starlink census) | null |
| FJ Fiji Airways | A350 / B737 MAX; A330 | No verified Starlink announcement found. A350 and B737 MAX offered general messaging/browsing Wi-Fi since 2024. | Unknown | null |
| JL Japan Airlines | Mainline A350, B787, B767, B777; B737 | SES contract, **not Starlink**: 20 A350-900 + 10 B787-9 linefit and 11 B787-9 retrofit; linefit starts 2028; earlier B737-8 SES order starts 2027. Current widebody Wi-Fi support names Panasonic; B737 names SES. No verified mainline Starlink announcement found. | Unknown; do not transfer ZIPAIR's 100% to JL | null |
| NU Japan Transocean Air | B737-800 | Gogo 2Ku selected; current JTA site offers free Wi-Fi; no verified Starlink announcement. | Unknown (historic alternative installation not present-day Starlink census) | null |
| MH Malaysia Airlines | A350-900 / A330-900 / selected A330-200,-300 / B737-8 | Current MHconnect coverage on these sub-fleets. B737-8 contract is Viasat Ka-band. No verified Starlink announcement. | Unknown | null |
| WY Oman Air | B787; B737 | Official Wi-Fi only on B787, current conditions name OnAir; no verified Starlink announcement. | Unknown | null |
| QF Qantas | A220 / A321XLR / B737-800 / A330 / B787 / A380 | Viasat programme (official); September 2026 Qantas spokesperson confirms ViaSat-3 F3 trials. No verified Starlink announcement. | Unknown (Viasat documented; not proof of universal zero census) | null |
| AT Royal Air Maroc | B737 + B787 | Official airline page: 41 aircraft contracted; **first installations begin early 2027**. | **0/41 target aircraft, 0% at cutoff**; denominator is contracted programme, not entire airline fleet | 0 (before 2027 only) |
| RJ Royal Jordanian | E2 / A320 / A321 / B787-9; B787-8 | Viasat selected for >40 aircraft. Current official airline says majority Wi-Fi; no verified Starlink announcement. | Unknown | null |
| UL SriLankan | A330-300; A320 | Official A330-300 paid OnAir service; A320 SkyPlus/Everhub is onboard content streaming, not evidence of satellite internet. No verified Starlink announcement. | Unknown | null |

## Sources

- **CX-1**, Cathay Pacific, *How inflight Wi-Fi is made possible*, originally Nov 2023, updated July 2026. https://www.cathaypacific.com/cx/en_TW/inspiration/cathay-stories/how-inflight-wifi-works.html — current description says A350 supplier differs from B777/A330/A321neo; GEO limitations. Accessed 2026-10-29.
- **CX-2**, Cathay Pacific release, 2025-04-08, *Cathay Pacific announces 100% seatback inflight entertainment and 100% Wi-Fi connectivity on all aircraft from August 2025*. https://news.cathaypacific.com/cathay-pacific-announces-100-seatback-inflight-entertainment-and-100-wi-fi-connectivity-on-all-aircraft-from-august-2025-9w00so — does not claim Starlink. Accessed 2026-10-29.
- **FJ-1**, PAX International, *Fiji Airways connects Economy passengers to free inflight Wi-Fi*, undated retrieved PDF (describes Nov 1 launch). https://www.pax-intl.com/assets/pdf/ife-connectivity/connectivity-and-satellites/fiji-airways-connects-economy-passengers-to-free-inflight-wi-fi.pdf — A350/B737 MAX messaging/browsing, generic Wi-Fi. Accessed 2026-10-29.
- **FJ-2**, The Manual, 2024-11-07, *Fiji Airways adds free messaging Wi-Fi for economy passengers*. https://www.themanual.com/travel/fiji-airways-free-wifi-economy/ — dates FJ-1 launch to Nov 1 2024. Accessed 2026-10-29.
- **JL-1**, SES official release, 2026-04-14, *SES, Japan Airlines to Expand Multi-Orbit Inflight Connectivity to Long-Haul Fleet*. https://www.ses.com/news/press-release/ses-japan-airlines-to-expand-multiorbit-inflight-connectivity-to-longhaul-fleet — exact fleet quantities and 2027/2028 start dates above. Accessed 2026-10-29.
- **JL-2**, JAL official current international Wi-Fi service page, undated. https://www.jal.co.jp/en-au/jal-experience/wifi.html — support Panasonic A350/B787/B767/B777; SES B737-800 V40. Accessed 2026-10-29.
- **JL-3**, Via Satellite, Mark Holmes, 2026-10-06, *How 4 Airlines Size Up IFC Offerings from LEO, GEO, to Multi-Orbit*. https://www.satellitetoday.com/mobility/2026/10/06/how-4-airlines-size-up-ifc-offerings-from-leo-geo-to-multi-orbit/ — direct JAL executive interview confirms SES/OneWeb hybrid rationale, not Starlink. Accessed 2026-10-29.
- **NU-1**, Gogo official release, 2015-09-29, *Japan Transocean Air (JTA) Latest to Select Gogo 2Ku*. https://gogoair.mediaroom.com/2015-09-29-Japan-Transocean-Air-JTA-Latest-to-Select-Gogo-2Ku — B737-800. Accessed 2026-10-29.
- **NU-2**, JTA official current website, undated. https://en.jta-okinawa.com/ — free Wi-Fi B737-800. Accessed 2026-10-29.
- **NU-3**, JTA release, 2024-12-19, https://jta-okinawa.com/cms/wp-content/uploads/2024/12/24070.pdf — video streaming enabled on all JTA flights Dec 20 2024; does not claim Starlink. Accessed 2026-10-29.
- **MH-1**, Malaysia Airlines official release, 2023-08-18, *Malaysia Airlines Selects Viasat to Enhance In-Flight Experience On Board Its New Boeing 737-8 Fleet*. https://www.malaysiaairlines.com/nz/en/mh-media-centre/news-releases/2023/enhance-in-flight-experience.html — Viasat factory installation, Ka-band. Accessed 2026-10-29.
- **MH-2**, Malaysia Airlines official current Wi-Fi page, undated. https://www.malaysiaairlines.com/hk/en/experience/in-flight-offerings/wi-fi.html — current MHconnect sub-fleets above. Accessed 2026-10-29.
- **WY-1**, Oman Air official current page, undated. https://services.omanair.com/be/en/inflight-connectivity — only B787 Wi-Fi, MB-capped packages. Accessed 2026-10-29.
- **WY-2**, Oman Air official current conditions, undated. https://services.omanair.com/ca/en/conditions-carriage — OnAir communication services. Accessed 2026-10-29.
- **QF-1**, Qantas official fact sheet, Feb 2024. https://www.qantasnewsroom.com.au/wp-content/uploads/2024/02/Fact-sheet-Investing-in-our-customers.pdf — Viasat rollout A330/B787/A380. Accessed 2026-10-29.
- **QF-2**, Qantas official current Wi-Fi page, undated. https://www.qantas.com/en-au/onboard/entertainment/wifi — lists enabled aircraft and warns swaps; general Wi-Fi not Starlink. Accessed 2026-10-29.
- **QF-3**, Executive Traveller, David Flynn, 2026-09-29, *Qantas switches on high-speed ViaSat Wi-Fi*. https://www.executivetraveller.com/news/qantas-viasat-wi-fi — Qantas spokesperson confirms current ViaSat-3 F3 tests; all B787s fitted, A380 rollout into mid-2027. Accessed 2026-10-29.
- **AT-1**, Royal Air Maroc official current page, undated. https://www.royalairmaroc.com/lr-en/connectivity — 41 B737/B787, first installations early 2027, no tail schedule. Accessed 2026-10-29.
- **AT-2**, AeroSillage, 2026-10-07, *Royal Air Maroc bets on Starlink to set the pace for African inflight Wi-Fi*. https://aerosillage.com/en/royal-air-maroc-starlink-africa-inflight-wifi-2027/ — announcement date Oct 7, selected 41, start Q1 2027. Accessed 2026-10-29.
- **RJ-1**, Viasat official release carried by PRNewswire, 2024-03-14, *Royal Jordanian Airlines to Elevate Passenger Experience with Viasat's State-of-the-Art In-flight Wi-Fi Across Multiple Fleets*. https://www.prnewswire.com/news-releases/royal-jordanian-airlines-to-elevate-passenger-experience-with-viasats-state-of-the-art-in-flight-wi-fi-across-multiple-fleets-302088822.html — >40 E2/A320/A321/B787-9. Accessed 2026-10-29.
- **RJ-2**, Royal Jordanian official current page, undated. https://www.rj.com/en/fly-rj/crown-class/in-flight-entertainment — majority flights Wi-Fi, free Crown/elite. Accessed 2026-10-29.
- **RJ-3**, Viasat current Royal Jordanian terms, undated. https://www.viasat.com/legaldocs/rja/en-us/termsofservice/ — confirms live Viasat service. Accessed 2026-10-29.
- **UL-1**, SriLankan official current page, undated. https://onboard.srilankan.com/en_uk/flying-with-us/in-flight-wifi — A330-300 OnAir. Accessed 2026-10-29.
- **UL-2**, SriLankan official current FAQ, undated. https://onboard.srilankan.com/en_uk/Corporate/faq-details?type=1 — expressly identifies OnAir provider. Accessed 2026-10-29.

## Rejected evidence / traps

StarlinkFlights claims JL has committed to Starlink based on unspecified internal notes, while SES's dated official contract and JAL executive interview identify a different network. It also claims RJ has no internet, contradicted by both RJ and Viasat. These trackers must not establish carrier-wide percentages. Same concern for generic trackers' total fleet denominators. FJ annual report mentions Starlink **at Rotuma airport for ground operations**, not onboard: https://parliament.gov.fj/wp-content/uploads/2026/03/11Fiji-Airways-Annual-Report-2024-2.pdf (2024 report, posted 2026; accessed 2026-10-29).

Bonus primary evidence for parent: ZIPAIR is separate from JL. Airline release dated 2026-05-08 confirms 8/8 B787-8 fully fitted: https://zipair-pdf.s3-ap-northeast-1.amazonaws.com/a8ef04b6-ca0f-4bf3-9d45-372bd86f06b12026-05-08T03%3A11%3A41.pdf (accessed 2026-10-29). Never map this to JL/NU.


# Non-oneworld Starlink evidence

Research cutoff/access date for every source below: **2026-10-29**. Figures describe their stated evidence dates, not an extrapolated October fleet. Do not assume a target was met. Tracker sites disagree severely (airBaltic complete vs 56%; Air France15% vs60%); prefer the dated sources below.

| Carrier | Subfleet | Status and equipped share | Evidence date | Source |
|---|---|---|---|---|
| United UA | CRJ550 |100/100 (100%)|2026-10-29|UA1|
|UA|E175|252/252 (100%)|2026-10-29|UA1|
|UA|737 non-MAX|193/328 (58.84%)|2026-10-29|UA1|
|UA|737 MAX|46/300 (15.33%)|2026-10-29|UA1|
|UA|A321 family|68/77 (88.31%)|2026-10-29|UA1|
|UA|777|4/96 (4.17%)|2026-10-29|UA1|
|UA|787|2/100 (2%)|2026-10-29|UA1|
|UA|A319, A320,757,767|Not installed yet ('Coming soon'); denominators67,62,61,53|2026-10-29|UA1|
|Air France AF|777-300ER|28/31 (90.32%)|early June2026|AF1|
|AF|A220-300|45/56 (80.36%)|early June2026|AF1|
|AF HOP|E190|24/30 (80%)|early June2026|AF1|
|AF|A350-900|30/41 (73.17%)|early June2026|AF1|
|AF|A320|3/28 (10.71%)|early June2026|AF1|
|AF|A321,777-200ER,787-9,E170|Not installed as of June; October current shares unknown|early June2026|AF1|
|AF|A318,A319,A330-200|No Starlink planned: retire by spring2027|2026-06-24 report|AF1|
|Air New Zealand NZ|Domestic A320 (ZK-OXE), ATR|Trial; oneA320 live June10, ATR expected that month. Current equipped count/share unknown|2025-06-10|NZ1,NZ2|
|NZ|International jets|No Starlink rollout established by these domestic trial sources; unknown, not zero|2026-10-29 research|NZ1,NZ2|
|WestJet WS|737 MAX8/737-800|At least100 installed (Oct9 2025); current official page says over100 across737 fleet. Reliable contemporaneous denominator by type unavailable => share unknown|2025-10-09, live2026-10-29|WS1,WS2|
|WS|787-9|Contracted; end2026 target; installed share unknown, do not mark completed|2024-07-24 announcement|WS3|
|airBaltic BT|A220-300|28 equipped throughMarch2026; Q1 58% of network flights (NOT fleet share). Presentation says53 airframes Q1 implied by55 current minus2 deliveries afterQ1; can report28 count without denominator to avoid mixing dates. Oct share unknown|2026-03-31|BT1|
|Emirates EK|777+A380|53/232 retrofit-program airframes (22.84%)|2026-09-15|EK1|
|EK|777; A380 individually|33 777 and3 A380 installed; individual type denominator not given|2026-07-02|EK2|
|EK|A350|Not proven installed by primary research; unknown. Other trackers cite planned replacement of Viasat but need source if used|2026-10-29 research|EK1,EK2|
|Virgin Atlantic VS|A350|Whole A350 fleet (100%); source does not give denominator|live page accessed2026-10-29|VS1|
|VS|787,A330neo|Contracted rollout; current counts unknown;2027 finish remains target|live page, original announcement|VS1,VS2|
|TAP TP|All|Unknown: no verified Starlink contract/install announcement found. A330neo/A321LR onboard WiFi source does not identify Starlink; absence of announcement is not proof of zero|research2026-10-29|TP1|
|Delta DL|All|No Starlink: explicitly declined partnership; choseAmazon Leo for500 aircraft starting2028. Current Viasat/Hughes|2026-10-09|DL1,DL2|
|Scandinavian SAS SK|A320neo|81/81 (100%)|2026-09-01|SK1|
|SK|Remaining aircraft types|Preparations/nextphase; more installations planned later2026; equipped counts unknown|2026-09-01|SK1|
|Air Canada AC|Jetz A320 charter|4/4 equipped; charter not normal scheduled mainline|2025-09-11|AC1|
|AC Express Jazz|Dash8-400|9 planned forYTZ-YOW/YUL; first being fitted September2025, October target. Current completion unverified: unknown share. 25 is cabin-refit scope, NOT installed denominator|2025-09-17|AC2,AC3|
|AC|Scheduled mainline|Mainline no Starlink indicated by specialist tracker; do not assert entireAC zero because Jetz/Q400 exception. Conservative scheduled-row probability unknown without operator/equipment|research2026-10-29|AC1,AC2,AC3|
|ZIPAIR ZG|787|8/8(100%), CEO confirmed completed atCAPA summit|2026-07-29|ZG1;ZG2 confirms contract and fleet8 before rollout|

## Source registry (all accessed2026-10-29)

- UA1: United official Starlink tracker. Updated2026-10-29 at4:01amCST. https://starlinktracker.united.com/program/starlink .665total installed;352regional307narrowbody6widebody. Per-family counts are preferable to headline44% whose denominator includes policy selection.
- AF1: One Mile at a Time, Ben Schlappig, published2026-06-08, updated2026-06-24. https://onemileatatime.com/news/air-france-free-starlink-wi-fi/ .Dated subfleet counts trace to Stardrift, not airline audited inventory. Total nearly60% atJune; target end2026.
- AF2: Air France primary launch release2025-09-08. https://corporate.airfrance.com/en/news/complimentary-high-speed-wifi-now-available-board-air-france-flights .ConfirmsStarlink,firsttwoE190,twoA220,firstA350;30%end2025 and wholefleet end2026 are targets in this release.
- NZ1: AirNewZealand primary trial announcement2023-12-13. https://www.airnewzealandnewsroom.com/press-release-2023-air-new-zealand-working-with-starlink-to-redefine-domestic-travel .Domesticjet+ATRtrial; expansion conditional on trial.
- NZ2: Airline2025-06-10release syndicated unedited byPublicTechnologies. https://ebs.publicnow.com/view/EC7511662B4E949F8CAC3D90265793A25D44D11E .ZK-OXEliveJune10;ATRlatermonthtarget.
- WS1: WestJet primary2025-10-09release. https://westjet.mediaroom.com/2025-10-09-SKY-HIGH-STREAMING-ALERT-WestJet-equips-its-100th-aircraft-with-WestJet-Wi-Fi%2C-presented-by-TELUS%2C-free-for-WestJet-Rewards-members .100737sinstalled.
- WS2: WestJet currentFAQ, undated. https://www.westjet.com/en-ca/help/westjet-wifi .Over100737s,flightguidewithin72hours.
- WS3: WestJet partnership primary2024-07-24 (URL year2024; page date not exposed in parsed text). https://www.westjet.com/en-ca/news/2024/westjet-and-telus-form-partnership-to-revolutionize-guest-experi .Narrowbodytargetend2025;widebodyend2026.
- BT1: airBaltic Q12026investorpresentation,2026-05-13,p9. https://a.storyblok.com/f/236210/x/bc36fc220f/air-baltic-corporation-2026-q1-results-presentation.pdf .28installedthroughMarch,58%networkflights.Not100%;conflictingtrackers shouldnot overrule this datedprimary.
- BT2: airBaltic current service page, undated. https://www.airbaltic.com/en/extra-services/fast-and-free-internet-on-board .Confirms activeStarlinkA220butparsedtextdoesnotconfirmfleetcompletion.
- EK1: EmiratesNewsAgencyWAM,2026-09-15. https://www.wam.ae/en/article/c29cjlf-emirates-connects-aircraft-starlink-targets-232 .53connected/232programscope;14permonth ispace,notlicense toextrapolatecount.
- EK2: Emirates primary2026-07-02. https://www.emirates.com/media-centre/one-million-connections-and-counting-emirates-customers-embrace-starlink-wi-fi/ .33B777+3A380 active.
- VS1: VirginAtlantic officialcurrentconnectivitypage,undated. https://www.virginatlantic.com/experience/inflight-entertainment/connectivity/starlink .ExplicitentireA350fleetnow;remainingrollout2027.
- VS2: VirginAtlantic primaryoriginalannouncement,2025-07-08 (dateconfirmedsearchcontext,notparsedpage). https://www.virginatlantic.com/corporate/media/press-releases/wi-fly-virgin-atlantic-becomes-the-first-uk-airline-to-announce-free-fleet-wide-starlink .OriginalQ32026startwas supersededbyMay2026launch;donotuseoldstarttosaynotlive.
- TP1: TAP official Airchannel onboardguideOct2024. https://www.flytap.com/-/media/Flytap/AIRchannel/Airchannel_20241001_100.pdf .WiFionA330neo/A321LRonly;not evidenceforStarlinkzero.No reliablecurrentStarlinknegativefound.
- DL1: Delta primary2026-03-31. https://news.delta.com/delta-amazon-leo-sign-agreement-deliver-next-era-connected-travel-and-digital-experiences .Initial500aircraftLeo2028.
- DL2: TravelWeeklyRobertSilk2026-10-09. https://www.travelweekly.com/Travel-News/Airline-News/Delta-CEO-addresses-Starlink-WiFi-controversy .CEOconfirmsdecliningStarlink;Viasat/Hughesexisting.
- SK1: SAS primary2026-09-01. https://www.sasgroup.net/newsroom/press-releases/2026/sas-completes-starlink-installation-across-entire-airbus-a320neo-fleet-in-just-six-months/ .81/81A320neo,around70%fleet;otherpreparationsplanned.
- AC1: PaxEx.Aero,SethMiller2025-09-11. https://paxex.aero/air-canada-jetz-starlink-service/ .4JetzA320sequippedsummer2025.
- AC2: PaxEx.Aero,SethMiller2025-09-17. https://paxex.aero/air-canada-q400-starlink/ .9plannedQ400,firstbeingfitted,Octoberentrytarget.
- AC3: AirCanada primary2025-09-17. https://www.aircanada.com/media/air-canada-elevates-the-regional-flying-experience-with-reimagined-q-400-amenities-offering-new-standards-of-comfort/ .25cabin-refits;WiFiselectaircraft;nevernamesStarlink.SpecialistAC2identifieshardware.
- ZG1: CAPA2026-07-29,quotingCEOatCAPAAirlineLeaderSummit. https://centreforaviation.com/news/zipair-ceo-we-completed-installation-of-starlink-inflight-connectivity-on-entire-fleet-1367868 .Alleight787scomplete.
- ZG2: ZIPAIR primary2026-02-25PDF. https://zipair-pdf.s3-ap-northeast-1.amazonaws.com/7552e71c-89d5-4daa-b75e-5aa255aa4d602026-02-25T12%3A22%3A43.pdf .Fleet8;installstartedFeb,completionspringtarget(supersededbyCAPAconfirmation).

## Conservative resolution of conflicting evidence

Aer Lingus' October 24 completion report above describes **12/12 active A330s**
and **14/14 A321LR/XLRs**. A separate [InsideFlyer report, published 2026-10-24,
accessed 2026-10-29](https://www.insideflyer.com/posts/aer-lingus-nears-starlink-coverage-across-transatlantic-fleet/)
says two A330-200s remained unequipped and were *due* to be parked. Their actual
removal from the active/standby fleet is not established here. The data preserves
the reported completed cohort but includes an additional unknown-scope A330-200
record, making equipment-unspecified EI long-haul rows **unknown**. It does not
assume a planned parking date proves retirement or excludes a possible swap.
