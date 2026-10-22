# Sam Toys (sam-toys, sam.toys, toys, playa)

Source inventory reviewed 2026-10-22 at main `03e22483fac6a82a3edd60ac1ccb0f0e10b64838`. Production configuration and current deployment were not inspected by the audit.

Product URL: https://sam.toys (listed in [index.html](../index.html); current production response was not checked).

## What exists

- **IMPLEMENTED** — Sam Toys is the sam.toys index and hosts multiple small product surfaces, defined in [index.html](../index.html).
- **IMPLEMENTED** — The index links product cards for Vroom, Tracks, Voicenotes, Out / London, Co-produce, Phone and Tantra.
- **IMPLEMENTED** — The index also links larger external products including TradeGG, Splittt, Taotime, Hike Fan, Finca, Drift & Sea, DrFit and Seer.
- **IMPLEMENTED** — The repository contains serverless handlers for transcription, London data/refresh, track playlist/OCR, and product-specific routes under [api/](../api/).
- **IMPLEMENTED** — [api/playa.js](../api/playa.js) is a private gallery route; its page documentation says it gates the shell, catalogue, media and shortlist.
- **IMPLEMENTED** — The gallery is designed to fail closed when required server-side configuration is absent; no secret values are stored in this summary.
- **IMPLEMENTED** — [vercel.json](../vercel.json) lists function settings for the repository’s API routes.
- **IMPLEMENTED** — [Testing and private release preflight](TESTING.md) documents reproducible synthetic checks, pinned tooling, and a local source/private-asset manifest. Private guide content remains outside public CI.
- **DEPLOYED** — GitHub records a Preview deployment for commit `ef5c402` on 2026-09-20; that is not confirmation of the current production revision.
- **MERGED** — PRs #15 and #16 redirect `/awakening` and `/awakening/` to knomi.club; their merge commits are `2c621f8` and `5f14468`.

## Gaps

The GitHub deployment data returned Preview records for recent changes but no current production receipt for main. Public availability, external integration configuration, and runtime health are unverified. Playa’s gallery content and related data are intentionally not described here.

## Recent

- 2026-09-20: merged PR #17 (`6935a37`) added the private Playa gallery shell.
- 2026-09-13: merged PR #16 added the trailing-slash `/awakening/` redirect.
- 2026-09-13: merge commit `2c621f8` moved KNOMI to its own repository.
- 2026-09-13: merge commit `a1ab383` updated KNOMI naming, routing and resource links.

## Read deeper

- [index.html](../index.html)
- [API routes](../api/)
- [Playa page contract](../api/_lib/PLAYA-PAGE.md)
- [vercel.json](../vercel.json)
