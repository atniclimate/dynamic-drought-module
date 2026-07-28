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
 * Swatches come from the same palette tables as the map fills, so the key
 * can never disagree with the map.
 */

import { registry } from '../state/registry';
import {
  BC_DROUGHT_LEVELS,
  BC_DROUGHT_NO_UPDATE,
  NADM_CATEGORIES,
  USDM_CATEGORIES,
  USDM_NONE_SWATCH,
  SPC_FIREWX_CATEGORIES
} from '../config/palette';
import { getDroughtSurfacePresentation } from '../config/layers';
import { escapeHtml } from '../util/escape';

interface KeySpec {
  readonly label: string;
  readonly ariaLabel: string;
  readonly itemsHtml: string;
}

interface HeatRiskFrame {
  readonly day: number;
  readonly validTime: number;
  readonly name: string;
}

interface HeatRiskFrameEventDetail {
  readonly status:
    | 'loading'
    | 'ready'
    | 'degraded'
    | 'error'
    | 'no-data'
    | 'inactive';
  readonly frames: readonly HeatRiskFrame[];
  readonly selectedDay: number | null;
  readonly hasCoverage: boolean | null;
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

function swatchItem(color: string, code: string): string {
  return `<span class="map-key-item"><span class="map-key-swatch" style="background:${escapeHtml(
    color
  )}"></span>${escapeHtml(code)}</span>`;
}

/**
 * NWS HeatRisk classes. The raster arrives colorized server-side per the
 * published HeatRisk legend; these swatches mirror that published scale
 * (0 little to none is the bare map, matching the none-swatch-leads rule).
 */
const HEATRISK_ITEMS: ReadonlyArray<{ color: string; code: string }> = [
  { color: '#00e087', code: 'Low' },
  { color: '#ffee00', code: 'Minor' },
  { color: '#ff9c00', code: 'Moderate' },
  { color: '#e60000', code: 'Major' },
  { color: '#c800c8', code: 'Extreme' }
];

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
      'Drought category key, D0 abnormally dry through D4 exceptional drought',
    itemsHtml: [USDM_NONE_SWATCH, ...USDM_CATEGORIES]
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
  return {
    label: 'HeatRisk',
    ariaLabel:
      'NWS HeatRisk key, low through extreme expected heat impact (experimental product).' +
      validDate +
      (heatRiskFrameStatus === 'degraded'
        ? ' Live (partial): selected frame has missing tiles.'
        : heatRiskFrameStatus === 'error'
          ? ' Unavailable: no selected-frame tiles loaded.'
          : ''),
    itemsHtml:
      heatDateControl() +
      HEATRISK_ITEMS.map((c) => swatchItem(c.color, c.code)).join('') +
      (heatRiskFrameStatus === 'degraded'
        ? '<span class="map-key-qualification" data-heatrisk-tile-status><strong>live (partial)</strong> Selected frame has missing tiles.</span>'
        : heatRiskFrameStatus === 'error'
          ? '<span class="map-key-qualification" data-heatrisk-tile-status><strong>unavailable</strong> No selected-frame tiles loaded.</span>'
          : '')
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

function fireKey(withOutlook: boolean): KeySpec {
  const outlook = withOutlook
    ? SPC_FIREWX_CATEGORIES.map((c) => swatchItem(c.color, c.label)).join('')
    : '';
  const perimeter =
    '<span class="map-key-item"><span class="map-key-fire-dot"></span>Active fire</span>';
  return {
    label: 'Fire',
    ariaLabel: withOutlook
      ? 'Fire weather key, the SPC outlook categories with NIFC active-fire perimeters'
      : 'Active wildfire key, NIFC perimeters and incident points',
    itemsHtml: outlook + perimeter
  };
}

/** The key the active layer set earns, or null to hide the strip. */
function activeKey(): KeySpec | null {
  const active = registry.getActiveKeys();
  let spec: KeySpec | null = null;
  if (active.has('heatrisk')) spec = heatKey();
  else if (active.has('spc-fire-weather')) spec = fireKey(true);
  else if (active.has('cdm-drought')) spec = cdmKey();
  else if (active.has('nadm-drought')) spec = nadmKey();
  else if (active.has('usdm')) spec = droughtKey();
  else if (active.has('nifc-fires')) spec = fireKey(false);

  if (!active.has('nws-alerts')) return spec;
  const snapshot = nwsSnapshotQualification();
  if (spec) {
    return {
      ...spec,
      ariaLabel: `${spec.ariaLabel} ${snapshot.ariaLabel}`,
      itemsHtml: spec.itemsHtml + snapshot.html
    };
  }
  return {
    label: 'Products',
    ariaLabel: snapshot.ariaLabel,
    itemsHtml: snapshot.html
  };
}

/** Build the swatch strip once and keep it synced to the registry. */
export function initMapKey(): void {
  const host = document.getElementById('map-key');
  if (!host) return;

  let rendered = '';
  const update = (): void => {
    const spec = activeKey();
    if (!spec) {
      host.hidden = true;
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
    const isInteractive =
      active.has('heatrisk') || (active.has('cdm-drought') && cdmLicense !== null);
    host.setAttribute('role', isInteractive ? 'group' : 'img');
    host.style.pointerEvents = isInteractive ? 'auto' : '';
    host.hidden = false;
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
