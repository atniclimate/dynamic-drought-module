/**
 * The desktop 3D Fire view toggle (W3/W4), rendered in the shell island
 * directly under the hazard cluster buttons.
 *
 * Visibility: only while the committed cluster is 'wildfire' AND the
 * viewport matches the desktop breakpoint. Embed mode hides the whole
 * shell panel (app.css: .app-shell.embed #shell-panel), so the control is
 * inert in embeds for free while a URL-named fire3d=true still drives the
 * map-side effect through the orchestrator.
 *
 * The button mirrors the PREFERENCE (the user's durable ask, aria-pressed
 * flips with the click); the status line underneath tells the honest truth
 * about the scene (checking, active with or without the smoke volume,
 * unavailable with the reason), and since 2026-08-19 a fourth line
 * appears when the smoke volume is on and the issuer returned no plumes,
 * so an empty sky reads as an answer instead of a broken feature. The
 * coverage note renders whenever the control does: the terrain bake is
 * Pacific Northwest only and the control must never imply national
 * relief.
 *
 * Chunk discipline: only TYPES are imported from the fire3d orchestrator
 * (erased at build), so this island never pulls the 3D chunk statically;
 * the live status subscription arrives through the same dynamic import
 * main.ts uses, and only while the control is actually visible.
 */

import { useEffect, useState } from 'preact/hooks';

import {
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_MIN_WIDTH_QUERY,
  FIRE3D_NON_PREDICTION_NOTE
} from '../../config/fire3d-presentation';
import type { HazardClusterKey } from '../../config/clusters';
import type { Fire3DStatus } from '../../map/fire3d';
import {
  getFire3DPreference,
  onFire3DPreferenceChange,
  setFire3DPreference
} from '../../state/fire3d-store';
import { registry } from '../../state/registry';

/** The catalog key whose emptiness the 3D control reports. */
const HMS_SMOKE_LAYER_KEY = 'hms-smoke';

function statusLine(status: Fire3DStatus | null): string {
  if (status === null) return '';
  switch (status.state) {
    case 'checking':
      return 'Checking terrain availability...';
    case 'active':
      return status.smokeVolume
        ? 'Active: terrain relief with the smoke volume.'
        : 'Active: terrain relief; smoke stays in the flat veil.';
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
 * the smoke volume" while there was no smoke to have volume, and the
 * absence read as a broken feature instead of an answer.
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
  const [desktop, setDesktop] = useState<boolean>(
    () => window.matchMedia(FIRE3D_MIN_WIDTH_QUERY).matches
  );
  const [preference, setPreference] = useState<boolean>(getFire3DPreference);
  const [status, setStatus] = useState<Fire3DStatus | null>(null);
  const [smokeStatus, setSmokeStatus] = useState<string | undefined>(() =>
    registry.getStatus(HMS_SMOKE_LAYER_KEY)
  );

  useEffect(() => {
    const query = window.matchMedia(FIRE3D_MIN_WIDTH_QUERY);
    const onChange = (): void => {
      setDesktop(query.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
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

  const visible = desktop && cluster === 'wildfire';

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

  if (!visible) return null;

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
