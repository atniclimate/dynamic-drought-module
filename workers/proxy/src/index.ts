/**
 * Dynamic Drought Module (DDM) Cross-Origin Resource Sharing (CORS) proxy.
 *
 * This Cloudflare Worker is a thin, stateless shim. It accepts requests at
 * `/proxy?url=<encoded_upstream_url>`, validates the upstream URL against a
 * small table of exact public agency read routes, forwards a minimal request,
 * returns the upstream bytes unchanged, and injects the CORS response headers
 * a browser needs to consume the body.
 *
 * The route table below covers only the exact AWDB, AgriMet, Hydromet, NWRFC,
 * USDM DSCI, USFS WHP, and NWS read operations used by the current DDM client.
 *
 * Anything outside the allow-list is rejected with 403 Forbidden.
 *
 * Hard rules (see CLAUDE.md section 4):
 *   - The Worker MUST NOT transform response bodies.
 *   - The Worker MUST NOT cache aggressively (default time-to-live 60 seconds).
 *   - The Worker MUST NOT log request bodies, headers, or query strings.
 *   - The Worker MUST NOT add tracking, analytics, or telemetry collection.
 *   - The Worker MUST forward only normalized Accept plus its fixed User-Agent.
 *
 * Operational notes:
 *   - The upstream fetch is bounded by a 12 second timeout, matching the
 *     in-browser per-mirror budget used by the client.
 *   - Status-200 GET responses are stored in `caches.default` keyed by the
 *     upstream URL plus normalized Accept, so repeated reads within the
 *     time-to-live are served without mixing media-type variants.
 *   - Health check at `GET /healthz` returns a small JSON document with no
 *     allow-list enforcement, for uptime monitoring.
 *   - Abuse throttle (critical-review #4). An allow-listed CORS shim with no
 *     throttle is an open relay FOR the allow-listed hosts: anyone can drive
 *     arbitrary traffic through the deployer's Cloudflare account, at the
 *     deployer's cost and against the deployer's reputation with the upstream
 *     agency. Three guards keep it a shim without becoming a relay: a per-client
 *     rate limit via the platform Rate Limiting binding (fails OPEN if the
 *     binding is not configured, so a fork or local run still works); a request
 *     exact read-route policy and `url`-length cap; and honest pass-through of
 *     an upstream 429 with its Retry-After. None of this transforms bodies or
 *     adds state beyond the platform primitives, so the shim contract holds.
 */

const EXACT_PATHS_BY_HOST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "wcc.sc.egov.usda.gov",
    new Set([
      "/awdbRestApi/services/v1/data",
      "/awdbRestApi/services/v1/stations"
    ])
  ],
  [
    "www.usbr.gov",
    new Set([
      "/gp/agrimet/data_files/AgrimetSites.js",
      "/pn-bin/webarccsv.pl"
    ])
  ],
  ["www.nwrfc.noaa.gov", new Set(["/water_supply/ws_report_csv.cgi"])],
  [
    "usdmdataservices.unl.edu",
    new Set(["/api/StateStatistics/GetDSCI"])
  ],
  [
    "imagery.geoplatform.gov",
    new Set([
      "/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage"
    ])
  ]
]);

const NWS_POINT_PATH = /^\/points\/-?\d{1,2}(?:\.\d{1,4})?,-?\d{1,3}(?:\.\d{1,4})?$/;
const NWS_GRIDPOINT_PATH =
  /^\/gridpoints\/[a-z0-9]{3,4}\/-?\d+,-?\d+(?:\/(?:stations|forecast))?$/i;
const NWS_LATEST_OBSERVATION_PATH =
  /^\/stations\/[a-z0-9-]+\/observations\/latest$/i;

