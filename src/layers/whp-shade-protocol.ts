import { addProtocol, type AddProtocolAction } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { WHP_SHADE_CATEGORIES } from '../config/whp-shade';

let registered = false;
const protocol = new Protocol();
const SHADE_ALPHA_BY_RGB = new Map(WHP_SHADE_CATEGORIES.map((category) => [
  Number.parseInt(category.color.slice(1), 16), category.opacity
]));

/** Recolor only known issuer classes. Keep missing pixels transparent. */
export function shadeWhpPixels(pixels: Uint8ClampedArray): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const rgb = (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
    const opacity = SHADE_ALPHA_BY_RGB.get(rgb);
    if (opacity === undefined) throw new Error('Unrecognized WHP class');
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = Math.round(pixels[offset + 3]! * opacity);
  }
}

export async function shadeImage(blob: Blob, signal: AbortSignal): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none'
  });
  try {
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('WHP canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    shadeWhpPixels(image.data);
    signal.throwIfAborted();
    return createImageBitmap(image);
  } finally {
    bitmap.close();
  }
}

/** Keep archive bounds/zooms in TileJSON; shade only requested image tiles. */
export const loadWhpShade: AddProtocolAction = async (request, abortController) => {
    const signal = abortController.signal;
    const timer = setTimeout(() => abortController.abort(), 15_000);
    try {
      const response = await protocol.tilev4({
        ...request,
        url: request.url.replace(/^whp-shade:\/\//, 'pmtiles://')
      }, abortController);
      signal.throwIfAborted();
      if (request.type === 'json') {
        return { data: { ...response.data as object, tiles: [`${request.url}/{z}/{x}/{y}`] } };
      }
      if (!(response.data instanceof Uint8Array)) return { data: response.data };
      return { data: await shadeImage(new Blob([response.data.slice()]), signal) };
    } finally {
      clearTimeout(timer);
    }
};

/** The published archive stays intact; decode and shade only requested tiles. */
export function registerWhpShadeProtocol(): void {
  if (registered) return;
  addProtocol('whp-shade', loadWhpShade);
  registered = true;
}
