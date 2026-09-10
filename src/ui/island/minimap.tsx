/**
 * The framing minimap (S4b; the S4 design record section 3; the
 * four-round region-selector spike, D-0.7.0-039/041/051/054).
 *
 * A schematic chooser over the nine editorial camera framings
 * (src/config/framings.ts) plus the ALL reset. The eight mainland
 * framings keep the verified, edge-matched masks promoted from the S4 shell
 * kit, clipped to bundled Natural Earth 1:50m physical coastline linework;
 * Hawaii is the enlarged inset whose whole frame is its hit target. The
 * drawing itself uses only quiet ocean affordance labels for pointer users
 * (D-0.7.0-054); names, provenance framing, and coverage cautions ride
 * the accessible name and the selected-framing caption below. Pointer
 * hover is deliberately visual-only: a soft glow marks the target
 * without covering the map with a description popup.
 *
 * A framing is CAMERA-ONLY (D-0.7.0-039): choosing one fits the
 * viewport and writes `framing=` through the shared store; it never
 * selects a briefing place, never changes the hazard cluster, and never
 * claims data coverage. Coverage honesty is the caption's job here and
 * the display summary's job in prose: both render the SAME user-facing
 * slice of the framing's coverageNote via userFacingCoverageClause.
 *
 * The three ocean zones are schematic controls, not geographic boundaries.
 * Each enters the shipped ENSO display and fits its configured ocean camera
 * in one explicit gesture. They retain normal Tab stops outside the framing
 * radiogroup because they change both display and camera, while the land
 * framings remain camera-only deferred-commit radios.
 *
 * Keyboard model: one radiogroup (ALL plus the nine framings) with the
 * repository's roving-tabindex idiom (the region radiogroup pattern),
 * but with COMMIT DEFERRED to Enter/Space: a framing commit is
 * expensive and stateful (a camera flight, an ocean-claim clear, a URL
 * write), and WAI-ARIA explicitly permits deferring selection when it
 * has such side effects, so arrows and Home/End only move focus through
 * the options; activating the focused option (Enter/Space via the
 * native button, or a pointer click) commits it. Browsing ten framings
 * therefore costs zero camera flights and zero URL writes until the
 * user chooses.
 */

import type * as maplibregl from 'maplibre-gl';
import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';

import {
  ALL_FRAMING_BOUNDS,
  FRAMINGS,
  FRAMING_KEYS,
  framingFitBounds,
} from '../../config/framings';
import type { FramingKey, FramingSelection } from '../../config/framings';
import type { HazardClusterKey } from '../../config/clusters';
import { OCEANS, OCEAN_KEYS } from '../../config/oceans';
import type { OceanKey } from '../../config/oceans';
import {
  FRAMING_SHAPES,
  FRAMING_SUPPLEMENTAL_SHAPES,
  HAWAII_ISLAND_SHAPES,
} from '../../config/framing-shapes';
import type { LonLat, MainlandFramingKey } from '../../config/framing-shapes';
import {
  MINIMAP_LAKE_PATHS,
  MINIMAP_LAND_PATH,
} from '../../config/minimap-geometry';
import { MINIMAP_WHP } from '../../config/minimap-whp';
import {
  MINIMAP_DROUGHT_COLORS,
  MINIMAP_WILDFIRE_COLORS,
  NADM_CATEGORIES,
} from '../../config/palette';
import { setFraming } from '../../state/framing-store';
import {
  clearOceanFraming,
  getOceanFraming,
  onHazardClusterChange,
} from '../../state/cluster-store';
import { requestOcean } from '../../state/cluster-service';
import { userFacingCoverageClause } from '../../state/display-summary';
import {
  getMinimapDroughtSnapshot,
  retainMinimapDrought,
} from '../../state/minimap-drought';
import type {
  FramingDroughtSummary,
  MinimapDroughtSnapshot,
} from '../../state/minimap-drought';
import {
  getMinimapWildfireSnapshot,
  retainMinimapWildfire,
} from '../../state/minimap-wildfire';
import type {
  MinimapWildfireSnapshot,
  MinimapWildfireSummary,
} from '../../state/minimap-wildfire';
import type { EnsoPhaseLabel } from '../../impact/enso';
import { prefersReducedMotion } from '../../util/motion';

/** The kit's ratified equirectangular drawing plane. The final 8 units
 * leave the small lower gutter carried by the production-candidate SVG. */
const LON_MIN = -188;
const LON_MAX = -52;
const LAT_MIN = 14;
const LAT_MAX = 84;
const DRAWING_WIDTH = 660;
const DRAWING_SCALE = DRAWING_WIDTH / (LON_MAX - LON_MIN);
const DRAWING_MAP_HEIGHT = Math.round((LAT_MAX - LAT_MIN) * DRAWING_SCALE);
const DRAWING_HEIGHT = DRAWING_MAP_HEIGHT + 8;

/** Schematic water affordances. Land controls render above these paths, so
 * the zones own only visible water. They are navigation hit areas, never
 * ocean-boundary geometry. */
const OCEAN_ZONE_PATHS: Readonly<Record<OceanKey, string>> = {
  pacific:
    'M0,54C92,62 174,88 244,128C282,181 316,262 350,348H0Z',
  arctic:
    'M0,0H660V78C572,66 502,78 430,70C344,61 266,70 194,66C126,62 62,70 0,58Z',
  atlantic:
    'M660,54C573,63 511,91 462,136C424,190 389,271 350,348H660Z',
};

type Projector = (point: LonLat) => readonly [number, number];

function project([longitude, latitude]: LonLat): readonly [number, number] {
  return [
    (longitude - LON_MIN) * DRAWING_SCALE,
    (LAT_MAX - latitude) * DRAWING_SCALE,
  ];
}

function shapePath(
  points: readonly LonLat[],
  projector: Projector = project,
): string {
  return (
    'M' +
    points
      .map((point) =>
        projector(point)
          .map((value) => value.toFixed(1))
          .join(','),
      )
      .join('L') +
    'Z'
  );
}

function shapesPath(
  shapes: readonly (readonly LonLat[])[],
  projector: Projector = project,
): string {
  return shapes.map((shape) => shapePath(shape, projector)).join('');
}

interface ViewportFootprintRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const VIEWPORT_FOOTPRINT_MIN_SIZE = 2;

/**
 * Project the main map's current bounds into the drawing plane, clamped to
 * the authored equirectangular window (LON_MIN/MAX, LAT_MIN/MAX) so a
 * camera panned or zoomed past this schematic's coverage still "stays
 * inside the card" (clause 2) instead of drawing off it. This is feedback
 * only: nothing here writes to the framing store or the URL.
 */
