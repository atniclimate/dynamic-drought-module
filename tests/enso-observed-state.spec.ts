import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gotoApp } from './helpers';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

interface SnapshotPoint {
  readonly preliminary?: boolean;
  readonly [key: string]: unknown;
}

interface SnapshotState {
  readonly conditions: string;
  readonly episode: string;
  readonly direction: string;
  readonly emerging: boolean;
  readonly threshold: number;
  readonly conditionsRule: string;
  readonly episodeRule: string;
}

interface SnapshotSeries {
  readonly sourceUrl: string;
  readonly published: string;
  readonly latest: SnapshotPoint;
  readonly values: SnapshotPoint[];
  readonly block?: string;
  readonly phase?: string;
  readonly state?: SnapshotState;
}

interface SnapshotFixture {
  readonly retrieved: string;
  readonly roni: SnapshotSeries;
  readonly oni: SnapshotSeries;
  readonly nino34: SnapshotSeries;
  readonly soi: SnapshotSeries;
  readonly probabilities?: unknown;
  readonly sourceQuotes?: readonly { readonly text: string; readonly source: string; readonly url: string }[];
}

/**
 * A snapshot whose operational RONI series is pinned to one of CPC's three
 * states, so the rendered wording is asserted against a fixture rather than
 * against whatever CPC published this month. Only `state` and `latest` are
 * overridden; the seasonal `values` (and therefore the chart) stay real.
 */
function snapshotInState(
  conditions: 'el-nino' | 'la-nina' | 'neutral',
  episode: 'el-nino' | 'la-nina' | 'neutral',
  direction: 'strengthening' | 'weakening' | 'steady',
  anom: number
): Record<string, unknown> {
  const base = readSnapshot();
  const state: SnapshotState = {
    conditions,
    episode,
    direction,
    emerging: conditions !== 'neutral' && episode === 'neutral',
    threshold: 0.5,
    conditionsRule:
      'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ensofaq.shtml',
    episodeRule: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/'
  };
  return {
    ...base,
    roni: {
      ...base.roni,
      phase: episode,
      state,
      latest: {
        ...base.roni.latest,
        anom,
        preliminary: true,
        exceedsThreshold: Math.abs(anom) >= 0.5,
        thresholdSide: anom >= 0.5 ? 'above' : anom <= -0.5 ? 'below' : 'within'
      }
    }
  };
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

  /**
   * ENSOSCI-01. CPC publishes two rules that answer different questions: the
   * onset rule on the newest three-month season (current conditions) and the
   * five-consecutive-overlapping-season rule that classifies a historical
   * episode. The builder emitted only the second and the headline reported
   * it in the present tense, so the application said "ENSO is currently
   * neutral" through a standing NOAA El Nino Advisory. The snapshot now
   * carries both, plus the derived `emerging` label and the CPC pages that
   * define each rule.
   */
  test('the bundled snapshot separates current conditions from the historical episode rule', () => {
    const snapshot = readSnapshot();
    const phases = ['el-nino', 'la-nina', 'neutral'];

    for (const [key, series] of [
      ['roni', snapshot.roni],
      ['oni', snapshot.oni]
    ] as const) {
      const state = series.state;
      expect(state, `${key} must carry a state block`).toBeTruthy();
      if (!state) continue;
      expect(phases).toContain(state.conditions);
      expect(phases).toContain(state.episode);
      expect(['strengthening', 'weakening', 'steady']).toContain(state.direction);
      // The legacy key stays an alias of the historical rule, so an older
      // consumer keeps loading and cannot silently gain a new meaning.
      expect(series.phase).toBe(state.episode);
      // `emerging` is derived, never a fourth state word.
      expect(state.emerging).toBe(state.conditions !== 'neutral' && state.episode === 'neutral');
      // Conditions follow CPC's onset rule on the newest season alone.
      const anom = series.latest.anom as number;
      const expected =
        anom >= state.threshold ? 'el-nino' : anom <= -state.threshold ? 'la-nina' : 'neutral';
      expect(state.conditions).toBe(expected);
      expect(state.conditionsRule).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
      expect(state.episodeRule).toMatch(/^https:\/\/www\.cpc\.ncep\.noaa\.gov\//);
    }

    // The verbatim CPC definitions travel with the artifact, each with the
    // page it was read from, so the file states the rules it was built under.
    expect(snapshot.sourceQuotes?.length ?? 0).toBeGreaterThan(0);
    for (const quote of snapshot.sourceQuotes ?? []) {
      expect(quote.text.length).toBeGreaterThan(0);
      expect(quote.url).toMatch(/^https:\/\//);
    }
  });

  test('an emerging El Nino leads with conditions and states the episode rule second', async ({
    page
  }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotInState('el-nino', 'neutral', 'strengthening', 0.98))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    // The headline is the present-tense onset answer.
    await expect(derived.first()).toContainText('El Nino conditions are present and strengthening');
    // The historical rule follows, named as historical.
    await expect(derived.first()).toContainText('five consecutive overlapping seasons');
    await expect(derived.first()).toContainText('historical episode classification still reads neutral');
    // The regression this replaced: the episode rule reported as the present.
    await expect(panel).not.toContainText('ENSO is currently neutral');
    await expect(panel).not.toContainText('offers little long-range signal');

    // CPC's own status is reachable, and the app says it does not restate it.
    const authority = panel.locator('.impact-claim', { hasText: 'ENSO Diagnostic Discussion' });
    await expect(authority.first()).toBeVisible();
    await expect(authority.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml'
    );

    // The Pacific Northwest tendency carries the issuer that states it, and
    // the flat below-normal-snowpack claim is gone (report 13, ENSOSCI-09).
    const tendency = panel.locator('.impact-claim', { hasText: 'past El Nino events' });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.climatehubs.usda.gov/hubs/northwest/topic/el-nino-northwest-what-can-we-expect'
    );
    await expect(tendency.first()).toContainText('near-normal Washington snowpack');
    await expect(panel).not.toContainText('below-normal snowpack');
  });

  test('a La Nina read cites its issuer and carries no uncited fine-fuels claim', async ({
    page
  }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotInState('la-nina', 'la-nina', 'weakening', -1.1))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('La Nina conditions are present and weakening');
    await expect(derived.first()).toContainText('episode criterion is met');

    const tendency = panel.locator('.impact-claim', { hasText: 'past La Nina events' });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.climatehubs.usda.gov/hubs/northwest/topic/la-nina-northwest-what-can-we-expect'
    );
    // The uncited fine-fuels teleconnection was deleted, not softened.
    await expect(panel).not.toContainText('fine fuels');
  });

  test('a neutral read says so without asserting an absence of signal', async ({ page }) => {
    await page.route('**/data/enso-indices.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(snapshotInState('neutral', 'neutral', 'steady', 0.12))
      })
    );

    await gotoApp(page, '?select=state:WA');
    const panel = page.locator('#impact-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const derived = panel.locator('.impact-claim-derived', {
      hasText: 'operational RONI'
    });
    await expect(derived.first()).toBeVisible({ timeout: 30_000 });
    await expect(derived.first()).toContainText('ENSO conditions are neutral');
    await expect(derived.first()).toContainText('onset thresholds');
    // The uncited forecast-skill assertion is gone; the redirection stays.
    await expect(panel).not.toContainText('offers little long-range signal');
    const tendency = panel.locator('.impact-claim', {
      hasText: 'neither El Nino nor La Nina conditions present'
    });
    await expect(tendency.first()).toBeVisible();
    await expect(tendency.first().locator('a')).toHaveAttribute(
      'href',
      'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/ENSO/composites/'
    );
  });
});