/** True only for an exact read route used by the current DDM runtime. */
export function isAllowedRoute(upstreamUrl: URL): boolean {
  const exactPaths = EXACT_PATHS_BY_HOST.get(upstreamUrl.hostname);
  if (exactPaths?.has(upstreamUrl.pathname)) return true;
  if (upstreamUrl.hostname !== "api.weather.gov") return false;
  return (
    NWS_POINT_PATH.test(upstreamUrl.pathname) ||
    NWS_GRIDPOINT_PATH.test(upstreamUrl.pathname) ||
    NWS_LATEST_OBSERVATION_PATH.test(upstreamUrl.pathname) ||
    upstreamUrl.pathname === "/alerts/active"
  );
}

const USER_AGENT =
  "DDM-Proxy/0.1.0 (+https://github.com/atniclimate/dynamic-drought-module)";
const WORKER_REVISION = "2026-08-09-route-hardening-v3";

const UPSTREAM_TIMEOUT_MS = 12_000;
const EDGE_CACHE_MAX_AGE_SECONDS = 60;
const EDGE_CACHE_CONTROL = `public, max-age=${EDGE_CACHE_MAX_AGE_SECONDS}`;
const CACHED_ORIGIN_CACHE_CONTROL = "X-DDM-Origin-Cache-Control";

// Abuse-throttle bounds (critical-review #4). The rate limit itself lives in the
// platform binding (wrangler.toml [[ratelimits]]); these cap a single request's
// size so a hostile caller cannot force oversized upstream URLs. Every allowed
// route is a GET/HEAD read, so no request-body allowance is needed.
const MAX_UPSTREAM_URL_LENGTH = 2048;
const MAX_ACCEPT_LENGTH = 512;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * Worker environment bindings. `RATE_LIMITER` is the platform Rate Limiting
 * binding declared in wrangler.toml. It is OPTIONAL on purpose: if a fork
 * removes the [[ratelimits]] stanza, or a local run does not provide it, the
 * throttle fails open rather than 500-ing every request. A repo-standard deploy
 * includes the stanza, so the limit is on by default.
 */
interface Env {
  RATE_LIMITER?: RateLimit;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept"
};

// Headers from the upstream response that we deliberately do not pass through:
// `set-cookie` is dropped to avoid laundering session state, and connection /
// transfer-coding hop-by-hop headers are managed by the runtime.
const HEADERS_TO_STRIP_FROM_RESPONSE: ReadonlySet<string> = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade"
]);

function jsonError(
  status: number,
  code: string,
  detail: string,
  extraHeaders?: Readonly<Record<string, string>>
): Response {
  return new Response(
    JSON.stringify({ error: code, detail }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...CORS_HEADERS,
        ...extraHeaders
      }
    }
  );
}

function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Max-Age": "86400"
    }
  });
}

function healthResponse(): Response {
  const body = JSON.stringify({
    status: "ok",
    worker: "ddm-proxy",
    revision: WORKER_REVISION,
    ts: new Date().toISOString()
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS
    }
  });
}

/**
 * Build the minimal upstream Request. Only normalized Accept and the fixed
 * identifying User-Agent are forwarded. Host is derived from the URL by the
 * Workers runtime; no inbound authentication, forwarding, or browser metadata
 * crosses the proxy boundary.
 */
export function normalizeAccept(inbound: Request): string {
  const accept = inbound.headers.get("Accept")?.trim();
  return accept && accept.length > 0 && accept.length <= MAX_ACCEPT_LENGTH
    ? accept
    : "*/*";
}

export function buildUpstreamRequest(
  inbound: Request,
  upstreamUrl: URL
): Request {
  const upstreamHeaders = new Headers({ Accept: normalizeAccept(inbound) });
  upstreamHeaders.set("User-Agent", USER_AGENT);

  return new Request(upstreamUrl.toString(), {
    method: inbound.method,
    headers: upstreamHeaders,
    // Redirects are NOT followed automatically: the runtime would chase a 3xx
    // Location to any host, bypassing the allow-list (a server-side request
    // forgery amplification). `fetchUpstreamWithTimeout` follows redirects
    // manually, re-validating each hop's host against the allow-list.
    redirect: "manual"
  });
}

