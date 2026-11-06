import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The landscape briefing's source rows link only to pages a person can read.
 * The artifact's `sourceUrl` is the address the builder downloaded from: for
 * WHP a 368 MB data zip, for SoilWeb, SDA and the MRLC WCS bare machine
 * endpoints. Those four show as labels; WHP links through the DOI the
 * artifact's own vintage carries (the issuer's suggested citation form).
 * Drives the shipped consumer over the committed artifact. Browser-free.
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
const { resolveLandscapeContext } = await import('../src/impact/landscape-consumer.ts');
const { loadLandscapeSignatureAtUrl } = await import('../src/impact/landscape.ts');

const load = (opts) =>
  loadLandscapeSignatureAtUrl('https://example.invalid/landscape.json', {
    ...opts,
    fetchJsonImpl: async () => ARTIFACT
  });

test('machine-endpoint sources show as labels; WHP links through its DOI', async () => {
  const result = await resolveLandscapeContext({ level: 4, code: '4a' }, { load });
  assert.equal(result.status, 'ready');
  const urls = Object.fromEntries(result.sources.map((source) => [source.key, source.url]));
  assert.deepEqual(urls, {
    terrain: 'https://www.usgs.gov/3d-elevation-program',
    soilMukey: undefined,
    soilSda: undefined,
    landcoverNlcd: undefined,
    fuelsFbfm40: ARTIFACT.sources.fuelsFbfm40.sourceUrl,
    hazardWhp: 'https://doi.org/10.2737/RDS-2015-0047-4'
  });
  for (const source of result.sources) assert.ok(source.label.length > 0 && source.vintage.length > 0);
});
