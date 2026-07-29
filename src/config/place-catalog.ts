import { URLS } from './urls';
import { loadTribalRoster } from '../state/tribal-roster';
import type { TypedPlaceKind, TypedPlaceRef } from '../state/typed-place';
import { fetchJsonWithBudget } from '../util/fetch';

export type PlaceTypeAvailability =
  | 'AVAILABLE'
  | 'AVAILABLE WITH SCOPED COVERAGE'
  | 'AVAILABLE, CONDITIONS BINDING';

export type PlaceCapabilityKey =
  | 'selectable'
  | 'briefable'
  | 'overlap-computable';

export type PlaceCapabilityState = 'available' | 'unavailable';

export interface PlaceCapabilityCell {
  readonly state: PlaceCapabilityState;
  readonly scope: string | null;
  readonly geometryDependent: boolean;
}

export type PlaceCapabilityMatrix = Readonly<
  Record<PlaceCapabilityKey, PlaceCapabilityCell>
>;

export interface PlaceCatalogDefinition {
  readonly kind: TypedPlaceKind;
  readonly label: string;
  readonly availability: PlaceTypeAvailability;
  readonly coverage: string | null;
  readonly sourceLabels: readonly string[];
  readonly capabilities: PlaceCapabilityMatrix;
}

export interface PlaceCatalogEntry {
  readonly kind: TypedPlaceKind;
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly provenance: readonly string[];
  readonly representationIds: readonly string[];
  readonly geometryAvailable: boolean;
}

const UNITED_STATES_SCOPE = 'United States';
export const ECOREGION_COVERAGE = 'Pacific Northwest (Level III and IV)';
export const WATERSHED_COVERAGE = 'HUC2 and HUC4';

export const PLACE_COVERAGE_MATRIX: Readonly<
  Record<TypedPlaceKind, PlaceCapabilityMatrix>
> = {
  tribe: {
    selectable: {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: false
    },
    briefable: {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: true
    },
    'overlap-computable': {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: true
    }
  },
  state: {
    selectable: {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: false
    },
    briefable: {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: true
    },
    'overlap-computable': {
      state: 'available',
      scope: UNITED_STATES_SCOPE,
      geometryDependent: true
    }
  },
  ecoregion: {
    selectable: {
      state: 'available',
      scope: ECOREGION_COVERAGE,
      geometryDependent: false
    },
    briefable: {
      state: 'available',
      scope: ECOREGION_COVERAGE,
      geometryDependent: true
    },
    'overlap-computable': {
      state: 'available',
      scope: ECOREGION_COVERAGE,
      geometryDependent: true
    }
  },
  watershed: {
    selectable: {
      state: 'available',
      scope: WATERSHED_COVERAGE,
      geometryDependent: false
    },
    briefable: {
      state: 'available',
      scope: WATERSHED_COVERAGE,
      geometryDependent: true
    },
    'overlap-computable': {
      state: 'available',
      scope: WATERSHED_COVERAGE,
      geometryDependent: true
    }
  }
};

export const PLACE_CATALOG: Readonly<
  Record<TypedPlaceKind, PlaceCatalogDefinition>
> = {
  tribe: {
    kind: 'tribe',
    label: 'Tribal Nations',
    availability: 'AVAILABLE',
    coverage: null,
    sourceLabels: [
      'Federal Register 2026-01899 (2026-01-30)',
      'BIA AIAN-LAR FeatureServer (distinct LARNAME)'
    ],
    capabilities: PLACE_COVERAGE_MATRIX.tribe
  },
  state: {
    kind: 'state',
    label: 'States',
    availability: 'AVAILABLE',
    coverage: null,
    sourceLabels: ['U.S. Census Bureau cartographic boundary file'],
    capabilities: PLACE_COVERAGE_MATRIX.state
  },
  ecoregion: {
    kind: 'ecoregion',
    label: 'Ecoregions',
    availability: 'AVAILABLE WITH SCOPED COVERAGE',
    coverage: ECOREGION_COVERAGE,
    sourceLabels: ['EPA Omernik Ecoregions (Level III and IV), Region 10'],
    capabilities: PLACE_COVERAGE_MATRIX.ecoregion
  },
  watershed: {
    kind: 'watershed',
    label: 'Watersheds',
    availability: 'AVAILABLE, CONDITIONS BINDING',
    coverage: WATERSHED_COVERAGE,
    sourceLabels: [
      'United States Geological Survey Watershed Boundary Dataset ArcGIS service'
    ],
    capabilities: PLACE_COVERAGE_MATRIX.watershed
  }
};

export const PLACE_TYPE_ORDER: readonly TypedPlaceKind[] = [
  'tribe',
  'state',
  'ecoregion',
  'watershed'
];

