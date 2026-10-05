/**
 * Near-term: the NOAA CPC 6-10 day and 8-14 day outlooks (probability tilt)
 * at a point, the briefing's `cpcExtended` lane.
 *
 * S30D P3-TRUTH (repair round 2): moved here, unchanged in what it states,
 * from `src/impact/sources.ts`, whose `fetchCpcOutlookClaims` now reaches it
 * through a bounded dynamic import (`settleLazy` there), as the ENSO read is
 * reached (`loadEnsoClaims`, hydrate.ts). That keeps this read's code out of
 * the briefing's first-activation closure (`point-heat-briefing` in
 * scripts/check-activation-budget.mjs). The shared request and wording
 * helpers stay in sources.ts, which this chunk imports, so both reads still
 * share one fetch budget, one error-envelope rule and one date style.
 */

import { URLS } from '../config/urls';
import { cpcOutlookBarsSvg } from '../ui/charts';
import { isObject } from '../util/guards';
import { makeClaim, todayIso } from './evidence';
import {
  EsriServiceError,
  GEOJSON_ACCEPT,
  epochField,
  esriPointQuery,
  featuresOf,
  fetchJson,
  humanDayUtc,
  humanDayUtcNoYear,
  isoDayUtc,
  upstreamNote,
  type SourceResult
} from './sources';
import type { BoundarySelectionContext, SourcedClaim } from './types';

interface OutlookValue {
  readonly cat: string;
  readonly prob: number;
  /** `fcst_date`: when CPC issued the outlook, epoch ms; null when absent. */
  readonly issued: number | null;
  /** `start_date`: first day of the valid window, epoch ms. */
  readonly validFrom: number | null;
  /** `end_date`: last day of the valid window, epoch ms (inclusive). */
  readonly validTo: number | null;
}

/**
 * The fields the extended-range outlook layers publish that the briefing can
 * state honestly: the tercile category and its probability, plus the issuance
 * and the valid window the service already sends with them (FSPEC-03). All
 * three date fields are epoch-millisecond UTC Date fields.
 */
const CPC_OUT_FIELDS = 'cat,prob,fcst_date,start_date,end_date';

/**
 * Query one CPC outlook layer (0 = temperature, 1 = precipitation) at a point.
 * Rejects when the request failed; resolves `null` when the layer answered
 * with no feature here (a complete answer with nothing to state); a feature
 * whose `cat` is not text resolves with `cat: ''`, which no `leanPhrase` code
 * reads, so the caller treats it as an answer it could not read (S30D
 * P3-TRUTH: those three outcomes are kept apart all the way to the cell).
 */
async function fetchCpcLayer(
  base: string,
  layer: 0 | 1,
  lng: number,
  lat: number,
  signal: AbortSignal
): Promise<OutlookValue | null> {
  const url = `${base}/${layer}/query?${esriPointQuery(lng, lat, CPC_OUT_FIELDS).toString()}`;
  const json: unknown = await fetchJson(url, GEOJSON_ACCEPT, signal);
  const f = featuresOf(json)[0] ?? null;
  if (!isObject(f) || !isObject(f.properties)) return null;
  const cat = f.properties.cat;
  const prob = f.properties.prob;
  return {
    cat: typeof cat === 'string' ? cat : '',
    prob: typeof prob === 'number' ? prob : NaN,
    issued: epochField(f.properties.fcst_date),
    validFrom: epochField(f.properties.start_date),
    validTo: epochField(f.properties.end_date)
  };
}

/**
 * "Issued Sep 1, 2026; valid Sep 7 to Sep 11, 2026." from whichever of the
 * three date fields the service returned, and the empty string when it
 * returned none. An outlook must never state a window it was not given, so
 * each half is omitted independently rather than inferred from the other.
 */
function outlookValiditySentence(v: OutlookValue | null): string {
  if (!v) return '';
  const parts: string[] = [];
  if (v.issued !== null) parts.push(`Issued ${humanDayUtc(v.issued)}`);
  if (v.validFrom !== null && v.validTo !== null) {
    const sameYear =
      new Date(v.validFrom).getUTCFullYear() === new Date(v.validTo).getUTCFullYear();
    const from = sameYear ? humanDayUtcNoYear(v.validFrom) : humanDayUtc(v.validFrom);
    parts.push(`valid ${from} to ${humanDayUtc(v.validTo)}`);
  } else if (v.validFrom !== null) {
    parts.push(`valid from ${humanDayUtc(v.validFrom)}`);
  } else if (v.validTo !== null) {
    parts.push(`valid through ${humanDayUtc(v.validTo)}`);
  }
  return parts.length > 0 ? ` ${parts.join('; ')}.` : '';
}

