/**
 * The mapped wildfire perimeter ribbon for the desktop 3D Fire mode
 * (DR-064, owner rendering specification 2026-09-02).
 *
 * NOT a LAYER_DEFS entry and NOT a LayerModule: like hms-smoke-volume, this
 * module is a presentation companion owned by the fire3d orchestrator
 * (src/map/fire3d.ts, which reaches it through a dynamic import after
 * terrain succeeds). The NIFC perimeter layer (src/layers/nifc-fires.ts)
 * keeps sole ownership of its fetch, its data, its filters, its popup, its
 * 2D legend, and its six-state status pill; nothing here reports a status,
 * changes what any status says, or changes a sentence in the briefing.
 *
 * What it draws. In the tilted scene a flat outline reads as a line drawn
 * on a map rather than as a fire line on the land, so the mapped WILDFIRE
 * perimeter (the pulsing WF and CX class; prescribed and unclassified
 * records keep their deliberately neutral flat treatment) is raised into a
 * low vertical ribbon: opaque where it meets the terrain, fading out above
 * it on a logarithmic curve, and pulsing in step with the flat outline.
 *
 * Where the geometry comes from. The ribbon derives its source from the
 * SAME GeoJSON the flat layer already holds, read back off the map through
 * `GeoJSONSource.getData()`. It issues no request of its own, so a scene
 * with the ribbon transfers exactly what a scene without it does. Because
 * MapLibre extrudes polygons and never lines, each perimeter ring becomes a
 * thin closed band CENTERED on the published edge (see
 * PERIMETER_RIBBON_HALF_WIDTH_METERS): the ribbon therefore neither
 * enlarges nor shrinks the mapped perimeter, and the flat outline stays
 * visible at its foot as the exact published edge.
 *
 * Partial degrade: when the perimeter source is absent (layer off, still
 * loading, or failed) or holds no wildfire-class record,
 * `activatePerimeterRibbon` returns false and the mode simply continues
 * without a ribbon. Nothing here may block terrain, and a scene without a
 * ribbon still shows the perimeter exactly as the flat map does.
 */

import type * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';

import {
  METERS_PER_DEGREE_LATITUDE,
  PERIMETER_RIBBON_HALF_WIDTH_METERS,
  PERIMETER_RIBBON_QUALIFICATION,
  PERIMETER_RIBBON_SLAB_COUNT,
  buildPerimeterRibbonSlabPaint
} from '../config/fire3d-presentation';
import {
  NIFC_INCIDENT_PRESENTATION,
  NIFC_INCIDENT_TYPE_PROPERTY,
  classifyNifcIncidentType
} from '../config/wildfire-presentation';
import { reassertLabelOrder, reassertThematicOrder } from '../map/layer-order';
import {
  LEGEND_ORDER,
  hideLegend,
  renderSwatchLegend,
  showLegend
} from '../ui/legend-registry';

/** Mirrored literal from src/layers/nifc-fires.ts (lazy-chunk independence). */
const PERIMETER_SOURCE_ID = 'nifc-fires';

const RIBBON_SOURCE_ID = 'nifc-perimeter-ribbon';
const LEGEND_KEY = 'nifc-perimeter-ribbon';

/**
 * One layer per fade slab, bottom first. The same ids are mirrored in
 * `src/map/layer-order.ts` (the ruled stacking chain) and in
 * `src/layers/nifc-fires.ts` (the pulse's paint targets); the fire3d spec
 * asserts all three lists agree, so a slab-count change cannot leave one
 * of them behind.
 */
export const PERIMETER_RIBBON_LAYER_IDS: readonly string[] = Array.from(
  { length: PERIMETER_RIBBON_SLAB_COUNT },
  (_unused, index) => `${RIBBON_SOURCE_ID}-${index}`
);

// ---------------------------------------------------------------------------
// Geometry: the published edge as a thin closed band
// ---------------------------------------------------------------------------

/**
 * Mitre clamp for the offset. A band offset around a sharp corner needs a
 * longer step along the bisector to keep its width constant; without a
 * clamp a near-doubled-back vertex would throw a spike across the map. Four
 * half-widths is roughly a 29 degree corner, past which the corner is cut
 * instead. The clamp changes only how a corner is drawn.
 */
const MAX_MITRE = 4;

