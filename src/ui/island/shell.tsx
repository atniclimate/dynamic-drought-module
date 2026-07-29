/**
 * The S4 main-screen shell island (the S4 design record sections 2-3;
 * D-0.7.0-042/052/074; ADR 0002: new UI surfaces are Preact islands).
 *
 * The left panel is a LAUNCH PAD, not a dashboard: one control per
 * decision, in the ruled order VIEW (which hazard) -> MAP CONTEXT
 * (where; the S4b minimap) -> WHEN (the compact temporal row; detail
 * behind the S4c "More time" popover) -> SHOWN NOW (the honest S3
 * DisplaySummary). Depth lives in the studios; the doors to them stay
 * where E1 put them (src/ui/view-shell.ts renders the capability-gated
 * PLACE/LAYERS pair against the real studio-route API, including the
 * embed link-out form, so this island deliberately does NOT duplicate
 * that surface).
 *
 * The four cluster buttons render COMMITTED truth, never optimistic
 * click state: aria-pressed mirrors the CommittedShellSnapshot's
 * cluster (published synchronously by requestCluster), and a
 * data-pending marker rides the committed button while any intended
 * hazard layer is still loading, so the button can show work without
 * ever claiming a display that is not on the map.
 *
 * The summary block renders the S3 DisplaySummary verbatim: primary
 * sentence plus at most one caveat, the caveat aria-live polite (the
 * only part announced, per the S1 contract).
 *
 * Horizon chips: the committed TemporalHorizonKey register lives in the
 * timeline store (S3). A chip commits the horizon and re-requests the
 * committed cluster so the recipe re-resolves at the new time. A
 * 'custom' display has no recipe, so the chips whose switch the service
 * cannot honestly apply to it render DISABLED with the reason
 * (aria-disabled plus title; DG-080 r2 finding 1): a pressed chip must
 * never claim a register the map is not showing, and this shell does
 * not attempt the preserve-extras surface-switching variant (banked for
 * later shell units).
 */

import type maplibregl from 'maplibre-gl';
import { render } from 'preact';
import { signal } from '@preact/signals';
import type { ReadonlySignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import { HAZARD_CLUSTERS, HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS } from '../../config/clusters';
import type { HazardClusterKey, TemporalHorizonKey } from '../../config/clusters';
import type { FramingKey } from '../../config/framings';
import { getLayerDef } from '../../config/layers';
import {
  getCommittedSnapshot,
  initClusterService,
  onCommittedSnapshotChange,
  requestCluster,
  requestHorizon
} from '../../state/cluster-service';
import type { CommittedShellSnapshot } from '../../state/cluster-service';
import { onTimeBarSpecChange } from '../time-bar';
import { Minimap } from './minimap';
import { TimeCompact } from './time-popover';
import { wireShellPopover } from './popover-discipline';

const HORIZON_LABELS: Readonly<Record<TemporalHorizonKey, string>> = {
  current: 'Current',
  'weeks-ahead': 'Weeks ahead',
  'season-ahead': 'Season ahead'
};

/** Whether the committed display is still settling: any intended
 * non-reference layer without a terminal status. Reference boundaries
 * are excluded so slow chrome never marks a hazard button pending. */
function isPending(snap: CommittedShellSnapshot): boolean {
  for (const key of snap.intendedKeys) {
    const def = getLayerDef(key);
    if (def === null || def.role === 'reference') continue;
    const status = snap.statuses.get(key);
    if (status === undefined || status === 'loading') return true;
  }
  return false;
}

/**
 * The honest reason a horizon chip is disabled for a CUSTOM composition,
 * or null when the chip is honestly applicable (DG-080 r2 finding 1).
 *
 * A custom set has no recipe, so a horizon switch cannot re-resolve the
 * displayed layers; committing the register alone would press a chip
 * for a time the map does not show (the two review counterexamples:
 * custom plus the US Drought Monitor with Weeks ahead clicked, and
 * custom plus the Seasonal outlook with Current clicked). The ONE
 * honest exception is flipping BETWEEN the two outlook horizons while
 * the CPC Drought Outlook surface is part of the custom display: that
 * mounted surface follows the outlook register itself and re-renders
 * the register the chip claims. The committed chip stays enabled (an
 * idempotent no-op press, and the honest pressed state).
 */
function customHorizonDisabledReason(
  snap: CommittedShellSnapshot,
  key: TemporalHorizonKey
): string | null {
  if (snap.cluster !== 'custom') return null;
  if (key === snap.horizon) return null;
  const outlookDisplayed = snap.intendedKeys.has('drought');
  if (outlookDisplayed && key !== 'current') return null;
  return (
    'Not available for this custom layer set: applying this time horizon ' +
    'would change which layers are displayed, and a custom set keeps the ' +
    'layers you chose. Pick a hazard view to change the time horizon.'
  );
}

interface ShellProps {
  readonly map: maplibregl.Map;
  readonly snap: ReadonlySignal<CommittedShellSnapshot>;
  readonly framing: ReadonlySignal<FramingKey | null>;
  readonly specTick: ReadonlySignal<number>;
}

/**
 * The compact-band framing door and its popover (the 600-699px height
 * band's only "where" control). Carries the same popover discipline as
 * the More time detail: focus moves in on open, restores to the door on
 * close, and the light-dismissing pointer gesture is consumed rather
 * than clicking through to the map.
 */
function MinimapPopover({
  map,
  framing
}: {
  readonly map: maplibregl.Map;
  readonly framing: ReadonlySignal<FramingKey | null>;
}) {
  const doorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pop = popRef.current;
    if (!pop) return;
    return wireShellPopover(pop, () => doorRef.current);
  }, []);

  return (
    <div class="shell-minimap-popover-wrap">
      <button
        type="button"
        id="shell-minimap-door"
        class="shell-popover-door"
        ref={doorRef}
        popovertarget="shell-minimap-popover"
      >
        Map areas
      </button>
      <div
        popover="auto"
        id="shell-minimap-popover"
        class="shell-popover"
        ref={popRef}
        aria-label="Map framing"
      >
        <Minimap map={map} framing={framing} idPrefix="shell-minimap-pop" />
      </div>
    </div>
  );
}

