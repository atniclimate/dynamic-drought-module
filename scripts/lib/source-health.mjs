/**
 * Pure evaluators for the scheduled source-health probe (DDM-P0-T12).
 *
 * The driver (scripts/source-health.mjs) boots the built application with
 * one layer at a time and records the requests the RUNTIME issues; nothing
 * here hand-copies a query string, so the probe measures what users get.
 * Receipts hold URLs, HTTP status, bytes, milliseconds, record counts,
 * cache headers, and status words only, never a body (hard rule 1;
 * src/layers/aiannh.ts).
 *
 * What a verdict means:
 *   breach   the runtime's own terminal state says the source failed
 *            (unavailable, stuck past the ceiling, an HTTP or network
 *            error, a partial or empty answer from a source that is
 *            always complete here, or requests that never answered);
 *   warn     the source answered but near a cliff (slow, large, partial,
 *            or an aborted request); no issue is opened;
 *   ok       every observed request answered inside the lines;
 *   skipped  nothing was measured (bundled, zoom-gated at the default
 *            camera, or served from the ambient capture), which the
 *            headline reports separately, never as "inside budget".
 */

/** Basemap tile hosts the probe answers with a blank tile instead of
 * fetching: the map still loads, and a daily automated boot per layer never
 * taxes OpenStreetMap (tile policy) or OpenTopoMap. Every host here must
 * appear in src/config/urls.ts or its boot slice src/config/urls-boot.ts
 * (the test pins that). */
export const STUBBED_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
]);

/** Tile paths stubbed on hosts that also serve a metadata query the runtime
 * needs answered honestly: the GOES GeoColor ImageServer's `exportImage`
 * tiles are blanked, while its `/query` (the frame catalog the recent
 * satellite basemap reads on every boot) goes upstream and is measured on
 * the ambient-boot row. Playwright glob per entry. */
export const STUBBED_TILE_GLOBS = Object.freeze([
  'https://satellitemaps.nesdis.noaa.gov/**/exportImage**',
]);

const STUBBED_TILE_MATCHERS = STUBBED_TILE_GLOBS.map((glob) => {
  const u = new URL(glob.replace(/\*+/g, 'STAR'));
  return { host: u.hostname, pathPattern: new RegExp(u.pathname.replaceAll('STAR', '.*')) };
});

/** Layers whose source always has complete records at the default region,
 * so a terminal `no data`, a partial answer (`degraded`, the ArcGIS transfer
 * limit), or a zero-record response is a breach rather than an honest
 * absence. Events (alerts, smoke, perimeters) can legitimately be empty and
 * are warned on, not breached, when partial. */
export const EXPECTS_RECORDS = new Set(['nadm-drought', 'aiannh', 'bia-reservations']);

/** Response headers worth carrying into the receipt: they say whether the
 * observed timing was a warm cache path or an origin fetch. */
export const CACHE_HEADERS = Object.freeze(['age', 'cache-control', 'x-cache', 'cf-cache-status', 'etag', 'last-modified']);

const DEFAULTS = Object.freeze({
  base: 'http://127.0.0.1:4173/',
  out: 'source-health-receipt.json',
  summary: null,
  layers: null,
  // The layer pill must be terminal inside this ceiling after boot; the
  // longest per-layer runtime budget is 15 s (NIFC perimeters).
  ceilingMs: 45_000,
  // A response slower than this is a warning (near a 15 s budget) without
  // opening an issue; a breach is the runtime's own terminal verdict.
  warnSeconds: 10,
  // A response larger than this is a warning: ArcGIS cuts feature transfers
  // at 32 MiB (33,554,432 bytes) and the runtime then reports degraded, so
  // a source three quarters of the way there is on the cliff edge.
  warnBytes: 24_000_000,
  userAgent: 'DDM source-health monitor (+https://github.com/atniclimate/dynamic-drought-module)',
});

export function parseHealthArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const raw = argv[i + 1];
    if (raw === undefined) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case '--base':
        out.base = raw.endsWith('/') ? raw : `${raw}/`;
        break;
      case '--out':
        out.out = raw;
        break;
      case '--summary':
        out.summary = raw;
        break;
      case '--layers':
        out.layers = raw.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--ceiling-ms':
        out.ceilingMs = Number.parseInt(raw, 10);
        break;
      case '--warn-seconds':
        out.warnSeconds = Number(raw);
        break;
      case '--warn-bytes':
        out.warnBytes = Number.parseInt(raw, 10);
        break;
      case '--user-agent':
        out.userAgent = raw;
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!/^https?:\/\//.test(out.base)) throw new Error('--base must be an http(s) URL');
  if (!Number.isFinite(out.ceilingMs) || out.ceilingMs <= 0) throw new Error('--ceiling-ms must be a positive integer');
  if (!Number.isFinite(out.warnSeconds) || out.warnSeconds <= 0) throw new Error('--warn-seconds must be positive');
  if (!Number.isFinite(out.warnBytes) || out.warnBytes <= 0) throw new Error('--warn-bytes must be a positive integer');
  return out;
}

