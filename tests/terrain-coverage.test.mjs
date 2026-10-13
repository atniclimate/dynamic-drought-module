import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The two terrain sentences and the 3D scene's edge fade, browser-free.
 *
 * The flat Terrain Shading reads the bundled archive (zoom 0-8); the 3D
 * scene reads the deep archive when it resolves (zoom 0-10). Both sentences
 * opened "Terrain relief uses", so the map key's zoom 8 and the 3D
 * information's zoom 10 read as one claim contradicting itself. Each now
 * names its own layer and both come from one formatter.
 *
 * Runs under plain `node --test` (Node 24 strips types); the resolve hook
 * maps the sources' extensionless relative imports to their .ts files.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const {
  FIRE3D_TERRAIN_COVERAGE,
  HILLSHADE_COVERAGE_SENTENCE,
  terrainCoverageSentence
} = await import('../src/config/terrain-coverage.ts');
const {
  FIRE3D_COVERAGE_NOTE,
  TERRAIN_EDGE_BAND_COUNT,
  TERRAIN_EDGE_HALF_WIDTH_DEG,
  fire3dTerrainCoverageSentence,
  terrainEdgeBands
} = await import('../src/config/fire3d-presentation.ts');

test('each sentence carries its own zoom and never the other', () => {
  const deep = { ...FIRE3D_TERRAIN_COVERAGE, maxZoom: 10 };
  assert.match(terrainCoverageSentence('X', deep), /detail ends at zoom 10;/);
  assert.doesNotMatch(terrainCoverageSentence('X', deep), /zoom 8\b/);
  assert.match(terrainCoverageSentence('X', FIRE3D_TERRAIN_COVERAGE), /detail ends at zoom 8;/);
  assert.doesNotMatch(terrainCoverageSentence('X', FIRE3D_TERRAIN_COVERAGE), /zoom 10\b/);
});

test('the flat shading and the 3D scene name different layers, so their zooms cannot read as one claim', () => {
  assert.ok(HILLSHADE_COVERAGE_SENTENCE.startsWith('Terrain Shading uses '));
  assert.match(HILLSHADE_COVERAGE_SENTENCE, new RegExp(`zoom ${FIRE3D_TERRAIN_COVERAGE.maxZoom};`));
  assert.ok(fire3dTerrainCoverageSentence(10).startsWith('3D relief uses '));
  assert.match(fire3dTerrainCoverageSentence(10), /zoom 10;/);
  assert.ok(FIRE3D_COVERAGE_NOTE.startsWith('3D relief uses '));
  for (const s of [HILLSHADE_COVERAGE_SENTENCE, fire3dTerrainCoverageSentence(10)]) {
    assert.ok(s.includes(FIRE3D_TERRAIN_COVERAGE.issuer));
    assert.ok(s.includes('125°W to 110.5°W, 41.5°N to 49.5°N'));
  }
});

test('the map key derives its terrain sentence instead of typing a zoom by hand', () => {
  const source = readFileSync(join(ROOT, 'src', 'ui', 'map-key.ts'), 'utf8');
  assert.ok(source.includes('HILLSHADE_COVERAGE_SENTENCE'), 'map-key.ts imports HILLSHADE_COVERAGE_SENTENCE');
  assert.ok(!/detail ends at zoom \d/.test(source), 'map-key.ts types no zoom figure by hand');
});

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

test('the edge fade straddles the archive box and peaks at its edge', () => {
  const box = FIRE3D_TERRAIN_COVERAGE;
  const { features } = terrainEdgeBands(box);
  assert.equal(features.length, 2 * TERRAIN_EDGE_BAND_COUNT);
  const opacities = features.map((f) => f.properties.opacity);
  // Outermost band first, innermost last: rising to the edge, then falling.
  assert.deepEqual(opacities, [...opacities].reverse());
  const peak = Math.max(...opacities);
  assert.equal(opacities[TERRAIN_EDGE_BAND_COUNT - 1], peak);
  assert.equal(opacities[TERRAIN_EDGE_BAND_COUNT], peak);
  for (const o of opacities) assert.ok(o > 0 && o < 1);
  assert.ok(opacities[0] < 0.1, 'the outermost band is nearly clear');
  for (const f of features) {
    const [outer, hole] = f.geometry.coordinates;
    assert.equal(f.geometry.coordinates.length, 2);
    assert.ok(ringArea(outer) > 0 && ringArea(hole) < 0, 'hole wound against the outer ring');
  }
  // The band just outside the box ends exactly on its edge, and the band
  // just inside starts there: the edge itself sits under the peak.
  const outside = features[TERRAIN_EDGE_BAND_COUNT - 1].geometry.coordinates[1];
  const inside = features[TERRAIN_EDGE_BAND_COUNT].geometry.coordinates[0];
  assert.deepEqual(outside[0], [box.west, box.south]);
  assert.deepEqual(inside[0], [box.west, box.south]);
  const far = features[0].geometry.coordinates[0][0];
  assert.deepEqual(far, [box.west - TERRAIN_EDGE_HALF_WIDTH_DEG, box.south - TERRAIN_EDGE_HALF_WIDTH_DEG]);
});
