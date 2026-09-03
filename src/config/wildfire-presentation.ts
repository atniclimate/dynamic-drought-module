import type * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

import { matchExpression } from './style-expressions';

export interface ArcGisPolygonFeatureCollection {
  readonly collection: FeatureCollection;
  readonly truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPosition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((coordinate) =>
      typeof coordinate === 'number' && Number.isFinite(coordinate)
    )
  );
}

function positionsEqual(first: unknown, last: unknown): boolean {
  return (
    Array.isArray(first) &&
    Array.isArray(last) &&
    first.length === last.length &&
    first.every((coordinate, index) => coordinate === last[index])
  );
}

function isLinearRing(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    value.every(isPosition) &&
    positionsEqual(value[0], value.at(-1))
  );
}

function isPolygonCoordinates(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isLinearRing);
}

function isPolygonGeometry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['type'] === 'Polygon') {
    return isPolygonCoordinates(value['coordinates']);
  }
  return (
    value['type'] === 'MultiPolygon' &&
    Array.isArray(value['coordinates']) &&
    value['coordinates'].length > 0 &&
    value['coordinates'].every(isPolygonCoordinates)
  );
}

/**
 * Validate the common ArcGIS `f=geojson` contract used by the Wildfire feeds.
 * HTTP 200 error bodies and malformed geometries are failures, not clean zero
 * results. A transfer-limit flag is returned separately so callers can render
 * the available polygons while reporting `live (partial)`.
 */
export function parseArcGisPolygonFeatureCollection(
  value: unknown,
  sourceLabel: string
): ArcGisPolygonFeatureCollection {
  if (isRecord(value) && Object.hasOwn(value, 'error')) {
    const error = isRecord(value['error']) ? value['error'] : null;
    const code = error?.['code'];
    const message = error?.['message'];
    throw new Error(
      `${sourceLabel} ArcGIS error ${
        typeof code === 'number' || typeof code === 'string'
          ? String(code)
          : '(unknown code)'
      }: ${typeof message === 'string' ? message : 'unknown error'}`
    );
  }
  if (
    !isRecord(value) ||
    value['type'] !== 'FeatureCollection' ||
    !Array.isArray(value['features']) ||
    (value['exceededTransferLimit'] !== undefined &&
      typeof value['exceededTransferLimit'] !== 'boolean')
  ) {
    throw new Error(`${sourceLabel} response was not a valid FeatureCollection.`);
  }

  for (const feature of value['features']) {
    if (
      !isRecord(feature) ||
      feature['type'] !== 'Feature' ||
      !isPolygonGeometry(feature['geometry']) ||
      !(feature['properties'] === null || isRecord(feature['properties']))
    ) {
      throw new Error(
        `${sourceLabel} response contained an invalid polygon feature.`
      );
    }
  }

  return {
    collection: value as unknown as FeatureCollection,
    truncated: value['exceededTransferLimit'] === true
  };
}

/** Shared, source-derived presentation for NIFC perimeter categories. */
export type NifcIncidentClass = 'wildfire' | 'prescribed' | 'other';

export const NIFC_INCIDENT_TYPE_PROPERTY = 'attr_IncidentTypeCategory';

/**
 * Restrained presentation-only pulse for current mapped Wildfire / Wildfire
 * Complex perimeters. The midpoint is also the static and reduced-motion
 * color so the legend never depends on animation to communicate the class.
 */
export const WILDFIRE_PULSE_COLORS = [
  '#ff3300',
  '#ff4c00',
  '#ff6600'
] as const;

export const WILDFIRE_STATIC_COLOR = WILDFIRE_PULSE_COLORS[1];

/** One complete low-to-high-to-low pulse. */
export const WILDFIRE_PULSE_DURATION_MS = 1_800;

const WILDFIRE_PULSE_KEYFRAMES = [
  WILDFIRE_PULSE_COLORS[0],
  WILDFIRE_PULSE_COLORS[1],
  WILDFIRE_PULSE_COLORS[2],
  WILDFIRE_PULSE_COLORS[1],
  WILDFIRE_PULSE_COLORS[0]
] as const;

type RgbColor = readonly [red: number, green: number, blue: number];

function parseHexColor(color: string): RgbColor {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ];
}

