'use strict';

// UNVERIFIED. Synthetic fixtures model this contract; no BA page was visited.
// Keep every site-specific URL, selector, label and challenge signature here.
module.exports = {
  urls: {
    account: 'https://www.britishairways.com/travel/execclub/execclub/_gf/en_gb',
    rewards: 'https://www.britishairways.com/travel/redeem/execclub/_gf/en_gb'
  },
  fields: {
    tier: '[data-testid="membership-tier"]',
    tierPoints: '[data-testid="tier-points"]',
    avios: '[data-testid="avios-balance"]',
    yearEnd: '[data-testid="collection-year-end"]',
    membership: '[data-testid="membership-number"]',
    rewardPage: '[data-testid="reward-results"]',
    empty: '[data-testid="no-reward-flights"]',
    card: '[data-testid="reward-flight"]',
    flight: '[data-testid="flight-number"]',
    from: '[data-testid="origin"]', to: '[data-testid="destination"]',
    date: '[data-testid="departure-date"]', cabin: '[data-testid="cabin"]',
    departure: '[data-testid="departure-time"]', arrival: '[data-testid="arrival-time"]',
    seats: '[data-testid="available-seats"]',
    mix: '[data-testid="avios-cash-option"]',
    allMixes: '[data-testid="all-avios-options"]',
    mixAvios: '[data-testid="option-avios"]', mixCash: '[data-testid="option-cash"]',
    mixCurrency: '[data-testid="option-currency"]'
  },
  controls: {
    membership: 'input[name="membershipNumber"]', password: 'input[name="password"]',
    login: 'button[data-testid="club-login"]', otp: 'input[autocomplete="one-time-code"]',
    loginError: '[data-testid="login-error"]',
    otpSubmit: 'button[data-testid="verify-code"]',
    from: 'input[name="origin"]', to: 'input[name="destination"]',
    date: 'input[name="departureDate"]', cabin: 'select[name="cabin"]',
    oneWay: 'input[value="oneWay"]', adults: 'select[name="adults"]',
    search: 'button[data-testid="search-rewards"]',
    mixes: 'button[data-testid="show-avios-options"]'
  },
  cabinValues: { economy: 'economy', premium: 'premium', business: 'business', first: 'first' },
  resultAttributes: { from: 'data-origin', to: 'data-destination', date: 'data-date', cabin: 'data-cabin', adults: 'data-adults', trip: 'data-trip-type', token: 'data-search-id' },
  challenges: [
    ['CAPTCHA', /captcha|verify (?:that )?you are (?:a )?human|prove you.are human/i],
    ['BOT_CHALLENGE', /bot (?:challenge|check|detection)|checking your browser|automated (?:access|traffic)|access denied|security challenge/i],
    ['UNUSUAL_ACTIVITY', /unusual (?:account )?activity|suspicious (?:activity|traffic)/i],
    ['ACCOUNT_LOCKED', /account\s+(?:(?:is|has been)\s+)?(?:(?:temporarily|permanently)\s+)?(?:locked|blocked|suspended)|too many (?:login|sign.in) attempts/i]
  ],
  challengeFrames: /recaptcha|hcaptcha|challenges\.cloudflare|arkoselabs|captcha/i
};
