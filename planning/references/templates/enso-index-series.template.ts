/**
 * TEMPLATE, not compiled or imported. The src/impact/enso.ts pieces for one
 * optional observed-index series, in the order they appear in that file:
 *
 *   1. types            (beside Nino34Point / Nino34Series)
 *   2. EnsoSnapshot     (one optional field)
 *   3. URL constants    (beside CPC_STATUS_URL and friends)
 *   4. guards           (beside isNino34Point / isNino34Series)
 *   5. load branch      (inside loadEnsoSnapshot, beside the nino34 branch)
 *   6. sentence         (beside nino34Text)
 *   7. claim            (inside fetchEnsoClaims, beside observedCompanionClaims)
 *
 * Replace __Name__ (PascalCase), __slug__ (camelCase), __ISSUER__, __URL__.
 * Every rule below is one enso.ts already follows; the template only makes
 * the pattern explicit so a session cannot half-copy it.
 *
 * Doctrine, restated from the enso.ts header so it travels with the code:
 *   - ENSO shifts the odds, it does not set the outcome. This index does not
 *     declare a state and does not drive one; RONI does.
 *   - The claim quotes what the issuer says the index IS. It does not say
 *     what the index implies for the weeks or seasons ahead. A sentence that
 *     needs a forward-looking verb is an outlook and does not belong here.
 *   - Past HARD_STALE_DAYS the claim is withheld, like the tendency claim.
 */

// ---------------------------------------------------------------------------
// 1. Types
// ---------------------------------------------------------------------------

interface __Name__Point {
  readonly year: number;
  readonly month: number;
  /** Present for weekly or daily products; absent for monthly ones. */
  readonly day?: number;
  /** The issuer's anomaly, in the issuer's units, against the stated base period. */
  readonly anom: number;
}

interface __Name__Series {
  readonly sourceUrl: string;
  /** Only when the file or page states a publication date (ISO day). */
  readonly published?: string;
  readonly latest: __Name__Point;
  readonly values: __Name__Point[];
}

// ---------------------------------------------------------------------------
// 2. EnsoSnapshot: add one optional field. RONI and ONI stay required.
// ---------------------------------------------------------------------------
//
//   interface EnsoSnapshot {
//     ...
//     readonly __slug__?: __Name__Series;
//   }

// ---------------------------------------------------------------------------
// 3. URL constants. The product page, not the data file; the builder owns
//    the data file. Re-stamp CITATIONS_VERIFIED when this is verified.
// ---------------------------------------------------------------------------

const __NAME___PRODUCT_URL = '__URL__';

// ---------------------------------------------------------------------------
// 4. Guards, mirroring isNino34Point / isNino34Series and the contract file.
// ---------------------------------------------------------------------------

function is__Name__Point(value: unknown): value is __Name__Point {
  return (
    isObject(value) &&
    Number.isInteger(value.year) &&
    typeof value.month === 'number' &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    (value.day === undefined ||
      (typeof value.day === 'number' && Number.isInteger(value.day) && value.day >= 1 && value.day <= 31)) &&
    typeof value.anom === 'number' &&
    Number.isFinite(value.anom)
  );
}

function is__Name__Series(value: unknown): value is __Name__Series {
  return (
    isObject(value) &&
    typeof value.sourceUrl === 'string' &&
    hasValidPublished(value) &&
    is__Name__Point(value.latest) &&
    Array.isArray(value.values) &&
    value.values.length > 0 &&
    value.values.every(is__Name__Point)
  );
}

// ---------------------------------------------------------------------------
// 5. Load branch, inside loadEnsoSnapshot. Dropped independently when
//    malformed; the seasonal indices still render.
// ---------------------------------------------------------------------------
//
//   const __slug__ =
//     json.__slug__ === undefined
//       ? undefined
//       : is__Name__Series(json.__slug__)
//         ? json.__slug__
//         : null;
//   if (__slug__ === null) {
//     console.warn('[enso] malformed __slug__ block in snapshot; seasonal indices still render.');
//   }
//   ...
//   return { ..., ...(__slug__ ? { __slug__ } : {}) };

// ---------------------------------------------------------------------------
// 6. The sentence. Observation only. The issuer's description of the index
//    (under 15 words, from the register's issuer_meaning quote) plus the
//    value, the date it is valid for, and the gap to retrieval where the
//    monthly companion states one. No forward-looking verb.
// ---------------------------------------------------------------------------

function __slug__Text(series: __Name__Series, retrieved: string): string {
  const latest = series.latest;
  const when =
    latest.day === undefined
      ? monthYear(latest.year, latest.month)
      : `${MONTH_NAMES[latest.month - 1]} ${latest.day}, ${latest.year}`;
  // __ISSUER_MEANING__ is the issuer's own description, verified by
  // ddm-science-verifier against __URL__ and recorded in the register.
  return (
    `The __ISSUER__ __Name__ anomaly was ${signed(latest.anom)} __UNITS__ (${when}, the newest value posted). ` +
    `__ISSUER__ describes it as __ISSUER_MEANING__. ` +
    'It is an observed index, not an ENSO phase declaration and not a forecast: it says nothing about the weeks ahead.'
  );
}

// ---------------------------------------------------------------------------
// 7. The claim, inside fetchEnsoClaims. Beside observedCompanionClaims,
//    spread into the returned claims array in display order.
// ---------------------------------------------------------------------------
//
//   const __slug__Claims =
//     snap.__slug__ && !stale
//       ? [
//           makeClaim({
//             text: __slug__Text(snap.__slug__, snap.retrieved),
//             source: '__ISSUER__ __Name__ anomaly',
//             sourceUrl: __NAME___PRODUCT_URL,
//             evidence: 'analyzed',
//             dates: claimDates(snap.retrieved, snap.__slug__.published),
//             lineage: ['__ISSUER__ __Name__ file (__machine file name__)'],
//             uncertainty: {
//               kind: 'typical',
//               text: '__the issuer's own revision or resolution note, e.g. values revise for N months; published to one decimal__'
//             },
//             // An observed index of the state now: the current horizon.
//             horizon: 'current'
//           })
//         ]
//       : [];
//
// Then add `...__slug__Claims` to the claims array, and add the new lineage
// label to LINEAGE_SOURCE_URLS so the label and its page cannot drift apart.

// Referenced helpers that already exist in enso.ts and are NOT redefined here:
//   isObject, hasValidPublished, signed, monthYear, MONTH_NAMES, claimDates,
//   makeClaim, HARD_STALE_DAYS (via `stale`), LINEAGE_SOURCE_URLS.
export {};