/**
 * Render a category and probability into a lean phrase for one variable.
 * `EC` (Equal Chances) is CPC's own statement that no forecast tool favors
 * any tercile, which is a different claim from a near-normal tilt (the
 * issuer's own glossary: "areas where equal chances of experiencing
 * below-normal, normal, or above-normal conditions are possible";
 * ddm-science-verifier EC verdict, 2026-09-09). It is never folded into
 * `Normal`'s "near-normal" phrase. A category code that is none of the
 * four the issuer's service carries renders nothing rather than invent a
 * tilt: `leanPhrase` returning `null` here already leaves the claim to the
 * surviving variable, or drops the window if neither answers (see the
 * `parts.filter` call above this function's caller).
 */
function leanPhrase(v: OutlookValue | null, variable: string): string | null {
  if (!v) return null;
  const odds = Number.isFinite(v.prob) ? ` (${v.prob}% odds)` : '';
  if (v.cat === 'Above') return `above-normal ${variable}${odds}`;
  if (v.cat === 'Below') return `below-normal ${variable}${odds}`;
  if (v.cat === 'Normal') return `near-normal ${variable}`;
  if (v.cat === 'EC') {
    return `equal chances of above-, near-, or below-normal ${variable} (no CPC-favored category)`;
  }
  return null;
}

/** Drought-and-fire interpretation of a temperature and precipitation lean. */
function outlookInterpretation(temp: OutlookValue | null, precip: OutlookValue | null): string {
  if (temp?.cat === 'Above' && precip?.cat === 'Below') {
    return 'This hotter, drier tilt worsens near-term dryness and raises fire and heat risk.';
  }
  if (temp?.cat === 'Below' && precip?.cat === 'Above') {
    return 'This cooler, wetter tilt eases near-term dryness.';
  }
  return '';
}

/**
 * Query the CPC 6-10 day and 8-14 day temperature and precipitation outlooks at
 * the point and surface each window's probability tilt as an outlook claim. The
 * lean is stated as a probability, never a deterministic value (the honest
 * outlook rule), and each claim carries the issuance and the valid window the
 * service publishes alongside the category. A window whose fetches fail is
 * skipped; the result is ok when at least one window resolved, and partial
 * when a window or a variable did not.
 */
