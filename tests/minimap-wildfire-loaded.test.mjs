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
const BCWS_LAYER_MODULE = '/src/layers/bcws-fires.ts';
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
    // The BC layer's fire areas, as its module answers them (src/layers/bcws-fires.ts `fireAreas`).
    if (url.endsWith(BCWS_LAYER_MODULE)) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export function fireAreas() { return globalThis.__minimapAreas ?? { areaOf: new Map() }; }'
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
/** The BC read's answers: its two whole-table counts and its active perimeters (no live host). */
const BC_QUIET = { count: 319, features: [] };

async function runFeed({ status, snapshot, bc = BC_QUIET, nifcCount = COUNT_ANSWER, bcStatus, areas }) {
  const original = globalThis.fetch;
  const posts = [];
  const bcUrls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('BCWS_FirePerimeters_PublicView')) {
      bcUrls.push(url);
      if (bc === 'fail') return new Response('', { status: 503 });
      const body = new URL(url).searchParams.get('returnCountOnly') === 'true'
        ? { count: bc.count }
        : { type: 'FeatureCollection', features: bc.features };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    posts.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ count: nifcCount }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  globalThis.__minimapLoaded = snapshot;
  globalThis.__minimapAreas = areas;
  registry.deactivate('nifc-fires');
  registry.deactivate('bcws-fires');
  if (status !== undefined) registry.setStatus('nifc-fires', status);
  if (bcStatus !== undefined) registry.setStatus('bcws-fires', bcStatus);
  let release = () => {};
  try {
    const settled = await new Promise((resolve) => {
      release = minimap.retainMinimapWildfire((next) => {
        if (next.checkedAtUtc !== null) resolve(next);
      });
    });
    return { posts, bcUrls, snapshot: settled };
  } finally {
    release();
    registry.deactivate('nifc-fires');
    registry.deactivate('bcws-fires');
    globalThis.__minimapLoaded = null;
    globalThis.__minimapAreas = undefined;
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

// ---------------------------------------------------------------------------
// The minimap read wrong outside Drought (owner look, 2026-10-12): one orange
// whatever the fire count, and Drought Monitor wording in every mode.
// ---------------------------------------------------------------------------

test('the mapped-wildfire fill deepens with the perimeter count: one, a few and many perimeters read differently', () => {
  const opacity = minimap.mappedWildfireFillOpacity;
  assert.ok(opacity(1) > 0, 'a single perimeter is still drawn');
  assert.ok(opacity(1) < opacity(5), 'five reads deeper than one');
  assert.ok(opacity(5) < opacity(300), 'three hundred reads deeper than five');
  assert.equal(opacity(300), 1, 'the busiest tier is the full mark');
  let previous = 0;
  for (const tier of minimap.MINIMAP_WILDFIRE_COUNT_TIERS) {
    assert.ok(tier.opacity > previous, `tier from ${tier.min} is deeper than the one below it`);
    assert.equal(opacity(tier.min), tier.opacity, `a count of ${tier.min} lands in its own tier`);
    previous = tier.opacity;
  }
});

test('each mode cites its own minimap source, enumerated from the cluster table: only Drought names the Drought Monitor', async () => {
  const { HAZARD_CLUSTER_KEYS } = await import('../src/config/clusters.ts');
  const { framingMinimapProvenance } = await import('../src/config/framings.ts');
  assert.match(framingMinimapProvenance('pacific-coast', 'drought'), /North American Drought Monitor/);
  for (const mode of HAZARD_CLUSTER_KEYS.filter((key) => key !== 'drought')) {
    for (const key of FRAMING_KEYS) {
      const clause = framingMinimapProvenance(key, mode);
      assert.equal(typeof clause, 'string', `${mode} names a source for ${key}`);
      assert.ok(clause.length > 0, `${mode} clause for ${key} is not empty`);
      assert.doesNotMatch(clause, /Drought Monitor|drought/i, `${mode} clause for ${key} cites no drought source`);
      assert.doesNotMatch(clause, /Navigation only/, `${mode} clause for ${key} says what the minimap shows`);
    }
  }
});

test('the missing Nunavut mask sentence is only for framings that can contain Nunavut', async () => {
  const { framingMayContainNunavut } = await import('../src/config/framings.ts');
  const reach = Object.fromEntries(FRAMING_KEYS.map((key) => [key, framingMayContainNunavut(key)]));
  assert.equal(reach['boreal-arctic'], true);
  for (const key of ['hawaii', 'mexico', 'southeast-gulf', 'alaska-northwest']) {
    assert.equal(reach[key], false, `${key} cannot contain Nunavut`);
  }
});

// ---------------------------------------------------------------------------
// BC Wildfire Service beside NIFC (the acceptance of 2026-09-25): the framings
// that reach British Columbia count the issuer's active stages, a known fire
// area once, and a failed BC read never as zero.
// ---------------------------------------------------------------------------

/** A small square at the Border 2 fire (49.0 N, 121 W), inside Pacific Coast and British Columbia's box. */
const BORDER_SQUARE = { type: 'Polygon', coordinates: [[[-121.1, 49.0], [-121.0, 49.0], [-121.0, 49.1], [-121.1, 49.1], [-121.1, 49.0]]] };
const BC_ACTIVE = { type: 'Feature', properties: { OBJECTID: 217, FIRE_NUMBER: 'V10885', FIRE_YEAR: 2026, FIRE_STATUS: 'Under Control' }, geometry: BORDER_SQUARE };
const NIFC_BORDER = {
  type: 'Feature',
  properties: { attr_ActiveFireCandidate: 1, attr_IncidentTypeCategory: 'WF', attr_UniqueFireIdentifier: '2026-WANCP-000266' },
  geometry: BORDER_SQUARE
};

test('setup: the Border square lies in Pacific Coast, and Mexico and Hawaii do not reach British Columbia', async () => {
  const { geometriesOverlap } = await import('../src/util/polygon-overlap.ts');
  assert.equal(geometriesOverlap(BORDER_SQUARE, minimap.framingGeometry(COVERED)), true);
});

test('a framing that reaches British Columbia adds the active BC perimeters to its count; one outside it carries no BC field', async () => {
  const { bcUrls, snapshot } = await runFeed({ status: undefined, nifcCount: 0, bc: { count: 319, features: [BC_ACTIVE] } });
  const covered = snapshot.summaries[COVERED];
  assert.equal(covered.mappedWildfirePerimeterCount, 1);
  assert.equal(covered.condition, 'mapped-wildfire');
  assert.equal(covered.bcwsPerimeterCount, 1);
  assert.equal(covered.fireAreasMerged, 0);
  for (const key of ['mexico', 'hawaii', 'southeast-gulf']) {
    assert.equal('bcwsPerimeterCount' in snapshot.summaries[key], false, `${key} is outside British Columbia`);
    assert.equal(snapshot.summaries[key].mappedWildfirePerimeterCount, 0);
  }
  // One province read of the active stages, bracketed by two whole-table counts.
  assert.equal(bcUrls.length, 3);
  const read = new URL(bcUrls.find((url) => url.includes('f=geojson')));
  assert.equal(read.searchParams.get('where'), "FIRE_STATUS IN ('Out of Control','Being Held','Under Control')");
  assert.equal(read.searchParams.get('geometry'), '-139.5,48,-113.5,60');
});

test('a failed BC read is never a zero for British Columbia: with no NIFC perimeter the framing is unavailable, with one it stays mapped and names BC unavailable', async () => {
  const none = await runFeed({ status: undefined, nifcCount: 0, bc: 'fail' });
  assert.equal(none.snapshot.summaries[COVERED].condition, 'unavailable');
  assert.equal(none.snapshot.summaries[COVERED].mappedWildfirePerimeterCount, null);
  assert.equal(none.snapshot.summaries[COVERED].bcwsPerimeterCount, null);
  assert.notEqual(none.snapshot.summaries.mexico.condition, 'unavailable', 'a framing outside British Columbia keeps its own answer');
  const some = await runFeed({ status: undefined, nifcCount: 2, bc: 'fail' });
  assert.equal(some.snapshot.summaries[COVERED].condition, 'mapped-wildfire');
  assert.equal(some.snapshot.summaries[COVERED].mappedWildfirePerimeterCount, 2);
  assert.equal(some.snapshot.summaries[COVERED].bcwsPerimeterCount, null);
});

test('a BC answer taken while the service reloads (its two whole-table counts disagree) is unavailable, never a zero', async () => {
  let counts = 0;
  const original = globalThis.Response;
  const { snapshot } = await runFeed({
    status: undefined,
    nifcCount: 0,
    bc: {
      get count() { counts += 1; return counts === 1 ? 0 : 319; },
      features: []
    }
  });
  assert.equal(globalThis.Response, original);
  assert.equal(snapshot.summaries[COVERED].condition, 'unavailable', 'an emptied layer mid-reload is not "no BC fires"');
});

test('a known fire area counts once and carries the ratified label; unknown, the two agencies count apart', async () => {
  const nifc = loaded({ type: 'FeatureCollection', features: [NIFC_BORDER] }, { truncated: false });
  const areaOf = new Map([['nifc:2026-WANCP-000266', 'fa:x'], ['bcws:2026-V10885', 'fa:x']]);
  const once = await runFeed({ status: 'ready', snapshot: nifc, bc: { count: 319, features: [BC_ACTIVE] }, bcStatus: 'ready', areas: { areaOf } });
  assert.equal(once.snapshot.summaries[COVERED].mappedWildfirePerimeterCount, 1);
  assert.equal(once.snapshot.summaries[COVERED].fireAreasMerged, 1);
  const apart = await runFeed({ status: 'ready', snapshot: nifc, bc: { count: 319, features: [BC_ACTIVE] } });
  assert.equal(apart.snapshot.summaries[COVERED].mappedWildfirePerimeterCount, 2);
  assert.equal(apart.snapshot.summaries[COVERED].fireAreasMerged, 0);
});

test('the BC stage whitelist decides what the minimap counts: Out and an unstated stage are not active', async () => {
  const out = { ...BC_ACTIVE, properties: { ...BC_ACTIVE.properties, FIRE_STATUS: 'Out' } };
  const unstated = { ...BC_ACTIVE, properties: { ...BC_ACTIVE.properties, OBJECTID: 1, FIRE_NUMBER: 'C22352', FIRE_STATUS: null } };
  const { snapshot } = await runFeed({ status: undefined, nifcCount: 0, bc: { count: 319, features: [out, unstated] } });
  assert.equal(snapshot.summaries[COVERED].bcwsPerimeterCount, 0);
  assert.notEqual(snapshot.summaries[COVERED].condition, 'mapped-wildfire');
});
