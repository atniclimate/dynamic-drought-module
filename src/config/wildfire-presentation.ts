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

/**
 * LANDFIRE 2024 (LF2024) Scott and Burgan 40 Fire Behavior Fuel Models
 * (FBFM40) drape for the desktop 3D Fire mode (the fuels context layer).
 *
 * The colors are the ISSUER'S published class colors, decoded verbatim from
 * the LF2024_FBFM40_CONUS ImageServer legend endpoint on 2026-08-19 UTC
 * (the bake's own retrieval clock; scripts/build-fuels-tiles.mjs re-fetches
 * the legend on every rebake and HARD-FAILS when this table and the served
 * legend disagree, so the archive's pixels and this key cannot drift
 * apart). The drape layer draws these colors translucent
 * (FUELS_DRAPE_OPACITY) so terrain and incident layers stay legible; the
 * qualification below discloses that. Class names are the standard Scott
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

/** Drape opacity: fuel classes stay context under perimeters and smoke. */
export const FUELS_DRAPE_OPACITY = 0.5;

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
  return {
    'line-color': POWER_LINE_COLOR,
    'line-opacity': POWER_LINE_OPACITY,
    'line-width': [
      'match',
      ['get', 'VOLT_CLASS'],
      ...POWER_LINE_WIDTHS.flatMap(([voltClass, width]) => [voltClass, width]),
      0.6
    ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<number>
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
 * The power legend note is COMPOSED from these parts so it only ever
 * describes surfaces actually in the scene (either source may degrade
 * alone): the lines part when the archive is on, the plants part when the
 * live fetch succeeded, and the shared closing always.
 */
export const POWER_LINES_QUALIFICATION =
  'Transmission lines: HIFLD (U.S. Government) ARCHIVED snapshot, last data update 2024-09-30, no longer maintained; includes records the issuer marks inactive or status-unknown, drawn identically; line width follows the issuer\'s voltage class, and an unknown class draws dashed at the thinnest width.';

export const POWER_PLANTS_QUALIFICATION =
  'Power plants: EIA inventory locations (Forms 860/860M); symbols mark location only, not capacity or fuel.';

export const POWER_SHARED_QUALIFICATION =
  'Not comprehensive or current; never for siting or safety-critical decisions. Substations and distribution lines have no authoritative public national source and are absent by design.';
