/**
 * DDM-P14-T08: the pure core of the mode-switch cost report.
 *
 * A hazard-mode switch is a change of the region shell's cluster from one
 * of the four HazardClusterKey values (src/config/clusters.ts:36) to
 * another, at one desktop viewport, with stubbed upstreams. This module
 * decides which network requests a switch's cost should count, merges a
 * measured run into the committed record, compares a candidate run against
 * a baseline, and renders the committed markdown table. It touches no
 * browser, no network, no filesystem, and no clock: every timestamp and
 * commit is supplied by the caller.
 *
 * The Playwright spec that drives Chromium and produces a RUN below is a
 * separate microtask (not written by this module) and is runnable directly
 * as `npm run measure:mode-switch`, which runs
 * tests/mode-switch-cost.spec.ts; that spec, not this file, owns the fs
 * write of the committed doc this module renders.
 *
 * A RUN has this shape (both sides of the split agree on it):
 *
 *   { label: 'baseline' | 'candidate', commit: '<short sha>',
 *     recordedAt: '<ISO 8601>', viewport: { width: 1280, height: 800 },
 *     dirty: <integer, count of `git status --porcelain` lines at
 *             measurement time>,
 *     switches: [ { id, from, to, requests: <integer>,
 *                   dataRequests: <integer>, tileRequests: <integer>,
 *                   quiescentMs: <integer>,
 *                   pendingAtStart: [<layer key>, ...],
 *                   counted: [{ url, n }, ...],
 *                   tiles: [{ url, n }, ...] }, ... ] }
 *
 * `dirty` is absent on a run recorded before DDM-P14-T08's provenance guard
 * (the committed baseline in docs/mode-switch-cost.json predates it);
 * `renderReport` and `compareRuns` treat a missing `dirty` as unknown, never
 * as zero and never as a reason to throw.
 *
 * `requests` is the raw total of `dataRequests` plus `tileRequests`, kept
 * because the milestone's acceptance sentence names "the request count".
 * The report's regression gate compares `dataRequests` only: almost all of
 * a switch's raw request count is raster map tiles, whose count depends on
 * viewport timing and on how much of the previous mode's tile streaming was
 * still in flight, not on anything the app did differently (DDM-P14-T08
 * correction 2). `counted` holds the DATA reads only (what `classifyRequest`
 * calls `'data'`); `tiles` holds the tile reads (what it calls `'tile'`),
 * tallied the same way.
 *
 * A RECORD is `{ schema: 1, note: <string>, runs: { baseline?: RUN,
 * candidate?: RUN, conusBaseline?: RUN, conusCandidate?: RUN } }`, the shape
 * written to and read from the committed doc.
 *
 * Two measurement PROFILEs (DDM-P14-T08 review finding C4, ratified before
 * D1's default-region flip): `'wa'` (the default) pins every switch's boot
 * to `region=washington_state` (drought also carries `&view=brief`, because
 * `region=` alone would otherwise flip drought's boot to the console view,
 * src/state/view-mode.ts:45-52) and is the exact query this module measured
 * before any profile existed; it compares against the committed
 * `runs.baseline` exactly as before. `'conus'` pins `region=national` and
 * records under its own `runs.conusBaseline` / `runs.conusCandidate` keys,
 * so a national-default run never overwrites, and is never compared
 * against, the Washington baseline: national geography changes the read
 * and tile workload (a different viewport-bound query scope, not a code
 * change), so a "rise" there would be a false regression. `normalizeProfile`
 * treats anything other than the literal string `'conus'` as `'wa'`, so an
 * absent or misspelled `DDM_MEASURE_PROFILE` measures Washington, the safe
 * default.
 *
 * The one-fingerprint two-profile protocol (C4R U10 follow-up, Codex J6 and
 * M1). `DDM_MEASURE_PROFILE=both` measures every profile in PROFILES order
 * inside ONE invocation, reads the tree's fingerprint (`fingerprintFrom`:
 * the short HEAD and the count of `git status --porcelain` lines) before the
 * first switch and after the last, and `planMeasurementWrite` merges every
 * profile's run into ONE record that the spec writes once. The dirty guard
 * keeps its full meaning: every porcelain line counts, the two artifacts
 * this flow writes included, so a genuinely dirty tree is refused, and so is
 * a second single-profile invocation after a first one wrote (record both
 * profiles with `both` instead). Chosen over "ignore exactly our two
 * artifacts" because that would let an uncommitted edit to the committed
 * record itself pass the guard, and would still need a cross-invocation
 * commit check to prove both profiles share one fingerprint; one invocation
 * gives both by construction. A baseline slot is write-once
 * (`resolveRunLabel`): a `baseline`-labelled run of a profile whose baseline
 * is already committed records as that profile's candidate, so the flow
 * never overwrites the historical Washington baseline; re-baselining is a
 * reviewed commit that deletes the slot first.
 *
 * `renderReport` renders one table per profile (`runs.baseline` /
 * `runs.candidate` for Washington, `runs.conusBaseline` /
 * `runs.conusCandidate` for CONUS); a table's Delta column and rise summary
 * compare a candidate only against its own profile's baseline, and a slot
 * holding the other profile's run is refused, so no number is ever compared
 * across profiles.
 */