function viewportFootprintRect(
  bounds: maplibregl.LngLatBounds | null,
): ViewportFootprintRect | null {
  if (!bounds) return null;
  const clampLon = (lon: number): number =>
    Math.min(LON_MAX, Math.max(LON_MIN, lon));
  const clampLat = (lat: number): number =>
    Math.min(LAT_MAX, Math.max(LAT_MIN, lat));
  const [x1, y1] = project([clampLon(bounds.getWest()), clampLat(bounds.getNorth())]);
  const [x2, y2] = project([clampLon(bounds.getEast()), clampLat(bounds.getSouth())]);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.max(VIEWPORT_FOOTPRINT_MIN_SIZE, Math.abs(x2 - x1)),
    height: Math.max(VIEWPORT_FOOTPRINT_MIN_SIZE, Math.abs(y2 - y1)),
  };
}

const HAWAII_INSET_SCALE = 2.6;
const HAWAII_INSET_X = 8;
const HAWAII_INSET_Y = DRAWING_MAP_HEIGHT - 96;

function projectHawaii([longitude, latitude]: LonLat): readonly [
  number,
  number,
] {
  return [
    HAWAII_INSET_X + (longitude + 160.2) * DRAWING_SCALE * HAWAII_INSET_SCALE,
    HAWAII_INSET_Y + (22.6 - latitude) * DRAWING_SCALE * HAWAII_INSET_SCALE,
  ];
}

const MAINLAND_FRAMING_KEYS: readonly MainlandFramingKey[] =
  FRAMING_KEYS.filter((key): key is MainlandFramingKey => key !== 'hawaii');

const MAINLAND_PATHS: Readonly<Record<MainlandFramingKey, string>> =
  Object.fromEntries(
    MAINLAND_FRAMING_KEYS.map((key) => [
      key,
      shapesPath([
        FRAMING_SHAPES[key],
        ...(FRAMING_SUPPLEMENTAL_SHAPES[key] ?? []),
      ]),
    ]),
  ) as Record<MainlandFramingKey, string>;

const LAKE_PATHS: readonly string[] = Object.values(MINIMAP_LAKE_PATHS);
const HAWAII_PATHS: readonly string[] = HAWAII_ISLAND_SHAPES.map((shape) =>
  shapePath(shape, projectHawaii),
);

/** Fit the camera to a framing, mirroring the boot path's fit. */
function fitFraming(map: maplibregl.Map, key: FramingKey): void {
  const def = FRAMINGS[key];
  map.fitBounds(
    framingFitBounds(def),
    { padding: 20, animate: !prefersReducedMotion() },
  );
}

/** Fit ALL to the full North American minimap extent. */
function fitAll(map: maplibregl.Map): void {
  map.fitBounds(
    framingFitBounds({ bounds: ALL_FRAMING_BOUNDS, padding: 0 }),
    { padding: 20, animate: !prefersReducedMotion() },
  );
}

function fitOcean(map: maplibregl.Map, key: OceanKey): void {
  map.fitBounds(
    framingFitBounds(OCEANS[key]),
    { padding: 20, animate: !prefersReducedMotion() },
  );
}

/** The roving order follows the drawing: nine framings, then ALL. */
const ROVING_ORDER: ReadonlyArray<FramingKey | null> = [...FRAMING_KEYS, null];

const CAMERA_ONLY_NOTE = 'Click fits the camera. Camera-only; selects nothing.';

export type MinimapMetricContext = HazardClusterKey | 'custom';

/**
 * DR-040 c: Heat and ENSO stay explicitly neutral (DDM-UI-004); the minimap
 * never invents a product for them. The literal phrase "Navigation only"
 * leads every one of these sentences so the visible note, its accessible
 * label fallback, and every framing target's accessible name (which all
 * read this same table via `metricNote` / `accessibleName`) say the same
 * honest thing in the same words, satisfying the acceptance clause's
 * "states that it is for navigation only" alternative to a shaded metric.
 */
const NEUTRAL_METRIC_NOTES: Readonly<
  Record<Exclude<MinimapMetricContext, 'drought' | 'wildfire'>, string>
> = {
  heat: 'Navigation only: no verified Extreme Heat framing metric applied.',
  enso: 'Navigation only: no verified ENSO framing metric applied.',
  custom: 'Navigation only: no verified custom-display framing metric applied.'
};

/**
 * The minimap only exists at the desktop shell breakpoint: below 721px
 * `#shell-panel` is `display: none` (src/styles/app.css, the max-width 720px
 * block) and the sheet, footer nav, and hazard rail carry mobile. EF-2: gate
 * the live NADM and NIFC retains on the same query so a phone does not pay
 * a monthly polygon fetch, a browser-side area sample, and a five-minute
 * perimeter poll for a control it never renders. Crossing the breakpoint
 * (rotation, a resized window) starts or stops the work.
 */
const DESKTOP_MINIMAP_QUERY = '(min-width: 721px)';

function useDesktopMinimap(): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(DESKTOP_MINIMAP_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_MINIMAP_QUERY);
    const sync = (): void => setMatches(query.matches);
    // Re-read once on mount: the viewport can change between the lazy
    // island chunk's first render and this effect.
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return matches;
}

/**
 * The compact height band (src/styles/app.css: `@media (min-width: 721px)
 * and (max-height: 699px)`) is where `.shell-minimap-map` (the inline
 * instance) yields to `.shell-minimap-popover-wrap` (the popover instance,
 * behind the "Map areas" door). Duplicated here for the same reason
 * `DESKTOP_MINIMAP_QUERY` is: a JS-side gate on whether an instance's
 * geometry has any chance of being seen (EF-2 in spirit, DDM-P11-T01 in
 * fact) has to match the CSS breakpoint that actually hides it, or the
 * gate lies in one direction or the other.
 */
const COMPACT_HEIGHT_BAND_QUERY = '(min-width: 721px) and (max-height: 699px)';

function useCompactHeightBand(): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia(COMPACT_HEIGHT_BAND_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(COMPACT_HEIGHT_BAND_QUERY);
    const sync = (): void => setMatches(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return matches;
}

const DROUGHT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  NADM_CATEGORIES.map((category) => [category.code, category.label]),
);

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

function droughtClassLabel(code: FramingDroughtSummary['averageClass']): string {
  return code === 'none'
    ? 'None · no drought'
    : `${code} · ${DROUGHT_LABELS[code] ?? 'Drought'}`;
}

/** A secondary, non-color channel so a prevalent `None` fill cannot hide a
 * substantial D1-D4 share. The square-root scale keeps modest impacts visible
 * without letting a 100 percent value swallow the small framing shapes. */
function droughtImpactStrokeWidth(
  summary: FramingDroughtSummary | undefined,
): number {
  if (!summary || summary.droughtPercent <= 0) return 0;
  return 1.6 + Math.sqrt(summary.droughtPercent / 100) * 5.4;
}

