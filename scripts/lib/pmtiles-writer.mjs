/**
 * Minimal, dependency-light PMTiles version 3 archive writer (build-time only).
 *
 * The Dynamic Drought Module (DDM) renders ecoregion polygons (and, from Phase
 * D Phase 9 onward, soil, fuel, and elevation overlays) from PMTiles vector
 * bundles baked at build time. The conventional generator (tippecanoe) is a
 * native tool that does not run on this Windows toolchain (no tippecanoe, no
 * Docker, no Windows Subsystem for Linux distro), so the tile build is pure
 * JavaScript instead: geojson-vt slices features into tiles, vt-pbf encodes
 * each tile as a Mapbox Vector Tile (MVT), and this module packs the tiles into
 * a PMTiles archive that the runtime `pmtiles` library reads through the
 * MapLibre protocol. The runtime contract is identical to a tippecanoe-built
 * bundle, so the generator can be swapped later without touching the app.
 *
 * Scope kept deliberately small for correctness: a single root directory (no
 * leaf directories), clustered layout (tiles written in tile-id order), gzip
 * for both the internal directory and the tiles, and no cross-tile dedup. That
 * covers the few-hundred-to-few-thousand-tile bundles DDM produces; it is not a
 * general-purpose writer. Output is validated by reading it back with the same
 * `pmtiles` reader the browser uses (see build-ecoregion-tiles.mjs).
 *
 * Reference: PMTiles specification version 3
 * (https://github.com/protomaps/PMTiles/blob/main/spec/v3.md).
 */

import { gzipSync } from 'node:zlib';

/** PMTiles compression enum: 1 = none, 2 = gzip. */
const COMPRESSION_GZIP = 2;
/** PMTiles tile-type enum: 1 = MVT (Mapbox Vector Tile). */
const TILETYPE_MVT = 1;

const HEADER_BYTES = 127;

/**
 * Map a tile z/x/y to its PMTiles tile id (Hilbert-curve ordering). This is the
 * canonical algorithm from the PMTiles specification, inlined so the build step
 * never imports the browser-targeted `pmtiles` module into Node. The smoke test
 * cross-checks a sample against the reader's `tileIdToZxy` to prove agreement.
 */
export function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error(`zoom ${z} exceeds the supported maximum of 26`);
  if (x >= 2 ** z || y >= 2 ** z) throw new Error(`tile ${z}/${x}/${y} out of range`);
  // Base offset: the count of all tiles in zooms 0..z-1, which is (4^z - 1) / 3.
  let acc = (4 ** z - 1) / 3;
  const n = 2 ** z;
  let rx = 0;
  let ry = 0;
  let d = 0;
  let tx = x;
  let ty = y;
  for (let s = n / 2; s > 0; s = Math.floor(s / 2)) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    // Rotate the quadrant so the curve stays continuous.
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      const t = tx;
      tx = ty;
      ty = t;
    }
  }
  return acc + d;
}

/** Append an unsigned LEB128 varint to a byte array (safe to 2^53). */
function writeVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

/**
 * Serialize a directory (entries pre-sorted by ascending tile id) using the
 * PMTiles version 3 column layout: count, then tile-id deltas, run lengths,
 * lengths, and offsets (with the offset-zero shortcut for tiles that abut the
 * previous tile in the data section). The caller gzip-compresses the result.
 */
function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);
  let lastId = 0;
  for (const e of entries) {
    writeVarint(out, e.tileId - lastId);
    lastId = e.tileId;
  }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const prev = entries[i - 1];
    if (i > 0 && e.offset === prev.offset + prev.length) {
      writeVarint(out, 0);
    } else {
      writeVarint(out, e.offset + 1);
    }
  }
  return Uint8Array.from(out);
}

/** Write a 32-bit signed degree value in PMTiles E7 fixed point. */
function e7(deg) {
  return Math.round(deg * 1e7);
}

/**
 * Build a complete PMTiles version 3 archive.
 *
 * @param {object} opts
 * @param {{tileId:number,data:Buffer}[]} opts.tiles Non-empty tiles, each
 *   already MVT-encoded and gzip-compressed, sorted by ascending tileId.
 * @param {number} opts.minZoom
 * @param {number} opts.maxZoom
 * @param {[number,number,number,number]} opts.bounds [minLon,minLat,maxLon,maxLat]
 * @param {[number,number,number]} opts.center [lon,lat,zoom]
 * @param {object} opts.metadata JSON metadata (must carry `vector_layers` for
 *   the MVT source so MapLibre learns the source-layer names and fields).
 * @returns {Buffer} the archive bytes.
 */
export function writePmtiles({ tiles, minZoom, maxZoom, bounds, center, metadata }) {
  // Lay out the tile-data section and the directory entries together. Offsets
  // are relative to the start of the tile-data section, per the specification.
  let runningOffset = 0;
  const entries = [];
  const tileBuffers = [];
  for (const t of tiles) {
    entries.push({ tileId: t.tileId, offset: runningOffset, length: t.data.length, runLength: 1 });
    tileBuffers.push(t.data);
    runningOffset += t.data.length;
  }
  const tileData = Buffer.concat(tileBuffers);

  const rootDirGz = Buffer.from(gzipSync(serializeDirectory(entries)));
  const metadataGz = Buffer.from(gzipSync(Buffer.from(JSON.stringify(metadata), 'utf8')));

  const rootDirOffset = HEADER_BYTES;
  const rootDirLength = rootDirGz.length;
  const metadataOffset = rootDirOffset + rootDirLength;
  const metadataLength = metadataGz.length;
  const leafDirOffset = metadataOffset + metadataLength;
  const leafDirLength = 0;
  const tileDataOffset = leafDirOffset + leafDirLength;
  const tileDataLength = tileData.length;

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('PMTiles', 0, 'ascii');
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  dv.setUint8(7, 3); // spec version
  dv.setBigUint64(8, BigInt(rootDirOffset), true);
  dv.setBigUint64(16, BigInt(rootDirLength), true);
  dv.setBigUint64(24, BigInt(metadataOffset), true);
  dv.setBigUint64(32, BigInt(metadataLength), true);
  dv.setBigUint64(40, BigInt(leafDirOffset), true);
  dv.setBigUint64(48, BigInt(leafDirLength), true);
  dv.setBigUint64(56, BigInt(tileDataOffset), true);
  dv.setBigUint64(64, BigInt(tileDataLength), true);
  dv.setBigUint64(72, BigInt(entries.length), true); // addressed tiles
  dv.setBigUint64(80, BigInt(entries.length), true); // tile entries
  dv.setBigUint64(88, BigInt(entries.length), true); // tile contents (no dedup)
  dv.setUint8(96, 1); // clustered: tiles written in tile-id order
  dv.setUint8(97, COMPRESSION_GZIP); // internal (directory + metadata) compression
  dv.setUint8(98, COMPRESSION_GZIP); // tile compression
  dv.setUint8(99, TILETYPE_MVT);
  dv.setUint8(100, minZoom);
  dv.setUint8(101, maxZoom);
  dv.setInt32(102, e7(bounds[0]), true); // min lon
  dv.setInt32(106, e7(bounds[1]), true); // min lat
  dv.setInt32(110, e7(bounds[2]), true); // max lon
  dv.setInt32(114, e7(bounds[3]), true); // max lat
  dv.setUint8(118, Math.round(center[2])); // center zoom
  dv.setInt32(119, e7(center[0]), true); // center lon
  dv.setInt32(123, e7(center[1]), true); // center lat

  return Buffer.concat([header, rootDirGz, metadataGz, tileData]);
}
