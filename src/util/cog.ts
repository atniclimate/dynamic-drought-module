/**
 * A reader for one narrow kind of Cloud Optimized GeoTIFF, by HTTP byte range.
 *
 * What it reads: a classic (not Big) little-endian TIFF holding one unsigned
 * 16-bit sample per pixel, cut into tiles, each tile compressed with Deflate
 * (TIFF compression 8) and no predictor, on a longitude/latitude grid (EPSG
 * 4326) whose reduced-resolution copies follow the full-resolution image in
 * the same file. Anything else is refused with a `CogFormatError`: this is
 * not a general GeoTIFF library and does not try to be one.
 *
 * Why it exists: the live fuel moisture maps (src/config/live-fuel-moisture.ts)
 * are published in exactly this form, and a map tile or a single place needs
 * only a few kilobytes of a 2 to 13 MB file. Every read is a bounded, cancellable
 * `Range` request through the project's fetch helper, and every decoded tile
 * is checked to be exactly the size its header promised.
 *
 * Two limits to know:
 * - The server must answer `Range` with 206. A 200 carrying the whole file is
 *   stopped by the byte cap and reads as a failure.
 * - Inflating uses the browser's own `DecompressionStream`, which Safari gained
 *   in 16.4. Where it is missing the read fails and the caller reports the
 *   source as unavailable.
 */

import { fetchBufferedWithBudget } from './fetch';

/** One resolution of the image: full resolution first, then each coarser copy. */
export interface CogLevel {
  readonly width: number;
  readonly height: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** Byte position and compressed length of each tile, row by row from the top left. */
  readonly tileOffsets: readonly number[];
  readonly tileByteCounts: readonly number[];
}

/** Where the image sits on the Earth and how to find its tiles. */
export interface CogGrid {
  readonly levels: readonly CogLevel[];
  /** The outer west and north edges of the image, in degrees. */
  readonly west: number;
  readonly north: number;
  /** Degrees per full-resolution pixel; both positive. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** The value that means "no value here", or null when the file names none. */
  readonly noData: number | null;
}

export interface CogReadLimits {
  /** Per request, in milliseconds. */
  readonly timeoutMs: number;
  /** The most header bytes ever requested for one file. */
  readonly maxHeaderBytes: number;
  /** The most compressed bytes accepted for one tile. */
  readonly maxTileBytes: number;
}

/** The file is not the kind of GeoTIFF this reader accepts, or it is damaged. */
export class CogFormatError extends Error {
  override name = 'CogFormatError';
}

/** The server did not answer a byte-range request the way a range read needs. */
export class CogTransportError extends Error {
  override name = 'CogTransportError';
}

const TAG = {
  newSubfileType: 254,
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  geoKeyDirectory: 34735,
  gdalNoData: 42113
} as const;

/** Bytes per value for the TIFF field types this reader understands. */
const TYPE_SIZE: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

const MAX_LEVELS = 16;
const MAX_TILES_PER_LEVEL = 65_536;
const MAX_TILE_EDGE = 1024;
/** The first header request. The live fuel moisture rasters' headers end near byte 7,500. */
const HEADER_FIRST_READ = 8_192;

interface RawDirectory {
  readonly fields: Map<number, readonly number[] | string>;
  readonly next: number;
}

/**
 * Read the image description from the first bytes of the file. Returns the
 * grid, or how many bytes are needed when `prefix` stops short of a table the
 * description points at (the caller reads that many and tries again).
 */
