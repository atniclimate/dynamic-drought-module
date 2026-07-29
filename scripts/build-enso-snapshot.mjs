/**
 * Build a snapshot of four National Oceanic and Atmospheric Administration
 * (NOAA) Climate Prediction Center (CPC) El Nino / Southern Oscillation
 * (ENSO) indices into public/data/enso-indices.json.
 *
 * The snapshot carries:
 *   - the Relative Oceanic Nino Index (RONI), CPC's operational ENSO
 *     monitoring index and the application's headline phase;
 *   - the Oceanic Nino Index (ONI), retained for historical continuity;
 *   - the analyzed monthly Nino 3.4 sea surface temperature (SST) anomaly,
 *     retained as a fast-moving companion and never a phase declaration; and
 *   - the standardized Southern Oscillation Index (SOI), retained only as a
 *     supporting ocean-atmosphere agreement flag.
 *
 * All four CPC files are documented machine-readable products served without
 * Cross-Origin Resource Sharing (CORS) headers. They are fetched sequentially
 * at snapshot-build time, attributed to NOAA CPC as public domain U.S.
 * Government works, and bundled locally. No runtime proxy or Worker is used.
 *
 * Re-run with: `npm run build:enso`. Commit the regenerated file.
 *
 * Thresholds: El Nino at index >= +0.5 and La Nina at index <= -0.5, each
 * sustained over five consecutive overlapping three-month seasons; between is
 * neutral. The same phase calculation is retained for the RONI headline and
 * the ONI comparison.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rejectEnsoSnapshot } from './lib/enso-snapshot-contract.mjs';

const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
const RONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt';
const NINO34_URL =
  'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/detrend.nino34.ascii.txt';
const SOI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/soi';

// Named fallback only: NOAA Physical Sciences Laboratory nina34.data
// (https://psl.noaa.gov/data/correlation/nina34.data) uses NOAA Extended
// Reconstructed SST version 6 and a differing climatology basis. It is not
// drop-in interchangeable with the adopted CPC detrended series and is
// deliberately not wired as an automatic failover.

// REMOVED 2026-07-21 (D-0.8.0-011 finding 3, built as T-P0-1): the CPC
// probabilistic-outlook plume was scraped from an HTML table here, which
// violates the no-scraping doctrine. CPC publishes the probabilities as HTML
// only, with no documented machine feed. This observed-state build does not
// restore a plume.
const RECENT_SEASONS = 36;
const RECENT_MONTHS = 36;
const THRESHOLD = 0.5;
const RUN_LENGTH = 5;
const SOI_MISSING = -999.9;
const SEASON_NAMES = [
  'DJF',
  'JFM',
  'FMA',
  'MAM',
  'AMJ',
  'MJJ',
  'JJA',
  'JAS',
  'ASO',
  'SON',
  'OND',
  'NDJ'
];
const SEASONS = new Set(SEASON_NAMES);
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SOI_HEADER = `YEAR ${MONTH_NAMES.join(' ')}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'public', 'data');
const OUT_PATH = join(DATA_DIR, 'enso-indices.json');

function normalized(line) {
  return line.trim().replace(/\s+/g, ' ');
}

function publishedDay(resp, url) {
  const lastModified = resp.headers.get('last-modified');
  if (!lastModified) return null;
  const timestamp = Date.parse(lastModified);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`invalid Last-Modified header "${lastModified}" for ${url}`);
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} for ${url}`);
  return {
    text: await resp.text(),
    published: publishedDay(resp, url)
  };
}

function assertChronologicalKeys(records, keyOf, ordinalOf, label) {
  const seen = new Set();
  let previousKey = null;
  let previousOrdinal = null;
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) throw new Error(`${label} schema check failed: duplicate ${key}`);
    const ordinal = ordinalOf(record);
    if (previousOrdinal !== null && ordinal !== previousOrdinal + 1) {
      throw new Error(
        `${label} schema check failed: expected consecutive chronology after ${previousKey}, found ${key}`
      );
    }
    seen.add(key);
    previousKey = key;
    previousOrdinal = ordinal;
  }
}

/**
 * Parse one CPC three-month index table. The strict header and row-width
 * checks make an upstream schema change fail the build instead of quietly
 * emitting a partial series.
 */
