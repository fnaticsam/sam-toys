(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightCities = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Metropolitan IATA codes whose member airports have coordinates in airports.json.
  // Do not broaden an individual airport code (such as LHR) into its city group.
  const groups = {
    NYC: { name: 'New York', airports: ['JFK', 'EWR', 'LGA'] },
    LON: { name: 'London', airports: ['LHR', 'LGW', 'LCY', 'STN', 'LTN', 'SEN'] },
    PAR: { name: 'Paris', airports: ['CDG', 'ORY'] },
    MIL: { name: 'Milan', airports: ['MXP', 'LIN', 'BGY'] },
    ROM: { name: 'Rome', airports: ['FCO', 'CIA'] },
    TYO: { name: 'Tokyo', airports: ['HND', 'NRT'] },
    CHI: { name: 'Chicago', airports: ['ORD', 'MDW'] },
    WAS: { name: 'Washington', airports: ['IAD', 'DCA', 'BWI'] },
    BJS: { name: 'Beijing', airports: ['PEK', 'PKX'] },
    BUE: { name: 'Buenos Aires', airports: ['EZE', 'AEP'] },
    BUH: { name: 'Bucharest', airports: ['OTP', 'BBU'] },
    DTT: { name: 'Detroit', airports: ['DTW', 'DET'] },
    JKT: { name: 'Jakarta', airports: ['CGK', 'HLP'] },
    MOW: { name: 'Moscow', airports: ['SVO', 'DME', 'VKO', 'ZIA'] },
    OSA: { name: 'Osaka', airports: ['KIX', 'ITM', 'UKB'] },
    REK: { name: 'Reykjavik', airports: ['KEF', 'RKV'] },
    RIO: { name: 'Rio de Janeiro', airports: ['GIG', 'SDU'] },
    SAO: { name: 'São Paulo', airports: ['GRU', 'CGH', 'VCP'] },
    SEL: { name: 'Seoul', airports: ['ICN', 'GMP'] },
    SPK: { name: 'Sapporo', airports: ['CTS', 'OKD'] },
    STO: { name: 'Stockholm', airports: ['ARN', 'BMA', 'NYO', 'VST'] },
    TCI: { name: 'Tenerife', airports: ['TFS', 'TFN'] },
    YMQ: { name: 'Montreal', airports: ['YUL', 'YHU', 'YMX'] },
    YTO: { name: 'Toronto', airports: ['YYZ', 'YTZ'] },
  };
  Object.values(groups).forEach(group => { Object.freeze(group.airports); Object.freeze(group); });
  const CITY_GROUPS = Object.freeze(groups);
  function matchesAirport(searchCode, actualAirport) {
    return typeof actualAirport === 'string' && (CITY_GROUPS[searchCode]
      ? CITY_GROUPS[searchCode].airports.includes(actualAirport)
      : searchCode === actualAirport);
  }
  function cityName(code) { return CITY_GROUPS[code]?.name || code; }
  return Object.freeze({ CITY_GROUPS, matchesAirport, cityName });
});
