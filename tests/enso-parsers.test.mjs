import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeasonIndex,
  parseNino34,
  parseNino34Weekly,
  parseSoi,
  assertRecentWhenUndated
} from '../scripts/build-enso-snapshot.mjs';

test('assertRecentWhenUndated refuses a stale series only when CPC sent no Last-Modified date', () => {
  const now = new Date(Date.UTC(2026, 10, 6));
  const roni = (seas, year, published) => ({ published, latest: { seas, year } });
  const weekly = (month, day, published) => ({ published, latest: { year: 2026, month, day } });
  const fresh = weekly(10, 28, null);
  // JAS ends in September: two months behind November passes, JJA's August
  // end passes at three, MAM's May end fails at six.
  assert.doesNotThrow(() => assertRecentWhenUndated(roni('JAS', 2026, null), fresh, now));
  assert.doesNotThrow(() => assertRecentWhenUndated(roni('JJA', 2026, null), fresh, now));
  assert.throws(() => assertRecentWhenUndated(roni('MAM', 2026, null), fresh, now), /RONI/);
  // NDJ 2025 ends in January 2026 (the label carries the centre month's year).
  assert.throws(() => assertRecentWhenUndated(roni('NDJ', 2025, null), fresh, now), /RONI/);
  assert.throws(() => assertRecentWhenUndated(roni('JAS', 2026, null), weekly(10, 1, null), now), /weekly/);
  // A dated file is aged by the app from that date, so the build does not refuse it.
  assert.doesNotThrow(() =>
    assertRecentWhenUndated(roni('MAM', 2026, '2026-06-05'), weekly(10, 1, '2026-10-05'), now)
  );
});

// Inline samples in the CPC layouts the parsers document. Each parser has a
// minimum-length floor, so the filler rows are generated; the rows under test
// are written out by hand.

test('parseSeasonIndex reads RONI rows and rejects a fused row and a swapped header', () => {
  const rows = ['DJF 2025 -0.50', 'JFM 2025 -0.40', 'FMA 2025 -0.30', 'MAM 2025 -0.10', 'AMJ 2025 0.20', 'MJJ 2025 0.45'];
  const text = ['SEAS  YR   ANOM', ...rows].join('\n');
  const records = parseSeasonIndex(text, 'SEAS YR ANOM', 'RONI');
  assert.equal(records.length, 6);
  assert.deepEqual(records.at(-1), { seas: 'MJJ', year: 2025, anom: 0.45 });

  const fused = text.replace('MJJ 2025 0.45', 'MJJ 2025-0.45');
  assert.throws(() => parseSeasonIndex(fused, 'SEAS YR ANOM', 'RONI'), /schema check failed/);
  assert.throws(() => parseSeasonIndex(text, 'SEAS YR TOTAL ANOM', 'RONI'), /schema check failed/);
});

// The header and newest twelve rows of CPC's monthly file at
// https://www.cpc.ncep.noaa.gov/data/indices/detrend.nino34.ascii.txt
// (Last-Modified 2026-11-03), copied verbatim. The file carries no missing
// value sentinel; its newest row is the newest analyzed month.
const NINO34_CURRENT = [
  ' YR   MON  TOTAL ClimAdjust ANOM',
  '2025  11   25.99   26.71   -0.72',
  '2025  12   25.99   26.53   -0.54',
  '2026   1   25.93   26.44   -0.52',
  '2026   2   26.55   26.66   -0.11',
  '2026   3   27.25   27.22    0.03',
  '2026   4   28.23   27.79    0.43',
  '2026   5   28.82   27.88    0.94',
  '2026   6   29.18   27.71    1.47',
  '2026   7   29.07   27.29    1.78',
  '2026   8   29.05   26.87    2.17',
  '2026   9   29.26   26.71    2.55',
  '2026  10   29.39   26.71    2.68'
].join('\n');

test('parseNino34 reads the current CPC monthly file through October 2026', () => {
  const records = parseNino34(NINO34_CURRENT);
  assert.equal(records.length, 12);
  assert.deepEqual(records.at(-1), { year: 2026, month: 10, total: 29.39, climAdjust: 26.71, anom: 2.68 });
  assert.deepEqual(records[1], { year: 2025, month: 12, total: 25.99, climAdjust: 26.53, anom: -0.54 });
});

