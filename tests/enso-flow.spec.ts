import { readFileSync } from 'node:fs';

import { continueLocalRoute } from './offline-test';
import { expect, test, type Locator, type Page, type Route } from './offline-test';
import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { FLOW_WORDS } from '../src/layers/enso-flow-data';
import { gotoApp, layerCheckbox, noddStubLog, search } from './helpers';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const NODD_ROUTE = /^https:\/\/noaa-gfs-bdp-pds\.s3\.amazonaws\.com\//;
/**
 * ENSO-FLOW-PLAN E2-1: wind and waves read NOAA NODD, answered by
 * tests/helpers.ts from the 2026-10-05 06Z f006 fixtures. A case that turns
 * either on fixes the page clock here, where the reader asks for exactly that
 * frame (candidate cycle 06Z, forecast hour 6 for both kinds).
 */
const LIVE_CLOCK = Date.UTC(2026, 9, 5, 12, 30);
/**
 * Ocean currents read the committed NOAA RTOFS frame, a file of the app's own
 * origin that the preview serves (public/data/rtofs-surface-currents*;
 * admission rtofs-currents-producer). A landing replaces the frame, so its run
 * and valid instant are read from the committed header, never typed here; a
 * case that reads the frame's age fixes the page clock three and a half days
 * after its valid instant, where the line ends "frame 3 days old".
 */
const CURRENTS_HEADER = /\/data\/rtofs-surface-currents\.json(?:\?|$)/;
const CURRENTS_FRAME = /\/data\/rtofs-surface-currents[^/]*$/;
const FRAME = JSON.parse(readFileSync(new URL('../public/data/rtofs-surface-currents.json', import.meta.url), 'utf8')) as {
  readonly run: string; readonly valid: string; readonly grids: readonly { readonly file: string }[];
};
const FRAME_RUN = Date.parse(FRAME.run);
const FRAME_VALID = Date.parse(FRAME.valid);
const FRAME_CLOCK = FRAME_VALID + 3.5 * 24 * 3_600_000;
const FRAME_AGE = 'frame 3 days old';

