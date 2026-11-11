/**
 * The Place studio: search first, action last, one screen.
 *
 * PRESENTATION (owner direction 2026-11-09 (sprint), DR-pending). One search
 * looks across every place type at once; type chips narrow it; the list is
 * the page (one scroller, no box inside it); and choosing a row raises a
 * selection bar pinned to the bottom that carries the place's gated formal
 * name, its kind in plain words, the honest state of its live boundary read,
 * the representation caveat on every Tribal Nation, and two actions that do
 * what their labels say: open its briefing, or show it on the map.
 *
 * WHAT DID NOT CHANGE. The catalogs are names only. A boundary is read live
 * when a place is chosen (a Tribal Nation's with `cache: 'no-store'`) and is
 * never bundled or kept. The durable typed place, the display snapshot, the
 * restore-then-brief exit and the newest-intent guards are the same code as
 * before, so Back, Escape and browser Back still hand a chosen place's
 * briefing to the map. The search matches with the shared search's own fold,
 * token rule and prefix-first rank (src/util/search-fold.ts) and rules Enter
 * with its `enterChoice`; it does not copy src/ui/search-controller.ts.
 */

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson';

import {
  PLACE_CATALOG,
  PLACE_COVERAGE_MATRIX,
  PLACE_TYPE_ORDER,
  coverageForEntry,
  loadPlaceCatalog,
  typedPlaceRef
} from '../../config/place-catalog';
import type {
  PlaceCapabilityKey,
  PlaceCatalogEntry
} from '../../config/place-catalog';
import { URLS } from '../../config/urls';
import { createBriefingSkeleton } from '../../impact/briefing';
import { selectBriefNarrativeLine } from '../../impact/brief-narrative-selector';
import { buildBoundaryContext, caveatFor } from '../../impact/context';
import {
  bboxIntersection,
  bboxIntersects,
  loadServiceEnvelopePieces,
  mergeByStableIdentifier
} from '../../util/bbox';
import { geometryBboxAcrossAntimeridian } from '../../util/antimeridian';
import { representativePoint } from '../../util/point-in-polygon';
import { applyMatrix } from '../../impact/matrix';
import { createNwsRequestSession } from '../../impact/nws-point';
import { sourceMayRun } from '../../impact/source-policy';
import { fetchUsdmClaims } from '../../impact/sources';
import { computeOverlapRows } from './overlap-engine';
import type { OverlapRelationship } from './overlap-engine';
import type { BoundaryKind, BoundarySelectionContext } from '../../impact/types';
import {
  getTypedPlace,
  onTypedPlaceChange,
  setTypedPlace
} from '../../state/typed-place';
import type { TypedPlaceKind, TypedPlaceRef } from '../../state/typed-place';
import {
  beginPlaceStudioDisplay,
  clearStudioEmphasis,
  emphasizeTypedPlace,
  restoreDisplaySnapshot,
  seedTribeEmphasisTargets,
  setPlaceStudioDisplayKind,
  setStudioWatershedBoundary,
  showStudioReturnBoundary
} from '../../state/display-snapshot';
import { getEmphasisTargets } from '../../state/place-emphasis';
import { setPlaceReturnBriefing, takePlaceReturn } from '../../state/place-return';
import { backToMap, getStudioRoute } from '../../state/studio-route';
import {
  loadWatershedCandidates,
  loadWatershedSelectionGeometry
} from '../../state/watershed-geometry';
import {
  assertCompleteFeatureCollection,
  escapeSql,
  isArealGeometry,
  mergeArealGeometry
} from '../../util/arcgis-features';
import type { ArealGeometry } from '../../util/arcgis-features';
import { fetchJsonWithBudget, fetchSharedJsonWithBudget, US_STATES_SHARED_KEY } from '../../util/fetch';
import { enterChoice, foldSearchText, matchesTokens, prefixFirst } from '../../util/search-fold';
import { openImpactPanel } from '../impact-panel';
import { releaseShownPlace, showPlaceOnMap } from './place-on-map';
import { applyStudioInertScope } from './studio-inert';
import '../../styles/studios.css';

const CAPABILITY_ORDER: readonly PlaceCapabilityKey[] = [
  'selectable',
  'briefable',
  'overlap-computable'
];
const CAPABILITY_LABEL: Readonly<Record<PlaceCapabilityKey, string>> = {
  selectable: 'Selectable',
  briefable: 'Briefing available',
  'overlap-computable': 'Overlap listing'
};

const OVERLAP_COLUMN_ORDER: readonly OverlapRelationship[] = [
  'within',
  'contains',
  'overlaps'
];
const OVERLAP_COLUMN_LABEL: Readonly<Record<OverlapRelationship, string>> = {
  within: 'Within',
  contains: 'Contains',
  overlaps: 'Overlaps'
};
const EDGE_OVERLAPS_OMITTED = 'Edge overlaps omitted.';
const EMPTY_OVERLAP_RESULT = 'No overlapping places listed.';
const UNAVAILABLE_OVERLAP_PAIR =
  'Overlap listing is not available for this pair yet.';
const TRIBAL_OVERLAP_CAVEAT = caveatFor('bia-reservation');
// DRAFT wording: the public naming of the Tribal Nations rows' sources (D13),
// after README.md; PLACE_CATALOG.tribe.sourceLabels stay internal.
const TRIBAL_OVERLAP_SOURCE =
  'Tribal Nations: names from the Bureau of Indian Affairs Federal Register list of federally recognized Tribes (2026-01-30); boundaries from the Bureau of Indian Affairs American Indian and Alaska Native Land Area Representation (AIAN-LAR).';
const PLACE_DATA_TIMEOUT_MS = 8_000;
const PNW_BOUNDS = [-125, 41.5, -110.5, 49.5] as const;

/** The list's reach: every place type, or one. */
type PlaceScope = 'all' | TypedPlaceKind;

/** One place type's names-only catalog, as the list reads it. */
interface CatalogState {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  readonly entries: readonly PlaceCatalogEntry[];
}

const CATALOG_IDLE: CatalogState = { status: 'idle', entries: [] };
const CATALOG_LOADING: CatalogState = { status: 'loading', entries: [] };
const CATALOG_UNAVAILABLE: CatalogState = { status: 'unavailable', entries: [] };
const NO_ATTEMPTS: Readonly<Record<TypedPlaceKind, number>> = {
  tribe: 0,
  state: 0,
  ecoregion: 0,
  watershed: 0
};

/** One listed place with its folded search text, built once per catalog. */
interface PlaceRow {
  readonly entry: PlaceCatalogEntry;
  readonly label: string;
  readonly haystack: string;
}

const rowCache = new WeakMap<readonly PlaceCatalogEntry[], readonly PlaceRow[]>();

/** The rows of one catalog. The folded text is the filter's own, unchanged: label, id and detail. */
function rowsOf(entries: readonly PlaceCatalogEntry[]): readonly PlaceRow[] {
  let rows = rowCache.get(entries);
  if (!rows) {
    rows = entries.map((entry) => ({
      entry,
      label: entry.label,
      haystack: foldSearchText(`${entry.label} ${entry.id} ${entry.detail ?? ''}`)
    }));
    rowCache.set(entries, rows);
  }
  return rows;
}

/** A place type in one plain word or two, for a row and for the selection bar. */
const KIND_WORD: Readonly<Record<TypedPlaceKind, string>> = {
  tribe: 'Tribal Nation',
  state: 'State',
  ecoregion: 'Ecoregion',
  watershed: 'Watershed'
};

/** A place's kind in plain words, with the catalog's own level where it has one. */
function kindWords(kind: TypedPlaceKind, detail: string | null): string {
  return detail ? `${KIND_WORD[kind]}, ${detail}` : KIND_WORD[kind];
}

/**
 * Where each kind's boundary is read from, in the words the instrument
 * already uses: the search's own name for the BIA service, and the source
 * labels of PLACE_CATALOG.
 */
const BOUNDARY_SOURCE: Readonly<Record<TypedPlaceKind, string>> = {
  tribe: 'the BIA land area service',
  state: 'the bundled Census state boundaries',
  ecoregion: 'the EPA ecoregions service',
  watershed: 'the USGS Watershed Boundary Dataset service'
};

/**
 * The live boundary read of the chosen place, as the selection bar states
 * it. `unmatched` is a Tribal Nation the roster names but no land-area
 * representation was safely matched to; `empty` is a source that answered
 * with no boundary; `unreachable` is a read that failed.
 */
type BoundaryRead = 'loading' | 'ready' | 'unreachable' | 'empty' | 'unmatched';

/** The one sentence the bar says about the read. Never a claim the read did not earn. */
function boundarySentence(kind: TypedPlaceKind, read: BoundaryRead): string {
  const source = BOUNDARY_SOURCE[kind];
  switch (read) {
    case 'loading':
      return `Reading the boundary from ${source}...`;
    case 'ready':
      return 'A briefing is available for this place.';
    case 'unreachable':
      return `The boundary could not be read from ${source} just now, so a briefing is not available yet.`;
    case 'empty':
      return `No boundary came back from ${source} for this place, so a briefing is not available.`;
    case 'unmatched':
      return kind === 'tribe'
        ? "DDM has not matched this Nation's name to a boundary in the BIA land area data, so a briefing is not available from this list."
        : 'No boundary is listed for this place, so a briefing is not available.';
  }
}

