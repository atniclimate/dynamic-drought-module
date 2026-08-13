/**
 * Compact on-map key (0.3.0 design pass; hazard-aware since the 2026-07-14
 * mobile shell, from the ratified 2026-07-11 mockup).
 *
 * The design critique's first-five-seconds finding: the opening view is a
 * striking drought surface with no visible statement of what the colors
 * mean; the full legend lives in the sidebar below the fold, and in embed
 * mode there is no sidebar at all. This strip answers that on the map
 * itself; on desktop and embed it sits in the bottom-left dock, and the
 * mobile shell lifts it to the top of the map (the mockup's "the reference
 * is always above the map").
 *
 * Hazard-aware, reflect-the-map: visibility and content key off the
 * registry. The active condition surface picks the key (US Drought Monitor,
 * NWS HeatRisk, or the SPC fire-weather outlook; the one-surface-at-a-time
 * invariant means at most one is active), with the NIFC perimeter glyphs as
 * the fire fallback when only the event layer is on. Nothing is fetched.
 * Vector swatches come from the map-fill palettes. HeatRisk uses the one
 * issuer-owned mirror table while its raster remains colorized upstream.
 */

import { registry } from '../state/registry';
import {
  BC_DROUGHT_LEVELS,
  BC_DROUGHT_NO_UPDATE,
  HEATRISK_CATEGORIES,
  NADM_CATEGORIES,
  NWS_ALERT_COLORS,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH,
  SPC_FIREWX_CATEGORIES
} from '../config/palette';
import { getDroughtSurfacePresentation } from '../config/layers';
import {
  NIFC_INCIDENT_PRESENTATION,
  USFS_WHP_PRESENTATION
} from '../config/wildfire-presentation';
import { escapeHtml } from '../util/escape';
import {
  createHeatRiskSequenceLoader,
  type HeatRiskFrameEventDetail
} from './heatrisk-sequence-loader';

export interface KeySpec {
  readonly label: string;
  readonly ariaLabel: string;
  readonly itemsHtml: string;
}

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

const HEATRISK_FRAMES_EVENT = 'ddm:heatrisk-frames';
const HEATRISK_DAY_SELECT_EVENT = 'ddm:heatrisk-day-select';
const CDM_SNAPSHOT_EVENT = 'ddm:cdm-snapshot';
const NADM_SNAPSHOT_EVENT = 'ddm:nadm-snapshot';
const NWS_SNAPSHOT_EVENT = 'ddm:nws-products-snapshot';
const MOBILE_MAP_KEY_QUERY = '(max-width: 720px)';
const MOBILE_MAP_KEY_HEIGHT_PROPERTY = '--mobile-map-key-height';

let heatRiskFrames: readonly HeatRiskFrame[] = [];
let heatRiskSelectedDay: number | null = null;
let heatRiskFrameStatus: HeatRiskFrameEventDetail['status'] = 'inactive';
let cdmMonth: string | null = null;
let cdmClasses: CdmSnapshotEventDetail['classes'] = [];
let cdmLicense: CdmSnapshotEventDetail['license'] = null;
let nadmMonth: string | null = null;
let heatRiskHasCoverage: boolean | null = null;
let nwsSnapshotStatus: NwsSnapshotEventDetail['status'] = 'inactive';
let nwsSnapshotAsOf: number | null = null;
let nwsSnapshotTruncated = false;
let disposeMapKeyLayout: (() => void) | null = null;

interface MapKeyLayoutWatch {
  readonly schedule: () => void;
  readonly dispose: () => void;
}

