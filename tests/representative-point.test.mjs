import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/src/util/') && /^\.\/[a-z-]+$/.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
} });
const { pointInPolygonGeometry, representativePoint } = await import('../src/util/point-in-polygon.ts');
const { geometryBboxAcrossAntimeridian } = await import('../src/util/antimeridian.ts');

/**
 * Audit 4 finding 2: a briefing with no click read its point sources at the
 * bbox centre, which can sit outside the place (Lake Michigan for Michigan,
 * Virginia for Maryland). representativePoint must land inside the shape.
 */
const assertInside = (geometry, label) => {
  const bbox = geometryBboxAcrossAntimeridian(geometry);
  const centre = { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
  assert.equal(pointInPolygonGeometry(centre.lng, centre.lat, geometry), false, `${label}: box centre is outside`);
  const point = representativePoint(geometry, bbox);
  assert.ok(pointInPolygonGeometry(point.lng, point.lat, geometry), `${label}: ${JSON.stringify(point)} is inside`);
};

test('a crescent whose box centre is in its hollow gets a point inside it', () => {
  const arc = (radius, from, to, steps) => Array.from({ length: steps + 1 }, (_, i) => {
    const angle = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [-120 + radius * Math.cos(angle), 45 + radius * Math.sin(angle)];
  });
  const ring = [...arc(1, 40, 320, 28), ...arc(0.6, 320, 40, 28)];
  ring.push(ring[0]);
  assertInside({ type: 'Polygon', coordinates: [ring] }, 'crescent');
});

test('a convex shape keeps its box centre', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
  assert.deepEqual(representativePoint(square, [0, 0, 2, 2]), { lng: 1, lat: 1 });
});

test('Maryland, Michigan, Florida and Hawaii from the bundled states get a point inside', () => {
  const states = JSON.parse(readFileSync(new URL('../public/data/us-states.geojson', import.meta.url), 'utf8'));
  for (const code of ['MD', 'MI', 'FL', 'HI']) {
    const feature = states.features.find((f) => f.properties?.STUSPS === code);
    assert.ok(feature, `${code} is in the bundled file`);
    assertInside(feature.geometry, code);
  }
});