function droughtDescription(
  status: MinimapDroughtSnapshot['status'],
  summary: FramingDroughtSummary | undefined,
  month: string | null,
): string {
  if (status === 'loading' || status === 'idle') {
    return 'North American drought summary loading.';
  }
  if (status === 'unavailable' || !summary || month === null) {
    return 'North American drought summary unavailable.';
  }
  const partial =
    summary.coverage === 'live-partial'
      ? ` Coverage is partial. The Nunavut analysis-mask proxy excludes ` +
        `approximately ${summary.notAnalyzedPercent}% of this framing's land.`
      : '';
  return (
    `Approximate area-weighted mean category index: ${droughtClassLabel(summary.averageClass)}, ` +
    `score ${summary.averageSeverityScore} on the ordinal scale None=0 through D4=5. ` +
    `This navigation overview is inferred from NADM polygons, not an NADM-issued regional category. ` +
    `Most prevalent assessed-land condition: ${droughtClassLabel(summary.dominant)}, approximately ` +
    `${summary.dominantPercent}% of assessed land. D1 through D4 drought: ` +
    `${summary.droughtPercent}%. NADM ${monthLabel(month)}.${partial}`
  );
}

function checkedTimeLabel(checkedAtUtc: string | null): string {
  if (checkedAtUtc === null) return 'at an unavailable check time';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(checkedAtUtc));
}

function whpScope(summary: MinimapWildfireSummary): string {
  if (summary.whpCoverage === 'live-partial') {
    return 'The WHP percentage covers only the United States portion of this cross-border framing.';
  }
  if (summary.whpCoverage === 'no-data') {
    return 'The United States WHP raster does not cover this framing.';
  }
  return 'The WHP percentage covers the United States land in this framing.';
}

function wildfireDescription(
  status: MinimapWildfireSnapshot['status'],
  summary: MinimapWildfireSummary | undefined,
  checkedAtUtc: string | null,
): string {
  if (status === 'loading' || status === 'idle') {
    return 'Current mapped wildfire perimeter summary loading.';
  }
  if (!summary || summary.status === 'unavailable') {
    return (
      'Current mapped NIFC wildfire perimeter summary unavailable. ' +
      'Static Wildfire Hazard Potential is not substituted when the current-fire check is unresolved.'
    );
  }

  const check = checkedTimeLabel(checkedAtUtc);
  const perimeterCount = summary.mappedWildfirePerimeterCount ?? 0;
  if (summary.condition === 'mapped-wildfire') {
    return (
      `${perimeterCount} current mapped NIFC wildfire ${perimeterCount === 1 ? 'perimeter intersects' : 'perimeters intersect'} this authored framing; prescribed fire is excluded; browser checked ${check}. ` +
      'This is mapped-perimeter evidence, not a count of every active wildfire.'
    );
  }

  const noMappedPerimeter =
    `No current mapped NIFC wildfire perimeter intersected this authored framing when the browser checked ${check}. `;
  if (summary.condition === 'no-data') {
    return (
      noMappedPerimeter +
      'No United States Forest Service WHP 2023 fallback covers this framing. This does not establish that no wildfire exists.'
    );
  }

  const high = summary.highOrVeryHighPercent ?? 0;
  const moderate = summary.moderateOrHigherPercent ?? 0;
  const scope = whpScope(summary);
  const qualification =
    // vocab-allow: honesty disclaimer denying that static WHP is a forecast
    'WHP 2023 is static strategic landscape potential, not current fire conditions or a forecast.';
  if (summary.condition === 'high-potential') {
    return (
      noMappedPerimeter +
      `Approximately ${high}% of classified WHP land is High or Very High, above the strict 50% threshold. ${scope} ${qualification}`
    );
  }
  if (summary.condition === 'moderate-potential') {
    return (
      noMappedPerimeter +
      `Approximately ${moderate}% of classified WHP land is Moderate, High, or Very High, above the strict 30% threshold; High or Very High is ${high}%. ${scope} ${qualification}`
    );
  }
  return (
    noMappedPerimeter +
    `High or Very High WHP is ${high}%, and Moderate or higher is ${moderate}%; neither strict display threshold is exceeded. ${scope} ${qualification}`
  );
}

/**
 * DR-041 b's fallback caption, named for the science verifier: the
 * organization and product name are fixed strings authored here, the
 * edition is read straight off the generated artifact
 * (src/config/minimap-whp.ts, `source.edition`), never hand-typed.
 */
const WHP_EDITION_CAPTION = `USFS Wildfire Hazard Potential, ${MINIMAP_WHP.source.edition}`;
const WHP_EDITION_YEAR_MATCH = MINIMAP_WHP.source.edition.match(/^\d{4}/);
/**
 * The edition YEAR (e.g. "2023"), not the trailing "updated YYYY-MM-DD"
 * date in the same field: per the issuer's own metadata (USFS
 * RDS-2015-0047-4, ddm-science-verifier check 2026-09-09), that later
 * date is when the Forest Service patched a Nodata classification bug in
 * the already-published 2023 raster, a technical correction, not a
 * refresh of the underlying hazard assessment. The surface itself
 * reflects landscape conditions as of the end of 2020 and is published
 * as the 2023, 4th edition; using the patch date as `data-metric-time`
 * would overstate how current the static fallback is.
 */
const WHP_EDITION_YEAR: string | undefined = WHP_EDITION_YEAR_MATCH?.[0];

function wildfireMetricNote(snapshot: MinimapWildfireSnapshot): string {
  if (snapshot.status === 'loading' || snapshot.status === 'idle') {
    return (
      'Checking current mapped NIFC wildfire perimeters. Static WHP is not ' +
      'substituted until each current-fire check resolves.'
    );
  }
  if (snapshot.status === 'unavailable') {
    return (
      'Current mapped NIFC wildfire perimeter check unavailable. Static WHP ' +
      'is not substituted, so the dark regions are unknown rather than no fire.'
    );
  }
  return (
    `NIFC browser check: ${checkedTimeLabel(snapshot.checkedAtUtc)}. ` +
    'Red marks a current mapped wildfire perimeter; a zero count does not establish no active wildfire. ' +
    'Otherwise, WHP 2023 fills are orange above 50% High or Very High, yellow above 30% Moderate or higher, light below both thresholds, and dark for no data or an unavailable current check. ' +
    // vocab-allow: honesty disclaimer denying that static WHP is a forecast
    'Percentages are approximate shares of classified WHP land in the covered United States portion. WHP is static strategic context, not a forecast; hatching marks partial coverage. ' +
    `A zero current-fire count with WHP data renders desaturated and stippled: ${WHP_EDITION_CAPTION}, a static potential overview, not a current wildfire condition.`
  );
}

function droughtMetricNote(snapshot: MinimapDroughtSnapshot): string {
  if (snapshot.status === 'loading' || snapshot.status === 'idle') {
    return (
      'Loading the North American Drought Monitor monthly consensus for the ' +
      'nine authored framings.'
    );
  }
  if (snapshot.status === 'unavailable' || snapshot.month === null) {
    return (
      'North American Drought Monitor framing summary unavailable, so the ' +
      'neutral fills are unknown rather than an absence of drought.'
    );
  }
  return (
    `North American Drought Monitor monthly consensus, ${monthLabel(snapshot.month)}. ` +
    'Fill is an approximate area-weighted mean category index over assessed land, and outline width is the D1 through D4 share. ' +
    'This navigation overview is inferred from NADM polygons, not an NADM-issued regional category; hatching marks partial coverage.'
  );
}

