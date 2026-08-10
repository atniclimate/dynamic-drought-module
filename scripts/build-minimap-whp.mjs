/**
 * Build the compact Wildfire Hazard Potential (WHP) summary used by the
 * North America framing minimap.
 *
 * This is an intentionally approximate overview. Each official 2023 raster
 * catalog member is requested as a nearest-neighbor EPSG:4326 GeoTIFF. Pixel
 * centers inside the existing ATNI-authored framing analysis shapes receive a
 * cosine-of-latitude weight. That corrects the area change across a regular
 * geographic grid without presenting the result as an exact zonal statistic.
 *
 * The generated artifact contains aggregate shares and a reproducibility
 * receipt only. It does not redistribute the source raster or any sovereign
 * geometry.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fromArrayBuffer } from 'geotiff';
import { PNG } from 'pngjs';
import { transformWithOxc } from 'vite';

const SERVICE =
  'https://imagery.geoplatform.gov/iipp/rest/services/' +
  'Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/' +
  'ImageServer';
const OUTPUT_PATH = fileURLToPath(
  new URL('../src/config/minimap-whp.ts', import.meta.url),
);
const SHAPES_PATH = fileURLToPath(
  new URL('../src/config/framing-shapes.ts', import.meta.url),
);
const REQUEST_TIMEOUT_MS = 30_000;
const MAINLAND_STEP_DEGREES = 0.05;
const HAWAII_STEP_DEGREES = 0.01;

const EXPECTED_MEMBERS = new Map([
  [1, 'whp2023_cls_hi'],
  [2, 'whp2023_cls_ak'],
  [3, 'whp2023_cls_conus'],
]);

const EXPECTED_PALETTE = [
  { value: 1, label: 'Very Low', rgba: [56, 163, 0, 255] },
  { value: 2, label: 'Low', rgba: [163, 255, 148, 255] },
  { value: 3, label: 'Moderate', rgba: [255, 255, 99, 255] },
  { value: 4, label: 'High', rgba: [255, 163, 0, 255] },
  { value: 5, label: 'Very High', rgba: [237, 30, 0, 255] },
  { value: 6, label: 'Non-burnable', rgba: [225, 225, 225, 255] },
  { value: 7, label: 'Water', rgba: [0, 112, 225, 255] },
];

const FRAMING_SOURCE = {
  'alaska-northwest': { memberId: 2, coverage: 'live-partial' },
  'boreal-arctic': { memberId: null, coverage: 'no-data' },
  'pacific-coast': { memberId: 3, coverage: 'live-partial' },
  'arid-west': { memberId: 3, coverage: 'live' },
  'plains-prairies': { memberId: 3, coverage: 'live-partial' },
  'eastern-forests': { memberId: 3, coverage: 'live-partial' },
  'southeast-gulf': { memberId: 3, coverage: 'live' },
  mexico: { memberId: null, coverage: 'no-data' },
  hawaii: { memberId: 1, coverage: 'live' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function consumeWithTimeout(url, init, label, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}.`);
    }
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, init, label) {
  const value = await consumeWithTimeout(
    url,
    init,
    label,
    async (response) => {
      const contentType = response.headers.get('content-type') ?? '';
      assert(
        contentType.includes('json') || contentType.includes('text/plain'),
        `${label} returned unexpected content type ${contentType || '(missing)'}.`,
      );
      return response.json();
    },
  );
  if (value && typeof value === 'object' && 'error' in value) {
    throw new Error(`${label} returned an ArcGIS error envelope.`);
  }
  return value;
}

async function loadFramingShapes() {
  const source = await readFile(SHAPES_PATH, 'utf8');
  const transpiled = await transformWithOxc(source, SHAPES_PATH, {
    lang: 'ts',
  });
  const encoded = Buffer.from(transpiled.code).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

async function validateCatalog() {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,Name',
    returnGeometry: 'false',
    f: 'json',
  });
  const value = await fetchJson(
    `${SERVICE}/query?${params}`,
    undefined,
    'WHP raster catalog',
  );
  assert(Array.isArray(value.features), 'WHP raster catalog has no features.');
  const observed = new Map(
    value.features.map((feature) => [
      Number(feature?.attributes?.objectid),
      String(feature?.attributes?.name ?? ''),
    ]),
  );
  assert(
    observed.size === EXPECTED_MEMBERS.size,
    `WHP raster catalog has ${observed.size} members; expected 3.`,
  );
  for (const [id, name] of EXPECTED_MEMBERS) {
    assert(
      observed.get(id) === name,
      `WHP raster ${id} is ${observed.get(id) ?? '(missing)'}, expected ${name}.`,
    );
  }
}

function legendCenterRgba(imageData) {
  const png = PNG.sync.read(Buffer.from(imageData, 'base64'));
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const offset = (y * png.width + x) * 4;
  return Array.from(png.data.subarray(offset, offset + 4));
}

async function validatePalette() {
  const value = await fetchJson(
    `${SERVICE}/legend?f=json`,
    undefined,
    'WHP legend',
  );
  const legend = value.layers?.[0]?.legend;
  assert(Array.isArray(legend), 'WHP legend has no class entries.');
  assert(
    legend.length === EXPECTED_PALETTE.length,
    `WHP legend has ${legend.length} classes; expected 7.`,
  );
  EXPECTED_PALETTE.forEach((expected, index) => {
    const item = legend[index];
    assert(
      item?.label === expected.label,
      `WHP class ${expected.value} label changed from ${expected.label}.`,
    );
    const rgba = legendCenterRgba(String(item.imageData ?? ''));
    assert(
      rgba.every((channel, channelIndex) => channel === expected.rgba[channelIndex]),
      `WHP class ${expected.value} palette changed to ${rgba.join(',')}.`,
    );
  });
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const a = ring[index];
    const b = ring[previous];
    const straddles = a[1] > latitude !== b[1] > latitude;
    if (
      straddles &&
      longitude <
        ((b[0] - a[0]) * (latitude - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function intersectionAtLongitude(a, b, longitude) {
  const fraction = (longitude - a[0]) / (b[0] - a[0]);
  return [longitude, a[1] + (b[1] - a[1]) * fraction];
}

function clipLongitude(ring, boundary, keepWest) {
  const output = [];
  const isInside = (point) =>
    keepWest ? point[0] <= boundary : point[0] >= boundary;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const previous = ring[(index + ring.length - 1) % ring.length];
    const currentInside = isInside(current);
    const previousInside = isInside(previous);
    if (currentInside) {
      if (!previousInside) {
        output.push(intersectionAtLongitude(previous, current, boundary));
      }
      output.push(current);
    } else if (previousInside) {
      output.push(intersectionAtLongitude(previous, current, boundary));
    }
  }
  return output;
}

function conventionalPieces(ring) {
  const west = Math.min(...ring.map((point) => point[0]));
  const east = Math.max(...ring.map((point) => point[0]));
  if (west >= -180) return [ring];
  if (east <= -180) {
    return [ring.map(([longitude, latitude]) => [longitude + 360, latitude])];
  }
  const western = clipLongitude(ring, -180, true).map(
    ([longitude, latitude]) => [longitude + 360, latitude],
  );
  const eastern = clipLongitude(ring, -180, false);
  return [western, eastern].filter((piece) => piece.length >= 3);
}

function boundsForRings(rings) {
  const points = rings.flat();
  return {
    west: Math.min(...points.map((point) => point[0])),
    south: Math.min(...points.map((point) => point[1])),
    east: Math.max(...points.map((point) => point[0])),
    north: Math.max(...points.map((point) => point[1])),
  };
}

function requestGroups(rings) {
  const pieces = rings.flatMap(conventionalPieces);
  const groups = new Map();
  for (const piece of pieces) {
    const key = piece.every((point) => point[0] >= 0) ? 'wrapped' : 'main';
    const group = groups.get(key) ?? [];
    group.push(piece);
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function exportGeographicTiff(memberId, rings, step) {
  const bounds = boundsForRings(rings);
  const width = Math.max(1, Math.ceil((bounds.east - bounds.west) / step));
  const height = Math.max(1, Math.ceil((bounds.north - bounds.south) / step));
  assert(width <= 4096 && height <= 4096, 'WHP sampling image exceeds 4096 px.');
  const params = new URLSearchParams({
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north].join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${width},${height}`,
    format: 'tiff',
    pixelType: 'U8',
    interpolation: 'RSP_NearestNeighbor',
    mosaicRule: JSON.stringify({
      mosaicMethod: 'esriMosaicLockRaster',
      lockRasterIds: [String(memberId)],
    }),
    f: 'image',
  });
  const bytes = await consumeWithTimeout(
    `${SERVICE}/exportImage?${params}`,
    undefined,
    `WHP raster ${memberId} sample`,
    async (response) => {
      const contentType = response.headers.get('content-type') ?? '';
      assert(
        contentType.includes('tiff'),
        `WHP raster ${memberId} returned ${
          contentType || '(missing type)'
        }.`,
      );
      return response.arrayBuffer();
    },
  );
  const magic = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  assert(
    magic.length === 4 && magic[0] === 73 && magic[1] === 73 && magic[2] === 42,
    `WHP raster ${memberId} did not return a little-endian TIFF.`,
  );
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  assert(image.getSamplesPerPixel() === 1, 'WHP sample TIFF is not single-band.');
  assert(
    image.getWidth() === width && image.getHeight() === height,
    'WHP sample TIFF dimensions do not match the request.',
  );
  const origin = image.getOrigin();
  const resolution = image.getResolution();
  const raster = await image.readRasters({ interleave: true });
  assert(raster instanceof Uint8Array, 'WHP sample TIFF is not unsigned 8-bit.');
  return { bounds, width, height, origin, resolution, raster, rings };
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

async function summarizeFraming(memberId, rings, step) {
  const weighted = Array(8).fill(0);
  const counts = Array(8).fill(0);
  let noDataSamples = 0;
  for (const group of requestGroups(rings)) {
    const sample = await exportGeographicTiff(memberId, group, step);
    const [originX, originY] = sample.origin;
    const [resolutionX, resolutionY] = sample.resolution;
    for (let row = 0; row < sample.height; row++) {
      const latitude = originY + (row + 0.5) * resolutionY;
      const latitudeWeight = Math.cos((latitude * Math.PI) / 180);
      for (let column = 0; column < sample.width; column++) {
        const longitude = originX + (column + 0.5) * resolutionX;
        if (!group.some((ring) => pointInRing(longitude, latitude, ring))) {
          continue;
        }
        const value = sample.raster[row * sample.width + column];
        if (value === 255) {
          noDataSamples++;
          continue;
        }
        assert(
          Number.isInteger(value) && value >= 1 && value <= 7,
          `WHP raster returned unknown class ${String(value)}.`,
        );
        counts[value] += 1;
        weighted[value] += latitudeWeight;
      }
    }
  }
  const landWeight = weighted.slice(1, 7).reduce((sum, value) => sum + value, 0);
  assert(landWeight > 0, `WHP raster ${memberId} produced no land samples.`);
  const highOrVeryHigh = weighted[4] + weighted[5];
  const moderateOrHigher = weighted[3] + highOrVeryHigh;
  return {
    highOrVeryHighPercent: round((highOrVeryHigh / landWeight) * 100, 3),
    moderateOrHigherPercent: round((moderateOrHigher / landWeight) * 100, 3),
    landSamples: counts.slice(1, 7).reduce((sum, value) => sum + value, 0),
    waterSamplesExcluded: counts[7],
    noDataSamples,
  };
}

function generatedSource(artifact) {
  const serializedArtifact = JSON.stringify(artifact, null, 2).replace(
    '    "qualification":',
    '    // vocab-allow: honesty disclaimer denying that static WHP is a forecast\n    "qualification":',
  );
  return `/**\n` +
    ` * Generated by scripts/build-minimap-whp.mjs.\n` +
    ` *\n` +
    ` * Compact, approximate area-weighted overview of the official 2023\n` +
    ` * United States Forest Service Wildfire Hazard Potential rasters. This\n` +
    ` * is static strategic context, not current fire conditions or a forecast.\n` +
    ` * Re-run the generator to update; do not hand-edit the values.\n` +
    ` */\n\n` +
    `import type { FramingKey } from './framings';\n\n` +
    `export type MinimapWhpCoverage = 'live' | 'live-partial' | 'no-data';\n\n` +
    `export interface MinimapWhpFramingSummary {\n` +
    `  readonly coverage: MinimapWhpCoverage;\n` +
    `  readonly highOrVeryHighPercent: number | null;\n` +
    `  readonly moderateOrHigherPercent: number | null;\n` +
    `  readonly landSamples: number;\n` +
    `  readonly waterSamplesExcluded: number;\n` +
    `  readonly noDataSamples: number;\n` +
    `}\n\n` +
    `export interface MinimapWhpArtifact {\n` +
    `  readonly schemaVersion: 1;\n` +
    `  readonly source: Readonly<Record<string, unknown>>;\n` +
    `  readonly method: Readonly<Record<string, unknown>>;\n` +
    `  readonly framings: Readonly<Record<FramingKey, MinimapWhpFramingSummary>>;\n` +
    `}\n\n` +
    `export const MINIMAP_WHP = ${serializedArtifact} as const satisfies MinimapWhpArtifact;\n`;
}

async function main() {
  const shapes = await loadFramingShapes();
  await Promise.all([validateCatalog(), validatePalette()]);

  const framings = {};
  for (const [key, source] of Object.entries(FRAMING_SOURCE)) {
    if (source.memberId === null) {
      framings[key] = {
        coverage: source.coverage,
        highOrVeryHighPercent: null,
        moderateOrHigherPercent: null,
        landSamples: 0,
        waterSamplesExcluded: 0,
        noDataSamples: 0,
      };
      continue;
    }
    const areas =
      key === 'hawaii'
        ? shapes.HAWAII_ISLAND_SHAPES
        : (shapes.FRAMING_ANALYSIS_AREAS[key]?.map((area) => area.shape) ?? [
            shapes.FRAMING_SHAPES[key],
          ]);
    const summary = await summarizeFraming(
      source.memberId,
      areas,
      key === 'hawaii' ? HAWAII_STEP_DEGREES : MAINLAND_STEP_DEGREES,
    );
    framings[key] = { coverage: source.coverage, ...summary };
  }

  const artifact = {
    schemaVersion: 1,
    source: {
      organization: 'United States Forest Service',
      product: 'Wildfire Hazard Potential for the United States',
      edition: '2023, 4th edition, updated 2024-07-17',
      doi: '10.2737/RDS-2015-0047-4',
      service: SERVICE,
      retrievedUtc: new Date().toISOString(),
      rasterMembers: Object.fromEntries(EXPECTED_MEMBERS),
      landscapeConditions: 'end of 2020',
    },
    method: {
      approximate: true,
      outputCrs: 'EPSG:4326',
      interpolation: 'nearest neighbor',
      mainlandStepDegrees: MAINLAND_STEP_DEGREES,
      hawaiiStepDegrees: HAWAII_STEP_DEGREES,
      areaWeight: 'cosine of pixel-center latitude',
      denominator: 'classes 1 through 6; class 7 water excluded',
      thresholds: {
        highOrVeryHighPercent: 'strictly greater than 50',
        moderateOrHigherPercent: 'strictly greater than 30',
      },
      qualification:
        'Static strategic potential overview, not current fire conditions or a forecast.',
      palette: Object.fromEntries(
        EXPECTED_PALETTE.map((entry) => [
          String(entry.value),
          { label: entry.label, rgba: entry.rgba },
        ]),
      ),
    },
    framings,
  };
  await writeFile(OUTPUT_PATH, generatedSource(artifact), 'utf8');
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

await main();
