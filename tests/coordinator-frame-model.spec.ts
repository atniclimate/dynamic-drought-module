import { test, expect, type Page } from '@playwright/test';
import { gotoApp, waitForLayerSettled } from './helpers';
import { serializePopupFrame } from '../src/ui/popup-frame';
import type { PopupModel } from '../src/ui/popup-frame';

/**
 * S30D P1-FRAME (2026-10-04): the InteractionCoordinator is the popup frame's
 * one caller. A click target may answer a MODEL (`CoordinatedResponse.model`)
 * instead of `content`; the coordinator serializes it through its one dynamic
 * import of src/ui/popup-frame.ts, warmed when the first click target
 * registers, and feeds the markup down the unchanged framed path. When a
 * commit carrying a model lands before the chunk has resolved, the commit
 * waits, then re-checks that it is still the current one before it paints or
 * writes any state.
 *
 * THE TEST-SIDE CLICK TARGET. No builder answers a model on this base (every
 * builder is in LEGACY_ALLOWANCE), and the production build exposes no
 * registration seam, so each boot rewrites the built Federal Reservations
 * chunk as it is served: its one `registerClickTarget({kind:'reservation-
 * boundary', ...})` call goes through `window.__ddmModelWrap`, an init-script
 * wrapper that keeps the layer's real target (its layer id, label, hit
 * testing, and the selection and emphasis its real respond builds) and
 * replaces only the answer's content with a scripted one: a model, or the
 * frame's serialized markup as legacy `content`. The rewrite must match the
 * built chunk exactly once or the boot fails loudly (a minifier change can
 * never pass silently). The synthetic reservation fixture (gotoApp's
 * boundary stubs) covers the viewport centre.
 *
 * THE OBSERVABLES are DOM-only and recorded by an init-script observer from
 * the first byte of the page: every coordinated response that appears in
 * either sink (the map popup and the Brief panel foot), by its frame title;
 * every write of the place-selection stamp (`#app[data-place-selected]`);
 * every write of the emphasis stamp (`html[data-ddm-emphasis]`). A
 * superseded commit must add nothing to any of the three.
 *
 * THE SETTLE SIGNAL after a release: the page imports the same chunk URL the
 * coordinator imported (one module record), then yields one task, so every
 * continuation the coordinator queued on that import has run before the
 * assertions read the record (after a held request is FAILED, the same import
 * is awaited for its rejection instead). No fixed sleep anywhere.
 */

const PLACE_TITLE = 'Fixture Framed Place';
const SURFACE_TITLE = 'Fixture Framed Surface';

const PLACE_MODEL: PopupModel = {
  kind: 'place',
  title: PLACE_TITLE,
  issuer: { role: 'boundary-from', name: 'Fixture boundary issuer', productKey: 'states' },
  value: [{ text: 'Fixture place value' }],
  clocks: [{ kind: 'point', meaning: 'edition', label: 'Fixture edition', at: { precision: 'year', year: '2024' } }],
  source: { link: { label: 'Fixture place source', href: 'https://www.census.gov/' } },
  details: [{ kind: 'row', label: 'Fixture detail', text: 'Fixture detail text' }],
  actions: [{ kind: 'briefing', place: PLACE_TITLE }]
};

const SURFACE_MODEL: PopupModel = {
  kind: 'surface',
  title: SURFACE_TITLE,
  issuer: { role: 'issued-by', name: 'Fixture surface issuer', productKey: 'usdm' },
  value: [{ text: 'Fixture surface value' }],
  clocks: [{ kind: 'point', meaning: 'map-date', label: 'Fixture map date', at: { precision: 'date', date: '2026-09-29' } }],
  source: { link: { label: 'Fixture surface source', href: 'https://droughtmonitor.unl.edu/' } }
};

/** One scripted answer: a model, or the frame's markup as legacy content; place answers keep the real selection and emphasis. */
interface Answer {
  readonly model?: PopupModel;
  readonly markup?: string;
  readonly place: boolean;
}

interface ModelLog {
  readonly responds: number;
  readonly paints: string[];
  readonly selection: string[];
  readonly emphasis: string[];
}

/**
 * The init script (page context; self-contained). Answers are taken in click
 * order; the last one repeats.
 */
