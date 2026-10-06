/**
 * The bounded, cancellable NODD reader of the ENSO flow paths
 * (ENSO-FLOW-PLAN section 3, block E1 unit E1-2; B-grib.md section 6;
 * admission gfs-runtime-nodd lines 1, 3 to 7).
 *
 * One frame per kind, read only for the kind on screen; wind never waits
 * behind waves.
 * 1. Cycle: candidate = floor((now - 3 h 30 m) / 6 h) (the newest cycle is
 *    absent for 3 h 31 m to 4 h 56 m). The forecast hour is the latest valid
 *    time not after now on the product's cadence (3-hourly 1p00, hourly
 *    wave), recomputed after each step back.
 * 2. Discover: GET the `.idx` (never HEAD: HEAD carries no
 *    Access-Control-Allow-Origin), with a Range of its cap (64 kB atmos,
 *    4 kB wave). A 404 steps back 6 h, at most 3 tries in all, then the kind
 *    reads unavailable.
 * 3. Locate: the line `n:offset:d=YYYYMMDDHH:VAR:LEVEL:STEP:` with VAR and
 *    LEVEL exact, `d=` the cycle and STEP the forecast hour; the span ends at
 *    the next line's offset minus 1, so a needed message on the last line is
 *    refused.
 * 4. Read: one Range GET per message, `credentials: 'omit'`, through
 *    `fetchBoundedWithBudget` with the 12 s complete-body budget and
 *    `{expectStatus: 206, maxBytes}` (a 200, a short body or an over-long
 *    body is refused). Content-Range and ETag are not readable cross-origin;
 *    integrity is the 206, the exact length, and the decoder's section 0
 *    length and closing `7777`.
 * 5. Decode in a module Worker (./decode-worker), which checks, rotates,
 *    crops and quantizes; the main thread builds the FlowField and stamps
 *    run, valid time and staleAfter = cycle + 24 h, and refuses a frame past
 *    it.
 *
 * An abort of the activation signal cancels every outstanding read and
 * terminates the Worker; the promise rejects with an AbortError (superseded,
 * not a failure). Every other failure is a FlowUnavailableError.
 */

import { linkAbort } from '../../util/fetch';
import { isStale, type FlowField, type FlowKind } from './field';
import {
  FLOW_SOURCES,
  fieldFromPacket,
  frameMeta,
  type DecodeReply,
  type DecodeRequest,
  type FlowMessage,
  type FlowPacket
} from './source';

const HOUR = 3_600_000;
const CYCLE_MS = 6 * HOUR;
/** The newest cycle's earliest observed arrival on NODD (B-grib.md section 2.3). */
const PUBLISH_LAG_MS = 3.5 * HOUR;

/** The complete-body budget of each read (the existing 12 s ENSO read budget). */
export const FLOW_READ_BUDGET_MS = 12_000;
/** Cycle tries in all: the candidate and two 6 h step-backs. */
export const MAX_CYCLE_TRIES = 3;

/**
 * Fixed transport ceilings, independent of the untrusted index. The committed
 * 2026-10-05 06Z fixtures carry 79,086/79,607 B wind messages and
 * 887,386/428,128 B global wave messages. These ceilings leave several times
 * those sizes for packing variation while bounding each read and their sum.
 */
const MAX_FLOW_READ_BYTES = 4 * 1024 * 1024;
const FLOW_BYTE_LIMITS: Readonly<Record<FlowKind, { readonly message: number; readonly frame: number }>> = {
  wind: { message: 512 * 1024, frame: 768 * 1024 },
  waves: { message: MAX_FLOW_READ_BYTES, frame: 6 * 1024 * 1024 }
};

export type FlowUnavailableReason =
  /** The `.idx` answered 404 on every try. */
  | 'not-published'
  /** An answer or a message was not the one asked for (status, length, `.idx` line, decoder refusal). */
  | 'refused'
  /** The frame is past cycle + 24 h. */
  | 'stale'
  /** The network, the budget or the Worker failed. */
  | 'failed';

/**
 * The class body declares no field, so the es2020 build lowers none and
 * bundles no class-field helper (block E2 E2-1). The field's type comes from
 * the merged interface rather than a `declare` field, because the Playwright
 * specs load this module through a transform that refuses `declare` fields.
 */
export interface FlowUnavailableError {
  readonly reason: FlowUnavailableReason;
}
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the interface only types `reason`, which the constructor always sets.
export class FlowUnavailableError extends Error {
  constructor(reason: FlowUnavailableReason, message: string) {
    super(message);
    this.name = 'FlowUnavailableError';
    (this as { reason: FlowUnavailableReason }).reason = reason;
  }
}

