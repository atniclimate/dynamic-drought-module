/**
 * ddm-terrain: the Dynamic Drought Module's terrain elevation archive, served
 * from R2 with byte ranges and CORS (DR-079, owner ruling 2026-09-10).
 *
 * WHY THIS EXISTS. The 3D Fire scene answers one question: is a fire at the
 * foot of a mountain, and would it run uphill. The bundled archive
 * (public/data/hillshade-dem-pnw.pmtiles, zooms 0 to 8, about 212 m per pixel
 * at 46N) cannot answer it. Measured in the running scene through
 * queryTerrainElevation on 2026-09-10, it reads the Mount Jefferson summit
 * 931 m low while reading the Bend valley floor within 19 m: a coarse
 * elevation model does not lower a landscape, it flattens it, and the mountain
 * is exactly what it removes. The same box at zoom 10 reads that summit 50 m
 * low, which is the read the feature was asked for. That archive is 415 MB,
 * past the GitHub Pages 1 GB site cap once anything else ships beside it and
 * far past the 25 MiB per-file ceiling on Cloudflare's own static assets, so
 * it lives in R2 and is read through here.
 *
 * WHAT IT IS NOT. It is not a proxy, it has no allow-list, and it reaches no
 * upstream. It reads one bucket and returns bytes. It is deliberately a
 * SEPARATE Worker from `ddm-proxy` rather than a widened route on it: the
 * worker-steward contract holds that Worker to an exact route table, and
 * "just add a route" is how a narrow, auditable shim becomes a general one.
 *
 * WHAT IT MUST NEVER DO. No logging (`[observability] enabled = false` in
 * wrangler.toml, DDM-D07): the request URL plus a byte range maps to roughly a
 * 10 km area of interest, and this tool serves Tribal Nations. Recording where
 * people look would be a stewardship failure, not a configuration detail. No
 * cookies, no identifiers, no beacons, no analytics. It writes nothing: every
 * method other than GET, HEAD and OPTIONS is refused.
 *
 * RANGE SUPPORT IS THE WHOLE POINT. A PMTiles reader opens an archive by
 * asking for its first 16,384 bytes and then reads individual tiles by offset.
 * Without `Range`, `Accept-Ranges` and a correct `Content-Range`, a client
 * would have to download 415 MB to draw one hillside. `Content-Range` and
 * `Accept-Ranges` must also be in `Access-Control-Expose-Headers` or a
 * cross-origin reader cannot see them, which is the failure mode that reads as
 * "the terrain silently never loads".
 */

export interface Env {
  /** The `ddm-terrain` bucket. Bound read-only by convention; the Worker
   *  never calls put, delete or list. */
  ddm_terrain: R2Bucket;
}

/** Object keys this Worker will serve. A versioned archive name only: no
 *  traversal, no wildcards, no directory listing. Adding a version means
 *  adding a line here and republishing, which is deliberate. */
const ALLOWED_KEYS = new Set<string>(['pnw-z10-2026-09-10.pmtiles']);

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range',
  // Without these a cross-origin PMTiles reader cannot see the range reply it
  // just received, and reports the archive as unreadable.
  'access-control-expose-headers':
    'Content-Range, ETag, Content-Length, Accept-Ranges',
  'access-control-max-age': '86400'
};

/** The archive is immutable: its version is in its key, so a changed archive
 *  is a different object and never a cache invalidation problem. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

function corsResponse(status: number, body: string | null = null): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'text/plain; charset=utf-8' }
  });
}

/**
 * Parse a single-range `Range` header. Multi-range requests are refused
 * rather than half-honoured: PMTiles never issues one, and a Worker that
 * silently returned only the first part of a multi-range request would corrupt
 * a reader that did.
 */
function parseRange(
  header: string | null,
  size: number
): { offset: number; length: number } | null | 'unsatisfiable' {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'unsatisfiable';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable';

  let start: number;
  let end: number;
  if (rawStart === '') {
    // A suffix range: the LAST n bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  if (start < 0 || start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return corsResponse(405, 'Method not allowed.\n');
    }

    const url = new URL(request.url);
    const key = url.pathname.replace(/^\/+/, '');
    if (!ALLOWED_KEYS.has(key)) {
      return corsResponse(404, 'No such archive.\n');
    }

    // HEAD is answered from the object's metadata alone, without asking R2 for
    // a body it would then discard.
    if (request.method === 'HEAD') {
      const head = await env.ddm_terrain.head(key);
      if (head === null) return corsResponse(404, 'No such archive.\n');
      return new Response(null, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'accept-ranges': 'bytes',
          'cache-control': CACHE_CONTROL,
          'content-type': 'application/octet-stream',
          'content-length': String(head.size),
          etag: head.httpEtag
        }
      });
    }

    const meta = await env.ddm_terrain.head(key);
    if (meta === null) return corsResponse(404, 'No such archive.\n');

    const range = parseRange(request.headers.get('Range'), meta.size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          ...CORS_HEADERS,
          'accept-ranges': 'bytes',
          'content-range': `bytes */${meta.size}`
        }
      });
    }

    const object =
      range === null
        ? await env.ddm_terrain.get(key)
        : await env.ddm_terrain.get(key, { range });
    if (object === null) return corsResponse(404, 'No such archive.\n');

    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'accept-ranges': 'bytes',
      'cache-control': CACHE_CONTROL,
      'content-type': 'application/octet-stream',
      etag: object.httpEtag
    };

    if (range === null) {
      headers['content-length'] = String(meta.size);
      return new Response(object.body, { status: 200, headers });
    }

    headers['content-length'] = String(range.length);
    headers['content-range'] =
      `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`;
    return new Response(object.body, { status: 206, headers });
  }
};