/**
 * Keep the mobile Share, Reset, and loading chrome below the one live key.
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
  let frame: number | null = null;
  let disposed = false;

  const measure = (): void => {
    frame = null;
    if (disposed) return;
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
      widthQuery.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      app.style.removeProperty(MOBILE_MAP_KEY_HEIGHT_PROPERTY);
    }
  };
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
  return {
    label: 'HeatRisk',
    ariaLabel:
      `NWS HeatRisk key, value ${firstCategory.value} ${firstCategory.label} through value ${lastCategory.value} ${lastCategory.label} expected heat impact (experimental product).` +
      validDate +
      (heatRiskFrameStatus === 'degraded'
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
      (heatRiskFrameStatus === 'degraded'
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

export function buildFireKey(activeKeys: ReadonlySet<string>): KeySpec {
  const includeSpcOutlook = activeKeys.has('spc-fire-weather');
  const includeNifcPerimeters = activeKeys.has('nifc-fires');
  if (!includeSpcOutlook && !includeNifcPerimeters) {
    throw new Error('A fire key requires at least one active fire product.');
  }
  const outlook = includeSpcOutlook
    ? '<span class="map-key-scale" data-spc-fire-weather-key>' +
      '<strong class="map-key-scale-label">SPC Day 1 outlook</strong>' +
      SPC_FIREWX_CATEGORIES.map((c) => swatchItem(c.color, c.label)).join('') +
      '</span>'
    : '';
  const perimeters = includeNifcPerimeters
    ? '<span class="map-key-scale" data-nifc-perimeter-key>' +
      '<strong class="map-key-scale-label">NIFC WFIGS current mapped perimeters</strong>' +
      swatchItem(
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
      '</span>'
    : '';
  const ariaParts: string[] = [];
  if (includeSpcOutlook) {
    ariaParts.push(
      'Storm Prediction Center (SPC) Day 1 fire-weather outlook categories.'
    );
  }
  if (includeNifcPerimeters) {
    ariaParts.push(
      'National Interagency Fire Center (NIFC) current mapped Wildfire perimeters, Prescribed fire perimeters, and other or unclassified fire perimeters.'
    );
  }
  return {
    label: 'Fire',
    ariaLabel: ariaParts.join(' '),
    itemsHtml: outlook + perimeters
  };
}

export function buildWhpKey(): KeySpec {
  return {
    label: 'Wildfire potential',
    ariaLabel: USFS_WHP_PRESENTATION.qualification,
    itemsHtml:
      '<span class="map-key-scale" data-usfs-whp-key>' +
      '<strong class="map-key-scale-label">USFS Wildfire Hazard Potential</strong>' +
      USFS_WHP_PRESENTATION.categories
        .map((category) => swatchItem(category.color, category.label))
        .join('') +
      '</span>' +
      `<span class="map-key-qualification">${escapeHtml(
        USFS_WHP_PRESENTATION.qualification
      )}</span>`
  };
}

/** The key the active layer set earns, or null to hide the strip. */
function activeKey(): KeySpec | null {
  const active = registry.getActiveKeys();
  let spec: KeySpec | null = null;
  if (active.has('heatrisk')) spec = heatKey();
  else if (active.has('spc-fire-weather')) {
    spec = buildFireKey(active);
  }
  else if (active.has('usfs-whp')) spec = buildWhpKey();
  else if (active.has('cdm-drought')) spec = cdmKey();
  else if (active.has('nadm-drought')) spec = nadmKey();
  else if (active.has('usdm')) spec = droughtKey();
  else if (active.has('nifc-fires')) {
    spec = buildFireKey(active);
  }

  if (!active.has('nws-alerts')) return spec;
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
  const layout = watchMapKeyLayout(host);
  disposeMapKeyLayout = layout.dispose;
  const heatRiskSequenceLoader = createHeatRiskSequenceLoader(
    () => import('./heatrisk-sequence'),
    (err) => {
      console.warn('[map-key] HeatRisk sequence failed to load.', err);
    }
  );

  let rendered = '';
  const update = (): void => {
    const spec = activeKey();
    if (!spec) {
      host.hidden = true;
      delete host.dataset.keyFamily;
      layout.schedule();
      return;
    }
    const html =
      `<span class="map-key-label">${escapeHtml(spec.label)}</span>` + spec.itemsHtml;
    if (html !== rendered) {
      rendered = html;
      host.innerHTML = html;
      host.setAttribute('aria-label', spec.ariaLabel);
    }
    const active = registry.getActiveKeys();
    host.dataset.keyFamily =
      active.has('usdm') || active.has('nadm-drought') || active.has('cdm-drought')
        ? 'drought'
        : 'other';
    const isInteractive =
      active.has('heatrisk') || (active.has('cdm-drought') && cdmLicense !== null);
    host.setAttribute('role', isInteractive ? 'group' : 'img');
    host.style.pointerEvents = isInteractive ? 'auto' : '';
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

  registry.on('change', update);
  registry.on('status-change', (key) => {
    if (key === 'usdm') update();
  });
  update();
}
