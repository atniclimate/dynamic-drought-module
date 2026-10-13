/**
 * The committed NOAA RTOFS surface-current frame (admission
 * rtofs-currents-producer; DR-116), read same-origin and never from NOMADS.
 *
 * scripts/build-rtofs-currents.mjs writes it at a landing: one JSON header
 * (run, valid instant, grids, scale) and, per grid, one gzip file of Int16
 * little-endian values, all u (east) then all v (north), rows north to
 * south, in steps of `scale` m/s, -32768 where the issuer's bitmap masks the
 * node (land). Each grid becomes its own FlowField on its native spacing;
 * grids are never joined or resampled, and the view draws the one under its
 * centre (`fieldNearestLatitude`).
 *
 * It is a dated model frame: the header's run and valid instant go to the
 * state line with the frame's age, and `staleAfter` is null, because the
 * frame is as old as the last landing (CONTRADICTIONS-4 Q3 a). A missing,
 * truncated or unparseable frame, or one holding a speed no ocean has,
 * throws, and the panel reads unavailable.
 */
import { BASE_URL } from '../../config/urls-boot';
import { fetchBufferedWithBudget, fetchJsonWithBudget } from '../../util/fetch';
import { isObject } from '../../util/guards';
import { createFlowField, type FlowField, type FlowGrid } from './field';

const DATA_URL = `${BASE_URL}data/`;
/** The header the producer writes; it names each grid's file beside it. */
export const CURRENTS_HEADER_FILE = 'rtofs-surface-currents.json';
export const CURRENTS_FORMAT = 'ddm-flow-frame/1';
export const CURRENTS_NO_DATA = -32768;
/**
 * A surface current component beyond this, m/s, is refused, by the producer
 * and again here. The fastest open-ocean surface currents (the Gulf Stream,
 * the Kuroshio) run at about 2.5 m/s; the fastest component in the committed
 * 2026-10-13 frame is 1.43 m/s. 5 leaves the first that much again.
 */
export const CURRENT_COMPONENT_MAX_MS = 5;
const READ_BUDGET_MS = 12_000;
const HOUR = 3_600_000;

export interface CurrentsGrid extends FlowGrid {
  /** The producer's name for the grid (the issuer's region word). */
  readonly id: string;
  /** The grid's file, beside the header. */
  readonly file: string;
}

export interface CurrentsHeader {
  /** Model run (GRIB reference time), epoch ms. */
  readonly run: number;
  readonly forecastHour: number;
  /** The one dated instant the frame is valid at, epoch ms. */
  readonly valid: number;
  /** m/s per Int16 step. */
  readonly scale: number;
  readonly level: string;
  readonly grids: readonly CurrentsGrid[];
}

const refuse = (what: string): never => {
  throw new Error(`currents frame: ${what}`);
};
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Check the header the producer wrote; anything this reader does not read is refused. */
export function parseCurrentsHeader(json: unknown): CurrentsHeader {
  if (!isObject(json) || json.format !== CURRENTS_FORMAT) return refuse('not a frame header');
  const e = json.encoding;
  if (
    json.units !== 'm s-1' || !isObject(e) || e.type !== 'int16' || e.endian !== 'little' ||
    e.layout !== 'planar-u-then-v' || e.rowOrder !== 'north-to-south' || e.noData !== CURRENTS_NO_DATA ||
    !finite(e.scale) || !(e.scale > 0)
  ) return refuse('an encoding this reader does not read');
  const run = typeof json.run === 'string' ? Date.parse(json.run) : Number.NaN;
  const valid = typeof json.valid === 'string' ? Date.parse(json.valid) : Number.NaN;
  const { forecastHour, level, grids } = json;
  if (!finite(run) || !finite(forecastHour) || valid !== run + forecastHour * HOUR) return refuse('run and valid instant disagree');
  if (typeof level !== 'string' || !Array.isArray(grids) || grids.length < 1 || grids.length > 4) return refuse('no grid list');
  return {
    run, forecastHour, valid, scale: e.scale, level,
    grids: grids.map((g: unknown): CurrentsGrid => {
      if (
        !isObject(g) || typeof g.id !== 'string' || typeof g.file !== 'string' || !/^[\w.-]+$/.test(g.file) ||
        !finite(g.lon0) || !finite(g.lat0) || !finite(g.dlon) || !finite(g.dlat) || !finite(g.nx) || !finite(g.ny)
      ) return refuse('a grid row is malformed');
      // createFlowField checks the grid's own ranges.
      return { id: g.id, file: g.file, lon0: g.lon0, lat0: g.lat0, dlon: g.dlon, dlat: g.dlat, nx: g.nx, ny: g.ny, wrapsLon: false };
    })
  };
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // A host that sends the file with Content-Encoding: gzip hands the page the Int16 bytes already.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * One FlowField per grid from the header and each grid's file bytes (gzip,
 * or already inflated), in the header's order. Masked nodes stay masked:
 * createFlowField writes NaN into them, so land is never read as still water.
 */
