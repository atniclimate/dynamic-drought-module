/**
 * Pure evaluators for the Worker edge receipt (DDM-P0-T05, slice 2).
 *
 * No network, no file I/O: the driver (scripts/verify-worker.mjs) gathers
 * facts from the public Worker and these functions decide, so every verdict
 * is unit-tested offline (tests/worker-receipts.test.mjs) against both the
 * answers live gives today and the answers the reviewed candidate must give.
 *
 * What a receipt may hold: the probe id, the method, the public request URL,
 * the HTTP status, the Worker's own JSON `error` code, the
 * `Access-Control-*` and `Allow` header values, a byte count, a SHA-256 hex
 * digest, and elapsed milliseconds. Never a response body, and never the
 * `detail` prose beside the error code. The relay reaches public agency
 * reads only, but the rule is the same one the live receipt follows: record
 * what proves the policy, not what the upstream said (hard rule 1; see the
 * NON-REDISTRIBUTION GUARD in src/layers/aiannh.ts).
 *
 * The policy these evaluators assert is the reviewed source in
 * workers/proxy/src/index.ts, not what the edge happens to serve. Running
 * this against a Worker older than reviewed source is expected to FAIL, and
 * that failing receipt is the drift evidence.
 */

/** The exact CORS advertisement the reviewed Worker injects on every
 * response it produces (workers/proxy/src/index.ts CORS_HEADERS). The live
 * 2026-07-29 revision advertises `GET, POST, OPTIONS` and `Content-Type`
 * instead, so these two strings are the whole difference between a
 * converged edge and a stale one. */
export const EXPECTED_ALLOW_ORIGIN = '*';
export const EXPECTED_ALLOW_METHODS = 'GET, HEAD, OPTIONS';
export const EXPECTED_ALLOW_HEADERS = 'Accept';
export const EXPECTED_PREFLIGHT_MAX_AGE = '86400';

/**
 * What `/healthz` advertises is a SEPARATE question from what `/proxy`
 * does: the health endpoint is a read of the Worker itself and may offer a
 * narrower method set than the relay. The candidate answers its own
 * preflight with `GET, OPTIONS` while the health document carries the
 * relay's advertisement, and that split is still settling, so the health
 * expectation is an input (`--expect-healthz-methods`) rather than a
 * constant. The `Allow` header on `HEAD /healthz` is recorded but not
 * asserted for the same reason.
 */
export const DEFAULT_HEALTHZ_ALLOW_METHODS = EXPECTED_ALLOW_METHODS;

/** The Worker's own upstream-failure codes. A probe marked
 * `upstreamTolerant` records these as warnings: an agency outage is not a
 * policy failure, and the receipt must not cry wolf about one. */
export const UPSTREAM_STATUSES = new Set([429, 502, 503, 504]);
export const UPSTREAM_CODES = new Set([
  'upstream_timeout',
  'upstream_unreachable',
  'too_many_redirects',
]);

/** The Worker's upstream deadline (index.ts UPSTREAM_TIMEOUT_MS). A relay
 * measured slower than this from the caller's side is recorded as a warning:
 * the Worker answers 504 past its own deadline, so a slow wall clock here is
 * network distance, not a broken bound. */
export const RELAY_BUDGET_MS = 12_000;

const DEFAULTS = Object.freeze({
  base: 'https://ddm-proxy.atniclimate.workers.dev/',
  expectRevision: '',
  expectHealthzMethods: DEFAULT_HEALTHZ_ALLOW_METHODS,
  out: 'worker-receipt.json',
  summary: null,
  // Longer than the Worker's own 12 second upstream deadline plus edge
  // overhead, on purpose. A client that gives up first turns the Worker's
  // honest 504 into an abort the receipt cannot interpret: the first live
  // run aborted the NWRFC relay at exactly 15005 ms, which said nothing
  // about the edge. The client must outlive the bound it is measuring.
  timeoutMs: 20_000,
});

