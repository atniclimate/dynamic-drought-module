/**
 * Compact on-map condition indicator. Its one disclosure opens the details
 * and categorical key in a bounded, keyboard-scrollable glass card. The
 * desktop Brief drought metric opens the same card; other surfaces use
 * the key's own indicator button.
 *
 * Hazard-aware, reflect-the-map: visibility and content key off the
 * registry. The active condition surface picks the key (US Drought Monitor,
 * NWS HeatRisk, or the SPC fire-weather outlook; the one-surface-at-a-time
 * invariant means at most one is active), with the NIFC perimeter glyphs as
 * the fire fallback when only the event layer is on. Nothing is fetched.
 * Vector swatches come from the map-fill palettes. HeatRisk uses the one
 * issuer-owned mirror table while its raster remains colorized upstream.
 *
 * Also, since 2026-09-10, the ONE render site for the S4 minimap's framing
 * coverage caution (`frameCoverageNote`/`withFrameCoverage` below): a
 * coverage-noted framing (Mexico, the prairie provinces, and the rest) with
 * a US-scoped display layer active earns a coverage line here regardless of
 * which hazard key (or no key at all) is otherwise showing, so it never
 * goes silent just because the surface is not North America Drought. This
 * relocated a sentence that used to pop up on the minimap itself on every
 * framing click and, at the same time, repeat verbatim in the conditions
 * summary caveat; both were retired in its favor (owner ask; see
 * src/config/framings.ts and src/state/display-summary.ts).
 */

import { registry } from '../state/registry';
import { sstAnomalyScaleHtml } from './sst-anomaly-legend';
import { timeline } from '../state/timeline';
import { usdmChangeLegendItems } from '../config/usdm-change';
import {
  BC_DROUGHT_LEVELS,
  BC_DROUGHT_NO_UPDATE,
  CDM_CATEGORIES,
  GRIDDED_INDEX_RAMP,
  HEATRISK_CATEGORIES,
  NADM_CATEGORIES,
  NWS_ALERT_LEGEND,
  OUTLOOK_LEGEND,
  SST_ANOMALY_LABELS,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH,
  SPC_FIREWX_CATEGORIES
} from '../config/palette';
import { LAYER_DEFS, getDroughtSurfacePresentation } from '../config/layers';
import { HAZARD_CLUSTERS } from '../config/clusters';
import { DETAIL_SECTIONS } from '../config/detail-sections';
import { ensureDetailSectionHosts } from './detail-section-hosts';
import {
  NIFC_INCIDENT_PRESENTATION,
  USFS_WHP_PRESENTATION,
  NIFC_KEY_GENERALIZATION_NOTE
} from '../config/wildfire-presentation';
import { FRAMINGS, framingMinimapProvenance } from '../config/framings';
import { getFraming, onFramingChange } from '../state/framing-store';
import { getHazardCluster, getOceanFraming, onHazardClusterChange } from '../state/cluster-store';
import { getViewMode, onViewModeChange } from '../state/view-mode';
import { isUsScopeCautionLayer } from '../state/display-summary';
import { escapeHtml } from '../util/escape';
import { KEY_ELIGIBLE_LABELS, chipFallbackLabel } from '../config/chip-labels';
import { CHIP_STATE_WORDS, chipStateFromStatuses, type ChipState } from '../config/chip-state';
import {
  createHeatRiskSequenceLoader,
  type HeatRiskFrameEventDetail
} from './heatrisk-sequence-loader';
import { openTechnicalInformation } from './impact-panel';
import { watchDesktopMapSeat } from './map-control-seat';
import { getTimeBarSpec, onTimeBarSpecChange } from './time-bar';
import { MAP_GROUND_COLOR } from '../config/interface-tokens';
import { WHP_3D_SHADE_CATEGORIES, WHP_3D_SHADE_QUALIFICATION, WHP_SHADE_CATEGORIES, WHP_SHADE_QUALIFICATION, WHP_SURFACE_OPACITY } from '../config/whp-shade';
import { FUEL_RISK_TITLE, fireKeySections } from './fire3d-fuel-risk';
import {
  TROPICAL_CONE,
  TROPICAL_EMPTY_TEXT,
  TROPICAL_ISSUERS,
  TROPICAL_POINT_CLASSES,
  TROPICAL_POINT_PAPER,
  TROPICAL_PART_NAMES,
  TROPICAL_TRACK,
  TROPICAL_WW_CLASSES,
  tropicalBasinName
} from '../config/tropical-presentation';

export interface KeySpec {
  readonly label: string;
  readonly ariaLabel: string;
  readonly itemsHtml: string;
}

export type MapKeyFamily = 'drought' | 'heat' | 'fire' | 'enso' | 'other';

interface HeatRiskFrame {
  readonly day: number;
  readonly validTime: number;
  readonly name: string;
}

interface NwsSnapshotEventDetail {
  readonly status:
    | 'loading'
    | 'ready'
    | 'degraded'
    | 'error'
    | 'no-data'
    | 'inactive';
  readonly asOf: number | null;
  readonly truncated: boolean;
}

interface CdmSnapshotEventDetail {
  readonly status: 'ready' | 'inactive';
  readonly month: string | null;
  readonly classes: readonly {
    readonly class: string;
    readonly state: 'present' | 'absent-no-occupied-area';
  }[];
  readonly license: {
    readonly title: 'Open Government Licence - Canada';
    readonly url: string;
  } | null;
}

interface NadmSnapshotEventDetail {
  readonly status: 'ready' | 'inactive';
  readonly month: string | null;
}

interface SstSnapshotEventDetail {
  readonly status: 'ready' | 'inactive';
  readonly date: string | null;
}

/**
 * The SST map's direction arrows (src/layers/enso-flow.ts), found-115 and
 * DR-188: their own status, model valid time and qualifications, in the
 * words their panel shows, for a drawer row under the SST key. The arrows'
 * module answers ENSO_FLOW_SNAPSHOT_REQUEST_EVENT with its current state,
 * because this lazy chunk can start after the arrows have loaded.
 */
interface EnsoFlowSnapshotEventDetail {
  readonly status: 'inactive' | 'off' | 'loading' | 'live' | 'live (partial)' | 'no data' | 'unavailable';
  readonly label: string;
  readonly line: string;
  readonly notes: readonly string[];
  /**
   * E1-4 (ENSO-FLOW-PLAN.md; C-fit.md 1.6): the flowing paths' motion state
   * (src/layers/flow/motion-loop.ts `MotionState`). Present only where the
   * paths can move; it alone decides whether the Pause button is offered.
   */
  readonly motion?: 'moving' | 'paused' | 'reduced' | 'held' | 'none';
  /** E1-4: the issuer credit, in the publisher's words, shown as its own item. */
  readonly provenance?: string;
}

/** The tropical cyclones layer's snapshot (src/layers/tropical-cyclones.ts TropicalSnapshot). */
interface TropicalSnapshotEventDetail {
  readonly status: 'inactive' | 'loading' | 'live' | 'live (partial)' | 'unavailable' | 'no data';
  readonly storms: readonly {
    readonly bin: string;
    readonly name: string;
    readonly basin: string;
    readonly advisory: string;
    readonly issued: string;
  }[];
}

const TROPICAL_KEY = 'tropical-cyclones';
const TROPICAL_SNAPSHOT_EVENT = 'ddm:tropical-snapshot';
const TROPICAL_SNAPSHOT_REQUEST_EVENT = 'ddm:tropical-snapshot-request';
let tropicalSnapshot: TropicalSnapshotEventDetail | null = null;

const HEATRISK_FRAMES_EVENT = 'ddm:heatrisk-frames';
const HEATRISK_DAY_SELECT_EVENT = 'ddm:heatrisk-day-select';
const CDM_SNAPSHOT_EVENT = 'ddm:cdm-snapshot';
const NADM_SNAPSHOT_EVENT = 'ddm:nadm-snapshot';
const NWS_SNAPSHOT_EVENT = 'ddm:nws-products-snapshot';
const SST_SNAPSHOT_EVENT = 'ddm:sst-snapshot';
const ENSO_FLOW_SNAPSHOT_EVENT = 'ddm:enso-flow-snapshot';
const ENSO_FLOW_SNAPSHOT_REQUEST_EVENT = 'ddm:enso-flow-snapshot-request';
/** A key button that opens a map feature's popup (the layer that draws it answers). */
const FEATURE_DOOR_EVENT = 'ddm:feature-door';
/** The Pause button's request; src/layers/flow/motion-loop.ts MOTION_REQUEST_EVENT. */
const ENSO_FLOW_MOTION_REQUEST_EVENT = 'ddm:enso-flow-motion-request';
const MOBILE_MAP_KEY_QUERY = '(max-width: 720px)';
const MOBILE_MAP_KEY_HEIGHT_PROPERTY = '--mobile-map-key-height';
const DESKTOP_LOADING_TOP_PROPERTY = '--desktop-loading-top';

let heatRiskFrames: readonly HeatRiskFrame[] = [];
let heatRiskSelectedDay: number | null = null;
let heatRiskFrameStatus: HeatRiskFrameEventDetail['status'] = 'inactive';
let cdmMonth: string | null = null;
let cdmClasses: CdmSnapshotEventDetail['classes'] = [];
let cdmLicense: CdmSnapshotEventDetail['license'] = null;
let nadmMonth: string | null = null;
let sstObservedDate: string | null = null;
let ensoFlowSnapshot: EnsoFlowSnapshotEventDetail | null = null;
let heatRiskHasCoverage: boolean | null = null;
let nwsSnapshotStatus: NwsSnapshotEventDetail['status'] = 'inactive';
let nwsSnapshotAsOf: number | null = null;
let nwsSnapshotTruncated = false;
let disposeMapKeyLayout: (() => void) | null = null;
let disposeMapKeyOverflow: (() => void) | null = null;
let disposeMapKeySeat: (() => void) | null = null;
let disposeMapKeyTimeBarSpec: (() => void) | null = null;
let disposeMapKeyFraming: (() => void) | null = null;
let disposeMapKeyViewMode: (() => void) | null = null;
let disposeMapKeyHazardCluster: (() => void) | null = null;
let whpShadeActive = false;
/** The Wildfire 3D dryness ground (DDM-P9-T13); mirrored literals of src/layers/wildfire-dryness.ts. */
const DRYNESS_GROUND_EVENT = 'ddm:dryness-ground';
const DRYNESS_GROUND_REQUEST_EVENT = 'ddm:dryness-ground-request';
let drynessGround: import('../layers/wildfire-dryness').DrynessGroundDetail | null = null;

