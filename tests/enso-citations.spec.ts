/**
 * The Pacific Northwest tilt sentences, and the acceptance sentence of
 * DDM-P12-T03 (docs/ROADMAP.yaml).
 *
 *   "Each of the three Pacific Northwest tilt sentences cites a published
 *    source and states the season and probabilistic strength that source
 *    supports; the two DR-030 names as over-claiming are narrowed to what
 *    their source supports."
 *
 * The task is DR-030 option (a): "adopt all three Pacific Northwest tilt
 * sentences with a source URL on each". `src/impact/enso.ts` `tendency()` has
 * exactly three branches, el-nino, la-nina and neutral, and each returns its
 * own `source` and `sourceUrl`. This file proves all three halves of the
 * acceptance against the rendered DOM, one fixture per branch:
 *
 *   1. CITES A PUBLISHED SOURCE. The long-range ENSO claim carries a source
 *      link whose href equals the URL the references ledger records for that
 *      branch. The ledger is READ, not restated, so the code and
 *      planning/references/register.yaml cannot drift apart without this
 *      failing. Every one of those URLs answered HTTP 200 on 2026-09-07.
 *   2. STATES THE SEASON AND THE STRENGTH. The claim names a season and hedges
 *      it. Both word lists below are derived from the three verified pages
 *      themselves, not invented here; see their comments.
 *   3. IMPLIES NO FORECAST. The same forbidden-language list DDM-P12-T02 uses,
 *      imported from ./enso-forecast-language so there is one copy of it.
 *
 * Fixture machinery (readSnapshot, daysAgo, route stubbing, the cell locator)
 * follows tests/enso-horizons.spec.ts. The branch is forced through the
 * snapshot's `roni.state` block, which `readState` returns as-is, so each
 * fixture selects one tendency branch without reaching into the module.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectNoForecastLanguage } from './enso-forecast-language';
import { gotoApp, stubHeatRiskCatalog } from './helpers';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');
const REGISTER_PATH = join(process.cwd(), 'planning', 'references', 'register.yaml');

/**
 * Season words. Every one of them is a word the three verified pages use to
 * scope a tendency in time: the USDA Northwest Climate Hub El Nino page says
 * "fall and winter are usually warmer and drier"; its La Nina page says
 * "winter is usually cooler" and speaks of "spring and summer conditions";
 * the CPC composites page indexes its products by "3-Month Period" and the
 * CPC Seasonal Drought Outlook names the "September-October-November season".
 * A tilt sentence that names no season has not said when its tendency applies.
 */
const SEASON_WORDS: readonly RegExp[] = [
  /\bfall\b/i,
  /\bwinter\b/i,
  /\bspring\b/i,
  /\bsummer\b/i,
  /\bseasons?\b/i,
  /\bseasonal\b/i
];

/**
 * Hedge words, likewise taken from the pages rather than invented. The Hub
 * pages carry "usually", "typically", "can", "some ... events", "not as strong
 * as for temperature" and "the typical effects are not a certainty"; the CPC
 * composites page publishes "tendencies" by phase; the Washington State
 * Climate Office reports "near-normal" snowpack. A tilt sentence that states a
 * regional consequence with none of these has claimed more than its page does.
 */
const HEDGE_WORDS: readonly RegExp[] = [
  /\busually\b/i,
  /\btypically\b/i,
  /\btend(s|ed|ency|encies)?\b/i,
  /\bcan\b/i,
  /\boften\b/i,
  /\bsome\b/i,
  /\bnot as strong\b/i,
  /\bnear-normal\b/i
];

type Conditions = 'el-nino' | 'la-nina' | 'neutral';

/**
 * One case per tendency branch. `registerId` is the entry in
 * planning/references/register.yaml whose `url` the branch must link, and
 * `anom` keeps the fixture coherent so the current-horizon sentence does not
 * report a positive index under a La Nina state.
 */