function Shell({ map, snap, framing, specTick }: ShellProps) {
  const snapshot = snap.value;
  const pending = isPending(snapshot);

  const chooseCluster = (key: HazardClusterKey): void => {
    requestCluster(key);
  };

  const chooseHorizon = (key: TemporalHorizonKey): void => {
    // One transaction, one revision: the service owns the horizon
    // commit (it re-resolves an explicit cluster once via its own
    // timeline subscription, applies the derived boot case itself, and
    // lets a 'custom' display keep its set).
    requestHorizon(key);
  };

  return (
    <div class="shell">
      <div class="shell-view" role="group" aria-label="Hazard view">
        {HAZARD_CLUSTER_KEYS.map((key) => {
          const def = HAZARD_CLUSTERS[key];
          const committed = snapshot.cluster === key;
          return (
            <button
              type="button"
              key={key}
              class="shell-cluster-btn"
              data-cluster={key}
              aria-pressed={committed}
              data-pending={committed && pending ? 'true' : 'false'}
              title={def.description}
              // First-use expansion for the one acronym title (CLAUDE.md
              // section 5; DG-080 review finding 7): the ruled visual
              // label stays 'ENSO'; the accessible name spells it out
              // (and contains the visible label, per WCAG label-in-name).
              aria-label={
                key === 'enso'
                  ? 'El Nino / Southern Oscillation (ENSO)'
                  : undefined
              }
              onClick={() => chooseCluster(key)}
            >
              {def.title}
            </button>
          );
        })}
      </div>

      <div class="shell-minimap-map">
        <Minimap map={map} framing={framing} idPrefix="shell-minimap" />
      </div>
      <MinimapPopover map={map} framing={framing} />

      <div class="shell-when" role="group" aria-label="Time horizon">
        <div class="shell-horizons">
          {TEMPORAL_HORIZON_KEYS.map((key) => {
            const disabledReason = customHorizonDisabledReason(snapshot, key);
            return (
              <button
                type="button"
                key={key}
                class="shell-horizon-btn"
                data-horizon={key}
                aria-pressed={snapshot.horizon === key}
                aria-disabled={disabledReason !== null ? 'true' : undefined}
                title={disabledReason ?? undefined}
                onClick={() => {
                  if (disabledReason === null) chooseHorizon(key);
                }}
              >
                {HORIZON_LABELS[key]}
              </button>
            );
          })}
        </div>
        <TimeCompact specTick={specTick} />
      </div>

      <section class="shell-summary" aria-label="What is shown">
        <h2 class="panel-title">Shown now</h2>
        <p class="shell-summary-primary" id="shell-summary-primary">
          {snapshot.summary.primary}
        </p>
        {/* The live region stays PERSISTENTLY rendered and visible; only
            its text swaps. A region that is unhidden in the same render
            that sets its text is unreliably announced across screen
            readers (NVDA/Firefox drop it), so hidden/display toggling is
            deliberately avoided; an empty paragraph renders nothing. */}
        <p
          class="shell-summary-caveat"
          id="shell-summary-caveat"
          aria-live="polite"
        >
          {snapshot.summary.caveat ?? ''}
        </p>
      </section>
    </div>
  );
}

/**
 * Mount the shell island into its static host. Called from
 * mountSidebarIsland; idempotent by construction (a re-render into the
 * same host replaces the tree). Initializes the S3 cluster service (the
 * boot wiring S3 deferred to S4) before the first render so the first
 * snapshot is live.
 */
export function mountShell(host: HTMLElement, map: maplibregl.Map): void {
  initClusterService();

  const first = getCommittedSnapshot();
  const snap = signal<CommittedShellSnapshot>(first);
  const framing = signal<FramingKey | null>(first.framing);
  onCommittedSnapshotChange(() => {
    const s = getCommittedSnapshot();
    snap.value = s;
    framing.value = s.framing;
  });

  const specTick = signal(0);
  onTimeBarSpecChange(() => {
    specTick.value = specTick.value + 1;
  });

  render(
    <Shell map={map} snap={snap} framing={framing} specTick={specTick} />,
    host
  );
}