/** The four hazard cluster keys, in the fixed order used everywhere below. */
export const MODE_KEYS = ['drought', 'heat', 'wildfire', 'enso'];

/**
 * All twelve ordered pairs of MODE_KEYS with from !== to, generated from
 * MODE_KEYS in order (every "from" in MODE_KEYS order, and for each, every
 * "to" in MODE_KEYS order, skipping from === to). Frozen so a caller can
 * never reorder or mutate the canonical switch list.
 */
export const SWITCHES = Object.freeze(
  MODE_KEYS.flatMap((from) =>
    MODE_KEYS.filter((to) => to !== from).map((to) => Object.freeze({ from, to }))
  )
);

/** The stable key for a switch, used as the record and comparison key. */
export function switchId({ from, to }) {
  return `${from}->${to}`;
}

const SAME_ORIGIN_REJECT_EXTENSIONS = new Set([
  '.html', '.js', '.mjs', '.cjs', '.css', '.map',
  '.ico', '.woff', '.woff2', '.ttf', '.otf'
]);

function sameOriginPathnameExtension(pathname) {
  const lastSlash = pathname.lastIndexOf('/');
  const lastDot = pathname.lastIndexOf('.');
  if (lastDot <= lastSlash) return '';
  return pathname.slice(lastDot).toLowerCase();
}

/**
 * True when `url` is a data read worth counting toward a switch's cost.
 * Never throws: an unparseable `url` or `appOrigin` is treated as "not
 * counted" rather than as an error, since the spec that calls this filters
 * a live request stream it does not fully control.
 */
export function isCountedRequest(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  let origin;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    return false;
  }

  if (parsed.origin !== origin) return true;

  const { pathname } = parsed;
  if (pathname.startsWith('/assets/')) return false;
  if (pathname === '/' || pathname.endsWith('/')) return false;
  if (SAME_ORIGIN_REJECT_EXTENSIONS.has(sameOriginPathnameExtension(pathname))) return false;
  return true;
}

const TILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.pbf', '.mvt', '.pmtiles'
]);

const XYZ_TRIPLE = /\/\d+\/\d+\/\d+(\.[a-z0-9]+)?$/;

/**
 * Classifies a counted request (see `isCountedRequest`) as `'tile'` (a
 * raster or vector map tile, whose count is viewport and timing dependent)
 * or `'data'` (everything else: a JSON, GeoJSON, or query-style read whose
 * count reflects what the app actually did). Anything `isCountedRequest`
 * rejects is `'ignored'`. Never throws, for the same reason
 * `isCountedRequest` never throws.
 *
 * The rules run in this fixed order and the first match wins:
 *
 *   1. A query string containing `REQUEST=DescribeDomains` or
 *      `REQUEST=GetCapabilities` (case-insensitive) is `'data'`, even
 *      though its path looks like a tile endpoint (a GIBS WMTS
 *      `wmts.cgi?...&REQUEST=DescribeDomains&...` is a metadata call, not a
 *      tile fetch). This exception is checked before every tile rule.
 *   2. A pathname containing `/wmts/` is `'tile'`.
 *   3. A pathname ending in a z/x/y triple (three final numeric path
 *      segments, with an optional extension) is `'tile'`.
 *   4. A pathname whose extension is one of `.png .jpg .jpeg .webp .avif
 *      .pbf .mvt .pmtiles` is `'tile'`.
 *   5. A pathname ending with `/exportimage` (case-insensitive), or
 *      containing `/imageserver/` with a `bbox=` query parameter, is
 *      `'tile'`.
 *   6. A pathname containing `/tile/` or `/tiles/` is `'tile'`.
 *   7. Anything counted that matches none of the above is `'data'`.
 *
 * Matching is case-insensitive on the pathname and query string and
 * ignores the hash.
 *
 * A request whose outer URL is the Worker proxy (`${PROXY_ORIGIN}/proxy`,
 * DDM-P14-T08 scope_note_2026_09_12) is reclassified by its nested `url=`
 * parameter: rules 1-7 above run against the decoded upstream address
 * instead of the proxy path, so a proxied WHP `exportImage` tile reads
 * `'tile'` (src/layers/usfs-whp.ts:194-199) while proxied metadata (an
 * ImageServer info request, a query, a DescribeDomains call) keeps reading
 * `'data'`. A request whose `url=` parameter names a host other than the
 * proxy is unaffected and keeps its outer-URL classification. A missing or
 * unparseable nested address falls back to classifying the outer proxy URL,
 * the same as before this rule existed.
 */
