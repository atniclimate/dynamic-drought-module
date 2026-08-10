/**
 * Build the compact coastline and lake paths used by the framing minimap.
 *
 * The source is Natural Earth 1:50m physical land and lakes, not an
 * administrative-boundary theme. The generated artifact is presentation
 * geometry only. Existing ATNI-authored framing masks continue to own the
 * navigation vocabulary and internal region lines.
 *
 * The build deliberately removes the complete Greenland land component by a
 * verified interior control point. It never clips the Canadian Arctic with a
 * longitude bound. Six western Aleutian island components are normalized from
 * positive longitudes into the minimap's continuous -188 to -52 drawing plane.
 *
 * Simplification happens in Lambert azimuthal equal-area metres with
 * keep-shapes before coordinates return to WGS 84 for the existing SVG
 * projector. No source download is shipped to the browser.
 *
 * Usage: npm run build:minimap-geometry
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import mapshaper from 'mapshaper';

const NATURAL_EARTH_VERSION = '5.1.2';
const SOURCE_ROOT =
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/` +
  `v${NATURAL_EARTH_VERSION}/geojson`;
const LAND_SOURCE = `${SOURCE_ROOT}/ne_50m_land.geojson`;
const LAKES_SOURCE = `${SOURCE_ROOT}/ne_50m_lakes.geojson`;
const LAND_SHA256 =
  'e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b';
const LAKES_SHA256 =
  'd350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52';

const SOURCE_RETRIEVED = '2026-08-09';
const LICENSE = 'public domain';
const LICENSE_URL = 'https://www.naturalearthdata.com/about/terms-of-use/';

const DRAWING_EXTENT = [-188, 14, -52, 84];
const DRAWING_WIDTH = 660;
const DRAWING_HEIGHT = 348;
const DRAWING_SCALE = DRAWING_WIDTH / (DRAWING_EXTENT[2] - DRAWING_EXTENT[0]);

const SIMPLIFICATION_PROJECTION =
  '+proj=laea +lat_0=45 +lon_0=-100 +datum=WGS84 +units=m';
const SIMPLIFICATION_INTERVAL_METERS = 12_000;
const MIN_ISLAND_AREA_SQUARE_KILOMETERS = 250;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 30_000;

const GREENLAND_CONTROL = [-42, 72];
const GREENLAND_RENDER_CONTROL = [-60, 76];
const GREENLAND_BBOX = [-72.818066, 59.815479, -11.425537, 83.599609];

const EXPECTED_ALEUTIAN_BBOXES = [
  [172.494824, 52.7521, 173.436035, 53.012988],
  [173.402344, 52.356641, 173.776074, 52.504102],
  [177.250293, 51.841064, 177.669629, 52.113818],
  [178.475, 51.899121, 178.607324, 51.994678],
  [178.647949, 51.372217, 179.451563, 51.655957],
  [179.497656, 51.880225, 179.77998, 52.03042],
];

const LAKE_NAMES = [
  'Lake Superior',
  'Lake Michigan',
  'Lake Huron',
  'Lake Erie',
  'Lake Ontario',
  'Lake Winnipeg',
  'Great Slave Lake',
  'Great Bear Lake',
];

const OUT_PATH = fileURLToPath(
  new URL('../src/config/minimap-geometry.ts', import.meta.url),
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFeatureCollection(value, label) {
  invariant(
    isRecord(value) &&
      value.type === 'FeatureCollection' &&
      Array.isArray(value.features),
    `${label} is not a GeoJSON FeatureCollection.`,
  );
  return value;
}

function assertPosition(value, label) {
  invariant(
    Array.isArray(value) &&
      value.length >= 2 &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1]),
    `${label} contains an invalid position.`,
  );
}

function assertRing(value, label) {
  invariant(Array.isArray(value) && value.length >= 4, `${label} is not a ring.`);
  for (const position of value) assertPosition(position, label);
}

function polygonsFromGeometry(geometry, label) {
  invariant(isRecord(geometry), `${label} has no geometry.`);
  if (geometry.type === 'Polygon') {
    invariant(Array.isArray(geometry.coordinates), `${label} has no coordinates.`);
    geometry.coordinates.forEach((ring) => assertRing(ring, label));
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiPolygon') {
    invariant(Array.isArray(geometry.coordinates), `${label} has no coordinates.`);
    for (const polygon of geometry.coordinates) {
      invariant(Array.isArray(polygon), `${label} contains an invalid polygon.`);
      polygon.forEach((ring) => assertRing(ring, label));
    }
    return geometry.coordinates;
  }
  throw new Error(`${label} is not Polygon or MultiPolygon geometry.`);
}

function ringBounds(ring) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const position of ring) {
    bounds[0] = Math.min(bounds[0], position[0]);
    bounds[1] = Math.min(bounds[1], position[1]);
    bounds[2] = Math.max(bounds[2], position[0]);
    bounds[3] = Math.max(bounds[3], position[1]);
  }
  return bounds;
}

function polygonBounds(polygon) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of polygon) {
    const next = ringBounds(ring);
    bounds[0] = Math.min(bounds[0], next[0]);
    bounds[1] = Math.min(bounds[1], next[1]);
    bounds[2] = Math.max(bounds[2], next[2]);
    bounds[3] = Math.max(bounds[3], next[3]);
  }
  return bounds;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index];
    const b = ring[previous];
    const straddles = a[1] > point[1] !== b[1] > point[1];
    if (
      straddles &&
      point[0] <
        ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function sameNumbers(actual, expected, tolerance = 1e-6) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance)
  );
}

function intersectsBounds(a, b) {
  return a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
}

function polygonFeature(polygon, properties = {}) {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: polygon },
  };
}

function shiftPolygonLongitude(polygon, offset) {
  return polygon.map((ring) =>
    ring.map((position) => [position[0] + offset, position[1]]),
  );
}

function isWesternAleutian(bounds) {
  return (
    bounds[0] >= 172 &&
    bounds[2] <= 180 &&
    bounds[1] >= 51 &&
    bounds[3] <= 54
  );
}

function bboxSort(a, b) {
  for (let index = 0; index < 4; index++) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

async function fetchPinned(label, url, expectedSha256) {
  const response = await fetch(url, {
    headers: { Accept: 'application/geo+json, application/json' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS),
  });
  invariant(response.ok, `${label} download failed with HTTP ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  invariant(
    sha256 === expectedSha256,
    `${label} SHA-256 mismatch: expected ${expectedSha256}, received ${sha256}.`,
  );
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  return { bytes: bytes.length, value: assertFeatureCollection(value, label) };
}

function prepareLand(source) {
  const polygons = [];
  for (const [featureIndex, feature] of source.features.entries()) {
    invariant(isRecord(feature), `Natural Earth land feature ${featureIndex} is invalid.`);
    const featurePolygons = polygonsFromGeometry(
      feature.geometry,
      `Natural Earth land feature ${featureIndex}`,
    );
    for (const [polygonIndex, polygon] of featurePolygons.entries()) {
      polygons.push({ featureIndex, polygonIndex, polygon });
    }
  }

  const greenlandMatches = polygons.filter(({ polygon }) =>
    pointInPolygon(GREENLAND_CONTROL, polygon),
  );
  invariant(
    greenlandMatches.length === 1,
    `Expected one Greenland land component, found ${greenlandMatches.length}.`,
  );
  const greenland = greenlandMatches[0];
  const greenlandBounds = polygonBounds(greenland.polygon);
  invariant(
    sameNumbers(greenlandBounds, GREENLAND_BBOX),
    `Greenland bbox changed: received ${greenlandBounds.join(',')}.`,
  );
  invariant(
    pointInPolygon(GREENLAND_RENDER_CONTROL, greenland.polygon),
    'Greenland render control is no longer inside the removed component.',
  );

  const withoutGreenland = polygons.filter((entry) => entry !== greenland);
  const aleutianEntries = withoutGreenland.filter(({ polygon }) =>
    isWesternAleutian(polygonBounds(polygon)),
  );
  const aleutianBounds = aleutianEntries
    .map(({ polygon }) => polygonBounds(polygon))
    .sort(bboxSort);
  const expectedBounds = [...EXPECTED_ALEUTIAN_BBOXES].sort(bboxSort);
  invariant(
    aleutianBounds.length === expectedBounds.length &&
      aleutianBounds.every((bounds, index) =>
        sameNumbers(bounds, expectedBounds[index]),
      ),
    `Western Aleutian component set changed: received ${JSON.stringify(aleutianBounds)}.`,
  );

  const aleutianSet = new Set(aleutianEntries);
  const normalized = withoutGreenland.map((entry) => ({
    ...entry,
    polygon: aleutianSet.has(entry)
      ? shiftPolygonLongitude(entry.polygon, -360)
      : entry.polygon,
  }));
  const candidates = normalized.filter(({ polygon }) =>
    intersectsBounds(polygonBounds(polygon), DRAWING_EXTENT),
  );
  invariant(candidates.length > 0, 'No Natural Earth land intersects the minimap extent.');

  return {
    collection: {
      type: 'FeatureCollection',
      features: candidates.map(({ polygon }) => polygonFeature(polygon)),
    },
    sourceFeatureCount: source.features.length,
    sourcePolygonCount: polygons.length,
    candidatePolygonCount: candidates.length,
    greenlandBounds,
    aleutianBounds,
  };
}

function prepareLakes(source) {
  const byName = new Map();
  for (const [featureIndex, feature] of source.features.entries()) {
    invariant(isRecord(feature), `Natural Earth lake feature ${featureIndex} is invalid.`);
    const name = isRecord(feature.properties) ? feature.properties.name : null;
    if (!LAKE_NAMES.includes(name)) continue;
    invariant(!byName.has(name), `Natural Earth lakes contains duplicate ${name}.`);
    const polygons = polygonsFromGeometry(
      feature.geometry,
      `Natural Earth lake ${name}`,
    );
    byName.set(name, polygons);
  }
  for (const name of LAKE_NAMES) {
    invariant(byName.has(name), `Natural Earth lakes is missing ${name}.`);
  }

  return {
    type: 'FeatureCollection',
    features: LAKE_NAMES.flatMap((name) =>
      byName.get(name).map((polygon) => polygonFeature(polygon, { name })),
    ),
  };
}

function applyMapshaper(label, collection, command) {
  const inputName = `${label}.geojson`;
  const outputName = `${label}-out.geojson`;
  const input = { [inputName]: Buffer.from(JSON.stringify(collection)) };
  const fullCommand = [
    `-i ${inputName} encoding=utf8`,
    `-clip bbox=${DRAWING_EXTENT.join(',')}`,
    `-proj init=wgs84 crs="${SIMPLIFICATION_PROJECTION}"`,
    `-simplify interval=${SIMPLIFICATION_INTERVAL_METERS} keep-shapes`,
    command,
    '-proj crs=wgs84',
    `-o ${outputName} format=geojson geojson-type=FeatureCollection no-null-props precision=0.001`,
  ]
    .filter(Boolean)
    .join(' ');

  return new Promise((resolve, reject) => {
    mapshaper.applyCommands(fullCommand, input, (error, output) => {
      if (error) {
        reject(new Error(`mapshaper failed for ${label}.`, { cause: error }));
        return;
      }
      const text = output[outputName];
      if (!text) {
        reject(new Error(`mapshaper produced no ${label} output.`));
        return;
      }
      try {
        const parsed = assertFeatureCollection(JSON.parse(text), `${label} output`);
        const features = parsed.features.filter((feature, index) => {
          invariant(isRecord(feature), `${label} output feature ${index} is invalid.`);
          invariant(
            feature.geometry === null || isRecord(feature.geometry),
            `${label} output feature ${index} has invalid geometry.`,
          );
          return feature.geometry !== null;
        });
        resolve({ ...parsed, features });
      } catch (error) {
        reject(new Error(`mapshaper produced invalid ${label} GeoJSON.`, { cause: error }));
      }
    });
  });
}

function formatSvgNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function projectPosition(position) {
  return [
    (position[0] - DRAWING_EXTENT[0]) * DRAWING_SCALE,
    (DRAWING_EXTENT[3] - position[1]) * DRAWING_SCALE,
  ];
}

function ringPath(ring) {
  const points =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring;
  invariant(points.length >= 3, 'Simplified geometry contains a degenerate ring.');
  return (
    'M' +
    points
      .map((position) => projectPosition(position).map(formatSvgNumber).join(','))
      .join('L') +
    'Z'
  );
}

function geometryPath(geometry, label) {
  return polygonsFromGeometry(geometry, label)
    .flatMap((polygon) => polygon.map(ringPath))
    .join('');
}

function collectionPath(collection, label) {
  const path = collection.features
    .map((feature, index) =>
      geometryPath(feature.geometry, `${label} feature ${index}`),
    )
    .join('');
  invariant(path.length > 0, `${label} produced an empty SVG path.`);
  invariant(!/NaN|Infinity/.test(path), `${label} SVG path contains invalid numbers.`);
  return path;
}

function lakePaths(collection) {
  const paths = Object.fromEntries(LAKE_NAMES.map((name) => [name, '']));
  for (const [index, feature] of collection.features.entries()) {
    const name = isRecord(feature.properties) ? feature.properties.name : null;
    invariant(LAKE_NAMES.includes(name), `Simplified lake feature ${index} has no known name.`);
    paths[name] += geometryPath(feature.geometry, `Simplified lake ${name}`);
  }
  for (const [name, path] of Object.entries(paths)) {
    invariant(path.length > 0, `Simplified lake ${name} has an empty SVG path.`);
  }
  return paths;
}

function countPolygons(collection, label) {
  return collection.features.reduce(
    (count, feature, index) =>
      count + polygonsFromGeometry(feature.geometry, `${label} feature ${index}`).length,
    0,
  );
}

function generatedModule(metadata, landPath, lakes) {
  const metadataText = JSON.stringify(metadata, null, 2);
  const lakesText = JSON.stringify(lakes, null, 2);
  return `/**\n` +
    ` * GENERATED by scripts/build-minimap-geometry.mjs. Do not hand-edit.\n` +
    ` * Natural Earth physical land and lakes supply presentation linework\n` +
    ` * only. No country, state, province, Tribal, or Treaty boundaries are\n` +
    ` * included. Existing ATNI-authored framing masks own navigation.\n` +
    ` */\n\n` +
    `export const MINIMAP_GEOMETRY_METADATA = ${metadataText} as const;\n\n` +
    `export const MINIMAP_LAND_PATH = ${JSON.stringify(landPath)};\n\n` +
    `export const MINIMAP_LAKE_PATHS = ${lakesText} as const;\n\n` +
    `export type MinimapLakeName = keyof typeof MINIMAP_LAKE_PATHS;\n`;
}

async function main() {
  console.log('minimap geometry:');
  const [landDownload, lakesDownload] = await Promise.all([
    fetchPinned('Natural Earth 1:50m physical land', LAND_SOURCE, LAND_SHA256),
    fetchPinned('Natural Earth 1:50m physical lakes', LAKES_SOURCE, LAKES_SHA256),
  ]);
  console.log(`  land source:  ${landDownload.bytes.toLocaleString()} bytes, SHA-256 verified`);
  console.log(`  lakes source: ${lakesDownload.bytes.toLocaleString()} bytes, SHA-256 verified`);

  const land = prepareLand(landDownload.value);
  const lakes = prepareLakes(lakesDownload.value);
  const simplifiedLand = await applyMapshaper(
    'minimap-land',
    land.collection,
    `-filter-islands min-area=${MIN_ISLAND_AREA_SQUARE_KILOMETERS}km2`,
  );
  const simplifiedLakes = await applyMapshaper('minimap-lakes', lakes, '');

  const landPath = collectionPath(simplifiedLand, 'Simplified land');
  const renderedLakes = lakePaths(simplifiedLakes);
  const metadata = {
    schemaVersion: 1,
    role: 'navigation presentation geometry',
    containsAdministrativeBoundaries: false,
    source: {
      product: 'Natural Earth 1:50m physical land and lakes',
      version: NATURAL_EARTH_VERSION,
      retrieved: SOURCE_RETRIEVED,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      land: {
        url: LAND_SOURCE,
        sha256: LAND_SHA256,
        bytes: landDownload.bytes,
      },
      lakes: {
        url: LAKES_SOURCE,
        sha256: LAKES_SHA256,
        bytes: lakesDownload.bytes,
      },
    },
    processing: {
      sourceCrs: 'EPSG:4326',
      simplificationProjection: SIMPLIFICATION_PROJECTION,
      simplificationIntervalMeters: SIMPLIFICATION_INTERVAL_METERS,
      keepShapes: true,
      minimumIslandAreaSquareKilometers: MIN_ISLAND_AREA_SQUARE_KILOMETERS,
      outputCoordinatePrecisionDegrees: 0.001,
      svgCoordinatePrecisionPixels: 0.1,
      drawingExtent: DRAWING_EXTENT,
      drawingWidth: DRAWING_WIDTH,
      drawingHeight: DRAWING_HEIGHT,
    },
    controls: {
      greenlandInteriorPoint: GREENLAND_CONTROL,
      greenlandRenderControlPoint: GREENLAND_RENDER_CONTROL,
      greenlandComponentBbox: land.greenlandBounds,
      greenlandComponentsRemoved: 1,
      westernAleutianComponentBboxes: land.aleutianBounds,
      westernAleutianComponentsNormalized: land.aleutianBounds.length,
    },
    counts: {
      sourceLandFeatures: land.sourceFeatureCount,
      sourceLandPolygons: land.sourcePolygonCount,
      candidateLandPolygons: land.candidatePolygonCount,
      renderedLandPolygons: countPolygons(simplifiedLand, 'Simplified land'),
      renderedLakes: Object.keys(renderedLakes).length,
    },
  };

  const output = generatedModule(metadata, landPath, renderedLakes);
  await writeFile(OUT_PATH, output, 'utf8');
  console.log(`  Greenland components removed: 1`);
  console.log(`  western Aleutian components normalized: ${land.aleutianBounds.length}`);
  console.log(`  rendered land polygons: ${metadata.counts.renderedLandPolygons}`);
  console.log(`  SVG land path: ${landPath.length.toLocaleString()} characters`);
  console.log(`  wrote ${OUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