/** The stewardship note every Tribal Nation read carries beside its caveat. */
const TRIBAL_LIVE_READ_NOTE = 'Its boundary is read live each time. DDM does not store it.';

type NarrativeStatus = 'loading' | 'ready' | 'unavailable';
type OverlapStatus = 'loading' | 'ready';

interface ResolvedPlaceSelection {
  readonly context: BoundarySelectionContext;
  readonly geometry: ArealGeometry;
  readonly bbox: readonly [number, number, number, number];
}

interface PlaceOverlapProperties extends Record<string, unknown> {
  readonly placeKind: TypedPlaceKind;
  readonly placeId: string;
  readonly placeLabel: string;
}

interface PlaceOverlapRow {
  readonly relationship: OverlapRelationship;
  readonly kind: TypedPlaceKind;
  readonly id: string;
  readonly label: string;
}

interface UnavailableOverlapCandidate {
  readonly kind: TypedPlaceKind;
  readonly id: string;
  readonly label: string;
}

interface OverlapViewState {
  readonly status: OverlapStatus;
  readonly rows: readonly PlaceOverlapRow[];
  readonly unavailableKinds: readonly TypedPlaceKind[];
  readonly unavailableCandidates: readonly UnavailableOverlapCandidate[];
  readonly selectionUnavailable: boolean;
  readonly hasSuppressedSlivers: boolean;
}

const EMPTY_OVERLAP_VIEW: OverlapViewState = {
  status: 'loading',
  rows: [],
  unavailableKinds: [],
  unavailableCandidates: [],
  selectionUnavailable: false,
  hasSuppressedSlivers: false
};

interface RuntimeCapabilityCell {
  readonly state: 'available' | 'loading' | 'unavailable';
  readonly scope: string | null;
  readonly geometryDependent: boolean;
}

type RuntimeCapabilityMatrix = Readonly<
  Record<PlaceCapabilityKey, RuntimeCapabilityCell>
>;

function runtimeCoverage(
  kind: TypedPlaceKind,
  selection: TypedPlaceRef | null,
  selectionEntry: PlaceCatalogEntry | null,
  loading: boolean,
  unavailable: boolean
): RuntimeCapabilityMatrix {
  const resolvedEntry =
    selection &&
    selectionEntry?.kind === selection.kind &&
    selectionEntry.id === selection.id
      ? selectionEntry
      : null;
  const matrix = resolvedEntry
    ? coverageForEntry(resolvedEntry)
    : PLACE_COVERAGE_MATRIX[selection?.kind ?? kind];
  const unresolvedSelection =
    selection !== null && selection.kind === kind && resolvedEntry === null;
  const catalogFailureAffectsMatrix =
    unavailable && (selection === null || selection.kind === kind);
  const resolve = (capability: PlaceCapabilityKey): RuntimeCapabilityCell => {
    const cell = matrix[capability];
    if (!cell.geometryDependent) return cell;
    if (catalogFailureAffectsMatrix) return { ...cell, state: 'unavailable' };
    if (!unresolvedSelection) return cell;
    return { ...cell, state: loading ? 'loading' : 'unavailable' };
  };
  return {
    selectable: resolve('selectable'),
    briefable: resolve('briefable'),
    'overlap-computable': resolve('overlap-computable')
  };
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
  init: RequestInit | null = null,
  maxDecodedBytes?: number,
  timeoutMs = PLACE_DATA_TIMEOUT_MS
): Promise<unknown> {
  return fetchJsonWithBudget(
    url,
    init,
    signal,
    timeoutMs,
    maxDecodedBytes
  );
}

/**
 * The bundled us-states.geojson read, shared page-lifetime (DDM-P14-T06)
 * across this studio's two readers (a single-state selection, a bbox
 * overlap-candidate scan) and every other reader of the same file (the
 * states layer's own activation, the click-door fallback, the deep link, the
 * place catalog's state list). Kept separate from `fetchJson` above, which
 * also serves this studio's per-query ArcGIS ecoregion and watershed reads,
 * none of which share a transport key.
 */
async function fetchSharedUsStates(signal: AbortSignal): Promise<unknown> {
  return fetchSharedJsonWithBudget(
    US_STATES_SHARED_KEY,
    URLS.usStatesLocal,
    null,
    signal,
    PLACE_DATA_TIMEOUT_MS
  );
}

function textProperty(
  properties: GeoJsonProperties,
  key: string
): string | null {
  const value = properties?.[key];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// bboxIntersects/bboxIntersection share the N2-A circular
// longitude contract with deep links and search.

function featureIntersectsBbox(
  feature: Feature,
  bbox: readonly [number, number, number, number]
): boolean {
  const candidateBbox = geometryBboxAcrossAntimeridian(feature.geometry);
  return candidateBbox ? bboxIntersects(candidateBbox, bbox) : false;
}

function arcGisEnvelopeParams(
  envelope: string,
  outFields: string
): URLSearchParams {
  return new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'true',
    geometryPrecision: '5',
    resultRecordCount: '2000',
    f: 'geojson'
  });
}

// About 55 m, far below what the 2 percent sliver rule can show; keeps a
// state's or Tribe's ecoregion candidates under the 8 MiB body cap (Idaho is
// 12.7 MB at full resolution). An ecoregion selection stays full resolution:
// simplifying both levels separately flips `contains` rows to `overlaps`.
function ecoregionCandidateParams(
  envelope: string,
  outFields: string,
  selectionKind: TypedPlaceKind
): URLSearchParams {
  const params = arcGisEnvelopeParams(envelope, outFields);
  if (selectionKind !== 'ecoregion') params.set('maxAllowableOffset', '0.0005');
  return params;
}

// Full-resolution Middle Rockies candidates are 11.4 MB, over the 8 MiB default.
const ECOREGION_CANDIDATE_MAX_BYTES = 24 * 1024 * 1024;
// EPA streams that answer in 4 to 6 s on a good day; 8 s is too thin for headers plus body.
const ECOREGION_CANDIDATE_TIMEOUT_MS = 20_000;

function resolvedSelection(
  kind: BoundaryKind,
  title: string,
  properties: GeoJsonProperties,
  geometry: ArealGeometry
): ResolvedPlaceSelection | null {
  const bbox = geometryBboxAcrossAntimeridian(geometry);
  if (!bbox) return null;
  const rawContext = buildBoundaryContext(
    kind,
    properties,
    geometry,
    representativePoint(geometry, bbox),
    title
  );
  return {
    context: { ...rawContext, bbox, pointInsidePlace: true },
    geometry,
    bbox
  };
}

async function resolveStateSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  const collection = assertCompleteFeatureCollection(
    await fetchSharedUsStates(signal)
  );
  abortIfNeeded(signal);
  const feature = collection.features.find(
    (candidate) => textProperty(candidate.properties, 'STUSPS') === entry.id
  );
  if (!feature || !isArealGeometry(feature.geometry)) return null;
  return resolvedSelection(
    'state',
    entry.label,
    feature.properties,
    feature.geometry
  );
}

/** Every LARID a query's response carried, in feature order, deduped later
 * by `seedTribeEmphasisTargets`. */
function larIdsFrom(features: readonly Feature[]): readonly (string | number)[] {
  const ids: Array<string | number> = [];
  for (const feature of features) {
    const id = feature.properties?.['LARID'];
    if (typeof id === 'string' || typeof id === 'number') ids.push(id);
  }
  return ids;
}

async function resolveTribeSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  if (entry.representationIds.length === 0) return null;
  const where = entry.representationIds
    .map((name) => `LARNAME='${escapeSql(name)}'`)
    .join(' OR ');
  const params = new URLSearchParams({
    where,
    outFields: 'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION',
    returnGeometry: 'true',
    outSR: '4326',
    // Full resolution: this response also seeds the emphasis cache that draws
    // the Tribal boundary on the map, so it is never generalized.
    geometryPrecision: '5',
    f: 'geojson'
  });
  const collection = assertCompleteFeatureCollection(
    await fetchJson(
      `${URLS.biaLarFeatureServer}/query?${params.toString()}`,
      signal,
      { cache: 'no-store' }
    )
  );
  abortIfNeeded(signal);
  const geometry = mergeArealGeometry(collection.features);
  if (!geometry) return null;
  // DDM-P2-T10 / DR-094: this ONE no-store AIAN-LAR request already carries
  // every LARID for this Nation's representations, so seed the emphasis
  // cache from it here. display-snapshot's tribe branch of
  // resolveEmphasisTargets then never opens its own second, LARID-only
  // request for this same selection.
  seedTribeEmphasisTargets(entry, larIdsFrom(collection.features));
  return resolvedSelection(
    'bia-reservation',
    entry.label,
    collection.features[0]?.properties ?? null,
    geometry
  );
}

async function resolveEcoregionSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  const isLevel4 = entry.detail === 'Level IV';
  const layer = isLevel4 ? 7 : 11;
  const codeField = isLevel4 ? 'US_L4CODE' : 'US_L3CODE';
  const outFields = isLevel4
    ? 'US_L4CODE,US_L4NAME,US_L3CODE,US_L3NAME'
    : 'US_L3CODE,US_L3NAME';
  const params = new URLSearchParams({
    where: `${codeField}='${escapeSql(entry.id)}'`,
    outFields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    f: 'geojson'
  });
  const collection = assertCompleteFeatureCollection(
    await fetchJson(
      `${URLS.epaEcoregionsMapServer}/${layer}/query?${params.toString()}`,
      signal,
      // EPA sends an ETag; revalidating spares a repeat 3 to 13 MB read.
      { cache: 'no-cache' }
    )
  );
  abortIfNeeded(signal);
  const geometry = mergeArealGeometry(collection.features);
  if (!geometry) return null;
  return resolvedSelection(
    'ecoregion',
    entry.label,
    collection.features[0]?.properties ?? null,
    geometry
  );
}

