import type * as maplibregl from 'maplibre-gl';

import { HILLSHADE_SHADOW } from './palette';
import {
  NIFC_MAX_ALLOWABLE_OFFSET_DEG,
  WILDFIRE_STATIC_COLOR
} from './wildfire-presentation';

/**
 * Presentation constants for the desktop 3D Fire mode (W3/W4).
 *
 * One combined mode governs terrain relief, the pitched camera, the sky
 * treatment, and the volumetric smoke read together; these are its tuning
 * knobs, kept in config so a design pass edits numbers, not orchestration.
 *
 * Meaning discipline (the wildfire meaning constraints): everything here is
 * PRESENTATION. Terrain relief and the pitched camera change how the same
 * mapped incident representations are seen, never what they claim; the sky
 * is scene dressing tuned to the app's dark palette, not a weather or smoke
 * statement.
 */

/**
 * Vertical exaggeration for the 3D terrain.
 *
 * Doubled from 1.2 to 2.4 on owner direction 2026-08-19: at the regional
 * camera distance the Cascades read as a gentle swell rather than as the
 * terrain a fire is moving through, and relief is the whole reason the
 * pitched scene exists.
 *
 * Exaggeration is a VIEWING transform on published elevation, not a claim:
 * it changes nothing about what any layer says. Two couplings to keep in
 * mind when tuning it, because neither scales with this number:
 *  - the smoke volume's extrusion heights are literal meters and stay
 *    literal, so raising this makes stylized plumes read shorter against
 *    the relief (see HMS_VOLUME_HEIGHT_SCALE_METERS);
 *  - building extrusions are the issuer's published heights in meters and
 *    must stay so; they are not to be scaled to "match" the terrain.
 */
export const FIRE3D_TERRAIN_EXAGGERATION = 2.4;

/** Camera pitch while the mode is active, in degrees. */
export const FIRE3D_PITCH_DEGREES = 60;

/** Ease duration for entering and leaving the pitched camera. Reduced
 * motion (WCAG 2.3.3) replaces the ease with an instant jump. */
export const FIRE3D_CAMERA_TRANSITION_MS = 800;

/**
 * Sky and fog for the pitched scene, tuned to the app's dark palette: the
 * base style's background '#0b1220' (src/map/style.ts) and the hillshade
 * shadow tone carry into the horizon so the 3D scene stays in the same
 * visual family as the flat map instead of introducing a daylight sky.
 */
export const FIRE3D_SKY_SPECIFICATION: maplibregl.SkySpecification = {
  'sky-color': '#0b1220',
  'horizon-color': HILLSHADE_SHADOW,
  'fog-color': '#0b1220',
  'fog-ground-blend': 0.8,
  'horizon-fog-blend': 0.6,
  'sky-horizon-blend': 0.7,
  'atmosphere-blend': 0.3
};

/**
 * The library's own "no sky" values (MapLibre's Sky falls back to exactly
 * this spec when constructed without one). Applied on exit so leaving the
 * mode restores the flat map's clear scene instead of a default daylight
 * sky; `Map.setSky` requires a full specification, so the reset is spelled
 * out rather than passed as undefined.
 */
export const FIRE3D_SKY_CLEAR_SPECIFICATION: maplibregl.SkySpecification = {
  'sky-color': 'transparent',
  'horizon-color': 'transparent',
  'fog-color': 'transparent',
  'fog-ground-blend': 1,
  'atmosphere-blend': 0
};

/**
 * Honest coverage statement rendered beside the toggle whenever the control
 * shows: the bundled DEM archive covers the Pacific Northwest only, and the
 * mode must not imply national relief.
 */
export const FIRE3D_COVERAGE_NOTE =
  'Terrain relief covers the Pacific Northwest data bake; outside it the ground renders flat. Bundled structure data covers the central Oregon pilot area only, from zoom 13.';

