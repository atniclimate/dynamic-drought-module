import type maplibregl from 'maplibre-gl';

import { URLS } from '../config/urls';
import {
  getBasemapMode,
  onBasemapChange
} from '../state/basemap-store';
import { fetchBufferedWithBudget } from '../util/fetch';
import {
  watchRasterTiles,
  type RasterTileWatch
} from '../util/raster-status';

const SOURCE_ID = 'basemap-ground';
const LAYER_ID = 'basemap-ground';
const CHIP_ID = 'ground-vintage';
const PROBE_TIMEOUT_MS = 5_000;
const TILE_COMPLETENESS_DEADLINE_MS = 8_000;

export type HistoricalGroundStatus =
  | 'loading'
  | 'live'
  | 'live-partial'
  | 'fallback';

let activeDispose: (() => void) | null = null;

function ensureChip(): HTMLElement | null {
  const existing = document.getElementById(CHIP_ID);
  if (existing) return existing;

  const dock = document.getElementById('map-bottom-dock');
  const foot = dock?.querySelector('.map-dock-foot');
  if (!dock || !foot) return null;

  const chip = document.createElement('div');
  chip.id = CHIP_ID;
  chip.className = 'basemap-imagery-chip historical-ground-chip';
  chip.setAttribute('role', 'status');
  chip.setAttribute('aria-live', 'polite');
  chip.setAttribute('aria-atomic', 'true');
  chip.hidden = true;
  dock.insertBefore(chip, foot);
  return chip;
}

function addLinkedText(
  parent: HTMLElement,
  text: string,
  href: string
): void {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = text;
  parent.appendChild(link);
}

function showChip(status: HistoricalGroundStatus): void {
  const chip = ensureChip();
  if (!chip) return;

  chip.dataset.status = status;
  chip.replaceChildren();
  if (status === 'loading') {
    chip.textContent =
      'Historical satellite ground loading; subdued OpenStreetMap fallback is visible.';
  } else if (status === 'fallback') {
    chip.textContent =
      'Historical satellite ground unavailable; subdued OpenStreetMap fallback is showing.';
  } else if (status === 'live') {
    chip.append('Historical ground: ');
    addLinkedText(chip, 'EOxCloudless', 'https://cloudless.eox.at');
    chip.append(' Sentinel-2 2016 by ');
    addLinkedText(chip, 'EOX', 'https://eox.at');
    chip.append('. Historical context, not current conditions.');
  } else {
    chip.append('Historical ground live (partial): ');
    addLinkedText(chip, 'EOxCloudless', 'https://cloudless.eox.at');
    chip.append(' Sentinel-2 2016 by ');
    addLinkedText(chip, 'EOX', 'https://eox.at');
    chip.append(
      '. Some tiles are unavailable; subdued OpenStreetMap fills gaps. Historical context, not current conditions.'
    );
  }
  chip.hidden = getBasemapMode() === 'satellite';
}

function setLayerVisible(
  map: maplibregl.Map,
  status: HistoricalGroundStatus,
  probePassed: boolean
): void {
  if (!map.getLayer(LAYER_ID)) return;
  const visible =
    probePassed && status !== 'fallback' && getBasemapMode() === 'default';
  map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
}

/** A known-data probe must return a supported media type and real image bytes. */
export async function isHistoricalGroundProbeResponse(
  response: Response
): Promise<boolean> {
  if (!response.ok) return false;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    !contentType.startsWith('image/jpeg') &&
    !contentType.startsWith('image/png')
  ) {
    return false;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const jpeg =
    bytes.length >= 64 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const png =
    bytes.length >= 64 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  return contentType.startsWith('image/jpeg') ? jpeg : png;
}

/**
 * Start the historical-ground lifecycle for the one app map. The public EOX
 * service is probed through a bounded, cancellable request before its layer is
 * revealed. OSM already renders underneath, so failure is a disclosed fallback
 * rather than an empty scene. Five source tile errors in one session also
 * retire the historical layer. The disposer supports tests and future map
 * teardown even though the current application owns one lifetime map.
 */
export function initHistoricalGround(map: maplibregl.Map): () => void {
  activeDispose?.();
  const controller = new AbortController();
  let disposed = false;
  let probePassed = false;
  let status: HistoricalGroundStatus = 'loading';
  let tileWatch: RasterTileWatch | null = null;

  const reflect = (): void => {
    if (disposed) return;
    setLayerVisible(map, status, probePassed);
    showChip(status);
  };

  const stopTileWatch = (): void => {
    tileWatch?.detach();
    tileWatch = null;
  };

  const startTileWatch = (): void => {
    if (
      disposed ||
      !probePassed ||
      status === 'fallback' ||
      getBasemapMode() !== 'default' ||
      tileWatch !== null
    ) {
      return;
    }
    status = 'loading';
    tileWatch = watchRasterTiles(
      map,
      SOURCE_ID,
      (outcome) => {
        if (disposed || getBasemapMode() !== 'default') return;
        if (outcome === 'ready') {
          status = 'live';
        } else if (outcome === 'degraded') {
          status = 'live-partial';
        } else {
          status = 'fallback';
          stopTileWatch();
          console.warn(
            '[historical-ground] no complete EOX ground frame loaded; OpenStreetMap fallback is showing.'
          );
        }
        reflect();
      },
      {
        reportInitialSuccess: true,
        requestCompletenessDeadlineMs: TILE_COMPLETENESS_DEADLINE_MS,
        emptyIdleOutcome: 'error'
      }
    );
    reflect();
  };

  const onBasemapModeChange = (): void => {
    if (getBasemapMode() === 'satellite') {
      stopTileWatch();
      reflect();
      return;
    }
    startTileWatch();
    reflect();
  };

  const unsubscribeBasemap = onBasemapChange(onBasemapModeChange);
  reflect();

  void fetchBufferedWithBudget(
    URLS.eoxCloudless2016Probe,
    { cache: 'no-store', credentials: 'omit' },
    controller.signal,
    PROBE_TIMEOUT_MS
  ).then(
    async (response) => {
      if (disposed || controller.signal.aborted) return;
      probePassed = await isHistoricalGroundProbeResponse(response);
      if (disposed || controller.signal.aborted) return;
      if (!probePassed) {
        status = 'fallback';
        reflect();
        return;
      }
      startTileWatch();
    },
    (error: unknown) => {
      if (disposed || controller.signal.aborted) return;
      status = 'fallback';
      reflect();
      console.warn(
        '[historical-ground] EOX probe failed; OpenStreetMap fallback is showing.',
        error
      );
    }
  );

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    stopTileWatch();
    unsubscribeBasemap();
    if (activeDispose === dispose) activeDispose = null;
  };
  activeDispose = dispose;
  return dispose;
}