function installModelTarget(answers: readonly Answer[]): void {
  type Response = { readonly selection?: unknown; readonly emphasis?: unknown } | null;
  type Spec = { readonly respond: (...args: unknown[]) => Response };
  const log = { responds: 0, paints: [] as string[], selection: [] as string[], emphasis: [] as string[] };
  const w = window as unknown as {
    __ddmModelLog?: typeof log;
    __ddmModelWrap?: (register: (spec: Spec) => void) => (spec: Spec) => void;
  };
  w.__ddmModelLog = log;
  w.__ddmModelWrap = (register) => (spec) =>
    register({
      ...spec,
      respond: (...args: unknown[]) => {
        const real = spec.respond(...args);
        const answer = answers[Math.min(log.responds, answers.length - 1)];
        log.responds += 1;
        if (!real || !answer) return real;
        const place = answer.place ? { selection: real.selection, emphasis: real.emphasis } : {};
        return answer.model ? { ...place, model: answer.model } : { ...place, content: answer.markup };
      }
    });
  const titleOf = (root: Element): string =>
    (root.querySelector('[data-popup-slot="title"], .popup-title')?.textContent ?? '').trim();
  // One entry per response root: MapLibre inserts the popup container, then
  // its content box, so one paint can arrive in two mutation records.
  const seen = new WeakSet<Element>();
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName === 'data-place-selected') {
          log.selection.push((record.target as Element).hasAttribute('data-place-selected') ? 'set' : 'cleared');
        } else {
          log.emphasis.push(document.documentElement.getAttribute('data-ddm-emphasis') ?? '');
        }
        continue;
      }
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        const roots = node.matches('.coordinated-response') ? [node] : Array.from(node.querySelectorAll('.coordinated-response'));
        for (const root of roots) {
          if (seen.has(root)) continue;
          seen.add(root);
          log.paints.push(titleOf(root));
        }
      }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-place-selected', 'data-ddm-emphasis']
  });
}

