/**
 * Locate: the person marker and its accuracy ring (owner direction
 * 2026-11-09 (sprint), DR-pending).
 *
 * TWO PARTS, ONE CLAIM. The ring is the claim: a circle drawn in true
 * ground metres at the radius the device itself reports, so it grows and
 * shrinks with the map like any other ground feature. The figure is the
 * label: a person standing on a short stem whose foot is the reported
 * point, so the point and a small ring stay visible instead of hiding
 * under the badge.
 *
 * NOT A HAZARD AND NOT THE BLUE DOT. Ink on rich black with a casing, so it
 * reads on any map and borrows no colour from the data. A good fix draws a
 * solid ring and a solid foot; an approximate fix draws a DASHED ring and a
 * hollow foot, the same two faces the card's figure shows. Nothing pulses:
 * the figure settles once on arrival (transform and opacity, the
 * stylesheet's `--dur-settle`) and a reader who asks for reduced motion
 * gets the same marker with no travel.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The source is inline GeoJSON and the
 * figure is a DOM element; there is no sprite, no glyph range and no tile.
 *
 * REMOVAL IS TOTAL. `remove()` takes away both layers, the source, the DOM
 * marker and both subscriptions this module made. `data-ddm-locate-map` on
 * the document root is read back from the map itself after every change
 * (the `data-ddm-emphasis` precedent, src/state/place-emphasis.ts), so a
 * test of the production build can see that nothing was left behind. The
 * stamp carries counts only, never a coordinate.
 */

import * as maplibregl from 'maplibre-gl';

import { discRing } from '../state/geolocate';
import type { LocateFix } from '../state/geolocate';
import { onPlaceSelectionChange } from '../state/place-selection';
import { registry } from '../state/registry';

const SOURCE_ID = 'ddm-locate';
const CASING_LAYER_ID = 'ddm-locate-ring-casing';
const RING_LAYER_ID = 'ddm-locate-ring';
const LAYER_IDS = [CASING_LAYER_ID, RING_LAYER_ID] as const;

/** Mirrors --surface-base and --ink-strong (src/styles/app.css): a map paint cannot read a custom property. */
const RICH_BLACK = '#010B13';
const INK = '#FFFFFF';

/** The figure: a 34 px badge, a stem, and the foot whose centre is the point. */
const FIGURE =
  '<svg class="locate-marker-figure" viewBox="0 0 34 52" width="34" height="52" aria-hidden="true" focusable="false">' +
  '<path class="locate-marker-stem-casing" d="M17 30v14"/><path class="locate-marker-stem" d="M17 30v14"/>' +
  '<circle class="locate-marker-halo" cx="17" cy="17" r="15.5"/>' +
  '<circle class="locate-marker-badge" cx="17" cy="17" r="13.5"/>' +
  '<circle class="locate-marker-ink" cx="17" cy="12.8" r="3.4"/>' +
  '<path class="locate-marker-ink" d="M10.3 24.3a6.7 6.7 0 0 1 13.4 0z"/>' +
  '<circle class="locate-marker-foot" cx="17" cy="46" r="4"/></svg>';

export interface LocateMarker {
  /** Take everything this module added off the map. */
  remove(): void;
}

function stamp(map: maplibregl.Map): void {
  const layers = LAYER_IDS.filter((id) => map.getLayer(id)).length;
  const sources = map.getSource(SOURCE_ID) ? 1 : 0;
  const markers = map.getContainer().querySelectorAll('.locate-marker').length;
  document.documentElement.dataset['ddmLocateMap'] = `layers=${layers} sources=${sources} markers=${markers}`;
}

/**
 * The card is the marker's continuing legend (src/ui/locate-runtime.ts). While
 * it waits hidden (src/ui/fire3d-phone-scene.ts), the figure and the ring wait
 * too: hidden, never removed, and drawn that way if they arrive meanwhile.
 */
let waiting = false;
let applyWaiting: ((waits: boolean) => void) | null = null;

export function setLocateMarkerWaiting(waits: boolean): void {
  waiting = waits;
  applyWaiting?.(waits);
}

/** Draw the marker for a fix. `approximate` is the low-accuracy face. */
export function showLocateMarker(
  map: maplibregl.Map,
  fix: LocateFix,
  options: { readonly approximate: boolean; readonly label: string; readonly animate: boolean }
): LocateMarker {
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      // At least one metre, so a device that reports zero still draws a ring.
      geometry: { type: 'Polygon', coordinates: [discRing(fix.lng, fix.lat, Math.max(1, fix.accuracy))] }
    }
  });
  // No beforeId: the ring belongs above every data layer and label.
  map.addLayer({
    id: CASING_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: { 'line-color': RICH_BLACK, 'line-width': 5, 'line-opacity': 0.8 }
  });
  map.addLayer({
    id: RING_LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: {
      'line-color': INK,
      'line-width': 2,
      ...(options.approximate ? { 'line-dasharray': [2.2, 1.6] } : {})
    }
  });

  const element = document.createElement('div');
  element.className = 'locate-marker';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', options.label);
  if (options.approximate) element.dataset['approximate'] = '';
  if (options.animate) element.dataset['arriving'] = '';
  element.innerHTML = FIGURE;
  // The foot's centre (17, 46) sits on the point.
  const marker = new maplibregl.Marker({ element, anchor: 'top-left', offset: [-17, -46] })
    .setLngLat([fix.lng, fix.lat])
    .addTo(map);

  // A layer that activates later is appended above the ring; put the ring back on top.
  let frame = 0;
  const raise = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const id of LAYER_IDS) if (map.getLayer(id)) map.moveLayer(id);
    });
  };
  const offStatus = registry.on('status-change', raise);
  const offSelection = onPlaceSelectionChange(raise);

  const wait = (waits: boolean): void => {
    element.toggleAttribute('data-waits', waits);
    for (const id of LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', waits ? 'none' : 'visible');
    }
  };
  applyWaiting = wait;
  wait(waiting);

  stamp(map);
  return {
    remove(): void {
      if (applyWaiting === wait) applyWaiting = null;
      waiting = false;
      cancelAnimationFrame(frame);
      offStatus();
      offSelection();
      marker.remove();
      for (const id of LAYER_IDS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      stamp(map);
    }
  };
}
