/**
 * The phone shell's way into the 3D Fire view: its geometry floors and the
 * decision of what stands where its 3D cell would be (owner direction
 * 2026-11-09 (sprint), DR-pending).
 *
 * THE LIFT. docs/design/mobile-map-chrome.md used to say "Phone views do not
 * load or present the 3D Fire controls". Phones may now enter the scene
 * through one explicit cell in the right-edge column, with touch camera
 * control. Everything else about the scene is kept: the WebGL 2 capability
 * gate, the lazy chunk, the two always-visible statements (terrain coverage
 * and non-prediction), and the naming rule of docs/design/fire3d-context.md.
 *
 * WHY THIS FILE. The cell is created by code that is already on the phone
 * path (src/ui/fire3d-phone.ts, in the entry chunk), so the facts it needs
 * live here, import-free, where the entry pays only for these lines and
 * `node --test` can load them with Node's type stripping. The scene's own
 * presentation constants stay in src/config/fire3d-presentation.ts, which
 * rides the lazy chunk.
 */

/**
 * The narrowest viewport, in CSS pixels, at which a phone is offered the
 * scene.
 *
 * It is the number inside the two width constants that must stay equal
 * (FIRE3D_CHUNK_WIDTH_QUERY in src/state/fire3d-store.ts and
 * FIRE3D_MIN_WIDTH_QUERY in src/config/fire3d-presentation.ts);
 * tests/fire3d-phone.test.mjs holds the three together.
 *
 * 360 is a DDM CONVENTION with a measured reason. The two statements have to
 * stay on the surface, word for word, for as long as the scene is on. Their
 * card sits between the left edge and the right-edge column, so its width is
 * the viewport less 72 px (the 8 px edge, a 48 px column and two 8 px gaps).
 * At 320 px that leaves a 248 px card whose text wraps to about 300 px of
 * height, more than half of the tallest 320 px phone in common use (568 px),
 * with the key above it and the camera pad below. 360 px is the next width
 * phones are actually made at, and there the card is the same height it is
 * at 375 and 390. Lower it only with a measurement.
 */
export const FIRE3D_PHONE_MIN_WIDTH_PX = 360;

/**
 * The shortest viewport, in CSS pixels, at which a phone is offered the
 * scene.
 *
 * The desktop floor (FIRE3D_MIN_HEIGHT_PX, 520) exists because a 60-degree
 * camera spends its frame on the far ground and leaves a compressed strip of
 * the near ground on a short viewport. A phone has less to give: the key
 * chip (52 px with its margin), the card that keeps both statements on the
 * surface (measured at 360 px wide: up to 268 px with its gap when the view
 * also earns the coverage-gap sentence), and the 132 px camera pad with its
 * margins (148 px) all stand on the same column of pixels. 52 + 268 + 148 is
 * 468 px of chrome; the floor asks for the height of one more camera pad
 * (132 px) of clear ground between the card and the pad, which is 600.
 *
 * So 600 is a DDM CONVENTION derived from this layout, not a device
 * constant. It admits 360 by 740, 375 by 667, 390 by 844 and 412 by 915, and
 * it leaves out 375 by 553 (a 4.7 inch phone with the browser's bars showing)
 * and every phone on its side. A phone below it gets no cell, and a shared
 * `fire3d=true` link gets one sentence instead of a scene. Raise or lower it
 * only with a measurement of the card.
 */
export const FIRE3D_PHONE_MIN_HEIGHT_PX = 600;

/** The phone height floor as a media query. */
export const FIRE3D_PHONE_MIN_HEIGHT_QUERY = `(min-height: ${FIRE3D_PHONE_MIN_HEIGHT_PX}px)`;

/**
 * What the phone shell offers where its 3D cell would be.
 *
 * `cell` is the control. `silent` is the case where 3D is not the subject
 * (another hazard view, or no phone shell at all: the desktop console and
 * the embed answer for themselves). The other three are REFUSALS, the same
 * idea as `Fire3DRefusal` in src/config/fire3d-presentation.ts: the device
 * cannot hold the scene, so the column shows no cell (absent, never a dead
 * control), and a person who arrived by a shared `fire3d=true` link reads
 * one sentence that says what was observed.
 */
export type Fire3DPhoneRefusal = 'no-webgl2' | 'narrow-window' | 'short-window';
export type Fire3DPhoneOffer = 'cell' | 'silent' | Fire3DPhoneRefusal;

export interface Fire3DPhoneOfferInput {
  /** The phone shell is presenting the map: 720 px and narrower, never an embed. */
  readonly phoneShell: boolean;
  /** Fire is the person's hazard view: the committed mode, or the custom set made from it. */
  readonly fireView: boolean;
  /** The once-per-page renderer probe's answer (`webGl2Capability()`). */
  readonly webgl2: boolean;
  /** The viewport is at least FIRE3D_PHONE_MIN_WIDTH_PX wide. */
  readonly wideEnough: boolean;
  /** The viewport is at least FIRE3D_PHONE_MIN_HEIGHT_PX tall. */
  readonly tallEnough: boolean;
}

/**
 * Decide what stands where the phone's 3D cell would be. Pure, so Node can
 * prove it beside `fire3dControlOffer`, which answers the same question for
 * the desktop console.
 *
 * Capability is asked before geometry so the deeper refusal wins, and width
 * before height because a narrow phone stays narrow while a short window can
 * grow (a keyboard closing, a browser bar hiding).
 */
export function fire3dPhoneOffer(input: Fire3DPhoneOfferInput): Fire3DPhoneOffer {
  if (!input.phoneShell || !input.fireView) return 'silent';
  if (!input.webgl2) return 'no-webgl2';
  if (!input.wideEnough) return 'narrow-window';
  if (!input.tallEnough) return 'short-window';
  return 'cell';
}

/**
 * The attribute the phone's 3D chrome stamps on `#app` while its card is in
 * the document. The scene's activation gate (src/map/fire3d.ts) admits a
 * phone only while it is present, so a phone can never show the scene
 * without the two statements standing on the surface beside it.
 */
export const FIRE3D_PHONE_CHROME_ATTRIBUTE = 'data-fire3d-phone';
