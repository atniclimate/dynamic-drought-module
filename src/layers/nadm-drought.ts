/**
 * North American Drought Monitor (NADM) continental monthly context.
 *
 * This is a separate tri-national consensus surface. It is never blended or
 * crosswalked with the weekly United States Drought Monitor, the Canadian
 * Drought Monitor, or Province of British Columbia basin levels. The upstream
 * publishes no per-feature country or issuing-agency attribute, so popups name
 * the product and never infer an issuer from polygon location.
 */

import type * as maplibregl from 'maplibre-gl';
import type { GeoJsonProperties } from 'geojson';

import { NADM_CATEGORIES } from '../config/palette';
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
import {
  fetchSharedJsonWithBudget,
  invalidateSharedJsonRequest
} from '../util/fetch';
import { validateNadmCollection } from '../util/nadm-collection';

const LAYER_KEY = 'nadm-drought';
const SOURCE_ID = 'nadm-drought-areas';
const FILL_ID = 'nadm-drought-fill';
const BEFORE_ID = 'first-symbol';
const FILL_OPACITY = 0.48;
const SNAPSHOT_EVENT = 'ddm:nadm-snapshot';
const CLASS_CODES = ['d0', 'd1', 'd2', 'd3', 'd4'] as const;

export const fadeLayerIds = [FILL_ID] as const;

type ClassCode = (typeof CLASS_CODES)[number];

interface NadmSnapshot {
  readonly month: string;
  readonly collection: GeoJSON.FeatureCollection;
}

let masterController: AbortController | null = null;
let activeSnapshot: NadmSnapshot | null = null;

const COLOR_EXPRESSION: maplibregl.ExpressionSpecification = [
  'match',
  ['downcase', ['to-string', ['get', 'DROUGHTCAT']]],
  'd0',
  NADM_CATEGORIES[0]!.color,
  'd1',
  NADM_CATEGORIES[1]!.color,
  'd2',
  NADM_CATEGORIES[2]!.color,
  'd3',
  NADM_CATEGORIES[3]!.color,
  'd4',
  NADM_CATEGORIES[4]!.color,
  'rgba(0,0,0,0)'
];

/**
 * The layer's reading of the shared payload: the one structural verdict in
 * `src/util/nadm-collection.ts` (also the minimap's, so the two consumers
 * of the `'nadm-current'` transport can never disagree about what to evict),
 * with `empty` reported as `null`, the layer's honest `no-data` state.
 * Exported for the pure agreement spec (`tests/nadm-shared-payload.spec.ts`).
 * Throws on a malformed payload; the caller evicts the shared entry then.
 */
export function validateNadmSnapshot(value: unknown): NadmSnapshot | null {
  const verdict = validateNadmCollection(value);
  if (verdict.kind === 'empty') return null;
  return {
    month: verdict.month,
    collection: value as unknown as GeoJSON.FeatureCollection
  };
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year!, monthNumber! - 1, 1)));
}

function showNadmLegend(month: string): void {
  showLegend(LAYER_KEY, {
    order: LEGEND_ORDER.surface,
    render: (body) => {
      renderSwatchLegend(
        body,
        `North American Drought Monitor · ${monthLabel(month)}`,
        NADM_CATEGORIES.map((entry) => ({
          color: entry.color,
          label: `${entry.code} · ${entry.label}`
        }))
      );
      const caveat = document.createElement('p');
      caveat.className = 'legend-semantic-note sr-only';
      caveat.textContent =
        'Tri-national monthly consensus; published 2 to 3 weeks after month-end; no polygon means no coverage from this source, not class zero.';
      body.appendChild(caveat);
    }
  });
}

function showNadmTimeBar(month: string): void {
  setTimeBar(LAYER_KEY, {
    ariaLabel: 'North American Drought Monitor consensus month',
    stamp: {
      headline: `Consensus month ${monthLabel(month)}`,
      detail:
        'North American Drought Monitor · tri-national monthly consensus · published 2 to 3 weeks after month-end',
      register: 'observed'
    }
  });
}