for (const width of [1440, 721, 720, 390]) {
  test(`D3 neutral flow controls retain keyboard selection and fit at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(LIVE_CLOCK);
    await stubSst(page);
    await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=off');
    if (width <= 720) await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
    const panel = page.locator('.enso-flow');
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return ['--accent', '--accent-strong', '--accent-soft', '--warn', '--good', '--danger'].map((name, index) => {
        const value = css.getPropertyValue(name).trim();
        if (index >= 3) return value;
        // Compare resolved colors, not the minifier's equivalent hex/RGBA spelling.
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      });
    })).toEqual(['rgb(255, 255, 255)', 'rgb(232, 236, 240)', 'rgba(255, 255, 255, 0.08)', '', '', '']);
    const off = panel.locator('[data-flow-kind="off"]');
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(off).toHaveCSS('background-color', 'rgb(42, 49, 56)');
    await expect(off).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(off).toHaveCSS('font-weight', '700');
    await expect(off).toHaveCSS('border-radius', width > 720 ? '0px' : '4px');
    await page.keyboard.press('Tab');
    await off.focus();
    await expect(off).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
    await expect(off).toHaveCSS('outline-width', '2px');
    await expect(off).toHaveCSS('outline-offset', '0px');
    await expect(off).toHaveCSS('box-shadow', /rgb\(1, 11, 19\) 0px 0px 0px 4px/);
    await expect(off).toHaveCSS('box-shadow', /inset/);
    await page.keyboard.press('Space');
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toHaveAttribute('data-status', 'off');
    // Off draws nothing, so it credits nothing; no kind's credit is a link (tests/flow-wire.spec.ts).
    await expect(panel.locator('a[href]')).toHaveCount(0);
    expect(new URLSearchParams(await search(page)).get('flow')).toBe('off');
    const fits = await panel.evaluate(node => [...node.querySelectorAll('button, select')].every(control => {
      const element = control as HTMLElement;
      const seat = element.getBoundingClientRect();
      return seat.left >= 0 && seat.right <= innerWidth && element.scrollWidth <= element.clientWidth;
    }));
    expect(fits).toBe(true);
    if (width <= 720) {
      const rail = page.locator('#mobile-footer-nav button[data-tab="layers"]');
      await expect(rail).toHaveCSS('background-color', 'rgba(1, 11, 19, 0.86)');
      await expect(rail).toHaveCSS('border-radius', '4px');
      await rail.focus();
      await expect(rail).toHaveCSS('outline-offset', '0px');
      await expect(rail).toHaveCSS('box-shadow', /rgb\(1, 11, 19\) 0px 0px 0px 4px/);
    }
  });
}

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

test('all three ENSO overlays remain bounded, independently timed, and preserve color through reload', async ({ page }) => {
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  // Every read of the committed currents frame (its header and its grid files).
  const calls: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (CURRENTS_FRAME.test(url.pathname)) calls.push(url);
  });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default');
  const panel = page.locator('.enso-flow');
  await expect(panel).toBeVisible();
  // The ENSO boot reads flow iff the cluster's flowDefault is set (E2-4 sets it;
  // read from the cluster definition, never a literal of this case).
  const flowDefault = Object.values(HAZARD_CLUSTERS).find((def) => def.urlToken === 'enso')?.flowDefault;
  expect(noddStubLog(page).length > 0, `NODD reads at an ENSO boot with flowDefault ${flowDefault ?? 'unset'}`)
    .toBe(flowDefault !== undefined && flowDefault !== 'currents');
  expect(calls.length > 0, 'the currents frame is read at boot only where currents are the default').toBe(flowDefault === 'currents');
  const before = calls.length;
  for (const kind of ['currents', 'wind', 'jet', 'pwat', 'waves']) {
    await panel.locator(`[data-flow-kind="${kind}"]`).click();
    // The wave crop ends at 165 E and 100 W, and the currents grid at 39 N and 130 E, inside this Pacific view's edges.
    await expect(panel).toHaveAttribute('data-status', kind === 'waves' || kind === 'currents' ? /^live/ : 'live');
    await expect(panel.locator('.enso-flow-status')).toContainText('Model valid');
    // Wind is ENSO's default since E2-4, written as the absence of the key.
    expect(new URLSearchParams(await search(page)).get('flow')).toBe(kind === 'wind' ? null : kind);
  }
  // Only ocean currents read the committed frame: its header and its grid files, once each, from the
  // app's own origin. Wind, jet-level wind, precipitable water and waves read the NODD fixtures.
  const origin = new URL(page.url()).origin;
  expect(calls.slice(before).map((url) => url.origin)).toEqual(FRAME.grids.map(() => origin).concat(origin));
  expect(calls.slice(before).map((url) => url.pathname.split('/').pop()).sort())
    .toEqual(['rtofs-surface-currents.json', ...FRAME.grids.map((grid) => grid.file)].sort());
  expect(noddStubLog(page).every((entry) => entry.answer === 'fixture')).toBe(true);
  await panel.getByLabel('Direction arrow color').selectOption('dark');
  expect(new URLSearchParams(await search(page)).get('flowink')).toBe('dark');
  await page.reload();
  await expect(panel.locator('[data-flow-kind="waves"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await expect(panel).toHaveAttribute('data-status', /^live/);
  await page.locator('.view-switch [data-view="console"]').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await panel.locator('summary').click();
  await expect(panel).toContainText('independently timed from the observed SST map');
  await panel.locator('[data-flow-kind="off"]').click();
  await expect(panel).toHaveAttribute('data-status', 'off');
  // Off is written beside ENSO's wind default so the link keeps meaning off (E2-4).
  expect(new URLSearchParams(await search(page)).get('flow')).toBe('off');
});

test('turning an ENSO overlay off aborts its held request and drops the late response', async ({ page }) => {
  await stubSst(page);
  let held: Route | null = null;
  await page.route(CURRENTS_HEADER, (route) => { held = route; });
  // flow=off: the boot reads nothing, so the only held request is the currents one below (ENSO opens with wind since E2-4).
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=off');
  const panel = page.locator('.enso-flow');
  // Ocean currents: the read of the committed frame's header is held open (wind and
  // waves: tests/flow-wire.spec.ts "off intent aborts every range").
  await panel.locator('[data-flow-kind="currents"]').click();
  await expect.poll(() => held !== null).toBe(true);
  const failed = page.waitForEvent('requestfailed', (req) => CURRENTS_HEADER.test(req.url()));
  await panel.locator('[data-flow-kind="off"]').click();
  await failed;
  await expect(panel).toHaveAttribute('data-status', 'off');
  await continueLocalRoute(held!).catch(() => undefined);
  await expect(panel.locator('.enso-flow-status')).toHaveText('Overlay off');
  expect(new URLSearchParams(await search(page)).get('flow')).toBe('off');
});

test('marine no-data and network failure remain separate from a successful direction field', async ({ page }) => {
  await stubSst(page);
  // Utah, framed by the state deep link: inland, so no node of the currents grid under the view holds a value.
  await gotoApp(page, '?cluster=enso&select=state:UT&flow=currents');
  const panel = page.locator('.enso-flow');
  await expect(panel).toHaveAttribute('data-status', 'no data');
  await expect(panel.locator('.enso-flow-status')).toHaveText(/^no data · /);
  await expect(panel.locator('.enso-flow-status')).not.toContainText(/calm|did not load/i);
  // Waves read NOAA NODD now (ENSO-FLOW-PLAN E2-1): the network failure is the bucket's.
  await page.route(NODD_ROUTE, (route) => route.abort('failed'));
  await panel.locator('[data-flow-kind="waves"]').click();
  await expect(panel).toHaveAttribute('data-status', 'unavailable');
  await expect(panel).toContainText('No direction or calm condition is inferred');
});

test('the same ENSO controls move into the mobile Layers glass panel and return to desktop', async ({ page }) => {
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  await page.setViewportSize({ width: 721, height: 844 });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=wind&flowink=dark');
  await expect(page.locator('.sidebar-scroll > #enso-flow-controls .enso-flow')).toBeVisible();
  await page.setViewportSize({ width: 720, height: 844 });
  await page.locator('#mobile-footer-nav button[data-tab="layers"]').click();
  const mobilePanel = page.locator('#sheet-enso-flow-host .enso-flow');
  await expect(mobilePanel).toBeVisible();
  await expect(mobilePanel.getByLabel('Direction arrow color')).toHaveValue('dark');
  await expect(page.locator('#enso-flow-controls')).toHaveCount(1);
  await page.setViewportSize({ width: 721, height: 844 });
  await expect(page.locator('.sidebar-scroll > #enso-flow-controls .enso-flow')).toBeVisible();
  await expect(page.locator('#sheet-enso-flow-host')).toBeEmpty();
  await expect(page.locator('.enso-flow [data-flow-kind="wind"]')).toHaveAttribute('aria-pressed', 'true');
});

/*
 * found-115 (DR-188, P3-ENSOKEY): the arrows draw wherever `flow=` and the
 * SST layer are on, but their panel lives in the sidebar, which a desktop
 * embed and a closed sidebar hide, and which a phone shows only in the
 * Layers sheet. The Key drawer carries their own status, model valid time
 * and qualifications as one more row of the SST key. Every case below
 * first reads `[data-enso-flow="status"]`, so on code without the row it
 * fails on that missing node, never on a stub or a selector of its own.
 * These cases ride ocean currents, whose frame needs no stub and no fixed
 * NODD clock; the wind and wave rows are tests/flow-wire.spec.ts's.
 */
const FLOW_ROW = '#map-key [data-enso-flow]';

function flowStatus(page: Page): Locator {
  return page.locator('#map-key [data-enso-flow="status"]');
}

function flowNotes(page: Page): Locator {
  return page.locator('#map-key [data-enso-flow="notes"]');
}

/** The key's own toggle is the chip for the SST key on every surface. */
async function openKeyDrawer(page: Page): Promise<void> {
  const toggle = page.locator('#map-key-details-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.locator('#map-key-content')).toBeVisible();
  await expect(page.locator('#map-key [data-sst-anomaly-key]')).toBeVisible();
}

/** A dated instant in the page's own Intl, the panel's own format. */
async function pageDate(page: Page, time: number): Promise<string> {
  return page.evaluate((ms) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(ms), time);
}

/** The currents frame's dated words after its state: run, valid instant and age, at a page clock of FRAME_CLOCK. */
async function frameWords(page: Page): Promise<string> {
  return `Model run ${await pageDate(page, FRAME_RUN)} · Model valid ${await pageDate(page, FRAME_VALID)} · ${FRAME_AGE}`;
}

/** `text`, as a pattern that takes either live state: the Pacific view may or may not run past the grid under it. */
function eitherLive(text: string): RegExp {
  const quoted = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${quoted.replace('LIVE', 'live(?: \\(partial\\))?')}$`);
}