/**
 * The visible metric note for whichever metric context is showing (EF-3).
 * It used to render on Wildfire alone, so Drought's live NADM encoding was
 * explained only to a screen reader and Heat, ENSO, and custom displays said
 * nothing at all about their flat fills. Neutral contexts keep the neutral
 * sentence verbatim: naming the absence of a framing metric is the honest
 * statement (design record DDM-UI-004), not a defect to paper over.
 */
function metricNote(
  context: MinimapMetricContext,
  drought: MinimapDroughtSnapshot,
  wildfire: MinimapWildfireSnapshot,
): string {
  if (context === 'drought') return droughtMetricNote(drought);
  if (context === 'wildfire') return wildfireMetricNote(wildfire);
  return NEUTRAL_METRIC_NOTES[context];
}

function metricFill(
  droughtSummary: FramingDroughtSummary | undefined,
  wildfireSummary: MinimapWildfireSummary | undefined,
): string | undefined {
  if (droughtSummary) {
    return MINIMAP_DROUGHT_COLORS[droughtSummary.averageClass];
  }
  if (wildfireSummary) {
    return MINIMAP_WILDFIRE_COLORS[wildfireSummary.condition];
  }
  return undefined;
}

function metricIsPartial(
  droughtSummary: FramingDroughtSummary | undefined,
  wildfireSummary: MinimapWildfireSummary | undefined,
): boolean {
  return (
    droughtSummary?.coverage === 'live-partial' ||
    (wildfireSummary?.status === 'live-partial' &&
      wildfireSummary.condition !== 'mapped-wildfire')
  );
}

/**
 * DR-041 b: the fallback case. `condition` reaches one of these three only
 * when the current-perimeter read SUCCEEDED at zero and WHP 2023 answered
 * for the gap (src/state/minimap-wildfire.ts:190-220,
 * `deriveMinimapWildfireSummary`); `unavailable` (the read failed) and
 * `no-data` (WHP has no coverage either) are excluded on purpose, so this
 * never marks a state that has nothing to fall back to. Wildfire's
 * `live-partial` status is unreachable except through one of these three
 * (`mapped-wildfire` is always `status: 'live'`), so this fully subsumes
 * the wildfire share of `metricIsPartial`.
 */
