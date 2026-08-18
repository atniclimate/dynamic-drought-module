/**
 * The conditions strip as a Preact island (ADR 0002, D-0.7.0-021): the
 * view half of the retired vanilla `src/ui/conditions-strip.ts`, whose
 * computation lives in `./strip-metrics`. Markup, strings, and data
 * attributes are contract: tests/conditions-strip.spec.ts asserts the
 * off-state wording, the tile order, the stale flags, and the button
 * semantics (see the conditions-strip-strings knowledge card). Since E1
 * (D-0.7.0-041 part 2, review E1.4) the Alerts and Fires tiles render only
 * while their layers are on; the drought tile and the date line are the
 * strip's permanent content.
 *
 * U1 (D-0.7.0-008, the ratified tile guardrail spec): each tile is a
 * REAL `button` with stable semantics in every state (off, loading,
 * ready, zero, error). A tile is an answer followed by an immediate
 * action: it exposes `aria-pressed` from the layer's on-state, keeps
 * status and action distinct in the accessible name ("14 active
 * fire perimeters. Current Mapped Fire Perimeters (NIFC) layer on. Press to hide."), and
 * routes its action through the shared toggle command, never a naive
 * controller call. The drought tile additionally discloses that showing
 * the US Drought Monitor replaces the current condition surface (USDM
 * is an exclusive surface; a silent replacement is technically correct
 * but not a predictable interaction).
 *
 * The component renders the three tiles into #conditions-metrics; the
 * strip's heading and date span are static index.html chrome OUTSIDE
 * this render root, so the date line and the section's `hidden` flip are
 * applied in an after-render effect, mirroring the vanilla render()
 * exactly.
 */

import type maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';

import { getLayerDef } from '../../config/layers';
import { timeline } from '../../state/timeline';
import { requestLayerOff, requestLayerOn } from '../layer-toggle-command';
import {
  droughtMetric,
  alertsMetric,
  firesMetric,
  isUsdmStale,
  formatMapDate
} from './strip-metrics';
import type { Metric } from './strip-metrics';

/**
 * The tile-to-layer mapping. `disclose` marks the drought tile's
 * surface-replacement disclosure (guardrail spec: USDM is an exclusive
 * surface, so showing it replaces whatever condition surface is on).
 */
const TILE_LAYER: Record<string, { key: string; disclose: boolean }> = {
  alerts: { key: 'nws-alerts', disclose: false },
  fires: { key: 'nifc-fires', disclose: false }
};

/**
 * The accessible name: the status reading first, then the layer state
 * and the action, as distinct sentences (guardrail spec). The visible
 * tile carries the same status; the action cue is visible in the off
 * state ("Show") and accessible-plus-hover elsewhere, so the strip
 * still reads as a summary first, not a second catalog.
 */
function tileAriaLabel(name: string, m: Metric, isOn: boolean, disclose: boolean): string {
  let status: string;
  if (m.tone === 'data') {
    status = `${m.value} ${m.sublabel}.`;
  } else if (m.tone === 'none') {
    status = `${m.value}, ${m.sublabel}.`;
  } else if (m.tone === 'loading') {
    status = `${name} loading.`;
  } else if (m.value === 'Layer off') {
    status = `${name} layer off.`;
  } else {
    // The pending tile: an honest canonical status word ("unavailable",
    // "no data", "zoom in to load", "live (partial)").
    status = `${name} ${m.sublabel}.`;
  }
  const stale = m.stale ? ' Reading is stale.' : '';
  const action = isOn
    ? ` ${name} layer on. Press to hide.`
    : ` Press to show.${
        disclose ? ` Showing ${name} replaces the current condition surface.` : ''
      }`;
  return `${status}${stale}${action}`;
}

function MetricTile({
  id,
  m,
  isOn,
  tile
}: {
  id: string;
  m: Metric;
  isOn: boolean;
  tile: { key: string; disclose: boolean };
}) {
  const name = getLayerDef(tile.key)?.name ?? tile.key;

  const onClick = (): void => {
    if (isOn) {
      requestLayerOff(tile.key);
    } else {
      requestLayerOn(tile.key);
    }
  };

  return (
    <button
      type="button"
      class={m.tone === 'loading' ? 'conditions-metric skeleton-shimmer' : 'conditions-metric'}
      data-metric={id}
      data-tone={m.tone}
      {...(m.stale ? { 'data-stale': 'true' } : {})}
      aria-pressed={isOn}
      aria-label={tileAriaLabel(name, m, isOn, tile.disclose)}
      title={
        isOn
          ? `Hide ${name}`
          : tile.disclose
            ? `Show ${name} (replaces the current condition surface)`
            : `Show ${name}`
      }
      onClick={onClick}
    >
      <span class="conditions-value" style={m.color ? `color:${m.color}` : undefined}>
        {m.value}
      </span>
      <span class="conditions-sublabel">
        {m.sublabel.replace(/ in view$/i, '')}
        {m.sublabel.toLowerCase().endsWith(' in view') ? (
          <span class="sr-only"> in the current map view</span>
        ) : null}
        {m.stale ? <span class="conditions-stale-tag">stale</span> : null}
      </span>
      {!isOn && m.tone === 'off' ? <span class="conditions-action">Show</span> : null}
    </button>
  );
}