const DRAWER_SURFACES = [
  { name: 'a desktop embed', width: 1280, height: 800, query: '&embed=true' },
  { name: 'the desktop shell with the sidebar closed', width: 1280, height: 800, query: '&sidebar=closed' },
  { name: 'a 390x844 phone with the Layers sheet not showing', width: 390, height: 844, query: '' },
  { name: 'a 390x844 phone embed', width: 390, height: 844, query: '&embed=true' }
] as const;

for (const surface of DRAWER_SURFACES) {
  test(`found-115 ${surface.name}: the Key drawer reads the currents' own status, model run, valid time and age, apart from the SST date`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await page.clock.setFixedTime(FRAME_CLOCK);
    await stubSst(page);
    await gotoApp(page, `?cluster=enso&ocean=pacific&flow=currents${surface.query}`);
    // The defect's premise: the paths load while their own panel is off screen.
    const panel = page.locator('.enso-flow');
    await expect(panel).toHaveAttribute('data-status', /^live/);
    await expect(panel).toBeHidden();
    await openKeyDrawer(page);
    await expect(flowStatus(page)).toBeVisible();
    // A dated frame: its run, its valid instant and its age, and no word for the present.
    await expect(flowStatus(page)).toHaveText(eitherLive(`Ocean currents · LIVE · ${await frameWords(page)}`));
    await expect(flowNotes(page)).toBeVisible();
    await expect(flowNotes(page)).toContainText(FLOW_WORDS.bins.currents);
    await expect(page.locator('#map-key [data-enso-flow="provenance"]')).toHaveText(FLOW_WORDS.currentsProvenance);
    // The key keeps the bins and the state; the explanations and the disclaimer read in the Impact Briefing.
    await expect(flowNotes(page)).not.toContainText('independently timed');
    await expect(flowNotes(page)).not.toContainText('Not for navigation');
    // Two products, two clocks: the SST date keeps its own node and words.
    const observed = page.locator('#map-key [data-sst-observed]');
    await expect(observed).toContainText('Observed');
    await expect(observed).not.toContainText('Model valid');
    await expect(flowStatus(page)).not.toContainText('Observed');
    await expect(flowNotes(page)).not.toContainText('Observed');
  });
}

