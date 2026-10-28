# British Airways robot — phase 6a

This is a local macOS robot for ai-mac: headed Chromium, a private persistent
profile and run-time Keychain access. It reads an account balance or searches
one adult, one way, in economy/premium/business/first. It never books, chooses
a fare, enters payment details or changes a BA account. `booking_requests` is
reserved for a later phase and has no mutation API here. The Vercel ignore file
excludes all of `robot/`.

**Offline scaffold, not a live-verified BA integration.** Every HTML fixture,
price and selector contract is synthetic and hand-written. No BA page was
visited; no login, Keychain read, Gmail access, Messages send or database change
was performed. BA URLs, markup, authentication, form controls, result freshness
and full price disclosure need validation in the later supervised session.
Missing or ambiguous markup fails closed rather than returning invented data.

## Offline installation and tests

Use Node 22 or newer. Install dependencies inside this folder; the root package
is unchanged. Versions and integrity hashes are in `package-lock.json`.

```sh
npm ci --prefix robot/ba --ignore-scripts
node --test robot/ba
node robot/ba/cli.js balance --dry-run
node robot/ba/cli.js reward-search --from LHR --to JFK --date 2026-12-03 --cabin economy --dry-run
```

Tests deny network and external command execution before importing robot code;
Keychain uses an injected fake process, browser interactions use an in-memory
fake, Supabase uses a fake transport, and clocks are controlled. The Messages
notifier is never invoked, including in tests. Dry runs only read bundled
fixtures: no environment credentials, profile, home files, datastore or browser.
Reward dry runs accept only the example route/date/cabin because those are the
only supplied reward fixtures. Both commands mark their output `synthetic`.

## Setup on ai-mac — later, supervised

Do not run the live commands during this packet. Sam adds the password himself
with **Keychain Access**, creating a generic password item with service/name
`ba-club`, account equal to the full BA membership number, and password equal to
his BA password. Use the application UI to avoid putting a password into shell
arguments, history, an `.env` file or a command transcript. Keep the login
Keychain locked when the Mac is unattended; do not grant blanket Keychain
access without reviewing the prompt.

At live login, the only password lookup is the argv-based command:

```text
/usr/bin/security find-generic-password -s ba-club -a <membership number> -w
```

Do not run this command separately in a recorded terminal: it prints the
password. The robot captures its output in memory, wipes the returned buffer,
preserves password whitespace and discards subprocess error details. JavaScript
strings cannot be reliably zeroed; references are dropped after use. Passwords
are never deliberately logged, stored or included in exceptions. Playwright
protocol debug logging, password saving, tracing, screenshots, HAR and video
capture are disabled or unused. Do not wrap the process in instrumentation that
records browser protocol arguments or process output.

Install the headed browser only when preparing the supervised session:

```sh
cd robot/ba
npx playwright install chromium
```

| Environment variable | Meaning |
| --- | --- |
| `BA_MEMBERSHIP` | Required full membership number, 6–12 digits. Never saved in results/events; account references use a SHA-256 digest. |
| `BA_LIVE_ENABLED` | Must be exactly `1` for live mode. Unset/`0` refuses live work before accessing the profile or Keychain. |
| `BA_DATA_STORE` | `supabase` by default; use `file` explicitly for local supervised work. Dry runs use neither. |
| `SUPABASE_URL` | HTTPS project origin; required for Supabase mode. |
| `SUPABASE_SERVICE_ROLE_KEY` | Local server credential, required for Supabase mode. Never printed, added to CLI output, or exposed to Vercel/browser code. |
| `BA_MAX_LOGINS_PER_DAY` | Default `3`; positive integer, rolling 24 hours. Each attempt is reserved durably before Keychain access. |
| `BA_MAX_SEARCHES_PER_HOUR` | Default `6`; positive integer, rolling 60 minutes. Failed attempts count. |
| `BA_OTP_PROVIDER` | `manual` by default. `gmail` refuses to run because that provider is a stub. |
| `BA_ACKNOWLEDGE_STOP` | Exact newest local stop event UUID, supplied only after a human reviews and resolves the stop. Acknowledgement is recorded. |
| `BA_IMESSAGE_RECIPIENT` | Optional E.164 phone number or email for a future explicit caller of `IMessageNotifier`; neither CLI command invokes it. |

Secrets must be supplied through a local protected environment, never committed.
No OAuth values are read today. A scheduled job needs access to Sam's logged-in
Aqua session and unlocked Keychain; it cannot run as a headless system daemon.

## Live CLI contract

After the go-live checks, the two commands are:

