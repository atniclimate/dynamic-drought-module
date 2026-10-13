import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Past HARD_STALE_DAYS the ENSO read degrades to a dated past-tense sentence,
 * so no claim may still state a current reading: the monthly Nino 3.4 claim,
 * the ONI continuity sentence and the SOI agreement sentence are withheld.
 */

// Same extensionless-specifier hook as tests/briefing-truth.test.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { fetchEnsoClaims } = await import('../src/impact/enso.ts');
const { invalidateSharedJsonRequest } = await import('../src/util/fetch.ts');
const { ENSO_INDICES_SHARED_KEY } = await import('../src/util/fetch.ts');

function dayOffset(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function claimsAtAge(days) {
  const snap = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/data/enso-indices.json', import.meta.url)), 'utf8')
  );
  const day = dayOffset(days);
  snap.retrieved = day;
  for (const key of ['roni', 'oni', 'nino34', 'nino34Weekly', 'soi']) {
    if (snap[key]) snap[key].published = day;
  }
  invalidateSharedJsonRequest(ENSO_INDICES_SHARED_KEY);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(snap));
  try {
    const result = await fetchEnsoClaims({}, new AbortController().signal);
    assert.equal(result.ok, true);
    return result.claims;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a 150 day old snapshot withholds the monthly companion, ONI continuity and SOI agreement', async () => {
  const claims = await claimsAtAge(150);
  const index = claims.find((c) => c.product === 'ensoIndex');
  assert.ok(index, 'the dated index claim is still present');
  assert.doesNotMatch(index.text, /Oceanic Nino Index/);
  assert.doesNotMatch(index.text, /Southern Oscillation Index/);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Monthly'), false);
});

test('a 30 day old snapshot keeps the monthly companion, ONI continuity and SOI agreement', async () => {
  const claims = await claimsAtAge(30);
  const index = claims.find((c) => c.product === 'ensoIndex');
  assert.match(index.text, /Oceanic Nino Index/);
  assert.match(index.text, /Southern Oscillation Index/);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Monthly'), true);
});