const FLAGS = new Map([
  ['--base', ['base', 'string']],
  ['--expect-revision', ['expectRevision', 'string']],
  ['--expect-healthz-methods', ['expectHealthzMethods', 'string']],
  ['--out', ['out', 'string']],
  ['--summary', ['summary', 'string']],
  ['--timeout-ms', ['timeoutMs', 'int']],
]);

export function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const spec = FLAGS.get(argv[i]);
    if (!spec) throw new Error(`unknown argument ${argv[i]}`);
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`${argv[i]} needs a value`);
    const [key, kind] = spec;
    if (kind === 'int') {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
        throw new Error(`${argv[i]} must be a positive integer`);
      }
      out[key] = n;
    } else {
      out[key] = raw;
    }
    i += 1;
  }
  if (!/^https?:\/\//.test(out.base)) throw new Error('--base must be an http(s) URL');
  if (!out.base.endsWith('/')) out.base += '/';
  if (!out.expectRevision) {
    throw new Error('--expect-revision <revision> is required: the receipt asserts a named revision, never whatever the edge happens to say');
  }
  if (!out.expectHealthzMethods) throw new Error('--expect-healthz-methods needs a non-empty value');
  return out;
}

/* ------------------------------------------------------------------ *
 * The probe table (pure data; the driver executes it).
 * ------------------------------------------------------------------ */

const AWDB_DATA =
  'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data' +
  '?stationTriplets=679:WA:SNTL&elements=WTEQ&duration=DAILY&beginDate=2026-01-01&endDate=2026-01-02';
const AWDB_STATIONS =
  'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations' +
  '?stationTriplets=*:WA:SNTL&activeOnly=true&returnStationElements=false';
const AGRIMET_SITES = 'https://www.usbr.gov/gp/agrimet/data_files/AgrimetSites.js';
const HYDROMET_ARC =
  'https://www.usbr.gov/pn-bin/webarccsv.pl' +
  '?parameter=OWY AF&syer=2026&smnth=1&sdy=1&eyer=2026&emnth=1&edy=2&format=2';
const NWRFC_WS =
  'https://www.nwrfc.noaa.gov/water_supply/ws_report_csv.cgi' +
  '?Type=ALL&Source=ALL&Wyr=2026&WyrDate=2026-01-02&Flavor=ESP10';
const USDM_DSCI =
  'https://usdmdataservices.unl.edu/api/StateStatistics/GetDSCI' +
  '?aoi=53&startdate=1/1/2026&enddate=1/7/2026&statisticsType=1';
const WHP_EXPORT_IMAGE =
  'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/' +
  'USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage' +
  '?bbox=-13887106,5700582,-13877106,5710582&bboxSR=3857&imageSR=3857' +
  '&size=256,256&format=png&transparent=true&f=image';
const NWS_POINT = 'https://api.weather.gov/points/38.5,-97.5';
const NWS_GRIDPOINT = 'https://api.weather.gov/gridpoints/TOP/31,80/forecast';
const NWS_STATION_OBSERVATION = 'https://api.weather.gov/stations/KTOP/observations/latest';
const NWS_ALERTS = 'https://api.weather.gov/alerts/active?point=38.5,-97.5';

/** An allowed HOST with a path that is not an allowed route. This is the
 * probe that caught the live general relay: it answered 200 with 50 bytes. */
const OFF_ROUTE_ALLOWED_HOST = 'https://www.usbr.gov/robots.txt';
/** A host that was never on any allow-list. */
const FOREIGN_HOST = 'https://example.com/';
/** A host the reviewed revision REMOVED. A relay here is the old policy. */
const REMOVED_HOST = 'https://cpc.ncep.noaa.gov/';

/**
 * The static endpoint the transparency pair uses: a fixed JavaScript site
 * registry, small, public, and not regenerated per request, so a direct
 * fetch and a relayed fetch of the same bytes are comparable.
 */
