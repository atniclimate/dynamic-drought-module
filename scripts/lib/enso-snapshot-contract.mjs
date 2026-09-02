/**
 * The ONE shared El Nino / Southern Oscillation (ENSO) snapshot contract.
 *
 * Mirrors the runtime consumer (src/impact/enso.ts loadEnsoSnapshot and its
 * guards) so every producer and transport step enforces exactly what the
 * consumer requires. Used by: the builder (scripts/build-enso-snapshot.mjs,
 * before writing) and any scheduled refresh workflow (via
 * scripts/validate-enso-snapshot.mjs, before committing). Added 2026-07-28
 * after the two-series
 * regression: an old-builder snapshot without `preliminary` flags passed
 * every transport step and the consumer then rejected the whole file, so
 * the live briefing lost its ENSO read (ground-truth audit, plan T0-1).
 *
 * Keep this file dependency-free (plain Node) and keep the guards aligned
 * with src/impact/enso.ts when the consumer contract changes.
 *
 * Extended 2026-09-02 (report 13, ENSOSCI-01 and ENSOSCI-04). The addition
 * is additive: every field the 2026-07-28 contract required is still
 * required, including the legacy `phase`, which is now an alias of
 * `state.episode`. New, per seasonal index series:
 *   state         { conditions, episode, direction, emerging, threshold,
 *                   conditionsRule, episodeRule } - CPC's onset rule, its
 *                   historical five-season episode rule, and the trailing
 *                   trajectory, kept as three separate answers so a present
 *                   -tense headline never reports a historical
 *                   classification (the app said "neutral" while CPC held an
 *                   El Nino Advisory).
 *   authority     where CPC states the official status, as a LINK.
 *   method        the issuer-stated computation, base period and revisions.
 * New, per snapshot: `sourceQuotes`, the verbatim CPC definitions with their
 * URLs, so the artifact states the rules it was built under.
 *
 * Extended again 2026-09-02 (report 18 section 8 item 4) with
 * `readEnsoAlertStatus` and `ensoAlertStatusMismatch`, the freshness half of
 * the gate: pure functions that compare a snapshot's `state.conditions`
 * against CPC's own "ENSO Alert System Status" line. They live here so both
 * the builder and the validator can reach them and so the validator's pinned
 * self-test can drive them from stubbed page text with no network.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The three CPC states a season can be in, and the three trajectory words.
 * `conditions`, `episode` and `direction` are separate answers to separate
 * CPC questions (ENSOSCI-01); see the builder header for the rules and the
 * `sourceQuotes` block of a built snapshot for CPC's own wording.
 */
