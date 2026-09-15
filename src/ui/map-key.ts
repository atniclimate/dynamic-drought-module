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
import {
  BC_DROUGHT_LEVELS,
  BC_DROUGHT_NO_UPDATE,
  HEATRISK_CATEGORIES,
  NADM_CATEGORIES,
  NWS_ALERT_COLORS,
  SST_ANOMALY_SCALE,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH,
  SPC_FIREWX_CATEGORIES
} from '../config/palette';
import { LAYER_DEFS, getDroughtSurfacePresentation } from '../config/layers';
import {
  NIFC_INCIDENT_PRESENTATION,
  USFS_WHP_PRESENTATION,
  NIFC_KEY_GENERALIZATION_NOTE
} from '../config/wildfire-presentation';
import { FRAMINGS } from '../config/framings';
import { getFraming, onFramingChange } from '../state/framing-store';
import { getOceanFraming } from '../state/cluster-store';
import { getViewMode, onViewModeChange } from '../state/view-mode';
import { isUsScopeCautionLayer } from '../state/display-summary';
import { escapeHtml } from '../util/escape';
import {
  createHeatRiskSequenceLoader,
  type HeatRiskFrameEventDetail
} from './heatrisk-sequence-loader';
import { watchDesktopMapSeat } from './map-control-seat';
import { getTimeBarSpec, onTimeBarSpecChange } from './time-bar';
import { WHP_SHADE_CATEGORIES, WHP_SHADE_QUALIFICATION, WHP_SURFACE_OPACITY } from '../config/whp-shade';
import { DRAPE_OPACITY } from '../config/wildfire-presentation';

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

