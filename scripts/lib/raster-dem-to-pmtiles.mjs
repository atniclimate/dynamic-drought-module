import { PNG } from 'pngjs';
import { fromFile } from 'geotiff';
import { zxyToTileId } from './pmtiles-writer.mjs';

const WEB_MERCATOR_MAX_LAT = 85.0511287798066;
const DEM_NODATA_FLOOR = -100000;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Local mirror handle; callers own close(), including failed tile work. */
export async function openLocalDem(path, signal) {
  signal?.throwIfAborted();
  const tiff = await fromFile(path, signal);
  try {
    const image = await tiff.getImage();
    const keys = image.getGeoKeys();
    // Selected 3DEP local mirror is NAD83 geographic (EPSG4269). WGS84
    // geographic fixtures/declared local mirrors are also supported; this
    // degree-window path performs no projected-CRS or datum transformation.
    if (keys?.GTModelTypeGeoKey !== 2 || ![4269,4326].includes(keys.GeographicTypeGeoKey) ||
        (keys.ProjectedCSTypeGeoKey !== undefined && keys.ProjectedCSTypeGeoKey !== 32767)) {
      throw Error('Local DEM requires supported geographic GeoKeys');
    }
    signal?.throwIfAborted();
    return { image, bounds: image.getBoundingBox(), nodata: image.getGDALNoData(),
      close: () => tiff.close() };
  } catch (error) { try { await tiff.close(); } catch { /* Preserve the original read/abort failure. */ } throw error; }
}

/** GeoTIFFImage takes a pixel window, not a geographic bbox. North-up DEMs only. */
export async function readDemWindow(image, { bbox, width, height, nodata, signal }) {
  signal?.throwIfAborted();
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
      bbox[0] >= bbox[2] || bbox[1] >= bbox[3] ||
      ![width,height].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid DEM window');
  const origin = image.getOrigin(), resolution = image.getResolution();
  const transform = image.getFileDirectory?.().getValue('ModelTransformation');
  if (transform || ![origin[0],origin[1],resolution[0],resolution[1]].every(Number.isFinite) ||
      resolution[0] <= 0 || resolution[1] >= 0) throw Error('DEM must use north-up pixel-scale georeferencing');
  const sourceBounds = [origin[0],origin[1]+resolution[1]*image.getHeight(),
    origin[0]+resolution[0]*image.getWidth(),origin[1]];
  if (bbox[0]<sourceBounds[0] || bbox[1]<sourceBounds[1] || bbox[2]>sourceBounds[2] || bbox[3]>sourceBounds[3]) {
    throw Error('DEM window outside source; caller must intersect its footprint first');
  }
  const window = [Math.floor((bbox[0]-origin[0])/resolution[0]),
    Math.floor((bbox[3]-origin[1])/resolution[1]),
    Math.ceil((bbox[2]-origin[0])/resolution[0]),
    Math.ceil((bbox[1]-origin[1])/resolution[1])];
  window[0]=clamp(window[0],0,image.getWidth()); window[2]=clamp(window[2],0,image.getWidth());
  window[1]=clamp(window[1],0,image.getHeight()); window[3]=clamp(window[3],0,image.getHeight());
  if(window[0]>=window[2] || window[1]>=window[3]) throw Error('DEM window outside source');
  // Read native pixels, zero the no-data cells, then resample: geotiff.js would blend no-data into coast cells.
  const raw = await image.readRasters({window,samples:[0],signal});
  signal?.throwIfAborted();
  const src = raw[0], inWidth = raw.width, inHeight = raw.height;
  for (let i = 0; i < src.length; i++) if (src[i] === nodata) src[i] = 0;
  // Same bilinear as geotiff.js, so valid cells resample exactly as before.
  const out = new Float32Array(width * height);
  const lerp = (a, b, t) => (1 - t) * a + t * b;
  for (let y = 0; y < height; y++) {
    const rawY = (inHeight / height) * y, yl = Math.floor(rawY), yh = Math.min(Math.ceil(rawY), inHeight - 1);
    for (let x = 0; x < width; x++) {
      const rawX = (inWidth / width) * x, xl = Math.floor(rawX), xh = Math.min(Math.ceil(rawX), inWidth - 1);
      out[y * width + x] = lerp(lerp(src[yl*inWidth+xl], src[yl*inWidth+xh], rawX % 1),
        lerp(src[yh*inWidth+xl], src[yh*inWidth+xh], rawX % 1), rawY % 1);
    }
  }
  return [out];
}

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z);
}

function lonToGlobalPixel(lon, z, tileSize) {
  return ((lon + 180) / 360) * 2 ** z * tileSize;
}

function latToGlobalPixel(lat, z, tileSize) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z * tileSize;
}

function globalPixelToLon(px, z, tileSize) {
  return (px / (2 ** z * tileSize)) * 360 - 180;
}

function globalPixelToLat(py, z, tileSize) {
  const n = Math.PI - (2 * Math.PI * py) / (2 ** z * tileSize);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = globalPixelToLat(y * 256, z, 256);
  const south = globalPixelToLat((y + 1) * 256, z, 256);
  return [west, south, east, north];
}

