import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Polygon
} from 'geojson';

import {
  PLACE_CATALOG,
  PLACE_COVERAGE_MATRIX,
  PLACE_TYPE_ORDER,
  coverageForEntry,
  loadPlaceCatalog,
  typedPlaceRef
} from '../../config/place-catalog';
import { regionCapabilityLevel } from '../../config/region-capability';
import type {
  PlaceCapabilityKey,
  PlaceCatalogEntry
} from '../../config/place-catalog';
import { URLS } from '../../config/urls';
import { createBriefingSkeleton } from '../../impact/briefing';
import { selectBriefNarrativeLine } from '../../impact/brief-narrative-selector';
import { buildBoundaryContext, caveatFor } from '../../impact/context';
import {
  bboxCenter,
  bboxIntersection,
  bboxIntersects,
  loadServiceEnvelopePieces,
  mergeByStableIdentifier
} from '../../util/bbox';
import { geometryBboxAcrossAntimeridian } from '../../util/antimeridian';
import { hydrateBriefing } from '../../impact/hydrate';
import { computeOverlapRows } from '../../impact/overlap-engine';
import type { OverlapRelationship } from '../../impact/overlap-engine';
import type { BoundaryKind, BoundarySelectionContext } from '../../impact/types';
import {
  getTypedPlace,
  onTypedPlaceChange,
  setTypedPlace
} from '../../state/typed-place';
import type { TypedPlaceKind, TypedPlaceRef } from '../../state/typed-place';
import {
  beginPlaceStudioDisplay,
  emphasizeTypedPlace,
  restoreDisplaySnapshot,
  setPlaceStudioDisplayKind,
  setStudioWatershedBoundary
} from '../../state/display-snapshot';
import { getMap } from '../../state/map-store';
import {
  backToMap,
  setPlaceStudioReturnAction,
  takePlaceStudioReturnAction
} from '../../state/studio-route';
import {
  loadWatershedCandidates,
  loadWatershedSelectionGeometry
} from '../../state/watershed-geometry';
import { fetchJsonWithBudget } from '../../util/fetch';
import { foldSearchText } from '../../util/search-fold';
import { openImpactPanel } from '../impact-panel';

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
const PLACE_DATA_TIMEOUT_MS = 8_000;
const PNW_BOUNDS = [-125, 41.5, -110.5, 49.5] as const;

type ArealGeometry = Polygon | MultiPolygon;
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
  readonly caveat: string | null;
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
  init: RequestInit | null = null
): Promise<unknown> {
  return fetchJsonWithBudget(
    url,
    init,
    signal,
    PLACE_DATA_TIMEOUT_MS
  );
}

function assertFeatureCollection(raw: unknown): FeatureCollection {
  if (raw && typeof raw === 'object' && 'error' in raw) {
    throw new Error('ArcGIS returned an error response.');
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { type?: unknown }).type !== 'FeatureCollection' ||
    !Array.isArray((raw as { features?: unknown }).features)
  ) {
    throw new Error('Expected a GeoJSON FeatureCollection.');
  }
  if ((raw as { exceededTransferLimit?: unknown }).exceededTransferLimit === true) {
    throw new Error('ArcGIS returned a partial FeatureCollection.');
  }
  return raw as FeatureCollection;
}

function isArealGeometry(
  geometry: Geometry | null | undefined
): geometry is ArealGeometry {
  return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
}

function mergeArealGeometry(features: readonly Feature[]): ArealGeometry | null {
  const polygons: MultiPolygon['coordinates'] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
    if (geometry?.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
  }
  if (polygons.length === 0) return null;
  if (polygons.length === 1) {
    return { type: 'Polygon', coordinates: polygons[0] ?? [] };
  }
  return { type: 'MultiPolygon', coordinates: polygons };
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

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

// bboxCenter/bboxIntersects/bboxIntersection share the N2-A circular
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
    bboxCenter(bbox),
    title
  );
  return {
    context: { ...rawContext, bbox },
    geometry,
    bbox
  };
}

