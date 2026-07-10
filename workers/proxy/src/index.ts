/**
 * Dynamic Drought Module (DDM) Cross-Origin Resource Sharing (CORS) proxy.
 *
 * This Cloudflare Worker is a thin, stateless shim. It accepts requests at
 * `/proxy?url=<encoded_upstream_url>`, validates the upstream host against a
 * small allow-list of public agency telemetry endpoints, forwards the request
 * (without cookies or Authorization), returns the upstream body unchanged, and
 * injects the CORS response headers a browser needs to consume the body.
 *
 * Allow-listed upstreams (host-only check):
 *   - Natural Resources Conservation Service (NRCS) Air-Water Database (AWDB):
 *     any subdomain of `sc.egov.usda.gov`.
 *   - United States Army Corps of Engineers (USACE) Dataquery 2.0:
 *     any subdomain of `usace.army.mil`.
 *   - United States Bureau of Reclamation (USBR) Hydromet:
 *     `usbr.gov` or `www.usbr.gov`.
 *   - Northwest River Forecast Center (NWRFC) of the National Oceanic and
 *     Atmospheric Administration (NOAA): `nwrfc.noaa.gov` or `www.nwrfc.noaa.gov`.
 *   - NOAA Climate Prediction Center (CPC): any subdomain of `cpc.ncep.noaa.gov`
 *     (the Oceanic Nino Index and other indices are served without Cross-Origin
 *     Resource Sharing headers; the default path is a build-time snapshot, but
 *     the host is allow-listed for anything that must be fetched live).
 *   - Bureau of Indian Affairs (BIA) map hosts: `biamaps.geoplatform.gov`
 *     (the live American Indian and Alaska Native Land Area Representation host)
 *     and `biamaps.doi.gov` (the fallback host). The geoplatform host serves
 *     reflective CORS today; the allow-list entry is a resilience path.
 *   - Federal GeoPlatform imagery host: `imagery.geoplatform.gov` (the USFS
 *     Wildfire Hazard Potential ImageServer). Its `exportImage` CORS is
 *     INTERMITTENT in real browsers (2026-07-09: 49 of 49 tile responses
 *     arrived without Access-Control-Allow-Origin while a curl probe with an
 *     Origin header got the origin-echoed value; `Vary: Origin` cache-variant
 *     behavior suspected), so the client routes WHP tiles through this Worker
 *     unconditionally (0.7.0 H3).
 *
 * Anything outside the allow-list is rejected with 403 Forbidden.
 *
 * Hard rules (see CLAUDE.md section 4):
 *   - The Worker MUST NOT transform response bodies.
 *   - The Worker MUST NOT cache aggressively (default time-to-live 60 seconds).
 *   - The Worker MUST NOT log request bodies, headers, or query strings.
 *   - The Worker MUST NOT add tracking, analytics, or telemetry collection.
 *   - The Worker MUST strip `cookie` and `authorization` headers before
 *     forwarding to upstream.
 *
 * Operational notes:
 *   - The upstream fetch is bounded by a 12 second timeout, matching the
 *     in-browser per-mirror budget used by the client.
 *   - Successful responses are stored in `caches.default` keyed by the request
 *     URL plus method, so repeated requests within the time-to-live are served
 *     from the Cloudflare edge cache instead of re-hitting the upstream.
 *   - Health check at `GET /healthz` returns a small JSON document with no
 *     allow-list enforcement, for uptime monitoring.
 *   - Abuse throttle (critical-review #4). An allow-listed CORS shim with no
 *     throttle is an open relay FOR the allow-listed hosts: anyone can drive
 *     arbitrary traffic through the deployer's Cloudflare account, at the
 *     deployer's cost and against the deployer's reputation with the upstream
 *     agency. Three guards keep it a shim without becoming a relay: a per-client
 *     rate limit via the platform Rate Limiting binding (fails OPEN if the
 *     binding is not configured, so a fork or local run still works); a request
 *     body and `url`-length cap; and honest pass-through of an upstream 429 with
 *     its Retry-After. None of this transforms bodies or adds state beyond the
 *     platform primitives, so the shim contract (CLAUDE.md rule 7) holds.
 */

