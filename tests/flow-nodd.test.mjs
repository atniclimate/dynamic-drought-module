/**
 * E1-2 NODD-READ (ENSO-FLOW-PLAN section 3, block E1; admission
 * gfs-runtime-nodd lines 1, 3 to 7 and 15): the bounded, cancellable NODD
 * reader (src/layers/flow/nodd.ts), the decode Worker's pure core
 * (src/layers/flow/decode-worker.ts) and the kind-to-product adapter that
 * owns the one FROM-to-TO wave rotation (src/layers/flow/source.ts).
 *
 * Every request is answered by a stub of globalThis.fetch that serves the
 * E1-1 fixtures (tests/fixtures/flow/, the 2026-10-05 06Z cycle, f006) at
 * their real NODD keys and byte offsets; nothing touches the network. The
 * decode Worker is replaced by an in-process stand-in that runs the real
 * worker core (decodeFrame) on the posted bytes, so the decode, crop,
 * quantize and FlowField steps are the production code.
 *
 * Runs under plain `node --test` (Node 24 strips types).
 */

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// src/ imports are extensionless (the bundler resolves them); map them to
// the .ts file, as tests/flow-grib-decode.test.mjs does.
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

const nodd = await import('../src/layers/flow/nodd.ts');
const source = await import('../src/layers/flow/source.ts');
const worker = await import('../src/layers/flow/decode-worker.ts');
const { decodeGrib2 } = await import('../src/layers/flow/grib2.ts');
const { gridPosition, sampleField, newSample, cellValid } = await import('../src/layers/flow/field.ts');

const { candidateCycle, forecastHourFor, locateMessage, readFlowFrame, FlowUnavailableError } = nodd;
const { FLOW_SOURCES, NODD_ORIGIN, waveToVector } = source;
const { decodeFrame, buildPacket } = worker;

const HOUR = 3_600_000;
const CYCLE_06Z = Date.UTC(2026, 9, 5, 6); // the fixtures' cycle
const NOW = Date.UTC(2026, 9, 5, 12, 30); // candidate 06Z; wind f006, wave f006

// ---------------------------------------------------------------------------
// Fixtures at their NODD keys
// ---------------------------------------------------------------------------

const FIXTURES = new URL('./fixtures/flow/', import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
const reference = JSON.parse(readFileSync(new URL('reference.json', FIXTURES), 'utf8'));
const refValues = (name) => new Float64Array(fixture(`${name}.ref.f64`).buffer.slice(0));

const WIND_KEY = 'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006';
const WAVE_KEY = 'gfs.20261005/06/wave/gridded/gfswave.t06z.global.0p25.f006.grib2';
const WIND_IDX = new TextDecoder().decode(fixture('gfs.t06z.pgrb2.1p00.f006.idx'));
const WAVE_IDX = new TextDecoder().decode(fixture('gfswave.t06z.global.0p25.f006.grib2.idx'));

/** Byte ranges of each served object: start offset to its bytes. */
const OBJECTS = new Map([
  [`${NODD_ORIGIN}/${WIND_KEY}.idx`, { idx: WIND_IDX }],
  [`${NODD_ORIGIN}/${WAVE_KEY}.idx`, { idx: WAVE_IDX }],
  [
    `${NODD_ORIGIN}/${WIND_KEY}`,
    {
      ranges: new Map([
        [34998139, fixture('gfs1p00-UGRD-10m-f006.grib2')],
        [35077225, fixture('gfs1p00-VGRD-10m-f006.grib2')]
      ])
    }
  ],
  [
    `${NODD_ORIGIN}/${WAVE_KEY}`,
    {
      ranges: new Map([
        [3029161, fixture('global0p25-HTSGW-f006.grib2')],
        // No global DIRPW fixture exists (887 kB); its span is served as
        // zeros of the right length, which the decoder refuses as not GRIB.
        [3968286, new Uint8Array(4855671 - 3968286 + 1)]
      ])
    }
  ]
]);

function streamOf(bytes, { stall = false, onCancel } = {}) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes);
      if (!stall) controller.close();
    },
    cancel() {
      onCancel?.();
    }
  });
}

/**
 * A NODD stand-in. Each call is recorded with its method, headers and
 * credentials. `.idx` keys answer 206 with the whole index when the Range
 * covers it (S3's answer to `bytes=0-cap` on a shorter object); message
 * keys answer 206 for an exact message span; any other key answers 404.
 */
