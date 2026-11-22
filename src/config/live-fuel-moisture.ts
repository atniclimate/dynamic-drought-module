/**
 * Live fuel moisture: the source's address, the limits every read is held to,
 * how the values are drawn, and every public string, in this one place.
 *
 * The source. Eight-day maps of live fuel moisture content (the water in
 * living plants as a percentage of their dry mass) for the western United
 * States, estimated from Suomi NPP VIIRS reflectance, daily weather and
 * terrain by the models of Pampanoni, Chuvieco, Ferrari, Laneve and Saquella
 * (2026), "A Unified Multisensor Machine-Learning Framework for Live Fuel
 * Moisture Content Retrieval", Remote Sensing 18(21), 3744,
 * doi:10.3390/rs18213744. The EOSIAL Laboratory of Sapienza University of
 * Rome publishes them as Cloud Optimized GeoTIFFs with a JSON list
 * (schema `eosial-lfmc-v1`): whole percent, 65535 where there is no value,
 * about 500 m cells on a longitude/latitude grid from 127.9 W to 101.4 W and
 * 29.2 N to 51.4 N. A value is a model estimate for land the model treats as
 * grass, shrub or tree, never a field measurement.
 *
 * Terms. The models and the maps made with them are under the PolyForm
 * Noncommercial License 1.0.0 and the publisher's "Terms for Generated Maps
 * and Model Outputs": non-commercial use, with attribution. The owner admitted
 * the source on those terms on 2026-11-21 (DDM is non-commercial; the full
 * attribution is in the documentation and the briefing's technical section).
 *
 * The address lives outside the URLS catalog for the reason given in
 * src/config/dryness-ground.ts (the catalog's chunk rides every feature's
 * first activation). It keeps the catalog's `key: 'https...'` form so
 * scripts/check-upstream-drift.mjs reads and probes it with the catalog.
 *
 * Transport, observed 2026-11-21: the host answers any origin
 * (`Access-Control-Allow-Origin: *`) and honours `Range` with 206, but refuses
 * an OPTIONS preflight with 405. A browser that sends a simple byte range
 * without a preflight reads it directly; one that preflights cannot, and the
 * layer and the briefing reading then say the source is unavailable.
 */
export const LIVE_FUEL_MOISTURE_URLS = {
  lfmcManifest: 'https://valpamp.github.io/eosial-lfmc-data/manifest.json'
} as const;

/**
 * Where a person can see the publisher's own map, read the method and read
 * the terms. Reading links, not data endpoints: they are written with
 * backticks so the upstream monitor, which probes every quoted
 * `key: 'https...'` in this file, leaves them alone.
 */
export const LIVE_FUEL_MOISTURE_LINKS = {
  viewer: `https://valpamp.github.io/eosial-viewer/fire-weather/`,
  paper: `https://doi.org/10.3390/rs18213744`,
  terms: `https://github.com/valpamp/lfmc-multisensor/blob/main/OUTPUT_TERMS.md`
} as const;

/** The list's schema name and the one raster encoding this app reads. */
export const LFMC_MANIFEST_SCHEMA = 'eosial-lfmc-v1';
export const LFMC_RASTER_ENCODING = 'uint16-nearest-v1';

/**
 * Read limits. Measured 2026-11-21: the list is 20,450 B for 24 maps; a
 * raster's header ends at byte 7,498; the largest full-resolution tile of the
 * 16 October map is 64,614 B compressed.
 */
export const LFMC_LIMITS = {
  timeoutMs: 15_000,
  manifestBytes: 1_048_576,
  maxComposites: 400,
  cog: { timeoutMs: 15_000, maxHeaderBytes: 262_144, maxTileBytes: 524_288 }
} as const;

/** How long the list and a raster's header are kept before they are read again. */
export const LFMC_MANIFEST_TTL_MS = 30 * 60_000;

/**
 * Which map the layer draws: the newest one carrying values for at least this
 * share of the cells of the fullest map in the list. A late-autumn map can be
 * mostly empty (the 1 to 8 November 2026 map held 14 percent of the fullest
 * map's cells), and a nearly blank layer tells a person nothing. The key always
 * names the dates of the map on screen. A DDM display rule (method M-115).
 */
export const LFMC_LAYER_MIN_COVERAGE = 0.5;

/**
 * The 3D ground: white at a per-class alpha, whiter where living plants hold
 * less water, the same direction as the plant-stress ground and the fuel-risk
 * drape (DR-199). The class edges are the tick marks of the publisher's own
 * colour scale (30, 60, 100, 150, 200); the classes between them are DDM's,
 * display steps and not fire-danger thresholds. The alphas
 * run from 40 percent white to a 4 percent lift in even steps, as the other
 * two grounds do. A DDM display derivation (method M-115).
 */