type FlowAnnouncement = { id: string; text: string; exposed: boolean };
type AnnouncementWindow = Window & { __flowAnnouncements: FlowAnnouncement[] };

/** Observe real live-region writes from boot, including while both visual readers are hidden. */
async function watchFlowAnnouncements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const entries: FlowAnnouncement[] = [];
    (window as unknown as AnnouncementWindow).__flowAnnouncements = entries;
    const exposed = (region: Element): boolean => {
      if (region.getAttribute('aria-live') === 'off') return false;
      for (let node: Element | null = region; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      // Clipping a sr-only live region does not remove it from the accessibility tree.
      return true;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const region = target?.closest('[role="status"], [aria-live="polite"], [aria-live="assertive"]');
        if (!region) continue;
        const text = record.type === 'characterData' ? record.target.textContent ?? ''
          : Array.from(record.addedNodes, (node) => node.textContent ?? '').join('');
        if (text) entries.push({ id: region.id || region.className, text, exposed: exposed(region) });
      }
    }).observe(document, { childList: true, characterData: true, subtree: true });
  });
}

async function flowAnnouncements(page: Page, line: string): Promise<FlowAnnouncement[]> {
  return page.evaluate((text) => (window as unknown as AnnouncementWindow).__flowAnnouncements.filter((entry) =>
    entry.text === text || entry.text === `Ocean currents · ${text}`), line);
}

