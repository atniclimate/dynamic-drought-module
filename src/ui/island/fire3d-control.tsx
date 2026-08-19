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
 * unavailable with the reason). The coverage note renders whenever the
 * control does: the terrain bake is Pacific Northwest only and the control
 * must never imply national relief.
 *
 * Chunk discipline: only TYPES are imported from the fire3d orchestrator
 * (erased at build), so this island never pulls the 3D chunk statically;
 * the live status subscription arrives through the same dynamic import
 * main.ts uses, and only while the control is actually visible.
 */

import { useEffect, useState } from 'preact/hooks';

import {
  FIRE3D_COVERAGE_NOTE,
  FIRE3D_MIN_WIDTH_QUERY
} from '../../config/fire3d-presentation';
import type { HazardClusterKey } from '../../config/clusters';
import type { Fire3DStatus } from '../../map/fire3d';
import {
  getFire3DPreference,
  onFire3DPreferenceChange,
  setFire3DPreference
} from '../../state/fire3d-store';

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
      <p class="shell-fire3d-note">{FIRE3D_COVERAGE_NOTE}</p>
    </div>
  );
}