async function resolveWatershedSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  const feature = await loadWatershedSelectionGeometry(entry, signal);
  if (!feature) return null;
  return resolvedSelection(
    'watershed',
    entry.label,
    feature.properties,
    feature.geometry
  );
}

async function resolvePlaceSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  switch (entry.kind) {
    case 'tribe':
      return resolveTribeSelection(entry, signal);
    case 'state':
      return resolveStateSelection(entry, signal);
    case 'ecoregion':
      return resolveEcoregionSelection(entry, signal);
    case 'watershed':
      return resolveWatershedSelection(entry, signal);
  }
}

function normalizedFeature(
  feature: Feature,
  kind: TypedPlaceKind,
  id: string,
  label: string
): Feature<ArealGeometry, PlaceOverlapProperties> | null {
  if (!isArealGeometry(feature.geometry)) return null;
  return {
    type: 'Feature',
    id: `${kind}:${id}`,
    properties: {
      ...(feature.properties ?? {}),
      placeKind: kind,
      placeId: id,
      placeLabel: label
    },
    geometry: feature.geometry
  };
}

async function loadStateCandidates(
  bbox: readonly [number, number, number, number],
  signal: AbortSignal
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  const collection = assertCompleteFeatureCollection(
    await fetchSharedUsStates(signal)
  );
  abortIfNeeded(signal);
  const features: Array<Feature<ArealGeometry, PlaceOverlapProperties>> = [];
  for (const feature of collection.features) {
    if (!featureIntersectsBbox(feature, bbox)) continue;
    const id = textProperty(feature.properties, 'STUSPS');
    const label = textProperty(feature.properties, 'NAME');
    if (!id || !label) continue;
    const normalized = normalizedFeature(feature, 'state', id, label);
    if (normalized) features.push(normalized);
  }
  return { type: 'FeatureCollection', features };
}

async function loadEcoregionCandidates(
  bbox: readonly [number, number, number, number],
  signal: AbortSignal,
  selectionKind: TypedPlaceKind
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  const query = async (
    layer: 7 | 11,
    envelope: string,
    siblingSignal: AbortSignal
  ): Promise<Feature[]> => {
    const outFields =
      layer === 7
        ? 'US_L4CODE,US_L4NAME,US_L3CODE,US_L3NAME'
        : 'US_L3CODE,US_L3NAME';
    const params = ecoregionCandidateParams(envelope, outFields, selectionKind);
    return assertCompleteFeatureCollection(
      await fetchJson(
        `${URLS.epaEcoregionsMapServer}/${layer}/query?${params.toString()}`,
        siblingSignal,
        { cache: 'no-cache' },
        ECOREGION_CANDIDATE_MAX_BYTES,
        ECOREGION_CANDIDATE_TIMEOUT_MS
      )
    ).features;
  };

  const groups = await loadServiceEnvelopePieces(
    bbox,
    signal,
    async (piece, siblingSignal) => {
      const envelope = piece.join(',');
      const [level3, level4] = await Promise.all([
        query(11, envelope, siblingSignal),
        query(7, envelope, siblingSignal)
      ]);
      return { level3, level4 };
    }
  );
  const level3 = mergeByStableIdentifier(
    groups.map((group) => group.level3),
    (feature) => textProperty(feature.properties, 'US_L3CODE')
  );
  const level4 = mergeByStableIdentifier(
    groups.map((group) => group.level4),
    (feature) => textProperty(feature.properties, 'US_L4CODE')
  );
  abortIfNeeded(signal);
  const features: Array<Feature<ArealGeometry, PlaceOverlapProperties>> = [];
  for (const [source, level] of [
    [level3, 'III'],
    [level4, 'IV']
  ] as const) {
    const codeField = level === 'III' ? 'US_L3CODE' : 'US_L4CODE';
    const nameField = level === 'III' ? 'US_L3NAME' : 'US_L4NAME';
    for (const feature of source) {
      const id = textProperty(feature.properties, codeField);
      const label = textProperty(feature.properties, nameField);
      if (!id || !label) continue;
      const normalized = normalizedFeature(feature, 'ecoregion', id, label);
      if (normalized) features.push(normalized);
    }
  }
  return { type: 'FeatureCollection', features };
}

async function loadTribeCandidates(
  bbox: readonly [number, number, number, number],
  signal: AbortSignal
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  const featureGroups = loadServiceEnvelopePieces(
    bbox,
    signal,
    async (piece, siblingSignal) => {
      const envelope = piece.join(',');
      const params = arcGisEnvelopeParams(
        envelope,
        'LARID,LARNAME,CLASSIFICATION,GISACRES,REGION'
      );
      return assertCompleteFeatureCollection(
        await fetchJson(
          `${URLS.biaLarFeatureServer}/query?${params.toString()}`,
          siblingSignal,
          { cache: 'no-store' }
        )
      ).features;
    }
  );
  const [groups, catalog] = await Promise.all([
    featureGroups,
    loadPlaceCatalog('tribe', signal)
  ]);
  abortIfNeeded(signal);
  const collectionFeatures = mergeByStableIdentifier(groups, (feature) =>
    textProperty(feature.properties, 'LARID')
  );

  const entriesByRepresentation = new Map<string, PlaceCatalogEntry[]>();
  for (const entry of catalog) {
    for (const representationId of entry.representationIds) {
      const key = representationId.toLocaleLowerCase();
      const entries = entriesByRepresentation.get(key) ?? [];
      entries.push(entry);
      entriesByRepresentation.set(key, entries);
    }
  }

  const featuresByNation = new Map<string, Feature[]>();
  const entryByNation = new Map<string, PlaceCatalogEntry>();
  for (const feature of collectionFeatures) {
    const representationId = textProperty(feature.properties, 'LARNAME');
    if (!representationId) continue;
    for (const entry of
      entriesByRepresentation.get(representationId.toLocaleLowerCase()) ?? []) {
      const features = featuresByNation.get(entry.id) ?? [];
      features.push(feature);
      featuresByNation.set(entry.id, features);
      entryByNation.set(entry.id, entry);
    }
  }

  const features: Array<Feature<ArealGeometry, PlaceOverlapProperties>> = [];
  for (const [id, nationFeatures] of featuresByNation) {
    const entry = entryByNation.get(id);
    const geometry = mergeArealGeometry(nationFeatures);
    if (!entry || !geometry) continue;
    features.push({
      type: 'Feature',
      id: `tribe:${entry.id}`,
      properties: {
        placeKind: 'tribe',
        placeId: entry.id,
        placeLabel: entry.label
      },
      geometry
    });
  }
  return { type: 'FeatureCollection', features };
}

async function loadWatershedOverlapCandidates(
  bbox: readonly [number, number, number, number],
  signal: AbortSignal
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  const collections = await loadServiceEnvelopePieces(
    bbox,
    signal,
    (piece, siblingSignal) => loadWatershedCandidates(piece, siblingSignal)
  );
  const candidates = mergeByStableIdentifier(
    collections.map((collection) => collection.features),
    (feature) => feature.properties.watershedCode
  );
  const features: Array<Feature<ArealGeometry, PlaceOverlapProperties>> = [];
  for (const feature of candidates) {
    const normalized = normalizedFeature(
      feature,
      'watershed',
      feature.properties.watershedCode,
      feature.properties.watershedLabel
    );
    if (normalized) features.push(normalized);
  }
  return { type: 'FeatureCollection', features };
}

function overlapPairAvailable(
  selectionEntry: PlaceCatalogEntry,
  candidateKind: TypedPlaceKind,
  selectionBbox: readonly [number, number, number, number]
): boolean {
  const selectedCapability = coverageForEntry(selectionEntry)[
    'overlap-computable'
  ];
  const candidateCapability =
    PLACE_COVERAGE_MATRIX[candidateKind]['overlap-computable'];
  if (
    selectedCapability.state !== 'available' ||
    candidateCapability.state !== 'available'
  ) {
    return false;
  }
  if (
    (selectionEntry.kind === 'ecoregion' || candidateKind === 'ecoregion') &&
    !bboxIntersects(selectionBbox, PNW_BOUNDS)
  ) {
    return false;
  }
  return true;
}

async function loadCandidateKind(
  kind: TypedPlaceKind,
  bbox: readonly [number, number, number, number],
  signal: AbortSignal,
  selectionKind: TypedPlaceKind
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  switch (kind) {
    case 'tribe':
      return loadTribeCandidates(bbox, signal);
    case 'state':
      return loadStateCandidates(bbox, signal);
    case 'ecoregion': {
      const scopedBbox = bboxIntersection(bbox, PNW_BOUNDS);
      return scopedBbox
        ? loadEcoregionCandidates(scopedBbox, signal, selectionKind)
        : { type: 'FeatureCollection', features: [] };
    }
    case 'watershed':
      return loadWatershedOverlapCandidates(bbox, signal);
  }
}

