/**
 * The view shell (U1, D-ARCH-002: "answer-first, two doors").
 *
 * Owns the mode chrome around the Brief/console split: the header mode
 * switch, the Brief head (the lede, the place picker, and the console
 * door), the `#app` mode classes the stylesheet keys off, and the
 * answer-first boot (a Brief boot opens the active region's briefing
 * immediately; Brief never opens on an empty state, D-0.7.0-006).
 *
 * The mode itself lives in `src/state/view-mode.ts` (URL-derived at
 * boot, `view=` round-tripped by the sidebar's URL sync). BRIEF leads
 * with the briefing and keeps the catalog beneath the Brief head as the
 * drill-down (answer-first, layers-SECOND, not layers-never); CONSOLE
 * is the full instrument. Deeper console reshaping (the region grid
 * demoting to a jump-to list, the searchable catalog) is U3
 * (D-0.7.0-009), not here.
 *
 * The mode swap crossfades via the View Transitions API where present,
 * guarded by prefers-reduced-motion (headroom B5); without support it
 * is an instant swap, which is also the reduced-motion behavior.
 *
 * Stewardship: the place picker routes through `openStateBriefing`,
 * which builds the same boundary context a map click would; no Tribal,
 * Treaty, or sovereign-jurisdiction data is surfaced by this module.
 */

import type maplibregl from 'maplibre-gl';

import { REGIONS } from '../config/regions';
import { openStateBriefing } from '../state/deep-link';
import { getPlaceSelection } from '../state/place-selection';
import { getCurrentRegion } from '../state/region-store';
import { getViewMode, onViewModeChange, setViewMode } from '../state/view-mode';
import type { ViewMode } from '../state/view-mode';
import {
  closeImpactPanel,
  isCurrentBriefingIntent,
  nextBriefingIntent,
  openImpactPanel
} from './impact-panel';
import { prefersReducedMotion } from '../util/motion';

/**
 * Apply the mode to the app shell: the `view-brief`/`view-console`
 * classes (the stylesheet's hook) and the Brief head's visibility.
 */
function applyModeClass(mode: ViewMode): void {
  const app = document.getElementById('app');
  if (app) {
    app.classList.toggle('view-brief', mode === 'brief');
    app.classList.toggle('view-console', mode === 'console');
  }
  const head = document.getElementById('brief-head');
  if (head) head.hidden = mode !== 'brief';
}

/** Reflect the mode into the header switch's pressed states. */
function updateModeSwitch(mode: ViewMode): void {
  document
    .querySelectorAll<HTMLButtonElement>('.view-switch [data-view]')
    .forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset['view'] === mode ? 'true' : 'false');
    });
}

/**
 * Open the Brief answer: the selected map place if one is current,
 * otherwise the active region's briefing anchor. Brief never opens on
 * an empty state (D-0.7.0-006); a region without an anchor (none of the
 * shipped regions) simply leaves the panel closed rather than faking one.
 *
 * The anchor path resolves after an async boundary fetch, so it always
 * carries a yield guard: the intent is declared at call time, and any
 * NEWER intent or panel interaction in the fetch window wins over it
 * (last intent wins, regardless of fetch resolve order).
 */
function openBriefAnswer(map: maplibregl.Map): void {
  const place = getPlaceSelection();
  if (place) {
    openImpactPanel(place.context);
    return;
  }
  const region = getCurrentRegion();
  const anchor = region ? REGIONS[region]?.briefing : undefined;
  if (!anchor) return;
  const intent = nextBriefingIntent();
  void openStateBriefing(map, anchor.id, {
    fit: false,
    guard: () => isCurrentBriefingIntent(intent)
  });
}

/**
 * Switch modes with a crossfade. The mutation flips the store (whose
 * subscribers apply the classes, re-sync the URL, and mount the island
 * if needed) and swaps the briefing panel to match the door: console is
 * the map, so the panel closes; Brief is the answer, so it opens.
 */