/** The model cycle to try first at `now` (epoch ms): floor((now - 3 h 30 m) / 6 h). */
export function candidateCycle(now: number): number {
  return Math.floor((now - PUBLISH_LAG_MS) / CYCLE_MS) * CYCLE_MS;
}

/** The latest forecast hour of `cycle`, on the kind's cadence, whose valid time is not after `now`. */
export function forecastHourFor(kind: FlowKind, cycle: number, now: number): number {
  const cadence = FLOW_SOURCES[kind].cadenceHours;
  return Math.max(0, Math.floor((now - cycle) / (cadence * HOUR)) * cadence);
}

function idxStamp(cycle: number): string {
  const iso = new Date(cycle).toISOString();
  return `d=${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}`;
}

const refuse = (message: string): never => {
  throw new FlowUnavailableError('refused', message);
};

/**
 * The byte span of one message in a `.idx`, or a 'refused' FlowUnavailableError
 * when the line is missing, repeated, of another cycle or hour, or the last line.
 */
export function locateMessage(
  idx: string,
  message: FlowMessage,
  cycle: number,
  forecastHour: number
): { start: number; end: number } {
  const lines = idx.split('\n').filter((line) => line.trim() !== '');
  const name = `${message.variable}:${message.level}`;
  let hit = -1;
  lines.forEach((line, i) => {
    const f = line.split(':');
    if (f[3] === message.variable && f[4] === message.level) {
      if (hit >= 0) refuse(`${name} appears twice in the .idx`);
      hit = i;
    }
  });
  if (hit < 0) return refuse(`${name} is not in the .idx`);
  const f = (lines[hit] as string).split(':');
  if (f[2] !== idxStamp(cycle)) refuse(`${name} is ${f[2]}, not ${idxStamp(cycle)}`);
  const step = forecastHour === 0 ? 'anl' : `${forecastHour} hour fcst`;
  if (f[5] !== step) refuse(`${name} is "${f[5]}", not "${step}"`);
  if (hit === lines.length - 1) refuse(`${name} is the last .idx line, so its end is unknown`);
  const startText = f[1] ?? '';
  const nextText = (lines[hit + 1] as string).split(':')[1] ?? '';
  const start = Number(startText);
  const next = Number(nextText);
  if (
    !/^\d+$/.test(startText) ||
    !/^\d+$/.test(nextText) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(next) ||
    next <= start
  ) {
    refuse(`${name} has no valid byte span`);
  }
  return { start, end: next - 1 };
}

/** The decode Worker as the reader uses it (a real module Worker satisfies it). */
export interface DecodeWorkerLike {
  onmessage: ((event: MessageEvent<DecodeReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DecodeRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface FlowReadOptions {
  /** The activation signal: its abort cancels every read and terminates the Worker. */
  readonly signal: AbortSignal;
  /** The clock (epoch ms); defaults to Date.now. */
  readonly now?: () => number;
  /** The Worker factory; defaults to the module Worker. */
  readonly createWorker?: () => DecodeWorkerLike;
}

function moduleWorker(): DecodeWorkerLike {
  return new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' });
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

/**
 * The bounded Range read: `fetchBufferedWithBudget`'s contract (the budget
 * and the owner's abort span the body, which is cancelled on either; the
 * Response carries the status and headers over the buffered bytes) plus a
 * byte bound, kept here in the lazy flow chunk rather than in the eager
 * src/util/fetch.ts (found-147). The read stops and rejects with a
 * RangeError as soon as the body passes `maxBytes`, so a server that ignores
 * Range cannot stream a whole file. With `expectStatus` as well, any other
 * status rejects with a RangeError at the headers and the request is
 * aborted, and the body must be exactly `maxBytes` long (a Range read of a
 * known span), so a short body is refused too.
 */
export async function fetchBoundedWithBudget(
  url: string,
  opts: RequestInit | null,
  masterSignal: AbortSignal | null,
  timeoutMs: number,
  bounds: { readonly maxBytes: number; readonly expectStatus?: number }
): Promise<Response> {
  if (masterSignal?.aborted) throw abortError();
  const { maxBytes, expectStatus } = bounds;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FLOW_READ_BYTES) {
    throw new RangeError('invalid flow response capacity');
  }
  const ctrl = new AbortController();
  const { signal } = ctrl;
  const unlink = linkAbort(ctrl, masterSignal);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...(opts ?? {}), signal });
    if (expectStatus !== undefined && response.status !== expectStatus) {
      ctrl.abort();
      throw new RangeError(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(maxBytes);
    let length = 0;
    const reader = response.body?.getReader();
    if (reader) {
      const cancel = (): void => void reader.cancel().catch(() => undefined);
      signal.addEventListener('abort', cancel);
      if (signal.aborted) cancel();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (signal.aborted) throw abortError();
          if (chunk.done) break;
          if (length + chunk.value.byteLength > maxBytes) {
            cancel();
            throw new RangeError();
          }
          bytes.set(chunk.value, length);
          length += chunk.value.byteLength;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    }
    if (expectStatus !== undefined && length !== maxBytes) throw new RangeError();
    return new Response(length ? bytes.subarray(0, length) : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } finally {
    clearTimeout(timer);
    unlink();
  }
}

function ranged(url: string, start: number, end: number, signal: AbortSignal, exact: boolean): Promise<Response> {
  return fetchBoundedWithBudget(
    url,
    { credentials: 'omit', headers: { Range: `bytes=${start}-${end}` } },
    signal,
    FLOW_READ_BUDGET_MS,
    exact ? { expectStatus: 206, maxBytes: end - start + 1 } : { maxBytes: end - start + 1 }
  );
}

function decodeIn(worker: DecodeWorkerLike, request: DecodeRequest, signal: AbortSignal): Promise<FlowPacket> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      signal.removeEventListener('abort', onAbort);
      const reply = event.data;
      if (reply.ok) resolve(reply.packet);
      else reject(new FlowUnavailableError('refused', reply.error));
    };
    worker.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new FlowUnavailableError('failed', 'the flow decode Worker failed'));
    };
    worker.postMessage(request, [...request.messages]);
  });
}

