import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Drive the spec's real step and row bodies, without starting Playwright or a
// page. These prove the test wiring; browser runs still own native scene proof.
const source = readFileSync(new URL('./view-contracts.spec.ts', import.meta.url), 'utf8');
function body(name) {
  const value = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^}`, 'm'))?.[0];
  assert.ok(value, `${name} remains an ordinary source function`);
  return stripTypeScriptTypes(value);
}
function expect(value, message) {
  return {
    toEqual: (wanted) => assert.deepEqual(value, wanted, message),
    toContain: (wanted) => assert.ok(value.includes(wanted), message),
  };
}
expect.soft = expect;
expect.poll = () => { throw new Error('a wall-clock poll was used'); };

const power = () => ({ unanswered: [], archive: [], warnings: [], timeline: [] });
function rowRunner(row, reads) {
  const callback = source.match(/test\(row\.id, (async \(\{ page \}\) => \{[\s\S]*?)^    \}\);/m)?.[1];
  assert.ok(callback, 'the matrix still registers its real row callback');
  const annotations = [];
  const bindings = {
    row, expect, test: { setTimeout() {}, info: () => ({ annotations }) },
    watchPowerLayerReads: async () => reads,
    trackSceneTraffic: () => ({}),
    gotoApp: async () => {}, runStep: async () => {}, assertExpectations: async () => {},
    console: { log() {} },
  };
  return Function(...Object.keys(bindings), `return ${stripTypeScriptTypes(`${callback}\n}`)};`)(...Object.values(bindings));
}
function row(steps) { return { id: 'controlled row', url: '?cluster=wildfire', steps, expect: {} }; }

test('the declared held probe cannot pass a row without its positive timeline event', async () => {
  await assert.rejects(rowRunner(row([{ hold_first_power_probe: 12000 }]), power())({ page: {} }), /hold|holding|probe/i);
});

test('a different held duration does not satisfy the declared probe', async () => {
  const reads = power();
  reads.timeline.push('holding the first line archive probe 1 ms');
  await assert.rejects(rowRunner(row([{ hold_first_power_probe: 12000 }]), reads)({ page: {} }), /hold|holding|probe/i);
});

test('the exact held probe event and rows without a hold retain their outcomes', async () => {
  const reads = power();
  reads.timeline.push('holding the first line archive probe 12000 ms');
  await rowRunner(row([{ hold_first_power_probe: 12000 }]), reads)({ page: {} });
  await rowRunner(row([]), power())({ page: {} });
});

function stepRunner(overrides = {}) {
  const bindings = {
    expect, FIRE3D_STAMP_TIMEOUT_MS: 60_000,
    fire3dStamp: async () => 'active', fire3dContextStamp: async () => 'whp structures',
    untilAnswered: async (read, accept, budget, what) => {
      const value = await read();
      assert.ok(accept(value), what);
      return value;
    },
    waitForSceneToSettle: async () => { throw new Error('the scene was required to become quiet'); },
    POWER_LINES_ARCHIVE: 'power-lines-pnw.pmtiles',
    setTimeout: (resolve) => { resolve(); },
    ...overrides,
  };
  const run = Function(...Object.keys(bindings), `${body('runStep')}; return runStep;`)(...Object.values(bindings));
  return (page, step, reads) => run.length === 4 ? run(page, step, {}, reads) : run(page, step, reads);
}

test('the legacy scene step waits for the reported context at the unchanged 30 s budget', async () => {
  const waits = [];
  const run = stepRunner({ untilAnswered: async (read, accept, budget) => {
    waits.push(budget);
    assert.equal(accept(undefined), false);
    assert.equal(accept('whp'), false);
    assert.equal(accept(await read()), true);
  } });
  await run({}, { settle_scene: true }, power());
  assert.deepEqual(waits, [30_000]);
});

test('a fire3d step uses the answered-read wait with its exact expected state and 60 s budget', async () => {
  const waits = [];
  const run = stepRunner({ untilAnswered: async (read, accept, budget) => {
    waits.push(budget);
    assert.equal(accept('inactive'), false);
    assert.equal(accept(await read()), true);
  } });
  await run({}, { wait_fire3d: 'active' }, power());
  assert.deepEqual(waits, [60_000]);
});

test('only the exact first power header request records the hold timeline', async () => {
  let handler;
  const reads = power();
  const run = stepRunner();
  await run({ route: async (_match, callback) => { handler = callback; } }, { hold_first_power_probe: 12000 }, reads);
  let fallbacks = 0;
  const route = (range) => ({ request: () => ({ headers: () => ({ range }) }), fallback: async () => { fallbacks++; } });
  await handler(route('bytes=0-127'));
  assert.deepEqual(reads.timeline, []);
  await handler(route('bytes=0-126'));
  await handler(route('bytes=0-126'));
  assert.deepEqual(reads.timeline, ['holding the first line archive probe 12000 ms']);
  assert.equal(fallbacks, 3);
});

function expectationRunner(overrides) {
  const bindings = { expect, FIRE3D_STAMP_TIMEOUT_MS: 60_000, URL_POLL_TIMEOUT_MS: 20_000, ...overrides };
  return Function(...Object.keys(bindings), `${body('assertExpectations')}; return assertExpectations;`)(...Object.values(bindings));
}

test('power status explicitly polls a missing pill, then loading, then the exact ready class', async () => {
  const values = [null, 'layer-toggle-status loading', 'layer-toggle-status ready'];
  let reads = 0;
  const recorded = power();
  const page = { evaluate: async (callback, key) => {
    const cls = values[reads++];
    const document = { querySelector: (selector) => {
      assert.equal(selector, '[data-layer-status="power-infrastructure"]');
      return cls === null ? null : { getAttribute: () => cls };
    } };
    return Function('document', `return (${callback.toString()});`)(document)(key);
  } };
  const run = expectationRunner({ untilAnswered: async (read, accept, budget) => {
    assert.equal(budget, 60_000);
    assert.equal(accept(await read()), false);
    assert.equal(accept(await read()), false);
    assert.equal(accept(await read()), true);
  } });
  await run(page, { layer_status: { 'power-infrastructure': 'ready' } }, recorded);
  assert.equal(reads, 3);
  assert.equal(recorded.timeline.length, 2);
  assert.match(recorded.timeline[0], /loading$/);
  assert.match(recorded.timeline[1], /ready$/);
});

test('page read exceptions propagate from status polling', async () => {
  const failure = new Error('page closed during the status read');
  const run = expectationRunner({ untilAnswered: async (read) => read() });
  await assert.rejects(run({ evaluate: async () => { throw failure; } }, { layer_status: { 'power-infrastructure': 'ready' } }, power()), (error) => error === failure);
});

test('the URL expectation retains its exact value and 20 s budget', async () => {
  const run = expectationRunner({
    urlParam: async (_page, name) => { assert.equal(name, 'fire3d'); return 'true'; },
    untilAnswered: async (read, accept, budget) => {
      assert.equal(budget, 20_000);
      assert.equal(accept(null), false);
      assert.equal(accept('false'), false);
      assert.equal(accept(await read()), true);
    },
  });
  await run({}, { url_params: { fire3d: 'true' } }, power());
});