function noddStub({ stallRanges = false, missingIdx = false } = {}) {
  const calls = [];
  const cancelled = [];
  let noteRange;
  const rangesSeen = new Promise((resolve) => {
    noteRange = resolve;
  });
  const fetchImpl = async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    const call = {
      url: String(url),
      method: (init.method ?? 'GET').toUpperCase(),
      credentials: init.credentials,
      range: headers.get('range')
    };
    calls.push(call);
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const object = OBJECTS.get(call.url);
    if (!object || (missingIdx && object.idx !== undefined)) {
      return new Response(streamOf(new TextEncoder().encode('<Error><Code>NoSuchKey</Code></Error>')), {
        status: 404
      });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(call.range ?? '');
    if (object.idx !== undefined) {
      const body = new TextEncoder().encode(object.idx);
      const end = m ? Math.min(Number(m[2]), body.byteLength - 1) : body.byteLength - 1;
      return new Response(streamOf(body.subarray(0, end + 1)), { status: m ? 206 : 200 });
    }
    if (!m) return new Response(streamOf(new Uint8Array(0)), { status: 200 });
    const start = Number(m[1]);
    const bytes = object.ranges.get(start);
    if (!bytes || start + bytes.byteLength - 1 !== Number(m[2])) {
      return new Response(streamOf(new Uint8Array(0)), { status: 416 });
    }
    const rangesSoFar = calls.filter((c) => !c.url.endsWith('.idx')).length;
    if (rangesSoFar >= 2) noteRange();
    const body = streamOf(bytes, {
      stall: stallRanges,
      onCancel: () => cancelled.push(call.url + ' ' + call.range)
    });
    return new Response(body, { status: 206 });
  };
  return { fetchImpl, calls, cancelled, rangesSeen };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** An in-process stand-in for the module Worker: runs the real worker core. */
function inProcessWorker({ hold = false } = {}) {
  const record = { posted: 0, terminated: false };
  const make = () => {
    const w = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        record.posted++;
        if (hold) return;
        setTimeout(() => {
          if (record.terminated) return;
          let data;
          try {
            data = { ok: true, packet: decodeFrame(message) };
          } catch (e) {
            data = { ok: false, error: String(e?.message ?? e) };
          }
          w.onmessage?.({ data });
        }, 0);
      },
      terminate() {
        record.terminated = true;
      }
    };
    record.worker = w;
    return w;
  };
  return { make, record };
}

function raced(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Capture the production timers so deadline checks do not sleep or depend on
// machine load. Fetch body timers have been cleared by the time decode posts.
async function controlledDecode(run, { throwOnPost = false } = {}) {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => {
    const handle = {};
    timers.set(handle, { callback, delay });
    return handle;
  };
  globalThis.clearTimeout = (handle) => timers.delete(handle);
  let posted;
  const ready = new Promise((resolve) => { posted = resolve; });
  const activation = new AbortController();
  let request;
  let terminated = 0;
  const fake = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(value) {
      request = value;
      posted();
      if (throwOnPost) throw new Error('post failed');
    },
    terminate() { terminated++; }
  };
  const pending = read('wind', noddStub(), { signal: activation.signal, createWorker: () => fake });
  // Observe rejection immediately, including a synchronous postMessage failure.
  const outcome = pending.then((field) => ({ field }), (error) => ({ error }));
  try {
    await ready;
    await run({ fake, timers, activation, outcome, request: () => request, terminated: () => terminated });
  } finally {
    activation.abort();
    // A deliberately broken decoder can ignore cancellation after clearing its
    // own handlers. Let cleanup microtasks finish without wedging the test suite.
    await Promise.race([outcome, new Promise((resolve) => setImmediate(resolve))]);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
}

function assertDecodeReleased(probe) {
  assert.equal(probe.terminated(), 1, 'the Worker is terminated exactly once');
  assert.equal(probe.timers.size, 0, 'no decode timer remains');
  for (const handler of ['onmessage', 'onerror', 'onmessageerror']) {
    assert.equal(probe.fake[handler], null, `${handler} is released`);
  }
}

test('a decoder factory failure releases the activation link without starting a read', async () => {
  const activation = new AbortController();
  const listeners = new Set();
  const signal = activation.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, ...args) => {
    if (type === 'abort') listeners.add(listener);
    add(type, listener, ...args);
  };
  signal.removeEventListener = (type, listener, ...args) => {
    if (type === 'abort') listeners.delete(listener);
    remove(type, listener, ...args);
  };
  const stub = noddStub();
  try {
    const error = await read('wind', stub, {
      signal,
      createWorker() { throw new Error('Worker could not start'); }
    }).catch((error) => error);
    assert.equal(listeners.size, 0, 'the failed activation retains no abort listener');
    assert.ok(error instanceof FlowUnavailableError && error.reason === 'failed');
    assert.equal(stub.calls.length, 0, 'no network read begins without a Worker');
  } finally {
    activation.abort();
  }
});

test('a silent decoder reaches the existing read deadline and releases all handlers', async () => {
  await controlledDecode(async (probe) => {
    assert.equal(probe.timers.size, 1, 'one completion deadline follows the completed network reads');
    const deadline = [...probe.timers.values()][0];
    assert.equal(deadline.delay, nodd.FLOW_READ_BUDGET_MS);
    const lateMessage = probe.fake.onmessage;
    deadline.callback();
    const { error } = await probe.outcome;
    assert.ok(error instanceof FlowUnavailableError);
    assert.equal(error.reason, 'failed');
    assertDecodeReleased(probe);
    lateMessage({ get data() { throw new Error('a settled decoder must ignore queued replies'); } });
    probe.activation.abort();
    assertDecodeReleased(probe);
  });
});

