import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });

const { buildQueryUrl } = await import('../src/layers/nws-alerts.ts');

test('the WWA alerts query asks the service for simplified, rounded shapes', () => {
  const params = new URL(buildQueryUrl()).searchParams;
  // Measured 2026-10-15: 1.88 MB gzipped at full detail, 224 KB with these two.
  assert.equal(params.get('maxAllowableOffset'), '0.002');
  assert.equal(params.get('geometryPrecision'), '5');
  assert.equal(params.get('outSR'), '4326');
  assert.equal(params.get('f'), 'geojson');
  assert.match(params.get('where') ?? '', /^prod_type IN \(/);
});
