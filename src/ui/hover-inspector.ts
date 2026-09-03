/**
 * Hover inspector (UX-4): a what-is-under-my-cursor readout so a user can
 * compare places without clicking. As the pointer moves over the map, a small
 * fixed readout names what sits beneath it, drawn from whichever layers are
 * active: the state, the ecoregion, the drought category, and the river under
 * the cursor (the last folds in the river-name tooltip the Leaflet port
 * dropped).
 *
 * Like the conditions strip, the inspector only reflects what is rendered: it
 * queries a layer only when that layer's fill or line is present, so it never
 * claims a reading a hidden layer would give. It fetches nothing.
 *
 * Pointer-only by design: touch has no hover, so on a phone the readout simply
 * never shows and the click-to-open popup remains the tap affordance. The
 * readout has `pointer-events: none` so it never intercepts a map drag or click.
 *
 * `mousemove` fires rapidly, so updates are coalesced to one per animation
 * frame; each update is a few small box queries and is cheap.
 */

import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { USDM_CATEGORIES } from '../config/palette';
import { escapeHtml } from '../util/escape';

const READOUT_ID = 'hover-inspector';

// Fill and line layer ids to interrogate, mirroring the layer modules. Query a
// small pixel box (not a bare point) so a thin river line is catchable under a
// slightly-off cursor.
const STATE_FILL = 'us-states-fill';
// The municipal labels layer (U4e). Reading it here puts the OFFICIAL place
// name (okina and macron forms included, D-0.7.0-030 condition 5) on a
// semantic DOM surface instead of only the canvas label.
const PLACE_LABELS = 'us-places-labels';
const ECOREGION_FILLS = ['ecoregions-l4-fill', 'ecoregions-l3-fill'] as const;
// Both frame-slot fills of the 0.5.0b week scrubber; the hidden slot is
// visibility 'none' and never matches, so the read is the on-screen week.
const USDM_FILLS = ['usdm-frame-a-fill', 'usdm-frame-b-fill'] as const;
const HYDRO_LINE = 'hydrography';

/** Half-size of the query box in pixels. */
const BOX = 3;

interface InspectItem {
  readonly label: string;
  readonly value: string;
}

function firstString(props: GeoJsonProperties, keys: readonly string[]): string | null {
  if (!props) return null;
  for (const k of keys) {
    const v = props[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function readDm(props: GeoJsonProperties): number | null {
  if (!props) return null;
  const raw = props['DM'] ?? props['dm'];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
}

function boxAround(point: maplibregl.Point): [maplibregl.PointLike, maplibregl.PointLike] {
  return [
    [point.x - BOX, point.y - BOX],
    [point.x + BOX, point.y + BOX]
  ];
}

/**
 * Collect the readout items under the cursor from the active layers, in a
 * where-then-what reading order: state, place, ecoregion, drought, river.
 */
function collectItems(map: maplibregl.Map, point: maplibregl.Point): InspectItem[] {
  const box = boxAround(point);
  const items: InspectItem[] = [];

  if (map.getLayer(STATE_FILL)) {
    const f = map.queryRenderedFeatures(box, { layers: [STATE_FILL] })[0];
    const name = firstString(f?.properties ?? null, ['NAME', 'name']);
    if (name) items.push({ label: 'State', value: name });
  }

  if (map.getLayer(PLACE_LABELS)) {
    const f = map.queryRenderedFeatures(box, { layers: [PLACE_LABELS] })[0];
    const name = firstString(f?.properties ?? null, ['name']);
    if (name) items.push({ label: 'Place', value: name });
  }

  for (const id of ECOREGION_FILLS) {
    if (!map.getLayer(id)) continue;
    const f = map.queryRenderedFeatures(box, { layers: [id] })[0];
    const name = firstString(f?.properties ?? null, ['US_L4NAME', 'US_L3NAME', 'NA_L3NAME', 'name']);
    if (name) {
      items.push({ label: 'Ecoregion', value: name });
      break; // only one ecoregion level is visible at a time
    }
  }

  const usdmFills = USDM_FILLS.filter((id) => map.getLayer(id));
  if (usdmFills.length > 0) {
    const f = map.queryRenderedFeatures(box, { layers: [...usdmFills] })[0];
    const dm = readDm(f?.properties ?? null);
    if (dm !== null) {
      const cat = USDM_CATEGORIES[dm]!;
      items.push({ label: 'Drought', value: `${cat.code} ${cat.label}` });
    }
  }

  if (map.getLayer(HYDRO_LINE)) {
    const f = map
      .queryRenderedFeatures(box, { layers: [HYDRO_LINE] })
      .find((ff) => typeof ff.properties?.['name'] === 'string' && ff.properties['name'].trim() !== '');
    const name = f ? (f.properties?.['name'] as string) : null;
    if (name) items.push({ label: 'River', value: name });
  }

  return items;
}

function render(el: HTMLElement, items: InspectItem[]): void {
  if (items.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.innerHTML = items
    .map(
      (it) =>
        `<span class="hover-item"><span class="hover-label">${escapeHtml(it.label)}</span>${escapeHtml(it.value)}</span>`
    )
    .join('');
  el.hidden = false;
}

/**
 * Wire the hover inspector. Called once from boot after the map has loaded.
 * The listeners live for the app lifetime.
 */
export function initHoverInspector(map: maplibregl.Map): void {
  const el = document.getElementById(READOUT_ID);
  if (!el) return;

  let pending: maplibregl.Point | null = null;
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    if (!pending) return;
    render(el, collectItems(map, pending));
  };

  map.on('mousemove', (e) => {
    pending = e.point;
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(flush);
  });

  // Leaving the map canvas clears the readout so it never lingers with a stale
  // reading once the pointer is gone.
  map.getCanvas().addEventListener('mouseout', () => {
    pending = null;
    el.hidden = true;
    el.innerHTML = '';
  });
}
