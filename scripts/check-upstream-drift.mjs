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
 * marked `corsRequired` (the through-Worker paths, where the Worker must
 * always inject the header) FAIL unless the value is either `*` or the exact
 * browser Origin sent by this monitor. Upstream-direct CORS values are
 * informational only, because several upstreams are intermittent (that is
 * the lesson).
 *
 * Run with: `npm run check:drift`. Runtime and build-source failures return
 * exit code 1 so the scheduled GitHub Action can alert on actionable drift.
 * Candidate-source failures are reported as nonblocking warnings because an
 * unwired research candidate cannot break a deployed embed. Model-free by
 * design; no AI in the loop.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { readCurrentWorkerRevision, readWorkerRevision } from './lib/worker-revision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const URLS_PATH = join(__dirname, '..', 'src', 'config', 'urls.ts');
/** The catalog's boot slice (DR-008a, 2026-09-03): the literals the eager
 * boot graph reads (the OpenStreetMap tile template among them) live here and
 * are re-exported by urls.ts under their old keys, so extraction must read
 * both files or the basemap probe silently disappears. */
const URLS_BOOT_PATH = join(__dirname, '..', 'src', 'config', 'urls-boot.ts');

/** The catalog and its boot slice as one extraction source. */
async function readUrlsSource() {
  const [catalog, boot] = await Promise.all([
    readFile(URLS_PATH, 'utf8'),
    readFile(URLS_BOOT_PATH, 'utf8'),
  ]);
  return `${catalog}\n${boot}`;
}

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 5;

export const DRIFT_TIERS = Object.freeze({
  RUNTIME: 'runtime',
  BUILD: 'build',
  CANDIDATE: 'candidate'
});

/** URLS is also the vetted-source notebook, so not every literal is shipped.
 * New keys default to runtime: a maintainer must explicitly lower an endpoint
 * to candidate or build-only status instead of silently losing protection. */
export const CANDIDATE_SOURCE_KEYS = new Set([
  'basemapTopo',
  'cpcDroughtWMS',
  'biaTribalLeadersDirectory',
  'waEcologyCededLands',
  'cecEcoregionsL3FeatureServer',
  'cpcWeeklySstAnomalyMapServer',
  'epaAirNowCurrentFeatureServer',
  'nifcHistoricPerimetersFeatureServer',
  'usgsVegdriWeeklyWms',
  'usgsQuickdriWeeklyWms',
  // Demoted from build to candidate 2026-08-19: the FBFM40 fuel-model
  // drape was replaced in the 3D scene by the USFS Wildfire Hazard
  // Potential drape (owner direction), and its archive left the working
  // tree. scripts/build-fuels-tiles.mjs stays as the restore path, so the
  // pin is still worth WATCHING, but a vanished upstream for a layer
  // nothing renders must not fail a build. The live bake pin that DOES
  // block is the WHP ImageServer, already probed at runtime tier through
  // the `usfsWhp` endpoint the flat layer shares.
  'fuelsFbfm40Release'
]);

export const BUILD_SOURCE_KEYS = new Set([
  'cdmDroughtAreasZipRoot',
  'landscapeLandfireRelease',
  'landscapeNlcdCollection',
  'landscapeNlcdPinnedTime',
  'landscapeWhpEdition4Zip',
  'landscapeWhpDoi',
  'landscapeSoilVintage'
]);

export function sourceTierForKey(key) {
  if (CANDIDATE_SOURCE_KEYS.has(key)) return DRIFT_TIERS.CANDIDATE;
  if (BUILD_SOURCE_KEYS.has(key)) return DRIFT_TIERS.BUILD;
  return DRIFT_TIERS.RUNTIME;
}

/** The production origin; sent on every probe so CORS posture is observable. */
const BROWSER_ORIGIN = 'https://atniclimate.github.io';

// `readWorkerRevision` is defined in ./lib/worker-revision.mjs and shared
// with tests/worker-proxy-policy.spec.ts, so the daily monitor's expected
// revision and the policy spec's expected revision cannot independently
// desync from each other or from workers/proxy/src/index.ts. Re-exported
// here so tests/upstream-drift-contract.test.mjs keeps importing it from
// this module.
export { readWorkerRevision };

// The expected Worker revision is now DERIVED FROM REVIEWED SOURCE, not
// hand-pinned to whatever the live edge last answered. The former pin
// (`EXPECTED_WORKER_REVISION = '2026-07-29-nws-point-heat-v2'`) was blind by
// construction: it was written by copying the live `/healthz` string at
// commit time, so it could only ever equal live, never catch live falling
// behind source. Merging a reviewed Worker candidate without publishing it
// left this monitor comparing live to live forever, the exact gap
// DDM-P0-T05 slice 1 closes. Reading the constant here means drift is now
// source-vs-live: a published revision that lags reviewed source fails this
// tripwire daily until the owner publishes (see DEVELOPER.md). Exported so
// a contract test can assert it is truly wired to readWorkerRevision() and
// not a hardcoded literal that would silently desync from source again.
export const EXPECTED_WORKER_REVISION = readCurrentWorkerRevision();

/** S1 landscape vintage rows. Pinned disappearance is a failure. A newer
 * served vintage is a warning and review trigger, never a build failure. */
