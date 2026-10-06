import { LAYER_DEFS } from '../config/layers';
import { TRIBAL_NATIONS_PROVENANCE_NOTE } from '../config/provenance';
import { getBasemapMode, onBasemapChange } from '../state/basemap-store';
import { getMap } from '../state/map-store';
import { registry } from '../state/registry';
import { openAcknowledgements } from './impact-panel';
import { isChecked } from './island/bridge';
import { resolveStatusPillText } from './island/pill-text';
import { watchDesktopMapSeat } from './map-control-seat';
import { onSheetDetentSettle } from './mobile-sheet';

const MOBILE_MAP_QUERY = '(max-width: 720px)';
/**
 * The style sources whose data is OpenStreetMap's (S30D D1 M22; DR-162):
 * the OSM raster ground (`src/map/style.ts`) and the Overpass hydrography
 * (`src/layers/hydrography.ts`). Both leave with OSM in D8 (DDM-P17-T04).
 */
const OSM_SOURCE_IDS = ['basemap', 'hydrography'] as const;
const TRIBAL_REFERENCE_KEYS = new Set([
  'aiannh',
  'bia-reservations',
  'tribal',
  'treaty'
]);

let disposeMapInformation: (() => void) | null = null;

/** Help's accessible name in the desktop column, where the word Help shows. */
const DESKTOP_HELP_NAME = 'Help and map information';
/** Its name at home: the word-less phone and embed disclosure. */
const HOME_HELP_NAME = 'Map information';

function setObscuredInteractionBlocked(blocked: boolean): void {
  for (const element of document.querySelectorAll<HTMLElement>(
    '#map .maplibregl-canvas-container, #map-bottom-dock'
  )) {
    element.inert = blocked;
  }
}

/**
 * Seat help and its Map information drawer in the desktop column's slot 3
 * (S30D D1 M9; design record interface-chrome-popups-text.md sections 2.3
 * and 2.6). The SAME two nodes move, button first, so the drawer stays the
 * next thing after its trigger in DOM order and every listener, the open
 * state and `aria-expanded` ride along. Phones and embeds keep both nodes
 * in their home right after `#map-info-home`, where the phone and embed
 * rules seat them; the helper decides which applies. Returns a dispose
 * that stops both watchers and returns both nodes home. A host page that
 * trims the seat or the home anchor keeps today's placement.
 */
