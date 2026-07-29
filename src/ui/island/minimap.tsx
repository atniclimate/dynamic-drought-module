/**
 * The framing minimap (S4b; the S4 design record section 3; the
 * four-round region-selector spike, D-0.7.0-039/041/051/054).
 *
 * A schematic chooser over the nine editorial camera framings
 * (src/config/framings.ts) plus the ALL reset. Each framing renders as
 * a real, absolutely-positioned button whose geometry derives from its
 * authored bounds on a plain equirectangular scale: honest hit areas,
 * native keyboard and assistive-tech behavior, no canvas or SVG focus
 * gymnastics. The drawing itself is label-free for pointer users
 * (D-0.7.0-054); names, provenance framing, and coverage cautions ride
 * the accessible name, the hover title, and the caption line below.
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
import { useState } from 'preact/hooks';

import { FRAMINGS, FRAMING_KEYS } from '../../config/framings';
import type { FramingKey } from '../../config/framings';
import { REGIONS, DEFAULT_REGION, regionToMapLibreBounds } from '../../config/regions';
import { getCurrentRegion } from '../../state/region-store';
import { setFraming } from '../../state/framing-store';
import { clearOceanFraming } from '../../state/cluster-store';
import { userFacingCoverageClause } from '../../state/display-summary';
import { prefersReducedMotion } from '../../util/motion';

/** The schematic's lon/lat extents (covering all nine framings). */
const LON_MIN = -171;
const LON_MAX = -51;
const LAT_MIN = 16.5;
const LAT_MAX = 74.5;

/** Percentage geometry for one framing's button. */
function geometry(key: FramingKey): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const [[south, west], [north, east]] = FRAMINGS[key].bounds;
  const lonSpan = LON_MAX - LON_MIN;
  const latSpan = LAT_MAX - LAT_MIN;
  return {
    left: `${(((west - LON_MIN) / lonSpan) * 100).toFixed(2)}%`,
    top: `${(((LAT_MAX - north) / latSpan) * 100).toFixed(2)}%`,
    width: `${(((east - west) / lonSpan) * 100).toFixed(2)}%`,
    height: `${(((north - south) / latSpan) * 100).toFixed(2)}%`
  };
}

/** Fit the camera to a framing, mirroring the boot path's fit. */
function fitFraming(map: maplibregl.Map, key: FramingKey): void {
  const def = FRAMINGS[key];
  const [[south, west], [north, east]] = def.bounds;
  const pad = def.padding;
  map.fitBounds(
    [
      [west - pad, south - pad],
      [east + pad, north + pad]
    ],
    { padding: 20, animate: !prefersReducedMotion() }
  );
}

/** Fit the camera back to the active legacy region (the ALL state). */
function fitAll(map: maplibregl.Map): void {
  const region = REGIONS[getCurrentRegion() ?? DEFAULT_REGION];
  if (!region) return;
  const [west, south, east, north] = regionToMapLibreBounds(region);
  const pad = region.padding;
  map.fitBounds(
    [
      [west - pad, south - pad],
      [east + pad, north + pad]
    ],
    { padding: 20, animate: !prefersReducedMotion() }
  );
}

/** The roving order: ALL first, then the nine framings. */
const ROVING_ORDER: ReadonlyArray<FramingKey | null> = [null, ...FRAMING_KEYS];

/** The distinct provenance notes across the drawn framing set, for the
 * at-rest caption (no framing committed, all nine shapes still drawn). */
const ALL_PROVENANCE_NOTES: string = [
  ...new Set(FRAMING_KEYS.map((key) => FRAMINGS[key].provenance))
].join(' ');

/** Commit a minimap choice: store write plus camera fit, one gesture. */
function choose(map: maplibregl.Map, key: FramingKey | null): void {
  // A framing choice is an explicit camera gesture: it drops any ocean
  // camera claim so the URL never asserts two cameras at once
  // (D-0.7.0-053; the selectRegion precedent in src/ui/sidebar.ts).
  clearOceanFraming();
  setFraming(key);
  if (key === null) fitAll(map);
  else fitFraming(map, key);
}

function accessibleName(key: FramingKey): string {
  const def = FRAMINGS[key];
  const coverage =
    def.coverageNote !== undefined ? userFacingCoverageClause(def.coverageNote) : '';
  const base = coverage.length > 0 ? `${def.label}. ${coverage}.` : `${def.label}.`;
  // The required provenance qualification travels with the name
  // (FramingDef.provenance is required, never empty, D-0.7.0-051; DG-080
  // review blocker 2): these rectangles visually resemble selectable
  // geographic regions, and the authored-simplification statement is a
  // sovereignty-adjacent honesty requirement, not decoration. Coverage
  // copy does not substitute for geometry provenance.
  return `${base} ${def.provenance}`;
}

/** Hover title: the label plus the same required provenance note. */
function hoverTitle(key: FramingKey): string {
  const def = FRAMINGS[key];
  return `${def.label} · ${def.provenance}`;
}

export interface MinimapProps {
  readonly map: maplibregl.Map;
  /** The committed framing (null = ALL), owned by the shell's signal. */
  readonly framing: ReadonlySignal<FramingKey | null>;
  /** Distinguishes the inline instance from the popover instance so ids
   * stay unique when both are mounted. */
  readonly idPrefix: string;
}

export function Minimap({ map, framing, idPrefix }: MinimapProps) {
  const active = framing.value;
  // The roving-focus position, independent of the committed selection
  // (deferred commit; see the header note). `undefined` means "no
  // browsing in progress": the tab stop sits on the committed option.
  const [focused, setFocused] = useState<FramingKey | null | undefined>(undefined);
  const roving = focused === undefined ? active : focused;

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
  const coverage =
    activeDef?.coverageNote !== undefined
      ? userFacingCoverageClause(activeDef.coverageNote)
      : '';

  return (
    <div class="shell-minimap">
      <div
        class="shell-minimap-canvas"
        role="radiogroup"
        aria-label="Map framing"
        onKeyDown={onKeyDown}
        onFocusOut={onFocusOut}
      >
        <button
          type="button"
          id={`${idPrefix}-all`}
          class="shell-minimap-all"
          role="radio"
          aria-checked={active === null}
          tabIndex={roving === null ? 0 : -1}
          title="All: the full default view"
          onClick={() => choose(map, null)}
        >
          All
        </button>
        {FRAMING_KEYS.map((key, order) => {
          const geo = geometry(key);
          const isActive = active === key;
          return (
            <button
              type="button"
              key={key}
              id={`${idPrefix}-${key}`}
              class={`shell-minimap-region${isActive ? ' active' : ''}${key === 'hawaii' ? ' inset' : ''}`}
              role="radio"
              aria-checked={isActive}
              aria-label={accessibleName(key)}
              title={hoverTitle(key)}
              tabIndex={roving === key ? 0 : -1}
              style={{ ...geo, zIndex: order + 1 }}
              data-framing={key}
              onClick={() => choose(map, key)}
            />
          );
        })}
      </div>
      {/* The caption pair: the live line names the committed framing and
          its coverage caution; the persistent line below carries the
          committed framing's required provenance (FramingDef.provenance,
          D-0.7.0-051; DG-080 review blocker 2) so the visible caption
          never presents an authored rectangle as an authoritative
          boundary. */}
      <p class="shell-minimap-note" aria-live="polite">
        {activeDef === null
          ? 'Framing: All (the full default view).'
          : coverage.length > 0
            ? `Framing: ${activeDef.label}. ${coverage}.`
            : `Framing: ${activeDef.label}.`}
      </p>
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