async function loadOverlapView(
  entry: PlaceCatalogEntry,
  selected: ResolvedPlaceSelection,
  signal: AbortSignal
): Promise<OverlapViewState> {
  const availableKinds = PLACE_TYPE_ORDER.filter((kind) =>
    overlapPairAvailable(entry, kind, selected.bbox)
  );
  const unavailableKinds = PLACE_TYPE_ORDER.filter(
    (kind) => !availableKinds.includes(kind)
  );
  const loadedKinds = await Promise.all(
    availableKinds.map(async (kind) => {
      try {
        return {
          kind,
          // The whole extent for every kind: an ecoregion reaches past the PNW
          // strip (Central Basin and Range runs to 36.4 N); loadCandidateKind
          // scopes only the ecoregion catalog.
          candidates: await loadCandidateKind(kind, selected.bbox, signal, entry.kind)
        } as const;
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn(`[place-studio] ${kind} overlap candidates failed.`, err);
        return { kind, candidates: null } as const;
      }
    })
  );
  abortIfNeeded(signal);

  const rows: PlaceOverlapRow[] = [];
  const unavailableCandidates: UnavailableOverlapCandidate[] = [];
  let hasSuppressedSlivers = false;
  for (const loaded of loadedKinds) {
    if (!loaded.candidates) {
      unavailableKinds.push(loaded.kind);
      continue;
    }
    const candidates: FeatureCollection<ArealGeometry, PlaceOverlapProperties> = {
      type: 'FeatureCollection',
      features: loaded.candidates.features.filter(
        (candidate) =>
          !(
            candidate.properties.placeKind === entry.kind &&
            candidate.properties.placeId === entry.id
          )
      )
    };
    const result = computeOverlapRows(selected.geometry, candidates);
    if (result.rejections?.some((rejection) => rejection.source === 'selection')) {
      return {
        status: 'ready',
        rows: [],
        unavailableKinds: [],
        unavailableCandidates: [],
        selectionUnavailable: true,
        hasSuppressedSlivers: false
      };
    }
    for (const rejection of result.rejections ?? []) {
      if (rejection.source !== 'candidate') continue;
      const properties = rejection.candidate.properties;
      if (
        unavailableCandidates.some(
          (candidate) =>
            candidate.kind === properties.placeKind &&
            candidate.id === properties.placeId
        )
      ) {
        continue;
      }
      unavailableCandidates.push({
        kind: properties.placeKind,
        id: properties.placeId,
        label: properties.placeLabel
      });
    }
    hasSuppressedSlivers ||= result.hasSuppressedSlivers;
    for (const row of result.rows) {
      const properties = row.candidate.properties;
      rows.push({
        relationship: row.relationship,
        kind: properties.placeKind,
        id: properties.placeId,
        label: properties.placeLabel
      });
    }
  }
  rows.sort((first, second) => first.label.localeCompare(second.label));
  return {
    status: 'ready',
    rows,
    unavailableKinds: PLACE_TYPE_ORDER.filter((kind) =>
      unavailableKinds.includes(kind)
    ),
    unavailableCandidates,
    selectionUnavailable: false,
    hasSuppressedSlivers
  };
}

/**
 * Whether the durable typed place still names this catalog entry (C3
 * housekeeping, S30R I6: newest intent wins).
 */
function placeStillCurrent(entry: PlaceCatalogEntry): boolean {
  const place = getTypedPlace();
  return place !== null && place.kind === entry.kind && place.id === entry.id;
}

/**
 * The selected-exit briefing hand-off for an explicit selection the studio
 * has not resolved yet (wave A finding 2). It chases `pending`, the studio's
 * own resolution, when there is one; if that was aborted by the unmount
 * cleanup, or there is none yet, it resolves INDEPENDENTLY (bounded by the
 * fetch budget). It opens only while the durable typed place still names the
 * entry (newest intent wins); a chase that ends with no briefing unlights the
 * place, since the exit's own unlight stood down for it, unless a newer
 * emphasis took over.
 */
function chaseBriefingOnReturn(
  entry: PlaceCatalogEntry,
  pending: Promise<ResolvedPlaceSelection | null> | null
): () => void {
  return () => {
    const lit = getEmphasisTargets();
    const resolveIndependently = (): Promise<ResolvedPlaceSelection | null> =>
      resolvePlaceSelection(entry, new AbortController().signal);
    void (pending ? pending.catch(resolveIndependently) : resolveIndependently())
      .catch(() => null)
      .then((resolved) => {
        // A newer typed place owns the light now.
        if (!placeStillCurrent(entry)) return;
        if (resolved) openReturnBriefing(entry, resolved);
        // A map click on a land area relights without changing the typed place.
        else if (getEmphasisTargets() === lit) clearStudioEmphasis();
      })
      .catch(() => undefined);
  };
}

/** Set while the exit hand-off runs a briefing, so the exit unlights its place only when none follows. */
let briefingHandedBack = false;

/** Run the exit hand-off; with no briefing on it, nothing would ever unlight the place the studio lit. */
function runReturnHandoff(): void {
  briefingHandedBack = false;
  takePlaceReturn()?.();
  if (!briefingHandedBack) clearStudioEmphasis();
}

/** Queue the exit briefing (newest wins, as setPlaceReturnBriefing). */
function queueReturnBriefing(action: () => void): void {
  setPlaceReturnBriefing(() => {
    briefingHandedBack = true;
    action();
  });
}

/** The exit briefing; a Nation's boundary is drawn after the open, so the overlay records the Nation's selection. */
function openReturnBriefing(entry: PlaceCatalogEntry, resolved: ResolvedPlaceSelection): void {
  openImpactPanel(resolved.context);
  if (entry.kind === 'tribe') showStudioReturnBoundary(resolved.geometry);
}

/**
 * The exit for "Show on map": the chosen place framed and marked, and no
 * briefing (src/ui/island/place-on-map.ts, which is the one step that
 * touches the map; nothing in this file does). It rides the same exit
 * hand-off slot as the briefing, so it runs after the display is restored.
 */
function showReturnPlace(entry: PlaceCatalogEntry, resolved: ResolvedPlaceSelection): void {
  showPlaceOnMap(entry.kind, resolved.context, resolved.geometry, resolved.bbox);
}

/**
 * One place type's names-only catalog, loaded while the list wants it under
 * the same master-abort plus timeout contract as before (`loadPlaceCatalog`).
 * A failure is its own honest state for that type and never an empty list;
 * a new `attempt` is the retry.
 */
function useCatalog(kind: TypedPlaceKind, wanted: boolean, attempt: number): CatalogState {
  const [state, setState] = useState<CatalogState>(CATALOG_IDLE);
  useEffect(() => {
    if (!wanted) return;
    const masterAbort = new AbortController();
    setState((prior) => (prior.status === 'ready' ? prior : CATALOG_LOADING));
    void loadPlaceCatalog(kind, masterAbort.signal)
      .then((entries) => {
        if (masterAbort.signal.aborted) return;
        setState({ status: 'ready', entries });
      })
      .catch((err: unknown) => {
        if (masterAbort.signal.aborted) return;
        console.warn('[place-studio] catalog load failed.', err);
        setState(CATALOG_UNAVAILABLE);
      });
    return () => masterAbort.abort();
  }, [attempt, kind, wanted]);
  return state;
}

