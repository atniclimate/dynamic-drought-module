/**
 * Validate an El Nino / Southern Oscillation (ENSO) snapshot file against
 * the shared consumer contract (scripts/lib/enso-snapshot-contract.mjs).
 *
 * Usage: node scripts/validate-enso-snapshot.mjs [--offline] <snapshot.json>
 *
 * Runs a pinned in-script self-test FIRST (the repo's validator pattern;
 * see validate-landscape-artifact.mjs): red fixtures reproducing the
 * 2026-07-28 regression classes must FAIL and the pass fixtures must PASS,
 * or the validator refuses to certify anything. Exit 0 only when the
 * self-test and the target file are both clean. Callers: the gate
 * (check:enso), the scheduled refresh workflow before committing, and any
 * hand run after build:enso.
 *
 * FRESHNESS (report 18 section 8 item 4, 2026-09-02). The contract proves the
 * snapshot agrees with itself. It cannot catch a pipeline that is correct and
 * STALE, which is the defect that shipped: for weeks the app told the public
 * ENSO was neutral while CPC held a standing El Nino Advisory. So after the
 * file validates, and only when the network is reachable, this script reads
 * CPC's own "ENSO Alert System Status" line from the URL in the snapshot's
 * `authority` block (one attempt, 8-second budget) and fails the gate when
 * that line contradicts `roni.state.conditions`, printing both texts.
 *
 * The gate must work offline, so an unreachable or unparseable page prints a
 * WARNING and passes. `--offline` skips the read entirely; nothing passes it
 * today, and it exists so a caller that must not touch the network (an air
 * -gapped check, a future verify:quick rung) has a documented way to say so.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  rejectEnsoSnapshot,
  presentSeries,
  readEnsoAlertStatus,
  ensoAlertStatusMismatch,
  CPC_RULE_URLS
} from './lib/enso-snapshot-contract.mjs';

/** A minimal valid seasonal point. */
const P = (over = {}) => ({ seas: 'AMJ', year: 2026, anom: 0.4, preliminary: false, ...over });
/** The three-state block for a neutral fixture (ENSOSCI-04). */
const STATE = (over = {}) => ({
  conditions: 'neutral',
  episode: 'neutral',
  direction: 'steady',
  emerging: false,
  threshold: 0.5,
  conditionsRule: CPC_RULE_URLS.onset,
  episodeRule: CPC_RULE_URLS.episode,
  ...over
});
/** A minimal valid required series. */
const SERIES = (over = {}) => ({
  sourceUrl: 'https://www.cpc.ncep.noaa.gov/example',
  state: STATE(),
  phase: 'neutral',
  latest: P(),
  values: [P(), P(), P(), P(), P()],
  ...over
});
/** A minimal fully valid snapshot (indices-only; optional blocks absent). */
const VALID = () => ({ retrieved: '2026-07-28', oni: SERIES(), roni: SERIES() });