/** Third in the key after fires and fuel risk; `data-product-key` is the product mounted on the map. */
function drynessKeyHtml(): string {
  const ground = drynessGround;
  if (!ground) return '';
  return `<span class="map-key-scale" data-dryness-key data-dryness-state="${escapeHtml(ground.state)}" data-product-key="${ground.productKey}">` +
    `<strong>${escapeHtml(ground.title ?? 'Plant stress')}</strong> <span class="map-key-qualification">${escapeHtml(ground.state)}</span>` +
    ground.rows.map((row) => swatchItem(whiteShade(row.alpha), row.label)).join('') +
    ground.lines.map((line) => `<span class="map-key-qualification">${escapeHtml(line)}</span>`).join('') +
    '</span>';
}

/**
 * Seat the on-map key beside the map controls on the desktop shell, and
 * return it to its bottom-dock home everywhere else (owner direction,
 * 2026-08-19: the Fire key belongs with the controls at the top right, not
 * alone in the bottom-left corner). Phones and embeds keep the dock seat
 * their layouts were designed around; see src/ui/map-control-seat.ts.
 */
function watchMapKeySeat(node: HTMLElement): () => void {
  const marker = document.getElementById('map-key-home');
  const overlayHost = document.getElementById('map-key-overlay-host');
  const dock = marker?.parentElement ?? null;
  if (!marker || !overlayHost || !dock) return () => {};
  return watchDesktopMapSeat({
    node,
    host: overlayHost,
    home: dock,
    placeHome: () => {
      if (
        node.parentElement !== dock ||
        node.previousElementSibling !== marker
      ) {
        marker.insertAdjacentElement('afterend', node);
      }
    }
  });
}

interface MapKeyLayoutWatch {
  readonly schedule: () => void;
  readonly dispose: () => void;
}

/**
 * Keep loading chrome clear of the live key and desktop condition indicator.
 * Key content is status-derived and can wrap after a registry update, a font
 * swap, text scaling, or a viewport change, so a fixed pixel offset cannot be
 * honest. The measured height is presentation state only and never enters the
 * URL or layer state.
 */
function watchMapKeyLayout(host: HTMLElement): MapKeyLayoutWatch {
  const app = document.getElementById('app');
  if (!app) {
    return { schedule: () => {}, dispose: () => {} };
  }

  const widthQuery = window.matchMedia(MOBILE_MAP_KEY_QUERY);
  const indicator = document.getElementById('map-condition-indicator');
  const loading = document.getElementById('loading-indicator');
  const controls = document.querySelector<HTMLElement>('.map-overlay-controls');
  const bottomDock = document.getElementById('map-bottom-dock');
  let frame: number | null = null;
  let disposed = false;

  const measure = (): void => {
    frame = null;
    if (disposed) return;
    const content = host.querySelector<HTMLElement>('#map-key-content');
    const mapBox = document.getElementById('map-container')?.getBoundingClientRect();
    if (content && !content.hidden && mapBox) {
      const contentBox = content.getBoundingClientRect();
      // S30D D1 M11 repair round: the Key drawer never intersects the
      // scale bars, but that invariant is already the CSS hard ceiling
      // at hazard-indicators.css:243 (`max-height: min(55vh, 420px,
      // var(--map-key-available-height, 55vh))`), not this JS bound. A
      // scale-bar-aware clamp on `bottomLimit` was tried here and proven
      // unreachable: with the indicator's content starting about 12px
      // (indicator top) below the map plus the closed chip's own ~40px,
      // `available` computed from the plain viewport/dock bottom alone
      // never drops under the 420px (396px at a 720px-tall viewport)
      // ceiling at any width and height this app supports, so the
      // scale bar's own top edge was never the smaller operand and the
      // clamp never changed what rendered. Dead code is not shipped; the
      // CSS ceiling alone carries the guarantee, proven by
      // tests/map-chrome-seats.spec.ts's own "never intersects ... the
      // scale bars" case.
      const bottomLimit = Math.min(window.innerHeight, mapBox.bottom);
      let available = bottomLimit - contentBox.top - 16;
      if (app.classList.contains('embed')) {
        // Embeds keep the key in a bottom-anchored dock. Growing content
        // raises its header and any preceding date stamp or notices, so
        // reserve the whole dock prefix below the upper controls.
        const keyBox = host.getBoundingClientRect();
        const dockTop = bottomDock?.getBoundingClientRect().top ?? keyBox.top;
        const controlsBox = controls?.getBoundingClientRect();
        const overlapsControls = controlsBox && keyBox.left < controlsBox.right && keyBox.right > controlsBox.left;
        const top = overlapsControls ? Math.max(mapBox.top, controlsBox.bottom) + 8 : mapBox.top + 8;
        available = keyBox.bottom - top - (contentBox.top - dockTop);
      }
      host.style.setProperty('--map-key-available-height', `${Math.max(0, Math.floor(available))}px`);
    } else host.style.removeProperty('--map-key-available-height');
    // Compare horizontal ranges only: reading the top we set here would
    // otherwise alternate between "overlap" and "clear" on every measure.
    if (!widthQuery.matches && !app.classList.contains('embed') && indicator && loading && !loading.hidden) {
      const indicatorBox = indicator.getBoundingClientRect();
      const loadingBox = loading.getBoundingClientRect();
      const containerBox = loading.offsetParent?.getBoundingClientRect();
      const overlaps = indicatorBox.height > 0 && loadingBox.width > 0 &&
        loadingBox.left < indicatorBox.right + 8 && loadingBox.right > indicatorBox.left - 8;
      if (overlaps && containerBox) {
        app.style.setProperty(DESKTOP_LOADING_TOP_PROPERTY, `${Math.ceil(indicatorBox.bottom - containerBox.top + 8)}px`);
      } else app.style.removeProperty(DESKTOP_LOADING_TOP_PROPERTY);
    } else app.style.removeProperty(DESKTOP_LOADING_TOP_PROPERTY);
    if (!widthQuery.matches || host.hidden || !host.isConnected) {
      app.style.removeProperty(MOBILE_MAP_KEY_HEIGHT_PROPERTY);
      return;
    }
    const height = Math.ceil(host.getBoundingClientRect().height);
    if (height > 0) {
      app.style.setProperty(MOBILE_MAP_KEY_HEIGHT_PROPERTY, `${height}px`);
    } else {
      app.style.removeProperty(MOBILE_MAP_KEY_HEIGHT_PROPERTY);
    }
  };

  const schedule = (): void => {
    if (disposed || frame !== null) return;
    frame = window.requestAnimationFrame(measure);
  };

  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(host);
  if (indicator) observer?.observe(indicator);
  if (loading) observer?.observe(loading);
  if (controls) observer?.observe(controls);
  if (bottomDock) observer?.observe(bottomDock);
  const loadingVisibility = new MutationObserver(schedule);
  if (loading) loadingVisibility.observe(loading, { attributes: true, attributeFilter: ['hidden'] });
  widthQuery.addEventListener('change', schedule);
  window.addEventListener('resize', schedule);
  void document.fonts?.ready.then(schedule);
  schedule();

  return {
    schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      loadingVisibility.disconnect();
      widthQuery.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      app.style.removeProperty(MOBILE_MAP_KEY_HEIGHT_PROPERTY);
      app.style.removeProperty(DESKTOP_LOADING_TOP_PROPERTY);
      host.style.removeProperty('--map-key-available-height');
    }
  };
}

/** Presentation-only family for semantic CSS hooks and disclosure behavior. */
export function resolveMapKeyFamily(
  active: ReadonlySet<string>
): MapKeyFamily {
  // Keep this precedence identical to activeKey(): the family describes the
  // key that is actually rendered when a custom URL activates mixed layers.
  if (active.has('heatrisk')) return 'heat';
  if (active.has('spc-fire-weather') || active.has('usfs-whp') || active.has('usfs-whp-classes')) return 'fire';
  if (
    active.has('usdm') ||
    active.has('nadm-drought') ||
    active.has('cdm-drought') ||
    active.has('drought') ||
    active.has('gridded-index')
  ) {
    return 'drought';
  }
  // The SST anomaly surface outranks the NIFC event fallback like every
  // other condition surface. UI-14(b): it now resolves to its own 'enso'
  // family instead of falling into 'other', so the ENSO screen's key is a
  // named peer of drought, fire, and heat for CSS hooks, disclosure
  // behavior, and tests. Naming the family adds no styling by itself.
  if (active.has('sst-anomaly')) return 'enso';
  if (active.has('nifc-fires')) return 'fire';
  return 'other';
}

function swatchItem(color: string, code: string): string {
  return `<span class="map-key-item"><span class="map-key-swatch" style="background:${escapeHtml(
    color
  )}"></span>${escapeHtml(code)}</span>`;
}

/**
 * A Wildfire 3D white shade (fuel risk, plant stress) as it reads on the map:
 * white at `alpha` over the map's dark ground. Nothing drawn is a transparent swatch.
 */
function whiteShade(alpha: number): string {
  if (alpha === 0) return 'transparent';
  const white = `rgba(255,255,255,${alpha})`;
  return `linear-gradient(${white},${white}),${MAP_GROUND_COLOR}`;
}