const ANNOUNCEMENT_SURFACES = [
  { name: 'the open desktop shell', width: 1280, height: 800, query: '', panelVisible: true },
  ...DRAWER_SURFACES.map((surface) => ({ ...surface, panelVisible: false }))
];

for (const surface of ANNOUNCEMENT_SURFACES) {
  for (const outcome of ['live', 'unavailable'] as const) {
    test(`found-141 ${surface.name}: loading and ${outcome} use one exposed announcement route`, async ({ page }) => {
      await page.setViewportSize({ width: surface.width, height: surface.height });
      await page.clock.setFixedTime(FRAME_CLOCK);
      await watchFlowAnnouncements(page);
      await stubSst(page);
      // The read of the committed frame's header is held open, then let through or failed.
      let held: Route | null = null;
      await page.route(CURRENTS_HEADER, (route) => { held = route; });
      await gotoApp(page, `?cluster=enso&ocean=pacific&flow=currents&basemap=default${surface.query}`);
      await expect.poll(() => held !== null).toBe(true);
      const panel = page.locator('.enso-flow');
      await expect(panel).toHaveAttribute('data-status', 'loading');
      if (surface.panelVisible) await expect(panel).toBeVisible();
      else await expect(panel).toBeHidden();
      await expect(page.locator('#map-key-content')).toBeHidden();

      const loading = `loading · ${FLOW_WORDS.loading.currents}`;
      await expect.poll(async () => (await flowAnnouncements(page, loading)).length).toBeGreaterThan(0);
      expect.soft(await flowAnnouncements(page, loading)).toEqual([
        { id: 'layer-status-live', text: `Ocean currents · ${loading}`, exposed: true }
      ]);
      // Even an open panel and a subsequently opened Key are plain readers of the same state.
      expect.soft(await panel.locator('.enso-flow-status').getAttribute('role')).toBeNull();
      expect.soft(await panel.locator('.enso-flow-status').getAttribute('aria-live')).toBeNull();

      if (outcome === 'live') await continueLocalRoute(held!);
      else await held!.abort('failed');
      // The view has settled by now (the read was held through the boot), so the live state is the final one:
      // live, or live (partial) where the Pacific view runs past the grid under it.
      await expect(panel).toHaveAttribute('data-status', outcome === 'live' ? /^live/ : 'unavailable');
      const terminal = outcome === 'live' ? `${await panel.getAttribute('data-status')} · ${await frameWords(page)}`
        : `unavailable · ${FLOW_WORDS.unavailable.currents}`;
      await expect(panel.locator('.enso-flow-status')).toHaveText(terminal);
      await expect.poll(async () => (await flowAnnouncements(page, terminal)).length).toBeGreaterThan(0);
      expect.soft(await flowAnnouncements(page, terminal)).toEqual([
        { id: 'layer-status-live', text: `Ocean currents · ${terminal}`, exposed: true }
      ]);
      await openKeyDrawer(page);
      await expect(flowStatus(page)).toHaveText(`Ocean currents · ${terminal}`);
      expect.soft(await flowStatus(page).getAttribute('role')).toBeNull();
      expect.soft(await flowStatus(page).getAttribute('aria-live')).toBeNull();
      // Opening the visual reader must not replay either announcement.
      expect.soft(await flowAnnouncements(page, loading)).toHaveLength(1);
      expect.soft(await flowAnnouncements(page, terminal)).toHaveLength(1);
      // Keep the text diagnostic in reporter stdout without an artifact attachment.
      console.log('[flow-announcement-routes]', JSON.stringify({ surface, outcome,
        loading: await flowAnnouncements(page, loading), terminal: await flowAnnouncements(page, terminal)
      }, null, 2));
    });
  }
}