for (const completion of ['messageerror', 'error', 'abort', 'success', 'refused', 'post throws', 'null reply', 'undefined reply']) {
  test(`decoder ${completion} settles once and clears its deadline and handlers`, async () => {
    await controlledDecode(async (probe) => {
      const deadline = [...probe.timers.values()][0];
      if (completion === 'messageerror') {
        assert.equal(typeof probe.fake.onmessageerror, 'function', 'messageerror is handled');
        probe.fake.onmessageerror({});
      } else if (completion === 'error') probe.fake.onerror({});
      else if (completion === 'abort') probe.activation.abort();
      else if (completion === 'success') probe.fake.onmessage({ data: { ok: true, packet: decodeFrame(probe.request()) } });
      else if (completion === 'refused') probe.fake.onmessage({ data: { ok: false, error: 'invalid frame' } });
      else if (completion === 'null reply') probe.fake.onmessage({ data: null });
      else if (completion === 'undefined reply') probe.fake.onmessage({ data: undefined });
      const { field, error } = await probe.outcome;
      if (completion === 'success') assert.equal(field.kind, 'wind');
      else if (completion === 'abort') assert.equal(error.name, 'AbortError');
      else {
        assert.ok(error instanceof FlowUnavailableError);
        assert.equal(error.reason, completion === 'refused' ? 'refused' : 'failed');
      }
      assertDecodeReleased(probe);
      // An already queued timeout cannot change the settled result or release twice.
      deadline?.callback();
      assertDecodeReleased(probe);
    }, { throwOnPost: completion === 'post throws' });
  });
}

const read = (kind, stub, opts = {}) =>
  withFetch(stub, () =>
    readFlowFrame(kind, {
      signal: opts.signal ?? new AbortController().signal,
      now: opts.now ?? (() => NOW),
      createWorker: opts.createWorker ?? inProcessWorker().make
    })
  );

// ---------------------------------------------------------------------------
// The cycle and the forecast hour
// ---------------------------------------------------------------------------

test('the cycle candidate is floor((now − 3 h 30 m) / 6 h)', () => {
  assert.equal(candidateCycle(Date.UTC(2026, 9, 5, 9, 30)), CYCLE_06Z);
  assert.equal(candidateCycle(Date.UTC(2026, 9, 5, 9, 29, 59, 999)), Date.UTC(2026, 9, 5, 0));
  assert.equal(candidateCycle(Date.UTC(2026, 9, 5, 15, 29)), CYCLE_06Z);
  assert.equal(candidateCycle(Date.UTC(2026, 9, 5, 3, 29)), Date.UTC(2026, 9, 4, 18));
  for (let t = Date.UTC(2026, 9, 4); t < Date.UTC(2026, 9, 6); t += 7 * 60_000) {
    const cycle = candidateCycle(t);
    assert.equal(cycle % (6 * HOUR), 0, 'a cycle is on a 6 h boundary');
    assert.ok(t - cycle >= 3.5 * HOUR && t - cycle < 9.5 * HOUR, `lag ${(t - cycle) / HOUR} h`);
  }
});

test('the forecast hour is the latest valid time not after now (3-hourly 1p00, hourly wave)', () => {
  const at = (h, m = 0) => CYCLE_06Z + h * HOUR + m * 60_000;
  assert.equal(forecastHourFor('wind', CYCLE_06Z, at(3, 30)), 3);
  assert.equal(forecastHourFor('wind', CYCLE_06Z, at(5, 59)), 3);
  assert.equal(forecastHourFor('wind', CYCLE_06Z, at(6)), 6);
  assert.equal(forecastHourFor('wind', CYCLE_06Z, at(9, 29)), 9);
  assert.equal(forecastHourFor('waves', CYCLE_06Z, at(3, 30)), 3);
  assert.equal(forecastHourFor('waves', CYCLE_06Z, at(4)), 4);
  assert.equal(forecastHourFor('waves', CYCLE_06Z, at(9, 29)), 9);
  // After one step back the same clock reads f009 to f015.
  assert.equal(forecastHourFor('wind', CYCLE_06Z - 6 * HOUR, at(9, 29)), 15);
  assert.equal(forecastHourFor('waves', CYCLE_06Z - 6 * HOUR, at(3, 30)), 9);
  for (let t = at(3, 30); t < at(15, 30); t += 11 * 60_000) {
    for (const kind of ['wind', 'waves']) {
      const fh = forecastHourFor(kind, CYCLE_06Z, t);
      const step = kind === 'wind' ? 3 : 1;
      assert.equal(fh % step, 0, `${kind} f${fh} is on its cadence`);
      const valid = CYCLE_06Z + fh * HOUR;
      assert.ok(valid <= t, 'the valid time is not after now');
      assert.ok(valid + step * HOUR > t, 'it is the latest such time');
    }
  }
});

