/**
 * PMTiles leaf-directory writer conformance (DDM-P6-T04, DR-173).
 *
 * `scripts/lib/pmtiles-writer.mjs` must write PMTiles v3 leaf directories when
 * the single compressed root would pass the reader's 16,384-byte first request
 * (header plus root), and must keep the single-root layout byte for byte for
 * every archive that fits. The reader here is the same `pmtiles` library the
 * browser uses, over an in-memory source.
 *
 * Run: node --test tests/pmtiles-leaf-writer.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PMTiles, bytesToHeader, tileIdToZxy, zxyToTileId as readerZxyToTileId } from 'pmtiles';
import * as writer from '../scripts/lib/pmtiles-writer.mjs';

const { writePmtiles, zxyToTileId } = writer;

const HEADER_BYTES = 127;
const FIRST_REQUEST_BYTES = 16_384;
/** The room the first request leaves for the root once the header is in it. */
const ROOT_ROOM_BYTES = FIRST_REQUEST_BYTES - HEADER_BYTES;
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

/** Seeded PRNG (mulberry32): the fixtures are deterministic. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand, length) {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Test-side varint reader, independent of the writer under test. */
function readVarint(buf, state) {
  let result = 0;
  let mul = 1;
  for (;;) {
    const b = buf[state.pos++];
    result += (b & 0x7f) * mul;
    if (b < 0x80) return result;
    mul *= 128;
  }
}

/** Test-side directory decoder (spec v3 column layout). */
function decodeDirectory(uncompressed) {
  const state = { pos: 0 };
  const n = readVarint(uncompressed, state);
  const entries = [];
  let lastId = 0;
  for (let i = 0; i < n; i++) {
    lastId += readVarint(uncompressed, state);
    entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 1 });
  }
  for (let i = 0; i < n; i++) entries[i].runLength = readVarint(uncompressed, state);
  for (let i = 0; i < n; i++) entries[i].length = readVarint(uncompressed, state);
  for (let i = 0; i < n; i++) {
    const v = readVarint(uncompressed, state);
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

function pushVarint(out, value) {
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** Test-side flat (single root) directory for contiguous tiles, gzipped. */
function flatDirectoryGzLength(tileIds, lengths) {
  const out = [];
  pushVarint(out, tileIds.length);
  let last = 0;
  for (const id of tileIds) {
    pushVarint(out, id - last);
    last = id;
  }
  for (let i = 0; i < tileIds.length; i++) pushVarint(out, 1);
  for (const len of lengths) pushVarint(out, len);
  for (let i = 0; i < tileIds.length; i++) pushVarint(out, i === 0 ? 1 : 0);
  return gzipSync(Uint8Array.from(out)).length;
}

function memorySource(archive, requests) {
  return {
    getKey: () => 'memory',
    getBytes: async (offset, length) => {
      if (requests) requests.push({ offset, length });
      const slice = archive.subarray(offset, offset + length);
      return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }
  };
}

function toBuffer(arrayBuffer) {
  return Buffer.from(new Uint8Array(arrayBuffer));
}

function lonToX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}
function xToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}
function yToLat(y, z) {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
}

/** Every tile position inside `bounds` at zoom z, as x and y inclusive ranges. */
function positionsInBounds(bounds, z) {
  const eps = 1e-4;
  return {
    xMin: Math.floor(lonToX(bounds[0], z) + eps),
    xMax: Math.ceil(lonToX(bounds[2], z) - eps) - 1,
    yMin: Math.floor(latToY(bounds[3], z) + eps),
    yMax: Math.ceil(latToY(bounds[1], z) - eps) - 1
  };
}

/**
 * The 20,000-tile heterogeneous fixture: three zoom blocks with irregular
 * tile-id gaps (a seeded keep probability per position) and incompressible
 * payloads of widely varied length, so the directory cannot compress into a
 * single root. Raw payloads are written with tileCompression None.
 */
