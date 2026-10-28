// Unknown or zero earning is never a zero-cost status run. Preserve the raw
// ratio for sorting (display rounding must not turn close scores into ties).
function rank(flights) {
  return flights.map((flight) => ({ ...flight,
    gbpPerTierPoint: Number.isFinite(flight.estimate?.tierPoints) && flight.estimate.tierPoints > 0
      ? flight.priceGbp / flight.estimate.tierPoints : null,
  })).sort((a, b) => (a.gbpPerTierPoint ?? Infinity) - (b.gbpPerTierPoint ?? Infinity) || a.priceGbp - b.priceGbp);
}
module.exports = { rank };
