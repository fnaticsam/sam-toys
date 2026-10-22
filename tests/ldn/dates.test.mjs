import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { isoDate, londonDate, datasetIsStale, dateStatus, eventLabel, isRecent } from '../../ldn/validity.mjs';
import { normalizePlace, carryOverEnrichment } from '../../api/_lib/ldn/research.mjs';

const html = await readFile(new URL('../../ldn/index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace("'/ldn/validity.mjs'", JSON.stringify(new URL('../../ldn/validity.mjs', import.meta.url).href));
const planner = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const now = '2026-10-22T12:00:00Z';
const checked = '2026-10-01T12:00:00Z';
const venue = {
  id: 'synthetic', category: 'art-museums', name: 'Synthetic venue', venue: 'Synthetic venue',
  address: '1 Synthetic Street, London', lat: 51.5136, lng: -0.1313, tier: 'evergreen',
  entry: 'dropin', hours: { thu: [['10:00', '22:00']], fri: [['10:00', '22:00']] },
  hoursUrl: 'https://example.invalid/hours', hoursCheckedAt: checked
};
const event = { ...venue, tier: 'this-month', validFrom: '2026-10-20', validTo: '2026-10-23' };
const opts = { start: venue, date: '2026-10-22', startMin: 840, durationMin: 180, mode: 'walk', rand: () => 0 };
const planned = (p, options = {}) => planner.planDate([p], { ...opts, ...options }).stops.length;
const unfilled = (p = venue) => { const copy = structuredClone(p); for (const k of ['hours', 'hoursUrl', 'hoursCheckedAt', 'entry', 'showTimes', 'showTimesCheckedAt', 'runtimeMins', 'rating', 'ratingCheckedAt']) delete copy[k]; return copy; };
function carry(old, fresh, previous = {}, next = {}) {
  const result = carryOverEnrichment({ generatedAt: checked, verified: true, places: [old], ...previous }, { generatedAt: now, places: [fresh], ...next });
  return result.carried;
}

test('strict ISO calendar dates and London day boundaries, including DST', () => {
  assert.equal(isoDate('2026-02-30'), null);
  assert.equal(isoDate('2026-2-02'), null);
  assert.equal(isoDate('2028-02-29'), '2028-02-29');
  assert.equal(londonDate(new Date('2026-10-22T23:30:00Z')), '2026-10-23');
  assert.equal(londonDate(new Date('2026-10-25T23:30:00Z')), '2026-10-25');
});

test('selected calendar date gates runs inclusively and derives the weekday', () => {
  assert.equal(planned(event), 1);
  assert.equal(planned(event, { date: '2026-10-23', dayKey: 'mon' }), 1);
  assert.equal(planned({ ...event, validFrom: '2026-10-22' }), 1);
  assert.equal(planned(event, { date: '2026-10-29' }), 0);
  assert.equal(planned(event, { date: '2026-10-15' }), 0);
  assert.equal(planned(event, { date: '' }), 0);
  assert.equal(planned(event, { date: '2026-02-30' }), 0);
});

test('uncertain prose dates and stale time-limited entries are excluded; evergreen fallback remains usable', () => {
  assert.equal(planned({ ...venue, tier: 'this-month', thisMonth: { dates: 'until 1 Jan 2020' } }), 0);
  assert.equal(planned(event, { stale: true }), 0);
  assert.equal(planned(venue, { stale: true }), 1);
  assert.equal(eventLabel(venue, opts.date, { stale: true }), '');
  assert.equal(dateStatus(event, '2026-10-29'), 'ended');
  assert.equal(eventLabel(event, opts.date, { stale: true }), 'Dates need checking');
  assert.match(eventLabel(event, opts.date), /^On now/);
});

test('dataset freshness rejects old months, unknown or future generation times', () => {
  assert.equal(datasetIsStale({ month: '2026-10', generatedAt: checked }, now), false);
  for (const data of [{ month: '2026-07', generatedAt: checked }, { month: '2026-10' }, { month: '2026-10', generatedAt: '2026-11-01' }]) assert.equal(datasetIsStale(data, now), true);
  assert.equal(isRecent('not a timestamp', now), false);
});

test('research retains grounded date bounds but never guesses them from prose', () => {
  const normalize = p => normalizePlace({ id: 'art-museums' }, p, 1);
  assert.equal(normalize(event).validTo, '2026-10-23');
  assert.equal(normalize({ ...event, validFrom: '2026-02-30' }).validFrom, null);
  assert.equal(normalize({ ...event, validFrom: '2026-10-24' }).validTo, null);
  assert.equal(normalize({ ...venue, tier: 'this-month', thisMonth: { dates: 'this week' } }).validTo, null);
  assert.equal('validTo' in normalize(venue), false);
});

test('carryover requires the same venue, rejects ambiguous matches and preserves independent copies', () => {
  const fresh = unfilled();
  assert.equal(carry(venue, fresh), 1);
  assert.deepEqual(fresh.hours, venue.hours);
  assert.notEqual(fresh.hours, venue.hours);
  for (const change of [{ venue: 'Other venue' }, { address: '2 Synthetic Street, London' }, { lat: 51.54 }, { venue: '' }]) assert.equal(carry(venue, { ...unfilled(), ...change }), 0);
  assert.equal(carry(venue, unfilled(), { places: [venue, { ...venue }] }), 0);
});

test('carryover ages from the actual enrichment check, never the newest dataset publication', () => {
  const first = unfilled();
  assert.equal(carry(venue, first), 1);
  assert.equal(first.hoursCheckedAt, checked);
  assert.equal(carry(first, unfilled(), { generatedAt: now }, { generatedAt: '2026-11-22T12:00:00Z' }), 0);
  const legacy = { ...venue }; delete legacy.hoursCheckedAt;
  assert.equal(carry(legacy, unfilled()), 1);
  assert.equal(carry(legacy, unfilled(), { verified: false }), 0);
  assert.equal(carry(legacy, unfilled(), { generatedAt: '2026-07-01T12:00:00Z' }), 0);
  assert.equal(carry({ ...venue, hoursCheckedAt: '2026-12-01' }, unfilled()), 0);
});

test('time-limited schedules require the same confirmed, still-valid run', () => {
  const show = { ...event, entry: 'show', showTimes: [{ days: ['thu'], start: '14:30' }], runtimeMins: 90, showTimesCheckedAt: checked };
  const fresh = unfilled(show);
  assert.equal(carry(show, fresh), 1);
  assert.deepEqual(fresh.showTimes, show.showTimes);
  assert.equal(fresh.runtimeMins, 90);
  assert.equal(planned(fresh), 1);
  assert.equal(carry(show, { ...unfilled(show), validTo: '2026-11-23' }), 0);
  assert.equal(carry(show, unfilled(show), {}, { generatedAt: '2026-10-24T12:00:00Z' }), 0);
  assert.equal(carry({ ...show, validFrom: null }, unfilled(show)), 0);
  assert.equal(carry(show, unfilled(venue)), 0);
});
