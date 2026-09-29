/**
 * Builds the Key drawer's per-cluster section hosts from
 * `src/config/detail-sections.ts` (S30D D1 M11 repair round 3; DR-158:
 * the built index.html's gzip went over its ratified budget, and DR-085
 * forbids raising a budget to pass a gate, so the markup this module
 * built is retired from index.html; DR-113: DETAIL_SECTIONS becomes the
 * one source instead of a list authored twice).
 *
 * BOOT ORDER (traced 2026-09-28, both paths dynamic imports off
 * `src/main.ts`):
 *   1. `main.ts:196-204`'s `loadMapKey()` dynamically imports
 *      `src/ui/map-key.ts` and calls `initMapKey()` synchronously as
 *      soon as that chunk resolves. `initMapKey()` builds the drawer's
 *      DOM synchronously in the same call (the block around
 *      `map-key.ts:1141-1167`), including this module's
 *      `ensureDetailSectionHosts()` call, which appends the built block
 *      into `#map-key-content` before `initMapKey()` returns.
 *   2. Separately, map-key.ts wires a `HeatRiskSequenceLoader`
 *      (`heatrisk-sequence-loader.ts`) whose `.apply()` runs on every
 *      HeatRisk raster-status event; the FIRST non-`'inactive'` one
 *      dynamically imports `src/ui/heatrisk-sequence.ts` (a SEPARATE
 *      chunk) and calls `mountHeatRiskSequence()` once THAT import
 *      resolves (`heatrisk-sequence-loader.ts:38-43`).
 *      `mountHeatRiskSequence` looks up its section host near
 *      `heatrisk-sequence.ts:820`.
 *   In practice (1) always finishes first: it is one chunk load ahead of
 *   (2), which needs its own chunk load PLUS a live raster-status event
 *   to even start. But nothing here is allowed to depend on that timing
 *   (no timer, no assumed order): `ensureDetailSectionHosts()` is
 *   idempotent and looks up hosts by a `Map`, never by `document.
 *   getElementById` on a node this module has not (yet) attached itself,
 *   so whichever of map-key.ts or heatrisk-sequence.ts calls first
 *   builds the block (in memory; only map-key.ts, the sole owner, ever
 *   appends it into the document) and every later caller, from either
 *   module, gets the exact same nodes back.
 */
import {
  DETAIL_SECTIONS,
  DETAIL_SECTION_KEYS
} from '../config/detail-sections';

let container: HTMLDivElement | null = null;
const hostsById = new Map<string, HTMLElement>();

/**
 * Builds `#map-key-drawer-sections` and one `section#<homeId>` per
 * declared key, in DETAIL_SECTION_KEYS order (DR-113: never a literal
 * list), on first call; returns the SAME node on every later call. Not
 * attached to the document by this function: map-key.ts is the one
 * place that ever appends it (into `#map-key-content`), exactly once.
 */
export function ensureDetailSectionHosts(): HTMLDivElement {
  if (container) return container;
  const built = document.createElement('div');
  built.id = 'map-key-drawer-sections';
  built.className = 'map-key-drawer-sections';
  built.hidden = true;
  for (const key of DETAIL_SECTION_KEYS) {
    const def = DETAIL_SECTIONS[key];
    const section = document.createElement('section');
    section.id = def.homeId;
    section.className = 'map-key-drawer-section';
    section.dataset['detailSection'] = def.key;
    section.hidden = true;
    const fallback = document.createElement('p');
    fallback.className = 'map-key-section-fallback';
    fallback.dataset['detailSectionFallback'] = '';
    fallback.textContent = def.fallback;
    section.append(fallback);
    built.append(section);
    hostsById.set(def.homeId, section);
  }
  container = built;
  return container;
}

/**
 * The single section host for one declared key's `homeId`. Builds the
 * whole block first if nothing has yet (see the boot-order note above),
 * so this never depends on map-key.ts having run, or on the block being
 * attached to the document yet: the lookup is by `Map`, not
 * `document.getElementById`.
 */
export function getDetailSectionHost(homeId: string): HTMLElement | null {
  ensureDetailSectionHosts();
  return hostsById.get(homeId) ?? null;
}