const HEATRISK_FRAMES_EVENT = 'ddm:heatrisk-frames';
const HEATRISK_DAY_SELECT_EVENT = 'ddm:heatrisk-day-select';
const CDM_SNAPSHOT_EVENT = 'ddm:cdm-snapshot';
const NADM_SNAPSHOT_EVENT = 'ddm:nadm-snapshot';
const NWS_SNAPSHOT_EVENT = 'ddm:nws-products-snapshot';
const SST_SNAPSHOT_EVENT = 'ddm:sst-snapshot';
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
let whpShadeActive = false;
let flatWhpShadeActive = false;

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
      let available = Math.min(window.innerHeight, mapBox.bottom) - contentBox.top - 16;
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
  if (active.has('spc-fire-weather') || active.has('usfs-whp')) return 'fire';
  if (
    active.has('usdm') ||
    active.has('nadm-drought') ||
    active.has('cdm-drought')
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

function droughtKey(): KeySpec {
  const presentation = getDroughtSurfacePresentation();
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
 * had no on-map scale. Swatches and wording come from the shared
 * SST_ANOMALY_SCALE table (src/config/palette.ts), the same table the
 * sidebar legend renders, so the two surfaces cannot drift. The observed
 * date mirrors the frame the ddm:sst-snapshot event announced (the same
 * date the temporal stamp shows); the scale stays qualitative because the
 * GIBS metadata states no climatology baseline.
 */
function sstKey(): KeySpec {
  const observed = sstObservedDate
    ? ` Observed ${formatSstDate(sstObservedDate)}.`
    : '';
  const first = SST_ANOMALY_SCALE[0]!;
  const last = SST_ANOMALY_SCALE.at(-1)!;
  return {
    label: 'Ocean temperature',
    ariaLabel:
      `Ocean temperature anomaly key, ${first.label.toLowerCase()} through ${last.label.toLowerCase()}, a qualitative scale.` +
      observed +
      ' NASA GIBS GHRSST MUR SST anomaly.',
    itemsHtml:
      (sstObservedDate
        ? `<span class="map-key-item" data-sst-observed>Observed ${escapeHtml(
            formatSstDate(sstObservedDate)
          )}</span>`
        : '') +
      '<span class="map-key-scale" data-sst-anomaly-key>' +
      SST_ANOMALY_SCALE.map((entry) => swatchItem(entry.color, entry.label)).join('') +
      '</span>' +
      '<span class="map-key-item" data-sst-attribution>NASA GIBS GHRSST MUR</span>'
  };
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
  const coverageCopy =
    'National Weather Service HeatRisk covers the contiguous United States only.';
  if (heatRiskHasCoverage === false) {
    return {
      label: 'HeatRisk',
      ariaLabel: `No data. ${coverageCopy}`,
      itemsHtml:
        '<span class="map-key-qualification" data-heatrisk-coverage>' +
        `<strong>no data</strong> ${escapeHtml(coverageCopy)}</span>`
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
          category.color,
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
  const labelsByColor = new Map<string, string[]>();
  for (const [label, color] of Object.entries(NWS_ALERT_COLORS)) {
    const labels = labelsByColor.get(color) ?? [];
    labels.push(label);
    labelsByColor.set(color, labels);
  }
  const labels = [...labelsByColor.values()].flat();
  return {
    html:
      '<span class="map-key-scale map-key-nws-products" data-nws-products-key>' +
      '<strong class="map-key-scale-label">NWS products</strong>' +
      [...labelsByColor].map(([color, names]) =>
        swatchItem(color, names.join(' / '))
      ).join('') +
      '</span>',
    ariaLabel:
      `National Weather Service event products: ${labels.join(', ')}.`
  };
}

function formatSnapshotTime(time: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(time));
}

function nwsSnapshotQualification(): {
  readonly html: string;
  readonly ariaLabel: string;
} {
  if (nwsSnapshotAsOf === null) {
    const state =
      nwsSnapshotStatus === 'error'
        ? 'National Weather Service snapshot unavailable.'
        : 'National Weather Service snapshot loading.';
    return {
      html: `<span class="map-key-qualification" data-nws-snapshot>${escapeHtml(state)}</span>`,
      ariaLabel: state
    };
  }
  const asOf = `National Weather Service snapshot as of ${formatSnapshotTime(
    nwsSnapshotAsOf
  )}.`;
  const partial =
    nwsSnapshotTruncated || nwsSnapshotStatus === 'degraded'
      ? ' live (partial): transfer limit reached.'
      : '';
  return {
    html:
      '<span class="map-key-qualification" data-nws-snapshot>' +
      `${escapeHtml(asOf)}${
        partial
          ? ' <strong>live (partial)</strong>: transfer limit reached.'
          : ''
      }</span>`,
    ariaLabel: asOf + partial
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
      USDM_CATEGORIES.map((entry) =>
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

export function buildWhpKey(): KeySpec {
  const categories = flatWhpShadeActive
    ? WHP_SHADE_CATEGORIES.map((category) => ({ ...category, color: `rgba(255,255,255,${category.opacity * WHP_SURFACE_OPACITY})` }))
    : USFS_WHP_PRESENTATION.categories;
  const qualification = flatWhpShadeActive ? WHP_SHADE_QUALIFICATION : USFS_WHP_PRESENTATION.qualification;
  return {
    label: 'Wildfire potential',
    ariaLabel: qualification,
    itemsHtml:
      '<span class="map-key-scale" data-usfs-whp-key>' +
      '<strong class="map-key-scale-label">USFS Wildfire Hazard Potential</strong>' +
      categories
        .map((category) => swatchItem(category.color, category.label))
        .join('') +
      '</span>' +
      `<span class="map-key-qualification">${escapeHtml(
        qualification
      )}</span>`
  };
}

/** The layer keys that can earn (or contribute to) the on-map key, with
 * the label a whole-key loading placeholder renders under (W2-D6). */
const KEY_ELIGIBLE_LABELS: Readonly<Record<string, string>> = {
  heatrisk: 'HeatRisk',
  'spc-fire-weather': 'Fire',
  'usfs-whp': 'Wildfire potential',
  'cdm-drought': 'Canada drought',
  'nadm-drought': 'North America drought',
  usdm: 'Drought',
  'sst-anomaly': 'Ocean temperature',
  'nifc-fires': 'Fire',
  'nws-alerts': 'Products'
};

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
 * Coverage qualification for the default-on `hillshade` layer (FIRE-09).
 *
 * Terrain Shading ships `defaultOn: true` (src/config/layers.ts) over a
 * Pacific Northwest-only raster-dem archive, so in the United States,
 * Alaska, Hawaii, and British Columbia framings it reports `live` and draws
 * nothing. The 3D mode discloses its own bake (`FIRE3D_COVERAGE_NOTE`); the
 * flat hillshade that is on for every user at every viewport did not.
 *
 * THE VISIBLE FORM IS DELIBERATELY SHORT AND WIDTH-GATED. Both are measured,
 * not hypothetical (2026-09-01):
 *
 *   - A sentence-long span pushed the phone Fire card past the 224px
 *     `--mobile-map-key-collapsed-height` at 390x844, so `#map-key-expand`
 *     stopped being hidden and every phone key gained a standing collapse
 *     control (`tests/interface-responsive.spec.ts:303` and `:371` red).
 *   - Shortening it to these three words did NOT fix that. Under the phone
 *     clamp `.map-key-content` is `flex-direction: column`, so ANY new child
 *     costs a whole row plus the 9px gap (about 23px), and the Fire key,
 *     alone among the four, has less headroom than that: it is the only key
 *     with two stacked sections plus their qualifications.
 *
 * So the visible entry renders above the clamp only. The full sentence rides
 * the key's accessible name on EVERY surface (a `title` carries it for
 * pointer users), which costs no layout, so a phone user on assistive
 * technology still hears the qualification. Making it visible on a phone
 * needs `--mobile-map-key-collapsed-height` to grow, which is an
 * owner-visible presentation decision and a stylesheet this module does not
 * own. FIRE-09's other half, the `hillshade` catalog row in
 * `src/config/layers.ts`, has no such constraint and is the better
 * phone-visible home for the disclosure.
 */
const HILLSHADE_COVERAGE_LABEL = 'Terrain: Pacific Northwest only';

/**
 * `FIRE3D_TERRAIN_COVERAGE_SENTENCE` (src/config/fire3d-presentation.ts)
 * mirrored here as a LITERAL, not an import: this module sits in the eager
 * graph (loaded at first paint), and that constant's owning file is reached
 * only through the 3D Fire mode's dynamic-import chain, so importing it here
 * would pull that chunk into first paint. The full `FIRE3D_COVERAGE_NOTE` is
 * not mirrored because its trailing sentence describes the 3D view's bundled
 * structure bake (the central Oregon pilot area), which says nothing about
 * the flat hillshade and would broaden the claim made here.
 * tests/fire3d-mode.spec.ts asserts this string equals the source constant,
 * so the two cannot drift silently.
 */
const HILLSHADE_COVERAGE_NOTE =
  "Terrain relief uses the USGS 3D Elevation Program's elevation data for 125°W to 110.5°W, 41.5°N to 49.5°N; outside that box the ground renders flat. The archive's detail ends at zoom 8; closer views stretch its deepest tiles.";

/**
 * Append the terrain coverage entry when Terrain Shading is on. It rides an
 * existing key rather than earning one: the hillshade is reference relief,
 * not a condition surface, so it must never materialize a key strip on a map
 * that has otherwise earned none.
 */
function withTerrainCoverage(
  spec: KeySpec | null,
  active: ReadonlySet<string>
): KeySpec | null {
  if (spec === null || !active.has('hillshade')) return spec;
  const clamped = window.matchMedia(MOBILE_MAP_KEY_QUERY).matches;
  return {
    ...spec,
    ariaLabel: `${spec.ariaLabel} ${HILLSHADE_COVERAGE_NOTE}`,
    itemsHtml: clamped
      ? spec.itemsHtml
      : spec.itemsHtml +
        '<span class="map-key-qualification" data-hillshade-coverage title="' +
        `${escapeHtml(HILLSHADE_COVERAGE_NOTE)}">` +
        `${escapeHtml(HILLSHADE_COVERAGE_LABEL)}</span>`
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
  if (coverage === undefined) return '';
  if (!landFramingGovernsCamera()) return '';

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

  if (coverage.minimapProvenance !== undefined && minimapInScene()) {
    clauses.push(coverage.minimapProvenance);
  }

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
 * is the case that most needs the honesty (FIRE-09 precedent:
 * `withTerrainCoverage` rides an existing key instead, but the hillshade
 * note is a bonus qualification, not a standing coverage-honesty contract).
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

/** The key the active layer set earns, or null to hide the strip. */
function activeKey(): KeySpec | null {
  const active = registry.getActiveKeys();
  return withFrameCoverage(
    withTerrainCoverage(hazardKey(), active),
    frameCoverageNote()
  );
}

/** The condition-surface key, before shared reference qualifications. */
function hazardKey(): KeySpec | null {
  const { active, loading, eligible } = keyEligibility();
  let spec: KeySpec | null = null;
  if (eligible.has('heatrisk')) {
    spec = active.has('heatrisk') ? heatKey() : loadingKeySpec('heatrisk');
  } else if (eligible.has('spc-fire-weather')) {
    spec = buildFireKey(active, loading);
  } else if (eligible.has('usfs-whp')) {
    spec = active.has('usfs-whp') ? buildWhpKey() : loadingKeySpec('usfs-whp');
  } else if (eligible.has('cdm-drought')) {
    spec = active.has('cdm-drought') ? cdmKey() : loadingKeySpec('cdm-drought');
  } else if (eligible.has('nadm-drought')) {
    spec = active.has('nadm-drought') ? nadmKey() : loadingKeySpec('nadm-drought');
  } else if (eligible.has('usdm')) {
    spec = active.has('usdm') ? droughtKey() : loadingKeySpec('usdm');
  } else if (eligible.has('sst-anomaly')) {
    spec = active.has('sst-anomaly') ? sstKey() : loadingKeySpec('sst-anomaly');
  } else if (eligible.has('nifc-fires')) {
    spec = buildFireKey(active, loading);
  }

  if (!eligible.has('nws-alerts')) return spec;
  if (loading.has('nws-alerts')) {
    // Activation in flight: a named placeholder row (W2-D6), not the full
    // product scale, which would claim a surface not yet on the map.
    const loadingHtml =
      '<span class="map-key-qualification map-key-loading" data-key-loading="nws-alerts">' +
      'NWS products loading</span>';
    const loadingAria = 'National Weather Service event products loading.';
    if (spec) {
      return {
        ...spec,
        ariaLabel: `${spec.ariaLabel} ${loadingAria}`,
        itemsHtml: spec.itemsHtml + loadingHtml
      };
    }
    return {
      label: 'Products',
      ariaLabel: loadingAria,
      itemsHtml: loadingHtml
    };
  }
  const snapshot = nwsSnapshotQualification();
  const products = nwsProductKey();
  if (spec) {
    return {
      ...spec,
      ariaLabel:
        `${spec.ariaLabel} ${products.ariaLabel} ${snapshot.ariaLabel}`,
      itemsHtml: spec.itemsHtml + products.html + snapshot.html
    };
  }
  return {
    label: 'Products',
    ariaLabel: `${products.ariaLabel} ${snapshot.ariaLabel}`,
    itemsHtml: products.html + snapshot.html
  };
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

  const detailsButton = document.createElement('button');
  detailsButton.id = 'map-key-details-toggle';
  detailsButton.className = 'map-key-details-toggle';
  detailsButton.type = 'button';
  detailsButton.setAttribute('aria-controls', content.id);
  detailsButton.setAttribute('aria-expanded', 'false');

  host.replaceChildren(detailsButton, content);
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
  // The terrain coverage entry is width-gated (see withTerrainCoverage), so
  // crossing the breakpoint has to RE-RENDER the strip, not only re-measure
  // it. `update` diffs against the last rendered html, so this is cheap.
  const onWidthChange = (): void => {
    update();
    layout.schedule();
  };
  widthQuery.addEventListener('change', onWidthChange);
  const toggleDetails = (): void => setDetailsOpen(!detailsOpen);
  const closeDetailsOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !detailsOpen) return;
    setDetailsOpen(false);
    const metric = document.querySelector<HTMLElement>('.conditions-metric[data-metric="drought"][data-layer-on="true"]');
    (host.dataset.keyMetricTrigger === 'true' ? metric : detailsButton)?.focus();
  };
  detailsButton.addEventListener('click', toggleDetails);
  window.addEventListener('ddm:toggle-map-key-details', toggleDetails);
  host.addEventListener('keydown', closeDetailsOnEscape);

  disposeMapKeyOverflow = () => {
    appPresentationObserver.disconnect();
    widthQuery.removeEventListener('change', onWidthChange);
    window.removeEventListener('ddm:toggle-map-key-details', toggleDetails);
    window.removeEventListener('ddm:whp-shade', onWhpShade);
    host.removeEventListener('keydown', closeDetailsOnEscape);
  };

  const update = (): void => {
    const spec = activeKey();
    if (!spec) {
      host.hidden = true;
      setDetailsOpen(false);
      delete host.dataset.keyFamily;
      delete host.dataset.register;
      reflectInteraction();
      layout.schedule();
      return;
    }
    keyLabel = spec.label;
    const shadeKey = whpShadeActive
      ? '<span class="map-key-scale" data-whp-shade-key><strong>3D wildfire potential</strong>' +
        WHP_SHADE_CATEGORIES.map((category) => swatchItem(
          `rgba(255,255,255,${category.opacity * DRAPE_OPACITY})`, category.label
        )).join('') + `<span class="map-key-qualification">${escapeHtml(WHP_SHADE_QUALIFICATION)}</span></span>`
      : '';
    const html =
      `<span class="map-key-label">${escapeHtml(spec.label)}</span>` + spec.itemsHtml + shadeKey;
    if (html !== rendered) {
      // A re-render replaces every node in the strip, so anything the
      // person was operating loses focus. The HeatRisk valid-date select
      // is the only focusable control in here, and since DDM-P8-T05 a day
      // change re-renders TWICE: once to say the new frame is loading, and
      // again when its tiles settle. Without this, a keyboard day change
      // dropped focus the moment the tiles landed and the next arrow key
      // went nowhere. Captured before the rewrite, restored after it.
      const active = document.activeElement;
      const refocusDaySelect =
        active instanceof HTMLElement &&
        content.contains(active) &&
        active.matches('[data-heatrisk-day]');
      rendered = html;
      content.innerHTML = html;
      host.setAttribute('aria-label', spec.ariaLabel);
      if (refocusDaySelect) {
        const restored = content.querySelector('[data-heatrisk-day]');
        if (restored instanceof HTMLElement) restored.focus();
      }
    }
    // The family follows what the strip acknowledges (active plus loading
    // placeholders), so a loading key seats under the same CSS its ready
    // form will use.
    const { eligible } = keyEligibility();
    const nextFamily = resolveMapKeyFamily(eligible);
    if (nextFamily !== family) setDetailsOpen(false);
    family = nextFamily;
    host.dataset.keyFamily = family;
    host.dataset.keyMetricTrigger = String(
      family === 'drought' && getViewMode() === 'brief' &&
      !app?.classList.contains('embed') && !app?.classList.contains('sidebar-collapsed') && !widthQuery.matches
    );
    detailsButton.textContent = family === 'fire' ? 'FIRE' : family === 'heat' ? 'HEAT RISK' : family === 'enso' ? 'ENSO' : spec.label.toUpperCase();
    detailsButton.setAttribute('aria-label', `${detailsOpen ? 'Close' : 'Open'} ${keyLabel} details and key`);
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

  const onWhpShade = (event: Event): void => {
    const detail = (event as CustomEvent<{ layer?: string; active: boolean }>).detail;
    if (detail?.layer === 'usfs-whp') flatWhpShadeActive = Boolean(detail.active);
    else whpShadeActive = Boolean(detail?.active);
    update();
  };
  window.addEventListener('ddm:whp-shade', onWhpShade);

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
  disposeMapKeyTimeBarSpec = onTimeBarSpecChange(update);
  // A framing click never fires a registry event (D-0.7.0-039: camera-only,
  // no layer write), so without this the coverage caution above would only
  // refresh on the NEXT unrelated key change.
  disposeMapKeyFraming = onFramingChange(update);
  // Nor does a Brief/Console flip, and it decides whether the minimap
  // provenance clause has a referent at all (finding 5). Without this the
  // sentence would linger into Console until some unrelated key change.
  disposeMapKeyViewMode = onViewModeChange(update);

  registry.on('change', update);
  // Every status transition can change the strip now that a loading key
  // renders a placeholder (W2-D6); the render diffs, so a status that does
  // not change the HTML is a cheap no-op.
  registry.on('status-change', () => {
    update();
  });
  update();
}