function interpolateHexColor(
  from: string,
  to: string,
  progress: number
): string {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  const channel = (index: number): string =>
    Math.round(start[index]! + (end[index]! - start[index]!) * progress)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * Pure pulse interpolation seam. Exact quarter-cycle keyframes are the three
 * canonical colors; sine easing keeps the reversal at each extreme gentle.
 */
export function interpolateWildfirePulseColor(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return WILDFIRE_STATIC_COLOR;
  const wrapped =
    ((elapsedMs % WILDFIRE_PULSE_DURATION_MS) +
      WILDFIRE_PULSE_DURATION_MS) %
    WILDFIRE_PULSE_DURATION_MS;
  const position =
    (wrapped / WILDFIRE_PULSE_DURATION_MS) *
    (WILDFIRE_PULSE_KEYFRAMES.length - 1);
  const segment = Math.min(
    Math.floor(position),
    WILDFIRE_PULSE_KEYFRAMES.length - 2
  );
  const segmentProgress = position - segment;
  const easedProgress = (1 - Math.cos(Math.PI * segmentProgress)) / 2;
  return interpolateHexColor(
    WILDFIRE_PULSE_KEYFRAMES[segment]!,
    WILDFIRE_PULSE_KEYFRAMES[segment + 1]!,
    easedProgress
  );
}

/**
 * Perimeter presentation by incident class.
 *
 * Outline weights doubled 2026-08-19 on owner direction (3 / 2.8 / 2.4 from
 * 1.5 / 1.4 / 1.2): at overview framing over the satellite basemap the
 * hairlines were too thin to read. The RATIO between the three classes is
 * preserved, so the visual ranking that separates a mapped wildfire from a
 * prescribed burn from an unclassified record is unchanged. Weight is
 * legibility only; it carries no claim about size, intensity, or certainty,
 * and the fills and opacities are untouched.
 */
export const NIFC_INCIDENT_PRESENTATION = {
  wildfire: {
    codes: ['WF', 'CX'] as const,
    fillColor: WILDFIRE_STATIC_COLOR,
    fillOpacity: 0.16,
    lineColor: WILDFIRE_STATIC_COLOR,
    lineOpacity: 0.82,
    lineWidth: 3,
    legendLabel: 'Mapped wildfire perimeter'
  },
  prescribed: {
    codes: ['RX'] as const,
    fillColor: '#64748b',
    fillOpacity: 0.08,
    lineColor: '#cbd5e1',
    lineOpacity: 0.82,
    lineWidth: 2.8,
    legendLabel: 'Prescribed fire perimeter'
  },
  other: {
    codes: [] as const,
    lineColor: '#94a3b8',
    lineOpacity: 0.78,
    lineWidth: 2.4,
    lineDasharray: [2, 2] as const,
    legendLabel: 'Other or unclassified fire perimeter'
  }
} as const;

/** Classify the upstream WFIGS incident type without treating RX as wildfire. */
export function classifyNifcIncidentType(value: unknown): NifcIncidentClass {
  if (typeof value !== 'string') return 'other';
  const code = value.trim().toUpperCase();
  if (code === 'WF' || code === 'CX') return 'wildfire';
  if (code === 'RX') return 'prescribed';
  return 'other';
}

/** User-facing incident type for the perimeter popup. */
export function nifcIncidentTypeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Other or unclassified fire perimeter';
  switch (value.trim().toUpperCase()) {
    case 'WF':
      return 'Wildfire';
    case 'CX':
      return 'Wildfire complex';
    case 'RX':
      return 'Prescribed fire';
    default:
      return 'Other or unclassified fire perimeter';
  }
}

/** The record cap the briefing's perimeter query sends to the service. A
 * page that comes back full means the count is a floor, and the sentence
 * says so. Shared with `src/impact/sources.ts`, which sends it. */
export const NIFC_AREA_QUERY_RECORD_CAP = 50;

/** What the perimeter query actually covered: a bounding box around the
 * selection, not its boundary. Named in the sentence (DR-024 b) because a
 * box is strictly wider than the boundary, so a positive count over the box
 * is not a count over the place. */
const NIFC_AREA_QUERY_EXTENT = 'the bounding box around this selection';

/** Source-honest sentence for the category values returned by the
 * current-perimeters service (DR-024 b, DR-058 a).
 *
 * The count is over the query's bounding box and the sentence names that
 * extent rather than calling it "this area"; the box is wider than the
 * boundary, so a perimeter in a box corner can be counted without touching
 * the place, and the sentence must not claim more than the query proved.
 * When every record is one category the sentence carries one count (the
 * old form repeated it: "3 ... perimeters intersect this area: 3 wildfire
 * perimeters"); when categories mix, Prescribed fire and unclassified
 * records stay explicit instead of being folded into a wildfire count. A
 * page that came back at the record cap reads as a lower bound. */
export function buildNifcAreaPerimeterClaim(
  incidentTypes: readonly unknown[],
  options: { readonly truncated?: boolean } = {}
): string {
  const counts: Record<NifcIncidentClass, number> = {
    wildfire: 0,
    prescribed: 0,
    other: 0
  };
  for (const value of incidentTypes) {
    counts[classifyNifcIncidentType(value)] += 1;
  }

  const total = incidentTypes.length;
  if (total === 0) {
    return `No current mapped NIFC fire perimeters intersect ${NIFC_AREA_QUERY_EXTENT}.`;
  }

  const floor = options.truncated
    ? ` The service returned its ${NIFC_AREA_QUERY_RECORD_CAP}-record maximum, so this count is a lower bound.`
    : '';
  const verb = total === 1 ? 'perimeter intersects' : 'perimeters intersect';

  const categoryLabel: Record<NifcIncidentClass, string> = {
    wildfire: 'wildfire',
    prescribed: 'Prescribed fire',
    other: 'other or unclassified fire'
  };
  const present = (Object.keys(counts) as NifcIncidentClass[]).filter(
    (key) => counts[key] > 0
  );
  if (present.length === 1) {
    const only = present[0] as NifcIncidentClass;
    return `${total} current mapped NIFC ${categoryLabel[only]} ${verb} ${NIFC_AREA_QUERY_EXTENT}.${floor}`;
  }

  const parts = present.map((key) => `${counts[key]} ${categoryLabel[key]}`);
  const categories = `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${total} current mapped NIFC fire ${verb} ${NIFC_AREA_QUERY_EXTENT}: ${categories}.${floor}`;
}

const NORMALIZED_NIFC_TYPE: maplibregl.ExpressionSpecification = [
  'upcase',
  ['to-string', ['coalesce', ['get', NIFC_INCIDENT_TYPE_PROPERTY], '']]
];

/** MapLibre filter used by the corresponding NIFC presentation layer. */
export function buildNifcIncidentFilter(
  incidentClass: NifcIncidentClass
): maplibregl.FilterSpecification {
  if (incidentClass === 'wildfire') {
    return [
      'in',
      NORMALIZED_NIFC_TYPE,
      ['literal', [...NIFC_INCIDENT_PRESENTATION.wildfire.codes]]
    ] as maplibregl.FilterSpecification;
  }
  if (incidentClass === 'prescribed') {
    return [
      'in',
      NORMALIZED_NIFC_TYPE,
      ['literal', [...NIFC_INCIDENT_PRESENTATION.prescribed.codes]]
    ] as maplibregl.FilterSpecification;
  }
  return [
    '!',
    [
      'in',
      NORMALIZED_NIFC_TYPE,
      [
        'literal',
        [
          ...NIFC_INCIDENT_PRESENTATION.wildfire.codes,
          ...NIFC_INCIDENT_PRESENTATION.prescribed.codes
        ]
      ]
    ]
  ] as maplibregl.FilterSpecification;
}