test('found-115 a Key that starts after the arrows have loaded still reads their state (a boot with flow= in the URL)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(FRAME_CLOCK);
  await stubSst(page);
  // The key is a lazy chunk; hold it until the arrows are live, so no
  // status change of theirs can reach it as it happens.
  let release!: () => void;
  const arrowsLive = new Promise<void>((resolve) => { release = resolve; });
  let keyRequested = false;
  await page.route(/\/assets\/map-key-[^/?]+\.js(?:\?|$)/, async (route) => {
    keyRequested = true;
    await arrowsLive;
    await continueLocalRoute(route);
  });
  await gotoApp(page, '?cluster=enso&ocean=pacific&flow=currents&embed=true');
  await expect(page.locator('.enso-flow')).toHaveAttribute('data-status', /^live/);
  await expect.poll(() => keyRequested).toBe(true);
  await expect(page.locator('#map-key-details-toggle')).toHaveCount(0);
  release();
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toHaveText(eitherLive(`Ocean currents · LIVE · ${await frameWords(page)}`));
  await expect(flowNotes(page)).toContainText(FLOW_WORDS.bins.currents);
});

test("found-115 the Key drawer reads the currents' loading and failed words while the panel is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  let held: Route | null = null;
  await page.route(CURRENTS_HEADER, (route) => { held = route; });
  await gotoApp(page, '?cluster=enso&ocean=pacific&flow=currents&embed=true');
  await expect.poll(() => held !== null).toBe(true);
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toHaveText(`Ocean currents · loading · ${FLOW_WORDS.loading.currents}`);
  // Loading has a state line and nothing to decode yet.
  await expect(flowNotes(page)).toHaveCount(0);
  await held!.abort('failed');
  await expect(flowStatus(page)).toHaveText(`Ocean currents · unavailable · ${FLOW_WORDS.unavailable.currents}`);
  await expect(flowNotes(page)).toHaveText('No direction or calm condition is inferred from a failed request.');
  // The no-data words in the same drawer: tests/flow-wire.spec.ts "a currents view off the grid under it".
});

test("found-115 the arrows' Key drawer row follows the open panel: none while off, the panel's words while on, kept through a pan, gone with the SST layer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  // flow=off: this case starts from off ("none while off"); ENSO opens with wind since E2-4.
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=console&basemap=default&flow=off');
  const panel = page.locator('.enso-flow');
  const panelStatus = panel.locator('.enso-flow-status');
  await expect(panel).toBeVisible();
  await openKeyDrawer(page);
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="currents"]').click();
  await expect(panel).toHaveAttribute('data-status', /^live/);
  const line = (await panelStatus.textContent())!;
  expect(line).toMatch(/^live(?: \(partial\))? · Model run .+ · Model valid .+ · frame .+ old$/);
  await expect(flowStatus(page)).toHaveText(`Ocean currents · ${line}`);
  const panelText = (await panel.textContent())!;
  const notes = (await flowNotes(page).textContent())!;
  for (const sentence of notes.split(/(?<=\.)\s+/)) expect(panelText, 'the key re-types no sentence').toContain(sentence);
  const box = (await page.locator('#map').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 30, { steps: 5 });
  await page.mouse.up();
  // A pan asks for nothing: the row is still the panel's own line, and no prompt joins it.
  await expect(panelStatus).toHaveText(/^live(?: \(partial\))? · Model run .+ old$/);
  await expect(flowStatus(page)).toHaveText(`Ocean currents · ${(await panelStatus.textContent())!}`);
  await panel.locator('[data-flow-kind="off"]').click();
  await expect(panel).toHaveAttribute('data-status', 'off');
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="wind"]').click();
  await expect(flowStatus(page)).toContainText('Atmospheric currents · live · Model run ');
  await expect(flowStatus(page)).toContainText(' · Model valid ');
  await layerCheckbox(page, 'sst-anomaly').uncheck();
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
});
