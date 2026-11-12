/**
 * Slice one or more GeoJSON layers into a PMTiles vector bundle (build-time).
 *
 * geojson-vt cuts each FeatureCollection into tiles, vt-pbf encodes each tile
 * as a multi-layer Mapbox Vector Tile (MVT), and pmtiles-writer packs them into
 * a PMTiles version 3 archive. The two tiling primitives are MapLibre's own
 * internals (geojson-vt and vt-pbf), so the encoding matches what MapLibre
 * expects to read back. This is the reusable core for every DDM Phase D tile
 * bundle (ecoregions first; soil, fuel, and elevation overlays later); the
 * per-dataset driver supplies the layers and the simplification choices.
 */

import { gzipSync } from 'node:zlib';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { zxyToTileId, writePmtiles } from './pmtiles-writer.mjs';

/** Web Mercator tile column for a longitude at a zoom. */
function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/** Web Mercator tile row for a latitude at a zoom. */
function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Collect the union of property keys across a FeatureCollection. */
function fieldsOf(featureCollection) {
  const fields = {};
  for (const f of featureCollection.features ?? []) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (!(k in fields)) fields[k] = typeof v === 'number' ? 'Number' : 'String';
    }
  }
  return fields;
}

/**
 * Build a PMTiles archive from named GeoJSON layers.
 *
 * @param {Record<string, GeoJSON.FeatureCollection | {data: GeoJSON.FeatureCollection, minZoom?: number, maxZoom?: number, as?: string}>} layers
 *   Source-layer name to FeatureCollection, or to `{data, minZoom, maxZoom, as}`
 *   when a layer is stored over fewer zooms than the archive. The names (or
 *   `as`, which merges several inputs into one tile layer) become the
 *   MapLibre `source-layer` ids.
 * @param {object} opts
 * @param {number} [opts.minZoom=0]
 * @param {number} [opts.maxZoom=10] Highest stored zoom; MapLibre overzooms above.
 * @param {[number,number,number,number]} opts.bounds [minLon,minLat,maxLon,maxLat]
 * @param {[number,number,number]} [opts.center]
 * @param {number} [opts.tolerance=3] Per-tile simplification tolerance (geojson-vt units).
 * @param {string} [opts.attribution]
 * @param {string} [opts.name]
 * @returns {{archive:Buffer, tileCount:number, vectorLayers:object[]}}
 */
export function geojsonLayersToPmtiles(layers, opts) {
  const minZoom = opts.minZoom ?? 0;
  const maxZoom = opts.maxZoom ?? 10;
  const tolerance = opts.tolerance ?? 3;
  const bounds = opts.bounds;
  const center = opts.center ?? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, minZoom];

  const indexes = {};
  const vectorLayers = [];
  for (const [name, spec] of Object.entries(layers)) {
    const fc = spec.type === 'FeatureCollection' ? spec : spec.data;
    const layerMin = Math.max(minZoom, spec.minZoom ?? minZoom);
    const layerMax = Math.min(maxZoom, spec.maxZoom ?? maxZoom);
    const index = geojsonvt(fc, {
      maxZoom: layerMax,
      indexMaxZoom: layerMax,
      tolerance: spec.tolerance ?? tolerance,
      extent: 4096,
      buffer: 64,
      generateId: true
    });
    // `as` writes several inputs into one tile layer, each over its own zooms
    // (a zoom band: small features stored only from the zoom that shows them).
    const id = spec.as ?? name;
    indexes[name] = { index, id, minZoom: layerMin, maxZoom: layerMax };
    const prior = vectorLayers.find((l) => l.id === id);
    if (prior) {
      prior.minzoom = Math.min(prior.minzoom, layerMin);
      prior.maxzoom = Math.max(prior.maxzoom, layerMax);
      prior.fields = { ...prior.fields, ...fieldsOf(fc) };
    } else {
      vectorLayers.push({ id, minzoom: layerMin, maxzoom: layerMax, fields: fieldsOf(fc) });
    }
  }

  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z - 1;
    const xMin = clamp(lonToTileX(bounds[0], z), 0, n);
    const xMax = clamp(lonToTileX(bounds[2], z), 0, n);
    // Latitude grows downward in tile rows, so the north edge gives the min row.
    const yMin = clamp(latToTileY(bounds[3], z), 0, n);
    const yMax = clamp(latToTileY(bounds[1], z), 0, n);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const tileLayers = {};
        let hasData = false;
        for (const { index, id, minZoom: lo, maxZoom: hi } of Object.values(indexes)) {
          if (z < lo || z > hi) continue;
          const t = index.getTile(z, x, y);
          if (t && t.features && t.features.length > 0) {
            const prior = tileLayers[id];
            tileLayers[id] = prior ? { ...prior, features: [...prior.features, ...t.features] } : t;
            hasData = true;
          }
        }
        if (!hasData) continue;
        const mvt = vtpbf.fromGeojsonVt(tileLayers, { version: 2 });
        const gz = Buffer.from(gzipSync(Buffer.from(mvt)));
        tiles.push({ tileId: zxyToTileId(z, x, y), data: gz });
      }
    }
  }
  tiles.sort((a, b) => a.tileId - b.tileId);

  const metadata = {
    name: opts.name ?? 'ddm-tiles',
    format: 'pbf',
    type: 'overlay',
    minzoom: minZoom,
    maxzoom: maxZoom,
    bounds,
    center,
    vector_layers: vectorLayers,
    attribution: opts.attribution ?? ''
  };

  const archive = writePmtiles({ tiles, minZoom, maxZoom, bounds, center, metadata });
  return { archive, tileCount: tiles.length, vectorLayers };
}