function dispatchSnapshot(status: 'ready' | 'inactive', month: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(SNAPSHOT_EVENT, {
      detail: { status, month }
    })
  );
}

function installMapState(
  map: maplibregl.Map,
  collection: GeoJSON.FeatureCollection
): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: collection,
      attribution:
        'North American Drought Monitor (NADM), tri-national consensus; NCEI hosting'
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
}

export async function activate(map: maplibregl.Map): Promise<void> {
  if (activeSnapshot !== null) {
    registry.setStatus(LAYER_KEY, 'ready');
    return;
  }
  masterController?.abort();
  masterController = new AbortController();
  const signal = masterController.signal;
  registry.setStatus(LAYER_KEY, 'loading');

  let snapshot: NadmSnapshot | null;
  try {
    snapshot = validateNadmSnapshot(
      await fetchSharedJsonWithBudget(
        'nadm-current',
        URLS.nadmCurrentGeojson,
        { cache: 'no-store' },
        signal,
        15_000
      )
    );
  } catch (error) {
    if (signal.aborted) return;
    invalidateSharedJsonRequest('nadm-current');
    console.warn('[nadm-drought] continental GeoJSON load failed.', error);
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  if (signal.aborted) return;

  if (snapshot === null) {
    registry.setStatus(LAYER_KEY, 'no-data');
    return;
  }

  try {
    installMapState(map, snapshot.collection);
  } catch (error) {
    if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    console.warn('[nadm-drought] map installation failed.', error);
    registry.setStatus(LAYER_KEY, 'error');
    return;
  }
  activeSnapshot = snapshot;
  showNadmLegend(snapshot.month);
  showNadmTimeBar(snapshot.month);
  dispatchSnapshot('ready', snapshot.month);
  registry.setStatus(LAYER_KEY, 'ready');
}

export function cancelActivation(): void {
  masterController?.abort();
}

export function deactivate(map: maplibregl.Map): void {
  masterController?.abort();
  masterController = null;
  if (map.getLayer(FILL_ID)) map.removeLayer(FILL_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  activeSnapshot = null;
  hideLegend(LAYER_KEY);
  clearTimeBar(LAYER_KEY);
  dispatchSnapshot('inactive', null);
}

function popupHtml(properties: GeoJsonProperties): string {
  const rawCategory = String(properties?.['DROUGHTCAT'] ?? '').toLowerCase();
  const categoryIndex = CLASS_CODES.indexOf(rawCategory as ClassCode);
  const category = categoryIndex >= 0 ? NADM_CATEGORIES[categoryIndex] : null;
  const sourceMonth = activeSnapshot?.month ?? null;
  return `
    <div class="popup-title">${escapeHtml(category ? `${category.code} · ${category.label}` : 'Unknown class')}</div>
    <div class="popup-agency">North American Drought Monitor · tri-national consensus product</div>
    <div class="popup-treaty-meta">Consensus month: ${escapeHtml(sourceMonth ? monthLabel(sourceMonth) : 'unavailable')}</div>
    <div class="popup-description">Monthly continental context, published 2 to 3 weeks after month-end. This product is not blended with a United States, Canadian, or provincial drought edition.</div>
    <div class="popup-treaty-meta">The source publishes no country or issuing-agency attribute for this polygon. No issuer is inferred from its location.</div>
    <div class="popup-treaty-meta">Areas without a polygon have no coverage from this source; they are not assigned class zero.</div>
    <div class="popup-links">
      <a href="${escapeHtml(URLS.nadmCurrentGeojson)}" target="_blank" rel="noopener">North American Drought Monitor source</a>
    </div>
  `;
}

export function bindPopups(map: maplibregl.Map): void {
  registerClickTarget({
    kind: 'condition-surface',
    layerIds: [FILL_ID],
    label: (feature) => {
      const rawCategory = String(feature.properties?.['DROUGHTCAT'] ?? '').toLowerCase();
      const index = CLASS_CODES.indexOf(rawCategory as ClassCode);
      return index >= 0
        ? `North American Drought Monitor ${NADM_CATEGORIES[index]!.code}`
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