const SELF_TEST = [
  // Pass cases.
  { name: 'valid indices-only snapshot', mustPass: true, make: VALID },
  {
    name: 'valid four-series snapshot',
    mustPass: true,
    make: () => ({
      ...VALID(),
      nino34: {
        sourceUrl: 'https://www.cpc.ncep.noaa.gov/example',
        latest: { year: 2026, month: 6, total: 28.1, climAdjust: 26.6, anom: 1.5 },
        values: [{ year: 2026, month: 6, total: 28.1, climAdjust: 26.6, anom: 1.5 }]
      },
      soi: {
        sourceUrl: 'https://www.cpc.ncep.noaa.gov/example',
        block: 'standardized',
        latest: { year: 2026, month: 6, value: -1.4 },
        values: [{ year: 2026, month: 6, value: -1.4 }]
      }
    })
  },
  // Red fixtures: the regression classes.
  {
    name: 'old two-series builder output (points lack preliminary)',
    mustPass: false,
    make: () => ({
      retrieved: '2026-07-27',
      oni: SERIES({ latest: { seas: 'AMJ', year: 2026, anom: 0.98 }, values: [{ seas: 'MJJ', year: 2023, anom: 0.6 }] }),
      roni: SERIES({ latest: { seas: 'AMJ', year: 2026, anom: 0.47 }, values: [{ seas: 'MJJ', year: 2023, anom: 0.37 }] })
    })
  },
  {
    name: 'one point missing preliminary',
    mustPass: false,
    make: () => {
      const s = VALID();
      const { preliminary, ...rest } = s.roni.values[2];
      s.roni.values[2] = rest;
      return s;
    }
  },
  { name: 'missing roni series', mustPass: false, make: () => ({ retrieved: '2026-07-28', oni: SERIES() }) },
  { name: 'malformed retrieved date', mustPass: false, make: () => ({ ...VALID(), retrieved: 'July 28, 2026' }) },
  {
    name: 'non-finite anomaly',
    mustPass: false,
    make: () => { const s = VALID(); s.oni.latest = P({ anom: 'NaN' }); return s; }
  },
  {
    name: 'fewer than five seasonal values',
    mustPass: false,
    make: () => { const s = VALID(); s.oni.values = [P(), P()]; return s; }
  },
  { name: 'unknown phase', mustPass: false, make: () => { const s = VALID(); s.roni.phase = 'warm'; return s; } },
  {
    name: 'present malformed nino34 (strict transport rejects)',
    mustPass: false,
    make: () => ({ ...VALID(), nino34: { sourceUrl: 'x', latest: { year: 2026 }, values: [] } })
  },
  {
    name: 'present malformed soi (strict transport rejects)',
    mustPass: false,
    make: () => ({ ...VALID(), soi: { sourceUrl: 'x', block: 'raw', latest: { year: 2026, month: 6, value: 1 }, values: [] } })
  },
  {
    name: 'present malformed probabilities (strict transport rejects)',
    mustPass: false,
    make: () => ({ ...VALID(), probabilities: { sourceUrl: 'x', baseline: 'b', issued: null, seasons: [] } })
  },
  { name: 'not valid JSON', mustPass: false, raw: '{nope' },
  // ENSOSCI-01 regression classes. Each red fixture below reproduces one way
  // the headline could go back to reporting a historical classification as
  // the present tense, or could disagree with the numbers under it.
  {
    name: 'valid emerging snapshot (conditions past the threshold, episode not yet)',
    mustPass: true,
    make: () => {
      const s = VALID();
      const latest = P({ seas: 'MJJ', anom: 0.98, preliminary: true, exceedsThreshold: true, thresholdSide: 'above' });
      for (const key of ['oni', 'roni']) {
        s[key] = SERIES({
          state: STATE({ conditions: 'el-nino', direction: 'strengthening', emerging: true }),
          latest,
          values: [P({ anom: -0.9 }), P({ anom: -0.4 }), P({ anom: -0.04 }), P({ anom: 0.49 }), latest]
        });
      }
      return s;
    }
  },
  {
    name: 'series with no state block (pre-ENSOSCI-04 builder)',
    mustPass: false,
    make: () => {
      const s = VALID();
      const { state, ...rest } = s.roni;
      s.roni = rest;
      return s;
    }
  },
  {
    name: 'state.episode disagrees with the legacy phase alias',
    mustPass: false,
    make: () => { const s = VALID(); s.roni = SERIES({ phase: 'el-nino' }); return s; }
  },
  {
    name: 'state.conditions does not follow from the newest season',
    mustPass: false,
    make: () => {
      const s = VALID();
      s.roni = SERIES({ latest: P({ anom: 0.98 }), state: STATE({ conditions: 'neutral' }) });
      return s;
    }
  },
  {
    name: 'state.emerging does not follow from conditions and episode',
    mustPass: false,
    make: () => {
      const s = VALID();
      s.roni = SERIES({ latest: P({ anom: 0.98 }), state: STATE({ conditions: 'el-nino', emerging: false }) });
      return s;
    }
  },
  {
    name: 'unknown direction word',
    mustPass: false,
    make: () => { const s = VALID(); s.roni = SERIES({ state: STATE({ direction: 'rising' }) }); return s; }
  },
  {
    name: 'state rule links are not https',
    mustPass: false,
    make: () => { const s = VALID(); s.roni = SERIES({ state: STATE({ conditionsRule: 'cpc.noaa.gov' }) }); return s; }
  },
  {
    name: 'latest.thresholdSide disagrees with the newest season',
    mustPass: false,
    make: () => {
      const s = VALID();
      s.roni = SERIES({ latest: P({ anom: 0.4, exceedsThreshold: true, thresholdSide: 'above' }) });
      return s;
    }
  },
  {
    name: 'present malformed sourceQuotes (strict transport rejects)',
    mustPass: false,
    make: () => ({ ...VALID(), sourceQuotes: [{ text: 'x', source: 'y', url: 'http://insecure' }] })
  },
  {
    name: 'valid snapshot with authority, method, and sourceQuotes',
    mustPass: true,
    make: () => ({
      ...VALID(),
      sourceQuotes: [
        { text: 'a verbatim issuer definition', source: 'NOAA CPC', url: CPC_RULE_URLS.onset }
      ],
      roni: SERIES({
        authority: {
          product: 'NOAA CPC ENSO Diagnostic Discussion (official ENSO status)',
          url: CPC_RULE_URLS.discussion,
          cadence: 'monthly, second Thursday',
          definitionsUrl: CPC_RULE_URLS.statusDefinitions
        },
        method: {
          index: '3 month running mean',
          basePeriod: '1991-2020',
          sstVersion: 'ERSSTv6',
          revisionWindowMonths: 2,
          updateCadence: 'by the 5th of each month',
          methodUrl: CPC_RULE_URLS.episode
        }
      })
    })
  },
  {
    name: 'present malformed authority (strict transport rejects)',
    mustPass: false,
    make: () => {
      const s = VALID();
      s.roni = SERIES({ authority: { product: 'x', url: CPC_RULE_URLS.discussion, cadence: 'monthly' } });
      return s;
    }
  }
];