const DIRECTIONS = new Set(['strengthening', 'weakening', 'steady']);
const THRESHOLD_SIDES = new Set(['above', 'below', 'within']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDay(value) {
  return typeof value === 'string' && ISO_DAY.test(value);
}

function hasValidPublished(value) {
  return value.published === undefined || isIsoDay(value.published);
}

function isPhase(value) {
  return value === 'el-nino' || value === 'la-nina' || value === 'neutral';
}

function isSeasonalIndexPoint(value) {
  return (
    isObject(value) &&
    typeof value.seas === 'string' &&
    Number.isInteger(value.year) &&
    typeof value.anom === 'number' &&
    Number.isFinite(value.anom) &&
    typeof value.preliminary === 'boolean'
  );
}

/**
 * The newest point may carry its own threshold read, which is what CPC's
 * onset rule turns on. Optional so an older snapshot still passes; strict
 * when present, and cross-checked against `anom` in `validateEnsoSnapshot`.
 */
function isLatestThresholdRead(value) {
  if (value.exceedsThreshold === undefined && value.thresholdSide === undefined) {
    return true;
  }
  return (
    typeof value.exceedsThreshold === 'boolean' &&
    THRESHOLD_SIDES.has(value.thresholdSide)
  );
}

/**
 * The three-state block (ENSOSCI-04). `conditions` answers CPC's onset rule
 * on the newest season, `episode` is the historical five-season
 * classification (the same value as the legacy `phase`), `direction` is the
 * trailing-three-season trajectory, and `emerging` is derived from the first
 * two. Each rule carries the CPC page that states it.
 */
function isIndexState(value) {
  return (
    isObject(value) &&
    isPhase(value.conditions) &&
    isPhase(value.episode) &&
    DIRECTIONS.has(value.direction) &&
    typeof value.emerging === 'boolean' &&
    typeof value.threshold === 'number' &&
    Number.isFinite(value.threshold) &&
    value.threshold > 0 &&
    isHttpsUrl(value.conditionsRule) &&
    isHttpsUrl(value.episodeRule)
  );
}

/** Where CPC states the official status. A link, never scraped text. */
function isAuthority(value) {
  return (
    isObject(value) &&
    isNonEmptyString(value.product) &&
    isHttpsUrl(value.url) &&
    isNonEmptyString(value.cadence) &&
    isHttpsUrl(value.definitionsUrl)
  );
}

/** The issuer-stated computation behind the index. */
function isMethod(value) {
  return (
    isObject(value) &&
    isNonEmptyString(value.index) &&
    isNonEmptyString(value.basePeriod) &&
    isNonEmptyString(value.sstVersion) &&
    Number.isInteger(value.revisionWindowMonths) &&
    value.revisionWindowMonths >= 0 &&
    isNonEmptyString(value.updateCadence) &&
    isHttpsUrl(value.methodUrl)
  );
}

/** One verbatim issuer definition with the page it was read from. */
function isSourceQuote(value) {
  return (
    isObject(value) &&
    isNonEmptyString(value.text) &&
    isNonEmptyString(value.source) &&
    isHttpsUrl(value.url)
  );
}

function isSourceQuotes(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isSourceQuote);
}

function isIndexSeries(value) {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    isPhase(value.phase) &&
    isSeasonalIndexPoint(value.latest) &&
    isLatestThresholdRead(value.latest) &&
    (value.state === undefined || isIndexState(value.state)) &&
    (value.authority === undefined || isAuthority(value.authority)) &&
    (value.method === undefined || isMethod(value.method)) &&
    Array.isArray(value.values) &&
    value.values.length >= 5 &&
    value.values.every(isSeasonalIndexPoint)
  );
}

/**
 * Cross-field consistency for one series' new blocks. The blocks are
 * computed, not transcribed, so a drifted builder must fail here rather than
 * ship a headline that disagrees with the numbers underneath it.
 * Returns an array of problem strings (empty when consistent).
 */
function stateProblems(series, label) {
  const problems = [];
  const state = series.state;
  if (state === undefined) return problems;
  if (state.episode !== series.phase) {
    problems.push(`${label}.state.episode does not match the legacy ${label}.phase alias`);
  }
  const emerging = state.conditions !== 'neutral' && state.episode === 'neutral';
  if (state.emerging !== emerging) {
    problems.push(`${label}.state.emerging does not follow from conditions and episode`);
  }
  const anom = series.latest.anom;
  const expected =
    anom >= state.threshold ? 'el-nino' : anom <= -state.threshold ? 'la-nina' : 'neutral';
  if (state.conditions !== expected) {
    problems.push(
      `${label}.state.conditions (${state.conditions}) does not follow from the newest season ` +
      `(${anom}) against the ${state.threshold} threshold`
    );
  }
  const side = series.latest.thresholdSide;
  if (side !== undefined) {
    const expectedSide =
      anom >= state.threshold ? 'above' : anom <= -state.threshold ? 'below' : 'within';
    if (side !== expectedSide) {
      problems.push(`${label}.latest.thresholdSide does not follow from the newest season`);
    }
    if (series.latest.exceedsThreshold !== (expectedSide !== 'within')) {
      problems.push(`${label}.latest.exceedsThreshold does not follow from the newest season`);
    }
  }
  return problems;
}

