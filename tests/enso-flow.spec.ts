import { continueLocalRoute } from './offline-test';
import { expect, test, type Locator, type Page, type Route } from './offline-test';
import { HAZARD_CLUSTERS } from '../src/config/clusters';
import { gotoApp, layerCheckbox, noddStubLog, search } from './helpers';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const FLOW_ROUTE = /^https:\/\/(?:marine-api|api)\.open-meteo\.com\/v1\//;
const NODD_ROUTE = /^https:\/\/noaa-gfs-bdp-pds\.s3\.amazonaws\.com\//;
/**
 * ENSO-FLOW-PLAN E2-1: wind and waves read NOAA NODD, answered by
 * tests/helpers.ts from the 2026-10-05 06Z f006 fixtures. A case that turns
 * either on fixes the page clock here, where the reader asks for exactly that
 * frame (candidate cycle 06Z, forecast hour 6 for both kinds). Only ocean
 * currents still read Open-Meteo.
 */
const LIVE_CLOCK = Date.UTC(2026, 9, 5, 12, 30);

async function stubSst(page: Page): Promise<void> {
  await page.route((url) => url.href.includes('DescribeDomains'), (route) => route.fulfill({
    status: 200, contentType: 'text/xml',
    body: "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-01/2026-09-07/P1D</Domain><Size>1</Size></DimensionDomain></Domains>"
  }));
  await page.route((url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

function payload(url: URL, missing = false, now = Date.now()): unknown[] {
  const latitudes = url.searchParams.get('latitude')!.split(',').map(Number);
  const longitudes = url.searchParams.get('longitude')!.split(',').map(Number);
  const [valueKey, directionKey] = url.searchParams.get('current')!.split(',') as [string, string];
  const time = Math.floor(now / 900_000) * 900;
  return latitudes.map((latitude, i) => ({ latitude, longitude: longitudes[i],
    current_units: { time: 'unixtime', [valueKey]: valueKey === 'wave_height' ? 'm' : 'm/s', [directionKey]: '°' },
    current: { time, interval: 900, [valueKey]: missing ? null : 2, [directionKey]: missing ? null : 90 }
  }));
}

async function respond(route: Route, missing = false, now = Date.now()): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload(new URL(route.request().url()), missing, now)) });
}

test('all three ENSO overlays remain bounded, independently timed, and preserve color through reload', async ({ page }) => {
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  const calls: URL[] = [];
  await page.route(FLOW_ROUTE, async (route) => { calls.push(new URL(route.request().url())); await respond(route, false, LIVE_CLOCK); });
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default');
  const panel = page.locator('.enso-flow');
  await expect(panel).toBeVisible();
  // The ENSO boot reads flow iff the cluster's flowDefault is set (E2-4 sets it;
  // read from the cluster definition, never a literal of this case).
  const flowDefault = Object.values(HAZARD_CLUSTERS).find((def) => def.urlToken === 'enso')?.flowDefault;
  expect(noddStubLog(page).length > 0, `NODD reads at an ENSO boot with flowDefault ${flowDefault ?? 'unset'}`)
    .toBe(flowDefault === 'wind' || flowDefault === 'waves');
  expect(calls).toHaveLength(flowDefault === 'currents' ? 1 : 0);
  const before = calls.length;
  for (const kind of ['currents', 'wind', 'waves']) {
    await panel.locator(`[data-flow-kind="${kind}"]`).click();
    // The wave crop ends at 165 E and 100 W, inside this Pacific view's edges.
    await expect(panel).toHaveAttribute('data-status', kind === 'waves' ? /^live/ : 'live');
    await expect(panel.locator('.enso-flow-status')).toContainText('Model valid');
    // Wind is ENSO's default since E2-4, written as the absence of the key.
    expect(new URLSearchParams(await search(page)).get('flow')).toBe(kind === 'wind' ? null : kind);
  }
  // Only ocean currents read Open-Meteo; wind and waves read the NODD fixtures.
  expect(calls).toHaveLength(before + 1);
  expect(calls.map((url) => url.searchParams.get('models')).slice(before)).toEqual(['meteofrance_currents']);
  for (const url of calls) expect(url.searchParams.get('latitude')!.split(',').length).toBeLessThanOrEqual(40);
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
  await page.route(FLOW_ROUTE, (route) => { held = route; });
  // flow=off: the boot reads nothing, so the only held request is the currents one below (ENSO opens with wind since E2-4).
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=off');
  const panel = page.locator('.enso-flow');
  // Ocean currents, the one kind still sampled from Open-Meteo (wind and
  // waves: tests/flow-wire.spec.ts "off intent aborts every range").
  await panel.locator('[data-flow-kind="currents"]').click();
  await expect.poll(() => held !== null).toBe(true);
  const failed = page.waitForEvent('requestfailed', (req) => FLOW_ROUTE.test(req.url()));
  await panel.locator('[data-flow-kind="off"]').click();
  await failed;
  await expect(panel).toHaveAttribute('data-status', 'off');
  await respond(held!).catch(() => undefined);
  await expect(panel.locator('.enso-flow-status')).toHaveText('Direction overlay off');
  expect(new URLSearchParams(await search(page)).get('flow')).toBe('off');
});

