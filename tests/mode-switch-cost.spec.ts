import { test, expect, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gotoApp, awaitQuiescence } from './helpers';
import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS } from '../src/config/clusters';
import {
  SWITCHES,
  switchId,
  classifyRequest,
  strippedUrl,
  tallyUrls,
  compareRuns,
  renderReport,
  shouldCompareToBaseline,
  measurementProfiles,
  bootQuery,
  fingerprintFrom,
  planMeasurementWrite
} from '../scripts/mode-switch-cost-report.mjs';

/**
 * DDM-P14-T08 microtask 2: the Playwright spec that drives the twelve
 * ordered mode switches among Drought, Heat, Wildfire, and ENSO and records
 * each one's request count and time to quiescence. `scripts/mode-switch-cost-report.mjs`
 * (microtask 1) owns the pure decisions: which requests count, how a run
 * merges into the committed record, and how the record renders. This file
 * owns the browser, the clock, and the one git read.
 *
 * Correction 2 (this file): the regression gate compares DATA reads only
 * (`classifyRequest`'s `'data'` verdict), not the raw request total.
 * Raster map tiles (`'tile'`) dominate a switch's traffic and their count
 * depends on viewport timing and on how much of the previous mode's tile
 * streaming was still in flight, not on what the app did differently; a
 * tile count is recorded for every switch but never gates. Both counts
 * are merged into `requests` (the raw total) for the committed record's
 * own visibility.
 *
 * Run it directly with `npm run measure:mode-switch`. It writes nothing to
 * `docs/` unless `DDM_MEASURE_LABEL` is `baseline` or `candidate`; a bare
 * run still prints its numbers and, when a baseline is already committed,
 * still checks that no switch's data-read count rose.
 *
 * The write decision runs through `writePolicy` (DDM-P14-T08 provenance
 * guard): a `baseline` or `candidate` run on a clean tree (`git status
 * --porcelain` empty) writes the committed record; the same run on a dirty
 * tree throws instead, because the stamped commit would not contain the
 * code that produced the numbers. A record that cites a commit it does not
 * match is worse than no record.
 *
 * Two measurement PROFILEs (`DDM_MEASURE_PROFILE=wa|conus|both`, default
 * `wa`; DDM-P14-T08 review finding C4): `wa` pins every switch's boot to
 * `region=washington_state` and is otherwise the boot this file measured
 * before any profile existed (the default region was then
 * `washington_state`); it is the only profile ever compared against the
 * committed `runs.baseline`. `conus` pins `region=national` (the region D1
 * makes the default) and stores its run under its own
 * `runs.conusBaseline` / `runs.conusCandidate` keys (`mergeRun`'s
 * `runKey`); it never runs the no-rise comparison against the Washington
 * baseline, because the two profiles frame different regions. `bootQuery`
 * builds every boot from the cluster's `urlToken` in src/config/clusters.ts.
 *
 * Recording both profiles (C4R U10 follow-up, Codex J6 and M1):
 * `DDM_MEASURE_PROFILE=both` measures every profile inside this one test,
 * reads the tree's fingerprint (`fingerprintFrom`) before the first switch
 * and after the last, and writes ONE record holding every profile's run
 * (`planMeasurementWrite`). The dirty guard exempts nothing, its own two
 * artifacts included, so two single-profile invocations cannot both write
 * (the first write dirties the tree); one `both` invocation records both
 * on one clean fingerprint. A committed baseline is never overwritten, and
 * no candidate exists without a baseline: a real-labelled run (`baseline` or
 * `candidate`) of a profile with no baseline records as its first baseline,
 * and one of a profile that already has one records as that profile's
 * candidate (`planMeasurementWrite`'s write-once rule).
 */

const VIEWPORT = { width: 1280, height: 800 };

/**
 * A mode's `urlToken` from the cluster table (src/config/clusters.ts), so
 * the boot query never branches on a mode name: the default display's
 * token is `null` and `bootQuery` boots it with no `cluster=` at all.
 */