async function resolveStateSelection(
  entry: PlaceCatalogEntry,
  signal: AbortSignal
): Promise<ResolvedPlaceSelection | null> {
  const collection = assertFeatureCollection(
    await fetchJson(URLS.usStatesLocal, signal)
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
    geometryPrecision: '5',
    f: 'geojson'
  });
  const collection = assertFeatureCollection(
    await fetchJson(
      `${URLS.biaLarFeatureServer}/query?${params.toString()}`,
      signal,
      { cache: 'no-store' }
    )
  );
  abortIfNeeded(signal);
  const geometry = mergeArealGeometry(collection.features);
  if (!geometry) return null;
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
  const collection = assertFeatureCollection(
    await fetchJson(
      `${URLS.epaEcoregionsMapServer}/${layer}/query?${params.toString()}`,
      signal,
      { cache: 'no-store' }
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
  const feature = await loadWatershedSelectionGeometry(
    entry,
    getMap()?.getZoom() ?? 0,
    signal
  );
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
  const collection = assertFeatureCollection(
    await fetchJson(URLS.usStatesLocal, signal)
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
  signal: AbortSignal
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
    const params = arcGisEnvelopeParams(envelope, outFields);
    return assertFeatureCollection(
      await fetchJson(
        `${URLS.epaEcoregionsMapServer}/${layer}/query?${params.toString()}`,
        siblingSignal,
        { cache: 'no-store' }
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
      return assertFeatureCollection(
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
    (piece, siblingSignal) =>
      loadWatershedCandidates(
        piece,
        getMap()?.getZoom() ?? 0,
        siblingSignal
      )
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
  signal: AbortSignal
): Promise<FeatureCollection<ArealGeometry, PlaceOverlapProperties>> {
  switch (kind) {
    case 'tribe':
      return loadTribeCandidates(bbox, signal);
    case 'state':
      return loadStateCandidates(bbox, signal);
    case 'ecoregion': {
      const scopedBbox = bboxIntersection(bbox, PNW_BOUNDS);
      return scopedBbox
        ? loadEcoregionCandidates(scopedBbox, signal)
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
  const requestBbox =
    entry.kind === 'ecoregion'
      ? bboxIntersection(selected.bbox, PNW_BOUNDS) ?? selected.bbox
      : selected.bbox;
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
          candidates: await loadCandidateKind(kind, requestBbox, signal)
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
        label: properties.placeLabel,
        caveat:
          properties.placeKind === 'tribe' ? TRIBAL_OVERLAP_CAVEAT : null
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

function PlaceStudio() {
  const initialSelection = getTypedPlace();
  const [kind, setKind] = useState<TypedPlaceKind>(
    initialSelection?.kind ?? 'tribe'
  );
  const [selection, setSelection] = useState<TypedPlaceRef | null>(initialSelection);
  const [selectionEntry, setSelectionEntry] = useState<PlaceCatalogEntry | null>(null);
  const [entries, setEntries] = useState<readonly PlaceCatalogEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
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
    beginPlaceStudioDisplay(kind);
    const app = document.getElementById('app');
    const priorAriaHidden = app?.getAttribute('aria-hidden') ?? null;
    if (app) {
      app.inert = true;
      app.setAttribute('aria-hidden', 'true');
    }
    backRef.current?.focus();

    return () => {
      restoreDisplaySnapshot();
      if (app) {
        app.inert = false;
        if (priorAriaHidden === null) app.removeAttribute('aria-hidden');
        else app.setAttribute('aria-hidden', priorAriaHidden);
      }
      // Restore-then-brief (ruled ordering): the selected-exit briefing
      // hand-off runs only here, AFTER restoreDisplaySnapshot(), so it can
      // neither open before the restore nor be cancelled by the restore's
      // intent supersede (the former popstate microtask raced both ways).
      takePlaceStudioReturnAction()?.();
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
    emphasizeTypedPlace(selection, selectionEntry);
  }, [selection, selectionEntry]);

  useEffect(
    () =>
      onTypedPlaceChange((place) => {
        setSelection(place);
        setSelectionEntry((entry) =>
          place && entry?.kind === place.kind && entry.id === place.id ? entry : null
        );
        if (place) setKind(place.kind);
      }),
    []
  );

  useEffect(() => {
    const masterAbort = new AbortController();
    setLoading(true);
    setUnavailable(false);
    setEntries([]);
    void loadPlaceCatalog(kind, masterAbort.signal)
      .then((next) => {
        if (masterAbort.signal.aborted) return;
        setEntries(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (masterAbort.signal.aborted) return;
        console.warn('[place-studio] catalog load failed.', err);
        setUnavailable(true);
        setLoading(false);
      });
    return () => masterAbort.abort();
  }, [catalogAttempt, kind]);

  useEffect(() => {
    if (!selection || selection.kind !== kind) return;
    const entry = entries.find(
      (candidate) => candidate.kind === selection.kind && candidate.id === selection.id
    );
    if (entry) setSelectionEntry(entry);
  }, [entries, kind, selection]);

  useEffect(() => {
    setPlaceStudioReturnAction(null);
    setStudioWatershedBoundary(null);
    resolvedSelectionRef.current = null;
    selectionPromiseRef.current = null;
    setNarrativeKindLabel(
      selection ? PLACE_CATALOG[selection.kind].label : ''
    );
    setNarrativeLine(null);
    setNarrativeStatus(selectionEntry ? 'loading' : 'unavailable');
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

    // Wave A finding 2: register the return hand-off at resolution START,
    // not completion, so an immediate browser Back (which bypasses
    // handleBack's await) still delivers the promised briefing. The action
    // chases the pending resolution; if the studio's own resolution was
    // aborted by the unmount cleanup, it re-resolves INDEPENDENTLY
    // (bounded by the fetch budget) rather than pinning the studio's
    // aborted chain, and it opens only while the durable typed place
    // still matches (newest intent wins). Once resolution completes
    // in-studio, the direct registration below replaces this one.
    if (
      explicitSelectionKeyRef.current === selectionKey &&
      coverage.briefable.state === 'available'
    ) {
      setPlaceStudioReturnAction(() => {
        const stillCurrent = (): boolean => {
          const place = getTypedPlace();
          return (
            place !== null &&
            place.kind === selectionEntry.kind &&
            place.id === selectionEntry.id
          );
        };
        void promise
          .catch(() =>
            resolvePlaceSelection(selectionEntry, new AbortController().signal)
          )
          .then((resolved) => {
            if (resolved && stillCurrent()) openImpactPanel(resolved.context);
          })
          .catch(() => undefined);
      });
    }

    void promise
      .then((resolved) => {
        if (masterAbort.signal.aborted) return;
        if (!resolved) {
          setNarrativeStatus('unavailable');
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
          setPlaceStudioReturnAction(() => openImpactPanel(resolved.context));
        }

        const impactSynthesis = regionCapabilityLevel(
          resolved.context.regionKey,
          'impactSynthesis'
        );
        if (
          coverage.briefable.state === 'available' &&
          impactSynthesis !== 'none'
        ) {
          const briefing = createBriefingSkeleton(resolved.context);
          setNarrativeKindLabel(briefing.landKind);
          void hydrateBriefing(briefing, masterAbort.signal, () => {
            if (masterAbort.signal.aborted) return;
            const line = selectBriefNarrativeLine(briefing);
            if (line) {
              setNarrativeLine(line);
              setNarrativeStatus('ready');
            }
          })
            .then(() => {
              if (
                !masterAbort.signal.aborted &&
                !selectBriefNarrativeLine(briefing)
              ) {
                setNarrativeStatus('unavailable');
              }
            })
            .catch((err: unknown) => {
              if (!masterAbort.signal.aborted) {
                console.warn('[place-studio] brief narrative failed.', err);
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
          setNarrativeStatus('unavailable');
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
  }, [selection, selectionEntry]);

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
    }
    backToMap();
  };

  const definition = PLACE_CATALOG[kind];
  // The shared search fold on BOTH sides (wave A finding 1): the roster's
  // formal Tribal Nation names carry hyphens and apostrophes, and this
  // surface must match punctuation-free typing exactly like the shared
  // search does ("Absentee Shawnee" finds "Absentee-Shawnee Tribe of
  // Indians of Oklahoma"). Token-AND over the folded haystack, same as
  // the shared component's matcher.
  const queryTokens = foldSearchText(query)
    .split(' ')
    .filter((token) => token.length > 0);
  const filteredEntries = useMemo(
    () =>
      queryTokens.length === 0
        ? entries
        : entries.filter((entry) => {
            const haystack = foldSearchText(
              `${entry.label} ${entry.id} ${entry.detail ?? ''}`
            );
            return queryTokens.every((token) => haystack.includes(token));
          }),
    [entries, queryTokens.join(' ')]
  );
  const coverage = runtimeCoverage(
    kind,
    selection,
    selectionEntry,
    loading,
    unavailable
  );

  return (
    <section class="layers-studio place-studio" aria-labelledby="place-studio-heading">
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

      <div class="layers-studio-scroll place-studio-scroll">
        <nav class="place-studio-type-rail" aria-label="Place type">
          {PLACE_TYPE_ORDER.map((placeKind) => {
            const type = PLACE_CATALOG[placeKind];
            const active = placeKind === kind;
            return (
              <button
                key={placeKind}
                id={`place-type-${placeKind}`}
                type="button"
                class="place-studio-type"
                aria-pressed={active}
                aria-controls="place-list-panel"
                onClick={() => setKind(placeKind)}
              >
                {type.label}
              </button>
            );
          })}
        </nav>

        <div class="place-studio-layout">
          <section
            id="place-list-panel"
            class="place-studio-list-panel"
            aria-labelledby={`place-type-${kind}`}
            aria-busy={loading ? 'true' : 'false'}
          >
            <div class="place-studio-type-status">
              <strong id="place-type-availability">
                {unavailable ? 'unavailable' : definition.availability}
              </strong>
              {definition.coverage ? (
                <span id="place-type-coverage">{definition.coverage}</span>
              ) : null}
            </div>
            <label class="place-studio-search" for="place-studio-search">
              <span class="sr-only">Search</span>
              <input
                id="place-studio-search"
                type="search"
                value={query}
                aria-label="Search"
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>

            {loading ? (
              <p id="place-list-status" class="place-studio-list-status" role="status">
                Loading places...
              </p>
            ) : unavailable ? (
              <div class="place-studio-list-failure">
                <p id="place-list-status" class="place-studio-list-status" role="status">
                  This list is not available right now.
                </p>
                <button
                  type="button"
                  class="layers-studio-back place-studio-retry"
                  onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
                >
                  Try again
                </button>
              </div>
            ) : filteredEntries.length === 0 ? (
              <p id="place-list-status" class="place-studio-list-status" role="status">
                {queryTokens.length === 0
                  ? 'No places are listed for this type yet.'
                  : 'No places match this search.'}
              </p>
            ) : (
              <ul id="place-list" class="place-studio-list">
                {filteredEntries.map((entry, index) => {
                  const selected =
                    selection?.kind === entry.kind && selection.id === entry.id;
                  return (
                    <li key={`${entry.kind}:${entry.id}:${entry.detail ?? ''}`}>
                      <button
                        id={`place-option-${kind}-${index}`}
                        type="button"
                        class={`place-studio-option${selected ? ' selected' : ''}`}
                        data-place-kind={entry.kind}
                        data-place-id={entry.id}
                        aria-pressed={selected}
                        onClick={() => {
                          const selectionKey = `${entry.kind}:${entry.id}`;
                          explicitSelectionKeyRef.current = selectionKey;
                          setPlaceStudioReturnAction(null);
                          const resolved = resolvedSelectionRef.current;
                          if (
                            resolved?.key === selectionKey &&
                            coverageForEntry(entry).briefable.state === 'available'
                          ) {
                            setPlaceStudioReturnAction(() =>
                              openImpactPanel(resolved.value.context)
                            );
                          }
                          setSelectionEntry(entry);
                          setTypedPlace(typedPlaceRef(entry));
                        }}
                      >
                        <span>{entry.label}</span>
                        {entry.detail ? <small>{entry.detail}</small> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <aside
            id="place-selection-panel"
            class="place-studio-selection-panel"
            aria-labelledby="place-selection-panel-heading"
          >
            <h3 id="place-selection-panel-heading">Selection panel</h3>
            {!selection ? (
              <p id="place-selection-empty">
                No place selected. Choose a place type, then a place; the full briefing
                opens when you return to the map.
              </p>
            ) : (
              <div id="place-selection-current">
                <section id="place-brief-narrative">
                  <h5>Brief narrative</h5>
                  <p class="place-studio-selection-kind">
                    {narrativeKindLabel}
                  </p>
                  <h4 id="place-selection-title">{selection.label}</h4>
                  <p id="place-brief-line" role="status">
                    {narrativeStatus === 'ready'
                      ? narrativeLine
                      : narrativeStatus}
                  </p>
                </section>
                <p class="place-studio-selection-availability">
                  {PLACE_CATALOG[selection.kind].availability}
                </p>
                {PLACE_CATALOG[selection.kind].coverage ? (
                  <p class="place-studio-selection-coverage">
                    {PLACE_CATALOG[selection.kind].coverage}
                  </p>
                ) : null}
                <section id="place-overlap-columns">
                  <h5>Overlap columns</h5>
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
                                    {row.caveat ? (
                                      <p class="place-overlap-tribal-caveat">
                                        {row.caveat}
                                      </p>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            </section>
                          );
                        })}
                      </div>
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
          </aside>
        </div>
      </div>
    </section>
  );
}

export function mountPlaceStudio(root: HTMLElement): void {
  render(<PlaceStudio />, root);
}

export function unmountPlaceStudio(root: HTMLElement): void {
  render(null, root);
}