export function buildNifcFillPaint(
  incidentClass: 'wildfire' | 'prescribed'
): NonNullable<maplibregl.FillLayerSpecification['paint']> {
  const presentation = NIFC_INCIDENT_PRESENTATION[incidentClass];
  return {
    'fill-color': presentation.fillColor,
    'fill-opacity': presentation.fillOpacity,
    ...(incidentClass === 'wildfire'
      ? { 'fill-color-transition': { duration: 0, delay: 0 } }
      : {})
  };
}

export function buildNifcLinePaint(
  incidentClass: NifcIncidentClass
): NonNullable<maplibregl.LineLayerSpecification['paint']> {
  const presentation = NIFC_INCIDENT_PRESENTATION[incidentClass];
  return {
    'line-color': presentation.lineColor,
    'line-opacity': presentation.lineOpacity,
    'line-width': presentation.lineWidth,
    ...(incidentClass === 'wildfire'
      ? { 'line-color-transition': { duration: 0, delay: 0 } }
      : {}),
    ...(incidentClass === 'other'
      ? { 'line-dasharray': [...NIFC_INCIDENT_PRESENTATION.other.lineDasharray] }
      : {})
  };
}

export type HmsDensityClass = 'Light' | 'Medium' | 'Heavy' | 'Unknown';

/** One cool hue, with density carried by opacity and an explicit neutral fallback. */
export const HMS_DENSITY_PRESENTATION = {
  Light: {
    color: '#93a8c4',
    opacity: 0.08,
    legendLabel: 'Light smoke (8% veil)',
    popupLabel: 'Light smoke'
  },
  Medium: {
    color: '#93a8c4',
    opacity: 0.17,
    legendLabel: 'Medium smoke (17% veil)',
    popupLabel: 'Medium smoke'
  },
  Heavy: {
    color: '#93a8c4',
    opacity: 0.33,
    legendLabel: 'Heavy smoke (33% veil)',
    popupLabel: 'Heavy smoke'
  },
  Unknown: {
    color: '#64748b',
    opacity: 0.12,
    legendLabel: 'Unclassified smoke density',
    popupLabel: 'Unclassified smoke density'
  }
} as const;

export const HMS_OVERVIEW_QUALIFICATION =
  'NOAA Hazard Mapping System, analyst-drawn from GOES imagery; current or previous UTC day. Its plume observation window is independent of the recent NOAA GeoColor basemap frame. Density opacity is presentation, not ground-level air quality.';

export function resolveHmsDensityClass(value: unknown): HmsDensityClass {
  if (typeof value !== 'string') return 'Unknown';
  switch (value.trim().toLowerCase()) {
    case 'light':
      return 'Light';
    case 'medium':
      return 'Medium';
    case 'heavy':
      return 'Heavy';
    default:
      return 'Unknown';
  }
}

export function resolveHmsDensityPresentation(
  value: unknown
): (typeof HMS_DENSITY_PRESENTATION)[HmsDensityClass] {
  return HMS_DENSITY_PRESENTATION[resolveHmsDensityClass(value)];
}

const NORMALIZED_HMS_DENSITY: maplibregl.ExpressionSpecification = [
  'upcase',
  ['to-string', ['coalesce', ['get', 'Density'], '']]
];

/** Exact paint installed by the HMS layer. Unknown never falls through to Light. */
export function buildHmsSmokeFillPaint(): NonNullable<
  maplibregl.FillLayerSpecification['paint']
> {
  return {
    'fill-color': [
      'match',
      NORMALIZED_HMS_DENSITY,
      'LIGHT',
      HMS_DENSITY_PRESENTATION.Light.color,
      'MEDIUM',
      HMS_DENSITY_PRESENTATION.Medium.color,
      'HEAVY',
      HMS_DENSITY_PRESENTATION.Heavy.color,
      HMS_DENSITY_PRESENTATION.Unknown.color
    ],
    'fill-opacity': [
      'match',
      NORMALIZED_HMS_DENSITY,
      'LIGHT',
      HMS_DENSITY_PRESENTATION.Light.opacity,
      'MEDIUM',
      HMS_DENSITY_PRESENTATION.Medium.opacity,
      'HEAVY',
      HMS_DENSITY_PRESENTATION.Heavy.opacity,
      HMS_DENSITY_PRESENTATION.Unknown.opacity
    ]
  };
}

/**
 * Vertical scale for the 3D smoke volume (W4): each density class's stylized
 * extrusion height is its 2D veil opacity times this many meters, so the
 * vertical ranking can never disagree with the ruled opacity ranking.
 *
 * RAISED from 4,000 to 10,000 on 2026-08-19, after the owner reported that
 * volumetric smoke "doesn't seem to work" and the diagnosis showed it was
 * rendering the whole time. HMS plumes are regional swaths, hundreds of
 * kilometres across; at 320 to 1,320 m a plume was a 300:1 sheet, and the
 * terrain it sits over reads up to about 7 km tall at the scene's 2.4x
 * exaggeration, which the smoke deliberately does NOT share. The volume
 * was there and had nothing to read as volume.
 *
 * Raising the scale is honest because the heights were never measurements:
 * HMS_VOLUME_QUALIFICATION already says the vertical extent is a stylized
 * encoding of the issuer's density class, and it still says exactly that.
 * The ranking, the opacity coupling, and the class-to-height derivation are
 * unchanged; only the constant moved. Nothing here claims a plume top.
 */