const BRANCHES: readonly {
  readonly conditions: Conditions;
  readonly registerId: string;
  readonly anom: number;
  readonly says: string;
}[] = [
  { conditions: 'el-nino', registerId: 'usda-nw-hub-el-nino', anom: 1.36, says: 'past El Nino events' },
  { conditions: 'la-nina', registerId: 'usda-nw-hub-la-nina', anom: -1.12, says: 'past La Nina events' },
  { conditions: 'neutral', registerId: 'cpc-enso-composites', anom: 0.1, says: 'no warm-phase or cool-phase composite' }
];

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

/**
 * The URL the references ledger records for one entry, read out of the YAML
 * by id. Deliberately a small text scan rather than a YAML dependency: the
 * point is only that the spec quotes the ledger instead of a literal, so a URL
 * changed in one place and not the other fails here.
 */
function registerUrl(id: string): string {
  const yaml = readFileSync(REGISTER_PATH, 'utf8');
  const block = new RegExp(`^  - id: ${id}\\s*$([\\s\\S]*?)(?=^  - id: |\\Z)`, 'm').exec(yaml);
  if (!block) throw new Error(`no entry "${id}" in planning/references/register.yaml`);
  const url = /^\s*url:\s*"([^"]+)"\s*$/m.exec(block[1]!);
  if (!url) throw new Error(`entry "${id}" in the references ledger carries no url`);
  return url[1]!;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A fresh snapshot pinned to one tendency branch. Fresh because the tendency
 * claim is withheld past HARD_STALE_DAYS, and dating the fixture off "now"
 * rather than off the shipped file keeps the spec from ageing into a skip.
 */
function branchFixture(conditions: Conditions, anom: number): Snapshot {
  const snap = readSnapshot();
  const fresh = daysAgo(1);
  snap.retrieved = fresh;
  for (const key of ['roni', 'oni', 'nino34', 'nino34Weekly', 'soi']) {
    const series = snap[key];
    if (typeof series === 'object' && series !== null && 'published' in series) {
      (series as { published: string }).published = fresh;
    }
  }
  const roni = snap.roni as {
    state?: unknown;
    latest: { anom: number; exceedsThreshold?: boolean; thresholdSide?: string };
  };
  roni.state = {
    conditions,
    episode: conditions,
    direction: 'steady',
    emerging: false,
    threshold: 0.5,
    conditionsRule: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ensofaq.shtml',
    episodeRule: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/'
  };
  roni.latest.anom = anom;
  roni.latest.exceedsThreshold = conditions !== 'neutral';
  roni.latest.thresholdSide =
    conditions === 'el-nino' ? 'above' : conditions === 'la-nina' ? 'below' : 'within';
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
  // DDM-P7-T05 F2: fetchHeatRiskClaims reads the NWS HeatRisk catalog
  // independently of the map layer (DR-014 a), so this boot reaches it too.
  await stubHeatRiskCatalog(page);
  await gotoApp(page, '?view=brief&layers=places&select=state:WA');
}

/**
 * The tendency claim. It stands under the long-range horizon
 * (src/impact/enso.ts, `horizon: 'longRange'`), and with no probabilities
 * block in the snapshot it is the only claim in that cell.
 */
function tendencyClaim(page: Page) {
  return page
    .locator('.impact-hazard[data-horizon="longRange"][data-hazard="enso"] .impact-claim')
    .first();
}

