/**
 * ENSO driver line (0.4.0 B2 slice 1).
 *
 * A one-line readout of the El Nino / Southern Oscillation (ENSO) state inside
 * the Brief display description: the phase, the latest Oceanic Nino Index
 * (ONI) reading, and a short Pacific Northwest tilt. Expanding the line (a
 * native details/summary disclosure) shows the full odds-never-outcomes tilt
 * paragraph with the modulators named, the snapshot provenance, and the source
 * link.
 *
 * This deliberately does not live inside the conditions strip: the strip's
 * contract is "reflect what is rendered on the map" and ENSO is a climate
 * driver, not a map layer. It reads the bundled build-time snapshot (no network
 * dependency beyond the local file), and on any failure the section stays
 * hidden; a missing snapshot never becomes a faked phase.
 */
import { fetchEnsoDriverSummary } from '../impact/enso';
import { escapeHtml } from '../util/escape';
import { prefersReducedMotion } from '../util/motion';
import { requestLayerOn } from './layer-toggle-command';
import { getMapRef } from './sidebar';

const SECTION_ID = 'enso-driver';

/**
 * The Pacific basin framing for the "View the Pacific" action: wide enough
 * to hold the whole ENSO tongue and the West Coast, so the eye can travel
 * from the Nino 3.4 box to home. Explicit southwest/northeast corners, kept
 * INSIDE -180..180 (a west edge past the antimeridian made MapLibre resolve
 * a wrong, too-narrow framing that left the Nino 3.4 box off-screen; found
 * by the 2026-07-06 browser verification). maxZoom guards the wide framing
 * on any screen aspect.
 */
const PACIFIC_BASIN_BOUNDS: [[number, number], [number, number]] = [
  [-178, -22],
  [-104, 48]
];

/** Build and reveal the ENSO driver line. Safe to call once at boot. */
export function buildEnsoDriver(): void {
  const section = document.getElementById(SECTION_ID);
  if (!section) return;

  const controller = new AbortController();
  void fetchEnsoDriverSummary(controller.signal).then((summary) => {
    if (!summary) return; // stay hidden; no faked phase
    section.innerHTML = `
      <details class="enso-driver-details">
        <summary class="enso-driver-line">
          <span class="enso-driver-kicker">ENSO driver</span>
          <span class="enso-driver-value">${escapeHtml(summary.phaseName)} · ${escapeHtml(summary.latest)}</span>
          <span class="enso-driver-tilt">${escapeHtml(summary.shortTilt)}</span>
        </summary>
        <p class="enso-driver-detail">${escapeHtml(summary.detail)}</p>
        <div class="enso-driver-actions">
          <button type="button" class="enso-driver-pacific" id="enso-view-pacific">View the Pacific</button>
          <a class="enso-driver-source" href="${escapeHtml(summary.sourceUrl)}" target="_blank" rel="noopener">NOAA CPC ONI and Relative ONI</a>
        </div>
      </details>
    `;
    section.hidden = false;

    // "View the Pacific": turn on the ocean-temperature surface and frame the
    // basin, so the driver line's number becomes a visible pattern. The layer
    // is activated through the shared toggle command (the serialized
    // activation path's DOM-free door); never by calling a layer module's
    // activate directly, and never via the checkbox element, which does not
    // exist until the lazy island mounts (the spike's Codex adversarial
    // finding).
    const btn = section.querySelector<HTMLButtonElement>('#enso-view-pacific');
    btn?.addEventListener('click', () => {
      requestLayerOn('sst-anomaly');
      // The 1200 ms sweep jumps for reduced-motion users (WCAG 2.3.3, #7).
      getMapRef()?.fitBounds(PACIFIC_BASIN_BOUNDS, {
        padding: 24,
        duration: prefersReducedMotion() ? 0 : 1200,
        maxZoom: 3
      });
    });
  });
}
