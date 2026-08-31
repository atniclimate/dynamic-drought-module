import { LAYER_DEFS } from '../config/layers';
import { TRIBAL_NATIONS_PROVENANCE_NOTE } from '../config/provenance';
import { getBasemapMode, onBasemapChange } from '../state/basemap-store';
import { getMap } from '../state/map-store';
import { registry } from '../state/registry';
import { resolveStatusPillText } from './island/pill-text';
import { onSheetDetentSettle } from './mobile-sheet';

const MOBILE_MAP_QUERY = '(max-width: 720px)';
const TRIBAL_REFERENCE_KEYS = new Set([
  'aiannh',
  'bia-reservations',
  'tribal',
  'treaty'
]);

let disposeMapInformation: (() => void) | null = null;

function setObscuredInteractionBlocked(blocked: boolean): void {
  for (const element of document.querySelectorAll<HTMLElement>(
    '#map .maplibregl-canvas-container, #map-bottom-dock'
  )) {
    element.inert = blocked;
  }
}

/**
 * Wire the mobile map-information disclosure to the canonical layer registry.
 * Its open state is deliberately ephemeral and never enters URL state.
 */
export function initMapInformation(): void {
  disposeMapInformation?.();

  const app = document.getElementById('app');
  const mapContainer = document.getElementById('map-container');
  const button = document.getElementById('map-info-btn') as HTMLButtonElement | null;
  const panel = document.getElementById('map-info-panel');
  const current = document.getElementById('map-info-current');
  const sources = document.getElementById('map-info-sources');
  const tribal = document.getElementById('map-info-tribal') as HTMLDetailsElement | null;
  const tribalNote = document.getElementById('map-info-tribal-note');
  const attribution = document.getElementById('map-info-attribution');
  const mapKey = document.getElementById('map-key');
  const bottomDock = document.getElementById('map-bottom-dock');

  if (
    !app ||
    !mapContainer ||
    !button ||
    !panel ||
    !current ||
    !sources ||
    !tribal ||
    !tribalNote ||
    !attribution
  ) {
    return;
  }

  const mobileQuery = window.matchMedia(MOBILE_MAP_QUERY);
  let open = false;

  const render = (): void => {
    const active = registry.getActiveKeys();
    // W2-D6: a source whose activation is still in flight is listed with
    // its loading status instead of being dropped; a deactivated source
    // (including a failed activation the controller unchecked) keeps its
    // honest absence.
    const definitions = LAYER_DEFS.filter(
      (definition) =>
        active.has(definition.key) ||
        registry.getStatus(definition.key) === 'loading'
    );
    const vintage = document.getElementById('basemap-vintage')?.textContent?.trim() ?? '';

    // W2-D8: the opening line leads with what this panel uniquely adds
    // (the active view and the basemap state with its observation window)
    // instead of restating the on-map key's aria text verbatim while that
    // key is visible directly beneath the panel.
    const surface =
      definitions.find(
        (definition) => definition.role === 'surface' && active.has(definition.key)
      ) ?? definitions.find((definition) => definition.role === 'surface');
    const contextParts = [
      surface ? `Active view: ${surface.name}.` : 'No condition surface is on.',
      getBasemapMode() === 'satellite'
        ? `Satellite imagery basemap.${vintage ? ` ${vintage}` : ''}`
        : 'Default OpenStreetMap basemap.'
    ];
    current.textContent = contextParts.join(' ');

    sources.replaceChildren();
    for (const definition of definitions) {
      const item = document.createElement('li');
      const name = document.createElement('strong');
      const source = document.createElement('span');
      name.textContent = definition.name;
      source.textContent = definition.source;
      item.append(name, source);

      const status = registry.getStatus(definition.key);
      if (status) {
        const state = document.createElement('span');
        state.className = 'map-info-source-state';
        state.textContent = resolveStatusPillText(status, definition.noDataLabel);
        item.append(state);
      }
      sources.append(item);
    }

    const hasTribalReference = definitions.some((definition) =>
      TRIBAL_REFERENCE_KEYS.has(definition.key)
    );
    tribal.hidden = !hasTribalReference;
    tribalNote.textContent = hasTribalReference
      ? TRIBAL_NATIONS_PROVENANCE_NOTE
      : '';

    // The license credits (owner direction, 2026-08-31): the exact
    // per-source attribution strings MapLibre's removed control would have
    // shown, read live from the style so a source added by a lazy layer
    // chunk credits itself the moment it exists. The strings are
    // first-party HTML declared at addSource time (they carry the license
    // links, e.g. the OpenStreetMap contributors link), which is why this
    // is innerHTML and every string stays issuer-verbatim. A source whose
    // layers were toggled off may keep its credit until removal; an extra
    // credit is honest, a missing one is not.
    const style = getMap()?.getStyle();
    const credits: string[] = [];
    if (style) {
      for (const source of Object.values(style.sources)) {
        const text = (source as { attribution?: unknown }).attribution;
        if (typeof text === 'string' && text.trim() !== '' && !credits.includes(text)) {
          credits.push(text);
        }
      }
    }
    attribution.innerHTML = credits.join(' | ');
  };

  const setOpen = (next: boolean, returnFocus = true): void => {
    open = next;
    app.toggleAttribute('data-map-info-open', next);
    button.setAttribute('aria-expanded', String(next));
    panel.hidden = !next;
    setObscuredInteractionBlocked(next);

    if (next) {
      render();
      window.requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    } else if (returnFocus && button.isConnected) {
      button.focus({ preventScroll: true });
    }
  };

  const updateRulerWidth = (): void => {
    const widths = Array.from(
      document.querySelectorAll<HTMLElement>('.maplibregl-ctrl-scale')
    ).map((scale) => scale.getBoundingClientRect().width);
    const width = Math.ceil(Math.max(0, ...widths));
    if (width > 0) {
      mapContainer.style.setProperty('--mobile-ruler-width', `${width}px`);
    }
  };

  const rulerObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(updateRulerWidth)
      : null;
  for (const scale of document.querySelectorAll<HTMLElement>(
    '.maplibregl-ctrl-scale'
  )) {
    rulerObserver?.observe(scale);
  }
  updateRulerWidth();

  const contentObserver = new MutationObserver(render);
  if (mapKey) {
    contentObserver.observe(mapKey, {
      attributes: true,
      attributeFilter: ['aria-label', 'hidden'],
      childList: true,
      subtree: true
    });
  }
  if (bottomDock) {
    contentObserver.observe(bottomDock, { childList: true, subtree: true });
  }

  const onButtonClick = (): void => setOpen(!open);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    setOpen(false);
  };
  const onMobileChange = (): void => {
    if (!mobileQuery.matches && open) setOpen(false, false);
  };

  button.addEventListener('click', onButtonClick);
  document.addEventListener('keydown', onKeyDown);
  mobileQuery.addEventListener('change', onMobileChange);
  const releaseLayers = registry.on('change', render);
  const releaseStatuses = registry.on('status-change', render);
  const releaseBasemap = onBasemapChange(render);
  const releaseSheet = onSheetDetentSettle((detent) => {
    if ((detent === 'half' || detent === 'full') && open) {
      setOpen(false, false);
    }
  });

  render();

  disposeMapInformation = () => {
    setOpen(false, false);
    rulerObserver?.disconnect();
    contentObserver.disconnect();
    releaseLayers();
    releaseStatuses();
    releaseBasemap();
    releaseSheet();
    button.removeEventListener('click', onButtonClick);
    document.removeEventListener('keydown', onKeyDown);
    mobileQuery.removeEventListener('change', onMobileChange);
    mapContainer.style.removeProperty('--mobile-ruler-width');
  };
}
