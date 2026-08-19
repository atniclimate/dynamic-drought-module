import type maplibregl from 'maplibre-gl';

import { HILLSHADE_SHADOW } from './palette';

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
 * Vertical exaggeration for the 3D terrain. Deliberately restrained: relief
 * should read as context under the fire perimeters, not as a dramatized
 * landscape that implies fire behavior.
 */
export const FIRE3D_TERRAIN_EXAGGERATION = 1.2;

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