function makeHeterogeneousTiles() {
  const rand = mulberry32(0x5eed1234);
  const blocks = [
    { z: 11, x0: 1200, y0: 800, w: 180, h: 180, keep: 0.55 },
    { z: 10, x0: 600, y0: 400, w: 90, h: 90, keep: 0.4 },
    { z: 9, x0: 300, y0: 200, w: 45, h: 45, keep: 0.6 }
  ];
  const candidates = [];
  for (const b of blocks) {
    for (let x = b.x0; x < b.x0 + b.w; x++) {
      for (let y = b.y0; y < b.y0 + b.h; y++) {
        if (rand() < b.keep) candidates.push({ z: b.z, x, y });
      }
    }
  }
  // Seeded shuffle, then keep exactly 20,000 so the count never depends on luck.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const chosen = candidates.slice(0, 20_000);
  const tiles = chosen.map((c) => {
    const length = 1 + Math.floor(rand() ** 3 * 1200);
    return { ...c, tileId: zxyToTileId(c.z, c.x, c.y), data: randomBytes(rand, length) };
  });
  tiles.sort((a, b) => a.tileId - b.tileId);
  const top = blocks[0];
  const bounds = [
    xToLon(top.x0, top.z),
    yToLat(top.y0 + top.h, top.z),
    xToLon(top.x0 + top.w, top.z),
    yToLat(top.y0, top.z)
  ];
  return { tiles, bounds, minZoom: 9, maxZoom: 11 };
}

function parseArchive(archive) {
  const header = bytesToHeader(
    archive.buffer.slice(archive.byteOffset, archive.byteOffset + HEADER_BYTES)
  );
  const root = decodeDirectory(
    gunzipSync(
      archive.subarray(header.rootDirectoryOffset, header.rootDirectoryOffset + header.rootDirectoryLength)
    )
  );
  return { header, root };
}

