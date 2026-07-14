import type maplibregl from 'maplibre-gl';
import { URLS } from '../config/urls';
import { firstLayerIdAbove } from './layer-order';
import { setBasemapMode } from '../state/basemap-store';
import { showToast } from '../ui/overlay';

/**
 * The opt-in satellite basemap (U4d): EOX Sentinel-2 cloudless, the 2016
 * CC BY 4.0 mosaic (D-0.7.0-028, ruled 2026-07-14 on the verifier receipt
 * in harness/phases/0.7.0/EVIDENCE_EOX_2026-07-14.md).
 *
 * This module rides a LAZY chunk (the P2 stage-5 entry-budget rule): the
 * switcher control and the boot path import it dynamically, so a user who
 * never touches satellite never downloads it. It owns three things:
 *
 *   1. The satellite raster source + layer, inserted into the permanent
 *      bottom stack (src/map/layer-order.ts) directly above the subdued
 *      OSM 'basemap' layer, below hillshade and every data layer, in ANY
 *      activation order (the stage-5 adversarial major 2).
 *   2. The visibility swap plus FAILURE CUSTODY (stage-5 major 6): the
 *      source add and layer add are transactional (a partial setup is
 *      rolled back, never left to poison a retry), and a map error event
 *      on the satellite source (EOX down, offline, blocked) reverts the
 *      whole mode: OSM back, chip hidden, store and URL back to default,
 *      one honest toast. The URL must never claim a satellite view that
 *      is not on screen (invariant 6).
 *   3. The HONESTY SPLIT (D-028 binding condition 2): the ruled legal
 *      attribution VERBATIM as visible text (stage-5 major 1: the URL is
 *      part of the string, so it renders as visible linked text, not a
 *      hidden href), plus the separate plain-language vintage notice
 *      visible whenever the satellite basemap is selected, embeds
 *      included.
 *
 * The satellite layer is deliberately NOT desaturated: it is a one-tap
 * terrain/context inspection surface, and muting it would defeat the
 * inspection (the analysis default remains the subdued OSM basemap).
 */

const SOURCE_ID = 'basemap-satellite';
const LAYER_ID = 'basemap-satellite';

/**
 * The exact legal attribution EOX publishes for the CC BY vintages,
 * captured verbatim 2026-07-14 (EVIDENCE_EOX_2026-07-14.md probe 5):
 * "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH
 * (Contains modified Copernicus Sentinel data 2016 & 2017)".
 * The URL stays VISIBLE text (it is part of the ruled string) and is
 * also the link target.
 */
const EOX_ATTRIBUTION =
  'EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> ' +
  'by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 &amp; 2017)';

/** The plain vintage statement (distinct from the legal attribution). */
const VINTAGE_TEXT = 'Satellite mosaic: 2016 (context only, not current conditions)';

/** Whether the map-level error listener for satellite tiles is wired. */
let errorListenerWired = false;

/** Find or create the vintage notice chip in the shared bottom dock. Its
 * OWN dock row (not inside the space-between foot row): squeezed between
 * the map key and the ATNI badge it wrapped to six lines at 400 px (the
 * U4 stage-5 matrix finding). */
function ensureVintageChip(): HTMLElement | null {
  const existing = document.getElementById('basemap-vintage');
  if (existing) return existing;
  const dock = document.getElementById('map-bottom-dock');
  const foot = dock?.querySelector('.map-dock-foot');
  if (!dock || !foot) return null;
  const chip = document.createElement('div');
  chip.id = 'basemap-vintage';
  chip.className = 'basemap-vintage-chip';
  chip.textContent = VINTAGE_TEXT;
  chip.hidden = true;
  dock.insertBefore(chip, foot);
  return chip;
}

/**
 * Revert to the default basemap after a satellite failure: restore OSM,
 * hide the chip, hand the mode back to the store (which re-syncs the URL)
 * and say so once. Safe to call repeatedly.
 */
function revertToDefault(map: maplibregl.Map, reason: string): void {
  console.warn(`[basemap] satellite reverted: ${reason}`);
  if (map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
  }
  if (map.getLayer('basemap')) {
    map.setLayoutProperty('basemap', 'visibility', 'visible');
  }
  const chip = ensureVintageChip();
  if (chip) chip.hidden = true;
  setBasemapMode('default');
  showToast('Satellite imagery is unavailable right now.');
}

/**
 * Show or hide the satellite basemap. Idempotent; adds the source and
 * layer on first activation, transactionally. The OSM basemap layer's
 * visibility is the inverse, so exactly one basemap renders (and only one
 * attribution shows) at a time.
 */
export function setSatelliteActive(map: maplibregl.Map, active: boolean): void {
  if (active && !map.getSource(SOURCE_ID)) {
    try {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [URLS.basemapSatellite],
        tileSize: 256,
        attribution: EOX_ATTRIBUTION,
        minzoom: 0,
        // The 2016 mosaic is published to zoom 14 (10 m-class imagery),
        // which matches the map's own maxZoom.
        maxzoom: 14
      });
      // Into the bottom stack: above 'basemap', below hillshade and every
      // data layer, regardless of what activated first.
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          layout: { visibility: 'visible' }
        },
        firstLayerIdAbove(map, ['background', 'basemap'])
      );
    } catch (err) {
      // Transactional rollback (stage-5 major 6): a half-built setup must
      // not survive to make the NEXT activation a silent no-op.
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      revertToDefault(map, `setup failed (${String(err)})`);
      return;
    }

    if (!errorListenerWired) {
      errorListenerWired = true;
      // Tile/source failures arrive asynchronously; while satellite is the
      // active basemap they mean the user is looking at a blank map the
      // URL still claims, so the mode reverts honestly. One revert per
      // failure burst: reverting flips visibility, and the guard below
      // ignores errors while the layer is already hidden.
      map.on('error', (e: { sourceId?: string }) => {
        if (e?.sourceId !== SOURCE_ID) return;
        const visible =
          map.getLayer(LAYER_ID) &&
          map.getLayoutProperty(LAYER_ID, 'visibility') !== 'none';
        if (!visible) return;
        revertToDefault(map, 'tile or source error');
      });
    }
  }

  if (map.getLayer(LAYER_ID)) {
    map.setLayoutProperty(LAYER_ID, 'visibility', active ? 'visible' : 'none');
  }
  if (map.getLayer('basemap')) {
    map.setLayoutProperty('basemap', 'visibility', active ? 'none' : 'visible');
  }

  const chip = ensureVintageChip();
  if (chip) chip.hidden = !active;
}
