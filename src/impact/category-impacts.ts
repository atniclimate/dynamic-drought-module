/**
 * United States Drought Monitor (USDM) category-to-impact translation.
 *
 * The on-the-ground impact profiles for the five USDM categories (D0 through
 * D4), with the wildfire and extreme-heat implications foregrounded. These are
 * the documented USDM impact definitions plus the drought-to-wildfire and
 * drought-to-heat causal-chain reads from the ddm-drought-impact-modeling
 * skill (references/index-impact-thresholds.md); they are not improvised
 * severity language. Used by the Current-horizon composer to turn a measured
 * USDM category at the clicked location into sourced claims.
 *
 * Honest framing carried in the wildfire and heat strings: drought raises the
 * odds, the potential intensity, and the season length of wildfire by drying
 * and curing fuels, but it does not by itself start fires; and drought and
 * extreme heat reinforce each other through a soil-moisture feedback, so a
 * region in deeper drought carries elevated heat risk beyond what a
 * temperature outlook alone shows. These are elevated-risk statements, not
 * certainties.
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
  /** Extreme-heat implication at this category (soil-moisture / heat feedback). */
  readonly heat: string;
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
    wildfire: 'Fine fuels begin to cure; the early signal that the fire window is starting to open.',
    heat: 'Soils begin drying; evaporative cooling is still mostly intact, so the heat coupling is weak but starting.'
  },
  {
    code: 'D1',
    label: 'Moderate Drought',
    summary:
      'Some damage to crops and pastures; streams, reservoirs, or wells run low; voluntary water-use restrictions appear.',
    wildfire: 'Fire season is lengthening as fuels continue to cure.',
    heat: 'Drying soils shift more energy into sensible heat, modestly raising heat risk above what a temperature outlook alone would show.'
  },
  {
    code: 'D2',
    label: 'Severe Drought',
    summary: 'Crop or pasture losses are likely; water shortages are common and restrictions are imposed.',
    wildfire: 'Elevated fire danger and a longer fire window.',
    heat: 'Dry soils suppress evaporative cooling and the drought-heat feedback is now meaningful, so heat risk is elevated beyond the temperature outlook.'
  },
  {
    code: 'D3',
    label: 'Extreme Drought',
    summary: 'Major crop and pasture losses; widespread water shortages or restrictions.',
    wildfire: 'High to very high fire potential.',
    heat: 'Strong drought-heat reinforcement: suppressed evaporative cooling drives more sensible heat, and that heat dries soils further, compounding heat risk.'
  },
  {
    code: 'D4',
    label: 'Exceptional Drought',
    summary:
      'Exceptional, widespread crop and pasture losses; shortages of water in reservoirs, streams, and wells creating emergencies.',
    wildfire: 'Extreme fire conditions.',
    heat: 'The drought-heat feedback runs at its strongest; deeply dry soils provide little evaporative cooling, so heat risk is elevated well beyond the temperature outlook alone.'
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