/**
 * The freshness half's pinned self-test (report 18 section 8 item 4). Every
 * `page` below is STUBBED text, so these cases run with no network and pin
 * both halves of the check: that the status line is read out of CPC's real
 * markup, and that each status constrains `state.conditions` the way CPC's
 * own definitions say it should.
 *
 * The first case is the regression this gate exists to stop: the live
 * markup as CPC served it on 2026-09-02 (tags, entities and all) against the
 * `neutral` the app was publishing at the same moment.
 */
const CPC_LIVE_MARKUP =
  '<p><strong>ENSO Alert System Status: </font>\n' +
  '<a href="./enso-alert-readme.shtml" class="homepagelinks">\n' +
  '<font face="verdana,arial,serif" size="2">\n' +
  '<span style="color:red">El Ni&ntilde;o Advisory</span>\n' +
  '</strong></font></a></p>\n' +
  '<p>Synopsis: &nbsp; El Ni&ntilde;o is strengthening, with a greater than 90&#37; chance.</p>';

const ALERT_SELF_TEST = [
  { name: 'live CPC markup reads as an El Nino Advisory', page: CPC_LIVE_MARKUP, status: 'el-nino-advisory', raw: 'El Nino Advisory' },
  { name: 'El Nino Advisory beside el-nino conditions agrees', page: CPC_LIVE_MARKUP, conditions: 'el-nino', mismatch: false },
  { name: 'El Nino Advisory beside neutral conditions is the shipped defect', page: CPC_LIVE_MARKUP, conditions: 'neutral', mismatch: true },
  { name: 'El Nino Advisory beside la-nina conditions is a mismatch', page: CPC_LIVE_MARKUP, conditions: 'la-nina', mismatch: true },
  { name: 'La Nina Advisory reads and agrees with la-nina', page: 'ENSO Alert System Status: <b>La Ni&ntilde;a Advisory</b> Synopsis: ...', status: 'la-nina-advisory', conditions: 'la-nina', mismatch: false },
  { name: 'La Nina Advisory beside neutral conditions is a mismatch', page: 'ENSO Alert System Status: La Ni&ntilde;a Advisory Synopsis: ...', conditions: 'neutral', mismatch: true },
  { name: 'an inactive alert system agrees with neutral', page: 'ENSO Alert System Status: NA: ENSO Alert System is not active. Synopsis: ...', status: 'not-active', conditions: 'neutral', mismatch: false },
  { name: 'an inactive alert system beside el-nino conditions is a mismatch', page: 'ENSO Alert System Status: Not Active', status: 'not-active', conditions: 'el-nino', mismatch: true },
  { name: 'an El Nino Watch accepts neutral (a Watch precedes onset)', page: 'ENSO Alert System Status: El Ni&ntilde;o Watch Synopsis: ...', status: 'el-nino-watch', conditions: 'neutral', mismatch: false },
  { name: 'an El Nino Watch accepts el-nino (the first season may already be past the threshold)', page: 'ENSO Alert System Status: El Ni&ntilde;o Watch', conditions: 'el-nino', mismatch: false },
  { name: 'an El Nino Watch beside la-nina conditions is the opposite phase', page: 'ENSO Alert System Status: El Ni&ntilde;o Watch', conditions: 'la-nina', mismatch: true },
  { name: 'a Final La Nina Advisory accepts neutral (conditions have ended)', page: 'ENSO Alert System Status: Final La Ni&ntilde;a Advisory Synopsis: ...', status: 'la-nina-final-advisory', conditions: 'neutral', mismatch: false },
  { name: 'a Final La Nina Advisory beside el-nino conditions is the opposite phase', page: 'ENSO Alert System Status: Final La Ni&ntilde;a Advisory', conditions: 'el-nino', mismatch: true },
  { name: 'a page without the status line is unparseable, not a finding', page: '<html><body>CPC is doing maintenance.</body></html>', status: null },
  { name: 'a status line naming both phases is unparseable, not a finding', page: 'ENSO Alert System Status: El Ni&ntilde;o or La Ni&ntilde;a Advisory', status: null },
  { name: 'a status line this reader does not know is unparseable, not a finding', page: 'ENSO Alert System Status: Under review', status: null }
];