export const PROXY_ORIGIN = 'https://ddm-proxy.atniclimate.workers.dev';

function classifyPathAndSearch(pathname, search) {
  if (search.includes('request=describedomains') || search.includes('request=getcapabilities')) {
    return 'data';
  }
  if (pathname.includes('/wmts/')) return 'tile';
  if (XYZ_TRIPLE.test(pathname)) return 'tile';
  if (TILE_EXTENSIONS.has(sameOriginPathnameExtension(pathname))) return 'tile';
  if (pathname.endsWith('/exportimage')) return 'tile';
  if (pathname.includes('/imageserver/') && search.includes('bbox=')) return 'tile';
  if (pathname.includes('/tile/') || pathname.includes('/tiles/')) return 'tile';
  return 'data';
}

export function classifyRequest(url, appOrigin) {
  if (!isCountedRequest(url, appOrigin)) return 'ignored';

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'ignored';
  }

  if (parsed.origin === PROXY_ORIGIN && parsed.pathname === '/proxy') {
    const nestedRaw = parsed.searchParams.get('url');
    if (nestedRaw !== null) {
      try {
        const nested = new URL(nestedRaw);
        return classifyPathAndSearch(nested.pathname.toLowerCase(), nested.search.toLowerCase());
      } catch {
        // Malformed nested address: fall through and classify the outer
        // proxy URL instead, never throw.
      }
    }
  }

  return classifyPathAndSearch(parsed.pathname.toLowerCase(), parsed.search.toLowerCase());
}

const STRIPPED_MAX_LENGTH = 160;
const STRIPPED_ELLIPSIS = '...';

function truncateStripped(value) {
  if (value.length <= STRIPPED_MAX_LENGTH) return value;
  return `${value.slice(0, STRIPPED_MAX_LENGTH - STRIPPED_ELLIPSIS.length)}${STRIPPED_ELLIPSIS}`;
}

/**
 * A short, stable, deterministic form of `url` for the committed record: a
 * same-origin URL becomes its pathname plus search; a cross-origin URL
 * stays absolute. Never throws: an unparseable `url` is truncated as-is so
 * the caller always gets a string back.
 */
export function strippedUrl(url, appOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return truncateStripped(String(url));
  }

  let origin = null;
  try {
    origin = new URL(appOrigin).origin;
  } catch {
    origin = null;
  }

  const short =
    parsed.origin === origin
      ? `${parsed.pathname}${parsed.search}`
      : `${parsed.origin}${parsed.pathname}${parsed.search}`;
  return truncateStripped(short);
}

/**
 * Tallies an array of already-stripped URLs into `{ url, n }` entries,
 * sorted by descending count then ascending url, so the same input always
 * produces the same committed record.
 */