test('20,000 heterogeneous tiles write leaf directories that the browser reader resolves', async (t) => {
  const fixture = makeHeterogeneousTiles();
  const { tiles, bounds, minZoom, maxZoom } = fixture;
  assert.equal(tiles.length, 20_000);
  for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i].tileId > tiles[i - 1].tileId);

  // The ids agree with the reader's own zxyToTileId and tileIdToZxy.
  for (const t of tiles) assert.equal(t.tileId, readerZxyToTileId(t.z, t.x, t.y));
  for (const t of tiles.filter((_, i) => i % 997 === 0)) {
    assert.deepEqual(tileIdToZxy(t.tileId), [t.z, t.x, t.y]);
  }

  // C3: the fixture genuinely needs leaves. The flat compressed directory would
  // not fit the room the first request leaves after the 127-byte header.
  const flatGz = flatDirectoryGzLength(
    tiles.map((t) => t.tileId),
    tiles.map((t) => t.data.length)
  );
  assert.ok(flatGz > ROOT_ROOM_BYTES, `flat directory is ${flatGz} bytes, must exceed ${ROOT_ROOM_BYTES}`);

  const archive = writePmtiles({
    tiles: tiles.map((t) => ({ tileId: t.tileId, data: t.data })),
    minZoom,
    maxZoom,
    bounds,
    center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 10],
    metadata: { name: 'leaf-conformance' },
    tileCompression: COMPRESSION_NONE
  });
  const { header, root } = parseArchive(archive);

  // C2: assert every header field directly, since the reader ignores
  // leafDirectoryLength when it looks a tile up.
  assert.ok(header.leafDirectoryLength > 0, 'the leaf-directory length is nonzero');
  assert.ok(
    header.rootDirectoryOffset + header.rootDirectoryLength <= FIRST_REQUEST_BYTES,
    `header plus root is ${header.rootDirectoryOffset + header.rootDirectoryLength} bytes`
  );
  assert.equal(header.specVersion, 3);
  assert.equal(header.rootDirectoryOffset, HEADER_BYTES);
  assert.equal(header.jsonMetadataOffset, header.rootDirectoryOffset + header.rootDirectoryLength);
  assert.equal(header.leafDirectoryOffset, header.jsonMetadataOffset + header.jsonMetadataLength);
  assert.equal(header.tileDataOffset, header.leafDirectoryOffset + header.leafDirectoryLength);
  assert.equal(header.tileDataLength, tiles.reduce((n, t) => n + t.data.length, 0));
  assert.equal(archive.length, header.tileDataOffset + header.tileDataLength);
  assert.equal(header.clustered, true);
  assert.equal(header.internalCompression, COMPRESSION_GZIP);
  assert.equal(header.tileCompression, COMPRESSION_NONE);
  assert.equal(header.numAddressedTiles, 20_000);
  assert.equal(header.numTileEntries, 20_000);
  assert.equal(header.numTileContents, 20_000);
  assert.equal(header.minZoom, minZoom);
  assert.equal(header.maxZoom, maxZoom);

  // C3: the root holds runLength 0 pointers only, contiguous over the leaf
  // section, and each leaf holds runLength 1 entries in tile-id order.
  assert.ok(root.length >= 3, `${root.length} leaves`);
  assert.ok(root.every((e) => e.runLength === 0));
  assert.equal(root[0].tileId, tiles[0].tileId);
  let expectedLeafOffset = 0;
  for (const e of root) {
    assert.equal(e.offset, expectedLeafOffset, 'a leaf entry offset is relative to the leaf section');
    expectedLeafOffset += e.length;
  }
  assert.equal(expectedLeafOffset, header.leafDirectoryLength);
  const leafFirstIds = [];
  let tileCursor = 0;
  let dataCursor = 0;
  for (const e of root) {
    const leaf = decodeDirectory(
      gunzipSync(
        archive.subarray(
          header.leafDirectoryOffset + e.offset,
          header.leafDirectoryOffset + e.offset + e.length
        )
      )
    );
    leafFirstIds.push(leaf[0].tileId);
    assert.equal(leaf[0].tileId, e.tileId, 'a root pointer carries its leaf first tile id');
    for (const le of leaf) {
      assert.equal(le.runLength, 1);
      assert.equal(le.tileId, tiles[tileCursor].tileId);
      assert.equal(le.offset, dataCursor);
      assert.equal(le.length, tiles[tileCursor].data.length);
      dataCursor += le.length;
      tileCursor++;
    }
  }
  assert.equal(tileCursor, 20_000);
  t.diagnostic(
    `20,000 tiles: flat directory ${flatGz} bytes gzipped; ${root.length} leaves, root ${header.rootDirectoryLength} bytes, ` +
      `leaves ${header.leafDirectoryLength} bytes, header plus root ${header.rootDirectoryOffset + header.rootDirectoryLength} bytes`
  );

  // Read every tile through the pmtiles reader, counting range requests that
  // land in the leaf section.
  const requests = [];
  const reader = new PMTiles(memorySource(archive, requests));
  const readHeader = await reader.getHeader();
  assert.equal(readHeader.leafDirectoryLength, header.leafDirectoryLength);
  const expected = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.data]));
  for (const t of tiles) {
    const got = await reader.getZxy(t.z, t.x, t.y);
    assert.ok(got, `tile ${t.z}/${t.x}/${t.y} resolves`);
    assert.ok(toBuffer(got.data).equals(t.data), `tile ${t.z}/${t.x}/${t.y} bytes`);
  }

  // Every zoom, every position inside the header's bounds: present tiles return
  // their bytes, absent positions return nothing.
  let present = 0;
  let absent = 0;
  for (let z = readHeader.minZoom; z <= readHeader.maxZoom; z++) {
    const r = positionsInBounds(bounds, z);
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        const got = await reader.getZxy(z, x, y);
        const want = expected.get(`${z}/${x}/${y}`);
        if (want) {
          assert.ok(got && toBuffer(got.data).equals(want), `sweep ${z}/${x}/${y}`);
          present++;
        } else {
          assert.equal(got, undefined, `sweep ${z}/${x}/${y} is absent`);
          absent++;
        }
      }
    }
  }
  assert.equal(present, 20_000, 'the sweep found every tile');
  assert.ok(absent > 5_000, `${absent} absent positions were probed`);

  // C3: a leaf read is observed, on the first, second and last leaves.
  const leafRequests = requests.filter(
    (r) =>
      r.offset >= header.leafDirectoryOffset &&
      r.offset < header.leafDirectoryOffset + header.leafDirectoryLength
  );
  assert.ok(leafRequests.length >= root.length, `${leafRequests.length} leaf range requests`);
  const requested = new Set(leafRequests.map((r) => `${r.offset - header.leafDirectoryOffset}:${r.length}`));
  for (const k of [0, 1, root.length - 1]) {
    assert.ok(requested.has(`${root[k].offset}:${root[k].length}`), `leaf ${k} was read`);
  }

  // Tile ids just before and just after each leaf boundary that are absent
  // resolve to nothing, wherever the reader will look for them.
  const present_ = new Set(tiles.map((t) => t.tileId));
  const probes = [];
  for (const first of leafFirstIds) {
    let below = first - 1;
    while (present_.has(below)) below--;
    let above = first + 1;
    while (present_.has(above)) above++;
    probes.push(below, above);
  }
  const lastId = tiles[tiles.length - 1].tileId;
  probes.push(tiles[0].tileId - 1, lastId + 1);
  for (const id of probes) {
    const [z, x, y] = tileIdToZxy(id);
    if (z < minZoom || z > maxZoom) continue;
    assert.equal(await reader.getZxy(z, x, y), undefined, `absent id ${id} at ${z}/${x}/${y}`);
  }
});

