/**
 * Compact on-map key for the US Drought Monitor surface (0.3.0 design pass).
 *
 * The design critique's first-five-seconds finding: the opening view is a
 * striking drought surface with no visible statement of what the colors
 * mean; the full legend lives in the sidebar below the fold, and in embed
 * mode there is no sidebar at all. This strip answers that in the map's
 * bottom-left corner: the five USDM category swatches with their codes,
 * drawn from the same `USDM_CATEGORIES` single source as the map fill, the
 * sidebar legend, and the conditions strip.
 *
 * Reflect-the-map, like the strip and the hover inspector: visibility keys
 * off the registry (shown while the USDM layer is registered active, hidden
 * otherwise) and nothing is fetched. Scoped deliberately to the USDM, the
 * default-on surface that carries the first impression; the other surfaces
 * keep their sidebar legend sections.
 */

import { registry } from '../state/registry';
import { USDM_CATEGORIES } from '../config/palette';
import { escapeHtml } from '../util/escape';

const USDM_KEY = 'usdm';

/** Build the swatch strip once and keep its visibility synced to the registry. */
export function initMapKey(): void {
  const host = document.getElementById('map-key');
  if (!host) return;

  host.innerHTML =
    '<span class="map-key-label">Drought</span>' +
    USDM_CATEGORIES.map(
      (c) =>
        `<span class="map-key-item"><span class="map-key-swatch" style="background:${escapeHtml(
          c.color
        )}"></span>${escapeHtml(c.code)}</span>`
    ).join('');

  const update = (): void => {
    host.hidden = !registry.getActiveKeys().has(USDM_KEY);
  };
  registry.on('change', update);
  update();
}
