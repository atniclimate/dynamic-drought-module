import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, test, type Page, type Route } from '@playwright/test';

import type { FlowKind } from '../src/layers/flow/field';
import { locateMessage } from '../src/layers/flow/nodd';
import { FLOW_SOURCES, frameMeta } from '../src/layers/flow/source';
import { RASTER_PROOF_DEADLINE_MS } from '../src/util/raster-status';
import { gotoApp, layerPill, noddStubLog, PILL, selectRegion } from './helpers';

/**
 * ENSO-FLOW-PLAN block E1, unit E1-5 (FLOW-PLUMB): the plumbing the flowing
 * paths need before anything draws them. Nothing here is user-visible: no
 * caller imports src/layers/flow/ in block E1.
 *
 * 1. The SST tile proof (src/util/raster-status.ts, M-009) closes a request
 *    cycle without MapLibre `'idle'`. A continuously repainting map never
 *    fires `'idle'` (MapLibre 6.6 `Map._render`: idle fires only when no
 *    repaint is pending), and the flow loop is such a map.
 * 2. Every routine boot answers the NOAA NODD bucket from the E1-1 fixtures
 *    (tests/helpers.ts, `installDefaultNoddStub`), so no ENSO spec reads AWS.
 *    There is no unexpected-egress host list in the repo, so that route is
 *    the guard: an unstubbed NODD key is answered 404 and fails the spec.
 *
 * Every case here routes every host it touches; a context backstop
 * registered before `gotoApp` aborts and logs whatever no stub claims, so a
 * red run on code without the NODD stub still makes no live request.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const NODD_ORIGIN = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com';

/** The 1p00 atmos key and its 10 m UGRD range, as E1-1's reference.json records them. */
const WIND_IDX_KEY = 'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006.idx';
const WIND_KEY = 'gfs.20261005/06/atmos/gfs.t06z.pgrb2.1p00.f006';
const UGRD_RANGE = 'bytes=34998139-35077224';

/**
 * The global.0p25 wave key and a range on it that is no message's `.idx`
 * span: DIRPW's span (bytes=3968286-4855671) one byte long, so a real key
 * with a fixture, read by a range the reader never sends.
 */
const WAVE_KEY = 'gfs.20261005/06/wave/gridded/gfswave.t06z.global.0p25.f006.grib2';
const OFF_SPAN_RANGE = 'bytes=3968286-4855672';

/** The fixtures' cycle and forecast hour (reference.json: 2026-10-05 06Z, f006). */
const FIXTURE_CYCLE = Date.UTC(2026, 9, 5, 6);
const FIXTURE_HOUR = 6;

function fixtureBytes(name: string): Buffer {
  const bytes = readFileSync(new URL(`./fixtures/flow/${name}`, import.meta.url));
  // An `.idx` is text, so a Windows checkout with core.autocrlf holds it
  // with CRLF; NODD serves the LF bytes the repository stores, and so does
  // the stub (tests/helpers.ts installDefaultNoddStub).
  return name.endsWith('.idx') ? Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1') : bytes;
}

function fixtureSha256(name: string): string {
  return createHash('sha256').update(fixtureBytes(name)).digest('hex');
}

interface ReferenceEntry {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly source: { readonly key: string; readonly range: string };
}

/** reference.json's message entries by name (`_method` left out). */
const REFERENCE = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(new URL('./fixtures/flow/reference.json', import.meta.url), 'utf8')) as Record<
      string,
      unknown
    >
  ).filter(([name]) => name !== '_method')
) as Record<string, ReferenceEntry>;

/** What the reader sends for one kind's `.idx` (src/layers/flow/nodd.ts readFlowFrame). */
function readerIndexRead(kind: FlowKind): { readonly url: string; readonly range: string; readonly cap: number } {
  const cap = FLOW_SOURCES[kind].idxMaxBytes;
  return {
    url: `${frameMeta(kind, FIXTURE_CYCLE, FIXTURE_HOUR).sourceUrl}.idx`,
    range: `bytes=0-${cap - 1}`,
    cap
  };
}

/** The committed `.idx` fixture of each kind's product (the global.0p25 file for waves). */
const INDEX_FIXTURE: Readonly<Record<FlowKind, { readonly file: string; readonly bytes: number }>> = {
  wind: { file: 'gfs.t06z.pgrb2.1p00.f006.idx', bytes: 39_706 },
  waves: { file: 'gfswave.t06z.global.0p25.f006.grib2.idx', bytes: 1_005 }
};