export function classifyUrl(url, previewOrigin) {
  const u = new URL(url);
  if (u.origin === previewOrigin) return 'app';
  if (STUBBED_HOSTS.includes(u.hostname)) return 'stubbed';
  if (STUBBED_TILE_MATCHERS.some((m) => m.host === u.hostname && m.pathPattern.test(u.pathname))) return 'stubbed';
  return 'source';
}

export function countRecords(contentType, text) {
  if (!contentType || !/json/i.test(contentType)) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.features)) return data.features.length;
  if (data && data.value && Array.isArray(data.value.timeSeries)) return data.value.timeSeries.length;
  return null;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const mb = (bytes) => `${(bytes / 1_000_000).toFixed(2)} MB`;
const isAbort = (failure) => /ERR_ABORTED|aborted/i.test(failure ?? '');

/**
 * Row shape: { key, status, settleMs, responses: [{url, status, bytes, ms,
 * count, cache?}], failed?: [{url, failure}], requests?: number,
 * shared?: number, finalStatus?: string }. `status` is the pill at the end
 * of the stability window (the verdict); `settleMs` is when it first went
 * terminal; `finalStatus` is set by the driver only when the pill changed
 * during the window.
 */
export function evaluateLayerHealth(row, opts) {
  const expectsRecords = opts.expectsRecords.has(row.key);
  const failed = row.failed ?? [];
  const requests = row.requests ?? row.responses.length + failed.length;
  if (row.status === 'zoom-in') {
    return { verdict: 'skipped', reasons: ['zoom in to load at the default camera; no source query issued'] };
  }
  const reasons = [];
  if (!row.status || row.status === 'loading') {
    reasons.push(`still ${row.status ?? 'without status'} after ${seconds(row.settleMs)} (ceiling ${seconds(opts.ceilingMs)})`);
  } else if (row.settleMs > opts.ceilingMs) {
    reasons.push(`reached ${row.status} at ${seconds(row.settleMs)}, over the ${seconds(opts.ceilingMs)} ceiling`);
  }
  if (row.status === 'error') reasons.push(`unavailable at ${seconds(row.settleMs)}`);
  if (row.status === 'degraded' && expectsRecords) reasons.push('live (partial) from a source that is always complete here');
  if (row.status === 'no-data' && expectsRecords) reasons.push('no data from a source that always has records here');
  for (const r of row.responses) {
    if (r.status === 0 || r.status >= 400) reasons.push(`HTTP ${r.status} ${r.url}`);
    else if (expectsRecords && r.count === 0) reasons.push(`0 records from ${r.url}`);
  }
  for (const f of failed) {
    if (!isAbort(f.failure)) reasons.push(`request failed (${f.failure}) ${f.url}`);
  }
  if (row.status === 'ready' && requests > 0 && row.responses.length === 0 && failed.length === 0) {
    reasons.push(`${requests} request(s) issued but no response observed inside the window`);
  }
  if (reasons.length) return { verdict: 'breach', reasons };
  if (row.responses.length === 0 && failed.length === 0 && requests === 0 && row.status === 'ready') {
    return {
      verdict: 'skipped',
      reasons: [
        row.shared
          ? 'every request it made is in the ambient boot set; measured on the ambient-boot row'
          : 'bundled or cached; no upstream request',
      ],
    };
  }
  if (row.status === 'degraded') reasons.push('live (partial): the runtime reported a partial answer (for example the ArcGIS transfer limit)');
  if (row.finalStatus && row.finalStatus !== row.status) {
    reasons.push(`pill moved from ${row.status} to ${row.finalStatus} during the stability window`);
  }
  for (const r of row.responses) {
    if (r.ms > opts.warnSeconds * 1000) {
      reasons.push(`${seconds(r.ms)} for ${r.bytes.toLocaleString('en-US')} bytes, over the ${opts.warnSeconds} s warning line: ${r.url}`);
    }
    if (r.bytes > opts.warnBytes) {
      reasons.push(`${mb(r.bytes)}, over the ${mb(opts.warnBytes)} warning line (ArcGIS cuts transfers at 32 MiB): ${r.url}`);
    }
  }
  for (const f of failed) {
    if (isAbort(f.failure)) reasons.push(`request aborted by the runtime (${f.failure}) ${f.url}`);
  }
  return { verdict: reasons.length ? 'warn' : 'ok', reasons };
}

