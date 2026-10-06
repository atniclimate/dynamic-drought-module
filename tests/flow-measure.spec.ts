import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Map as MlMap } from 'maplibre-gl';

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Route
} from './offline-test';

import { gotoApp, NODD_FIXTURES, noddStubLog } from './helpers';

/*
 * ENSO-FLOW-PLAN block E2, unit E2-2 (FLOW-MEASURE), section 4.2 and 4.4: the
 * flowing paths' cost, measured in a browser before wind becomes the ENSO
 * default. This is a MEASUREMENT spec, not an assertion suite: it belongs to
 * the `chromium-measure` project (playwright.config.ts MEASURE_SPECS), is
 * never collected by `chromium` or by CI, and is run alone by
 * `npm run measure:flow`. It writes its numbers to JSON (see OUT_DIR) and
 * asserts only the plan's bars and the sanity of what it recorded.
 *
 * Fixtures only, zero egress. Every NODD read is answered by
 * tests/helpers.ts `installDefaultNoddStub` from the committed 2026-10-05 06Z
 * f006 messages (the real wave pair is 1.3 MB, so the bytes are real);
 * Open-Meteo (ocean currents, the interim arrows) and the OSM basemap are
 * answered from here; a context backstop aborts and logs any other host.
 *
 * WHAT THE NUMBERS ARE, and are not (the plan's labels):
 * - Headless Chromium here runs ANGLE over SwiftShader, a software GL. When
 *   the recorded WEBGL_debug_renderer_info string names SwiftShader or
 *   llvmpipe, every frame-rate figure carries the label SOFTWARE_GL_LABEL;
 *   only the CPU columns are judged against the plan's bars. The explicit
 *   DDM_MEASURE_NATIVE_GPU=1 project option requests a headed native renderer;
 *   map-backed measurements reject an unknown or software renderer on that path.
 * - "Flow CPU per step". A production build exposes no per-step timer (the
 *   ribbon layer's `stats.lastStepMs` has no page handle), so the CPU figure
 *   is read from the CDP sampling profiler: every sample whose stack has a
 *   frame in the flow chunk's own files (the lazy chunk and the non-initial
 *   chunks it imports, from dist/.vite/manifest.json) is a flow sample, and
 *   consecutive flow samples within FLOW_BURST_GAP_MS make one burst, the
 *   main-thread time of one rAF tick or one MapLibre render of the layer
 *   (advection step, texture upload and the layer's GL calls included). The
 *   plan's p95 bar is applied to the p95 of those bursts; the mean per step
 *   is the window's flow time over the steps the view counted
 *   (`data-flow-steps`). The sampler adds its own overhead, so the profiled
 *   window is a separate window from the frame-rate one.
 * - Density. Production passes no density to the view (Standard always), so
 *   Sparse and Dense are emulated by the particle count: the count is
 *   canvas CSS area / 1024 times the factor (src/layers/flow/advect.ts), so
 *   the viewport is resized to half and double the Standard canvas area.
 *   Step CPU is comparable (it scales with the count); frame rate is not
 *   (the canvas changes size too).
 * - "Today's arrows". The static wind and wave arrows of 4c2afb4 were removed
 *   by E2-1; the interim arrows that remain are ocean currents, measured
 *   here (Open-Meteo stubbed) as the closest comparison the tree can run.
 * - Pan, zoom: the zoom of a production build is not readable, so the pan is
 *   500 px drags (about 25 degrees of longitude at zoom 3.8) and the zoom is
 *   wheel notches in and out; the recorded fields say what was driven.
 *
 * Every figure per condition is the median over RUNS runs of that run's own
 * median (the plan's "median of medians"); a p95 is reported the same way.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const OPEN_METEO = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\//;
const NODD = /^https:\/\/noaa-gfs-bdp-pds\.s3\.amazonaws\.com\//;
/** Candidate cycle 06Z; wind (3-hourly) and waves (hourly) both at f006: the fixtures are the frame it asks for. */
const LIVE_CLOCK = Date.UTC(2026, 9, 5, 12, 30);

const VIEWPORT = { width: 1440, height: 900 };
const WARM_UP_MS = 1500;
const WINDOW_MS = 6000;
const RUNS = 3;
const SOFTWARE_GL_LABEL = 'software GL floor, not GPU evidence';
/** Flow samples closer than this are one burst (one tick or one render of the layer). */
const FLOW_BURST_GAP_MS = 1;
const SAMPLING_INTERVAL_US = 200;
/** The wave pair's slow-link measurement (plan 4.4). */
const NETWORK_FLOOR = { rateMbit: 1.6, latencyMs: 150 };
/** nodd.ts FLOW_READ_BUDGET_MS: the complete-body budget of each read. */
const READ_BUDGET_MS = 12_000;
const NATIVE_GPU_REQUESTED = process.env['DDM_MEASURE_NATIVE_GPU'] === '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = process.env['DDM_FLOW_MEASURE_OUT'] ?? join(ROOT, 'test-results', 'flow-measure');

// ---------------------------------------------------------------------------
// Results: one JSON file, merged across partial (-g) runs.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const results: Json = {};

function record(key: string, value: unknown): void {
  results[key] = value;
}

function writeResults(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, 'flow-measure.json');
  let merged: Json = {};
  try {
    if (existsSync(file)) merged = JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch {
    merged = {};
  }
  writeFileSync(file, `${JSON.stringify({ ...merged, ...results, writtenAt: new Date().toISOString() }, null, 2)}\n`);
}

test.afterAll(writeResults);

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}

const round = (value: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// ---------------------------------------------------------------------------
// Boot: fixtures only, zero egress.
// ---------------------------------------------------------------------------

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }));
}