function droughtKey(): KeySpec {
  if (getDroughtSurfacePresentation().edition === 'usdm' && timeline.usdmMode !== 'absolute') {
    const span = timeline.usdmMode === 'chg4' ? '4-week' : '1-week';
    const title = `Drought change key (${span})`;
    return {
      label: title,
      ariaLabel: title,
      itemsHtml: usdmChangeLegendItems().map(item => swatchItem(item.color, item.label)).join('')
    };
  }
  const presentation = getDroughtSurfacePresentation();
  // DR-160 (2026-09-28): while BC_BASIN_EDITION_HELD is true in
  // src/config/layers.ts, no writer ever sets edition 'bc-basin'
  // (src/layers/usdm.ts editionForRegion, src/ui/sidebar.ts selectRegion),
  // so this branch is unreachable; it stays dormant, not deleted, for the
  // hold's eventual release.
  if (presentation.edition === 'bc-basin') {
    const date = presentation.sourceDate ?? 'unavailable';
    return {
      label: 'BC drought',
      ariaLabel:
        `British Columbia basin drought-level key, levels 0 through 5, No update means not measured right now. Province of British Columbia, source date ${date}.`,
      itemsHtml:
        `<span class="map-key-item">Province of British Columbia · ${escapeHtml(date)}</span>` +
        [...BC_DROUGHT_LEVELS, BC_DROUGHT_NO_UPDATE]
          .map((entry) => swatchItem(entry.color, entry.code))
          .join('')
    };
  }
  return {
    label: 'Drought',
    ariaLabel:
      'Drought category key, D0 abnormally dry through D4 exceptional drought. No polygon means no D0-D4 category is drawn; without an analyzed-area mask it does not confirm no drought.',
    itemsHtml:
      [USDM_NONE_SWATCH, ...USDM_CATEGORIES]
        .map((c) => swatchItem(c.color, c.code))
        .join('')
  };
}

function formatSstDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year!, month! - 1, day! )));
}

/**
 * The ENSO ocean-surface key (W2-D1): the one quick view that previously
 * had no on-map scale. Full source colors and existing qualitative words
 * come from the same helper as the sidebar legend. The observed
 * date mirrors the frame the ddm:sst-snapshot event announced (the same
 * date the temporal stamp shows); the scale stays qualitative because the
 * GIBS metadata states no climatology baseline.
 */
function sstKey(): KeySpec {
  const observed = sstObservedDate
    ? ` Observed ${formatSstDate(sstObservedDate)}.`
    : '';
  const first = SST_ANOMALY_LABELS[0];
  const last = SST_ANOMALY_LABELS[2];
  const flow = ensoFlowRow();
  return {
    label: 'Ocean temperature',
    ariaLabel:
      `Ocean temperature anomaly key, ${first.toLowerCase()} through ${last.toLowerCase()}, a qualitative scale.` +
      observed +
      ' NASA GIBS GHRSST MUR SST anomaly.' +
      flow.ariaLabel,
    itemsHtml:
      (sstObservedDate
        ? `<span class="map-key-item" data-sst-observed>Observed ${escapeHtml(
            formatSstDate(sstObservedDate)
          )}</span>`
        : '') +
      '<span class="map-key-scale" data-sst-anomaly-key>' +
      sstAnomalyScaleHtml() +
      '</span>' +
      '<span class="map-key-item" data-sst-attribution>NASA GIBS GHRSST MUR</span>' +
      // A keyboard door to the box's popup (the box's own title; src/layers/sst-anomaly.ts answers it).
      '<button type="button" class="map-key-item map-key-door" data-feature-door="nino34">Nino 3.4 (the ENSO index region)</button>' +
      flow.html
  };
}

/**
 * The direction arrows' own row, after the SST attribution and apart from
 * the SST "Observed" row: two products, two clocks (docs/design/README.md,
 * DDM-UI-007). Every word is the arrows' module's own; this only joins them.
 * For the NODD kinds the notes are the bins and any live-state sentence; what
 * the lines and marks mean reads in the Impact Briefing
 * (src/ui/map-technical-information.ts). No row while the arrows are off or
 * their layer is inactive.
 */
function ensoFlowRow(): { readonly html: string; readonly ariaLabel: string } {
  const flow = ensoFlowSnapshot;
  if (!flow || flow.status === 'inactive' || flow.status === 'off') return { html: '', ariaLabel: '' };
  // DRAFT wording (DR-177): pending owner read (DRAFT-W1, the
  // composition "<label> · <status line>" then the qualification sentences).
  const status = `${flow.label} · ${flow.line}`;
  const notes = flow.notes.join(' ');
  // E1-4: the credit is its own text item, as data-sst-attribution is for
  // the SST; the words are the publisher's, never typed here.
  const provenance = flow.provenance ?? '';
  return {
    html:
      `<span class="map-key-item" data-enso-flow="status">${escapeHtml(status)}</span>` +
      (provenance ? `<span class="map-key-item" data-enso-flow="provenance">${escapeHtml(provenance)}</span>` : '') +
      (notes ? `<span class="map-key-qualification" data-enso-flow="notes">${escapeHtml(notes)}</span>` : ''),
    ariaLabel: ` ${status}.` + (provenance ? ` ${provenance}.` : '')
  };
}

/**
 * The flowing paths' Pause toggle (E1-4). Built once by initMapKey and only
 * shown, hidden and renamed here, never re-created. The icon and the
 * accessible name swap together and say what a press does (two bars and
 * "Pause motion" while the lines move, a play triangle and "Play motion"
 * while they hold still), so the button carries no aria-pressed (APG button
 * pattern: a name that changes, or a pressed state, never both). The names
 * stay apart from the time bar's own "Pause" and "Play" for the SST days.
 */
function buildFlowPauseButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'map-key-flow-pause';
  button.className = 'map-key-flow-pause';
  // DRAFT (DR-draft, block E1 E1-4): pending owner read
  // DRAFT wording (DR-177): "Pause motion", the flowing paths' toggle name,
  // on ENSO-FLOW-PLAN.md question 6's read-back list.
  button.setAttribute('aria-label', 'Pause motion');
  button.dataset.paused = 'false';
  button.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const bars = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  bars.setAttribute('class', 'map-key-flow-pause-bars');
  bars.setAttribute('d', 'M4 3h3v10H4zM9 3h3v10H9z');
  const play = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  play.setAttribute('class', 'map-key-flow-pause-play');
  play.setAttribute('d', 'M4.5 2.5 13 8l-8.5 5.5z');
  svg.append(bars, play);
  button.append(svg);
  return button;
}

/**
 * Show the toggle only while the paths' snapshot reports motion, and offer
 * Play while they are paused or still under reduced motion. `held` (the SST
 * days playing, a hidden tab) is no one's pause, so it still offers Pause.
 */
function syncFlowPause(
  host: HTMLElement,
  button: HTMLButtonElement,
  flow: EnsoFlowSnapshotEventDetail | null
): void {
  const motion =
    flow && flow.status !== 'inactive' && flow.status !== 'off' && flow.motion && flow.motion !== 'none'
      ? flow.motion
      : null;
  button.hidden = motion === null;
  if (motion === null) {
    delete host.dataset.flowMotion;
    return;
  }
  host.dataset.flowMotion = motion;
  const paused = motion === 'paused' || motion === 'reduced';
  button.dataset.paused = String(paused);
  // DRAFT wording (DR-177): "Play motion", the same toggle's name while the lines hold still.
  button.setAttribute('aria-label', paused ? 'Play motion' : 'Pause motion');
}

function formatHeatRiskDate(validTime: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(validTime));
}

