/**
 * TEMPLATE, not imported anywhere. Two pieces for one optional snapshot series:
 *
 *   A. the builder side, for scripts/build-enso-snapshot.mjs
 *      (upstream URL constants near :60; the per-series fetch/parse functions;
 *      the assembly of the snapshot object);
 *   B. the contract side, for scripts/lib/enso-snapshot-contract.mjs
 *      (OPTIONAL_SERIES near :304; the validator shaped like isNino34Series
 *      near :481).
 *
 * The line references are from the S03b recon report and S09; read the files
 * and re-anchor before editing. Replace __Name__, __slug__, __SLUG__,
 * __ISSUER__, __URL__ throughout. Keep the two sides in step: the contract is
 * one rule expressed twice (builder and browser), exactly as enso.ts's guards
 * mirror it.
 *
 * Rules this template encodes:
 *   - The builder fetches at build time. The browser never sees __URL__.
 *   - A series is optional. A malformed series is dropped with a warning; the
 *     snapshot still writes with RONI and ONI.
 *   - Every value is a number the issuer published, in the issuer's units.
 *     No unit conversion, no smoothing, no derived fields beyond what the
 *     browser needs to format the issuer's own numbers.
 *   - `published` is filled only from a date the file or its page states.
 *     Never from the fetch time; `retrieved` carries that.
 *   - No schedule change. refresh-snapshots.yml already runs the builder.
 */

// ---------------------------------------------------------------------------
// A. Builder side (scripts/build-enso-snapshot.mjs)
// ---------------------------------------------------------------------------

/** Upstream file. Verified live YYYY-MM-DD, HTTP ___, Last-Modified ___. */
const __SLUG_CONST___URL = '__URL__';

/** The product page a reader is sent to, not the data file. */
const __SLUG_CONST___PRODUCT_URL = '__PRODUCT_URL__';

/**
 * Parse the issuer's file into the series shape. Written against the file's
 * documented layout (name the documentation page here). Returns null when the
 * file cannot be parsed, so the caller drops the block instead of writing a
 * half-filled one.
 *
 * @param {string} text  raw file body
 * @returns {{
 *   sourceUrl: string,
 *   published?: string,
 *   latest: { year: number, month: number, day?: number, anom: number },
 *   values: Array<{ year: number, month: number, day?: number, anom: number }>
 * } | null}
 */
export function parse__Name__(text) {
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    // Fixed-width or delimited parse against the documented columns.
    // Skip header lines and sentinel rows (for example -99.9 / -999.9)
    // exactly as the issuer documents them; never coerce a sentinel to 0.
    const parsed = null; // replace with the real row parse
    if (parsed) values.push(parsed);
  }
  if (values.length === 0) return null;
  const latest = values[values.length - 1];
  return {
    sourceUrl: __SLUG_CONST___PRODUCT_URL,
    // published: only if the file or page states it, as an ISO day
    latest,
    values
  };
}

/**
 * Fetch and parse; the shape the existing fetchers use. On any failure log
 * and return undefined so the snapshot writes without this block.
 */
export async function fetch__Name__(fetchText) {
  try {
    const text = await fetchText(__SLUG_CONST___URL);
    const series = parse__Name__(text);
    if (!series) {
      console.warn('[enso-snapshot] __slug__: file fetched but no rows parsed; block omitted.');
      return undefined;
    }
    return series;
  } catch (err) {
    console.warn('[enso-snapshot] __slug__: fetch failed; block omitted.', err);
    return undefined;
  }
}

// In the snapshot assembly, beside nino34Weekly:
//   const __slug__ = await fetch__Name__(fetchText);
//   ...(__slug__ ? { __slug__ } : {})

// ---------------------------------------------------------------------------
// B. Contract side (scripts/lib/enso-snapshot-contract.mjs)
// ---------------------------------------------------------------------------

/**
 * Validator, shaped like isNino34Series. The browser guard in enso.ts
 * (is__Name__Series) must accept exactly the same objects; a divergence
 * between the two is a bug in whichever one changed last.
 */
export function is__Name__Point(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.year) &&
    Number.isInteger(value.month) && value.month >= 1 && value.month <= 12 &&
    (value.day === undefined || (Number.isInteger(value.day) && value.day >= 1 && value.day <= 31)) &&
    typeof value.anom === 'number' && Number.isFinite(value.anom)
  );
}

export function is__Name__Series(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.sourceUrl === 'string' &&
    (value.published === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value.published)) &&
    is__Name__Point(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(is__Name__Point)
  );
}

// In OPTIONAL_SERIES, beside nino34Weekly:
//   __slug__: is__Name__Series,
//
// Then: regenerate public/data/enso-indices.json, run `npm run check:enso`,
// and prove a copy of the snapshot with the block deleted still validates.
