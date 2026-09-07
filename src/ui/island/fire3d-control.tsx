/**
 * The desktop 3D Fire view toggle (W3/W4), rendered in the shell island
 * directly under the hazard cluster buttons.
 *
 * Visibility: only while the committed cluster is 'wildfire' AND the
 * device can enter the scene at all, which since DR-025a is the same three
 * questions the map-side gate in `src/map/fire3d.ts` asks: the viewport is
 * at least the desktop breakpoint wide, at least `FIRE3D_MIN_HEIGHT_PX`
 * tall (a landscape phone is wide enough and stays out), and the renderer
 * probe found a WebGL 2 context. Before 2026-09-03 the control read the
 * width alone, so a landscape phone was offered a button whose scene the
 * gate would refuse; a control the map cannot honor is not offered. Embed
 * mode hides the whole shell panel (app.css: .app-shell.embed
 * #shell-panel), so the control is inert in embeds for free while a
 * URL-named fire3d=true still drives the map-side effect through the
 * orchestrator.
 *
 * Refusals are SAID, not performed by omission (DDM-P9-T02). Withdrawing
 * the control was only half of DR-025a: it stopped offering a button the
 * map would refuse, and left the person who cannot have the scene looking
 * at an interface indistinguishable from one where the feature was never
 * built. A device that cannot hold the scene now reads one sentence where
 * the button would have been, naming what was observed and nothing else
 * (`fire3dControlOffer` and `FIRE3D_REFUSAL_TEXT` carry both decisions and
 * both sentences). It is a control affordance, not a seventh layer state;
 * the status line below the button keeps the six-state vocabulary to
 * itself.
 *
 * The button mirrors the PREFERENCE (the user's durable ask, aria-pressed
 * flips with the click); the status line underneath tells the honest truth
 * about the scene in the project's six-state vocabulary (AGENTS.md
 * invariant 6): loading, live with the smoke volume, live (partial) for
 * relief without it, unavailable with the reason. Since 2026-08-19 a
 * fourth line appears when the smoke volume is on and the issuer returned
 * no plumes, so an empty sky reads as an answer instead of a broken
 * feature. The coverage note renders whenever the control does: the
 * terrain bake is Pacific Northwest only and the control must never imply
 * national relief.
 *
 * Chunk discipline: only TYPES are imported from the fire3d orchestrator
 * (erased at build), so this island never pulls the 3D chunk statically;
 * the live status subscription arrives through the same dynamic import
 * main.ts uses, and only while the control is actually visible.
 */

import { useEffect, useState } from 'preact/hooks';

import {
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_MIN_HEIGHT_QUERY,
  FIRE3D_MIN_WIDTH_QUERY,
  FIRE3D_NON_PREDICTION_NOTE,
  FIRE3D_REFUSAL_TEXT,
  fire3dControlOffer
} from '../../config/fire3d-presentation';
import type { HazardClusterKey } from '../../config/clusters';
import type { Fire3DStatus } from '../../map/fire3d';
// The shared, once-per-page probe result (already in the entry chunk through
// main.ts, so reading it here adds no eager weight and no second context).
import { webGl2Capability } from '../../map/gl-capability';
import {
  getFire3DPreference,
  onFire3DPreferenceChange,
  setFire3DPreference
} from '../../state/fire3d-store';
import { registry } from '../../state/registry';

/** The catalog key whose emptiness the 3D control reports. */
const HMS_SMOKE_LAYER_KEY = 'hms-smoke';

/**
 * The status line speaks the six honest layer states (AGENTS.md invariant
 * 6, the same vocabulary `STATUS_PILL_TEXT` renders on every catalog
 * pill): loading, live, live (partial), unavailable, no data, zoom in to
 * load. Before 2026-09-02 it invented a parallel one ("Checking terrain
 * availability...", "Active: ..."), so a person reading the sidebar met
 * two vocabularies for one idea (FIRE-14).
 *
 * The mapping is the meaning, not a rename: `checking` is a load in
 * flight, and the smoke-volume degrade is the canonical PARTIAL case (the
 * scene is live; one of its two elements is not), which is exactly what
 * `live (partial)` says everywhere else. Sentence capitalization is kept
 * because this is a sentence in a paragraph, not a lowercase pill chip.
 *
 * The machine-readable `data-fire3d-status` attribute keeps the
 * `Fire3DStatus` union's own values (specs pin them); only the human
 * strings move. `inactive` renders no line at all: the scene is off and
 * claims nothing.
 */
function statusLine(status: Fire3DStatus | null): string {
  if (status === null) return '';
  switch (status.state) {
    case 'checking':
      return 'Loading terrain availability...';
    case 'active':
      return status.smokeVolume
        ? 'Live: terrain relief with the smoke volume.'
        : 'Live (partial): terrain relief; smoke stays in the flat veil.';
    case 'unavailable':
      return `Unavailable. ${status.reason ?? ''}`.trim();
    default:
      return '';
  }
}

/**
 * The empty-smoke line (owner report, 2026-08-19: volumetric smoke
 * "doesn't seem to work").
 *
 * One of the two things that report could mean is that HMS genuinely had
 * no plumes in view at that hour, which is an ordinary and correct answer
 * from a daytime satellite analysis product. The catalog pill said so, in
 * the sidebar, in small type, several sections away from the 3D control a
 * person was looking at. So the scene said "Active: terrain relief with
 * the smoke volume" (that day's wording; the line reads "Live: terrain
 * relief with the smoke volume" since FIRE-14) while there was no smoke
 * to have volume, and the absence read as a broken feature instead of an
 * answer.
 *
 * This line puts the answer where the question is. It is derived from the
 * layer's own registry status rather than from a second source of truth,
 * so it can never disagree with the pill.
 */
