/**
 * The ENSO flow decode Worker (ENSO-FLOW-PLAN section 3, block E1 unit E1-2;
 * section 2.3). A module Worker: it receives the GRIB2 messages of one frame
 * (one buffer per Range GET, in the source row's order), decodes each with
 * DDM's own decoder (./grib2), checks it is the message asked for (grid,
 * parameter, cycle, forecast hour, template, bitmap), turns GFS-Wave DIRPW
 * FROM into its TO unit vector through `waveToVector` (./source, the one
 * rotation), crops to the kind's coverage box, quantizes to Int16 steps and
 * transfers the result. A global 0.25 degree field is 4.15 MB as Float32;
 * the wave crop as Int16 plus a byte mask is about 0.77 MB.
 *
 * Any refusal (a template the decoder does not implement, a structurally
 * invalid message, a message that is not the one asked for, an unmasked
 * value outside its variable's physical bound, a value outside the Int16
 * range) replies with an error, and the reader reads the kind as
 * unavailable. Nothing is clamped and nothing masked is filled.
 *
 * GRIB2 carries no checksum, so a damaged message can still parse. The
 * bounds below refuse values no real field holds (found-148); a damaged
 * message whose values all stay inside them is not detected.
 */

import { decodeGrib2 } from './grib2';
import type { FlowKind } from './field';
import { FLOW_SOURCES, PACKET_NO_VALUE, waveToVector, type DecodeReply, type DecodeRequest, type FlowPacket } from './source';

const HOUR = 3_600_000;

/** GFS 10 m UGRD and VGRD, m/s: above the strongest sustained surface wind estimated in any tropical cyclone (about 96 m/s). */
export const WIND_COMPONENT_MAX_MS = 100;
/** GFS-Wave HTSGW, m: the largest buoy-measured significant wave height is about 19 m; 30 m leaves room for a model peak. */
export const WAVE_HEIGHT_MAX_M = 30;
/** GFS-Wave DIRPW, degrees true clockwise from north: 360 is accepted in case the issuer writes north as 360. */
export const WAVE_DIRECTION_MAX_DEG = 360;

/** The inclusive range each source message's unmasked values must lie in, by `.idx` variable. */
export const PLAUSIBLE_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  UGRD: [-WIND_COMPONENT_MAX_MS, WIND_COMPONENT_MAX_MS],
  VGRD: [-WIND_COMPONENT_MAX_MS, WIND_COMPONENT_MAX_MS],
  HTSGW: [0, WAVE_HEIGHT_MAX_M],
  DIRPW: [0, WAVE_DIRECTION_MAX_DEG]
};

/**
 * Refuse (RangeError) a decoded field holding any unmasked value outside its
 * variable's range, anywhere on the grid; NaN is a masked point. A variable
 * with no range is refused too. Exported for the tests.
 */
export function checkPlausible(variable: string, values: Float32Array): void {
  const range = PLAUSIBLE_RANGE[variable];
  if (!range) throw new RangeError(`${variable} has no plausibility bound`);
  const [lo, hi] = range;
  for (let k = 0; k < values.length; k++) {
    const x = values[k] as number;
    if (!Number.isNaN(x) && !(x >= lo && x <= hi)) {
      throw new RangeError(`${variable} ${x} at point ${k} is outside the plausible range ${lo} to ${hi}; the frame is refused`);
    }
  }
}

/** Quantize one cropped component to Int16 steps; a NaN node is PACKET_NO_VALUE. */
function quantize(src: Float32Array, step: number, what: string): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const x = src[i] as number;
    if (Number.isNaN(x)) {
      out[i] = PACKET_NO_VALUE;
      continue;
    }
    const q = Math.round(x / step);
    if (!(q > PACKET_NO_VALUE && q <= 32_767)) throw new RangeError(`${what} ${x} is outside the Int16 transfer range`);
    out[i] = q;
  }
  return out;
}

/**
 * Build the transfer packet from decoded full-grid values (scan order, NaN
 * where masked), one array per source message. Exported for the tests.
 */
export function buildPacket(kind: FlowKind, values: readonly Float32Array[], cycle: number, forecastHour: number): FlowPacket {
  const s = FLOW_SOURCES[kind];
  const { ni, nj } = s.grid;
  if (values.length !== s.messages.length || values.some((a) => a.length !== ni * nj)) {
    throw new Error(`${kind}: expected ${s.messages.length} fields of ${ni}x${nj}`);
  }
  // The whole grid, not only the crop: a value out of bound anywhere marks the message as damaged.
  s.messages.forEach((message, k) => checkPlausible(message.variable, values[k] as Float32Array));
  const c = s.crop ?? { column0: 0, row0: 0, nx: ni, ny: nj };
  if (c.row0 < 0 || c.row0 + c.ny > nj || c.nx > ni) throw new Error(`${kind}: the crop leaves the grid`);
  const n = c.nx * c.ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const m = kind === 'waves' ? new Float32Array(n) : null;
  const mask = new Uint8Array(n);
  const [a, b] = values as [Float32Array, Float32Array];
  for (let row = 0; row < c.ny; row++) {
    const srcRow = (c.row0 + row) * ni;
    for (let col = 0; col < c.nx; col++) {
      const i = row * c.nx + col;
      const j = srcRow + ((c.column0 + col) % ni);
      const x = a[j] as number;
      const y = b[j] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        u[i] = v[i] = Number.NaN;
        if (m) m[i] = Number.NaN;
        continue;
      }
      if (m) {
        // Waves: a = DIRPW (FROM, degrees true), b = HTSGW (m).
        const to = waveToVector(x);
        u[i] = to[0];
        v[i] = to[1];
        m[i] = y;
      } else {
        // Wind: a = UGRD, b = VGRD, already TO; never rotated.
        u[i] = x;
        v[i] = y;
      }
      mask[i] = 1;
    }
  }
  return {
    kind,
    cycle,
    forecastHour,
    u: quantize(u, s.step.uv, 'u'),
    v: quantize(v, s.step.uv, 'v'),
    m: m ? quantize(m, s.step.m, 'magnitude') : null,
    mask
  };
}

/** Decode, check, rotate, crop and quantize one frame's messages. */
export function decodeFrame(request: DecodeRequest): FlowPacket {
  const s = FLOW_SOURCES[request.kind];
  if (request.messages.length !== s.messages.length) throw new Error(`${request.kind}: ${request.messages.length} messages`);
  if (!Number.isFinite(request.cycle) || request.cycle % (6 * HOUR) !== 0) throw new Error('flow: the cycle is not a GFS cycle');
  const values = s.messages.map((message, k) =>
    decodeGrib2(new Uint8Array(request.messages[k] as ArrayBuffer), {
      grid: s.grid,
      parameter: message.parameter,
      refTime: request.cycle,
      forecastHours: request.forecastHour,
      packing: s.packing,
      bitmap: s.bitmap
    }).values
  );
  return buildPacket(request.kind, values, request.cycle, request.forecastHour);
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeReply, transfer: Transferable[]): void;
}

// Attach only inside a Worker; importing this module elsewhere (the Node
// tests) runs nothing.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = (event) => {
    let reply: DecodeReply;
    let transfer: Transferable[] = [];
    try {
      const packet = decodeFrame(event.data);
      reply = { ok: true, packet };
      transfer = [packet.u.buffer, packet.v.buffer, packet.mask.buffer];
      if (packet.m) transfer.push(packet.m.buffer);
    } catch (e) {
      reply = { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    scope.postMessage(reply, transfer);
  };
}
