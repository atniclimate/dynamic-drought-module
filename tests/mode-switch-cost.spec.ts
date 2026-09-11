import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gotoApp, awaitQuiescence } from './helpers';
import {
  SWITCHES,
  switchId,
  isCountedRequest,
  strippedUrl,
  tallyUrls,
  emptyRecord,
  mergeRun,
  compareRuns,
  renderReport
} from '../scripts/mode-switch-cost-report.mjs';

/**
 * DDM-P14-T08 microtask 2: the Playwright spec that drives the twelve
 * ordered mode switches among Drought, Heat, Wildfire, and ENSO and records
 * each one's request count and time to quiescence. `scripts/mode-switch-cost-report.mjs`
 * (microtask 1) owns the pure decisions: which requests count, how a run
 * merges into the committed record, and how the record renders. This file
 * owns the browser, the clock, and the one git read.
 *
 * Run it directly with `npm run measure:mode-switch`. It writes nothing to
 * `docs/` unless `DDM_MEASURE_LABEL` is `baseline` or `candidate`; a bare
 * run still prints its numbers and, when a baseline is already committed,
 * still checks that no switch's request count rose.
 */

const VIEWPORT = { width: 1280, height: 800 };

/**
 * The boot query for a mode. Drought is the default display, reached with
 * NO `cluster=` parameter at all (src/config/clusters.ts: `drought`'s
 * `urlToken` is `null`, and src/state/url.ts's `parseShellParams` falls
 * back to `'drought'` on any unmatched token, including absence). The other
 * three modes are their own `urlToken` exactly (`wildfire`, `heat`, `enso`),
 * so `?cluster=<mode>` is correct for them.
 */
function queryForMode(mode: string): string {
  return mode === 'drought' ? '' : `?cluster=${mode}`;
}

interface CountedEntry {
  readonly url: string;
  readonly n: number;
}

interface SwitchResult {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly requests: number;
  readonly quiescentMs: number;
  readonly pendingAtStart: readonly string[];
  readonly counted: readonly CountedEntry[];
}

test.describe('mode-switch cost', () => {
  test('records the cost of all twelve ordered mode switches', async ({ browser }) => {
    test.setTimeout(10 * 60 * 1000);

    const results: SwitchResult[] = [];

    for (const sw of SWITCHES) {
      const id = switchId(sw);
      const context = await browser.newContext({ viewport: VIEWPORT });
      try {
        const page = await context.newPage();

        const fromQuery = queryForMode(sw.from);
        await gotoApp(page, fromQuery);
        const fromBtn = page.locator(`.shell-cluster-btn[data-cluster="${sw.from}"]`);
        await expect(
          fromBtn,
          `${id}: booting with query "${fromQuery}" did not land on the "from" mode "${sw.from}"`
        ).toHaveAttribute('aria-pressed', 'true');

        // Counting starts only now: the boot's own reads are not the
        // switch's cost.
        const appOrigin = new URL(page.url()).origin;
        const countedUrls: string[] = [];
        let requestCount = 0;
        page.on('request', (request) => {
          const url = request.url();
          if (isCountedRequest(url, appOrigin)) {
            requestCount += 1;
            countedUrls.push(strippedUrl(url, appOrigin));
          }
        });

        const toBtn = page.locator(`.shell-cluster-btn[data-cluster="${sw.to}"]`);
        const t0 = Date.now();
        await toBtn.click();

        // One macrotask after the click, so the tracker's own first look
        // (also queued on its own macrotask, src/state/boot-idle.ts) has
        // posted whatever `loading` the click set in motion.
        const startSnapshot = await page.evaluate(
          () =>
            new Promise<{ pendingLayerKeys: string[] } | null>((resolve) => {
              setTimeout(() => {
                const seam = (window as unknown as { __ddm?: { snapshot: () => { pendingLayerKeys: string[] } } }).__ddm;
                resolve(seam ? seam.snapshot() : null);
              }, 0);
            })
        );
        if (startSnapshot === null) {
          throw new Error(`${id}: window.__ddm is not installed; the boot-idle seam never armed`);
        }
        const pendingAtStart = startSnapshot.pendingLayerKeys;

        // Lets a timeout fail the test: awaitQuiescence re-throws the
        // page's own DdmQuiescenceTimeout, naming what was still pending,
        // which is the whole diagnostic value of a miss here.
        await awaitQuiescence(page, 30_000);
        const quiescentMs = Date.now() - t0;

        await expect(
          toBtn,
          `${id}: switching did not commit the "to" mode "${sw.to}"`
        ).toHaveAttribute('aria-pressed', 'true');

        const counted = tallyUrls(countedUrls);
        results.push({ id, from: sw.from, to: sw.to, requests: requestCount, quiescentMs, pendingAtStart, counted });

        console.log(
          `${id}: ${requestCount} requests, ${quiescentMs} ms to quiescence, ` +
            `pending at start = ${JSON.stringify(pendingAtStart)}`
        );
      } finally {
        await context.close();
      }
    }

    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const rawLabel = process.env['DDM_MEASURE_LABEL'];
    const label = rawLabel === 'baseline' ? 'baseline' : 'candidate';
    const run = {
      label,
      commit,
      recordedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      switches: results
    };

    const here = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(here, '..', 'docs', 'mode-switch-cost.json');
    const mdPath = join(here, '..', 'docs', 'MODE_SWITCH_COST.md');

    const existingRecord = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

    if (rawLabel === 'baseline' || rawLabel === 'candidate') {
      const record = existingRecord ?? emptyRecord();
      const merged = mergeRun(record, run);
      writeFileSync(jsonPath, `${JSON.stringify(merged, null, 2)}\n`);
      writeFileSync(mdPath, `${renderReport(merged)}\n`);
    }

    const baselineRun = existingRecord?.runs?.baseline ?? null;
    if (baselineRun && label !== 'baseline') {
      const { rises } = compareRuns(baselineRun, run);
      const detail = rises
        .map((r: { id: string; baseline: number; candidate: number }) => `${r.id} (baseline ${r.baseline} to candidate ${r.candidate})`)
        .join('; ');
      expect(rises, `request count rose for: ${detail}`).toEqual([]);
    } else {
      console.log('mode-switch-cost: no committed baseline run to compare against; skipping the regression check.');
    }
  });
});