export const HMS_VOLUME_HEIGHT_SCALE_METERS = 10_000;

/**
 * The stylized height per density class, DERIVED rather than typed twice.
 *
 * These numbers appear in the extrusion paint and, word for word, in the
 * legend a person reads. Before this table they were hand-copied literals
 * in both places, which is a drift waiting to happen the moment the scale
 * changes. Rounded to the nearest 10 m so the legend reads as a stylized
 * figure rather than a spurious measurement.
 */
export const HMS_VOLUME_HEIGHTS: Readonly<Record<HmsDensityClass, number>> = {
  Light: Math.round((HMS_DENSITY_PRESENTATION.Light.opacity * HMS_VOLUME_HEIGHT_SCALE_METERS) / 10) * 10,
  Medium: Math.round((HMS_DENSITY_PRESENTATION.Medium.opacity * HMS_VOLUME_HEIGHT_SCALE_METERS) / 10) * 10,
  Heavy: Math.round((HMS_DENSITY_PRESENTATION.Heavy.opacity * HMS_VOLUME_HEIGHT_SCALE_METERS) / 10) * 10,
  Unknown: Math.round((HMS_DENSITY_PRESENTATION.Unknown.opacity * HMS_VOLUME_HEIGHT_SCALE_METERS) / 10) * 10
};

/** Honest legend line for the 3D smoke volume. */
export const HMS_VOLUME_QUALIFICATION =
  'Vertical extent is a stylized encoding of the issuer\'s density class (Light, Medium, Heavy), not measured plume height, concentration, or transport.';

/**
 * Exact paint installed by the 3D smoke volume layer (hms-smoke-volume).
 *
 * Heights come from HMS_VOLUME_HEIGHTS, which derives them from the 2D veil
 * opacities times HMS_VOLUME_HEIGHT_SCALE_METERS. They used to be baked
 * here as literals AND typed again in the legend; deriving them once means
 * a scale change cannot leave the legend describing heights the map is not
 * drawing. The match mirrors buildHmsSmokeFillPaint, including the guard
 * that an Unknown density NEVER falls through to the Light class. Colors
 * match the 2D veil exactly.
 *
 * fill-extrusion-opacity is not data-driven in the MapLibre style
 * specification, so the per-class opacity ramp of the flat veil cannot be
 * reproduced per feature here; the volume carries density in its height and
 * keeps one mid-ramp translucency (the 2D Medium veil) so overlapping
 * plumes still read through each other.
 */
export const HMS_VOLUME_OPACITY = HMS_DENSITY_PRESENTATION.Medium.opacity;

export function buildHmsSmokeVolumePaint(): NonNullable<
  maplibregl.FillExtrusionLayerSpecification['paint']
> {
  return {
    'fill-extrusion-color': [
      'match',
      NORMALIZED_HMS_DENSITY,
      'LIGHT',
      HMS_DENSITY_PRESENTATION.Light.color,
      'MEDIUM',
      HMS_DENSITY_PRESENTATION.Medium.color,
      'HEAVY',
      HMS_DENSITY_PRESENTATION.Heavy.color,
      HMS_DENSITY_PRESENTATION.Unknown.color
    ],
    'fill-extrusion-height': [
      'match',
      NORMALIZED_HMS_DENSITY,
      'LIGHT',
      HMS_VOLUME_HEIGHTS.Light,
      'MEDIUM',
      HMS_VOLUME_HEIGHTS.Medium,
      'HEAVY',
      HMS_VOLUME_HEIGHTS.Heavy,
      HMS_VOLUME_HEIGHTS.Unknown
    ],
    'fill-extrusion-base': 0,
    'fill-extrusion-opacity': HMS_VOLUME_OPACITY
  };
}

/**
 * Static United States Forest Service Wildfire Hazard Potential key.
 *
 * CORRECTED 2026-08-19, and the correction is the point. This table
 * previously listed five classes in a ColorBrewer RdYlGn ramp
 * (#1a9850, #91cf60, #fee08b, #fc8d59, #d73027). The service renders
 * neither those colors nor only five classes. Its own legend endpoint
 * serves SEVEN entries in the colors below, and an exportImage sample
 * over central Oregon contained exactly those seven values and nothing
 * else (probed live 2026-08-19). So the key on screen described a
 * different image than the one beside it, and the two classes that carry
 * no hazard rating, non-burnable land and water, rendered with no legend
 * entry at all.
 *
 * The values here are now the issuer's, decoded from the legend
 * endpoint's own swatches, and scripts/build-whp-tiles.mjs re-fetches
 * that legend on every bake and HARD-FAILS when this table and the served
 * legend disagree, exactly as the fuels bake does. A legend and its
 * raster cannot drift apart again without the build stopping.
 *
 * The last two entries are deliberately kept: they are not hazard
 * ratings, they DO paint pixels, and a person seeing grey and blue areas
 * deserves to know what they are rather than guessing at a missing class.
 */
export const USFS_WHP_PRESENTATION = {
  categories: [
    { label: 'Very Low', color: '#38a300' },
    { label: 'Low', color: '#a3ff94' },
    { label: 'Moderate', color: '#ffff63' },
    { label: 'High', color: '#ffa300' },
    { label: 'Very High', color: '#ed1e00' },
    { label: 'Non-burnable', color: '#e1e1e1' },
    { label: 'Water', color: '#0070e1' }
  ],
  qualification:
    // vocab-allow: honesty disclaimer distinguishes static WHP from a forecast
    'United States Forest Service Wildfire Hazard Potential, static 2023 edition, 270 m resolution, conterminous United States (CONUS) only; potential context, not current fire conditions or a forecast. The last two classes are the issuer\'s non-hazard classes: they mark land that does not carry fire and open water, not a hazard rating.'
} as const;

