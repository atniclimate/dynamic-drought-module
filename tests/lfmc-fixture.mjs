// A stand-in for the published live fuel moisture maps: a small Cloud
// Optimized GeoTIFF built in memory in exactly the form src/util/cog.ts reads
// (classic little-endian TIFF, one unsigned 16-bit sample, Deflate tiles,
// longitude/latitude grid, coarser copies after the full image), plus the
// publisher's list and a fetch answer that honours byte ranges. Shared by the
// node tests and the browser stub so both exercise the same bytes.

import { deflateSync } from 'node:zlib';

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 12: 8 };
export const LFMC_NO_DATA = 65535;

/**
 * Build the raster. `levels` is full resolution first; each gives its size
 * and a `value(col, row)` function (return LFMC_NO_DATA for an empty cell).
 * `overrides` replaces header fields by TIFF tag number, for the refusal tests.
 */
export function buildLfmcCog({ west, north, pixel, tile = 16, levels, overrides = {}, byteOrder = 0x4949, magic = 42 }) {
  const images = levels.map((level) => {
    const across = Math.ceil(level.width / tile);
    const down = Math.ceil(level.height / tile);
    const tiles = [];
    for (let tr = 0; tr < down; tr += 1) {
      for (let tc = 0; tc < across; tc += 1) {
        const raw = Buffer.alloc(tile * tile * 2);
        for (let r = 0; r < tile; r += 1) {
          for (let c = 0; c < tile; c += 1) {
            const col = tc * tile + c;
            const row = tr * tile + r;
            raw.writeUInt16LE(col < level.width && row < level.height ? level.value(col, row) : LFMC_NO_DATA, (r * tile + c) * 2);
          }
        }
        tiles.push(deflateSync(raw));
      }
    }
    return { ...level, tiles };
  });

  // [tag, type, values]; values is a string for ASCII. Tile offsets are filled in once the layout is known.
  const entriesFor = (image, index) => {
    const base = [
      [254, 4, [index === 0 ? 0 : 1]],
      [256, 4, [image.width]],
      [257, 4, [image.height]],
      [258, 3, [16]],
      [259, 3, [8]],
      [277, 3, [1]],
      [322, 3, [tile]],
      [323, 3, [tile]],
      [324, 4, image.tiles.map(() => 0)],
      [325, 4, image.tiles.map((t) => t.length)],
      [339, 3, [1]]
    ];
    if (index === 0) {
      base.push(
        [33550, 12, [pixel, pixel, 0]],
        [33922, 12, [0, 0, 0, west, north, 0]],
        // Geographic coordinates (1024 = 2), pixel is area (1025 = 1), WGS 84 (2048 = 4326).
        [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]],
        [42113, 2, `${LFMC_NO_DATA}\0`]
      );
    }
    // A predictor field is written only when asked for (the publisher's rasters carry none).
    if (overrides[317]) base.push([317, 3, overrides[317]]);
    for (const [tag, values] of Object.entries(overrides)) {
      const entry = base.find((row) => row[0] === Number(tag));
      if (entry) entry[2] = values;
    }
    return base.sort((a, b) => a[0] - b[0]);
  };

  const plans = [];
  let cursor = 8;
  images.forEach((image, index) => {
    const entries = entriesFor(image, index);
    const at = cursor;
    cursor += 2 + entries.length * 12 + 4;
    const placed = entries.map(([tag, type, values]) => {
      const count = values.length;
      const bytes = count * TYPE_SIZE[type];
      let offset = null;
      if (bytes > 4) {
        offset = cursor;
        cursor += bytes + (bytes % 2);
      }
      return { tag, type, values, count, offset };
    });
    plans.push({ image, at, placed });
  });
  for (const plan of plans) {
    const offsets = plan.placed.find((entry) => entry.tag === 324);
    offsets.values = plan.image.tiles.map((bytes) => {
      const at = cursor;
      cursor += bytes.length;
      return at;
    });
    plan.tileOffsets = offsets.values;
  }

  const out = Buffer.alloc(cursor);
  out.writeUInt16LE(byteOrder, 0);
  out.writeUInt16LE(magic, 2);
  out.writeUInt32LE(plans[0].at, 4);
  const writeValues = (type, values, at) => {
    if (type === 2) {
      out.write(values, at, 'latin1');
      return;
    }
    values.forEach((value, i) => {
      if (type === 3) out.writeUInt16LE(value, at + i * 2);
      else if (type === 4) out.writeUInt32LE(value, at + i * 4);
      else out.writeDoubleLE(value, at + i * 8);
    });
  };
  plans.forEach((plan, index) => {
    out.writeUInt16LE(plan.placed.length, plan.at);
    plan.placed.forEach((entry, i) => {
      const at = plan.at + 2 + i * 12;
      out.writeUInt16LE(entry.tag, at);
      out.writeUInt16LE(entry.type, at + 2);
      out.writeUInt32LE(entry.count, at + 4);
      if (entry.offset === null) writeValues(entry.type, entry.values, at + 8);
      else {
        out.writeUInt32LE(entry.offset, at + 8);
        writeValues(entry.type, entry.values, entry.offset);
      }
    });
    out.writeUInt32LE(plans[index + 1]?.at ?? 0, plan.at + 2 + plan.placed.length * 12);
    plan.image.tiles.forEach((bytes, i) => bytes.copy(out, plan.tileOffsets[i]));
  });
  return out;
}

/** One row of the publisher's list, in the publisher's own shape. */
export function lfmcListRow(start, endExclusive, validPixels = 100, name = `viirs_${start.replaceAll('-', '')}_test_uint16-nearest-v1.tif`) {
  return {
    start,
    end_exclusive: endExclusive,
    model_version: 'v01',
    raster: `cogs/${start.slice(0, 4)}/${start.slice(5, 7)}/${name}`,
    encoding: 'uint16-nearest-v1',
    stats: { valid_pixels: validPixels }
  };
}

/** The publisher's list. */
export function lfmcList(rows) {
  return { schema: 'eosial-lfmc-v1', region: 'Western USA', composites: rows };
}

/**
 * A fetch stand-in for one host folder: `files` maps a path under the folder
 * to JSON (an object) or bytes (a Buffer). Bytes answer `Range` with 206 and
 * the exact slice, as the publisher's host does; a request with no `Range`
 * gets the whole file with 200. `log` receives each `[path, range]`.
 */
export function lfmcFetch(base, files, log = []) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(base)) return new Response('not found', { status: 404 });
    const path = url.slice(base.length);
    const file = files[path];
    const range = new Headers(init.headers ?? {}).get('range');
    log.push([path, range]);
    if (file === undefined) return new Response('not found', { status: 404 });
    if (!Buffer.isBuffer(file)) return Response.json(file);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!match) return new Response(file, { status: 200 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    if (start >= file.length) return new Response('', { status: 416 });
    return new Response(file.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${file.length}` }
    });
  };
}
