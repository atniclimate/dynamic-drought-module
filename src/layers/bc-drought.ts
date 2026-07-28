/**
 * Province of British Columbia basin drought levels.
 *
 * This helper is mounted only by the registered issuer-aware drought surface
 * when the British Columbia framing is active. It fetches the public ArcGIS
 * FeatureServer directly and commits no source geometry to the repository.
 * The provincial 0 through 5 scale is never translated to United States
 * Drought Monitor categories. Value 99 is the source's explicit No update
 * state outside the core drought season.
 */

import type maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import {
  BC_DROUGHT_LEVELS,
  BC_DROUGHT_NO_UPDATE
} from '../config/palette';
import {
  setDroughtSurfacePresentation
} from '../config/layers';
import { URLS } from '../config/urls';
import { registerClickTarget } from '../map/interaction-coordinator';
import { registry } from '../state/registry';
import { clearTimeBar, setTimeBar } from '../ui/time-bar';
import {
  hideLegend,
  LEGEND_ORDER,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';
import { escapeHtml } from '../util/escape';
import { fetchWithBudget } from '../util/fetch';

const CONTROLLER_KEY = 'usdm';
export const BC_DROUGHT_SOURCE_ID = 'bc-drought-basins';
export const BC_DROUGHT_FILL_ID = 'bc-drought-fill';
export const BC_DROUGHT_OUTLINE_ID = 'bc-drought-outline';

const FETCH_TIMEOUT_MS = 25_000;
const BEFORE_ID = 'first-symbol';
const FILL_OPACITY = 0.54;
const OUTLINE_OPACITY = 0.48;

let masterController: AbortController | null = null;
let sourceDate: string | null = null;

const COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'DroughtLevel'],
  0,
  BC_DROUGHT_LEVELS[0]!.color,
  1,
  BC_DROUGHT_LEVELS[1]!.color,
  2,
  BC_DROUGHT_LEVELS[2]!.color,
  3,
  BC_DROUGHT_LEVELS[3]!.color,
  4,
  BC_DROUGHT_LEVELS[4]!.color,
  5,
  BC_DROUGHT_LEVELS[5]!.color,
  BC_DROUGHT_NO_UPDATE.value,
  BC_DROUGHT_NO_UPDATE.color,
  'rgba(0,0,0,0)'
];

export function buildBcDroughtQueryUrl(): string {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,BasinName,DroughtLevel,Date_Modified',
    outSR: '4326',
    f: 'geojson',
    maxAllowableOffset: '0.01',
    geometryPrecision: '4'
  });
  return `${URLS.bcDroughtLevelsFeatureServer}/query?${params.toString()}`;
}

function formatSourceDate(value: unknown): string | null {
  const milliseconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function validateFeatureCollection(
  value: unknown
): GeoJSON.FeatureCollection {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { type?: unknown }).type !== 'FeatureCollection' ||
    !Array.isArray((value as { features?: unknown }).features)
  ) {
    throw new Error('British Columbia response is not a FeatureCollection.');
  }
  const collection = value as GeoJSON.FeatureCollection;
  for (const feature of collection.features) {
    const properties = feature.properties ?? {};
    const level = Number(properties['DroughtLevel']);
    const name = properties['BasinName'];
    const date = formatSourceDate(properties['Date_Modified']);
    if (
      !Number.isInteger(level) ||
      (!BC_DROUGHT_LEVELS.some((entry) => entry.value === level) &&
        level !== BC_DROUGHT_NO_UPDATE.value)
    ) {
      throw new Error(`British Columbia response contains unknown level ${String(level)}.`);
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('British Columbia response contains an unnamed basin.');
    }
    if (date === null) {
      throw new Error('British Columbia response contains a basin without a source date.');
    }
  }
  return collection;
}