/**
 * DR-063: the Wildfire Hazard Potential black-to-white ramp, recorded as a
 * DDM PRESENTATION CONVENTION and NOT YET DRAWN.
 *
 * The owner's design decision (decision register DR-063, option a, decided
 * 2026-09-02): "a black-to-white ramp with calibrated transparency that
 * composes with both the terrain layer and the perimeter symbology. The
 * class breaks, class labels and the legend's issuer attribution stay the
 * issuer's; only the presentation ramp changes, and it is labeled a DDM
 * presentation convention because the 2026-08-19 research chose the
 * issuer-published palette." The owner's prose fixes the direction with no
 * ambiguity: black is the LOWEST fuel risk, white the HIGHEST, so white
 * fuel risk separates at a glance from the warm red and orange perimeter
 * symbology, and the surface stays translucent enough that ridgelines,
 * valleys, and hydrography keep reading through it.
 *
 * WHY THIS TABLE IS DATA AND NOT PAINT (verified 2026-09-03). Both WHP
 * surfaces are issuer-RENDERED rasters: the flat `usfs-whp` catalog layer
 * pulls Portable Network Graphics tiles from the GeoPlatform ImageServer's
 * `exportImage` operation, which bakes the class colors server-side in its
 * own raster function, and the 3D drape reads a Protomaps PMTiles archive
 * of those same server-rendered bytes. Recoloring them needs one of two
 * things, and this repository has neither today:
 *
 *   1. A client-side raster recolor. MapLibre 6.6.0 (style specification
 *      26.4.1) exposes exactly nine raster paint properties:
 *      `raster-opacity`, `raster-hue-rotate`, `raster-brightness-min`,
 *      `raster-brightness-max`, `raster-saturation`, `raster-contrast`,
 *      `resampling`, `raster-resampling`, and `raster-fade-duration`.
 *      There is no `raster-color`, and the string does not appear anywhere
 *      in the shipped library. The nine that do exist compose to an affine
 *      map on red, green, and blue, so the only grey they can produce is
 *      the luminance of the issuer color; the issuer's luminances run
 *      Very High 0.28, Water 0.38, Very Low 0.50, High 0.67,
 *      Non-burnable 0.88, Low 0.89, Moderate 0.96, which is not the hazard
 *      order in either direction. A filter cannot express this ramp.
 *   2. A rendering rule on the request. The layer sends `bbox`, `bboxSR`,
 *      `imageSR`, `size`, `format`, `transparent`, and `f` and no
 *      `renderingRule`; adding one changes the upstream request and the
 *      Worker route policy, so it is an owner decision rather than a
 *      presentation change.
 *
 * UNTIL THE PIXELS CHANGE, THE KEY KEEPS THE ISSUER SWATCHES. Pointing the
 * key and the legend at this ramp on its own would reproduce the exact
 * defect the table above was corrected for on 2026-08-19: a key describing
 * a different image than the one beside it. `USFS_WHP_PRESENTATION` stays
 * the rendering truth for both the map key and the 3D drape legend, and
 * this table is inert, in the same way `FBFM40_PRESENTATION` below is
 * retired from the scene but kept for its cross-check.
 *
 * THE NON-HAZARD CLASSES ARE DELIBERATELY OFF THE RAMP, and this is the
 * one place the owner's prose leaves two readings. Reading one puts all
 * seven issuer classes on the grey ramp; reading two puts only the five
 * hazard classes on it. Reading one is rejected because once every grey on
 * this surface means a fuel-risk level, the issuer's light grey
 * Non-burnable would read as near-highest hazard, contradicting the
 * issuer's own statement that it is not a hazard rating. Reading two is
 * what the prose supports ("black, lowest fuel risk, to white, highest
 * fuel risk"), so the two non-hazard classes carry no grey at all: they
 * draw nothing, which also serves the owner's ask that hydrography read
 * through, since the basemap already draws water. That sub-choice, drawn
 * as nothing versus drawn as some off-ramp treatment, is flagged for the
 * owner rather than settled here.
 *
 * The five labels and their order are the issuer's, unchanged and
 * unmovable; only the color and the alpha are DDM's.
 */
export const WHP_DDM_RAMP_CONVENTION = {
  /** Not the issuer's colors. Never present this ramp as USFS's. */
  ddmConvention:
    'DDM presentation convention: the colors and alpha below are DDM\'s, the class breaks and class labels are the United States Forest Service\'s and do not move.',
  /** Recorded, not wired. See the module comment above. */
  applied: false,
  /**
   * Black to white across the issuer's five hazard classes, even in
   * lightness (CIE L* approximately 4, 26, 49, 75, 100) so the steps read
   * as equal increments rather than crowding at one end, with alpha
   * climbing so the low end stays quiet against terrain and the high end
   * is the prominent one.
   */
  hazardClasses: [
    { label: 'Very Low', color: '#0d0d0d', alpha: 0.3 },
    { label: 'Low', color: '#3d3d3d', alpha: 0.38 },
    { label: 'Moderate', color: '#757575', alpha: 0.46 },
    { label: 'High', color: '#b8b8b8', alpha: 0.56 },
    { label: 'Very High', color: '#ffffff', alpha: 0.68 }
  ],
  /** Off the ramp: no grey value, because no fuel-risk level applies. */
  nonHazardClasses: [
    { label: 'Non-burnable', color: null, alpha: 0 },
    { label: 'Water', color: null, alpha: 0 }
  ]
} as const;

