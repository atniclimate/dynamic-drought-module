import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * S30D P3-MINIMAP (REGISTER found-129): the Wildfire minimap never counts
 * perimeters from a truncated loaded NIFC collection.
 *
 * `countFromLoadedNifcCollection` (src/state/minimap-wildfire.ts) reads the
 * perimeters layer's already-loaded collection instead of posting a
 * count-only query for a framing the collection covers. A collection the
 * service truncated (it hit its transfer limit) can omit perimeters, so a
 * zero from it would state "No current mapped NIFC wildfire perimeter
 * intersected this authored framing" and a positive count would be a lower
 * bound dressed as a count. The reader must therefore decline a truncated
 * snapshot and let the framing take its normal count-only POST, reading
 * completeness from the SNAPSHOT it counts (the same rule the briefing
 * follows, src/impact/sources.ts), not from the layer status read before
 * the await: a refresh can publish a truncated collection in between.
 *
 * Driven through `retainMinimapWildfire` with the REAL module, `fetch`
 * stubbed to record the count-only POSTs (no network), and the one layer
 * module `src/layers/nifc-fires.ts` replaced by a module whose
 * `loadedNifcCollection` answers whatever the case sets on
 * `globalThis.__minimapLoaded` (Node cannot strip that module nor run its
 * MapLibre and DOM graph; tests/briefing-truth.test.mjs is the same
 * technique).
 */

// The product modules import each other without extensions; this hook appends
// `.ts` to a relative, extensionless specifier whose parent is a `.ts` module.
const NIFC_LAYER_MODULE = '/src/layers/nifc-fires.ts';
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
  },
  load(url, context, nextLoad) {
    if (url.endsWith(NIFC_LAYER_MODULE)) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export function loadedNifcCollection() { return globalThis.__minimapLoaded ?? null; }'
      };
    }
    return nextLoad(url, context);
  }
});

const minimap = await import('../src/state/minimap-wildfire.ts');
const { registry } = await import('../src/state/registry.ts');
const { FRAMING_KEYS } = await import('../src/config/framings.ts');

const COVERED = 'pacific-coast';
const COUNT_ANSWER = 3;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A perimeter that overlaps the COVERED framing: its own first authored
 * ring, a polygon the framing's geometry certainly intersects. */
function perimeterOverCoveredFraming() {
  const frame = minimap.framingGeometry(COVERED);
  return {
    type: 'Feature',
    properties: { attr_ActiveFireCandidate: 1, attr_IncidentTypeCategory: 'WF' },
    geometry: { type: 'Polygon', coordinates: frame.coordinates[0] }
  };
}

const WITH_PERIMETER = { type: 'FeatureCollection', features: [perimeterOverCoveredFraming()] };
const EMPTY = { type: 'FeatureCollection', features: [] };

