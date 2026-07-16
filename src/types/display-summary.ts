/**
 * The honest prose display-summary model (S1; D-0.7.0-041 part 2,
 * adopting the ratified Codex design review section C).
 *
 * The vision requires ONE simple, truthful prose description of what
 * the map currently displays. The trap the review named: prose
 * assembled from checked-checkbox intent would falsely say a loading,
 * unavailable, empty, or zoom-gated layer is displayed. The summary is
 * therefore STATUS-DERIVED, never checkbox-derived: it composes the
 * committed cluster/framing state, the intended layer set, and the
 * registry's canonical six statuses into a sentence plus an optional
 * caveat.
 *
 * S1 lands the pure types and the derivation contract below; the
 * grammar implementation and the rendering island are later units (S3
 * publishes the committed snapshot the summary derives from; S4
 * renders it; S5 adds the ocean-temperature sentence).
 *
 * DERIVATION CONTRACT (the grammar a later unit implements):
 *
 *   ready     include under "Showing".
 *   degraded  include under "Showing partial coverage from" and name
 *             it in the caveat.
 *   loading   exclude from "Showing"; say "Loading X" in the caveat.
 *   error     exclude; say "X is unavailable".
 *   no-data   exclude; reuse the canonical pill wording so live
 *             zero-feature and deployer-placeholder stay distinct.
 *   zoom-in   exclude; say "X appears after you zoom in".
 *
 * The derivation is PURE: no DOM queries, no layer-module imports, no
 * paths around the layer controller. It recomputes only on cluster
 * commit, layer intent/status change, timeline change, and framing
 * change, and it never describes an intermediate half-applied recipe
 * (S3's atomic commit guarantees the input snapshot).
 */

import type { LayerStatus } from './layer';
import type { HazardClusterKey } from '../config/clusters';
import type { FramingKey } from '../config/framings';
import type { UsdmViewMode, OutlookRange } from '../state/timeline';

/**
 * A committed snapshot of the temporal-axis state (the timeline store's
 * four registers), so the summary can name the "when" without reaching
 * into the store mid-transition.
 */
export interface TimelineSnapshot {
  /** Selected USDM valid-Tuesday (YYYYMMDD), or null for the current week. */
  readonly usdmWeek: string | null;
  readonly usdmMode: UsdmViewMode;
  /** Selected SST anomaly frame (YYYY-MM-DD), or null for the latest. */
  readonly sstDate: string | null;
  readonly outlookRange: OutlookRange;
}

export interface DisplaySummaryInput {
  /** The committed cluster, or 'custom' once the user has customized
   * in the LAYERS studio (cluster= comes off the URL; D-0.7.0-044). */
  readonly cluster: HazardClusterKey | 'custom';
  /** The active framing, or null for the ALL state (absence is the
   * truth; D-0.7.0-041). */
  readonly framing: FramingKey | null;
  /** The intended (requested) layer keys from the committed state. */
  readonly intendedKeys: ReadonlySet<string>;
  /** Canonical per-layer statuses from the registry. */
  readonly statuses: ReadonlyMap<string, LayerStatus>;
  readonly timeline: TimelineSnapshot;
}

export interface DisplaySummary {
  /** The one-sentence "Showing ..." description of rendered truth. */
  readonly primary: string;
  /** Availability honesty (loading, unavailable, partial, zoom-gated),
   * or null when everything intended is rendered. This is the only
   * part announced politely to assistive tech. */
  readonly caveat: string | null;
}

/** The pure derivation a later unit implements against this contract. */
export type DeriveDisplaySummary = (input: DisplaySummaryInput) => DisplaySummary;