export const TRANSPARENCY_UPSTREAM = AGRIMET_SITES;

/** CORS expectation shared by every response the Worker itself produces. */
const WORKER_CORS = Object.freeze({
  allowOrigin: EXPECTED_ALLOW_ORIGIN,
  allowMethods: EXPECTED_ALLOW_METHODS,
  allowHeaders: EXPECTED_ALLOW_HEADERS,
});

/** A relayed upstream response carries the injected origin and method
 * advertisement; the request-header advertisement rides only on responses
 * the Worker synthesizes, so it is not asserted on a relayed body. */
const RELAY_CORS = Object.freeze({
  allowOrigin: EXPECTED_ALLOW_ORIGIN,
  allowMethods: EXPECTED_ALLOW_METHODS,
});

const relay = (id, name, upstream) => ({
  id,
  row: 4,
  name,
  method: 'GET',
  path: '/proxy',
  upstream,
  hash: false,
  expect: {
    status: '2xx',
    error: null,
    cors: RELAY_CORS,
    upstreamTolerant: true,
    budgetMs: RELAY_BUDGET_MS,
  },
});

/**
 * Every probe the driver runs, in order, keyed to the plan's 14 rows. Row 1
 * and row 2 are the health probe, evaluated by evaluateHealthz. Row 12 is
 * the transparency pair, which the driver builds with a fresh cache-busting
 * nonce and evaluateTransparency judges. Row 14 is the elapsed budget
 * carried on each relay row rather than a probe of its own.
 */
