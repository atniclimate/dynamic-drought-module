import { readPngTile, type PngTileReadLimits } from '../map/tile-protocol';
import {
  DRYNESS_NOT_ASSESSED_COLOR,
  RG_DRYNESS_CLASSES,
  RG_NOT_ASSESSED_COLORS,
  STAR_DRYNESS_CLASSES,
  type DrynessProduct
} from '../config/dryness-ground';

const colorNumber = (hex: string): number => Number.parseInt(hex.slice(1), 16);
const neutral = colorNumber(DRYNESS_NOT_ASSESSED_COLOR);
const star = new Map<number, number>(STAR_DRYNESS_CLASSES.map(row => [colorNumber(row.source), colorNumber(row.grey)]));
const greenness = new Map<number, number>(RG_DRYNESS_CLASSES.map(row => [colorNumber(row.source), colorNumber(row.grey)]));
for (const source of RG_NOT_ASSESSED_COLORS) greenness.set(colorNumber(source), neutral);

/**
 * Transform an already-decoded exact-source RGBA buffer in place.
 * Validate the complete tile first, so a drifted class or unexpected alpha
 * cannot leave partly recolored input behind. No decoder, fetch or protocol
 * registration is owned here. The caller must decode without color conversion.
 */
export function shadeDrynessPixels(pixels: Uint8ClampedArray, product: DrynessProduct): void {
  if (pixels.length % 4 !== 0) throw new RangeError('Invalid dryness RGBA length');
  const classes = product === 'star-vhi' ? star : product === 'relative-greenness' ? greenness : undefined;
  if (!classes) throw new Error('Unknown dryness product');
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]!;
    if (alpha === 0) continue;
    // Exact issuer palette evidence supports opaque classes and transparent
    // absence only. A partial-alpha sample may be interpolated or premultiplied;
    // its class is not guessed and it is not silently labeled not assessed.
    if (alpha !== 255) throw new Error('Unsupported dryness alpha');
    const color = (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
    if (!classes.has(color)) throw new Error('Unrecognized dryness class');
  }
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const color = (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
    const output = pixels[offset + 3] === 0 ? neutral : classes.get(color)!;
    pixels[offset] = output >>> 16;
    pixels[offset + 1] = (output >>> 8) & 255;
    pixels[offset + 2] = output & 255;
    pixels[offset + 3] = 255;
  }
}

export interface DrynessTileLimits extends PngTileReadLimits {
  /** Encoded PNG output ceiling, separate from the decoded HTTP body ceiling. */
  readonly maxOutputBytes: number;
}

/**
 * Read and transform one PNG atomically. No source selection or registration.
 * Native image decode/encode cannot be physically canceled; abort/deadline
 * rejects the consumer promptly, discards late output, and closes late bitmaps.
 * Pixel limits bound synchronous work; elapsed checks prohibit late publication.
 */
export async function readDrynessTile(
  url: string,
  product: DrynessProduct,
  owner: AbortController,
  limits: DrynessTileLimits
): Promise<ArrayBuffer> {
  if (![limits.timeoutMs, limits.maxDecodedBytes, limits.maxPixels, limits.maxOutputBytes].every(
    value => Number.isSafeInteger(value) && value > 0
  ) || limits.timeoutMs > 15_000) throw new RangeError('Invalid dryness tile limits');
  if (product !== 'star-vhi' && product !== 'relative-greenness') throw new Error('Unknown dryness product');
  const controller = new AbortController();
  const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');
  const timeoutError = (): DOMException => new DOMException('Dryness tile timed out', 'TimeoutError');
  const deadline = performance.now() + limits.timeoutMs;
  const cancel = (): void => controller.abort(abortError());
  if (owner.signal.aborted) cancel();
  else owner.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError()), limits.timeoutMs);
  const checkpoint = (): void => {
    if (owner.signal.aborted) throw abortError();
    controller.signal.throwIfAborted();
    if (performance.now() >= deadline) {
      controller.abort(timeoutError());
      controller.signal.throwIfAborted();
    }
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
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    checkpoint();
    const png = await settle(readPngTile(url, controller.signal, limits));
    checkpoint();
    bitmap = await settle(createImageBitmap(new Blob([png.data], { type: 'image/png' }), {
      colorSpaceConversion: 'none', premultiplyAlpha: 'none'
    }), value => value.close());
    checkpoint();
    if (bitmap.width !== png.width || bitmap.height !== png.height ||
        bitmap.width > Math.floor(limits.maxPixels / bitmap.height)) {
      throw new RangeError('Decoded dryness dimensions mismatch');
    }
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new Error('Dryness canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    checkpoint();
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    checkpoint();
    shadeDrynessPixels(image.data, product);
    checkpoint();
    context.putImageData(image, 0, 0);
    bitmap.close();
    bitmap = undefined;
    checkpoint();
    const output = await settle(new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(blob => blob ? resolve(blob) : reject(new Error('Dryness PNG encode failed')), 'image/png');
    }));
    checkpoint();
    if (output.type !== 'image/png' || output.size === 0 || output.size > limits.maxOutputBytes) {
      throw new RangeError('Invalid dryness PNG output');
    }
    const bytes = await settle(output.arrayBuffer());
    checkpoint();
    if (bytes.byteLength !== output.size || bytes.byteLength > limits.maxOutputBytes) {
      throw new RangeError('Dryness PNG output limit exceeded');
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    owner.signal.removeEventListener('abort', cancel);
    controller.abort(abortError());
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