test('an archive that fits one root is written exactly as before', async (t) => {
  const original = readFileSync(new URL('../public/data/ecoregions-pnw.pmtiles', import.meta.url));
  const { header, root } = parseArchive(original);
  assert.equal(header.leafDirectoryLength, 0, 'the shipped archive has no leaf section');
  assert.ok(root.every((e) => e.runLength === 1));

  // The original compressed tile slices, in directory order (C1).
  const slices = root.map((e) => ({
    tileId: e.tileId,
    data: original.subarray(header.tileDataOffset + e.offset, header.tileDataOffset + e.offset + e.length)
  }));

  // The sweep through the reader finds exactly the header's addressed tiles.
  const reader = new PMTiles(memorySource(original));
  const bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
  const byId = new Map(slices.map((s) => [s.tileId, s.data]));
  let found = 0;
  for (let z = header.minZoom; z <= header.maxZoom; z++) {
    const r = positionsInBounds(bounds, z);
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        const got = await reader.getZxy(z, x, y);
        if (!got) continue;
        found++;
        const stored = byId.get(readerZxyToTileId(z, x, y));
        assert.ok(stored, `reader returned ${z}/${x}/${y}, which the directory does not list`);
        assert.ok(toBuffer(got.data).equals(gunzipSync(stored)), `decoded ${z}/${x}/${y}`);
      }
    }
  }
  assert.equal(found, header.numAddressedTiles, 'the sweep missed no addressed tile');
  assert.equal(found, slices.length);

  const metadata = JSON.parse(
    gunzipSync(
      original.subarray(header.jsonMetadataOffset, header.jsonMetadataOffset + header.jsonMetadataLength)
    ).toString('utf8')
  );
  const repacked = writePmtiles({
    tiles: slices,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    bounds,
    center: [header.centerLon, header.centerLat, header.centerZoom],
    metadata,
    tileType: header.tileType,
    tileCompression: header.tileCompression
  });
  const again = parseArchive(repacked);

  assert.equal(again.header.leafDirectoryLength, 0, 'no leaf section for an archive that fits');
  assert.equal(again.header.rootDirectoryOffset, HEADER_BYTES);
  assert.equal(again.header.tileDataLength, header.tileDataLength);
  assert.equal(again.header.numAddressedTiles, header.numAddressedTiles);
  assert.equal(again.header.clustered, true);
  assert.equal(again.header.internalCompression, header.internalCompression);
  assert.equal(again.header.tileCompression, header.tileCompression);
  assert.equal(again.header.tileType, header.tileType);
  for (const key of ['minZoom', 'maxZoom', 'minLon', 'minLat', 'maxLon', 'maxLat', 'centerZoom', 'centerLon', 'centerLat']) {
    assert.equal(again.header[key], header[key], key);
  }
  // Every tile, and the whole tile-data section, byte-identical.
  assert.deepEqual(again.root, root, 'the same directory entries');
  assert.ok(
    repacked
      .subarray(again.header.tileDataOffset, again.header.tileDataOffset + again.header.tileDataLength)
      .equals(original.subarray(header.tileDataOffset, header.tileDataOffset + header.tileDataLength)),
    'the tile-data section is byte-identical'
  );
  const reader2 = new PMTiles(memorySource(repacked));
  for (const s of slices.filter((_, i) => i % 7 === 0)) {
    const [z, x, y] = tileIdToZxy(s.tileId);
    const got = await reader2.getZxy(z, x, y);
    assert.ok(got && toBuffer(got.data).equals(gunzipSync(s.data)), `repacked ${z}/${x}/${y}`);
  }
  // The uncompressed root directory is identical too (independent of zlib).
  assert.ok(
    gunzipSync(repacked.subarray(HEADER_BYTES, HEADER_BYTES + again.header.rootDirectoryLength)).equals(
      gunzipSync(original.subarray(HEADER_BYTES, HEADER_BYTES + header.rootDirectoryLength))
    )
  );
  // Reported, not asserted: gzip and JSON reproduction are not this writer's.
  t.diagnostic(
    `ecoregions re-pack: ${slices.length} tiles, whole archive byte-identical: ${repacked.equals(original)}`
  );
});