function isNino34Point(value) {
  return (
    isObject(value) &&
    Number.isInteger(value.year) &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    typeof value.total === 'number' &&
    Number.isFinite(value.total) &&
    typeof value.climAdjust === 'number' &&
    Number.isFinite(value.climAdjust) &&
    typeof value.anom === 'number' &&
    Number.isFinite(value.anom)
  );
}

function isNino34Series(value) {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    isNino34Point(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(isNino34Point)
  );
}

function isSoiPoint(value) {
  return (
    isObject(value) &&
    Number.isInteger(value.year) &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    (value.value === null ||
      (typeof value.value === 'number' &&
        Number.isFinite(value.value) &&
        value.value !== -999.9))
  );
}

function isSoiLatestPoint(value) {
  return isSoiPoint(value) && typeof value.value === 'number';
}

function isSoiSeries(value) {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    value.block === 'standardized' &&
    isSoiLatestPoint(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(isSoiPoint)
  );
}

function isPlumePoint(value) {
  return (
    isObject(value) &&
    typeof value.seas === 'string' &&
    typeof value.laNina === 'number' &&
    typeof value.neutral === 'number' &&
    typeof value.elNino === 'number'
  );
}

function isProbabilities(value) {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    typeof value.baseline === 'string' &&
    (typeof value.issued === 'string' || value.issued === null) &&
    Array.isArray(value.seasons) &&
    value.seasons.length >= 2 &&
    value.seasons.every(isPlumePoint)
  );
}

/** The optional series keys a snapshot may carry beyond the required pair. */
export const OPTIONAL_SERIES = ['nino34', 'soi', 'probabilities'];

/**
 * The CPC rule pages the state block cites, exported so the builder and the
 * validator name the same URLs (VERIFIED live 2026-09-02, HTTP 200 each).
 */
export const CPC_RULE_URLS = Object.freeze({
  /** ENSO FAQ: the onset rule, one three-month season past +/- 0.5 C. */
  onset: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ensofaq.shtml',
  /** RONI episodes page: the five-consecutive-overlapping-season rule. */
  episode: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/',
  /** The ENSO Diagnostic Discussion, where CPC states the official status. */
  discussion:
    'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml',
  /** The definitions behind that status (Watch, Advisory, Final Advisory). */
  statusDefinitions:
    'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/enso-alert-readme.shtml'
});

/*
 * ---------------------------------------------------------------------------
 * The issuer cross-check (report 18 section 8 item 4, 2026-09-02).
 *
 * The contract above proves the snapshot is internally consistent: the
 * headline follows from the numbers under it. It cannot catch the defect that
 * actually shipped, which was the pipeline being CORRECT and STALE at the same
 * time: for weeks the app said ENSO was neutral while CPC held a standing
 * El Nino Advisory. Nothing in the repository compared the artifact to the
 * issuer's own status line, so nothing noticed.
 *
 * These two functions are that comparison, kept pure so the validator's pinned
 * self-test can drive them from stubbed page text and so the gate still works
 * with no network. The fetch, the timeout and the warn-or-fail decision live
 * in scripts/validate-enso-snapshot.mjs.
 *
 * This reads ONE line of a federal public page to check an assertion the app
 * already makes. It is not a scrape: no CPC text is stored, rendered, or
 * shipped, and no probability is derived from it (ENSOSCI-06 stands).
 *
 * CPC's own definitions, from
 * .../enso_advisory/enso-alert-readme.shtml (report 13, ENSOSCI-01):
 *   "El Nino or La Nina Watch: Issued when conditions are favorable for the
 *    development of El Nino or La Nina conditions within the next six months."
 *   "El Nino or La Nina Advisory: Issued when El Nino or La Nina conditions
 *    are observed and expected to continue."
 *   "Final El Nino or La Nina Advisory: Issued after El Nino or La Nina
 *    conditions have ended."
 *   "NA: ENSO Alert System is not active."
 * ---------------------------------------------------------------------------
 */