export const LFMC_GROUND_CLASSES = [
  { upTo: 30, alpha: 0.4, label: '30 or lower' },
  { upTo: 60, alpha: 0.328, label: '31 to 60' },
  { upTo: 100, alpha: 0.256, label: '61 to 100' },
  { upTo: 150, alpha: 0.184, label: '101 to 150' },
  { upTo: 200, alpha: 0.112, label: '151 to 200' },
  { upTo: Number.POSITIVE_INFINITY, alpha: 0.04, label: 'Above 200' }
] as const;

/**
 * The flat map: the publisher's own default scale ("Desert to Forest" in the
 * EOSIAL Fire Weather Viewer, read from its source on 2026-11-21), unchanged.
 * Colours are interpolated in a straight line between stops; values below 30
 * or above 250 take the end colours, as they do in the publisher's viewer.
 */
export const LFMC_ISSUER_STOPS = [
  [30, '#642809'], [55, '#b86129'], [80, '#e7af57'], [95, '#d4ca76'], [100, '#a1d99b'],
  [130, '#83c888'], [160, '#60ad71'], [190, '#449359'], [220, '#24723e'], [250, '#00441b']
] as const;
/** The publisher's scale labels, at these values. */
export const LFMC_ISSUER_TICKS = [
  [30, '30 or lower'], [60, '60'], [100, '100'], [150, '150'], [200, '200'], [250, '250 or higher']
] as const;

/**
 * The area the maps cover, as the rasters' own header states it (west, south,
 * east, north; read 2026-11-21), rounded outward by a hundredth of a degree.
 * Used only to skip a place that cannot be covered without asking the network;
 * a read inside it still takes the raster's own bounds as the truth.
 */
export const LFMC_COVERAGE = [-127.89, 29.24, -101.35, 51.43] as const;

/** Whether a box (west, south, east, north) touches the area the maps cover. */
export function lfmcCovers(box: readonly [number, number, number, number]): boolean {
  const [west, south, east, north] = LFMC_COVERAGE;
  return box[0] < east && box[2] > west && box[1] < north && box[3] > south;
}

/**
 * The briefing's reading (method M-115).
 * - `recentMaps`: how many of the newest maps are read for a place; five maps
 *   span 40 days.
 * - `pointHalfWidthKm`: half the width of the square read around a place that
 *   has no outline.
 * - `minCells`: the fewest cells with a value a statement is made from.
 * - `comparableShare`: a map counts for a place only when it carries values for
 *   at least this share of the cells the fullest of the maps read carries
 *   there. Cloud and snow empty different parts of a place in different
 *   weeks, and the median of a half-empty place is the median of a different
 *   piece of ground (Washington's read 60 in a map holding 45 percent of its
 *   cells and 105 in the full map a week earlier), so only like is compared
 *   with like.
 * - `windowPixels`: a large area is read from a coarser copy of the map so the
 *   read spans at most this many cells each way (two raster tiles at most).
 */
export const LFMC_BRIEFING = {
  recentMaps: 5,
  pointHalfWidthKm: 5,
  minCells: 5,
  comparableShare: 0.8,
  windowPixels: 128
} as const;

/**
 * Public wording. The wording follows the references-ledger entry
 * `eosial-lfmc-western-us` (clause verdicts read 2026-11-22) and is still a
 * DRAFT until the owner reads it (new public scientific wording is the owner's
 * call): the key's lines, the layer's name and the briefing's sentences and
 * notes.
 */
export const LFMC_TEXT = {
  name: 'Live fuel moisture',
  groundTitle: 'Live fuel moisture (% of dry mass), whiter is drier',
  flatTitle: 'Live fuel moisture (% of dry mass)',
  noValue: 'No value shown (land the model does not cover, or satellite input missing or screened out)',
  definition: 'Water in living plants as a percentage of their dry mass, estimated from satellite, weather and terrain data.',
  coverage: 'Coverage: western United States, 29.2°N to 51.4°N and 127.9°W to 101.4°W.',
  unavailable: 'Live fuel moisture unavailable: the publisher\'s maps could not be read.',
  issuer: 'EOSIAL Laboratory, Sapienza University of Rome',
  source: 'EOSIAL Laboratory, Sapienza University of Rome (Pampanoni et al. 2026)',
  nativeSupport: 'about 500 m cells, eight-day satellite composite',
  modelNote: 'A model estimate for land the model treats as grass, shrub or tree; not a field measurement.',
  // From the abstract of doi:10.3390/rs18213744, read 2026-11-21.
  accuracyNote: 'The authors test the models on dates held out from training at sites that also supplied training data, and report that "Testing at sites excluded from training gives lower accuracy."',
  thresholdNote: 'The white shading and its classes are DDM\'s: display steps between the tick marks of the publisher\'s colour scale, not fire-danger thresholds.',
  termsNote: 'Used under the PolyForm Noncommercial License 1.0.0 and the publisher\'s Terms for Generated Maps and Model Outputs: non-commercial use, with attribution.'
} as const;