async function fulfillPng(route: Route): Promise<void> {
  await route
    .fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    .catch(() => undefined);
}

/** A route gate: every request routed through it waits for `release()`. */
function routeGate(): { readonly held: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

/**
 * Fail closed on any host this case does not answer: registered on the
 * CONTEXT before `gotoApp`, so every page route and every context stub the
 * helpers install later is tried first (Playwright runs the newest route
 * first), and whatever none of them claims is aborted and logged here
 * instead of reaching a live provider (tests/raster-current-view.spec.ts's
 * backstop, the same shape).
 */
async function abortUnroutedHosts(page: Page, appOrigin: string): Promise<string[]> {
  const aborted: string[] = [];
  await page.context().route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      aborted.push(route.request().url());
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  );
  return aborted;
}

const isSstTile = (url: URL): boolean =>
  url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png');

/** Five published days, the newest 2026-09-24 (tests/raster-status.spec.ts's axis). */
const SST_DOMAINS_XML =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
  '<ows:Identifier>time</ows:Identifier>' +
  '<Domain>2026-09-20/2026-09-24/P1D</Domain>' +
  '<Size>1</Size></DimensionDomain></Domains>';

async function stubSstDomains(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.includes('REQUEST=DescribeDomains'),
    (route) => route.fulfill({ status: 200, contentType: 'text/xml', body: SST_DOMAINS_XML })
  );
}

/**
 * Keep every MapLibre map the page constructs, from before the first script
 * runs. The production build carries no map handle (src/main.ts), so the
 * case catches the map's own constructor assigning `_onWindowOnline` (a
 * property only `Map` sets, in its constructor, in MapLibre 6.6's built
 * module) through a setter on `Object.prototype`, which then steps aside by
 * defining the property on the map itself.
 */
async function captureMaps(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const maps: unknown[] = [];
    (window as unknown as { __flowPlumbMaps?: unknown[] }).__flowPlumbMaps = maps;
    Object.defineProperty(Object.prototype, '_onWindowOnline', {
      configurable: true,
      set(this: object, value: unknown) {
        Object.defineProperty(this, '_onWindowOnline', {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
        maps.push(this);
      }
    });
  });
}

/**
 * Turn on MapLibre's own continuous repaint on the main map (`#map`), the
 * repaint loop a moving layer runs, and count every `'idle'` after it.
 */
async function startRepaintLoop(page: Page): Promise<void> {
  await page.evaluate(() => {
    type LoopMap = {
      repaint: boolean;
      getContainer(): HTMLElement;
      on(name: string, handler: () => void): void;
    };
    const maps = (window as unknown as { __flowPlumbMaps?: LoopMap[] }).__flowPlumbMaps ?? [];
    const map = maps.find((candidate) => candidate.getContainer().id === 'map');
    if (!map) throw new Error('the main map was not captured');
    const counter = { idle: 0 };
    (window as unknown as { __flowPlumbIdle?: typeof counter }).__flowPlumbIdle = counter;
    map.on('idle', () => {
      counter.idle += 1;
    });
    map.repaint = true;
  });
}

async function idleCountSinceLoop(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __flowPlumbIdle?: { idle: number } }).__flowPlumbIdle?.idle ?? -1
  );
}

/**
 * The outcome of one in-page NODD read, as the browser saw it. A cross-origin
 * read only settles with a readable status when the answer carries
 * `Access-Control-Allow-Origin` (the header itself is not exposed to the
 * page), so `ok` is the CORS check: without the header NODD sends, the fetch
 * rejects with a TypeError.
 */
interface NoddRead {
  readonly ok: boolean;
  readonly status: number;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly error: string | null;
}

/**
 * One cross-origin GET from the app's own page, the way the E1-2 reader will
 * make it: `credentials: 'omit'` and, for a message, one Range header.
 */
async function readNodd(page: Page, url: string, range: string | null): Promise<NoddRead> {
  return page.evaluate(
    async ({ url, range }) => {
      try {
        const response = await fetch(url, {
          credentials: 'omit',
          headers: range ? { Range: range } : {}
        });
        const body = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
        return {
          ok: true,
          status: response.status,
          sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          bytes: body.byteLength,
          error: null
        };
      } catch (error) {
        return { ok: false, status: 0, sha256: null, bytes: 0, error: String(error) };
      }
    },
    { url, range }
  );
}

/**
 * The reader's `.idx` read from the app's page, with the exact init
 * `nodd.ts` `ranged()` sends (`credentials: 'omit'`, one Range header of
 * the kind's cap), returning the body as text for `locateMessage`.
 */