/** The entities the CPC discussion page actually emits, decoded to ASCII. */
const CPC_ENTITIES = [
  [/&nbsp;/gi, ' '],
  [/&ntilde;/g, 'n'],
  [/&Ntilde;/g, 'N'],
  [/&deg;/gi, ' degrees '],
  [/&#37;/g, '%'],
  [/&quot;/gi, '"'],
  [/&#39;/g, "'"],
  [/&amp;/gi, '&']
];

/** HTML to one whitespace-collapsed ASCII line. */
function flattenPage(html) {
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  for (const [pattern, replacement] of CPC_ENTITIES) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Read CPC's "ENSO Alert System Status" line out of the ENSO Diagnostic
 * Discussion page.
 *
 * Returns { raw, status } where `raw` is the status words as published and
 * `status` is one of the seven states below, or null when the line is absent
 * or says something this reader does not recognize. A null is deliberately
 * NOT a finding: the caller warns and passes, because a page CPC restyled is
 * not evidence that the snapshot is wrong.
 */
export function readEnsoAlertStatus(html) {
  const text = flattenPage(html);
  const label = /ENSO\s+Alert\s+System\s+Status\s*:?/i.exec(text);
  if (label === null) return null;
  let raw = text.slice(label.index + label[0].length, label.index + label[0].length + 120).trim();
  // The Synopsis paragraph follows the status on the live page; a full stop
  // ends the "NA: ENSO Alert System is not active." wording. Either boundary
  // keeps the reader from swallowing forecast prose that names both phases.
  const synopsis = /synopsis/i.exec(raw);
  if (synopsis !== null) raw = raw.slice(0, synopsis.index).trim();
  const stop = raw.indexOf('.');
  if (stop !== -1) raw = raw.slice(0, stop).trim();
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();
  const elNino = /el\s*nino/.test(lower);
  const laNina = /la\s*nina/.test(lower);
  // Both phases in one status line is not a status this reader understands.
  if (elNino && laNina) return null;
  if (!elNino && !laNina) {
    if (/not\s+active/.test(lower) || /^na\b/.test(lower)) return { raw, status: 'not-active' };
    return null;
  }
  const phase = elNino ? 'el-nino' : 'la-nina';
  if (/final/.test(lower)) return { raw, status: `${phase}-final-advisory` };
  if (/watch/.test(lower)) return { raw, status: `${phase}-watch` };
  if (/advisory/.test(lower)) return { raw, status: `${phase}-advisory` };
  return null;
}

/**
 * Is the snapshot's `state.conditions` consistent with CPC's status line?
 * Returns null when consistent, otherwise a one-line reason.
 *
 * Only a standing (non-final) Advisory and an inactive alert system constrain
 * the value, because only those two say what conditions are TODAY. A Watch
 * precedes onset and a Final Advisory follows the end of an episode, so either
 * can legitimately sit beside a neutral snapshot or beside the phase it names;
 * only the OPPOSITE phase contradicts them. Erring toward silence here is
 * deliberate: a gate that cries wolf at a legitimate transition gets muted.
 */
export function ensoAlertStatusMismatch(status, conditions) {
  const said = `CPC's status line says ${status}; the snapshot says conditions are ${conditions}`;
  switch (status) {
    case 'el-nino-advisory':
      return conditions === 'el-nino' ? null : `${said}. An El Nino Advisory is issued when El Nino conditions are observed and expected to continue.`;
    case 'la-nina-advisory':
      return conditions === 'la-nina' ? null : `${said}. A La Nina Advisory is issued when La Nina conditions are observed and expected to continue.`;
    case 'not-active':
      return conditions === 'neutral' ? null : `${said}. CPC's alert system is not active, which is CPC saying neither El Nino nor La Nina conditions are observed.`;
    case 'el-nino-watch':
    case 'el-nino-final-advisory':
      return conditions === 'la-nina' ? `${said}, which is the opposite phase from the one CPC named.` : null;
    case 'la-nina-watch':
    case 'la-nina-final-advisory':
      return conditions === 'el-nino' ? `${said}, which is the opposite phase from the one CPC named.` : null;
    default:
      return null;
  }
}

/** The series keys present (required and optional) on a parsed snapshot. */
export function presentSeries(parsed) {
  return ['oni', 'roni', ...OPTIONAL_SERIES].filter(
    (k) => parsed[k] !== undefined && parsed[k] !== null
  );
}

/**
 * Validate a parsed snapshot against the consumer contract.
 *
 * Returns { errors, warnings }. `errors` are violations the runtime
 * consumer rejects outright (the whole snapshot fails to load): missing or
 * malformed `retrieved`, `oni`, or `roni`. `warnings` are malformed
 * OPTIONAL blocks: the consumer drops them independently and still renders
 * the seasonal indices, but no correct producer emits them, so producer
 * and transport callers treat warnings as failures too (strict).
 */
export function validateEnsoSnapshot(parsed) {
  const errors = [];
  const warnings = [];
  if (!isObject(parsed)) {
    return { errors: ['the snapshot is not a JSON object'], warnings };
  }
  if (!isIsoDay(parsed.retrieved)) {
    errors.push('retrieved is missing or not an ISO day (YYYY-MM-DD)');
  }
  for (const series of ['oni', 'roni']) {
    if (!isIndexSeries(parsed[series])) {
      errors.push(
        `${series} is missing or fails the consumer contract ` +
        '(sourceUrl, phase, and points with seas/year/finite anom/boolean preliminary; at least 5 values)'
      );
    }
  }
  if (parsed.nino34 !== undefined && !isNino34Series(parsed.nino34)) {
    warnings.push('nino34 is present but malformed (the consumer would drop it)');
  }
  if (parsed.soi !== undefined && !isSoiSeries(parsed.soi)) {
    warnings.push('soi is present but malformed (the consumer would drop it)');
  }
  if (parsed.probabilities !== undefined && !isProbabilities(parsed.probabilities)) {
    warnings.push('probabilities is present but malformed (the consumer would drop it)');
  }
  if (parsed.sourceQuotes !== undefined && !isSourceQuotes(parsed.sourceQuotes)) {
    warnings.push('sourceQuotes is present but malformed (each quote needs text, source, and an https url)');
  }
  // The three-state block is a WARNING, not an error, in both directions:
  // the runtime consumer still renders from the legacy `phase` alias when a
  // snapshot predates ENSOSCI-04, but no correct producer omits it, so the
  // builder and the gate (which treat warnings as failures) refuse a
  // snapshot whose headline could fall back to the historical episode rule.
  for (const label of ['oni', 'roni']) {
    const series = parsed[label];
    if (!isIndexSeries(series)) continue;
    if (series.state === undefined) {
      warnings.push(`${label} carries no state block (conditions, episode, direction, emerging)`);
      continue;
    }
    warnings.push(...stateProblems(series, label));
  }
  return { errors, warnings };
}

/**
 * Strict transport/producer acceptance: no errors AND no warnings.
 * Returns null when acceptable, otherwise a one-line reason.
 */
export function rejectEnsoSnapshot(parsedOrRaw) {
  let parsed = parsedOrRaw;
  if (typeof parsedOrRaw === 'string') {
    try {
      parsed = JSON.parse(parsedOrRaw);
    } catch {
      return 'the snapshot is not valid JSON';
    }
  }
  const { errors, warnings } = validateEnsoSnapshot(parsed);
  const problems = [...errors, ...warnings];
  return problems.length > 0 ? problems.join('; ') : null;
}
