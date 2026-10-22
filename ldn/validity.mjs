// Calendar dates are London dates, not timestamps in the visitor's time zone.
// Forty-five days allows one monthly refresh; carryover never resets this age.
export const MAX_ENRICHMENT_AGE_DAYS = 45;

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function londonDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isRecent(checkedAt, now = new Date()) {
  if (typeof checkedAt !== 'string' || !checkedAt.trim()) return false;
  const age = new Date(now).getTime() - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= 0 && age <= MAX_ENRICHMENT_AGE_DAYS * 86400000;
}

export function datasetIsStale(data, now = new Date()) {
  return data?.month !== londonDate(new Date(now)).slice(0, 7) || !isRecent(data?.generatedAt, now);
}

export function isTimeLimited(place) {
  return place.tier === 'this-month' || place.validFrom != null || place.validTo != null;
}

export function hasDateWindow(place) {
  return !!(isoDate(place.validFrom) && isoDate(place.validTo) && place.validFrom <= place.validTo);
}

export function dateStatus(place, date) {
  if (!isTimeLimited(place)) return 'evergreen';
  if (!isoDate(date) || !hasDateWindow(place)) return 'unconfirmed';
  if (date < place.validFrom) return 'upcoming';
  if (date > place.validTo) return 'ended';
  return 'current';
}

export function availableOn(place, date, { stale = false } = {}) {
  const status = dateStatus(place, date);
  return status === 'evergreen' || (status === 'current' && !stale);
}

export function eventLabel(place, date, { stale = false } = {}) {
  const status = dateStatus(place, date);
  if (status === 'evergreen') return '';
  if (status === 'ended') return 'Run ended ' + place.validTo;
  if (stale || status === 'unconfirmed') return 'Dates need checking';
  if (status === 'upcoming') return 'From ' + place.validFrom;
  return 'On now · until ' + place.validTo;
}
