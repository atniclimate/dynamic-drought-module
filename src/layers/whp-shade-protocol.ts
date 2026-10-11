import { addProtocol, type AddProtocolAction } from 'maplibre-gl';
import { pmtilesTransport, PMTILES_READ_TIMEOUT_MS } from '../map/tile-protocol';
import { WHP_3D_SHADE_CATEGORIES, WHP_SHADE_CATEGORIES } from '../config/whp-shade';
import { listeningTimeout } from '../util/listening-timeout';

let registered = false;
type ShadeAlphaByRgb = ReadonlyMap<number, number>;
const alphaByRgb = (categories: typeof WHP_SHADE_CATEGORIES): ShadeAlphaByRgb => new Map(categories.map((category) => [
  Number.parseInt(category.color.slice(1), 16), category.opacity
]));
/** The flat view's shading on terrain (src/layers/whp-image-shade-protocol.ts). */
const SHADE_ALPHA_BY_RGB = alphaByRgb(WHP_SHADE_CATEGORIES);
/** The Wildfire 3D archive drape's own shading (src/layers/whp-3d.ts). */
export const WHP_3D_SHADE_ALPHA_BY_RGB = alphaByRgb(WHP_3D_SHADE_CATEGORIES);

/** Recolor only known issuer classes. Keep missing pixels transparent. */
export function shadeWhpPixels(pixels: Uint8ClampedArray, shade: ShadeAlphaByRgb = SHADE_ALPHA_BY_RGB): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const rgb = (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
    const opacity = shade.get(rgb);
    if (opacity === undefined) throw new Error('Unrecognized WHP class');
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = Math.round(pixels[offset + 3]! * opacity);
  }
}

export async function shadeImage(blob: Blob, signal: AbortSignal, shade?: ShadeAlphaByRgb): Promise<ImageBitmap> {
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
    shadeWhpPixels(image.data, shade);
    signal.throwIfAborted();
    return createImageBitmap(image);
  } finally {
    bitmap.close();
  }
}

/** Keep archive bounds/zooms in TileJSON; shade only requested image tiles. */
export const loadWhpShade: AddProtocolAction = async (request, abortController) => {
    const signal = abortController.signal;
    const stopTimeout = listeningTimeout(PMTILES_READ_TIMEOUT_MS, () => abortController.abort(new DOMException('PMTiles read timed out', 'TimeoutError')));
    try {
      const response = await pmtilesTransport.tilev4({
        ...request,
        url: request.url.replace(/^whp-shade:\/\//, 'pmtiles://')
      }, abortController);
      signal.throwIfAborted();
      if (request.type === 'json') {
        return { data: { ...response.data as object, tiles: [`${request.url}/{z}/{x}/{y}`] } };
      }
      // Missing WHP coverage is transparent. MapLibre completes an empty image
      // buffer as a transparent pixel, whereas null leaves its image pending.
      if (response.data === null) return { data: new ArrayBuffer(0) };
      if (!(response.data instanceof Uint8Array)) return { data: response.data };
      return { data: await shadeImage(new Blob([response.data.slice()]), signal, WHP_3D_SHADE_ALPHA_BY_RGB) };
    } finally {
      stopTimeout();
    }
};

/** The published archive stays intact; decode and shade only requested tiles. */
export function registerWhpShadeProtocol(): void {
  if (registered) return;
  addProtocol('whp-shade', loadWhpShade);
  registered = true;
}
