import { readPngTile, type PngTileReadLimits } from '../map/tile-protocol';
import { ExpiringLruCache } from '../util/bounded-cache';
import { listeningTimeout, MAX_STALL_REREADS } from '../util/listening-timeout';
import {
  RG_DRYNESS_CLASSES,
  RG_NOT_ASSESSED_COLORS,
  STAR_DRYNESS_CLASSES,
  STAR_LAND_COVER_DRAWN,
  STAR_LAND_COVER_MASKED,
  type DrynessProduct
} from '../config/dryness-ground';

const colorNumber = (hex: string): number => Number.parseInt(hex.slice(1), 16);
const rgb = (pixels: Uint8ClampedArray, offset: number): number =>
  (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
// Issuer class RGB to the 8-bit alpha its white is drawn at; 0 is no value.
const star = new Map<number, number>(STAR_DRYNESS_CLASSES.map(row => [colorNumber(row.source), Math.round(row.alpha * 255)]));
const greenness = new Map<number, number>(RG_DRYNESS_CLASSES.map(row => [colorNumber(row.source), Math.round(row.alpha * 255)]));
for (const source of RG_NOT_ASSESSED_COLORS) greenness.set(colorNumber(source), 0);
// STAR land-cover class RGB to whether plant stress is drawn over it.
const landCover = new Map<number, boolean>([
  ...STAR_LAND_COVER_DRAWN.map((color): [number, boolean] => [colorNumber(color), true]),
  ...STAR_LAND_COVER_MASKED.map((color): [number, boolean] => [colorNumber(color), false])
]);

/**
 * Transform an already-decoded exact-source RGBA buffer in place: white at
 * the class's alpha, fully transparent where there is no value. `mask` is the
 * decoded STAR land-cover tile of the same z/x/y; its snow and ice, bare
 * ground, water and unclassed (transparent) pixels are not drawn.
 * Validate both complete tiles first, so a drifted class or unexpected alpha
 * cannot leave partly recolored input behind. No decoder, fetch or protocol
 * registration is owned here. The caller must decode without color conversion.
 */
export function shadeDrynessPixels(pixels: Uint8ClampedArray, product: DrynessProduct, mask?: Uint8ClampedArray): void {
  if (pixels.length % 4 !== 0) throw new RangeError('Invalid dryness RGBA length');
  const classes = product === 'star-vhi' ? star : product === 'relative-greenness' ? greenness : undefined;
  if (!classes) throw new Error('Unknown dryness product');
  if (mask && mask.length !== pixels.length) throw new RangeError('Invalid dryness land-cover mask');
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]!;
    // Exact issuer palette evidence supports opaque classes and transparent
    // absence only. A partial-alpha sample may be interpolated or premultiplied;
    // its class is not guessed and it is not silently labeled not assessed.
    if (alpha !== 0 && alpha !== 255) throw new Error('Unsupported dryness alpha');
    if (alpha !== 0 && !classes.has(rgb(pixels, offset))) throw new Error('Unrecognized dryness class');
    const maskAlpha = mask?.[offset + 3] ?? 0;
    if (maskAlpha !== 0 && (maskAlpha !== 255 || !landCover.has(rgb(mask!, offset)))) throw new Error('Unrecognized land-cover class');
  }
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const drawn = pixels[offset + 3] !== 0 && (!mask || (mask[offset + 3] !== 0 && landCover.get(rgb(mask, offset))));
    const alpha = drawn ? classes.get(rgb(pixels, offset))! : 0;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = alpha === 0 ? 0 : 255;
    pixels[offset + 3] = alpha;
  }
}

export type DrynessTileLimits = PngTileReadLimits;

/** The browser could not process bytes that passed the PNG header check: this tile's trouble, not the week's. */
export class DrynessLocalError extends Error { override name = 'DrynessLocalError'; }
/** Whether a failed tile says its frame is bad (step the week back). A stall, a local failure or a cancellation does not. */
export const isDrynessSourceFault = (error: unknown): boolean =>
  !(error instanceof DrynessLocalError) && !(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name));
const local = async <T>(work: Promise<T>): Promise<T> => {
  try { return await work; } catch (error) { throw new DrynessLocalError(`Dryness bitmap failed: ${error}`); }
};

// 60 x 262,144 B (a 256 x 256 RGBA tile) is 15.7 MB at most.
const MASK_ENTRIES = 60;
const MASK_TTL_MS = 3_600_000;

/**
 * Decoded land-cover tiles by exact URL, and the reads in flight. The mask does
 * not depend on the week, so a tile that validated is kept an hour after its
 * last use (an expired one is read again). Tiles asking for one URL
 * share one read; each cancels only itself, and the read stops when none is
 * left. Kept pixels are only ever read (shadeDrynessPixels does not write the mask).
 */
export function createDrynessMasks(now?: () => number) {
  const done = new ExpiringLruCache<string, Uint8ClampedArray>(MASK_ENTRIES, now);
  const reads = new Map<string, { owner: AbortController; users: number; work: Promise<Uint8ClampedArray> }>();
  return {
    keep: (url: string, pixels: Uint8ClampedArray): void => done.set(url, pixels, MASK_TTL_MS),
    /** `asker` is the caller's own signal: its abort leaves the read. */
    join(url: string, asker: AbortSignal, start: (owner: AbortController) => Promise<Uint8ClampedArray>): Promise<Uint8ClampedArray> {
      const kept = done.get(url);
      if (kept) return Promise.resolve(kept);
      let read = reads.get(url);
      if (!read) {
        const owner = new AbortController();
        const made = { owner, users: 0, work: start(owner) };
        read = made;
        const forget = (): void => { if (reads.get(url) === made) reads.delete(url); };
        made.work.then(forget, forget);
        reads.set(url, made);
      }
      const joined = read;
      joined.users++;
      const leave = (): void => {
        if (--joined.users > 0 || reads.get(url) !== joined) return;
        reads.delete(url);
        joined.owner.abort(new DOMException('Aborted', 'AbortError'));
      };
      if (asker.aborted) leave(); else asker.addEventListener('abort', leave, { once: true });
      return joined.work;
    }
  };
}
export type DrynessMasks = ReturnType<typeof createDrynessMasks>;