/** Unit right-hand normal of an edge, or null for a zero-length edge. */
function rightNormal(dx: number, dy: number): readonly [number, number] | null {
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;
  return [dy / length, -dx / length];
}

/** Signed area of an OPEN ring (positive when counterclockwise). */
function signedArea(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as Position;
    const b = ring[(i + 1) % ring.length] as Position;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Drop repeated positions and any closing duplicate; returns an open ring. */
function openRing(ring: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const position of ring) {
    if (position.length < 2) continue;
    const last = out[out.length - 1];
    if (last && last[0] === position[0] && last[1] === position[1]) continue;
    out.push([position[0], position[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (
    out.length > 1 &&
    first &&
    last &&
    first[0] === last[0] &&
    first[1] === last[1]
  ) {
    out.pop();
  }
  return out;
}

/**
 * Offset every vertex of an open ring along its corner bisector.
 *
 * Longitude is scaled by `kx` (the cosine of the ring's mean latitude) so
 * the offset is an equal ground distance in both axes rather than an equal
 * angle; the scaling is undone on the way out. `distanceDeg` is signed:
 * one call outward, one inward, the same magnitude, which is what keeps the
 * band centered on the published edge.
 */
function offsetRing(
  ring: readonly Position[],
  distanceDeg: number,
  kx: number
): Position[] {
  const out: Position[] = [];
  const count = ring.length;
  for (let i = 0; i < count; i += 1) {
    const previous = ring[(i - 1 + count) % count] as Position;
    const here = ring[i] as Position;
    const next = ring[(i + 1) % count] as Position;
    const incoming = rightNormal(
      (here[0] - previous[0]) * kx,
      here[1] - previous[1]
    );
    const outgoing = rightNormal((next[0] - here[0]) * kx, next[1] - here[1]);
    const reference = outgoing ?? incoming;
    if (!reference) continue;
    let bx = (incoming?.[0] ?? reference[0]) + (outgoing?.[0] ?? reference[0]);
    let by = (incoming?.[1] ?? reference[1]) + (outgoing?.[1] ?? reference[1]);
    const length = Math.hypot(bx, by);
    if (length > 1e-12) {
      bx /= length;
      by /= length;
    } else {
      // A vertex that doubles straight back on itself has no bisector; the
      // outgoing normal is the honest fallback and the band stays closed.
      bx = reference[0];
      by = reference[1];
    }
    const cosHalfAngle = bx * reference[0] + by * reference[1];
    const mitre = Math.min(MAX_MITRE, 1 / Math.max(cosHalfAngle, 1 / MAX_MITRE));
    out.push([
      here[0] + (bx * distanceDeg * mitre) / kx,
      here[1] + by * distanceDeg * mitre
    ]);
  }
  return out;
}

/** Close an open ring, orienting it per RFC 7946 (exterior counterclockwise). */
function closedRing(ring: Position[], counterClockwise: boolean): Position[] {
  const oriented =
    signedArea(ring) >= 0 === counterClockwise ? ring : [...ring].reverse();
  const first = oriented[0] as Position;
  return [...oriented, [first[0], first[1]]];
}

/** Every ring of a polygonal geometry; other geometry types contribute none. */
function ringsOf(geometry: Geometry | null): readonly Position[][] {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

/**
 * The band for one perimeter ring: an outward offset as the exterior and an
 * inward offset as its hole, so the extruded result is a wall standing on
 * the published edge rather than a solid block filling the burned area.
 * Returns null for a ring too degenerate to offset.
 */
function bandForRing(ring: readonly Position[]): Position[][] | null {
  const simple = openRing(ring);
  if (simple.length < 3) return null;
  const meanLatitude =
    simple.reduce((sum, position) => sum + position[1], 0) / simple.length;
  const kx = Math.max(Math.cos((meanLatitude * Math.PI) / 180), 0.05);
  const distanceDeg =
    PERIMETER_RIBBON_HALF_WIDTH_METERS / METERS_PER_DEGREE_LATITUDE;
  const outward = offsetRing(simple, distanceDeg, kx);
  const inward = offsetRing(simple, -distanceDeg, kx);
  if (outward.length < 3 || inward.length < 3) return null;
  const outwardIsLarger =
    Math.abs(signedArea(outward)) >= Math.abs(signedArea(inward));
  const exterior = outwardIsLarger ? outward : inward;
  const hole = outwardIsLarger ? inward : outward;
  return [closedRing(exterior, true), closedRing(hole, false)];
}

/**
 * Derive the ribbon's GeoJSON from the perimeter collection the flat layer
 * holds. Pure, so the geometry contract is testable without a map.
 *
 * Only the WF and CX incident classes are raised: those are the records the
 * flat layer pulses, and raising a prescribed burn into the same ribbon of
 * light would say something about it that the layer deliberately does not.
 */
export function buildPerimeterRibbonBands(
  collection: FeatureCollection
): FeatureCollection {
  const features: Feature[] = [];
  for (const feature of collection.features ?? []) {
    const incidentClass = classifyNifcIncidentType(
      feature.properties?.[NIFC_INCIDENT_TYPE_PROPERTY]
    );
    if (incidentClass !== 'wildfire') continue;
    const bands: Position[][][] = [];
    for (const ring of ringsOf(feature.geometry)) {
      const band = bandForRing(ring);
      if (band) bands.push(band);
    }
    if (bands.length === 0) continue;
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: bands }
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Scene lifecycle
// ---------------------------------------------------------------------------

function asFeatureCollection(data: unknown): FeatureCollection {
  if (
    data !== null &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'FeatureCollection' &&
    Array.isArray((data as { features?: unknown }).features)
  ) {
    return data as FeatureCollection;
  }
  return { type: 'FeatureCollection', features: [] };
}

/** Read the flat layer's own collection back off the map, or null. */
async function readPerimeterCollection(
  map: maplibregl.Map
): Promise<FeatureCollection | null> {
  const source = map.getSource(PERIMETER_SOURCE_ID) as
    | { getData?: () => Promise<unknown> }
    | undefined;
  if (!source || typeof source.getData !== 'function') return null;
  return asFeatureCollection(await source.getData());
}

/**
 * Raise the ribbon over the perimeters already on the map. Idempotent.
 * Returns false (nothing added) when the perimeter source is absent or
 * holds no wildfire-class geometry; the caller treats that as a non-fatal
 * partial degrade.
 */
export async function activatePerimeterRibbon(
  map: maplibregl.Map,
  signal?: AbortSignal
): Promise<boolean> {
  if (map.getSource(RIBBON_SOURCE_ID)) return true;
  const collection = await readPerimeterCollection(map);
  // A teardown or a superseded activation while the read was in flight: do
  // not render into a scene that no longer wants one.
  if (signal?.aborted) return false;
  if (!collection) return false;
  if (map.getSource(RIBBON_SOURCE_ID)) return true;

  const bands = buildPerimeterRibbonBands(collection);
  if (bands.features.length === 0) return false;

  map.addSource(RIBBON_SOURCE_ID, { type: 'geojson', data: bands });
  PERIMETER_RIBBON_LAYER_IDS.forEach((id, index) => {
    map.addLayer({
      id,
      type: 'fill-extrusion',
      source: RIBBON_SOURCE_ID,
      paint: buildPerimeterRibbonSlabPaint(index)
    });
  });
  // Seat the slabs at their ruled position (EVENT_OVERLAY_IDS, directly
  // above the flat perimeter outline) instead of relying on activation
  // order; this module adds outside the layer controller, so it re-asserts
  // the chain itself, exactly as the smoke volume does.
  reassertThematicOrder(map);
  reassertLabelOrder(map);

  showLegend(LEGEND_KEY, {
    order: LEGEND_ORDER.event + 2,
    render: (body) =>
      renderSwatchLegend(
        body,
        'Perimeter ribbon (3D view)',
        [
          {
            color: NIFC_INCIDENT_PRESENTATION.wildfire.lineColor,
            label: NIFC_INCIDENT_PRESENTATION.wildfire.legendLabel
          }
        ],
        PERIMETER_RIBBON_QUALIFICATION
      )
  });

  return true;
}

/**
 * Remove every slab, the derived source, and the legend section. Defensive
 * guards throughout; symmetric with activate. The ribbon owns its own
 * source, so nothing here can strand or orphan the flat layer's.
 */
export function deactivatePerimeterRibbon(map: maplibregl.Map): void {
  for (const id of PERIMETER_RIBBON_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(RIBBON_SOURCE_ID)) map.removeSource(RIBBON_SOURCE_ID);
  hideLegend(LEGEND_KEY);
}