async function readNoddIndex(
  page: Page,
  url: string,
  range: string
): Promise<{ readonly status: number; readonly text: string; readonly error: string | null }> {
  return page.evaluate(
    async ({ url, range }) => {
      try {
        const response = await fetch(url, { credentials: 'omit', headers: { Range: range } });
        return { status: response.status, text: new TextDecoder().decode(await response.arrayBuffer()), error: null };
      } catch (error) {
        return { status: 0, text: '', error: String(error) };
      }
    },
    { url, range }
  );
}

/** Every NODD answer's status and Content-Range, as Playwright saw them (not readable by the page). */
function recordNoddRanges(page: Page): Array<readonly [number, string | null]> {
  const ranges: Array<readonly [number, string | null]> = [];
  page.on('response', (response) => {
    if (isNoddUrl(response.url())) ranges.push([response.status(), response.headers()['content-range'] ?? null]);
  });
  return ranges;
}

/** ENSO boots answer the SST surface locally; everything else falls to the backstop. */
async function stubEnsoSurface(page: Page): Promise<void> {
  await stubSstDomains(page);
  await page.route(isSstTile, fulfillPng);
}

const isNoddUrl = (url: string): boolean => new URL(url).hostname === new URL(NODD_ORIGIN).hostname;

/** Every NODD answer the page received: [status, Access-Control-Allow-Origin]. */
function recordNoddAnswers(page: Page): Array<readonly [number, string | null]> {
  const answers: Array<readonly [number, string | null]> = [];
  page.on('response', (response) => {
    if (isNoddUrl(response.url())) {
      answers.push([response.status(), response.headers()['access-control-allow-origin'] ?? null]);
    }
  });
  return answers;
}

