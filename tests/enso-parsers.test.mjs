import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeasonIndex,
  parseNino34Weekly,
  parseSoi
} from '../scripts/build-enso-snapshot.mjs';

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