function urlTokenFor(mode: string): string | null {
  const key = HAZARD_CLUSTER_KEYS.find((candidate) => candidate === mode);
  if (key === undefined) {
    throw new Error(`mode-switch-cost: "${mode}" is not a cluster key in src/config/clusters.ts`);
  }
  return HAZARD_CLUSTERS[key].urlToken;
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
  readonly dataRequests: number;
  readonly tileRequests: number;
  readonly quiescentMs: number;
  readonly pendingAtStart: readonly string[];
  readonly counted: readonly CountedEntry[];
  readonly tiles: readonly CountedEntry[];
}

test.describe('mode-switch cost', () => {
  /**
   * Measures every ordered switch in SWITCHES once under `profile`, each in
   * a fresh browser context booted at the profile's region (`bootQuery`).
   */
  async function measureProfile(browser: Browser, profile: string): Promise<SwitchResult[]> {
    const results: SwitchResult[] = [];

    for (const sw of SWITCHES) {
      const id = switchId(sw);
      // Diagnostics name the profile too; the recorded `id` stays the
      // switch id, the key `compareRuns` and `renderReport` match on.
      const where = `${profile} ${id}`;
      const context = await browser.newContext({ viewport: VIEWPORT });
      try {
        const page = await context.newPage();

        const fromQuery = bootQuery({ urlToken: urlTokenFor(sw.from), profile });
        // J12 opt-out: the recorded baseline (0c27ab1) measured the live WFIGS
        // and NADM reads; the NADM fixture default (b872c7e) came after it.
        // The NWS WWA default stub (S30D P2-CI) came after the baseline too:
        // its heat boots measured the live WWA read.
        await gotoApp(page, fromQuery, { nifc: 'live', nadm: 'live', nwsWwa: 'live' });
        const fromBtn = page.locator(`.shell-cluster-btn[data-cluster="${sw.from}"]`);
        await expect(
          fromBtn,
          `${where}: booting with query "${fromQuery}" did not land on the "from" mode "${sw.from}"`
        ).toHaveAttribute('aria-pressed', 'true');

        // Counting starts only now: the boot's own reads are not the
        // switch's cost. Data reads gate; tile reads are recorded but
        // never gate (see the file doc comment above).
        const appOrigin = new URL(page.url()).origin;
        const dataUrls: string[] = [];
        const tileUrls: string[] = [];
        page.on('request', (request) => {
          const url = request.url();
          const verdict = classifyRequest(url, appOrigin);
          if (verdict === 'data') {
            dataUrls.push(strippedUrl(url, appOrigin));
          } else if (verdict === 'tile') {
            tileUrls.push(strippedUrl(url, appOrigin));
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
          throw new Error(`${where}: window.__ddm is not installed; the boot-idle seam never armed`);
        }
        const pendingAtStart = startSnapshot.pendingLayerKeys;

        // Lets a timeout fail the test: awaitQuiescence re-throws the
        // page's own DdmQuiescenceTimeout, naming what was still pending,
        // which is the whole diagnostic value of a miss here.
        await awaitQuiescence(page, 30_000);
        const quiescentMs = Date.now() - t0;

        await expect(
          toBtn,
          `${where}: switching did not commit the "to" mode "${sw.to}"`
        ).toHaveAttribute('aria-pressed', 'true');

        const counted = tallyUrls(dataUrls);
        const tiles = tallyUrls(tileUrls);
        const dataRequests = dataUrls.length;
        const tileRequests = tileUrls.length;
        results.push({
          id,
          from: sw.from,
          to: sw.to,
          requests: dataRequests + tileRequests,
          dataRequests,
          tileRequests,
          quiescentMs,
          pendingAtStart,
          counted,
          tiles
        });

        console.log(
          `${where}: ${dataRequests} data reads, ${tileRequests} tile requests, ` +
            `${quiescentMs} ms to quiescence, pending at start = ${JSON.stringify(pendingAtStart)}`
        );
      } finally {
        await context.close();
      }
    }

    return results;
  }

  /** The tree's code fingerprint now: short HEAD and the porcelain line count. */
  function readFingerprint(): { commit: string; dirty: number } {
    return fingerprintFrom({
      head: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }),
      porcelain: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
    });
  }

  test('records the cost of all twelve ordered mode switches', async ({ browser }) => {
    // DDM-P14-T08 review finding C4 and the C4R U10 follow-up: the profiles
    // decide which region every switch boots at and, downstream, whether a
    // run is ever compared against the committed Washington baseline
    // (`shouldCompareToBaseline`). `both` measures every profile here.
    const profiles = measurementProfiles(process.env['DDM_MEASURE_PROFILE']);
    test.setTimeout(profiles.length * 10 * 60 * 1000);

    // One fingerprint for every profile: read before the first switch and
    // after the last; `planMeasurementWrite` refuses a write unless both
    // reads are clean and name the same commit.
    const before = readFingerprint();
    const measured: { profile: string; switches: SwitchResult[] }[] = [];
    for (const profile of profiles) {
      measured.push({ profile, switches: await measureProfile(browser, profile) });
    }
    const after = readFingerprint();

    const here = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(here, '..', 'docs', 'mode-switch-cost.json');
    const mdPath = join(here, '..', 'docs', 'MODE_SWITCH_COST.md');

    const existingRecord = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, 'utf8')) : null;

    // The write decision is keyed on the RAW env label: a bare run
    // (DDM_MEASURE_LABEL unset or some other value) is always 'skip', never
    // 'write' or 'refuse', no matter how dirty the tree is (writePolicy's
    // contract, applied by planMeasurementWrite at both fingerprint reads).
    const rawLabel = process.env['DDM_MEASURE_LABEL'];
    const plan = planMeasurementWrite({
      record: existingRecord,
      measured,
      rawLabel,
      before,
      after,
      recordedAt: new Date().toISOString(),
      viewport: VIEWPORT
    });

    for (const run of plan.runs) {
      if (rawLabel === 'baseline' && run.label !== 'baseline') {
        console.log(
          `mode-switch-cost: the ${run.profile} profile already has a committed baseline; this ` +
            'run records as its candidate, and the committed baseline is never overwritten.'
        );
      } else if (rawLabel === 'candidate' && run.label === 'baseline') {
        console.log(
          `mode-switch-cost: the ${run.profile} profile has no committed baseline yet; this ` +
            'candidate-labelled run records as its first baseline, so no candidate exists without one.'
        );
      }
    }

    if (plan.policy === 'write') {
      // One write of one record holding every measured profile's run.
      writeFileSync(jsonPath, `${JSON.stringify(plan.record, null, 2)}\n`);
      writeFileSync(mdPath, `${renderReport(plan.record)}\n`);
    } else if (plan.policy === 'refuse') {
      throw new Error(
        `mode-switch-cost: ${plan.reason}, so commit \`${after.commit}\` is not one clean ` +
          'fingerprint of the code that produced these numbers. The artifact was NOT written: ' +
          'a record must cite a commit that contains the code that produced it. Commit or ' +
          'stash the working tree, then re-run the measurement. To record several profiles, ' +
          'measure them in one invocation (DDM_MEASURE_PROFILE=both): the guard counts the ' +
          'two artifacts too, so a second invocation after a first one wrote is refused.'
      );
    }

    // DDM-P14-T08 review finding C4: only a `wa` run is ever compared
    // against the committed Washington baseline (`shouldCompareToBaseline`).
    // A `conus` run records under its own key (`runKey`) and never reaches
    // this comparison, so a national run can never fail, or misleadingly
    // pass, a no-rise check keyed to a different region.
    const baselineRun = existingRecord?.runs?.baseline ?? null;
    for (const run of plan.runs) {
      if (baselineRun && shouldCompareToBaseline(run)) {
        const { rises } = compareRuns(baselineRun, run);
        const detail = rises
          .map(
            (r: { id: string; baselineData: number; candidateData: number }) =>
              `${r.id} (baseline ${r.baselineData} to candidate ${r.candidateData})`
          )
          .join('; ');
        expect(rises, `${run.profile} data-read count rose for: ${detail}`).toEqual([]);
      } else if (run.profile === 'conus') {
        console.log(
          'mode-switch-cost: conus profile recorded under its own key; the wa/Washington ' +
            'no-rise comparison never runs against a national run.'
        );
      } else {
        console.log(
          `mode-switch-cost: no committed baseline to compare the ${run.profile} ${run.label} ` +
            'run against; skipping the regression check.'
        );
      }
    }
  });
});
