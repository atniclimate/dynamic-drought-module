/**
 * Live readings computed from the rendered map by `strip-metrics`.
 * A live reading of the active mode's own layer (the drought surface, the
 * Wildfire fires, the Heat alerts) opens the map key without changing the
 * condition surface, so a readout never acts as an unexpected layer-off
 * control (owner item 9, 2026-11-13). A failed tile keeps Retry; off tiles
 * and extras outside the mode keep their explicit layer actions through the
 * shared toggle command.
 *
 * The strip publishes the mode's own lead reading (conditions-headline.ts),
 * which the desktop Key chip shows as its title (owner 2026-11-13, one box).
 * In desktop Brief the strip node is parked unseen in the map's dock so it
 * keeps computing; Console shows it in the sidebar below the hazard buttons.
 * Source status, historical-week dates, and stale flags stay authoritative.
 */

import type * as maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ReadonlySignal } from '@preact/signals';

import { getLayerDef } from '../../config/layers';
import { timeline } from '../../state/timeline';
import { isFailedCheckedLayer, requestLayerOff, requestLayerOn } from '../layer-toggle-command';
import { HAZARD_CLUSTERS } from '../../config/clusters';
import type { HazardClusterKey } from '../../config/clusters';
import { getSelectedHazard, onCommittedSnapshotChange, requestHorizon } from '../../state/cluster-service';
import {
  droughtMetric,
  alertsMetric,
  firesMetric,
  isDroughtStale,
  formatMapDate
} from './strip-metrics';
import type { Metric } from './strip-metrics';
import { stripFocusAfterHide } from './strip-focus';
import { setConditionsHeadline } from '../../state/conditions-headline';

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
 * found-008: whether the active mode's own recipe (enumerated from
 * HAZARD_CLUSTERS, never a hard-coded mode name, DR-113) names any of the
 * drought current-conditions family. The recipe table names the shipped
 * tri-national default (`nadm-drought`) and the CPC outlook (`drought`);
 * `usdm` is the same tile's interchangeable domestic alternate (the strip
 * already treats the two as one reading via `lastDroughtLayer`), so it
 * counts too even though no recipe names it directly.
 */
const DROUGHT_FAMILY_KEYS: readonly string[] = ['nadm-drought', 'drought', 'usdm'];

/** Whether any horizon recipe of the mode draws `layerKey` (enumerated from HAZARD_CLUSTERS, DR-113). */
function clusterOffersLayer(clusterKey: HazardClusterKey, layerKey: string): boolean {
  return Object.values(HAZARD_CLUSTERS[clusterKey].recipes).some((recipe) =>
    recipe.some((key) => key === layerKey)
  );
}

function clusterOffersDroughtFamily(clusterKey: HazardClusterKey): boolean {
  return DROUGHT_FAMILY_KEYS.some((key) => clusterOffersLayer(clusterKey, key));
}

/**
 * The accessible name: the status reading first, then the layer state
 * and the action, as distinct sentences (guardrail spec). The visible
 * tile carries the same status; the action cue is visible in the off
 * state ("Show") and accessible-plus-hover elsewhere, so the strip
 * still reads as a summary first, not a second catalog.
 */
function tileStatus(name: string, m: Metric): string {
  // A count reads as one phrase ("0 mapped wildfire perimeters in view"); only
  // a word value ("No polygon, no NADM category polygon...") takes the comma.
  if (m.tone === 'data' || /^\d+$/.test(m.value)) return `${m.value} ${m.sublabel}.`;
  if (m.tone === 'none') return `${m.value}, ${m.sublabel}.`;
  if (m.tone === 'loading') return `${name} loading.`;
  if (m.value === 'Layer off') return `${name} layer off.`;
  // The pending tile: an honest canonical status word ("unavailable",
  // "no data", "zoom in to load", "live (partial)").
  return `${name} ${m.sublabel}.`;
}

