/**
 * Validate an El Nino / Southern Oscillation (ENSO) snapshot file against
 * the shared consumer contract (scripts/lib/enso-snapshot-contract.mjs).
 *
 * Usage: node scripts/validate-enso-snapshot.mjs <path-to-snapshot.json>
 *
 * Runs a pinned in-script self-test FIRST (the repo's validator pattern;
 * see validate-landscape-artifact.mjs): red fixtures reproducing the
 * 2026-07-28 regression classes must FAIL and the pass fixtures must PASS,
 * or the validator refuses to certify anything. Exit 0 only when the
 * self-test and the target file are both clean. Callers: the gate
 * (check:enso), the scheduled refresh workflow before committing, and any
 * hand run after build:enso.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { rejectEnsoSnapshot, presentSeries } from './lib/enso-snapshot-contract.mjs';

/** A minimal valid seasonal point. */
const P = (over = {}) => ({ seas: 'AMJ', year: 2026, anom: 0.4, preliminary: false, ...over });
/** A minimal valid required series. */
const SERIES = (over = {}) => ({
  sourceUrl: 'https://www.cpc.ncep.noaa.gov/example',
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
  { name: 'not valid JSON', mustPass: false, raw: '{nope' }
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
if (selfTestFailures > 0) {
  console.error(`enso-snapshot validator: self-test failed (${selfTestFailures} case(s)).`);
  process.exit(1);
}
console.log(`enso-snapshot validator: self-test OK (${SELF_TEST.length} pinned cases)`);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/validate-enso-snapshot.mjs <path-to-snapshot.json>');
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
console.log(`${target} is valid (series: ${presentSeries(JSON.parse(raw)).join(', ')})`);