function parseSeasonIndex(text, expectedHeader, label) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headerIndex = lines.findIndex((line) => normalized(line) === expectedHeader);
  if (headerIndex < 0) {
    throw new Error(`${label} schema check failed: expected header "${expectedHeader}"`);
  }

  const expectedColumns = expectedHeader.split(' ').length;
  const records = [];
  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== expectedColumns) {
      throw new Error(`${label} schema check failed: expected ${expectedColumns} columns in "${line}"`);
    }
    const seas = parts[0];
    const year = Number(parts[1]);
    const anom = Number(parts[parts.length - 1]);
    if (!SEASONS.has(seas) || !Number.isInteger(year) || !Number.isFinite(anom)) {
      throw new Error(`${label} schema check failed: malformed row "${line}"`);
    }
    records.push({ seas, year, anom });
  }

  if (records.length < RUN_LENGTH) {
    throw new Error(`${label} schema check failed: only ${records.length} records`);
  }
  assertChronologicalKeys(
    records,
    (record) => `${record.year}-${record.seas}`,
    (record) => record.year * SEASON_NAMES.length + SEASON_NAMES.indexOf(record.seas),
    label
  );
  return records;
}

/**
 * CPC warns that the newest Extended Reconstructed Sea Surface Temperature
 * values can revise for up to two months. Decision 2026-07-24: mark exactly
 * the trailing two ONI and RONI seasons preliminary, and do not extend this
 * flag to the monthly Nino 3.4 series without a separate evidence ruling.
 */
function markPreliminary(records) {
  const firstPreliminary = Math.max(0, records.length - 2);
  return records.map((record, index) => ({
    ...record,
    preliminary: index >= firstPreliminary
  }));
}

function currentPhase(values) {
  const tail = values.slice(-RUN_LENGTH);
  if (tail.length === RUN_LENGTH) {
    if (tail.every((value) => value.anom >= THRESHOLD)) return 'el-nino';
    if (tail.every((value) => value.anom <= -THRESHOLD)) return 'la-nina';
  }
  return 'neutral';
}

async function fetchSeasonIndex(url, expectedHeader, label) {
  const fetched = await fetchText(url);
  const all = markPreliminary(parseSeasonIndex(fetched.text, expectedHeader, label));
  return {
    published: fetched.published,
    phase: currentPhase(all),
    latest: all[all.length - 1],
    values: all.slice(-RECENT_SEASONS)
  };
}