/**
 * Always-visible non-prediction disclosure for the 3D view and its context
 * layers. Peer-reviewed interview work on wildfire visualizations (Edgeley
 * et al. 2024, Fire Ecology 20:45, DOI 10.1186/s42408-024-00278-8) found
 * viewers over-trust fire visuals even when told otherwise in docs, so the
 * statement lives in the interface itself, beside the toggle, never in a
 * dismissible tooltip or documentation only.
 */
export const FIRE3D_NON_PREDICTION_NOTE =
  'The 3D view shows each source\'s published data as context. It computes no fire behavior: nothing here shows or implies spread, ignition, or an all-clear.';

/** The desktop gate; mirrors the shell's DESKTOP_SHELL_QUERY breakpoint. */
export const FIRE3D_MIN_WIDTH_QUERY = '(min-width: 721px)';

/**
 * Viewport-height floor for the tilted camera, in CSS pixels.
 *
 * DR-025a admits tablets (the 721 to 1024 px band of DR-036) and excludes
 * landscape phones, which a width query alone cannot separate: a landscape
 * phone is 721 px wide or wider and a tablet in portrait is not much taller.
 * Height is what actually distinguishes them, and height is also what the
 * scene needs, because a 60-degree camera spends most of its frame on the
 * horizon and leaves a compressed strip of ground.
 *
 * 520 is a DDM CONVENTION, not a device constant. It sits above the tallest
 * current landscape phone viewport (about 430 to 440 CSS px on the largest
 * phones) and well below the shortest tablet landscape viewport (768 CSS px),
 * so it separates the two classes with margin on both sides rather than
 * tracking any one model. Raise it only with a measurement.
 */
export const FIRE3D_MIN_HEIGHT_PX = 520;

/** The height floor as a media query, beside the width query above. */
export const FIRE3D_MIN_HEIGHT_QUERY = `(min-height: ${FIRE3D_MIN_HEIGHT_PX}px)`;

// ---------------------------------------------------------------------------
// The mapped wildfire perimeter ribbon (DR-064, owner rendering specification)
// ---------------------------------------------------------------------------

/**
 * DR-064 (owner rendering specification, 2026-09-02): in the 3D scene the
 * mapped wildfire perimeter stands up as a low vertical ribbon instead of
 * reading as a flat map line in a tilted frame. Opaque at the bottom where
 * it meets the terrain, fading out above it on a logarithmic curve so the
 * opacity drops fastest at the top, low enough to stand off the relief
 * without dominating it, held at a constant on-screen height across zooms,
 * and pulsing along the edge in step with the flat outline.
 *
 * These constants live here rather than in `wildfire-presentation.ts`
 * because the ribbon exists ONLY inside the 3D scene: it is a property of
 * this mode, not of the NIFC perimeter layer, which keeps its own fill,
 * outline, filter, legend, popup, and six-state status untouched.
 *
 * MEANING DISCIPLINE. Every number below is a DDM PRESENTATION CONVENTION.
 * The ribbon's vertical extent is not flame height, fire intensity, plume
 * top, or any measured quantity, and its width is not a buffer around the
 * fire; both are drawing devices that make the same published edge legible
 * in a pitched view. It follows exactly the geometry the flat layer already
 * holds and adds no request of its own.
 */

/** Spherical mean meters per degree of latitude (a DDM convention figure). */
export const METERS_PER_DEGREE_LATITUDE = 111_320;

/**
 * The latitude the ribbon's screen geometry is tuned at, in degrees north.
 *
 * MapLibre reads extrusion heights in meters and projects them through the
 * Web Mercator scale, so one meter buys more pixels the further north it is
 * drawn. 45 degrees is the middle of the Pacific Northwest bake this mode
 * covers (FIRE3D_COVERAGE_NOTE), so the ribbon is right where the terrain
 * is and drifts only slightly across the rest of the map.
 */
export const PERIMETER_RIBBON_REFERENCE_LATITUDE_DEG = 45;