```sh
node robot/ba/cli.js balance
node robot/ba/cli.js reward-search --from LHR --to JFK --date 2026-12-03 --cabin economy
```

Use uppercase IATA codes and a real ISO date; no return trips or passenger-count
options are accepted in this phase. Query metadata and every result must match
route, date, cabin, one adult and one-way travel. A fresh result token is required
after submission, including for zero availability. All price choices must be
disclosed; a default price alone is insufficient. Prices use integer cash minor
units (`17550` means GBP 175.50), explicit ISO currency and exact Avios counts;
there is no inferred conversion or invented mix. Connections are preserved as
flight-number lists when the reviewed page exposes them. Times are page-local
clock strings, not timezone-resolved instants. Availability is an observation,
not a reservation or a guaranteed price.

The site contract lives in `selectors.js`; HTML interpretation lives in
`parsers.js`. Replace the synthetic selectors and associated fields together
when supervised markup review supplies evidence. Tests should then use a
sanitized reviewed contract without personal account data. The browser permits
only HTTPS requests to BA's own domains, blocks off-site navigation and known
payment/checkout routes, rejects popups, and blocks service workers/downloads.
Any required third-party identity origin needs a later explicit access review.
There is no stealth plugin, CAPTCHA solving or challenge bypass.

## Session, pacing and recovery

State is fixed under `~/Library/Application Support/sam-flights/`:

| Path | Contents |
| --- | --- |
| `ba-profile/` | Persistent Chromium session/cookies; mode 0700, password manager disabled. |
| `ba-safety.json` | Local authoritative rolling quotas and challenge latch, independent of the chosen result datastore; mode 0600. |
| `ba-data.json` | FileDataStore tables when selected; mode 0600. |
| `ba-run.lock/owner.json` | Exclusive profile/run lock with PID. |

All robot-owned directories are 0700. Symlink paths and foreign-owned state
files are rejected. JSON writes use a private temp file, fsync and atomic rename;
file-store operations have an exclusive lock. One process owns the profile at a
time. Do not create alternate profiles/copies to bypass quotas. Hashing a
membership number is pseudonymization, not strong anonymization; protect these
files and session cookies as private account data.

Each browser action is spaced by 800–1800 ms of random jitter, with challenge
checks before and after the delay/action. Cached sessions avoid password access.
There are **no automatic login retries**, OTP resends, search retries or failed
transport retries, which is stricter than the permitted one login retry.
Quotas are rolling windows, survive restarts and include reservations for failed
attempts. A backwards clock does not discard future reservations.

Visible CAPTCHA/bot/unusual-activity/lock text or embedded challenge frames stop
the browser and record a bounded `safety_stop` event. A mutation observer catches
changes during waits, including manual OTP polling. The persistent local latch
blocks later runs even if Supabase is unavailable. After human review, an exact
`BA_ACKNOWLEDGE_STOP` value acknowledges that event once; it never resets quotas.
Do not automatically acknowledge stops in launchd.

Crashes, an unclosed browser or failure to persist a challenge can leave the run
lock. Inspect its PID and confirm all related Chromium processes are stopped
before manually removing **only** `ba-run.lock/owner.json` and the now-empty
`ba-run.lock/`. A crashed file transaction can similarly leave `<json-file>.lock/`.
Never automatically remove a lock or erase the safety ledger to get a run going.

## Datastore contract and manual OTP

`DataStore` defines snapshot writes, search creation/completion/failure, bounded
events and ephemeral OTP handoff. Both adapters match the **proposed** `flights`
contract in `schema-contract.sql`. This branch contains no existing database
definition for these tables, so compatibility with a deployed schema cannot be
claimed. The SQL is reference material, not an applied migration. Sam must
review/reconcile it and approve production database changes separately.

The adapter writes `flights.ba_account_snapshots`, `reward_searches`,
`reward_results` and `robot_events`; it never reads/writes `booking_requests`.
Searches transition from `running` to `completed` (including an explicit empty
result) or `failed`. Supabase completion uses `complete_robot_reward_search` to
commit all result rows and status in one transaction. The FileDataStore does the
equivalent in one atomic file replacement. A crash may leave a `running` search
for a human to reconcile; it is never automatically retried.

