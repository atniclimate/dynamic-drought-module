/**
 * The ENSO horizons, and the acceptance sentence of DDM-P12-T02.
 *
 *   "Every visible ENSO horizon activates evidence no other horizon shows, or
 *    is absent, and no horizon implies a forecast the app does not have."
 *
 * The task is DR-031 option (a): wire the CPC weekly Nino 3.4 observation into
 * the near-term ENSO cell, "labeled an observation and not a forecast". Before
 * it, all three ENSO horizons rested on one monthly and seasonal snapshot and
 * the near-term cell was a permanent named absence (option b behaviour).
 *
 * The second clause is the sharp one, and it is why the forbidden-language
 * check below exists. DR-031 recorded the risk in its own words: "a weekly
 * observation inside a register named weeks ahead reads as a forecast unless
 * the label says otherwise". A cell that renders an observation under a
 * near-term heading is exactly the place that risk lands.
 *
 * Three fixtures, because the cell has three honest states and the acceptance
 * has to hold in all of them: the snapshot carrying the weekly block, a snapshot
 * without it (an older build, which must still load), and a snapshot past
 * HARD_STALE_DAYS, where the claim is withheld the way the tendency claim is.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { gotoApp } from './helpers';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

/** src/impact/enso.ts HARD_STALE_DAYS is 120; 200 is comfortably past it. */
const STALE_DAYS = 200;

const ENSO_HORIZONS = ['current', 'nearTerm', 'longRange'] as const;

/**
 * Language that would make a cell read as a statement about what the ocean is
 * going to do. Built from what src/impact/enso.ts already treats as needing a
 * denial: every `vocab-allow` comment in that module marks an honesty
 * disclaimer that "denies being a forecast", and the module's own MODULATORS,
 * tendency and plume strings each end in one.
 *
 * `forecast` is checked separately below, because the module uses the word
 * legitimately and only to deny being one. These patterns are deliberately
 * about future CONDITIONS rather than any modal verb: the module says "RONI
 * values may change up to two months" about revisions and "a new RONI season
 * has likely posted" about its own staleness, and neither is a claim about
 * the ocean's future.
 */
const FORWARD_LOOKING: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'will + condition verb', re: /\bwill\s+(be|remain|continue|persist|strengthen|weaken|warm|cool|develop)\b/i },
  { name: 'is/are expected to', re: /\b(is|are|were|was)\s+expected\s+to\b/i },
  { name: 'predict / project / anticipate', re: /\b(predicts?|predicted|projects?|projected|anticipates?|anticipated)\b/i },
  { name: 'the coming/next weeks, months or seasons', re: /\b(coming|next)\s+(weeks?|months?|seasons?)\b/i },
  { name: 'through the end of / into the season', re: /\bthrough\s+the\s+(end\s+of\s+)?(winter|spring|summer|fall|autumn|season)\b/i }
];

/** `forecast` is allowed only immediately inside a denial. */
const FORECAST_WORD = /\bforecasts?\b/gi;
const FORECAST_DENIED = /\b(not|never|no)\b[^.]{0,40}\bforecasts?\b/i;

interface Snapshot {
  retrieved: string;
  [key: string]: unknown;
}

function readSnapshot(): Snapshot {
  const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { retrieved?: unknown }).retrieved !== 'string'
  ) {
    throw new Error('malformed bundled ENSO snapshot');
  }
  return parsed as Snapshot;
}

function daysAgo(days: number): string {
  const ms = Date.now() - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The shipped snapshot, which carries the weekly block. */
function withWeekly(): Snapshot {
  const snap = readSnapshot();
  if (snap.nino34Weekly === undefined) {
    throw new Error(
      'the bundled snapshot carries no nino34Weekly block; run npm run build:enso'
    );
  }
  return snap;
}

/** An older build: every other block present, the weekly one absent. */
function withoutWeekly(): Snapshot {
  const snap = readSnapshot();
  delete snap.nino34Weekly;
  return snap;
}

/** Past the hard staleness cutoff, where the weekly claim is withheld. */
function staleSnapshot(): Snapshot {
  const snap = readSnapshot();
  const old = daysAgo(STALE_DAYS);
  snap.retrieved = old;
  for (const key of ['roni', 'oni', 'nino34', 'nino34Weekly', 'soi']) {
    const series = snap[key];
    if (typeof series === 'object' && series !== null && 'published' in series) {
      (series as { published: string }).published = old;
    }
  }
  return snap;
}

async function openBriefing(page: Page, snapshot: Snapshot): Promise<void> {
  await page.route('**/data/enso-indices.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot)
    })
  );
  // The other briefing lanes are stubbed empty so this file asserts the ENSO
  // row only and never depends on a live agency being up.
  await page.route('**/USDM_current/FeatureServer/0/query?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  await page.route('**/WFIGS_Interagency_Perimeters_Current/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/geo+json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] })
    })
  );
  await page.route('https://api.weather.gov/alerts/active?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ features: [] })
    })
  );
  await page.route('**/proxy?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');
}

