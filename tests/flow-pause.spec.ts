import { expect, test, type Locator, type Page } from '@playwright/test';
import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { gotoApp } from './helpers';

/*
 * E1-4 MOTION-PAUSE (ENSO-FLOW-PLAN.md section 3, block E1; C-fit.md 1.8).
 * The flowing paths start on their own and run longer than 5 s beside other
 * content, so WCAG 2.2.2 needs a pause reachable without opening anything:
 * one persistent native button in the map key's collapsed header, beside
 * the key's own toggle, with a constant name and aria-pressed.
 *
 * Nothing publishes the snapshot's `motion` field until E2-1 wires the
 * paths, so these cases drive the key with a synthetic
 * `ddm:enso-flow-snapshot` event (the plan's E1-4 amendment), in exactly the
 * shape P3-ENSOKEY's src/layers/enso-flow.ts publishes plus the two fields
 * this unit adds. The loop cases bundle src/layers/flow/motion-loop.ts on
 * the fly (no caller in dist/ imports flow/ yet) and wire it to the key the
 * way E2-1 will: its state goes out as the snapshot's `motion`, and the
 * button's request comes back through its own listener.
 */

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FLOW_ROUTE = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\/v1\//;
const SNAPSHOT_EVENT = 'ddm:enso-flow-snapshot';
const REQUEST_EVENT = 'ddm:enso-flow-motion-request';
const PAUSE_NAME = 'Pause motion';
const PROVENANCE = 'derived from NOAA GFS';
/** A synthetic live frame, in P3-ENSOKEY's detail shape. Test data, not app text. */
const BASE = {
  status: 'live',
  label: 'Atmospheric currents',
  line: 'live · Model valid Oct 5, 6:00 AM UTC',
  notes: ['Synthetic snapshot for the Pause spec.'],
  provenance: PROVENANCE
} as const;

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  // No case here asks for the sampled arrows; a stray read fails loudly.
  await page.route(FLOW_ROUTE, (route) => route.abort('blockedbyclient'));
}

/** Boot ENSO with the arrows off, so only the synthetic snapshots speak. */
async function bootEnso(page: Page, query = ''): Promise<void> {
  await stubSst(page);
  await gotoApp(page, `?cluster=enso&ocean=pacific${query}`);
  await expect(page.locator('.enso-flow')).toHaveAttribute('data-status', 'off');
  await expect(page.locator('#map-key-details-toggle')).toBeVisible();
}

async function publish(page: Page, extra: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ name, detail }) => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }, { name: SNAPSHOT_EVENT, detail: { ...BASE, ...extra } });
}

function pauseButton(page: Page): Locator {
  return page.locator('#map-key').getByRole('button', { name: PAUSE_NAME });
}

/** Answer each request the way E2-1's loop will: republish with the asked state. */
async function respondToRequests(page: Page): Promise<void> {
  await page.evaluate(({ request, snapshot, base }) => {
    const w = window as unknown as { __pauseRequests: boolean[] };
    w.__pauseRequests = [];
    window.addEventListener(request, (event) => {
      const paused = Boolean((event as CustomEvent<{ paused: boolean }>).detail?.paused);
      w.__pauseRequests.push(paused);
      window.dispatchEvent(new CustomEvent(snapshot, { detail: { ...base, motion: paused ? 'paused' : 'moving' } }));
    });
  }, { request: REQUEST_EVENT, snapshot: SNAPSHOT_EVENT, base: BASE });
}

async function requests(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __pauseRequests: boolean[] }).__pauseRequests);
}

/** Tag the node so a later read can tell whether it is the same element. */
async function tag(button: Locator): Promise<void> {
  await button.evaluate((node) => { (node as unknown as { __flowPauseTag: number }).__flowPauseTag = 1; });
}

async function focusedIsTagged(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.activeElement as unknown as { __flowPauseTag?: number } | null)?.__flowPauseTag === 1);
}

let motionLoopBundle: string | null = null;