/**
 * LANDFIRE 2024 (LF2024) Scott and Burgan 40 Fire Behavior Fuel Models
 * (FBFM40) drape for the desktop 3D Fire mode (the fuels context layer).
 *
 * The colors are the ISSUER'S published class colors, decoded verbatim from
 * the LF2024_FBFM40_CONUS ImageServer legend endpoint on 2026-08-19 UTC
 * (the bake's own retrieval clock; scripts/build-fuels-tiles.mjs re-fetches
 * the legend on every rebake and HARD-FAILS when this table and the served
 * legend disagree, so the archive's pixels and this key cannot drift
 * apart). The drape drew these colors translucent (DRAPE_OPACITY) so
 * terrain and incident layers stayed legible; the qualification below
 * discloses that. RETIRED FROM THE SCENE 2026-08-19: the hazard drape
 * replaced it, and this table now serves the builder's cross-check and a
 * possible future opt-in rather than a rendering layer. Class names are the standard Scott
 * and Burgan (2005) fuel model names as published in the LANDFIRE FBFM40
 * data dictionary.
 */
export const FBFM40_PRESENTATION = {
  classes: [
    { code: 'NB1', label: 'Urban or developed', color: '#686868' },
    { code: 'NB2', label: 'Snow or ice', color: '#e1e1e1' },
    { code: 'NB3', label: 'Agricultural', color: '#ffeded' },
    { code: 'NB8', label: 'Open water', color: '#000ed6' },
    { code: 'NB9', label: 'Bare ground', color: '#4d6e70' },
    { code: 'GR1', label: 'Short, sparse dry climate grass', color: '#ffebbe' },
    { code: 'GR2', label: 'Low load, dry climate grass', color: '#ffd373' },
    { code: 'GR3', label: 'Low load, very coarse humid climate grass', color: '#ffec8b' },
    { code: 'GR4', label: 'Moderate load, dry climate grass', color: '#ffff73' },
    { code: 'GR5', label: 'Low load, humid climate grass', color: '#f5de29' },
    { code: 'GR6', label: 'Moderate load, humid climate grass', color: '#e6e640' },
    { code: 'GR7', label: 'High load, dry climate grass', color: '#cdc673' },
    { code: 'GR8', label: 'High load, very coarse humid climate grass', color: '#8b864e' },
    { code: 'GS1', label: 'Low load, dry climate grass-shrub', color: '#ffaa00' },
    { code: 'GS2', label: 'Moderate load, dry climate grass-shrub', color: '#ffa77f' },
    { code: 'GS3', label: 'Moderate load, humid climate grass-shrub', color: '#ff6300' },
    { code: 'GS4', label: 'High load, humid climate grass-shrub', color: '#cd6600' },
    { code: 'SH1', label: 'Low load dry climate shrub', color: '#d7c29e' },
    { code: 'SH2', label: 'Moderate load dry climate shrub', color: '#d7b09e' },
    { code: 'SH3', label: 'Moderate load, humid climate shrub', color: '#cd8966' },
    { code: 'SH4', label: 'Low load, humid climate timber-shrub', color: '#895a44' },
    { code: 'SH5', label: 'High load, dry climate shrub', color: '#cdaa66' },
    { code: 'SH6', label: 'Low load, humid climate shrub', color: '#ed7044' },
    { code: 'SH7', label: 'Very high load, dry climate shrub', color: '#cd7d39' },
    { code: 'SH8', label: 'High load, humid climate shrub', color: '#a83800' },
    { code: 'SH9', label: 'Very high load, humid climate shrub', color: '#731a00' },
    { code: 'TU1', label: 'Low load dry climate timber-grass-shrub', color: '#e9ffbe' },
    { code: 'TU2', label: 'Moderate load, humid climate timber-shrub', color: '#aaff00' },
    { code: 'TU3', label: 'Moderate load, humid climate timber-grass-shrub', color: '#b4d79e' },
    { code: 'TU4', label: 'Dwarf conifer with understory', color: '#70a800' },
    { code: 'TU5', label: 'Very high load, dry climate timber-shrub', color: '#267300' },
    { code: 'TL1', label: 'Low load compact conifer litter', color: '#beffe8' },
    { code: 'TL2', label: 'Low load broadleaf litter', color: '#00ffc5' },
    { code: 'TL3', label: 'Moderate load conifer litter', color: '#bed2ff' },
    { code: 'TL4', label: 'Small downed logs', color: '#7b68ee' },
    { code: 'TL5', label: 'High load conifer litter', color: '#bee8ff' },
    { code: 'TL6', label: 'Moderate load broadleaf litter', color: '#00c5ff' },
    { code: 'TL7', label: 'Large downed logs', color: '#0084a8' },
    { code: 'TL8', label: 'Long-needle litter', color: '#005ce6' },
    { code: 'TL9', label: 'Very high load broadleaf litter', color: '#4d6e91' },
    { code: 'SB1', label: 'Low load activity fuel', color: '#e8beff' },
    { code: 'SB2', label: 'Moderate load activity fuel or low load blowdown', color: '#c500ff' },
    { code: 'SB3', label: 'High load activity fuel or moderate load blowdown', color: '#ffbee8' },
    { code: 'SB4', label: 'High load blowdown', color: '#ff7f7f' }
  ],
  qualification:
    // vocab-allow: honesty disclaimer distinguishes the static fuel snapshot from a forecast
    'LANDFIRE 2024 fuel model classes (Scott and Burgan 40), shown with LANDFIRE\'s published class colors, drawn translucent at reduced resolution from the 30 m source; a static classified snapshot of vegetation as fuel, not current conditions, fire behavior, or a forecast.'
} as const;

/**
 * Drape opacity for the 3D scene's landscape surface.
 *
 * Named for the role rather than the layer since 2026-08-19, when the
 * fuel-model drape was replaced by the hazard drape: half opacity is what
 * keeps a full-viewport classified surface as CONTEXT beneath the
 * perimeters, smoke, and infrastructure that carry the incident, rather
 * than a wall of color the eye reads first. The value is unchanged.
 */
