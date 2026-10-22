# Private Playa gallery

The single function `api/playa.js` gates the shell, catalog, media, shortlist and downloads.
The shell is generic, committed, and bundled with the function; it contains no
gallery records. All data is fetched after admission. No external scripts,
fonts or styles are loaded.

## Environment names

- `PLAYA_PASSWORD`
- `PLAYA_TRUSTED_IPS` (optional)
- `PLAYA_READ_WRITE_TOKEN`

Use an independent password and a dedicated **private** Blob store. No values
belong in this repository. Missing password fails every route closed. Missing
store credentials or an unpublished catalog leave the shell available with a
“Gallery not published yet” message. Trusted addresses are an explicit password
bypass; an unset or empty `PLAYA_TRUSTED_IPS` admits nobody by IP. Production
leaves this variable unset for now. Only the platform's connection-derived `x-real-ip` is consulted.

## Blob layout contract

- `catalog/catalog.json`: `{version, generated_at, years, photos}`. A photo has
  `{id, y, w, h, t, tags, score, pick, sel, sel_src, burst, sens}`. Optional
  `reason` (or `note`) appears beside the score. `id` is lowercase SHA-256 hex.
  Years may be scalar years or objects with `y`; no year or photo data is built in.
- `thumb/<aa>/<id>.webp` and `preview/<aa>/<id>.webp`: first two ID characters
  supply `<aa>`.
- `state/shortlist.json`: `{ids, updated_at}`. The Blob ETag is returned separately
  to clients. A missing object reads as an empty shortlist; first creation uses
  `allowOverwrite: false`. Updates use `allowOverwrite: true` with Blob `ifMatch`.
  Reads bypass the CDN cache so a conflict retry sees the latest state.
  PUT accepts up to 5,000 IDs within a 384 KiB JSON body (5,000 compact IDs
  require 335,009 bytes). Both item and byte limits remain enforced.
- `dl/2048/<aa>/<id>/playa-<year>-<first 10 hex of id>.jpg`: prebuilt private
  JPEG, written by the box. The gate gets `<year>` from the current published
  catalog and signs only that exact object for a published ID. Year labels are
  four digits when available, otherwise `unknown`; a missing or invalid year
  never excludes a published ID from downloads or exports. Ready photo filenames
  use the same year-label rule. The gallery keeps otherwise valid undated photos
  in an “Unknown year” group at `#year/unknown`, including shortlist labels.
- `exports/req/<rid>.json`: gate-written `{v:1,rid,kind,size,ids,created_at}`.
  `rid` is 32 lowercase hex from a CSPRNG. `kind:photo` accepts exactly one ID
  and `4096` or `original`; `kind:zip` accepts 1–2,000 unique IDs and `2048`,
  `4096` or `original`. Every ID must be in the current published catalog.
  Writes use `allowOverwrite:false` with no random suffix.
- `exports/status/<rid>.json`: box-written `{v:1,rid,state,done,total,error?,
  file?:{path,bytes,name},updated_at,expires_at}`. States are `queued`, `building`,
  `ready`, `failed`. Only fixed error codes reach the browser: `invalid-request`,
  `not-published`, `integrity`, `too-large`, `busy`, `internal`.
- `exports/out/<rid>/<name>`: box-built download. Photo basenames follow
  `playa-<year>-<first 10 hex of id>.<ext>` (`jpg` for rendered copies, lowercase
  original extension otherwise). Zip basenames follow
  `playa-shortlist-<YYYY-MM-DD>-<size>.zip`; entries follow `<year>/<photo basename>`.
  No source names or paths belong in any of these objects. The box enforces the
  25 GB source-total limit, integrity of reconstructed originals, and removes
  request, status and output objects 24 hours after a terminal state.

