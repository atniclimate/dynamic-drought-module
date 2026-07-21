/**
 * Build a snapshot of the NOAA CPC El Nino / Southern Oscillation (ENSO)
 * indices into public/data/enso-indices.json.
 *
 * Two indices are captured:
 *   - the Oceanic Nino Index (ONI), the standard three-month running mean of the
 *     Nino 3.4 sea surface temperature anomaly; and
 *   - the Relative ONI (RONI), which removes the tropical-mean warming
 *     background and is a useful corroborating index in a warming climate (in a
 *     warming ocean the raw ONI drifts warm, so RONI often reads cooler).
 *
 * Both sources (https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt and
 * .../RONI.ascii.txt) are slow-moving monthly indices served without
 * Cross-Origin Resource Sharing (CORS) headers, so a browser cannot fetch them
 * directly. Per the DDM climate-data-sources doctrine, a slow monthly index is
 * a build-time snapshot committed to public/data/ with its retrieval date, not
 * a runtime proxy call. There is no cleaner JSON API for the CPC indices; the
 * whitespace-delimited ascii table is the canonical machine source. This script
 * parses both, determines each phase per the standard thresholds, and writes a
 * small combined JSON the app bundles and reads locally.
 *
 * Re-run with: `npm run build:enso`. Commit the regenerated file.
 *
 * Thresholds (CPC): El Nino at index >= +0.5, La Nina at index <= -0.5, each
 * sustained over five consecutive overlapping three-month seasons; between is
 * neutral. The same thresholds are applied to ONI and to RONI.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
const RONI_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt';
// REMOVED 2026-07-21 (D-0.8.0-011 finding 3, built as T-P0-1): the CPC
// probabilistic-outlook plume was scraped from an HTML table here, which
// violates the no-scraping doctrine (CLAUDE.md hard rule 2 scope; the
// anti-scrape doctrine in ddm-climate-data-sources). CPC publishes the
// probabilities as HTML only, with no documented machine feed. The snapshot
// is now indices-only; the app renders the honest no-plume state. The plume
// returns only via a documented machine endpoint if CPC ships one, or as an
// explicitly-labeled MODELED NMME ensemble plume once its redistribution
// license verifies (workplan T-V0-3 / U-ENSO-REPAIR).
const RECENT_SEASONS = 36; // about three years of overlapping seasons
const THRESHOLD = 0.5;
const RUN_LENGTH = 5; // consecutive overlapping seasons to declare an event

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'public', 'data');
const OUT_PATH = join(DATA_DIR, 'enso-indices.json');
const LEGACY_PATH = join(DATA_DIR, 'oni.json');

/**
 * Parse a CPC index ascii table into ordered { seas, year, anom } records.
 * Handles both the ONI layout (`SEAS YR TOTAL ANOM`, four columns) and the
 * RONI layout (`SEAS YR ANOM`, three columns) by reading the anomaly from the
 * last column.
 */
function parse(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('SEAS')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const seas = parts[0];
    const year = Number(parts[1]);
    const anom = Number(parts[parts.length - 1]);
    if (!Number.isFinite(year) || !Number.isFinite(anom)) continue;
    out.push({ seas, year, anom });
  }
  return out;
}

/**
 * Declare the current phase only when the most recent RUN_LENGTH overlapping
 * seasons all sit at or beyond the threshold in the same direction; otherwise
 * neutral.
 */
function currentPhase(values) {
  const tail = values.slice(-RUN_LENGTH);
  if (tail.length === RUN_LENGTH) {
    if (tail.every((v) => v.anom >= THRESHOLD)) return 'el-nino';
    if (tail.every((v) => v.anom <= -THRESHOLD)) return 'la-nina';
  }
  return 'neutral';
}

async function fetchIndex(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} for ${url}`);
  const all = parse(await resp.text());
  if (all.length === 0) throw new Error(`parse produced no records for ${url}`);
  return {
    phase: currentPhase(all),
    latest: all[all.length - 1],
    values: all.slice(-RECENT_SEASONS)
  };
}

async function main() {
  const [oni, roni] = await Promise.all([fetchIndex(ONI_URL), fetchIndex(RONI_URL)]);

  const snapshot = {
    retrieved: new Date().toISOString().slice(0, 10),
    oni: {
      source: 'NOAA CPC Oceanic Nino Index (ONI)',
      sourceUrl: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php',
      description:
        'Three-month running mean of the Nino 3.4 sea surface temperature anomaly (ERSSTv5). El Nino at ONI >= +0.5 and La Nina at ONI <= -0.5, each sustained over five consecutive overlapping seasons; between is neutral.',
      phase: oni.phase,
      latest: oni.latest,
      values: oni.values
    },
    roni: {
      source: 'NOAA CPC Relative Oceanic Nino Index (RONI)',
      sourceUrl: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/',
      description:
        'The ONI with the tropical-mean sea surface temperature trend removed, so it is not biased warm by background ocean warming. A useful corroborating index in a warming climate; same thresholds as ONI.',
      phase: roni.phase,
      latest: roni.latest,
      values: roni.values
    }
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  // Remove the legacy ONI-only snapshot if present (superseded by this file).
  await rm(LEGACY_PATH, { force: true });

  console.log(
    `Wrote ${OUT_PATH}: ONI phase=${oni.phase} latest=${oni.latest.seas} ${oni.latest.year} ${oni.latest.anom}; ` +
      `RONI phase=${roni.phase} latest=${roni.latest.seas} ${roni.latest.year} ${roni.latest.anom}; ` +
      'indices-only (the probabilistic plume was removed 2026-07-21, T-P0-1; no machine feed exists).'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