export function tileRangeForBounds(bounds, z) {
  const n = 2 ** z - 1;
  const minLon = clamp(bounds[0], -180, 180);
  const minLat = clamp(bounds[1], -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const maxLon = clamp(bounds[2], -180, 180);
  const maxLat = clamp(bounds[3], -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  return {
    xMin: clamp(lonToTileX(minLon, z), 0, n),
    xMax: clamp(lonToTileX(maxLon, z), 0, n),
    yMin: clamp(latToTileY(maxLat, z), 0, n),
    yMax: clamp(latToTileY(minLat, z), 0, n)
  };
}

function intersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function terrariumPng(elevations, width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < elevations.length; i++) {
    const value = Number.isFinite(elevations[i]) ? Math.round(elevations[i]) : 0;
    const encoded = clamp(Math.round((value + 32768) * 256), 0, 16777215);
    const o = i * 4;
    png.data[o] = Math.floor(encoded / 65536);
    png.data[o + 1] = Math.floor(encoded / 256) & 255;
    png.data[o + 2] = encoded & 255;
    png.data[o + 3] = 255;
  }
  const candidates = [-1, 2, 4];
  let best = null;
  let bestFilterType = null;
  for (const filterType of candidates) {
    const data = PNG.sync.write(png, {
      colorType: 6,
      inputColorType: 6,
      deflateLevel: 9,
      deflateStrategy: 3,
      filterType
    });
    if (!best || data.length < best.length) {
      best = data;
      bestFilterType = filterType;
    }
  }
  return { data: best, filterType: bestFilterType };
}

function decodeTerrariumPixel(png, pixelIndex) {
  const o = pixelIndex * 4;
  return png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
}

function normalizeElevation(v) {
  if (!Number.isFinite(v) || v <= DEM_NODATA_FLOOR) return 0;
  return clamp(v, -32768, 32767);
}

async function fillFromSourceTile(out, { z, x, y, tileSize, bounds }, source) {
  if (!intersects(bounds, source.bounds)) return false;

  const west = Math.max(bounds[0], source.bounds[0]);
  const south = Math.max(bounds[1], source.bounds[1]);
  const east = Math.min(bounds[2], source.bounds[2]);
  const north = Math.min(bounds[3], source.bounds[3]);

  const tileOriginX = x * tileSize;
  const tileOriginY = y * tileSize;
  const colStart = clamp(Math.floor(lonToGlobalPixel(west, z, tileSize) - tileOriginX), 0, tileSize - 1);
  const colEnd = clamp(Math.ceil(lonToGlobalPixel(east, z, tileSize) - tileOriginX), colStart + 1, tileSize);
  const rowStart = clamp(Math.floor(latToGlobalPixel(north, z, tileSize) - tileOriginY), 0, tileSize - 1);
  const rowEnd = clamp(Math.ceil(latToGlobalPixel(south, z, tileSize) - tileOriginY), rowStart + 1, tileSize);
  const width = colEnd - colStart;
  const height = rowEnd - rowStart;
  if (width <= 0 || height <= 0) return false;

  const readWest = Math.max(globalPixelToLon(tileOriginX + colStart, z, tileSize), source.bounds[0]);
  const readEast = Math.min(globalPixelToLon(tileOriginX + colEnd, z, tileSize), source.bounds[2]);
  const readNorth = Math.min(globalPixelToLat(tileOriginY + rowStart, z, tileSize), source.bounds[3]);
  const readSouth = Math.max(globalPixelToLat(tileOriginY + rowEnd, z, tileSize), source.bounds[1]);
  if (readWest >= readEast || readSouth >= readNorth) return false;

  const rasters = await readDemWindow(source.image, {
    bbox: [readWest, readSouth, readEast, readNorth],
    width,
    height,
    nodata: source.nodata
  });
  const band = rasters[0];
  for (let row = 0; row < height; row++) {
    const outOffset = (rowStart + row) * tileSize + colStart;
    const inOffset = row * width;
    for (let col = 0; col < width; col++) {
      out[outOffset + col] = normalizeElevation(band[inOffset + col]);
    }
  }
  return true;
}

/** Local-only national bake seam. Pool supplies an explicit ordered source plan.
 * Degree-window floor/ceil and bilinear resampling are the existing approximate
 * sampling method, not exact reprojection or a datum conversion.
 */
export async function renderLocalDemTile(job, {maxSourcePixels,maxTileBytes}) {
  const tileSize=512,bounds=tileBounds(job.z,job.x,job.y);
  const elevations=new Float32Array(tileSize*tileSize);
  let filledSources=0;
  if(job.kind!=='ocean'){
    for(const receipt of job.sources){
      const source=await openLocalDem(receipt.path);
      let failed=false;
      try{
        const pixels=source.image.getWidth()*source.image.getHeight();
        if(!Number.isSafeInteger(pixels)||pixels>maxSourcePixels)throw Error('Local DEM source pixel allowance');
        if(await fillFromSourceTile(elevations,{z:job.z,x:job.x,y:job.y,tileSize,bounds},
          source))filledSources++;
      }catch(error){failed=true;throw error;}
      finally{try{await source.close();}catch(error){if(!failed)throw error;}}
    }
  }
  if(job.kind==='land'&&filledSources===0)throw Error('Land tile has no intersecting source');
  const data=terrariumPng(elevations,tileSize,tileSize).data;
  if(data.length>maxTileBytes)throw Error('Local DEM encoded tile allowance');
  return {tileId:zxyToTileId(job.z,job.x,job.y),data};
}

/** Returns receipt-backed records for writeTerrainPmtiles; never an archive-sized buffer. */
export async function buildRasterDemTileStore(options) {
  const {buildLocalTerrainStore}=await import('./terrain-local-pool.mjs');
  return buildLocalTerrainStore(options);
}

export function decodeTerrariumTile(buffer) {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { png, elevationAtIndex: (i) => decodeTerrariumPixel(png, i) };
}