test('the capacity rule is header plus root, not the root alone', async () => {
  // Find, with a seeded stream, the first tile count whose flat compressed
  // directory passes the 16,257 bytes left after the header. The count just
  // below it fits one root; the count at it does not, although the root alone
  // is still under 16,384.
  const rand = mulberry32(0xc0ffee);
  const pool = randomBytes(rand, 4_000);
  const ids = [];
  const lengths = [];
  let id = 0;
  for (let i = 0; i < 20_000; i++) {
    id += 1 + Math.floor(rand() * 64);
    ids.push(id);
    lengths.push(1 + Math.floor(rand() * 3000));
  }
  const dataAt = (i) => pool.subarray(i % 1000, (i % 1000) + lengths[i]);
  const gzAt = (n) => flatDirectoryGzLength(ids.slice(0, n), lengths.slice(0, n));
  assert.ok(gzAt(ids.length) > ROOT_ROOM_BYTES, 'the stream is long enough to spill');
  let n = 500;
  while (gzAt(n + 50) <= ROOT_ROOM_BYTES) n += 50;
  while (gzAt(n + 1) <= ROOT_ROOM_BYTES) n++;
  const fits = n;
  const spills = n + 1;
  assert.ok(gzAt(fits) <= ROOT_ROOM_BYTES);
  assert.ok(gzAt(spills) > ROOT_ROOM_BYTES, 'header plus root passes 16,384 here');
  assert.ok(gzAt(spills) <= FIRST_REQUEST_BYTES, 'the root alone is still under 16,384');

  const build = (count) =>
    writePmtiles({
      tiles: ids.slice(0, count).map((tileId, i) => ({ tileId, data: dataAt(i) })),
      minZoom: 0,
      maxZoom: 14,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 0],
      metadata: {},
      tileCompression: COMPRESSION_NONE
    });

  const single = parseArchive(build(fits));
  assert.equal(single.header.leafDirectoryLength, 0, 'the count that fits keeps one root');
  assert.ok(HEADER_BYTES + single.header.rootDirectoryLength <= FIRST_REQUEST_BYTES);
  assert.ok(single.root.every((e) => e.runLength === 1));

  const archive = build(spills);
  const leafy = parseArchive(archive);
  assert.ok(leafy.header.leafDirectoryLength > 0, 'the count that spills takes the leaf path');
  assert.ok(leafy.header.rootDirectoryOffset + leafy.header.rootDirectoryLength <= FIRST_REQUEST_BYTES);
  assert.ok(leafy.root.every((e) => e.runLength === 0));

  const reader = new PMTiles(memorySource(archive));
  for (const i of [0, 1, spills >> 1, spills - 2, spills - 1]) {
    const [z, x, y] = tileIdToZxy(ids[i]);
    const got = await reader.getZxy(z, x, y);
    assert.ok(got, `tile ${i} resolves`);
    assert.ok(toBuffer(got.data).equals(dataAt(i)), `tile ${i} bytes`);
  }
});