function switchMode(map: maplibregl.Map, mode: ViewMode): void {
  if (mode === getViewMode()) return;
  const mutate = (): void => {
    setViewMode(mode);
    if (mode === 'console') {
      closeImpactPanel();
    } else {
      openBriefAnswer(map);
    }
  };
  const doc = document as Document & {
    startViewTransition?: (update: () => void) => unknown;
  };
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    doc.startViewTransition(() => {
      mutate();
    });
  } else {
    mutate();
  }
}

/** Build the two-button mode switch into the sidebar header. */
function buildModeSwitch(map: maplibregl.Map): void {
  const header = document.querySelector('.sidebar-header');
  const collapseBtn = document.getElementById('sidebar-collapse');
  if (!header || !collapseBtn) return;

  const group = document.createElement('div');
  group.className = 'view-switch';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'View');
  group.innerHTML = `
    <button type="button" data-view="brief" aria-pressed="false" title="The briefing-led view">Brief</button>
    <button type="button" data-view="console" aria-pressed="false" title="The full map and layers view">Console</button>
  `;
  group.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset['view'];
      if (target === 'brief' || target === 'console') switchMode(map, target);
    });
  });
  header.insertBefore(group, collapseBtn);
  updateModeSwitch(getViewMode());
}

/**
 * Fill the Brief head: the lede, the ONE search (U3, replacing the U1 stopgap
 * state `<select>`), and the console door. The search is the shared component
 * (places + Tribal land areas + layers), the same one the console catalog and
 * the mobile sheet mount, so a person types one box wherever they are.
 */
function buildBriefHead(map: maplibregl.Map): void {
  const head = document.getElementById('brief-head');
  if (!head) return;

  head.innerHTML = `
    <h2 class="panel-title">Drought briefing</h2>
    <p class="brief-head-lede">What does the current drought mean for a place? Search a place, a Tribal land area, or a layer, or select a boundary on the map, and the briefing answers with conditions, outlooks, and resources.</p>
    <div id="brief-search"></div>
    <button type="button" id="brief-console-door" class="brief-console-door">Open the map &amp; layers console</button>
  `;

  const door = head.querySelector<HTMLButtonElement>('#brief-console-door');
  door?.addEventListener('click', () => {
    switchMode(map, 'console');
  });

  mountBriefSearch(map);
}

/**
 * Mount the shared search into the Brief head. Gated by the C1 rule: a brief
 * embed never downloads the island / search chunk at BOOT (the Brief head
 * chrome is not the embed's surface). The embed-exit path (the sidebar
 * expand control) calls back through `ensureBriefHeadSearch` once the embed
 * class is gone, so an exited embed gets the head search without a reload
 * (the U3 stage-5 minor 7 fix). Every other boot has the island mounted
 * already, so the extra chunk is free. Mounting is idempotent: the search
 * renders into a dedicated container and a re-render replaces it.
 */
function mountBriefSearch(map: maplibregl.Map): void {
  const isEmbed = document.getElementById('app')?.classList.contains('embed') ?? false;
  if (isEmbed && getViewMode() === 'brief') return;
  const container = document.getElementById('brief-search');
  if (!container) return;
  void import('./search-controller').then(({ mountSearchInto }) => {
    mountSearchInto(map, container);
  });
}

/**
 * Public seam for the embed-exit path: mount the Brief-head search if the
 * boot-time C1 gate skipped it (a brief embed) and the app has since left
 * embed mode. Safe to call repeatedly.
 */
export function ensureBriefHeadSearch(map: maplibregl.Map): void {
  mountBriefSearch(map);
}

/**
 * Initialize the view shell. Called once from boot, after the sidebar
 * (which seeds the mode from the URL) and before the deep link applies
 * (a `select=` deep link opens its own briefing, so the answer-first
 * boot must not double-open; the caller says whether one is present).
 */
export function initViewShell(
  map: maplibregl.Map,
  opts: { hasSelectDeepLink: boolean }
): void {
  buildModeSwitch(map);
  buildBriefHead(map);
  applyModeClass(getViewMode());

  onViewModeChange((mode) => {
    applyModeClass(mode);
    updateModeSwitch(mode);
  });

  if (getViewMode() === 'brief' && !opts.hasSelectDeepLink) {
    openBriefAnswer(map);
  }
}