/**
 * One cancellable, deadline-bound PNG reader: `decode` gives exact RGBA, `settle`
 * lets a caller stop waiting on native work that ignores a signal, and `finish`
 * (always called) releases the timer, listener and canvases.
 */
function drynessReader(owner: AbortController, limits: DrynessTileLimits) {
  const controller = new AbortController();
  const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
  const timeoutError = (): DOMException => new DOMException('Dryness tile timed out', 'TimeoutError');
  const cancel = (): void => controller.abort(abortError());
  if (owner.signal.aborted) cancel();
  else owner.signal.addEventListener('abort', cancel, { once: true });
  // A stall must never read as a source failure that steps the week back.
  const stopTimeout = listeningTimeout(limits.timeoutMs, () => controller.abort(timeoutError()));
  const checkpoint = (): void => {
    if (owner.signal.aborted) throw abortError();
    controller.signal.throwIfAborted();
  };
  // This wrapper owns rejection even when a native promise ignores our signal.
  const settle = <T>(work: Promise<T>, discard?: (value: T) => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let finished = false;
      const discardValue = (value: T): void => {
        try { discard?.(value); } catch { /* Cleanup must not create a detached rejection. */ }
      };
      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener('abort', onAbort);
        reject(owner.signal.aborted ? abortError() : controller.signal.reason);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      void work.then(value => {
        if (finished) { discardValue(value); return; }
        finished = true;
        controller.signal.removeEventListener('abort', onAbort);
        try { checkpoint(); } catch (error) { discardValue(value); reject(error); return; }
        resolve(value);
      }, error => {
        if (finished) return;
        finished = true;
        controller.signal.removeEventListener('abort', onAbort);
        try { checkpoint(); } catch (cancellation) { reject(cancellation); return; }
        reject(error);
      });
    });
  const canvases: HTMLCanvasElement[] = [];
  // One PNG to exact RGBA. The source bitmap never outlives this call; the canvas is released in the finally below.
  const decode = async (target: string): Promise<ImageData> => {
    // The shared reader's wall-clock timer fired while ticks remain: read again.
    let png: Awaited<ReturnType<typeof readPngTile>>;
    for (let rereads = MAX_STALL_REREADS; ; rereads--) {
      try {
        png = await settle(readPngTile(target, controller.signal, limits));
        break;
      } catch (error) {
        if (rereads === 0 || controller.signal.aborted ||
            !(error instanceof DOMException) || error.name !== 'TimeoutError') throw error;
      }
    }
    checkpoint();
    const bitmap = await settle(local(createImageBitmap(new Blob([png.data], { type: 'image/png' }), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none'
    })), value => value.close());
    try {
      checkpoint();
      if (bitmap.width !== png.width || bitmap.height !== png.height ||
          bitmap.width > Math.floor(limits.maxPixels / bitmap.height)) {
        throw new RangeError('Decoded dryness dimensions mismatch');
      }
      const canvas = document.createElement('canvas');
      canvases.push(canvas);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      if (!context) throw new DrynessLocalError('Dryness canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      checkpoint();
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  };
  return {
    signal: controller.signal, settle, checkpoint, decode,
    finish(): void {
      stopTimeout();
      owner.signal.removeEventListener('abort', cancel);
      controller.abort(abortError());
      for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
    }
  };
}

/**
 * Read and transform one PNG atomically into a decoded bitmap that the caller
 * closes or hands to MapLibre. No source selection or registration.
 * Native image decode cannot be physically canceled; abort/deadline
 * rejects the consumer promptly, discards late output, and closes late bitmaps.
 * Pixel limits bound synchronous work; the tick deadline prohibits late
 * publication. `maskUrl` is the land-cover tile of the same z/x/y, read beside
 * the source through the same reader, limits and deadline (shared and kept by
 * `masks`); if it fails, the tile is not drawn.
 */
export async function readDrynessTile(
  url: string,
  product: DrynessProduct,
  owner: AbortController,
  limits: DrynessTileLimits,
  maskUrl?: string,
  masks: DrynessMasks = createDrynessMasks()
): Promise<ImageBitmap> {
  if (![limits.timeoutMs, limits.maxDecodedBytes, limits.maxPixels].every(
    value => Number.isSafeInteger(value) && value > 0
  ) || limits.timeoutMs > 15_000) throw new RangeError('Invalid dryness tile limits');
  if (product !== 'star-vhi' && product !== 'relative-greenness') throw new Error('Unknown dryness product');
  const reader = drynessReader(owner, limits);
  const { settle, checkpoint } = reader;
  try {
    checkpoint();
    const [image, mask] = await Promise.all([reader.decode(url), maskUrl === undefined ? undefined :
      settle(masks.join(maskUrl, reader.signal, shared => {
        const read = drynessReader(shared, limits);
        return read.decode(maskUrl).then(({ data }) => data).finally(read.finish);
      }))]);
    checkpoint();
    shadeDrynessPixels(image.data, product, mask);
    checkpoint();
    // Kept only now: the pure check passed and the tile was not canceled.
    if (maskUrl !== undefined && mask) masks.keep(maskUrl, mask);
    // The caller owns the bitmap; one that completes after a cancel is closed here.
    return await settle(local(createImageBitmap(image)), value => value.close());
  } finally {
    reader.finish();
  }
}
