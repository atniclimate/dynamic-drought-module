/**
 * The ONE shared El Nino / Southern Oscillation (ENSO) snapshot contract.
 *
 * Mirrors the runtime consumer (src/impact/enso.ts loadEnsoSnapshot and its
 * guards) so every producer and transport step enforces exactly what the
 * consumer requires. Used by: the builder (scripts/build-enso-snapshot.mjs,
 * before writing), the scheduled refresh workflow (via
 * scripts/validate-enso-snapshot.mjs, before committing), and the publish
 * copy-back guard (scripts/publish-public.mjs, before accepting a public
 * snapshot into the dev tree). Added 2026-07-28 after the two-series
 * regression: an old-builder snapshot without `preliminary` flags passed
 * every transport step and the consumer then rejected the whole file, so
 * the live briefing lost its ENSO read (ground-truth audit, plan T0-1).
 *
 * Keep this file dependency-free (plain Node) and keep the guards aligned
 * with src/impact/enso.ts when the consumer contract changes.
 */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isIndexSeries(value) {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    isPhase(value.phase) &&
    isSeasonalIndexPoint(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length >= 5 &&
    value.values.every(isSeasonalIndexPoint)
  );
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