function parseNino34(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const expectedHeader = 'YR MON TOTAL ClimAdjust ANOM';
  const headerIndex = lines.findIndex((line) => normalized(line) === expectedHeader);
  if (headerIndex < 0) {
    throw new Error(`Nino 3.4 schema check failed: expected header "${expectedHeader}"`);
  }

  const records = [];
  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Nino 3.4 schema check failed: expected 5 columns in "${line}"`);
    }
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const total = Number(parts[2]);
    const climAdjust = Number(parts[3]);
    const anom = Number(parts[4]);
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isFinite(total) ||
      !Number.isFinite(climAdjust) ||
      !Number.isFinite(anom)
    ) {
      throw new Error(`Nino 3.4 schema check failed: malformed row "${line}"`);
    }
    records.push({ year, month, total, climAdjust, anom });
  }

  if (records.length < 12) {
    throw new Error(`Nino 3.4 schema check failed: only ${records.length} records`);
  }
  assertChronologicalKeys(
    records,
    (record) => `${record.year}-${record.month}`,
    (record) => record.year * 12 + record.month - 1,
    'Nino 3.4'
  );
  return records;
}

async function fetchNino34() {
  const fetched = await fetchText(NINO34_URL);
  const all = parseNino34(fetched.text);
  return {
    published: fetched.published,
    latest: all[all.length - 1],
    values: all.slice(-RECENT_MONTHS)
  };
}

/**
 * Parse one SOI year-by-month block. Numeric token extraction, instead of
 * whitespace splitting, deliberately handles fused negative columns such as
 * "-2.4-999.9". Exactly 13 numeric tokens are still required on every year
 * row, so fusion tolerance cannot hide a shifted or truncated schema.
 */
function parseSoiBlock(lines, start, end, label) {
  const rows = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index].trim();
    if (!line || !/^\d{4}/.test(line)) continue;
    const tokens = line.match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
    if (tokens.length !== 13) {
      throw new Error(`SOI ${label} schema check failed: expected 13 numeric columns in "${line}"`);
    }
    const year = Number(tokens[0]);
    const months = tokens.slice(1).map((token) => {
      const value = Number(token);
      if (!Number.isFinite(value)) {
        throw new Error(`SOI ${label} schema check failed: invalid value "${token}"`);
      }
      return value === SOI_MISSING ? null : value;
    });
    if (!Number.isInteger(year) || months.length !== 12) {
      throw new Error(`SOI ${label} schema check failed: malformed year row "${line}"`);
    }
    rows.push({ year, months });
  }

  if (rows.length < 50) {
    throw new Error(`SOI ${label} schema check failed: only ${rows.length} year rows`);
  }
  assertChronologicalKeys(
    rows,
    (row) => String(row.year),
    (row) => row.year,
    `SOI ${label}`
  );
  return rows;
}

function parseSoi(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headerIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (normalized(lines[index]) === SOI_HEADER) headerIndexes.push(index);
  }
  if (headerIndexes.length !== 2) {
    throw new Error(`SOI schema check failed: expected two "${SOI_HEADER}" headers, found ${headerIndexes.length}`);
  }

  const anomalyRows = parseSoiBlock(lines, headerIndexes[0] + 1, headerIndexes[1], 'anomaly');
  const standardizedRows = parseSoiBlock(lines, headerIndexes[1] + 1, lines.length, 'standardized');
  if (
    anomalyRows.length !== standardizedRows.length ||
    anomalyRows.some((row, index) => row.year !== standardizedRows[index]?.year)
  ) {
    throw new Error('SOI schema check failed: anomaly and standardized year blocks do not align');
  }

  // Decision 2026-07-24: the STANDARDIZED second block is the sole block used
  // for the supporting ocean-atmosphere agreement read. The anomaly first
  // block is parsed and schema-checked, but it is not emitted as the flag.
  const values = standardizedRows.flatMap((row) =>
    row.months.map((value, index) => ({
      year: row.year,
      month: index + 1,
      value
    }))
  );
  const latest = values.findLast((record) => record.value !== null);
  if (!latest || latest.value === null) {
    throw new Error('SOI standardized schema check failed: no populated monthly value');
  }

  const latestIndex = values.indexOf(latest);
  if (values.slice(latestIndex + 1).some((record) => record.value !== null)) {
    throw new Error('SOI standardized schema check failed: populated value follows a missing future month');
  }
  // CPC currently preallocates sentinel-only future years. Retain a bounded
  // recent window through December of the latest populated year, including
  // only that year's future-month nulls, rather than emitting the far-future
  // preallocation tail.
  const latestYearEndIndex = latestIndex + (12 - latest.month);
  return {
    block: 'standardized',
    latest,
    values: values.slice(
      Math.max(0, latestYearEndIndex - RECENT_MONTHS + 1),
      latestYearEndIndex + 1
    )
  };
}

async function fetchSoi() {
  const fetched = await fetchText(SOI_URL);
  return {
    published: fetched.published,
    ...parseSoi(fetched.text)
  };
}

function withPublished(published) {
  return published ? { published } : {};
}

async function main() {
  // Sequential fetches keep the four-request refresh bounded and polite.
  const roni = await fetchSeasonIndex(RONI_URL, 'SEAS YR ANOM', 'RONI');
  const oni = await fetchSeasonIndex(ONI_URL, 'SEAS YR TOTAL ANOM', 'ONI');
  const nino34 = await fetchNino34();
  const soi = await fetchSoi();

  const snapshot = {
    retrieved: new Date().toISOString().slice(0, 10),
    roni: {
      source: 'NOAA CPC Relative Oceanic Nino Index (RONI)',
      sourceUrl: RONI_URL,
      attribution: 'NOAA Climate Prediction Center (CPC), public domain U.S. Government work',
      description:
        'CPC operational ENSO monitoring index. The Oceanic Nino Index with the tropical-mean sea surface temperature trend removed; the application uses its sustained-threshold phase as the observed-state headline.',
      ...withPublished(roni.published),
      phase: roni.phase,
      latest: roni.latest,
      values: roni.values
    },
    oni: {
      source: 'NOAA CPC Oceanic Nino Index (ONI)',
      sourceUrl: ONI_URL,
      attribution: 'NOAA Climate Prediction Center (CPC), public domain U.S. Government work',
      description:
        'Three-month running mean of the Nino 3.4 sea surface temperature anomaly, retained as the long historical-continuity comparison behind the operational RONI headline.',
      ...withPublished(oni.published),
      phase: oni.phase,
      latest: oni.latest,
      values: oni.values
    },
    nino34: {
      source: 'NOAA CPC detrended monthly Nino 3.4 sea surface temperature anomaly',
      sourceUrl: NINO34_URL,
      attribution: 'NOAA Climate Prediction Center (CPC), public domain U.S. Government work',
      description:
        'Analyzed monthly Nino 3.4 sea surface temperature anomaly, retained as a fast-moving companion and never used as an ENSO phase declaration on its own.',
      ...withPublished(nino34.published),
      latest: nino34.latest,
      values: nino34.values
    },
    soi: {
      source: 'NOAA CPC Southern Oscillation Index (SOI)',
      sourceUrl: SOI_URL,
      attribution: 'NOAA Climate Prediction Center (CPC), public domain U.S. Government work',
      description:
        'Standardized monthly SOI second block, retained only as a supporting ocean-atmosphere agreement flag and never used to drive the ENSO phase.',
      ...withPublished(soi.published),
      block: soi.block,
      latest: soi.latest,
      values: soi.values
    }
  };

  const serialized = JSON.stringify(snapshot, null, 2) + '\n';
  if (serialized.includes(String(SOI_MISSING))) {
    throw new Error('SOI schema check failed: missing-value sentinel would leak into the snapshot');
  }

  // The shared consumer contract, enforced at the producer (2026-07-28
  // regression guard): a snapshot the runtime consumer would reject or
  // degrade must never be written, so a stale or drifted builder fails
  // loudly here instead of silently shipping a dead read.
  const rejection = rejectEnsoSnapshot(snapshot);
  if (rejection !== null) {
    throw new Error(`built snapshot fails the consumer contract: ${rejection}`);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_PATH, serialized, 'utf8');

  console.log(
    `Wrote ${OUT_PATH}: ` +
      `RONI phase=${roni.phase} latest=${roni.latest.seas} ${roni.latest.year} ${roni.latest.anom} preliminary=${roni.latest.preliminary}; ` +
      `ONI comparison latest=${oni.latest.seas} ${oni.latest.year} ${oni.latest.anom} preliminary=${oni.latest.preliminary}; ` +
      `Nino 3.4 latest=${nino34.latest.year}-${String(nino34.latest.month).padStart(2, '0')} ${nino34.latest.anom}; ` +
      `standardized SOI latest=${soi.latest.year}-${String(soi.latest.month).padStart(2, '0')} ${soi.latest.value}; ` +
      'no probabilistic plume.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
