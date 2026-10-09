import { PNG } from 'pngjs';

import { expect, test, type Page } from './offline-test';
import {
  RG_FIXTURE_TIMES,
  STAR_VHI_TILE_PATH,
  USGS_RG_WMS,
  drynessStub,
  gotoApp,
  installDefaultDrynessStub,
  layerCheckbox,
  waitForLayerSettled
} from './helpers';
import { stubDeepTerrainArchive, stubWildfireFeeds } from './wildfire-fixtures';
import {
  DRYNESS_KEY_DRAFT,
  rgWeekLine,
  starCurrentWeek,
  starPreviousWeek,
  starWeekLine
} from '../src/layers/wildfire-dryness';

/**
 * DDM-P9-T13, the Wildfire 3D dryness ground (release 0.7.3 step 2). Every
 * STAR and USGS answer comes from the arms in tests/helpers.ts
 * (`installDefaultDrynessStub`); the terrain Worker is stubbed unreachable.
 * Browser cases on the software renderer: a pixel read here is SwiftShader's,
 * never GPU evidence.
 */

const TOGGLE = '.shell-fire3d-btn';
const WA = '?region=washington_state&cluster=wildfire';

function stamp(page: Page, key: 'ddmFire3d' | 'ddmDryness' | 'ddmDrynessProduct'): Promise<string | undefined> {
  return page.evaluate((name) => document.documentElement.dataset[name], key);
}

async function reaches(page: Page, key: 'ddmFire3d' | 'ddmDryness' | 'ddmDrynessProduct', expected: string | undefined, timeout = 60_000): Promise<void> {
  await expect.poll(() => stamp(page, key), { timeout }).toBe(expected);
}

/** Arms set before navigation reach the first entry; `gotoApp` keeps them. */
async function bootWith(page: Page, query: string, arms: Partial<Pick<ReturnType<typeof drynessStub>, 'star' | 'starFailWeeks' | 'starFill' | 'rg'>> = {}): Promise<void> {
  await stubWildfireFeeds(page);
  await stubDeepTerrainArchive(page);
  await installDefaultDrynessStub(page);
  Object.assign(drynessStub(page), arms);
  await gotoApp(page, query);
}

const dryKey = (page: Page) => page.locator('#map-key [data-dryness-key]');

/** Mean sRGB luminance of the near ground (bottom centre of the map canvas). */
async function nearGroundLuminance(page: Page): Promise<number> {
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('no map canvas');
  const clip = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.75, width: box.width * 0.2, height: box.height * 0.15 };
  const png = PNG.sync.read(await page.screenshot({ clip, animations: 'disabled' }));
  let sum = 0;
  for (let i = 0; i < png.data.length; i += 4) sum += 0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!;
  return sum / (png.data.length / 4);
}

test('STAR weeks follow the issuer\'s 1-to-52 rule and the key states each week as dates (owner direction 2026-10-09)', () => {
  const at = (day: string) => new Date(`${day}T12:00:00Z`);
  expect(starCurrentWeek(at('2026-10-09'))).toBe('2026040');
  expect(starCurrentWeek(at('2026-01-05'))).toBe('2025052');
  expect(starCurrentWeek(at('2026-01-08'))).toBe('2026001');
  expect(starCurrentWeek(at('2026-12-31'))).toBe('2026052');
  expect(starPreviousWeek('2026001')).toBe('2025052');
  expect(starWeekLine('2026038')).toBe('NOAA STAR week 38: Sep 17 to Sep 23, 2026');
  expect(starWeekLine('2026052')).toBe('NOAA STAR week 52: Dec 24 to Dec 30, 2026');
  expect(starWeekLine('2024052')).toBe('NOAA STAR week 52: Dec 23 to Dec 29, 2024');
  expect(rgWeekLine('2026-09-28T00:00:00.000Z')).toBe('USGS week of Sep 28 to Oct 4, 2026');
  expect(rgWeekLine('2025-12-29T00:00:00.000Z')).toBe('USGS week of Dec 29, 2025 to Jan 4, 2026');
});

