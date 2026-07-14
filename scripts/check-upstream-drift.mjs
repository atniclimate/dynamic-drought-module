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
 * CORS honesty (0.7.0 H3 lesson). The USFS Wildfire Hazard Potential
 * ImageServer answered every capability probe 200 while its `exportImage`
 * responses reached real browsers WITHOUT the Access-Control-Allow-Origin
 * header: liveness without CORS lies. Every probe therefore sends an Origin
 * header and reports the returned CORS header in the detail column; probes
 * marked `corsRequired` (the through-Worker tile path, where the Worker
 * must always inject the header) FAIL when it is absent. Upstream-direct
 * CORS values are informational only, because several upstreams are
 * intermittent (that is the lesson).
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

/** The production origin; sent on every probe so CORS posture is observable. */
const BROWSER_ORIGIN = 'https://atniclimate.github.io';

/** The representative WHP tile call (a real 256x256 export over the PNW).
 * Probed twice: upstream-direct (informational CORS) and through the Worker
 * proxy (corsRequired; this is the path production tiles actually ride). */
const WHP_EXPORT_IMAGE_QUERY =
  '/exportImage?bbox=-13887106,5700582,-13877106,5710582&bboxSR=3857&imageSR=3857&size=256,256&format=png&transparent=true&f=image';

/** Substitutions that turn a tile/parameter template into one probeable URL. */
const TEMPLATE_SUBSTITUTIONS = [
  ['{z}', '3'],
  ['{y}', '2'],
  ['{x}', '2'],
  // A small Web-Mercator bbox over the Pacific Northwest.
  ['{bbox-epsg-3857}', '-13887106,5700582,-13877106,5710582'],
  // GIBS WMTS accepts the literal keyword 'default' in the TIME position
  // (the most recent granule). Without this the timed template 400s on the
  // literal token and the monitor cries wolf (verified 2026-07-09).
  ['{TIME}', 'default']
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
  // A representative exportImage tile, not just the capability document
  // (the H3 lesson: metadata answered 200 while tiles were CORS-dead).
  ['usfsWhp', WHP_EXPORT_IMAGE_QUERY],
  // The Worker's documented health check (urls.ts stamp).
  ['workerProxy', '/healthz'],
  // Directory root; probe a known archive (AAFC retains all years, 2019+).
  ['cdmDroughtAreasZipRoot', '/2026/cdm_2605_drought_areas_json.zip']
]);

/** Content tripwires: keys whose response BODY must satisfy a validator,
 * or the probe FAILS even on HTTP 200. A validator returns null when the
 * body passes, or a human-readable miss description. First use: the
 * D-0.7.0-028 vintage tripwire. No versioned 2016 EOX id exists, so the
 * unversioned s2cloudless_3857 id is pinned to the 2016 CC BY mosaic only
 * by EOX's published capabilities text; if that text stops saying so, the
 * pin has silently broken and the satellite option must be pulled pending
 * review (the D-0.7.0-026b evidence-disappears pattern). The check is
 * SCOPED to the capabilities <Layer> element whose identifier is exactly
 * s2cloudless_3857 (the stage-5 adversarial medium 10: whole-body
 * substring search could false-pass on strings surviving elsewhere in a
 * changed document). Reference text in EVIDENCE_EOX_2026-07-14.md. */
const CONTENT_TRIPWIRES = new Map([
  [
    'basemapSatelliteCapabilities',
    (body) => {
      const blocks = body.split('<Layer>').slice(1).map((b) => b.split('</Layer>')[0]);
      const target = blocks.find((b) =>
        /<ows:Identifier>\s*s2cloudless_3857\s*<\/ows:Identifier>/.test(b)
      );
      if (!target) return 'no <Layer> with identifier s2cloudless_3857';
      if (!target.includes('for 2016')) {
        return 'the s2cloudless_3857 layer no longer identifies itself as the 2016 mosaic';
      }
      if (!/CC\s*BY|Creative Commons Attribution/i.test(target)) {
        return 'the s2cloudless_3857 layer no longer declares CC BY';
      }
      return null;
    }
  ]
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
      headers: {
        'User-Agent': 'ddm-drift-monitor/1.0 (+https://github.com/atniclimate/dynamic-drought-module)',
        Origin: BROWSER_ORIGIN
      }
    });
    const type = resp.headers.get('content-type') ?? '(none)';
    const acao = resp.headers.get('access-control-allow-origin');
    const corsMissing = Boolean(entry.corsRequired) && acao === null;
    let tripwireMiss = null;
    const tripwire = CONTENT_TRIPWIRES.get(entry.key);
    if (tripwire && resp.status < 400) {
      const body = await resp.text();
      tripwireMiss = tripwire(body);
    }
    const ok = resp.status < 400 && !corsMissing && tripwireMiss === null;
    const detail =
      `HTTP ${resp.status} ${type}; cors=${acao ?? 'ABSENT'}` +
      (corsMissing ? ' (required on this path)' : '') +
      (tripwireMiss !== null ? `; TRIPWIRE: ${tripwireMiss}` : '');
    return { key: entry.key, url, ok, detail };
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

  // A configured tripwire whose key stopped matching an extracted URL is a
  // DISARMED tripwire, which must fail loudly rather than silently skip
  // (the stage-5 adversarial medium 10).
  for (const key of CONTENT_TRIPWIRES.keys()) {
    if (!entries.some((e) => e.key === key)) {
      console.error(
        `Tripwire key "${key}" not found among the extracted urls.ts entries; the tripwire is disarmed.`
      );
      process.exit(1);
    }
  }

  // Synthetic probe: the WHP tile THROUGH the Worker proxy, the path
  // production tiles actually ride since 0.7.0 H3. The Worker must always
  // inject the CORS header, so its absence here is a real failure (a stale
  // Worker deploy missing the imagery.geoplatform.gov allow-list entry
  // shows up as HTTP 403 on this row).
  const workerProxy = entries.find((e) => e.key === 'workerProxy');
  const usfsWhp = entries.find((e) => e.key === 'usfsWhp');
  if (workerProxy && usfsWhp) {
    entries.push({
      key: 'workerProxy->usfsWhpTile',
      url: `${workerProxy.url}/proxy?url=${encodeURIComponent(usfsWhp.url + WHP_EXPORT_IMAGE_QUERY)}`,
      corsRequired: true
    });
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
