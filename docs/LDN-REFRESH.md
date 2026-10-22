# London refresh operations

This is the monthly pipeline for the public London guide. The public dataset
remains `ldn/current.json` with the same application fields. Existing bundled
seed data remains the fallback. Private gallery storage is unrelated.

## Authentication and configuration

- Vercel Cron uses **GET** with `Authorization: Bearer <CRON_SECRET>`.
- Manual clients use **POST** with `x-refresh-secret: <REFRESH_SECRET>`.
- `key` query authentication is removed. Never put credentials in URLs. An
  authenticated URL that still has `key` is rejected so callers migrate explicitly.
- `month=YYYY-MM` and `dryRun=1` remain optional query parameters. Dry runs still
  call paid providers and take the same exclusive lease; they never publish data.
- `BLOB_READ_WRITE_TOKEN` is the existing **public dataset** store credential.
- `LDN_REFRESH_CONTROL_TOKEN` must identify a separate **private** Blob store.
  Refreshes fail closed with 503 before provider calls if either token is missing.
  Never put this token, lease state, or other private controls in the public store.

**Rollout requirement:** an owner must configure the private control-store token
and migrate manual callers before enabling this version's refresh. No store,
credential, secret, cron setting or deployment was changed by this remediation.
Validate actual private-store access and SDK conditional-write behavior on a
separately authorized preview before rollout. Do not infer live readiness from
mocked tests. Keep the `api/ldn-refresh.mjs` function maximum at 300 seconds while
using the six-minute lease; increasing runtime requires revisiting that invariant.

## Concurrency, deadlines and errors

The fixed private `ldn/control/refresh.json` record is created atomically and
updated by ETag comparison. Its random owner and six-minute expiry allow recovery
after a killed invocation. Concurrent instances get 409 before paid work. Cleanup
is conditional, so an old owner cannot release a newer lease. Cleanup completes
before the HTTP response; a failed cleanup is logged with a fixed event name and
the lease expires naturally. There is no process-local fallback.

The invocation has a 240-second operation deadline. Research and enrichment stop
by 210 seconds, leaving up to 30 seconds to archive and promote. Individual calls
are bounded at 45 seconds for Gemini, ten seconds for Places, and fifteen seconds
for Blob. Reconciliation and lease cleanup get their own five-second bounds,
still below the configured function maximum. Abort signals propagate through
requests, queue workers and retry delays.

Gemini has one transport retry budget, at most three total attempts. Permanent
HTTP failures do not retry; 408, 429, 5xx and transient network/timeouts can retry.
Retry-After is honored up to 30 seconds and cancellation interrupts the delay.
Category code does not multiply the budget. Provider errors/model text are not
returned or logged. Expected outcomes use fixed errors: `refresh-busy`,
`refresh-conflict`, `refresh-timeout`, and `refresh-unavailable`. The public read
endpoint similarly does not expose storage exceptions. Structural validation
failures return `persisted:false`; they never replace the existing dataset.

## Publication and recovery

Each run reads the exact current body and ETag before research. Before promotion,
it writes immutable snapshots under
`ldn/archive/<YYYY-MM>/<timestamp>-<random id>-previous.json` and `...-next.json`.
The prior live body is archived even on the first upgraded run. A missing current
object only needs the new snapshot; the original seed remains in source control.
Archives contain only the already-public dataset, never credentials or lease
records. Old monthly archive paths are left intact.

Any archive failure prevents promotion. The final current write requires the
original ETag, or atomic first creation if current was absent. A competing writer
therefore cannot be silently overwritten. A lost response after promotion is
reconciled by reading current and comparing the exact serialized body; no blind
second write occurs. If reconciliation is unavailable, the request reports a
generic failure and the promotion outcome must be checked before rerunning.
Both snapshots remain available after interrupted promotion. Immutable snapshots
are retained; any future retention policy must preserve the current recovery
chain and requires separate operational review.

Successful refresh responses include `snapshot` and `previousSnapshot`. An
operator can inspect these already-public datasets and restore a selected new
format snapshot using the `createDatasetStore().restore(snapshot, context)`
library method. There is deliberately no web restore route. The operator must
first acquire the same private lease and read a fresh `current()` baseline,
then pass `{lease, baseline, signal}` to `restore`, and release the lease in
`finally`. Restore validates the fixed archive pathname, archives the current
state, and uses the same conditional promotion. Do not restore with a blind
public Blob overwrite. Recovery operations are external writes requiring their
own authorization; none were performed here.

## Local verification

Run `node --test tests/ldn/refresh.test.mjs`. Tests inject synthetic Blob records,
fetch responses and providers; they make no live requests and require no real
credentials. They cover method/authentication combinations, missing configuration,
independent-instance contention, stale/uncertain leases, archive failures,
interrupted/uncertain promotion, ETag races and first-creation races, restore,
seed fallback, cancellation, bounded retryability and freshness timestamps.

The London date-validity remediation owns `validFrom`, `validTo` and carried
schedule freshness. Places stamps `hoursCheckedAt` and `ratingCheckedAt` only
when it actually replaces those fields; retained official fields keep their age.