Blob SDK 2.6.1 exposes the operations used here: `get`, `put`, `list`,
`issueSignedToken`, `presignUrl`. Catalog reads stream through the function;
media redirects use private, path-scoped, GET-only grants expiring in five
minutes. Thumb and preview signing checks a per-instance cached set of published
IDs, refreshed at most once every 60 seconds. Concurrent checks share a refresh;
failed refreshes fail closed. Unknown IDs return 404 without a grant. Publication
removals take effect on the next refresh; existing grants remain valid until expiry.
A signed URL is a temporary bearer capability: anyone receiving it
can fetch that one derivative until expiry, including after password rotation.
This is the specified signed-media design, not revocable per-request media auth.
Never log these URLs. The signing material and store credential stay server-side.

## Download routes

All routes use the existing password-session admission, raw pathname rules and
privacy headers. Anonymous requests return 401 before any store access; missing
password returns 503. Authenticated unsupported methods return 405 with `Allow`.
GET routes also accept HEAD, suppressing its body as existing routes do.

| Route | Method | Result |
| --- | --- | --- |
| `/playa/m/dl/2048/<id>.jpg` | GET, HEAD | 302 to an exact-object, GET-only signed URL, valid five minutes, with `download=1`; private max-age 300 |
| `/playa/api/export` | POST | Same-origin JSON `{kind,size,ids}` creates a request; 202 `{rid}` |
| `/playa/api/export/<rid>` | GET, HEAD | Uncached status; ready includes `{state,done,total,url,bytes,name}` with an exact-object download URL valid until the earlier of five minutes or `expires_at` |

Malformed IDs/RIDs or raw paths return 404 without Blob calls. Invalid export
payloads return 400 `invalid-request`, malformed JSON returns 400 `invalid-json`,
unpublished IDs return 400 `not-published`, and non-JSON writes return 415
`content-type`. POST uses the shortlist's same-origin evidence rule; rejected
origins return 403 `cross-site`. Export bodies are capped at 256 KiB (413
`invalid-request`). Eight unfinished requests per function instance cause 429
`export-busy`. At least 100 retained objects under `exports/req/` also cause 429
`export-busy`, before any status is read.

Only `exports/req/` is listed, including pagination, stopping at 100 objects;
missing/queued/building statuses count as unfinished. Terminal requests do not
consume unfinished capacity, but count toward the retained-object bound.
Admissions are serialized within a store instance. **Known contract limitation:**
the frozen random-RID request layout supplies no shared atomic reservation key.
Concurrent admissions in separate serverless instances can both observe spare
capacity and exceed eight. This per-instance cap is accepted for this single-user
gallery; the box processes one request at a time. Strict global enforcement needs an agreed coordination
object or transactional service; neither is added by this packet.
Status reads use batches of at most 16 and examine at most 99 retained requests.
The 100-object bound caps admission cost during the box's 24-hour retention window.
Thumb and preview signing checks the published catalog through a per-instance cache refreshed at most
every 60 s, so a newly hidden photo can stay signable (and a newly published one return 404) for up to a
minute; accepted for this single-user gallery.

Missing status plus a request returns `{state:"queued"}`; neither returns 404
`not-found`. Valid statuses expose only state and bounded progress; failed adds
a fixed error code (unknown codes become `internal`). Past `expires_at` maps to
`{state:"expired"}` without signing. Ready statuses require a valid matching
request, currently published IDs, complete progress, a positive byte count, a
safe contract basename, and exactly `exports/out/<rid>/<name>`. Orphan or invalid
status/request records fail closed with the existing generic private 503.

## SDK download-name finding