const LANDSCAPE_PROBES = [
  {
    key: 'landscapeLandfireRelease',
    url: 'https://lfps.usgs.gov/arcgis/rest/services?f=pjson'
  },
  {
    // The RETIRED fuels drape's bake pin (scripts/build-fuels-tiles.mjs):
    // LF2024 FBFM40 CONUS, the newest complete-CONUS vintage as of
    // 2026-08-18 (LF2025 is a phased GeoArea release through December
    // 2026). Candidate tier since 2026-08-19: the drape it fed no longer
    // ships, so a disappearance here is a warning and a review trigger,
    // not a build failure.
    key: 'fuelsFbfm40Release',
    url:
      'https://lfps.usgs.gov/arcgis/rest/services/Landfire_LF2024/' +
      'LF2024_FBFM40_CONUS/ImageServer?f=pjson'
  },
  {
    key: 'landscapeNlcdCollection',
    url:
      'https://dmsdata.cr.usgs.gov/geoserver/' +
      'mrlc_Land-Cover-Native_conus_year_data/wcs' +
      '?service=WCS&version=1.0.0&request=GetCapabilities'
  },
  {
    key: 'landscapeNlcdPinnedTime',
    url:
      'https://dmsdata.cr.usgs.gov/geoserver/' +
      'mrlc_Land-Cover-Native_conus_year_data/wcs' +
      '?service=WCS&version=1.0.0&request=GetCoverage' +
      '&coverage=mrlc_Land-Cover-Native_conus_year_data:' +
      'Land-Cover-Native_conus_year_data' +
      '&crs=EPSG:5070&response_crs=EPSG:5070' +
      '&bbox=-1900000,2900000,-1899970,2900030' +
      '&width=1&height=1&time=2024-01-01&format=GeoTIFF'
  },
  {
    key: 'landscapeWhpEdition4Zip',
    url:
      'https://www.fs.usda.gov/rds/archive/products/RDS-2015-0047-4/' +
      'RDS-2015-0047-4_Data.zip',
    method: 'HEAD'
  },
  {
    key: 'landscapeWhpDoi',
    url: 'https://doi.org/10.2737/RDS-2015-0047-4'
  }
];

/** The representative WHP tile call (a real 256x256 export over the PNW).
 * Probed twice: upstream-direct (informational CORS) and through the Worker
 * proxy (corsRequired; this is the path production tiles actually ride). */
const WHP_EXPORT_IMAGE_QUERY =
  '/exportImage?bbox=-13887106,5700582,-13877106,5710582&bboxSR=3857&imageSR=3857&size=256,256&format=png&transparent=true&f=image';

/** A small, anonymous NWS metadata read already used by the point-heat client. */
const NWS_POINT_PROBE_PATH = '/points/38.5,-97.5';

/** The exact DSCI read shape used by the runtime, with a small fixed window. */
const USDM_DSCI_PROBE_PATH =
  '/StateStatistics/GetDSCI?' +
  new URLSearchParams({
    aoi: '53',
    startdate: '1/1/2026',
    enddate: '1/7/2026',
    statisticsType: '1'
  }).toString();

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
  // The 3D Fire power context's live plants read: probe one real record
  // with the Period vintage field, so an ArcGIS error riding HTTP 200 or
  // a vanished Period attribute FAILS via the content tripwire below
  // instead of passing as a healthy status line.
  [
    'eiaPowerPlantsFeatureLayer',
    '/query?where=1%3D1&geometry=-125,41.5,-110.5,49.5' +
      '&geometryType=esriGeometryEnvelope&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects&outFields=Period' +
      '&returnGeometry=false&resultRecordCount=1&f=json'
  ],
  // Probe the same bounded station-network discovery used by the runtime.
  [
    'nrcsAwdbStations',
    '?stationTriplets=%2A%3A%2A%3ASNTL&activeOnly=true&returnStationElements=false'
  ],
  // These NOAA MapServer roots can return an HTML page or a gateway error;
  // exercise the GeoJSON query paths the layers actually consume.
  [
    'spcFireWeatherOutlookMapServer',
    '/1/query?where=1%3D1&outFields=dn%2Cvalid%2Cexpire&outSR=4326&f=geojson'
  ],
  [
    'cpcDroughtOutlookVectorMapServer',
    '/4/query?where=1%3D1&outFields=outlook%2Cfcst_date%2Ctarget%2Cidp_filedate' +
      '&outSR=4326&f=geojson&maxAllowableOffset=0.01&geometryPrecision=4'
  ],
  // The recent satellite client needs a queryable, time-stamped catalog,
  // not only a healthy ImageServer root.
  [
    'noaaMergedGeoColorImageServer',
    '/query?where=1%3D1&outFields=objectid%2Cname%2Cstart_time%2Cend_time' +
      '&returnGeometry=false&orderByFields=end_time%20DESC' +
      '&resultRecordCount=4&f=json'
  ],
  // Parameterized APIs: a bare root 400s by design; probe a minimal real call.
  ['usgsIV', '?format=json&sites=01646500&parameterCd=00060&siteStatus=all'],
  ['nrcsAwdbRest', '?stationTriplets=679:WA:SNTL&elements=WTEQ&duration=DAILY&beginDate=2026-01-01&endDate=2026-01-02'],
  ['usdmDataServices', USDM_DSCI_PROBE_PATH],
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
 * body passes, or a human-readable miss description. */