test('marine no-data and network failure remain separate from a successful direction field', async ({ page }) => {
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route, true));
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=brief&basemap=default&flow=currents');
  const panel = page.locator('.enso-flow');
  await expect(panel).toHaveAttribute('data-status', 'no data');
  await panel.locator('summary').click();
  await expect(panel).toContainText('0 of 40 sampled cells have data');
  // Waves read NOAA NODD now (ENSO-FLOW-PLAN E2-1): the network failure is the bucket's.
  await page.route(NODD_ROUTE, (route) => route.abort('failed'));
  await panel.locator('[data-flow-kind="waves"]').click();
  await expect(panel).toHaveAttribute('data-status', 'unavailable');
  await expect(panel).toContainText('No direction or calm condition is inferred');
});

test('the same ENSO controls move into the mobile Layers glass panel and return to desktop', async ({ page }) => {
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route));
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
 * Since ENSO-FLOW-PLAN E2-1 these cases ride ocean currents, the one kind
 * still sampled from Open-Meteo, whose sampled-cell words they pin; the
 * wind and wave rows are tests/flow-wire.spec.ts's.
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

/** The served instant in the page's own Intl, the panel's own format. */
async function modelValid(page: Page, seconds: number): Promise<string> {
  return page.evaluate((ms) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
  }).format(ms), seconds * 1000);
}

const DRAWER_SURFACES = [
  { name: 'a desktop embed', width: 1280, height: 800, query: '&embed=true' },
  { name: 'the desktop shell with the sidebar closed', width: 1280, height: 800, query: '&sidebar=closed' },
  { name: 'a 390x844 phone with the Layers sheet not showing', width: 390, height: 844, query: '' },
  { name: 'a 390x844 phone embed', width: 390, height: 844, query: '&embed=true' }
] as const;

