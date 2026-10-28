'use strict';
const { parse } = require('parse5');
const site = require('./selectors');
const { fail } = require('./errors');

function nodes(root, predicate) {
  const found = [];
  function walk(n) {
    if (predicate(n)) found.push(n);
    for (const child of n.childNodes || []) walk(child);
  }
  walk(root); return found;
}
function attr(n, key) { return n.attrs?.find(a => a.name === key)?.value; }
// The parser contract deliberately supports simple attribute selectors only.
// Changing this contract to BA's reviewed markup is isolated to this module and selectors.js.
function select(root, selector) {
  const match = /^\[([\w-]+)="([^"]+)"\]$/.exec(selector);
  if (!match) fail('SELECTOR_CONTRACT');
  return nodes(root, n => attr(n, match[1]) === match[2]);
}
function text(root) {
  if (['script', 'style', 'template', 'noscript'].includes(root.tagName)) return '';
  if (root.nodeName === '#text') return root.value;
  return (root.childNodes || []).map(text).join(' ').replace(/\s+/g, ' ').trim();
}
function value(root, field, optional = false) {
  const matches = select(root, site.fields[field]);
  if (matches.length !== 1) { if (optional && !matches.length) return null; fail('PAGE_CONTRACT'); }
  return text(matches[0]);
}
function integer(input) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(input)) fail('PAGE_NUMBER');
  const result = Number(input.replaceAll(',', ''));
  if (!Number.isSafeInteger(result)) fail('PAGE_NUMBER');
  return result;
}
function isoDate(input) {
  let result = input;
  const long = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(input);
  if (long) {
    const month = ['January','February','March','April','May','June','July','August','September','October','November','December'].findIndex(m => m.toLowerCase() === long[2].toLowerCase());
    if (month < 0) fail('PAGE_DATE');
    result = `${long[3]}-${String(month + 1).padStart(2, '0')}-${long[1].padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) fail('PAGE_DATE');
  return result;
}
function detectChallenge(html) {
  const root = parse(html);
  const content = text(root);
  for (const [kind, pattern] of site.challenges) if (pattern.test(content)) return kind;
  if (nodes(root, n => ['iframe', 'script'].includes(n.tagName) && site.challengeFrames.test(attr(n, 'src') || '')).length) return 'CAPTCHA';
  return null;
}
function checked(html) {
  const challenge = detectChallenge(html);
  if (challenge) fail(challenge);
  return parse(html);
}
function parseAccount(html, { membership } = {}) {
  const root = checked(html);
  if (membership !== undefined && value(root, 'membership').replace(/\s/g, '') !== membership) fail('ACCOUNT_MISMATCH');
  const tier = value(root, 'tier');
  if (!['Blue', 'Bronze', 'Silver', 'Gold', 'Gold Guest List', 'Premier'].includes(tier)) fail('PAGE_TIER');
  return { tier, tier_points: integer(value(root, 'tierPoints')), avios: integer(value(root, 'avios')), collection_year_end: isoDate(value(root, 'yearEnd')) };
}
function parseRewards(html, query) {
  const root = checked(html);
  const pages = select(root, site.fields.rewardPage);
  if (pages.length !== 1) fail('PAGE_CONTRACT');
  const meta = site.resultAttributes, page = pages[0];
  if (!attr(page, meta.token) || ['from', 'to', 'date', 'cabin'].some(k => attr(page, meta[k]) !== query[k]) || attr(page, meta.adults) !== '1' || attr(page, meta.trip) !== 'one_way') fail('SEARCH_MISMATCH');
  const cards = select(root, site.fields.card);
  const empty = select(root, site.fields.empty).length > 0;
  if ((!cards.length && !empty) || (cards.length && empty)) fail('PAGE_CONTRACT');
  return cards.map(card => {
    const from = value(card, 'from'), to = value(card, 'to');
    const date = isoDate(value(card, 'date')), cabin = value(card, 'cabin').toLowerCase();
    if (from !== query.from || to !== query.to || date !== query.date || cabin !== query.cabin) fail('SEARCH_MISMATCH');
    const flight = value(card, 'flight');
    if (!/^[A-Z0-9]{2}\s?\d{1,4}(?:\s*\/\s*[A-Z0-9]{2}\s?\d{1,4})*$/.test(flight)) fail('PAGE_FLIGHT');
    const departure = value(card, 'departure'), arrival = value(card, 'arrival');
    if (![departure, arrival].every(t => /^([01]\d|2[0-3]):[0-5]\d(?: \+1)?$/.test(t))) fail('PAGE_TIME');
    const allMixes = select(card, site.fields.allMixes);
    if (allMixes.length !== 1) fail('MIXES_UNAVAILABLE');
    const mixes = select(allMixes[0], site.fields.mix).map(mix => {
      const avios = integer(value(mix, 'mixAvios'));
      const amount = value(mix, 'mixCash');
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(amount)) fail('PAGE_CASH');
      const cash_minor = Math.round(Number(amount.replaceAll(',', '')) * 100);
      const currency = value(mix, 'mixCurrency');
      if (!Number.isSafeInteger(cash_minor) || !/^[A-Z]{3}$/.test(currency)) fail('PAGE_CASH');
      return { avios, cash_minor, currency };
    });
    if (!mixes.length) fail('MIXES_UNAVAILABLE');
    const seats = value(card, 'seats', true);
    return { flight_numbers: flight.split(/\s*\/\s*/), origin: from, destination: to, departure_date: date,
      cabin, departure_time: departure, arrival_time: arrival, available_seats: seats === null ? null : integer(seats),
      price_basis: 'one_adult_one_way', mixes };
  });
}
module.exports = { parseAccount, parseRewards, detectChallenge, isoDate };