test('a 404 .idx steps back 6 h, at most 3 tries, then reads unavailable', async () => {
  const stub = noddStub({ missingIdx: true });
  await assert.rejects(read('wind', stub), (e) => e instanceof FlowUnavailableError && e.reason === 'not-published');
  assert.deepEqual(
    stub.calls.map((c) => c.url.slice(NODD_ORIGIN.length + 1)),
    [
      'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006.idx',
      'gfs.20261005/00/atmos/gfs.t00z.pgrb2.1p00.f012.idx',
      'gfs.20261004/18/atmos/gfs.t18z.pgrb2.1p00.f018.idx'
    ],
    'three .idx GETs, each 6 h earlier with its forecast hour recomputed, and no range'
  );
  const waves = noddStub({ missingIdx: true });
  await assert.rejects(read('waves', waves), (e) => e instanceof FlowUnavailableError && e.reason === 'not-published');
  assert.deepEqual(
    waves.calls.map((c) => c.url.slice(NODD_ORIGIN.length + 1)),
    [
      'gfs.20261005/06/wave/gridded/gfswave.t06z.global.0p25.f006.grib2.idx',
      'gfs.20261005/00/wave/gridded/gfswave.t00z.global.0p25.f012.grib2.idx',
      'gfs.20261004/18/wave/gridded/gfswave.t18z.global.0p25.f018.grib2.idx'
    ]
  );
});

// ---------------------------------------------------------------------------
// The .idx
// ---------------------------------------------------------------------------

