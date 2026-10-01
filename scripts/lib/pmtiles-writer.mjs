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
 * Scope kept deliberately small for correctness: clustered layout (tiles
 * written in tile-id order), gzip for the internal directories (and for the
 * tiles unless the caller says otherwise), and no cross-tile dedup. An archive
 * whose gzipped directory fits the room the reader's first request leaves after
 * the header is written with a single root directory, exactly as it always was.
 * A larger one is written with one level of leaf directories under a root of
 * RunLength-0 pointers (see `packDirectories`), so a bake can be as deep as it
 * needs. It is not a general-purpose writer. Output is validated by reading it
 * back with the same `pmtiles` reader the browser uses (see
 * build-ecoregion-tiles.mjs and tests/pmtiles-leaf-writer.test.mjs).
 *
 * Reference: PMTiles specification version 3
 * (https://github.com/protomaps/PMTiles/blob/main/spec/v3.md).
 */

import { gzipSync } from 'node:zlib';

/** PMTiles compression enum: 1 = none, 2 = gzip. */
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;
/** PMTiles tile-type enum: 1 = MVT (Mapbox Vector Tile). */
const TILETYPE_MVT = 1;

const HEADER_BYTES = 127;

/**
 * The reader's first-request budget.
 *
 * The `pmtiles` library (and every other conforming reader) fetches the
 * first 16,384 bytes of an archive and expects the header AND the whole
 * root directory to be inside it. A root directory with one entry per
 * tile that passes the budget produces a file that opens nowhere: the
 * reader gunzips a truncated buffer and fails with an unexpected end of
 * file, AFTER the bake has already written the artifact.
 *
 * Measured 2026-08-19 while deepening the transmission bake, when this
 * writer still wrote only a single root: at zoom 12 (10,069 tiles) the
 * root directory reached 18,678 bytes and the archive was unreadable; at
 * zoom 11 (3,816 tiles) it is 7,399 bytes and reads cleanly. Every other
 * shipped archive sits between 540 and 8,201 bytes.
 *
 * The capacity rule is therefore header plus root: the gzipped root must be
 * at most 16,384 - 127 = 16,257 bytes. A directory that fits stays a single
 * root; one that does not moves its entries into gzipped leaf directories
 * and keeps only one RunLength-0 pointer per leaf in the root, so the root
 * fits however many tiles there are.
 */
const READER_FIRST_REQUEST_BYTES = 16_384;

/**
 * Entries per leaf directory to start from when a directory needs leaves,
 * and the factor the leaf size grows by while the root of pointers still
 * does not fit. A leaf this size is a few kilobytes gzipped, one range
 * request for the reader; the growth rule only matters for archives of
 * millions of tiles.
 */
const LEAF_ENTRIES_START = 1_024;
const LEAF_GROWTH = 1.2;

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

/** Split sorted entries into leaves of `leafSize`, gzip each, and build the root of pointers. */
function buildLeaves(entries, leafSize) {
  const leafBuffers = [];
  const pointers = [];
  let leafOffset = 0;
  for (let i = 0; i < entries.length; i += leafSize) {
    const leafGz = Buffer.from(gzipSync(serializeDirectory(entries.slice(i, i + leafSize))));
    // A RunLength-0 entry points at a leaf: its offset is relative to the start
    // of the leaf-directories section and its length is the leaf's gzipped length.
    pointers.push({ tileId: entries[i].tileId, offset: leafOffset, length: leafGz.length, runLength: 0 });
    leafBuffers.push(leafGz);
    leafOffset += leafGz.length;
  }
  return {
    rootGz: Buffer.from(gzipSync(serializeDirectory(pointers))),
    leavesGz: Buffer.concat(leafBuffers),
    leafCount: pointers.length,
    leafSize
  };
}

/**
 * Lay out the directories for entries sorted by ascending tile id.
 *
 * When the gzipped single root fits `rootCapacity` it is returned as is (no
 * leaves). Otherwise the entries are cut into consecutive leaves, starting at
 * 1,024 entries each and growing the leaf size by a factor of 1.2 (rounded up,
 * never past one leaf holding everything) until the gzipped root of one
 * pointer per leaf fits. Throws when even one leaf cannot fit the capacity.
 *
 * @param {{tileId:number,offset:number,length:number,runLength:number}[]} entries
 * @param {number} [rootCapacity] gzipped-root byte budget, default the room the
 *   reader's first request leaves after the header (16,384 - 127).
 * @returns {{rootGz:Buffer, leavesGz:Buffer, leafCount:number, leafSize:number}}
 *   leafCount and leafSize are 0 for a single root.
 */
export function packDirectories(entries, rootCapacity = READER_FIRST_REQUEST_BYTES - HEADER_BYTES) {
  const flatGz = Buffer.from(gzipSync(serializeDirectory(entries)));
  if (flatGz.length <= rootCapacity) {
    return { rootGz: flatGz, leavesGz: Buffer.alloc(0), leafCount: 0, leafSize: 0 };
  }
  if (entries.length > 0) {
    let leafSize = Math.min(LEAF_ENTRIES_START, entries.length);
    for (;;) {
      const packed = buildLeaves(entries, leafSize);
      if (packed.rootGz.length <= rootCapacity) return packed;
      if (leafSize >= entries.length) break;
      leafSize = Math.min(entries.length, Math.ceil(leafSize * LEAF_GROWTH));
    }
  }
  throw new Error(
    `a root directory for ${entries.length} entries cannot fit ${rootCapacity} bytes, ` +
      'even with every entry in one leaf directory'
  );
}

/** Write a 32-bit signed degree value in PMTiles E7 fixed point. */
function e7(deg) {
  return Math.round(deg * 1e7);
}

/**
 * Build a complete PMTiles version 3 archive.
 *
 * @param {object} opts
 * @param {{tileId:number,data:Buffer}[]} opts.tiles Non-empty tiles, sorted by
 *   ascending tileId.
 * @param {number} opts.minZoom
 * @param {number} opts.maxZoom
 * @param {[number,number,number,number]} opts.bounds [minLon,minLat,maxLon,maxLat]
 * @param {[number,number,number]} opts.center [lon,lat,zoom]
 * @param {object} opts.metadata JSON metadata.
 * @param {number} [opts.tileType=1] PMTiles tile type, 1 MVT, 2 PNG.
 * @param {number} [opts.tileCompression=2] PMTiles tile compression enum.
 * @returns {Buffer} the archive bytes: header, root directory, metadata, leaf
 *   directories (none when the root fits), tile data.
 */
export function writePmtiles({
  tiles,
  minZoom,
  maxZoom,
  bounds,
  center,
  metadata,
  tileType = TILETYPE_MVT,
  tileCompression = COMPRESSION_GZIP
}) {
  // Lay out the tile-data section and the directory entries together. Offsets
  // are relative to the start of the tile-data section, per the specification.
  let runningOffset = 0;
  const entries = [];
  const tileBuffers = [];
  for (const t of tiles) {
    // A directory is binary-searched by tile id: a reader cannot find tiles in
    // one that is not strictly ascending, so that layout is refused.
    if (entries.length > 0 && t.tileId <= entries[entries.length - 1].tileId) {
      throw new Error(
        `tile ids must be strictly ascending: ${t.tileId} follows ${entries[entries.length - 1].tileId}`
      );
    }
    entries.push({ tileId: t.tileId, offset: runningOffset, length: t.data.length, runLength: 1 });
    tileBuffers.push(t.data);
    runningOffset += t.data.length;
  }
  const tileData = Buffer.concat(tileBuffers);

  // One gzipped root when it fits the room after the header in the reader's
  // first request; otherwise a root of leaf pointers plus the leaf section.
  const { rootGz: rootDirGz, leavesGz } = packDirectories(entries);
  const metadataGz = Buffer.from(gzipSync(Buffer.from(JSON.stringify(metadata), 'utf8')));

  const rootDirOffset = HEADER_BYTES;
  const rootDirLength = rootDirGz.length;
  const metadataOffset = rootDirOffset + rootDirLength;
  const metadataLength = metadataGz.length;
  const leafDirOffset = metadataOffset + metadataLength;
  const leafDirLength = leavesGz.length;
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
  dv.setUint8(98, tileCompression);
  dv.setUint8(99, tileType);
  dv.setUint8(100, minZoom);
  dv.setUint8(101, maxZoom);
  dv.setInt32(102, e7(bounds[0]), true); // min lon
  dv.setInt32(106, e7(bounds[1]), true); // min lat
  dv.setInt32(110, e7(bounds[2]), true); // max lon
  dv.setInt32(114, e7(bounds[3]), true); // max lat
  dv.setUint8(118, Math.round(center[2])); // center zoom
  dv.setInt32(119, e7(center[0]), true); // center lon
  dv.setInt32(123, e7(center[1]), true); // center lat

  return Buffer.concat([header, rootDirGz, metadataGz, leavesGz, tileData]);
}
