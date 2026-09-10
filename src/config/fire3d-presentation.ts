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
 * The bundled terrain archive's own extent (DDM-P9-T04), read from the
 * committed public/data/hillshade-dem-pnw.pmtiles PMTiles v3 header
 * (min/max zoom at header bytes 100-101, the WGS84 bounding box at bytes
 * 102-117, int32 degrees times 1e-7 per the spec) rather than typed by
 * hand, so a re-bake that shifts the box makes this constant wrong and the
 * archive-header test in tests/fire3d-mode.spec.ts catches it before the
 * sentence below can silently claim ground the new archive does not cover.
 * The archive is USGS 3D Elevation Program elevation data served through
 * the 3DEPElevation ImageServer (src/layers/hillshade.ts:4-6); it carries
 * no vertical-accuracy claim, and none is made here.
 */
export const FIRE3D_TERRAIN_COVERAGE = {
  issuer: 'USGS 3D Elevation Program',
  west: -125,
  south: 41.5,
  east: -110.5,
  north: 49.5,
  maxZoom: 8
} as const;

/**
 * Whether a lng/lat sits inside the bundled terrain archive's own extent.
 * Compared directly against FIRE3D_TERRAIN_COVERAGE's own numbers, never a
 * second hand-typed box, so a re-bake that moves the coverage changes this
 * test the same way it changes the sentence below. The box is a closed
 * interval (inclusive at every edge): the archive's own bounding box is
 * itself inclusive, so a view centered exactly on an edge coordinate is
 * inside, not outside.
 *
 * FIRE3D_TERRAIN_COVERAGE.maxZoom plays no part here: this answers ONLY the
 * geographic question (is there any baked elevation here at all), never the
 * separate and non-boundary question of how deep the bake goes once inside
 * the box (see FIRE3D_TERRAIN_COVERAGE_SENTENCE's own comment on why the two
 * must stay apart).
 */
export function isWithinTerrainCoverage(lng: number, lat: number): boolean {
  return (
    lng >= FIRE3D_TERRAIN_COVERAGE.west &&
    lng <= FIRE3D_TERRAIN_COVERAGE.east &&
    lat >= FIRE3D_TERRAIN_COVERAGE.south &&
    lat <= FIRE3D_TERRAIN_COVERAGE.north
  );
}

/** A geographic box, the shape MapLibre's `LngLatBounds` reports. */
export interface ViewBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * How much of a VIEW the bundled archive covers: all of it, some of it, or
 * none of it.
 *
 * `full` earns no sentence, `none` earns the wholly-outside sentence, and
 * `partial` earns its own, because those are three different facts about the
 * ground and only two of them were ever said.
 */
export type TerrainCoverageReading = 'full' | 'partial' | 'none';

/**
 * Classify a view's footprint against the archive's extent (Codex adversarial
 * review 2026-09-10, finding 8).
 *
 * The predicate this replaces asked `isWithinTerrainCoverage` about the view's
 * CENTER and then made a categorical claim about the whole view. A point
 * cannot carry that claim: at the eastern edge, a viewport straddling
 * longitude -110.5 said nothing at all while half its ground was unmodelled,
 * and two thousandths of a degree of pan later the same mixed scene announced
 * that "this view is outside" the extent and "the ground here carries no
 * archived elevation". Both readings were wrong about the same picture.
 *
 * The view box is a SUPERSET of the visible ground when the camera is pitched
 * (MapLibre reports the bounding box of a trapezoid), and that asymmetry is
 * deliberate here: a superset can turn a `full` into a `partial`, which
 * over-qualifies, and can never turn a `partial` into a `full`, which would
 * under-qualify. Coverage prose is allowed to be cautious; it is not allowed
 * to be confident and wrong.
 *
 * Edges are inclusive, matching `isWithinTerrainCoverage` and the archive's
 * own inclusive bounding box: a view touching an edge without crossing it is
 * still fully covered. Antimeridian-naive, like every other box in this
 * codebase.
 */
export function classifyTerrainCoverage(view: ViewBox): TerrainCoverageReading {
  const box = FIRE3D_TERRAIN_COVERAGE;
  const disjoint =
    view.west > box.east ||
    view.east < box.west ||
    view.south > box.north ||
    view.north < box.south;
  if (disjoint) return 'none';
  const contained =
    view.west >= box.west &&
    view.east <= box.east &&
    view.south >= box.south &&
    view.north <= box.north;
  return contained ? 'full' : 'partial';
}