export const PROBES = Object.freeze([
  {
    id: 'healthz',
    row: 1,
    name: 'GET /healthz',
    method: 'GET',
    path: '/healthz',
    health: true,
  },
  {
    id: 'healthz-head',
    row: 3,
    // A HEAD response carries no body, so no probe on this method can read
    // the Worker's error code. Every HEAD row asserts the status and the
    // headers only, and the same refusal is asserted by code on a GET. The
    // `Allow` header this row returns is recorded, not asserted: what the
    // health endpoint offers is narrower than the relay and still settling.
    name: 'HEAD /healthz is refused',
    method: 'HEAD',
    path: '/healthz',
    expect: { status: 405, cors: WORKER_CORS },
  },
  relay('relay-awdb-data', 'GET relay: AWDB data', AWDB_DATA),
  relay('relay-awdb-stations', 'GET relay: AWDB stations', AWDB_STATIONS),
  relay('relay-agrimet-sites', 'GET relay: AgriMet site registry', AGRIMET_SITES),
  relay('relay-hydromet-arc', 'GET relay: Hydromet daily arc CSV', HYDROMET_ARC),
  relay('relay-nwrfc-ws', 'GET relay: NWRFC water-supply CSV', NWRFC_WS),
  relay('relay-usdm-dsci', 'GET relay: USDM DSCI statistics', USDM_DSCI),
  relay('relay-whp-export', 'GET relay: USFS WHP exportImage tile', WHP_EXPORT_IMAGE),
  relay('relay-nws-point', 'GET relay: NWS point metadata', NWS_POINT),
  relay('relay-nws-gridpoint', 'GET relay: NWS gridpoint forecast', NWS_GRIDPOINT),
  relay('relay-nws-observation', 'GET relay: NWS latest observation', NWS_STATION_OBSERVATION),
  relay('relay-nws-alerts', 'GET relay: NWS active alerts', NWS_ALERTS),
  {
    id: 'head-allowed',
    row: 5,
    name: 'HEAD on an allowed route',
    method: 'HEAD',
    path: '/proxy',
    upstream: AGRIMET_SITES,
    expect: {
      status: '2xx',
      cors: RELAY_CORS,
      upstreamTolerant: true,
      budgetMs: RELAY_BUDGET_MS,
    },
  },
  {
    id: 'head-off-route',
    row: 5,
    name: 'HEAD on an off-route path of an allowed host',
    method: 'HEAD',
    path: '/proxy',
    upstream: OFF_ROUTE_ALLOWED_HOST,
    expect: { status: 403, cors: WORKER_CORS },
  },
  {
    id: 'options-allowed',
    row: 6,
    name: 'OPTIONS preflight for an allowed target',
    method: 'OPTIONS',
    path: '/proxy',
    upstream: NWS_POINT,
    expect: {
      status: 204,
      error: null,
      cors: { ...WORKER_CORS, maxAge: EXPECTED_PREFLIGHT_MAX_AGE },
    },
  },
  {
    id: 'options-off-route',
    row: 6,
    name: 'OPTIONS preflight for an off-route target',
    method: 'OPTIONS',
    path: '/proxy',
    upstream: OFF_ROUTE_ALLOWED_HOST,
    expect: { status: 403, error: 'route_not_allowed', cors: WORKER_CORS },
  },
  {
    id: 'options-unknown-path',
    row: 6,
    name: 'OPTIONS on an unknown path',
    method: 'OPTIONS',
    path: '/nope',
    expect: { status: 404, error: 'not_found', cors: WORKER_CORS },
  },
  {
    id: 'post-allowed-route',
    row: 7,
    name: 'POST (empty body) on an allowed route',
    method: 'POST',
    path: '/proxy',
    upstream: NWS_POINT,
    expect: {
      status: 405,
      error: 'method_not_allowed',
      cors: WORKER_CORS,
      // RFC 9110 section 15.5.6 requires a 405 to name the methods it does
      // accept, and the reviewed candidate emits `Allow` on this refusal
      // BEFORE any host lookup, so the header is asserted rather than
      // merely recorded. The live 2026-07-29 edge sends neither the 405 nor
      // the header.
      allow: { value: EXPECTED_ALLOW_METHODS, required: true },
    },
  },
  {
    id: 'off-route-allowed-host',
    row: 8,
    name: 'GET an off-route path of an allowed host',
    method: 'GET',
    path: '/proxy',
    upstream: OFF_ROUTE_ALLOWED_HOST,
    expect: { status: 403, error: 'route_not_allowed', cors: WORKER_CORS },
  },
  {
    id: 'foreign-host',
    row: 9,
    name: 'GET a host that was never allow-listed',
    method: 'GET',
    path: '/proxy',
    upstream: FOREIGN_HOST,
    expect: { status: 403, error: 'route_not_allowed', cors: WORKER_CORS },
  },
  {
    id: 'removed-host',
    row: 10,
    name: 'GET a host the reviewed revision removed',
    method: 'GET',
    path: '/proxy',
    upstream: REMOVED_HOST,
    expect: { status: 403, error: 'route_not_allowed', cors: WORKER_CORS },
  },
  {
    id: 'unknown-path',
    row: 11,
    name: 'GET an unknown path',
    method: 'GET',
    path: '/nope',
    expect: { status: 404, error: 'not_found', cors: WORKER_CORS },
  },
  {
    id: 'bounds-missing-url',
    row: 13,
    name: 'bounds: no url parameter',
    method: 'GET',
    path: '/proxy',
    expect: { status: 400, error: 'missing_url', cors: WORKER_CORS },
  },
  {
    id: 'bounds-two-url-params',
    row: 13,
    name: 'bounds: two url parameters',
    method: 'GET',
    path: '/proxy',
    rawQuery: `url=${encodeURIComponent(AGRIMET_SITES)}&url=${encodeURIComponent(NWS_POINT)}`,
    expect: { status: 400, error: 'invalid_url_count', cors: WORKER_CORS },
  },
  {
    id: 'bounds-url-too-long',
    row: 13,
    // 2049 characters: one past the 2048-character cap in the reviewed
    // source, so the length gate answers before the URL is parsed.
    name: 'bounds: a 2049-character url',
    method: 'GET',
    path: '/proxy',
    upstream: `${AGRIMET_SITES}?pad=${'a'.repeat(2049 - AGRIMET_SITES.length - 5)}`,
    expect: { status: 414, error: 'url_too_long', cors: WORKER_CORS },
  },
  {
    id: 'bounds-http-scheme',
    row: 13,
    name: 'bounds: an http upstream',
    method: 'GET',
    path: '/proxy',
    upstream: AGRIMET_SITES.replace('https://', 'http://'),
    expect: { status: 400, error: 'unsupported_scheme', cors: WORKER_CORS },
  },
  {
    id: 'bounds-credentials',
    row: 13,
    name: 'bounds: credentials in the upstream url',
    method: 'GET',
    path: '/proxy',
    upstream: AGRIMET_SITES.replace('https://', 'https://user:secret@'),
    expect: { status: 400, error: 'credentials_not_allowed', cors: WORKER_CORS },
  },
  {
    id: 'bounds-port',
    row: 13,
    // Not :443. The URL parser drops the default port, so the port gate
    // would never see it.
    name: 'bounds: a non-default port',
    method: 'GET',
    path: '/proxy',
    upstream: AGRIMET_SITES.replace('www.usbr.gov', 'www.usbr.gov:8443'),
    expect: { status: 400, error: 'port_not_allowed', cors: WORKER_CORS },
  },
]);