export const DRAPE_OPACITY = 0.5;

/**
 * Power infrastructure context for the desktop 3D Fire mode.
 *
 * Transmission lines: the ARCHIVED federal HIFLD dataset via the Esri
 * Federal User Community copy (public, Extract-enabled, accessInformation
 * "U.S. Government"; last data update 2024-09-30), baked once by
 * scripts/build-power-tiles.mjs. The issuer's VOLT_CLASS attribute drives
 * line WIDTH only, a presentation ramp over the issuer's own classes; one
 * color for every line so the layer never reads as a data ramp. Issuer
 * sentinels are preserved: VOLT_CLASS 'NOT AVAILABLE' draws at the
 * thinnest width and the qualification says so.
 *
 * Plants: the U.S. Energy Information Administration layer (EIA Forms
 * 860/860M), fetched live; the Period attribute carries the issuer's own
 * reporting vintage and the legend prints it.
 */
export const POWER_LINE_COLOR = '#e8eef5';
export const POWER_LINE_OPACITY = 0.75;

/** Width per issuer VOLT_CLASS (kV); the seven classes served inside the
 * PNW envelope, verified live 2026-08-19 UTC. Unknown classes draw at the
 * thinnest width, disclosed in the qualification. */
export const POWER_LINE_WIDTHS: readonly (readonly [string, number])[] = [
  ['UNDER 100', 0.6],
  ['100-161', 1.0],
  ['220-287', 1.4],
  ['345', 1.8],
  ['500', 2.2],
  ['DC', 1.8],
  ['NOT AVAILABLE', 0.6]
];

export function buildPowerLinePaint(): NonNullable<
  maplibregl.LineLayerSpecification['paint']
> {
  // `matchExpression` does the head-pair/tail split the Style Spec tuple type
  // requires. For every non-empty palette, and so for POWER_LINE_WIDTHS as
  // shipped, the emitted array is the same one the older cast-and-spread form
  // produced; for an empty palette the two disagree and both are invalid, so
  // the helper throws instead of emitting either.
  return {
    'line-color': POWER_LINE_COLOR,
    'line-opacity': POWER_LINE_OPACITY,
    'line-width': matchExpression(
      ['get', 'VOLT_CLASS'],
      POWER_LINE_WIDTHS,
      0.6,
      'POWER_LINE_WIDTHS'
    )
  };
}

export const POWER_PLANT_PRESENTATION = {
  color: '#ffd166',
  strokeColor: '#0b1220',
  radius: 3.5
} as const;

export function buildPowerPlantPaint(): NonNullable<
  maplibregl.CircleLayerSpecification['paint']
> {
  return {
    'circle-color': POWER_PLANT_PRESENTATION.color,
    'circle-stroke-color': POWER_PLANT_PRESENTATION.strokeColor,
    'circle-stroke-width': 1,
    'circle-radius': POWER_PLANT_PRESENTATION.radius,
    'circle-opacity': 0.9
  };
}

/**
 * Clustered plant symbols (2026-08-19 owner direction: the unclustered
 * dots "cluster poorly" and read as noise at regional framing).
 *
 * A cluster circle is a COUNT of issuer records, nothing more: it is the
 * same yellow as a single plant, dimmed and outlined so it never reads as
 * one large plant, and it prints its own count. Radius steps with the
 * count so a person can rank groups at a glance without the size implying
 * capacity, which the symbols explicitly do not carry.
 */
export const POWER_PLANT_CLUSTER_PRESENTATION = {
  color: '#c8a23f',
  strokeColor: '#ffd166',
  textColor: '#0b1220',
  /** [count threshold, radius] steps, smallest first. */
  radiusSteps: [
    [0, 9],
    [10, 13],
    [40, 17]
  ] as readonly (readonly [number, number])[]
} as const;

export function buildPowerPlantClusterPaint(): NonNullable<
  maplibregl.CircleLayerSpecification['paint']
> {
  const [, base] = POWER_PLANT_CLUSTER_PRESENTATION.radiusSteps[0]!;
  const steps = POWER_PLANT_CLUSTER_PRESENTATION.radiusSteps.slice(1);
  return {
    'circle-color': POWER_PLANT_CLUSTER_PRESENTATION.color,
    'circle-stroke-color': POWER_PLANT_CLUSTER_PRESENTATION.strokeColor,
    'circle-stroke-width': 1,
    'circle-opacity': 0.88,
    'circle-radius': [
      'step',
      ['get', 'point_count'],
      base,
      ...steps.flatMap(([threshold, radius]) => [threshold, radius])
    ]
  };
}

/**
 * The zoom at which the power surfaces draw.
 *
 * Owner direction 2026-08-19: "electrical infrastructure should appear
 * when zoomed in". Below this the layer reports the honest `zoom in to
 * load` state instead of painting a continental smear of lines and dots
 * that can be neither read nor clicked. Six is roughly a multi-state
 * frame, where an individual line still separates from its neighbor.
 */
export const POWER_MIN_ZOOM = 6;

/**
 * The power legend note is COMPOSED from these parts so it only ever
 * describes surfaces actually in the scene (either source may degrade
 * alone): the lines part when the archive is on, the plants part when the
 * live fetch succeeded, and the shared closing always.
 */
export const POWER_LINES_QUALIFICATION =
  'Transmission lines: HIFLD (U.S. Government) ARCHIVED snapshot, last data update 2024-09-30, no longer maintained; includes records the issuer marks inactive or status-unknown, drawn identically; line width follows the issuer\'s voltage class, and an unknown class draws dashed at the thinnest width.';

