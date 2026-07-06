/**
 * ENSO driver line (0.4.0 B2 slice 1).
 *
 * A one-line, always-visible readout of the El Nino / Southern Oscillation
 * (ENSO) state directly under the conditions strip: the phase, the latest
 * Oceanic Nino Index (ONI) reading, and a five-word Pacific Northwest tilt.
 * Expanding the line (a native details/summary disclosure) shows the full
 * odds-never-outcomes tilt paragraph with the modulators named, the snapshot
 * provenance, and the source link.
 *
 * This deliberately does NOT live inside the conditions strip: the strip's
 * contract is "reflect what is rendered on the map" and ENSO is a climate
 * driver, not a map layer. It reads the bundled build-time snapshot (no
 * network dependency beyond the local file), and on any failure the section
 * stays hidden; a missing snapshot never becomes a faked phase.
 */
import { fetchEnsoDriverSummary } from '../impact/enso';
import { escapeHtml } from '../util/escape';

const SECTION_ID = 'enso-driver';

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
        <a class="enso-driver-source" href="${escapeHtml(summary.sourceUrl)}" target="_blank" rel="noopener">NOAA CPC ONI and Relative ONI</a>
      </details>
    `;
    section.hidden = false;
  });
}
