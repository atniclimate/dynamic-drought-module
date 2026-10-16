import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Audit 10: the Ecoregions layer reads `live` once its bundled archive opens,
 * at any viewport, but the archive only covers the Pacific Northwest. Like the
 * hillshade row (found-066), the row must name its coverage: the source line
 * carries the coverage tail, and the catalog shows that tail on the row.
 * The archive's own PMTiles v3 header is the authority for its bounds.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { LAYER_DEFS } = await import('../src/config/layers.ts');

const ARCHIVE = new URL('../public/data/ecoregions-pnw.pmtiles', import.meta.url);
const CATALOG = new URL('../src/ui/island/catalog.tsx', import.meta.url);
const TAIL = 'Pacific Northwest bundle only';

function pmtilesBounds(file) {
  const header = readFileSync(file).subarray(0, 127);
  assert.equal(header.subarray(0, 7).toString('latin1'), 'PMTiles');
  assert.equal(header[7], 3);
  const e7 = (offset) => header.readInt32LE(offset) / 1e7;
  return { west: e7(102), south: e7(106), east: e7(110), north: e7(114) };
}

test('the ecoregion archive is regional, not national', () => {
  const b = pmtilesBounds(ARCHIVE);
  // The national framing reaches -66.9 longitude; a regional archive stops well short.
  assert.ok(b.east < -100, `archive east bound ${b.east}`);
  assert.ok(b.south > 40, `archive south bound ${b.south}`);
});

test('the ecoregions source line ends with its coverage tail', () => {
  const def = LAYER_DEFS.find((d) => d.key === 'ecoregions');
  assert.ok(def, 'ecoregions layer def');
  assert.equal(def.source.split(' · ').pop(), TAIL);
});

test('the catalog shows the coverage cue on the ecoregions row', () => {
  // catalog.tsx is TSX and does not load under node; read the key list instead.
  const text = readFileSync(CATALOG, 'utf8');
  const match = text.match(/COVERAGE_CUE_KEYS[^=]*=\s*new Set\(\[([^\]]*)\]/);
  assert.ok(match, 'COVERAGE_CUE_KEYS declaration in catalog.tsx');
  const keys = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.includes('ecoregions'), `keys ${keys.join(', ')}`);
  assert.ok(keys.includes('hillshade'), `keys ${keys.join(', ')}`);
  assert.match(text, /COVERAGE_CUE_KEYS\.has\(def\.key\)\s*\?\s*coverageCue\(def\.source\)/);
});
