/**
 * The panel-foot selected-place response (S4c; the S4 design record
 * sections 3-4; D-0.7.0-072).
 *
 * The shell's response band: place-bearing map clicks rehost their one
 * coordinated response at the FOOT of the left panel instead of a
 * map-anchored popup, through the coordinator's swappable sink API
 * (src/map/interaction-coordinator.ts, setResponseSink). The content is
 * the SAME assembled element the popup path renders, so the frozen-head
 * / scrolling-body pattern carries over intact: the title, the briefing
 * door, and the "Other map features here" disclosure stay frozen and
 * visible; the FULL Tribal/Treaty representation caveat and source
 * detail scroll WITHIN the foot's own bounded region, never truncated,
 * never abbreviated (the stewardship line, design record section 4),
 * while the panel itself does not scroll.
 *
 * ACTIVE-CLUSTER-AWARE: the foot's own header line names the committed
 * hazard view and horizon from the CommittedShellSnapshot, so the
 * response always reads against the display it sits over.
 *
 * The sink DECLINES (returns false, popup fallback) whenever this foot
 * is not a usable surface: below the 720 px mobile line (the sheet and
 * the coordinator's own mobile route own that world; the shell must not
 * fight them), in embed (hard rule 8: embed behavior unchanged), or
 * with the sidebar collapsed.
 *
 * Usability is ALSO re-checked while a response is presented: if the
 * user collapses the sidebar (a first-class control, hard rule 8) or
 * the viewport crosses the 720 px line while the foot holds the one
 * response, the stylesheet would hide it with the panel while the
 * coordinator still tracked a presented response and a live selection
 * (an invisible response and a stranded emphasized boundary). The
 * transition therefore DISMISSES the response through the coordinator,
 * clearing the selection with it: the map returns to an honest
 * unselected state and the next click re-offers the response on
 * whichever surface then owns it.
 */

import { render } from 'preact';
import { signal } from '@preact/signals';
import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import {
  CLUSTER_DISPLAY_NAMES,
  TEMPORAL_HORIZON_CHIP_LABELS
} from '../../config/clusters';
import {
  dismissResponse,
  setResponseSink
} from '../../map/interaction-coordinator';
import type { StructuredResponse } from '../../map/interaction-coordinator';
import {
  getCommittedSnapshot,
  onCommittedSnapshotChange
} from '../../state/cluster-service';
import type { CommittedShellSnapshot } from '../../state/cluster-service';

/** Whether the panel foot is a usable response surface right now. The
 * foot is a BRIEF-shell surface (the S4 launch pad): console keeps the
 * shipped map-anchored popup (the coordinator contract those specs pin;
 * the console is the instrument view, and its response belongs on the
 * instrument). */
function usable(): boolean {
  const app = document.getElementById('app');
  if (!app) return false;
  return (
    window.matchMedia('(min-width: 721px)').matches &&
    app.classList.contains('view-brief') &&
    !app.classList.contains('embed') &&
    !app.classList.contains('sidebar-collapsed')
  );
}

function clusterLine(snap: CommittedShellSnapshot): string {
  const view =
    snap.cluster === 'custom'
      ? 'Custom layer set'
      : `${CLUSTER_DISPLAY_NAMES[snap.cluster]} view`;
  // One table for the visible horizon wording (src/config/clusters.ts), so
  // this line and the shell's chips can never drift apart.
  return `${view} · ${TEMPORAL_HORIZON_CHIP_LABELS[snap.horizon]}`;
}

interface PanelResponseProps {
  readonly current: ReadonlySignal<StructuredResponse | null>;
  readonly snap: ReadonlySignal<CommittedShellSnapshot>;
}

function PanelResponse({ current, snap }: PanelResponseProps) {
  const response = current.value;
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (response) host.appendChild(response.element);
  }, [response]);

  return (
    <>
      {/* Persistently rendered polite live region (the M8 .sr-only
          idiom): the panel-foot response appears without moving focus,
          so this is the only way a screen-reader user learns a response
          exists. Text swaps; the element never mounts/unmounts. */}
      <span class="sr-only" aria-live="polite">
        {response
          ? `Map selection response: ${response.title ?? 'selected place'}. The response is at the foot of the panel.`
          : ''}
      </span>
      {response && (
        <section class="panel-response-card" aria-label="Map selection response">
          <div class="panel-response-bar">
            <span class="panel-response-context">{clusterLine(snap.value)}</span>
            <button
              type="button"
              class="panel-response-close icon-btn"
              aria-label="Close the selection response"
              onClick={() => dismissResponse()}
            >
              {'×'}
            </button>
          </div>
          <div class="panel-response-host" ref={hostRef}></div>
        </section>
      )}
    </>
  );
}

/**
 * Mount the panel-foot response surface into its static host and
 * install it as the coordinator's response sink. Idempotent per host.
 */
export function mountPanelResponse(host: HTMLElement): void {
  const current = signal<StructuredResponse | null>(null);
  const snap = signal<CommittedShellSnapshot>(getCommittedSnapshot());
  onCommittedSnapshotChange(() => {
    snap.value = getCommittedSnapshot();
  });

  setResponseSink({
    present(response) {
      if (!usable()) return false;
      current.value = response;
      host.toggleAttribute('data-open', true);
      return true;
    },
    dismiss() {
      current.value = null;
      host.toggleAttribute('data-open', false);
    }
  });

  // Usability is a live condition, not a present-time one: a sidebar
  // collapse or a viewport crossing of the 720 px line hides this foot
  // by stylesheet while a response may be presented in it. Dismiss
  // through the coordinator on those transitions (clearing the place
  // selection with it), so no invisible response ever strands an active
  // selection. The #app class list is the collapse/embed signal; the
  // media query is the width signal.
  const dismissIfUnusable = (): void => {
    if (current.value !== null && !usable()) dismissResponse();
  };
  const widthQuery = window.matchMedia('(min-width: 721px)');
  widthQuery.addEventListener('change', dismissIfUnusable);
  const app = document.getElementById('app');
  if (app) {
    new MutationObserver(dismissIfUnusable).observe(app, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  render(<PanelResponse current={current} snap={snap} />, host);
}
