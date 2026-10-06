import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Import real config objects only. This never enumerates tests, starts the
// Playwright CLI, launches a browser, or runs the configured webServer.
const configUrl = new URL('../playwright.config.ts', import.meta.url).href;
const saved = process.env.DDM_MEASURE_NATIVE_GPU;
let unset;
let zero;
let native;
try {
  delete process.env.DDM_MEASURE_NATIVE_GPU;
  unset = (await import(`${configUrl}?measure-proof=unset`)).default;
  process.env.DDM_MEASURE_NATIVE_GPU = '0';
  zero = (await import(`${configUrl}?measure-proof=zero`)).default;
  process.env.DDM_MEASURE_NATIVE_GPU = '1';
  native = (await import(`${configUrl}?measure-proof=native`)).default;
} finally {
  if (saved === undefined) delete process.env.DDM_MEASURE_NATIVE_GPU;
  else process.env.DDM_MEASURE_NATIVE_GPU = saved;
}

const project = (config, name) => config.projects.find((candidate) => candidate.name === name);
const softwareUse = {
  browserName: 'chromium',
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
};

test('unset and 0 keep the existing software measure configuration', () => {
  assert.deepEqual(project(unset, 'chromium-measure').use, softwareUse);
  assert.deepEqual(zero, unset);
});

test('native measure opt-in leaves ordinary projects and all routing unchanged', () => {
  for (const name of ['chromium', 'chromium-interaction', 'chromium-3d']) {
    assert.deepEqual(project(native, name), project(unset, name));
    assert.deepEqual(project(unset, name).use, softwareUse);
  }
  assert.deepEqual({ ...native, projects: undefined }, { ...unset, projects: undefined });
  assert.deepEqual(native.projects.map(({ use, ...rest }) => rest), unset.projects.map(({ use, ...rest }) => rest));
});

