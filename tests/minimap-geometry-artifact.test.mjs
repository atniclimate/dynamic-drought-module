import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const artifactUrl = new URL('../src/config/minimap-geometry.ts', import.meta.url);
const artifactSource = await readFile(artifactUrl, 'utf8');
const executableArtifact = artifactSource
  .replaceAll(' as const;', ';')
  .replace(/^export type .+$/gm, '');
const artifactModuleUrl = `data:text/javascript;base64,${Buffer.from(
  executableArtifact,
).toString('base64')}`;
const {
  MINIMAP_GEOMETRY_METADATA,
  MINIMAP_LAKE_PATHS,
  MINIMAP_LAND_PATH,
} = await import(artifactModuleUrl);

function ringsFromPath(path) {
  return path
    .split('M')
    .slice(1)
    .map((subpath) =>
      subpath
        .replace(/Z$/, '')
        .split('L')
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          assert.ok(
            Number.isFinite(x) && Number.isFinite(y),
            `Invalid generated SVG point: ${pair}`,
          );
          return [x, y];
        }),
    );
}

function pointInRing(point, ring) {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
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

function pointInEvenOddPath(point, path) {
  return ringsFromPath(path).reduce(
    (inside, ring) => (pointInRing(point, ring) ? !inside : inside),
    false,
  );
}

function project(longitude, latitude) {
  const [west, , east, north] =
    MINIMAP_GEOMETRY_METADATA.processing.drawingExtent;
  const scale = MINIMAP_GEOMETRY_METADATA.processing.drawingWidth / (east - west);
  return [(longitude - west) * scale, (north - latitude) * scale];
}

test('pins physical source identity, license, and processing controls', () => {
  assert.equal(MINIMAP_GEOMETRY_METADATA.schemaVersion, 1);
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.containsAdministrativeBoundaries,
    false,
  );
  assert.equal(MINIMAP_GEOMETRY_METADATA.source.version, '5.1.2');
  assert.equal(MINIMAP_GEOMETRY_METADATA.source.license, 'public domain');
  assert.match(
    MINIMAP_GEOMETRY_METADATA.source.land.url,
    /natural-earth-vector\/v5\.1\.2\/geojson\/ne_50m_land\.geojson$/,
  );
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.source.land.sha256,
    'e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b',
  );
  assert.equal(MINIMAP_GEOMETRY_METADATA.source.land.bytes, 1_636_166);
  assert.match(
    MINIMAP_GEOMETRY_METADATA.source.lakes.url,
    /natural-earth-vector\/v5\.1\.2\/geojson\/ne_50m_lakes\.geojson$/,
  );
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.source.lakes.sha256,
    'd350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52',
  );
  assert.equal(MINIMAP_GEOMETRY_METADATA.source.lakes.bytes, 876_018);
  assert.match(
    MINIMAP_GEOMETRY_METADATA.processing.simplificationProjection,
    /\+proj=laea/,
  );
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.processing.simplificationIntervalMeters,
    12_000,
  );
  assert.equal(MINIMAP_GEOMETRY_METADATA.processing.keepShapes, true);
});

test('removes Greenland whole while retaining Canadian Arctic land', () => {
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.controls.greenlandComponentsRemoved,
    1,
  );
  assert.deepEqual(
    MINIMAP_GEOMETRY_METADATA.controls.greenlandComponentBbox,
    [-72.818066, 59.815479, -11.425537, 83.599609],
  );

  assert.equal(pointInEvenOddPath(project(-60, 76), MINIMAP_LAND_PATH), false);
  assert.equal(pointInEvenOddPath(project(-85, 75), MINIMAP_LAND_PATH), true);
  assert.equal(pointInEvenOddPath(project(-120, 74), MINIMAP_LAND_PATH), true);
});

test('keeps normalized Aleutians and compact multi-part linework', () => {
  assert.equal(
    MINIMAP_GEOMETRY_METADATA.controls.westernAleutianComponentsNormalized,
    6,
  );
  assert.ok(MINIMAP_GEOMETRY_METADATA.counts.renderedLandPolygons > 30);
  assert.ok((MINIMAP_LAND_PATH.match(/M/g) ?? []).length > 30);
  assert.ok(MINIMAP_LAND_PATH.length > 5_000);
  assert.ok(MINIMAP_LAND_PATH.length < 100_000);
  assert.doesNotMatch(MINIMAP_LAND_PATH, /NaN|Infinity/);

  const xs = ringsFromPath(MINIMAP_LAND_PATH).flatMap((ring) =>
    ring.map((point) => point[0]),
  );
  assert.ok(Math.min(...xs) < 45);
});

test('contains exactly the eight selected physical lake anchors', () => {
  assert.deepEqual(Object.keys(MINIMAP_LAKE_PATHS), [
    'Lake Superior',
    'Lake Michigan',
    'Lake Huron',
    'Lake Erie',
    'Lake Ontario',
    'Lake Winnipeg',
    'Great Slave Lake',
    'Great Bear Lake',
  ]);
  assert.equal(MINIMAP_GEOMETRY_METADATA.counts.renderedLakes, 8);
  for (const path of Object.values(MINIMAP_LAKE_PATHS)) {
    assert.match(path, /^M/);
    assert.match(path, /Z$/);
    assert.doesNotMatch(path, /NaN|Infinity/);
  }
});