const CONTENT_TRIPWIRES = new Map([
  [
    'workerProxy',
    (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return 'Worker health check no longer returns JSON';
      }
      if (
        payload?.status !== 'ok' ||
        payload?.worker !== 'ddm-proxy' ||
        payload?.revision !== EXPECTED_WORKER_REVISION
      ) {
        return (
          'Worker health identity mismatch; expected ' +
          `status=ok, worker=ddm-proxy, revision=${EXPECTED_WORKER_REVISION}`
        );
      }
      return null;
    }
  ],
  [
    'workerProxy->nwsPoint',
    (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return 'proxied NWS point response is not JSON';
      }
      const properties = payload?.properties;
      if (properties === null || typeof properties !== 'object') {
        return 'proxied NWS point response has no properties object';
      }
      for (const key of [
        'forecast',
        'forecastGridData',
        'observationStations'
      ]) {
        const value = properties[key];
        if (typeof value !== 'string' || value.length === 0) {
          return `proxied NWS point response has no usable ${key} URL`;
        }
        try {
          const endpoint = new URL(value);
          if (
            endpoint.protocol !== 'https:' ||
            endpoint.hostname !== 'api.weather.gov'
          ) {
            return `proxied NWS point response has an unexpected ${key} origin`;
          }
        } catch {
          return `proxied NWS point response has an invalid ${key} URL`;
        }
      }
      return null;
    }
  ],
  [
    'noaaMergedGeoColorImageServer',
    (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return 'latest-frame query no longer returns JSON';
      }
      const now = Date.now();
      const features = Array.isArray(payload?.features) ? payload.features : [];
      const validCandidate = features.some((feature) => {
        const attributes = feature?.attributes;
        const objectId = Number(attributes?.objectid ?? attributes?.OBJECTID);
        const startTime = Number(attributes?.start_time ?? attributes?.START_TIME);
        const endTime = Number(attributes?.end_time ?? attributes?.END_TIME);
        const age = now - endTime;
        return (
          Number.isInteger(objectId) &&
          objectId > 0 &&
          Number.isFinite(startTime) &&
          Number.isFinite(endTime) &&
          startTime > 0 &&
          endTime >= startTime &&
          endTime - startTime <= 30 * 60_000 &&
          age >= -15 * 60_000 &&
          age <= 26 * 60 * 60_000
        );
      });
      if (!validCandidate) {
        return 'latest-frame query has no structurally valid frame inside the 26-hour freshness window';
      }
      return null;
    }
  ],
  [
    'landscapeLandfireRelease',
    (body) => {
      if (!body.includes('Landfire_LF2023')) {
        return 'pinned LANDFIRE LF2023 folder is no longer served';
      }
      const releases = [...body.matchAll(/Landfire_LF(20\d{2})/g)]
        .map((match) => Number(match[1]));
      const newer = releases.filter((release) => release > 2023);
      if (newer.length > 0) {
        return {
          warning:
            `newer LANDFIRE release folder observed: LF${Math.max(...newer)}; ` +
            'pinned release code 240 (LF2023) remains available'
        };
      }
      return null;
    }
  ],
  [
    'eiaPowerPlantsFeatureLayer',
    (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return 'EIA power-plant probe response is not JSON';
      }
      if (payload?.error) {
        return 'EIA power-plant layer returned an ArcGIS error envelope (a 200-with-error body)';
      }
      const period = payload?.features?.[0]?.attributes?.Period;
      if (typeof period !== 'string' || !/^\d{6}$/.test(period)) {
        return 'EIA power-plant probe record carries no YYYYMM Period attribute; the legend vintage line would misreport';
      }
      return null;
    }
  ],
  [
    'fuelsFbfm40Release',
    (body) => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return 'LF2024 FBFM40 ImageServer metadata is not JSON';
      }
      if (payload?.error) {
        return 'pinned LF2024 FBFM40 CONUS ImageServer is no longer served';
      }
      const pixelSize = Number(payload?.pixelSizeX);
      if (!Number.isFinite(pixelSize) || Math.round(pixelSize) !== 30) {
        return 'LF2024 FBFM40 CONUS no longer reports the 30 m source resolution the bake was measured against';
      }
      return null;
    }
  ],
  [
    'landscapeNlcdCollection',
    (body) => {
      const coverage =
        'mrlc_Land-Cover-Native_conus_year_data:' +
        'Land-Cover-Native_conus_year_data';
      if (!body.includes(coverage)) {
        return 'pinned Annual NLCD Collection 1.1 coverage is no longer served';
      }
      const years = [...body.matchAll(/(20\d{2})-01-01/g)]
        .map((match) => Number(match[1]));
      const newer = years.filter((year) => year > 2024);
      if (newer.length > 0) {
        return {
          warning:
            `newer Annual NLCD collection TIME observed: ` +
            `${Math.max(...newer)}-01-01; the separate bounded row checks ` +
            'pinned Annual NLCD Collection 1.1 TIME=2024-01-01'
        };
      }
      return null;
    }
  ],
  [
    'landscapeWhpDoi',
    (body, response) => {
      if (
        !response.url.includes('RDS-2015-0047-4') &&
        !body.includes('RDS-2015-0047-4')
      ) {
        return 'DOI 10.2737/RDS-2015-0047-4 no longer resolves to edition 4';
      }
      if (!/version\s+2023[\s\S]{0,100}\(4th Edition\)/i.test(body)) {
        return 'edition-4 DOI page no longer identifies the 2023 WHP product';
      }
      return null;
    }
  ]
]);