/**
 * Web Mercator ground resolution at zoom 0 and the equator, in meters per
 * CSS pixel.
 *
 * The equatorial circumference divided by 512, NOT by 256: MapLibre's zoom
 * levels are defined on 512 pixel tiles, so the world is 512 times two to
 * the zoom pixels wide and the familiar 156,543 figure (a 256 pixel tile
 * scheme) would make every ribbon twice as tall as asked for. Measured that
 * way on a 2026-09-03 capture over central Oregon before the constant was
 * corrected.
 */
const MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 78_271.516_964_020_5;

/**
 * Half the ribbon band's ground width, in meters, DERIVED rather than
 * chosen twice.
 *
 * MapLibre extrudes polygons, never lines, so the ribbon is a thin closed
 * band whose CENTERLINE is the published perimeter edge: the band is offset
 * the same distance inward and outward, so the ribbon neither enlarges nor
 * shrinks the mapped perimeter. Its half width is the perimeter query's own
 * display generalization (NIFC_MAX_ALLOWABLE_OFFSET_DEG, 0.0005 degree)
 * expressed in meters of longitude at the reference latitude, so the band is
 * never wider than the tolerance the drawn edge already carries. About 39 m.
 */
export const PERIMETER_RIBBON_HALF_WIDTH_METERS = Math.round(
  NIFC_MAX_ALLOWABLE_OFFSET_DEG *
    METERS_PER_DEGREE_LATITUDE *
    Math.cos((PERIMETER_RIBBON_REFERENCE_LATITUDE_DEG * Math.PI) / 180)
);

/**
 * How tall the whole ribbon stands on screen, in CSS pixels.
 *
 * "Not too tall. Just enough vertical extent to offer clear distinction
 * from the terrain surface" (the owner specification). 16 px is a DDM
 * PRESENTATION CONVENTION, chosen by looking: it is about the height of a
 * line of interface text, tall enough to separate from the ground at a 60
 * degree pitch and short enough that a ribbon never becomes a wall across
 * the relief behind it. The height in METERS is derived from it per zoom,
 * so the ribbon reads the same at a regional framing and over a single
 * incident.
 *
 * This is the NOMINAL height, at the map center. A pitched camera is a
 * perspective projection, so a ribbon in the near foreground draws larger
 * and one at the horizon smaller; that is the pitch doing its job, not a
 * scale error.
 */
export const PERIMETER_RIBBON_SCREEN_HEIGHT_PX = 16;

/**
 * The zoom range over which the meter height is scaled. Outside it MapLibre
 * clamps to the end stop, so a continental view keeps a ribbon that shrinks
 * with the world instead of a wall tens of kilometers tall.
 */
export const PERIMETER_RIBBON_ZOOM_STOPS = [5, 15] as const;

/** The ribbon's full height in meters at `zoom`, at the reference latitude. */
export function perimeterRibbonHeightMeters(zoom: number): number {
  const groundResolution =
    (MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 *
      Math.cos((PERIMETER_RIBBON_REFERENCE_LATITUDE_DEG * Math.PI) / 180)) /
    2 ** zoom;
  return PERIMETER_RIBBON_SCREEN_HEIGHT_PX * groundResolution;
}

/**
 * How many stacked extrusion slabs the ribbon is built from.
 *
 * `fill-extrusion-opacity` is a data-CONSTANT property in the MapLibre style
 * specification and there is no vertical opacity gradient, so a continuous
 * fade is not expressible in one layer. The ribbon is therefore quantized
 * into slabs that share one source and one filter (MapLibre groups them into
 * a single bucket, so this costs draw calls, not geometry): each slab spans
 * an equal band of the height and carries the fade curve's value at its own
 * midpoint. Six is the smallest count at which the ladder reads as a fade
 * rather than as stripes at a 60 degree pitch.
 */
export const PERIMETER_RIBBON_SLAB_COUNT = 6;

