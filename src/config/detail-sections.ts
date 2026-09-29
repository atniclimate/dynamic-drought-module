/**
 * Per-cluster Key drawer sections (S30D D1 M11; register item owner-1h;
 * design record interface-chrome-popups-text.md section 2.6 "Drawers",
 * "Sections for N modes"; DR-113).
 *
 * A `HazardClusterDef` (src/config/clusters.ts) names the sections its
 * Key drawer carries through `detailSections`, a list of
 * `DetailSectionKey`. The drawer (src/ui/map-key.ts) looks each key up
 * here for the static host to reveal; it enumerates HAZARD_CLUSTER_KEYS
 * and reads this table, so no mode literal appears in its section logic
 * (only heat declares a section today, but the registry holds for N
 * modes: a future cluster adds an entry here and lists its key, nothing
 * else).
 *
 * Each declared section's real DOM host (`homeId`) is built once, from
 * THIS table, by `src/ui/detail-section-hosts.ts`'s
 * `ensureDetailSectionHosts()` (S30D D1 M11 repair round 3: no longer
 * authored a second time as index.html markup, DR-158's gzip budget and
 * DR-113's one-source rule), and only relocated (never rewritten) by
 * map-key.ts; the node that moves into it (`nodeId`) is mounted
 * elsewhere first (HeatRisk: `#map-bottom-dock`, its F9 seat) and never
 * rebuilt, so DDM-UI-011 (docs/design/README.md:134-136) holds
 * regardless of which seat it is in. This module stays DOM- and
 * import-free config; `detail-section-hosts.ts` is the one place that
 * touches `document`.
 */

export type DetailSectionKey = 'heatrisk-sequence';

export interface DetailSectionDef {
  /** Stable key; matches a HazardClusterDef.detailSections entry. */
  readonly key: DetailSectionKey;
  /** Section heading, read by a future point-scoped popup action (P3)
   * that opens the drawer and moves focus here; M11 does not build that
   * action (carried with the popup frame, M23/M24). */
  readonly heading: string;
  /** The id of the node that moves into this section's host on the
   * desktop shell outside embeds. The SAME node; never rebuilt. */
  readonly nodeId: string;
  /** The id of the section host built by
   * `src/ui/detail-section-hosts.ts`'s `ensureDetailSectionHosts()`
   * (S30D D1 M11 repair round 3, DR-158: no longer authored in
   * index.html, so this table is the one source, DR-113). map-key.ts
   * only relocates and shows/hides this element; it never writes its
   * contents. */
  readonly homeId: string;
  /** Whether a point selection scopes this section's content (the
   * HeatRisk sequence shows nothing, then the fallback sentence, until a
   * place is selected). */
  readonly pointScoped: boolean;
  /** Exact, check:vocabulary-clean sentence shown while the section is
   * revealed but `pointScoped` and nothing is selected yet. */
  readonly fallback: string;
}

export const DETAIL_SECTIONS: Readonly<Record<DetailSectionKey, DetailSectionDef>> = {
  'heatrisk-sequence': {
    key: 'heatrisk-sequence',
    heading: 'HeatRisk, next seven days',
    nodeId: 'heatrisk-sequence',
    homeId: 'detail-section-heatrisk-sequence',
    pointScoped: true,
    fallback:
      'Select a place on the map to see its HeatRisk for each of the next seven days.'
  }
};

/** The declared keys in table order, for consumers that enumerate. */
export const DETAIL_SECTION_KEYS: readonly DetailSectionKey[] = Object.keys(
  DETAIL_SECTIONS
) as DetailSectionKey[];
