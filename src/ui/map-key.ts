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
  USDM_CATEGORIES,
  USDM_NONE_SWATCH,
  SPC_FIREWX_CATEGORIES
} from '../config/palette';
import { escapeHtml } from '../util/escape';

interface KeySpec {
  readonly label: string;
  readonly ariaLabel: string;
  readonly itemsHtml: string;
}

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
  return {
    label: 'Drought',
    ariaLabel:
      'Drought category key, D0 abnormally dry through D4 exceptional drought',
    itemsHtml: [USDM_NONE_SWATCH, ...USDM_CATEGORIES]
      .map((c) => swatchItem(c.color, c.code))
      .join('')
  };
}

function heatKey(): KeySpec {
  return {
    label: 'HeatRisk',
    ariaLabel:
      'NWS HeatRisk key, low through extreme expected heat impact (experimental product)',
    itemsHtml: HEATRISK_ITEMS.map((c) => swatchItem(c.color, c.code)).join('')
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
  if (active.has('heatrisk')) return heatKey();
  if (active.has('spc-fire-weather')) return fireKey(true);
  if (active.has('usdm')) return droughtKey();
  if (active.has('nifc-fires')) return fireKey(false);
  return null;
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
    host.hidden = false;
  };
  registry.on('change', update);
  update();
}