/** src/layers/flow/motion-loop.ts as one script exposing `window.__ddmFlowMotion`. */
async function motionLoopScript(): Promise<string> {
  if (motionLoopBundle) return motionLoopBundle;
  const input = fileURLToPath(new URL('../src/layers/flow/motion-loop.ts', import.meta.url));
  const out = await build({ input, write: false, logLevel: 'silent', output: { format: 'iife', name: '__ddmFlowMotion' } });
  motionLoopBundle = out.output[0].code;
  return motionLoopBundle;
}

interface Harness {
  readonly repaints: number;
  readonly stoppedAt: number | null;
  readonly resumes: number;
  readonly motion: string;
  setSst(playing: boolean): void;
  setHidden(hidden: boolean): void;
  frames(count: number): Promise<number>;
}

/**
 * The real motion loop over a stand-in map (a counting `triggerRepaint`, the
 * app's own map container and a detached canvas) and a stand-in SST clock.
 * Every state change goes out as the snapshot's `motion`, as E2-1 will.
 */
async function installLoop(page: Page): Promise<void> {
  await page.addScriptTag({ content: await motionLoopScript() });
  await page.evaluate(({ snapshot, base }) => {
    type Loop = { readonly motion: string };
    const lib = (window as unknown as {
      __ddmFlowMotion: {
        createMotionLoop(options: Record<string, unknown>): Loop;
        listenMotionRequests(loop: Loop): () => void;
      };
    }).__ddmFlowMotion;
    const canvas = document.createElement('canvas');
    const container = document.getElementById('map')!;
    let repaints = 0;
    let stoppedAt: number | null = null;
    let resumes = 0;
    let playing = false;
    let hidden = false;
    const sstListeners = new Set<() => void>();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    const loop = lib.createMotionLoop({
      map: { triggerRepaint: () => { repaints += 1; }, getCanvas: () => canvas, getContainer: () => container },
      sst: { playing: () => playing, subscribe: (fn: () => void) => { sstListeners.add(fn); return () => sstListeners.delete(fn); } },
      onResume: () => { resumes += 1; },
      onChange: (motion: string) => {
        stoppedAt = motion === 'moving' ? null : repaints;
        window.dispatchEvent(new CustomEvent(snapshot, { detail: { ...base, motion } }));
      }
    });
    lib.listenMotionRequests(loop);
    const harness: Harness = {
      get repaints() { return repaints; },
      get stoppedAt() { return stoppedAt; },
      get resumes() { return resumes; },
      get motion() { return loop.motion; },
      setSst(next) { playing = next; for (const fn of [...sstListeners]) fn(); },
      setHidden(next) { hidden = next; document.dispatchEvent(new Event('visibilitychange')); },
      frames(count) {
        // Display frames, never a timer: counts repaints over `count` frames.
        const from = repaints;
        return new Promise((resolve) => {
          let left = count;
          const tick = (): void => { left -= 1; if (left <= 0) resolve(repaints - from); else requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
      }
    };
    (window as unknown as { __flowHarness: Harness }).__flowHarness = harness;
  }, { snapshot: SNAPSHOT_EVENT, base: BASE });
}

async function harness<T>(page: Page, read: (h: Harness) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__flowHarness)`) as Promise<T>;
}

test.describe('E1-4 Pause motion in the map key header', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Pause motion is one native button in the key\'s collapsed header with a constant name and aria-pressed', async ({ page }) => {
    await bootEnso(page);
    await publish(page, { motion: 'moving' });
    const button = pauseButton(page);
    await expect(button).toHaveCount(1);
    await expect(button).toBeVisible();
    // Collapsed: the drawer stays shut and the button still shows.
    await expect(page.locator('#map-key-content')).toBeHidden();
    const shape = await button.evaluate((node) => ({
      tag: node.tagName,
      type: node.getAttribute('type'),
      parentId: node.parentElement?.id ?? null,
      afterToggle: node.previousElementSibling?.id ?? null,
      inLegend: Boolean(node.closest('#map-key-legend')),
      inDrawer: Boolean(node.closest('#map-key-content'))
    }));
    expect(shape).toEqual({ tag: 'BUTTON', type: 'button', parentId: 'map-key', afterToggle: 'map-key-details-toggle', inLegend: false, inDrawer: false });
    await expect(page.locator('#map-key button[aria-pressed]')).toHaveCount(1);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await publish(page, { motion: 'paused' });
    await expect(pauseButton(page)).toHaveAttribute('aria-pressed', 'true');
    await publish(page, { motion: 'reduced' });
    await expect(pauseButton(page)).toHaveAttribute('aria-pressed', 'true');
    await publish(page, { motion: 'held' });
    await expect(pauseButton(page)).toHaveAttribute('aria-pressed', 'false');
    // The name never changes with the state (APG button pattern).
    await expect(page.locator('#map-key').getByRole('button', { name: /Play/ })).toHaveCount(0);
    // The time bar's own Pause and Play drive the SST days, not this.
    await expect(button).not.toHaveAccessibleName('Pause');
  });

  test('Enter and Space toggle it; focus stays on the same node across key updates', async ({ page }) => {
    await bootEnso(page);
    await respondToRequests(page);
    await publish(page, { motion: 'moving' });
    const button = pauseButton(page);
    await expect(button).toBeVisible();
    await tag(button);
    // It sits in the Tab order right after the chip.
    await page.locator('#map-key-details-toggle').focus();
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await requests(page)).toEqual([true]);
    expect(await focusedIsTagged(page)).toBe(true);
    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await requests(page)).toEqual([true, false]);
    expect(await focusedIsTagged(page)).toBe(true);
    // A key update that rewrites the legend leaves the button node alone.
    await publish(page, { motion: 'moving', line: 'live · Model valid Oct 5, 9:00 AM UTC' });
    await expect(page.locator('#map-key')).toHaveAttribute('aria-label', /Model valid Oct 5, 9:00 AM UTC/);
    await expect(button).toBeFocused();
    expect(await focusedIsTagged(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await focusedIsTagged(page)).toBe(true);
  });

  test('Escape still closes the drawer', async ({ page }) => {
    await bootEnso(page);
    await respondToRequests(page);
    await publish(page, { motion: 'moving' });
    const toggle = page.locator('#map-key-details-toggle');
    await toggle.click();
    await expect(page.locator('#map-key-content')).toBeVisible();
    const button = pauseButton(page);
    await button.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#map-key-content')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Escape is never a pause request.
    expect(await requests(page)).toEqual([]);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  test('the target is at least 24x24 CSS px', async ({ page }) => {
    await bootEnso(page);
    await publish(page, { motion: 'moving' });
    const box = (await pauseButton(page).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeGreaterThanOrEqual(24);
  });

  for (const surface of [
    { name: 'the desktop chip', width: 1280, height: 800, query: '' },
    { name: 'the phone top bar', width: 390, height: 844, query: '' },
    { name: 'the embed dock', width: 1280, height: 800, query: '&embed=true' }
  ] as const) {
    test(`it is reachable in the desktop chip, the phone top bar and the embed dock: ${surface.name}`, async ({ page }) => {
      await page.setViewportSize({ width: surface.width, height: surface.height });
      await bootEnso(page, surface.query);
      await publish(page, { motion: 'moving' });
      const button = pauseButton(page);
      await expect(button).toBeVisible();
      await expect(button).toBeInViewport();
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      // Nothing covers it: the topmost node at its centre is the button.
      const hit = await page.evaluate(({ x, y }) => {
        const node = document.elementFromPoint(x, y);
        return Boolean(node?.closest('#map-key button[aria-pressed]'));
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      expect(hit).toBe(true);
      // No overlap with the key toggle beside it.
      const toggle = (await page.locator('#map-key-details-toggle').boundingBox())!;
      const overlaps = box.x < toggle.x + toggle.width && toggle.x < box.x + box.width &&
        box.y < toggle.y + toggle.height && toggle.y < box.y + box.height;
      expect(overlaps).toBe(false);
      await page.locator('#map-key-details-toggle').focus();
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
    });
  }

  test('under emulated reduced motion it starts pressed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootEnso(page);
    await installLoop(page);
    const button = pauseButton(page);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await harness(page, (h) => h.motion)).toBe('reduced');
    expect(await harness(page, (h) => h.frames(30))).toBe(0);
    // An explicit Play is honoured as the viewer's choice.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await harness(page, (h) => h.motion)).toBe('moving');
    expect(await harness(page, (h) => h.frames(30))).toBeGreaterThan(0);
  });

  test('the loop stops within one frame of Pause, hidden or SST play', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await bootEnso(page);
    await installLoop(page);
    const button = pauseButton(page);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    // Running, and capped at 30 Hz: never more than one repaint per 1/30 s.
    const first = await harness(page, (h) => h.frames(60));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(32);

    // Pause, by keyboard.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await harness(page, (h) => h.motion)).toBe('paused');
    expect(await harness(page, async (h) => { const at = h.stoppedAt!; await h.frames(30); return h.repaints - at; })).toBe(0);
    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await harness(page, (h) => h.frames(30))).toBeGreaterThan(0);
    expect(await harness(page, (h) => h.resumes)).toBe(1);

    // A hidden document.
    await harness(page, (h) => h.setHidden(true));
    expect(await harness(page, (h) => h.motion)).toBe('held');
    expect(await harness(page, async (h) => { const at = h.stoppedAt!; await h.frames(30); return h.repaints - at; })).toBe(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await harness(page, (h) => h.setHidden(false));
    expect(await harness(page, (h) => h.frames(30))).toBeGreaterThan(0);
    expect(await harness(page, (h) => h.resumes)).toBe(2);

    // The SST days playing: one clock moves at a time.
    await harness(page, (h) => h.setSst(true));
    expect(await harness(page, (h) => h.motion)).toBe('held');
    expect(await harness(page, async (h) => { const at = h.stoppedAt!; await h.frames(30); return h.repaints - at; })).toBe(0);
    // The button still works while the SST days play, and a pause outlasts them.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await harness(page, (h) => h.setSst(false));
    expect(await harness(page, (h) => h.motion)).toBe('paused');
    expect(await harness(page, (h) => h.frames(30))).toBe(0);
  });

  test('the provenance item reads derived from NOAA GFS as text, with no image', async ({ page }) => {
    await bootEnso(page);
    await publish(page, { motion: 'moving' });
    await page.locator('#map-key-details-toggle').click();
    const item = page.locator('#map-key [data-enso-flow="provenance"]');
    await expect(item).toBeVisible();
    await expect(item).toHaveText(PROVENANCE);
    const look = await item.evaluate((node) => ({
      media: node.querySelectorAll('img, svg, picture, canvas, object, embed').length,
      background: getComputedStyle(node).backgroundImage,
      before: getComputedStyle(node, '::before').backgroundImage,
      after: getComputedStyle(node, '::after').backgroundImage
    }));
    expect(look).toEqual({ media: 0, background: 'none', before: 'none', after: 'none' });
    // After the status row, and in the key's accessible name.
    const order = await page.locator('#map-key [data-enso-flow]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-enso-flow')));
    expect(order.indexOf('provenance')).toBeGreaterThan(order.indexOf('status'));
    await expect(page.locator('#map-key')).toHaveAttribute('aria-label', new RegExp(`${PROVENANCE}\\.`));
  });

  test('with no motion field in the snapshot the button is absent', async ({ page }) => {
    await bootEnso(page);
    await publish(page, { motion: undefined });
    await expect(page.locator('#map-key [data-enso-flow="status"]')).toHaveCount(1);
    await expect(pauseButton(page)).toHaveCount(0);
    await expect(page.locator('#map-key button[aria-pressed]')).toBeHidden();
    // It appears once motion is reported, and leaves again with it.
    await publish(page, { motion: 'moving' });
    await expect(pauseButton(page)).toBeVisible();
    await publish(page, { motion: 'none' });
    await expect(pauseButton(page)).toHaveCount(0);
    await publish(page, { motion: 'moving' });
    await expect(pauseButton(page)).toBeVisible();
    await publish(page, { status: 'inactive', label: '', line: '', notes: [], provenance: undefined, motion: undefined });
    await expect(pauseButton(page)).toHaveCount(0);
  });
});