function seatMapInformationOnDesktop(
  mapContainer: HTMLElement,
  button: HTMLElement,
  panel: HTMLElement
): () => void {
  const seat = document.getElementById('map-info-seat');
  const anchor = document.getElementById('map-info-home');
  if (!seat || !anchor || anchor.parentElement !== mapContainer) return () => {};

  const placeButtonHome = (): void => {
    if (button.parentElement === mapContainer && button.previousElementSibling === anchor) {
      return;
    }
    anchor.insertAdjacentElement('afterend', button);
  };
  const placePanelHome = (): void => {
    // Follow the button when it is home; otherwise hold the anchor's
    // place, and the button's own return lands in front of the panel.
    const after = button.parentElement === mapContainer ? button : anchor;
    if (panel.parentElement === mapContainer && panel.previousElementSibling === after) return;
    after.insertAdjacentElement('afterend', panel);
  };

  // One node, two names. In the column the button shows the word Help, so
  // its name leads with that word (WCAG 2.5.3, label in name; the design
  // record's name table, section 2.3). At home it is the round,
  // word-less phone and embed disclosure, whose name stays as it was.
  const nameForSeat = (): void => {
    const name =
      button.parentElement === seat ? DESKTOP_HELP_NAME : HOME_HELP_NAME;
    if (button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name);
  };
  const nameObserver = new MutationObserver(nameForSeat);
  nameObserver.observe(seat, { childList: true });

  const releaseButton = watchDesktopMapSeat({
    node: button,
    host: seat,
    home: mapContainer,
    placeHome: placeButtonHome
  });
  const releasePanel = watchDesktopMapSeat({
    node: panel,
    host: seat,
    home: mapContainer,
    placeHome: placePanelHome
  });
  nameForSeat();
  return () => {
    releasePanel();
    releaseButton();
    nameObserver.disconnect();
    nameForSeat();
  };
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

  const releaseDesktopSeat = seatMapInformationOnDesktop(mapContainer, button, panel);
  const mobileQuery = window.matchMedia(MOBILE_MAP_QUERY);
  let open = false;

  const render = (): void => {
    const active = registry.getActiveKeys();
    // W2-D6: a source whose activation is still in flight is listed with
    // its loading status instead of being dropped; a deactivated source
    // (including a failed activation the controller unchecked) keeps its
    // honest absence. A failed activation that stays checked (a recipe
    // member of the committed cluster, D1 M5, 2026-09-27) is listed with
    // its unavailable status: the view asks for it and could not read it.
    const definitions = LAYER_DEFS.filter((definition) => {
      const status = registry.getStatus(definition.key);
      return (
        active.has(definition.key) ||
        status === 'loading' ||
        (status === 'error' && isChecked(definition.key))
      );
    });
    const vintage = document.getElementById('basemap-vintage')?.textContent?.trim() ?? '';

    // W2-D8: the opening line leads with what this panel uniquely adds
    // (the active view and the basemap state with its observation window)
    // instead of restating the on-map key's aria text verbatim while that
    // key is visible directly beneath the panel.
    // The fallback names a surface still loading, never one that failed.
    const surface =
      definitions.find(
        (definition) => definition.role === 'surface' && active.has(definition.key)
      ) ??
      definitions.find(
        (definition) =>
          definition.role === 'surface' && registry.getStatus(definition.key) === 'loading'
      );
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

    // S30D D1 M22 (DDM-P7-T11; DR-106 Q-CREDIT): the credits line is a
    // pointer to the acknowledgements section now, built once below; the
    // one OpenStreetMap credit rides the map itself (renderOsmCredit).
    renderOsmCredit();
  };

  // The pointer (design record acknowledgements-table.md section 4.1): the
  // credits line and the sidebar footer each carry one button that opens
  // the acknowledgements section. The panel closes first, so focus comes
  // back to the Help button, which stays in the chrome; the footer's own
  // button takes focus back from there.
  const pointerButtons: HTMLButtonElement[] = [];
  const buildPointer = (host: HTMLElement, lead: string, tail: string): void => {
    const pointer = document.createElement('button');
    pointer.type = 'button';
    pointer.className = 'map-info-ack-link';
    pointer.dataset['openAcknowledgements'] = '';
    pointer.textContent = 'Acknowledgements';
    host.replaceChildren(lead, pointer, tail);
    pointerButtons.push(pointer);
  };
  // DRAFT wording (DR-177)
  buildPointer(attribution, 'Credits for every data source are in ', '.');
  const footerCredits = document.getElementById('footer-credits');
  // DRAFT wording (DR-177)
  if (footerCredits) buildPointer(footerCredits, 'Data sources and credits: ', '');
  const onPointerClick = (event: MouseEvent): void => {
    const pointer = event.currentTarget as HTMLButtonElement;
    const fromPanel = panel.contains(pointer);
    if (fromPanel) setOpen(false, false);
    openAcknowledgements(fromPanel ? button : pointer);
  };
  for (const pointer of pointerButtons) pointer.addEventListener('click', onPointerClick);

  // The one OpenStreetMap credit (DR-117, DR-162; found-027): on the map,
  // in the bottom dock (a seat disjoint from every chrome seat), exactly
  // while a source whose data is OpenStreetMap's draws. The string is the
  // source's own first-party attribution HTML (src/map/style.ts, the
  // hydrography layer), read live from the style, never retyped here.
  const osmCredit = document.createElement('p');
  osmCredit.id = 'map-osm-credit';
  osmCredit.className = 'map-osm-credit';
  osmCredit.hidden = true;
  const dockFoot = bottomDock?.querySelector('.map-dock-foot') ?? null;
  if (bottomDock) bottomDock.insertBefore(osmCredit, dockFoot);
  function renderOsmCredit(): void {
    const activeMap = getMap();
    const style = activeMap?.getStyle();
    let credit: string | null = null;
    if (activeMap && style) {
      for (const sourceId of OSM_SOURCE_IDS) {
        const source = style.sources[sourceId] as { attribution?: unknown } | undefined;
        const drawing = style.layers.some(
          (layer) =>
            'source' in layer &&
            layer.source === sourceId &&
            layer.layout?.visibility !== 'none'
        );
        if (drawing && typeof source?.attribution === 'string' && source.attribution.trim() !== '') {
          credit = source.attribution;
          break;
        }
      }
    }
    if (credit === null) {
      osmCredit.hidden = true;
      return;
    }
    if (osmCredit.innerHTML !== credit) osmCredit.innerHTML = credit;
    osmCredit.hidden = false;
  }

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
    for (const pointer of pointerButtons) pointer.removeEventListener('click', onPointerClick);
    osmCredit.remove();
    document.removeEventListener('keydown', onKeyDown);
    mobileQuery.removeEventListener('change', onMobileChange);
    mapContainer.style.removeProperty('--mobile-ruler-width');
    releaseDesktopSeat();
  };
}
