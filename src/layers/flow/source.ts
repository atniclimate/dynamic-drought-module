/**
 * The kind-to-product table of the ENSO flow paths (ENSO-FLOW-PLAN section 3,
 * block E1 unit E1-2; admission gfs-runtime-nodd lines 1, 7, 14 and 15).
 *
 * - Wind: NOAA GFS `pgrb2.1p00`, UGRD and VGRD at `10 m above ground`; grid
 *   3.0, 360 x 181, 1.0 degree, DRT 5.3, no bitmap. Not cropped: the global
 *   grid covers the whole United States (DR-116 coverage).
 * - Waves: NOAA GFS-Wave `global.0p25`, DIRPW and HTSGW at `surface`; grid
 *   3.0, 1440 x 721, 0.25 degree, DRT 5.40 with a bitmap. Cropped to 10 S to
 *   62 N and 165 E to 100 W, across the antimeridian (0.25 degree columns 660
 *   to 1040, 381 x 289 nodes), which holds every Pacific coast from Baja to
 *   the Aleutians and Hawaii (DR-116 coverage; plan section 2.3, critic C1).
 *   PERPW, the 0p50 wind and the regional wave grids are not read (owner
 *   question 9, Q15): adding one later is a row here.
 *
 * Direction (A-direction.md, CONFIRMED-FROM; admission line 15). GFS 10 m
 * UGRD/VGRD are earth-relative and point the way the air moves (TO); they
 * pass through unchanged. GFS-Wave DIRPW is in degrees true, clockwise from
 * north, and gives the direction the waves come FROM, so they travel toward
 * (DIRPW + 180) mod 360. THIS MODULE IS THE ONE PLACE THAT ROTATES
 * (`waveToVector`, called by the decode Worker); `field.ts` never does. The
 * travel bearing is shipped as its east/north unit vector (-sin DIRPW,
 * -cos DIRPW), so the sampler blends components, never angles.
 *
 * Clocks: run = the model cycle; valid time = cycle + forecast hour (a dated
 * instant, never "now"); staleAfter = cycle + 24 h, after which the frame is
 * refused. Nothing here publishes a derived number (owner question 10).
 */

import type { GribParameter } from './grib2';
import { createFlowField, type FlowField, type FlowGrid, type FlowKind, type FlowMeta } from './field';

const HOUR = 3_600_000;

/** The NODD bucket, virtual-hosted: the only form the reader requests. */
export const NODD_ORIGIN = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';

/** A frame is refused once its cycle is more than this old. */
export const FRAME_LIFETIME_MS = 24 * HOUR;

/** One GRIB2 message: its `.idx` VAR and LEVEL words and its GRIB parameter. */
export interface FlowMessage {
  readonly variable: string;
  readonly level: string;
  readonly parameter: GribParameter;
}

/** A crop of the source grid, in source columns and rows (columns wrap). */
export interface FlowCrop {
  readonly column0: number;
  readonly row0: number;
  readonly nx: number;
  readonly ny: number;
}

export interface FlowSource {
  readonly kind: FlowKind;
  /** Issuer and model words, verbatim. */
  readonly issuer: string;
  readonly model: string;
  readonly level: string;
  /** Units of the FlowField magnitude. */
  readonly units: string;
  /** Hours between published forecast hours. */
  readonly cadenceHours: number;
  /** Byte cap of the `.idx` read. */
  readonly idxMaxBytes: number;
  /** The source grid every message must carry (template 3.0). */
  readonly grid: { readonly ni: number; readonly nj: number; readonly la1: number; readonly lo1: number; readonly la2: number; readonly lo2: number; readonly di: number; readonly dj: number };
  readonly surface: { readonly type: number; readonly value: number };
  readonly packing: 3 | 40;
  readonly bitmap: boolean;
  /** Messages in the order the Worker receives them. */
  readonly messages: readonly FlowMessage[];
  /** The crop, or null for the whole grid. */
  readonly crop: FlowCrop | null;
  /** Int16 quantization steps for the transfer: the vector components and the magnitude. */
  readonly step: { readonly uv: number; readonly m: number };
  /** Object key of the GRIB2 file for a cycle and forecast hour. */
  key(cycle: number, forecastHour: number): string;
}

function stamp(cycle: number): { day: string; hh: string } {
  const iso = new Date(cycle).toISOString();
  return { day: iso.slice(0, 10).replaceAll('-', ''), hh: iso.slice(11, 13) };
}

const fff = (fh: number): string => String(fh).padStart(3, '0');

