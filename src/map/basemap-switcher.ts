import type maplibregl from 'maplibre-gl';
import {
  getBasemapMode,
  setBasemapMode,
  onBasemapChange
} from '../state/basemap-store';
import type { BasemapMode } from '../state/basemap-store';
import { showToast } from '../ui/overlay';

/**
 * The basemap switcher (U4d, D-0.7.0-005 / D-0.7.0-031).
 *
 * One `IControl` button that flips between the desaturated analysis
 * default and opt-in recent satellite context; deliberately NOT a style
 * gallery (the corpus's product-lens guardrail). The control stacks with
 * the existing attribution and scale controls, carries real button
 * semantics (aria-pressed reflects the satellite state), and stays
 * provider-neutral: the NOAA source, attribution, and observation-time
 * notice live in the lazy `./satellite` chunk so the entry bundle never
 * pays for them (the P2 stage-5 lazy-chunk requirement).
 *
 * State custody: the store (src/state/basemap-store.ts) owns the mode and
 * the URL sync subscription; this control owns the map-side application
 * and the button. The boot path (`applyUrlStateSync`) seeds the store and
 * calls `applyBasemapMode` directly, so a `basemap=satellite` deep link
 * renders without the control being clicked.
 */

/**
 * Apply a basemap mode to the map. Lazy-imports the satellite module on
 * first use; idempotent per mode. On a chunk or source failure the mode
 * REVERTS to 'default' and says so (invariant 6, honest feedback): the
 * URL must never claim a satellite view that is not on screen.
 */
export async function applyBasemapMode(
  map: maplibregl.Map,
  mode: BasemapMode
): Promise<void> {
  try {
    const { setSatelliteActive } = await import('./satellite');
    await setSatelliteActive(map, mode === 'satellite');
  } catch (err) {
    console.error('[basemap] satellite module failed to load:', err);
    if (mode === 'satellite') {
      setBasemapMode('default');
      showToast('Recent satellite imagery is unavailable. Default map restored.');
    }
  }
}

/** The one-button basemap switcher control. */
export class BasemapSwitcherControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  onAdd(map: maplibregl.Map): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'basemap-switcher-btn';
    btn.setAttribute('aria-label', 'Recent NOAA satellite imagery');
    btn.title = 'Recent NOAA satellite imagery';
    // A text label rather than an icon font: self-hosted posture, and the
    // label reads at control size. Relabeled from 'SAT' to 'Satellite' by
    // E2 (D-0.7.0-058 ruling 2) so the switcher reads as one family with
    // the Share view / Reset stack. Styled from tokens in app.css.
    btn.textContent = 'Satellite';

    const reflect = (): void => {
      const on = getBasemapMode() === 'satellite';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    };
    reflect();
    this.unsubscribe?.();
    this.unsubscribe = onBasemapChange(reflect);

    btn.addEventListener('click', () => {
      const next: BasemapMode =
        getBasemapMode() === 'satellite' ? 'default' : 'satellite';
      // Store first (URL and button state update immediately), then the
      // map-side application; a failed chunk reverts the store inside
      // applyBasemapMode.
      setBasemapMode(next);
      void applyBasemapMode(map, next);
    });

    container.appendChild(btn);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.container?.remove();
    this.container = null;
  }
}
