import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Past HARD_STALE_DAYS the ENSO read degrades to a dated past-tense sentence,
 * so no claim may still state a current reading: the monthly Nino 3.4 claim,
 * the ONI continuity sentence and the SOI agreement sentence are withheld.
 * A frozen companion file is withheld on its own age, and the trend words
 * agree with the change they print and with CPC's La Nina usage.
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

async function claimsAtAge(days, edit = () => {}) {
  const snap = JSON.parse(
    readFileSync(fileURLToPath(new URL('../public/data/enso-indices.json', import.meta.url)), 'utf8')
  );
  const day = dayOffset(days);
  snap.retrieved = day;
  for (const key of ['roni', 'oni', 'nino34', 'nino34Weekly', 'soi']) {
    if (snap[key]) snap[key].published = day;
  }
  edit(snap);
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

test('a frozen companion file is withheld on its own age and does not date the RONI headline', async () => {
  const claims = await claimsAtAge(30, (snap) => {
    snap.nino34.published = dayOffset(130);
  });
  const index = claims.find((c) => c.product === 'ensoIndex');
  assert.match(index.text, /conditions are (present|neutral)/);
  assert.match(index.text, /Oceanic Nino Index/);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Monthly'), false);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Weekly'), true);
});

// Audit round 5 (R5-32): the monthly file posts about every 30 days, so at 70
// days it has missed an issue and is no longer "the most recent analyzed month".
test('a monthly file frozen past 60 days is withheld while its headline is fresh', async () => {
  const claims = await claimsAtAge(30, (snap) => {
    snap.nino34.published = dayOffset(70);
  });
  assert.equal(claims.some((c) => c.product === 'ensoNino34Monthly'), false);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Weekly'), true);
});

test('a weekly file frozen past 45 days is withheld while its headline is fresh', async () => {
  const claims = await claimsAtAge(30, (snap) => {
    snap.nino34Weekly.published = dayOffset(60);
  });
  assert.equal(claims.some((c) => c.product === 'ensoNino34Weekly'), false);
  assert.equal(claims.some((c) => c.product === 'ensoNino34Monthly'), true);
});

/** Replace the tail of a series' values (and its latest) with these anomalies. */
function setTail(series, anoms) {
  const values = series.values.slice(-anoms.length);
  anoms.forEach((anom, i) => {
    values[i].anom = anom;
  });
  series.latest = { ...series.latest, anom: anoms.at(-1) };
}

test('a weekly change of 3.2 to 3.4 is read as the 0.2 band it prints, not as noise', async () => {
  const claims = await claimsAtAge(30, (snap) => setTail(snap.nino34Weekly, [3.2, 3.3, 3.4, 3.4]));
  const weekly = claims.find((c) => c.product === 'ensoNino34Weekly');
  assert.match(weekly.text, /a change of \+0\.20 degrees/);
  assert.match(weekly.text, /it is warming/);
});

// CPC's usage: a La Nina strengthens as its anomaly grows more negative and
// weakens as it rises toward zero. readState computes the raw-sign direction
// here because the state block is removed.
for (const [anoms, word] of [
  [[-1.0, -0.9, -0.8], 'weakening'],
  [[-0.7, -0.8, -0.9], 'strengthening']
]) {
  test(`a La Nina run ${anoms.join(', ')} reads as ${word}`, async () => {
    const claims = await claimsAtAge(30, (snap) => {
      delete snap.roni.state;
      setTail(snap.roni, [-1.2, -1.1, ...anoms]);
    });
    const index = claims.find((c) => c.product === 'ensoIndex');
    assert.match(index.text, new RegExp(`La Nina conditions are present and ${word}:`));
  });
}