/**
 * Exported (not just an internal helper) so the header-vs-sentence test in
 * tests/fire3d-mode.spec.ts asserts against the exact same formatting the
 * sentence uses, rather than a second hand-written copy that could drift
 * from it silently.
 */
export function formatLatitudeDeg(value: number): string {
  return `${Math.abs(value)}°${value >= 0 ? 'N' : 'S'}`;
}

/** See formatLatitudeDeg. */
export function formatLongitudeDeg(value: number): string {
  return `${Math.abs(value)}°${value >= 0 ? 'E' : 'W'}`;
}

/**
 * The terrain-only clause: the geographic extent is the coverage claim
 * (outside the box there is no archive at all, so the ground renders
 * flat); the zoom figure is stated separately as a DETAIL, never folded
 * into the same clause as "outside it...flat", because it is not a
 * coverage boundary. Above zoom 8 MapLibre overzooms the archive's
 * deepest level rather than going flat (src/layers/hillshade.ts:7-11),
 * and the 3D scene builds its own raster-dem from this same archive
 * (src/map/fire3d.ts), so relief persists, softened, at every zoom; a
 * sentence that read "through zoom 8; outside it...flat" would have let
 * "outside" be misread as "past zoom 8", which is false.
 *
 * Exported so src/ui/map-key.ts's flat-hillshade coverage entry can mirror
 * it verbatim (that module is in the eager graph and must not import this
 * chunk); tests/fire3d-mode.spec.ts pins the two against drift.
 */
export const FIRE3D_TERRAIN_COVERAGE_SENTENCE =
  `Terrain relief uses the ${FIRE3D_TERRAIN_COVERAGE.issuer}'s elevation data for ` +
  `${formatLongitudeDeg(FIRE3D_TERRAIN_COVERAGE.west)} to ${formatLongitudeDeg(FIRE3D_TERRAIN_COVERAGE.east)}, ` +
  `${formatLatitudeDeg(FIRE3D_TERRAIN_COVERAGE.south)} to ${formatLatitudeDeg(FIRE3D_TERRAIN_COVERAGE.north)}; ` +
  'outside that box the ground renders flat. ' +
  `The archive's detail ends at zoom ${FIRE3D_TERRAIN_COVERAGE.maxZoom}; closer views stretch its deepest tiles.`;

/**
 * Honest coverage statement rendered beside the toggle whenever the control
 * shows: names the issuer and the bundled DEM archive's own extent (derived
 * from FIRE3D_TERRAIN_COVERAGE, not typed by hand), so the mode never
 * implies national relief or a precision the archive does not carry.
 */
export const FIRE3D_COVERAGE_NOTE =
  `${FIRE3D_TERRAIN_COVERAGE_SENTENCE} Bundled structure data covers the ` +
  'central Oregon pilot area only, from zoom 13.';

/**
 * What the scene's live status line adds the moment the view sits WHOLLY
 * outside FIRE3D_TERRAIN_COVERAGE while the mode is active.
 *
 * "Wholly", since 2026-09-10: this used to be published from the view's
 * CENTER, so it also fired for a view whose ground was half covered, and
 * stayed silent for a view whose ground was half MISSING. A view that only
 * overlaps the extent gets FIRE3D_PARTIAL_COVERAGE_STATUS instead, and only a
 * view with no covered ground at all gets this one. See
 * `classifyTerrainCoverage`.
 *
 * FIRE3D_COVERAGE_NOTE states the box once, always, beside the toggle,
 * whether or not it is presently true of the view; a reader who has not
 * memorized four coordinates cannot tell from a standing paragraph whether
 * THIS view is inside it. MapLibre's own terrain sampler falls back to
 * elevation 0 for a location its raster-dem source does not cover, which
 * renders identically to terrain never having been wired at all: a person
 * cannot otherwise tell "verified no elevation data here" from "the scene is
 * broken" (the no-data/unavailable distinction docs/design/README.md
 * requires). This sentence answers that, at the moment it is true, beside
 * the live status line, and it stops rendering the moment a pan returns the
 * view to the box. It reuses FIRE3D_TERRAIN_COVERAGE.issuer rather than
 * naming the source a second way.
 */
export const FIRE3D_OUT_OF_COVERAGE_STATUS =
  `This view is outside the ${FIRE3D_TERRAIN_COVERAGE.issuer}'s bundled ` +
  'elevation extent, so the ground here carries no archived elevation and ' +
  'renders flat; that is a coverage gap, not a failed scene.';

