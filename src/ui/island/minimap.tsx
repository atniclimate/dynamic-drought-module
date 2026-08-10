/**
 * The framing minimap (S4b; the S4 design record section 3; the
 * four-round region-selector spike, D-0.7.0-039/041/051/054).
 *
 * A schematic chooser over the nine editorial camera framings
 * (src/config/framings.ts) plus the ALL reset. The eight mainland
 * framings use the verified, edge-matched silhouettes promoted from the
 * S4 shell kit; Hawaii is the enlarged inset whose whole frame is its
 * hit target. The drawing itself is label-free for pointer users
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
 * OCEAN ZONES ARE DELIBERATELY OMITTED (the design record's corrected
 * fence): an inert but interactive-looking ocean zone would be faked
 * capability; oceans arrive when S5 makes them do something. The ENSO
 * cluster button still works without them.
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
import {
  FRAMING_SHAPES,
  FRAMING_SUPPLEMENTAL_SHAPES,
  HAWAII_ISLAND_SHAPES,
  LAKE_SHAPES,
} from '../../config/framing-shapes';
import type { LonLat, MainlandFramingKey } from '../../config/framing-shapes';
import { MINIMAP_DROUGHT_COLORS, NADM_CATEGORIES } from '../../config/palette';
import { setFraming } from '../../state/framing-store';
import { clearOceanFraming } from '../../state/cluster-store';
import { userFacingCoverageClause } from '../../state/display-summary';
import {
  getMinimapDroughtSnapshot,
  retainMinimapDrought,
} from '../../state/minimap-drought';
import type {
  FramingDroughtSummary,
  MinimapDroughtSnapshot,
} from '../../state/minimap-drought';
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

const LAKE_PATHS: readonly string[] = LAKE_SHAPES.map((shape) =>
  shapePath(shape),
);
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

/** The roving order follows the drawing: nine framings, then ALL. */
const ROVING_ORDER: ReadonlyArray<FramingKey | null> = [...FRAMING_KEYS, null];

const CAMERA_ONLY_NOTE = 'Click fits the camera. Camera-only; selects nothing.';

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

function dominantLabel(summary: FramingDroughtSummary): string {
  return summary.dominant === 'none'
    ? 'None · no drought'
    : `${summary.dominant} · ${DROUGHT_LABELS[summary.dominant] ?? 'Drought'}`;
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
    `Most prevalent assessed-land condition: ${dominantLabel(summary)}, approximately ` +
    `${summary.dominantPercent}% of assessed land in this framing. D1 through D4 drought: ` +
    `${summary.droughtPercent}%. NADM ${monthLabel(month)}.${partial}`
  );
}

/** The distinct provenance notes across the drawn framing set, for the
 * at-rest caption (no framing committed, all nine shapes still drawn). */
const ALL_PROVENANCE_NOTES: string = [
  ...new Set(FRAMING_KEYS.map((key) => FRAMINGS[key].provenance)),
].join(' ');

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

function accessibleName(
  key: FramingKey,
  drought: MinimapDroughtSnapshot,
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
  return `${base} ${droughtDescription(
    drought.status,
    drought.summaries[key],
    drought.month,
  )} ${CAMERA_ONLY_NOTE} ${def.provenance}`;
}

export interface MinimapProps {
  readonly map: maplibregl.Map;
  /** The committed minimap camera, owned by the shell's signal. */
  readonly framing: ReadonlySignal<FramingSelection>;
  /** Distinguishes the inline instance from the popover instance so ids
   * stay unique when both are mounted. */
  readonly idPrefix: string;
}

