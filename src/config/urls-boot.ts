/**
 * The boot slice of the URL catalog (DR-008a, 2026-09-03).
 *
 * `src/config/urls.ts` is the service-endpoint catalog: about seventy
 * entries with their verification notes, the single largest source in the
 * entry chunk before this split, and read at boot by exactly two eager
 * modules for these values: the base style wants its two base-map
 * archives, and the deep-link resolver wants the bundled state polygons. Everything else that reads the catalog is a lazily loaded layer,
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
   * DDM's own base map (DDM-P17-T12): two same-origin PMTiles vector
   * archives baked from public files by `scripts/build-base-tiles.mjs`
   * (Census, USGS, Natural Resources Canada, Natural Earth; inputs pinned in
   * `scripts/data/base-tiles-inputs.json`). The edition is in the name, so a
   * rebuild is a new URL. North America to zoom 8 (the highways in their
   * own file); the world to zoom 5.
   */
  baseNaPmtiles: BASE_URL + 'data/ddm-base-na-2026-11.pmtiles',
  baseRoadsPmtiles: BASE_URL + 'data/ddm-roads-na-2026-11.pmtiles',
  baseWorldPmtiles: BASE_URL + 'data/ddm-base-world-2026-11.pmtiles',

  /**
   * Bundled United States state boundaries, read by the deep-link resolver
   * at boot. Baked from the Census Bureau cartographic boundary file by
   * `scripts/build-states.mjs`; the provenance note stays on the catalog
   * entry in `urls.ts`.
   */
  usStatesLocal: BASE_URL + 'data/us-states.geojson'
});
