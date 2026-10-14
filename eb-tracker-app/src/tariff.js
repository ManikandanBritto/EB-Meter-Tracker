// Slab-based tariff model.
// Each slab: { upto: number|null, rate: number } — upto is the cumulative
// unit ceiling for that slab; null means "no ceiling" (last slab).
// Example default slabs loosely modeled on typical domestic EB tariffs —
// EDIT THESE to match your actual electricity board's current rates.
export const DEFAULT_SLABS = [
  { upto: 100, rate: 0 },      // first 100 units free/subsidized
  { upto: 400, rate: 4.70 },
  { upto: 500, rate: 6.30 },
  { upto: 600, rate: 8.40 },
  { upto: 800, rate: 9.45 },
  { upto: 1000, rate: 10.50 },
  { upto: null, rate: 11.55 },
];

/**
 * Calculate cost for a given number of consumed units using slab tariffs.
 * Slabs are cumulative: units are billed at each slab's rate up to that
 * slab's ceiling, remainder spills into the next slab.
 */
export function calculateCost(units, slabs = DEFAULT_SLABS) {
  if (units <= 0) return 0;
  let remaining = units;
  let lastCeiling = 0;
  let cost = 0;

  for (const slab of slabs) {
    const slabSize =
      slab.upto === null ? remaining : Math.max(0, slab.upto - lastCeiling);
    const unitsInSlab = Math.min(remaining, slabSize);
    cost += unitsInSlab * slab.rate;
    remaining -= unitsInSlab;
    lastCeiling = slab.upto === null ? lastCeiling : slab.upto;
    if (remaining <= 0) break;
  }

  return Math.round(cost * 100) / 100;
}