/** Ocean currents (the interim arrows): a 40-cell live sample at the page clock. */
async function stubOpenMeteo(page: Page): Promise<URL[]> {
  const calls: URL[] = [];
  await page.route(OPEN_METEO, async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const latitudes = url.searchParams.get('latitude')!.split(',').map(Number);
    const longitudes = url.searchParams.get('longitude')!.split(',').map(Number);
    const time = Math.floor(LIVE_CLOCK / 900_000) * 900;
    const body = latitudes.map((latitude, i) => ({
      latitude, longitude: longitudes[i],
      current_units: { time: 'unixtime', ocean_current_velocity: 'm/s', ocean_current_direction: '°' },
      current: { time, interval: 900, ocean_current_velocity: 0.4, ocean_current_direction: 90 }
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return calls;
}

/** What the in-page collector returns for one window. */
interface WindowSample {
  readonly intervals: readonly number[];
  readonly longTaskCount: number;
  readonly longTaskMaxMs: number;
  readonly glClears: number;
  readonly flowRenders: number | null;
  readonly flowSteps: number | null;
  readonly canvasW: number;
  readonly canvasH: number;
  readonly windowMs: number;
}

/**
 * Page-side instruments, installed before any app script: a rAF interval
 * recorder, a long-task observer, and a `clear` counter on WebGL2 contexts
 * (MapLibre clears once per frame it renders, so it counts map frames
 * including those of a condition with no flow view).
 */
const INSTRUMENTS = (): void => {
  interface Collector { clears: number }
  const holder = window as unknown as { __flowMeasureClears?: Collector; __flowMeasure?: (ms: number) => Promise<WindowSample> };
  const clears: Collector = { clears: 0 };
  holder.__flowMeasureClears = clears;
  const proto = WebGL2RenderingContext.prototype;
  const original = proto.clear;
  proto.clear = function patched(this: WebGL2RenderingContext, mask: number): void {
    clears.clears++;
    return original.call(this, mask);
  };
  holder.__flowMeasure = (ms: number): Promise<WindowSample> =>
    new Promise((resolve) => {
      const panel = document.querySelector<HTMLElement>('.enso-flow');
      const read = (key: string): number | null => {
        const raw = panel?.dataset[key];
        return raw === undefined ? null : Number(raw);
      };
      const canvas = document.querySelector<HTMLCanvasElement>('#map canvas');
      let longTaskCount = 0;
      let longTaskMaxMs = 0;
      let observer: PerformanceObserver | null = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTaskCount++;
            longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration);
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        observer = null;
      }
      const intervals: number[] = [];
      const clearsBefore = clears.clears;
      const rendersBefore = read('flowRenders');
      const stepsBefore = read('flowSteps');
      const t0 = performance.now();
      let last = t0;
      const tick = (now: number): void => {
        intervals.push(now - last);
        last = now;
        if (now - t0 < ms) {
          requestAnimationFrame(tick);
          return;
        }
        observer?.disconnect();
        const rendersAfter = read('flowRenders');
        const stepsAfter = read('flowSteps');
        resolve({
          intervals,
          longTaskCount,
          longTaskMaxMs,
          glClears: clears.clears - clearsBefore,
          flowRenders: rendersBefore === null || rendersAfter === null ? null : rendersAfter - rendersBefore,
          flowSteps: stepsBefore === null || stepsAfter === null ? null : stepsAfter - stepsBefore,
          canvasW: canvas?.clientWidth ?? 0,
          canvasH: canvas?.clientHeight ?? 0,
          windowMs: now - t0
        });
      };
      requestAnimationFrame(tick);
    });
};

interface BootOptions {
  readonly viewport?: { width: number; height: number };
  readonly dpr?: number;
  readonly reduced?: boolean;
  /** Stored Pause choice carried into the page (sessionStorage), the still form from the first frame. */
  readonly storedPause?: boolean;
  /** Only the paired-pan case installs a map observer and start/stop collector. */
  readonly pairedPan?: boolean;
  readonly flow: 'off' | 'currents' | 'wind' | 'waves';
}

interface Booted {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly aborted: string[];
  readonly openMeteoCalls: URL[];
}

const panelOf = (page: Page): Locator => page.locator('.enso-flow');

async function waitFlowReady(page: Page, flow: BootOptions['flow']): Promise<void> {
  const panel = panelOf(page);
  if (flow === 'off') return;
  await expect(panel).toHaveAttribute('data-status', /^live/, { timeout: 30_000 });
  // Currents are the interim arrows (no flow view), so nothing stamps data-flow-drawn for them.
  if (flow !== 'currents') await expect(panel).toHaveAttribute('data-flow-drawn', flow, { timeout: 30_000 });
}

/**
 * The context backstop every context in this spec installs FIRST (so every
 * later route outranks it): any request to a host other than the app's own
 * that no stub claims is aborted and logged. Returns the live log.
 */
async function installBackstop(context: BrowserContext): Promise<string[]> {
  const aborted: string[] = [];
  const appOrigin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173/').origin;
  await context.route(
    (url) => url.origin !== appOrigin,
    async (route) => {
      aborted.push(route.request().url());
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  );
  return aborted;
}

/** Zero egress: nothing aimed at the NODD bucket or Open-Meteo reached the backstop (each has its own stub). */
function expectNoEscape(aborted: readonly string[], label: string): void {
  expect(aborted.filter((url) => NODD.test(url) || OPEN_METEO.test(url)), `${label}: no NODD or Open-Meteo request escaped its stub`).toEqual([]);
}

/** A fresh context booted into ENSO with `flow`, every host routed, the instruments armed. */
async function boot(browser: Browser, options: BootOptions): Promise<Booted> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: options.viewport ?? VIEWPORT,
    deviceScaleFactor: options.dpr ?? 1,
    reducedMotion: options.reduced ? 'reduce' : 'no-preference'
  });
  const aborted = await installBackstop(context);
  const page = await context.newPage();
  await page.route('https://tile.openstreetmap.org/**', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }));
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  const openMeteoCalls = await stubOpenMeteo(page);
  await page.addInitScript(INSTRUMENTS);
  if (options.pairedPan) await page.addInitScript(PAN_INSTRUMENTS);
  if (options.storedPause) {
    await page.addInitScript(() => {
      try {
        window.sessionStorage.setItem('ddm:flow-motion', 'paused');
      } catch {
        // storage blocked: the case then measures the moving form, and says so in its record
      }
    });
  }
  const cdp = await context.newCDPSession(page);
  // flowMotion live: the measure reads the moving form, so routine boots' hold
  // (tests/helpers.ts, E2-4) must not pause it; a stored-pause condition seeds
  // its own choice above.
  await gotoApp(page, `?cluster=enso&ocean=pacific&flow=${options.flow}`, { flowMotion: 'live' });
  await waitFlowReady(page, options.flow);
  if (NATIVE_GPU_REQUESTED) {
    try {
      const renderer = await actualMapRenderer(page);
      expect(knownHardwareRenderer(renderer), `native GPU requested; actual map renderer: ${JSON.stringify(renderer)}`).toBe(true);
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  return { context, page, cdp, aborted, openMeteoCalls };
}

interface MapRenderer {
  readonly renderer: string | null;
  readonly vendor: string | null;
}

async function actualMapRenderer(page: Page): Promise<MapRenderer> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#map canvas.maplibregl-canvas');
    const gl = canvas?.getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info && gl ? {
      renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
      vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL))
    } : { renderer: null, vendor: null };
  });
}

function knownHardwareRenderer(value: MapRenderer): boolean {
  if (!value.renderer || !value.vendor) return false;
  const text = `${value.vendor} ${value.renderer}`;
  if (/unknown|unavailable|swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic|\bwarp\b/i.test(text)) return false;
  return /\b(intel|nvidia|amd|ati technologies|apple|qualcomm|adreno|arm|mali|radeon|geforce)\b/i.test(value.renderer);
}

async function rendererString(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no WebGL2 context';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'WEBGL_debug_renderer_info unavailable';
  });
}

const isSoftwareGl = (renderer: string): boolean => /swiftshader|llvmpipe/i.test(renderer);

// ---------------------------------------------------------------------------
// The flow chunk's own files, from the build manifest.
// ---------------------------------------------------------------------------

interface ManifestEntry { file?: string; imports?: string[]; isEntry?: boolean }

function staticClosure(manifest: Record<string, ManifestEntry>, seeds: readonly string[]): Set<string> {
  const seen = new Set(seeds.filter((key) => key in manifest));
  const stack = [...seen];
  while (stack.length > 0) {
    const key = stack.pop() as string;
    for (const imported of manifest[key]?.imports ?? []) {
      if (imported in manifest && !seen.has(imported)) {
        seen.add(imported);
        stack.push(imported);
      }
    }
  }
  return seen;
}

