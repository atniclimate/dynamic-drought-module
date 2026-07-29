/**
 * Build a committed Canadian Drought Monitor (CDM) monthly snapshot.
 *
 * Usage: npm run build:cdm -- YYYY-MM
 *
 * Agriculture and Agri-Food Canada publishes one zipped GeoJSON file per
 * occupied D0 through D4 class. The archive is build-time only: this script
 * downloads one named month, expands it with the dev-only fflate dependency,
 * verifies its stewardship and schema boundaries, reprojects EPSG:3857 to
 * World Geodetic System 1984 (WGS 84), simplifies the national polygons, and
 * writes one compact runtime artifact. No ZIP code or source archive enters
 * the application import graph.
 *
 * A successful artifact has monthState "published" and records each class as
 * present or absent-no-occupied-area. HTTP failure, malformed ZIP, unexpected
 * geometry, schema drift, or a positive stewardship match fails before write;
 * none can serialize as a clean month with no drought.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'fflate';
import mapshaper from 'mapshaper';

const ZIP_ROOT =
  'https://agriculture.canada.ca/atlas/data_donnees/canadianDroughtMonitor/data_donnees/geoJSON/areasofDrought';
const OUT_PATH = fileURLToPath(
  new URL('../public/data/cdm-drought-areas.json', import.meta.url)
);
const LICENSE_URL =
  'https://open.canada.ca/en/open-government-licence-canada';
const DATASET_URL =
  'https://open.canada.ca/data/en/dataset/292646cd-619f-4200-afb1-8b2c52f984a2';
const MAX_ARCHIVE_BYTES = 10_000_000;
const MAX_EXPANDED_BYTES = 100_000_000;
const MAX_ARTIFACT_BYTES = 5_000_000;
const SIMPLIFY = '15%';
const ALL_CLASSES = ['D0', 'D1', 'D2', 'D3', 'D4'];
const SOURCE_PROPERTIES = new Set([
  'OBJECTID',
  'DM',
  'AREA_AC',
  'Shape_Length',
  'Shape_Area'
]);
const STEWARDSHIP_TERMS = [
  'First Nation',
  'First Nations',
  'Metis',
  'Métis',
  'Inuit',
  'reserve',
  'reserves',
  'Treaty',
  'Treaties'
];
const STEWARDSHIP_PATTERN =
  /\b(?:first\s+nations?|m[eé]tis|inuit|reserves?|treat(?:y|ies))\b/giu;
const WEB_MERCATOR_RADIUS = 6378137;
const WEB_MERCATOR_LIMIT = 20037508.342789244;

function parseMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value ?? '');
  if (!match) {
    throw new Error('month must be YYYY-MM (example: 2026-06)');
  }
  return {
    month: value,
    year: match[1],
    yymm: `${match[1].slice(2)}${match[2]}`
  };
}

function archiveUrl({ year, yymm }) {
  return `${ZIP_ROOT}/${year}/cdm_${yymm}_drought_areas_json.zip`;
}

function isZip(bytes) {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2]) &&
    [0x04, 0x06, 0x08].includes(bytes[3])
  );
}

async function downloadArchive(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `month not published or fetch failed: HTTP ${response.status} for ${url}`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isZip(bytes)) throw new Error(`response is not a ZIP archive: ${url}`);
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `archive is ${bytes.length} bytes, over the ${MAX_ARCHIVE_BYTES} byte ceiling`
    );
  }
  return {
    bytes,
    published: response.headers.get('last-modified')
  };
}

function decodeText(bytes, name) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`archive member is not UTF-8 text: ${name}`);
  }
}

function stewardshipMatches(name, text) {
  const matches = [];
  for (const candidate of [name, text]) {
    STEWARDSHIP_PATTERN.lastIndex = 0;
    for (const match of candidate.matchAll(STEWARDSHIP_PATTERN)) {
      matches.push(match[0]);
    }
  }
  return [...new Set(matches)];
}

function classMember(name, yymm) {
  const pattern = new RegExp(
    `(?:^|/)CDM_${yymm}_D([0-4])_LR\\.geojson$`,
    'i'
  );
  const match = pattern.exec(name.replaceAll('\\', '/'));
  return match ? `D${match[1]}` : null;
}

function inspectCoordinates(value, bounds) {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    const [x, y] = value;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > WEB_MERCATOR_LIMIT + 1 ||
      Math.abs(y) > WEB_MERCATOR_LIMIT + 1
    ) {
      throw new Error(`coordinate is outside EPSG:3857 bounds: ${x},${y}`);
    }
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    return;
  }
  if (!Array.isArray(value)) throw new Error('geometry contains non-array coordinates');
  for (const child of value) inspectCoordinates(child, bounds);
}

function round(value, digits = 5) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function projectCoordinates(value) {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    const [x, y] = value;
    const longitude = (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);
    const latitude =
      (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS)) - Math.PI / 2) *
      (180 / Math.PI);
    return [round(longitude), round(latitude)];
  }
  return value.map(projectCoordinates);
}

function assertSourceProperties(properties, classCode, memberName) {
  const keys = Object.keys(properties ?? {});
  const unexpected = keys.filter((key) => !SOURCE_PROPERTIES.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `unexpected source properties in ${memberName}: ${unexpected.join(', ')}`
    );
  }
  const dm = Number(properties?.DM);
  if (!Number.isInteger(dm) || dm !== Number(classCode.slice(1))) {
    throw new Error(
      `DM property does not match ${classCode} in ${memberName}: ${String(properties?.DM)}`
    );
  }
}

function parseClassFile(text, classCode, memberName) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`invalid GeoJSON in ${memberName}: ${error.message}`);
  }
  if (
    parsed?.type !== 'FeatureCollection' ||
    !Array.isArray(parsed.features)
  ) {
    throw new Error(`${memberName} is not a GeoJSON FeatureCollection`);
  }
  const crsName = String(parsed?.crs?.properties?.name ?? '');
  if (!/3857|102100/.test(crsName)) {
    throw new Error(
      `${memberName} does not declare EPSG:3857 geometry (found "${crsName || 'no CRS'}")`
    );
  }

  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
  const features = parsed.features.map((feature, index) => {
    if (
      feature?.type !== 'Feature' ||
      !feature.geometry ||
      !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)
    ) {
      throw new Error(
        `${memberName} feature ${index} is not Polygon or MultiPolygon`
      );
    }
    assertSourceProperties(feature.properties, classCode, memberName);
    inspectCoordinates(feature.geometry.coordinates, bounds);
    return {
      type: 'Feature',
      properties: { dm: Number(classCode.slice(1)) },
      geometry: {
        type: feature.geometry.type,
        coordinates: projectCoordinates(feature.geometry.coordinates)
      }
    };
  });
  if (features.length === 0) {
    throw new Error(
      `${memberName} exists for occupied class ${classCode} but has no features`
    );
  }
  if (
    bounds.minX >= -180 &&
    bounds.maxX <= 180 &&
    bounds.minY >= -90 &&
    bounds.maxY <= 90
  ) {
    throw new Error(
      `${memberName} coordinates already look like WGS 84; refusing a second reprojection`
    );
  }
  return features;
}

function polygonComponents(geometry, context) {
  if (
    geometry?.type === 'Polygon' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return [geometry.coordinates];
  }
  if (
    geometry?.type === 'MultiPolygon' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return geometry.coordinates;
  }
  throw new Error(`${context} has missing or unsupported polygon geometry`);
}

function componentCountsByClass(collection) {
  const counts = new Map(ALL_CLASSES.map((classCode) => [classCode, 0]));
  for (const [index, feature] of collection.features.entries()) {
    const dm = Number(feature?.properties?.dm);
    if (!Number.isInteger(dm) || dm < 0 || dm > 4) {
      throw new Error(`feature ${index} has an invalid drought class`);
    }
    const classCode = `D${dm}`;
    const count = polygonComponents(
      feature.geometry,
      `feature ${index} (${classCode})`
    ).length;
    counts.set(classCode, (counts.get(classCode) ?? 0) + count);
  }
  return counts;
}

function explodeComponents(collection) {
  return {
    type: 'FeatureCollection',
    features: collection.features.flatMap((feature, sourceFeature) =>
      polygonComponents(
        feature.geometry,
        `source feature ${sourceFeature}`
      ).map((coordinates, sourceComponent) => ({
        type: 'Feature',
        properties: {
          dm: feature.properties.dm,
          sourceFeature,
          sourceComponent
        },
        geometry: {
          type: 'Polygon',
          coordinates
        }
      }))
    )
  };
}

function restoreMultipartFeatures(collection, sourceCollection) {
  const sourceComponents = explodeComponents(sourceCollection);
  const expectedIdentities = new Set(
    sourceComponents.features.map(
      (feature) =>
        `${feature.properties.sourceFeature}:${feature.properties.sourceComponent}`
    )
  );
  const simplifiedByIdentity = new Map();
  const fallbackCounts = new Map(
    ALL_CLASSES.map((classCode) => [classCode, 0])
  );
  for (const [index, feature] of collection.features.entries()) {
    const dm = Number(feature?.properties?.dm);
    const sourceFeature = Number(feature?.properties?.sourceFeature);
    const sourceComponent = Number(feature?.properties?.sourceComponent);
    const identity = `${sourceFeature}:${sourceComponent}`;
    if (
      !Number.isInteger(dm) ||
      dm < 0 ||
      dm > 4 ||
      !Number.isInteger(sourceFeature) ||
      !Number.isInteger(sourceComponent) ||
      !expectedIdentities.has(identity)
    ) {
      throw new Error(
        `simplified component ${index} lost its source component identity`
      );
    }
    if (simplifiedByIdentity.has(identity)) {
      throw new Error(`simplification duplicated source component ${identity}`);
    }
    let coordinates = null;
    try {
      const components = polygonComponents(
        feature.geometry,
        `simplified component ${index}`
      );
      if (components.length === 1) coordinates = components[0];
    } catch {
      // A tiny component can collapse at the declared output precision.
      // The source-projected coordinates are substituted below rather than
      // allowing that occupied component to disappear.
    }
    simplifiedByIdentity.set(identity, { dm, coordinates });
  }

  const restored = new Map();
  for (const source of sourceComponents.features) {
    const dm = Number(source.properties.dm);
    const sourceFeature = Number(source.properties.sourceFeature);
    const sourceComponent = Number(source.properties.sourceComponent);
    const identity = `${sourceFeature}:${sourceComponent}`;
    const simplified = simplifiedByIdentity.get(identity);
    if (simplified && simplified.dm !== dm) {
      throw new Error(
        `simplified component ${identity} changed drought class from D${dm} to D${simplified.dm}`
      );
    }
    const simplifiedCoordinates = simplified?.coordinates ?? null;
    const coordinates =
      simplifiedCoordinates ??
      polygonComponents(source.geometry, `source component ${identity}`)[0];
    if (simplifiedCoordinates === null) {
      const classCode = `D${dm}`;
      fallbackCounts.set(classCode, (fallbackCounts.get(classCode) ?? 0) + 1);
    }
    const group = restored.get(sourceFeature) ?? { dm, coordinates: [] };
    group.coordinates.push(coordinates);
    restored.set(sourceFeature, group);
  }

  for (const [sourceFeature, source] of sourceCollection.features.entries()) {
    const output = restored.get(sourceFeature);
    const sourceCount = polygonComponents(
      source.geometry,
      `source feature ${sourceFeature}`
    ).length;
    const outputCount = output?.coordinates.length ?? 0;
    if (outputCount !== sourceCount) {
      throw new Error(
        `component preservation failed for source feature ${sourceFeature} ` +
          `(D${source.properties.dm}): source ${sourceCount}, shipped ${outputCount}`
      );
    }
  }
  if (restored.size !== sourceCollection.features.length) {
    throw new Error(
      `component preservation produced ${restored.size} source feature groups; expected ${sourceCollection.features.length}`
    );
  }

  return {
    collection: {
      type: 'FeatureCollection',
      features: [...restored.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, group]) => ({
          type: 'Feature',
          properties: { dm: group.dm },
          geometry:
            group.coordinates.length === 1
              ? {
                  type: 'Polygon',
                  coordinates: group.coordinates[0]
                }
              : {
                  type: 'MultiPolygon',
                  coordinates: group.coordinates
                }
        }))
    },
    fallbackCounts
  };
}

function assertComponentParity(sourceCounts, shippedCounts) {
  for (const classCode of ALL_CLASSES) {
    const source = sourceCounts.get(classCode) ?? 0;
    const shipped = shippedCounts.get(classCode) ?? 0;
    if (source !== shipped) {
      throw new Error(
        `component preservation failed for ${classCode}: source ${source}, shipped ${shipped}`
      );
    }
  }
}

function simplifyFeatureCollection(collection) {
  const input = {
    'input.geojson': Buffer.from(JSON.stringify(collection))
  };
  const command = [
    '-i input.geojson encoding=utf8',
    `-simplify ${SIMPLIFY} keep-shapes`,
    '-o output.geojson format=geojson precision=0.0001'
  ].join(' ');
  return new Promise((resolve, reject) => {
    mapshaper.applyCommands(command, input, (error, output) => {
      if (error) return reject(error);
      const text = output['output.geojson'];
      if (!text) return reject(new Error('mapshaper produced no CDM output'));
      resolve(JSON.parse(text));
    });
  });
}

function assertWgs84(collection) {
  const bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
  for (const feature of collection.features) {
    inspectWgsCoordinates(feature.geometry.coordinates, bounds);
  }
  if (
    bounds.minX < -180 ||
    bounds.maxX > 180 ||
    bounds.minY < -90 ||
    bounds.maxY > 90
  ) {
    throw new Error(
      `reprojected artifact exceeds WGS 84 bounds: ${JSON.stringify(bounds)}`
    );
  }
  return bounds;
}

function inspectWgsCoordinates(value, bounds) {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  ) {
    const [longitude, latitude] = value;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error('reprojected geometry contains a non-finite coordinate');
    }
    bounds.minX = Math.min(bounds.minX, longitude);
    bounds.maxX = Math.max(bounds.maxX, longitude);
    bounds.minY = Math.min(bounds.minY, latitude);
    bounds.maxY = Math.max(bounds.maxY, latitude);
    return;
  }
  if (!Array.isArray(value)) throw new Error('geometry contains non-array coordinates');
  for (const child of value) inspectWgsCoordinates(child, bounds);
}

async function main() {
  const requested = parseMonth(process.argv[2]);
  const sourceUrl = archiveUrl(requested);
  const downloaded = await downloadArchive(sourceUrl);
  const members = unzipSync(downloaded.bytes);
  const memberNames = Object.keys(members)
    .filter((name) => !name.endsWith('/'))
    .sort();
  const expandedBytes = memberNames.reduce(
    (sum, name) => sum + members[name].byteLength,
    0
  );
  if (expandedBytes > MAX_EXPANDED_BYTES) {
    throw new Error(
      `expanded archive is ${expandedBytes} bytes, over the ${MAX_EXPANDED_BYTES} byte ceiling`
    );
  }

  const present = new Map();
  const stewardshipFindings = [];
  for (const name of memberNames) {
    const text = decodeText(members[name], name);
    const matches = stewardshipMatches(name, text);
    if (matches.length > 0) {
      stewardshipFindings.push({ member: name, matches });
    }
    if (!/\.geojson$/i.test(name)) continue;
    const classCode = classMember(name, requested.yymm);
    if (classCode === null) {
      throw new Error(
        `unexpected GeoJSON member may carry out-of-scope geometry: ${name}`
      );
    }
    if (present.has(classCode)) {
      throw new Error(`duplicate ${classCode} file in archive: ${name}`);
    }
    present.set(classCode, {
      member: basename(name),
      features: parseClassFile(text, classCode, name)
    });
  }
  if (stewardshipFindings.length > 0) {
    throw new Error(
      `STEWARDSHIP CHECK FAILED: ${JSON.stringify(stewardshipFindings)}`
    );
  }

  const combined = {
    type: 'FeatureCollection',
    features: ALL_CLASSES.flatMap(
      (classCode) => present.get(classCode)?.features ?? []
    )
  };
  const sourceComponentCounts = componentCountsByClass(combined);
  const exploded = explodeComponents(combined);
  const simplified = await simplifyFeatureCollection(exploded);
  const restored = restoreMultipartFeatures(simplified, combined);
  const shipped = restored.collection;
  const shippedComponentCounts = componentCountsByClass(shipped);
  assertComponentParity(sourceComponentCounts, shippedComponentCounts);
  const bounds = assertWgs84(shipped);

  const outputFeatureCounts = new Map(
    ALL_CLASSES.map((classCode) => [classCode, 0])
  );
  for (const feature of shipped.features) {
    const classCode = `D${feature.properties.dm}`;
    outputFeatureCounts.set(
      classCode,
      (outputFeatureCounts.get(classCode) ?? 0) + 1
    );
  }
  const classes = ALL_CLASSES.map((classCode) => {
    const entry = present.get(classCode);
    return entry
      ? {
          class: classCode,
          state: 'present',
          member: entry.member,
          featureCount: outputFeatureCounts.get(classCode) ?? 0,
          componentCount: shippedComponentCounts.get(classCode) ?? 0
        }
      : {
          class: classCode,
          state: 'absent-no-occupied-area',
          member: null,
          featureCount: 0,
          componentCount: 0
        };
  });

  const stewardshipResult =
    `PASS: no First Nations, Metis, Métis, Inuit, reserve, or Treaty ` +
    `terms found in ${memberNames.length} archive member names or decoded contents.`;
  const componentPreservationResult =
    'PASS: shipped component count equals source component count for every class.';
  const artifact = {
    schemaVersion: 1,
    product: 'Canadian Drought Monitor',
    month: requested.month,
    monthState: 'published',
    attribution: 'Agriculture and Agri-Food Canada',
    license: {
      title: 'Open Government Licence - Canada',
      url: LICENSE_URL,
      datasetUrl: DATASET_URL
    },
    provenance: {
      sourceUrl,
      retrieved: localIsoDate(),
      published: downloaded.published,
      archiveBytes: downloaded.bytes.length,
      expandedBytes,
      sourceCrs: 'EPSG:3857',
      outputCrs: 'EPSG:4326',
      simplification:
        `${SIMPLIFY} keep-shapes after exploding multipart components, ` +
        'coordinate precision 0.0001 degrees; any component that would ' +
        'collapse retains its 0.00001-degree source-projected coordinates',
      unsimplifiedComponents: Object.fromEntries(
        ALL_CLASSES.map((classCode) => [
          classCode,
          restored.fallbackCounts.get(classCode) ?? 0
        ])
      ),
      classesPresent: classes
        .filter((entry) => entry.state === 'present')
        .map((entry) => entry.class),
      classesAbsent: classes
        .filter((entry) => entry.state === 'absent-no-occupied-area')
        .map((entry) => entry.class),
      stewardshipCheck: {
        terms: STEWARDSHIP_TERMS,
        result: stewardshipResult
      },
      componentPreservation: componentPreservationResult
    },
    classes,
    bounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
    data: shipped
  };
  const serialized = `${JSON.stringify(artifact)}\n`;
  const artifactBytes = Buffer.byteLength(serialized);
  if (artifactBytes > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `artifact is ${artifactBytes} bytes, over the ${MAX_ARTIFACT_BYTES} byte ceiling`
    );
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, serialized, 'utf8');
  console.log(`Wrote ${OUT_PATH} (${artifactBytes} bytes).`);
  console.log(`Month state: published (${requested.month}).`);
  console.log(
    `Classes present: ${artifact.provenance.classesPresent.join(', ') || 'none'}; ` +
      `absent with no occupied area: ${artifact.provenance.classesAbsent.join(', ') || 'none'}.`
  );
  console.log(stewardshipResult);
  console.log(componentPreservationResult);
  console.log(
    `Components: ${ALL_CLASSES.map((classCode) =>
      `${classCode} source ${sourceComponentCounts.get(classCode) ?? 0}, ` +
      `shipped ${shippedComponentCounts.get(classCode) ?? 0}`
    ).join('; ')}.`
  );
  console.log(
    `Unsimplified precision fallbacks: ${ALL_CLASSES.map((classCode) =>
      `${classCode} ${restored.fallbackCounts.get(classCode) ?? 0}`
    ).join(', ')}.`
  );
  console.log(
    `Source archive: ${downloaded.bytes.length} bytes; retrieval ${artifact.provenance.retrieved}.`
  );
}

main().catch((error) => {
  console.error(`build-cdm-snapshot failed: ${error.message}`);
  process.exit(1);
});