export function extractUrls(source) {
  const out = [];
  const re = /^\s*(\w+):\s*\n?\s*(['"])(https:\/\/[^'"]+)\2/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ key: m[1], url: m[3], tier: sourceTierForKey(m[1]) });
  }
  return out;
}

/**
 * ArcGIS field-schema probes (slice B, 2026-08-28). The runtime read
 * `attr_DailyAcres` from the WFIGS perimeters for months; the service never
 * had it. For each module that sends `outFields`, the list is read FROM THE
 * MODULE SOURCE (never hand-copied; an imported constant is followed to its
 * module), the layer's `?f=pjson` is fetched, and a requested field that is
 * absent by exact name fails the probe at the runtime tier. `layer` is the
 * path the module appends to the URLS base before `/query` ('' when the base
 * already names the layer). `constName` selects one list when a module
 * sends several; `pick` selects the branch of a ternary that belongs to a
 * layer. Subsets already covered by a row: the BIA fields sent by
 * src/state/display-snapshot.ts, src/ui/search-controller.ts, and
 * src/ui/island/place-studio.tsx; the USDM `DM` and NIFC identity fields in
 * src/impact/sources.ts; the WBD template in src/state/watershed-geometry.ts
 * (same as place-catalog's). NOT covered: the CPC 6-10 and 8-14 day point
 * query in src/impact/sources.ts passes `cat,prob` as a function argument
 * the extractor does not see, and the WBD HUC code field is a template
 * token reported as unchecked.
 */
export const ARCGIS_FIELD_PROBES = Object.freeze([
  { key: 'nifcRawsFeatureServer', file: 'src/config/station-registry.ts', layer: '' },
  { key: 'noaaMergedGeoColorImageServer', file: 'src/map/satellite.ts', layer: '' },
  // place-studio.tsx: Level IV is layer 7 (four fields), Level III is layer 11.
  { key: 'epaEcoregionsMapServer', file: 'src/ui/island/place-studio.tsx', layer: '/7', pick: (fields) => fields.includes('US_L4CODE') },
  { key: 'epaEcoregionsMapServer', file: 'src/ui/island/place-studio.tsx', layer: '/11', pick: (fields) => fields.includes('US_L3CODE') && !fields.includes('US_L4CODE') },
  // place-catalog.ts watershedQueryUrl: layers 1 (huc2) and 2 (huc4).
  { key: 'wbdMapServer', file: 'src/config/place-catalog.ts', layer: '/1' },
  { key: 'wbdMapServer', file: 'src/config/place-catalog.ts', layer: '/2' },
  { key: 'nifcFires', file: 'src/layers/nifc-fires.ts', layer: '', constName: 'NIFC_OUT_FIELDS' },
  { key: 'censusAiannhMapServer', file: 'src/layers/aiannh.ts', layer: '/47' },
  { key: 'biaLarFeatureServer', file: 'src/layers/bia-reservations.ts', layer: '' },
  // RANGE_LAYER_INDEX in drought.ts: monthly 1, seasonal 4.
  { key: 'cpcDroughtOutlookVectorMapServer', file: 'src/layers/drought.ts', layer: '/1' },
  { key: 'cpcDroughtOutlookVectorMapServer', file: 'src/layers/drought.ts', layer: '/4' },
  { key: 'nwsHeatRisk', file: 'src/layers/heatrisk.ts', layer: '' },
  { key: 'noaaHmsSmokeFeatureServer', file: 'src/layers/hms-smoke.ts', layer: '' },
  { key: 'nwsWwaMapServer', file: 'src/layers/nws-alerts.ts', layer: '' },
  { key: 'eiaPowerPlantsFeatureLayer', file: 'src/layers/power-3d.ts', layer: '', constName: 'PLANTS_OUT_FIELDS' },
  // DAY1_LAYER_ID in spc-fire-weather.ts.
  { key: 'spcFireWeatherOutlookMapServer', file: 'src/layers/spc-fire-weather.ts', layer: '/1' },
  { key: 'usdmFeatureServer', file: 'src/layers/usdm.ts', layer: '', constName: 'CURRENT_OUT_FIELDS' },
  { key: 'usdmArchiveFeatureServer', file: 'src/layers/usdm.ts', layer: '', constName: 'ARCHIVE_OUT_FIELDS' },
  { key: 'bcDroughtLevelsFeatureServer', file: 'src/layers/bc-drought.ts', layer: '' },
]);

// `outFields: <expr>` (object key) or `outFields = <expr>` (a local const
// later passed as shorthand). The expression is a string literal, a template
// literal, a ternary of two string literals whose condition is an
// identifier or a comparison (`isLevel4`, `layer === 7`), or an identifier
// (optionally `.join(',')`); a shorthand `outFields,` property is the
// assignment's consumer and is not matched on its own, and a list passed
// as a positional function argument is not seen at all (see
// OUT_FIELDS_SENDERS_COVERED_ELSEWHERE).
/**
 * Every source file that mentions `outFields` must be in ARCGIS_FIELD_PROBES
 * or here, with the reason it needs no row of its own; the drift contract
 * test inventories `src/` and fails on a sender that is in neither, so a new
 * ArcGIS query cannot arrive unprotected in silence.
 */
export const OUT_FIELDS_SENDERS_COVERED_ELSEWHERE = Object.freeze({
  'src/config/urls.ts': 'documentation comments only; no query is built here',
  'src/state/display-snapshot.ts': 'extracted list (BIA LARID) is a subset of the biaLarFeatureServer row today; not probed on its own',
  'src/ui/search-controller.ts': 'extracted list is the same five BIA fields as the biaLarFeatureServer row today; not probed on its own',
  'src/state/watershed-geometry.ts':
    'NOT extracted (the template is a positional argument to geometryParams); byte-identical to the place-catalog template today',
  'src/impact/sources.ts':
    'NOT extracted (positional arguments to esriPointQuery and esriEnvelopeQuery): USDM DM and the NIFC identity fields are subsets of their rows today; the CPC 6-10 and 8-14 day point query (cat,prob) has no row',
});

const OUT_FIELDS_RE =
  /\boutFields\s*[:=]\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([A-Za-z_][A-Za-z0-9_.\s=!<>()]*?)\s*\?\s*'([^']*)'\s*:\s*'([^']*)'|([A-Za-z_][A-Za-z0-9_]*)(?:\.join\(\s*','\s*\))?)/g;

const splitFields = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

/** Resolve `const NAME = [...]` or `const NAME = '...'` in a module source
 * to a field list, or null when the module does not declare it. */
export function resolveFieldConstant(source, name) {
  const arr = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (arr) return [...arr[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  const str = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(?:'([^']*)'|"([^"]*)")`).exec(source);
  if (str) return (str[1] ?? str[2]).split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

function importSpecifierFor(source, name) {
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop());
    if (names.includes(name)) return m[2];
  }
  return null;
}

/** Every `outFields` list the module sends: a literal list, a template
 * literal (static names, with `${...}` tokens named in `dynamic` and left
 * unchecked), a ternary (one entry per branch), a local constant
 * (resolved), or an imported constant (`fields: null`, `importedFrom` set
 * for the caller to resolve). `outFields: '*'` is not a schema claim. */
export function extractOutFields(source) {
  const out = [];
  for (const m of source.matchAll(OUT_FIELDS_RE)) {
    const line = source.slice(0, m.index).split('\n').length;
    const entries = [];
    if (m[1] !== undefined || m[2] !== undefined) {
      entries.push({ fields: splitFields(m[1] ?? m[2]), via: 'literal', importedFrom: null, dynamic: [] });
    } else if (m[3] !== undefined) {
      const dynamic = [...m[3].matchAll(/\$\{([^}]*)\}/g)].map((t) => t[1].trim());
      entries.push({ fields: splitFields(m[3].replace(/\$\{[^}]*\}/g, '')), via: 'template', importedFrom: null, dynamic });
    } else if (m[4] !== undefined) {
      const condition = m[4].replace(/\s+/g, ' ').trim();
      entries.push({ fields: splitFields(m[5]), via: `ternary:${condition}`, importedFrom: null, dynamic: [] });
      entries.push({ fields: splitFields(m[6]), via: `ternary:!(${condition})`, importedFrom: null, dynamic: [] });
    } else {
      const via = m[7];
      // `outFields: string` is a TypeScript type annotation (an interface
      // member or a parameter), not a list the module sends.
      if (via === 'string') continue;
      const fields = resolveFieldConstant(source, via);
      const importedFrom = fields === null ? importSpecifierFor(source, via) : null;
      // An identifier that is neither a local constant nor an import is
      // kept as unresolved so a probe over it fails instead of skipping.
      entries.push({ fields, via, importedFrom, dynamic: [], unresolved: fields === null && importedFrom === null });
    }
    for (const entry of entries) {
      if (entry.fields !== null && (entry.fields.length === 0 || entry.fields.includes('*'))) continue;
      out.push({ line, unresolved: false, ...entry });
    }
  }
  return out;
}