export function tallyUrls(urls) {
  const counts = new Map();
  for (const url of urls) {
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return Array.from(counts, ([url, n]) => ({ url, n })).sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

/** A fresh, empty committed record, before any run has been merged in. */
export function emptyRecord() {
  return {
    schema: 1,
    note:
      'This file is generated by the mode-switch cost report spec ' +
      '(tests/mode-switch-cost.spec.ts, run via `npm run measure:mode-switch`) ' +
      'using scripts/mode-switch-cost-report.mjs to render it; it is never hand edited.',
    runs: {}
  };
}

/**
 * Normalizes a measurement profile: the literal string `'conus'` stays
 * `'conus'`; anything else (`'wa'`, `undefined`, `null`, a typo) becomes
 * `'wa'`, the default (DDM-P14-T08 review finding C4). Never throws.
 */
export function normalizeProfile(rawProfile) {
  return rawProfile === 'conus' ? 'conus' : 'wa';
}

/**
 * The committed record key a run is stored under, keyed on its (normalized)
 * profile and its label. The `'wa'` profile keeps today's keys (`baseline`
 * / `candidate`) unchanged; the `'conus'` profile uses its own,
 * non-overlapping keys (`conusBaseline` / `conusCandidate`) so a
 * national-default run can never overwrite, or be confused with, the
 * Washington comparator. A `label` that is not `'baseline'` normalizes to
 * the candidate slot, matching `mergeRun`'s caller (`writePolicy` only ever
 * allows `'baseline'` or `'candidate'` through to a write).
 */
export function runKey(profile, label) {
  const isBaseline = label === 'baseline';
  return normalizeProfile(profile) === 'conus'
    ? isBaseline
      ? 'conusBaseline'
      : 'conusCandidate'
    : isBaseline
      ? 'baseline'
      : 'candidate';
}

/**
 * Returns a NEW record with `run` stored under `runKey(run.profile,
 * run.label)`, leaving every other run and the input record untouched. A
 * `run` with no `profile` field is treated as `'wa'` (see
 * `normalizeProfile`), so every RUN recorded before DDM-P14-T08 review
 * finding C4 (none of which carried a `profile` field) keeps merging into
 * `runs.baseline` / `runs.candidate` exactly as before.
 */
export function mergeRun(record, run) {
  return {
    ...record,
    runs: {
      ...record.runs,
      [runKey(run.profile, run.label)]: run
    }
  };
}

/**
 * True when a measured run should be checked for a data-read rise against
 * the committed Washington baseline: only the `'wa'` profile is ever
 * compared, and only when the run is not itself the baseline (a `baseline`
 * label run is never compared against itself). A `'conus'` run is always
 * `false`, regardless of label: national geography changes the read and
 * tile workload by itself, so comparing it against the Washington baseline
 * would report geography as a regression (DDM-P14-T08 review finding C4).
 */
export function shouldCompareToBaseline({ profile, label }) {
  return normalizeProfile(profile) === 'wa' && label !== 'baseline';
}

/** The measurement profiles, in the fixed order a `both` run measures and renders them. */
export const PROFILES = Object.freeze(['wa', 'conus']);

/** The region every switch boots at under each profile. */
export const PROFILE_REGIONS = Object.freeze({ wa: 'washington_state', conus: 'national' });

const PROFILE_TITLES = Object.freeze({ wa: 'Washington', conus: 'CONUS' });

/**
 * The profiles one measurement invocation measures: the literal string
 * `'both'` measures every entry of PROFILES, in order; anything else
 * measures the single profile `normalizeProfile` picks (so an absent or
 * misspelled value measures Washington only). Never throws.
 */
export function measurementProfiles(rawProfile) {
  return rawProfile === 'both' ? [...PROFILES] : [normalizeProfile(rawProfile)];
}

/**
 * The boot query for one side of a switch under a profile. `urlToken` is
 * the cluster's `urlToken` from src/config/clusters.ts (`null` for the
 * default display, reached with no `cluster=` parameter at all). Every boot
 * pins `region=` to the profile's region. A null-token boot also carries
 * `view=brief`: the bare URL booted the brief view, and `region=` alone
 * would flip it to the console view (src/state/view-mode.ts
 * `deriveViewMode`), so both profiles keep the default mode's boot view the
 * bare URL had. A token boot already carried `cluster=`, which flips to the
 * console view by itself, so adding `region=` changes no view.
 */
export function bootQuery({ urlToken, profile }) {
  const region = PROFILE_REGIONS[normalizeProfile(profile)];
  if (urlToken === null) return `?region=${region}&view=brief`;
  return `?cluster=${urlToken}&region=${region}`;
}

/**
 * The tree's code fingerprint from the raw output of `git rev-parse --short
 * HEAD` (`head`) and `git status --porcelain` (`porcelain`): `{ commit,
 * dirty }`, where `dirty` counts every non-blank porcelain line. No path is
 * exempt, the artifacts this flow writes included: the guard's meaning is
 * "the stamped commit is exactly the tree that was measured".
 */
export function fingerprintFrom({ head, porcelain }) {
  return {
    commit: String(head).trim(),
    dirty: String(porcelain)
      .split('\n')
      .filter((line) => line.trim().length > 0).length
  };
}

/**
 * The label a profile's run records under, with a write-once baseline: a
 * `baseline` request fills the profile's baseline slot only while it is
 * empty; once a baseline is committed, the run records as that profile's
 * candidate (and is compared against it), so the measurement flow never
 * overwrites a committed baseline, the historical Washington one included.
 * Any other request (`candidate`, or a bare run) is a candidate.
 */
function resolveRunLabel(record, profile, rawLabel) {
  if (rawLabel !== 'baseline') return 'candidate';
  return record.runs[runKey(profile, 'baseline')] ? 'candidate' : 'baseline';
}

/**
 * Plans one measurement invocation's single write. `measured` is one
 * `{ profile, switches }` per measured profile (at most one per profile);
 * `before` and `after` are `fingerprintFrom` reads taken before the first
 * switch and after the last; `rawLabel` is `DDM_MEASURE_LABEL` as given.
 *
 * Returns `{ policy, reason, runs, record }`. `runs` is always every
 * measured profile's RUN, stamped with `after`'s commit and dirty count,
 * `recordedAt` and `viewport` (so a bare run can still be checked for a
 * rise). `policy` is `writePolicy`'s verdict at both reads: `'skip'` for a
 * bare run on any tree; `'refuse'` (with a `reason`) when either read is
 * dirty or HEAD moved between them, since then no single clean fingerprint
 * produced every run; otherwise `'write'`, and `record` is the input record
 * (or a fresh one) with every run merged in, every committed baseline slot
 * the same object it was. `record` is null unless `policy` is `'write'`.
 * Never mutates its input. Throws a TypeError for an unknown or repeated
 * profile.
 */
export function planMeasurementWrite({ record, measured, rawLabel, before, after, recordedAt, viewport }) {
  const base = record ?? emptyRecord();
  const seen = new Set();
  for (const { profile } of measured) {
    if (!PROFILES.includes(profile)) {
      throw new TypeError(`planMeasurementWrite: unknown profile ${JSON.stringify(profile)}.`);
    }
    if (seen.has(profile)) {
      throw new TypeError(
        `planMeasurementWrite: profile "${profile}" was measured twice; one invocation records one run per profile.`
      );
    }
    seen.add(profile);
  }

  const runs = measured.map(({ profile, switches }) => ({
    label: resolveRunLabel(base, profile, rawLabel),
    profile,
    commit: after.commit,
    recordedAt,
    viewport,
    dirty: after.dirty,
    switches
  }));

  const atStart = writePolicy({ label: rawLabel, dirty: before.dirty });
  const atEnd = writePolicy({ label: rawLabel, dirty: after.dirty });
  if (atEnd === 'skip') return { policy: 'skip', reason: null, runs, record: null };
  if (atEnd === 'refuse') {
    return {
      policy: 'refuse',
      reason: `the working tree has ${after.dirty} dirty file${after.dirty === 1 ? '' : 's'} (git status --porcelain)`,
      runs,
      record: null
    };
  }
  if (atStart === 'refuse') {
    return {
      policy: 'refuse',
      reason: `the working tree had ${before.dirty} dirty file${before.dirty === 1 ? '' : 's'} when measurement began`,
      runs,
      record: null
    };
  }
  if (before.commit !== after.commit) {
    return {
      policy: 'refuse',
      reason: `HEAD moved from \`${before.commit}\` to \`${after.commit}\` during measurement`,
      runs,
      record: null
    };
  }

  let merged = base;
  for (const run of runs) merged = mergeRun(merged, run);
  for (const profile of PROFILES) {
    const key = runKey(profile, 'baseline');
    if (base.runs[key] && merged.runs[key] !== base.runs[key]) {
      throw new Error(`planMeasurementWrite: the committed "${key}" run would be overwritten; baselines are write-once.`);
    }
  }
  return { policy: 'write', reason: null, runs, record: merged };
}

/**
 * Decides whether a measured run may be written to the committed record.
 *
 * `label` not `'baseline'` and not `'candidate'` (a bare run, the default
 * when `DDM_MEASURE_LABEL` is unset) always returns `'skip'`, regardless of
 * `dirty`: a bare run writes nothing today and that stays true.
 *
 * A real label (`'baseline'` or `'candidate'`) with `dirty === 0` returns
 * `'write'`: the tree that produced the numbers is exactly the tree at the
 * stamped commit.
 *
 * A real label with `dirty > 0` returns `'refuse'`: the stamped commit does
 * not contain the code that produced the numbers, and a record that claims
 * otherwise is worse than no record. The caller must fail loudly rather
 * than write.
 *
 * Throws a TypeError naming `"dirty"` when `dirty` is not a non-negative
 * integer (a negative count or a fractional count cannot be a line count
 * from `git status --porcelain`), in the same style as `compareRuns`'s
 * shape guard.
 */
export function writePolicy({ label, dirty }) {
  if (!Number.isInteger(dirty) || dirty < 0) {
    throw new TypeError(
      `writePolicy: "dirty" must be a non-negative integer (a count of ` +
        `"git status --porcelain" lines), got ${dirty}.`
    );
  }
  if (label !== 'baseline' && label !== 'candidate') return 'skip';
  return dirty === 0 ? 'write' : 'refuse';
}

/**
 * Throws a TypeError when `value` is not a RUN: refuses `undefined`, `null`,
 * a RECORD passed by mistake (a RECORD has no top-level `switches` array;
 * it has `switches` nested under `runs.baseline` or `runs.candidate`), and
 * an old-shape RUN whose switch entries predate DDM-P14-T08 correction 2
 * (no `dataRequests` field), which cannot be compared on data reads. An
 * array is required, but an empty array is a legal run with no switches
 * recorded yet, so it passes.
 */
function assertIsRun(value, argName) {
  if (!value || !Array.isArray(value.switches)) {
    throw new TypeError(
      `compareRuns: "${argName}" must be a RUN with a "switches" array, ` +
        'not a RECORD (which nests its runs under "runs.baseline" / ' +
        `"runs.candidate"); got ${value === null ? 'null' : typeof value}.`
    );
  }
  const oldShapeEntry = value.switches.find((s) => typeof s.dataRequests !== 'number');
  if (oldShapeEntry) {
    throw new TypeError(
      `compareRuns: "${argName}" has a switch entry ("${oldShapeEntry.id}") with no ` +
        'numeric "dataRequests" field. This is an old-shape RUN recorded before ' +
        'DDM-P14-T08 correction 2 (which gates on data reads, not raw request ' +
        'count); it must be re-measured, not compared as-is.'
    );
  }
}

/**
 * Compares a candidate run against a baseline run, switch by switch, in
 * SWITCHES order, on `dataRequests` (raster tile counts are viewport and
 * timing dependent and are reported, never gated). A switch the baseline
 * never recorded is skipped entirely. A switch present in the baseline and
 * absent from the candidate is reported as `missing`, never as a fall.
 * Throws a TypeError if either argument is not a RUN (see `assertIsRun`).
 */
export function compareRuns(baseline, candidate) {
  assertIsRun(baseline, 'baseline');
  assertIsRun(candidate, 'candidate');

  const baselineById = new Map(baseline.switches.map((s) => [s.id, s]));
  const candidateById = new Map(candidate.switches.map((s) => [s.id, s]));

  const rises = [];
  const falls = [];
  const unchanged = [];
  const missing = [];

  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const b = baselineById.get(id);
    if (!b) continue;
    const c = candidateById.get(id);
    if (!c) {
      missing.push({
        id,
        from: pair.from,
        to: pair.to,
        baselineData: b.dataRequests,
        candidateData: null,
        baselineTiles: b.tileRequests,
        candidateTiles: null
      });
      continue;
    }
    const entry = {
      id,
      from: pair.from,
      to: pair.to,
      baselineData: b.dataRequests,
      candidateData: c.dataRequests,
      baselineTiles: b.tileRequests,
      candidateTiles: c.tileRequests
    };
    if (c.dataRequests > b.dataRequests) rises.push(entry);
    else if (c.dataRequests < b.dataRequests) falls.push(entry);
    else unchanged.push(entry);
  }

  return { rises, falls, unchanged, missing };
}

/**
 * Renders a run's `dirty` field for the committed table: `'dirty unknown'`
 * when the field is absent (a run recorded before DDM-P14-T08's provenance
 * guard), `'dirty 0'` for a clean tree, and `'dirty N files'` otherwise.
 * Never throws.
 */
function formatDirty(run) {
  if (!Number.isInteger(run.dirty)) return 'dirty unknown';
  if (run.dirty === 0) return 'dirty 0';
  return `dirty ${run.dirty} files`;
}

function formatDelta(delta) {
  if (delta > 0) return `+${delta}`;
  return `${delta}`;
}

/**
 * `key` is the record key the run is stored under (`runKey`), so a
 * Washington run reads `(baseline, <commit>)` exactly as before profiles
 * existed and a CONUS run reads `(conusBaseline, <commit>)`.
 */
function renderUrlDetail(run, key, { title, field, emptyLabel }) {
  const lines = [];
  lines.push('<details>');
  lines.push(`<summary>${title} (${key}, ${run.commit})</summary>`);
  lines.push('');
  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const entry = run.switches.find((s) => s.id === id);
    const list = entry ? entry[field] : null;
    lines.push(`- \`${id}\`:`);
    if (!list || list.length === 0) {
      lines.push(`  - (${emptyLabel})`);
      continue;
    }
    for (const { url, n } of list) {
      lines.push(`  - ${url} (${n})`);
    }
  }
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

function renderCountedDetail(run, key) {
  return renderUrlDetail(run, key, {
    title: 'Counted data reads per switch',
    field: 'counted',
    emptyLabel: 'no data reads recorded'
  });
}

function renderTileDetail(run, key) {
  return renderUrlDetail(run, key, {
    title: 'Tile requests per switch',
    field: 'tiles',
    emptyLabel: 'no tile requests recorded'
  });
}

const LOWER_BOUND_MARK = '†'; // dagger footnote marker

/**
 * Throws a TypeError when the run stored under `key` belongs to a profile
 * other than `profile` (a run with no `profile` field is Washington, see
 * `normalizeProfile`), so a hand-edited or misfiled record can never put one
 * profile's run into another profile's table and comparison.
 */
function assertSlotProfile(run, key, profile) {
  if (run && normalizeProfile(run.profile) !== profile) {
    throw new TypeError(
      `renderReport: record key "${key}" holds a run of profile ` +
        `${JSON.stringify(run.profile ?? 'wa')}, not "${profile}"; a table never ` +
        'renders or compares another profile\'s run.'
    );
  }
}

/**
 * The lines of one profile's section: a heading naming the profile and its
 * region, then (when the profile has a run) the table, its lower-bound
 * footnote, each run's provenance, each run's per-switch detail, and, when
 * both runs exist, the rise summary. Every value in the section comes from
 * this profile's own two slots; the Delta column and the rise summary
 * compare its candidate only against its own baseline.
 */
function renderProfileSection(record, profile) {
  const baselineKey = runKey(profile, 'baseline');
  const candidateKey = runKey(profile, 'candidate');
  const baseline = record.runs[baselineKey] ?? null;
  const candidate = record.runs[candidateKey] ?? null;
  assertSlotProfile(baseline, baselineKey, profile);
  assertSlotProfile(candidate, candidateKey, profile);
  const hasCandidate = Boolean(baseline && candidate);
  const title = PROFILE_TITLES[profile];

  const lines = [];
  lines.push(`## ${title} profile (\`region=${PROFILE_REGIONS[profile]}\`)`);
  lines.push('');
  if (!baseline && !candidate) {
    lines.push(`No ${title}-profile run is recorded yet.`);
    lines.push('');
    return lines;
  }

  const header = ['From', 'To', 'Data reads', 'Tiles', 'Requests', 'Time to quiescence (ms)'];
  if (hasCandidate) {
    header.push('Candidate data reads', 'Candidate tiles', 'Candidate requests', 'Candidate ms', 'Delta');
  }
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  const baselineById = new Map((baseline?.switches ?? []).map((s) => [s.id, s]));
  const candidateById = new Map((candidate?.switches ?? []).map((s) => [s.id, s]));

  const lowerBoundIds = [];

  for (const pair of SWITCHES) {
    const id = switchId(pair);
    const b = baselineById.get(id) ?? null;
    const c = hasCandidate ? candidateById.get(id) ?? null : null;

    const isLowerBound =
      (b && b.pendingAtStart.length === 0) || (c && c.pendingAtStart.length === 0);
    if (isLowerBound) lowerBoundIds.push(id);
    const toCell = isLowerBound ? `${pair.to} ${LOWER_BOUND_MARK}` : pair.to;

    const row = [
      pair.from,
      toCell,
      b ? String(b.dataRequests) : 'n/a',
      b ? String(b.tileRequests) : 'n/a',
      b ? String(b.requests) : 'n/a',
      b ? String(b.quiescentMs) : 'n/a'
    ];
    if (hasCandidate) {
      row.push(c ? String(c.dataRequests) : 'n/a');
      row.push(c ? String(c.tileRequests) : 'n/a');
      row.push(c ? String(c.requests) : 'n/a');
      row.push(c ? String(c.quiescentMs) : 'n/a');
      row.push(b && c ? formatDelta(c.dataRequests - b.dataRequests) : 'n/a');
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');

  if (lowerBoundIds.length > 0) {
    lines.push(
      `${LOWER_BOUND_MARK} ${lowerBoundIds.map((id) => `\`${id}\``).join(', ')}: recorded with no ` +
        'layer pending at the start of the switch, because the SST anomaly layer ' +
        '(src/layers/sst-anomaly.ts:575) reports `\'ready\'` at activation, ' +
        'before any tile is fetched, so the boot-idle seam declared quiescence ' +
        'immediately; the recorded time is a lower bound, not a measured settle time.'
    );
    lines.push('');
  }

  const present = [
    [baselineKey, baseline],
    [candidateKey, candidate]
  ].filter(([, run]) => run);

  for (const [key, run] of present) {
    lines.push(
      `Run \`${key}\`: commit \`${run.commit}\`, recorded ${run.recordedAt}, ` +
        `viewport ${run.viewport.width}x${run.viewport.height}, ${formatDirty(run)}.`
    );
  }
  lines.push('');

  for (const [key, run] of present) {
    lines.push(renderCountedDetail(run, key));
    lines.push('');
    lines.push(renderTileDetail(run, key));
    lines.push('');
  }

  if (hasCandidate) {
    const scope = `${title} profile, \`${candidateKey}\` against \`${baselineKey}\``;
    const { rises } = compareRuns(baseline, candidate);
    if (rises.length > 0) {
      const names = rises
        .map((r) => `\`${r.id}\` (${baselineKey} ${r.baselineData} to ${candidateKey} ${r.candidateData})`)
        .join(', ');
      lines.push(`${scope}: data-read count rose for ${names}.`);
    } else {
      lines.push(`${scope}: no switch's data-read count rose.`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Renders the committed markdown report for `record`: the shared
 * introduction, then one section per entry of PROFILES, in order (see
 * `renderProfileSection`). Within a section, with only a baseline run, the
 * table has From, To, Data reads, Tiles, Requests, and Time to quiescence
 * columns; with both runs, it adds Candidate data reads, Candidate tiles,
 * Candidate requests, Candidate ms, and a Delta column computed on data
 * reads (the profile's candidate minus the same profile's baseline, written
 * with a leading + when positive and 0 when equal). A row whose recorded
 * `pendingAtStart` was empty carries a footnote mark: the boot-idle seam
 * reported quiescence immediately for that switch, so its time is a lower
 * bound. No value is ever compared across profiles.
 */
export function renderReport(record) {
  const lines = [];
  lines.push('# Mode-switch cost report');
  lines.push('');
  lines.push(
    '<!-- GENERATED FILE. Do not edit by hand: this table is produced by ' +
      'scripts/mode-switch-cost-report.mjs from the mode-switch cost spec ' +
      '(tests/mode-switch-cost.spec.ts, run via `npm run measure:mode-switch`); ' +
      'run that to regenerate it. -->'
  );
  lines.push('');
  lines.push(
    'Data reads, tile requests, and time to quiescence (read from `window.__ddm`) ' +
      'for each of the twelve ordered switches among Drought, Heat, Wildfire, and ' +
      'ENSO, at one desktop viewport with stubbed upstreams (DDM-P14-T08).'
  );
  lines.push('');
  lines.push(
    'The regression gate below compares data reads, not the raw request count: ' +
      'almost all of a switch\'s traffic is raster map tiles, and a tile count ' +
      'depends on viewport timing and on how much of the previous mode\'s tile ' +
      'streaming was still in flight, not on what the app did differently. ' +
      'Measured evidence: on one unchanged commit, `enso->drought` counted 42 ' +
      'requests on one run and 14 on the next, entirely from tile-timing variance. ' +
      'Data reads and tile requests are both recorded below; only data reads gate.'
  );
  lines.push('');
  lines.push(
    'Each measurement profile has its own section below, and every switch in a profile ' +
      `boots at that profile's region (${PROFILES.map(
        (profile) => `${PROFILE_TITLES[profile]}: \`region=${PROFILE_REGIONS[profile]}\``
      ).join('; ')}). A profile's candidate is compared only against the same profile's ` +
      'baseline, never across profiles, because the profiles frame different regions.'
  );
  lines.push('');

  for (const profile of PROFILES) {
    lines.push(...renderProfileSection(record, profile));
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
