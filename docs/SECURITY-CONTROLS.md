# Durable abuse controls

The public audio and screenshot endpoints, and authenticated Ask dev, reserve a
shared allowance before each Gemini call. Private-page password attempts use a
separate counter per page. This is bounded application usage, not a currency-denominated
provider spend limit, user identity system, CAPTCHA, or a substitute for ingress
abuse protection and provider budget alerts.

## Rollout prerequisite

Before deploying these handlers, configure `ABUSE_CONTROL_READ_WRITE_TOKEN` in the
intended Vercel environment for a **dedicated private Blob store**. Do not reuse
Playa's gallery token, publish the token, or configure it in browser code. The PR
adds no live configuration. Missing/invalid configuration or an unavailable control
store returns generic 503 before paid work or password comparison; existing valid
private-page sessions continue working. Review the policy below against actual
usage before rollout. A preview plus independent security review remains required
by the repository guide before production deployment or closing issue #2.

| Optional setting | Default | Meaning |
| --- | --- | --- |
| `ABUSE_PAID_DAILY_LIMIT` | 100 | Shared paid requests per UTC day, including failures |
| `ABUSE_PAID_IP_DAILY_LIMIT` | 20 | Paid requests per platform client IP per UTC day |
| `ABUSE_PAID_CONCURRENCY` | 3 | Active paid reservations across instances and routes |
| `ABUSE_LOGIN_IP_LIMIT` | 10 | Password attempts per IP, per page, per window |
| `ABUSE_LOGIN_GLOBAL_LIMIT` | 200 | Password attempts from all IPs, per page, per window |
| `ABUSE_LOGIN_WINDOW_SECONDS` | 900 | Fixed login window duration |

Only positive integers within the implementation bounds are accepted. Invalid
settings fail closed. Use consistent settings across functions/environments sharing
a store; use a separate store for preview so tests cannot consume production
allowances. Public Gemini outputs are capped at 8192 tokens; Ask dev retains its
700-token cap. Existing upload limits also bound each input. Model-specific billing
and audio-token conversion still require provider budget controls.

## Atomicity, failures and retention

A private, deterministic state object for paid work contains the current UTC day,
global and pseudonymous IP counters, and active random lease IDs. A single ETag
conditional write reserves the global count, IP count and concurrency slot together.
First creation disallows overwrite. CAS conflicts have bounded retries; uncertain
writes never grant admission. Reads bypass the CDN. SDK requests share a 1.5-second
abort deadline per admission/release operation. Stale counts never authorize work.

The 90-second lease exceeds the guarded function maximum lifetime (currently at
most 60 seconds). If a worker dies or release fails, the next admission reclaims its
slot only after expiry. Failed/aborted model work is never refunded, since provider
billing can be uncertain. Daily rollover preserves live leases. If function duration
is raised above 60 seconds, increase the lease before rollout; do not independently
change these two limits. State remains in a fixed set of objects rather than an
unbounded list. Old counters are replaced at the next period; stale leases are
removed at the next admission.

Login attempts count before password comparison, including successful logins. Each
private page has an independent fixed window and global/IP limits; one page cannot
exhaust another page's allowance. An attacker may temporarily exhaust new-login
allowance for a page, so use ingress filtering as well. Existing sessions are not
locked out. Window-boundary bursts are bounded by two adjacent windows; this is not
a sliding-window algorithm. Changing window duration can conservatively deny logins
until the next new window; review settings before deployment.

Client addresses come only from Vercel's ingress-set `x-real-ip`; absent/invalid
addresses share an `unknown` bucket. Never place this code behind a proxy that lets
clients set that header. IP keys are HMACs keyed by the dedicated server token and
period/surface; raw addresses, passwords, prompts and model responses are not stored.
The server returns generic errors rather than policy values, counters or secrets.
Rotating the store token changes IP pseudonyms but does not reset the global count;
coordinate any rotation with the privacy and incident policy.

Server error logs contain fixed error classes and provider HTTP status only, not
model output, prompts or provider error bodies. Review platform/provider retention
separately; this code does not establish or change those policies.

## Local verification

`node --test tests/security/*.test.js` uses synthetic fixtures, an in-memory atomic
Blob double and stubbed provider fetches. It exercises independent instances,
conflicting writes, daily/IP exhaustion, concurrency, rollover, abandoned leases,
failed/ambiguous storage, malformed JSON getters and private log hygiene. Existing
handler acceptance suites install an explicit test-only control stub; production
code has no test bypass environment switch. No live store or model is contacted.
