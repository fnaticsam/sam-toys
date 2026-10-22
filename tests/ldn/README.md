# London date and freshness regression checks

Run pure tests with `node --test tests/ldn/dates.test.mjs`.
Run the offline browser flow with `node tests/ldn/dates-browser-check.cjs` after
installing the project's browser test dependencies. `CHROMIUM_PATH` may override
`/usr/bin/chromium`. The browser test intercepts every request and uses synthetic
listings; it does not access providers or a deployed application.

Data contract:

- Time-limited entries need inclusive `validFrom` and `validTo` calendar dates in
  `YYYY-MM-DD` format. These are London dates. Unknown or invalid windows remain
  unknown, even when a prose date is present. The planner excludes them.
- A dataset is current only when its month is the current London month and its
  generation timestamp is within 45 days. Stale time-limited entries are excluded
  from plans. Evergreen venues remain available with recorded-hours caveats.
- `verified: true` records independent review of that snapshot. Automated
  structural checks do not imply independent review.
- Carryover requires matching name/category, venue identity, and recent source
  enrichment. `hoursCheckedAt`, `showTimesCheckedAt`, and `ratingCheckedAt` retain
  their original timestamps. The 45-day limit allows one monthly refresh without
  perpetually extending the age of an old check. Legacy independently reviewed
  snapshots may use their original `generatedAt` once as this timestamp.
- Timed entries additionally need the exact same confirmed, unexpired date window
  before enrichment is carried. A changed venue or run requires new enrichment.
  Newly recorded hours/ratings must receive timestamps when actually refreshed;
  publishing a dataset alone must not reset those timestamps.

This intentionally leaves legacy time-limited seed entries out of itineraries
until their structured dates are checked. It does not rewrite the seed or claim
that standing venues have expired. Weekly hours and future bookings still need
confirmation with the venue; the planner is an estimate, not ticket availability.