export function missingFields(outFields, pjson) {
  const names = new Set((pjson?.fields ?? []).map((f) => f.name));
  const lower = new Set([...names].map((n) => n.toLowerCase()));
  const missing = outFields.filter((f) => !names.has(f));
  const caseOnly = missing.filter((f) => lower.has(f.toLowerCase()));
  return { missing, caseOnly };
}

/** Judge a `?f=pjson` body against the fields the runtime requests. */
export function checkFieldSchema(expected, bodyText) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { miss: 'schema body is not JSON', note: '' };
  }
  if (json && json.error) {
    return { miss: `ArcGIS error ${json.error.code ?? '?'} ${json.error.message ?? ''}`.trim(), note: '' };
  }
  if (!json || !Array.isArray(json.fields)) return { miss: 'schema body has no fields array', note: '' };
  const { missing, caseOnly } = missingFields(expected, json);
  if (missing.length > 0) {
    const near = caseOnly.length ? ` (case-only: ${caseOnly.join(', ')})` : '';
    return { miss: `missing fields: ${missing.join(', ')}${near}`, note: '' };
  }
  return { miss: null, note: `${expected.length}/${expected.length} requested fields present` };
}

async function fieldListsForProbe(probe, root) {
  const file = join(root, probe.file);
  const source = await readFile(file, 'utf8');
  const found = extractOutFields(source).filter((f) => !probe.constName || f.via === probe.constName);
  const lists = [];
  const dynamic = new Set();
  for (const entry of found) {
    if (entry.unresolved) {
      throw new Error(`field probe ${probe.key}${probe.layer}: outFields at ${probe.file}:${entry.line} names ${entry.via}, which is neither a local constant nor an import`);
    }
    if (entry.fields !== null) {
      if (probe.pick && !probe.pick(entry.fields)) continue;
      lists.push(entry.fields);
      for (const token of entry.dynamic) dynamic.add(token);
      continue;
    }
    const target = resolve(dirname(file), entry.importedFrom);
    const candidates = [`${target}.ts`, join(target, 'index.ts')];
    let resolved = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      resolved = resolveFieldConstant(await readFile(candidate, 'utf8'), entry.via);
      if (resolved) break;
    }
    if (!resolved) {
      throw new Error(`field probe ${probe.key}${probe.layer}: ${entry.via} imported from ${entry.importedFrom} at ${probe.file}:${entry.line} did not resolve to a field list`);
    }
    if (!probe.pick || probe.pick(resolved)) lists.push(resolved);
  }
  return { lists, dynamic: [...dynamic] };
}