export const POWER_PLANTS_QUALIFICATION =
  'Power plants: EIA inventory locations (Forms 860/860M); symbols mark location only, not capacity or fuel. Grouped symbols count issuer records in view; the count is not a capacity.';

/**
 * The absence statement.
 *
 * Re-verified 2026-08-19: there is no authoritative public national
 * dataset of distribution circuits, and that is by design rather than by
 * oversight. Distribution networks are utility-proprietary, and the
 * federal substation layer has been withheld on security grounds since
 * 2022. A viewer who sees only long transmission lines could reasonably
 * conclude the sparse network IS the grid, so the interface says plainly
 * what is missing and why. Naming the reason matters: "absent by design"
 * alone reads as a DDM choice, when the choice belongs to the issuers.
 */
export const POWER_SHARED_QUALIFICATION =
  'Not comprehensive or current; never for siting or safety-critical decisions. Substations and distribution circuits are absent because no authoritative public national source publishes them: distribution networks are held privately by utilities, and substation locations have been withheld for security since 2022. Their absence here is not evidence that none are present.';

/**
 * Structures context for the desktop 3D Fire mode: Overture Maps
 * Foundation building footprints (ODbL), central Oregon pilot bake.
 *
 * Height honesty is carried in the paint split: footprints with an
 * issuer-published height extrude to it in the measured tone; the rest
 * draw in a visibly DIMMER tone at a disclosed placeholder height (three
 * meters per published floor, otherwise a fixed four meters).
 * fill-extrusion-opacity is not data-driven in the MapLibre style
 * specification, so the distinction rides color, exactly like the smoke
 * volume's constant-opacity constraint.
 */
export const STRUCTURES_PRESENTATION = {
  measuredColor: '#cfc8bd',
  placeholderColor: '#78706a',
  opacity: 0.85,
  metersPerFloor: 3,
  placeholderMeters: 4
} as const;

export function buildStructuresMeasuredPaint(): NonNullable<
  maplibregl.FillExtrusionLayerSpecification['paint']
> {
  return {
    'fill-extrusion-color': STRUCTURES_PRESENTATION.measuredColor,
    'fill-extrusion-height': ['get', 'h'],
    'fill-extrusion-base': 0,
    'fill-extrusion-opacity': STRUCTURES_PRESENTATION.opacity
  };
}

export function buildStructuresPlaceholderPaint(): NonNullable<
  maplibregl.FillExtrusionLayerSpecification['paint']
> {
  return {
    'fill-extrusion-color': STRUCTURES_PRESENTATION.placeholderColor,
    'fill-extrusion-height': [
      'case',
      ['has', 'f'],
      ['*', ['get', 'f'], STRUCTURES_PRESENTATION.metersPerFloor],
      STRUCTURES_PRESENTATION.placeholderMeters
    ],
    'fill-extrusion-base': 0,
    'fill-extrusion-opacity': STRUCTURES_PRESENTATION.opacity
  };
}

export const STRUCTURES_QUALIFICATION =
  'Overture Maps Foundation building footprints (ODbL; includes OpenStreetMap and other open sources), release 2026-07-22.0, central Oregon pilot coverage only, drawn from zoom 13. Buildings extrude to the issuer\'s published height where one exists (72 percent of this bake); the dimmer tone marks a disclosed placeholder height (three meters per published floor, otherwise four meters), never a measured value. Footprints and heights are open-data representations, not parcel, occupancy, or condition records.';

/**
 * NIFC WFIGS query scope (FE-16, 2026-08-28).
 *
 * The national perimeters query used to ask for every attribute and
 * full-precision geometry: 42.75 MB in 41.6 s for 243 perimeters, measured
 * 2026-08-28, against the layer's 15 s budget, so the Fire view's primary
 * evidence read `unavailable` on every boot. The attribute list below is
 * exactly what the layer, its popup, the map key, and the conditions strip
 * read, checked against the service schema (`FeatureServer/0?f=pjson`); a
 * name the service does not know is an HTTP 400, so the list must stay
 * schema-exact. `attr_DailyAcres` is not on the service and is not requested.
 *
 * The generalization asks the service to simplify each outline before it
 * leaves the server (`maxAllowableOffset` in the degrees of EPSG:4326,
 * `geometryPrecision` decimal places). 0.0005 degree is roughly 56 m of
 * latitude and 37 to 50 m of longitude across mapped United States
 * latitudes. Measured the same day with the field list: 1.83 MB in 4.5 s.
 * That is a change to what the map shows, not only to transport, so the
 * note below travels with the legend, the popup, and the map key. Viewport
 * or region scoping stays with roadmap task DDM-P1-T06.
 */
export const NIFC_OUT_FIELDS = [
  'attr_IncidentName',
  'poly_IncidentName',
  'attr_IncidentTypeCategory',
  'attr_UniqueFireIdentifier',
  'attr_IrwinID',
  'attr_IncidentSize',
  'poly_GISAcres',
  'attr_FireDiscoveryDateTime',
  'attr_POOState'
] as const;

/** Degrees of EPSG:4326; see the note above for the metric equivalent. */
export const NIFC_MAX_ALLOWABLE_OFFSET_DEG = 0.0005;

/** Coordinate decimal places requested from the service (about one meter). */
export const NIFC_GEOMETRY_PRECISION = 5;

/** The full statement, for the sidebar legend and the perimeter popup. */
export const NIFC_GENERALIZATION_NOTE =
  'Outlines are generalized by the NIFC service for display at a 0.0005 degree tolerance (roughly 37 to 56 m across mapped United States latitudes); the displayed edge is not the full-resolution source geometry.';

/** The compact statement for the on-map key. */
export const NIFC_KEY_GENERALIZATION_NOTE =
  'Outlines generalized by the service at 0.0005 degree (up to about 56 m); not for tactical or evacuation decisions.';
