import type { AddProtocolAction } from 'maplibre-gl';
import { fetchBufferedWithBudget } from '../util/fetch';

/**
 * The guard between NOAA's GeoColor image service and the map.
 *
 * The service has answered tile requests, correctly pinned ones included,
 * with a two-level black and white placeholder image instead of imagery
 * (seen 2026-11-11). It arrives as a valid 256 by 256 PNG or JPEG with HTTP
 * 200, so neither the status nor the envelope gives it away. Every satellite
 * tile therefore comes through this protocol: the bytes are read whole under
 * a budget, decoded, and a placeholder is answered with a transparent tile
 * (the plain map shows through) and reported, so the frame that served it
 * can be dropped. The frame probe in src/map/satellite.ts applies the same
 * check before a frame is ever installed.
 */

export const SATELLITE_TILE_SCHEME = 'satellite-guard';
const TILE_TIMEOUT_MS = 15_000;

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, four bytes a pixel, not premultiplied. */
  readonly data: Uint8ClampedArray | Uint8Array;
}

export type ImageDecoder = (
  bytes: ArrayBuffer,
  contentType: string,
  signal: AbortSignal
) => Promise<DecodedImage>;

/** A PNG or JPEG by both its declared type and its signature. An ArcGIS error envelope (JSON or HTML with HTTP 200) fails here. */
export function isSupportedRaster(contentType: string, bytes: Uint8Array): boolean {
  if (contentType.startsWith('image/png')) {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  }
  if (contentType.startsWith('image/jpeg')) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
}

/** A grey with every channel at or below this is near black. */
const NEAR_BLACK = 40;
/** A grey with every channel at or above this is near white. */
const NEAR_WHITE = 215;
/** Channels this close together read as grey; tinted dark ocean or cloud is not grey. */
const GREY_SPREAD = 24;
/** Each level must hold at least this share of the opaque pixels. */
const MIN_LEVEL_SHARE = 0.05;
/** Tones between the two levels (JPEG edges included) may hold at most this share. */
const MAX_BETWEEN_SHARE = 0.03;

/**
 * True for the placeholder image: nearly every opaque pixel is a near-black
 * or near-white grey, both levels are present, and almost nothing lies
 * between. Imagery has tone between its darkest and brightest parts (cloud
 * edges, coasts, terrain, the tinted night ocean), so it fails the last test.
 * A transparent, uniform or one-level tile is not a placeholder here; the
 * probe rejects blank and uniform frames on its own.
 */
export function isPlaceholderImage(image: DecodedImage): boolean {
  const pixels = image.data;
  let opaque = 0;
  let dark = 0;
  let light = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    opaque++;
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    const low = Math.min(r, g, b);
    const high = Math.max(r, g, b);
    if (high - low > GREY_SPREAD) continue;
    if (high <= NEAR_BLACK) dark++;
    else if (low >= NEAR_WHITE) light++;
  }
  if (opaque === 0) return false;
  return (
    dark >= opaque * MIN_LEVEL_SHARE &&
    light >= opaque * MIN_LEVEL_SHARE &&
    opaque - dark - light <= opaque * MAX_BETWEEN_SHARE
  );
}

/** Decode in the page: an image bitmap drawn once to a canvas at full size, so a fine pattern is not averaged into grey. */
export const decodeImage: ImageDecoder = async (bytes, contentType, signal) => {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  });
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Satellite image could not be inspected.');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data };
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
};

/**
 * The `satellite-guard://<https url>` tile loader. `onTile` hears every tile
 * that reached the map, with whether it was a placeholder; a cancelled or
 * superseded request never reaches it. A failed fetch, a non-image body or
 * an undecodable image is a tile error (the frame's `unavailable` path),
 * never an empty tile.
 */
export function satelliteTileAction(
  onTile: (url: string, placeholder: boolean) => void,
  decode: ImageDecoder = decodeImage,
  timeoutMs = TILE_TIMEOUT_MS
): AddProtocolAction {
  return async (request, abortController) => {
    const signal = abortController.signal;
    const url = request.url.slice(`${SATELLITE_TILE_SCHEME}://`.length);
    const response = await fetchBufferedWithBudget(url, { credentials: 'omit' }, signal, timeoutMs);
    if (!response.ok) throw new Error(`Satellite tile HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const data = await response.arrayBuffer();
    if (!isSupportedRaster(contentType, new Uint8Array(data))) {
      throw new Error('Satellite tile is not a supported raster image.');
    }
    const placeholder = isPlaceholderImage(await decode(data, contentType, signal));
    signal.throwIfAborted();
    onTile(url, placeholder);
    // MapLibre completes an empty image buffer as a transparent tile.
    return { data: placeholder ? new ArrayBuffer(0) : data };
  };
}
