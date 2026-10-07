import { FetchSource, PMTiles, Protocol, ResolvedValueCache } from 'pmtiles';
import type { Cache, Entry, Header, RangeResponse, Source } from 'pmtiles';
import type { AddProtocolAction } from 'maplibre-gl';
import { fetchBufferedWithBudget } from '../util/fetch';

// Same read ceiling as the existing WHP protocol, now covering directory bodies.
export const PMTILES_READ_TIMEOUT_MS = 15_000;

function aborted(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function timedOut(): DOMException {
  return new DOMException('PMTiles read timed out', 'TimeoutError');
}

/** Detach one waiter without rejecting or aborting another waiter. */
function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Keep upstream range, small-archive, ETag and Windows cache semantics. */
class ReadSource implements Source {
  readonly base: FetchSource;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  constructor(base: FetchSource, signal: AbortSignal, timeoutMs: number) {
    this.base = base;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
  }
  getKey(): string { return this.base.getKey(); }
  async getBytes(offset: number, length: number, passed?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const controller = new AbortController();
    const cancel = (): void => controller.abort(this.signal.aborted ? this.signal.reason : passed?.reason);
    const signals = passed === undefined ? [this.signal] : [this.signal, passed];
    for (const signal of signals) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', cancel, { once: true });
    }
    const timer = setTimeout(() => controller.abort(timedOut()), this.timeoutMs);
    try {
      controller.signal.throwIfAborted();
      // FetchSource consumes arrayBuffer before resolving. The controller remains
      // live through that body, not just the arrival of response headers.
      return await waitFor(this.base.getBytes(offset, length, controller.signal, etag), controller.signal);
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', cancel);
      // Also release an unread HTTP error/ETag-mismatch response body.
      controller.abort();
    }
  }
}

interface Pending<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  users: number;
}

class ArchiveCache implements Cache {
  private resolved = new ResolvedValueCache();
  private generation = 0;
  private readonly pending = new Map<string, Pending<unknown>>();
  readonly base: FetchSource;
  readonly timeoutMs: number;
  constructor(base: FetchSource, timeoutMs: number) {
    this.base = base;
    this.timeoutMs = timeoutMs;
  }

  private join<T>(key: string, caller: ReadSource, load: (source: Source, cache: ResolvedValueCache) => Promise<T>): Promise<T> {
    if (caller.signal.aborted) return Promise.reject(aborted());
    const fullKey = this.generation + ':' + key;
    let item = this.pending.get(fullKey) as Pending<T> | undefined;
    if (item === undefined) {
      const controller = new AbortController();
      const cache = this.resolved;
      const source = new ReadSource(this.base, controller.signal, this.timeoutMs);
      const promise = load(source, cache);
      item = { controller, promise, users: 0 };
      this.pending.set(fullKey, item);
      const retire = (): void => {
        if (this.pending.get(fullKey) === item) this.pending.delete(fullKey);
      };
      // Both handlers resolve: no detached rejecting cleanup promise.
      void promise.then(retire, retire);
    }
    const held = item;
    held.users += 1;
    return waitFor(held.promise, caller.signal).finally(() => {
      held.users -= 1;
      if (held.users === 0) {
        if (this.pending.get(fullKey) === held) {
          this.pending.delete(fullKey);
          // An abandoned parse/decompression may finish later. Its cache must
          // not become the next generation's successful header/directory.
          this.resolved = new ResolvedValueCache();
          this.generation += 1;
        }
        held.controller.abort();
      }
    });
  }

  getHeader(source: Source): Promise<Header> {
    return this.join('header', source as ReadSource, (read, cache) => cache.getHeader(read));
  }
  getDirectory(source: Source, offset: number, length: number, header: Header): Promise<Entry[]> {
    const key = 'directory:' + (header.etag ?? '') + ':' + offset + ':' + length;
    return this.join(key, source as ReadSource, (read, cache) => cache.getDirectory(read, offset, length, header));
  }
  invalidate(_source: Source): Promise<void> {
    // PMTiles 4.4.1 calls this without awaiting it. Replace synchronously and
    // never return a rejecting promise. Old completions can only fill old cache.
    this.resolved = new ResolvedValueCache();
    this.generation += 1;
    return Promise.resolve();
  }
}