const ALLOW_LIST: ReadonlyArray<RegExp> = [
  // NRCS AWDB. The published hosts are `wcc.sc.egov.usda.gov` and
  // `wcc-nwcc.sc.egov.usda.gov`; the regex matches any single-label
  // subdomain of `sc.egov.usda.gov` to absorb future hostname changes.
  /^[a-z0-9-]+\.sc\.egov\.usda\.gov$/i,
  // USACE Dataquery 2.0. Published hosts include `www.nwd-wc.usace.army.mil`
  // and `lockproduction.usace.army.mil`; the regex matches any subdomain of
  // `usace.army.mil` (and `usace.army.mil` itself).
  /^([a-z0-9-]+\.)*usace\.army\.mil$/i,
  // USBR Hydromet. `www.usbr.gov` is the canonical host; bare `usbr.gov` is
  // accepted for resilience to redirect chains.
  /^(www\.)?usbr\.gov$/i,
  // NWRFC. `www.nwrfc.noaa.gov` is the canonical host; bare `nwrfc.noaa.gov`
  // is accepted for resilience to redirect chains.
  /^(www\.)?nwrfc\.noaa\.gov$/i,
  // NOAA CPC. Indices (the Oceanic Nino Index, Relative ONI, Southern
  // Oscillation Index, detrended Nino 3.4) and the analysis pages live under
  // `cpc.ncep.noaa.gov`; the regex matches any subdomain (and the apex).
  /^([a-z0-9-]+\.)*cpc\.ncep\.noaa\.gov$/i,
  // BIA map hosts: the live AIAN-LAR host (`biamaps.geoplatform.gov`) and the
  // fallback (`biamaps.doi.gov`).
  /^biamaps\.(geoplatform\.gov|doi\.gov)$/i,
  // Federal GeoPlatform imagery host (USFS Wildfire Hazard Potential
  // ImageServer). Added 2026-07-09 (0.7.0 H3): the upstream's exportImage
  // CORS is intermittent in real browsers, so WHP tiles ride this Worker.
  /^imagery\.geoplatform\.gov$/i
];

const USER_AGENT =
  "DDM-Proxy/0.1.0 (+https://github.com/atniclimate/dynamic-drought-module)";

const UPSTREAM_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_CONTROL = "public, max-age=60";

// Abuse-throttle bounds (critical-review #4). The rate limit itself lives in the
// platform binding (wrangler.toml [[ratelimits]]); these cap a single request's
// size so a hostile caller cannot force large upstream reads or oversized URLs.
// The allow-listed upstreams are read endpoints that take short query strings and
// small POST bodies, so these ceilings are far above any legitimate call.
const MAX_UPSTREAM_URL_LENGTH = 2048;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
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
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Headers that must never be forwarded to upstream from the inbound request.
// Cookies and Authorization are stripped per the no-authentication policy
// (CLAUDE.md section 4 rule 3); Host is set by `fetch()` from the upstream URL
// and must not be carried over from the inbound request.
const HEADERS_TO_STRIP_FROM_REQUEST: ReadonlySet<string> = new Set([
  "cookie",
  "authorization",
  "host"
]);

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

function isAllowedHost(host: string): boolean {
  return ALLOW_LIST.some((rx) => rx.test(host));
}

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
 * Build the upstream Request from the inbound Request. Method, body, and
 * most headers are preserved; cookies, Authorization, and Host are stripped.
 * The User-Agent is always set so upstream operators can attribute the traffic.
 */
function buildUpstreamRequest(inbound: Request, upstreamUrl: URL): Request {
  const upstreamHeaders = new Headers();
  for (const [name, value] of inbound.headers) {
    if (HEADERS_TO_STRIP_FROM_REQUEST.has(name.toLowerCase())) {
      continue;
    }
    upstreamHeaders.set(name, value);
  }
  upstreamHeaders.set("User-Agent", USER_AGENT);
  upstreamHeaders.set("Host", upstreamUrl.host);

  const init: RequestInit = {
    method: inbound.method,
    headers: upstreamHeaders,
    // Redirects are NOT followed automatically: the runtime would chase a 3xx
    // Location to any host, bypassing the allow-list (a server-side request
    // forgery amplification). `fetchUpstreamWithTimeout` follows redirects
    // manually, re-validating each hop's host against the allow-list.
    redirect: "manual"
  };

  // GET and HEAD requests must not carry a body. For other methods, forward
  // the body as a stream to avoid buffering large payloads in memory.
  const method = inbound.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && inbound.body !== null) {
    init.body = inbound.body;
  }

  return new Request(upstreamUrl.toString(), init);
}

/**
 * Build the response we send back to the browser, given the upstream response.
 * Headers are copied with the strip-list applied; CORS headers are injected;
 * the body is passed through unchanged; the upstream `Cache-Control` is kept
 * if present, otherwise a short default time-to-live is applied.
 */
