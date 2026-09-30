import { expect, test, type Page, type Request } from '@playwright/test';

import { URLS } from '../src/config/urls';
import { BASE_URL, BOOT_URLS } from '../src/config/urls-boot';
import { gotoApp, layerPill, waitForLayerSettled } from './helpers';
import { RAWS_ROUTE, rawsHappyBody } from './fixtures/raws-fixtures';
import { stubWildfireFeeds } from './wildfire-fixtures';

/**
 * S30D D1 M22 (DDM-P7-T11; register items owner-1r-credits and found-027;
 * design record acknowledgements-table.md sections 1.4 to 1.7, 4.1 and
 * 5.3; DR-159, DR-162, DR-163): the map-information pointer reaches the
 * acknowledgements with or without a place, the section survives a
 * hydration refresh and prints open, the embed reaches it, the chrome
 * carries no credit except the one OpenStreetMap string on the map, and
 * the station legend and the power key carry their ruled lines.
 *
 * Every boot goes through `gotoApp` (its suite-wide stubs keep sovereign
 * and live geometry off the wire); no fixed sleeps, every wait is on a
 * condition.
 */

const POINTER = '#map-info-attribution button[data-open-acknowledgements]';
const RAWS_NOTICE =
  'Public-view station data for awareness only; not for on-the-ground coordination.';

async function openPointer(page: Page): Promise<void> {
  await page.locator('#map-info-btn').click();
  await expect(page.locator('#map-info-panel')).toBeVisible();
  await page.locator(POINTER).click();
}

/**
 * The map's own ground and relief traffic, by explicit name: the recent
 * satellite basemap service (its frame query and exportImage tiles,
 * src/map/satellite.ts), the OpenStreetMap raster ground's tile host
 * (src/map/style.ts), and the Pacific Northwest relief archive with its
 * hosting fallback (URLS.hillshadePmtilesLocal and
 * URLS.hillshadePmtilesFallback). MapLibre keeps fetching these tiles after a
 * cold boot, on its own schedule, whatever the panel shows. None of these
 * names can match a briefing read: those go to the Worker proxy (NWS, SPC,
 * CPC and the rest), the same-origin resource catalog under /data/resources/,
 * the landscape signature, or the bundled boundaries, and the self-check in
 * the case below proves the first two still count.
 */
const OSM_TILE_HOST = new URL(BOOT_URLS.basemapOSM.replace(/\{[xyz]\}/g, '0')).hostname;
// The archive's path below the deploy base (the preview serves it from `/`,
// while BASE_URL outside a Vite build reads the Pages base).
const RELIEF_ARCHIVE_PATH = `/${URLS.hillshadePmtilesLocal.slice(BASE_URL.length)}`;
function isMapGroundRead(url: string): boolean {
  const parsed = new URL(url);
  return (
    url.startsWith(`${URLS.noaaMergedGeoColorImageServer}/`) ||
    parsed.hostname === OSM_TILE_HOST ||
    parsed.pathname.endsWith(RELIEF_ARCHIVE_PATH) ||
    url === URLS.hillshadePmtilesFallback
  );
}

/** Data reads (fetch or XHR) other than the map's own ground and relief
 * tiles: the only requests a lane, a layer or the briefing makes. */
function isDataRead(request: Request): boolean {
  const type = request.resourceType();
  return (type === 'fetch' || type === 'xhr') && !isMapGroundRead(request.url());
}