/**
 * Read, decode and stamp one frame of `kind` from NODD. Resolves to a
 * FlowField (wind uncropped, waves cropped, both TO); rejects with an
 * AbortError when the activation signal aborts, or a FlowUnavailableError.
 */
export async function readFlowFrame(kind: FlowKind, options: FlowReadOptions): Promise<FlowField> {
  const { signal } = options;
  if (signal.aborted) throw abortError();
  const now = options.now ?? Date.now;
  const source = FLOW_SOURCES[kind];
  const ctrl = new AbortController();
  const unlink = linkAbort(ctrl, signal);
  const worker = (options.createWorker ?? moduleWorker)();
  try {
    const t = now();
    let cycle = candidateCycle(t);
    for (let tries = 1; ; tries++) {
      const forecastHour = forecastHourFor(kind, cycle, t);
      const meta = frameMeta(kind, cycle, forecastHour);
      const idxResponse = await ranged(`${meta.sourceUrl}.idx`, 0, source.idxMaxBytes - 1, ctrl.signal, false);
      if (idxResponse.status === 404) {
        if (tries >= MAX_CYCLE_TRIES) {
          throw new FlowUnavailableError('not-published', `no ${kind} .idx in ${MAX_CYCLE_TRIES} cycles`);
        }
        cycle -= CYCLE_MS;
        continue;
      }
      if (!idxResponse.ok) throw new FlowUnavailableError('failed', `.idx HTTP ${idxResponse.status}`);
      const idxBytes = await idxResponse.arrayBuffer();
      if (idxBytes.byteLength >= source.idxMaxBytes) refuse(`the ${kind} .idx fills its ${source.idxMaxBytes} B cap`);
      const idx = new TextDecoder().decode(idxBytes);
      const spans = source.messages.map((message) => locateMessage(idx, message, cycle, forecastHour));
      const limit = FLOW_BYTE_LIMITS[kind];
      let frameBytes = 0;
      for (const { start, end } of spans) {
        const bytes = end - start + 1;
        if (bytes > limit.message) refuse(`the ${kind} message exceeds its ${limit.message} B cap`);
        frameBytes += bytes;
        if (frameBytes > limit.frame) refuse(`the ${kind} frame exceeds its ${limit.frame} B cap`);
      }
      const responses = await Promise.all(
        spans.map(({ start, end }) => ranged(meta.sourceUrl, start, end, ctrl.signal, true))
      );
      const messages = await Promise.all(responses.map((response) => response.arrayBuffer()));
      const packet = await decodeIn(worker, { kind, cycle, forecastHour, messages }, ctrl.signal);
      const field = fieldFromPacket(packet, meta);
      if (isStale(field, now())) {
        throw new FlowUnavailableError('stale', `the ${kind} frame is past cycle + 24 h`);
      }
      return field;
    }
  } catch (e) {
    if (signal.aborted) throw abortError();
    if (e instanceof FlowUnavailableError) throw e;
    const reason = e instanceof RangeError ? 'refused' : 'failed';
    // A RangeError is fetchBoundedWithBudget's bound: a status other than
    // 206, or a body longer or shorter than the span asked for.
    throw new FlowUnavailableError(reason, `${kind} read: ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`);
  } finally {
    worker.terminate();
    ctrl.abort();
    unlink();
  }
}