interface StripProps {
  map: maplibregl.Map;
  /** Bumped (rAF-coalesced) on map settle, registry, and timeline events. */
  tick: ReadonlySignal<number>;
  /** Per-layer checkbox intent from the bridge (the aria-pressed truth). */
  checked: ReadonlySignal<ReadonlyMap<string, boolean>>;
}

export function ConditionsStrip({ map, tick, checked }: StripProps) {
  // Subscribe to the tick: every bump recomputes the metrics from what
  // the map is actually rendering (the reflect-the-map contract).
  void tick.value;

  const lastDroughtLayer = useRef<'usdm' | 'nadm-drought'>('nadm-drought');
  if (checked.value.get('usdm')) lastDroughtLayer.current = 'usdm';
  else if (checked.value.get('nadm-drought')) {
    lastDroughtLayer.current = 'nadm-drought';
  }
  const drought = droughtMetric(map, lastDroughtLayer.current);
  const alerts = alertsMetric(map);
  const fires = firesMetric(map);
  const droughtLayer = {
    key: lastDroughtLayer.current,
    disclose: true
  };
  const tileLayers: Record<string, { key: string; disclose: boolean }> = {
    ...TILE_LAYER,
    drought: droughtLayer
  };

  const isOn = (id: string): boolean => {
    const tile = tileLayers[id];
    return tile ? (checked.value.get(tile.key) ?? false) : false;
  };

  // A deliberately scrubbed historical week (0.5.0b temporal axis) is NOT a
  // stale feed: the user chose to look back. The stale flag is reserved for
  // a frozen upstream while viewing the CURRENT week; a scrubbed view gets
  // its own honest "viewing week of" date register instead.
  const viewingHistory = timeline.usdmWeek !== null;

  // Degrade a frozen or drifted USDM surface to an explicit stale read
  // (critical-review #6): the category still shows, but the tile and the date
  // line both say so, rather than presenting an old week as current.
  const droughtStale =
    droughtLayer.key === 'usdm' &&
    !viewingHistory &&
    drought.metric.tone === 'data' &&
    isUsdmStale(drought.dateMs);
  const droughtTile: Metric = droughtStale ? { ...drought.metric, stale: true } : drought.metric;

  useEffect(() => {
    const strip = document.getElementById('conditions-strip');
    if (strip) strip.hidden = false;

    const dateEl = document.getElementById('conditions-date');
    if (!dateEl) return;
    if (drought.dateMs === null) {
      dateEl.textContent = '';
      delete dateEl.dataset['stale'];
    } else if (droughtStale) {
      dateEl.textContent = `stale, data as of ${formatMapDate(drought.dateMs)}`;
      dateEl.dataset['stale'] = 'true';
    } else if (viewingHistory) {
      dateEl.textContent = `viewing week of ${formatMapDate(drought.dateMs)}`;
      delete dateEl.dataset['stale'];
    } else {
      dateEl.textContent = `as of ${formatMapDate(drought.dateMs)}`;
      delete dateEl.dataset['stale'];
    }
  });

  // E1 deliverable 6 (D-0.7.0-041 part 2; the 2026-07-16 design review
  // E1.4): the off-state Alerts and Fires tiles retire. The strip keeps the
  // drought reading and the date line always (including drought's honest
  // off state; the drought tile is the strip's identity), but the two event
  // tiles render only while their layers are ON; turning a layer on (the
  // catalog today, the cluster buttons at S4) brings its tile back as the
  // live reading plus the hide action.
  const alertsOn = isOn('alerts');
  const firesOn = isOn('fires');
  // W2-D10: in a non-drought view the strip leads with the ACTIVE hazard's
  // own tiles; the drought tile stays (the strip's identity and the one
  // road back to the drought surface) but its off-state anchor renders
  // LAST rather than fronting another hazard's read. The drought view
  // itself is unchanged: with its layer on, the drought tile still leads.
  const droughtOn = isOn('drought');
  const droughtTileNode = (
    <MetricTile id="drought" m={droughtTile} isOn={droughtOn} tile={droughtLayer} />
  );
  return (
    <>
      {droughtOn ? droughtTileNode : null}
      {alertsOn ? <MetricTile id="alerts" m={alerts} isOn={alertsOn} tile={TILE_LAYER.alerts!} /> : null}
      {firesOn ? <MetricTile id="fires" m={fires} isOn={firesOn} tile={TILE_LAYER.fires!} /> : null}
      {!droughtOn ? droughtTileNode : null}
    </>
  );
}