/** One transport for ordinary PMTiles and the WHP decoded-image protocol. */
export function createPmtilesTransport(timeoutMs = PMTILES_READ_TIMEOUT_MS): { tilev4: AddProtocolAction } {
  const archives = new Map<string, { base: FetchSource; cache: ArchiveCache }>();
  return {
    tilev4: async (request, owner) => {
      owner.signal.throwIfAborted();
      const match = request.type === 'json'
        ? /^pmtiles:\/\/(.+)$/.exec(request.url)
        : /^pmtiles:\/\/(.+)\/\d+\/\d+\/\d+(?:\?.*)?$/.exec(request.url);
      if (!match?.[1]) throw new Error('Invalid PMTiles protocol URL');
      const url = match[1];
      let archive = archives.get(url);
      if (archive === undefined) {
        const base = new FetchSource(url);
        archive = { base, cache: new ArchiveCache(base, timeoutMs) };
        archives.set(url, archive);
      }
      const controller = new AbortController();
      const cancel = (): void => controller.abort(owner.signal.reason);
      owner.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
      try {
        const source = new ReadSource(archive.base, controller.signal, timeoutMs);
        const protocol = new Protocol();
        protocol.add(new PMTiles(source, archive.cache));
        const response = await waitFor(protocol.tilev4(request, controller), controller.signal);
        // MapLibre's exact optional fields omit absent cache metadata.
        return {
          data: response.data,
          ...(response.cacheControl === undefined ? {} : { cacheControl: response.cacheControl }),
          ...(response.expires === undefined ? {} : { expires: response.expires })
        };
      } finally {
        clearTimeout(timer);
        owner.signal.removeEventListener('abort', cancel);
        controller.abort();
      }
    }
  };
}

export const pmtilesTransport = createPmtilesTransport();

export interface PngTileReadLimits {
  readonly timeoutMs: number;
  readonly maxDecodedBytes: number;
  /** Allocation guard from IHDR only; the image decoder must still validate PNG data. */
  readonly maxPixels: number;
}

/** Bounded response evidence for source-specific exception classification. */
export class PngTileResponseError extends Error {
  readonly status: number;
  readonly contentType: string;
  readonly body: ArrayBuffer;
  constructor(message: string, status: number, contentType: string, body: ArrayBuffer) {
    super(message);
    this.name = 'PngTileResponseError';
    this.status = status;
    this.contentType = contentType;
    this.body = body;
  }
}

/**
 * Shared PNG body read for the future VHI/RG protocols. No protocol registration,
 * source selection, image decoding, class interpretation or budget default.
 * A PNG envelope is not proof of a valid/nonblank frame.
 */
export async function readPngTile(
  url: string,
  owner: AbortSignal,
  limits: PngTileReadLimits
): Promise<{ data: ArrayBuffer; width: number; height: number }> {
  if (![limits.timeoutMs, limits.maxDecodedBytes, limits.maxPixels].every(
    value => Number.isSafeInteger(value) && value > 0
  ) || limits.timeoutMs > 15_000) {
    throw new RangeError('Invalid PNG tile read limits.');
  }
  if (owner.aborted) throw aborted();
  let response: Response;
  try {
    response = await fetchBufferedWithBudget(url, null, owner, limits.timeoutMs, limits.maxDecodedBytes);
  } catch (error) {
    if (owner.aborted) throw aborted();
    // Native MapLibre suppresses AbortError; a deadline must remain an error.
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DOMException('PNG tile read timed out', 'TimeoutError');
    }
    throw error;
  }
  if (owner.aborted) throw aborted();
  const data = await response.arrayBuffer();
  if (owner.aborted) throw aborted();
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!response.ok) throw new PngTileResponseError(`PNG tile HTTP ${response.status}`, response.status, contentType, data);
  if (contentType !== 'image/png') {
    throw new PngTileResponseError('PNG tile content type mismatch.', response.status, contentType, data);
  }
  const bytes = new Uint8Array(data);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) {
    throw new Error('Invalid PNG tile signature.');
  }
  const header = new DataView(data);
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) {
    throw new Error('Invalid PNG tile IHDR.');
  }
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff ||
      width > Math.floor(limits.maxPixels / height)) {
    throw new RangeError('PNG tile pixel limit exceeded.');
  }
  return { data, width, height };
}