test('exact 1 selects only the headed native measure launch', () => {
  assert.deepEqual(project(native, 'chromium-measure').use, {
    browserName: 'chromium', headless: false,
    launchOptions: { args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-frame-rate-limit'] }
  });
});

test('native renderer admission requires an actual recognizable GPU identity', () => {
  // Execute the actual private predicate without importing a Playwright spec
  // into node:test and without copying the admission rule into this test.
  const source = readFileSync(new URL('./flow-measure.spec.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function knownHardwareRenderer(');
  const end = source.indexOf('\nasync function rendererString(', start);
  assert.ok(start >= 0 && end > start, 'the actual predicate has an isolated source range');
  const accepts = vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}; knownHardwareRenderer`);
  assert.equal(accepts({ vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)' }), true);
  for (const value of [
    { vendor: null, renderer: null },
    { vendor: 'Intel', renderer: 'unknown' },
    { vendor: 'Intel', renderer: 'WebKit WebGL' },
    { vendor: 'Google Inc.', renderer: 'ANGLE (Google, Vulkan (SwiftShader Device))' },
    { vendor: 'Mesa', renderer: 'llvmpipe (LLVM)' },
    { vendor: 'Microsoft', renderer: 'ANGLE (Microsoft Basic Render Driver)' }
  ]) assert.equal(accepts(value), false, JSON.stringify(value));
});

for (const completedArms of [0, 1]) {
  test(`paired-pan receipt is incomplete on disk after ${completedArms} arms without afterAll`, async () => {
    const source = readFileSync(new URL('./flow-measure.spec.ts', import.meta.url), 'utf8');
    const resultStart = source.indexOf('const results: Json = {}');
    const resultEnd = source.indexOf('\nfunction median(', resultStart);
    const callbackStart = source.indexOf("  test('records paired completed pans with wind and flow off', ");
    const callbackEnd = source.indexOf("\n  test('records frame rate,", callbackStart);
    assert.ok(resultStart >= 0 && resultEnd > resultStart && callbackStart >= 0 && callbackEnd > callbackStart);
    const directory = mkdtempSync(join(tmpdir(), 'ddm-paired-receipt-'));
    const file = join(directory, 'flow-measure.json');
    const oldCondition = { retained: 'unrelated partial-run receipt' };
    writeFileSync(file, JSON.stringify({ pairedPan: { complete: true, stale: true }, conditions: oldCondition }));
    const stopped = new Error('stop before the next arm completes');
    let run;
    let calls = 0;
    const register = (_title, callback) => { run = callback; };
    register.setTimeout = () => {};
    register.afterAll = () => {}; // Deliberately never run teardown persistence.
    const context = {
      test: register, OUT_DIR: directory, existsSync, mkdirSync, readFileSync, writeFileSync, join,
      NATIVE_GPU_REQUESTED: false, VIEWPORT: { width: 1440, height: 900 }, WARM_UP_MS: 1500,
      PAN_DIRECTIONS: [1, -1, 1, -1], PAN_DISTANCE_PX: 500, PAN_STEPS: 24, PAN_RELEASE_HOLD_MS: 200, RUNS: 3,
      measureCompletedPans: async (_browser, flow) => {
        if (calls++ < completedArms) return { flow, probe: 'completed arm' };
        const stored = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(stored.pairedPan.complete, false, 'an old completed receipt was replaced before this arm started');
        assert.equal(stored.pairedPan.stale, undefined);
        assert.deepEqual(stored.conditions, oldCondition, 'other partial-run results remain');
        if (completedArms) assert.deepEqual(stored.pairedPan.pairs[0].arms.off, { flow: 'off', probe: 'completed arm' });
        throw stopped;
      }
    };
    try {
      vm.runInNewContext(stripTypeScriptTypes(`${source.slice(resultStart, resultEnd)}\n${source.slice(callbackStart, callbackEnd)}`), context);
      assert.equal(typeof run, 'function', 'the real paired-pan callback registered');
      await assert.rejects(run({ browser: {} }), (error) => error === stopped);
    } finally {
      unlinkSync(file);
      rmdirSync(directory);
    }
  });
}

const windState = { status: 'live', kind: 'wind', form: 'moving', motion: 'moving', drawn: 'wind', steps: 10 };
const offState = { status: 'off', kind: 'off', form: 'none', motion: 'none', drawn: '', steps: null };
for (const scenario of [
  { name: 'moving wind', flow: 'wind', before: windState, after: { ...windState, steps: 20 }, valid: true },
  { name: 'flow off', flow: 'off', before: offState, after: offState, valid: true },
  { name: 'wind unavailable after warmup', flow: 'wind', before: { ...windState, status: 'unavailable' }, after: { ...windState, steps: 20 } },
  { name: 'wind stopped during pans', flow: 'wind', before: windState, after: offState },
  { name: 'wind never advanced', flow: 'wind', before: windState, after: windState },
  { name: 'off changed during pans', flow: 'off', before: offState, after: windState }
]) {
  test(`paired pan admits only its intended completed arm: ${scenario.name}`, async () => {
    const source = readFileSync(new URL('./flow-measure.spec.ts', import.meta.url), 'utf8');
    const start = source.indexOf('async function measureCompletedPans(');
    const end = source.indexOf('\nfunction samePanCamera(', start);
    assert.ok(start >= 0 && end > start);
    let state = scenario.flow === 'wind' ? windState : offState;
    let closed = false;
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const expectValue = (value) => ({
      toHaveAttribute: async (name, expected) => assert.equal({ 'data-status': state.status, 'data-flow-form': state.form, 'data-flow-motion': state.motion }[name], expected),
      toBe: (expected) => assert.equal(value, expected),
      toEqual: (expected) => assert.deepEqual(plain(value), plain(expected)),
      toMatchObject: (expected) => { for (const [key, entry] of Object.entries(expected)) assert.equal(value[key], entry); },
      toHaveLength: (length) => assert.equal(value.length, length),
      toBeGreaterThan: (limit) => assert.ok(value > limit),
      toBeGreaterThanOrEqual: (limit) => assert.ok(value >= limit)
    });
    const page = { evaluate: async (callback) => callback.toString().includes('__endPan') ? {
      startedAtMs: 1, endedAtMs: 10, intervalsMs: [1], longTasks: [], longTaskSupported: true
    } : undefined };
    let metricRead = 0;
    const context = {
      boot: async () => ({ page, cdp: { send: async () => {} }, context: { close: async () => { closed = true; } }, aborted: [] }),
      expect: expectValue, panelOf: () => ({}), hold: async () => { state = scenario.before; },
      panCameraSettles: async () => {}, panCamera: async () => ({}), actualMapRenderer: async () => ({ renderer: 'SwiftShader', vendor: 'Google' }),
      isSoftwareGl: () => true, SOFTWARE_GL_LABEL: 'software', WARM_UP_MS: 1500,
      readPanFlowState: async () => ({ ...state }),
      pageMetrics: async () => [{ name: 'TaskDuration', value: ++metricRead }], taskSeconds: (metrics) => metrics[0].value,
      performance, completedPans: async () => { state = scenario.after; return [{}, {}, {}, {}]; },
      PAN_DIRECTIONS: [1, -1, 1, -1], noddStubLog: () => [], expectNoEscape: () => {}
    };
    const run = vm.runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}; measureCompletedPans`, context);
    if (scenario.valid) {
      const result = await run({}, scenario.flow);
      assert.deepEqual(plain(result.flowBefore), scenario.before);
      assert.deepEqual(plain(result.flowAfter), scenario.after);
    } else await assert.rejects(run({}, scenario.flow), { name: 'AssertionError' });
    assert.equal(closed, true, 'the arm releases its browser context on success or rejection');
  });
}