function PlaceStudio() {
  const initialSelection = getTypedPlace();
  const [kind, setKind] = useState<TypedPlaceKind>(
    initialSelection?.kind ?? 'tribe'
  );
  // The list's reach. A studio that reopens on a chosen place opens on that
  // place's type, so its row is in view; otherwise it opens on every type.
  const [scope, setScope] = useState<PlaceScope>(initialSelection?.kind ?? 'all');
  const [selection, setSelection] = useState<TypedPlaceRef | null>(initialSelection);
  const [selectionEntry, setSelectionEntry] = useState<PlaceCatalogEntry | null>(null);
  const [query, setQuery] = useState('');
  const [attempts, setAttempts] = useState(NO_ATTEMPTS);
  // A catalog loads while the list shows its type, the map shows its
  // reference layers (`kind`), or the chosen place belongs to it.
  const wants = (placeKind: TypedPlaceKind): boolean =>
    scope === 'all' || scope === placeKind || kind === placeKind || selection?.kind === placeKind;
  const catalogs: Readonly<Record<TypedPlaceKind, CatalogState>> = {
    tribe: useCatalog('tribe', wants('tribe'), attempts.tribe),
    state: useCatalog('state', wants('state'), attempts.state),
    ecoregion: useCatalog('ecoregion', wants('ecoregion'), attempts.ecoregion),
    watershed: useCatalog('watershed', wants('watershed'), attempts.watershed)
  };
  const retryCatalog = (placeKind: TypedPlaceKind): void =>
    setAttempts((prior) => ({ ...prior, [placeKind]: prior[placeKind] + 1 }));
  // The display kind's catalog, as the technical view and the selection read it.
  const entries = catalogs[kind].entries;
  const loading = catalogs[kind].status === 'loading' || catalogs[kind].status === 'idle';
  const unavailable = catalogs[kind].status === 'unavailable';
  const [boundary, setBoundary] = useState<BoundaryRead>('loading');
  const [boundaryAttempt, setBoundaryAttempt] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The list's one keyboard stop (a roving tab index), by place key.
  const [cursor, setCursor] = useState<string | null>(null);
  const [narrativeStatus, setNarrativeStatus] =
    useState<NarrativeStatus>('unavailable');
  const [narrativeKindLabel, setNarrativeKindLabel] = useState(
    initialSelection ? PLACE_CATALOG[initialSelection.kind].label : ''
  );
  const [narrativeLine, setNarrativeLine] = useState<string | null>(null);
  const [overlapView, setOverlapView] =
    useState<OverlapViewState>(EMPTY_OVERLAP_VIEW);
  const [backPending, setBackPending] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef(0);
  const explicitSelectionKeyRef = useRef<string | null>(null);
  const resolvedSelectionRef = useRef<{
    readonly key: string;
    readonly value: ResolvedPlaceSelection;
  } | null>(null);
  const selectionPromiseRef = useRef<{
    readonly key: string;
    readonly value: Promise<ResolvedPlaceSelection | null>;
  } | null>(null);
  const kindRef = useRef(kind);

  useEffect(() => {
    // A boundary an earlier "Show on map" left belongs to the map, not to this session.
    releaseShownPlace();
    beginPlaceStudioDisplay(kind);
    const releaseInertScope = applyStudioInertScope();
    backRef.current?.focus();

    return () => {
      restoreDisplaySnapshot();
      releaseInertScope();
      // Restore-then-brief (ruled ordering): the selected-exit briefing
      // hand-off runs only here, AFTER restoreDisplaySnapshot(), so it can
      // neither open before the restore nor be cancelled by the restore's
      // intent supersede (the former popstate microtask raced both ways).
      runReturnHandoff();
    };
  }, []);

  useEffect(() => {
    kindRef.current = kind;
    setPlaceStudioDisplayKind(kind);
    const selectionKey = selection ? `${selection.kind}:${selection.id}` : null;
    const resolved = resolvedSelectionRef.current;
    setStudioWatershedBoundary(
      kind === 'watershed' &&
        selection?.kind === 'watershed' &&
        resolved?.key === selectionKey
        ? resolved.value.geometry
        : null
    );
  }, [kind, selection]);

  useEffect(() => {
    // DDM-P2-T10 / DR-094: a matched Tribal Nation selection's emphasis is
    // driven from the geometry resolution effect below instead, which seeds
    // the emphasis cache from the SAME AIAN-LAR response (one request serves
    // both). Emphasizing here too, before that response lands, would open a
    // second, redundant AIAN-LAR request racing the first one. Every other
    // place kind (state, ecoregion, watershed), and a mismatched or null
    // tribe selection (nothing pending to defer to), still emphasizes here,
    // unchanged.
    const deferToTribeResolution =
      selection?.kind === 'tribe' &&
      selectionEntry?.kind === 'tribe' &&
      selection.id === selectionEntry.id;
    if (deferToTribeResolution) return;
    emphasizeTypedPlace(selection, selectionEntry);
  }, [selection, selectionEntry]);

  useEffect(
    () =>
      onTypedPlaceChange((place) => {
        setSelection(place);
        setSelectionEntry((entry) =>
          place && entry?.kind === place.kind && entry.id === place.id ? entry : null
        );
        if (place) {
          setKind(place.kind);
          // A narrowed list widens to the chosen place's type; "all" already holds it.
          setScope((reach) => (reach === 'all' || reach === place.kind ? reach : place.kind));
        } else {
          setDetailsOpen(false);
        }
      }),
    []
  );

  useEffect(() => {
    if (!selection || selection.kind !== kind) return;
    const entry = entries.find(
      (candidate) => candidate.kind === selection.kind && candidate.id === selection.id
    );
    if (entry) setSelectionEntry(entry);
  }, [entries, kind, selection]);

  useEffect(() => {
    setPlaceReturnBriefing(null);
    setStudioWatershedBoundary(null);
    resolvedSelectionRef.current = null;
    selectionPromiseRef.current = null;
    setNarrativeKindLabel(
      selection ? PLACE_CATALOG[selection.kind].label : ''
    );
    setNarrativeLine(null);
    setNarrativeStatus(selectionEntry ? 'loading' : 'unavailable');
    setBoundary('loading');
    setOverlapView(
      selectionEntry
        ? EMPTY_OVERLAP_VIEW
        : {
            status: 'ready',
            rows: [],
            unavailableKinds: [],
            unavailableCandidates: [],
            selectionUnavailable: false,
            hasSuppressedSlivers: false
          }
    );

    if (
      !selection ||
      !selectionEntry ||
      selection.kind !== selectionEntry.kind ||
      selection.id !== selectionEntry.id
    ) {
      return;
    }

    const selectionKey = `${selection.kind}:${selection.id}`;
    const coverage = coverageForEntry(selectionEntry);
    if (
      coverage.briefable.state !== 'available' &&
      coverage['overlap-computable'].state !== 'available'
    ) {
      setNarrativeStatus('unavailable');
      setBoundary('unmatched');
      setOverlapView({
        status: 'ready',
        rows: [],
        unavailableKinds: PLACE_TYPE_ORDER,
        unavailableCandidates: [],
        selectionUnavailable: false,
        hasSuppressedSlivers: false
      });
      return;
    }

    const masterAbort = new AbortController();
    const promise = resolvePlaceSelection(selectionEntry, masterAbort.signal);
    selectionPromiseRef.current = { key: selectionKey, value: promise };

    // C3 housekeeping, S30R I6: newest intent wins. The abort flag alone is
    // checked only when the cleanup has already run; a completion that lands
    // between a newer durable typed place and this effect's deferred cleanup
    // needs this predicate too, so it is hoisted once and reused at every
    // site below that would otherwise apply a stale selection's emphasis.
    const selectionStillCurrent = (): boolean => placeStillCurrent(selectionEntry);

    // Wave A finding 2: register the return hand-off at resolution START,
    // not completion, so an immediate browser Back (which bypasses
    // handleBack's await) still delivers the promised briefing. The action
    // chases the pending resolution; if the studio's own resolution was
    // aborted by the unmount cleanup, it re-resolves INDEPENDENTLY
    // (bounded by the fetch budget) rather than pinning the studio's
    // aborted chain, and it opens only while the durable typed place
    // still matches (newest intent wins). Once resolution completes
    // in-studio, the direct registration below replaces this one. The
    // option's click registered an equivalent action already (FE-23); this
    // one replaces it so the hand-off shares the studio's own request.
    if (
      explicitSelectionKeyRef.current === selectionKey &&
      coverage.briefable.state === 'available'
    ) {
      queueReturnBriefing(chaseBriefingOnReturn(selectionEntry, promise));
    }

    void promise
      .then((resolved) => {
        if (masterAbort.signal.aborted) return;
        if (!resolved) {
          // DDM-P2-T10: a tribe selection deferred its emphasis to this
          // resolution (the effect above); nothing resolved (no geometry, or
          // a geometry-less Nation), so emphasize now to clear any prior
          // subject's highlight rather than leaving it stale.
          // C3 housekeeping, S30R I6: newest intent wins, the abort flag
          // alone is checked only when the cleanup has already run.
          if (selectionEntry.kind === 'tribe' && selectionStillCurrent()) {
            emphasizeTypedPlace(selection, selectionEntry);
          }
          setNarrativeStatus('unavailable');
          setBoundary('empty');
          setOverlapView({
            status: 'ready',
            rows: [],
            unavailableKinds: PLACE_TYPE_ORDER,
            unavailableCandidates: [],
            selectionUnavailable: false,
            hasSuppressedSlivers: false
          });
          return;
        }

        resolvedSelectionRef.current = { key: selectionKey, value: resolved };
        setBoundary('ready');
        if (selectionEntry.kind === 'tribe' && selectionStillCurrent()) {
          // The emphasis cache is warm here: resolveTribeSelection seeded it
          // from this SAME response before resolving, so this call reads the
          // cache rather than opening a second AIAN-LAR request.
          // C3 housekeeping, S30R I6: newest intent wins, the abort flag
          // alone is checked only when the cleanup has already run.
          emphasizeTypedPlace(selection, selectionEntry);
        }
        if (
          selectionEntry.kind === 'watershed' &&
          kindRef.current === 'watershed'
        ) {
          setStudioWatershedBoundary(resolved.geometry);
        }
        if (
          explicitSelectionKeyRef.current === selectionKey &&
          coverage.briefable.state === 'available'
        ) {
          queueReturnBriefing(() => openReturnBriefing(selectionEntry, resolved));
        }

        if (coverage.briefable.state === 'available') {
          // The line reads only point heat and the USDM claim, so fetch those
          // two under the briefing's own source policy, not the whole briefing.
          const briefing = createBriefingSkeleton(resolved.context);
          const { context } = resolved;
          const { signal } = masterAbort;
          setNarrativeKindLabel(briefing.landKind);
          const publish = (): void => {
            if (signal.aborted) return;
            const line = selectBriefNarrativeLine(briefing);
            if (line) {
              setNarrativeLine(line);
              setNarrativeStatus('ready');
            }
          };
          const warn = (err: unknown): void => {
            if (!signal.aborted) console.warn('[place-studio] brief narrative failed.', err);
          };
          const heat = sourceMayRun(briefing.sourcePolicy, 'pointHeat')
            ? import('../../impact/point-heat')
                .then(({ fetchPointHeat }) =>
                  fetchPointHeat(context, createNwsRequestSession(signal))
                )
                .then((result) => {
                  briefing.pointHeat = result;
                  publish();
                })
                .catch(warn)
            : Promise.resolve();
          const drought =
            briefing.sourcePolicy.droughtImpact.enabled &&
            sourceMayRun(briefing.sourcePolicy, 'usdm')
              ? fetchUsdmClaims(context, signal)
                  .then((result) => {
                    applyMatrix(briefing.horizons, new Map([['usdm', result]]));
                    publish();
                  })
                  .catch(warn)
              : Promise.resolve();
          void Promise.all([heat, drought]).then(() => {
            if (!signal.aborted && !selectBriefNarrativeLine(briefing)) {
              setNarrativeStatus('unavailable');
            }
          });
        } else {
          setNarrativeStatus('unavailable');
        }

        if (coverage['overlap-computable'].state === 'available') {
          void loadOverlapView(selectionEntry, resolved, masterAbort.signal)
            .then((view) => {
              if (!masterAbort.signal.aborted) setOverlapView(view);
            })
            .catch((err: unknown) => {
              if (!masterAbort.signal.aborted) {
                console.warn('[place-studio] overlap listing failed.', err);
                setOverlapView({
                  status: 'ready',
                  rows: [],
                  unavailableKinds: PLACE_TYPE_ORDER,
                  unavailableCandidates: [],
                  selectionUnavailable: false,
                  hasSuppressedSlivers: false
                });
              }
            });
        } else {
          setOverlapView({
            status: 'ready',
            rows: [],
            unavailableKinds: PLACE_TYPE_ORDER,
            unavailableCandidates: [],
            selectionUnavailable: false,
            hasSuppressedSlivers: false
          });
        }
      })
      .catch((err: unknown) => {
        if (!masterAbort.signal.aborted) {
          console.warn('[place-studio] selected place geometry failed.', err);
          // DDM-P2-T10: the deferred tribe emphasis falls back to
          // display-snapshot's own (unseeded) resolution here, honestly
          // attempting the live query rather than leaving a stale highlight.
          if (selectionEntry.kind === 'tribe' && selectionStillCurrent()) {
            emphasizeTypedPlace(selection, selectionEntry);
          }
          setNarrativeStatus('unavailable');
          setBoundary('unreachable');
          setOverlapView({
            status: 'ready',
            rows: [],
            unavailableKinds: PLACE_TYPE_ORDER,
            unavailableCandidates: [],
            selectionUnavailable: false,
            hasSuppressedSlivers: false
          });
        }
      });

    return () => {
      masterAbort.abort();
      if (selectionEntry.kind === 'watershed') {
        setStudioWatershedBoundary(null);
      }
    };
    // `boundaryAttempt` is the selection bar's retry: the same read, asked again.
  }, [selection, selectionEntry, boundaryAttempt]);

  const handleBack = async (): Promise<void> => {
    if (backPending) return;
    const selectionKey = selection ? `${selection.kind}:${selection.id}` : null;
    if (
      selectionKey &&
      explicitSelectionKeyRef.current === selectionKey &&
      selectionPromiseRef.current?.key === selectionKey &&
      resolvedSelectionRef.current?.key !== selectionKey
    ) {
      setBackPending(true);
      try {
        await selectionPromiseRef.current.value;
      } catch {
        // The selected capability remains unavailable when its fetch failed.
      }
      // Browser Back during the wait already left the studio; a second back would leave the site.
      if (getStudioRoute() !== 'place') return;
    }
    backToMap();
  };

  const definition = PLACE_CATALOG[kind];
  const selectionKey = selection ? `${selection.kind}:${selection.id}` : null;

  // ONE SEARCH ACROSS PLACE TYPES. The shared search's fold on both sides
  // (wave A finding 1): the roster's formal Tribal Nation names carry hyphens
  // and apostrophes, and this surface must match punctuation-free typing
  // exactly like the shared search does ("Absentee Shawnee" finds
  // "Absentee-Shawnee Tribe of Indians of Oklahoma"). Its token rule and its
  // one rank too: every token in the folded text, labels that start with the
  // query first, and no confidence score.
  const foldedQuery = foldSearchText(query);
  const queryTokens = foldedQuery.split(' ').filter((token) => token.length > 0);
  const scopeKinds = scope === 'all' ? PLACE_TYPE_ORDER : [scope];
  const groups = scopeKinds.map((placeKind) => {
    const catalog = catalogs[placeKind];
    const all = rowsOf(catalog.entries);
    const rows =
      queryTokens.length === 0
        ? all
        : prefixFirst(
            all.filter((row) => matchesTokens(row.haystack, queryTokens, false)),
            foldedQuery
          );
    return { kind: placeKind, status: catalog.status, total: all.length, rows };
  });
  const listed = groups.filter((group) => group.status === 'ready' && group.rows.length > 0);
  const pending = groups.filter((group) => group.status === 'loading' || group.status === 'idle');
  const failed = groups.filter((group) => group.status === 'unavailable');
  const shownRows = listed.flatMap((group) => group.rows);
  // What a match count is "of": every place the search looked through, in
  // the types that loaded, whether or not a type had a match.
  const searchedTotal = groups.reduce(
    (sum, group) => sum + (group.status === 'ready' ? group.total : 0),
    0
  );
  // With nothing to list, one honest line says why: still loading, not
  // available (with a retry), nothing listed for the type, or no match.
  const listStatus: 'loading' | 'unavailable' | 'none' | 'no-match' | null =
    listed.length > 0
      ? null
      : pending.length > 0
        ? 'loading'
        : failed.length === groups.length
          ? 'unavailable'
          : queryTokens.length === 0
            ? 'none'
            : 'no-match';
  const summary =
    listed.length === 0
      ? ''
      : queryTokens.length === 0
        ? `${shownRows.length.toLocaleString('en-US')} ${shownRows.length === 1 ? 'place' : 'places'}`
        : `${shownRows.length.toLocaleString('en-US')} of ${searchedTotal.toLocaleString('en-US')} ${shownRows.length === 1 ? 'place matches' : 'places match'}`;

  // The list is one keyboard stop: the row the arrows last reached, else the
  // chosen row, else the first row.
  const shownKeys = new Set(shownRows.map((row) => `${row.entry.kind}:${row.entry.id}`));
  const firstRow = shownRows[0];
  const tabStop =
    cursor !== null && shownKeys.has(cursor)
      ? cursor
      : selectionKey !== null && shownKeys.has(selectionKey)
        ? selectionKey
        : firstRow
          ? `${firstRow.entry.kind}:${firstRow.entry.id}`
          : null;

  const coverage = runtimeCoverage(
    kind,
    selection,
    selectionEntry,
    loading,
    unavailable
  );

  /** Choose a place: the row's press, and Enter on an unambiguous search. */
  const choose = (entry: PlaceCatalogEntry): void => {
    const chosenKey = `${entry.kind}:${entry.id}`;
    explicitSelectionKeyRef.current = chosenKey;
    setPlaceReturnBriefing(null);
    const resolved = resolvedSelectionRef.current;
    if (coverageForEntry(entry).briefable.state === 'available') {
      // FE-23: register the hand-off in the click's
      // own task. The selection effect that would
      // otherwise register it runs after the next
      // frame, and Preact drops it if a browser Back
      // unmounts the studio first (a slow device), so
      // the briefing was lost. The effect replaces
      // this action with its own once it runs.
      if (resolved?.key === chosenKey) {
        queueReturnBriefing(() => openReturnBriefing(entry, resolved.value));
      } else {
        queueReturnBriefing(chaseBriefingOnReturn(entry, null));
      }
    }
    setCursor(chosenKey);
    setSelectionEntry(entry);
    setTypedPlace(typedPlaceRef(entry));
  };

  const focusOption = (key: string | null): void => {
    if (key === null) return;
    const [optionKind, ...rest] = key.split(':');
    const option = Array.from(
      scrollRef.current?.querySelectorAll<HTMLButtonElement>('.place-studio-option') ?? []
    ).find(
      (button) =>
        button.dataset['placeKind'] === optionKind && button.dataset['placeId'] === rest.join(':')
    );
    option?.focus();
  };

  // The shared search's keys: Escape clears a typed query before it can
  // close the studio, the down arrow enters the list, and Enter opens only an
  // unambiguous match (`enterChoice`); otherwise it moves to the first row,
  // so a second Enter chooses what the person can see.
  const onSearchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
    } else if (event.key === 'ArrowDown') {
      if (tabStop === null) return;
      event.preventDefault();
      focusOption(tabStop);
    } else if (event.key === 'Enter') {
      if (shownRows.length === 0) return;
      event.preventDefault();
      const chosen =
        queryTokens.length === 0
          ? undefined
          : enterChoice(
              shownRows.map((row) => ({
                label: row.label,
                id: row.entry.id,
                // `enterChoice` names a state row 'place'.
                kind: row.entry.kind === 'state' ? 'place' : row.entry.kind,
                entry: row.entry
              })),
              foldedQuery
            );
      if (chosen) choose(chosen.entry);
      else focusOption(firstRow ? `${firstRow.entry.kind}:${firstRow.entry.id}` : null);
    }
  };

  // Arrow keys walk the list as one widget; Tab leaves it for the selection
  // bar. With no bar the list is the studio's last stop, and the rows the
  // arrows have not reached are out of the tab order, so Tab wraps to the
  // first stop here: focus never leaves the studio for the page behind it.
  const onListKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      if (event.shiftKey) return;
      const row = event.currentTarget as HTMLElement;
      const stops = Array.from(
        row
          .closest('.place-studio')
          ?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]'
          ) ?? []
      ).filter((stop) => stop.tabIndex >= 0 && stop.offsetParent !== null);
      const later = stops.some(
        (stop) => (row.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
      if (!later) {
        event.preventDefault();
        stops[0]?.focus();
      }
      return;
    }
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? -Infinity : event.key === 'End' ? Infinity : 0;
    if (step === 0) return;
    const options = Array.from(
      scrollRef.current?.querySelectorAll<HTMLButtonElement>('.place-studio-option') ?? []
    );
    const at = options.indexOf(event.currentTarget as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = options[Math.min(Math.max(at + step, 0), options.length - 1)];
    if (!next) return;
    setCursor(`${next.dataset['placeKind'] ?? ''}:${next.dataset['placeId'] ?? ''}`);
    next.focus();
  };

  // WHAT THE BAR CAN SAY AND DO. `selectionEntry` is null while the chosen
  // place's own list is still loading (a studio reopened on a durable place),
  // when that list could not load, and for a place picked on the map that the
  // list does not hold (a territory, say). The bar says which of the three,
  // and offers the retry only where a retry can help.
  const selectionCatalog = selection ? catalogs[selection.kind] : CATALOG_IDLE;
  const entryPending = selection !== null && selectionEntry === null;
  const entryUnavailable = entryPending && selectionCatalog.status === 'unavailable';
  const entryMissing =
    entryPending &&
    selectionCatalog.status === 'ready' &&
    !selectionCatalog.entries.some((candidate) => candidate.id === selection?.id);
  const read: BoundaryRead = entryPending
    ? entryUnavailable
      ? 'unreachable'
      : entryMissing
        ? 'unmatched'
        : 'loading'
    : boundary;
  const canAct = !entryPending && (read === 'loading' || read === 'ready');
  const canRetry = read === 'unreachable' || read === 'empty';
  const stateSentence =
    selection === null
      ? ''
      : entryUnavailable
        ? 'The list this place belongs to is not available right now, so a briefing is not available yet.'
        : entryMissing
          ? 'This place is not in the lists this screen can brief from, so a briefing is not available here.'
          : entryPending
            ? 'Reading the list this place belongs to...'
            : boundarySentence(selection.kind, read);

  const retryRead = (): void => {
    if (!selection) return;
    if (entryPending) retryCatalog(selection.kind);
    else setBoundaryAttempt((attempt) => attempt + 1);
  };

  /**
   * Leave the studio with the chosen place: its briefing, or the map alone.
   * The exit is the same one step Back takes, and the hand-off rides the
   * slot the selection already uses, so it runs after the display is
   * restored. While the boundary read is still in flight the exit waits for
   * it, as Back does; if the read then fails, the studio stays and the bar
   * says so. A place the bar finds chosen from an earlier session is
   * registered here, as its own row press would have.
   */
  const leaveWith = async (view: 'briefing' | 'map'): Promise<void> => {
    if (backPending || !selectionEntry || selectionKey === null) return;
    const entry = selectionEntry;
    const hand = view === 'map' ? showReturnPlace : openReturnBriefing;
    explicitSelectionKeyRef.current = selectionKey;
    const resolved = resolvedSelectionRef.current;
    if (resolved?.key === selectionKey) {
      queueReturnBriefing(() => hand(entry, resolved.value));
      backToMap();
      return;
    }
    const inFlight = selectionPromiseRef.current;
    if (inFlight?.key !== selectionKey) return;
    // Until the read lands the standing hand-off covers a browser Back: the briefing.
    queueReturnBriefing(chaseBriefingOnReturn(entry, inFlight.value));
    setBackPending(true);
    let landed: ResolvedPlaceSelection | null = null;
    try {
      landed = await inFlight.value;
    } catch {
      // The bar already states the failed read.
    }
    // Browser Back during the wait already left the studio; a second back would leave the site.
    if (getStudioRoute() !== 'place') return;
    if (!landed) {
      setBackPending(false);
      return;
    }
    const value = landed;
    queueReturnBriefing(() => hand(entry, value));
    backToMap();
  };

  /** Drop the choice: the durable place's explicit clear, so Back hands nothing to the map. */
  const clearChoice = (): void => {
    explicitSelectionKeyRef.current = null;
    setPlaceReturnBriefing(null);
    setDetailsOpen(false);
    setTypedPlace(null);
  };

  // The technical view is one press away. In a single column it takes the
  // list's place and gives it back, scroll position included.
  const toggleDetails = (): void => {
    const scroller = scrollRef.current;
    if (!detailsOpen) listScrollRef.current = scroller?.scrollTop ?? 0;
    const restore = detailsOpen ? listScrollRef.current : 0;
    setDetailsOpen(!detailsOpen);
    requestAnimationFrame(() => scroller?.scrollTo({ top: restore }));
  };

  // The page's own height, published for the stylesheet: in two columns the
  // technical view stays beside the list while the list scrolls, and it may
  // be no taller than the page it stands in.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return;
    const publish = (): void => {
      scroller.style.setProperty('--place-page-h', `${scroller.clientHeight}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(scroller);
    publish();
    return () => observer.disconnect();
  }, []);

  // A chosen row stays in view when the bar rises and takes its strip of the page.
  useEffect(() => {
    if (selectionKey === null) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>('.place-studio-option[aria-pressed="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectionKey]);

  return (
    <section
      class="layers-studio place-studio"
      aria-labelledby="place-studio-heading"
      data-place-details={detailsOpen ? 'open' : 'closed'}
      data-place-chosen={selection ? 'true' : 'false'}
    >
      <header class="layers-studio-header place-studio-header">
        <button
          ref={backRef}
          id="place-studio-back"
          type="button"
          class="layers-studio-back"
          disabled={backPending}
          onClick={() => void handleBack()}
        >
          Back to map
        </button>
        <h2 id="place-studio-heading">Place studio</h2>
        <div />
      </header>

      <div class="layers-studio-scroll place-studio-scroll" ref={scrollRef}>
        <div class="place-studio-layout">
          <section
            id="place-list-panel"
            class="place-studio-list-panel"
            aria-labelledby={`place-type-${scope}`}
            aria-busy={pending.length > 0 ? 'true' : 'false'}
          >
            <label class="place-studio-search" for="place-studio-search">
              <span class="sr-only">Search places</span>
              {/* The field is named for assistive technology and says what
                  typing does for everyone else; the placeholder is a hint,
                  never the accessible name. */}
              <input
                id="place-studio-search"
                type="search"
                value={query}
                aria-label="Search places"
                aria-controls="place-list-panel"
                placeholder="Search places"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                enterkeyhint="search"
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={onSearchKeyDown}
              />
            </label>

            <nav class="place-studio-type-rail" aria-label="Place type">
              <button
                id="place-type-all"
                type="button"
                class="place-studio-type"
                aria-pressed={scope === 'all'}
                aria-controls="place-list-panel"
                onClick={() => setScope('all')}
              >
                All
              </button>
              {PLACE_TYPE_ORDER.map((placeKind) => (
                <button
                  key={placeKind}
                  id={`place-type-${placeKind}`}
                  type="button"
                  class="place-studio-type"
                  aria-pressed={scope === placeKind}
                  aria-controls="place-list-panel"
                  onClick={() => {
                    setScope(placeKind);
                    setKind(placeKind);
                  }}
                >
                  {PLACE_CATALOG[placeKind].label}
                </button>
              ))}
            </nav>

            {!selection ? (
              <p class="place-studio-lead">
                Choose a place to open its briefing or show it on the map.
              </p>
            ) : null}

            <p id="place-list-summary" class="place-studio-summary" aria-live="polite">
              {summary}
            </p>

            {/* In the all-types list a type that is still loading or could
                not load says so here, above the rows, never as an empty group. */}
            {listed.length > 0 && (pending.length > 0 || failed.length > 0) ? (
              <ul class="place-studio-type-notes">
                {pending.map((group) => (
                  <li key={group.kind} data-place-note={group.kind}>
                    Loading {PLACE_CATALOG[group.kind].label}...
                  </li>
                ))}
                {failed.map((group) => (
                  <li key={group.kind} data-place-note={group.kind}>
                    <span>{PLACE_CATALOG[group.kind].label} are not available right now.</span>
                    {/* Its own class only: `.layers-studio-back` in this root is the header's Back and the one-list failure's retry. */}
                    <button
                      type="button"
                      class="place-studio-retry"
                      aria-label={`Try ${PLACE_CATALOG[group.kind].label} again`}
                      onClick={() => retryCatalog(group.kind)}
                    >
                      Try again
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {listStatus === 'loading' ? (
              <p id="place-list-status" class="place-studio-list-status" role="status">
                Loading places...
              </p>
            ) : listStatus === 'unavailable' ? (
              <div class="place-studio-list-failure">
                <p id="place-list-status" class="place-studio-list-status" role="status">
                  This list is not available right now.
                </p>
                <button
                  type="button"
                  class="layers-studio-back place-studio-retry"
                  onClick={() => {
                    for (const group of failed) retryCatalog(group.kind);
                  }}
                >
                  Try again
                </button>
              </div>
            ) : listStatus !== null ? (
              <p id="place-list-status" class="place-studio-list-status" role="status">
                {listStatus === 'none'
                  ? 'No places are listed for this type yet.'
                  : 'No places match this search.'}
              </p>
            ) : (
              <div id="place-list" class="place-studio-list">
                {listed.map((group) => (
                  <section
                    key={group.kind}
                    class="place-studio-group"
                    data-place-group={group.kind}
                    aria-labelledby={`place-group-${group.kind}`}
                  >
                    <h3 class="place-studio-group-head" id={`place-group-${group.kind}`}>
                      <span>{PLACE_CATALOG[group.kind].label}</span>
                      <span class="place-studio-group-count">
                        {group.rows.length === group.total
                          ? group.total.toLocaleString('en-US')
                          : `${group.rows.length.toLocaleString('en-US')} of ${group.total.toLocaleString('en-US')}`}
                      </span>
                    </h3>
                    <ul>
                      {group.rows.map(({ entry }, index) => {
                        const rowKey = `${entry.kind}:${entry.id}`;
                        const selected = rowKey === selectionKey;
                        return (
                          <li key={`${rowKey}:${entry.detail ?? ''}`}>
                            <button
                              id={`place-option-${entry.kind}-${index}`}
                              type="button"
                              class={`place-studio-option${selected ? ' selected' : ''}`}
                              data-place-kind={entry.kind}
                              data-place-id={entry.id}
                              aria-pressed={selected}
                              tabIndex={rowKey === tabStop ? 0 : -1}
                              onFocus={() => {
                                // The row that holds focus is the list's stop.
                                if (rowKey !== tabStop) setCursor(rowKey);
                              }}
                              onKeyDown={onListKeyDown}
                              onClick={() => choose(entry)}
                            >
                              <span class="place-studio-option-text">
                                <span class="place-studio-option-name">{entry.label}</span>
                                <span class="place-studio-option-kind">
                                  {kindWords(entry.kind, entry.detail)}
                                </span>
                              </span>
                              <span class="place-studio-option-mark" aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </section>

          <aside
            id="place-selection-panel"
            class="place-studio-selection-panel"
            aria-labelledby="place-selection-panel-heading"
          >
            <h3 id="place-selection-panel-heading">About this place</h3>
            {!selection ? (
              <p id="place-selection-empty">
                No place is chosen yet. Choose one from the list to open its briefing or show it
                on the map.
              </p>
            ) : (
              <div id="place-selection-current">
                <section id="place-brief-narrative">
                  <h5>Current read</h5>
                  <p class="place-studio-selection-kind">
                    {narrativeKindLabel}
                  </p>
                  <p id="place-brief-line" role="status">
                    {narrativeStatus === 'ready'
                      ? narrativeLine
                      : narrativeStatus}
                  </p>
                </section>
                <section id="place-overlap-columns">
                  <h5>Overlapping places</h5>
                  {overlapView.status === 'loading' ? (
                    <p id="place-overlap-status" role="status">
                      loading
                    </p>
                  ) : overlapView.selectionUnavailable ? (
                    <p id="place-overlap-status" role="status">
                      {UNAVAILABLE_OVERLAP_PAIR}
                    </p>
                  ) : (
                    <>
                      <div class="place-overlap-grid">
                        {OVERLAP_COLUMN_ORDER.map((relationship) => {
                          const rows = overlapView.rows.filter(
                            (row) => row.relationship === relationship
                          );
                          return (
                            <section
                              key={relationship}
                              class="place-overlap-column"
                              aria-labelledby={`place-overlap-${relationship}`}
                            >
                              <h6 id={`place-overlap-${relationship}`}>
                                {OVERLAP_COLUMN_LABEL[relationship]}
                              </h6>
                              <ul>
                                {rows.map((row) => (
                                  <li
                                    key={`${row.kind}:${row.id}:${row.relationship}`}
                                    data-overlap-kind={row.kind}
                                    data-overlap-id={row.id}
                                  >
                                    <span>{row.label}</span>
                                    <small>{PLACE_CATALOG[row.kind].label}</small>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          );
                        })}
                      </div>
                      {/* D13: the Tribal Nations rows' public sources and the
                          representation note, once for the group, not per row. */}
                      {overlapView.rows.some((row) => row.kind === 'tribe') ? (
                        <div id="place-overlap-tribal-note">
                          {/* One class for both: the stylesheet's existing small-print rule. */}
                          <p id="place-overlap-tribal-source" class="place-overlap-tribal-caveat">
                            {TRIBAL_OVERLAP_SOURCE}
                          </p>
                          <p id="place-overlap-tribal-representation" class="place-overlap-tribal-caveat">
                            {TRIBAL_OVERLAP_CAVEAT}
                          </p>
                        </div>
                      ) : null}
                      {overlapView.rows.length === 0 &&
                      overlapView.unavailableKinds.length < PLACE_TYPE_ORDER.length ? (
                        <p id="place-overlap-empty">{EMPTY_OVERLAP_RESULT}</p>
                      ) : null}
                      {overlapView.hasSuppressedSlivers ? (
                        <p id="place-overlap-suppression">
                          {EDGE_OVERLAPS_OMITTED}
                        </p>
                      ) : null}
                      {overlapView.unavailableKinds.length > 0 ||
                      overlapView.unavailableCandidates.length > 0 ? (
                        <ul class="place-overlap-unavailable">
                          {overlapView.unavailableKinds.map((unavailableKind) => (
                            <li
                              key={unavailableKind}
                              data-overlap-unavailable-kind={unavailableKind}
                            >
                              <span>{PLACE_CATALOG[unavailableKind].label}</span>
                              <p>{UNAVAILABLE_OVERLAP_PAIR}</p>
                            </li>
                          ))}
                          {overlapView.unavailableCandidates.map((candidate) => (
                            <li
                              key={`candidate:${candidate.kind}:${candidate.id}`}
                              data-overlap-rejected-candidate=""
                              data-overlap-kind={candidate.kind}
                              data-overlap-id={candidate.id}
                            >
                              <span>{candidate.label}</span>
                              <p>{UNAVAILABLE_OVERLAP_PAIR}</p>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </section>
              </div>
            )}
            <section class="place-studio-technical" aria-labelledby="place-technical-heading">
              <h5 id="place-technical-heading">What this list can do</h5>
              <div class="place-studio-type-status">
                <span class="place-studio-type-name">{definition.label}</span>
                <strong id="place-type-availability">
                  {unavailable ? 'unavailable' : definition.availability}
                </strong>
                {definition.coverage ? (
                  <span id="place-type-coverage">{definition.coverage}</span>
                ) : null}
              </div>
            <dl id="place-coverage-matrix" class="place-studio-coverage-matrix">
              {CAPABILITY_ORDER.map((capability) => (
                <div key={capability}>
                  <dt>{CAPABILITY_LABEL[capability]}</dt>
                  <dd id={`place-capability-${capability}`}>
                    <span>{coverage[capability].state}</span>
                    {coverage[capability].scope ? (
                      <small>{coverage[capability].scope}</small>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
            </section>
          </aside>
        </div>
      </div>

      {selection ? (
        <section
          id="place-selection-bar"
          class="place-studio-bar"
          aria-label="Chosen place"
          data-boundary={read}
        >
          <div class="place-studio-bar-id">
            <p id="place-selection-kind" class="place-studio-bar-kind">
              {kindWords(selection.kind, selectionEntry?.detail ?? null)}
            </p>
            {/* The gated formal name, whole: a Nation's name is never abbreviated. */}
            <h3 id="place-selection-title" class="place-studio-bar-name">
              {selection.label}
            </h3>
          </div>
          <button
            id="place-selection-clear"
            type="button"
            class="place-studio-bar-clear"
            aria-label="Clear this choice"
            onClick={clearChoice}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" />
            </svg>
          </button>
          <div class="place-studio-bar-notes">
            <p id="place-selection-state" class="place-studio-bar-state" role="status">
              {stateSentence}
            </p>
            {selection.kind === 'tribe' ? (
              <>
                {read === 'loading' || read === 'ready' ? (
                  <p id="place-selection-live-read" class="place-studio-bar-note">
                    {TRIBAL_LIVE_READ_NOTE}
                  </p>
                ) : null}
                {/* The representation caveat rides every Tribal Nation
                    selection that has a boundary representation, whole and in
                    view: never dropped, never folded. A Nation with no matched
                    boundary has no representation to qualify, and says that. */}
                {read === 'unmatched' ? null : (
                  <p id="place-selection-caveat" class="place-studio-bar-caveat">
                    {TRIBAL_OVERLAP_CAVEAT}
                  </p>
                )}
              </>
            ) : null}
          </div>
          <div class="place-studio-bar-actions">
            {canAct ? (
              <>
                <button
                  id="place-open-briefing"
                  type="button"
                  class="place-studio-action"
                  disabled={backPending}
                  onClick={() => void leaveWith('briefing')}
                >
                  Open briefing
                </button>
                <button
                  id="place-show-on-map"
                  type="button"
                  class="place-studio-action"
                  disabled={backPending}
                  onClick={() => void leaveWith('map')}
                >
                  Show on map
                </button>
              </>
            ) : canRetry ? (
              <button
                id="place-selection-retry"
                type="button"
                class="place-studio-action"
                onClick={retryRead}
              >
                Try again
              </button>
            ) : null}
            <button
              id="place-details-toggle"
              type="button"
              class="place-studio-details-toggle"
              aria-expanded={detailsOpen}
              aria-controls="place-selection-panel"
              onClick={toggleDetails}
            >
              Details
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

export function mountPlaceStudio(root: HTMLElement): void {
  render(<PlaceStudio />, root);
}

export function unmountPlaceStudio(root: HTMLElement): void {
  render(null, root);
}