export async function readCpcOutlookClaims(
  context: BoundarySelectionContext,
  signal: AbortSignal
): Promise<SourceResult> {
  const { lng, lat } = context.lngLat;
  const source = 'NOAA CPC extended-range outlooks';
  const sourceUrl = 'https://www.cpc.ncep.noaa.gov/';

  const windows: Array<{ label: string; base: string }> = [
    { label: '6-10 day', base: URLS.cpc610OutlookMapServer },
    { label: '8-14 day', base: URLS.cpc814OutlookMapServer }
  ];

  // Each settled claim carries its window's ordinal so chronological order
  // never depends on the display copy (a wording change must not reorder).
  const settled: Array<{ readonly ordinal: number; readonly claim: SourcedClaim }> = [];
  // S30D P3-TRUTH: only a FAILED request, or an answer the code cannot read,
  // leaves the read incomplete; a layer that answered with no feature here is
  // a complete answer with nothing to state. Only a window whose two requests
  // both got NO answer is what the existing note ("One CPC outlook window did
  // not respond.") says (repair round 2): an HTTP 200 error envelope
  // (`EsriServiceError`) is an answer that reports an error, so a window that
  // got one is incomplete but never "did not respond". `answered` records
  // that some request answered with data or with an empty layer.
  let windowFailed = false;
  let incomplete = false;
  let answered = false;
  // The first error-envelope answer seen across both windows, kept so a host
  // that answered with an error is not reported as one that never answered
  // (FSPEC-01). The per-variable catches below swallow the rejection to keep
  // the sibling variable, so the envelope has to be recorded on the way past.
  let serviceError: EsriServiceError | null = null;
  const keepServiceError = (err: unknown): null => {
    if (err instanceof EsriServiceError && serviceError === null) serviceError = err;
    return null;
  };
  await Promise.all(
    windows.map(async ({ label, base }, ordinal) => {
      let failed = 0;
      let silent = 0;
      const miss = (err: unknown): null => {
        failed += 1;
        if (!(err instanceof EsriServiceError)) silent += 1;
        return keepServiceError(err);
      };
      try {
        // Fetch temperature and precipitation independently so one variable's
        // HTTP failure does not discard the other; a window still emits the
        // variable that succeeded (graceful degradation, honest-feedback rule).
        const [temp, precip] = await Promise.all([
          fetchCpcLayer(base, 0, lng, lat, signal).catch(miss),
          fetchCpcLayer(base, 1, lng, lat, signal).catch(miss)
        ]);
        if (signal.aborted) return;
        const tempPhrase = leanPhrase(temp, 'temperature');
        const precipPhrase = leanPhrase(precip, 'precipitation');
        // An answer whose category the code cannot read (`leanPhrase` null on
        // a returned feature) is neither "no outlook here" nor "did not
        // respond": the read did not establish that variable, so it is
        // incomplete, and no note is attached (none would be true).
        if (failed > 0 || (temp && !tempPhrase) || (precip && !precipPhrase)) incomplete = true;
        if (silent > 1) windowFailed = true;
        if (failed < 2) answered = true;
        const parts = [tempPhrase, precipPhrase].filter((p): p is string => p !== null);
        if (parts.length === 0) return;
        const interp = outlookInterpretation(temp, precip);
        // The two variables are layers of ONE issuance, so they carry the same
        // fcst_date, start_date and end_date; whichever answered speaks for the
        // window. An outlook claim with no forecast period is the one kind that
        // must never lack one (DWH-06), so the dates are stated in the sentence
        // and the issuance also dates the claim.
        const dated = temp ?? precip;
        const validity = outlookValiditySentence(dated);
        const issued = dated?.issued ?? null;
        // Foreground the temperature tercile bar (the heat-relevant variable).
        const chartSvg = temp && tempPhrase
          ? cpcOutlookBarsSvg({ variable: 'temperature', cat: temp.cat, prob: temp.prob, window: label })
          : undefined;
        settled.push({
          ordinal,
          claim: makeClaim({
            text: `CPC ${label} outlook: ${parts.join(', ')}.${interp ? ' ' + interp : ''}${validity}`,
            source,
            sourceUrl,
            product: 'cpcExtended',
            evidence: 'outlook',
            dates:
              issued === null
                ? { retrieved: todayIso() }
                : { issued: isoDayUtc(issued), retrieved: todayIso() },
            uncertainty: { kind: 'categorical', text: 'stated as tercile odds (above, near, or below normal), not a deterministic value' },
            ...(chartSvg ? { chartSvg } : {})
          })
        });
      } catch (err) {
        // Both requests have settled by here (their own catches above), so a
        // throw is this code failing on an answer, never a window that did not
        // respond: incomplete, with no window note (repair round 2).
        if (!signal.aborted) console.warn(`[impact] CPC ${label} outlook failed.`, err);
        incomplete = true;
      }
    })
  );

  if (signal.aborted) return { claims: [], ok: false };
  // Keep windows in chronological order (6-10 then 8-14) regardless of which
  // promise settled first, by the declared window ordinal (never by text).
  const claims = settled.sort((a, b) => a.ordinal - b.ordinal).map((s) => s.claim);
  if (!answered) {
    return {
      claims: [],
      ok: false,
      note: upstreamNote(serviceError, 'The CPC extended-range outlooks')
    };
  }
  // S30D P3-TRUTH: a read that answered is ok, even with nothing to state.
  // A complete one with nothing to state lets the cell name its own absence;
  // an incomplete one never does (`fillCell`, repair round 2). An incomplete
  // read keeps what it established and says so, so the cell reads live
  // (partial), never live, and carries the window note only when a whole
  // window got no answer.
  return {
    claims,
    ok: true,
    ...(incomplete ? { partial: true } : {}),
    ...(windowFailed ? { note: 'One CPC outlook window did not respond.' } : {})
  };
}