const BIA_CHUNK = /\/bia-reservations-[A-Za-z0-9_-]{8}\.js$/;
/** The built registration call: `<local>({kind:` before the reservation-boundary kind literal, any quote style. */
const BIA_REGISTRATION = /([\w$]+)\(\{kind:(?=[`'"]reservation-boundary[`'"])/g;

/** Boot with the reservation target answering the scripted answers. */
async function bootModelTarget(page: Page, query: string, answers: readonly Answer[]): Promise<void> {
  const rewrites: number[] = [];
  await page.route(
    (url) => BIA_CHUNK.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const sites = body.match(BIA_REGISTRATION)?.length ?? 0;
      rewrites.push(sites);
      await route.fulfill({
        response,
        body: sites === 1 ? body.replace(BIA_REGISTRATION, '(window.__ddmModelWrap||(f=>f))($1)({kind:') : body
      });
    }
  );
  await page.addInitScript(installModelTarget, answers);
  await gotoApp(page, query);
  await waitForLayerSettled(page, 'bia-reservations');
  expect(rewrites, 'the built reservation chunk carries exactly one registration call to wrap').toEqual([1]);
}

interface FrameGate {
  /** Every frame chunk request, in order (a retry carries `retry=<n>`). */
  readonly urls: string[];
  /** Let held requests through. */
  release(): void;
  /** While true, every frame chunk request is aborted. */
  failing: boolean;
}

const FRAME_CHUNK = /\/popup-frame-[A-Za-z0-9_-]{8}\.js$/;

/** Hold (until release) or fail every request for the built popup-frame chunk. Install before the boot. */
async function gateFrameChunk(page: Page, mode: 'hold' | 'fail'): Promise<FrameGate> {
  let open: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  const gate: FrameGate = { urls: [], release: () => open(), failing: mode === 'fail' };
  if (mode === 'fail') open();
  await page.route(
    (url) => FRAME_CHUNK.test(url.pathname),
    async (route) => {
      gate.urls.push(route.request().url());
      // `failing` is read at release, so a held request can also be failed.
      await released;
      if (gate.failing) await route.abort('failed');
      else await route.continue();
    }
  );
  return gate;
}

async function readLog(page: Page): Promise<ModelLog> {
  return page.evaluate(() => {
    const log = (window as unknown as { __ddmModelLog?: ModelLog }).__ddmModelLog;
    return {
      responds: log?.responds ?? 0,
      paints: [...(log?.paints ?? [])],
      selection: [...(log?.selection ?? [])],
      emphasis: [...(log?.emphasis ?? [])]
    };
  });
}

async function mapPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/**
 * Click until the reservation target has answered `count` times in all. The
 * fill is queryable a frame or two after its pill settles; a click that lands
 * before then hits nothing (respond is synchronous with the click, so a hit
 * is counted before the poll starts).
 */
async function clickUntilAnswered(page: Page, point: { x: number; y: number }, count: number): Promise<void> {
  await expect(async () => {
    await page.mouse.click(point.x, point.y);
    await expect.poll(async () => (await readLog(page)).responds, { timeout: 1500 }).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 20_000 });
}

/** The settle signal: the coordinator's import of this chunk has resolved and its continuations have run. */
async function frameSettled(page: Page, url: string): Promise<void> {
  await page.evaluate(async (chunk) => {
    await import(/* @vite-ignore */ chunk);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, url);
}

/**
 * The settle signal after a held request is FAILED: the page imports the same
 * URL (the cached failure, or a second aborted fetch; either rejects after the
 * coordinator's own import did), then yields one task.
 */
async function frameFailed(page: Page, url: string): Promise<void> {
  await page.evaluate(async (chunk) => {
    await import(/* @vite-ignore */ chunk).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, url);
}

async function warmed(gate: FrameGate): Promise<string> {
  await expect
    .poll(() => gate.urls.length, { message: 'the coordinator requested the frame chunk when the first click target registered', timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  return gate.urls[0]!;
}

const CONSOLE = '?region=washington_state&view=console&layers=bia-reservations';

test.describe('the coordinator is the popup frame\'s one caller', () => {
  test('a model answer paints exactly the frame serialization, in the same coordinated regions a framed content answer gets', async ({
    page
  }) => {
    const markup = serializePopupFrame(PLACE_MODEL);
    await bootModelTarget(page, CONSOLE, [
      { markup, place: true },
      { model: PLACE_MODEL, place: true }
    ]);
    const centre = await mapPoint(page, 0.5, 0.5);
    const read = async () => {
      await expect(page.locator('.maplibregl-popup-content > [data-popup-frame]')).toHaveCount(1);
      return page.evaluate((html) => {
        const root = document.querySelector('.maplibregl-popup-content > [data-popup-frame]')!;
        const clone = root.cloneNode(true) as Element;
        const strip = (el: Element | undefined, name: string): void => {
          el?.classList.remove(name);
          if (el?.getAttribute('class') === '') el.removeAttribute('class');
        };
        strip(clone, 'coordinated-response');
        clone.removeAttribute('data-ddm-response');
        strip(clone.children[0], 'coordinated-response-head');
        strip(clone.children[1], 'coordinated-response-body');
        const parsed = document.createElement('div');
        parsed.innerHTML = html;
        return {
          outer: root.outerHTML,
          stripped: clone.outerHTML,
          expected: parsed.firstElementChild?.outerHTML ?? '',
          popupClass: root.closest('.maplibregl-popup')?.className ?? '',
          regions: Array.from(root.children).map((c) => c.getAttribute('class')),
          stamp: root.getAttribute('data-ddm-response')
        };
      }, markup);
    };

    // The legacy framed path: the frame's markup handed over as content.
    await clickUntilAnswered(page, centre, 1);
    const viaContent = await read();
    await page.keyboard.press('Escape');
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

    // The model path: the coordinator serializes the same model itself.
    await clickUntilAnswered(page, centre, 2);
    const viaModel = await read();
    expect(viaModel.outer, 'the model path renders the same DOM as the framed content path').toBe(viaContent.outer);
    expect(viaModel.stripped, 'the displayed frame is the serialization plus only the coordinator\'s own classes and stamp').toBe(viaModel.expected);
    expect(viaModel.popupClass).toContain('ddm-popup-framed');
    expect(viaModel.regions).toEqual(['coordinated-response-head', 'coordinated-response-body']);
    expect(viaModel.stamp).toBe('bia-reservations-fill');
    expect((await readLog(page)).paints).toEqual([PLACE_TITLE, PLACE_TITLE]);
    // The place answer established its selection on the model path too.
    await expect(page.locator('#app')).toHaveAttribute('data-place-selected', '');
  });

  test('a click while the frame chunk is held paints nothing until release, then paints once', async ({ page }) => {
    const gate = await gateFrameChunk(page, 'hold');
    await bootModelTarget(page, CONSOLE, [{ model: PLACE_MODEL, place: true }]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    const before = await readLog(page);

    await clickUntilAnswered(page, centre, 1);
    const held = await readLog(page);
    expect(held.paints, 'nothing paints while the chunk is held').toEqual([]);
    expect(held.selection, 'no selection is written before the commit can paint').toEqual(before.selection);
    expect(held.emphasis, 'no emphasis is written before the commit can paint').toEqual(before.emphasis);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

    gate.release();
    await frameSettled(page, url);
    const after = await readLog(page);
    expect(after.paints, 'the held commit paints exactly once on release').toEqual([PLACE_TITLE]);
    expect(after.selection.length, 'the place commit writes its selection after the wait').toBeGreaterThan(before.selection.length);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
    expect(gate.urls, 'one request: the click waited on the warm-up import').toEqual([url]);
  });

  test('a second click during the hold wins: the first commit never paints and never writes its selection or emphasis', async ({
    page
  }) => {
    const gate = await gateFrameChunk(page, 'hold');
    await bootModelTarget(page, CONSOLE, [
      { model: PLACE_MODEL, place: true },
      { model: SURFACE_MODEL, place: false }
    ]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    const before = await readLog(page);

    await clickUntilAnswered(page, centre, 1);
    await clickUntilAnswered(page, centre, 2);
    expect((await readLog(page)).paints).toEqual([]);

    gate.release();
    await frameSettled(page, url);
    const after = await readLog(page);
    expect(after.paints, 'only the later commit paints').toEqual([SURFACE_TITLE]);
    expect(after.selection, 'the superseded place commit wrote no selection').toEqual(before.selection);
    expect(after.emphasis, 'the superseded place commit wrote no emphasis').toEqual(before.emphasis);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
  });

  const DISMISSALS: ReadonlyArray<{ readonly name: string; readonly open: boolean; readonly dismiss: (page: Page) => Promise<void> }> = [
    {
      name: 'an empty-map click',
      open: false,
      dismiss: async (page) => {
        // West of the fixture rectangles: water and coast, no registered feature.
        const box = await page.locator('#map').boundingBox();
        if (!box) throw new Error('map container has no box');
        await page.mouse.click(box.x + 12, box.y + box.height / 2);
      }
    },
    { name: 'Escape on the open response', open: true, dismiss: (page) => page.keyboard.press('Escape') },
    // P1-FRAME repair round 2: nothing is on screen yet, so the only Escape
    // handler that can retire the held commit is the one its wait installs.
    { name: 'Escape with no response open', open: false, dismiss: (page) => page.keyboard.press('Escape') },
    { name: 'the open response\'s close button', open: true, dismiss: (page) => page.locator('.maplibregl-popup-close-button').click() }
  ];

  for (const route of DISMISSALS) {
    test(`a dismissal during the hold wins (${route.name}): nothing paints after release, and a later click paints`, async ({
      page
    }) => {
      const gate = await gateFrameChunk(page, 'hold');
      // With an open response, the first answer is legacy content that paints
      // at once; the held model commit is the second click.
      const answers: Answer[] = route.open
        ? [
            { markup: serializePopupFrame(SURFACE_MODEL), place: false },
            { model: PLACE_MODEL, place: true }
          ]
        : [{ model: PLACE_MODEL, place: true }];
      await bootModelTarget(page, CONSOLE, answers);
      const url = await warmed(gate);
      const centre = await mapPoint(page, 0.5, 0.5);
      if (route.open) {
        await clickUntilAnswered(page, centre, 1);
        await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
      }
      const before = await readLog(page);
      const held = answers.length;

      await clickUntilAnswered(page, centre, held);
      expect((await readLog(page)).paints).toEqual(before.paints);
      await route.dismiss(page);
      await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

      gate.release();
      await frameSettled(page, url);
      const after = await readLog(page);
      expect(after.paints, 'the dismissed commit never paints').toEqual(before.paints);
      expect(after.selection, 'the dismissed commit wrote no selection').toEqual(before.selection);
      expect(after.emphasis, 'the dismissed commit wrote no emphasis').toEqual(before.emphasis);
      await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

      // The guard left the coordinator usable: the next click paints.
      await clickUntilAnswered(page, centre, held + 1);
      await expect.poll(async () => (await readLog(page)).paints).toEqual([...before.paints, PLACE_TITLE]);
    });
  }

  test('a studio route change during the hold wins: nothing reaches the panel sink after release, and a later click does', async ({
    page
  }) => {
    const gate = await gateFrameChunk(page, 'hold');
    await bootModelTarget(page, '?region=washington_state&view=brief&layers=bia-reservations', [{ model: PLACE_MODEL, place: true }]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    const before = await readLog(page);
    const foot = page.locator('#panel-response .coordinated-response');

    await clickUntilAnswered(page, centre, 1);
    await page.locator('#place-studio-entry').click();
    await expect(page).toHaveURL(/studio=place/);

    gate.release();
    await frameSettled(page, url);
    const after = await readLog(page);
    expect(after.paints, 'the commit superseded by the studio never reaches a sink').toEqual([]);
    expect(after.selection, 'the superseded commit wrote no selection').toEqual(before.selection);
    // Entering the studio clears the emphasis itself (an empty stamp); the
    // superseded place commit would have lit its reservation.
    expect(
      after.emphasis.slice(before.emphasis.length).filter((stamp) => stamp !== ''),
      'the superseded commit lit no emphasis'
    ).toEqual([]);
    await expect(foot).toHaveCount(0);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

    await page.goBack();
    await expect(page).not.toHaveURL(/studio=/);
    await clickUntilAnswered(page, centre, 2);
    await expect.poll(async () => (await readLog(page)).paints).toEqual([PLACE_TITLE]);
    await expect(foot).toHaveCount(1);
  });

  test('a frame chunk that fails to load dismisses the open response and writes nothing, and a later click loads it under a retry URL and paints', async ({
    page
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('[coordinator]')) errors.push(message.text());
    });
    // The warm-up's own failure (the first request below) must be caught.
    const rejections: string[] = [];
    page.on('pageerror', (error) => {
      if (error.message.includes('popup-frame')) rejections.push(error.message);
    });
    const gate = await gateFrameChunk(page, 'fail');
    // A legacy answer opens a response first; the model click that fails is the second.
    await bootModelTarget(page, CONSOLE, [
      { markup: serializePopupFrame(SURFACE_MODEL), place: false },
      { model: PLACE_MODEL, place: true }
    ]);
    await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    await clickUntilAnswered(page, centre, 1);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
    const before = await readLog(page);

    await clickUntilAnswered(page, centre, 2);
    await expect.poll(() => errors.length, { message: 'the failed load is reported once', timeout: 15_000 }).toBe(1);
    const failed = await readLog(page);
    expect(failed.paints, 'the failed commit paints nothing').toEqual(before.paints);
    expect(failed.selection, 'the failed commit writes no selection').toEqual(before.selection);
    expect(failed.emphasis, 'the failed commit writes no emphasis').toEqual(before.emphasis);
    await expect(page.locator('.maplibregl-popup'), 'a click that yields no response dismisses the open one').toHaveCount(0);

    gate.failing = false;
    await clickUntilAnswered(page, centre, 3);
    await expect
      .poll(async () => (await readLog(page)).paints, { message: 'the later click loads the chunk again and paints' })
      .toEqual([...before.paints, PLACE_TITLE]);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
    expect(
      gate.urls.map((u) => new URL(u).searchParams.get('retry')),
      'the warm-up, the failed click and the later click: each retry under a new URL'
    ).toEqual([null, '1', '2']);
    expect(rejections, 'no unhandled rejection: the failed warm-up is caught where it starts').toEqual([]);
  });

  // S30D P1-FRAME repair round 1 (2026-10-04).

  test('a load that fails after its commit was superseded is not reported and dismisses nothing', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('[coordinator]')) errors.push(message.text());
    });
    const gate = await gateFrameChunk(page, 'hold');
    // The held model commit is superseded by a legacy answer that paints at once.
    await bootModelTarget(page, CONSOLE, [
      { model: PLACE_MODEL, place: true },
      { markup: serializePopupFrame(SURFACE_MODEL), place: false }
    ]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    await clickUntilAnswered(page, centre, 1);
    await clickUntilAnswered(page, centre, 2);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
    const before = await readLog(page);
    expect(before.paints, 'the later legacy answer painted at once').toEqual([SURFACE_TITLE]);

    gate.failing = true;
    gate.release();
    await frameFailed(page, url);
    await expect(page.locator('.maplibregl-popup'), 'the superseded commit\'s failed load dismissed nothing').toHaveCount(1);
    expect(errors, 'the superseded commit\'s failed load is not reported').toEqual([]);
    const after = await readLog(page);
    expect(after.paints).toEqual(before.paints);
    expect(after.selection, 'the superseded commit wrote no selection').toEqual(before.selection);
    expect(after.emphasis, 'the superseded commit wrote no emphasis').toEqual(before.emphasis);
  });

  test('the mobile Brief sheet activating during the hold (a resize to phone width, no view-mode change) wins: nothing paints or reaches the panel sink', async ({
    page
  }) => {
    const gate = await gateFrameChunk(page, 'hold');
    await bootModelTarget(page, '?region=washington_state&view=brief&layers=bia-reservations', [{ model: PLACE_MODEL, place: true }]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    expect(await page.locator('#app').getAttribute('data-sheet-detent'), 'the desktop shell: no mobile sheet yet').toBeNull();
    const before = await readLog(page);

    await clickUntilAnswered(page, centre, 1);
    expect((await readLog(page)).paints, 'nothing paints while the chunk is held').toEqual([]);
    // The real sheet: its (max-width: 720px) media query activates it on the
    // resize; nothing changes the view mode, so no view-mode listener runs.
    const height = page.viewportSize()?.height ?? 800;
    await page.setViewportSize({ width: 600, height });
    await expect(page.locator('#app'), 'the mobile Brief sheet activated').toHaveAttribute('data-sheet-detent', /\S/);

    gate.release();
    await frameSettled(page, url);
    const after = await readLog(page);
    expect(after.paints, 'the commit the sheet superseded never paints nor reaches the panel sink').toEqual([]);
    expect(after.selection, 'the superseded commit wrote no selection').toEqual(before.selection);
    expect(after.emphasis, 'the superseded commit wrote no emphasis').toEqual(before.emphasis);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
  });

  // S30D P1-FRAME repair round 2 (2026-10-04): the activation is remembered,
  // not only checked when the wait ends.
  test('the mobile Brief sheet activating and deactivating again during the hold (a resize to phone width and back) still wins: nothing paints or reaches the panel sink', async ({
    page
  }) => {
    const gate = await gateFrameChunk(page, 'hold');
    await bootModelTarget(page, '?region=washington_state&view=brief&layers=bia-reservations', [{ model: PLACE_MODEL, place: true }]);
    const url = await warmed(gate);
    const centre = await mapPoint(page, 0.5, 0.5);
    const desktop = page.viewportSize() ?? { width: 1280, height: 800 };
    expect(await page.locator('#app').getAttribute('data-sheet-detent'), 'the desktop shell: no mobile sheet yet').toBeNull();
    const before = await readLog(page);

    await clickUntilAnswered(page, centre, 1);
    expect((await readLog(page)).paints, 'nothing paints while the chunk is held').toEqual([]);
    // The real sheet both ways: its (max-width: 720px) media query activates
    // it on the narrow resize and deactivates it on the way back, so when the
    // wait ends the sheet is inactive again, exactly as at the click.
    await page.setViewportSize({ width: 600, height: desktop.height });
    await expect(page.locator('#app'), 'the mobile Brief sheet activated').toHaveAttribute('data-sheet-detent', /\S/);
    await page.setViewportSize(desktop);
    await expect(page.locator('#app'), 'the mobile Brief sheet deactivated again').not.toHaveAttribute('data-sheet-detent');

    gate.release();
    await frameSettled(page, url);
    const after = await readLog(page);
    expect(after.paints, 'the commit the transient sheet superseded never paints nor reaches the panel sink').toEqual([]);
    expect(after.selection, 'the superseded commit wrote no selection').toEqual(before.selection);
    expect(after.emphasis, 'the superseded commit wrote no emphasis').toEqual(before.emphasis);
    await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
    await expect(page.locator('#panel-response .coordinated-response')).toHaveCount(0);
  });
});
