# fnaticsam/sam-toys (sam.toys, playa, sam-toys, samfun): checked 2026-10-31

## What exists

- Sam Toys index: The sam.toys index hosts multiple small product surfaces. IMPLEMENTED `index.html`
- Product cards: The index links Vroom, Tracks, Voicenotes, Out / London, Co-produce, Phone and Tantra. IMPLEMENTED `index.html`
- External products: The index links TradeGG, Splittt, Taotime, Hike Fan, Finca, Drift & Sea, DrFit and Seer. IMPLEMENTED `index.html`
- Serverless routes: The repository contains transcription, London, track playlist, OCR and product-specific handlers. IMPLEMENTED `vercel.json`
- Playa gallery: The private gallery gates the shell, catalogue, media and shortlist. IMPLEMENTED `api/_lib/PLAYA-PAGE.md`
- Playa downloads: Sam can download photos at 2048, 4096 or original size, and a shortlist as a zip. MERGED #21
- Gemini cost guard: Anonymous calls to transcription and track OCR are refused. MERGED #22
- Awakening redirect: `/awakening` redirects to knomi.club. MERGED #15
- Flights search: sam.toys/flights searches oneworld and BA-partner fares ranked by estimated £ per tier point. MERGED #26
- Flights results: Flight cards show tier points and an oneworld toggle that can add other airlines. MERGED #30
- City search: Flights searches whole cities and pulls up to 100 flights. MERGED #31
- Flights filters: Results carry sourced Starlink Wi-Fi likelihood. MERGED #35
- Pull-request checks: Pull requests run site tests and the flights browser check in parallel. MERGED #37

## Gaps

- Production receipt: Current production revision and runtime health are unverified.
- External integrations: Configuration and public availability are unverified.
- Playa content: Gallery content and related data are intentionally not described here.

## Recent

- 2026-10-30: Flights received the v4 design with origin pills, calendar, nearby dates, filters and animation. MERGED #38
- 2026-10-30: Pull requests began running site tests and the flights browser check in parallel. MERGED #37
- 2026-10-30: Flights results added sourced Starlink Wi-Fi likelihood. MERGED #35
- 2026-10-29: Flights added city search and up to 100 results. MERGED #31
- 2026-10-29: Turning off oneworld adds other airlines rather than hiding BA partners. MERGED #30

## Read deeper

- `README.md`
- `index.html`
- `api/_lib/PLAYA-PAGE.md`
- `vercel.json`