function emptySmokeLine(status: Fire3DStatus | null, smokeStatus: string | undefined): string {
  if (status?.state !== 'active' || !status.smokeVolume) return '';
  return smokeStatus === 'no-data'
    ? 'No current smoke plumes in view; the issuer returned none for this area.'
    : '';
}

export function Fire3DControl({
  cluster
}: {
  readonly cluster: HazardClusterKey | 'custom';
}) {
  // The geometry half of the entry gate (DR-025a): wide enough AND tall
  // enough, watched as two media queries so a phone rotating into landscape
  // withdraws the control and rotating back restores it. The capability
  // half is read once; it cannot change for a page.
  //
  // The two are held apart rather than as one boolean because they now have
  // different ANSWERS: a viewport below the desktop breakpoint is the phone
  // chrome and says nothing about 3D, while a wide but short viewport is a
  // landscape phone that has to be told why the button it saw yesterday is
  // gone (DDM-P9-T02).
  const [wideEnough, setWideEnough] = useState<boolean>(
    () => window.matchMedia(FIRE3D_MIN_WIDTH_QUERY).matches
  );
  const [tallEnough, setTallEnough] = useState<boolean>(
    () => window.matchMedia(FIRE3D_MIN_HEIGHT_QUERY).matches
  );
  const [preference, setPreference] = useState<boolean>(getFire3DPreference);
  const [status, setStatus] = useState<Fire3DStatus | null>(null);
  const [smokeStatus, setSmokeStatus] = useState<string | undefined>(() =>
    registry.getStatus(HMS_SMOKE_LAYER_KEY)
  );

  useEffect(() => {
    const width = window.matchMedia(FIRE3D_MIN_WIDTH_QUERY);
    const height = window.matchMedia(FIRE3D_MIN_HEIGHT_QUERY);
    const onChange = (): void => {
      setWideEnough(width.matches);
      setTallEnough(height.matches);
    };
    width.addEventListener('change', onChange);
    height.addEventListener('change', onChange);
    return () => {
      width.removeEventListener('change', onChange);
      height.removeEventListener('change', onChange);
    };
  }, []);

  useEffect(
    () =>
      onFire3DPreferenceChange(() => {
        setPreference(getFire3DPreference());
      }),
    []
  );

  // The smoke layer's own status is the single source for the empty-smoke
  // line, so the 3D control and the catalog pill can never disagree about
  // whether the issuer returned anything.
  useEffect(
    () =>
      registry.on('status-change', (key) => {
        if (key !== HMS_SMOKE_LAYER_KEY) return;
        setSmokeStatus(registry.getStatus(HMS_SMOKE_LAYER_KEY));
      }),
    []
  );

  const offer = fire3dControlOffer({
    wideEnough,
    tallEnough,
    webgl2: webGl2Capability().webgl2,
    fireView: cluster === 'wildfire'
  });
  const visible = offer === 'control';

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    void import('../../map/fire3d').then((mod) => {
      if (disposed) return;
      setStatus(mod.getFire3DStatus());
      unsubscribe = mod.onFire3DStatusChange(() => {
        setStatus(mod.getFire3DStatus());
      });
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [visible]);

  // A refusal reads as one sentence in the slot the button would have
  // occupied, directly after the hazard-view button group, so a person
  // reading the panel in order (screen reader included) meets the reason
  // exactly where the missing control would have been. It is a statement,
  // not a control: there is nothing here to press, and a dead-looking
  // button would say less than a sentence that names the refusal.
  //
  // It borrows `.shell-fire3d-empty`, the treatment this panel already uses
  // for a sentence that ANSWERS rather than qualifies (one step brighter
  // than the standing notes), so the refusal reads as the answer to "where
  // is the 3D view" rather than as fine print. `.shell-fire3d-note` stays
  // countable: this paragraph is not one of the standing notes.
  if (offer !== 'control') {
    if (offer === 'silent') return null;
    return (
      <p
        class="shell-fire3d-empty"
        id="shell-fire3d-refused"
        data-fire3d-refused={offer}
      >
        {FIRE3D_REFUSAL_TEXT[offer]}
      </p>
    );
  }

  return (
    <div class="shell-fire3d" id="shell-fire3d">
      <button
        type="button"
        class="shell-fire3d-btn"
        aria-pressed={preference}
        title="Tilt the Fire view over 3D terrain relief with a volumetric smoke read. Presentation only: it changes how the same mapped data is seen, not what any layer claims."
        onClick={() => setFire3DPreference(!preference)}
      >
        3D Fire view
      </button>
      {/* Persistently rendered live region (the shell summary pattern):
          only its text swaps, so screen readers announce it reliably. */}
      <p
        class="shell-fire3d-status"
        data-fire3d-status={status?.state ?? 'inactive'}
        aria-live="polite"
      >
        {statusLine(status)}
      </p>
      {emptySmokeLine(status, smokeStatus) ? (
        <p class="shell-fire3d-empty" data-fire3d-empty-smoke>
          {emptySmokeLine(status, smokeStatus)}
        </p>
      ) : null}
      <p class="shell-fire3d-note">{FIRE3D_COVERAGE_NOTE}</p>
      {/* The non-prediction disclosure renders whenever the control does
          (never a dismissible tooltip): viewers over-trust fire visuals,
          so the boundary statement lives in the interface itself. */}
      <p class="shell-fire3d-note" data-fire3d-disclosure>
        {FIRE3D_NON_PREDICTION_NOTE}
      </p>
    </div>
  );
}