test('parseNino34 throws on a renamed column or a missing month', () => {
  assert.throws(() => parseNino34(NINO34_CURRENT.replace('ClimAdjust', 'CLIM')), /schema check failed/);
  const gap = NINO34_CURRENT.split('\n').filter((line) => !line.startsWith('2026   9')).join('\n');
  assert.throws(() => parseNino34(`${gap}\n2026  11   29.40   26.70    2.70`), /consecutive chronology/);});

function weekLabel(index) {
  const d = new Date(Date.UTC(2025, 8, 3 + 7 * index));
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${String(d.getUTCDate()).padStart(2, '0')}${months[d.getUTCMonth()]}${d.getUTCFullYear()}`;
}

function weeklyText({ region = 'Nino1+2 Nino3 Nino34 Nino4', lastTwo }) {
  const filler = Array.from(
    { length: 52 },
    (_, i) => ` ${weekLabel(i)}     25.3 4.6     28.4 3.5     27.0 0.1     29.6 1.0`
  );
  return [
    ' Weekly SST data starts week centered on 3Sep2025',
    `       ${region}`,
    ' Week          SST SSTA     SST SSTA     SST SSTA     SST SSTA',
    ...filler,
    ...lastTwo
  ].join('\n');
}

test('parseNino34Weekly reads Nino 3.4 SST and anomaly, including a fused negative', () => {
  const text = weeklyText({
    lastTwo: [
      ` ${weekLabel(52)}     20.6-0.1     28.4 3.5     29.4-0.7     29.6 1.0`,
      ` ${weekLabel(53)}     25.3 4.6     28.4 3.5     29.4 2.7     29.6 1.0`
    ]
  });
  const records = parseNino34Weekly(text);
  assert.equal(records.length, 54);
  const [fused, plain] = records.slice(-2);
  assert.equal(fused.total, 29.4);
  assert.equal(fused.anom, -0.7);
  assert.equal(plain.total, 29.4);
  assert.equal(plain.anom, 2.7);
});

test('parseNino34Weekly throws on a swapped region header', () => {
  const text = weeklyText({
    region: 'Nino1+2 Nino4 Nino3 Nino34',
    lastTwo: [
      ` ${weekLabel(52)}     25.3 4.6     28.4 3.5     29.4 2.7     29.6 1.0`
    ]
  });
  assert.throws(() => parseNino34Weekly(text), /schema check failed/);
});

const SOI_HEADER = 'YEAR   JAN   FEB   MAR   APR   MAY   JUN   JUL   AUG   SEP   OCT   NOV   DEC';
const SOI_FUTURE = Array(12).fill('-999.9').join(' ');

function soiBlock(lastRow) {
  const rows = Array.from({ length: 50 }, (_, i) => `${1975 + i} 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2`);
  return [SOI_HEADER, ...rows, lastRow];
}

test('parseSoi maps the -999.9 sentinel to null and splits a fused -2.4-999.9', () => {
  const standardizedLast = '2025 0.5 0.3 -0.2 0.1 -0.4 -2.4-999.9 -999.9 -999.9 -999.9 -999.9 -999.9';
  const text = [
    'ANOMALY',
    ...soiBlock(`2025 ${SOI_FUTURE}`),
    'STANDARDIZED DATA',
    ...soiBlock(standardizedLast)
  ].join('\n');
  const soi = parseSoi(text);
  assert.equal(soi.block, 'standardized');
  assert.deepEqual(soi.latest, { year: 2025, month: 6, value: -2.4 });
  assert.equal(soi.values.find((v) => v.year === 2025 && v.month === 7).value, null);
});

test('parseSoi throws when a header is swapped', () => {
  const swapped = soiBlock(`2025 ${SOI_FUTURE}`).map((line) =>
    line === SOI_HEADER ? SOI_HEADER.replace('JAN   FEB', 'FEB   JAN') : line
  );
  const text = [...swapped, ...soiBlock(`2025 ${SOI_FUTURE}`)].join('\n');
  assert.throws(() => parseSoi(text), /schema check failed/);
});
