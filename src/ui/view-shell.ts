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
import { STATE_LABEL } from '../impact/resources';
import type { StateCode } from '../impact/resources';
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
import { escapeHtml } from '../util/escape';
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
 * Fill the Brief head: the lede, the state place picker (the minimal U1
 * picker; U3 replaces it with the shared search experience), and the
 * console door.
 */
function buildBriefHead(map: maplibregl.Map): void {
  const head = document.getElementById('brief-head');
  if (!head) return;

  const states = (Object.entries(STATE_LABEL) as Array<[StateCode, string]>).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  head.innerHTML = `
    <h2 class="panel-title">Drought briefing</h2>
    <p class="brief-head-lede">What does the current drought mean for a place? Pick a state, or select a boundary on the map, and the briefing answers with conditions, outlooks, and resources.</p>
    <label class="brief-place-label" for="brief-place-select">See the briefing for</label>
    <select id="brief-place-select" class="brief-place-select">
      <option value="">Choose a state...</option>
      ${states
        .map(
          ([code, name]) =>
            `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`
        )
        .join('')}
    </select>
    <button type="button" id="brief-console-door" class="brief-console-door">Open the map &amp; layers console</button>
  `;

  const select = head.querySelector<HTMLSelectElement>('#brief-place-select');
  select?.addEventListener('change', () => {
    const code = select.value;
    if (!code) return;
    // Same yield rule as every async open: the pick declares an intent,
    // and anything newer (another pick, a boundary click, a close) wins
    // over it even if this pick's fetch resolves later.
    const intent = nextBriefingIntent();
    void openStateBriefing(map, code, {
      fit: true,
      guard: () => isCurrentBriefingIntent(intent)
    });
  });

  const door = head.querySelector<HTMLButtonElement>('#brief-console-door');
  door?.addEventListener('click', () => {
    switchMode(map, 'console');
  });
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