test.describe('Wildfire 3D dryness ground', () => {
  test.setTimeout(180_000);

  test('entering Wildfire 3D requests no MERGEDGC, GIBS GOES, nowCOAST, Blue Marble or D8-ground host and no VHI tile at z8 or deeper', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await bootWith(page, `${WA}&fire3d=true`);
    await reaches(page, 'ddmFire3d', 'active');
    await reaches(page, 'ddmDryness', 'live');
    expect(await stamp(page, 'ddmDrynessProduct')).toBe('star-vhi');
    const imagery = requests.filter((url) =>
      /satellitemaps\.nesdis\.noaa\.gov|MERGEDGC|gibs\.earthdata\.nasa\.gov|nowcoast\.noaa\.gov|BlueMarble/i.test(url));
    expect(imagery).toEqual([]);
    const star = drynessStub(page).log.filter((row) => row.host === 'star');
    expect(star.length).toBeGreaterThan(1);
    expect(star.filter((row) => row.z === null || row.z >= 8)).toEqual([]);
    // Week k from STAR's own rule, read straight through: no fallback was needed.
    expect(drynessStub(page).weeks).toEqual([starCurrentWeek(new Date())]);
    await expect(dryKey(page)).toContainText(starWeekLine(starCurrentWeek(new Date())));
    await expect(dryKey(page)).toContainText(DRYNESS_KEY_DRAFT.starRevision);
  });

  test('a week-k failure steps to k-1 and then swaps to Relative Greenness atomically, reading the named source failure', async ({ page }) => {
    await page.addInitScript(() => {
      const log: unknown[] = [];
      (window as unknown as { __drynessLog: unknown[] }).__drynessLog = log;
      window.addEventListener('ddm:dryness-ground', (event) => log.push((event as CustomEvent).detail));
    });
    await bootWith(page, `${WA}&fire3d=true`, { starFailWeeks: 2 });
    await reaches(page, 'ddmDrynessProduct', 'usgs-relative-greenness');
    const k = starCurrentWeek(new Date());
    expect(drynessStub(page).weeks).toEqual([k, starPreviousWeek(k)]);
    // The newest listed TIME, requested exactly.
    const rgTiles = drynessStub(page).log.filter((row) => row.host === 'rg' && row.frame !== 'capabilities');
    expect(new Set(rgTiles.map((row) => row.frame))).toEqual(new Set([RG_FIXTURE_TIMES.at(-1)]));
    const details = await page.evaluate(() => (window as unknown as { __drynessLog: unknown[] }).__drynessLog) as Array<{
      productKey: string; title: string | null; rows: { label: string }[]; lines: string[];
    } | null>;
    // One identity at every publish: rows, title, clock, coverage and qualification change together.
    for (const detail of details) {
      if (!detail || detail.productKey === 'none') continue;
      const star = detail.productKey === 'star-vhi';
      expect(detail.title).toBe(star ? DRYNESS_KEY_DRAFT.starTitle : DRYNESS_KEY_DRAFT.rgTitle);
      expect(detail.rows.map((row) => row.label).slice(0, -1)).toEqual([...(star ? DRYNESS_KEY_DRAFT.starRows : DRYNESS_KEY_DRAFT.rgRows)]);
      expect(detail.lines).toContain(star ? DRYNESS_KEY_DRAFT.starCoverage : DRYNESS_KEY_DRAFT.rgCoverage);
      expect(detail.lines.includes(DRYNESS_KEY_DRAFT.starRevision)).toBe(star);
    }
    expect(details.some((detail) => detail?.productKey === 'star-vhi')).toBe(false);
    await expect(dryKey(page)).toContainText('NOAA STAR vegetation health unavailable; showing USGS Relative Greenness');
    await expect(dryKey(page)).toContainText(rgWeekLine(RG_FIXTURE_TIMES.at(-1)!));
    await expect(dryKey(page)).toHaveAttribute('data-product-key', 'usgs-relative-greenness');
  });

  test('at every status publish the legend\'s product key equals the mounted source\'s product key', async ({ page }) => {
    await bootWith(page, WA, { starFailWeeks: 2 });
    await expect(page.locator('#map-key-legend')).toBeAttached();
    // Registered after the key's own listener, so each read sees that publish rendered.
    type Read = { legend: string; mounted: string; title: string | null; swatches: number };
    await page.evaluate(() => {
      const reads: Read[] = [];
      (window as unknown as { __drynessReads: Read[] }).__drynessReads = reads;
      window.addEventListener('ddm:dryness-ground', () => {
        const key = document.querySelector('#map-key [data-dryness-key]');
        reads.push({
          legend: key?.getAttribute('data-product-key') ?? 'none',
          // Stamped from the map itself: the product whose source the ground layer draws.
          mounted: document.documentElement.dataset['ddmDrynessProduct'] ?? 'none',
          title: key?.querySelector('strong')?.textContent ?? null,
          swatches: key?.querySelectorAll('.map-key-item').length ?? 0
        });
      });
    });
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmDrynessProduct', 'usgs-relative-greenness');
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmFire3d', 'inactive');
    const reads = await page.evaluate(() => (window as unknown as { __drynessReads: Read[] }).__drynessReads);
    expect(reads.length).toBeGreaterThan(3);
    for (const read of reads) {
      expect(read.legend).toBe(read.mounted);
      // The classes drawn in the key are the mounted product's own, never the attempted one's.
      expect(read.swatches).toBe(read.mounted === 'star-vhi' ? 10 : read.mounted === 'usgs-relative-greenness' ? 11 : 0);
      if (read.mounted === 'usgs-relative-greenness') expect(read.title).toBe(DRYNESS_KEY_DRAFT.rgTitle);
    }
    expect(reads.at(-1)).toEqual({ legend: 'none', mounted: 'none', title: null, swatches: 0 });
  });

  test('a failed VHI route leaves the hillshade and reads unavailable', async ({ page }) => {
    await bootWith(page, `${WA}&fire3d=true`, { star: 'abort', rg: 'abort' });
    await reaches(page, 'ddmFire3d', 'active');
    await reaches(page, 'ddmDryness', 'unavailable');
    expect(await stamp(page, 'ddmDrynessProduct')).toBe('none');
    await expect(dryKey(page)).toContainText(DRYNESS_KEY_DRAFT.unavailable);
    await expect(layerCheckbox(page, 'hillshade')).toBeChecked();
    await waitForLayerSettled(page, 'hillshade');
    expect(await stamp(page, 'ddmFire3d')).toBe('active');
  });

  test('RG north of 51.78 N reads live (partial) with the coverage line', async ({ page }) => {
    await bootWith(page, '?region=british_columbia&cluster=wildfire&fire3d=true', { starFailWeeks: 2 });
    await reaches(page, 'ddmDrynessProduct', 'usgs-relative-greenness');
    await reaches(page, 'ddmDryness', 'live (partial)');
    await expect(dryKey(page)).toContainText(DRYNESS_KEY_DRAFT.rgCoverage);
    await expect(dryKey(page)).toHaveAttribute('data-dryness-state', 'live (partial)');
  });

  test('zero pending VHI or RG requests after leaving 3D', async ({ page }) => {
    const pending = new Set<string>();
    const dryness = (url: string): boolean => url.startsWith(STAR_VHI_TILE_PATH) || url.startsWith(USGS_RG_WMS);
    page.on('request', (request) => { if (dryness(request.url())) pending.add(request.url()); });
    page.on('requestfinished', (request) => pending.delete(request.url()));
    page.on('requestfailed', (request) => pending.delete(request.url()));
    await bootWith(page, WA, { star: 'hold' });
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmDryness', 'loading');
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmFire3d', 'inactive');
    await expect.poll(() => pending.size, { timeout: 15_000 }).toBe(0);
    expect(await stamp(page, 'ddmDryness')).toBeUndefined();
    const before = drynessStub(page).log.length;
    await page.waitForTimeout(2_000);
    expect(drynessStub(page).log.length).toBe(before);
  });

  test('re-entering Wildfire 3D after NOAA revises the same week draws the revised bytes', async ({ page }) => {
    // Owner direction 2026-10-09: no app cache may mask a revision.
    await bootWith(page, WA, { starFill: 3 });
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmDryness', 'live');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset['ddmFire3dTransport']), { timeout: 60_000 }).toBe('settled');
    const first = await nearGroundLuminance(page);
    const firstEntry = drynessStub(page).log.length;
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmFire3d', 'inactive');
    // The same week, revised: index 3 (STAR's driest run) becomes index 90 (its wettest).
    drynessStub(page).starFill = 90;
    await page.locator(TOGGLE).click();
    await reaches(page, 'ddmDryness', 'live');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset['ddmFire3dTransport']), { timeout: 60_000 }).toBe('settled');
    const second = await nearGroundLuminance(page);
    const reread = drynessStub(page).log.slice(firstEntry).filter((row) => row.host === 'star');
    expect(new Set(reread.map((row) => row.frame))).toEqual(new Set([starCurrentWeek(new Date())]));
    expect(reread.length).toBeGreaterThan(1);
    expect(second - first).toBeGreaterThan(10);
  });
});
