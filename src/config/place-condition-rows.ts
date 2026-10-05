/**
 * Per-cluster place-condition rows (S30D D1 M24; register item owner-1k;
 * task DDM-P11-T04; D1.md:145; design record interface-chrome-popups-text.md
 * section 3.5, "The Conditions block"; DR-113).
 *
 * A `HazardClusterDef` (src/config/clusters.ts) names the row its mode
 * contributes to a place popup's Conditions block through
 * `placeConditionRow`: a key of this table, or `null` with a recorded
 * deferral below. The block (src/ui/popup-conditions.ts) enumerates
 * HAZARD_CLUSTER_KEYS through `placeConditionRowKeys` and builds one row
 * builder per key, so no mode literal and no literal layer list appear in
 * its logic: a future cluster adds a row here and names it, nothing else.
 *
 * MODE-AGNOSTIC, as the block was before this table: a row is listed
 * whenever one of its layers is on, whichever mode is committed, in table
 * order (drought, NWS alerts, wildfire perimeters: the order the block has
 * always used). The table declares which rows exist; the layer state
 * decides which of them a card shows.
 *
 * DOM-free and import-free apart from `import type` (erased): clusters.ts
 * rides the entry chunk and reads only this module's types, so nothing here
 * may become a runtime edge of it.
 */

import type { HazardClusterKey } from './clusters';
import type { LayerKey } from './layers';

export type PlaceConditionRowKey = 'drought' | 'nws-alerts' | 'wildfire-perimeter';

export interface PlaceConditionRowDef {
  /** Stable key; matches a HazardClusterDef.placeConditionRow value. */
  readonly key: PlaceConditionRowKey;
  /**
   * The layers this row reads, in the block's own precedence (NADM before
   * USDM for drought). A row is listed while any of them is on; one that
   * was asked for and could not be read joins the block's "switched on but
   * could not be read" check.
   */
  readonly layerKeys: readonly [LayerKey, ...LayerKey[]];
}

/** The rows, in the block's presentation order. */
export const PLACE_CONDITION_ROWS: Readonly<Record<PlaceConditionRowKey, PlaceConditionRowDef>> = {
  drought: { key: 'drought', layerKeys: ['nadm-drought', 'usdm'] },
  'nws-alerts': { key: 'nws-alerts', layerKeys: ['nws-alerts'] },
  'wildfire-perimeter': { key: 'wildfire-perimeter', layerKeys: ['nifc-fires'] }
};

/** The declared row keys in table order, for consumers that enumerate. */
export const PLACE_CONDITION_ROW_KEYS: readonly PlaceConditionRowKey[] = Object.keys(
  PLACE_CONDITION_ROWS
) as PlaceConditionRowKey[];

/**
 * A mode whose `placeConditionRow` is `null`, with the reason it has none
 * yet. Internal, never rendered. ENSO's place row (the sea surface
 * temperature anomaly) moves to the ocean sprint the owner asked for on
 * 2026-10-01; until then a place card in ENSO mode lists only the rows
 * whose layers are on. Read by the Conditions block
 * (src/ui/popup-conditions.ts): a mode with a recorded deferral, and with
 * no condition layer on, shows the interim line of draft DR-180.
 */
export const PLACE_CONDITION_ROW_DEFERRED: Readonly<Partial<Record<HazardClusterKey, string>>> = {
  enso: 'the ocean sprint, owner 2026-10-01'
};

/**
 * The rows a place card can list: the union of every cluster's declared
 * row, in table order. Pure, and generic over the cluster table so a test
 * can hand it a synthetic one of any size.
 */
export function placeConditionRowKeys<K extends string>(
  clusters: Readonly<Record<K, { readonly placeConditionRow: PlaceConditionRowKey | null }>>,
  keys: readonly K[]
): PlaceConditionRowKey[] {
  const declared = new Set<PlaceConditionRowKey>();
  for (const key of keys) {
    const row = clusters[key].placeConditionRow;
    if (row !== null) declared.add(row);
  }
  return PLACE_CONDITION_ROW_KEYS.filter((row) => declared.has(row));
}