test('the .idx line match refuses a wrong d=, a wrong STEP and a last-line message', () => {
  const wind = FLOW_SOURCES.wind;
  const u = wind.messages[0];
  assert.deepEqual(locateMessage(WIND_IDX, u, CYCLE_06Z, 6), { start: 34998139, end: 35077224 });
  assert.deepEqual(locateMessage(WAVE_IDX, FLOW_SOURCES.waves.messages[0], CYCLE_06Z, 6).start, 3968286);
  const refused = (fn) => assert.throws(fn, (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
  // d= names another cycle.
  refused(() => locateMessage(WIND_IDX, u, CYCLE_06Z - 6 * HOUR, 6));
  refused(() => locateMessage(WIND_IDX.replaceAll('d=2026100506', 'd=2026100500'), u, CYCLE_06Z, 6));
  // STEP names another hour.
  refused(() => locateMessage(WIND_IDX, u, CYCLE_06Z, 3));
  refused(() => locateMessage(WIND_IDX.replace(':UGRD:10 m above ground:6 hour fcst:', ':UGRD:10 m above ground:6-7 hour ave fcst:'), u, CYCLE_06Z, 6));
  // The needed message is the last line: its end is unknown.
  const cut = WIND_IDX.split('\n').filter((line) => Number(line.split(':')[0]) <= 588).join('\n') + '\n';
  refused(() => locateMessage(cut, u, CYCLE_06Z, 6));
  // A near-miss level is not the 10 m level.
  refused(() => locateMessage(WIND_IDX.replace(':UGRD:10 m above ground:', ':UGRD:100 m above ground:'), u, CYCLE_06Z, 6));
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** Synthetic offsets are inspected only: a message fetch throws before returning a body. */
function offsetProbe(kind, offsets) {
  const lines = FLOW_SOURCES[kind].messages.map(
    (message, i) => `${i + 1}:${offsets[i]}:d=2026100506:${message.variable}:${message.level}:6 hour fcst:`
  );
  lines.push(`3:${offsets[2]}:d=2026100506:OTHER:surface:6 hour fcst:`);
  const ranges = [];
  const stub = {
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('.idx')) return new Response(lines.join('\n'), { status: 206 });
      ranges.push(new Headers(init.headers).get('range'));
      // Never let the old, uncapped reader reach its Uint8Array allocation.
      throw new RangeError('the range probe stops before a body or allocation');
    }
  };
  return { stub, ranges };
}

test('invalid index offsets are refused before any message fetch or decode', async () => {
  for (const offsets of [
    [-1, 10, 20],
    ['', 10, 20],
    ['1.5', 10, 20],
    ['0x10', 20, 30],
    ['1e1', 20, 30],
    [0, 0, 20],
    [0, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2]
  ]) {
    const probe = offsetProbe('wind', offsets);
    const w = inProcessWorker({ hold: true });
    await assert.rejects(read('wind', probe.stub, { createWorker: w.make }),
      (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
    assert.deepEqual(probe.ranges, [], `invalid offsets ${JSON.stringify(offsets)} never reach fetch`);
    assert.equal(w.record.posted, 0, 'invalid offsets never reach the decoder');
    assert.equal(w.record.terminated, true, 'the reader releases its worker');
  }
});

// Safety ceilings admit several times the recorded NOAA message sizes while
// bounding concurrent bodies independently of every number supplied by the index.
const READ_LIMITS = {
  wind: { message: 512 * 1024, frame: 768 * 1024 },
  waves: { message: 4 * 1024 * 1024, frame: 6 * 1024 * 1024 }
};

test('each kind refuses an oversized message before any range fetch or decode', async () => {
  for (const [kind, limit] of Object.entries(READ_LIMITS)) {
    for (const lengths of [[limit.message + 1, 1], [1, limit.message + 1], [2 ** 31, 1]]) {
      const probe = offsetProbe(kind, [0, lengths[0], lengths[0] + lengths[1]]);
      const w = inProcessWorker({ hold: true });
      await assert.rejects(read(kind, probe.stub, { createWorker: w.make }),
        (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
      assert.deepEqual(probe.ranges, [], `${kind} oversized message ${lengths} never reaches fetch`);
      assert.equal(w.record.posted, 0, 'an oversized span never reaches the decoder');
      assert.equal(w.record.terminated, true);
    }
  }
});

test('each kind refuses the aggregate frame ceiling before either range starts', async () => {
  for (const [kind, limit] of Object.entries(READ_LIMITS)) {
    const probe = offsetProbe(kind, [0, limit.message, limit.frame + 1]);
    await assert.rejects(read(kind, probe.stub),
      (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
    assert.deepEqual(probe.ranges, [], `${kind} individually valid spans exceed the frame ceiling`);
  }
});

test('each kind admits the exact message and aggregate boundaries without allocating probe bodies', async () => {
  for (const [kind, limit] of Object.entries(READ_LIMITS)) {
    const probe = offsetProbe(kind, [0, limit.message, limit.frame]);
    await assert.rejects(read(kind, probe.stub),
      (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
    assert.deepEqual(probe.ranges, [
      `bytes=0-${limit.message - 1}`,
      `bytes=${limit.message}-${limit.frame - 1}`
    ], `${kind} inclusive ceilings allow both bounded requests`);
  }
});

test('every read sends credentials omit and a Range header, never HEAD', async () => {
  const wind = noddStub();
  await read('wind', wind);
  const waves = noddStub();
  await assert.rejects(read('waves', waves), (e) => e instanceof FlowUnavailableError && e.reason === 'refused');
  const calls = [...wind.calls, ...waves.calls];
  assert.equal(calls.length, 6, 'one .idx and two message ranges per kind');
  for (const call of calls) {
    assert.equal(call.method, 'GET', call.url);
    assert.equal(call.credentials, 'omit', call.url);
    assert.match(call.range ?? '', /^bytes=\d+-\d+$/, call.url);
    assert.ok(call.url.startsWith(`${NODD_ORIGIN}/gfs.`), call.url);
  }
  assert.deepEqual(
    wind.calls.map((c) => c.range),
    ['bytes=0-65535', 'bytes=34998139-35077224', 'bytes=35077225-35156831']
  );
  assert.deepEqual(
    waves.calls.map((c) => c.range),
    ['bytes=0-4095', 'bytes=3968286-4855671', 'bytes=3029161-3457288'],
    'waves read DIRPW and HTSGW, never PERPW (3457289-3968285)'
  );
});

test('Worker startup failure is normalized and unlinks the activation signal', async () => {
  const activation = new AbortController();
  const stub = noddStub();
  await assert.rejects(
    read('wind', stub, {
      signal: activation.signal,
      createWorker: () => { throw new DOMException('Worker startup blocked', 'SecurityError'); }
    }),
    (error) => error instanceof FlowUnavailableError && error.reason === 'failed' && error.message.includes('SecurityError')
  );
  assert.equal(getEventListeners(activation.signal, 'abort').length, 0);
  assert.equal(activation.signal.aborted, false);
  assert.deepEqual(stub.calls, [], 'startup failure makes no network requests');
});

test('abort of the activation signal cancels every outstanding range and terminates the Worker', async () => {
  const stub = noddStub({ stallRanges: true });
  const w = inProcessWorker({ hold: true });
  const activation = new AbortController();
  const pending = withFetch(stub, () =>
    readFlowFrame('waves', { signal: activation.signal, now: () => NOW, createWorker: w.make })
  );
  await raced(stub.rangesSeen, 2000, 'both ranges requested');
  await new Promise((resolve) => setTimeout(resolve, 10));
  activation.abort();
  await assert.rejects(raced(pending, 2000, 'the aborted read'), { name: 'AbortError' });
  assert.equal(stub.cancelled.length, 2, `both range bodies cancelled: ${stub.cancelled.join(', ')}`);
  assert.equal(w.record.terminated, true, 'the decode Worker is terminated');
});

test('a frame past cycle + 24 h is refused', async () => {
  // The clock is read when the cycle is chosen and again when the frame is
  // ready; a frame that comes back past its staleAfter is never returned.
  const clock = [NOW, CYCLE_06Z + 24 * HOUR + 1];
  const now = () => (clock.length > 1 ? clock.shift() : clock[0]);
  await assert.rejects(
    read('wind', noddStub(), { now }),
    (e) => e instanceof FlowUnavailableError && e.reason === 'stale'
  );
  // Control: at staleAfter itself the frame still stands.
  const field = await read('wind', noddStub(), {
    now: ((ticks) => () => (ticks.length > 1 ? ticks.shift() : ticks[0]))([NOW, CYCLE_06Z + 24 * HOUR])
  });
  assert.equal(field.meta.staleAfter, CYCLE_06Z + 24 * HOUR);
});

// ---------------------------------------------------------------------------
// The bounded Range read (found-147: moved here from tests/fetch-budget.test.mjs
// with src/util/fetch.ts's bounds, same inputs and outcomes). A server or proxy
// that ignores Range answers 200 with the whole file (41 MB for 1p00, 11.6 MB
// for the wave grid), so the read stops at the cap, a status other than the
// expected one is refused, and with both set the body must be exactly maxBytes
// long. It keeps fetchBufferedWithBudget's budget and owner abort over the body.
// ---------------------------------------------------------------------------

const { fetchBoundedWithBudget } = nodd;

test('the bounded helper refuses invalid or excessive capacity before fetch', async () => {
  const calls = [];
  const stub = { fetchImpl: async () => {
    calls.push('fetch');
    throw new RangeError('capacity probe prevents every body allocation');
  } };
  await withFetch(stub, async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1, 4 * 1024 * 1024 + 1, 2 ** 31]) {
      await assert.rejects(fetchBoundedWithBudget('/range.grib2', null, null, 5000, { maxBytes }),
        { name: 'RangeError' });
      assert.equal(calls.length, 0, `capacity ${maxBytes} is refused before fetch`);
    }
    // Reaching fetch proves the inclusive bound, without allocating the ceiling.
    await assert.rejects(fetchBoundedWithBudget('/range.grib2', null, null, 5000,
      { maxBytes: 4 * 1024 * 1024 }), { name: 'RangeError' });
    assert.equal(calls.length, 1, 'the exact helper ceiling is admitted');
  });
});

/**
 * A fetch stub whose body is a stream the test controls (the
 * tests/fetch-budget.test.mjs stub): `close: false` sends the chunks and
 * stalls; `cancelled` resolves when the consumer cancels the stream.
 */
function stubFetch({ status = 200, chunks = [], close = true } = {}) {
  let noteCancelled;
  const cancelled = new Promise((resolve) => {
    noteCancelled = resolve;
  });
  let noteHeaders;
  const headersReturned = new Promise((resolve) => {
    noteHeaders = resolve;
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (close) controller.close();
      },
      cancel() {
        noteCancelled();
      }
    });
    noteHeaders();
    return new Response(body, { status });
  };
  return { fetchImpl, cancelled, headersReturned, calls };
}

test('the flow Range read aborts a 200 whole-file answer at the cap', async () => {
  // A whole-file answer that keeps streaming: 3 kB sent, never closed. The
  // 10 s budget would end it only much later; the cap must end it at once.
  const kB = 'x'.repeat(1024);
  const stub = stubFetch({ status: 200, chunks: [kB, kB, kB], close: false });
  await withFetch(stub, async () => {
    const request = fetchBoundedWithBudget('/whole-file.grib2', null, null, 10_000, { maxBytes: 2048 });
    await assert.rejects(raced(request, 2000, 'the capped read'), { name: 'RangeError' });
    await raced(stub.cancelled, 2000, 'stream cancel');
  });
  // Under the cap, maxBytes alone accepts any status (a 404 still reads as 404).
  const small = stubFetch({ status: 404, chunks: ['not here'] });
  await withFetch(small, async () => {
    const response = await fetchBoundedWithBudget('/missing.idx', null, null, 5000, { maxBytes: 2048 });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'not here');
  });
});

test('the flow Range read with expectStatus 206 rejects a 200 and a short body', async () => {
  const bounds = { expectStatus: 206, maxBytes: 10 };
  // A 200 (Range ignored) is refused at the headers, and the request is
  // aborted, which in a browser ends the body stream and the connection.
  const whole = stubFetch({ status: 200, chunks: ['0123456789'], close: false });
  await withFetch(whole, async () => {
    const request = fetchBoundedWithBudget('/range.grib2', null, null, 10_000, bounds);
    await assert.rejects(raced(request, 2000, 'the 200 read'), { name: 'RangeError' });
    assert.equal(whole.calls[0].init.signal.aborted, true, 'the request signal is aborted');
  });
  // A 206 that ends short of the requested span is refused.
  const short = stubFetch({ status: 206, chunks: ['012345'] });
  await withFetch(short, async () => {
    await assert.rejects(
      raced(fetchBoundedWithBudget('/range.grib2', null, null, 5000, bounds), 2000, 'the short read'),
      { name: 'RangeError' }
    );
  });
  // A 206 one byte long is refused too (over the cap).
  const long = stubFetch({ status: 206, chunks: ['0123456789A'] });
  await withFetch(long, async () => {
    await assert.rejects(
      raced(fetchBoundedWithBudget('/range.grib2', null, null, 5000, bounds), 2000, 'the long read'),
      { name: 'RangeError' }
    );
  });
  // Control: a 206 of exactly the span passes through with its bytes.
  const exact = stubFetch({ status: 206, chunks: ['01234', '56789'] });
  await withFetch(exact, async () => {
    const response = await raced(fetchBoundedWithBudget('/range.grib2', null, null, 5000, bounds), 2000, 'exact');
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '0123456789');
  });
});

test('the flow Range read keeps the body budget, the owner abort and credentials as given', async () => {
  // A stalled body is cut off by the budget and the stream is cancelled.
  const stalled = stubFetch({ status: 206, chunks: ['01'], close: false });
  await withFetch(stalled, async () => {
    const request = fetchBoundedWithBudget('/range.grib2', null, null, 40, { maxBytes: 10 });
    await assert.rejects(raced(request, 2000, 'the budgeted read'), { name: 'AbortError' });
    await raced(stalled.cancelled, 2000, 'stream cancel');
  });
  // An abort of the owning signal after headers cancels the read.
  const held = stubFetch({ status: 206, chunks: ['01'], close: false });
  await withFetch(held, async () => {
    const master = new AbortController();
    const request = fetchBoundedWithBudget('/range.grib2', null, master.signal, 10_000, { maxBytes: 10 });
    await raced(held.headersReturned, 2000, 'headers');
    master.abort();
    await assert.rejects(raced(request, 2000, 'the aborted read'), { name: 'AbortError' });
    await raced(held.cancelled, 2000, 'stream cancel');
  });
  // An already-aborted owning signal never reaches fetch.
  const never = stubFetch({ status: 206, chunks: ['0123456789'] });
  await withFetch(never, async () => {
    const master = new AbortController();
    master.abort();
    await assert.rejects(fetchBoundedWithBudget('/range.grib2', null, master.signal, 5000, { maxBytes: 10 }), {
      name: 'AbortError'
    });
    assert.equal(never.calls.length, 0);
  });
  // The request init is passed through (the reader's credentials: 'omit' and Range).
  const plain = stubFetch({ status: 206, chunks: ['0123456789'] });
  await withFetch(plain, async () => {
    const init = { credentials: 'omit', headers: { Range: 'bytes=0-9' } };
    await fetchBoundedWithBudget('/range.grib2', init, null, 5000, { expectStatus: 206, maxBytes: 10 });
    assert.equal(plain.calls[0].init.credentials, 'omit');
    assert.deepEqual(plain.calls[0].init.headers, { Range: 'bytes=0-9' });
  });
});

// ---------------------------------------------------------------------------
// The frames
// ---------------------------------------------------------------------------

test('the wind frame is the uncropped 360x181 global grid', async () => {
  const stub = noddStub();
  const field = await read('wind', stub);
  assert.equal(field.kind, 'wind');
  assert.deepEqual(field.grid, { lon0: 0, lat0: 90, dlon: 1, dlat: 1, nx: 360, ny: 181, wrapsLon: true });
  assert.equal(field.u.length, 360 * 181);
  assert.equal(field.mask.reduce((a, b) => a + b, 0), 360 * 181, 'no wind node is masked');
  assert.equal(field.meta.cycle, CYCLE_06Z);
  assert.equal(field.meta.forecastHour, 6);
  assert.equal(field.meta.validTime, CYCLE_06Z + 6 * HOUR);
  assert.equal(field.meta.staleAfter, CYCLE_06Z + 24 * HOUR);
  assert.equal(field.meta.issuer, 'NOAA');
  assert.equal(field.meta.model, 'GFS');
  assert.equal(field.meta.level, '10 m above ground');
  assert.equal(field.meta.sourceUrl, `${NODD_ORIGIN}/${WIND_KEY}`);
  // Values match eccodes at every sampled point, within the Int16 step (0.01 m/s).
  for (const [name, arr] of [
    ['gfs1p00-UGRD-10m-f006', field.u],
    ['gfs1p00-VGRD-10m-f006', field.v]
  ]) {
    const ref = refValues(name);
    const stride = reference[name].stride;
    for (let k = 0; k < ref.length; k++) {
      assert.ok(Math.abs(arr[k * stride] - ref[k]) <= 0.005 + 2e-5, `${name} point ${k * stride}`);
    }
  }
});

test('the wave crop spans 165 E to 100 W across the antimeridian and contains Attu (52.9 N, 172.9 E), Guaymas (27.9 N, 110.9 W) and Hilo (19.7 N, 155.1 W)', () => {
  const htsgw = decodeGrib2(fixture('global0p25-HTSGW-f006.grib2'), {
    grid: { ni: 1440, nj: 721, la1: 90, lo1: 0 },
    parameter: { discipline: 10, category: 0, number: 3 }
  });
  // A synthetic DIRPW of 270 (from the west) on HTSGW's own mask.
  const dirpw = htsgw.values.map((h) => (Number.isFinite(h) ? 270 : Number.NaN));
  const packet = buildPacket('waves', [dirpw, htsgw.values], CYCLE_06Z, 6);
  const field = source.fieldFromPacket(packet, source.frameMeta('waves', CYCLE_06Z, 6));
  assert.deepEqual(field.grid, { lon0: 165, lat0: 62, dlon: 0.25, dlat: 0.25, nx: 381, ny: 289, wrapsLon: false });
  // Corners: 165 E and 100 W (260 E), 62 N and 10 S.
  const pos = { x: 0, y: 0 };
  assert.deepEqual(gridPosition(field, 165, 62, pos), { x: 0, y: 0 });
  assert.deepEqual(gridPosition(field, -100, -10, pos), { x: 380, y: 288 });
  assert.ok(gridPosition(field, 180, 0, pos) && pos.x === 60, 'the antimeridian is column 60');
  assert.equal(gridPosition(field, 164.5, 30, pos), null, 'west of 165 E is outside');
  assert.equal(gridPosition(field, -99.5, 30, pos), null, 'east of 100 W is outside');
  // The cropped node equals the global node it came from.
  for (const [lon, lat] of [[165, 62], [180, 0], [-100, -10], [-140, 40]]) {
    const col = Math.round((((lon % 360) + 360) % 360) / 0.25);
    const row = Math.round((90 - lat) / 0.25);
    const g = htsgw.values[row * 1440 + col];
    gridPosition(field, lon, lat, pos);
    const c = field.magnitude[Math.round(pos.y) * 381 + Math.round(pos.x)];
    if (Number.isNaN(g)) assert.ok(Number.isNaN(c), `${lon}, ${lat} masked in both`);
    else assert.ok(Math.abs(c - g) <= 0.0005 + 1e-6, `${lon}, ${lat}: ${c} vs ${g}`);
  }
  // Each named coast is inside the crop, with a valid sea cell within 0.5 degree.
  const places = { Attu: [172.9, 52.9], Guaymas: [-110.9, 27.9], Hilo: [-155.1, 19.7] };
  for (const [name, [lon, lat]] of Object.entries(places)) {
    assert.ok(gridPosition(field, lon, lat, pos), `${name} is inside the crop`);
    let sea = false;
    for (let dy = -2; dy <= 2 && !sea; dy++) {
      for (let dx = -2; dx <= 2 && !sea; dx++) {
        sea = cellValid(field, Math.floor(pos.x) + dx, Math.floor(pos.y) + dy);
      }
    }
    assert.ok(sea, `${name} has a valid sea cell within 0.5 degree`);
  }
});

test('the wave adapter yields TO = DIRPW + 180 (DIRPW 270 travels east)', () => {
  const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} vs ${b}`);
  const cases = [
    [270, 1, 0], // from the west: travels east
    [0, 0, -1], // from the north: travels south
    [90, -1, 0], // from the east: travels west
    [180, 0, 1], // from the south: travels north
    [315, Math.SQRT1_2, -Math.SQRT1_2] // from the north-west: travels south-east
  ];
  for (const [dir, u, v] of cases) {
    const [eu, ev] = waveToVector(dir);
    close(eu, u, `DIRPW ${dir} east`);
    close(ev, v, `DIRPW ${dir} north`);
    // The travel bearing is (DIRPW + 180) mod 360.
    const to = ((Math.atan2(eu, ev) * 180) / Math.PI + 360) % 360;
    close(to, (dir + 180) % 360, `DIRPW ${dir} travel bearing`);
  }
  // Through the Worker's build and the FlowField: a global DIRPW of 270 travels east.
  const wavesSpec = FLOW_SOURCES.waves;
  assert.equal(wavesSpec.messages[0].variable, 'DIRPW');
  const dir = new Float32Array(1440 * 721).fill(270);
  const hs = new Float32Array(1440 * 721).fill(1.5);
  const packet = buildPacket('waves', [dir, hs], CYCLE_06Z, 6);
  const field = source.fieldFromPacket(packet, source.frameMeta('waves', CYCLE_06Z, 6));
  const s = sampleField(field, -140, 40, newSample());
  assert.ok(s, 'a valid sample');
  assert.ok(Math.abs(s.u - 1) < 1e-3 && Math.abs(s.v) < 1e-3, `travels east: ${s.u}, ${s.v}`);
  assert.ok(Math.abs(s.m - 1.5) < 1e-3, 'height is carried as magnitude');
});

test('wind u +5, v 0 travels east, from 270', () => {
  const u = new Float32Array(360 * 181).fill(5);
  const v = new Float32Array(360 * 181).fill(0);
  const packet = buildPacket('wind', [u, v], CYCLE_06Z, 6);
  const field = source.fieldFromPacket(packet, source.frameMeta('wind', CYCLE_06Z, 6));
  const s = sampleField(field, -122.5, 45.5, newSample());
  assert.ok(s, 'a valid sample');
  assert.ok(Math.abs(s.u - 5) < 1e-9 && Math.abs(s.v) < 1e-9, `TO is (u, v) as given: ${s.u}, ${s.v}`);
  assert.ok(Math.abs(s.m - 5) < 1e-6, 'magnitude 5 m/s');
  // The bearing it travels toward is 90 (east); the meteorological FROM
  // direction, atan2(-u, -v), is 270, which is what GFS WDIR holds.
  const toward = ((Math.atan2(s.u, s.v) * 180) / Math.PI + 360) % 360;
  const from = ((Math.atan2(-s.u, -s.v) * 180) / Math.PI + 360) % 360;
  assert.equal(Math.round(toward), 90);
  assert.equal(Math.round(from), 270);
});