/** The flow chunk's non-initial static closure and the Worker's chunk, as dist file names (`assets/x.js`). */
function flowFiles(): { chunks: string[]; worker: string | null } {
  const manifestPath = join(ROOT, 'dist', '.vite', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, ManifestEntry>;
  const initial = staticClosure(manifest, Object.keys(manifest).filter((key) => manifest[key]?.isEntry));
  const initialFiles = new Set([...initial].map((key) => manifest[key]?.file));
  const chunks = [...staticClosure(manifest, ['src/layers/flow/index.ts'])]
    .map((key) => manifest[key]?.file)
    .filter((file): file is string => typeof file === 'string' && file.endsWith('.js') && !initialFiles.has(file));
  // Vite never lists a Worker bundle in the manifest (scripts/check-activation-budget.mjs
  // workerBundleFor): find it in dist/assets by its stem, not among any manifest file.
  const listed = new Set(Object.values(manifest).map((entry) => entry.file));
  const workers = readdirSync(join(ROOT, 'dist', 'assets'))
    .filter((name) => /^decode-worker-.+\.js$/.test(name) && !listed.has(`assets/${name}`));
  return { chunks, worker: workers.length === 1 ? `assets/${workers[0]}` : null };
}

// ---------------------------------------------------------------------------
// The CDP sampling profiler: flow-chunk bursts.
// ---------------------------------------------------------------------------

interface ProfileNode { id: number; callFrame: { url: string }; children?: number[] }
interface Profile { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

interface FlowCpu {
  readonly samples: number;
  readonly flowSamples: number;
  readonly flowMs: number;
  readonly burstCount: number;
  readonly burstP50Ms: number;
  readonly burstP95Ms: number;
  readonly burstMaxMs: number;
  readonly bursts: readonly number[];
}

function flowCpuOf(profile: Profile, flowUrlSuffixes: readonly string[]): FlowCpu {
  const byId = new Map(profile.nodes.map((node) => [node.id, node] as const));
  const inFlow = new Map<number, boolean>();
  const root = profile.nodes[0];
  if (root) {
    const stack: Array<[number, boolean]> = [[root.id, false]];
    while (stack.length > 0) {
      const [id, parentIn] = stack.pop() as [number, boolean];
      const node = byId.get(id);
      if (!node) continue;
      const url = node.callFrame.url;
      const self = parentIn || (url !== '' && flowUrlSuffixes.some((suffix) => url.endsWith(suffix)));
      inFlow.set(id, self);
      for (const child of node.children ?? []) stack.push([child, self]);
    }
  }
  const intervalMs = SAMPLING_INTERVAL_US / 1000;
  const bursts: number[] = [];
  let time = 0;
  let start = Number.NaN;
  let end = Number.NaN;
  let flowSamples = 0;
  profile.samples.forEach((id, i) => {
    time += (profile.timeDeltas[i] ?? 0) / 1000;
    if (inFlow.get(id) !== true) return;
    flowSamples++;
    if (Number.isNaN(start)) {
      start = time;
      end = time;
    } else if (time - end <= FLOW_BURST_GAP_MS) {
      end = time;
    } else {
      bursts.push(end - start + intervalMs);
      start = time;
      end = time;
    }
  });
  if (!Number.isNaN(start)) bursts.push(end - start + intervalMs);
  return {
    samples: profile.samples.length,
    flowSamples,
    flowMs: flowSamples * intervalMs,
    burstCount: bursts.length,
    burstP50Ms: round(percentile(bursts, 0.5)),
    burstP95Ms: round(percentile(bursts, 0.95)),
    burstMaxMs: round(bursts.length > 0 ? Math.max(...bursts) : 0),
    bursts
  };
}

async function profileDuring(cdp: CDPSession, work: () => Promise<void>, flowUrlSuffixes: readonly string[]): Promise<FlowCpu> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
  await cdp.send('Profiler.start');
  let failure: unknown = null;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: Profile };
  await cdp.send('Profiler.disable');
  if (failure !== null) throw failure;
  return flowCpuOf(profile, flowUrlSuffixes);
}

// ---------------------------------------------------------------------------
// Motion while a window is measured.
// ---------------------------------------------------------------------------

type Motion = (page: Page, untilMs: number) => Promise<void>;

/**
 * Let the page run for `ms`: a measurement window or a pacing gap between
 * synthetic input events, never a wait for an app state (every wait for state
 * is an expect). It is the page's own timer, the same shape as the sampling
 * windows in tests/flow-wire.spec.ts, so it is not a `waitForTimeout` site.
 */
async function hold(page: Page, ms: number): Promise<void> {
  await page.evaluate((windowMs) => new Promise<void>((resolve) => setTimeout(resolve, windowMs)), ms);
}

async function mapBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('#map').boundingBox())!;
}

/** Drag the map left and right by `dx` CSS px, back and forth, until `untilMs` (performance.now of this process). */
const panMotion: Motion = async (page, untilMs) => {
  const box = await mapBox(page);
  const cy = box.y + box.height / 2;
  let direction = 1;
  while (performance.now() < untilMs) {
    const cx = box.x + box.width / 2 - (direction * 250);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + direction * 500, cy, { steps: 24 });
    await page.mouse.up();
    direction = -direction;
  }
};

type PanFlow = 'off' | 'wind';
interface PanFrames {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly intervalsMs: readonly number[];
  readonly longTasks: readonly { startTimeMs: number; durationMs: number }[];
  readonly longTaskSupported: boolean;
}
interface PanWindow extends Window {
  __panMaps: MlMap[];
  __beginPan: () => void;
  __endPan: () => PanFrames;
}

/** Passive instrumentation only, installed for the paired-pan case. */
const PAN_INSTRUMENTS = (): void => {
  const holder = window as unknown as PanWindow;
  const maps: MlMap[] = [];
  holder.__panMaps = maps;
  Object.defineProperty(Object.prototype, '_onWindowOnline', {
    configurable: true,
    set(this: MlMap, value: unknown) {
      Object.defineProperty(this, '_onWindowOnline', { configurable: true, enumerable: true, writable: true, value });
      maps.push(this);
    }
  });
  let stop: (() => PanFrames) | null = null;
  holder.__beginPan = () => {
    if (stop) throw new Error('paired pan collector is already active');
    const startedAtMs = performance.now();
    let lastFrame: number | null = null;
    let raf = 0;
    const intervalsMs: number[] = [];
    const longTasks: Array<{ startTimeMs: number; durationMs: number }> = [];
    const take = (entries: readonly PerformanceEntry[]): void => {
      for (const entry of entries) {
        if (entry.startTime >= startedAtMs) longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
      }
    };
    const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const observer = longTaskSupported ? new PerformanceObserver((list) => take(list.getEntries())) : null;
    observer?.observe({ entryTypes: ['longtask'] });
    const frame = (now: number): void => {
      if (lastFrame !== null) intervalsMs.push(now - lastFrame);
      lastFrame = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    stop = () => {
      const endedAtMs = performance.now();
      cancelAnimationFrame(raf);
      if (observer) take(observer.takeRecords());
      observer?.disconnect();
      stop = null;
      return { startedAtMs, endedAtMs, intervalsMs, longTasks, longTaskSupported };
    };
  };
  holder.__endPan = () => {
    if (!stop) throw new Error('paired pan collector was not started');
    return stop();
  };
};

interface PanCamera {
  readonly longitude: number;
  readonly latitude: number;
  readonly zoom: number;
  readonly bearing: number;
  readonly pitch: number;
  readonly canvas: readonly [number, number];
}

async function panCamera(page: Page): Promise<PanCamera> {
  return page.evaluate(() => {
    const map = (window as unknown as PanWindow).__panMaps.find((candidate) => candidate.getContainer().id === 'map')!;
    const center = map.getCenter();
    return {
      longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
      canvas: [map.getCanvas().clientWidth, map.getCanvas().clientHeight] as const
    };
  });
}

async function panCameraSettles(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as PanWindow).__panMaps.find((candidate) => candidate.getContainer().id === 'map')!;
    return !map.isMoving() && map.loaded();
  }), { timeout: 30_000 }).toBe(true);
}

const PAN_DIRECTIONS = [1, -1, 1, -1] as const;
const PAN_DISTANCE_PX = 500;
const PAN_STEPS = 24;
// An identical stationary hold before release avoids velocity-dependent coast.
// This is input protocol time, not a performance or responsiveness limit.
const PAN_RELEASE_HOLD_MS = 200;