function latestSourceDate(collection: GeoJSON.FeatureCollection): string | null {
  let latest: string | null = null;
  for (const feature of collection.features) {
    const date = formatSourceDate(feature.properties?.['Date_Modified']);
    if (date !== null && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

function showBcLegend(date: string | null): void {
  const dateText = date ?? 'unavailable';
  showLegend(CONTROLLER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) =>
      renderSwatchLegend(
        body,
        'British Columbia basin drought levels',
        [...BC_DROUGHT_LEVELS, BC_DROUGHT_NO_UPDATE].map((entry) => ({
          color: entry.color,
          label:
            entry.value === BC_DROUGHT_NO_UPDATE.value
              ? `${entry.code} · ${entry.label}`
              : entry.label
        })),
        `Province of British Columbia · source date ${dateText} · provincial scale, not D0 through D4`
      )
  });
}

function showBcTimeBar(date: string | null): void {
  setTimeBar(CONTROLLER_KEY, {
    ariaLabel: 'British Columbia basin drought levels source date',
    stamp: {
      headline: date === null ? 'Source date unavailable' : `Source date ${date}`,
      detail:
        'Province of British Columbia · weekly in the core drought season · No update means not measured right now',
      register: 'observed'
    }
  });
}

function installMapState(
  map: maplibregl.Map,
  collection: GeoJSON.FeatureCollection
): void {
  if (!map.getSource(BC_DROUGHT_SOURCE_ID)) {
    map.addSource(BC_DROUGHT_SOURCE_ID, {
      type: 'geojson',
      data: collection,
      attribution: 'Province of British Columbia'
    });
  }
  const beforeId = map.getLayer(BEFORE_ID) ? BEFORE_ID : undefined;
  if (!map.getLayer(BC_DROUGHT_FILL_ID)) {
    map.addLayer(
      {
        id: BC_DROUGHT_FILL_ID,
        type: 'fill',
        source: BC_DROUGHT_SOURCE_ID,
        paint: {
          'fill-color': COLOR_EXPRESSION,
          'fill-opacity': FILL_OPACITY
        }
      },
      beforeId
    );
  }
  if (!map.getLayer(BC_DROUGHT_OUTLINE_ID)) {
    map.addLayer(
      {
        id: BC_DROUGHT_OUTLINE_ID,
        type: 'line',
        source: BC_DROUGHT_SOURCE_ID,
        paint: {
          'line-color': COLOR_EXPRESSION,
          'line-opacity': OUTLINE_OPACITY,
          'line-width': 0.6
        }
      },
      beforeId
    );
  }
}

function levelRead(level: unknown): { title: string; description: string } {
  const numeric = Number(level);
  if (numeric === BC_DROUGHT_NO_UPDATE.value) {
    return {
      title: 'No update',
      description:
        'This basin is not measured right now because it is outside the core drought season. This is not a drought severity.'
    };
  }
  const entry = BC_DROUGHT_LEVELS.find((candidate) => candidate.value === numeric);
  if (!entry) {
    return {
      title: 'Level unavailable',
      description: 'The source did not provide a recognized provincial drought level.'
    };
  }
  return {
    title: entry.label,
    description:
      `Province scale ${entry.label}; this value is not equivalent to a United States Drought Monitor D-category.`
  };
}

function buildPopupHtml(properties: GeoJsonProperties): string {
  const values = properties ?? {};
  const basin =
    typeof values['BasinName'] === 'string' && values['BasinName'].trim() !== ''
      ? values['BasinName'].trim()
      : 'Unnamed basin';
  const read = levelRead(values['DroughtLevel']);
  const date = formatSourceDate(values['Date_Modified']);
  return `
    <div class="popup-title">${escapeHtml(basin)}: ${escapeHtml(read.title)}</div>
    <div class="popup-agency">Province of British Columbia</div>
    <div class="popup-treaty-meta">Source date: ${escapeHtml(date ?? 'unavailable')}</div>
    <div class="popup-description">${escapeHtml(read.description)}</div>
    <div class="popup-treaty-meta">Updated weekly during the core drought season.</div>
    <div class="popup-links">
      <a href="https://www.arcgis.com/home/item.html?id=f1842161d9c2454a98f9fc3b45d5d92e" target="_blank" rel="noopener">British Columbia drought levels source</a>
    </div>
  `;
}

export async function activate(map: maplibregl.Map): Promise<void> {
  if (map.getSource(BC_DROUGHT_SOURCE_ID)) {
    registry.setStatus(CONTROLLER_KEY, 'ready');
    return;
  }
  masterController?.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  registry.setStatus(CONTROLLER_KEY, 'loading');

  let collection: GeoJSON.FeatureCollection;
  try {
    const response = await fetchWithBudget(
      buildBcDroughtQueryUrl(),
      null,
      signal,
      FETCH_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    collection = validateFeatureCollection(await response.json());
  } catch (error) {
    if (signal.aborted) return;
    console.warn('[bc-drought] basin drought-level fetch failed.', error);
    registry.setStatus(CONTROLLER_KEY, 'error');
    return;
  }
  if (signal.aborted) return;

  sourceDate = latestSourceDate(collection);
  setDroughtSurfacePresentation({
    edition: 'bc-basin',
    name: 'British Columbia Basin Drought Levels',
    source: `Province of British Columbia · source date ${sourceDate ?? 'unavailable'}`,
    sourceDate
  });
  showBcLegend(sourceDate);
  showBcTimeBar(sourceDate);

  if (collection.features.length === 0) {
    registry.setStatus(CONTROLLER_KEY, 'no-data');
    return;
  }

  installMapState(map, collection);
  registry.setStatus(CONTROLLER_KEY, 'ready');
}

export function cancelActivation(): void {
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  masterController?.abort();
  masterController = null;
  if (map.getLayer(BC_DROUGHT_FILL_ID)) map.removeLayer(BC_DROUGHT_FILL_ID);
  if (map.getLayer(BC_DROUGHT_OUTLINE_ID)) map.removeLayer(BC_DROUGHT_OUTLINE_ID);
  if (map.getSource(BC_DROUGHT_SOURCE_ID)) map.removeSource(BC_DROUGHT_SOURCE_ID);
  sourceDate = null;
  clearTimeBar(CONTROLLER_KEY);
  hideLegend(CONTROLLER_KEY);
}

export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [BC_DROUGHT_FILL_ID],
    label: (feature) => {
      const name = feature.properties?.['BasinName'];
      return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
    },
    respond: (feature) => ({
      content: buildPopupHtml(feature.properties ?? {})
    })
  });
  map.on('mouseenter', BC_DROUGHT_FILL_ID, () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', BC_DROUGHT_FILL_ID, () => {
    map.getCanvas().style.cursor = '';
  });
}
