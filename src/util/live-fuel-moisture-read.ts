/**
 * Reading the published live fuel moisture maps: the publisher's list, one
 * raster's header and tiles (kept briefly so a second tile or a nearby place
 * costs nothing), the values inside an area, and the pixels of one map tile.
 * No map, no panel and no wording here; src/layers/live-fuel-moisture.ts draws
 * with it and src/impact/live-fuel-moisture.ts writes the briefing from it.
 * The source, its terms and every limit are in src/config/live-fuel-moisture.ts.
 */

import type { Geometry } from 'geojson';

import {
  LFMC_BRIEFING,
  LFMC_GROUND_CLASSES,
  LFMC_ISSUER_STOPS,
  LFMC_LAYER_MIN_COVERAGE,
  LFMC_LIMITS,
  LFMC_MANIFEST_SCHEMA,
  LFMC_MANIFEST_TTL_MS,
  LFMC_RASTER_ENCODING,
  LIVE_FUEL_MOISTURE_URLS
} from '../config/live-fuel-moisture';
import { ExpiringLruCache } from './bounded-cache';
import { cogBounds, cogLevelFor, cogLevelPixelSize, openCog, readCogTile, type CogGrid } from './cog';
import { fetchJsonWithBudget } from './fetch';
import { pointInPolygonGeometry } from './point-in-polygon';