function ensoCell(page: Page, horizon: string) {
  return page.locator(
    `.impact-hazard[data-horizon="${horizon}"][data-hazard="enso"]`
  );
}

async function ensoTexts(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const horizon of ENSO_HORIZONS) {
    const cell = ensoCell(page, horizon);
    await expect(cell).toHaveCount(1);
    out[horizon] = (await cell.innerText()).replace(/\s+/g, ' ').trim();
  }
  return out;
}

/**
 * The acceptance's second clause, applied to every ENSO cell in whatever state
 * the fixture put it in.
 */
function expectNoForecastLanguage(texts: Record<string, string>): void {
  for (const [horizon, text] of Object.entries(texts)) {
    for (const { name, re } of FORWARD_LOOKING) {
      expect(re.test(text), `${horizon} ENSO cell uses forward-looking language (${name}): "${text}"`).toBe(false);
    }
    const uses = text.match(FORECAST_WORD) ?? [];
    if (uses.length > 0) {
      expect(
        FORECAST_DENIED.test(text),
        `${horizon} ENSO cell says "forecast" outside a denial: "${text}"`
      ).toBe(true);
    }
  }
}

test.describe('DDM-P12-T02: the ENSO horizons carry distinct source-backed meanings', () => {
  test('with the weekly block, each ENSO horizon shows evidence no other ENSO horizon shows', async ({
    page
  }) => {
    await openBriefing(page, withWeekly());
    const texts = await ensoTexts(page);

    // The near-term cell is the one DR-031 (a) wired. It states the weekly
    // trajectory: how many observations, both end values, and the band.
    expect(texts.nearTerm).toContain('weekly observations');
    expect(texts.nearTerm).toMatch(/[+-]\d+\.\d\s+to\s+[+-]\d+\.\d\s+degrees Celsius/);
    expect(texts.nearTerm).toContain('degree band');
    expect(texts.nearTerm).toContain('week centred');

    // ...and denies being the thing its column heading might suggest.
    expect(texts.nearTerm).toContain('not a forecast');
    expect(texts.nearTerm).toContain('say nothing about the weeks ahead');
    expect(texts.nearTerm).toContain('do not declare an ENSO phase');

    // Distinctness: the three cells do not repeat one another's evidence.
    expect(texts.current).toContain('RONI');
    expect(texts.longRange).toContain('Pacific Northwest');
    expect(texts.nearTerm).not.toContain('RONI');
    expect(texts.current).not.toContain('weekly observations');
    expect(texts.longRange).not.toContain('weekly observations');
    const rendered = ENSO_HORIZONS.map((h) => texts[h]);
    expect(new Set(rendered).size, 'two ENSO cells rendered identical text').toBe(3);

    expectNoForecastLanguage(texts);
  });

  test('without the weekly block, the near-term cell is a named absence and the others are unchanged', async ({
    page
  }) => {
    await openBriefing(page, withoutWeekly());
    const texts = await ensoTexts(page);

    expect(texts.nearTerm).toContain('No weekly Nino 3.4 observation is available');
    expect(texts.nearTerm).not.toContain('weekly observations the Nino 3.4');
    // Absent, not blank, and never a spinner for a source that is not coming.
    await expect(
      ensoCell(page, 'nearTerm').locator('.impact-horizon-note')
    ).toHaveCount(1);

    // The other two horizons still stand on their own evidence.
    expect(texts.current).toContain('RONI');
    expect(texts.longRange).toContain('Pacific Northwest');

    expectNoForecastLanguage(texts);
  });

  test('past the hard staleness cutoff, the weekly claim is withheld and the cell says so', async ({
    page
  }) => {
    await openBriefing(page, staleSnapshot());
    const texts = await ensoTexts(page);

    expect(texts.nearTerm).toContain('No weekly Nino 3.4 observation is available');
    expect(texts.nearTerm).not.toContain('weekly observations the Nino 3.4');

    // The long-range tendency is withheld past the same cutoff, so that cell
    // is an absence too; the current cell degrades to a dated past-tense read
    // rather than disappearing.
    expect(texts.current).toContain('snapshot dated');

    expectNoForecastLanguage(texts);
  });
});