export async function decodeCurrentsFrame(
  header: CurrentsHeader, bodies: readonly Uint8Array<ArrayBuffer>[], sourceUrl: string = DATA_URL + CURRENTS_HEADER_FILE
): Promise<FlowField[]> {
  if (bodies.length !== header.grids.length) return refuse('a grid file is missing');
  return Promise.all(header.grids.map(async (grid, k) => {
    const { id, file, ...flowGrid } = grid;
    const raw = await inflate(bodies[k] as Uint8Array<ArrayBuffer>);
    const n = grid.nx * grid.ny;
    if (raw.byteLength !== n * 4) refuse(`${file} holds ${raw.byteLength} bytes; ${n * 4} expected`);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const read = (offset: number): number => {
      const q = view.getInt16(offset, true);
      if (q === CURRENTS_NO_DATA) return Number.NaN;
      const x = q * header.scale;
      if (Math.abs(x) > CURRENT_COMPONENT_MAX_MS) refuse(`${file} holds ${x} m/s, beyond the plausible ${CURRENT_COMPONENT_MAX_MS} m/s`);
      return x;
    };
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      u[i] = read(i * 2);
      v[i] = read((n + i) * 2);
    }
    return createFlowField({
      kind: 'currents', grid: flowGrid, u, v,
      meta: {
        issuer: 'NOAA', model: 'Global RTOFS', transport: 'same-origin-frame',
        cycle: header.run, forecastHour: header.forecastHour, validTime: header.valid,
        // A dated frame, as old as the last landing: its age is stated, never a limit.
        staleAfter: null,
        level: header.level, units: 'm s-1', sourceUrl, productKey: id
      }
    });
  }));
}

/** Read the committed frame: the header, then every grid file, each inside the 12 s complete-body budget. */
export async function readCurrentsFrame(options: { readonly signal: AbortSignal }): Promise<FlowField[]> {
  const url = DATA_URL + CURRENTS_HEADER_FILE;
  const header = parseCurrentsHeader(await fetchJsonWithBudget(url, null, options.signal, READ_BUDGET_MS, 16_384));
  const bodies = await Promise.all(header.grids.map(async (grid) => {
    // A gzip file is never longer than its Int16 bytes plus a small wrapper.
    const cap = grid.nx * grid.ny * 4 + 1_024;
    const response = await fetchBufferedWithBudget(DATA_URL + grid.file, null, options.signal, READ_BUDGET_MS, cap);
    if (!response.ok) refuse(`${grid.file} answered HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  return decodeCurrentsFrame(header, bodies, url);
}

/** The field whose rows lie nearest latitude `lat` (the first on a tie): the grid under the view's centre. */
export function fieldNearestLatitude(fields: readonly FlowField[], lat: number): FlowField {
  const away = ({ grid }: FlowField): number =>
    Math.max(0, lat - grid.lat0, grid.lat0 - (grid.ny - 1) * grid.dlat - lat);
  return fields.reduce((best, field) => (away(field) < away(best) ? field : best));
}