/**
 * What the status line says when the view STRADDLES the extent's edge: some
 * of the visible ground is modelled and some of it is not.
 *
 * The third reading the center-point test could not express (Codex adversarial
 * review 2026-09-10, finding 8). It has to exist as its own sentence rather
 * than reusing either neighbour, because both neighbours are categorical
 * about the whole view and this case is the one where that is false. It makes
 * the same no-data-versus-broken distinction the wholly-outside sentence
 * makes, and for the same reason: MapLibre's sampler returns elevation 0 for
 * uncovered ground, which is indistinguishable from an unwired scene unless
 * the interface says which it is. It names no boundary coordinate, because
 * the standing FIRE3D_COVERAGE_NOTE already states the box and repeating it
 * mid-sentence would read as a second, competing claim.
 */
export const FIRE3D_PARTIAL_COVERAGE_STATUS =
  `Part of this view lies outside the ${FIRE3D_TERRAIN_COVERAGE.issuer}'s ` +
  'bundled elevation extent; that ground carries no archived elevation and ' +
  'renders flat, while the rest of the view is modelled. That is a coverage ' +
  'gap, not a failed scene.';

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

/**
 * What the shell offers where the 3D toggle would be (DDM-P9-T02).
 *
 * `control` is the toggle itself. `silent` is the case where the feature is
 * not the subject at all, so the panel says nothing about it. The remaining
 * two are REFUSALS, and each one is a sentence a person reads.
 *
 * These are CONTROL affordances, not layer states. The six honest layer
 * states (`loading`, `live`, `live (partial)`, `unavailable`, `no data`,
 * `zoom in to load`) gain no seventh member here and lend none of their
 * words to this vocabulary; the toggle's own status line keeps speaking
 * them for the scene once the scene exists.
 */
export type Fire3DRefusal = 'no-webgl2' | 'short-window';
export type Fire3DOffer = 'control' | 'silent' | Fire3DRefusal;

/**
 * What the interface SAYS when it refuses. One sentence each, in the words
 * of a person who is not a specialist, and each says only what was
 * observed: the probe found no WebGL 2 context, or the window is shorter
 * than the floor above. Neither names a cause it has not established
 * ("your graphics card is too old" would be a guess), neither promises a
 * fix, and neither asks the user to do anything.
 */
export const FIRE3D_REFUSAL_TEXT: Readonly<Record<Fire3DRefusal, string>> = {
  'no-webgl2':
    'This browser cannot render the 3D scene, so there is nothing here to turn on.',
  'short-window':
    'This window is too short for the 3D Fire view, so there is nothing here to turn on.'
};

/** What the shell island reads about the device and the committed view. */
export interface Fire3DOfferInput {
  /** The viewport meets FIRE3D_MIN_WIDTH_QUERY. */
  readonly wideEnough: boolean;
  /** The viewport meets FIRE3D_MIN_HEIGHT_QUERY. */
  readonly tallEnough: boolean;
  /** The once-per-page renderer probe's answer (`webGl2Capability()`). */
  readonly webgl2: boolean;
  /** The committed cluster is Wildfire, which is the only view that offers
   * the scene today. */
  readonly fireView: boolean;
}

/**
 * Decide what stands where the 3D toggle would be. Pure, so the decision is
 * Node-testable beside `shouldFire3DBeActive`, which asks the same three
 * questions of the map (DR-025a).
 *
 * Silence versus a sentence is the whole point of this function. Before
 * 2026-09-03 the control simply rendered nothing whenever the gate refused,
 * so a person on a device that cannot hold the scene met an interface
 * indistinguishable from one where the feature had never been built. Now a
 * refusal that a person could otherwise mistake for a missing button says
 * so, once, quietly, where the button would have been.
 *
 * The two silences are deliberate and are NOT refusals to explain:
 *  - another hazard view has no 3D toggle to miss, so naming one would be
 *    an advertisement rather than an answer;
 *  - a viewport below the desktop breakpoint is the phone chrome, where 3D
 *    is deferred by owner ruling rather than refused by this device, and a
 *    standing notice on every phone would be a nag about a decision that
 *    has nothing to do with the hardware in the reader's hand.
 *
 * Capability is tested before geometry so the deeper refusal wins: a device
 * that cannot render the scene at all would not begin to hold it in a
 * taller window.
 */
export function fire3dControlOffer(input: Fire3DOfferInput): Fire3DOffer {
  if (!input.fireView || !input.wideEnough) return 'silent';
  if (!input.webgl2) return 'no-webgl2';
  if (!input.tallEnough) return 'short-window';
  return 'control';
}

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