export function Minimap({ map, framing, idPrefix }: MinimapProps) {
  const active = framing.value === 'all' ? null : framing.value;
  // The roving-focus position, independent of the committed selection
  // (deferred commit; see the header note). `undefined` means "no
  // browsing in progress": the tab stop sits on the committed option.
  const [focused, setFocused] = useState<FramingKey | null | undefined>(
    undefined,
  );
  const [drought, setDrought] = useState<MinimapDroughtSnapshot>(
    getMinimapDroughtSnapshot,
  );
  const roving = focused === undefined ? active : focused;

  useEffect(() => retainMinimapDrought(setDrought), []);

  const onRegionKeyDown = (event: KeyboardEvent, key: FramingKey): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choose(map, key);
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
  const activeDrought = active !== null ? drought.summaries[active] : undefined;
  const coverage =
    activeDef?.coverageNote !== undefined
      ? userFacingCoverageClause(activeDef.coverageNote)
      : '';
  const scaleText =
    drought.status === 'live' && drought.month !== null
      ? `NADM · ${monthLabel(drought.month)}`
      : drought.status === 'unavailable'
        ? 'Drought unavailable'
        : 'Loading drought';
  const scaleAccessibleText =
    drought.status === 'live' && drought.month !== null
      ? `North American Drought Monitor monthly consensus, ${monthLabel(drought.month)}`
      : scaleText;
  const activePartialNote =
    activeDrought?.coverage === 'live-partial'
      ? ` The Nunavut analysis-mask proxy excludes approximately ${activeDrought.notAnalyzedPercent}% of this framing's land.`
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
          title="North American Drought Monitor; Nunavut analysis exclusion adapted from Statistics Canada 2021 Digital Boundary Files"
        >
          {scaleText}
        </span>
      </div>
      <div
        class="shell-minimap-canvas"
        role="radiogroup"
        aria-labelledby={`${idPrefix}-heading ${idPrefix}-scale`}
        data-drought-status={drought.status}
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
            {MAINLAND_FRAMING_KEYS.map((key) => {
              const summary = drought.summaries[key];
              if (summary?.coverage !== 'live-partial') return null;
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
                    fill={MINIMAP_DROUGHT_COLORS[summary.dominant]}
                  />
                  <path d="M-2,2L2,-2M0,8L8,0M6,10L10,6" />
                </pattern>
              );
            })}
          </defs>
          {MAINLAND_FRAMING_KEYS.map((key) => {
            const summary = drought.summaries[key];
            return (
              <path
                key={`impact-${key}`}
                class="shell-minimap-impact"
                d={MAINLAND_PATHS[key]}
                aria-hidden="true"
                focusable="false"
                vector-effect="non-scaling-stroke"
                stroke-width={droughtImpactStrokeWidth(summary)}
                data-impact-framing={key}
              />
            );
          })}
          {MAINLAND_FRAMING_KEYS.map((key) => {
            const isActive = active === key;
            const summary = drought.summaries[key];
            return (
              <path
                key={key}
                id={`${idPrefix}-${key}`}
                class={`shell-minimap-region shell-minimap-mainland${isActive ? ' active' : ''}`}
                d={MAINLAND_PATHS[key]}
                role="radio"
                aria-checked={isActive}
                aria-label={accessibleName(key, drought)}
                tabIndex={roving === key ? 0 : -1}
                focusable="true"
                vectorEffect="non-scaling-stroke"
                style={
                  summary
                    ? {
                        fill:
                          summary.coverage === 'live-partial'
                            ? `url(#${idPrefix}-partial-${key})`
                            : MINIMAP_DROUGHT_COLORS[summary.dominant],
                      }
                    : undefined
                }
                data-framing={key}
                data-drought-class={summary?.dominant ?? 'unavailable'}
                data-drought-coverage={summary?.coverage ?? 'unavailable'}
                data-not-analyzed-percent={summary?.notAnalyzedPercent}
                onClick={() => choose(map, key)}
                onKeyDown={(event) => onRegionKeyDown(event, key)}
                onFocus={() => setFocused(key)}
              />
            );
          })}
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
          class={`shell-minimap-region shell-minimap-hawaii${active === 'hawaii' ? ' active' : ''}`}
          role="radio"
          aria-checked={active === 'hawaii'}
          aria-label={accessibleName('hawaii', drought)}
          tabIndex={roving === 'hawaii' ? 0 : -1}
          data-framing="hawaii"
          data-drought-class={
            drought.summaries.hawaii?.dominant ?? 'unavailable'
          }
          data-drought-coverage={
            drought.summaries.hawaii?.coverage ?? 'unavailable'
          }
          data-not-analyzed-percent={
            drought.summaries.hawaii?.notAnalyzedPercent
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
            {HAWAII_PATHS.map((path, index) => (
              <path
                key={`impact-${index}`}
                class="shell-minimap-impact"
                d={path}
                vector-effect="non-scaling-stroke"
                stroke-width={droughtImpactStrokeWidth(
                  drought.summaries.hawaii,
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
                  drought.summaries.hawaii
                    ? {
                        fill: MINIMAP_DROUGHT_COLORS[
                          drought.summaries.hawaii.dominant
                        ],
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
          aria-checked={active === null}
          aria-label="All: fit North America"
          tabIndex={roving === null ? 0 : -1}
          onClick={() => choose(map, null)}
          onFocus={() => setFocused(null)}
        >
          All
        </button>
      </div>
      <hr class="shell-minimap-divider" />
      {/* A committed framing keeps its visible coverage caution. ALL uses
          the divider alone so the default state does not repeat itself. */}
      {activeDef !== null ? (
        <p class="shell-minimap-note" aria-live="polite">
          {coverage.length > 0
            ? `Framing: ${activeDef.label}. ${coverage}.${activePartialNote}`
            : `Framing: ${activeDef.label}.${activePartialNote}`}
        </p>
      ) : null}
      {/* The persistent line carries the committed framing's required
          provenance (FramingDef.provenance, D-0.7.0-051; DG-080 review
          blocker 2) so the visible caption never presents authored geometry
          as an authoritative boundary. */}
      <p class="shell-minimap-provenance">
        {activeDef === null
          ? // No framing committed, but the nine authored shapes are
            // drawn regardless; the qualification applies to the drawing
            // itself. The distinct provenance notes of the drawn set are
            // shown (today all nine share one authored-simplification
            // statement, so this renders as the one sentence; a future
            // divergent entry would surface its own note rather than be
            // silently folded).
            ALL_PROVENANCE_NOTES
          : activeDef.provenance}
      </p>
    </div>
  );
}
