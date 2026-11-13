import type { HazardClusterKey } from '../config/clusters';
import { MOBILE_HAZARD_PRESETS, type ViewPreset } from '../config/presets';

/**
 * The phone hazard rail's cells, generated from the mode table (DR-113, N
 * modes) instead of hand-written in index.html. Keyed by HazardClusterKey so
 * `tsc` refuses a mode without a rail icon; the key order is the rail's order
 * (ENSO, Fire, Drought, Heat), which deliberately differs from the desktop
 * column's HAZARD_CLUSTER_KEYS order. Each value is the icon's SVG shapes.
 * Drought is a simple hollow water droplet (owner, 2026-11-13).
 */
export const HAZARD_RAIL_ICONS: Readonly<Record<HazardClusterKey, string>> = {
  enso: '<path d="M3 8c2.25-3 4.75-3 7 0s4.75 3 7 0 3.5-2.5 4-2.5"/><path d="M3 14c2.25-3 4.75-3 7 0s4.75 3 7 0 3.5-2.5 4-2.5"/><path d="M5 19c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0"/>',
  wildfire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  drought: '<path d="M12 21.5a6.5 6.5 0 0 0 6.5-6.5c0-1.9-.9-3.6-2.8-5.1S12.5 6 12 3c-.5 3-1.8 5.4-3.7 6.9S5.5 13.1 5.5 15a6.5 6.5 0 0 0 6.5 6.5z"/>',
  heat: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>'
};

export interface HazardRailCell {
  readonly preset: ViewPreset;
  readonly icon: string;
}

/** One cell per mode that has a rail preset, in rail order. */
export function hazardRailCells(): HazardRailCell[] {
  return (Object.keys(HAZARD_RAIL_ICONS) as HazardClusterKey[]).flatMap((mode) => {
    const preset = MOBILE_HAZARD_PRESETS.find((p) => p.mode === mode);
    return preset ? [{ preset, icon: HAZARD_RAIL_ICONS[mode] }] : [];
  });
}

/** The rail's buttons, the markup index.html carried by hand until 2026-11-13. */
export function hazardRailMarkup(): string {
  return hazardRailCells()
    .map(
      ({ preset, icon }) =>
        `<button type="button" class="hazard-rail-btn" data-preset="${preset.key}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icon}</svg><span class="map-control-label">${preset.label}</span></button>`
    )
    .join('');
}
