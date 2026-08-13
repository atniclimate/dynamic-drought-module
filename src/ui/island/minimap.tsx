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

import type maplibregl from 'maplibre-gl';
import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';

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

const NEUTRAL_METRIC_NOTES: Readonly<
  Record<Exclude<MinimapMetricContext, 'drought' | 'wildfire'>, string>
> = {
  heat: 'No verified Extreme Heat framing metric applied.',
  enso: 'No verified ENSO framing metric applied.',
  custom: 'No verified custom-display framing metric applied.'
};

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
    'Percentages are approximate shares of classified WHP land in the covered United States portion. WHP is static strategic context, not a forecast; hatching marks partial coverage.'
  );
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
  const roving = focused === undefined ? active : focused;

  useEffect(() => {
    if (!showDroughtMetric) return;
    return retainMinimapDrought(setDrought);
  }, [showDroughtMetric]);

  useEffect(() => {
    if (!showWildfireMetric) return;
    return retainMinimapWildfire(setWildfire);
  }, [showWildfireMetric]);

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
      : 'Navigation only';
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
      : NEUTRAL_METRIC_NOTES[metricContext];
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

  return (
    <div class="shell-minimap">
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
          showDroughtMetric
            ? drought.status
            : showWildfireMetric
              ? wildfire.status
              : 'neutral'
        }
        data-metric-context={metricContext}
      >
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
              if (!metricIsPartial(droughtSummary, wildfireSummary)) return null;
              const fill = metricFill(droughtSummary, wildfireSummary);
              if (fill === undefined) return null;
              return (
                <pattern
                  id={`${idPrefix}-partial-${key}`}
                  key={key}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                >
                  <rect
                    width="8"
                    height="8"
                    fill={fill}
                  />
                  <path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" />
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
            const fill = metricFill(droughtSummary, wildfireSummary);
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
                  fill !== undefined
                    ? {
                        fill:
                          metricIsPartial(droughtSummary, wildfireSummary)
                            ? `url(#${idPrefix}-partial-${key})`
                            : fill,
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
          </svg>

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
          onClick={() => choose(map, 'hawaii')}
          onFocus={() => setFocused('hawaii')}
        >
          <span class="shell-minimap-hawaii-label">Hawaii (enlarged)</span>
          <svg
            class="shell-minimap-hawaii-islands"
            viewBox="4 205 132 104"
            aria-hidden="true"
            focusable="false"
          >
            {metricIsPartial(
              showDroughtMetric ? drought.summaries.hawaii : undefined,
              showWildfireMetric ? wildfire.summaries.hawaii : undefined,
            ) ? (
              <defs>
                <pattern
                  id={`${idPrefix}-partial-hawaii`}
                  width="8"
                  height="8"
                  patternUnits="userSpaceOnUse"
                >
                  <rect
                    width="8"
                    height="8"
                    fill={
                      metricFill(
                        showDroughtMetric
                          ? drought.summaries.hawaii
                          : undefined,
                        showWildfireMetric
                          ? wildfire.summaries.hawaii
                          : undefined,
                      ) ?? MINIMAP_WILDFIRE_COLORS['no-data']
                    }
                  />
                  <path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" />
                </pattern>
              </defs>
            ) : null}
            {HAWAII_PATHS.map((path, index) => (
              <path
                key={`impact-${index}`}
                class="shell-minimap-impact"
                d={path}
                vector-effect="non-scaling-stroke"
                stroke-width={droughtImpactStrokeWidth(
                  showDroughtMetric ? drought.summaries.hawaii : undefined,
                )}
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
                  metricFill(
                    showDroughtMetric ? drought.summaries.hawaii : undefined,
                    showWildfireMetric ? wildfire.summaries.hawaii : undefined,
                  ) !== undefined
                    ? {
                        fill: metricIsPartial(
                          showDroughtMetric
                            ? drought.summaries.hawaii
                            : undefined,
                          showWildfireMetric
                            ? wildfire.summaries.hawaii
                            : undefined,
                        )
                          ? `url(#${idPrefix}-partial-hawaii)`
                          : metricFill(
                              showDroughtMetric
                                ? drought.summaries.hawaii
                                : undefined,
                              showWildfireMetric
                                ? wildfire.summaries.hawaii
                                : undefined,
                            ),
                      }
                    : undefined
                }
              />
            ))}
          </svg>
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
      {showDroughtMetric ? null : showWildfireMetric ? (
        <p
          class="shell-minimap-metric-note"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {wildfireMetricNote(wildfire)}
        </p>
      ) : null}
    </div>
  );
}