/** One published eight-day map. */
export interface LfmcComposite {
  /** First day, and the day after the last, as `YYYY-MM-DD`. */
  readonly start: string;
  readonly endExclusive: string;
  readonly modelVersion: string;
  /** The raster's full address, always under the list's own folder. */
  readonly url: string;
  /** Cells carrying a value, as the publisher counts them; null when the list does not say. */
  readonly validCells: number | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RASTER_PATH = /^cogs\/\d{4}\/\d{2}\/[A-Za-z0-9_.-]+\.tif$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Check the publisher's list and return its maps oldest first. A list of the
 * wrong schema, or one holding no usable map, throws; a single malformed row
 * is skipped so one bad entry cannot take the layer down. A raster address
 * that would leave the list's own folder is never followed.
 */
export function parseLfmcManifest(json: unknown, manifestUrl: string): LfmcComposite[] {
  if (!isRecord(json) || json['schema'] !== LFMC_MANIFEST_SCHEMA || !Array.isArray(json['composites'])) {
    throw new Error('Unrecognized live fuel moisture list');
  }
  const base = new URL('.', manifestUrl);
  const out: LfmcComposite[] = [];
  for (const row of json['composites'].slice(0, LFMC_LIMITS.maxComposites)) {
    if (!isRecord(row) || row['encoding'] !== LFMC_RASTER_ENCODING) continue;
    const { start, end_exclusive: end, raster, model_version: version, stats } = row;
    if (typeof start !== 'string' || typeof end !== 'string' || !ISO_DAY.test(start) || !ISO_DAY.test(end) ||
        !(Date.parse(end) > Date.parse(start)) || typeof raster !== 'string' || !RASTER_PATH.test(raster)) continue;
    const url = new URL(raster, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
    const valid = isRecord(stats) ? stats['valid_pixels'] : undefined;
    out.push({
      start,
      endExclusive: end,
      modelVersion: typeof version === 'string' ? version : '',
      url: url.href,
      validCells: typeof valid === 'number' && Number.isFinite(valid) && valid >= 0 ? valid : null
    });
  }
  if (out.length === 0) throw new Error('The live fuel moisture list holds no usable map');
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * The map the layer draws: the newest one with at least `LFMC_LAYER_MIN_COVERAGE`
 * of the fullest map's cells (see that constant for why), or simply the newest
 * when the list gives no counts.
 */
export function chooseLayerComposite(composites: readonly LfmcComposite[]): LfmcComposite {
  const fullest = Math.max(0, ...composites.map((c) => c.validCells ?? 0));
  for (let i = composites.length - 1; i >= 0; i -= 1) {
    const cells = composites[i]!.validCells;
    if (fullest === 0 || cells === null || cells >= fullest * LFMC_LAYER_MIN_COVERAGE) return composites[i]!;
  }
  return composites[composites.length - 1]!;
}

/** Finished reads, kept for a while, and the reads still in flight (dropped the moment they settle). */
interface Kept<T> {
  readonly done: ExpiringLruCache<string, T>;
  readonly pending: Map<string, Promise<T>>;
}
const DAY_MS = 86_400_000;
const dayText = (time: number, withYear: boolean): string =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(new Date(time));

/**
 * The days a map (or a run of maps) covers, for a person: "Oct 16 to 23, 2026",
 * "Sep 30 to Oct 7, 2026", or "Dec 27, 2026 to Jan 3, 2027". `endExclusive` is
 * the day after the last day, as the publisher's list gives it.
 */
export function lfmcDateSpan(start: string, endExclusive: string): string {
  const first = Date.parse(start);
  const last = Date.parse(endExclusive) - DAY_MS;
  const a = new Date(first);
  const b = new Date(last);
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${dayText(first, true)} to ${dayText(last, true)}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) return `${dayText(first, false)} to ${dayText(last, true)}`;
  return `${dayText(first, false)} to ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}

const manifests = new ExpiringLruCache<string, readonly LfmcComposite[]>(1);
const grids: Kept<CogGrid> = { done: new ExpiringLruCache(32), pending: new Map() };
// A decoded tile is 131 KB; 64 of them is 8.4 MB at most.
const tiles: Kept<Uint16Array> = { done: new ExpiringLruCache(64), pending: new Map() };

/** Forget everything kept (tests, and a reader that wants a fresh list). */
export function clearLfmcCaches(): void {
  manifests.clear();
  for (const kept of [grids, tiles]) {
    kept.done.clear();
    kept.pending.clear();
  }
}

/** The publisher's list, read at most once every thirty minutes. */
export async function readLfmcComposites(signal: AbortSignal | null): Promise<readonly LfmcComposite[]> {
  const url = LIVE_FUEL_MOISTURE_URLS.lfmcManifest;
  const kept = manifests.get(url);
  if (kept) return kept;
  const json = await fetchJsonWithBudget(url, { cache: 'no-cache' }, signal, LFMC_LIMITS.timeoutMs, LFMC_LIMITS.manifestBytes);
  const composites = parseLfmcManifest(json, url);
  manifests.set(url, composites, LFMC_MANIFEST_TTL_MS);
  return composites;
}

/**
 * A shared read: askers for the same thing wait on one request, a finished
 * value is kept for thirty minutes, and a failure is kept for no time at all,
 * so the next asker reads again. The request belongs to no single asker (a
 * cancelled map tile must not fail the tile beside it); it is small and ends
 * on its own timeout.
 */
function shared<T>(kept: Kept<T>, key: string, start: () => Promise<T>): Promise<T> {
  const done = kept.done.get(key);
  if (done !== undefined) return Promise.resolve(done);
  const running = kept.pending.get(key);
  if (running) return running;
  const work = start().then((value) => {
    kept.done.set(key, value, LFMC_MANIFEST_TTL_MS);
    return value;
  });
  kept.pending.set(key, work);
  const forget = (): void => {
    if (kept.pending.get(key) === work) kept.pending.delete(key);
  };
  work.then(forget, forget);
  return work;
}

/** Wait for shared work, but stop waiting (without stopping the work) when this asker cancels. */
function waitFor<T>(work: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** One raster's grid. The request is not tied to one asker, so a cancelled tile does not fail its neighbours. */
export function lfmcGrid(url: string, signal: AbortSignal | null): Promise<CogGrid> {
  return waitFor(shared(grids, url, () => openCog(url, null, LFMC_LIMITS.cog)), signal);
}

function lfmcTile(url: string, grid: CogGrid, level: number, col: number, row: number, signal: AbortSignal | null): Promise<Uint16Array> {
  return waitFor(
    shared(tiles, `${url}#${level}/${col}/${row}`, () => readCogTile(url, grid, level, col, row, null, LFMC_LIMITS.cog)),
    signal
  );
}

/** A rectangle of one level's pixels, read through the tile cache. `get` returns the value or the no-data value. */
async function readWindow(
  url: string,
  grid: CogGrid,
  levelIndex: number,
  colMin: number,
  rowMin: number,
  colMax: number,
  rowMax: number,
  signal: AbortSignal | null
): Promise<(col: number, row: number) => number> {
  const level = grid.levels[levelIndex]!;
  const { tileWidth, tileHeight } = level;
  const tcMin = Math.floor(colMin / tileWidth);
  const trMin = Math.floor(rowMin / tileHeight);
  const tcMax = Math.floor(colMax / tileWidth);
  const trMax = Math.floor(rowMax / tileHeight);
  const across = tcMax - tcMin + 1;
  const reads: Promise<Uint16Array>[] = [];
  for (let tr = trMin; tr <= trMax; tr += 1) {
    for (let tc = tcMin; tc <= tcMax; tc += 1) reads.push(lfmcTile(url, grid, levelIndex, tc, tr, signal));
  }
  const data = await Promise.all(reads);
  const empty = grid.noData ?? 65535;
  return (col, row) => {
    if (col < colMin || col > colMax || row < rowMin || row > rowMax) return empty;
    const tile = data[(Math.floor(row / tileHeight) - trMin) * across + (Math.floor(col / tileWidth) - tcMin)]!;
    return tile[(row % tileHeight) * tileWidth + (col % tileWidth)]!;
  };
}

/** What the cells inside an area say. Quartiles are of the cells that carry a value. */
export interface LfmcAreaReading {
  readonly median: number;
  readonly q25: number;
  readonly q75: number;
  /** Cells whose centre lies inside the area, and how many of them carry a value. */
  readonly cells: number;
  readonly cellsWithValue: number;
  /** The width of one cell read, in kilometres, at the area's latitude (coarser for a large area). */
  readonly cellKm: number;
}

/** A quantile of ascending values, between the two nearest ranks, rounded to a whole percent like the source. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low));
}

/**
 * The box read for a place: its own outline's box, or a square about ten
 * kilometres across centred on a point that has no outline.
 */
export function lfmcBoxFor(
  lngLat: { readonly lng: number; readonly lat: number },
  bbox: readonly [number, number, number, number] | undefined
): readonly [number, number, number, number] {
  if (bbox && bbox[0] < bbox[2] && bbox[1] < bbox[3]) return bbox;
  const halfLat = LFMC_BRIEFING.pointHalfWidthKm / 111.32;
  const halfLon = halfLat / Math.max(0.2, Math.cos((lngLat.lat * Math.PI) / 180));
  return [lngLat.lng - halfLon, lngLat.lat - halfLat, lngLat.lng + halfLon, lngLat.lat + halfLat];
}

/**
 * Read one map's cells inside `box` (and inside `outline`, when the place has
 * one) and summarize them. Returns null when the box misses the map entirely;
 * a reading with `cellsWithValue` of 0 means the map covers the place but holds
 * no value there. A large area is read from a coarser copy of the map, whose
 * cells are every second, fourth or eighth cell of the original (the publisher
 * builds the copies by nearest neighbour), so the summary is of a regular
 * sample and at most four raster tiles are read.
 */
export async function readLfmcArea(
  url: string,
  box: readonly [number, number, number, number],
  outline: Geometry | null | undefined,
  signal: AbortSignal | null
): Promise<LfmcAreaReading | null> {
  const grid = await lfmcGrid(url, signal);
  const [gw, gs, ge, gn] = cogBounds(grid);
  const west = Math.max(box[0], gw);
  const south = Math.max(box[1], gs);
  const east = Math.min(box[2], ge);
  const north = Math.min(box[3], gn);
  if (west >= east || south >= north) return null;

  // The finest copy of the map on which the box is at most `windowPixels` across
  // (so it touches at most two tiles each way); the coarsest copy always fits.
  const span = LFMC_BRIEFING.windowPixels;
  let levelIndex = grid.levels.length - 1;
  for (let i = 0; i < grid.levels.length; i += 1) {
    const [lx, ly] = cogLevelPixelSize(grid, i);
    if ((east - west) / lx <= span && (north - south) / ly <= span) {
      levelIndex = i;
      break;
    }
  }
  const level = grid.levels[levelIndex]!;
  const [dx, dy] = cogLevelPixelSize(grid, levelIndex);
  const clamp = (n: number, max: number): number => Math.min(max, Math.max(0, n));
  const colMin = clamp(Math.floor((west - grid.west) / dx), level.width - 1);
  const colMax = clamp(Math.ceil((east - grid.west) / dx) - 1, level.width - 1);
  const rowMin = clamp(Math.floor((grid.north - north) / dy), level.height - 1);
  const rowMax = clamp(Math.ceil((grid.north - south) / dy) - 1, level.height - 1);

  const get = await readWindow(url, grid, levelIndex, colMin, rowMin, colMax, rowMax, signal);
  const polygon = outline && (outline.type === 'Polygon' || outline.type === 'MultiPolygon') ? outline : null;
  let values: number[] = [];
  let cells = 0;
  const collect = (inside: Geometry | null): void => {
    values = [];
    cells = 0;
    for (let row = rowMin; row <= rowMax; row += 1) {
      const lat = grid.north - (row + 0.5) * dy;
      for (let col = colMin; col <= colMax; col += 1) {
        const lon = grid.west + (col + 0.5) * dx;
        if (lon < west || lon > east || lat < south || lat > north) continue;
        if (inside && !pointInPolygonGeometry(lon, lat, inside)) continue;
        cells += 1;
        const value = get(col, row);
        if (value !== grid.noData) values.push(value);
      }
    }
  };
  collect(polygon);
  // An outline smaller than one cell holds no cell centre: read its box instead.
  if (polygon && cells === 0) collect(null);
  values.sort((a, b) => a - b);
  const cellKm = dx * 111.32 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  if (values.length === 0) return { median: Number.NaN, q25: Number.NaN, q75: Number.NaN, cells, cellsWithValue: 0, cellKm };
  return {
    median: quantile(values, 0.5),
    q25: quantile(values, 0.25),
    q75: quantile(values, 0.75),
    cells,
    cellsWithValue: values.length,
    cellKm
  };
}

/** How one map tile is coloured: the white 3D ground, or the publisher's own colours. */
export type LfmcTileStyle = 'ground' | 'issuer';

// One colour per whole-percent value from 0 to 250 (anything higher uses the
// last), built once per style. Each entry is the four bytes red, green, blue,
// alpha as they sit in an RGBA pixel on a little-endian machine, which every
// platform this app runs on is.
const LOOKUP_TOP = 250;
const lookups: Partial<Record<LfmcTileStyle, Uint32Array>> = {};
function lookup(style: LfmcTileStyle): Uint32Array {
  const kept = lookups[style];
  if (kept) return kept;
  const table = new Uint32Array(LOOKUP_TOP + 1);
  const pack = (r: number, g: number, b: number, a: number): number => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const stops = LFMC_ISSUER_STOPS;
  for (let value = 0; value <= LOOKUP_TOP; value += 1) {
    if (style === 'ground') {
      const alpha = LFMC_GROUND_CLASSES.find((row) => value <= row.upTo)!.alpha;
      table[value] = pack(255, 255, 255, Math.round(alpha * 255));
      continue;
    }
    // The stop at or above the value and the one below it; a value outside the scale takes the end colour.
    const found = stops.findIndex(([at]) => value <= at);
    const right = found === -1 ? stops.length - 1 : found;
    const left = found <= 0 ? right : right - 1;
    const [v0, c0] = stops[left]!;
    const [v1, c1] = stops[right]!;
    const weight = v1 === v0 ? 0 : (value - v0) / (v1 - v0);
    const channel = (shift: number): number => {
      const a = (Number.parseInt(c0.slice(1), 16) >> shift) & 255;
      const b = (Number.parseInt(c1.slice(1), 16) >> shift) & 255;
      return Math.round(a + (b - a) * weight);
    };
    table[value] = pack(channel(16), channel(8), channel(0), 255);
  }
  lookups[style] = table;
  return table;
}

/** The colour a value is drawn in, as `[red, green, blue, alpha]` (0 to 255). */
export function lfmcColor(value: number, style: LfmcTileStyle): readonly [number, number, number, number] {
  const packed = lookup(style)[Math.min(LOOKUP_TOP, Math.max(0, Math.round(value)))]!;
  return [packed & 255, (packed >> 8) & 255, (packed >> 16) & 255, packed >>> 24];
}

const mercatorLat = (y: number, z: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * The RGBA pixels of one Web Mercator map tile (`size` pixels square), or null
 * when the tile lies wholly outside the map's area. Each output pixel takes
 * the value of the raster cell under its centre (nearest neighbour, as the
 * publisher's own viewer draws it); a cell with no value stays transparent.
 */
export async function renderLfmcTile(
  url: string,
  z: number,
  x: number,
  y: number,
  size: number,
  style: LfmcTileStyle,
  signal: AbortSignal | null
): Promise<Uint8ClampedArray<ArrayBuffer> | null> {
  const grid = await lfmcGrid(url, signal);
  const [gw, gs, ge, gn] = cogBounds(grid);
  const step = 360 / 2 ** z;
  const tileWest = x * step - 180;
  const tileNorth = mercatorLat(y, z);
  const tileSouth = mercatorLat(y + 1, z);
  if (tileWest >= ge || tileWest + step <= gw || tileSouth >= gn || tileNorth <= gs) return null;

  const levelIndex = cogLevelFor(grid, step / size, (tileNorth - tileSouth) / size);
  const level = grid.levels[levelIndex]!;
  const [dx, dy] = cogLevelPixelSize(grid, levelIndex);
  const clamp = (n: number, max: number): number => Math.min(max, Math.max(0, n));
  const colMin = clamp(Math.floor((Math.max(tileWest, gw) - grid.west) / dx), level.width - 1);
  const colMax = clamp(Math.floor((Math.min(tileWest + step, ge) - grid.west) / dx), level.width - 1);
  const rowMin = clamp(Math.floor((grid.north - Math.min(tileNorth, gn)) / dy), level.height - 1);
  const rowMax = clamp(Math.floor((grid.north - Math.max(tileSouth, gs)) / dy), level.height - 1);
  const get = await readWindow(url, grid, levelIndex, colMin, rowMin, colMax, rowMax, signal);

  const colors = lookup(style);
  const out = new Uint32Array(size * size);
  const columns = new Int32Array(size);
  for (let i = 0; i < size; i += 1) {
    const lon = tileWest + ((i + 0.5) * step) / size;
    columns[i] = lon < gw || lon >= ge ? -1 : Math.floor((lon - grid.west) / dx);
  }
  for (let j = 0; j < size; j += 1) {
    const lat = mercatorLat(y + (j + 0.5) / size, z);
    if (lat > gn || lat <= gs) continue;
    const row = Math.floor((grid.north - lat) / dy);
    for (let i = 0; i < size; i += 1) {
      const col = columns[i]!;
      if (col < 0) continue;
      const value = get(col, row);
      if (value !== grid.noData) out[j * size + i] = colors[Math.min(LOOKUP_TOP, value)]!;
    }
  }
  return new Uint8ClampedArray(out.buffer);
}