async function completedPans(page: Page): Promise<PanCamera[]> {
  const box = await mapBox(page);
  const cy = box.y + box.height / 2;
  const ends: PanCamera[] = [];
  for (const direction of PAN_DIRECTIONS) {
    const before = await panCamera(page);
    const cx = box.x + box.width / 2 - direction * PAN_DISTANCE_PX / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + direction * PAN_DISTANCE_PX, cy, { steps: PAN_STEPS });
    await hold(page, PAN_RELEASE_HOLD_MS);
    await page.mouse.up();
    await panCameraSettles(page);
    const after = await panCamera(page);
    expect(after.longitude, 'the completed physical drag moved the actual camera').not.toBe(before.longitude);
    ends.push(after);
  }
  return ends;
}

interface PageMetric { readonly name: string; readonly value: number }
async function pageMetrics(cdp: CDPSession): Promise<readonly PageMetric[]> {
  const result = await cdp.send('Performance.getMetrics') as { metrics: PageMetric[] };
  return result.metrics;
}

function taskSeconds(metrics: readonly PageMetric[]): number {
  const value = metrics.find((metric) => metric.name === 'TaskDuration')?.value;
  if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error('TaskDuration is missing or invalid');
  return value;
}

interface PanFlowState {
  readonly status: string | null;
  readonly kind: string | null;
  readonly form: string | null;
  readonly motion: string | null;
  readonly drawn: string | null;
  readonly steps: number | null;
}

async function readPanFlowState(page: Page): Promise<PanFlowState> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.enso-flow');
    const steps = panel?.getAttribute('data-flow-steps');
    return {
      status: panel?.getAttribute('data-status') ?? null,
      kind: panel?.querySelector<HTMLElement>('[data-flow-kind][aria-pressed="true"]')?.dataset['flowKind'] ?? null,
      form: panel?.getAttribute('data-flow-form') ?? null,
      motion: panel?.getAttribute('data-flow-motion') ?? null,
      drawn: panel?.getAttribute('data-flow-drawn') ?? null,
      steps: steps && /^\d+$/.test(steps) ? Number(steps) : null
    };
  });
}

interface PanRun {
  readonly flow: PanFlow;
  readonly renderer: MapRenderer;
  readonly label: string;
  readonly initialCamera: PanCamera;
  readonly gestureEnds: readonly PanCamera[];
  readonly frames: PanFrames;
  readonly hostElapsedMs: number;
  readonly metricsBefore: readonly PageMetric[];
  readonly metricsAfter: readonly PageMetric[];
  readonly taskDurationThreadMs: number;
  readonly flowBefore: PanFlowState;
  readonly flowAfter: PanFlowState;
}