/**
 * The logarithmic fade's shape constant.
 *
 * Opacity at height fraction `t` is `ln(1 + k(1 - t)) / ln(1 + k)`: one at
 * the ground, zero at the top, and steepening as it rises, which is the
 * "opacity drops quickly near the top rather than linearly" the owner asked
 * for. `k` sets how pronounced that steepening is; k of 1.5 gives per-slab
 * drops of about 0.12, 0.14, 0.16, 0.18 and 0.22 with the six slabs above,
 * so the ribbon is nearly solid where it touches the ground and nearly gone
 * at its top edge. A larger k flattens the bottom and hides the fade in the
 * last sliver; a smaller one approaches a straight ramp.
 */
export const PERIMETER_RIBBON_FADE_CONSTANT = 1.5;

/**
 * The fade curve sampled at slab `index`'s midpoint, rounded to three
 * decimals so the ladder is readable in a paint object and in a test.
 */
export function perimeterRibbonSlabOpacity(index: number): number {
  const midpoint = (index + 0.5) / PERIMETER_RIBBON_SLAB_COUNT;
  const raw =
    Math.log1p(PERIMETER_RIBBON_FADE_CONSTANT * (1 - midpoint)) /
    Math.log1p(PERIMETER_RIBBON_FADE_CONSTANT);
  return Math.round(raw * 1000) / 1000;
}

/**
 * A zoom curve holding `fraction` of the ribbon's height at a constant
 * on-screen size.
 *
 * An exponential interpolation with base 0.5 between two stops whose values
 * are themselves in the ratio 0.5 per zoom level reproduces that geometric
 * series EXACTLY at every intermediate zoom, not approximately: MapLibre's
 * factor is `(b^(z - z0) - 1) / (b^(z1 - z0) - 1)`, which with `b = 0.5` and
 * `v1 = v0 * 0.5^(z1 - z0)` evaluates to `v0 * 0.5^(z - z0)`. Ground
 * resolution halves per zoom level, so the two cancel and the ribbon holds
 * its pixel height.
 */
function perimeterRibbonHeightCurve(
  fraction: number
): maplibregl.ExpressionSpecification {
  const [low, high] = PERIMETER_RIBBON_ZOOM_STOPS;
  return [
    'interpolate',
    ['exponential', 0.5],
    ['zoom'],
    low,
    fraction * perimeterRibbonHeightMeters(low),
    high,
    fraction * perimeterRibbonHeightMeters(high)
  ];
}

/**
 * Exact paint for one ribbon slab, bottom slab first.
 *
 * The color is the perimeter layer's own static wildfire color, so the
 * ribbon starts where the reduced-motion contract leaves the flat outline;
 * when motion is allowed the perimeter layer's single pulse controller
 * animates this property on every slab at once, in phase with the flat
 * outline (WILDFIRE_PULSE_PAINT_TARGETS in src/layers/nifc-fires.ts).
 */
export function buildPerimeterRibbonSlabPaint(
  index: number
): NonNullable<maplibregl.FillExtrusionLayerSpecification['paint']> {
  return {
    'fill-extrusion-color': WILDFIRE_STATIC_COLOR,
    'fill-extrusion-base':
      index === 0
        ? 0
        : perimeterRibbonHeightCurve(index / PERIMETER_RIBBON_SLAB_COUNT),
    'fill-extrusion-height': perimeterRibbonHeightCurve(
      (index + 1) / PERIMETER_RIBBON_SLAB_COUNT
    ),
    'fill-extrusion-opacity': perimeterRibbonSlabOpacity(index),
    // MapLibre's own vertical gradient shades the FOOT of an extrusion
    // darker, which is exactly where this ribbon has to stay brightest.
    // The only fade here is the opacity ladder above.
    'fill-extrusion-vertical-gradient': false
  };
}

/** Honest legend line for the 3D perimeter ribbon. */
export const PERIMETER_RIBBON_QUALIFICATION =
  'The 3D view raises the mapped wildfire perimeter edge into a low ribbon, opaque where it meets the ground and fading out above it. Its vertical extent is a DDM presentation convention held at a constant on-screen height across zooms, not flame height, fire intensity, or any measured quantity, and it follows the same generalized NIFC perimeter the flat map draws.';
