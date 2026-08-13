import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gotoApp } from './helpers';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

interface SnapshotPoint {
  readonly preliminary?: boolean;
  readonly [key: string]: unknown;
}

interface SnapshotSeries {
  readonly sourceUrl: string;
  readonly published: string;
  readonly latest: SnapshotPoint;
  readonly values: SnapshotPoint[];
  readonly block?: string;
}

interface SnapshotFixture {
  readonly retrieved: string;
  readonly roni: SnapshotSeries;
  readonly oni: SnapshotSeries;
  readonly nino34: SnapshotSeries;
  readonly soi: SnapshotSeries;
  readonly probabilities?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshotSeries(value: unknown): value is SnapshotSeries {
  return (
    isRecord(value) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.published === 'string' &&
    isRecord(value.latest) &&
    Array.isArray(value.values) &&
    value.values.every(isRecord)
  );
}

function isSnapshotFixture(value: unknown): value is SnapshotFixture {
  return (
    isRecord(value) &&
    typeof value.retrieved === 'string' &&
    isSnapshotSeries(value.roni) &&
    isSnapshotSeries(value.oni) &&
    isSnapshotSeries(value.nino34) &&
    isSnapshotSeries(value.soi)
  );
}

function readSnapshot(): SnapshotFixture {
  const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (!isSnapshotFixture(parsed)) throw new Error('malformed bundled ENSO test fixture');
  return parsed;
}

/**
 * Observed-state El Nino / Southern Oscillation (ENSO) repair
 * (0.8.0 U-ENSO-REPAIR). Assertions are structural: current phases and values
 * deliberately remain unpinned because the committed snapshot refreshes.
 */
test.describe('ENSO observed-state repair', () => {
  test('bundled snapshot carries four sourced series and bounded preliminary flags', () => {
    const snapshot = readSnapshot();

    expect(snapshot.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sources = [
      ['roni', snapshot.roni],
      ['oni', snapshot.oni],
      ['nino34', snapshot.nino34],
      ['soi', snapshot.soi]
    ] as const;
    for (const [key, series] of sources) {
      expect(series, `${key} series must be present`).toBeTruthy();
      expect(series.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(series.sourceUrl).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
      expect(series.values.length).toBeGreaterThan(0);
    }

    for (const series of [snapshot.roni, snapshot.oni]) {
      const values = series.values;
      expect(values.slice(-2).every((point) => point.preliminary === true)).toBe(true);
      expect(values.slice(0, -2).every((point) => point.preliminary === false)).toBe(true);
    }
    expect(snapshot.nino34.latest.preliminary).toBeUndefined();
    expect(snapshot.soi.block).toBe('standardized');
    expect(JSON.stringify(snapshot.soi)).not.toContain('-999.9');
    expect(snapshot.probabilities).toBeUndefined();
  });

  test('the standalone ENSO driver line is removed from the interface', async ({
    page
  }) => {
    await gotoApp(page);
    await expect(page.locator('#enso-driver')).toHaveCount(0);
  });

  test('preliminary seasonal values say they may change in every rendered surface', async ({
    page
  }) => {
    const snapshot = readSnapshot();
    expect(snapshot.roni.latest.preliminary).toBe(true);
    expect(snapshot.oni.latest.preliminary).toBe(true);

    await gotoApp(page, '?select=state:WA');

    await expect(page.locator('#enso-driver')).toHaveCount(0);

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    const chart = derived.first().locator('.impact-claim-chart');
    await expect.soft(chart).toContainText(/RONI\* [+-]?\d+\.\d{2}/);
    await expect.soft(chart).toContainText(/ONI\* [+-]?\d+\.\d{2}/);
    await expect.soft(chart).toContainText(/Preliminary: plotted value may change/i);

    const analyzed = panel.locator('.impact-claim-analyzed', {
      hasText: 'analyzed monthly Nino 3.4'
    });
    await expect(analyzed.first()).toBeVisible({ timeout: 15_000 });
    await expect(analyzed.first()).not.toContainText(/preliminary/i);
  });

  test('missing optional Nino 3.4 and SOI blocks do not restore the retired driver', async ({
    page
  }) => {
    const snapshot: Record<string, unknown> = { ...readSnapshot() };
    delete snapshot.nino34;
    delete snapshot.soi;
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshot)
      })
    );

    await gotoApp(page);
    await expect(page.locator('#enso-driver')).toHaveCount(0);
  });

  for (const block of ['nino34', 'soi'] as const) {
    test(`present malformed optional ${block} block does not restore the retired driver`, async ({
      page
    }) => {
      const snapshot: Record<string, unknown> = {
        ...readSnapshot(),
        [block]: { malformed: true }
      };
      await page.route('**/data/enso-indices.json', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot)
        })
      );

      await gotoApp(page);
      await expect(page.locator('#enso-driver')).toHaveCount(0);
    });
  }

  test('briefing labels Nino 3.4 analyzed, keeps SOI supporting, and renders no plume', async ({
    page
  }) => {
    await gotoApp(page, '?select=state:WA');

    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('historical-continuity Oceanic Nino Index');
    await expect(derived.first()).toContainText('ocean-atmosphere agreement flag only');

    const analyzed = panel.locator('.impact-claim-analyzed', {
      hasText: 'analyzed monthly Nino 3.4'
    });
    await expect(analyzed.first()).toBeVisible({ timeout: 15_000 });
    await expect(analyzed.first().locator('.impact-claim-badge')).toHaveText('Analyzed');

    await expect(
      panel.locator('.impact-claim', { hasText: 'probabilistic ENSO outlook' })
    ).toHaveCount(0);
    await expect(
      panel.locator('.impact-claim-chart', { hasText: 'odds of El Nino' })
    ).toHaveCount(0);
  });
});
