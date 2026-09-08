/**
 * Honest horizon chips, and the acceptance sentence of DDM-P8-T03
 * (`docs/ROADMAP.yaml:325`):
 *
 *   "A horizon a hazard cannot answer is absent or visibly disabled with its
 *    reason, and every hazard surface states its time in one grammar with
 *    its forecast register visually distinct from its observed register."
 *
 * This file covers the two clauses this session's rulings (S12, R1-R4)
 * touched:
 *
 *   - "one grammar": the shell's horizon chips (`src/ui/island/shell.tsx`)
 *     now read `HORIZON_CHROME` (`src/impact/horizon-chrome.ts`), the same
 *     table the briefing panel headings already read, instead of the
 *     retired `TEMPORAL_HORIZON_CHIP_LABELS`. No chip, and no other element
 *     in the DOM, still shows the old "Weeks ahead" / "Season ahead" chip
 *     wording. (Clause 1, "absent or visibly disabled with its reason", is
 *     the shell's pre-existing `customHorizonDisabledReason` behaviour and
 *     is not re-tested here.)
 *   - "forecast register visually distinct from its observed register":
 *     every rendered claim now carries exactly one `observed`/`outlook`
 *     text tag beside its source line (`CLAIM_REGISTER_TAG`,
 *     `src/impact/evidence.ts`), derived from the claim's own `evidence`
 *     field, and no `CELL_ABSENCE` note carries one (an absence is
 *     neither).
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
import { gotoApp } from './helpers';

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

async function openBriefing(page: Page, snapshot: Snapshot): Promise<void> {
  await page.route('**/data/enso-indices.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot)
    })
  );
  // The other briefing lanes are stubbed empty: fire, drought and heat cells
  // with no lane declared for their horizon (fire nearTerm/longRange, heat
  // longRange) settle to CELL_ABSENCE, which is exactly what the R4 check
  // below needs.
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

    // Fire nearTerm and longRange, and Heat longRange, have no lane declared
    // for them (matrix.ts LANE_PLACEMENT), so with the other lanes stubbed
    // empty they render CELL_ABSENCE prose, never a claim.
    const absenceCells: ReadonlyArray<readonly ['fire' | 'heat', 'nearTerm' | 'longRange']> = [
      ['fire', 'nearTerm'],
      ['fire', 'longRange'],
      ['heat', 'longRange']
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