/**
 * Build the response we send back to the browser, given the upstream response.
 * Headers are copied with the strip-list applied; CORS headers are injected;
 * the body is passed through unchanged; the upstream `Cache-Control` is kept
 * if present, otherwise a short default time-to-live is applied.
 */
export function buildClientResponse(upstream: Response): Response {
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    const normalizedName = name.toLowerCase();
    if (
      HEADERS_TO_STRIP_FROM_RESPONSE.has(normalizedName) ||
      normalizedName.startsWith("access-control-")
    ) {
      continue;
    }
    responseHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set("Cache-Control", EDGE_CACHE_CONTROL);
  }
  // Pass an upstream 429 through honestly (critical-review #4): keep its status
  // and its Retry-After so the client backs off, and supply a default hint if
  // the upstream omitted one. A 429 is not `ok`, so it is never cached below.
  if (upstream.status === 429 && !responseHeaders.has("Retry-After")) {
    responseHeaders.set("Retry-After", String(RATE_LIMIT_RETRY_AFTER_SECONDS));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

/**
 * Parse the `url` query parameter and validate it. Returns the parsed URL on
 * success, or a Response describing the failure.
 */
export function parseAndValidateUpstream(request: Request): URL | Response {
  const requestUrl = new URL(request.url);
  const targets = requestUrl.searchParams.getAll("url");
  if (targets.length !== 1 || targets[0] === "") {
    return jsonError(
      400,
      targets.length === 0 ? "missing_url" : "invalid_url_count",
      "Exactly one non-empty 'url' query parameter is required."
    );
  }
  const target = targets[0];

  // Cap the upstream URL length before parsing (critical-review #4). An
  // allow-listed read endpoint never needs a multi-kilobyte URL; a very long
  // one is either malformed or an attempt to smuggle an oversized query.
  if (target.length > MAX_UPSTREAM_URL_LENGTH) {
    return jsonError(
      414,
      "url_too_long",
      `Query parameter 'url' exceeds the ${MAX_UPSTREAM_URL_LENGTH}-character limit.`
    );
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return jsonError(
      400,
      "invalid_url",
      "Query parameter 'url' is not a valid URL."
    );
  }

  if (upstreamUrl.protocol !== "https:") {
    return jsonError(
      400,
      "unsupported_scheme",
      "Only https upstream URLs are supported."
    );
  }

  if (upstreamUrl.username !== "" || upstreamUrl.password !== "") {
    return jsonError(
      400,
      "credentials_not_allowed",
      "Upstream URLs must not contain credentials."
    );
  }

  if (upstreamUrl.port !== "") {
    return jsonError(
      400,
      "port_not_allowed",
      "Upstream URLs must use the default HTTPS port."
    );
  }

  if (!isAllowedRoute(upstreamUrl)) {
    return jsonError(
      403,
      "route_not_allowed",
      `Upstream route '${upstreamUrl.hostname}${upstreamUrl.pathname}' is not on the proxy allow-list.`
    );
  }

  return upstreamUrl;
}

// Maximum redirect hops to follow before failing closed.
const MAX_REDIRECT_HOPS = 5;

/**
 * Fetch the upstream with a hard timeout, following redirects MANUALLY so each
 * complete URL is re-validated against the exact route table. The final body is
 * buffered as bytes before the timer is cleared, so the deadline covers DNS,
 * headers, redirects, and body consumption. Rebuilding a Response from that
 * ArrayBuffer preserves the exact bytes without interpreting them.
 */
export async function fetchUpstreamWithTimeout(
  upstreamRequest: Request,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Upstream request timed out.", "TimeoutError")
      ),
    timeoutMs
  );
  try {
    let request = upstreamRequest;
    for (let hop = 0; ; hop++) {
      const resp = await fetchImpl(request, { signal: controller.signal });
      const isRedirect = resp.status >= 300 && resp.status < 400;
      const location = isRedirect ? resp.headers.get("location") : null;
      if (!location) {
        const body =
          request.method.toUpperCase() === "HEAD" || resp.body === null
            ? null
            : await resp.arrayBuffer();
        return new Response(body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers
        });
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        await resp.body?.cancel();
        return jsonError(
          508,
          "too_many_redirects",
          "Upstream exceeded the redirect hop limit."
        );
      }
      let next: URL;
      try {
        next = new URL(location, request.url);
      } catch {
        await resp.body?.cancel();
        return jsonError(
          502,
          "invalid_redirect",
          "Upstream returned a redirect with an invalid Location."
        );
      }
      if (
        next.protocol !== "https:" ||
        next.username !== "" ||
        next.password !== "" ||
        next.port !== "" ||
        !isAllowedRoute(next)
      ) {
        await resp.body?.cancel();
        return jsonError(
          403,
          "redirect_not_allowed",
          `Upstream redirected to '${next.hostname}${next.pathname}', which is not on the proxy allow-list.`
        );
      }
      await resp.body?.cancel();
      const followHeaders = new Headers(request.headers);
      request = new Request(next.toString(), {
        method: request.method,
        headers: followHeaders,
        redirect: "manual"
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the cache key for one normalized representation. Caching is keyed on
 * the upstream URL plus Accept so a response that varies by media type cannot
 * be served to a different client representation.
 */
export function buildCacheKey(upstreamUrl: URL, accept: string): Request {
  const cacheUrl = new URL(upstreamUrl.toString());
  cacheUrl.searchParams.append("__ddm_accept", accept);
  return new Request(cacheUrl.toString(), {
    method: "GET",
    headers: { Accept: accept }
  });
}

function isCacheableMethod(method: string): boolean {
  return method.toUpperCase() === "GET";
}

/**
 * Respect upstream directives that forbid shared caching. Successful public
 * responses may be cached, but their edge lifetime is capped separately.
 */
export function permitsEdgeCaching(response: Response): boolean {
  if (response.status !== 200) return false;
  const vary = (response.headers.get("Vary") ?? "")
    .split(",")
    .map((value) => value.trim());
  if (vary.includes("*")) return false;

  const directives = (response.headers.get("Cache-Control") ?? "")
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim());
  return !directives.some((directive) => {
    const [rawName, rawValue] = directive.split("=", 2);
    const name = rawName?.trim();
    if (name === "no-store" || name === "no-cache" || name === "private") {
      return true;
    }
    return (
      (name === "max-age" || name === "s-maxage") &&
      Number(rawValue?.replaceAll('"', "")) === 0
    );
  });
}

function edgeCacheMaxAge(response: Response): number {
  const directives = (response.headers.get("Cache-Control") ?? "")
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim());

  for (const directiveName of ["s-maxage", "max-age"] as const) {
    const directive = directives.find((candidate) => {
      const [name] = candidate.split("=", 1);
      return name?.trim() === directiveName;
    });
    if (directive === undefined) continue;
    const [, rawValue] = directive.split("=", 2);
    const normalizedValue = rawValue?.trim().replaceAll('"', "") ?? "";
    if (!/^\d+$/.test(normalizedValue)) continue;
    return Math.min(
      EDGE_CACHE_MAX_AGE_SECONDS,
      Number.parseInt(normalizedValue, 10)
    );
  }

  return EDGE_CACHE_MAX_AGE_SECONDS;
}

/**
 * Build the copy stored in caches.default. The original Cache-Control value is
 * retained in an internal marker so cache hits can return the upstream header
 * while Cloudflare expires its own copy after at most 60 seconds.
 */
export function prepareResponseForEdgeCache(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    CACHED_ORIGIN_CACHE_CONTROL,
    headers.get("Cache-Control") ?? EDGE_CACHE_CONTROL
  );
  headers.set(
    "Cache-Control",
    `public, max-age=${edgeCacheMaxAge(response)}`
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Restore the upstream-facing response header on a cache hit. A missing marker
 * identifies an entry written by an older Worker revision, which must be
 * bypassed so the 60-second ceiling is not silently inherited.
 */
export function restoreResponseFromEdgeCache(
  response: Response
): Response | null {
  const originCacheControl = response.headers.get(
    CACHED_ORIGIN_CACHE_CONTROL
  );
  if (originCacheControl === null) return null;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", originCacheControl);
  headers.delete(CACHED_ORIGIN_CACHE_CONTROL);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Preflight: handle Cross-Origin Resource Sharing (CORS) OPTIONS requests
    // for any path. The browser may probe before issuing the real request.
    if (request.method === "OPTIONS") {
      return preflightResponse();
    }

    // Health endpoint: no allow-list check, no upstream fetch, no caching.
    if (url.pathname === "/healthz") {
      if (request.method !== "GET") {
        return jsonError(
          405,
          "method_not_allowed",
          "The /healthz endpoint accepts GET only."
        );
      }
      return healthResponse();
    }

    if (url.pathname !== "/proxy") {
      return jsonError(
        404,
        "not_found",
        "Unknown path. Use /proxy?url=<encoded_upstream_url> or /healthz."
      );
    }

    // The current DDM routes are reads. Reject every mutating method to keep
    // this shim incapable of submitting state changes to an allowed agency.
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return jsonError(
        405,
        "method_not_allowed",
        "The /proxy endpoint accepts GET, HEAD, and OPTIONS."
      );
    }

    // Per-client rate limit (critical-review #4). Keyed on the real client IP
    // Cloudflare attaches at the edge. Fails OPEN when the binding is absent so
    // a fork or local run without the [[ratelimits]] stanza still serves. Only
    // real proxy calls are limited; the health check above is exempt so uptime
    // monitors are never throttled.
    if (env.RATE_LIMITER) {
      const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
      if (!success) {
        return jsonError(
          429,
          "rate_limited",
          "Too many proxy requests from this client; slow down and retry.",
          { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS) }
        );
      }
    }

    const upstreamOrError = parseAndValidateUpstream(request);
    if (upstreamOrError instanceof Response) {
      return upstreamOrError;
    }
    const upstreamUrl: URL = upstreamOrError;

    const cache = caches.default;
    const cacheable = isCacheableMethod(method);
    const cacheKey = buildCacheKey(upstreamUrl, normalizeAccept(request));

    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached !== undefined) {
        const restored = restoreResponseFromEdgeCache(cached);
        if (restored !== null) return restored;
      }
    }

    let upstreamResponse: Response;
    try {
      const upstreamRequest = buildUpstreamRequest(request, upstreamUrl);
      upstreamResponse = await fetchUpstreamWithTimeout(
        upstreamRequest,
        UPSTREAM_TIMEOUT_MS
      );
    } catch (err: unknown) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError");
      if (isAbort) {
        return jsonError(
          504,
          "upstream_timeout",
          `Upstream did not respond within ${UPSTREAM_TIMEOUT_MS} milliseconds.`
        );
      }
      const message =
        err instanceof Error ? err.message : "Unknown fetch failure.";
      return jsonError(502, "upstream_unreachable", message);
    }

    const clientResponse = buildClientResponse(upstreamResponse);

    // Cache only status-200 idempotent reads. We clone before handing back so
    // the body stream can be consumed twice (once by the cache, once by the
    // client). `ctx.waitUntil` lets the cache write outlive the response.
    if (
      cacheable &&
      permitsEdgeCaching(clientResponse)
    ) {
      const responseToCache = prepareResponseForEdgeCache(
        clientResponse.clone()
      );
      ctx.waitUntil(cache.put(cacheKey, responseToCache).catch(() => undefined));
    }

    return clientResponse;
  }
};
