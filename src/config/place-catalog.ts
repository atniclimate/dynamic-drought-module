import { URLS } from './urls';
import { TRUSTED_PROVENANCE, gatedDisplayName, loadTribalRoster } from '../state/tribal-roster';
import type { TribalRosterArea } from '../state/tribal-roster';
import type { TypedPlaceKind, TypedPlaceRef } from '../state/typed-place';
import { fetchJsonWithBudget, fetchSharedJsonWithBudget, US_STATES_SHARED_KEY } from '../util/fetch';

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
// Guarded so a pure Node test can import this module without a Vite-served
// page (the same idiom as src/config/urls-boot.ts:29, DDM-P2-T12).
const TRIBAL_CROSSWALK_URL =
  (import.meta.env?.BASE_URL ?? '/dynamic-drought-module/') + 'data/tribal-larname-crosswalk.json';
const ECOREGION_CATALOG_URL =
  (import.meta.env?.BASE_URL ?? '/dynamic-drought-module/') + 'data/ecoregions-pnw-catalog.json';
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
  return buildTribeCatalogEntries(areas, rawCrosswalk as TribalCrosswalk);
}

/**
 * The pure loop body of `loadTribeEntries` (DDM-P2-T12), lifted out of the
 * async fetch shell so the trust decision and the label choice are
 * unit-testable on hand-built rows with no browser and no network. Trust is
 * decided by testing the roster row's own `provenance` against
 * `TRUSTED_PROVENANCE` (never by comparing the gated label string against
 * `displayName`, which reads as trusted whenever an UNTRUSTED row's
 * `displayName` happens to equal its `larName`); a trusted row is labelled
 * with the gated roster value (`gated`), never with the crosswalk's own
 * `tribe` string.
 */
export function buildTribeCatalogEntries(
  areas: readonly TribalRosterArea[],
  crosswalk: TribalCrosswalk
): readonly PlaceCatalogEntry[] {
  const rosterSource =
    textValue(crosswalk.meta?.rosterSource) ?? PLACE_CATALOG.tribe.sourceLabels[0] ?? '';
  const landAreaSource =
    textValue(crosswalk.meta?.landAreaSource) ?? PLACE_CATALOG.tribe.sourceLabels[1] ?? '';
  const rosterByLarName = new Map<string, TribalRosterArea>(
    areas.map((area) => [area.larName.trim().toLocaleLowerCase(), area] as const)
  );
  const representationIds = new Map<string, Set<string>>();
  // Entries whose label is a formal Nation name (a trusted crosswalk match,
  // or a matched/rosterNoLar row with no land area to gate at all).
  const formalNames = new Set<string>();
  // Entries whose label is a BIA land-area name (DR-094): a crosswalk row
  // whose roster provenance is NOT trusted keeps its own honest label
  // rather than borrowing the unproven formal name, with no visible marker
  // distinguishing it from a formal-name entry (the title stays plain).
  const gatedLarLabels = new Set<string>();

  for (const row of crosswalk.matched ?? []) {
    const name = textValue(row.tribe);
    const larName = textValue(row.larName);
    if (!name) continue;
    if (!larName) {
      // A roster-only match: no land area to gate, so it passes as the
      // crosswalk's own name (nothing here can be gated against).
      formalNames.add(name);
      continue;
    }
    const rosterArea = rosterByLarName.get(larName.toLocaleLowerCase());
    if (!rosterArea) {
      // Matched to a larName the shipped roster does not carry: same
      // no-land-area-to-gate case as above.
      formalNames.add(name);
      continue;
    }
    const gated = gatedDisplayName(rosterArea);
    if (TRUSTED_PROVENANCE.has(rosterArea.provenance ?? '')) {
      // Trusted (DR-094, the shared gate in src/state/tribal-roster.ts):
      // this representation is shown under the gated roster value (the
      // formal Nation name), never the crosswalk's own `tribe` string,
      // which the trust decision does not depend on (DDM-P2-T12: trust is
      // tested against TRUSTED_PROVENANCE directly, never inferred by
      // comparing the gated label to displayName).
      formalNames.add(gated);
      const ids = representationIds.get(gated) ?? new Set<string>();
      ids.add(rosterArea.larName);
      representationIds.set(gated, ids);
    } else {
      // Untrusted (DDM-P2-T12: decided against the provenance set, never by
      // comparing the gated label to displayName, which is wrong whenever
      // an untrusted row's displayName happens to equal its larName): the
      // polygon stays selectable, honestly labeled with its own BIA
      // land-area name instead of the unproven crosswalk name.
      gatedLarLabels.add(gated);
      const ids = representationIds.get(gated) ?? new Set<string>();
      ids.add(rosterArea.larName);
      representationIds.set(gated, ids);
    }
  }
  for (const value of crosswalk.rosterNoLar ?? []) {
    const name = textValue(value);
    // A roster row with no land area at all: nothing to gate, so it passes
    // as the roster's own name (same rule as the no-larName branch above).
    if (name) formalNames.add(name);
  }

  const labels = new Set<string>([...formalNames, ...gatedLarLabels]);
  return [...labels]
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
  // Shared, page-lifetime transport (DDM-P14-T06): joins whatever fetch the
  // states layer, the deep link, the click-door fallback, or another Place
  // studio reader already made for the same bundled file, rather than
  // issuing its own. Only read below (`for...of` over `raw.features ?? []`,
  // never sorted or written to), so sharing the reference is safe.
  const raw = (await fetchSharedJsonWithBudget(
    US_STATES_SHARED_KEY,
    URLS.usStatesLocal,
    null,
    signal,
    CATALOG_TIMEOUT_MS
  )) as {
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
