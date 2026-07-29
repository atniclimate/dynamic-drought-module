/**
 * United States Drought Monitor (USDM) category-to-impact translation.
 *
 * The on-the-ground impact profiles for the five USDM categories (D0 through
 * D4), with the wildfire implications foregrounded. The summaries are the
 * documented USDM impact definitions; the wildfire strings are DDM-derived
 * reads and are labeled as such by the consumer. Used by the Current-horizon
 * composer to turn a measured USDM category at the clicked location into
 * sourced claims.
 *
 * The former per-category extreme-heat strings were REMOVED by ruling
 * (D-0.8.0-047): no decision ever authorized that five-step drought-to-heat
 * mapping, and the retrieved literature supports the mechanism but defeats
 * the universal ladder. Do not reintroduce a DDM-inferred heat claim from a
 * USDM category; the ruling records an eight-condition revisit gate.
 *
 * Honest framing carried in the wildfire strings: drought raises the odds,
 * the potential intensity, and the season length of wildfire by drying and
 * curing fuels, but it does not by itself start fires. These are
 * elevated-risk statements, not certainties.
 */

export interface CategoryImpact {
  /** D0..D4. */
  readonly code: string;
  /** USDM label, for example "Severe Drought". */
  readonly label: string;
  /** General on-the-ground impact summary (USDM impact profile). */
  readonly summary: string;
  /** Wildfire implication at this category (drying and curing of fuels). */
  readonly wildfire: string;
}

/**
 * Indexed by the integer `DM` value NDMC publishes (0 = D0 through 4 = D4).
 */
export const CATEGORY_IMPACTS: readonly CategoryImpact[] = [
  {
    code: 'D0',
    label: 'Abnormally Dry',
    summary:
      'Going into or coming out of drought: short-term dryness slows planting and growth. Not yet drought, but the leading or trailing edge of it.',
    wildfire: 'Fine fuels begin to cure; the early signal that the fire window is starting to open.'
  },
  {
    code: 'D1',
    label: 'Moderate Drought',
    summary:
      'Some damage to crops and pastures; streams, reservoirs, or wells run low; voluntary water-use restrictions appear.',
    wildfire: 'Fire season is lengthening as fuels continue to cure.'
  },
  {
    code: 'D2',
    label: 'Severe Drought',
    summary: 'Crop or pasture losses are likely; water shortages are common and restrictions are imposed.',
    wildfire: 'Elevated fire danger and a longer fire window.'
  },
  {
    code: 'D3',
    label: 'Extreme Drought',
    summary: 'Major crop and pasture losses; widespread water shortages or restrictions.',
    wildfire: 'High to very high fire potential.'
  },
  {
    code: 'D4',
    label: 'Exceptional Drought',
    summary:
      'Exceptional, widespread crop and pasture losses; shortages of water in reservoirs, streams, and wells creating emergencies.',
    wildfire: 'Extreme fire conditions.'
  }
];

/**
 * Look up the impact profile for an integer USDM `DM` value (0..4). Returns
 * null for anything outside that range so the caller surfaces the upstream
 * anomaly honestly rather than guessing a category.
 */
export function categoryImpact(dm: unknown): CategoryImpact | null {
  if (typeof dm !== 'number' || !Number.isInteger(dm) || dm < 0 || dm > 4) {
    return null;
  }
  return CATEGORY_IMPACTS[dm] ?? null;
}
