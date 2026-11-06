/**
 * The classes-drawn minimap reading (src/config/minimap-readings.ts): which of
 * an outlook's issuer classes its layer drew over each framing.
 *
 * It reads what the mode loaded and never fetches a copy: the layer's GeoJSON
 * source on the map holds exactly what the layer drew under its own filter,
 * and it is read again on each of the layer's status reports (a new read, a
 * register switch, a refresh, an expiry) and when the layer comes on or off.
 * A class counts in a framing when one of its drawn polygons overlaps the
 * framing's authored rings: the polygon-versus-polygon test the wildfire count
 * uses, against the same rings (`framingGeometry`). No area, share, rank or
 * merged class is computed. A partial read (the layer's `degraded`), or a
 * drawn feature whose class the issuer's legend does not name, leaves the
 * reading unavailable rather than half-said.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';

import { FRAMING_KEYS } from '../config/framings';
import type { FramingKey } from '../config/framings';
import type { MinimapOutlookSource, MinimapOutlookStatus } from '../config/minimap-readings';
import { geometriesOverlap } from '../util/polygon-overlap';
import { framingGeometry } from './minimap-wildfire';
import { registry } from './registry';

export interface MinimapOutlookSnapshot {
  readonly status: MinimapOutlookStatus;
  /** Per framing, the drawn classes as indexes into the source's classes, in legend order. */
  readonly drawn: Readonly<Partial<Record<FramingKey, readonly number[]>>>;
}

export const IDLE_OUTLOOK: MinimapOutlookSnapshot = { status: 'idle', drawn: {} };
const LOADING: MinimapOutlookSnapshot = { status: 'loading', drawn: {} };
const UNAVAILABLE: MinimapOutlookSnapshot = { status: 'unavailable', drawn: {} };

type Drawn = Record<FramingKey, readonly number[]>;

/** The two mounted minimaps read one collection object; derive it once. */
const derived = new WeakMap<object, Drawn | null>();

/** Each framing's drawn classes, or null when a drawn feature's class is not the issuer's. */
export function deriveClassesDrawn(
  collection: FeatureCollection,
  outlook: MinimapOutlookSource,
): Drawn | null {
  const cached = derived.get(collection);
  if (cached !== undefined) return cached;
  const classed = collection.features.map(
    (feature) => [outlook.classOf(feature.properties), feature] as readonly [number, Feature],
  );
  let result: Drawn | null = null;
  if (classed.every(([index]) => index >= 0)) {
    const drawn = {} as Drawn;
    for (const key of FRAMING_KEYS) {
      const frame = framingGeometry(key);
      const present = new Set<number>();
      for (const [index, feature] of classed) {
        if (!present.has(index) && geometriesOverlap(feature.geometry, frame)) present.add(index);
      }
      drawn[key] = [...present].sort((a, b) => a - b);
    }
    result = drawn;
  }
  derived.set(collection, result);
  return result;
}

/** The issuer colours of the classes drawn in one framing, or undefined for none or no live read. */
export function outlookColors(
  outlook: MinimapOutlookSource,
  snapshot: MinimapOutlookSnapshot,
  key: FramingKey,
): readonly string[] | undefined {
  const drawn = snapshot.status === 'live' ? snapshot.drawn[key] : undefined;
  return drawn?.length ? drawn.map((index) => outlook.classes[index]?.color ?? '') : undefined;
}

/** The issuer's words for the classes drawn in one framing. */
export function outlookLabels(
  outlook: MinimapOutlookSource,
  snapshot: MinimapOutlookSnapshot,
  key: FramingKey,
): readonly string[] {
  return (snapshot.drawn[key] ?? []).map((index) => outlook.classes[index]?.label ?? '');
}

/**
 * Follow one outlook layer on the map; the listener hears each reading. The
 * returned function stops it. Status-driven, so it needs no timer of its own:
 * the layer's own refresh is what moves it.
 */
export function watchMinimapOutlook(
  map: maplibregl.Map,
  product: string,
  outlook: MinimapOutlookSource,
  listener: (next: MinimapOutlookSnapshot) => void,
): () => void {
  let generation = 0;
  let active = registry.getActiveKeys().has(product);
  const read = (): void => {
    const mine = ++generation;
    const status = registry.getStatus(product);
    if (status !== 'ready' && status !== 'no-data') {
      listener(status === undefined ? IDLE_OUTLOOK : status === 'loading' ? LOADING : UNAVAILABLE);
      return;
    }
    const source = map.getSource(outlook.source) as maplibregl.GeoJSONSource | undefined;
    const data: Promise<unknown> = source
      ? source.getData()
      : Promise.resolve({ type: 'FeatureCollection', features: [] });
    data.then(
      (value) => {
        if (mine !== generation) return;
        const collection = value as FeatureCollection | null;
        const drawn =
          collection?.type === 'FeatureCollection' && Array.isArray(collection.features)
            ? deriveClassesDrawn(collection, outlook)
            : null;
        listener(drawn === null ? UNAVAILABLE : { status: 'live', drawn });
      },
      () => {
        if (mine === generation) listener(UNAVAILABLE);
      },
    );
  };
  const offStatus = registry.on('status-change', (key) => {
    if (key === product) read();
  });
  // Off clears the status without a status report; only this product's own flip re-reads.
  const offChange = registry.on('change', (keys) => {
    if (keys.has(product) === active) return;
    active = !active;
    read();
  });
  read();
  return () => {
    generation++;
    offStatus();
    offChange();
  };
}
