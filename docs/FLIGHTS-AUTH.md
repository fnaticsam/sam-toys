# Flights account sign-in integration

This packet adds server-side Sam ID sign-in for private Flights account APIs.
The public flight search, UI and existing files are untouched. These changes
remain uncommitted and are not deployed.

## Routes

| Method and public path | Function |
| --- | --- |
| `GET /flights/login` | `api/flights-login.js` |
| `GET /flights/callback` | `api/flights-callback.js` |
| `POST /flights/logout` | `api/flights-logout.js` |
| `GET /api/flights-account/me` | `api/flights-account/me.js` |

Login and callback redirect with 303; successful callback and logout return
to `/flights`. There is no user-controlled return URL. `/me` returns
`{ "signedIn": false }` for missing/invalid sessions, or
`{ "signedIn": true, "name": "Sam" }` for the issuer's verified `sub: sam`.
Missing configuration gives 503 even for anonymous `/me` requests. Wrong
methods return 405 and `Allow`; responses and redirects have private no-store
and no-referrer headers and emit no CORS permission.

Future private account routes must call:

```js
const { requireSamSession } = require('../_lib/flights-session');
// Before any account data access, paid provider work or side effects:
const session = requireSamSession(req);
```

The helper returns `{ sub: 'sam', name: 'Sam' }`, throws with `statusCode: 401`
when unauthenticated, and throws with `statusCode: 503` for invalid/missing
configuration. Callers must return generic errors with private no-store
headers. Future mutating account APIs also need same-origin/CSRF checks.
This packet does not implement BA storage, reward search or booking choices.

## Sam ID registration

Append this object to the issuer project's existing `SAM_ID_CLIENTS` array;
preserve all other registered clients:

```json
{
  "client_id": "sam-toys-flights",
  "name": "Sam Toys Flights",
  "redirect_uris": ["https://sam.toys/flights/callback"],
  "secret_sha256": "<SHA-256 hex of the separately provisioned client secret>"
}
```

The placeholder is intentionally invalid until replaced through an approved
secret-provisioning action. This task generates/stores no real credential.
The tests generate ephemeral credentials and ES256 keys in memory only.

## sam-toys Vercel environment

Set these server-side variables on the `sam-toys` project for the intended
deployment environment. Never use a browser/public prefix:

| Variable | Value |
| --- | --- |
| `SAM_ID_ISSUER` | `https://id.sam.toys` |
| `SAM_ID_CLIENT_ID` | `sam-toys-flights` |
| `SAM_ID_CLIENT_SECRET` | Separately provisioned secret matching the registration hash |
| `FLIGHTS_SESSION_SECRET` | Independent strong random secret, at least 32 bytes |
| `FLIGHTS_REDIRECT_URI` | `https://sam.toys/flights/callback` |

All five are required for every route and session verification. Issuer must
be an HTTPS origin without a trailing slash. Redirect URI must be an HTTPS
URL at `/flights/callback`, without query, fragment or userinfo. HTTP loopback
URLs are accepted only outside production and Vercel for local fake-issuer
tests. Preview sign-in requires its own registered exact redirect URI and
corresponding environment; production registration alone does not authorize
a preview callback. Requests must arrive on the configured redirect origin;
forwarded host headers cannot select it. Vercel supplies the trusted
`x-forwarded-proto` header; other proxies must overwrite it themselves.

## Vercel wiring to apply during integration

No edit was made to `vercel.json`. Merge these properties into its existing
function list and rewrite array, preserving the other entries. The nested
locked dependency must also be installed (or move `jose: 6.2.3` into the root
manifest and lockfile in a separate integration change):

```json
{
  "installCommand": "npm ci && npm ci --prefix api/_lib/samid",
  "functions": {
    "api/flights-login.js": { "maxDuration": 10 },
    "api/flights-callback.js": { "maxDuration": 30 },
    "api/flights-logout.js": { "maxDuration": 10 },
    "api/flights-account/me.js": { "maxDuration": 10 }
  },
  "rewrites": [
    { "source": "/flights/login", "destination": "/api/flights-login" },
    { "source": "/flights/callback", "destination": "/api/flights-callback" },
    { "source": "/flights/logout", "destination": "/api/flights-logout" }
  ]
}
```

Place these exact rewrites before any future `/flights/:path*` catch-all.
`/api/flights-account/me` uses Vercel file routing and needs no rewrite.
Runtime imports are traced from the function entries; `_lib` files are not
standalone function endpoints. This packet has no HTML includeFiles setting.

## Cookie behavior and security boundary

The HMAC-SHA256 signed session contains only version, issuer, client ID,
subject, display name and issued/expiry timestamps. It contains no email,
ID token or provider credentials. Both server-side expiry and browser Max-Age
are 12 hours, without sliding renewal. Identity is bound to the configured
issuer and client ID. Changing the session signing secret invalidates every
existing session. Duplicate cookie names fail closed.

One cookie cannot have two paths. Callback sets the same host-only
`__Secure-flights-session` cookie twice: once at `Path=/flights` and once at
`Path=/api/flights-account`. Both are HttpOnly, Secure and SameSite=Lax.
Logout expires both copies and the transaction cookies, requires POST and
the exact configured Origin, and rejects a conflicting Fetch Metadata site.
Missing Origin is rejected. A copied stateless session remains valid until
expiry or signing-secret rotation; logout removes the browser cookies and
does not provide server-side revocation. Cookie paths limit transmission and
are not isolation from other same-origin JavaScript or handlers.

The vendored client enforces state, nonce, PKCE, signing `kid`, ES256, issuer,
audience, authorized party, expiry, five-minute token lifetime, subject `sam`,
authentication time, nonempty email and WebAuthn. The issuer is the
single-user authority, so no separate email allowlist is required here.
Transaction cookies expire in ten minutes and are cleared on callback
success/failure. Network requests to token/JWKS endpoints refuse redirects
and have an eight-second abort deadline per fetch. No secrets, upstream
errors or callback parameters are logged or reflected in error bodies.

## Checks

```sh
npm ci
npm ci --prefix api/_lib/samid
node --test tests/flights-auth/*.test.js
node --test
```

The targeted tests use only a local HTTP issuer with newly generated ES256
keys, a JWKS endpoint and atomically consumed authorization codes bound to
client, redirect URI and S256 challenge. They cover success, state/nonce,
PKCE, client authentication, replay/racing redemption, expired codes/tokens,
claim and signature failures, cookie forgery/expiry, missing configuration,
same-origin logout, methods, host checks and issuer network errors. No
Playwright/browser test or deployment is performed by this backend packet.

Verification on ai-box (2026-10-28): targeted tests passed 27/27. Plain
`node --test` reported 71 tests, 64 passed and 7 failed; the original tracked
test files alone reported 44 tests, 37 passed and the same 7 failures.
Supplying ephemeral in-memory `DEV_PASSWORD` and `PLAYA_PASSWORD` values to
the full suite yielded 68 passed and 3 failed out of 71. All three remaining
failures are the existing dev-page suites requiring the ignored private
`api/_lib/dev.html`, which was not shipped in this mirror. No replacement
private page was fabricated. The nested `jose` lockfile audit found zero known
vulnerabilities; the unchanged root lockfile audit reported five high-severity
findings (`@vercel/blob`, `@vercel/cli-config`, `@vercel/oidc`, `undici`, and `zod`).
These pre-existing dependencies were not changed by this packet.
Independent security review found no blocking
correctness or security issue. Vercel CLI's current Node invocation code was
read to check that rewrites preserve the original callback pathname; a live
Vercel build and browser sign-in remain unverified.
