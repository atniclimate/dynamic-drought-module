/**
 * Honest horizon chips, and the acceptance sentence of DDM-P8-T03
 * (`docs/ROADMAP.yaml:325`):
 *
 *   "A horizon a hazard cannot answer is absent or visibly disabled with its
 *    reason, and every hazard surface states its time in one grammar with
 *    its forecast register visually distinct from its observed register."
 *
 * This file covers all three clauses:
 *
 *   - "one grammar": the shell's horizon chips (`src/ui/island/shell.tsx`)
 *     now read `HORIZON_CHROME` (`src/impact/horizon-chrome.ts`), the same
 *     table the briefing panel headings already read, instead of the
 *     retired `TEMPORAL_HORIZON_CHIP_LABELS`. No chip, and no other element
 *     in the DOM, still shows the old "Weeks ahead" / "Season ahead" chip
 *     wording.
 *   - "absent or visibly disabled with its reason" (DDM-P8-T03, DR-017 a):
 *     the shell's `horizonDisabledReason` (renamed from
 *     `customHorizonDisabledReason`, which covered the CUSTOM-composition
 *     case only) now also disables a chip bound to a committed cluster
 *     whose recipe at that horizon is empty or repeats an earlier horizon's
 *     (`horizonSurfaceSignature`, `src/state/timeline.ts`), reached through
 *     `aria-disabled` plus `title` (the pre-existing custom-composition
 *     pattern). A step-3 STOP RULE run found that an always-visible
 *     `.shell-horizon-note` line collides with `.conditions-metric` at the
 *     900x675 tablet band (`tests/interface-responsive.spec.ts`'s "tablet
 *     band" describe), so that visible-text half is deferred pending an
 *     `app.css` grant (DDM-P10-T04 territory); this clause is PARTIAL.
 *   - "forecast register visually distinct from its observed register":
 *     every rendered claim now carries exactly one `observed`/`outlook`
 *     text tag beside its source line (`CLAIM_REGISTER_TAG`,
 *     `src/impact/evidence.ts`), derived from the claim's own `evidence`
 *     field, and no `CELL_ABSENCE` note carries one (an absence is
 *     neither); and `#map-key`'s `data-register` (added this task) mirrors
 *     `#time-bar`'s for the same surface, so the two never disagree.
 *
 * Fixture machinery adapted from `tests/enso-horizons.spec.ts`: the bundled
 * ENSO snapshot, routed through `page.route`, with the other briefing lanes
 * stubbed empty so this file depends on no live agency.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLAIM_REGISTER_TAG, makeClaim } from '../src/impact/evidence';
import { HORIZON_CHROME, SHELL_HORIZON_KEY } from '../src/impact/horizon-chrome';
import { CELL_ABSENCE } from '../src/impact/matrix';
import type { EvidenceClass } from '../src/impact/types';
import { renderClaim } from '../src/ui/claim-render';
import { TEMPORAL_HORIZON_KEYS } from '../src/config/clusters';
import { gotoApp, search, stubHeatRiskCatalog, urlLayers } from './helpers';

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'data', 'enso-indices.json');

interface Snapshot {
  retrieved: string;
  [key: string]: unknown;
}

function withWeekly(): Snapshot {
  const parsed: unknown = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { retrieved?: unknown }).retrieved !== 'string'
  ) {
    throw new Error('malformed bundled ENSO snapshot');
  }
  const snap = parsed as Snapshot;
  if (snap.nino34Weekly === undefined) {
    throw new Error(
      'the bundled snapshot carries no nino34Weekly block; run npm run build:enso'
    );
  }
  return snap;
}

async function openBriefing(
  page: Page,
  snapshot: Snapshot,
  query = '?view=brief&layers=places&select=state:WA'
): Promise<void> {
  await page.route('**/data/enso-indices.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot)
    })
  );
  // The other briefing lanes are stubbed empty: fire cells with no lane
  // declared for their horizon (fire nearTerm/longRange) settle to
  // CELL_ABSENCE, which is exactly what the R4 check below needs. Heat
  // longRange now has a lane (DDM-P7-T07); `gotoApp` stubs its endpoint with
  // a default fixture, so that cell renders a claim, not an absence.
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
  await gotoApp(page, query);
}

// ---------------------------------------------------------------------------
// Shell chips: "one grammar"
// ---------------------------------------------------------------------------