/** The public request URL for one probe. Pure: the driver does the fetch. */
export function probeUrl(base, probe) {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  if (probe.rawQuery !== undefined) return `${root}${probe.path}?${probe.rawQuery}`;
  if (probe.upstream !== undefined) {
    return `${root}${probe.path}?url=${encodeURIComponent(probe.upstream)}`;
  }
  return `${root}${probe.path}`;
}

/* ------------------------------------------------------------------ *
 * Evaluators.
 * ------------------------------------------------------------------ */

const headerLabels = Object.freeze({
  allowOrigin: 'Access-Control-Allow-Origin',
  allowMethods: 'Access-Control-Allow-Methods',
  allowHeaders: 'Access-Control-Allow-Headers',
  maxAge: 'Access-Control-Max-Age',
});

function corsReasons(headers, expected) {
  const reasons = [];
  for (const [key, want] of Object.entries(expected ?? {})) {
    const got = headers?.[key] ?? null;
    if (got !== want) {
      reasons.push(`${headerLabels[key] ?? key} ${got === null ? 'absent' : `"${got}"`}, expected "${want}"`);
    }
  }
  return reasons;
}

/**
 * Row 1 and row 2: the health endpoint names the revision that is actually
 * running, and advertises the reviewed CORS policy with no caching.
 *
 * The advertised method set is an argument, not a constant: the relay's
 * `GET, HEAD, OPTIONS` is the default, but what the health endpoint offers
 * is a policy question of its own and the caller names it.
 *
 * @param {{status: number, revision: ?string, headers: object,
 *   networkError: ?string}} row
 * @param {{expectRevision: string, expectMethods: ?string}} expect
 */
export function evaluateHealthz(row, { expectRevision, expectMethods = DEFAULT_HEALTHZ_ALLOW_METHODS }) {
  const reasons = [];
  if (row?.networkError) return { ok: false, reasons: [`request failed: ${row.networkError}`], warnings: [] };
  if (row?.status !== 200) reasons.push(`status ${row?.status ?? 'none'}, expected 200`);
  const revision = row?.revision ?? null;
  if (!revision) reasons.push('the health document carried no revision field');
  else if (revision !== expectRevision) {
    reasons.push(`revision "${revision}", expected "${expectRevision}"`);
  }
  reasons.push(...corsReasons(row?.headers, { ...WORKER_CORS, allowMethods: expectMethods }));
  const cacheControl = row?.headers?.cacheControl ?? null;
  if (cacheControl !== 'no-store') {
    reasons.push(`Cache-Control ${cacheControl === null ? 'absent' : `"${cacheControl}"`}, expected "no-store"`);
  }
  return { ok: reasons.length === 0, reasons, warnings: [] };
}