export function parseCogHeader(prefix: ArrayBuffer): CogGrid | { readonly needBytes: number } {
  const view = new DataView(prefix);
  if (view.byteLength < 8) return { needBytes: HEADER_FIRST_READ };
  if (view.getUint16(0, true) !== 0x4949) throw new CogFormatError('Not a little-endian TIFF');
  if (view.getUint16(2, true) !== 42) throw new CogFormatError('Not a classic TIFF');

  let need = 0;
  const want = (end: number): boolean => {
    if (end <= view.byteLength) return true;
    need = Math.max(need, end);
    return false;
  };

  const readDirectory = (at: number): RawDirectory | null => {
    if (!want(at + 2)) return null;
    const count = view.getUint16(at, true);
    const end = at + 2 + count * 12 + 4;
    if (!want(end)) return null;
    const fields = new Map<number, readonly number[] | string>();
    let complete = true;
    for (let i = 0; i < count; i += 1) {
      const entry = at + 2 + i * 12;
      const tag = view.getUint16(entry, true);
      if (!Object.values(TAG).includes(tag as (typeof TAG)[keyof typeof TAG])) continue;
      const type = view.getUint16(entry + 2, true);
      const length = view.getUint32(entry + 4, true);
      const size = TYPE_SIZE[type];
      if (size === undefined) throw new CogFormatError(`Unsupported field type ${type} for tag ${tag}`);
      if (length > 4 * MAX_TILES_PER_LEVEL) throw new CogFormatError(`Field ${tag} is too long`);
      const bytes = size * length;
      const start = bytes <= 4 ? entry + 8 : view.getUint32(entry + 8, true);
      if (!want(start + bytes)) {
        complete = false;
        continue;
      }
      if (type === 2) {
        let text = '';
        for (let k = 0; k < length; k += 1) {
          const code = view.getUint8(start + k);
          if (code !== 0) text += String.fromCharCode(code);
        }
        fields.set(tag, text);
        continue;
      }
      const values: number[] = new Array<number>(length);
      for (let k = 0; k < length; k += 1) {
        const p = start + k * size;
        values[k] = type === 1 ? view.getUint8(p)
          : type === 3 ? view.getUint16(p, true)
            : type === 4 ? view.getUint32(p, true)
              : view.getFloat64(p, true);
      }
      fields.set(tag, values);
    }
    return complete ? { fields, next: view.getUint32(end - 4, true) } : null;
  };

  const directories: RawDirectory[] = [];
  let at = view.getUint32(4, true);
  while (at !== 0) {
    if (directories.length >= MAX_LEVELS) throw new CogFormatError('Too many images in one file');
    const directory = readDirectory(at);
    if (!directory) return { needBytes: need };
    directories.push(directory);
    at = directory.next;
  }
  if (directories.length === 0) throw new CogFormatError('The file holds no image');

  const numbers = (directory: RawDirectory, tag: number): readonly number[] | undefined => {
    const value = directory.fields.get(tag);
    return typeof value === 'string' ? undefined : value;
  };
  const one = (directory: RawDirectory, tag: number, fallback?: number): number => {
    const value = numbers(directory, tag)?.[0] ?? fallback;
    if (value === undefined) throw new CogFormatError(`Missing field ${tag}`);
    return value;
  };

  const level = (directory: RawDirectory): CogLevel => {
    const width = one(directory, TAG.imageWidth);
    const height = one(directory, TAG.imageLength);
    const tileWidth = one(directory, TAG.tileWidth);
    const tileHeight = one(directory, TAG.tileLength);
    if (one(directory, TAG.bitsPerSample) !== 16 || one(directory, TAG.samplesPerPixel, 1) !== 1 ||
        one(directory, TAG.sampleFormat, 1) !== 1) {
      throw new CogFormatError('Not one unsigned 16-bit sample per pixel');
    }
    const compression = one(directory, TAG.compression, 1);
    if (compression !== 8 && compression !== 32946) throw new CogFormatError(`Unsupported compression ${compression}`);
    if (one(directory, TAG.predictor, 1) !== 1) throw new CogFormatError('Unsupported predictor');
    if (![width, height, tileWidth, tileHeight].every((n) => Number.isSafeInteger(n) && n > 0) ||
        tileWidth > MAX_TILE_EDGE || tileHeight > MAX_TILE_EDGE) {
      throw new CogFormatError('Invalid image or tile size');
    }
    const tiles = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
    const tileOffsets = numbers(directory, TAG.tileOffsets);
    const tileByteCounts = numbers(directory, TAG.tileByteCounts);
    if (tiles > MAX_TILES_PER_LEVEL || tileOffsets?.length !== tiles || tileByteCounts?.length !== tiles) {
      throw new CogFormatError('Tile tables do not match the image size');
    }
    return { width, height, tileWidth, tileHeight, tileOffsets, tileByteCounts };
  };

  const first = directories[0]!;
  const scale = numbers(first, TAG.modelPixelScale);
  const tie = numbers(first, TAG.modelTiepoint);
  if (!scale || scale.length < 2 || !tie || tie.length < 6 || tie[0] !== 0 || tie[1] !== 0) {
    throw new CogFormatError('Missing or unsupported georeferencing');
  }
  const [pixelWidth, pixelHeight] = scale as [number, number];
  const west = tie[3]!;
  const north = tie[4]!;
  if (![pixelWidth, pixelHeight, west, north].every(Number.isFinite) || pixelWidth <= 0 || pixelHeight <= 0) {
    throw new CogFormatError('Invalid georeferencing');
  }

  // GeoKeyDirectory: a header of four shorts, then four shorts per key. Key
  // 1024 says what kind of coordinates (2 is longitude/latitude), 2048 which
  // datum (4326 is WGS 84), 1025 whether a pixel is an area (1) or a point.
  const keys = numbers(first, TAG.geoKeyDirectory) ?? [];
  const geoKey = (id: number): number | undefined => {
    for (let i = 4; i + 3 < keys.length; i += 4) {
      if (keys[i] === id && keys[i + 1] === 0) return keys[i + 3];
    }
    return undefined;
  };
  if (geoKey(1024) !== 2 || geoKey(2048) !== 4326) throw new CogFormatError('Not a longitude/latitude (EPSG 4326) grid');
  if ((geoKey(1025) ?? 1) !== 1) throw new CogFormatError('Pixel-is-point rasters are not supported');

  const levels: CogLevel[] = [level(first)];
  for (const directory of directories.slice(1)) {
    // Bit 0 marks a reduced-resolution copy; bit 2 a transparency mask, which this reader does not use.
    const subfile = one(directory, TAG.newSubfileType, 0);
    if ((subfile & 1) === 0 || (subfile & 4) !== 0) continue;
    const next = level(directory);
    if (next.width >= levels[levels.length - 1]!.width) throw new CogFormatError('Overviews are not in decreasing order');
    levels.push(next);
  }

  const noDataText = first.fields.get(TAG.gdalNoData);
  const noDataValue = typeof noDataText === 'string' ? Number(noDataText.trim()) : Number.NaN;
  return {
    levels,
    west,
    north,
    pixelWidth,
    pixelHeight,
    noData: Number.isFinite(noDataValue) ? noDataValue : null
  };
}

