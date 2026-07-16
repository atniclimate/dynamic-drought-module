/**
 * Click-triggered related Treaty & Ceded Lands (Unit I, D-0.7.0-038
 * decision 2; design calls in docs/design/UNIT_I_RELATED_CESSIONS_2026-07-15.md).
 *
 * When a user clicks a Tribal Lands (`aiannh`) or Reservation Boundaries
 * (`bia-reservations`) feature, this module PROBES the USFS Royce service
 * for cessions intersecting the clicked feature's bounding box, matches
 * them by name under the D-0.7.0-026 safe-match discipline
 * (src/impact/cession-match.ts), and only on a REAL match activates the
 * `treaty-cessions` layer (through the shared toggle door, so checkbox,
 * registry, URL, and pills stay in sync) with the matched cessions
 * emphasized via the `related` feature-state.
 *
 * Honesty guarantees (mandatory, D-0.7.0-038):
 *   - NO match: nothing activates; the popup slot says plainly that no
 *     cession is on file, with the Royce-scope caveat. The layer never
 *     falls back to showing every cession as if it related to the clicked
 *     Tribe.
 *   - AMBIGUOUS name: the matcher refuses; the slot says the area could
 *     not be matched by name and claims nothing about absence.
 *   - Probe failure, or a truncated probe with no hit: "could not be
 *     checked right now"; absence is never claimed from partial evidence.
 *   - The click only ever turns the layer ON; manual toggle state is
 *     user-owned and never touched here.
 *
 * Supersession: a new click aborts the in-flight probe and replaces the
 * match query (the request-identity-token plus master-abort pattern the
 * Tribal-geography layers share).
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties, Geometry } from 'geojson';

import { loadTribalRoster, trustedNameFor } from '../state/tribal-roster';
import { isChecked } from '../ui/island/bridge';
import { requestLayerOn } from '../ui/layer-toggle-command';
import { relatedCessionsStatusText } from '../ui/cession-wording';
import type { RelatedCessionOutcome } from '../ui/cession-wording';
import { matchCessionFeatures } from './cession-match';
import type { CessionMatchQuery } from './cession-match';
import { geometryBbox } from './context';

/** The two boundary kinds whose click drives a related-cession lookup. */
export type RelatedCessionSourceKind = 'aiannh' | 'bia-reservation';

/** Master abort + identity token for the in-flight probe (invariant 5). */
let probeController: AbortController | null = null;
let probeSeq = 0;

/** First non-empty string among the given property keys. */
function readName(props: GeoJsonProperties, keys: readonly string[]): string | null {
  if (!props) return null;
  for (const key of keys) {
    const v = (props as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/**
 * Build the safe candidate names for one clicked feature. The formal lane
 * exists only for a BIA land area whose LARNAME has a TRUSTED roster row
 * (the D-0.7.0-026 gate); a roster load failure just drops that lane, it
 * never blocks the loose lane.
 */
async function buildQuery(
  kind: RelatedCessionSourceKind,
  props: GeoJsonProperties
): Promise<CessionMatchQuery | null> {
  if (kind === 'aiannh') {
    const looseNames = [
      readName(props, ['BASENAME']),
      readName(props, ['NAME'])
    ].filter((n): n is string => n !== null);
    return looseNames.length > 0 ? { formalNames: [], looseNames } : null;
  }
  const larName = readName(props, ['LARNAME', 'LARName']);
  if (larName === null) return null;
  let formalNames: string[] = [];
  try {
    const formal = trustedNameFor(larName, await loadTribalRoster());
    if (formal !== null) formalNames = [formal];
  } catch {
    // Roster unavailable: the loose lane still runs; nothing is guessed.
  }
  return { formalNames, looseNames: [larName] };
}

/**
 * Probe, match, and (on a match only) surface the related cessions.
 * Resolves to the outcome for the popup slot, or null when a newer click
 * superseded this one (the caller shows nothing for a superseded lookup).
 */
export async function surfaceRelatedCessions(
  map: maplibregl.Map,
  kind: RelatedCessionSourceKind,
  props: GeoJsonProperties,
  geometry: Geometry | undefined | null
): Promise<RelatedCessionOutcome | null> {
  if (probeController) probeController.abort();
  probeController = new AbortController();
  const signal = probeController.signal;
  const token = ++probeSeq;
  // Snapshot the toggle intent at click time: if the layer was on then and
  // the user turns it OFF while the probe runs, the match must not
  // resurrect it (toggles are user-owned; Codex Unit I review, finding 2).
  const wasOnAtClick = isChecked('treaty-cessions');

  // The cession module owns the probe transport and the emphasis state;
  // loading it here (not at boot) keeps the click path lazy like the layer.
  const cessions = await import('../layers/treaty-cessions');
  if (token !== probeSeq) return null;

  const query = await buildQuery(kind, props);
  if (token !== probeSeq) return null;
  const bbox = geometryBbox(geometry);
  if (query === null || bbox === null) {
    cessions.setRelatedCessionQuery(map, null);
    return { state: 'unmatchable' };
  }

  let probe;
  try {
    probe = await cessions.probeCessions(bbox, signal);
  } catch (err) {
    if (signal.aborted || token !== probeSeq) return null;
    console.warn('[related-cessions] Royce probe failed.', err);
    cessions.setRelatedCessionQuery(map, null);
    return { state: 'unavailable' };
  }
  if (signal.aborted || token !== probeSeq) return null;

  const result = matchCessionFeatures(query, probe.features);
  if (result.state === 'matched') {
    // Query first, activation second: the layer's first applied collection
    // already carries the emphasis. requestLayerOn is a guarded no-op when
    // the user already has the layer on. If the user turned the layer OFF
    // while the probe ran, their toggle wins: the match query is still
    // recorded (a later manual re-on lights the same cessions) but nothing
    // reactivates, and the wording tells them the toggle is off.
    cessions.setRelatedCessionQuery(map, query);
    const userTurnedOff = wasOnAtClick && !isChecked('treaty-cessions');
    if (!userTurnedOff) requestLayerOn('treaty-cessions');
    return { state: 'matched', count: result.ids.length, activated: !userTurnedOff };
  }
  cessions.setRelatedCessionQuery(map, null);
  if (result.state === 'ambiguous') return { state: 'unmatchable' };
  // A truncated probe cannot prove absence.
  if (probe.truncated) return { state: 'unavailable' };
  return { state: 'no-match' };
}

/**
 * Fill a popup's related-cession slot once the lookup resolves. Fire and
 * forget from the boundary layers' click handlers; a superseded lookup
 * (the user clicked elsewhere) leaves the old popup untouched, and a popup
 * closed before resolution simply has no live slot to fill.
 */
export function hydrateRelatedCessions(
  map: maplibregl.Map,
  popup: maplibregl.Popup,
  kind: RelatedCessionSourceKind,
  props: GeoJsonProperties,
  geometry: Geometry | undefined | null
): void {
  const fill = (outcome: RelatedCessionOutcome): void => {
    const el = popup.getElement()?.querySelector('[data-related-cessions]');
    if (el) el.textContent = relatedCessionsStatusText(outcome);
  };
  surfaceRelatedCessions(map, kind, props, geometry)
    .then((outcome) => {
      if (outcome !== null) fill(outcome);
    })
    .catch((err) => {
      console.warn('[related-cessions] lookup failed.', err);
      fill({ state: 'unavailable' });
    });
}
