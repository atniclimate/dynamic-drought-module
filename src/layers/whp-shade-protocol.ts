import { addProtocol, type AddProtocolAction } from 'maplibre-gl';
import type { Position } from 'geojson';
import { pmtilesTransport, PMTILES_READ_TIMEOUT_MS } from '../map/tile-protocol';
import { WHP_3D_SHADE_CATEGORIES, WHP_SHADE_CATEGORIES } from '../config/whp-shade';
import { FIRE3D_TERRAIN_COVERAGE } from '../config/terrain-coverage';
import { listeningTimeout } from '../util/listening-timeout';
import { tilePolygonMask } from '../util/tile-polygon-mask';

let registered = false;
/**
 * The fire perimeters on the map (GeoJSON polygon coordinates), kept current
 * by src/layers/whp-3d.ts: the Wildfire 3D drape draws no fuel risk inside
 * one (owner, 2026-10-11). Read when a tile is shaded, so a tile still on
 * its way is cut to the newest set. The flat view's shading never reads them.
 */
let perimeters: readonly Position[][][] = [];
export function setWhpShadePerimeters(polygons: readonly Position[][][]): void {
  perimeters = polygons;
}

type ShadeAlphaByRgb = ReadonlyMap<number, number>;
const alphaByRgb = (categories: typeof WHP_SHADE_CATEGORIES): ShadeAlphaByRgb => new Map(categories.map((category) => [
  Number.parseInt(category.color.slice(1), 16), category.opacity
]));
/** The flat view's shading on terrain (src/layers/whp-image-shade-protocol.ts). */
const SHADE_ALPHA_BY_RGB = alphaByRgb(WHP_SHADE_CATEGORIES);
/** The Wildfire 3D archive drape's own shading (src/layers/whp-3d.ts). */
export const WHP_3D_SHADE_ALPHA_BY_RGB = alphaByRgb(WHP_3D_SHADE_CATEGORIES);

/** The live ImageServer paints its NoData (value 255: ocean, Canada, Mexico, interior gaps) opaque black although its PNG tRNS names (253,253,253); black is no issuer class (probed 2026-10-19), so it is missing coverage. */
const ISSUER_NO_DATA_RGB = 0x000000;
const rgbAt = (pixels: Uint8ClampedArray, offset: number): number =>
  (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;

/** Recolor only known issuer classes. Keep missing pixels (transparent, or the issuer's opaque-black NoData) transparent, and clear each pixel by the share of it `mask` gives (one byte each, 255 for all of it). */
export function shadeWhpPixels(pixels: Uint8ClampedArray, shade: ShadeAlphaByRgb = SHADE_ALPHA_BY_RGB, mask?: Uint8ClampedArray | null): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const rgb = rgbAt(pixels, offset);
    if (rgb === ISSUER_NO_DATA_RGB) { pixels[offset + 3] = 0; continue; }
    const opacity = shade.get(rgb);
    if (opacity === undefined) throw new Error('Unrecognized WHP class');
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = Math.round(pixels[offset + 3]! * opacity * (1 - (mask?.[offset >> 2] ?? 0) / 255));
  }
}

/** The issuer-colours row: keep every colour as the issuer drew it and clear only its opaque-black NoData. */
export function clearWhpNoData(pixels: Uint8ClampedArray): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (rgbAt(pixels, offset) === ISSUER_NO_DATA_RGB) pixels[offset + 3] = 0;
  }
}

type Bounds = { readonly west: number; readonly south: number; readonly east: number; readonly north: number };
/** The WHP archive's header box, the terrain's own: the bake exported whole edge tiles, so pixels past it are tile padding, not fuel risk. */
let bounds: Bounds = FIRE3D_TERRAIN_COVERAGE;
export function setWhpShadeBounds(box: Bounds): void {
  bounds = box;
}

/** Make transparent every pixel whose centre lies outside `box`. Clears only; the colours and classes stay as they were. `tile` is z, x, y; `size` its width in pixels. */
export function clearWhpOutsideBounds(pixels: Uint8ClampedArray, [z, x, y]: readonly number[], size: number, box: Bounds = bounds): void {
  const tiles = 2 ** z;
  const outsideLon = Array.from({ length: size }, (_, px) => {
    const lon = ((x! + (px + 0.5) / size) / tiles) * 360 - 180;
    return lon < box.west || lon > box.east;
  });
  for (let py = 0; py < size; py += 1) {
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y! + (py + 0.5) / size)) / tiles))) * 180) / Math.PI;
    const rowOutside = lat < box.south || lat > box.north;
    for (let px = 0; px < size; px += 1) {
      if (rowOutside || outsideLon[px]) pixels[(py * size + px) * 4 + 3] = 0;
    }
  }
}

/** `tile` is the drape tile's own z, x, y: only then are the fire perimeters cut out of it and the pixels beyond the archive's box cleared. `shade` is a class table, or a pixel function that replaces the shading (the issuer-colours row's `clearWhpNoData`). */
export async function shadeImage(blob: Blob, signal: AbortSignal, shade?: ShadeAlphaByRgb | ((pixels: Uint8ClampedArray) => void), tile?: readonly number[]): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none'
  });
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!context) throw new Error('WHP canvas unavailable');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    // Archive tiles are square, so the bitmap's width is the tile's pixel size.
    if (typeof shade === 'function') shade(image.data);
    else shadeWhpPixels(image.data, shade, tile && tilePolygonMask(perimeters, tile, bitmap.width));
    if (tile) clearWhpOutsideBounds(image.data, tile, bitmap.width);
    signal.throwIfAborted();
    return createImageBitmap(image);
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
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
      return { data: await shadeImage(new Blob([response.data.slice()]), signal, WHP_3D_SHADE_ALPHA_BY_RGB,
        request.url.split('/').slice(-3).map(Number)) };
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