/** The image's outer edges in degrees: west, south, east, north. */
export function cogBounds(grid: CogGrid): readonly [number, number, number, number] {
  const full = grid.levels[0]!;
  return [grid.west, grid.north - full.height * grid.pixelHeight, grid.west + full.width * grid.pixelWidth, grid.north];
}

/** Degrees per pixel at one level (a coarser copy spans the same ground with fewer pixels). */
export function cogLevelPixelSize(grid: CogGrid, levelIndex: number): readonly [number, number] {
  const full = grid.levels[0]!;
  const level = grid.levels[levelIndex]!;
  return [(grid.pixelWidth * full.width) / level.width, (grid.pixelHeight * full.height) / level.height];
}

/**
 * The coarsest level that still has at least one source pixel per requested
 * pixel, so a zoomed-out map tile reads a small overview instead of the full image.
 */
export function cogLevelFor(grid: CogGrid, degreesPerPixelX: number, degreesPerPixelY: number): number {
  let chosen = 0;
  for (let i = 1; i < grid.levels.length; i += 1) {
    const [dx, dy] = cogLevelPixelSize(grid, i);
    if (dx <= degreesPerPixelX && dy <= degreesPerPixelY) chosen = i;
    else break;
  }
  return chosen;
}

async function readRange(
  url: string,
  start: number,
  length: number,
  signal: AbortSignal | null,
  timeoutMs: number,
  exact: boolean
): Promise<ArrayBuffer> {
  const response = await fetchBufferedWithBudget(
    url,
    { headers: { Range: `bytes=${start}-${start + length - 1}` } },
    signal,
    timeoutMs,
    length
  );
  if (response.status !== 206) throw new CogTransportError(`Range read answered HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (exact ? bytes.byteLength !== length : bytes.byteLength === 0) {
    throw new CogTransportError('Range read returned the wrong number of bytes');
  }
  return bytes;
}

/** Read and check the image description: one request for a file laid out the usual way. */
export async function openCog(url: string, signal: AbortSignal | null, limits: CogReadLimits): Promise<CogGrid> {
  let length = Math.min(HEADER_FIRST_READ, limits.maxHeaderBytes);
  // Three rounds: the first read, one for a table past it, one for a second image's table.
  for (let round = 0; round < 3; round += 1) {
    const prefix = await readRange(url, 0, length, signal, limits.timeoutMs, false);
    const parsed = parseCogHeader(prefix);
    if ('levels' in parsed) return parsed;
    // The file ended before the table it points at: nothing more to ask for.
    if (prefix.byteLength < length) throw new CogFormatError('The file ends inside its own header');
    if (parsed.needBytes > limits.maxHeaderBytes) throw new CogFormatError('The header is larger than the read limit');
    length = Math.min(limits.maxHeaderBytes, Math.max(parsed.needBytes, length * 2));
  }
  throw new CogFormatError('The header could not be read in three requests');
}

/** Inflate a zlib stream to exactly `expected` bytes, refusing anything longer or shorter. */
async function inflateExactly(compressed: ArrayBuffer, expected: number, signal: AbortSignal | null): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new CogTransportError('This browser cannot inflate raster tiles');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let filled = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = await reader.read();
      if (chunk.done) break;
      if (filled + chunk.value.byteLength > expected) throw new CogFormatError('A tile inflated past its declared size');
      out.set(chunk.value, filled);
      filled += chunk.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    // A damaged stream surfaces as a TypeError from the browser; say what it means.
    if (error instanceof TypeError) throw new CogFormatError('A tile could not be inflated');
    throw error;
  }
  if (filled !== expected) throw new CogFormatError('A tile inflated short of its declared size');
  return out;
}

/**
 * One tile's values, row by row. A tile the file stores as empty (length 0,
 * which GDAL writes for a tile that is all "no value") comes back filled with
 * the no-data value, with no request made.
 */
export async function readCogTile(
  url: string,
  grid: CogGrid,
  levelIndex: number,
  tileCol: number,
  tileRow: number,
  signal: AbortSignal | null,
  limits: CogReadLimits
): Promise<Uint16Array> {
  const level = grid.levels[levelIndex];
  if (!level) throw new RangeError('No such level');
  const across = Math.ceil(level.width / level.tileWidth);
  const down = Math.ceil(level.height / level.tileHeight);
  if (!Number.isSafeInteger(tileCol) || !Number.isSafeInteger(tileRow) ||
      tileCol < 0 || tileRow < 0 || tileCol >= across || tileRow >= down) throw new RangeError('No such tile');
  const index = tileRow * across + tileCol;
  const offset = level.tileOffsets[index]!;
  const count = level.tileByteCounts[index]!;
  const pixels = level.tileWidth * level.tileHeight;
  if (count === 0) {
    if (grid.noData === null) throw new CogFormatError('An empty tile in a file that names no no-data value');
    return new Uint16Array(pixels).fill(grid.noData);
  }
  if (count > limits.maxTileBytes) throw new CogFormatError('A tile is larger than the read limit');
  const compressed = await readRange(url, offset, count, signal, limits.timeoutMs, true);
  const bytes = await inflateExactly(compressed, pixels * 2, signal);
  // The file is little-endian. Every platform this app runs on is too, so the
  // bytes can be viewed in place; a big-endian host would need a byte swap here.
  return new Uint16Array(bytes.buffer, bytes.byteOffset, pixels);
}

/** Which pixel of a level holds a longitude/latitude, or null when the place is outside the image. */
export function cogPixelAt(
  grid: CogGrid,
  levelIndex: number,
  lon: number,
  lat: number
): { readonly col: number; readonly row: number } | null {
  const level = grid.levels[levelIndex];
  if (!level || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const [dx, dy] = cogLevelPixelSize(grid, levelIndex);
  const col = Math.floor((lon - grid.west) / dx);
  const row = Math.floor((grid.north - lat) / dy);
  return col < 0 || row < 0 || col >= level.width || row >= level.height ? null : { col, row };
}

/**
 * The full-resolution value at one place: a number, or null when the place is
 * outside the image or the pixel holds the no-data value. Two requests at most
 * (none for the header when the caller already holds the grid).
 */
export async function readCogPoint(
  url: string,
  grid: CogGrid,
  lon: number,
  lat: number,
  signal: AbortSignal | null,
  limits: CogReadLimits
): Promise<number | null> {
  const pixel = cogPixelAt(grid, 0, lon, lat);
  if (!pixel) return null;
  const level = grid.levels[0]!;
  const tile = await readCogTile(
    url, grid, 0, Math.floor(pixel.col / level.tileWidth), Math.floor(pixel.row / level.tileHeight), signal, limits
  );
  const value = tile[(pixel.row % level.tileHeight) * level.tileWidth + (pixel.col % level.tileWidth)]!;
  return value === grid.noData ? null : value;
}
