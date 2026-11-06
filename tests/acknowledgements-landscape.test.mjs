import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every source the landscape briefing names in its fact rows
 * (src/impact/landscape-consumer.ts SOURCE_KEYS_BY_FACT) has an
 * Acknowledgements row through PROVIDERS['landscape-signature'], so a reader
 * who sees LANDFIRE fuels or NLCD land cover in the briefing finds its
 * issuer in the credits. Browser-free; plain `node --test`.
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

const ARTIFACT = JSON.parse(
  readFileSync(new URL('../public/data/landscape-signature-pnw.json', import.meta.url), 'utf8')
);
const { ACKNOWLEDGEMENTS, PROVIDERS } = await import('../src/config/acknowledgements.ts');

/** Each source key a briefing fact row shows, and the row that credits its issuer. */
const SHOWN_SOURCE_ROWS = {
  terrain: 'usgs',
  soilMukey: 'usda-nrcs',
  soilSda: 'usda-nrcs',
  landcoverNlcd: 'mrlc',
  fuelsFbfm40: 'landfire',
  hazardWhp: 'usfs'
};

test('every source the landscape briefing shows is credited by a landscape-signature row', () => {
  const rows = PROVIDERS['landscape-signature'];
  for (const [key, id] of Object.entries(SHOWN_SOURCE_ROWS)) {
    assert.ok(ARTIFACT.sources[key], `${key}: not in the shipped artifact`);
    assert.ok(ACKNOWLEDGEMENTS[id], `${key}: no row "${id}"`);
    assert.ok(rows.includes(id), `${key}: row "${id}" not in PROVIDERS['landscape-signature']`);
  }
});

test('the LANDFIRE and MRLC rows carry their draft citation unrendered until ddm-cite records it', () => {
  for (const id of ['landfire', 'mrlc']) {
    const sentences = [...ACKNOWLEDGEMENTS[id].credits, ...ACKNOWLEDGEMENTS[id].changes];
    assert.ok(sentences.length > 0, `${id}: no draft sentence`);
    for (const sentence of sentences) assert.equal(sentence.citeId, null, `${id}: a draft must not render`);
  }
});