function buildClientResponse(upstream: Response): Response {
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (HEADERS_TO_STRIP_FROM_RESPONSE.has(name.toLowerCase())) {
      continue;
    }
    responseHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set("Cache-Control", DEFAULT_CACHE_CONTROL);
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
function parseAndValidateUpstream(request: Request): URL | Response {
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");
  if (target === null || target === "") {
    return jsonError(
      400,
      "missing_url",
      "Query parameter 'url' is required and must be a fully qualified upstream URL."
    );
  }

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

  if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
    return jsonError(
      400,
      "unsupported_scheme",
      "Only http and https upstream URLs are supported."
    );
  }

  if (!isAllowedHost(upstreamUrl.hostname)) {
    return jsonError(
      403,
      "host_not_allowed",
      `Upstream host '${upstreamUrl.hostname}' is not on the proxy allow-list.`
    );
  }

  return upstreamUrl;
}

// Maximum redirect hops to follow before failing closed.
const MAX_REDIRECT_HOPS = 5;

/**
 * Fetch the upstream with a hard timeout, following redirects MANUALLY so each
 * hop's host is re-validated against the allow-list. A 3xx whose Location is
 * off the allow-list (or not http/https, or malformed) fails closed with a
 * 403/502 rather than being chased; this closes the redirect-bypass SSRF hole
 * that `redirect: "follow"` would open. Request bodies are not replayed across
 * redirects (the allow-listed upstreams are read endpoints), so a followed hop
 * is re-issued as GET (or HEAD) with the same headers. AbortController is wired
 * so the runtime tears down the request cleanly when the deadline expires; the
 * timeout spans all hops.
 */
async function fetchUpstreamWithTimeout(
  upstreamRequest: Request,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let request = upstreamRequest;
    for (let hop = 0; ; hop++) {
      const resp = await fetch(request, { signal: controller.signal });
      const isRedirect = resp.status >= 300 && resp.status < 400;
      const location = isRedirect ? resp.headers.get("location") : null;
      if (!location) {
        return resp;
      }
      if (hop >= MAX_REDIRECT_HOPS) {
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
        return jsonError(
          502,
          "invalid_redirect",
          "Upstream returned a redirect with an invalid Location."
        );
      }
      if (
        (next.protocol !== "http:" && next.protocol !== "https:") ||
        !isAllowedHost(next.hostname)
      ) {
        return jsonError(
          403,
          "redirect_not_allowed",
          `Upstream redirected to '${next.hostname}', which is not on the proxy allow-list.`
        );
      }
      const followHeaders = new Headers(request.headers);
      followHeaders.set("Host", next.host);
      request = new Request(next.toString(), {
        method: request.method.toUpperCase() === "HEAD" ? "HEAD" : "GET",
        headers: followHeaders,
        redirect: "manual"
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the cache key for a given upstream URL and method. Caching is keyed on
 * the upstream URL (not on the proxy request URL) so that different proxy
 * paths that resolve to the same upstream share a cache entry. We only cache
 * idempotent reads (GET and HEAD).
 */
function buildCacheKey(upstreamUrl: URL, method: string): Request {
  const normalizedMethod = method.toUpperCase();
  return new Request(upstreamUrl.toString(), { method: normalizedMethod });
}

function isCacheableMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
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

    // Allow only methods we have a defined story for. PUT, DELETE, PATCH are
    // not currently used by any DDM client and are rejected to keep the
    // attack surface small.
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      return jsonError(
        405,
        "method_not_allowed",
        "The /proxy endpoint accepts GET, HEAD, POST, and OPTIONS."
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

    // Cap the request body (critical-review #4). The allow-listed upstreams take
    // small query bodies, so a declared Content-Length above the ceiling is
    // rejected before we open an upstream connection.
    if (method === "POST") {
      const declaredLength = request.headers.get("content-length");
      if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (Number.isFinite(bytes) && bytes > MAX_REQUEST_BODY_BYTES) {
          return jsonError(
            413,
            "request_too_large",
            `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte proxy limit.`
          );
        }
      }
    }

    const upstreamOrError = parseAndValidateUpstream(request);
    if (upstreamOrError instanceof Response) {
      return upstreamOrError;
    }
    const upstreamUrl: URL = upstreamOrError;

    const cache = caches.default;
    const cacheable = isCacheableMethod(method);
    const cacheKey = buildCacheKey(upstreamUrl, method);

    if (cacheable) {
      const cached = await cache.match(cacheKey);
      if (cached !== undefined) {
        // The cached response already carries the Cross-Origin Resource
        // Sharing (CORS) headers we injected when we wrote it.
        return cached;
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

    // Cache only successful idempotent reads. We clone before handing back so
    // the body stream can be consumed twice (once by the cache, once by the
    // client). `ctx.waitUntil` lets the cache write outlive the response.
    if (cacheable && clientResponse.ok) {
      const responseToCache = clientResponse.clone();
      ctx.waitUntil(cache.put(cacheKey, responseToCache));
    }

    return clientResponse;
  }
};