function heatDateControl(): string {
  if (
    heatRiskFrames.length === 0 ||
    heatRiskSelectedDay === null
  ) {
    const state =
      heatRiskFrameStatus === 'error'
        ? 'Valid date unavailable'
        : 'Loading valid dates';
    return `<span class="map-key-item" data-heatrisk-date>${escapeHtml(state)}</span>`;
  }

  const options = heatRiskFrames
    .map((frame) => {
      const selected = frame.day === heatRiskSelectedDay ? ' selected' : '';
      const label = `Day ${frame.day} · ${formatHeatRiskDate(frame.validTime)}`;
      return `<option value="${frame.day}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');
  return (
    '<label class="map-key-item" data-heatrisk-date>Valid date ' +
    `<select data-heatrisk-day aria-label="HeatRisk valid date">${options}</select></label>`
  );
}

function heatKey(): KeySpec {
  // The coverage caveat lives in Technical information, not the key.
  if (heatRiskHasCoverage === false) {
    return {
      label: 'HeatRisk',
      ariaLabel: 'No HeatRisk data at the map center.',
      itemsHtml:
        '<span class="map-key-qualification" data-heatrisk-coverage>' +
        '<strong>no data</strong> at the map center</span>'
    };
  }

  const selected = heatRiskFrames.find(
    (frame) => frame.day === heatRiskSelectedDay
  );
  const validDate = selected
    ? ` Valid ${formatHeatRiskDate(selected.validTime)}.`
    : '';
  const firstCategory = HEATRISK_CATEGORIES[0]!;
  const lastCategory = HEATRISK_CATEGORIES.at(-1)!;
  // A DAY CHANGE IS A FETCH (DDM-P8-T05). The selected frame's source is
  // replaced whenever the day changes, so between the teardown and the
  // first tile the key would otherwise present the full scale under the
  // NEW valid date with nothing painted under it. `loading` is the honest
  // qualification for that window, in the same W2-D6 form an activation
  // placeholder uses; the frame watcher replaces it with the terminal
  // verdict, so it cannot outlive the fetch.
  const frameLoading = heatRiskFrameStatus === 'loading';
  return {
    label: 'HeatRisk',
    ariaLabel:
      `NWS HeatRisk key, value ${firstCategory.value} ${firstCategory.label} through value ${lastCategory.value} ${lastCategory.label} expected heat impact (experimental product).` +
      validDate +
      (frameLoading
        ? ' Loading: the selected frame has not painted yet.'
        : heatRiskFrameStatus === 'degraded'
          ? ' Live (partial): selected frame has missing tiles.'
          : heatRiskFrameStatus === 'error'
            ? ' Unavailable: no selected-frame tiles loaded.'
            : ''),
    itemsHtml:
      heatDateControl() +
      '<span class="map-key-scale" data-heatrisk-scale>' +
      '<strong class="map-key-scale-label">Surface</strong>' +
      HEATRISK_CATEGORIES.map((category) =>
        swatchItem(
          // class 0 is not shaded on the map (exportImage noData=0)
          category.value === 0 ? 'transparent' : category.color,
          `${category.value} ${category.label}`
        )
      ).join('') +
      '</span>' +
      (frameLoading
        ? '<span class="map-key-qualification map-key-loading" data-key-loading="heatrisk">' +
          '<strong>loading</strong> The selected frame has not painted yet.</span>'
        : heatRiskFrameStatus === 'degraded'
          ? '<span class="map-key-qualification" data-heatrisk-tile-status><strong>live (partial)</strong> Selected frame has missing tiles.</span>'
          : heatRiskFrameStatus === 'error'
            ? '<span class="map-key-qualification" data-heatrisk-tile-status><strong>unavailable</strong> No selected-frame tiles loaded.</span>'
            : '')
  };
}

function nwsProductKey(): {
  readonly html: string;
  readonly ariaLabel: string;
} {
  return {
    html:
      '<span class="map-key-scale map-key-nws-products" data-nws-products-key>' +
      '<strong class="map-key-scale-label">NWS products</strong>' +
      NWS_ALERT_LEGEND.map(({ color, label }) => swatchItem(color, label)).join('') +
      '</span>',
    ariaLabel:
      `National Weather Service event products: ${NWS_ALERT_LEGEND.map(({ label }) => label).join(', ')}.`
  };
}

/** "1:14 AM, Oct 19" on the viewer's clock: when DDM last read the products. */
function formatSnapshotTime(time: number): string {
  const date = new Date(time);
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return `${clock.format(date)}, ${day.format(date)}`;
}

function nwsSnapshotQualification(): {
  readonly html: string;
  readonly ariaLabel: string;
} {
  if (nwsSnapshotAsOf === null) {
    const unavailable = nwsSnapshotStatus === 'error';
    return {
      html: `<span class="map-key-qualification" data-nws-snapshot>${
        unavailable ? 'Unavailable' : 'Loading'
      }</span>`,
      ariaLabel: unavailable
        ? 'National Weather Service products unavailable.'
        : 'National Weather Service products loading.'
    };
  }
  // "As of", not "Valid": the time is DDM's read, not an NWS validity time.
  const stamp = formatSnapshotTime(nwsSnapshotAsOf);
  const partial =
    nwsSnapshotTruncated || nwsSnapshotStatus === 'degraded'
      ? ' live (partial): transfer limit reached.'
      : '';
  return {
    html:
      '<span class="map-key-qualification" data-nws-snapshot>' +
      `As of ${escapeHtml(stamp)}${
        partial
          ? ' <strong>live (partial)</strong>: transfer limit reached.'
          : ''
      }</span>`,
    ariaLabel: `National Weather Service products as of ${stamp}.${partial}`
  };
}

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

function cdmKey(): KeySpec {
  const month = cdmMonth ? formatMonth(cdmMonth) : 'month unavailable';
  const stateByClass = new Map(
    cdmClasses.map((entry) => [entry.class, entry.state])
  );
  return {
    label: 'Canada drought',
    ariaLabel:
      `Canadian Drought Monitor key for ${month}. Agriculture and Agri-Food Canada. Areas without a polygon are not assigned class zero.`,
    itemsHtml:
      `<span class="map-key-item">${escapeHtml(month)}</span>` +
      CDM_CATEGORIES.map((entry) =>
        swatchItem(
          entry.color,
          stateByClass.get(entry.code) === 'absent-no-occupied-area'
            ? `${entry.code} none this month`
            : entry.code
        )
      ).join('') +
      '<span class="map-key-item">No polygon: no coverage in artifact</span>' +
      (cdmLicense
        ? `<a class="map-key-item" href="${escapeHtml(cdmLicense.url)}" target="_blank" rel="noopener">${escapeHtml(cdmLicense.title)}</a>`
        : '')
  };
}

function nadmKey(): KeySpec {
  const month = nadmMonth ? formatMonth(nadmMonth) : 'month unavailable';
  return {
    label: 'North America drought',
    ariaLabel:
      `North American Drought Monitor tri-national consensus key for ${month}. No polygon means no coverage from this source, not class zero.`,
    itemsHtml:
      `<span class="map-key-item">${escapeHtml(month)} · tri-national consensus</span>` +
      NADM_CATEGORIES.map((entry) => swatchItem(entry.color, entry.code)).join('') +
      '<span class="map-key-item">No polygon: no source coverage</span>'
  };
}

/** The CPC outlook classes, from the same table the sidebar legend draws. */
function outlookKey(): KeySpec {
  return {
    label: KEY_ELIGIBLE_LABELS['drought']!,
    ariaLabel: 'NOAA Climate Prediction Center drought outlook key. An outlook is a shift in odds, not an observed condition.',
    itemsHtml: OUTLOOK_LEGEND.map((entry) => swatchItem(entry.color, entry.label)).join('')
  };
}

/** The gridded index ramp, drier to wetter; the unlabeled white slot is left out. */
function griddedKey(): KeySpec {
  return {
    label: KEY_ELIGIBLE_LABELS['gridded-index']!,
    ariaLabel: 'Gridded Standardized Precipitation Index key, drier to wetter. NOAA NIDIS.',
    itemsHtml: GRIDDED_INDEX_RAMP.flatMap((entry) => (entry.code ? [swatchItem(entry.color, entry.code)] : [])).join('')
  };
}

/** A placeholder row for a still-loading key section (W2-D6): the section
 * is named rather than omitted, so live activation never silently drops a
 * source from the reference. 'unavailable' keeps its absence semantics. */
function loadingSectionRow(key: string): string {
  return (
    `<span class="map-key-item map-key-loading" data-key-loading="${escapeHtml(key)}">` +
    'loading</span>'
  );
}

export function buildFireKey(
  activeKeys: ReadonlySet<string>,
  loadingKeys: ReadonlySet<string> = new Set()
): KeySpec {
  const includeSpcOutlook = activeKeys.has('spc-fire-weather');
  const includeNifcPerimeters = activeKeys.has('nifc-fires');
  const spcLoading = !includeSpcOutlook && loadingKeys.has('spc-fire-weather');
  const nifcLoading = !includeNifcPerimeters && loadingKeys.has('nifc-fires');
  if (!includeSpcOutlook && !includeNifcPerimeters && !spcLoading && !nifcLoading) {
    throw new Error('A fire key requires at least one active fire product.');
  }
  const outlook =
    includeSpcOutlook || spcLoading
      ? '<span class="map-key-scale" data-spc-fire-weather-key>' +
        '<strong class="map-key-scale-label">SPC Day 1 outlook</strong>' +
        (spcLoading
          ? loadingSectionRow('spc-fire-weather')
          : SPC_FIREWX_CATEGORIES.map((c) => swatchItem(c.color, c.label)).join('')) +
        '</span>'
      : '';
  const perimeters =
    includeNifcPerimeters || nifcLoading
      ? '<span class="map-key-scale" data-nifc-perimeter-key>' +
        '<strong class="map-key-scale-label">NIFC WFIGS current mapped perimeters</strong>' +
        (nifcLoading
          ? loadingSectionRow('nifc-fires')
          : swatchItem(
              NIFC_INCIDENT_PRESENTATION.wildfire.lineColor,
              NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel
            ) +
            swatchItem(
              NIFC_INCIDENT_PRESENTATION.prescribed.lineColor,
              NIFC_INCIDENT_PRESENTATION.prescribed.legendLabel
            ) +
            swatchItem(
              NIFC_INCIDENT_PRESENTATION.other.lineColor,
              NIFC_INCIDENT_PRESENTATION.other.legendLabel
            ) +
            '<span class="map-key-qualification" data-nifc-generalization>' +
            escapeHtml(NIFC_KEY_GENERALIZATION_NOTE) +
            '</span>') +
        '</span>'
      : '';
  const ariaParts: string[] = [];
  if (includeSpcOutlook) {
    ariaParts.push(
      'Storm Prediction Center (SPC) Day 1 fire-weather outlook categories.'
    );
  } else if (spcLoading) {
    ariaParts.push(
      'Storm Prediction Center (SPC) Day 1 fire-weather outlook loading.'
    );
  }
  if (includeNifcPerimeters) {
    ariaParts.push(
      'National Interagency Fire Center (NIFC) current mapped Wildfire perimeters, Prescribed fire perimeters, and other or unclassified fire perimeters. Outlines are generalized by the service for display.'
    );
  } else if (nifcLoading) {
    ariaParts.push(
      'National Interagency Fire Center (NIFC) current mapped fire perimeters loading.'
    );
  }
  return {
    label: 'Fire',
    ariaLabel: ariaParts.join(' '),
    itemsHtml: outlook + perimeters
  };
}

export function buildWhpKey(scaleLabel = 'USFS Wildfire Hazard Potential', shaded = false): KeySpec {
  const categories = shaded
    ? WHP_SHADE_CATEGORIES.map((category) => ({ ...category, color: `rgba(255,255,255,${category.opacity * WHP_SURFACE_OPACITY})` }))
    : USFS_WHP_PRESENTATION.categories;
  const qualification = shaded ? WHP_SHADE_QUALIFICATION : USFS_WHP_PRESENTATION.qualification;
  return {
    label: 'Wildfire potential',
    ariaLabel: qualification,
    itemsHtml:
      '<span class="map-key-scale" data-usfs-whp-key>' +
      `<strong class="map-key-scale-label">${escapeHtml(scaleLabel)}</strong>` +
      categories
        .map((category) => swatchItem(category.color, category.label))
        .join('') +
      '</span>' +
      `<span class="map-key-qualification">${escapeHtml(
        qualification
      )}</span>`
  };
}

// KEY_ELIGIBLE_LABELS moved to src/config/chip-labels.ts (S30D D1 M10): the
// same table now serves the runtime and tests/chrome-n-modes.test.mjs's
// plain-Node N-mode contract, so the two can never drift.

interface KeyEligibility {
  /** Registered-active keys (the registry's post-activation truth). */
  readonly active: ReadonlySet<string>;
  /** Key-eligible layers still in their 'loading' state (not yet active). */
  readonly loading: ReadonlySet<string>;
  /** Union: what the key strip should acknowledge right now. */
  readonly eligible: ReadonlySet<string>;
}

/** Active keys plus key-eligible layers whose activation is in flight.
 * A still-loading source earns a named placeholder, never an omission
 * (W2-D6); terminal states (error and friends) keep absence semantics. */
function keyEligibility(): KeyEligibility {
  const active = registry.getActiveKeys();
  const loading = new Set<string>();
  for (const key of Object.keys(KEY_ELIGIBLE_LABELS)) {
    if (!active.has(key) && registry.getStatus(key) === 'loading') {
      loading.add(key);
    }
  }
  return { active, loading, eligible: new Set([...active, ...loading]) };
}

/** A whole-key loading placeholder: the label plus one 'loading' row. */
function loadingKeySpec(key: string): KeySpec {
  const label = KEY_ELIGIBLE_LABELS[key] ?? key;
  return {
    label,
    ariaLabel: `${label} key loading.`,
    itemsHtml: loadingSectionRow(key)
  };
}

/**
 * Whether the land framing's coverage clauses apply to the CURRENT CAMERA.
 *
 * An ocean framing takes camera precedence while deliberately preserving the
 * land framing underneath it (D-0.7.0-042/053: an ocean click is an entry
 * into ENSO, display plus camera, and it does not clear `framing=`). Reading
 * only the land framing therefore put Mexico-specific copy on a Pacific
 * ocean scene (Codex adversarial review 2026-09-10, finding 5). The land
 * framing's sentences describe land the camera is no longer looking at, so
 * none of them applies until the ocean camera is released.
 */
function landFramingGovernsCamera(): boolean {
  return getOceanFraming() === null;
}

/**
 * Whether a minimap actually exists in this scene, which is what makes a
 * sentence about "this minimap" mean anything.
 *
 * Console hides the widget and stops its retained drought and wildfire reads
 * (src/ui/island/minimap.tsx), so its provenance sentence has no referent
 * there and used to render anyway (finding 5's second case). The view mode is
 * the deterministic half of the answer and the DOM presence check is the
 * honest half: the minimap also stands down on narrow viewports and in the
 * compact height band, and duplicating those media queries here would be a
 * second copy of a rule that is already hard to keep in step. A key that
 * renders before the widget mounts simply omits the clause, which
 * under-claims rather than over-claims and corrects itself on the next
 * render.
 */
function minimapInScene(): boolean {
  if (getViewMode() === 'console') return false;
  if (typeof document === 'undefined') return false;
  const el = document.querySelector('.shell-minimap-map');
  return el instanceof HTMLElement && el.getClientRects().length > 0;
}

/**
 * The active framing's coverage cautions (D-0.7.0-051; the S4 handoff), the
 * ONE render site since 2026-09-10 (owner: the sentence used to pop up on
 * the minimap itself on every click AND repeat, word for word, in the
 * conditions summary caveat; both were retired here, src/config/framings.ts
 * and src/state/display-summary.ts).
 *
 * Independent of `hazardKey()` (see `withFrameCoverage` below) so it never
 * vanishes just because the active surface is not North America Drought.
 *
 * Each clause carries its own gate, because they do not share conditions of
 * truth (Codex adversarial review 2026-09-10, finding 5; the reasoning is in
 * `FramingCoverage` in src/config/framings.ts). This function's predecessor
 * rendered all of them together and ungated, which is how a tri-national
 * surface came to be told it did not cover Mexico, and how Console came to
 * carry a sentence about a minimap it does not show.
 */
function frameCoverageNote(): string {
  const selection = getFraming();
  const framing = selection === null || selection === 'all' ? null : selection;
  const def = framing !== null ? FRAMINGS[framing] : undefined;
  const coverage = def?.coverage;
  if (!landFramingGovernsCamera()) return '';
  // Per mode, and before the coverage early return: arid-west and
  // southeast-gulf have no coverage block but still earn the Wildfire, Heat
  // and ENSO clauses.
  // With no framing selected the key stays as quiet as it always was.
  const minimapProvenance = framing !== null && minimapInScene()
    ? framingMinimapProvenance(framing, getHazardCluster())
    : undefined;
  if (coverage === undefined) return minimapProvenance?.replace(/\.\s*$/, '') ?? '';

  const clauses: string[] = [];

  if (coverage.displayScope !== undefined) {
    // What is actually on the map right now, by the same rule
    // display-summary.ts applies (`isUsScopeCautionLayer`): a non-reference
    // layer that is not one of the two that already reach past the US.
    const activeDisplay = LAYER_DEFS.filter(
      (d) => registry.getActiveKeys().has(d.key) && d.role !== 'reference'
    );
    const usScoped = activeDisplay.filter((d) => isUsScopeCautionLayer(d));
    // A clause phrased about the WHOLE display is false the moment one
    // active layer reaches further, so it needs every layer to be US-scoped.
    // A clause phrased about the US-scoped layers among them needs only one.
    const earned = coverage.claimsWholeDisplay === true
      ? activeDisplay.length > 0 && usScoped.length === activeDisplay.length
      : usScoped.length > 0;
    if (earned) clauses.push(coverage.displayScope);
  }

  if (minimapProvenance !== undefined) clauses.push(minimapProvenance);

  // Ungated: the place catalog ends where it ends, whatever is displayed.
  if (coverage.briefingScope !== undefined) clauses.push(coverage.briefingScope);

  // Trailing periods are re-added by the caller, which appends exactly one.
  return clauses.join(' ').replace(/\.\s*$/, '');
}

/**
 * Fold the framing coverage caution into whatever key the active layer set
 * already earned, OR stand up a minimal key of its own when nothing else
 * would render one (the stations-only or no-active-hazard case): a coverage
 * caution that only showed up when some OTHER key happened to be visible
 * would silently vanish exactly when the display is otherwise quiet, which
 * is the case that most needs the honesty.
 */
function withFrameCoverage(spec: KeySpec | null, coverage: string): KeySpec | null {
  if (coverage.length === 0) return spec;
  const html =
    '<span class="map-key-qualification" data-frame-coverage>' +
    `${escapeHtml(coverage)}.</span>`;
  if (spec === null) {
    return { label: 'Map coverage', ariaLabel: `${coverage}.`, itemsHtml: html };
  }
  return {
    ...spec,
    ariaLabel: `${spec.ariaLabel} ${coverage}.`,
    itemsHtml: spec.itemsHtml + html
  };
}

/**
 * A KeySpec together with the registry key(s) its chip glyph state is
 * read from (repair round on M10: `chipStateFromStatuses` in
 * src/config/chip-state.ts reads `registry.getStatus` for exactly these
 * keys, never the spec's own rendered text). Empty when the spec was
 * synthesized with no backing product (the frame-coverage-only "Map
 * coverage" spec `withFrameCoverage` builds from nothing) -- see `update`,
 * which also treats the committed mode's own no-key fallback as empty.
 */
interface HazardKeyResult {
  readonly spec: KeySpec;
  readonly productKeys: readonly string[];
}

/** The key the active layer set earns, or null to hide the strip. */
function activeKey(): HazardKeyResult | null {
  const hazard = hazardKey();
  const spec = withFrameCoverage(hazard?.spec ?? null, frameCoverageNote());
  if (!spec) return null;
  return { spec, productKeys: hazard?.productKeys ?? [] };
}

/** The two fire-family product keys, filtered to the ones actually eligible
 * right now (buildFireKey itself reads `active` and `loading` the same
 * way): a solo NIFC fallback names only 'nifc-fires', never a
 * spc-fire-weather status that is not part of what is drawn. */
function fireProductKeys(eligible: ReadonlySet<string>): readonly string[] {
  return (['spc-fire-weather', 'nifc-fires'] as const).filter((key) => eligible.has(key));
}

/**
 * A neutral circle at a renderer class's size (the issuer's points are icons, not colours).
 * The map draws dark ink over a bright raster; the key panel is dark, so here the circle is
 * paper alone: a solid paper disc for a filled point, a paper ring with a clear centre for a
 * hollow one and for the size examples.
 */
function tropicalCircle(radius: number, label: string, filled = false): string {
  const size = Math.round(radius * 2);
  return (
    '<span class="map-key-item"><span class="map-key-swatch" style="' +
    `background:${filled ? TROPICAL_POINT_PAPER : 'transparent'};border:1.5px solid ${TROPICAL_POINT_PAPER};box-shadow:none;border-radius:50%;width:${size}px;height:${size}px` +
    `"></span>${escapeHtml(label)}</span>`
  );
}

/** One stacked key group: a heading on its own line, then one row per line (CSS .map-key-tropical-group). */
function tropicalGroup(rows: readonly string[], heading?: string): string {
  const head = heading ? `<strong class="map-key-scale-label" data-tropical-points="${escapeHtml(heading)}">${escapeHtml(heading)}</strong>` : '';
  return `<span class="map-key-tropical-group">${head}${rows.join('')}</span>`;
}

/**
 * The tropical cyclones row (ENSO block B3), an event overlay appended to
 * whichever key the surface earned, like the NWS products row. Its state is
 * the registry's (a refresh that fails reads unavailable; an empty season
 * reads the owner's words, "No active tropical cyclones"); its storms and
 * classes are the layer snapshot's and the issuer renderer's labels, verbatim.
 * The basins and circle-sizing notes read in the Impact Briefing
 * (src/ui/map-technical-information.ts), not here.
 */
function tropicalRow(): { readonly html: string; readonly ariaLabel: string } | null {
  const status = registry.getStatus(TROPICAL_KEY);
  const on = registry.getActiveKeys().has(TROPICAL_KEY);
  // A failed first read leaves the key inactive with 'error' kept for the
  // committed mode's summary; say unavailable only while that mode shows it.
  const committed = Object.values(HAZARD_CLUSTERS[getHazardCluster()].recipes).some((r) => r.includes(TROPICAL_KEY));
  if (!on && status !== 'loading' && !(status === 'error' && committed)) return null;
  const issuer = TROPICAL_ISSUERS.both.name;
  const parts: string[] = ['<strong class="map-key-scale-label">Tropical cyclones</strong>'];
  let aria = 'Tropical cyclones:';
  let state: string;
  if (status === 'loading' || status === undefined) {
    state = 'loading';
    parts.push(`<span class="map-key-qualification map-key-loading" data-key-loading="${TROPICAL_KEY}"><strong>loading</strong></span>`);
    aria += ' loading.';
  } else if (status === 'error') {
    state = 'unavailable';
    parts.push('<span class="map-key-qualification" data-tropical-status><strong>unavailable</strong> The NHC and CPHC advisories could not be read.</span>');
    aria += ' unavailable. The NHC and CPHC advisories could not be read.';
  } else if (status === 'no-data') {
    state = 'no data';
    parts.push(`<span class="map-key-item" data-tropical-empty>${escapeHtml(TROPICAL_EMPTY_TEXT)}</span>`);
    aria += ` ${TROPICAL_EMPTY_TEXT}.`;
  } else {
    state = status === 'degraded' ? 'live (partial)' : 'live';
    for (const storm of tropicalSnapshot?.storms ?? []) {
      const basin = tropicalBasinName(storm.basin) ?? `basin ${storm.basin || 'not given'} (not recognised)`;
      const line = `${storm.name}, ${basin}, advisory ${storm.advisory}, issued ${storm.issued}`;
      // A keyboard door to the storm's popup (src/layers/tropical-cyclones.ts answers it).
      parts.push(
        `<button type="button" class="map-key-item map-key-door" data-tropical-storm="${escapeHtml(storm.bin)}" data-feature-door="storm:${escapeHtml(storm.bin)}">${escapeHtml(line)}</button>`
      );
      aria += ` ${line}.`;
    }
    if (status === 'degraded') {
      parts.push('<span class="map-key-qualification" data-tropical-status><strong>live (partial)</strong> Some storm layers could not be read or name another advisory; those are not drawn.</span>');
      aria += ' live (partial).';
    }
    for (const src of ['Tropical Cyclone', 'Post-Tropical Cyclone'] as const) {
      parts.push(
        tropicalGroup(
          TROPICAL_POINT_CLASSES.filter((c) => c.key.endsWith(`,${src}`)).map((c) => tropicalCircle(c.radius, c.label)),
          src
        )
      );
    }
    parts.push(
      tropicalGroup([
        tropicalCircle(7.5, 'Advisory position', true),
        tropicalCircle(7.5, 'Later positions'),
        // The track is black on the map; a paper ring keeps it visible on the dark panel.
        swatchItem(TROPICAL_TRACK.color, TROPICAL_PART_NAMES.track).replace('style="', `style="box-shadow:0 0 0 1px ${TROPICAL_POINT_PAPER};`),
        swatchItem(TROPICAL_CONE.fill, TROPICAL_PART_NAMES.cone),
        ...TROPICAL_WW_CLASSES.map((c) => swatchItem(c.color, c.label))
      ])
    );
    aria += ` ${TROPICAL_POINT_CLASSES.map((c) => c.label).join(', ')}; ${TROPICAL_WW_CLASSES.map((c) => c.label).join(', ')}.`;
  }
  parts.push(`<span class="map-key-item" data-tropical-issuer>${escapeHtml(issuer)}</span>`);
  return {
    html: `<span class="map-key-scale" data-tropical-key data-tropical-state="${state}">${parts.join('')}</span>`,
    ariaLabel: `${aria} ${issuer}.`
  };
}

/** The surface key with the tropical cyclones row appended when that layer is on. */
function hazardKey(): HazardKeyResult | null {
  const base = surfaceKey();
  const row = tropicalRow();
  if (!row) return base;
  if (base) {
    return {
      spec: { ...base.spec, ariaLabel: `${base.spec.ariaLabel} ${row.ariaLabel}`, itemsHtml: base.spec.itemsHtml + row.html },
      productKeys: base.productKeys
    };
  }
  return { spec: { label: KEY_ELIGIBLE_LABELS[TROPICAL_KEY]!, ariaLabel: row.ariaLabel, itemsHtml: row.html }, productKeys: [] };
}

/** The condition-surface key, before shared reference qualifications. */
function surfaceKey(): HazardKeyResult | null {
  const { active, loading, eligible } = keyEligibility();
  let spec: KeySpec | null = null;
  let productKeys: readonly string[] = [];
  const fireSections = fireKeySections(eligible);
  // Fuel risk ('usfs-whp') is white-shaded; the Layer studio's classes row keeps issuer colours.
  const whpKey = eligible.has('usfs-whp-classes') ? 'usfs-whp-classes' : 'usfs-whp';
  const whpShaded = whpKey === 'usfs-whp';
  if (eligible.has('heatrisk')) {
    spec = active.has('heatrisk') ? heatKey() : loadingKeySpec('heatrisk');
    productKeys = ['heatrisk'];
  } else if (fireSections && !fireSections.fire) {
    spec = active.has(whpKey) ? buildWhpKey(undefined, whpShaded) : loadingKeySpec(whpKey);
    productKeys = [whpKey];
  } else if (fireSections) {
    // Fuel risk over Wildfire: the Fire key keeps every section and gains the potential one.
    const fire = buildFireKey(active, loading);
    spec = fire;
    productKeys = fireProductKeys(eligible);
    if (fireSections.whp) {
      const whpTitle = whpShaded ? FUEL_RISK_TITLE : 'USFS Wildfire Hazard Potential';
      const whp = active.has(whpKey)
        ? buildWhpKey(whpTitle, whpShaded)
        : {
            ariaLabel: 'loading.',
            itemsHtml:
              '<span class="map-key-scale" data-usfs-whp-key>' +
              `<strong class="map-key-scale-label">${escapeHtml(whpTitle)}</strong>` +
              `${loadingSectionRow(whpKey)}</span>`
          };
      spec = {
        ...fire,
        ariaLabel: `${fire.ariaLabel} ${whpTitle}, ${whp.ariaLabel}`,
        itemsHtml: fire.itemsHtml + whp.itemsHtml
      };
      productKeys = [...productKeys, whpKey];
    }
  } else if (eligible.has('cdm-drought')) {
    spec = active.has('cdm-drought') ? cdmKey() : loadingKeySpec('cdm-drought');
    productKeys = ['cdm-drought'];
  } else if (eligible.has('nadm-drought')) {
    spec = active.has('nadm-drought') ? nadmKey() : loadingKeySpec('nadm-drought');
    productKeys = ['nadm-drought'];
  } else if (eligible.has('usdm')) {
    spec = active.has('usdm') ? droughtKey() : loadingKeySpec('usdm');
    productKeys = ['usdm'];
  } else if (eligible.has('drought')) {
    spec = active.has('drought') ? outlookKey() : loadingKeySpec('drought');
    productKeys = ['drought'];
  } else if (eligible.has('gridded-index')) {
    spec = active.has('gridded-index') ? griddedKey() : loadingKeySpec('gridded-index');
    productKeys = ['gridded-index'];
  } else if (eligible.has('sst-anomaly')) {
    spec = active.has('sst-anomaly') ? sstKey() : loadingKeySpec('sst-anomaly');
    productKeys = ['sst-anomaly'];
  } else if (eligible.has('nifc-fires')) {
    spec = buildFireKey(active, loading);
    productKeys = fireProductKeys(eligible);
  }

  // NWS alerts is an EVENT layer stacked over whichever surface above (or
  // none), a qualification appended to the spec's text. It never joins
  // productKeys: the chip glyph states the SURFACE's status, and an event
  // overlay's own loading/ready state has no six-state glyph slot of its
  // own here (map-key.ts:1180's no-key fallback already covers "no
  // surface, nothing to grade").
  if (!eligible.has('nws-alerts')) return spec ? { spec, productKeys } : null;
  if (loading.has('nws-alerts')) {
    // Activation in flight: a named placeholder row (W2-D6), not the full
    // product scale, which would claim a surface not yet on the map.
    const loadingHtml =
      '<span class="map-key-qualification map-key-loading" data-key-loading="nws-alerts">' +
      'NWS products loading</span>';
    const loadingAria = 'National Weather Service event products loading.';
    if (spec) {
      return {
        spec: {
          ...spec,
          ariaLabel: `${spec.ariaLabel} ${loadingAria}`,
          itemsHtml: spec.itemsHtml + loadingHtml
        },
        productKeys
      };
    }
    return {
      spec: {
        label: KEY_ELIGIBLE_LABELS['nws-alerts']!,
        ariaLabel: loadingAria,
        itemsHtml: loadingHtml
      },
      productKeys: []
    };
  }
  const snapshot = nwsSnapshotQualification();
  const products = nwsProductKey();
  if (spec) {
    return {
      spec: {
        ...spec,
        ariaLabel:
          `${spec.ariaLabel} ${products.ariaLabel} ${snapshot.ariaLabel}`,
        itemsHtml: spec.itemsHtml + products.html + snapshot.html
      },
      productKeys
    };
  }
  return {
    spec: {
      label: KEY_ELIGIBLE_LABELS['nws-alerts']!,
      ariaLabel: `${products.ariaLabel} ${snapshot.ariaLabel}`,
      itemsHtml: products.html + snapshot.html
    },
    productKeys: []
  };
}

/**
 * The chip's six-state glyph, read from the layer REGISTRY's own recorded
 * status for the product key(s) `productKeys` names, never from a spec's
 * rendered text (repair round on M10: the old `chipStateFromSpec`
 * substring-matched `ariaLabel`/`itemsHtml`, which the hillshade coverage
 * note and a partially-loading multi-layer key could both falsify). An
 * empty `productKeys` (no key backs the spec) returns undefined: see
 * `aggregateChipState` in src/config/chip-state.ts for the six-state
 * doctrine this defers to, and the caller below for what "no glyph state"
 * renders as.
 */
function chipStateFromKeys(productKeys: readonly string[]): ChipState | undefined {
  return chipStateFromStatuses(productKeys.map((key) => registry.getStatus(key)));
}

/**
 * The chip's four grammar slots (interface-chrome-popups-text.md section
 * 2.4): a swatch (empty, no classed reading, since the chip names a
 * PRODUCT rather than one current value; the conditions strip in
 * conditions-strip.tsx carries the single-reading swatch), one label line,
 * the six-state glyph, and an SVG plus/minus disclosure replacing the CSS
 * `::after` character so its centring can be measured (D1.md M10 Notes).
 */
function buildChipGrammar(button: HTMLButtonElement): {
  readonly swatch: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly state: HTMLSpanElement;
} {
  const swatch = document.createElement('span');
  swatch.className = 'map-key-chip-swatch';
  swatch.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'map-key-chip-label';

  const state = document.createElement('span');
  state.className = 'map-key-chip-state';
  state.setAttribute('aria-hidden', 'true');

  const disclosure = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  disclosure.setAttribute('class', 'map-key-chip-disclosure');
  disclosure.setAttribute('viewBox', '0 0 16 16');
  disclosure.setAttribute('width', '16');
  disclosure.setAttribute('height', '16');
  disclosure.setAttribute('aria-hidden', 'true');
  disclosure.setAttribute('focusable', 'false');
  const horizontal = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  horizontal.setAttribute('d', 'M2 8h12');
  horizontal.setAttribute('stroke', 'currentColor');
  horizontal.setAttribute('stroke-width', '2');
  horizontal.setAttribute('stroke-linecap', 'round');
  const vertical = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  vertical.setAttribute('class', 'map-key-chip-disclosure-vert');
  vertical.setAttribute('d', 'M8 2v12');
  vertical.setAttribute('stroke', 'currentColor');
  vertical.setAttribute('stroke-width', '2');
  vertical.setAttribute('stroke-linecap', 'round');
  disclosure.append(horizontal, vertical);

  button.replaceChildren(swatch, label, state, disclosure);
  return { swatch, label, state };
}

/** Build the swatch strip once and keep it synced to the registry. */
export function initMapKey(): void {
  const host = document.getElementById('map-key');
  if (!host) return;
  disposeMapKeyLayout?.();
  disposeMapKeyOverflow?.();
  disposeMapKeySeat?.();
  disposeMapKeyTimeBarSpec?.();
  disposeMapKeyFraming?.();
  disposeMapKeyViewMode?.();
  disposeMapKeyHazardCluster?.();
  const layout = watchMapKeyLayout(host);
  disposeMapKeyLayout = layout.dispose;
  disposeMapKeySeat = watchMapKeySeat(host);
  const heatRiskSequenceLoader = createHeatRiskSequenceLoader(
    () => import('./heatrisk-sequence'),
    (err) => {
      console.warn('[map-key] HeatRisk sequence failed to load.', err);
    }
  );

  const content = document.createElement('div');
  content.id = 'map-key-content';
  content.className = 'map-key-content';
  content.hidden = true;
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', 'Map details and key');

  // S30D D1 M11 (the Key drawer): update() below writes the rendered
  // KeySpec HTML into THIS wrapper, never into `content` itself, so the
  // drawer's static per-cluster section hosts (index.html, moved in
  // next) survive every legend re-render instead of being wiped by it.
  // `display: contents` (app.css) keeps it invisible to layout, so the
  // legend's own items read exactly as `content`'s direct flex children
  // did before this split.
  const legend = document.createElement('div');
  legend.id = 'map-key-legend';
  legend.className = 'map-key-legend';
  content.append(legend);

  // The drawer's section hosts (src/config/detail-sections.ts, built by
  // src/ui/detail-section-hosts.ts's ensureDetailSectionHosts(): S30D D1
  // M11 repair round 3, DR-158): built once, only relocated (never
  // rewritten) here.
  const drawerSections = ensureDetailSectionHosts();
  drawerSections.hidden = false;
  content.append(drawerSections);

  // The owner's call 1: one quiet link to the briefing's Technical information, built once (outside the rewritten legend) so it keeps focus.
  const technicalLink = document.createElement('button');
  technicalLink.type = 'button';
  technicalLink.className = 'map-info-ack-link';
  technicalLink.dataset['openTechnicalInformation'] = '';
  // DRAFT wording (DR-177)
  technicalLink.textContent = 'Technical information';
  technicalLink.addEventListener('click', () => openTechnicalInformation(technicalLink));
  content.append(technicalLink);

  const detailsButton = document.createElement('button');
  detailsButton.id = 'map-key-details-toggle';
  detailsButton.className = 'map-key-details-toggle';
  detailsButton.type = 'button';
  detailsButton.setAttribute('aria-controls', content.id);
  detailsButton.setAttribute('aria-expanded', 'false');
  const chipGrammar = buildChipGrammar(detailsButton);

  // E1-4 (ENSO-FLOW-PLAN.md; C-fit.md 1.8; WCAG 2.2.2): the flowing paths'
  // Pause, one native toggle in the collapsed header right after the chip,
  // outside #map-key-legend (rewritten on every update) so it is built once
  // and keeps focus across key updates. Its name says what a press does,
  // from the paths' own snapshot and nothing else. Hidden until
  // a snapshot reports motion (nothing does before E2-1 wires the paths).
  const pauseButton = buildFlowPauseButton();

  host.replaceChildren(detailsButton, pauseButton, content);
  host.dataset.keyDetailsOpen = 'false';

  const widthQuery = window.matchMedia(MOBILE_MAP_KEY_QUERY);
  let rendered = '';
  let family: MapKeyFamily = 'other';
  let keyLabel = '';
  let detailsOpen = false;

  const setDetailsOpen = (next: boolean): void => {
    detailsOpen = next;
    host.dataset.keyDetailsOpen = String(next);
    content.hidden = !next;
    detailsButton.setAttribute('aria-expanded', String(next));
    detailsButton.setAttribute('aria-label', `${next ? 'Close' : 'Open'} ${keyLabel || 'map'} details and key`);
    window.dispatchEvent(new CustomEvent('ddm:map-key-details-change', { detail: { open: next } }));
    layout.schedule();
  };

  const reflectInteraction = (): void => {
    host.setAttribute('role', 'group');
    host.style.pointerEvents = 'auto';
  };

  const appPresentationObserver = new MutationObserver(() => update());
  const app = document.getElementById('app');
  if (app) appPresentationObserver.observe(app, { attributes: true, attributeFilter: ['class'] });
  // Crossing the phone breakpoint re-renders the strip as well as
  // re-measuring it. `update` diffs against the last rendered html, so this
  // is cheap.
  const onWidthChange = (): void => {
    update();
    layout.schedule();
  };
  widthQuery.addEventListener('change', onWidthChange);
  const toggleDetails = (): void => setDetailsOpen(!detailsOpen);
  /** The visible chip: the key toggle. */
  const chip = (): HTMLElement | null => detailsButton;
  const closeDetailsOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !detailsOpen) return;
    setDetailsOpen(false);
    chip()?.focus();
  };
  detailsButton.addEventListener('click', toggleDetails);
  pauseButton.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent(ENSO_FLOW_MOTION_REQUEST_EVENT, {
      detail: { paused: pauseButton.dataset.paused !== 'true' }
    }));
  });
  window.addEventListener('ddm:toggle-map-key-details', toggleDetails);
  host.addEventListener('keydown', closeDetailsOnEscape);

  // S30D D1 M28 (interface-chrome-popups-text.md 2.7, the focus table).
  // Two hand-offs, each acting only while focus was on a node that has now
  // gone (removed, or hidden under it) and has moved nowhere else; focus a
  // person moves themselves (a pointer press on a mode button, a click on
  // the page) is never taken back.
  // - A focused drawer control that disappears (a re-render, or its section
  //   hidden on a mode change, such as a HeatRisk day cell on leaving Heat)
  //   hands focus to the drawer heading (`tabindex="-1"`) while the drawer
  //   is open, otherwise to the chip (P2).
  // - A focused chip control that disappears hands focus to the key toggle.
  // Each runs from a focusout with no next target (a removal) and again
  // after every update, which is where a node is hidden.
  const handOff = (lost: HTMLElement | null, next: () => HTMLElement | null): HTMLElement | null => {
    const active = document.activeElement;
    if (!lost || (active !== lost && active !== document.body && active !== null)) return lost;
    if (lost.isConnected && lost.getClientRects().length > 0) return active === lost ? lost : null;
    const target = next();
    if (target && target !== lost && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
      return target;
    }
    return lost;
  };
  let drawerFocus: HTMLElement | null = null;
  let chipFocus: HTMLElement | null = null;
  const drawerHeading = (): HTMLElement | null => {
    const heading = detailsOpen ? legend.querySelector<HTMLElement>('.map-key-label') : null;
    if (heading) heading.tabIndex = -1;
    return heading ?? chip();
  };
  const handOffLostFocus = (): void => {
    drawerFocus = handOff(drawerFocus, drawerHeading);
    chipFocus = handOff(chipFocus, chip);
  };
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target as HTMLElement;
    drawerFocus = content.contains(target) ? target : null;
    chipFocus = target === detailsButton || target === pauseButton ? target : null;
  };
  const onFocusOut = (event: FocusEvent): void => {
    if (!event.relatedTarget && (event.target === drawerFocus || event.target === chipFocus)) {
      queueMicrotask(handOffLostFocus);
    }
  };
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);

  disposeMapKeyOverflow = () => {
    appPresentationObserver.disconnect();
    widthQuery.removeEventListener('change', onWidthChange);
    window.removeEventListener('ddm:toggle-map-key-details', toggleDetails);
    window.removeEventListener('ddm:whp-shade', onWhpShade);
    window.removeEventListener(DRYNESS_GROUND_EVENT, onDrynessGround);
    host.removeEventListener('keydown', closeDetailsOnEscape);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    window.removeEventListener(ENSO_FLOW_SNAPSHOT_EVENT, onEnsoFlowSnapshot);
  };

  const update = (): void => {
    const active = activeKey();
    // THE CHIP NEVER HIDES, but only where it IS the chip: the desktop
    // TL-1 seat, outside an embed (interface-chrome-popups-text.md
    // sections 2.4 and 2.8). Phones and embeds keep today's seats exactly
    // (D1.md M10 scope), which includes hiding when nothing is eligible;
    // only there does the pre-M10 `host.hidden = true` path survive.
    const isDesktopChip = !widthQuery.matches && !app?.classList.contains('embed');
    if (!active && !isDesktopChip) {
      host.hidden = true;
      setDetailsOpen(false);
      delete host.dataset.keyFamily;
      delete host.dataset.register;
      reflectInteraction();
      layout.schedule();
      return;
    }
    const spec: KeySpec = active?.spec ?? {
      label: chipFallbackLabel(getHazardCluster()),
      ariaLabel: `${chipFallbackLabel(getHazardCluster())}. No classed layer is drawn.`,
      itemsHtml: ''
    };
    // The committed mode's no-key fallback above names no product (its
    // drawer already says "the view draws no classed layer"), so it earns
    // no productKeys either: `chipStateFromKeys` below returns undefined
    // for it, same as `active`'s own coverage-only synthetic spec.
    const productKeys: readonly string[] = active?.productKeys ?? [];
    keyLabel = spec.label;
    const shadeKey = whpShadeActive
      ? '<span class="map-key-scale" data-whp-shade-key><strong>3D wildfire potential</strong>' +
        WHP_3D_SHADE_CATEGORIES.map((category) => swatchItem(
          whiteShade(category.opacity), category.label
        )).join('') + `<span class="map-key-qualification">${escapeHtml(WHP_3D_SHADE_QUALIFICATION)}</span></span>`
      : '';
    const html =
      `<span class="map-key-label">${escapeHtml(spec.label)}</span>` + spec.itemsHtml + shadeKey + drynessKeyHtml();
    if (html !== rendered) {
      // A re-render replaces every node in the strip, so anything the
      // person was operating loses focus. The HeatRisk valid-date select
      // is the only focusable control in here, and since DDM-P8-T05 a day
      // change re-renders TWICE: once to say the new frame is loading, and
      // again when its tiles settle. Without this, a keyboard day change
      // dropped focus the moment the tiles landed and the next arrow key
      // went nowhere. Captured before the rewrite, restored after it. The
      // feature doors (a storm, the Nino 3.4 box) keep focus the same way
      // across the storm refresh and the SST and flow snapshots.
      const active = document.activeElement;
      const door = active instanceof HTMLElement ? active.dataset.featureDoor : undefined;
      const refocus =
        active instanceof HTMLElement && legend.contains(active)
          ? active.matches('[data-heatrisk-day]')
            ? '[data-heatrisk-day]'
            : door !== undefined
              ? `[data-feature-door="${CSS.escape(door)}"]`
              : null
          : null;
      rendered = html;
      legend.innerHTML = html;
      host.setAttribute('aria-label', spec.ariaLabel);
      if (refocus) {
        const restored = legend.querySelector(refocus);
        if (restored instanceof HTMLElement) restored.focus();
      }
    }
    // The family follows what the strip acknowledges (active plus loading
    // placeholders), so a loading key seats under the same CSS its ready
    // form will use.
    const { eligible } = keyEligibility();
    const nextFamily = resolveMapKeyFamily(eligible);
    // S30D D1 M11 (design record section 2.6, "Persistence"): the Key
    // drawer stays open across a hazard, horizon, loading or selection
    // change and re-renders for the new state. The automatic close this
    // used to run on every family change is removed; only the toggle
    // (detailsButton) and Escape (closeDetailsOnEscape) close it now.
    family = nextFamily;
    host.dataset.keyFamily = family;
    // The drawer's per-cluster sections (DR-113; src/config/detail-
    // sections.ts): the COMMITTED cluster decides which static section
    // host is revealed, never the momentarily-eligible family, so a
    // section never flashes for a layer that is merely loading under a
    // different mode.
    const activeCluster = getHazardCluster();
    const activeSections = HAZARD_CLUSTERS[activeCluster].detailSections ?? [];
    for (const def of Object.values(DETAIL_SECTIONS)) {
      const sectionEl = document.getElementById(def.homeId);
      if (sectionEl) sectionEl.hidden = !activeSections.includes(def.key);
    }
    // The four chip grammar slots (section 2.4): an empty, keylined swatch
    // (the chip names a product, not one reading; the conditions strip
    // carries the single-reading swatch), the label in the issuer's own
    // words with no text-transform (replacing the family ternary that used
    // to hardcode 'FIRE' / 'HEAT RISK' / 'ENSO', a cluster literal DR-113
    // forbids), and the six-state glyph.
    chipGrammar.label.textContent = spec.label;
    const chipState = chipStateFromKeys(productKeys);
    if (chipState) {
      chipGrammar.state.dataset.chipState = chipState;
      chipGrammar.state.title = CHIP_STATE_WORDS[chipState];
    } else {
      // No product key backs this spec (the no-key fallback, or a
      // coverage-only synthetic spec): no glyph state, never an invented
      // seventh state (interface-chrome-popups-text.md section 7).
      delete chipGrammar.state.dataset.chipState;
      chipGrammar.state.title = '';
    }
    detailsButton.setAttribute('aria-label', `${detailsOpen ? 'Close' : 'Open'} ${keyLabel} details and key`);
    syncFlowPause(host, pauseButton, ensoFlowSnapshot);
    // A MIRROR of the owning layer's own declared register (never
    // computed from the pressed horizon chip, never invented for a
    // layer, such as WHP, that declares none): src/ui/time-bar.ts is
    // the single source, so the key and the time bar can never disagree.
    const timeBarSpec = getTimeBarSpec();
    if (timeBarSpec) {
      host.dataset.register = timeBarSpec.stamp.register;
    } else {
      delete host.dataset.register;
    }
    reflectInteraction();
    host.hidden = false;
    layout.schedule();
    handOffLostFocus();
  };

  host.addEventListener('change', (event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLSelectElement) ||
      !target.matches('[data-heatrisk-day]')
    ) {
      return;
    }
    const day = Number(target.value);
    if (!Number.isSafeInteger(day) || day < 1) return;
    window.dispatchEvent(
      new CustomEvent(HEATRISK_DAY_SELECT_EVENT, { detail: { day } })
    );
  });
  // A feature door asks the owning layer, by event, so the key imports no layer module.
  host.addEventListener('click', (event) => {
    const door = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-feature-door]') : null;
    if (door) window.dispatchEvent(new CustomEvent(FEATURE_DOOR_EVENT, { detail: door.dataset.featureDoor }));
  });

  const onWhpShade = (event: Event): void => {
    whpShadeActive = Boolean((event as CustomEvent<{ active: boolean }>).detail?.active);
    update();
  };
  window.addEventListener('ddm:whp-shade', onWhpShade);
  const onDrynessGround = (event: Event): void => {
    drynessGround = (event as CustomEvent<typeof drynessGround>).detail ?? null;
    update();
  };
  window.addEventListener(DRYNESS_GROUND_EVENT, onDrynessGround);

  window.addEventListener(HEATRISK_FRAMES_EVENT, (event) => {
    const detail = (event as CustomEvent<HeatRiskFrameEventDetail>).detail;
    if (!detail) return;
    heatRiskFrameStatus = detail.status;
    heatRiskFrames = detail.frames;
    heatRiskSelectedDay = detail.selectedDay;
    heatRiskHasCoverage = detail.hasCoverage;
    update();
    heatRiskSequenceLoader.apply(detail);
  });

  window.addEventListener(NWS_SNAPSHOT_EVENT, (event) => {
    const detail = (event as CustomEvent<NwsSnapshotEventDetail>).detail;
    if (!detail) return;
    nwsSnapshotStatus = detail.status;
    nwsSnapshotAsOf = detail.asOf;
    nwsSnapshotTruncated = detail.truncated;
    update();
  });
  window.addEventListener(CDM_SNAPSHOT_EVENT, (event) => {
    const detail = (event as CustomEvent<CdmSnapshotEventDetail>).detail;
    if (!detail) return;
    cdmMonth = detail.status === 'ready' ? detail.month : null;
    cdmClasses = detail.status === 'ready' ? detail.classes : [];
    cdmLicense = detail.status === 'ready' ? detail.license : null;
    update();
  });
  window.addEventListener(NADM_SNAPSHOT_EVENT, (event) => {
    const detail = (event as CustomEvent<NadmSnapshotEventDetail>).detail;
    if (!detail) return;
    nadmMonth = detail.status === 'ready' ? detail.month : null;
    update();
  });
  window.addEventListener(SST_SNAPSHOT_EVENT, (event) => {
    const detail = (event as CustomEvent<SstSnapshotEventDetail>).detail;
    if (!detail) return;
    sstObservedDate = detail.status === 'ready' ? detail.date : null;
    update();
  });
  const onEnsoFlowSnapshot = (event: Event): void => {
    const detail = (event as CustomEvent<EnsoFlowSnapshotEventDetail>).detail;
    if (!detail) return;
    ensoFlowSnapshot = detail;
    update();
  };
  window.addEventListener(ENSO_FLOW_SNAPSHOT_EVENT, onEnsoFlowSnapshot);
  window.addEventListener(TROPICAL_SNAPSHOT_EVENT, (event) => {
    const detail = (event as CustomEvent<TropicalSnapshotEventDetail>).detail;
    if (!detail) return;
    tropicalSnapshot = detail;
    update();
  });
  disposeMapKeyTimeBarSpec = onTimeBarSpecChange(update);
  // A framing click never fires a registry event (D-0.7.0-039: camera-only,
  // no layer write), so without this the coverage caution above would only
  // refresh on the NEXT unrelated key change.
  disposeMapKeyFraming = onFramingChange(update);
  // Nor does a Brief/Console flip, and it decides whether the minimap
  // provenance clause has a referent at all (finding 5). Without this the
  // sentence would linger into Console until some unrelated key change.
  disposeMapKeyViewMode = onViewModeChange(update);
  // The chip never hides (section 2.4): with no key eligible it falls back
  // to the committed mode's own word, so a mode switch with no layer
  // change (an empty season-ahead recipe, D-0.7.0-043) still has to
  // re-render the fallback label.
  disposeMapKeyHazardCluster = onHazardClusterChange(update);

  registry.on('change', update);
  // Every status transition can change the strip now that a loading key
  // renders a placeholder (W2-D6); the render diffs, so a status that does
  // not change the HTML is a cheap no-op.
  registry.on('status-change', () => {
    update();
  });
  timeline.onChange(update);
  // The arrows may have loaded before this chunk did (a boot with `flow=`
  // in the URL): ask once for their state; nothing answers while inactive.
  ensoFlowSnapshot = null;
  window.dispatchEvent(new Event(ENSO_FLOW_SNAPSHOT_REQUEST_EVENT));
  drynessGround = null;
  window.dispatchEvent(new Event(DRYNESS_GROUND_REQUEST_EVENT));
  tropicalSnapshot = null;
  window.dispatchEvent(new Event(TROPICAL_SNAPSHOT_REQUEST_EVENT));
  update();
}