Checked the **installed 2.6.1** `PresignGetUrlOptions`, `presignUrl`,
`getDownloadUrl`, and GET URL builder in `node_modules/@vercel/blob/dist/`.
`getDownloadUrl` adds `download=1` for attachment disposition. GET presigning has
no filename or content-disposition override; adding the download switch retains
the existing path/operation signature. See the official
[SDK source](https://github.com/vercel/storage/blob/main/packages/blob/src/helpers.ts)
and [signed URL documentation](https://vercel.com/changelog/signed-urls-are-now-available-for-vercel-blob).
No live store was contacted to test CDN behavior.

Queued objects and prebuilt 2048 objects use the required safe basename.
Because Blob SDK 2.6.1 has no GET filename override, the prebuilt 2048 object
path itself supplies `playa-<year>-<short hash>.jpg` when `download=1` is used.

The inline UI offers one Download disclosure per photo and shortlist with
`2048 px`, `4096 px` and `Original` choices. Jobs snapshot selected IDs and show
`Preparing…` for a photo or `Preparing… done/total` for a shortlist. A ready job
starts its download automatically once and retains a visible Save file fallback
link. Escape closes an open size menu before closing the viewer.
Recoverable status failures retain the RID and selection. Network errors, 408,
429 and server errors retry after 2, 4, 8, 16 and 30 seconds, then pause with a
“Resume status” action for the same RID. New export submission stays disabled
until the job reaches a terminal status; resuming never repeats its POST.
Authentication and other client errors stop automatic polling. A stale ready
link is used only after a successful status refresh. Jobs remain in memory:
page reload and an uncertain initial POST response still need a future recovery
contract, not an automatic retry of an expensive build.
No browser fetch buffers the built file. No cancellation or extra backend path
is introduced; the box owns expiry. The existing CSP and script nonce remain.

## Routing evidence

The handler uses the raw pathname from `req.url`, without normalizing dot segments
or decoding slashes. It ignores original-path headers and query routing hints.
Vercel's Node dev proxy preserves `origUrl.pathname` when invoking functions,
merging only routing query parameters. The Node handler passes `request.url`
through to the function. Sources:

- [Vercel CLI function invocation](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/dev/server.ts)
- [Vercel Node handler](https://github.com/vercel/vercel/blob/main/packages/node/src/serverless-functions/serverless-handler.mts)
- [Vercel rewrite configuration](https://vercel.com/docs/project-configuration/vercel-json#rewrites)

`tests/playa/routing-check.js` runs the three rewrites through Vercel's routing
compiler and models that invocation path. Forged routing hints are covered by
the endpoint security suite. A real preview rewrite check remains part of the
owner's deploy validation; this packet does not deploy. Direct function hits
use the same admission rule. Unauthenticated non-login requests return 401;
unsupported methods return 405 only after admission.

## Deploy order (owner action; not performed by this packet)

1. Complete independent security review and the packet's local gates.
2. Create the private store and configure the environment names above. Publish
   the catalog and the two derivative sizes through the separate publisher.
   Publish prebuilt downloads and enable the separate box worker before relying
   on download controls. Originals use authorized, exact-object download links.
3. Deploy the function and bundled shell through the existing toys workflow.
4. Check original-path routing on a preview, then verify anonymous GET and HEAD
   requests cannot retrieve any catalog or media data. Check password login,
   private media redirects, shortlist conflict retries and mobile navigation.

Rotate the password by changing `PLAYA_PASSWORD` through the existing environment
workflow and activating that configuration. This invalidates all HMAC cookies;
trusted addresses still bypass password login. Cookies otherwise expire after
90 days. Logout clears the cookie at `Path=/playa`. Login failures wait 400 ms;
this is defence in depth, not distributed rate limiting.

## Deliberately absent from git

Photos, catalog records, private source paths, camera filenames, personal names,
store identifiers, credentials, and all generated derivatives are private runtime
data. Shortlists also live only in the private store. The publisher, export processor and connection to the source machine remain
outside this repository. The gate handles download admission and queue requests;
the separate box worker builds larger renders, originals and zips.

Tests generate synthetic IDs and data at runtime. The public scan calls the
unchanged dev secret scanner and adds catalog/image identifier checks, suppressing
matching content. Browser and routing checks use optional test tools installed
outside the repo, via `NODE_PATH`; no application dependency changes are needed.

## Outcome and transition coverage

Names below are the separately reported checks. Catalog, media and shortlist
checks live in `tests/playa/store.test.js`; rotation and no-leak checks live in
`tests/playa/security.test.js`; gate checks live in `tests/playa/gate.test.js`.

| Input or event | Outcome | Persisted | Retry rule | Covering check |
| --- | --- | --- | --- | --- |
| Unauthenticated private route | 401; zero store calls | Nothing | Log in | `no-leak sweep: <route>` |
| Correct password POST | 303 and scoped cookie | Stateless cookie | None | `gate parity: correct POST redirects and issues scoped 90-day HMAC cookie` |
| Wrong password POST | Delayed 401 | Nothing | Delayed retry | `gate parity: wrong delayed at least 390 ms` |
| Trusted connection address | 200 and cookie | Stateless cookie | None | `gate parity: trusted x-real-ip issues valid cookie, including HEAD` |
| Missing password | 503 on every route | Nothing | Configure password | `gate parity: missing secret returns 503 on every route with zero store calls` |
| Missing store token | Data 503; shell available | Nothing | Reload after configuration | `store-error: missing Blob token fails data closed while shell loads` |
| Store error | Generic private 503 | Nothing | Reload | `store-error: upstream failures are private generic 503s, shell still loads` |
| Invalid media ID | 404; zero store calls | Nothing | None | `media id table: <invalid path>` |
| Stale shortlist ETag | 412 | Nothing | Refetch, merge, retry once | `shortlist: stale If-Match returns 412 and changes nothing` |
| Cross-site shortlist PUT | 403; zero writes | Nothing | None | `shortlist cross-site PUT: cross-site` |
| Logout | 303 and cleared cookie | Cookie removed | Log in again | `gate parity: logout clears the scoped cookie` |
| Authenticated catalog GET | 200, JSON and ETag | Nothing | Revalidate | `catalog: authenticated GET 200 with ETag` |
| Catalog GET with matching ETag | 304, no body | Nothing | Reuse catalog | `catalog: authenticated If-None-Match returns 304` |
| Authenticated thumb GET | 302, exact constructed signed pathname, private max-age 300 | Nothing | Fetch signed URL | `media: authenticated thumb GET 302 exact signed pathname and max-age 300` |
| Authenticated preview GET | 302, exact constructed signed pathname, private max-age 300 | Nothing | Fetch signed URL | `media: authenticated preview GET 302 exact signed pathname and max-age 300` |
| Authenticated shortlist GET | 200, IDs, timestamp and ETag | Nothing | None | `shortlist: authenticated GET returns empty state` |
| Successful shortlist PUT then GET | 200; order retained, duplicates removed | Private shortlist | None | `shortlist: authenticated PUT then GET keeps order and removes duplicates` |
| PUT with wrong content type | 415; zero writes | Nothing | Correct type | `shortlist validation: wrong content type has zero writes` |
| PUT stream exceeds byte cap before end | 413 before request completion; zero writes | Nothing | Smaller request | `shortlist validation: oversized stream rejected before end with zero writes` |
| PUT with bad ID | 400; zero writes | Nothing | Correct ID | `shortlist validation: bad id has zero writes` |
| PUT with more than 5,000 valid IDs | 413 (also exceeds byte cap); zero writes | Nothing | Fewer IDs | `shortlist validation: more than 5,000 valid ids has zero writes` |
| PUT with malformed JSON | 400; zero writes | Nothing | Correct JSON | `shortlist validation: malformed JSON has zero writes` |
| Password rotation, old cookie on private routes | 401; zero store calls | Nothing | Log in again | `password rotation: old token rejected on every private route with zero store calls` |

`tests/playa/browser-check.js` separately reports `browser: keyboard navigation`,
`browser: focus trap`, `browser: focus restore`, `browser: keyboard shortlist persistence`,
and `browser: shortlist conflict refetch merges concurrent addition and retries once`.
The rotation sweep covers GET and HEAD on every private endpoint, plus unauthorized
write methods and malformed/direct paths. Login and logout remain their existing
explicit exceptions; this round does not change either behavior.