test('the writer refuses only a layout no conforming reader could open', () => {
  const tile = (tileId) => ({ tileId, data: Buffer.from([1, 2, 3]) });
  const base = { minZoom: 0, maxZoom: 3, bounds: [-1, -1, 1, 1], center: [0, 0, 0], metadata: {} };
  // Rule: a directory must list strictly ascending tile ids, or the reader's
  // binary search cannot find them; and a layout whose root cannot fit its
  // room even with one leaf holding everything is refused.
  assert.throws(() => writePmtiles({ ...base, tiles: [tile(5), tile(3)] }), /ascending/);
  assert.throws(() => writePmtiles({ ...base, tiles: [tile(3), tile(3)] }), /ascending/);
  assert.doesNotThrow(() => writePmtiles({ ...base, tiles: [] }));

  const entries = Array.from({ length: 50 }, (_, i) => ({
    tileId: i * 3 + 1,
    offset: i * 7,
    length: 7,
    runLength: 1
  }));
  assert.throws(() => writer.packDirectories(entries, 2), /cannot fit/);
});

test('the leaf size grows until the root fits its room', () => {
  const rand = mulberry32(0xbadc0de);
  let offset = 0;
  const entries = [];
  let id = 0;
  for (let i = 0; i < 20_000; i++) {
    id += 1 + Math.floor(rand() * 9);
    const length = 1 + Math.floor(rand() * 900);
    entries.push({ tileId: id, offset, length, runLength: 1 });
    offset += length;
  }
  const roomy = writer.packDirectories(entries);
  assert.ok(roomy.leafCount >= 2);
  assert.ok(roomy.rootGz.length <= ROOT_ROOM_BYTES);

  const tight = writer.packDirectories(entries, 60);
  assert.ok(tight.rootGz.length <= 60, `root is ${tight.rootGz.length} bytes`);
  assert.equal(roomy.leafSize, 1_024, 'a leaf starts at 1,024 entries');
  // The leaf size follows the 1.2 growth sequence, and stops at the first size
  // whose root fits, well short of one leaf holding everything.
  const sequence = [];
  for (let s = 1_024; ; s = Math.min(entries.length, Math.ceil(s * 1.2))) {
    sequence.push(s);
    if (s >= entries.length) break;
  }
  assert.ok(sequence.includes(tight.leafSize), `${tight.leafSize} is on the growth sequence`);
  assert.ok(tight.leafSize < entries.length, 'the leaf size did not jump to one leaf');
  assert.ok(tight.leafSize > roomy.leafSize, 'the leaf size grew');
  assert.ok(tight.leafCount < roomy.leafCount);

  // Whatever the leaf size, the leaves and the root reproduce every entry.
  const rootEntries = decodeDirectory(gunzipSync(tight.rootGz));
  assert.equal(rootEntries.length, tight.leafCount);
  let cursor = 0;
  const seen = [];
  for (const r of rootEntries) {
    assert.equal(r.runLength, 0);
    for (const e of decodeDirectory(gunzipSync(tight.leavesGz.subarray(r.offset, r.offset + r.length)))) {
      seen.push(e);
      cursor++;
    }
  }
  assert.equal(cursor, entries.length);
  assert.deepEqual(seen, entries);
});
