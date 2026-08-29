/**
 * Pure evaluators for the scheduled source-health probe (DDM-P0-T12).
 *
 * The driver (scripts/source-health.mjs) boots the built application with
 * one layer at a time and records the requests the RUNTIME issues; nothing
 * here hand-copies a query string, so the probe measures what users get.
 * Receipts hold URLs, HTTP status, bytes, milliseconds, record counts, and
 * status words only, never a body (hard rule 1; src/layers/aiannh.ts).
 */

/** Basemap tile hosts the probe answers with a blank tile instead of
 * fetching: the map still loads, and a daily automated boot per layer never
 * taxes OpenStreetMap (tile policy), OpenTopoMap, or the GOES service. */
export const STUBBED_HOSTS = Object.freeze([
  'tile.openstreetmap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
  'satellitemaps.nesdis.noaa.gov',
]);

/** Layers whose source always has records at the default region, so a
 * terminal `no data` is a source breach rather than an honest absence
 * (events such as alerts, smoke, and perimeters can legitimately be empty). */
export const EXPECTS_RECORDS = new Set(['nadm-drought', 'aiannh', 'bia-reservations']);

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
  return out;
}

export function classifyUrl(url, previewOrigin) {
  const u = new URL(url);
  if (u.origin === previewOrigin) return 'app';
  if (STUBBED_HOSTS.includes(u.hostname)) return 'stubbed';
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

export function evaluateLayerHealth(row, opts) {
  if (row.status === 'zoom-in') {
    return { verdict: 'skipped', reasons: ['zoom in to load at the default region; no source query issued'] };
  }
  if (row.responses.length === 0 && row.status === 'ready') {
    return { verdict: 'skipped', reasons: ['bundled or cached; no upstream request'] };
  }
  const reasons = [];
  if (!row.status || row.status === 'loading') {
    reasons.push(`still ${row.status ?? 'without status'} after ${seconds(row.settleMs)} (ceiling ${seconds(opts.ceilingMs)})`);
  }
  if (row.status === 'error') reasons.push(`unavailable at ${seconds(row.settleMs)}`);
  if (row.status === 'no-data' && opts.expectsRecords.has(row.key)) {
    reasons.push('no data from a source that always has records here');
  }
  for (const r of row.responses) {
    if (r.status === 0 || r.status >= 400) reasons.push(`HTTP ${r.status} ${r.url}`);
  }
  if (reasons.length) return { verdict: 'breach', reasons };
  for (const r of row.responses) {
    if (r.ms > opts.warnSeconds * 1000) {
      reasons.push(`${seconds(r.ms)} for ${r.bytes.toLocaleString('en-US')} bytes, over the ${opts.warnSeconds} s warning line: ${r.url}`);
    }
  }
  return { verdict: reasons.length ? 'warn' : 'ok', reasons };
}

export function renderHealthSummary(rows, meta) {
  const lines = [];
  const breaches = rows.filter((r) => r.verdict === 'breach').length;
  const warns = rows.filter((r) => r.verdict === 'warn').length;
  const headline = breaches ? `${breaches} breach${breaches === 1 ? '' : 'es'}` : 'every probed source inside budget';
  const warnNote = warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
  lines.push(`## Source health: ${headline}${warnNote}`);
  lines.push('');
  lines.push(`Build \`${meta.sha}\`, started ${meta.startedAt}. The runtime issued every request below; the probe recorded it.`);
  lines.push('');
  lines.push('| Layer | Status | Settled | Verdict | Requests (status, bytes, seconds, records) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const reqs = r.responses
      .map((x) => `${x.status} ${mb(x.bytes)} ${seconds(x.ms)}${x.count === null ? '' : ` ${x.count} rec`} \`${x.url}\``)
      .join('<br>') || '(none)';
    const detail = r.reasons.length ? ` (${r.reasons.join('; ')})` : '';
    lines.push(`| ${r.key} | ${r.status ?? '(none)'} | ${seconds(r.settleMs)} | ${r.verdict}${detail} | ${reqs} |`);
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
    '',
    `Probe run: ${runUrl}`,
    '',
    '_This issue closes automatically when a later probe finds the source inside budget._',
  ];
  return lines.join('\n');
}