function isWildfireWhpFallback(
  wildfireSummary: MinimapWildfireSummary | undefined,
): boolean {
  return (
    wildfireSummary !== undefined &&
    wildfireSummary.condition !== 'mapped-wildfire' &&
    wildfireSummary.condition !== 'no-data' &&
    wildfireSummary.condition !== 'unavailable'
  );
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(channels: readonly [number, number, number]): string {
  return `#${channels
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`.toUpperCase();
}

/** A neutral slate, already the palette's "unknown/static" hue family
 * (MINIMAP_WILDFIRE_COLORS['no-data'] / ['unavailable']). */
const WHP_FALLBACK_NEUTRAL: readonly [number, number, number] = [148, 163, 184];
const WHP_FALLBACK_DESATURATION = 0.55;

/**
 * DR-041 b: blend a WHP condition color 55% toward neutral slate so the
 * static fallback fill is UNMISTAKABLY not the vivid live/current palette,
 * independent of which of the three WHP condition colors it started from.
 */
function desaturateForWhpFallback(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const [nr, ng, nb] = WHP_FALLBACK_NEUTRAL;
  return rgbToHex([
    r + (nr - r) * WHP_FALLBACK_DESATURATION,
    g + (ng - g) * WHP_FALLBACK_DESATURATION,
    b + (nb - b) * WHP_FALLBACK_DESATURATION,
  ]);
}

type MinimapFillTreatment =
  | { readonly kind: 'solid'; readonly color: string }
  | { readonly kind: 'pattern'; readonly patternId: string };

/**
 * One fill decision per framing shape, used identically for the mainland
 * paths and the Hawaii islands. `whp-fallback` (DR-041 b, desaturated +
 * stippled) takes precedence over the older partial-coverage crosshatch
 * for wildfire, since every wildfire `live-partial` state IS a WHP
 * fallback state (see `isWildfireWhpFallback`); drought's crosshatch is
 * unaffected, wildfire summaries never reach it.
 */
function fillTreatment(
  idPrefix: string,
  key: string,
  droughtSummary: FramingDroughtSummary | undefined,
  wildfireSummary: MinimapWildfireSummary | undefined,
): MinimapFillTreatment | undefined {
  const fill = metricFill(droughtSummary, wildfireSummary);
  if (fill === undefined) return undefined;
  if (isWildfireWhpFallback(wildfireSummary)) {
    return { kind: 'pattern', patternId: `${idPrefix}-whp-${key}` };
  }
  if (metricIsPartial(droughtSummary, wildfireSummary)) {
    return { kind: 'pattern', patternId: `${idPrefix}-partial-${key}` };
  }
  return { kind: 'solid', color: fill };
}

/** Commit a minimap choice: store write plus camera fit, one gesture. */
function choose(map: maplibregl.Map, key: FramingKey | null): void {
  // A framing choice is an explicit camera gesture: it drops any ocean
  // camera claim so the URL never asserts two cameras at once
  // (D-0.7.0-053; the selectRegion precedent in src/ui/sidebar.ts).
  clearOceanFraming();
  setFraming(key ?? 'all');
  if (key === null) fitAll(map);
  else fitFraming(map, key);
}

/** One explicit ocean gesture enters ENSO and moves the camera. The framing
 * store is intentionally untouched; `ocean=` has camera precedence while it
 * is present and the prior authored framing remains available when cleared. */
function chooseOcean(map: maplibregl.Map, key: OceanKey): void {
  requestOcean(key);
  fitOcean(map, key);
}

function oceanAccessibleName(key: OceanKey): string {
  const ocean = OCEANS[key];
  return (
    `${ocean.label}. Switch to the El Nino / Southern Oscillation sea-surface-temperature anomaly display and fit this ocean camera. ` +
    ocean.provenance
  );
}

function accessibleName(
  key: FramingKey,
  drought: MinimapDroughtSnapshot,
  wildfire: MinimapWildfireSnapshot,
  metricContext: MinimapMetricContext,
): string {
  const def = FRAMINGS[key];
  const coverage =
    def.coverageNote !== undefined
      ? userFacingCoverageClause(def.coverageNote)
      : '';
  const base =
    coverage.length > 0 ? `${def.label}. ${coverage}.` : `${def.label}.`;
  // The required provenance qualification travels with the name
  // (FramingDef.provenance is required, never empty, D-0.7.0-051; DG-080
  // review blocker 2): these rectangles visually resemble selectable
  // geographic regions, and the authored-simplification statement is a
  // sovereignty-adjacent honesty requirement, not decoration. Coverage
  // copy does not substitute for geometry provenance.
  const metric =
    metricContext === 'drought'
      ? droughtDescription(
          drought.status,
          drought.summaries[key],
          drought.month,
        )
      : metricContext === 'wildfire'
        ? wildfireDescription(
            wildfire.status,
            wildfire.summaries[key],
            wildfire.checkedAtUtc,
          )
        : NEUTRAL_METRIC_NOTES[metricContext];
  return `${base} ${metric} ${CAMERA_ONLY_NOTE} ${def.provenance}`;
}

export interface MinimapProps {
  readonly map: maplibregl.Map;
  /** The committed minimap camera, owned by the shell's signal. */
  readonly framing: ReadonlySignal<FramingSelection>;
  /** Distinguishes the inline instance from the popover instance so ids
   * stay unique when both are mounted. */
  readonly idPrefix: string;
  /** Drought and Wildfire have source-qualified framing metrics. */
  readonly metricContext: MinimapMetricContext;
}

export function Minimap({
  map,
  framing,
  idPrefix,
  metricContext
}: MinimapProps) {
  const active = framing.value === 'all' ? null : framing.value;
  const [oceanFraming, setOceanFramingState] = useState(getOceanFraming);
  const activeOcean = metricContext === 'enso' ? oceanFraming : null;
  const landSelectionIsCurrent = activeOcean === null;
  const showDroughtMetric = metricContext === 'drought';
  const showWildfireMetric = metricContext === 'wildfire';
  // The roving-focus position, independent of the committed selection
  // (deferred commit; see the header note). `undefined` means "no
  // browsing in progress": the tab stop sits on the committed option.
  const [focused, setFocused] = useState<FramingKey | null | undefined>(
    undefined,
  );
  const [drought, setDrought] = useState<MinimapDroughtSnapshot>(
    getMinimapDroughtSnapshot,
  );
  const [wildfire, setWildfire] = useState<MinimapWildfireSnapshot>(
    getMinimapWildfireSnapshot,
  );
  const [ensoPhase, setEnsoPhase] = useState<EnsoPhaseLabel | null>(null);
  const desktopMinimap = useDesktopMinimap();
  const compactHeightBand = useCompactHeightBand();
  const roving = focused === undefined ? active : focused;

  // DDM-P11-T01 clause 3: this is the ONE shell.tsx mounts the popover
  // instance under (idPrefix "shell-minimap-pop", shell.tsx:309); the
  // inline instance never matches. Derived from the frozen prefix contract
  // shell.tsx documents (":394-406"), not from DOM traversal, so it is
  // known synchronously on the first render with no visibility flash.
  const isPopoverInstance = idPrefix.endsWith('-pop');
  const rootRef = useRef<HTMLDivElement>(null);
  // Closed is the only correct default: a popover starts closed on every
  // boot, and nothing here can open one before this component paints.
  const [popoverOpen, setPopoverOpen] = useState(false);
  useEffect(() => {
    if (!isPopoverInstance) return;
    const host = rootRef.current?.closest('[popover]');
    if (!(host instanceof HTMLElement)) return;
    const sync = (): void => setPopoverOpen(host.matches(':popover-open'));
    sync();
    host.addEventListener('toggle', sync);
    return () => host.removeEventListener('toggle', sync);
  }, [isPopoverInstance]);
  // The inline instance is hidden below 721px (#shell-panel, the whole
  // shell) and again in the compact height band (.shell-minimap-map
  // yields to the popover door there); the popover instance is visible
  // ONLY inside that same band, and only once opened. Either way, this is
  // the single signal that gates every <svg>/<path> below (clause 3): a
  // hidden instance renders none.
  const geometryVisible = isPopoverInstance
    ? compactHeightBand && popoverOpen
    : desktopMinimap && !compactHeightBand;

  // Clause 2: a live footprint of the main map's own camera, independent
  // of the committed framing selection. `map` is the SAME instance the
  // fit* helpers already fly (choose/chooseOcean above); this is the only
  // place anything in this module listens to it move, so there is no
  // second map-listener store to invent.
  const [viewportBounds, setViewportBounds] = useState<maplibregl.LngLatBounds | null>(
    () => map.getBounds(),
  );
  useEffect(() => {
    const sync = (): void => setViewportBounds(map.getBounds());
    sync();
    map.on('moveend', sync);
    return () => {
      map.off('moveend', sync);
    };
  }, [map]);

  useEffect(() => {
    if (!showDroughtMetric || !desktopMinimap) return;
    return retainMinimapDrought(setDrought);
  }, [showDroughtMetric, desktopMinimap]);

  useEffect(() => {
    if (!showWildfireMetric || !desktopMinimap) return;
    return retainMinimapWildfire(setWildfire);
  }, [showWildfireMetric, desktopMinimap]);

  // EF-6: name the current ENSO phase in the scale slot instead of the bare
  // "Navigation only". Label only, from the SAME bundled snapshot and the
  // SAME operational-RONI phase the briefing reads, through one lazy import
  // so the ENSO screen does not pull the impact cluster into the shell
  // chunk. It adds no framing metric: the fills stay neutral, and the
  // accessible name still says so. An unavailable read leaves the existing
  // label untouched rather than asserting a phase.
  useEffect(() => {
    if (metricContext !== 'enso' || !desktopMinimap) return;
    const controller = new AbortController();
    let live = true;
    void (async () => {
      try {
        const { readEnsoPhaseLabel } = await import('../../impact/enso');
        const label = await readEnsoPhaseLabel(controller.signal);
        if (live) setEnsoPhase(label);
      } catch {
        // A failed chunk or read keeps the neutral navigation label.
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [metricContext, desktopMinimap]);

  useEffect(
    () =>
      onHazardClusterChange(() => {
        setOceanFramingState(getOceanFraming());
      }),
    [],
  );

  const onRegionKeyDown = (event: KeyboardEvent, key: FramingKey): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choose(map, key);
  };

  const onOceanKeyDown = (event: KeyboardEvent, key: OceanKey): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    chooseOcean(map, key);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const idx = ROVING_ORDER.indexOf(roving);
    let nextIdx: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIdx = (idx + 1) % ROVING_ORDER.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIdx = (idx - 1 + ROVING_ORDER.length) % ROVING_ORDER.length;
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = ROVING_ORDER.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = ROVING_ORDER[nextIdx];
    if (target === undefined) return;
    // Move focus only; the commit waits for Enter/Space or a click.
    setFocused(target);
    const el = document.getElementById(`${idPrefix}-${target ?? 'all'}`);
    el?.focus();
  };

  const onFocusOut = (event: FocusEvent): void => {
    // Leaving the radiogroup resets the roving position to the committed
    // option, so the next Tab entry lands on the truth.
    const next = event.relatedTarget;
    const group = event.currentTarget as HTMLElement;
    if (!(next instanceof Node) || !group.contains(next)) {
      setFocused(undefined);
    }
  };

  const activeDef = active !== null ? FRAMINGS[active] : null;
  const activeDrought =
    showDroughtMetric && active !== null ? drought.summaries[active] : undefined;
  const activeWildfire =
    showWildfireMetric && active !== null
      ? wildfire.summaries[active]
      : undefined;
  const coverage =
    activeDef?.coverageNote !== undefined
      ? userFacingCoverageClause(activeDef.coverageNote)
      : '';
  // EF-6: the ENSO scale slot names the current operational RONI CONDITIONS
  // (the CPC onset rule on the newest season) and the season they are read
  // from, never the historical five-season episode classification, which
  // lags an event by months. It replaces a label, not a metric: the framings
  // stay neutral (DDM-UI-004), and the accessible name keeps saying so
  // before it names the basin-wide state.
  const ensoScaleText =
    metricContext === 'enso' && ensoPhase !== null
      ? `RONI ${ensoPhase.conditionsName}${ensoPhase.emerging ? ' emerging' : ''} · ${ensoPhase.season} ${ensoPhase.year}`
      : null;
  const ensoScaleAccessibleText =
    metricContext === 'enso' && ensoPhase !== null
      ? `${NEUTRAL_METRIC_NOTES.enso} The operational Relative Oceanic Nino Index reads ${ensoPhase.conditionsName} conditions for the ${ensoPhase.season} ${ensoPhase.year} season` +
        (ensoPhase.emerging
          ? `, with the historical five-season episode classification still reading ${ensoPhase.phaseName}`
          : '') +
        '. It is a basin-wide index label rather than a condition in any framing.'
      : null;
  const scaleText = showDroughtMetric
    ? drought.status === 'live' && drought.month !== null
      ? `NADM · ${monthLabel(drought.month)}`
      : drought.status === 'unavailable'
        ? 'Drought unavailable'
        : 'Loading drought'
    : showWildfireMetric
      ? wildfire.status === 'loading' || wildfire.status === 'idle'
        ? 'Checking wildfire'
        : wildfire.status === 'unavailable'
          ? 'Wildfire unavailable'
          : 'NIFC / WHP 2023'
      : ensoScaleText ?? 'Navigation only';
  const scaleAccessibleText = showDroughtMetric
    ? drought.status === 'live' && drought.month !== null
      ? `North American Drought Monitor monthly consensus, ${monthLabel(drought.month)}. Fill is an approximate area-weighted mean category index; outline width is the D1 through D4 share.`
      : scaleText
    : showWildfireMetric
      ? wildfire.status === 'loading' || wildfire.status === 'idle'
        ? 'Checking current mapped NIFC wildfire perimeters for the nine authored framings.'
        : wildfire.status === 'unavailable'
          ? 'Current mapped NIFC wildfire perimeter summary unavailable. Static WHP is not substituted.'
          : 'Current mapped NIFC wildfire perimeters with static United States Forest Service Wildfire Hazard Potential 2023 fallback.'
      : ensoScaleAccessibleText ?? NEUTRAL_METRIC_NOTES[metricContext];
  const activePartialNote =
    activeDrought?.coverage === 'live-partial'
      ? ` The Nunavut analysis-mask proxy excludes approximately ${activeDrought.notAnalyzedPercent}% of this framing's land.`
      : '';
  const activeWildfireNote =
    activeWildfire?.status === 'live-partial'
      ? ' The WHP fallback covers only the United States portion of this framing.'
      : activeWildfire?.status === 'no-data'
        ? ' WHP 2023 does not cover this framing.'
        : '';
  const viewportRect = geometryVisible
    ? viewportFootprintRect(viewportBounds)
    : null;

  return (
    <div class="shell-minimap" ref={rootRef}>
      <div class="shell-minimap-heading">
        <h2 id={`${idPrefix}-heading`} class="panel-title shell-minimap-title">
          Jump to region
        </h2>
        <span
          id={`${idPrefix}-scale`}
          class="shell-minimap-scale"
          aria-label={scaleAccessibleText}
          title={
            showDroughtMetric
              ? 'North American Drought Monitor monthly consensus; approximate area-weighted mean category index; Nunavut analysis exclusion adapted from Statistics Canada 2021 Digital Boundary Files'
              : showWildfireMetric
                ? wildfire.checkedAtUtc === null
                  ? scaleAccessibleText
                  : `${scaleAccessibleText} ${checkedTimeLabel(wildfire.checkedAtUtc)} is the browser check time, not a source observation time.`
              : scaleAccessibleText
          }
        >
          {scaleText}
        </span>
      </div>
      <div
        class="shell-minimap-canvas"
        data-drought-status={showDroughtMetric ? drought.status : 'neutral'}
        data-wildfire-status={showWildfireMetric ? wildfire.status : 'neutral'}
        data-minimap-status={
          // Six-state vocabulary only (src/ui/island/pill-text.ts:18-25):
          // Heat/ENSO/custom carry no status word at all rather than the
          // former novel 'neutral' sentinel.
          showDroughtMetric
            ? drought.status
            : showWildfireMetric
              ? wildfire.status
              : undefined
        }
        data-metric-context={metricContext}
        // The source's valid month, never a retrieval timestamp; wildfire
        // has no single canvas-wide valid time to put here honestly (its
        // live share is dateless-current, its WHP share is dated per
        // framing below), so it is left absent at this level on purpose.
        data-metric-time={
          showDroughtMetric && drought.status === 'live'
            ? (drought.month ?? undefined)
            : undefined
        }
      >
        {geometryVisible && (
          <svg
            class="shell-minimap-oceans"
            viewBox={`0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
            focusable="false"
          >
            {OCEAN_KEYS.map((key) => {
              return (
                <path
                  key={key}
                  class={`shell-minimap-ocean${activeOcean === key ? ' active' : ''}`}
                  d={OCEAN_ZONE_PATHS[key]}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        )}

        <div class="shell-minimap-ocean-doors" role="group" aria-label="Ocean views">
          {OCEAN_KEYS.map((key) => (
            <button
              type="button"
              id={`${idPrefix}-ocean-${key}`}
              class={`shell-minimap-ocean-door shell-minimap-ocean-door-${key}`}
              aria-pressed={activeOcean === key}
              aria-label={oceanAccessibleName(key)}
              data-ocean={key}
              onClick={() => chooseOcean(map, key)}
              onKeyDown={(event) => onOceanKeyDown(event, key)}
            >
              {OCEANS[key].label}
            </button>
          ))}
        </div>

        <div
          class="shell-minimap-region-group"
          role="radiogroup"
          aria-labelledby={`${idPrefix}-heading ${idPrefix}-scale`}
          onKeyDown={onKeyDown}
          onFocusOut={onFocusOut}
        >
          {geometryVisible && (
          <svg
            class="shell-minimap-drawing"
            viewBox={`0 0 ${DRAWING_WIDTH} ${DRAWING_HEIGHT}`}
            preserveAspectRatio="xMidYMid meet"
          data-geographic-extent={`${LON_MIN},${LAT_MIN},${LON_MAX},${LAT_MAX}`}
          >
          <defs>
            <clipPath
              id={`${idPrefix}-physical-land`}
              clipPathUnits="userSpaceOnUse"
            >
              <path d={MINIMAP_LAND_PATH} clip-rule="evenodd" />
            </clipPath>
            <clipPath
              id={`${idPrefix}-authored-framings`}
              clipPathUnits="userSpaceOnUse"
            >
              {MAINLAND_FRAMING_KEYS.map((key) => (
                <path key={key} d={MAINLAND_PATHS[key]} />
              ))}
            </clipPath>
            {MAINLAND_FRAMING_KEYS.map((key) => {
              const droughtSummary = showDroughtMetric
                ? drought.summaries[key]
                : undefined;
              const wildfireSummary = showWildfireMetric
                ? wildfire.summaries[key]
                : undefined;
              const treatment = fillTreatment(
                idPrefix,
                key,
                droughtSummary,
                wildfireSummary,
              );
              if (!treatment || treatment.kind !== 'pattern') return null;
              const fill = metricFill(droughtSummary, wildfireSummary);
              if (fill === undefined) return null;
              // DR-041 b: the WHP fallback pattern is desaturated fill plus
              // a stipple dot, deliberately distinct from the older
              // diagonal-hatch partial-coverage pattern below it.
              const whpFallback = isWildfireWhpFallback(wildfireSummary);
              return (
                <pattern
                  id={treatment.patternId}
                  key={key}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                >
                  <rect
                    width="8"
                    height="8"
                    fill={whpFallback ? desaturateForWhpFallback(fill) : fill}
                  />
                  {whpFallback ? (
                    <circle cx="2" cy="2" r="0.9" fill="#0F172A" fill-opacity="0.4" />
                  ) : (
                    <path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" />
                  )}
                </pattern>
              );
            })}
          </defs>
          {MAINLAND_FRAMING_KEYS.map((key) => {
            const summary = showDroughtMetric
              ? drought.summaries[key]
              : undefined;
            return (
              <path
                key={`impact-${key}`}
                class="shell-minimap-impact"
                d={MAINLAND_PATHS[key]}
                aria-hidden="true"
                focusable="false"
                vector-effect="non-scaling-stroke"
                stroke-width={droughtImpactStrokeWidth(summary)}
                clip-path={`url(#${idPrefix}-physical-land)`}
                data-impact-framing={key}
              />
            );
          })}
          {MAINLAND_FRAMING_KEYS.map((key) => {
            const isActive = landSelectionIsCurrent && active === key;
            const droughtSummary = showDroughtMetric
              ? drought.summaries[key]
              : undefined;
            const wildfireSummary = showWildfireMetric
              ? wildfire.summaries[key]
              : undefined;
            const treatment = fillTreatment(
              idPrefix,
              key,
              droughtSummary,
              wildfireSummary,
            );
            const whpFallback = isWildfireWhpFallback(wildfireSummary);
            return (
              <path
                key={key}
                id={`${idPrefix}-${key}`}
                class={`shell-minimap-region shell-minimap-mainland${isActive ? ' active' : ''}`}
                d={MAINLAND_PATHS[key]}
                role="radio"
                aria-checked={isActive}
                aria-label={accessibleName(key, drought, wildfire, metricContext)}
                tabIndex={roving === key ? 0 : -1}
                focusable="true"
                vectorEffect="non-scaling-stroke"
                clip-path={`url(#${idPrefix}-physical-land)`}
                style={
                  treatment
                    ? {
                        fill:
                          treatment.kind === 'pattern'
                            ? `url(#${treatment.patternId})`
                            : treatment.color,
                      }
                    : undefined
                }
                data-framing={key}
                data-drought-class={
                  showDroughtMetric
                    ? droughtSummary?.averageClass ?? 'unavailable'
                    : 'neutral'
                }
                data-drought-dominant={
                  showDroughtMetric ? droughtSummary?.dominant : undefined
                }
                data-drought-coverage={
                  showDroughtMetric
                    ? droughtSummary?.coverage ?? 'unavailable'
                    : 'neutral'
                }
                data-not-analyzed-percent={
                  showDroughtMetric
                    ? droughtSummary?.notAnalyzedPercent
                    : undefined
                }
                data-wildfire-condition={
                  showWildfireMetric
                    ? wildfireSummary?.condition ?? 'unavailable'
                    : 'neutral'
                }
                data-wildfire-region-status={
                  showWildfireMetric
                    ? wildfireSummary?.status ?? 'unavailable'
                    : 'neutral'
                }
                data-nifc-perimeter-count={
                  showWildfireMetric
                    ? wildfireSummary?.mappedWildfirePerimeterCount
                    : undefined
                }
                data-whp-high-percent={
                  showWildfireMetric
                    ? wildfireSummary?.highOrVeryHighPercent
                    : undefined
                }
                data-whp-moderate-percent={
                  showWildfireMetric
                    ? wildfireSummary?.moderateOrHigherPercent
                    : undefined
                }
                // DR-041 b: the source's valid time (the WHP edition
                // year, never the trailing correction date in the same
                // field), present only on framings actually showing that
                // static fallback fill; a live mapped-fire framing has no
                // discrete date to claim, so it is absent.
                data-metric-time={
                  showWildfireMetric && whpFallback ? WHP_EDITION_YEAR : undefined
                }
                onClick={() => choose(map, key)}
                onKeyDown={(event) => onRegionKeyDown(event, key)}
                onFocus={() => setFocused(key)}
              />
            );
          })}
          <path
            class="shell-minimap-coastline"
            d={MINIMAP_LAND_PATH}
            clip-path={`url(#${idPrefix}-authored-framings)`}
            fill-rule="evenodd"
            vector-effect="non-scaling-stroke"
            aria-hidden="true"
            focusable="false"
          />
          {LAKE_PATHS.map((path, index) => (
            <path
              key={index}
              class="shell-minimap-lake"
              d={path}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {viewportRect && (
            <>
              {/* Clause 2: feedback only (no onClick/onKeyDown, no store
                  write) mirroring the main map's own getBounds()/moveend,
                  never the committed framing. A white-on-navy halo keeps
                  at least one ring at ~15:1 contrast against every fill
                  in the drought and wildfire palettes (report has the
                  computed ratios); reduced motion needs no handling here
                  because neither rect carries a transition. */}
              <rect
                id={`${idPrefix}-viewport`}
                class="shell-minimap-viewport"
                data-viewport="true"
                x={viewportRect.x}
                y={viewportRect.y}
                width={viewportRect.width}
                height={viewportRect.height}
                aria-hidden="true"
                focusable="false"
                style={{
                  fill: 'none',
                  stroke: '#0F172A',
                  strokeWidth: 3,
                  vectorEffect: 'non-scaling-stroke',
                  pointerEvents: 'none',
                }}
              />
              <rect
                class="shell-minimap-viewport shell-minimap-viewport-inner"
                x={viewportRect.x}
                y={viewportRect.y}
                width={viewportRect.width}
                height={viewportRect.height}
                aria-hidden="true"
                focusable="false"
                style={{
                  fill: 'none',
                  stroke: '#FFFFFF',
                  strokeWidth: 1.5,
                  vectorEffect: 'non-scaling-stroke',
                  pointerEvents: 'none',
                }}
              />
            </>
          )}
          </svg>
          )}

        <button
          type="button"
          id={`${idPrefix}-hawaii`}
          class={`shell-minimap-region shell-minimap-hawaii${landSelectionIsCurrent && active === 'hawaii' ? ' active' : ''}`}
          role="radio"
          aria-checked={landSelectionIsCurrent && active === 'hawaii'}
          aria-label={accessibleName('hawaii', drought, wildfire, metricContext)}
          tabIndex={roving === 'hawaii' ? 0 : -1}
          data-framing="hawaii"
          data-drought-class={
            showDroughtMetric
              ? drought.summaries.hawaii?.averageClass ?? 'unavailable'
              : 'neutral'
          }
          data-drought-dominant={
            showDroughtMetric ? drought.summaries.hawaii?.dominant : undefined
          }
          data-drought-coverage={
            showDroughtMetric
              ? drought.summaries.hawaii?.coverage ?? 'unavailable'
              : 'neutral'
          }
          data-not-analyzed-percent={
            showDroughtMetric
              ? drought.summaries.hawaii?.notAnalyzedPercent
              : undefined
          }
          data-wildfire-condition={
            showWildfireMetric
              ? wildfire.summaries.hawaii?.condition ?? 'unavailable'
              : 'neutral'
          }
          data-wildfire-region-status={
            showWildfireMetric
              ? wildfire.summaries.hawaii?.status ?? 'unavailable'
              : 'neutral'
          }
          data-nifc-perimeter-count={
            showWildfireMetric
              ? wildfire.summaries.hawaii?.mappedWildfirePerimeterCount
              : undefined
          }
          data-whp-high-percent={
            showWildfireMetric
              ? wildfire.summaries.hawaii?.highOrVeryHighPercent
              : undefined
          }
          data-whp-moderate-percent={
            showWildfireMetric
              ? wildfire.summaries.hawaii?.moderateOrHigherPercent
              : undefined
          }
          data-metric-time={
            showWildfireMetric &&
            isWildfireWhpFallback(wildfire.summaries.hawaii)
              ? WHP_EDITION_YEAR
              : undefined
          }
          onClick={() => choose(map, 'hawaii')}
          onFocus={() => setFocused('hawaii')}
        >
          <span class="shell-minimap-hawaii-label">Hawaii (enlarged)</span>
          {geometryVisible && (() => {
            const hawaiiDrought = showDroughtMetric
              ? drought.summaries.hawaii
              : undefined;
            const hawaiiWildfire = showWildfireMetric
              ? wildfire.summaries.hawaii
              : undefined;
            const hawaiiTreatment = fillTreatment(
              idPrefix,
              'hawaii',
              hawaiiDrought,
              hawaiiWildfire,
            );
            const hawaiiWhpFallback = isWildfireWhpFallback(hawaiiWildfire);
            const hawaiiFill = metricFill(hawaiiDrought, hawaiiWildfire);
            return (
              <svg
                class="shell-minimap-hawaii-islands"
                viewBox="4 205 132 104"
                aria-hidden="true"
                focusable="false"
              >
                {hawaiiTreatment && hawaiiTreatment.kind === 'pattern' ? (
                  <defs>
                    <pattern
                      id={hawaiiTreatment.patternId}
                      width="8"
                      height="8"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect
                        width="8"
                        height="8"
                        fill={
                          hawaiiWhpFallback && hawaiiFill !== undefined
                            ? desaturateForWhpFallback(hawaiiFill)
                            : (hawaiiFill ?? MINIMAP_WILDFIRE_COLORS['no-data'])
                        }
                      />
                      {hawaiiWhpFallback ? (
                        <circle cx="2" cy="2" r="0.9" fill="#0F172A" fill-opacity="0.4" />
                      ) : (
                        <path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" />
                      )}
                    </pattern>
                  </defs>
                ) : null}
                {HAWAII_PATHS.map((path, index) => (
                  <path
                    key={`impact-${index}`}
                    class="shell-minimap-impact"
                    d={path}
                    vector-effect="non-scaling-stroke"
                    stroke-width={droughtImpactStrokeWidth(hawaiiDrought)}
                    data-impact-framing="hawaii"
                  />
                ))}
                {HAWAII_PATHS.map((path, index) => (
                  <path
                    key={index}
                    class="shell-minimap-island"
                    d={path}
                    vectorEffect="non-scaling-stroke"
                    style={
                      hawaiiTreatment
                        ? {
                            fill:
                              hawaiiTreatment.kind === 'pattern'
                                ? `url(#${hawaiiTreatment.patternId})`
                                : hawaiiTreatment.color,
                          }
                        : undefined
                    }
                  />
                ))}
              </svg>
            );
          })()}
        </button>

        <button
          type="button"
          id={`${idPrefix}-all`}
          class="shell-minimap-all"
          role="radio"
          aria-checked={landSelectionIsCurrent && active === null}
          aria-label="All: fit North America"
          tabIndex={roving === null ? 0 : -1}
          onClick={() => choose(map, null)}
          onFocus={() => setFocused(null)}
        >
          All
        </button>
        </div>
      </div>
      <hr class="shell-minimap-divider" />
      {/* A committed framing keeps its visible coverage caution. ALL uses
          the divider alone so the default state does not repeat itself. */}
      {activeDef !== null ? (
        <p class="shell-minimap-note" aria-live="polite">
          {activeOcean !== null
            ? `Ocean view: ${OCEANS[activeOcean].label}. ${OCEANS[activeOcean].provenance} Preserved land framing: ${activeDef.label}.`
            : coverage.length > 0
              ? `Framing: ${activeDef.label}. ${coverage}.${activePartialNote}${activeWildfireNote}`
              : `Framing: ${activeDef.label}.${activePartialNote}${activeWildfireNote}`}
        </p>
      ) : activeOcean !== null ? (
        <p class="shell-minimap-note" aria-live="polite">
          Ocean view: {OCEANS[activeOcean].label}. {OCEANS[activeOcean].provenance}
        </p>
      ) : null}
      <p
        class="shell-minimap-metric-note"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {metricNote(metricContext, drought, wildfire)}
      </p>
    </div>
  );
}