test.describe('the acknowledgements pointer and section (D1 M22)', () => {
  test('with no place selected the pointer opens the acknowledgements-only presentation and starts no request', async ({
    page
  }) => {
    // The named exclusion can never hide a briefing read.
    expect(isMapGroundRead(`${URLS.workerProxy}/proxy?url=${encodeURIComponent(`${URLS.nwsApi}/points/47,-120`)}`)).toBe(false);
    expect(isMapGroundRead('http://127.0.0.1:4173/data/resources/federal.json')).toBe(false);
    expect(isMapGroundRead('http://127.0.0.1:4173/data/landscape-signature-pnw.json')).toBe(false);
    // And it does name the relief archive the gate saw read after boot.
    expect(isMapGroundRead('http://127.0.0.1:4173/data/hillshade-dem-pnw.pmtiles')).toBe(true);
    await gotoApp(page, '');
    const reads: string[] = [];
    page.on('request', (request) => {
      if (isDataRead(request)) reads.push(request.url());
    });
    await openPointer(page);

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText('Acknowledgements');
    const section = panel.locator('.impact-acknowledgements');
    await expect(section).toHaveJSProperty('open', true);
    await expect(section.locator('.ack-row').first()).toBeVisible();
    // No place, no matrix, no resources: the list alone.
    await expect(panel.locator('.impact-horizons, .impact-resources')).toHaveCount(0);
    // Mail has no briefing to send here.
    await expect(panel.locator('.impact-panel-action-mail')).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(reads, 'the acknowledgements-only presentation read data').toEqual([]);

    // Close returns focus to Help, which stays in the chrome.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#map-info-btn')).toBeFocused();
    expect(reads).toEqual([]);
  });

  test('with a place briefing open, the Acknowledgements section at its end opens from its summary and takes focus', async ({
    page
  }) => {
    // The reachable route with a briefing open (director's ruling, round 2):
    // on the desktop the briefing is a modal over the Help button, so the
    // pointer is out of reach; the briefing's own section is the way in.
    await gotoApp(page, '?select=state:WA&region=washington_state');
    const panel = page.locator('#impact-panel');
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', {
      timeout: 15_000
    });
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    // A hydration refresh keeps the section's node (refreshOpenBriefing), so
    // no lane landing can retire the summary between focus and Enter; the
    // settled catalog row only anchors the read after the first paint.
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible({ timeout: 15_000 });
    const section = panel.locator('.impact-acknowledgements');
    const summary = section.locator('summary');
    await expect(section).toHaveJSProperty('open', false);
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(section).toHaveJSProperty('open', true);
    await expect(summary).toBeFocused();
    await expect(section.locator('.ack-row').first()).toBeVisible();
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington');
    // The section is the last section of the briefing body.
    expect(
      await panel.locator('.impact-panel-body').evaluate(
        (body) => body.lastElementChild?.classList.contains('impact-acknowledgements') ?? false
      )
    ).toBe(true);
  });

  test('a hydration refresh keeps the open section open, focused and in place', async ({ page }) => {
    // Hold the resource-catalog rehydrate (public/data/resources/): its
    // landing is the refresh this case releases. `rehydrateResourcesFromCatalog`
    // (src/ui/impact-panel-runtime.ts) awaits these reads, adds the state and
    // federal rows ABOVE the section, and then calls `refreshOpenBriefing`,
    // which re-renders every section above the acknowledgements and keeps
    // the acknowledgements node itself. tests/report-print.spec.ts holds the
    // same request the same way to force its mid-print refresh. (NWS reads go
    // through the Worker proxy, so an api.weather.gov route never matches.)
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldReads = 0;
    await page.route(/\/data\/resources\//, async (route) => {
      heldReads++;
      await gate;
      await route.continue();
    });
    await gotoApp(page, '?select=state:WA&region=washington_state');
    const panel = page.locator('#impact-panel');
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', {
      timeout: 15_000
    });
    // The catalog read is in flight and held: its row has not landed yet.
    await expect.poll(() => heldReads, { timeout: 15_000 }).toBeGreaterThan(0);
    const catalogRow = panel.getByRole('link', { name: 'Agricultural drought relief information' });
    await expect(catalogRow).toHaveCount(0);
    const summary = panel.locator('.impact-acknowledgements > summary');
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(panel.locator('.impact-acknowledgements')).toHaveJSProperty('open', true);
    // Mark the section and the resources section above it in one read.
    const before = await panel.locator('.impact-panel-body').evaluate((body) => {
      const section = body.querySelector(':scope > .impact-acknowledgements') as HTMLElement & {
        __m22Marker?: boolean;
      };
      const resources = body.querySelector('.impact-resources') as HTMLElement & {
        __m22Marker?: boolean;
      };
      section.__m22Marker = true;
      resources.__m22Marker = true;
      return section.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });

    release();
    // A fresh DOM read, not a sleep: this WA catalog row exists only once the
    // held rehydrate has landed and `refreshOpenBriefing` re-rendered.
    await expect(catalogRow).toBeVisible({ timeout: 15_000 });

    // The refresh re-rendered the sections above (the resources node is new)
    // and kept the acknowledgements node itself (its marker survives), open,
    // focused and where the reader left it. One read, after the settled row.
    const after = await panel.locator('.impact-panel-body').evaluate((body) => {
      const section = body.querySelector(':scope > .impact-acknowledgements') as
        | (HTMLDetailsElement & { __m22Marker?: boolean })
        | null;
      const resources = body.querySelector('.impact-resources') as
        | (HTMLElement & { __m22Marker?: boolean })
        | null;
      return {
        resourcesReplaced: resources !== null && resources.__m22Marker !== true,
        sameNode: section?.__m22Marker === true,
        open: section?.open ?? false,
        focused: section !== null && section.querySelector('summary') === document.activeElement,
        offset: section
          ? section.getBoundingClientRect().top - body.getBoundingClientRect().top
          : Number.NaN
      };
    });
    expect(after.resourcesReplaced).toBe(true);
    expect(after.sameNode).toBe(true);
    expect(after.open).toBe(true);
    expect(after.focused).toBe(true);
    expect(Math.abs(after.offset - before)).toBeLessThanOrEqual(1);
  });

  test('print opens the section, prints its licence URLs, and afterprint restores it closed', async ({
    page
  }) => {
    await gotoApp(page, '?select=state:WA&region=washington_state');
    const panel = page.locator('#impact-panel');
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', {
      timeout: 15_000
    });
    const section = panel.locator('.impact-acknowledgements');
    await expect(section).toHaveJSProperty('open', false);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await page.emulateMedia({ media: 'print' });
    await expect(section).toHaveJSProperty('open', true);
    await expect(section.locator('[data-ack-id="aafc"]')).toBeVisible();
    // One fresh query and read per poll: a hydration lane landing between a
    // locator's resolve and its evaluate re-renders the body, and
    // getComputedStyle on the detached old anchor reads '' for every value.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const anchor = document.querySelector(
            '#impact-panel .impact-acknowledgements [data-ack-id="aafc"] .ack-licence a'
          );
          return anchor ? getComputedStyle(anchor, '::after').content : 'no licence anchor';
        })
      )
      .toContain('https://open.canada.ca/en/open-government-licence-canada');
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(section).toHaveJSProperty('open', false);
  });

  test('under ?embed=true the pointer opens the acknowledgements', async ({ page }) => {
    await gotoApp(page, '?embed=true');
    await openPointer(page);
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.impact-acknowledgements')).toHaveJSProperty('open', true);
    await expect(panel.locator('[data-ack-id="osm"]')).toBeVisible();
  });

  test('no issuer name, copyright sign or licence link in #map-info-attribution, the sidebar footer or the map container except the OSM string while an OSM-derived source draws', async ({
    page
  }) => {
    await gotoApp(page, '?view=console');
    await page.locator('#map-info-btn').click();
    await expect(page.locator('#map-info-panel')).toBeVisible();
    const reading = await page.evaluate(() => {
      const LICENCE = /opendatacommons\.org|creativecommons\.org|open-government-licence|openstreetmap\.org\/copyright/;
      const issuerWords = /OpenStreetMap|NOAA|USGS|BIA|EPA|Census|NASA|NIFC|Overture/;
      const text = (selector: string) => document.querySelector(selector)?.textContent ?? '';
      const attribution = document.querySelector('#map-info-attribution');
      const footer = document.querySelector('.sidebar-footer');
      const container = document.querySelector('#map-container');
      const osm = document.querySelector('#map-osm-credit');
      const outsideOsm = (node: Element) => !osm || !osm.contains(node);
      const containerLinks = Array.from(container?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])
        .filter(outsideOsm)
        .filter((a) => LICENCE.test(a.href))
        .map((a) => a.href);
      const containerCopyright = Array.from(container?.querySelectorAll('*') ?? [])
        .filter(outsideOsm)
        .filter((el) =>
          Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').includes('©'))
        ).length;
      return {
        attribution: text('#map-info-attribution'),
        attributionLinks: attribution?.querySelectorAll('a').length ?? -1,
        attributionIssuer: issuerWords.test(text('#map-info-attribution')),
        footerIssuer: issuerWords.test(footer?.textContent ?? ''),
        footerCopyright: (footer?.textContent ?? '').includes('©'),
        footerLicenceLinks: Array.from(footer?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []).filter(
          (a) => LICENCE.test(a.href)
        ).length,
        containerLinks,
        containerCopyright,
        osmHidden: osm instanceof HTMLElement ? osm.hidden : null,
        osmText: osm?.textContent ?? ''
      };
    });
    expect(reading.attribution).toContain('Acknowledgements');
    expect(reading.attribution).not.toContain('©');
    expect(reading.attributionLinks).toBe(0);
    expect(reading.attributionIssuer).toBe(false);
    expect(reading.footerIssuer).toBe(false);
    expect(reading.footerCopyright).toBe(false);
    expect(reading.footerLicenceLinks).toBe(0);
    expect(reading.containerLinks).toEqual([]);
    expect(reading.containerCopyright).toBe(0);
    // The one exception: the OSM ground draws on every default boot.
    expect(reading.osmHidden).toBe(false);
    expect(reading.osmText).toBe('© OpenStreetMap contributors');
  });

  test("the station legend and the briefing carry the public-view notice verbatim, as DDM's notice (DR-159)", async ({
    page
  }) => {
    await page.route(RAWS_ROUTE, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rawsHappyBody()) })
    );
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    const legend = page.locator('#legend-panel [data-legend="telemetry"] .legend-ddm-notice');
    await expect(legend).toHaveText(`DDM notice: ${RAWS_NOTICE}`);

    await openPointer(page);
    const row = page.locator('#impact-panel [data-ack-id="nifc"] .ack-notice');
    await expect(row).toHaveText(`DDM notice: ${RAWS_NOTICE}`);
  });

  test('a power layer drawing shows the federal-source and host credit (DR-163)', async ({ page }) => {
    await stubWildfireFeeds(page);
    await gotoApp(page, '?region=washington_state&view=console&layers=power-infrastructure');
    const pill = layerPill(page, 'power-infrastructure');
    // The layer draws from zoom 6; zoom the map in from the keyboard until
    // it leaves "zoom in to load".
    await expect(async () => {
      const text = (await pill.textContent())?.trim() ?? '';
      if (text === 'zoom in to load') {
        await page.locator('#map .maplibregl-canvas').focus();
        await page.keyboard.press('Equal');
      }
      await expect(pill).toHaveText(/^live/, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const credits = page.locator('#legend-panel [data-legend="power-context"] [data-power-credit]');
    await expect(credits.filter({ hasText: 'Power plants: Source: U.S. Energy Information Administration' })).toHaveCount(1);
    await expect(
      credits.filter({ hasText: 'via the Esri Federal User Community (ArcGIS Living Atlas) copy.' })
    ).toHaveCount(1);
    await expect(
      credits.filter({
        hasText:
          'Transmission lines: U.S. Electric Power Transmission Lines (U.S. Government), archived copy last updated 2024-09-30, via the Esri Federal User Community.'
      })
    ).toHaveCount(1);
  });

  test('an unavailable briefing opened in the panel the acknowledgements-only view left open has a working Mail control', async ({
    page
  }) => {
    // A Tribal boundary's context carries no state (src/impact/context.ts
    // containingFromProperties: the fixtures carry no STUSPS), so its open
    // loads the containing-state chunk first; failing that chunk sends the
    // open down the facade's unavailable render (src/ui/impact-panel.ts
    // openImpactPanel's rejection branch, renderUnavailable) into the one
    // shared shell the acknowledgements-only view is still showing.
    // At 2560 wide the briefing panel (capped at 880px) leaves the map's
    // centre, where the collision fixtures sit, uncovered.
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.route('**/assets/containing-state-*.js', (route) => route.abort('failed'));
    // The boot and the centre click of tests/interaction-coordinator.spec.ts
    // (bootCollision, clickCenterForResponse) and of the Tribal Nation
    // mailto case in tests/impact-panel-a11y.spec.ts: both live Tribal
    // layers settled over tests/tribal-fixtures.ts's synthetic fixtures,
    // which the suite-wide boundary stubs serve.
    await gotoApp(page, '?region=washington_state&view=console&layers=aiannh,bia-reservations');
    await waitForLayerSettled(page, 'aiannh');
    await waitForLayerSettled(page, 'bia-reservations');

    await openPointer(page);
    const panel = page.locator('#impact-panel');
    const mail = panel.locator('.impact-panel-action-mail');
    await expect(panel.locator('#impact-panel-title')).toHaveText('Acknowledgements');
    await expect(mail).toHaveAttribute('aria-disabled', 'true');

    const map = await page.locator('#map').boundingBox();
    const seat = await panel.boundingBox();
    if (!map || !seat) throw new Error('the map or the panel has no box');
    const centre = { x: map.x + map.width / 2, y: map.y + map.height / 2 };
    expect(centre.x, 'the map centre must lie outside the open panel').toBeLessThan(seat.x);
    const popup = page.locator('.maplibregl-popup-content');
    await expect(async () => {
      await page.mouse.click(centre.x, centre.y);
      await expect(popup).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 20_000 });
    // Activate the door from the keyboard: the card may be wider than the
    // gap to the panel's edge, and a pointer hit-test there would land on
    // the panel; Enter on the focused button runs the same click handler.
    await popup.locator('[data-ddm-impact-trigger]').press('Enter');

    await expect(panel.locator('.impact-capability-unavailable')).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#impact-panel-title')).not.toHaveText('Acknowledgements');
    await expect(mail).not.toHaveAttribute('aria-disabled', 'true');
    await expect(mail).toHaveAttribute('href', /^mailto:\?subject=/);
  });

  test("the acknowledgements-only view's disabled Mail stays disabled with no link after a briefing has rendered", async ({
    page
  }) => {
    // found-098's re-arm (src/ui/impact-panel.ts rearmMailHref) rebuilds the
    // Email href from the LAST briefing on pointerdown, focus and click; with
    // a briefing rendered before, it must not hand the acknowledgements-only
    // view (no briefing to send) the previous briefing's link.
    await gotoApp(page, '?select=state:WA&region=washington_state');
    const panel = page.locator('#impact-panel');
    await expect(panel.locator('#impact-panel-title')).toHaveText('Washington', {
      timeout: 15_000
    });
    await expect(
      panel.getByRole('link', { name: 'Agricultural drought relief information' })
    ).toBeVisible({ timeout: 15_000 });
    const mail = panel.locator('.impact-panel-action-mail');
    await expect(mail).toHaveAttribute('href', /^mailto:\?/);
    await panel.locator('.impact-panel-close').click();
    await expect(panel).toBeHidden();

    await openPointer(page);
    await expect(panel.locator('#impact-panel-title')).toHaveText('Acknowledgements');
    await expect(mail).toHaveAttribute('aria-disabled', 'true');
    await mail.dispatchEvent('pointerdown');
    await mail.dispatchEvent('focus');
    const state = await mail.evaluate((anchor) => ({
      disabled: anchor.getAttribute('aria-disabled'),
      href: anchor.getAttribute('href')
    }));
    expect(state).toEqual({ disabled: 'true', href: null });
  });
});
