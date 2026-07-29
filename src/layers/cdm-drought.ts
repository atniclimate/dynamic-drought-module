/**
 * Canadian Drought Monitor (CDM) committed monthly snapshot.
 *
 * The source ZIP, unzip dependency, and EPSG:3857 reprojection stay entirely
 * in scripts/build-cdm-snapshot.mjs. Runtime fetches one compact WGS 84 JSON
 * artifact. The artifact distinguishes a published month with an unoccupied
 * class from a missing or failed month; malformed provenance fails closed.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { URLS } from '../config/urls';
import { registerClickTarget } from '../map/interaction-coordinator';
import { registry } from '../state/registry';
import {
  hideLegend,
  LEGEND_ORDER,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { clearTimeBar, setTimeBar } from '../ui/time-bar';
import { escapeHtml } from '../util/escape';
import { fetchWithBudget } from '../util/fetch';

const LAYER_KEY = 'cdm-drought';
const SOURCE_ID = 'cdm-drought-areas';
const FILL_ID = 'cdm-drought-fill';
const OUTLINE_ID = 'cdm-drought-outline';
const BEFORE_ID = 'first-symbol';
const FETCH_TIMEOUT_MS = 15_000;
const FILL_OPACITY = 0.54;
const OUTLINE_OPACITY = 0.45;
const CLASS_CODES = ['D0', 'D1', 'D2', 'D3', 'D4'] as const;
const CLASS_COLORS = ['#FFFF00', '#FCD37F', '#FFAA00', '#E60000', '#730000'] as const;
const SNAPSHOT_EVENT = 'ddm:cdm-snapshot';
const LICENSE_TITLE = 'Open Government Licence - Canada';
const LICENSE_URL =
  'https://open.canada.ca/en/open-government-licence-canada';
const DATASET_URL =
  'https://open.canada.ca/data/en/dataset/292646cd-619f-4200-afb1-8b2c52f984a2';

export const fadeLayerIds = [FILL_ID, OUTLINE_ID] as const;

type ClassCode = (typeof CLASS_CODES)[number];
type ClassState = 'present' | 'absent-no-occupied-area';

interface ArtifactClass {
  readonly class: ClassCode;
  readonly state: ClassState;
  readonly member: string | null;
  readonly featureCount: number;
  readonly componentCount: number;
}

interface CdmArtifact {
  readonly schemaVersion: 1;
  readonly product: 'Canadian Drought Monitor';
  readonly month: string;
  readonly monthState: 'published';
  readonly attribution: 'Agriculture and Agri-Food Canada';
  readonly license: {
    readonly title: 'Open Government Licence - Canada';
    readonly url: string;
    readonly datasetUrl: string;
  };
  readonly provenance: {
    readonly sourceUrl: string;
    readonly retrieved: string;
    readonly archiveBytes: number;
    readonly classesPresent: readonly ClassCode[];
    readonly classesAbsent: readonly ClassCode[];
    readonly stewardshipCheck: {
      readonly result: string;
    };
    readonly componentPreservation: string;
  };
  readonly classes: readonly ArtifactClass[];
  readonly data: GeoJSON.FeatureCollection;
}

let masterController: AbortController | null = null;
let activeArtifact: CdmArtifact | null = null;

const COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'dm'],
  0,
  CLASS_COLORS[0],
  1,
  CLASS_COLORS[1],
  2,
  CLASS_COLORS[2],
  3,
  CLASS_COLORS[3],
  4,
  CLASS_COLORS[4],
  'rgba(0,0,0,0)'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateArtifact(value: unknown): CdmArtifact {
  if (!isRecord(value)) throw new Error('CDM artifact is not an object.');
  if (
    value['schemaVersion'] !== 1 ||
    value['product'] !== 'Canadian Drought Monitor' ||
    value['monthState'] !== 'published' ||
    value['attribution'] !== 'Agriculture and Agri-Food Canada' ||
    typeof value['month'] !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(value['month'])
  ) {
    throw new Error('CDM artifact identity or published-month stamp is invalid.');
  }
  const license = value['license'];
  if (
    !isRecord(license) ||
    license['title'] !== LICENSE_TITLE ||
    license['url'] !== LICENSE_URL ||
    license['datasetUrl'] !== DATASET_URL
  ) {
    throw new Error('CDM artifact license provenance is invalid.');
  }
  const provenance = value['provenance'];
  if (
    !isRecord(provenance) ||
    typeof provenance['sourceUrl'] !== 'string' ||
    typeof provenance['retrieved'] !== 'string' ||
    typeof provenance['archiveBytes'] !== 'number' ||
    !Array.isArray(provenance['classesPresent']) ||
    !Array.isArray(provenance['classesAbsent']) ||
    !isRecord(provenance['stewardshipCheck']) ||
    typeof provenance['stewardshipCheck']['result'] !== 'string' ||
    !provenance['stewardshipCheck']['result'].startsWith('PASS:') ||
    typeof provenance['componentPreservation'] !== 'string' ||
    !provenance['componentPreservation'].startsWith('PASS:')
  ) {
    throw new Error('CDM artifact provenance or stewardship result is invalid.');
  }
  const classes = value['classes'];
  if (!Array.isArray(classes) || classes.length !== CLASS_CODES.length) {
    throw new Error('CDM artifact must state all five class occupancy states.');
  }
  const stateByClass = new Map<ClassCode, ArtifactClass>();
  for (const entry of classes) {
    if (
      !isRecord(entry) ||
      !CLASS_CODES.includes(entry['class'] as ClassCode) ||
      !['present', 'absent-no-occupied-area'].includes(String(entry['state'])) ||
      !Number.isSafeInteger(entry['featureCount']) ||
      !Number.isSafeInteger(entry['componentCount'])
    ) {
      throw new Error('CDM artifact class occupancy entry is invalid.');
    }
    const typed = entry as unknown as ArtifactClass;
    if (stateByClass.has(typed.class)) {
      throw new Error(`CDM artifact repeats class ${typed.class}.`);
    }
    stateByClass.set(typed.class, typed);
  }
  const data = value['data'];
  if (
    !isRecord(data) ||
    data['type'] !== 'FeatureCollection' ||
    !Array.isArray(data['features'])
  ) {
    throw new Error('CDM artifact data is not a FeatureCollection.');
  }
  const featureCount = new Map<ClassCode, number>(
    CLASS_CODES.map((code) => [code, 0])
  );
  const componentCount = new Map<ClassCode, number>(
    CLASS_CODES.map((code) => [code, 0])
  );
  for (const feature of data['features']) {
    if (
      !isRecord(feature) ||
      !isRecord(feature['properties']) ||
      !isRecord(feature['geometry']) ||
      !Array.isArray(feature['geometry']['coordinates'])
    ) {
      throw new Error('CDM artifact contains a feature without valid geometry or properties.');
    }
    const dm = Number(feature['properties']['dm']);
    if (!Number.isInteger(dm) || dm < 0 || dm > 4) {
      throw new Error(`CDM artifact contains unknown class ${String(dm)}.`);
    }
    const code = CLASS_CODES[dm]!;
    featureCount.set(code, (featureCount.get(code) ?? 0) + 1);
    const geometryType = feature['geometry']['type'];
    const coordinates = feature['geometry']['coordinates'];
    const components =
      geometryType === 'Polygon'
        ? coordinates.length > 0
          ? 1
          : 0
        : geometryType === 'MultiPolygon'
          ? coordinates.length
          : -1;
    if (components <= 0) {
      throw new Error(`CDM artifact contains invalid ${String(geometryType)} geometry.`);
    }
    componentCount.set(code, (componentCount.get(code) ?? 0) + components);
  }
  for (const code of CLASS_CODES) {
    const state = stateByClass.get(code);
    const count = featureCount.get(code) ?? 0;
    const components = componentCount.get(code) ?? 0;
    if (!state || state.featureCount !== count) {
      throw new Error(`CDM artifact feature count disagrees for ${code}.`);
    }
    if (state.componentCount !== components) {
      throw new Error(`CDM artifact component count disagrees for ${code}.`);
    }
    if (
      (state.state === 'present' && count === 0) ||
      (state.state === 'absent-no-occupied-area' && count !== 0)
    ) {
      throw new Error(`CDM artifact occupancy state disagrees for ${code}.`);
    }
  }
  return value as unknown as CdmArtifact;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

function showCdmLegend(artifact: CdmArtifact): void {
  const stateByClass = new Map(
    artifact.classes.map((entry) => [entry.class, entry.state])
  );
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) => {
      renderSwatchLegend(
        body,
        `Canadian Drought Monitor · ${monthLabel(artifact.month)}`,
        CLASS_CODES.map((code, index) => ({
          color: CLASS_COLORS[index]!,
          label:
            stateByClass.get(code) === 'present'
              ? `${code} · present this month`
              : `${code} · no area in this class this month`
        })),
        'Agriculture and Agri-Food Canada · monthly classification · bare map means no polygon coverage in this artifact, not class zero'
      );
      const license = document.createElement('p');
      license.className = 'legend-note';
      const link = document.createElement('a');
      link.href = artifact.license.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = artifact.license.title;
      license.append(link);
      body.append(license);
    }
  });
}

function showCdmTimeBar(artifact: CdmArtifact): void {
  setTimeBar(LAYER_KEY, {
    ariaLabel: 'Canadian Drought Monitor snapshot month',
    stamp: {
      headline: `Month ${monthLabel(artifact.month)}`,
      detail:
        'Canadian Drought Monitor · Agriculture and Agri-Food Canada · monthly classification',
      register: 'observed'
    }
  });
}

function dispatchSnapshot(
  status: 'ready' | 'inactive',
  artifact: CdmArtifact | null
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(SNAPSHOT_EVENT, {
      detail: {
        status,
        month: artifact?.month ?? null,
        classes: artifact?.classes ?? [],
        license: artifact?.license ?? null
      }
    })
  );
}

function installMapState(
  map: maplibregl.Map,
  artifact: CdmArtifact
): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: artifact.data,
      attribution:
        `Agriculture and Agri-Food Canada · ` +
        `<a href="${artifact.license.url}" target="_blank" rel="noopener">${artifact.license.title}</a>`
    });
  }
  const beforeId = map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
  if (!map.getLayer(FILL_ID)) {
    map.addLayer(
      {
        id: FILL_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: {
          'fill-color': COLOR_EXPRESSION,
          'fill-opacity': FILL_OPACITY
        }
      },
      beforeId
    );
  }
  if (!map.getLayer(OUTLINE_ID)) {
    map.addLayer(
      {
        id: OUTLINE_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: {
          'line-color': COLOR_EXPRESSION,
          'line-opacity': OUTLINE_OPACITY,
          'line-width': 0.5
        }
      },
      beforeId
    );
  }
}

export async function activate(map: maplibregl.Map): Promise<void> {
  if (activeArtifact !== null) {
    registry.setStatus(LAYER_KEY, 'ready');
    return;
  }
  masterController?.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  registry.setStatus(LAYER_KEY, 'loading');

  let artifact: CdmArtifact;
  try {
    const response = await fetchWithBudget(
      URLS.cdmDroughtAreasLocal,
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    artifact = validateArtifact(await response.json());
  } catch (error) {
    if (signal.aborted) return;
    console.warn('[cdm-drought] committed snapshot load failed.', error);
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  if (signal.aborted) return;

  activeArtifact = artifact;
  showCdmLegend(artifact);
  showCdmTimeBar(artifact);
  dispatchSnapshot('ready', artifact);

  // A published month may legitimately have no occupied D0 through D4
  // classes. That is a real finding and remains live, never "no data".
  if (artifact.data.features.length > 0) {
    installMapState(map, artifact);
  }
  registry.setStatus(LAYER_KEY, 'ready');
}

export function cancelActivation(): void {
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  masterController?.abort();
  masterController = null;
  if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
  if (map.getLayer(OUTLINE_ID)) map.removeLayer(OUTLINE_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  activeArtifact = null;
  hideLegend(LAYER_KEY);
  clearTimeBar(LAYER_KEY);
  dispatchSnapshot('inactive', null);
}

function popupHtml(properties: GeoJsonProperties): string {
  const dm = Number(properties?.['dm']);
  const code =
    Number.isInteger(dm) && dm >= 0 && dm <= 4 ? CLASS_CODES[dm]! : 'Unknown';
  const month = activeArtifact?.month ?? null;
  return `
    <div class="popup-title">${escapeHtml(code)}</div>
    <div class="popup-agency">Canadian Drought Monitor · Agriculture and Agri-Food Canada</div>
    <div class="popup-treaty-meta">Month: ${escapeHtml(month ? monthLabel(month) : 'unavailable')}</div>
    <div class="popup-description">Monthly Canadian Drought Monitor classification. This feature is not blended with a United States or provincial product.</div>
    <div class="popup-treaty-meta">Areas without a polygon are not assigned class zero by this artifact.</div>
    <div class="popup-links">
      <a href="${DATASET_URL}" target="_blank" rel="noopener">Canadian Drought Monitor source</a>
      <a href="${LICENSE_URL}" target="_blank" rel="noopener">${LICENSE_TITLE}</a>
    </div>
  `;
}

export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [FILL_ID],
    label: (feature) => {
      const dm = Number(feature.properties?.['dm']);
      return Number.isInteger(dm) && dm >= 0 && dm <= 4
        ? `Canadian Drought Monitor ${CLASS_CODES[dm]}`
        : null;
    },
    respond: (feature) => ({
      content: popupHtml(feature.properties ?? {})
    })
  });
  map.on('mouseenter', FILL_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', FILL_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