/** Build one probe entry per ARCGIS_FIELD_PROBES row from the extracted
 * URLS entries. A row whose key or field list cannot be resolved throws:
 * an unresolvable probe is a disarmed probe, never a silent skip. */
export async function buildFieldProbeEntries(urlEntries, root = join(__dirname, '..')) {
  const byKey = new Map(urlEntries.map((e) => [e.key, e]));
  const entries = [];
  for (const probe of ARCGIS_FIELD_PROBES) {
    const base = byKey.get(probe.key);
    if (!base) throw new Error(`field probe ${probe.key} is not an extracted urls.ts entry; the probe is disarmed`);
    const { lists, dynamic } = await fieldListsForProbe(probe, root);
    if (lists.length === 0) {
      throw new Error(`field probe ${probe.key}${probe.layer}: no outFields list resolved from ${probe.file}${probe.constName ? ` via ${probe.constName}` : ''}`);
    }
    const fieldsExpected = [...new Set(lists.flat())];
    entries.push({
      key: `fields:${probe.key}${probe.layer}`,
      url: `${base.url}${probe.layer}?f=pjson`,
      tier: DRIFT_TIERS.RUNTIME,
      fieldsExpected,
      fieldsDynamic: dynamic,
    });
  }
  return entries;
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
  const tier = entry.tier ?? sourceTierForKey(entry.key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: entry.method ?? 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'ddm-drift-monitor/1.0 (+https://github.com/atniclimate/dynamic-drought-module)',
        Origin: BROWSER_ORIGIN
      }
    });
    const type = resp.headers.get('content-type') ?? '(none)';
    const acao = resp.headers.get('access-control-allow-origin');
    const corsCompatible = acao === '*' || acao === BROWSER_ORIGIN;
    const corsInvalid = Boolean(entry.corsRequired) && !corsCompatible;
    let tripwireMiss = null;
    let warning = null;
    let fieldNote = '';
    const tripwire = CONTENT_TRIPWIRES.get(entry.key);
    if (tripwire && resp.status < 400) {
      const body = await resp.text();
      const result = tripwire(body, resp);
      if (typeof result === 'string') {
        tripwireMiss = result;
      } else if (result && typeof result.warning === 'string') {
        warning = result.warning;
      }
    } else if (entry.fieldsExpected && resp.status < 400) {
      const result = checkFieldSchema(entry.fieldsExpected, await resp.text());
      tripwireMiss = result.miss;
      fieldNote = result.note;
      if (fieldNote && entry.fieldsDynamic?.length) {
        fieldNote += `; template token${entry.fieldsDynamic.length === 1 ? '' : 's'} ${entry.fieldsDynamic.map((t) => '${' + t + '}').join(', ')} not checked`;
      }
    }
    const ok = resp.status < 400 && !corsInvalid && tripwireMiss === null;
    const detail =
      `HTTP ${resp.status} ${type}; cors=${acao ?? 'ABSENT'}` +
      (corsInvalid
        ? ` (required '*' or '${BROWSER_ORIGIN}' on this path)`
        : '') +
      (tripwireMiss !== null ? `; TRIPWIRE: ${tripwireMiss}` : '') +
      (fieldNote ? `; ${fieldNote}` : '') +
      (warning !== null ? `; WARNING: ${warning}` : '');
    return { key: entry.key, url, tier, ok, warning, detail };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : String(err && err.cause ? err.cause : err);
    return { key: entry.key, url, tier, ok: false, warning: null, detail: reason };
  } finally {
    clearTimeout(timer);
  }
}

