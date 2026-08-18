import type maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

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

export const NIFC_INCIDENT_PRESENTATION = {
  wildfire: {
    codes: ['WF', 'CX'] as const,
    fillColor: WILDFIRE_STATIC_COLOR,
    fillOpacity: 0.16,
    lineColor: WILDFIRE_STATIC_COLOR,
    lineOpacity: 0.82,
    lineWidth: 1.5,
    legendLabel: 'Mapped wildfire perimeter'
  },
  prescribed: {
    codes: ['RX'] as const,
    fillColor: '#64748b',
    fillOpacity: 0.08,
    lineColor: '#cbd5e1',
    lineOpacity: 0.82,
    lineWidth: 1.4,
    legendLabel: 'Prescribed fire perimeter'
  },
  other: {
    codes: [] as const,
    lineColor: '#94a3b8',
    lineOpacity: 0.78,
    lineWidth: 1.2,
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

/** Source-honest selected-area sentence for the category values returned by
 * the current-perimeters service. Prescribed fire and unclassified records
 * remain explicit instead of being folded into a wildfire count. */
export function buildNifcAreaPerimeterClaim(
  incidentTypes: readonly unknown[]
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
    return 'No current mapped NIFC fire perimeters intersect this area.';
  }

  const parts: string[] = [];
  const addPart = (count: number, label: string): void => {
    if (count === 0) return;
    parts.push(`${count} ${label} ${count === 1 ? 'perimeter' : 'perimeters'}`);
  };
  addPart(counts.wildfire, 'wildfire');
  addPart(counts.prescribed, 'Prescribed fire');
  addPart(counts.other, 'other or unclassified fire');
  const categories =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${total} current mapped NIFC fire ${
    total === 1 ? 'perimeter intersects' : 'perimeters intersect'
  } this area: ${categories}.`;
}

const NORMALIZED_NIFC_TYPE = [
  'upcase',
  ['to-string', ['coalesce', ['get', NIFC_INCIDENT_TYPE_PROPERTY], '']]
] as unknown as maplibregl.ExpressionSpecification;

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

const NORMALIZED_HMS_DENSITY = [
  'upcase',
  ['to-string', ['coalesce', ['get', 'Density'], '']]
] as unknown as maplibregl.ExpressionSpecification;

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
 */
export const HMS_VOLUME_HEIGHT_SCALE_METERS = 4000;

/** Honest legend line for the 3D smoke volume. */
export const HMS_VOLUME_QUALIFICATION =
  'Vertical extent is a stylized encoding of the issuer\'s density class (Light, Medium, Heavy), not measured plume height, concentration, or transport.';

/**
 * Exact paint installed by the 3D smoke volume layer (hms-smoke-volume).
 *
 * Heights are the 2D veil opacities times HMS_VOLUME_HEIGHT_SCALE_METERS,
 * baked as literals so the paint is auditable at a glance: Light 0.08 to
 * 320 m, Medium 0.17 to 680 m, Heavy 0.33 to 1320 m, Unknown 0.12 to 480 m.
 * The match mirrors buildHmsSmokeFillPaint, including the guard that an
 * Unknown density NEVER falls through to the Light class. Colors match the
 * 2D veil exactly.
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
      320,
      'MEDIUM',
      680,
      'HEAVY',
      1320,
      480
    ],
    'fill-extrusion-base': 0,
    'fill-extrusion-opacity': HMS_VOLUME_OPACITY
  };
}

/** Static United States Forest Service Wildfire Hazard Potential key. */
export const USFS_WHP_PRESENTATION = {
  categories: [
    { label: 'Very Low', color: '#1a9850' },
    { label: 'Low', color: '#91cf60' },
    { label: 'Moderate', color: '#fee08b' },
    { label: 'High', color: '#fc8d59' },
    { label: 'Very High', color: '#d73027' }
  ],
  qualification:
    // vocab-allow: honesty disclaimer distinguishes static WHP from a forecast
    'United States Forest Service Wildfire Hazard Potential, static 2023 edition, 270 m resolution, conterminous United States (CONUS) only; potential context, not current fire conditions or a forecast.'
} as const;