export const FLOW_SOURCES: Readonly<Record<FlowKind, FlowSource>> = {
  wind: {
    kind: 'wind',
    issuer: 'NOAA',
    model: 'GFS',
    level: '10 m above ground',
    units: 'm s-1',
    cadenceHours: 3,
    idxMaxBytes: 65_536,
    grid: { ni: 360, nj: 181, la1: 90, lo1: 0, la2: -90, lo2: 359, di: 1, dj: 1 },
    surface: { type: 103, value: 10 },
    packing: 3,
    bitmap: false,
    messages: [
      { variable: 'UGRD', level: '10 m above ground', parameter: { discipline: 0, category: 2, number: 2 } },
      { variable: 'VGRD', level: '10 m above ground', parameter: { discipline: 0, category: 2, number: 3 } }
    ],
    crop: null,
    step: { uv: 0.01, m: 0.01 },
    key(cycle, fh) {
      const { day, hh } = stamp(cycle);
      return `gfs.${day}/${hh}/atmos/gfs.t${hh}z.pgrb2.1p00.f${fff(fh)}`;
    }
  },
  waves: {
    kind: 'waves',
    issuer: 'NOAA',
    model: 'GFS-Wave',
    level: 'surface',
    units: 'm',
    cadenceHours: 1,
    idxMaxBytes: 4_096,
    // The committed NOAA messages encode this endpoint; node spacing is 0.25.
    grid: { ni: 1440, nj: 721, la1: 90, lo1: 0, la2: -90, lo2: 359.750016, di: 0.25, dj: 0.25 },
    surface: { type: 1, value: 1 },
    packing: 40,
    bitmap: true,
    messages: [
      { variable: 'DIRPW', level: 'surface', parameter: { discipline: 10, category: 0, number: 10 } },
      { variable: 'HTSGW', level: 'surface', parameter: { discipline: 10, category: 0, number: 3 } }
    ],
    // 165 E (column 660) to 100 W (260 E, column 1040); 62 N (row 112) to 10 S (row 400).
    crop: { column0: 660, row0: 112, nx: 381, ny: 289 },
    step: { uv: 1e-4, m: 1e-3 },
    key(cycle, fh) {
      const { day, hh } = stamp(cycle);
      return `gfs.${day}/${hh}/wave/gridded/gfswave.t${hh}z.global.0p25.f${fff(fh)}.grib2`;
    }
  }
};

/**
 * The one FROM-to-TO rotation: a GFS-Wave direction in degrees true that the
 * waves come FROM, as the east/north unit vector of the bearing they travel
 * TOWARD, (dir + 180) mod 360. DIRPW 270 (from the west) gives (1, 0), east.
 */
export function waveToVector(dirFromDegrees: number): [number, number] {
  const r = (dirFromDegrees * Math.PI) / 180;
  return [-Math.sin(r), -Math.cos(r)];
}

/** The FlowField grid of a kind after its crop. */
export function frameGrid(kind: FlowKind): FlowGrid {
  const s = FLOW_SOURCES[kind];
  const c = s.crop ?? { column0: 0, row0: 0, nx: s.grid.ni, ny: s.grid.nj };
  return {
    lon0: s.grid.lo1 + c.column0 * s.grid.di,
    lat0: s.grid.la1 - c.row0 * s.grid.dj,
    dlon: s.grid.di,
    dlat: s.grid.dj,
    nx: c.nx,
    ny: c.ny,
    wrapsLon: s.crop === null
  };
}

/** The frame's clocks and issuer words: run, valid time and staleAfter. */
export function frameMeta(kind: FlowKind, cycle: number, forecastHour: number): FlowMeta {
  const s = FLOW_SOURCES[kind];
  const key = s.key(cycle, forecastHour);
  return {
    issuer: s.issuer,
    model: s.model,
    transport: 'nodd-range',
    cycle,
    forecastHour,
    validTime: cycle + forecastHour * HOUR,
    staleAfter: cycle + FRAME_LIFETIME_MS,
    level: s.level,
    units: s.units,
    sourceUrl: `${NODD_ORIGIN}/${key}`,
    productKey: key
  };
}

/** Int16 marker of a node with no value. */
export const PACKET_NO_VALUE = -32768;

/**
 * What the decode Worker transfers back: the cropped grid as Int16 steps
 * (`step` from the source row), with a byte mask. Waves carry the TO unit
 * vector and the significant height; wind carries u and v only.
 */
export interface FlowPacket {
  readonly kind: FlowKind;
  readonly cycle: number;
  readonly forecastHour: number;
  readonly u: Int16Array;
  readonly v: Int16Array;
  readonly m: Int16Array | null;
  readonly mask: Uint8Array;
}

/** The request posted to the decode Worker: one buffer per source message, in order. */
export interface DecodeRequest {
  readonly kind: FlowKind;
  readonly cycle: number;
  readonly forecastHour: number;
  readonly messages: readonly ArrayBuffer[];
}

export type DecodeReply = { readonly ok: true; readonly packet: FlowPacket } | { readonly ok: false; readonly error: string };

function unpack(q: Int16Array, step: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) {
    const x = q[i] as number;
    out[i] = x === PACKET_NO_VALUE ? Number.NaN : x * step;
  }
  return out;
}

/** Build the FlowField from a Worker packet, on the main thread. */
export function fieldFromPacket(packet: FlowPacket, meta: FlowMeta): FlowField {
  const s = FLOW_SOURCES[packet.kind];
  if (packet.cycle !== meta.cycle || packet.forecastHour !== meta.forecastHour) {
    throw new Error('flow packet clocks differ from the frame requested');
  }
  const input = {
    kind: packet.kind,
    grid: frameGrid(packet.kind),
    u: unpack(packet.u, s.step.uv),
    v: unpack(packet.v, s.step.uv),
    mask: packet.mask,
    meta
  };
  return createFlowField(packet.m ? { ...input, magnitude: unpack(packet.m, s.step.m) } : input);
}
