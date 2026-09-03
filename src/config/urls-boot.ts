/**
 * The boot slice of the URL catalog (DR-008a, 2026-09-03).
 *
 * `src/config/urls.ts` is the service-endpoint catalog: about seventy
 * entries with their verification notes, the single largest source in the
 * entry chunk before this split, and read at boot by exactly two eager
 * modules for exactly two values: the base style wants the OpenStreetMap
 * tile template, and the deep-link resolver wants the bundled state
 * polygons. Everything else that reads the catalog is a lazily loaded layer,
 * adapter, or briefing module. This module holds those two values so the
 * eager graph imports it instead of the catalog, and the catalog re-exports
 * them under their old keys so every lazy reader and every script that
 * scans `URLS` sees one whole table. The activation gate
 * (`scripts/check-activation-budget.mjs`) forbids the catalog from the
 * initial static set, so a new eager `URLS` import fails the gate rather
 * than silently undoing the split.
 *
 * Rule for growing this file: a value belongs here only if a module in the
 * initial static set needs it before first paint. Anything else goes in the
 * catalog.
 */

/**
 * The deployment base path. Vite substitutes `import.meta.env.BASE_URL`
 * at build time; the fallback is the GitHub Pages project path, which is
 * what the historical catalog assumed.
 */
export const BASE_URL: string =
  import.meta.env?.BASE_URL ?? '/dynamic-drought-module/';

export const BOOT_URLS = Object.freeze({
  /**
   * OpenStreetMap standard raster, subdued via raster paint in
   * `src/map/style.ts` so the hazard layers dominate. Verified live
   * 2026-05-30; the OSM tile usage policy applies (attribution stays
   * reachable through the map-information panel, owner direction
   * 2026-08-31).
   */
  basemapOSM: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',

  /**
   * Bundled United States state boundaries, read by the deep-link resolver
   * at boot. Baked from the Census Bureau cartographic boundary file by
   * `scripts/build-states.mjs`; the provenance note stays on the catalog
   * entry in `urls.ts`.
   */
  usStatesLocal: BASE_URL + 'data/us-states.geojson'
});