test.describe('DDM-P8-T03: the shell horizon chips read HORIZON_CHROME', () => {
  test('every shell chip title and subtitle equals HORIZON_CHROME, and no chip reads the retired wording', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places');
    for (const key of TEMPORAL_HORIZON_KEYS) {
      const chrome = HORIZON_CHROME[SHELL_HORIZON_KEY[key]];
      const btn = page.locator(`.shell-horizon-btn[data-horizon="${key}"]`);
      const title = (await btn.locator('.shell-horizon-btn-title').innerText()).trim();
      const subtitle = (await btn.locator('.shell-horizon-btn-sub').innerText()).trim();
      expect(title, `${key} chip title`).toBe(chrome.title);
      expect(subtitle, `${key} chip subtitle`).toBe(chrome.subtitle);
    }

    // The retired chip wording must not survive anywhere in the DOM. Scoped
    // to exclude .preset-chip: VIEW_PRESETS' unrelated "Season ahead" scene
    // chip (src/config/presets.ts) coincidentally shares the words but is a
    // different feature, not a temporal horizon, and out of this task's
    // scope.
    const stray = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.preset-chip').forEach((el) => el.remove());
      return /\bWeeks ahead\b|\bSeason ahead\b/.test(clone.textContent ?? '');
    });
    expect(stray, 'the retired chip wording still appears somewhere in the DOM').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim register tags: "forecast register visually distinct from observed"
// ---------------------------------------------------------------------------

/** Every evidence class a claim in this app is built with as of this ruling
 * (src/impact/evidence.ts: modeled and modeled-analysis are unused). */
const USED_EVIDENCE: readonly EvidenceClass[] = [
  'observed',
  'analyzed',
  'classified',
  'derived',
  'outlook'
];

function registerTagIn(html: string): string | null {
  const m = html.match(/<span class="impact-claim-register">([^<]*)<\/span>/);
  return m ? m[1]! : null;
}

test.describe('DDM-P8-T03: every rendered claim carries exactly one observed/outlook tag', () => {
  test('R3: the literal ruling, evidence to tag', () => {
    // "evidence 'outlook' renders \"outlook\"; 'analyzed' and 'derived'
    // render \"observed\"." (R3, owner ruling 2026-09-07)
    expect(CLAIM_REGISTER_TAG.outlook).toBe('outlook');
    expect(CLAIM_REGISTER_TAG.analyzed).toBe('observed');
    expect(CLAIM_REGISTER_TAG.derived).toBe('observed');
    // The identity case R3 does not need to spell out, and this session's
    // extension for 'classified' (not named in R3; same 'observation' tone
    // EVIDENCE_PRESENTATION already gives it).
    expect(CLAIM_REGISTER_TAG.observed).toBe('observed');
    expect(CLAIM_REGISTER_TAG.classified).toBe('observed');
  });

  test('every used evidence class renders exactly one register tag, matching the ruling', () => {
    for (const evidence of USED_EVIDENCE) {
      const claim = makeClaim({
        text: `A ${evidence} statement for the register-tag check.`,
        source: 'Test source',
        evidence,
        dates: { retrieved: '2026-09-07' }
      });
      const html = renderClaim(claim);
      const occurrences = html.split('impact-claim-register').length - 1;
      expect(occurrences, `${evidence} claim tag count`).toBe(1);
      expect(registerTagIn(html), `${evidence} claim tag text`).toBe(
        CLAIM_REGISTER_TAG[evidence]
      );
    }
  });

  test('no register tag word contains "forecast"', () => {
    for (const tag of Object.values(CLAIM_REGISTER_TAG)) {
      expect(tag, `register tag "${tag}"`).not.toMatch(/forecast/i);
    }
  });

  test('live in the browser: the ENSO row across all three horizons carries the ruled tags', async ({
    page
  }) => {
    await openBriefing(page, withWeekly());

    // current: the index-state read (derived -> observed) and the
    // authority + monthly-companion reads (analyzed -> observed).
    const current = page.locator('.impact-hazard[data-horizon="current"][data-hazard="enso"]');
    const currentTags = await current.locator('.impact-claim-register').allInnerTexts();
    expect(currentTags.length, 'enso current claim count').toBeGreaterThan(0);
    for (const tag of currentTags) expect(tag.trim()).toBe('observed');

    // nearTerm: the weekly Nino 3.4 observation (analyzed -> observed),
    // exactly the DR-031 claim this ruling was made for.
    const nearTerm = page.locator('.impact-hazard[data-horizon="nearTerm"][data-hazard="enso"]');
    const nearTermTags = await nearTerm.locator('.impact-claim-register').allInnerTexts();
    expect(nearTermTags.length, 'enso nearTerm claim count').toBeGreaterThan(0);
    for (const tag of nearTermTags) expect(tag.trim()).toBe('observed');

    // longRange: the tendency claim (derived -> observed). The bundled
    // fixture carries no `probabilities` block, so the CPC-odds claim
    // (outlook -> outlook, the one place both tags would render side by
    // side) does not activate here; 'outlook' is proven by the model-level
    // test above instead, against every evidence class the app builds.
    const longRange = page.locator('.impact-hazard[data-horizon="longRange"][data-hazard="enso"]');
    const longRangeTags = await longRange.locator('.impact-claim-register').allInnerTexts();
    expect(longRangeTags.map((t) => t.trim())).toEqual(['observed']);

    // Every claim carries exactly one tag: as many .impact-claim-register
    // elements as .impact-claim elements, in each of the three cells.
    for (const cell of [current, nearTerm, longRange]) {
      const claimCount = await cell.locator('.impact-claim').count();
      const tagCount = await cell.locator('.impact-claim-register').count();
      expect(tagCount).toBe(claimCount);
    }
  });

  test('R4: absence cells carry no tag', async ({ page }) => {
    await openBriefing(page, withWeekly());

    // Fire nearTerm and longRange have no lane declared for them
    // (matrix.ts LANE_PLACEMENT), so with the other lanes stubbed empty they
    // render CELL_ABSENCE prose, never a claim. Heat longRange left this list
    // when DDM-P7-T07 wired the CPC seasonal temperature outlook lane; it now
    // renders a claim (see tests/heat-h2-point-heat.spec.ts).
    const absenceCells: ReadonlyArray<readonly ['fire' | 'heat', 'nearTerm' | 'longRange']> = [
      ['fire', 'nearTerm'],
      ['fire', 'longRange']
    ];
    for (const [hazard, horizon] of absenceCells) {
      const cell = page.locator(
        `.impact-hazard[data-horizon="${horizon}"][data-hazard="${hazard}"]`
      );
      await expect(cell.locator('.impact-horizon-note')).toHaveCount(1);
      await expect(cell.locator('.impact-claim-register')).toHaveCount(0);
      const noteText = (await cell.locator('.impact-horizon-note').innerText()).trim();
      expect(noteText).toBe(CELL_ABSENCE[horizon][hazard]);
    }
  });
});

// ---------------------------------------------------------------------------
// Clause 1: every horizon chip either changes the map or says why not
// ---------------------------------------------------------------------------

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** Empty, deterministic wildfire product fixtures so a wildfire cluster
 * commit in this file depends on no live agency (the same pattern already
 * used for the briefing's fire lane in `openBriefing` above), plus the WHP
 * ImageServer `exportImage` tile behind the DDM proxy (season-ahead). */
async function stubWildfireProducts(page: Page): Promise<void> {
  await page.route(
    (url) =>
      url.href.includes('WFIGS_Interagency_Perimeters_Current') ||
      url.href.includes('NOAA_Satellite_Smoke_Detection') ||
      url.href.includes('/SPC_firewx/MapServer/1/query'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features: [] })
      })
  );
  await page.route('https://ddm-proxy.atniclimate.workers.dev/**', async (route) => {
    const target = new URL(route.request().url()).searchParams.get('url') ?? '';
    if (target.includes('/exportImage')) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

/** The four chips DR-017 a disables: heat season-ahead has an empty
 * recipe, and the other three repeat an earlier horizon's signature
 * (fact 1 of the step plan's ground-truth read: heat current === weeks-
 * ahead; enso is one surface at every horizon). */
const DISABLED_CHIPS: ReadonlySet<string> = new Set([
  'heat:weeks-ahead',
  'heat:season-ahead',
  'enso:weeks-ahead',
  'enso:season-ahead'
]);
const CLUSTER_KEYS = ['drought', 'wildfire', 'heat', 'enso'] as const;

test.describe('DDM-P8-T03 clause 1: every horizon chip either changes the map or says why not', () => {
  test('a chip with no distinct map surface is aria-disabled with a reason', async ({
    page
  }) => {
    await stubWildfireProducts(page);
    // A bare boot, not `openBriefing`'s `layers=places`: a reference-role
    // extra layer surviving a cluster click demotes the commit to
    // 'custom' (src/state/cluster-service.ts applyCluster), which would
    // test the CUSTOM branch of horizonDisabledReason instead of the one
    // this describe is about.
    await gotoApp(page);
    for (const cluster of CLUSTER_KEYS) {
      await page.locator(`.shell-cluster-btn[data-cluster="${cluster}"]`).click();
      for (const key of TEMPORAL_HORIZON_KEYS) {
        const btn = page.locator(`.shell-horizon-btn[data-horizon="${key}"]`);
        const expectDisabled = DISABLED_CHIPS.has(`${cluster}:${key}`);
        if (!expectDisabled) {
          expect(
            await btn.getAttribute('aria-disabled'),
            `${cluster}:${key} should be enabled`
          ).toBeNull();
          continue;
        }
        await expect(btn, `${cluster}:${key} should be disabled`).toHaveAttribute(
          'aria-disabled',
          'true'
        );
        // DDM-P8-T03 step 3 stop rule: an always-visible
        // `.shell-horizon-note` line was tried and reverted (it collided
        // with `.conditions-metric` at the 900x675 tablet band,
        // interface-responsive.spec.ts's "tablet band" describe); the
        // reason still reaches a keyboard or screen-reader user through
        // `title`, the pre-existing custom-composition pattern.
        const title = (await btn.getAttribute('title'))?.trim();
        expect(title, `${cluster}:${key} title`).toBeTruthy();
      }
    }
  });

  test('a disabled chip is a refusal, not a silent no-op', async ({ page }) => {
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    const season = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(season).toHaveAttribute('aria-disabled', 'true');
    const pressedBefore = await season.getAttribute('aria-pressed');
    const layersBefore = await urlLayers(page);
    // force: true because Playwright's actionability check refuses
    // aria-disabled targets; the press reaching the handler and being
    // refused is exactly what this asserts (the pattern at
    // tests/s4-shell.spec.ts:433).
    await season.click({ force: true });
    expect(await season.getAttribute('aria-pressed')).toBe(pressedBefore);
    expect(await search(page)).not.toContain('horizon=');
    expect(await urlLayers(page)).toEqual(layersBefore);
  });

  test('keyboard: a disabled chip keeps its place in the tab order and refuses Enter and Space', async ({
    page
  }) => {
    await gotoApp(page, '?view=brief&layers=places');
    await page.locator('.shell-cluster-btn[data-cluster="enso"]').click();
    const weeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    await expect(weeks).toHaveAttribute('aria-disabled', 'true');
    await weeks.focus();
    await expect(weeks).toBeFocused();
    const pressedBefore = await weeks.getAttribute('aria-pressed');
    await page.keyboard.press('Enter');
    expect(await weeks.getAttribute('aria-pressed')).toBe(pressedBefore);
    await expect(weeks).toBeFocused();
    await page.keyboard.press('Space');
    expect(await weeks.getAttribute('aria-pressed')).toBe(pressedBefore);
    await expect(weeks).toBeFocused();
    expect(await search(page)).not.toContain('horizon=');
  });

  test('the briefing does not drive chip state', async ({ page }) => {
    // No `layers=places`: a reference-role extra surviving a cluster
    // click would demote the commit to 'custom' and mask this clause
    // (see the boot comment above).
    await openBriefing(page, withWeekly(), '?view=brief&select=state:WA');
    await page.locator('.shell-cluster-btn[data-cluster="heat"]').click();
    // The season-ahead chip is disabled on the recipe alone; the briefing
    // cell existing (DDM-P7-T07's claim) is asserted only for existence,
    // never consulted as the reason.
    const heatSeason = page.locator('.shell-horizon-btn[data-horizon="season-ahead"]');
    await expect(heatSeason).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.locator('.impact-hazard[data-horizon="longRange"][data-hazard="heat"]')
    ).toHaveCount(1);

    // The converse: on Drought, weeks-ahead is a real recipe (the CPC
    // monthly outlook) and stays enabled regardless of what the briefing
    // renders for that cell.
    await page.locator('.shell-cluster-btn[data-cluster="drought"]').click();
    const droughtWeeks = page.locator('.shell-horizon-btn[data-horizon="weeks-ahead"]');
    expect(await droughtWeeks.getAttribute('aria-disabled')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Clauses 2 and 3: one grammar, product-specific registers
// ---------------------------------------------------------------------------

/** The ENSO screen's surface: a one-week P1D window and blank tiles, the
 * same stub tests/fire-heat-time-bar.spec.ts and tests/temporal-axis.spec.ts
 * each carry their own copy of. */
async function stubSstFixture(page: Page): Promise<void> {
  await page.route(
    (url) => url.href.includes('DescribeDomains'),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/xml',
        body:
          "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><DimensionDomain>" +
          '<ows:Identifier>time</ows:Identifier>' +
          '<Domain>2026-07-01/2026-07-07/P1D</Domain>' +
          '<Size>1</Size></DimensionDomain></Domains>'
      })
  );
  await page.route(
    (url) => url.href.includes('GHRSST_L4_MUR') && url.pathname.endsWith('.png'),
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX })
  );
}

test.describe('DDM-P8-T03 clauses 2 and 3: one grammar, product-specific registers', () => {
  test.describe('at 390x844 (every hazard family shows a key there)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('each hazard key and its time bar state one register, and the outlook register is not the observed one', async ({
      page
    }) => {
      await stubWildfireProducts(page);
      // Wildfire current: NIFC perimeters, observed.
      await gotoApp(page, '?cluster=wildfire');
      let key = page.locator('#map-key');
      let bar = page.locator('#time-bar');
      await expect(key).toBeVisible();
      await expect(bar).toHaveAttribute('data-register', 'observed');
      await expect(key).toHaveAttribute('data-register', 'observed');

      // Wildfire near term: the SPC fire-weather outlook, outlook register.
      await gotoApp(page, '?cluster=wildfire&horizon=weeks-ahead');
      key = page.locator('#map-key');
      bar = page.locator('#time-bar');
      await expect(key).toBeVisible();
      await expect(bar).toHaveAttribute('data-register', 'outlook');
      await expect(key).toHaveAttribute('data-register', 'outlook');

      // Heat current: whichever register HeatRisk's active day declares
      // (src/layers/heatrisk.ts switches per day); the key must mirror the
      // bar, not claim a fixed value.
      await gotoApp(page, '?cluster=heat');
      key = page.locator('#map-key');
      bar = page.locator('#time-bar');
      await expect(key).toBeVisible();
      const heatBarRegister = await bar.getAttribute('data-register');
      expect(heatBarRegister).not.toBeNull();
      await expect(key).toHaveAttribute('data-register', heatBarRegister!);

      // ENSO: the GHRSST MUR daily field, observed at every horizon.
      await gotoApp(page, '?cluster=enso');
      key = page.locator('#map-key');
      bar = page.locator('#time-bar');
      await expect(key).toBeVisible();
      await expect(bar).toHaveAttribute('data-register', 'observed');
      await expect(key).toHaveAttribute('data-register', 'observed');
    });

    test('the Wildfire Hazard Potential key never claims an outlook register', async ({
      page
    }) => {
      await stubWildfireProducts(page);
      await gotoApp(page, '?cluster=wildfire&horizon=season-ahead');
      const key = page.locator('#map-key');
      const bar = page.locator('#time-bar');
      await expect(bar).toHaveAttribute('data-register', 'observed');
      await expect(key).toHaveAttribute('data-register', 'observed');
      // The key's own accessible name carries the static-edition honesty
      // disclaimer (src/config/wildfire-presentation.ts qualification);
      // the visible label stays 'Wildfire potential', never a dated claim.
      await expect(key).toHaveAttribute('aria-label', /static 2023 edition/);
    });
  });

  test('the horizon grammar is one table across chip, stamp and briefing heading', async ({
    page
  }) => {
    await stubSstFixture(page);
    await gotoApp(
      page,
      '?view=console&cluster=enso&horizon=season-ahead&sst=2026-07-03'
    );
    const chipTitle = (
      await page
        .locator('.shell-horizon-btn[data-horizon="season-ahead"] .shell-horizon-btn-title')
        .innerText()
    ).trim();
    expect(chipTitle).toBe(HORIZON_CHROME.longRange.title);
    // The stamp still says what the surface is (Current Conditions): the
    // pressed chip's horizon and the stamp's own horizon are allowed to
    // diverge and this divergence is PRESERVED, never reconciled (pinned
    // at tests/fire-heat-time-bar.spec.ts:676-694). The SST layer installs
    // its stamp once the ImageServer domain answers; wait for it rather
    // than reading a pre-boot placeholder.
    const stampHorizonEl = page.locator('.time-bar-stamp-horizon');
    // The rendered text is "<title> · <subtitle>" (stampHorizonText,
    // src/ui/time-bar.ts:94-97), not the bare title.
    const expectedStampHorizon = `${HORIZON_CHROME.current.title} · ${HORIZON_CHROME.current.subtitle}`;
    await expect(stampHorizonEl).toHaveText(expectedStampHorizon, { timeout: 25_000 });
    expect(expectedStampHorizon).not.toBe(chipTitle);
    await expect(
      page.locator('.shell-horizon-btn[data-horizon="season-ahead"]')
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