function statusMatches(expected, status) {
  if (expected === '2xx') return status >= 200 && status < 300;
  return status === expected;
}

/**
 * One probe-table row: the status AND the Worker's own error code, because
 * they answer different questions. Today's live edge answers 403 to a POST
 * on an allowed route; the status alone reads as a rejection, but the code
 * shows the method gate never fired and something downstream refused. A
 * receipt that checked only the status would score that row as a pass.
 *
 * `error: null` in an expectation means the opposite assertion: no Worker
 * error code may be present, so a relayed 200 cannot be confused with a
 * JSON refusal that happens to carry a 2xx.
 *
 * @param {{status: number, error: ?string, headers: object, elapsedMs: ?number,
 *   networkError: ?string}} row
 * @param {object} expectation
 */
export function evaluateProbe(row, expectation) {
  const warnings = [];
  if (row?.networkError) {
    // A relay row that never completed says something about the agency at
    // the other end, not about the route policy, so it is recorded the same
    // way an upstream 504 is. Rows that assert a refusal are not tolerant:
    // an edge that cannot answer at all must fail those loudly.
    const message = `request failed after ${row.elapsedMs ?? '?'} ms: ${row.networkError}`;
    return expectation?.upstreamTolerant === true
      ? { ok: true, reasons: [], warnings: [`upstream unavailable: ${message}`] }
      : { ok: false, reasons: [message], warnings };
  }
  const reasons = [];
  const observedError = row?.error ?? null;
  const tolerated =
    expectation?.upstreamTolerant === true &&
    (UPSTREAM_STATUSES.has(row?.status) || UPSTREAM_CODES.has(observedError));

  const outcome = [];
  if (expectation?.status !== undefined && !statusMatches(expectation.status, row?.status)) {
    outcome.push(`status ${row?.status ?? 'none'}, expected ${expectation.status}`);
  }
  if (expectation?.error === null) {
    if (observedError !== null) outcome.push(`the Worker refused with "${observedError}"`);
  } else if (typeof expectation?.error === 'string' && observedError !== expectation.error) {
    outcome.push(`error code ${observedError === null ? 'absent' : `"${observedError}"`}, expected "${expectation.error}"`);
  }
  // An agency outage is not a policy failure. It is still recorded, so a
  // receipt that passes with an unavailable upstream says so out loud.
  if (tolerated && outcome.length > 0) warnings.push(`upstream unavailable: ${outcome.join('; ')}`);
  else reasons.push(...outcome);

  reasons.push(...corsReasons(row?.headers, expectation?.cors));

  if (expectation?.allow) {
    const got = row?.headers?.allow ?? null;
    if (got === null) {
      const message = `Allow absent, expected "${expectation.allow.value}" (RFC 9110 section 15.5.6)`;
      if (expectation.allow.required) reasons.push(message);
      else warnings.push(message);
    } else if (got !== expectation.allow.value) {
      reasons.push(`Allow "${got}", expected "${expectation.allow.value}"`);
    }
  }

  if (expectation?.budgetMs && Number.isFinite(row?.elapsedMs) && row.elapsedMs > expectation.budgetMs) {
    warnings.push(`answered in ${row.elapsedMs} ms, past the ${expectation.budgetMs} ms upstream deadline`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Row 12: the relay hands back the upstream bytes unchanged.
 *
 * Cache caveat, and why this is one static endpoint and not the whole
 * table. Two fetches of a dynamic upstream differ for honest reasons, and a
 * relayed response can be served from the 60-second edge cache while the
 * direct leg is not, so a general direct-versus-relay hash false-fails on
 * timing rather than on transparency. The pair is therefore run against a
 * fixed, published site registry, with a fresh cache-busting query on both
 * legs so neither the edge cache nor an intermediary can answer from a
 * stored copy, and the direct leg goes first so the relay cannot be the
 * thing that warmed an upstream cache. Byte transparency across the rest of
 * the table is proved before publishing, on synthetic bytes, in
 * tests/worker-proxy-policy.spec.ts. A non-200 direct leg is inconclusive
 * rather than proof, and says so.
 *
 * @param {{direct: object, proxied: object}} pair
 */
export function evaluateTransparency({ direct, proxied } = {}) {
  const reasons = [];
  const warnings = [];
  if (direct?.networkError) reasons.push(`direct leg failed: ${direct.networkError}`);
  if (proxied?.networkError) reasons.push(`relayed leg failed: ${proxied.networkError}`);
  if (reasons.length > 0) return { ok: false, reasons, warnings };

  if (direct?.status !== 200) {
    reasons.push(`direct leg answered ${direct?.status ?? 'nothing'}; the comparison is inconclusive, not a transparency failure`);
  }
  if (proxied?.status !== 200) {
    reasons.push(`relayed leg answered ${proxied?.status ?? 'nothing'}, expected 200`);
  }
  if (reasons.length === 0) {
    if (direct.bytes !== proxied.bytes) {
      reasons.push(`relayed ${proxied.bytes} bytes, upstream ${direct.bytes} bytes`);
    }
    if (direct.sha256 !== proxied.sha256) {
      reasons.push(`relayed sha256 ${proxied.sha256}, upstream sha256 ${direct.sha256}`);
    }
  }
  const age = Number(proxied?.headers?.age ?? 0);
  if (Number.isFinite(age) && age > 0) {
    warnings.push(`the relayed leg carried Age ${age}, so an edge copy answered despite the cache-busting query`);
  }
  return { ok: reasons.length === 0, reasons, warnings };
}

export function receiptOk(receipt) {
  return receipt.checks.length > 0 && receipt.checks.every((c) => c.ok);
}

export function renderSummary(receipt) {
  const lines = [];
  lines.push(`## Worker edge receipt: ${receiptOk(receipt) ? 'pass' : 'FAIL'}`);
  lines.push('');
  lines.push(
    `Base \`${receipt.base}\`; expected revision \`${receipt.expectRevision}\`; ` +
      `live revision \`${receipt.observedRevision ?? '(none)'}\`; ` +
      `expected health methods \`${receipt.expectHealthzMethods ?? DEFAULT_HEALTHZ_ALLOW_METHODS}\`; ` +
      `${receipt.checks.filter((c) => !c.ok).length} of ${receipt.checks.length} checks failing.`,
  );
  lines.push('');
  lines.push('| Row | Probe | Method | Status | Error | Verdict | Detail |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of receipt.checks) {
    const detail = [...c.reasons, ...(c.warnings ?? []).map((w) => `warning: ${w}`)].join('; ');
    lines.push(
      `| ${c.row ?? ''} | ${c.name} | ${c.method ?? ''} | ${c.status ?? ''} | ${c.error ?? ''} | ` +
        `${c.ok ? 'pass' : 'FAIL'} | ${detail} |`,
    );
  }
  if (receipt.transparency) {
    const t = receipt.transparency;
    lines.push('');
    lines.push(
      `Body transparency (row 12): upstream ${t.direct?.bytes ?? '?'} bytes sha256 \`${t.direct?.sha256 ?? '?'}\`; ` +
        `relayed ${t.proxied?.bytes ?? '?'} bytes sha256 \`${t.proxied?.sha256 ?? '?'}\`. ` +
        'One static, cache-busted endpoint; the rest of the table proves transparency on synthetic bytes before a publish.',
    );
  }
  if (receipt.timing) {
    lines.push('');
    lines.push(
      `Slowest relay ${receipt.timing.maxRelayMs ?? '?'} ms against the ${receipt.timing.budgetMs} ms upstream deadline ` +
        `(${receipt.timing.probe ?? 'none'}).`,
    );
  }
  return lines.join('\n') + '\n';
}