function bboxOf(key) {
  const frame = minimap.framingGeometry(key);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of frame.coordinates) {
    for (const [lon, lat] of polygon[0]) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

/** What the layer's `loadedNifcCollection` answers. `envelope` null is the
 * layer's unscoped national fallback and covers every framing. */
function loaded(collection, { truncated, envelope = null }) {
  return { collection, envelope, fetchedAt: Date.now(), truncated };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Run the retained feed once under a layer status and a loaded snapshot and
 * return the recorded count-only POST bodies plus the published summaries. */
async function runFeed({ status, snapshot }) {
  const original = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (_input, init) => {
    posts.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ count: COUNT_ANSWER }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  globalThis.__minimapLoaded = snapshot;
  registry.deactivate('nifc-fires');
  if (status !== undefined) registry.setStatus('nifc-fires', status);
  let release = () => {};
  try {
    const settled = await new Promise((resolve) => {
      release = minimap.retainMinimapWildfire((next) => {
        if (next.checkedAtUtc !== null) resolve(next);
      });
    });
    return { posts, snapshot: settled };
  } finally {
    release();
    registry.deactivate('nifc-fires');
    globalThis.__minimapLoaded = null;
    globalThis.fetch = original;
  }
}

function postedFor(posts, key) {
  const body = minimap.buildMinimapWildfireQueryBody(key).toString();
  return posts.includes(body);
}

// ---------------------------------------------------------------------------
// A truncated snapshot is declined
// ---------------------------------------------------------------------------

for (const status of ['degraded', 'ready']) {
  test(`a truncated loaded collection holding a matching perimeter is declined under layer status ${status}: every framing takes its count-only POST and the summaries come from the answers`, async () => {
    const { posts, snapshot } = await runFeed({
      status,
      snapshot: loaded(WITH_PERIMETER, { truncated: true })
    });
    assert.equal(posts.length, FRAMING_KEYS.length, 'one count-only POST per framing');
    for (const key of FRAMING_KEYS) {
      assert.equal(postedFor(posts, key), true, `${key} was posted`);
      const summary = snapshot.summaries[key];
      assert.equal(summary.mappedWildfirePerimeterCount, COUNT_ANSWER, `${key} counts the POST answer`);
      assert.equal(summary.condition, 'mapped-wildfire');
      assert.equal(summary.status, 'live');
    }
  });

  test(`a truncated loaded collection holding NO perimeter is declined under layer status ${status}: its zero is never read as an absence`, async () => {
    const { posts, snapshot } = await runFeed({
      status,
      snapshot: loaded(EMPTY, { truncated: true })
    });
    assert.equal(posts.length, FRAMING_KEYS.length, 'one count-only POST per framing');
    for (const key of FRAMING_KEYS) {
      const summary = snapshot.summaries[key];
      assert.equal(
        summary.mappedWildfirePerimeterCount,
        COUNT_ANSWER,
        `${key} is counted by the service, not read as zero from the partial set`
      );
      assert.equal(summary.condition, 'mapped-wildfire');
    }
  });
}

test('a truncated snapshot with an envelope that covers only one framing still posts all nine: truncation is checked on the snapshot, not the coverage', async () => {
  const { posts } = await runFeed({
    status: 'degraded',
    snapshot: loaded(WITH_PERIMETER, { truncated: true, envelope: bboxOf(COVERED) })
  });
  assert.equal(posts.length, FRAMING_KEYS.length);
  assert.equal(postedFor(posts, COVERED), true, 'the covered framing is posted too');
});

// ---------------------------------------------------------------------------
// A complete snapshot behaves as before
// ---------------------------------------------------------------------------

test('a complete loaded collection with a matching perimeter counts from the collection: no count-only POST for a covered framing', async () => {
  const { posts, snapshot } = await runFeed({
    status: 'ready',
    snapshot: loaded(WITH_PERIMETER, { truncated: false })
  });
  assert.equal(posts.length, 0, 'the national-fallback envelope covers every framing');
  const covered = snapshot.summaries[COVERED];
  assert.equal(covered.condition, 'mapped-wildfire');
  assert.ok(covered.mappedWildfirePerimeterCount >= 1, 'counted from the collection');
  assert.notEqual(covered.mappedWildfirePerimeterCount, COUNT_ANSWER, 'not the POST answer');
});

test('a complete, empty loaded collection reads a verified zero from the collection: no POST, and the framing does not claim a mapped perimeter', async () => {
  const { posts, snapshot } = await runFeed({
    status: 'ready',
    snapshot: loaded(EMPTY, { truncated: false })
  });
  assert.equal(posts.length, 0);
  for (const key of FRAMING_KEYS) {
    assert.equal(snapshot.summaries[key].mappedWildfirePerimeterCount, 0, `${key} counts zero`);
    assert.notEqual(snapshot.summaries[key].condition, 'mapped-wildfire');
  }
});

test('a complete snapshot under the degraded layer status is still read from the collection (the status alone never decides)', async () => {
  const { posts, snapshot } = await runFeed({
    status: 'degraded',
    snapshot: loaded(WITH_PERIMETER, { truncated: false })
  });
  assert.equal(posts.length, 0);
  assert.equal(snapshot.summaries[COVERED].condition, 'mapped-wildfire');
});

test('a framing the loaded collection does not cover still takes its count-only POST: only the covered framing reads the collection', async () => {
  const { posts, snapshot } = await runFeed({
    status: 'ready',
    snapshot: loaded(WITH_PERIMETER, { truncated: false, envelope: bboxOf(COVERED) })
  });
  assert.equal(postedFor(posts, COVERED), false, 'the covered framing sent no POST');
  const uncovered = FRAMING_KEYS.filter((key) => key !== COVERED);
  assert.equal(posts.length, uncovered.length, 'every other framing posted');
  for (const key of uncovered) assert.equal(postedFor(posts, key), true, `${key} was posted`);
  assert.equal(snapshot.summaries[COVERED].condition, 'mapped-wildfire');
  assert.notEqual(snapshot.summaries[COVERED].mappedWildfirePerimeterCount, COUNT_ANSWER);
});

test('no loaded snapshot at all (the layer says ready but nothing is loaded) takes the count-only POST for every framing', async () => {
  const { posts } = await runFeed({ status: 'ready', snapshot: null });
  assert.equal(posts.length, FRAMING_KEYS.length);
});