const CATALOG_TIMEOUT_MS = 8_000;
const TRIBAL_CROSSWALK_URL =
  import.meta.env.BASE_URL + 'data/tribal-larname-crosswalk.json';
const ECOREGION_CATALOG_URL =
  import.meta.env.BASE_URL + 'data/ecoregions-pnw-catalog.json';
const STATE_CATALOG_STUSPS: ReadonlySet<string> = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY'
]);

interface TribalCrosswalkMatch {
  readonly larName?: unknown;
  readonly tribe?: unknown;
}

interface TribalCrosswalk {
  readonly meta?: {
    readonly rosterSource?: unknown;
    readonly landAreaSource?: unknown;
  };
  readonly matched?: readonly TribalCrosswalkMatch[];
  readonly rosterNoLar?: readonly unknown[];
}

interface ArcGisFeature {
  readonly attributes?: Readonly<Record<string, unknown>>;
}

interface ArcGisAttributeResponse {
  readonly features?: readonly ArcGisFeature[];
  readonly exceededTransferLimit?: boolean;
  readonly error?: unknown;
}

interface EcoregionCatalogManifest {
  readonly entries?: readonly {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly level?: unknown;
  }[];
}

const catalogCache = new Map<TypedPlaceKind, readonly PlaceCatalogEntry[]>();

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
  init: RequestInit | null = null
): Promise<unknown> {
  return fetchJsonWithBudget(url, init, signal, CATALOG_TIMEOUT_MS);
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function readAttribute(
  attributes: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  return textValue(attributes[key]);
}

function compareEntries(a: PlaceCatalogEntry, b: PlaceCatalogEntry): number {
  const labelOrder = a.label.localeCompare(b.label);
  if (labelOrder !== 0) return labelOrder;
  return a.id.localeCompare(b.id);
}

async function loadTribeEntries(signal: AbortSignal): Promise<readonly PlaceCatalogEntry[]> {
  const [areas, rawCrosswalk] = await Promise.all([
    loadTribalRoster(),
    fetchJson(TRIBAL_CROSSWALK_URL, signal)
  ]);
  abortIfNeeded(signal);

  const crosswalk = rawCrosswalk as TribalCrosswalk;
  const rosterSource =
    textValue(crosswalk.meta?.rosterSource) ?? PLACE_CATALOG.tribe.sourceLabels[0] ?? '';
  const landAreaSource =
    textValue(crosswalk.meta?.landAreaSource) ?? PLACE_CATALOG.tribe.sourceLabels[1] ?? '';
  const shippedLarNames = new Map(
    areas.map((area) => [area.larName.trim().toLocaleLowerCase(), area.larName] as const)
  );
  const representationIds = new Map<string, Set<string>>();
  const formalNames = new Set<string>();

  for (const row of crosswalk.matched ?? []) {
    const name = textValue(row.tribe);
    const larName = textValue(row.larName);
    if (!name) continue;
    formalNames.add(name);
    if (!larName) continue;
    const shipped = shippedLarNames.get(larName.toLocaleLowerCase());
    if (!shipped) continue;
    const ids = representationIds.get(name) ?? new Set<string>();
    ids.add(shipped);
    representationIds.set(name, ids);
  }
  for (const value of crosswalk.rosterNoLar ?? []) {
    const name = textValue(value);
    if (name) formalNames.add(name);
  }

  return [...formalNames]
    .map((label): PlaceCatalogEntry => {
      const ids = [...(representationIds.get(label) ?? [])].sort();
      return {
        kind: 'tribe',
        id: label,
        label,
        detail: null,
        provenance: [rosterSource, landAreaSource],
        representationIds: ids,
        geometryAvailable: ids.length > 0
      };
    })
    .sort(compareEntries);
}

async function loadStateEntries(signal: AbortSignal): Promise<readonly PlaceCatalogEntry[]> {
  const raw = (await fetchJson(URLS.usStatesLocal, signal)) as {
    readonly features?: readonly {
      readonly geometry?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    }[];
  };
  abortIfNeeded(signal);

  const entries: PlaceCatalogEntry[] = [];
  for (const feature of raw.features ?? []) {
    const properties = feature.properties ?? {};
    const id = readAttribute(properties, 'STUSPS');
    const label = readAttribute(properties, 'NAME');
    if (!id || !label || !STATE_CATALOG_STUSPS.has(id)) continue;
    entries.push({
      kind: 'state',
      id,
      label,
      detail: null,
      provenance: PLACE_CATALOG.state.sourceLabels,
      representationIds: [id],
      geometryAvailable: feature.geometry !== null && feature.geometry !== undefined
    });
  }
  return entries.sort(compareEntries);
}

function arcGisFeatures(raw: unknown): readonly ArcGisFeature[] {
  const response = raw as ArcGisAttributeResponse;
  if (response.error || response.exceededTransferLimit) {
    throw new Error('ArcGIS attribute query did not return a complete page');
  }
  return response.features ?? [];
}

async function loadEcoregionEntries(
  signal: AbortSignal
): Promise<readonly PlaceCatalogEntry[]> {
  const raw = (await fetchJson(ECOREGION_CATALOG_URL, signal)) as EcoregionCatalogManifest;
  abortIfNeeded(signal);

  const entries = new Map<string, PlaceCatalogEntry>();
  for (const row of raw.entries ?? []) {
    const id = textValue(row.code);
    const label = textValue(row.name);
    const level = textValue(row.level);
    if (!id || !label || (level !== 'III' && level !== 'IV')) {
      throw new Error('Invalid bundled ecoregion catalog manifest');
    }
    const key = `${level}:${id}`;
    if (entries.has(key)) throw new Error('Duplicate bundled ecoregion catalog member');
    entries.set(key, {
      kind: 'ecoregion',
      id,
      label,
      detail: `Level ${level}`,
      provenance: PLACE_CATALOG.ecoregion.sourceLabels,
      representationIds: [key],
      geometryAvailable: true
    });
  }
  if (entries.size === 0) throw new Error('Empty bundled ecoregion catalog manifest');
  return [...entries.values()].sort(compareEntries);
}

function watershedQueryUrl(layer: 1 | 2): string {
  const codeField = layer === 1 ? 'huc2' : 'huc4';
  const params = new URLSearchParams({
    where: '1=1',
    outFields: `${codeField},name,areasqkm,states`,
    returnGeometry: 'false',
    orderByFields: codeField,
    resultRecordCount: '2000',
    f: 'json'
  });
  return `${URLS.wbdMapServer}/${layer}/query?${params.toString()}`;
}

async function loadWatershedEntries(
  signal: AbortSignal
): Promise<readonly PlaceCatalogEntry[]> {
  const [huc2Raw, huc4Raw] = await Promise.all([
    fetchJson(watershedQueryUrl(1), signal, { cache: 'no-store' }),
    fetchJson(watershedQueryUrl(2), signal, { cache: 'no-store' })
  ]);
  abortIfNeeded(signal);

  const entries: PlaceCatalogEntry[] = [];
  const addLevel = (raw: unknown, level: 2 | 4): void => {
    const codeField = level === 2 ? 'huc2' : 'huc4';
    for (const feature of arcGisFeatures(raw)) {
      const attributes = feature.attributes ?? {};
      const rawCode = readAttribute(attributes, codeField);
      const name = readAttribute(attributes, 'name');
      if (!rawCode || !name) continue;
      const code = rawCode.padStart(level, '0');
      entries.push({
        kind: 'watershed',
        id: code,
        label: `${name} (HUC ${code})`,
        detail: `HUC${level}`,
        provenance: PLACE_CATALOG.watershed.sourceLabels,
        representationIds: [],
        geometryAvailable: true
      });
    }
  };
  addLevel(huc2Raw, 2);
  addLevel(huc4Raw, 4);
  return entries.sort(compareEntries);
}

/** Load one catalog through the shared master-abort plus timeout contract. */
export async function loadPlaceCatalog(
  kind: TypedPlaceKind,
  signal: AbortSignal
): Promise<readonly PlaceCatalogEntry[]> {
  abortIfNeeded(signal);
  const cached = catalogCache.get(kind);
  if (cached) return cached;

  let entries: readonly PlaceCatalogEntry[];
  switch (kind) {
    case 'tribe':
      entries = await loadTribeEntries(signal);
      break;
    case 'state':
      entries = await loadStateEntries(signal);
      break;
    case 'ecoregion':
      entries = await loadEcoregionEntries(signal);
      break;
    case 'watershed':
      entries = await loadWatershedEntries(signal);
      break;
  }
  abortIfNeeded(signal);
  catalogCache.set(kind, entries);
  return entries;
}

export function typedPlaceRef(entry: PlaceCatalogEntry): TypedPlaceRef {
  return { kind: entry.kind, id: entry.id, label: entry.label };
}

/** Resolve geometry-dependent cells for one concrete catalog entry. */
export function coverageForEntry(entry: PlaceCatalogEntry): PlaceCapabilityMatrix {
  const matrix = PLACE_COVERAGE_MATRIX[entry.kind];
  const resolve = (cell: PlaceCapabilityCell): PlaceCapabilityCell =>
    cell.geometryDependent && !entry.geometryAvailable && cell.state === 'available'
      ? { ...cell, state: 'unavailable' }
      : cell;
  return {
    selectable: resolve(matrix.selectable),
    briefable: resolve(matrix.briefable),
    'overlap-computable': resolve(matrix['overlap-computable'])
  };
}