let selfTestFailures = 0;
for (const t of SELF_TEST) {
  const input = t.raw !== undefined ? t.raw : t.make();
  const reason = rejectEnsoSnapshot(input);
  const passed = reason === null;
  if (passed !== t.mustPass) {
    selfTestFailures += 1;
    console.error(
      `self-test FAILED: ${t.name}: expected ${t.mustPass ? 'pass' : 'fail'}, got ` +
      `${passed ? 'pass' : `fail (${reason})`}`
    );
  }
}
for (const t of ALERT_SELF_TEST) {
  const read = readEnsoAlertStatus(t.page);
  if (t.status !== undefined) {
    const got = read === null ? null : read.status;
    if (got !== t.status) {
      selfTestFailures += 1;
      console.error(`self-test FAILED: ${t.name}: expected status ${t.status}, got ${got}`);
      continue;
    }
    if (t.raw !== undefined && read.raw !== t.raw) {
      selfTestFailures += 1;
      console.error(`self-test FAILED: ${t.name}: expected raw "${t.raw}", got "${read.raw}"`);
      continue;
    }
  }
  if (t.conditions !== undefined) {
    if (read === null) {
      selfTestFailures += 1;
      console.error(`self-test FAILED: ${t.name}: the status line did not parse, so the comparison could not run`);
      continue;
    }
    const problem = ensoAlertStatusMismatch(read.status, t.conditions);
    if ((problem !== null) !== t.mismatch) {
      selfTestFailures += 1;
      console.error(
        `self-test FAILED: ${t.name}: expected ${t.mismatch ? 'a mismatch' : 'agreement'}, got ` +
        `${problem === null ? 'agreement' : `a mismatch (${problem})`}`
      );
    }
  }
}
if (selfTestFailures > 0) {
  console.error(`enso-snapshot validator: self-test failed (${selfTestFailures} case(s)).`);
  process.exit(1);
}
console.log(
  `enso-snapshot validator: self-test OK (${SELF_TEST.length} pinned contract cases, ` +
  `${ALERT_SELF_TEST.length} pinned CPC status cases)`
);

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const target = args.find((arg) => !arg.startsWith('--'));
const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--offline');
if (!target || unknown.length > 0) {
  if (unknown.length > 0) console.error(`enso-snapshot validator: unknown option ${unknown[0]}`);
  console.error('usage: node scripts/validate-enso-snapshot.mjs [--offline] <path-to-snapshot.json>');
  process.exit(1);
}
let raw;
try {
  raw = readFileSync(target, 'utf8');
} catch (err) {
  console.error(`enso-snapshot validator: cannot read ${target}: ${err.message}`);
  process.exit(1);
}
const reason = rejectEnsoSnapshot(raw);
if (reason !== null) {
  console.error(`${target} FAILS the consumer contract: ${reason}`);
  process.exit(1);
}
const parsed = JSON.parse(raw);
const roniState = parsed.roni?.state;
const stateLine = roniState
  ? `; RONI conditions=${roniState.conditions} episode=${roniState.episode} ` +
    `direction=${roniState.direction} emerging=${roniState.emerging}`
  : '';