test.describe('E1-5 flow plumbing (ENSO-FLOW-PLAN block E1)', () => {
  test('with a repaint loop running, panning back to cached SST tiles reaches live', async ({
    page,
    baseURL
  }) => {
    // Boot, one proof deadline and two camera moves.
    test.setTimeout(90_000);
    const aborted = await abortUnroutedHosts(page, new URL(baseURL ?? 'http://127.0.0.1:4173/').origin);
    await captureMaps(page);
    // Every region change is one instant jump (src/ui/sidebar.ts fitBounds
    // with animate: !prefersReducedMotion()), as in raster-current-view.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('https://tile.openstreetmap.org/**', fulfillPng);
    await stubSstDomains(page);
    let phase: 'boot' | 'hold' | 'return' = 'boot';
    const returned: string[] = [];
    const gate = routeGate();
    await page.route(isSstTile, async (route) => {
      if (phase === 'boot') {
        await fulfillPng(route);
        return;
      }
      if (phase === 'return') returned.push(route.request().url());
      // A held request is let go only after its view has left, as a 404, so a
      // late answer can never prove a tile.
      if (phase === 'hold') await gate.held;
      await route.fulfill({ status: 404, body: '' }).catch(() => undefined);
    });
    const pill = layerPill(page, 'sst-anomaly');

    try {
      await gotoApp(page, '?view=console&layers=sst-anomaly&region=national');
      await expect(pill).toHaveText(PILL.live);

      // The loop: from here MapLibre never fires 'idle'.
      await startRepaintLoop(page);

      // Hawaii, every tile held: the proof deadline floors the pill at live
      // (partial) (found-042) with that request cycle still open.
      phase = 'hold';
      await selectRegion(page, 'hawaii');
      await expect(pill).toHaveText(PILL.degraded, { timeout: RASTER_PROOF_DEADLINE_MS + 7_000 });

      // Back to the boot view: every tile comes from MapLibre's own cache, so
      // no request opens a cycle and no tile event follows. Before E1-5 only
      // 'idle' closed the open cycle, and the loop starves it.
      phase = 'return';
      await selectRegion(page, 'national');
      await expect(pill).toHaveText(PILL.live);
      expect(returned, 'the return to the boot view requested no SST tile').toEqual([]);
      expect(await idleCountSinceLoop(page), 'the repaint loop starved idle throughout').toBe(0);
    } finally {
      gate.release();
      if (aborted.length > 0) {
        test.info().annotations.push({ type: 'aborted-unrouted-requests', description: aborted.join('\n') });
      }
    }
  });

  test('a routine ENSO boot makes no request to the live NODD host', async ({ page, baseURL }) => {
    const aborted = await abortUnroutedHosts(page, new URL(baseURL ?? 'http://127.0.0.1:4173/').origin);
    const noddRequests: string[] = [];
    page.on('request', (request) => {
      if (isNoddUrl(request.url())) noddRequests.push(request.url());
    });
    await stubEnsoSurface(page);
    // ENSO opens with wind on since E2-4, which reads NODD at boot; flow=off
    // keeps this case on the routine boot that reads none of it.
    await gotoApp(page, '?cluster=enso&flow=off');
    const answers = recordNoddAnswers(page);
    // With flow off the boot itself reads none of NODD.
    expect(noddRequests, 'the ENSO boot made no NODD request').toEqual([]);

    // The reads E1-2's reader makes are answered from E1-1's fixtures, byte
    // for byte, readable cross-origin as NODD's answers are. The reader
    // always sends a Range on the `.idx` (its 64 kB atmos cap), and S3
    // answers a range past the object's end with 206 and the whole object.
    expect(`${NODD_ORIGIN}/${WIND_IDX_KEY}`).toBe(readerIndexRead('wind').url);
    const idx = await readNodd(page, `${NODD_ORIGIN}/${WIND_IDX_KEY}`, readerIndexRead('wind').range);
    expect(idx).toEqual({
      ok: true,
      status: 206,
      sha256: fixtureSha256('gfs.t06z.pgrb2.1p00.f006.idx'),
      bytes: 39_706,
      error: null
    });
    const ugrd = await readNodd(page, `${NODD_ORIGIN}/${WIND_KEY}`, UGRD_RANGE);
    expect(ugrd).toEqual({
      ok: true,
      status: 206,
      sha256: fixtureSha256('gfs1p00-UGRD-10m-f006.grib2'),
      bytes: 79_086,
      error: null
    });
    await expect.poll(() => answers, { message: 'each answer carried the CORS header NODD sends' }).toEqual([
      [206, '*'],
      [206, '*']
    ]);
    expect(
      aborted.filter(isNoddUrl),
      'no NODD request fell through to the backstop (and so to the network)'
    ).toEqual([]);
  });

  test("the stub answers the reader's capped .idx range with 206 and the whole index", async ({
    page,
    baseURL
  }) => {
    const aborted = await abortUnroutedHosts(page, new URL(baseURL ?? 'http://127.0.0.1:4173/').origin);
    await stubEnsoSurface(page);
    await gotoApp(page, '?cluster=enso&flow=off');
    const answers = recordNoddAnswers(page);
    const ranges = recordNoddRanges(page);

    const expectedRanges: Array<readonly [number, string | null]> = [];
    for (const kind of ['wind', 'waves'] as const) {
      const read = readerIndexRead(kind);
      const fixture = INDEX_FIXTURE[kind];
      // The fixture is shorter than the cap, so the reader takes it whole
      // (a body that fills the cap is refused).
      expect(fixture.bytes, `${kind}: the .idx fits under its ${read.cap} B cap`).toBeLessThan(read.cap);
      const idx = await readNodd(page, read.url, read.range);
      expect(idx, `${kind}: ${read.range} on ${read.url}`).toEqual({
        ok: true,
        status: 206,
        sha256: fixtureSha256(fixture.file),
        bytes: fixture.bytes,
        error: null
      });
      expectedRanges.push([206, `bytes 0-${fixture.bytes - 1}/${fixture.bytes}`]);
    }

    // A GET with no Range still has the whole object, 200, as S3 answers it.
    const whole = await readNodd(page, readerIndexRead('waves').url, null);
    expect(whole).toMatchObject({ ok: true, status: 200, bytes: INDEX_FIXTURE.waves.bytes });
    expectedRanges.push([200, null]);
    // A range that starts past the object's end is 416, as S3 answers it.
    const past = INDEX_FIXTURE.waves.bytes;
    const beyond = await readNodd(page, readerIndexRead('waves').url, `bytes=${past}-${past + 4095}`);
    expect(beyond).toMatchObject({ ok: true, status: 416 });
    expectedRanges.push([416, null]);

    await expect.poll(() => ranges, { message: 'status and Content-Range of each answer' }).toEqual(expectedRanges);
    expect(answers.map(([, acao]) => acao), 'every answer carried ACAO *').toEqual(['*', '*', '*', '*']);
    expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed')).toEqual([]);
    expect(test.info().errors, 'no read was unstubbed').toEqual([]);
    expect(aborted.filter(isNoddUrl), 'no NODD request fell through to the backstop').toEqual([]);
  });

  test('the stub answers each wind and wave message by its .idx span, and DIRPW global.0p25 is among them', async ({
    page,
    baseURL
  }) => {
    const aborted = await abortUnroutedHosts(page, new URL(baseURL ?? 'http://127.0.0.1:4173/').origin);
    await stubEnsoSurface(page);
    await gotoApp(page, '?cluster=enso&flow=off');

    // readFlowFrame's requests, kind by kind, from the app's page with the
    // reader's own init: the `.idx` by the kind's capped Range, then each
    // message of FLOW_SOURCES by the span the reader's own `locateMessage`
    // finds in the index the stub answered.
    const served: Record<FlowKind, string[]> = { wind: [], waves: [] };
    for (const kind of ['wind', 'waves'] as const) {
      const meta = frameMeta(kind, FIXTURE_CYCLE, FIXTURE_HOUR);
      const read = readerIndexRead(kind);
      const idx = await readNoddIndex(page, read.url, read.range);
      expect(idx.error, `${kind}: the .idx read settled`).toBeNull();
      expect(idx.status, `${kind}: ${read.range} on the .idx`).toBe(206);
      for (const message of FLOW_SOURCES[kind].messages) {
        const { start, end } = locateMessage(idx.text, message, FIXTURE_CYCLE, FIXTURE_HOUR);
        const range = `bytes=${start}-${end}`;
        const entry = Object.entries(REFERENCE).find(
          ([, ref]) => ref.source.key === meta.productKey && ref.source.range === range
        );
        expect(entry, `${kind} ${message.variable}: reference.json holds ${meta.productKey} ${range}`).toBeDefined();
        const [name, ref] = entry as [string, ReferenceEntry];
        expect(fixtureSha256(ref.file), `${name}: the file is the message reference.json describes`).toBe(ref.sha256);
        const body = await readNodd(page, meta.sourceUrl, range);
        // The reader takes a message only as a 206 of exactly the span.
        expect(body, `${kind} ${message.variable}: ${range}`).toEqual({
          ok: true,
          status: 206,
          sha256: ref.sha256,
          bytes: end - start + 1,
          error: null
        });
        served[kind].push(name);
      }
    }
    expect(served).toEqual({
      wind: ['gfs1p00-UGRD-10m-f006', 'gfs1p00-VGRD-10m-f006'],
      waves: ['global0p25-DIRPW-f006', 'global0p25-HTSGW-f006']
    });
    expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed')).toEqual([]);
    expect(test.info().errors, 'no read was unstubbed').toEqual([]);
    expect(aborted.filter(isNoddUrl), 'no NODD request fell through to the backstop').toEqual([]);
  });

  test('a message range other than its .idx span is unstubbed: 404, logged, and fails the test', async ({
    page,
    baseURL
  }) => {
    const aborted = await abortUnroutedHosts(page, new URL(baseURL ?? 'http://127.0.0.1:4173/').origin);
    await stubEnsoSurface(page);
    await gotoApp(page, '?cluster=enso&flow=off');
    expect(test.info().errors, 'the boot itself recorded no error').toEqual([]);
    const answers = recordNoddAnswers(page);

    // A real NODD key with fixtures, read by a range that is no message's span.
    const off = await readNodd(page, `${NODD_ORIGIN}/${WAVE_KEY}`, OFF_SPAN_RANGE);
    // Settled and readable cross-origin: the 404 carries ACAO * as NODD's does.
    expect(off.ok, `the read settled: ${off.error ?? ''}`).toBe(true);
    expect(off.status).toBe(404);
    await expect.poll(() => answers).toEqual([[404, '*']]);
    expect(aborted.filter(isNoddUrl), 'the stub, not the backstop, answered it').toEqual([]);
    expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed')).toEqual([
      { method: 'GET', url: `${NODD_ORIGIN}/${WAVE_KEY}`, range: OFF_SPAN_RANGE, answer: 'unstubbed' }
    ]);

    // The stub recorded it against this test as a soft failure that names
    // the key and the range, so the spec fails.
    const messages = test.info().errors.map((error) => error.message ?? '');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('unstubbed NODD request');
    expect(messages[0]).toContain(WAVE_KEY);
    expect(messages[0]).toContain(OFF_SPAN_RANGE);

    // Every check above held, so the one failure this test carries is the
    // stub's own: declare it expected. A check above that fails stops the
    // test before this line, and the test then fails for real.
    test.fail();
  });
});