function checkSoilDrift() {
  const root = join(__dirname, '..');
  const soilInputState = soilDriftInputState(root);
  if (soilInputState === 'missing') {
    return {
      key: 'landscapeSoilVintage',
      url: 'Soil Data Access drift_check',
      tier: DRIFT_TIERS.BUILD,
      ok: true,
      skipped: true,
      warning:
        'soil vintage drift check not run: the lean checkout omits the ' +
        'digest-bound soil intermediate data',
      detail:
        'SKIPPED: the committed manifest is present, but neither the three ' +
        'committed soil data files nor their bound guard-overflow copy is available'
    };
  }
  const windowsPython = join(root, '.venv', 'Scripts', 'python.exe');
  const posixPython = join(root, '.venv', 'bin', 'python');
  const pythonCandidates = process.platform === 'win32'
    ? [windowsPython, posixPython]
    : [posixPython, windowsPython];
  const python = pythonCandidates.find((candidate) => existsSync(candidate));
  if (python === undefined) {
    return {
      key: 'landscapeSoilVintage',
      url: 'Soil Data Access drift_check',
      tier: DRIFT_TIERS.BUILD,
      ok: false,
      warning: null,
      detail:
        'project Python environment is missing; checked ' +
        pythonCandidates.join(', ')
    };
  }
  const child = spawnSync(
    python,
    ['-m', 'scripts.landscape', '--soil-drift-check'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
  if (child.error || child.status !== 0) {
    const reason = child.error?.code === 'ETIMEDOUT'
      ? 'timeout 45000ms'
      : (child.stderr || child.error?.message || `exit ${child.status}`).trim();
    return {
      key: 'landscapeSoilVintage',
      url: 'Soil Data Access drift_check',
      tier: DRIFT_TIERS.BUILD,
      ok: false,
      warning: null,
      detail: reason
    };
  }
  try {
    const lines = child.stdout.trim().split(/\r?\n/);
    const payload = JSON.parse(lines.at(-1));
    const counts = payload.requestCounts ?? {};
    if (counts['soilweb-wcs'] !== 0 || counts['sda-post'] > 3) {
      throw new Error(
        `invalid request receipt: soilweb-wcs=${counts['soilweb-wcs']}, ` +
        `sda-post=${counts['sda-post']}`
      );
    }
    if (payload.recorded?.fyLabel !== 'FY2025') {
      throw new Error(
        `pinned FY2025 is absent from the bound intermediate record`
      );
    }
    const warning = payload.drift
      ? (
          `new Soil Data Access vintage tuple observed; pinned FY2025 ` +
          `record remains usable; current=${JSON.stringify(payload.current)}`
        )
      : null;
    return {
      key: 'landscapeSoilVintage',
      url: 'Soil Data Access drift_check',
      tier: DRIFT_TIERS.BUILD,
      ok: true,
      warning,
      detail:
        `pinned=${JSON.stringify(payload.recorded)}; ` +
        `current=${JSON.stringify(payload.current)}; ` +
        `requests=${JSON.stringify(counts)}` +
        (warning ? `; WARNING: ${warning}` : '')
    };
  } catch (err) {
    return {
      key: 'landscapeSoilVintage',
      url: 'Soil Data Access drift_check',
      tier: DRIFT_TIERS.BUILD,
      ok: false,
      warning: null,
      detail: `invalid bounded drift receipt: ${err.message}`
    };
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

const SOIL_INTERMEDIATE_DATA_NAMES = [
  'histogram-l3.json',
  'histogram-l4.json',
  'sda-rows.json'
];

/**
 * Report whether the bounded soil drift command can validate its recorded
 * vintage identity. Public checkouts intentionally retain only MANIFEST.json;
 * the large digest-bound inputs live either beside it in a stewardship
 * workspace or in the guard-overflow cache.
 */
export function soilDriftInputState(root, isFile = existsSync) {
  const fy = 'FY2025';
  const committed = join(
    root,
    'scripts',
    'landscape',
    'intermediates',
    'soil',
    fy
  );
  if (
    SOIL_INTERMEDIATE_DATA_NAMES.every((name) => isFile(join(committed, name)))
  ) {
    return 'committed';
  }

  const overflow = join(
    root,
    'scripts',
    '.cache',
    'soil',
    'intermediates-overflow',
    fy
  );
  if (
    SOIL_INTERMEDIATE_DATA_NAMES.every((name) => isFile(join(overflow, name))) &&
    isFile(join(overflow, 'INPUT-BINDING.json'))
  ) {
    return 'overflow';
  }
  return 'missing';
}

export function classifyDriftResults(results) {
  const runtimeFailures = [];
  const buildFailures = [];
  const candidateFailures = [];
  const warnings = [];
  const skipped = [];

  for (const result of results) {
    const tier = result.tier ?? sourceTierForKey(result.key);
    if (result.skipped) {
      skipped.push({ ...result, tier });
      continue;
    }
    if (result.ok) {
      if (result.warning) warnings.push({ ...result, tier });
      continue;
    }
    if (tier === DRIFT_TIERS.CANDIDATE) {
      candidateFailures.push({ ...result, tier });
    } else if (tier === DRIFT_TIERS.BUILD) {
      buildFailures.push({ ...result, tier });
    } else {
      runtimeFailures.push({ ...result, tier });
    }
  }

  return {
    runtimeFailures,
    buildFailures,
    candidateFailures,
    warnings,
    skipped,
    blockingFailures: [...runtimeFailures, ...buildFailures]
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--landscape-only')) {
    console.error('usage: node scripts/check-upstream-drift.mjs [--landscape-only]');
    process.exit(2);
  }
  const landscapeOnly = args[0] === '--landscape-only';
  let entries = [];
  if (!landscapeOnly) {
    const source = await readUrlsSource();
    entries = extractUrls(source);
    if (entries.length === 0) {
      console.error('No https URLs extracted from urls.ts; the extraction regex has drifted.');
      process.exit(1);
    }
    // Field-schema rows for every ArcGIS outFields list the runtime sends;
    // an unresolvable row throws (a disarmed probe must fail loudly).
    entries.push(...(await buildFieldProbeEntries(entries)));
  }
  entries.push(...LANDSCAPE_PROBES);

  // Synthetic probe: the WHP tile THROUGH the Worker proxy, the path
  // production tiles actually ride since 0.7.0 H3. The Worker must always
  // inject the CORS header, so its absence here is a real failure (a stale
  // Worker deploy missing the imagery.geoplatform.gov allow-list entry
  // shows up as HTTP 403 on this row).
  const workerProxy = entries.find((e) => e.key === 'workerProxy');
  if (workerProxy) workerProxy.corsRequired = true;
  const usfsWhp = entries.find((e) => e.key === 'usfsWhp');
  if (workerProxy && usfsWhp) {
    entries.push({
      key: 'workerProxy->usfsWhpTile',
      url: `${workerProxy.url}/proxy?url=${encodeURIComponent(usfsWhp.url + WHP_EXPORT_IMAGE_QUERY)}`,
      corsRequired: true
    });
  }

  // The DSCI trend THROUGH the Worker (added 2026-07-14 when the upstream
  // stopped emitting CORS headers and the fetch moved onto the proxy): the
  // Worker must always inject ACAO on this path, so its absence is a real
  // failure (a stale Worker deploy missing the usdmdataservices.unl.edu
  // allow-list entry shows up as HTTP 403 on this row).
  const usdm = entries.find((e) => e.key === 'usdmDataServices');
  if (workerProxy && usdm) {
    const suffix = PROBE_SUFFIXES.get('usdmDataServices') ?? '';
    entries.push({
      key: 'workerProxy->usdmDsci',
      url: `${workerProxy.url}/proxy?url=${encodeURIComponent(usdm.url + suffix)}`,
      corsRequired: true
    });
  }

  // NWS point metadata THROUGH the Worker exercises the production path that
  // supplies the identifying User-Agent and verifies browser-compatible CORS
  // plus the exact metadata links consumed by point heat.
  const nwsApi = entries.find((e) => e.key === 'nwsApi');
  if (workerProxy && nwsApi) {
    const upstream = nwsApi.url + NWS_POINT_PROBE_PATH;
    entries.push({
      key: 'workerProxy->nwsPoint',
      url: `${workerProxy.url}/proxy?url=${encodeURIComponent(upstream)}`,
      corsRequired: true
    });
  }

  // A configured tripwire whose key stopped matching an extracted or
  // synthetic URL is a DISARMED tripwire, which must fail loudly rather than
  // silently skip (the stage-5 adversarial medium 10).
  const activeTripwireKeys = landscapeOnly
    ? new Set(LANDSCAPE_PROBES.map((entry) => entry.key))
    : new Set(CONTENT_TRIPWIRES.keys());
  for (const key of activeTripwireKeys) {
    if (!entries.some((e) => e.key === key)) {
      console.error(
        `Tripwire key "${key}" not found among the extracted urls.ts entries; the tripwire is disarmed.`
      );
      process.exit(1);
    }
  }

  console.log(`Probing ${entries.length} upstream endpoints (timeout ${TIMEOUT_MS / 1000}s, concurrency ${CONCURRENCY})...\n`);
  const results = await run(entries);
  results.push(checkSoilDrift());

  const classification = classifyDriftResults(results);
  const allFailures = [
    ...classification.runtimeFailures,
    ...classification.buildFailures,
    ...classification.candidateFailures
  ];
  const width = Math.max(...results.map((r) => r.key.length));
  for (const r of results) {
    const tier = r.tier ?? sourceTierForKey(r.key);
    const state = r.skipped
      ? 'SKIP'
      : !r.ok
      ? tier === DRIFT_TIERS.CANDIDATE ? 'WARN' : 'FAIL'
      : r.warning ? 'WARN' : 'ok  ';
    console.log(
      `${state}  [${tier.padEnd(9)}]  ${r.key.padEnd(width)}  ${r.detail}`
    );
  }

  const attemptedCount = results.length - classification.skipped.length;
  console.log(
    `\n${attemptedCount - allFailures.length}/${attemptedCount} probed endpoints answered.`
  );
  if (classification.runtimeFailures.length > 0) {
    console.log(
      `Runtime failures (possible deployed impact): ${classification.runtimeFailures.map((f) => f.key).join(', ')}`
    );
  }
  if (classification.buildFailures.length > 0) {
    console.log(
      `Build-source failures (future artifact risk, not proof of deployed impact): ${classification.buildFailures.map((f) => f.key).join(', ')}`
    );
  }
  if (classification.candidateFailures.length > 0) {
    console.log(
      `Candidate warnings (nonblocking, not wired): ${classification.candidateFailures.map((f) => f.key).join(', ')}`
    );
  }
  if (classification.warnings.length > 0) {
    console.log(
      `Source warnings: ${classification.warnings.map((w) => w.key).join(', ')}`
    );
  }
  if (classification.skipped.length > 0) {
    console.log(
      `Skipped bounded checks: ${classification.skipped.map((r) => r.key).join(', ')}`
    );
  }
  if (
    allFailures.length === 0 &&
    classification.warnings.length === 0 &&
    classification.skipped.length === 0
  ) {
    console.log('No drift detected.');
  }
  if (classification.blockingFailures.length > 0) process.exit(1);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