for (const surface of DRAWER_SURFACES) {
  test(`found-115 ${surface.name}: the Key drawer reads the arrows' own status and model valid time, apart from the SST date`, async ({ page }) => {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    await stubSst(page);
    let served: number | null = null;
    await page.route(FLOW_ROUTE, async (route) => {
      const body = payload(new URL(route.request().url()));
      served = (body[0] as { current: { time: number } }).current.time;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await gotoApp(page, `?cluster=enso&ocean=pacific&flow=currents${surface.query}`);
    // The defect's premise: the arrows load while their own panel is off screen.
    const panel = page.locator('.enso-flow');
    await expect(panel).toHaveAttribute('data-status', 'live');
    await expect(panel).toBeHidden();
    await openKeyDrawer(page);
    const valid = await modelValid(page, served!);
    await expect(flowStatus(page)).toBeVisible();
    await expect(flowStatus(page)).toHaveText(`Ocean currents · live · Model valid ${valid}`);
    await expect(flowNotes(page)).toBeVisible();
    await expect(flowNotes(page)).toContainText(/^\d+ of \d+ sampled cells have data\. /);
    await expect(flowNotes(page)).toContainText('Arrows show travel direction only, with equal lengths; still water or calm wind has no arrow.');
    await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
    await expect(flowNotes(page)).toContainText('This is model context, independently timed from the observed SST map.');
    // The resample control is hidden on exactly these surfaces.
    await expect(flowNotes(page)).not.toContainText('Update area');
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
    (window as AnnouncementWindow).__flowAnnouncements = entries;
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
  return page.evaluate((text) => (window as AnnouncementWindow).__flowAnnouncements.filter((entry) =>
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
      await page.clock.setFixedTime(LIVE_CLOCK);
      await watchFlowAnnouncements(page);
      await stubSst(page);
      let held: Route | null = null;
      await page.route(FLOW_ROUTE, (route) => { held = route; });
      await gotoApp(page, `?cluster=enso&ocean=pacific&flow=currents&basemap=default${surface.query}`);
      await expect.poll(() => held !== null).toBe(true);
      const panel = page.locator('.enso-flow');
      await expect(panel).toHaveAttribute('data-status', 'loading');
      if (surface.panelVisible) await expect(panel).toBeVisible();
      else await expect(panel).toBeHidden();
      await expect(page.locator('#map-key-content')).toBeHidden();

      const loading = 'loading · Model direction samples';
      await expect.poll(async () => (await flowAnnouncements(page, loading)).length).toBeGreaterThan(0);
      expect.soft(await flowAnnouncements(page, loading)).toEqual([
        { id: 'layer-status-live', text: `Ocean currents · ${loading}`, exposed: true }
      ]);
      // Even an open panel and a subsequently opened Key are plain readers of the same state.
      expect.soft(await panel.locator('.enso-flow-status').getAttribute('role')).toBeNull();
      expect.soft(await panel.locator('.enso-flow-status').getAttribute('aria-live')).toBeNull();

      if (outcome === 'live') await respond(held!, false, LIVE_CLOCK);
      else await held!.abort('failed');
      await expect(panel).toHaveAttribute('data-status', outcome);
      const terminal = outcome === 'live' ? `live · Model valid ${await modelValid(page, LIVE_CLOCK / 1000)}`
        : 'unavailable · Direction samples did not load';
      await expect.poll(async () => (await flowAnnouncements(page, terminal)).length).toBeGreaterThan(0);
      expect.soft(await flowAnnouncements(page, terminal)).toEqual([
        { id: 'layer-status-live', text: `Ocean currents · ${terminal}`, exposed: true }
      ]);
      if (outcome === 'live') {
        // The existing panel-only resample prompt keeps its announcement on a
        // visible panel; a hidden control must not acquire a spoken instruction.
        const box = (await page.locator('#map').boundingBox())!;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx - 60, cy - 30, { steps: 5 });
        await page.mouse.up();
        const resample = `${terminal} · Update area to resample`;
        await expect(panel.locator('.enso-flow-status')).toHaveText(resample);
        expect.soft(await flowAnnouncements(page, resample)).toEqual(surface.panelVisible ? [
          { id: 'layer-status-live', text: `Ocean currents · ${resample}`, exposed: true }
        ] : []);
      }
      await openKeyDrawer(page);
      await expect(flowStatus(page)).toHaveText(`Ocean currents · ${terminal}`);
      expect.soft(await flowStatus(page).getAttribute('role')).toBeNull();
      expect.soft(await flowStatus(page).getAttribute('aria-live')).toBeNull();
      // Opening the visual reader must not replay either announcement.
      expect.soft(await flowAnnouncements(page, loading)).toHaveLength(1);
      expect.soft(await flowAnnouncements(page, terminal)).toHaveLength(1);
      await test.info().attach('flow-announcement-routes', {
        contentType: 'application/json', body: Buffer.from(JSON.stringify({ surface, outcome,
          loading: await flowAnnouncements(page, loading), terminal: await flowAnnouncements(page, terminal),
          resample: await flowAnnouncements(page, `${terminal} · Update area to resample`)
        }, null, 2))
      });
    });
  }
}

test('found-115 a Key that starts after the arrows have loaded still reads their state (a boot with flow= in the URL)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route));
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
  await expect(page.locator('.enso-flow')).toHaveAttribute('data-status', 'live');
  await expect.poll(() => keyRequested).toBe(true);
  await expect(page.locator('#map-key-details-toggle')).toHaveCount(0);
  release();
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toContainText('Ocean currents · live · Model valid ');
  await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
});

test("found-115 the Key drawer reads the arrows' loading, failed and no-data words while the panel is hidden", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubSst(page);
  let held: Route | null = null;
  await page.route(FLOW_ROUTE, (route) => { held = route; });
  await gotoApp(page, '?cluster=enso&ocean=pacific&flow=currents&embed=true');
  await expect.poll(() => held !== null).toBe(true);
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toHaveText('Ocean currents · loading · Model direction samples');
  await expect(flowNotes(page)).toHaveText('Loading up to 40 source grid cells for this area.');
  await held!.abort('failed');
  await expect(flowStatus(page)).toHaveText('Ocean currents · unavailable · Direction samples did not load');
  await expect(flowNotes(page)).toHaveText('No direction or calm condition is inferred from a failed request.');
  // The newest handler runs first, so this one answers every later read.
  await page.route(FLOW_ROUTE, (route) => respond(route, true));
  await page.reload();
  await openKeyDrawer(page);
  await expect(flowStatus(page)).toContainText('Ocean currents · no data · Model valid ');
  await expect(flowNotes(page)).toContainText(/^0 of \d+ sampled cells have data\. /);
  await expect(flowNotes(page)).toContainText('Missing cells have no arrow and do not imply calm conditions.');
});

test("found-115 the arrows' Key drawer row follows the open panel: none while off, the panel's words while on, kept through a pan, gone with the SST layer", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.setFixedTime(LIVE_CLOCK);
  await stubSst(page);
  await page.route(FLOW_ROUTE, (route) => respond(route, false, LIVE_CLOCK));
  // flow=off: this case starts from off ("none while off"); ENSO opens with wind since E2-4.
  await gotoApp(page, '?cluster=enso&ocean=pacific&view=console&basemap=default&flow=off');
  const panel = page.locator('.enso-flow');
  const panelStatus = panel.locator('.enso-flow-status');
  await expect(panel).toBeVisible();
  await openKeyDrawer(page);
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="currents"]').click();
  await expect(panel).toHaveAttribute('data-status', 'live');
  const line = (await panelStatus.textContent())!;
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
  await expect(panelStatus).toContainText('Update area to resample');
  await expect(flowStatus(page)).toHaveText(`Ocean currents · ${line}`);
  await panel.locator('[data-flow-kind="off"]').click();
  await expect(panel).toHaveAttribute('data-status', 'off');
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
  await panel.locator('[data-flow-kind="wind"]').click();
  await expect(flowStatus(page)).toContainText('Atmospheric currents · live · Model run ');
  await expect(flowStatus(page)).toContainText(' · Model valid ');
  await layerCheckbox(page, 'sst-anomaly').uncheck();
  await expect(page.locator(FLOW_ROW)).toHaveCount(0);
});