console.log(`${target} is valid (series: ${presentSeries(parsed).join(', ')})${stateLine}`);

/**
 * One attempt, 8 seconds, no retry: this is a freshness cross-check, not a
 * data path, and hard rule 7 wants network work bounded. Every failure mode
 * except a proved contradiction warns and passes, so the gate still runs on a
 * plane.
 */
const STATUS_FETCH_TIMEOUT_MS = 8000;

async function checkAgainstCpcStatus() {
  const conditions = roniState?.conditions;
  const authority = parsed.roni?.authority ?? parsed.oni?.authority;
  const url = authority?.url;
  if (typeof conditions !== 'string' || typeof url !== 'string') {
    console.warn(
      'enso-snapshot validator: WARNING the snapshot carries no roni.state.conditions or no ' +
      'authority url, so CPC\'s status line was not read. The contract check above still stands.'
    );
    return;
  }
  let page;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(STATUS_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    page = await response.text();
  } catch (err) {
    console.warn(
      `enso-snapshot validator: WARNING could not read ${url} (${err.message}). The CPC status ` +
      'cross-check was skipped and the gate passes; it is a freshness check, not a contract check.'
    );
    return;
  }
  const read = readEnsoAlertStatus(page);
  if (read === null) {
    console.warn(
      `enso-snapshot validator: WARNING ${url} answered, but no "ENSO Alert System Status" line ` +
      'this reader understands was found. The cross-check was skipped and the gate passes.'
    );
    return;
  }
  const problem = ensoAlertStatusMismatch(read.status, conditions);
  if (problem === null) {
    console.log(
      `CPC status cross-check: "ENSO Alert System Status: ${read.raw}" is consistent with ` +
      `roni.state.conditions=${conditions}.`
    );
    return;
  }
  const latest = parsed.roni?.latest;
  console.error('');
  console.error(`${target} DISAGREES with the issuer's own ENSO status.`);
  console.error(`  CPC (${url}):`);
  console.error(`    ENSO Alert System Status: ${read.raw}`);
  console.error(`  ${target} (retrieved ${parsed.retrieved}):`);
  console.error(
    `    roni.state.conditions = ${conditions} (episode ${roniState.episode}, newest season ` +
    `${latest?.seas} ${latest?.year} ${latest?.anom})`
  );
  console.error(`  ${problem}`);
  console.error('  Rebuild with `npm run build:enso`. If the snapshot is already current, CPC has');
  console.error('  changed what it publishes and this reader needs updating, not the data.');
  // `exitCode`, not `process.exit(1)`: calling exit() while the fetch's
  // sockets are still open trips a libuv assertion on Windows and reports 127
  // instead of 1. Letting the event loop drain gives a clean, portable 1.
  process.exitCode = 1;
}

if (offline) {
  console.log('CPC status cross-check: skipped (--offline).');
} else {
  await checkAgainstCpcStatus();
}