test.describe('DDM-P12-T03: each tilt sentence cites a source and states its season and strength', () => {
  for (const branch of BRANCHES) {
    test(`the ${branch.conditions} tilt sentence is cited, seasoned, hedged and not a forecast`, async ({
      page
    }) => {
      await openBriefing(page, branchFixture(branch.conditions, branch.anom));

      const claim = tendencyClaim(page);
      await expect(claim).toHaveCount(1);
      const text = (await claim.locator('.impact-claim-text').innerText())
        .replace(/\s+/g, ' ')
        .trim();

      // The fixture really did select this branch.
      expect(text, `the ${branch.conditions} fixture did not render its own branch`).toContain(
        branch.says
      );

      // 1. Cites a published source, and cites the one the ledger records.
      const href = await claim.locator('.impact-claim-source a').getAttribute('href');
      expect(
        href,
        `the ${branch.conditions} tilt sentence links a source that is not the one planning/references/register.yaml records for "${branch.registerId}"`
      ).toBe(registerUrl(branch.registerId));

      // 2. States the season and the probabilistic strength its source supports.
      expect(
        SEASON_WORDS.some((re) => re.test(text)),
        `the ${branch.conditions} tilt sentence names no season: "${text}"`
      ).toBe(true);
      expect(
        HEDGE_WORDS.some((re) => re.test(text)),
        `the ${branch.conditions} tilt sentence states a tendency with no hedge: "${text}"`
      ).toBe(true);

      // 3. Implies no forecast the app does not have.
      expectNoForecastLanguage(`the ${branch.conditions} tilt sentence`, text);
    });
  }

  /**
   * The narrowings DR-030's acceptance asks for, pinned so a later edit cannot
   * quietly widen them back. Each was made 2026-09-07 against the live page
   * and each restores a qualifier the issuer states and the app had dropped.
   */
  test('the narrowed clauses hold at the strength their pages state', async ({ page }) => {
    await openBriefing(page, branchFixture('el-nino', 1.36));
    const elNino = (await tendencyClaim(page).locator('.impact-claim-text').innerText())
      .replace(/\s+/g, ' ')
      .trim();

    // The Hub scopes rain-over-snow to WINTER, not to fall and winter, and
    // hedges the consequences twice with drought as the intermediate link.
    expect(elNino).toContain('a drier, warmer winter results in more precipitation falling as rain than snow');
    expect(elNino).toContain('can lead to decreased runoff and less summer water availability');
    expect(elNino).toContain('can in turn contribute to drought and increased wildfire risk');
    // Both issuers bound "on record": "in the modern era", "since 1950".
    expect(elNino).toContain('the three strongest El Ninos on record in the modern era');
    expect(elNino, 'the El Nino tilt sentence dropped the snowpack counter-evidence').toContain(
      'each produced near-normal Washington snowpack'
    );

    // The framing sentence that introduces the counter-evidence, owner-ruled
    // 2026-09-07. It must make a BOUNDED claim about snowpack in one class of
    // event, not rank snowpack against the tendency's other components: no
    // issuer compares the components, which is why the old wording was
    // reported as a stop rather than narrowed.
    expect(elNino).toContain('That tendency has not held for snowpack in the strongest events');
    expect(
      elNino,
      'the snowpack framing ranks components again; no issuer makes that comparison'
    ).not.toContain('least reliable');
    // "strongest", not "largest": the page's own vocabulary throughout is
    // "very strong" and "the strongest El Nino on record", never "large".
    expect(elNino).not.toContain('largest events');
    // ...and it carries the sample-size caveat, attributed to the party that
    // actually wrote it. The near-normal-snowpack finding is a direct quotation
    // from the Deputy Washington State Climatologist; the caveat is the UW
    // College of the Environment article's own narration, outside her quotes,
    // so the sentence names two sources and not one.
    expect(elNino).toContain(
      'the University of Washington College of the Environment report of that finding adds'
    );
    expect(elNino).toContain('hard to say whether it is a real pattern or a small sample');

    await openBriefing(page, branchFixture('la-nina', -1.12));
    const laNina = (await tendencyClaim(page).locator('.impact-claim-text').innerText())
      .replace(/\s+/g, ' ')
      .trim();

    // The Hub's modal is "can lead to", not a settled "has been associated with".
    expect(laNina).toContain('A deeper snowpack can lead to increased runoff');
    expect(laNina).not.toContain('has been associated with');
    // The fine-fuels sentence 46f98f4 deleted stays deleted: no issuer states
    // it as an ENSO teleconnection (report 13, ENSOSCI-09, UNVERIFIED).
    expect(laNina).not.toMatch(/fine fuels|grass-fire/i);
  });
});