Supabase uses REST with `Accept-Profile: flights` and `Content-Profile: flights`,
timeouts, redirects rejected and redacted error codes. The custom schema must
be [exposed in the Data API](https://supabase.com/docs/guides/api/using-custom-schemas).
The contract enables RLS, grants robot access only to `service_role` and revokes
public/anon/authenticated access; no browser-side policy grants are added.
The service-role credential remains broadly privileged and local-only. No
project, database, SQL migration or live key was accessed during this packet.

Manual OTP defaults to a three-minute deadline, polling every two seconds. The
CLI prints only the request UUID. A trusted local/supervised operator finds that
`otp_requested` row and supplies the code through `store.submitOtp(accountRef,
requestId, code)`, or the equivalent parameterized `flights.submit_robot_otp`
RPC. Do not put a code in CLI arguments, logs or ordinary event `details`.
The dedicated `robot_events.otp_code` column is transient; atomic
`consume_robot_otp` returns it once and clears it. Timeout/abort also clears it.
The request is bound to account, UUID and expiry. If the process crashes, a human
must clear any expired OTP fields; do not retain OTPs in exported audit logs or
backups. The FileDataStore exposes the same methods for a local operator helper;
do not edit the JSON concurrently or print the whole store during OTP handling.

`GmailOtpProvider` intentionally always raises `GMAIL_OTP_NOT_CONFIGURED` and has
no Gmail client or calls. A future implementation needs:

- A Google Cloud OAuth desktop client for Sam's Gmail account with Gmail API
  enabled, client ID, client secret and an offline refresh token provided later
  through an approved local credential store. None are requested/read now.
- Only `https://www.googleapis.com/auth/gmail.readonly` scope; no send, modify,
  delete, labels or compose access. This scope grants mailbox-wide read access:
  Google does **not** provide an OAuth scope limited to a sender.
- Application-level query restricted to the **exact BA OTP sender address Sam
  verifies from a legitimate message**, e.g. `from:VERIFIED_BA_OTP_SENDER
  newer_than:1d after:<challenge-start-unix-seconds>`. Do not guess an address,
  use an unrestricted query or enumerate other mail. Fetch only matched IDs,
  validate the exact sender/date/recipient against the active request, reject
  stale/ambiguous codes and never persist message bodies or refresh tokens.

Sender-query restriction is a code boundary, not Gmail authorization isolation.
References: [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[messages.list query](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

`IMessageNotifier` uses a fixed AppleScript with separate recipient/message argv;
only three fixed status messages are allowed. It is implemented for later
explicit use, unconnected to the robot CLI and unused by tests. First sending
and macOS Messages Automation permission belong to a separate supervised step.

## Daily balance LaunchAgent template

`launchd/com.sam.flights.ba-balance.plist.template` is disabled (`BA_LIVE_ENABLED=0`),
not installed or loaded. After successful supervised reads, replace the absolute
Node/repo paths and membership number, inspect the 09:15 local-time schedule,
copy it to `~/Library/LaunchAgents/com.sam.flights.ba-balance.plist`, chmod 0600,
and enable live mode only with Sam's approval. The template uses FileDataStore
so it needs no service-role secret in a plist. It discards stdout/stderr; inspect
private datastore events for outcomes. launchd does not inherit interactive shell
environment variables or expand `~`. It does not run at load or auto-restart.

## Risks and supervised go-live checklist

BA terms forbid automation; this can trigger challenges, suspend access or lock
the account. Rate limits and pacing do not establish permission or remove that
risk. Sam must review current BA terms himself before the first live run; this
packet deliberately did not visit BA, including its terms pages.

- Review terms and account-lock risk; agree to one supervised read, with no booking.
- Confirm ai-mac's headed desktop, current Node/Chromium and private profile/state permissions.
- Sam creates the Keychain entry himself and supplies `BA_MEMBERSHIP`.
- Review real account/login/OTP/search markup and update the synthetic selector
  contract, including full membership verification, result freshness/query
  metadata and the all-options disclosure. Check every supported cabin and empty
  state. A masked-only membership display needs a reviewed identity check.
- Choose FileDataStore initially or separately approve/reconcile the Supabase
  schema/RPCs, RLS and schema exposure, then supply the local service-role key.
- Use manual OTP first; any Gmail OAuth setup and later provider implementation
  require their own explicit access approval. Keep notifications disconnected.
- Run the offline suite, enable `BA_LIVE_ENABLED=1` for the supervised process,
  inspect one balance and one tightly specified search against the visible page,
  and confirm every offered mix is returned. Stop on any challenge; never bypass it.
- Verify session reuse avoids a second login, quotas persist across processes,
  no booking request exists, and no secrets appear in logs/artifacts.
- Only after Sam accepts the supervised results, consider enabling the daily
  LaunchAgent. Do not schedule reward polling or install a controller here.
