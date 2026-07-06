/**
 * Upstream drift monitor (0.4.0 B5): probe every remote endpoint in the URLS
 * table and report liveness drift before users find it.
 *
 * The URLS table (src/config/urls.ts) is TypeScript with Vite-specific
 * expressions, so this script does not import it; it extracts `key: 'https://
 * ...'` literals with a regex. Local bundled paths (import.meta.env.BASE_URL)
 * are skipped: they are build outputs, not upstreams. Tile-template URLs get
 * sample coordinates substituted so the probe hits a real tile.
 *
 * A probe FAILS on a network error, a timeout, or an HTTP status >= 400.
 * Anything else (200, 3xx, even an odd content type) passes with the details
 * printed, because many agency roots answer differently to a bare GET than to
 * the app's parameterized calls; the check guards liveness, not shape (shape
 * is the ddm-source-verifier's job at wire time).
 *
 * Run with: `npm run check:drift`. Exit code 1 when any endpoint fails, so a
 * scheduled runner (Task Scheduler, cron, or a future GitHub Action) can
 * alert on drift. Model-free by design; no AI in the loop.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_PATH = join(__dirname, '..', 'src', 'config', 'urls.ts');

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 5;

/** Substitutions that turn a tile/parameter template into one probeable URL. */
const TEMPLATE_SUBSTITUTIONS = [
  ['{z}', '3'],
  ['{y}', '2'],
  ['{x}', '2'],
  // A small Web-Mercator bbox over the Pacific Northwest.
  ['{bbox-epsg-3857}', '-13887106,5700582,-13877106,5710582']
];

/** Keys whose bare root answers 4xx by design; probed with the consumer's
 * real form (or the documented health check) so a healthy service reads ok
 * and a FAIL means genuine drift, not a probe artifact. */
const PROBE_SUFFIXES = new Map([
  // ESRI service roots: ?f=json is the canonical liveness form.
  ['nifcRawsFeatureServer', '?f=json'],
  ['cpcWeeklySstAnomalyMapServer', '?f=json'],
  ['biaLarFeatureServer', '?f=json'],
  // Parameterized APIs: a bare root 400s by design; probe a minimal real call.
  ['usgsIV', '?format=json&sites=01646500&parameterCd=00060&siteStatus=all'],
  ['nrcsAwdbRest', '?stationTriplets=679:WA:SNTL&elements=WTEQ&duration=DAILY&beginDate=2026-01-01&endDate=2026-01-02'],
  ['usdmDataServices', '/USStatistics/GetDroughtSeverityStatisticsByArea?aoi=us&startdate=1/1/2026&enddate=1/7/2026&statisticsType=1'],
  // Tile ROOT with the template living in the consumer; probe one real tile.
  ['nidisGriddedTileRoot', '/ce-ACIS_NRCC_NN-spi-90d/3/1/2.png'],
  // The Worker's documented health check (urls.ts stamp).
  ['workerProxy', '/healthz']
]);

function extractUrls(source) {
  const out = [];
  const re = /^\s*(\w+):\s*\n?\s*'(https:\/\/[^']+)'/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ key: m[1], url: m[2] });
  }
  return out;
}

function probeUrl(entry) {
  let url = entry.url;
  for (const [token, value] of TEMPLATE_SUBSTITUTIONS) {
    url = url.split(token).join(value);
  }
  const suffix = PROBE_SUFFIXES.get(entry.key);
  if (suffix && !url.includes('?')) url += suffix;
  return url;
}

async function check(entry) {
  const url = probeUrl(entry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ddm-drift-monitor/1.0 (+https://github.com/atniclimate/dynamic-drought-module)' }
    });
    const type = resp.headers.get('content-type') ?? '(none)';
    const ok = resp.status < 400;
    return { key: entry.key, url, ok, detail: `HTTP ${resp.status} ${type}` };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : String(err && err.cause ? err.cause : err);
    return { key: entry.key, url, ok: false, detail: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function run(entries) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      results[i] = await check(entries[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function main() {
  const source = await readFile(URLS_PATH, 'utf8');
  const entries = extractUrls(source);
  if (entries.length === 0) {
    console.error('No https URLs extracted from urls.ts; the extraction regex has drifted.');
    process.exit(1);
  }

  console.log(`Probing ${entries.length} upstream endpoints (timeout ${TIMEOUT_MS / 1000}s, concurrency ${CONCURRENCY})...\n`);
  const results = await run(entries);

  const failures = results.filter((r) => !r.ok);
  const width = Math.max(...results.map((r) => r.key.length));
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.key.padEnd(width)}  ${r.detail}`);
  }

  console.log(
    `\n${results.length - failures.length}/${results.length} endpoints answered; ` +
      (failures.length ? `${failures.length} FAILED: ${failures.map((f) => f.key).join(', ')}` : 'no drift detected.')
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
