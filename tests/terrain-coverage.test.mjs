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
  TERRAIN_EDGE_BUFFER,
  TERRAIN_EDGE_PAINT,
  fire3dCoverageNote,
  fire3dTerrainCoverageSentence,
  terrainEdgeLine
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

/** A zoom-only `interpolate` expression's value at `zoom` (linear or exponential). */
function evaluateZoom(expr, zoom) {
  const [op, [kind, base = 1], input, ...stops] = expr;
  assert.equal(op, 'interpolate');
  assert.deepEqual(input, ['zoom']);
  if (zoom <= stops[0]) return stops[1];
  for (let i = 2; i < stops.length; i += 2) {
    const z0 = stops[i - 2], z1 = stops[i], v0 = stops[i - 1], v1 = stops[i + 1];
    if (zoom > z1) continue;
    const t = kind === 'linear' || base === 1
      ? (zoom - z0) / (z1 - z0)
      : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + t * (v1 - v0);
  }
  return stops[stops.length - 1];
}

const pxPerDegree = (zoom) => (512 * 2 ** zoom) / 360;

test('the edge fade is one blurred line on the archive box: a true gradient, no bands', () => {
  const box = FIRE3D_TERRAIN_COVERAGE;
  const line = terrainEdgeLine(box);
  assert.equal(line.geometry.type, 'LineString');
  // Closed on the box itself, so the peak sits on the seam.
  assert.deepEqual(line.geometry.coordinates, [
    [box.west, box.south], [box.east, box.south], [box.east, box.north],
    [box.west, box.north], [box.west, box.south]
  ]);
  const paint = TERRAIN_EDGE_PAINT;
  for (const zoom of [3, 4, 5, 6, 7, 8, 9, 11]) {
    const width = evaluateZoom(paint['line-width'], zoom);
    // Blur of half the width: alpha falls linearly from the seam to zero at both sides.
    assert.ok(Math.abs(evaluateZoom(paint['line-blur'], zoom) - width / 2) < 1e-9);
  }
  // Half a degree of ground from regional zoom to close in, so the regional
  // view gets a soft edge rather than a hairline; the seam carries the peak.
  for (const zoom of [3, 4, 5, 6.5, 9]) {
    const deg = evaluateZoom(paint['line-width'], zoom) / pxPerDegree(zoom);
    assert.ok(Math.abs(deg - 0.5) < 0.02, `half a degree at zoom ${zoom}, got ${deg}`);
  }
  // Nothing can frame the archive box at regional zoom: transparent at zoom 6
  // and below, opaque enough to hide the seam by zoom 8.
  for (const zoom of [3, 5, 6]) assert.equal(evaluateZoom(paint['line-opacity'], zoom), 0);
  assert.ok(evaluateZoom(paint['line-opacity'], 8) >= 0.9, 'opaque enough at the seam to hide it');
  // Held in screen space past zoom 9, and the half width stays inside the
  // GeoJSON tile buffer at every zoom (a tile edge would cut the fade).
  assert.equal(evaluateZoom(paint['line-width'], 14), evaluateZoom(paint['line-width'], 9));
  assert.ok(evaluateZoom(paint['line-width'], 9) / 2 <= TERRAIN_EDGE_BUFFER);
  assert.ok(TERRAIN_EDGE_BUFFER <= 512, 'the style spec caps the buffer at 512');
});

test('the scene adds the veil with that buffer and re-seats the ruled chain after it', () => {
  const source = readFileSync(join(ROOT, 'src', 'map', 'fire3d.ts'), 'utf8');
  const block = source.slice(source.indexOf('terrainEdgeLine(resolved.coverage)'));
  assert.match(block.slice(0, 600), /buffer: TERRAIN_EDGE_BUFFER/);
  assert.match(block.slice(0, 900), /reassertThematicOrder\(map\);\s*reassertLabelOrder\(map\);/);
});

test('the Impact Briefing never prints the 3D scene\'s unresolved zoom 8 as a 3D relief claim', async () => {
  const { renderMapTechnicalInformation, setMapTechnicalNote } =
    await import('../src/ui/map-technical-information.ts');
  const briefing = () => /<p id="impact-technical-fire3d">([^<]*)<\/p>/.exec(renderMapTechnicalInformation())[1];
  const decode = (s) => s.replace(/&#039;/g, "'").replace(/&amp;/g, '&');
  // Before any scene: the flat Terrain Shading's own sentence, zoom 8, by name.
  assert.ok(decode(briefing()).startsWith(HILLSHADE_COVERAGE_SENTENCE));
  assert.doesNotMatch(briefing(), /3D relief uses/);
  // The control hands over its unresolved bundled form while no scene is active.
  setMapTechnicalNote('fire3d', FIRE3D_COVERAGE_NOTE);
  assert.ok(decode(briefing()).startsWith(HILLSHADE_COVERAGE_SENTENCE));
  assert.doesNotMatch(briefing(), /3D relief uses/);
  // An active scene on the deep archive: the sidebar's own sentence, verbatim.
  const deep = fire3dCoverageNote({ ...FIRE3D_TERRAIN_COVERAGE, maxZoom: 10 });
  setMapTechnicalNote('fire3d', deep, true);
  assert.equal(decode(briefing()), deep);
  assert.match(briefing(), /^3D relief uses .*zoom 10;/);
  // An active scene that fell back to the bundled archive reads its own line, not the idle one.
  setMapTechnicalNote('fire3d', FIRE3D_COVERAGE_NOTE, true);
  assert.equal(decode(briefing()), FIRE3D_COVERAGE_NOTE);
});