async function measureCompletedPans(browser: Browser, flow: PanFlow): Promise<PanRun> {
  const { page, cdp, context, aborted } = await boot(browser, { flow, pairedPan: true });
  try {
    if (flow === 'wind') {
      await expect(panelOf(page)).toHaveAttribute('data-flow-form', 'moving');
      await expect(panelOf(page)).toHaveAttribute('data-flow-motion', 'moving');
    } else {
      await expect(panelOf(page)).toHaveAttribute('data-status', 'off');
      await expect(panelOf(page)).toHaveAttribute('data-flow-form', 'none');
    }
    await hold(page, WARM_UP_MS);
    await panCameraSettles(page);
    // Wait for a real map render after sources/camera have settled. Continuous
    // wind repaint is not map movement and is not required to become idle.
    await page.evaluate(() => new Promise<void>((resolve) => {
      const map = (window as unknown as PanWindow).__panMaps.find((candidate) => candidate.getContainer().id === 'map')!;
      map.once('render', () => resolve());
      map.triggerRepaint();
    }));
    const initialCamera = await panCamera(page);
    const renderer = await actualMapRenderer(page);
    const label = isSoftwareGl(renderer.renderer ?? '') ? SOFTWARE_GL_LABEL : knownHardwareRenderer(renderer) ? 'hardware renderer' : 'unverified renderer';
    const intendedState = flow === 'wind'
      ? { status: 'live', kind: 'wind', form: 'moving', motion: 'moving', drawn: 'wind' }
      : { status: 'off', kind: 'off', form: 'none', motion: 'none', drawn: '' };
    // Snapshot outside the metric bracket, after warmup and after completed pans.
    // A transient pause while dragging is allowed; a failed or stopped arm is not.
    const flowBefore = await readPanFlowState(page);
    expect(flowBefore, 'the intended arm is present after warmup').toMatchObject(intendedState);
    if (flow === 'wind') {
      expect(Number.isSafeInteger(flowBefore.steps), 'wind exposes its actual step counter').toBe(true);
      expect(flowBefore.steps!).toBeGreaterThanOrEqual(0);
    }
    // CDP threadTicks measures renderer main-thread running time. TaskDuration
    // covers all tasks in this page, including our instruments and MapLibre;
    // it excludes worker/GPU/other-process work and is not isolated flow CPU.
    await cdp.send('Performance.enable', { timeDomain: 'threadTicks' });
    try {
      const metricsBefore = await pageMetrics(cdp);
      const hostStartedAt = performance.now();
      await page.evaluate(() => (window as unknown as PanWindow).__beginPan());
      const gestureEnds = await completedPans(page);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const frames = await page.evaluate(() => (window as unknown as PanWindow).__endPan());
      const hostElapsedMs = performance.now() - hostStartedAt;
      const metricsAfter = await pageMetrics(cdp);
      const flowAfter = await readPanFlowState(page);
      expect(flowAfter, 'the intended arm remains after the completed pans').toMatchObject(intendedState);
      if (flow === 'wind') {
        expect(Number.isSafeInteger(flowAfter.steps), 'wind retains its actual step counter').toBe(true);
        expect(flowAfter.steps! - flowBefore.steps!, 'moving wind advanced during the arm').toBeGreaterThan(0);
      }
      const taskDurationThreadMs = (taskSeconds(metricsAfter) - taskSeconds(metricsBefore)) * 1000;
      expect(gestureEnds).toHaveLength(PAN_DIRECTIONS.length);
      expect(frames.longTaskSupported, 'long-task instrumentation is available').toBe(true);
      expect(frames.intervalsMs.length, 'the pan recorded frame intervals').toBeGreaterThan(0);
      expect(frames.intervalsMs.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      expect(taskDurationThreadMs, 'renderer task time is monotonic').toBeGreaterThanOrEqual(0);
      expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed'), 'no unstubbed NODD read').toEqual([]);
      expectNoEscape(aborted, `paired-pan-${flow}`);
      return { flow, renderer, label, initialCamera, gestureEnds, frames, hostElapsedMs, metricsBefore, metricsAfter, taskDurationThreadMs, flowBefore, flowAfter };
    } finally {
      await cdp.send('Performance.disable');
    }
  } finally {
    await context.close();
  }
}

function samePanCamera(actual: PanCamera, expected: PanCamera): void {
  expect(actual.canvas).toEqual(expected.canvas);
  for (const key of ['longitude', 'latitude', 'zoom', 'bearing', 'pitch'] as const) expect(actual[key]).toBeCloseTo(expected[key], 8);
}

/** Wheel notches in, then out, until `untilMs`. */
const zoomMotion: Motion = async (page, untilMs) => {
  const box = await mapBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let direction = -1;
  while (performance.now() < untilMs) {
    for (let i = 0; i < 12 && performance.now() < untilMs; i++) {
      await page.mouse.wheel(0, direction * 100);
      await hold(page, 100);
    }
    direction = -direction;
  }
};

const idleMotion: Motion = async (page, untilMs) => {
  const wait = untilMs - performance.now();
  if (wait > 0) await hold(page, wait);
};

/** Press the key's Pause button with the keyboard (focus it, then Enter). */
async function pauseByKeyboard(page: Page): Promise<void> {
  const button = page.locator('#map-key-flow-pause');
  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

// ---------------------------------------------------------------------------
// One measured run of one condition.
// ---------------------------------------------------------------------------

interface ConditionSpec {
  readonly id: string;
  readonly describe: string;
  readonly boot: BootOptions;
  readonly motion?: Motion;
  /** After boot and before warm-up: the keyboard Pause, or a viewport resize for density. */
  readonly prepare?: (page: Page) => Promise<void>;
  /** The conditions that draw no flow view are not profiled. */
  readonly profiled?: boolean;
  readonly note?: string;
}

interface RunRecord {
  readonly rafMedianMs: number;
  readonly rafP95Ms: number;
  readonly fps: number;
  readonly glFramesPerSec: number;
  readonly flowRendersPerSec: number | null;
  readonly flowStepsPerSec: number | null;
  readonly longTaskCount: number;
  readonly longTaskMaxMs: number;
  readonly heapDeltaKB: number;
  readonly canvasCssPx: readonly [number, number];
  readonly particleCountEquivalent: number;
  readonly cpu: Omit<FlowCpu, 'bursts'> | null;
  readonly cpuMeanPerStepMs: number | null;
  readonly paused: string | null;
}

function summarise(sample: WindowSample, heapDeltaBytes: number, cpu: FlowCpu | null, cpuSteps: number | null, paused: string | null): RunRecord {
  const seconds = sample.windowMs / 1000;
  const rafMedian = median(sample.intervals);
  return {
    rafMedianMs: round(rafMedian),
    rafP95Ms: round(percentile(sample.intervals, 0.95)),
    fps: round(1000 / rafMedian, 2),
    glFramesPerSec: round(sample.glClears / seconds, 2),
    flowRendersPerSec: sample.flowRenders === null ? null : round(sample.flowRenders / seconds, 2),
    flowStepsPerSec: sample.flowSteps === null ? null : round(sample.flowSteps / seconds, 2),
    longTaskCount: sample.longTaskCount,
    longTaskMaxMs: round(sample.longTaskMaxMs, 1),
    heapDeltaKB: round(heapDeltaBytes / 1024, 1),
    canvasCssPx: [sample.canvasW, sample.canvasH],
    particleCountEquivalent: Math.max(0, Math.min(4096, Math.round((sample.canvasW * sample.canvasH) / 1024))),
    cpu: cpu === null ? null : {
      samples: cpu.samples,
      flowSamples: cpu.flowSamples,
      flowMs: cpu.flowMs,
      burstCount: cpu.burstCount,
      burstP50Ms: cpu.burstP50Ms,
      burstP95Ms: cpu.burstP95Ms,
      burstMaxMs: cpu.burstMaxMs
    },
    cpuMeanPerStepMs: cpu !== null && cpuSteps !== null && cpuSteps > 0 ? round(cpu.flowMs / cpuSteps, 3) : null,
    paused
  };
}

async function heapUsed(cdp: CDPSession): Promise<number> {
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  return usedSize;
}

async function measureOnce(browser: Browser, spec: ConditionSpec, flowSuffixes: readonly string[]): Promise<RunRecord> {
  const booted = await boot(browser, spec.boot);
  const { page, cdp, context } = booted;
  try {
    await spec.prepare?.(page);
    const motion = spec.motion ?? idleMotion;
    // Warm-up: the same motion the window will have, so the first window frames are not cold.
    await motion(page, performance.now() + WARM_UP_MS);
    await cdp.send('HeapProfiler.collectGarbage');
    const heapBefore = await heapUsed(cdp);
    const windowEnd = performance.now() + WINDOW_MS + 500;
    const collected = page.evaluate((ms) => (window as unknown as { __flowMeasure: (ms: number) => Promise<WindowSample> }).__flowMeasure(ms), WINDOW_MS);
    const driven = motion(page, windowEnd);
    const [sample] = await Promise.all([collected, driven]);
    const heapDelta = (await heapUsed(cdp)) - heapBefore;

    let cpu: FlowCpu | null = null;
    let cpuSteps: number | null = null;
    if (spec.profiled !== false) {
      const profileEnd = performance.now() + WINDOW_MS;
      const stepsBefore = await page.evaluate(() => Number(document.querySelector<HTMLElement>('.enso-flow')?.dataset['flowSteps'] ?? Number.NaN));
      cpu = await profileDuring(cdp, () => motion(page, profileEnd), flowSuffixes);
      const stepsAfter = await page.evaluate(() => Number(document.querySelector<HTMLElement>('.enso-flow')?.dataset['flowSteps'] ?? Number.NaN));
      cpuSteps = Number.isNaN(stepsBefore) || Number.isNaN(stepsAfter) ? null : stepsAfter - stepsBefore;
    }
    const paused = spec.boot.flow === 'off' ? null : await panelOf(page).getAttribute('data-flow-motion');
    expect(noddStubLog(page).filter((entry) => entry.answer === 'unstubbed'), 'no unstubbed NODD read').toEqual([]);
    expectNoEscape(booted.aborted, spec.id);
    return summarise(sample, heapDelta, cpu, cpuSteps, paused);
  } finally {
    await context.close();
  }
}

/** Median of medians over RUNS runs (and the median of each run's p95). */
function combine(runs: readonly RunRecord[]): Json {
  const med = (pick: (run: RunRecord) => number | null): number | null => {
    const values = runs.map(pick).filter((v): v is number => v !== null && !Number.isNaN(v));
    return values.length === 0 ? null : round(median(values));
  };
  return {
    rafMedianMs: med((r) => r.rafMedianMs),
    rafP95Ms: med((r) => r.rafP95Ms),
    fps: med((r) => r.fps),
    glFramesPerSec: med((r) => r.glFramesPerSec),
    flowRendersPerSec: med((r) => r.flowRendersPerSec),
    flowStepsPerSec: med((r) => r.flowStepsPerSec),
    longTaskCountMedian: med((r) => r.longTaskCount),
    longTaskMaxMsMedian: med((r) => r.longTaskMaxMs),
    heapDeltaKBMedian: med((r) => r.heapDeltaKB),
    particleCountEquivalent: med((r) => r.particleCountEquivalent),
    flowCpuBurstP95Ms: med((r) => r.cpu?.burstP95Ms ?? null),
    flowCpuBurstMaxMs: med((r) => r.cpu?.burstMaxMs ?? null),
    flowCpuMeanPerStepMs: med((r) => r.cpuMeanPerStepMs)
  };
}

// ---------------------------------------------------------------------------
// The conditions (plan 4.2).
// ---------------------------------------------------------------------------

/** Viewport sized so the map canvas has `factor` times the Standard canvas area: width grows, or height shrinks, by it. */
async function resizeForDensity(page: Page, factor: number): Promise<void> {
  const box = await mapBox(page);
  const chromeW = VIEWPORT.width - box.width;
  const chromeH = VIEWPORT.height - box.height;
  const next = factor >= 1
    ? { width: Math.round(chromeW + box.width * factor), height: VIEWPORT.height }
    : { width: VIEWPORT.width, height: Math.round(chromeH + box.height * factor) };
  await page.setViewportSize(next);
  await hold(page, 600);
}

const CONDITIONS: readonly ConditionSpec[] = [
  { id: 'flow-off', describe: 'flow off', boot: { flow: 'off' }, profiled: false },
  {
    id: 'currents-arrows', describe: "today's interim arrows: ocean currents, Open-Meteo stubbed (the wind and wave arrows of 4c2afb4 were removed by E2-1)",
    boot: { flow: 'currents' }, profiled: false
  },
  { id: 'wind-sparse', describe: 'wind, Sparse (canvas area halved: half the particles)', boot: { flow: 'wind' }, prepare: (page) => resizeForDensity(page, 0.5), note: 'density emulated by canvas area; frame rate not comparable' },
  { id: 'wind-standard', describe: 'wind, Standard', boot: { flow: 'wind' } },
  { id: 'wind-dense', describe: 'wind, Dense (canvas area doubled: double the particles)', boot: { flow: 'wind' }, prepare: (page) => resizeForDensity(page, 2), note: 'density emulated by canvas area; frame rate not comparable' },
  { id: 'waves', describe: 'waves (crest marks)', boot: { flow: 'waves' } },
  { id: 'still', describe: 'still form from a stored Pause choice', boot: { flow: 'wind', storedPause: true } },
  { id: 'paused-keyboard', describe: 'wind, paused with the keyboard after boot', boot: { flow: 'wind' }, prepare: async (page) => { await pauseByKeyboard(page); await hold(page, 3000); } },
  { id: 'reduced-motion', describe: 'wind under prefers-reduced-motion', boot: { flow: 'wind', reduced: true } },
  { id: 'pan', describe: 'wind, a pan: 500 px drags back and forth, about 25 degrees of longitude at zoom 3.8', boot: { flow: 'wind' }, motion: panMotion },
  { id: 'zoom', describe: 'wind, a zoom: wheel notches in and out (the production build exposes no zoom value)', boot: { flow: 'wind' }, motion: zoomMotion },
  { id: 'dpr2', describe: 'wind, device pixel ratio 2', boot: { flow: 'wind', dpr: 2 } }
];

test.describe('flow measure (ENSO-FLOW-PLAN 4.2 and 4.4)', () => {
  test.describe.configure({ mode: 'serial' });

  test('records WEBGL_debug_renderer_info and labels SwiftShader or llvmpipe as a software GL floor', async ({ browser }) => {
    const { page, context } = await boot(browser, { flow: 'off' });
    try {
      const renderer = await rendererString(page);
      const software = isSoftwareGl(renderer);
      record('renderer', {
        webglDebugRendererInfo: renderer,
        softwareGlFloor: software,
        fpsLabel: software ? SOFTWARE_GL_LABEL : 'hardware renderer',
        viewport: VIEWPORT
      });
      expect(renderer, 'a renderer string was read').not.toMatch(/unavailable|no WebGL2/);
      console.log(`flow-measure renderer: ${renderer}${software ? ` (${SOFTWARE_GL_LABEL})` : ''}`);
    } finally {
      await context.close();
    }
  });

  test("records the flow chunk's and the Worker's transferred bytes from CDP Network.loadingFinished", async ({ browser }) => {
    const { chunks, worker } = flowFiles();
    expect(chunks.length, 'the flow chunk is in the build manifest (run npm run build)').toBeGreaterThan(0);
    interface Seen { url: string; status: number; encoded: number; dataLength: number; bodyBytes: number }
    const perKind: Record<string, unknown> = {};
    for (const flow of ['wind', 'waves'] as const) {
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      const aborted = await installBackstop(context);
      const page = await context.newPage();
      try {
        await page.route('https://tile.openstreetmap.org/**', (route: Route) =>
          route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }));
        await page.clock.setFixedTime(LIVE_CLOCK);
        await stubSst(page);
        await stubOpenMeteo(page);
        const cdp = await context.newCDPSession(page);
        const requests = new Map<string, Seen>();
        cdp.on('Network.requestWillBeSent', (event: { requestId: string; request: { url: string } }) => {
          requests.set(event.requestId, { url: event.request.url, status: 0, encoded: 0, dataLength: 0, bodyBytes: 0 });
        });
        cdp.on('Network.responseReceived', (event: { requestId: string; response: { status: number } }) => {
          const seen = requests.get(event.requestId);
          if (seen) seen.status = event.response.status;
        });
        cdp.on('Network.dataReceived', (event: { requestId: string; dataLength: number }) => {
          const seen = requests.get(event.requestId);
          if (seen) seen.dataLength += event.dataLength;
        });
        cdp.on('Network.loadingFinished', (event: { requestId: string; encodedDataLength: number }) => {
          const seen = requests.get(event.requestId);
          if (seen) seen.encoded = event.encodedDataLength;
        });
        await cdp.send('Network.enable');
        // A dedicated Worker's script load is announced on the page session but never finishes there, so its
        // size is also read from Playwright's own request timing (response body and header bytes as sent).
        const playwrightSizes = new Map<string, { responseBodySize: number; responseHeadersSize: number }>();
        page.on('requestfinished', (request) => {
          void request.sizes().then((sizes) => {
            playwrightSizes.set(request.url(), { responseBodySize: sizes.responseBodySize, responseHeadersSize: sizes.responseHeadersSize });
          }).catch(() => undefined);
        });
        // Boot with flow off: the flow chunk and the Worker are then the cost of choosing the kind, not of boot.
        await gotoApp(page, '?cluster=enso&ocean=pacific&flow=off', { flowMotion: 'live' });
        const bootUrls = new Set([...requests.values()].map((r) => r.url));
        await panelOf(page).locator(`[data-flow-kind="${flow}"]`).click();
        await waitFlowReady(page, flow);
        const after = [...requests.values()].filter((r) => !bootUrls.has(r.url) || NODD.test(r.url));
        const isChunk = (url: string): boolean => chunks.some((file) => url.endsWith(file));
        const chunkRows = after.filter((r) => isChunk(r.url));
        const workerRows = after.filter((r) => /decode-worker/.test(r.url) || (worker !== null && r.url.endsWith(worker)));
        const noddRows = after.filter((r) => NODD.test(r.url));
        const distBytes = (files: readonly string[]): { raw: number; gzip: number } => files.reduce(
          (sum, file) => {
            const bytes = readFileSync(join(ROOT, 'dist', file));
            return { raw: sum.raw + bytes.length, gzip: sum.gzip + gzipSync(bytes).length };
          },
          { raw: 0, gzip: 0 }
        );
        const workerFiles = workerRows.map((r) => r.url.slice(r.url.indexOf('/assets/') + 1)).filter((f) => f.startsWith('assets/'));
        /** The message spans the stub answered from a fixture, summed (the two reads of the pair). */
        const messageSpanBytes = noddStubLog(page).reduce((sum, entry) => {
          const m = /^bytes=(\d+)-(\d+)$/.exec(entry.range ?? '');
          const fixture = NODD_FIXTURES.find((row) => entry.url.endsWith(row.key) && row.range !== null && row.range === entry.range);
          return m && fixture ? sum + Number(m[2]) - Number(m[1]) + 1 : sum;
        }, 0);
        perKind[flow] = {
          flowChunk: { files: chunks, requests: chunkRows.map(({ url, status, encoded, dataLength }) => ({ url, status, encodedDataLength: encoded, dataLength })), dist: distBytes(chunks) },
          worker: {
            file: worker,
            requests: workerRows.map(({ url, status, encoded, dataLength }) => ({
              url, status, encodedDataLength: encoded, dataLength, playwrightSizes: playwrightSizes.get(url) ?? null
            })),
            dist: workerFiles.length > 0 ? distBytes(workerFiles) : null
          },
          nodd: {
            requestCount: noddRows.length,
            requests: noddRows.map(({ url, status, encoded, dataLength }) => ({ url: url.replace('https://noaa-gfs-bdp-pds.s3.amazonaws.com/', ''), status, encodedDataLength: encoded, dataLength })),
            cdpEncodedBytes: noddRows.reduce((sum, r) => sum + r.encoded, 0),
            cdpDataBytes: noddRows.reduce((sum, r) => sum + r.dataLength, 0),
            messageSpanBytes
          },
          note: 'Transferred bytes by CDP Network.loadingFinished. The preview server compresses the chunk, so encodedDataLength is its gzip size plus headers, beside dist.gzip, the figure check:activation prints; the Worker script request is announced but never finishes on the page session, so its size is its dist file. NODD responses are fulfilled by the test stub, so their CDP lengths are the stub body lengths; the messages are the real GRIB2 messages cut from the bucket.'
        };
        expect(chunkRows.length, `${flow}: the flow chunk was requested after boot`).toBeGreaterThan(0);
        expect(workerRows.length, `${flow}: the decode Worker script was requested`).toBeGreaterThan(0);
        expect(noddRows.length, `${flow}: NODD reads (one .idx and two ranges)`).toBe(3);
        expectNoEscape(aborted, `${flow} bytes`);
      } finally {
        await context.close();
      }
    }
    record('bytes', perKind);
  });

  test('records the DIRPW + HTSGW wall time at 1.6 Mbit/s and finds the slow-link rate where the pair passes 12 s', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const fixtureSize = (key: string): number => {
      const row = NODD_FIXTURES.find((r) => r.key === key && r.range === null);
      if (!row) return 0;
      return readFileSync(new URL(`./fixtures/flow/${row.file}`, import.meta.url)).length;
    };
    /** The body bytes the stub will send for one NODD request. */
    const bodyBytes = (url: string, range: string | null): number => {
      const key = new URL(url).pathname.replace(/^\//, '');
      const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
      if (key.endsWith('.idx')) return Math.min(fixtureSize(key), m ? Number(m[2] === '' ? Infinity : m[2]) + 1 : Infinity);
      return m ? Number(m[2]) - Number(m[1]) + 1 : 0;
    };

    async function waveRead(rateMbit: number): Promise<{ rateMbit: number; wallMs: number; status: string; bytes: number }> {
      const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      const aborted = await installBackstop(context);
      const page = await context.newPage();
      try {
        await page.route('https://tile.openstreetmap.org/**', (route: Route) =>
          route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }));
        await page.clock.setFixedTime(LIVE_CLOCK);
        await stubSst(page);
        await stubOpenMeteo(page);
        // One shared link: each request waits its latency, then queues behind the bytes already on the wire.
        let linkFreeAt = 0;
        let bytes = 0;
        await page.route(NODD, async (route) => {
          const request = route.request();
          const size = bodyBytes(request.url(), (await request.headerValue('range')) ?? null);
          bytes += size;
          const now = performance.now();
          const begins = Math.max(now + NETWORK_FLOOR.latencyMs, linkFreeAt);
          const done = begins + (size * 8) / (rateMbit * 1000);
          linkFreeAt = done;
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, done - now)));
          await route.fallback();
        });
        await gotoApp(page, '?cluster=enso&ocean=pacific&flow=off', { flowMotion: 'live' });
        const panel = panelOf(page);
        const t0 = performance.now();
        await panel.locator('[data-flow-kind="waves"]').click();
        await expect(panel).toHaveAttribute('data-status', /^(live|unavailable)/, { timeout: READ_BUDGET_MS * 3 });
        const wallMs = performance.now() - t0;
        const status = ((await panel.getAttribute('data-status')) ?? '').startsWith('live') ? 'live' : 'unavailable';
        expectNoEscape(aborted, `slow link ${rateMbit} Mbit/s`);
        return { rateMbit, wallMs: round(wallMs, 0), status, bytes };
      } finally {
        await context.close();
      }
    }

    const floor = await waveRead(NETWORK_FLOOR.rateMbit);
    record('waveWallTime', {
      label: 'network floor',
      rateMbit: NETWORK_FLOOR.rateMbit,
      latencyMs: NETWORK_FLOOR.latencyMs,
      linkModel: 'one shared link: each request pays the latency, then queues behind bytes already on the wire (page.route delay, so CDP throttling, which does not reach fulfilled responses, is not used)',
      wallMsClickToLive: floor.wallMs,
      status: floor.status,
      bytesOnTheWire: floor.bytes
    });
    expect(floor.status, 'the wave pair reads at 1.6 Mbit/s').toBe('live');
    expect(floor.wallMs, 'inside one read budget at 1.6 Mbit/s').toBeLessThan(READ_BUDGET_MS);

    // Where the pair passes 12 s: bisect the rate between a failing floor and the passing 1.6.
    const pairBytes = (NODD_FIXTURES.filter((r) => /global\.0p25\.f006\.grib2$/.test(r.key) && r.range !== null)
      .reduce((sum, r) => sum + Number((r.range as string).split('-')[1]) - Number((r.range as string).split('=')[1]!.split('-')[0]) + 1, 0));
    const predicted = (pairBytes * 8) / ((READ_BUDGET_MS - NETWORK_FLOOR.latencyMs) * 1000);
    const trials: Array<{ rateMbit: number; wallMs: number; status: string }> = [{ rateMbit: floor.rateMbit, wallMs: floor.wallMs, status: floor.status }];
    let passing = NETWORK_FLOOR.rateMbit;
    let failing = 0.4;
    const lowest = await waveRead(failing);
    trials.push({ rateMbit: lowest.rateMbit, wallMs: lowest.wallMs, status: lowest.status });
    if (lowest.status === 'live') {
      passing = failing;
      failing = Number.NaN;
    } else {
      for (let i = 0; i < 5; i++) {
        const rate = round((passing + failing) / 2, 4);
        const trial = await waveRead(rate);
        trials.push({ rateMbit: trial.rateMbit, wallMs: trial.wallMs, status: trial.status });
        if (trial.status === 'live') passing = rate;
        else failing = rate;
      }
    }
    record('slowLink', {
      readBudgetMs: READ_BUDGET_MS,
      pairBytes,
      predictedThresholdMbit: round(predicted, 3),
      lowestPassingMbit: passing,
      highestFailingMbit: failing,
      trials,
      note: 'The reads run together and share the link, so the pair passes the 12 s read budget when latency plus both messages at the link rate exceeds it; the bracket is the in-browser result, the prediction is that arithmetic.'
    });
    expect(Number.isNaN(failing), 'a rate below the passing one failed the 12 s budget').toBe(false);
    expect(passing, 'the bracket closes').toBeGreaterThan(failing);
  });

  test('records paired completed pans with wind and flow off', async ({ browser }) => {
    test.setTimeout(60 * 60_000);
    const pairs: Array<{
      order: readonly PanFlow[];
      arms: Partial<Record<PanFlow, PanRun>>;
      difference: Record<string, number> | null;
    }> = [];
    const report = {
      complete: false,
      nativeGpuRequested: NATIVE_GPU_REQUESTED,
      viewport: VIEWPORT,
      warmUpMs: WARM_UP_MS,
      protocol: { directions: PAN_DIRECTIONS, distancePx: PAN_DISTANCE_PX, mouseSteps: PAN_STEPS, stationaryReleaseHoldMs: PAN_RELEASE_HOLD_MS },
      timeDomain: 'threadTicks',
      cpuScope: 'CDP Performance.TaskDuration: renderer main-thread running time for all page tasks, including MapLibre and instrumentation; excludes workers, GPU and other processes.',
      differenceScope: 'Wind minus off for identical completed pointer inputs and matching camera endpoints. Additional page cost, not isolated flow-code CPU. Frame quantile differences describe these samples, not paired individual frames.',
      pairs
    };
    // Persist before starting an arm, including when teardown never runs.
    // Every completed arm also survives a later interrupted measurement.
    record('pairedPan', report);
    writeResults();
    const orders: readonly (readonly PanFlow[])[] = [['off', 'wind'], ['wind', 'off']];
    for (let repeat = 0; repeat < RUNS; repeat++) {
      for (const order of orders) {
        const pair: typeof pairs[number] = { order, arms: {}, difference: null };
        pairs.push(pair);
        for (const flow of order) {
          pair.arms[flow] = await measureCompletedPans(browser, flow);
          writeResults();
        }
        const off = pair.arms.off!;
        const wind = pair.arms.wind!;
        samePanCamera(wind.initialCamera, off.initialCamera);
        expect(wind.renderer, 'both arms use the same actual renderer').toEqual(off.renderer);
        for (let i = 0; i < PAN_DIRECTIONS.length; i++) samePanCamera(wind.gestureEnds[i]!, off.gestureEnds[i]!);
        const summary = (run: PanRun): Record<string, number> => ({
          taskDurationThreadMs: run.taskDurationThreadMs,
          taskDurationPerGestureMs: run.taskDurationThreadMs / run.gestureEnds.length,
          hostElapsedMs: run.hostElapsedMs,
          pageElapsedMs: run.frames.endedAtMs - run.frames.startedAtMs,
          rafMedianMs: median(run.frames.intervalsMs),
          rafP95Ms: percentile(run.frames.intervalsMs, 0.95),
          longTaskCount: run.frames.longTasks.length,
          longTaskTotalMs: run.frames.longTasks.reduce((sum, entry) => sum + entry.durationMs, 0),
          longTaskMaxMs: Math.max(0, ...run.frames.longTasks.map((entry) => entry.durationMs))
        });
        const offSummary = summary(off);
        const windSummary = summary(wind);
        pair.difference = Object.fromEntries(Object.keys(windSummary).map((key) => [key, windSummary[key]! - offSummary[key]!]));
        writeResults();
        console.log(`flow-measure paired-pan ${pairs.length} ${order.join(' then ')}: ${JSON.stringify(pair.difference)}`);
      }
    }
    report.complete = true;
    writeResults();
  });

  test('records frame rate, render rate, CPU, long tasks and heap for every condition', async ({ browser }) => {
    test.setTimeout(60 * 60_000);
    const { chunks } = flowFiles();
    expect(chunks.length, 'the flow chunk is in the build manifest (run npm run build)').toBeGreaterThan(0);
    const suffixes = chunks.map((file) => `/${file}`);
    const probe = await boot(browser, { flow: 'off' });
    const renderer = await rendererString(probe.page);
    await probe.context.close();
    const software = isSoftwareGl(renderer);
    const out: Json = {};
    for (const spec of CONDITIONS) {
      const runs: RunRecord[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(browser, spec, suffixes));
      out[spec.id] = {
        describe: spec.describe,
        note: spec.note ?? null,
        fpsLabel: software ? SOFTWARE_GL_LABEL : 'hardware renderer',
        medianOfMedians: combine(runs),
        runs
      };
      console.log(`flow-measure ${spec.id}: ${JSON.stringify((out[spec.id] as { medianOfMedians: Json }).medianOfMedians)}`);
    }
    record('conditions', { renderer, softwareGlFloor: software, warmUpMs: WARM_UP_MS, windowMs: WINDOW_MS, runs: RUNS, viewport: VIEWPORT, conditions: out });
    const standard = (out['wind-standard'] as { medianOfMedians: Json }).medianOfMedians;
    expect(standard['glFramesPerSec'], 'wind at Standard rendered frames').toBeGreaterThan(0);
  });

  test('paused: 0 renders in 2 s after a 3 s settle', async ({ browser }) => {
    const { page, context } = await boot(browser, { flow: 'wind' });
    try {
      const rendersOver = (ms: number): Promise<number> => page.evaluate(async (windowMs) => {
        const read = (): number => Number(document.querySelector<HTMLElement>('.enso-flow')?.dataset['flowRenders'] ?? 0);
        const before = read();
        await new Promise((resolve) => setTimeout(resolve, windowMs));
        return read() - before;
      }, ms);
      const moving = await rendersOver(1000);
      await pauseByKeyboard(page);
      await hold(page, 3000);
      const paused = await rendersOver(2000);
      record('pausedRenders', { movingRendersPerSecondBeforePause: moving, rendersIn2sAfter3sSettle: paused });
      expect(moving, 'the moving form was rendering before the pause').toBeGreaterThan(0);
      expect(paused).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('reduced motion: 0 renders', async ({ browser }) => {
    const { page, context } = await boot(browser, { flow: 'wind', reduced: true });
    try {
      await hold(page, 3000);
      const renders = await page.evaluate(async () => {
        const read = (): number => Number(document.querySelector<HTMLElement>('.enso-flow')?.dataset['flowRenders'] ?? 0);
        const before = read();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return read() - before;
      });
      const form = await panelOf(page).getAttribute('data-flow-form');
      record('reducedMotionRenders', { rendersIn2sAfter3sSettle: renders, form });
      expect(form, 'reduced motion draws the still form').toBe('still');
      expect(renders).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('flow CPU step p95 ≤ 2 ms at Standard', async ({ browser }) => {
    test.setTimeout(10 * 60_000);
    const suffixes = flowFiles().chunks.map((file) => `/${file}`);
    const runs: RunRecord[] = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(await measureOnce(browser, { id: 'cpu-standard', describe: 'wind, Standard', boot: { flow: 'wind' } }, suffixes));
    }
    const p95s = runs.map((r) => r.cpu?.burstP95Ms ?? Number.NaN);
    const means = runs.map((r) => r.cpuMeanPerStepMs ?? Number.NaN);
    record('flowCpuStandard', {
      barMs: 2,
      method: 'CDP sampling profiler, flow-chunk samples grouped into bursts (see the spec header); p95 over bursts per run, median over runs',
      burstP95MsPerRun: p95s,
      burstP95MsMedian: round(median(p95s)),
      meanPerStepMsPerRun: means,
      meanPerStepMsMedian: round(median(means)),
      burstMaxMsPerRun: runs.map((r) => r.cpu?.burstMaxMs ?? Number.NaN),
      flowStepsPerSec: runs.map((r) => r.flowStepsPerSec)
    });
    expect(median(p95s), 'flow CPU step p95 at Standard (ms)').toBeLessThanOrEqual(2);
  });

  test('still-form build < 50 ms', async ({ browser }) => {
    test.setTimeout(5 * 60_000);
    const suffixes = flowFiles().chunks.map((file) => `/${file}`);
    const builds: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { page, cdp, context } = await boot(browser, { flow: 'wind', reduced: true });
      try {
        await expect(panelOf(page)).toHaveAttribute('data-flow-form', 'still');
        await hold(page, 1000);
        // Each drag ends in a moveend, and the view rebuilds the still form 150 ms later.
        const cpu = await profileDuring(cdp, async () => {
          const box = await mapBox(page);
          const cy = box.y + box.height / 2;
          for (let drag = 0; drag < 4; drag++) {
            const sign = drag % 2 === 0 ? 1 : -1;
            const cx = box.x + box.width / 2 - sign * 150;
            await page.mouse.move(cx, cy);
            await page.mouse.down();
            await page.mouse.move(cx + sign * 300, cy, { steps: 12 });
            await page.mouse.up();
            await hold(page, 700);
          }
        }, suffixes);
        // A run with no flow sample would read 0 ms and pass vacuously.
        expect(cpu.burstCount, `run ${i}: the profiler saw flow-chunk work for the rebuilds`).toBeGreaterThan(0);
        builds.push(cpu.burstMaxMs);
      } finally {
        await context.close();
      }
    }
    record('stillFormBuild', {
      barMs: 50,
      method: 'longest flow-chunk burst (buildStillForm plus the source.setData call) while four drags each end in a moveend rebuild; per run, then the median',
      maxBurstMsPerRun: builds,
      medianMs: round(median(builds))
    });
    expect(median(builds), 'still-form build (ms)').toBeLessThan(50);
  });
});