/** Above this many responses a layer is a tile fan-out (HeatRisk, WHP,
 * SST, the NIDIS grids): the summary collapses them per host so the table
 * stays readable; the JSON receipt keeps every response. */
export const COLLAPSE_ABOVE = 6;

const cacheNote = (x) => {
  const c = x.cache ?? {};
  const parts = [];
  if (c['cf-cache-status']) parts.push(`cf ${c['cf-cache-status']}`);
  if (c['x-cache']) parts.push(`x-cache ${c['x-cache']}`);
  if (c.age) parts.push(`age ${c.age}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

export function describeResponses(responses) {
  if (responses.length === 0) return '(none)';
  if (responses.length <= COLLAPSE_ABOVE) {
    return responses
      .map((x) => `${x.status} ${mb(x.bytes)} ${seconds(x.ms)}${x.count === null ? '' : ` ${x.count} rec`}${cacheNote(x)} \`${x.url}\``)
      .join('<br>');
  }
  const byHost = new Map();
  for (const x of responses) {
    const host = new URL(x.url).hostname;
    const group = byHost.get(host) ?? { count: 0, bytes: 0, slowestMs: 0, statuses: new Map() };
    group.count += 1;
    group.bytes += x.bytes;
    group.slowestMs = Math.max(group.slowestMs, x.ms);
    group.statuses.set(x.status, (group.statuses.get(x.status) ?? 0) + 1);
    byHost.set(host, group);
  }
  return [...byHost.entries()]
    .map(([host, g]) => {
      const statuses = [...g.statuses.entries()].map(([s, n]) => `${s} x${n}`).join(', ');
      return `${g.count} responses from \`${host}\`: ${statuses}; ${mb(g.bytes)} total; slowest ${seconds(g.slowestMs)}`;
    })
    .join('<br>');
}

export function renderHealthSummary(rows, meta) {
  const lines = [];
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const breaches = count('breach');
  const warns = count('warn');
  const skipped = count('skipped');
  const measured = rows.length - skipped;
  const headline = breaches
    ? `${breaches} breach${breaches === 1 ? '' : 'es'} in ${measured} measured source rows`
    : `${measured} measured source rows inside budget`;
  const notes = [];
  if (warns) notes.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  if (skipped) notes.push(`${skipped} not measured`);
  lines.push(`## Source health: ${headline}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  lines.push('');
  const requests = rows.reduce((n, r) => n + (r.requests ?? r.responses.length), 0);
  const responses = rows.reduce((n, r) => n + r.responses.length, 0);
  const failed = rows.reduce((n, r) => n + (r.failed?.length ?? 0), 0);
  const replayed = rows.reduce((n, r) => n + (r.shared ?? 0), 0);
  lines.push(
    `Build \`${meta.sha}\`, started ${meta.startedAt}. Observed responses to the requests the runtime issued: ` +
      `${requests} upstream requests, ${responses} responses, ${failed} failed, ${replayed} ambient requests on layer boots (answered from the control capture when captured). ` +
      'Timings are one observation each and may be warm-cache paths; cache headers are shown when present.',
  );
  lines.push('');
  lines.push('| Layer | Status | Settled | Verdict | Requests (status, bytes, seconds, records) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const reqs = describeResponses(r.responses);
    const fails = (r.failed ?? []).map((f) => `failed ${f.failure} \`${f.url}\``).join('<br>');
    const detail = r.reasons.length ? ` (${r.reasons.join('; ')})` : '';
    lines.push(`| ${r.key} | ${r.status ?? '(none)'} | ${seconds(r.settleMs)} | ${r.verdict}${detail} | ${[reqs, fails].filter(Boolean).join('<br>')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderIssueBody(row, runUrl) {
  const lines = [
    `<!-- ddm-source-health:${row.key} -->`,
    `## Source health breach: ${row.key}`,
    '',
    `The scheduled source-health probe booted the built application with the \`${row.key}\` layer active and the runtime's own request did not end inside budget.`,
    '',
    ...row.reasons.map((r) => `- ${r}`),
    '',
    `Layer status \`${row.status ?? '(none)'}\` at ${seconds(row.settleMs)}.`,
    '',
    '| HTTP | Bytes | Seconds | Records | URL |',
    '| --- | --- | --- | --- | --- |',
    ...row.responses.map(
      (x) => `| ${x.status} | ${x.bytes.toLocaleString('en-US')} | ${(x.ms / 1000).toFixed(1)} | ${x.count ?? ''} | \`${x.url}\` |`,
    ),
    ...(row.failed ?? []).map((f) => `| failed | | | | \`${f.url}\` (${f.failure}) |`),
    '',
    `Probe run: ${runUrl}`,
    '',
    '_This issue closes automatically when a later probe finds the source inside budget._',
  ];
  return lines.join('\n');
}
