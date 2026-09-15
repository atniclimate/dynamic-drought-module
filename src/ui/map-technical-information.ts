import { escapeHtml } from '../util/escape';

type Overview = 'drought' | 'wildfire' | 'fire3d';

/** Methodology lives with the briefing; updating it never fetches a source. */
const notes: Record<Overview, string> = {
  drought:
    'The North American Drought Monitor navigation overview uses an approximate area-weighted mean category index over assessed land. Outline width represents the D1 through D4 share. The overview is inferred from NADM polygons, not an NADM-issued regional category; hatching marks partial coverage.',
  wildfire:
    'The wildfire navigation overview first checks current mapped NIFC wildfire perimeters. A zero count does not establish no active wildfire. Only a successful zero-count check permits the USFS Wildfire Hazard Potential 2023 static overview; failed checks remain unavailable. WHP percentages cover classified land in the covered United States portion. Hatching marks partial coverage; desaturation and stippling identify static potential.',
  fire3d:
    'Terrain relief uses USGS 3D Elevation Program data for the Pacific Northwest. Outside the active archive extent the ground renders flat, a coverage gap. Closer views stretch the deepest archived tiles. Active archive detail and coverage are listed under 3D information. Bundled structures cover the central Oregon pilot area only.'
};

export function setMapTechnicalNote(overview: Overview, text: string): void {
  notes[overview] = text;
  const node = document.getElementById(`impact-technical-${overview}`);
  if (node) node.textContent = text;
}

export function renderMapTechnicalInformation(): string {
  return `<details class="impact-technical-information">
    <summary>Technical information</summary>
    <h4>Drought navigation overview</h4>
    <p id="impact-technical-drought">${escapeHtml(notes.drought)}</p>
    <h4>Wildfire navigation overview</h4>
    <p id="impact-technical-wildfire">${escapeHtml(notes.wildfire)}</p>
    <h4>3D Fire context</h4>
    <p id="impact-technical-fire3d">${escapeHtml(notes.fire3d)}</p>
    <p>The 3D view shows published source data as context. It computes no fire behavior and does not show or imply spread, ignition, or an all-clear.</p>
  </details>`;
}
