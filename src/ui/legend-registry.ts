/**
 * Unified legend registry (UX-3).
 *
 * Retires the four ad-hoc legend panels (each layer toggling its own hidden
 * `<section>` in index.html) in favor of ONE panel whose sections are
 * contributed by whichever layers are active. A layer calls `showLegend` on
 * activate and `hideLegend` on deactivate; the registry owns section ordering
 * (the active condition surface, then events, then the ecoregion reference)
 * and shows or hides the panel as the last section comes and goes, so an empty
 * legend never occupies sidebar space.
 *
 * Because sections are created and destroyed per activation (rather than a
 * fixed panel toggled hidden), any interactive control a section carries (the
 * gridded-index product selector, the ecoregion Level III/IV selector) must be
 * built and wired inside the section's `render`, not once at boot. The layer
 * modules do exactly that.
 */

import { escapeHtml } from '../util/escape';

const PANEL_ID = 'legend-panel';
const SECTIONS_ID = 'legend-sections';

/**
 * Ordering bands so callers pass an intent, not a magic number. Lower renders
 * higher in the panel: the active condition surface on top, then events, then
 * the ecoregion reference key.
 */
export const LEGEND_ORDER = {
  surface: 10,
  event: 20,
  reference: 30
} as const;

export interface LegendSpec {
  /** Ordering within the panel; lower renders higher. Use LEGEND_ORDER. */
  readonly order: number;
  /** Fill the section body. Called each time the section is (re)shown. */
  render(body: HTMLElement): void;
}

function panelEl(): HTMLElement | null {
  return document.getElementById(PANEL_ID);
}

function sectionsEl(): HTMLElement | null {
  return document.getElementById(SECTIONS_ID);
}

function sectionFor(key: string): HTMLElement | null {
  const container = sectionsEl();
  if (!container) return null;
  return container.querySelector<HTMLElement>(
    `.legend-section[data-legend="${cssEscape(key)}"]`
  );
}

/**
 * Show (or rebuild) a layer's legend section, inserted in `order` position
 * among its siblings. Returns the section element `render` filled, or null if
 * the legend panel is not in the DOM.
 */
export function showLegend(key: string, spec: LegendSpec): HTMLElement | null {
  const container = sectionsEl();
  const panel = panelEl();
  if (!container || !panel) return null;

  // Rebuild cleanly on a re-activation: drop any stale section for this key.
  sectionFor(key)?.remove();

  const section = document.createElement('div');
  section.className = 'legend-section';
  section.dataset['legend'] = key;
  section.dataset['order'] = String(spec.order);
  spec.render(section);

  insertOrdered(container, section, spec.order);
  panel.hidden = false;
  return section;
}

/** Remove a layer's legend section; hide the panel when the last one goes. */
export function hideLegend(key: string): void {
  sectionFor(key)?.remove();
  const container = sectionsEl();
  const panel = panelEl();
  if (container && panel && container.childElementCount === 0) {
    panel.hidden = true;
  }
}

/** The section element for a key, for in-place dynamic updates (ecoregion list). */
export function getLegendSection(key: string): HTMLElement | null {
  return sectionFor(key);
}

function insertOrdered(container: HTMLElement, section: HTMLElement, order: number): void {
  const siblings = Array.from(container.children) as HTMLElement[];
  const after = siblings.find((el) => Number(el.dataset['order'] ?? '0') > order);
  if (after) container.insertBefore(section, after);
  else container.appendChild(section);
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Shared builder for the common legend shape
// ---------------------------------------------------------------------------

export interface SwatchEntry {
  readonly color: string;
  readonly label: string;
}

/**
 * Render the common legend shape: a titled swatch list plus an optional note.
 * Used by the static-key layers (usdm, drought, alerts, fires); the two layers
 * with an interactive control (gridded-index, ecoregions) build their own DOM.
 * The `note` is plain text and is escaped; a note that needs a link builds its
 * section directly rather than through this helper.
 */
export function renderSwatchLegend(
  body: HTMLElement,
  title: string,
  entries: readonly SwatchEntry[],
  note?: string
): void {
  const items = entries
    .map(
      (e) =>
        `<li><span class="swatch" style="background:${escapeHtml(e.color)}"></span>${escapeHtml(e.label)}</li>`
    )
    .join('');
  body.innerHTML =
    `<h3 class="legend-section-title">${escapeHtml(title)}</h3>` +
    `<ul class="legend">${items}</ul>` +
    (note ? `<p class="legend-note">${escapeHtml(note)}</p>` : '');
}