function tileAriaLabel(name: string, m: Metric, isOn: boolean, disclose: boolean, retries: boolean): string {
  const status = tileStatus(name, m);
  const stale = m.stale ? ' Reading is stale.' : '';
  // DRAFT wording (DR-177): "Press to retry." names the failed checked tile's action.
  const action = retries ? ' Press to retry.' : isOn
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
  tile,
  inMode
}: {
  id: string;
  m: Metric;
  isOn: boolean;
  tile: { key: string; disclose: boolean };
  /** The active mode's own recipe draws this layer, so its live tile opens the key. */
  inMode: boolean;
}) {
  const name = getLayerDef(tile.key)?.name ?? tile.key;
  const retries = !(id === 'drought' && isOn) && isFailedCheckedLayer(tile.key);
  const showsDetails = isOn && !retries && (id === 'drought' || inMode);
  const keyNoun = id === 'drought' ? 'drought' : name;
  // DRAFT wording (DR-177): failed checked tile action "Retry" and title "Retry {layer name}".
  const action = retries ? 'Retry' : 'Hide';
  // A tile mounted while the Key is already open (a layer just turned on) reads it.
  const [detailsOpen, setDetailsOpen] = useState(() => document.getElementById('map-key')?.dataset['keyDetailsOpen'] === 'true');
  useEffect(() => {
    const update = (event: Event): void => {
      setDetailsOpen(Boolean((event as CustomEvent<{ open: boolean }>).detail?.open));
    };
    window.addEventListener('ddm:map-key-details-change', update);
    return () => window.removeEventListener('ddm:map-key-details-change', update);
  }, []);

  const onClick = (event: MouseEvent): void => {
    if (showsDetails) {
      window.dispatchEvent(new Event('ddm:toggle-map-key-details'));
    } else if (isOn && !isFailedCheckedLayer(tile.key)) {
      // Hide unmounts this tile; hand on focus a person left here first.
      const btn = event.currentTarget as HTMLElement;
      if (document.activeElement === btn) stripFocusAfterHide(btn)?.focus({ preventScroll: true });
      requestLayerOff(tile.key);
    } else {
      // The observed drought surface commits the Current horizon first, as
      // drought.ts switchToObserved does, so no outlook chip stays pressed over it.
      if (id === 'drought') requestHorizon('current');
      requestLayerOn(tile.key);
    }
  };

  return (
    <button
      type="button"
      class={m.tone === 'loading' ? 'conditions-metric skeleton-shimmer' : 'conditions-metric'}
      data-metric={id}
      data-tone={m.tone}
      data-layer-on={String(isOn)}
      {...(m.stale ? { 'data-stale': 'true' } : {})}
      aria-pressed={showsDetails ? undefined : isOn}
      aria-expanded={showsDetails ? detailsOpen : undefined}
      aria-controls={showsDetails ? 'map-key-content' : undefined}
      aria-label={showsDetails
        ? `${tileStatus(name, m)}${m.stale ? ' Reading is stale.' : ''} ${detailsOpen ? 'Close' : 'Open'} ${keyNoun} details and key.`
        : tileAriaLabel(name, m, isOn, tile.disclose, retries)}
      title={
        showsDetails
          ? `${id === 'drought' ? 'Drought' : name} details and key`
          : isOn
          ? `${action} ${name}`
          : tile.disclose
            ? `Show ${name} (replaces the current condition surface)`
            : `Show ${name}`
      }
      onClick={onClick}
    >
      <span class="conditions-value">
        {m.color ? (
          <span
            class="conditions-swatch"
            aria-hidden="true"
            style={`background:${m.color}`}
          />
        ) : null}
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
      {/* Name the action visibly: a live in-mode reading opens the key; other
          tiles retry failed activation or hide their active layer. */}
      {isOn && m.tone !== 'loading' ? (
        <span class="conditions-action conditions-action-hide">{showsDetails ? 'Key' : action}</span>
      ) : null}
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

  // found-008: the active mode, kept live so a cluster switch that leaves
  // the checked set unchanged (rare, but possible via a reference-role
  // extra surviving the switch) still re-evaluates which surfaces this
  // mode actually offers.
  // The person's hazard, not the store, which reads Drought for every custom set.
  const [cluster, setCluster] = useState<HazardClusterKey>(getSelectedHazard);
  useEffect(() => onCommittedSnapshotChange(() => setCluster(getSelectedHazard())), []);

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

  // Degrade a frozen or drifted USDM or NADM surface to an explicit stale read
  // (critical-review #6): the category still shows, but the tile and the date
  // line both say so, rather than presenting an old week or month as current.
  const droughtStale =
    !viewingHistory &&
    drought.metric.tone === 'data' &&
    isDroughtStale(droughtLayer.key, drought.dateMs);
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
      dateEl.textContent = `stale, data as of ${drought.dateLabel ?? formatMapDate(drought.dateMs)}`;
      dateEl.dataset['stale'] = 'true';
    } else if (viewingHistory) {
      dateEl.textContent = `viewing week of ${formatMapDate(drought.dateMs)}`;
      delete dateEl.dataset['stale'];
    } else {
      dateEl.textContent = `as of ${drought.dateLabel ?? formatMapDate(drought.dateMs)}`;
      delete dateEl.dataset['stale'];
    }
  });

  // E1 deliverable 6 (D-0.7.0-041 part 2; the 2026-07-16 design review
  // E1.4): the off-state Alerts and Fires tiles retire. The strip keeps the
  // drought reading and the date line always (including drought's honest
  // off state; the drought tile is the strip's identity), but the two event
  // tiles render only while their layers are ON; turning a layer on (the
  // catalog today, the cluster buttons at S4) brings its tile back as the
  // live reading plus its action.
  const alertsOn = isOn('alerts');
  const firesOn = isOn('fires');
  // W2-D10: in a non-drought view the strip leads with the ACTIVE hazard's
  // own tiles; the drought tile stays (the strip's identity and the one
  // road back to the drought surface) but its off-state anchor renders
  // LAST rather than fronting another hazard's read. The drought view
  // itself is unchanged: with its layer on, the drought tile still leads.
  const droughtOn = isOn('drought');
  // found-008: an OFF drought anchor is an invitation ("Layer off. Press to
  // show.") to activate a SURFACE this mode does not offer; in a mode whose
  // own recipe never names the drought family, that invitation both names
  // the wrong mode's layer and, once pressed, silently replaces the mode's
  // own surface (surface exclusivity). An ON drought reading still renders
  // regardless of mode: the strip reflects the map honestly either way, and
  // never hides a layer that is actually drawing.
  const droughtInMode = droughtOn || clusterOffersDroughtFamily(cluster);
  const droughtTileNode = droughtInMode ? (
    <MetricTile key="drought" id="drought" m={droughtTile} isOn={droughtOn} tile={droughtLayer} inMode />
  ) : null;
  const eventTile = (id: 'alerts' | 'fires', m: Metric) => (
    <MetricTile key={id} id={id} m={m} isOn tile={TILE_LAYER[id]!} inMode={clusterOffersLayer(cluster, TILE_LAYER[id]!.key)} />
  );
  // The mode's OWN readings lead and any other live layer follows, so the Key chip's title (the first, when it is
  // the mode's own) never names another mode's reading: a Wildfire view with Alerts added leads with its fires.
  const live = [
    droughtOn ? { own: clusterOffersDroughtFamily(cluster), node: droughtTileNode, m: droughtTile, key: droughtLayer.key } : null,
    alertsOn ? { own: clusterOffersLayer(cluster, TILE_LAYER.alerts!.key), node: eventTile('alerts', alerts), m: alerts, key: TILE_LAYER.alerts!.key } : null,
    firesOn ? { own: clusterOffersLayer(cluster, TILE_LAYER.fires!.key), node: eventTile('fires', fires), m: fires, key: TILE_LAYER.fires!.key } : null
  ].filter((tile): tile is NonNullable<typeof tile> => tile !== null);
  const ordered = [...live.filter((tile) => tile.own), ...live.filter((tile) => !tile.own)];
  const first = ordered[0];
  const lead = first?.own && (first.m.tone === 'data' || first.m.tone === 'none') ? first : null;
  // Every render; the store drops an unchanged reading.
  useEffect(() => setConditionsHeadline(lead ? {
    value: lead.m.value,
    sublabel: lead.m.sublabel,
    ...(lead.m.color ? { color: lead.m.color } : {}),
    stale: Boolean(lead.m.stale),
    tone: lead.m.tone as 'data' | 'none',
    aria: tileStatus(getLayerDef(lead.key)?.name ?? lead.key, lead.m) + (lead.m.stale ? ' Reading is stale.' : '')
  } : null));
  useEffect(() => () => setConditionsHeadline(null), []);
  return (
    <>
      {ordered.map((tile) => tile.node)}
      {!droughtOn ? droughtTileNode : null}
      {/* Last, so the stylesheet shows it only while no tile is shown (an ENSO
          view in Console). */}
      {/* DRAFT wording (DR-177) */}
      <p class="conditions-empty">No readings for this view</p>
    </>
  );
}
