import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(specifier + '.ts', context.parentURL)))) return nextResolve(specifier + '.ts', context);
  return nextResolve(specifier, context);
} });
const { buildQueryEnvelope, envelopeCovers, toCoverageEnvelope } = await import('../src/util/bbox.ts');

const view = (w, s, e, n) => ({ getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n });

test('the view envelope overscans a quarter of the view, covers a pan inside it, and misses a pan past it', () => {
  const envelope = buildQueryEnvelope(view(-120.000004, 46, -118, 47));
  // A quarter of the width and height on each side, quantized outward to five decimals.
  assert.deepEqual(envelope, [-120.50001, 45.75, -117.49999, 47.25]);

  const coverage = toCoverageEnvelope(envelope);
  assert.ok(coverage[0] > envelope[0] && coverage[1] > envelope[1]);
  assert.ok(coverage[2] < envelope[2] && coverage[3] < envelope[3]);

  assert.equal(envelopeCovers(coverage, view(-120.4, 45.8, -118.4, 46.8)), true);
  assert.equal(envelopeCovers(coverage, view(-120.6, 46, -118.6, 47)), false);
  // The queried edge itself is not claimed: coverage sits one quantum inside it.
  assert.equal(envelopeCovers(coverage, view(envelope[0], 46, -118, 47)), false);
});
