import { HILLSHADE_COVERAGE_SENTENCE } from '../config/terrain-coverage';
import { HMS_OVERVIEW_QUALIFICATION } from '../config/wildfire-presentation';
import { escapeHtml } from '../util/escape';

type Overview = 'drought' | 'wildfire' | 'fire3d';
type PlantStress = import('../layers/wildfire-dryness').DrynessBriefing | null;

/**
 * The 3D paragraph while no scene has resolved an archive: the flat Terrain
 * Shading's own sentence (bundled, zoom 8), never a 3D relief depth the
 * scene may not read (it resolves the deep archive's header on entry).
 */
const FIRE3D_IDLE_NOTE =
  `${HILLSHADE_COVERAGE_SENTENCE} The 3D scene lists its own archive and that archive's detail ` +
  'under 3D information while it is open. Bundled structure data covers the central Oregon ' +
  'pilot area only, from zoom 13.';

/** Methodology lives with the briefing; updating it never fetches a source. */
const notes: Record<Overview, string> = {
  drought:
    'The North American Drought Monitor navigation overview uses an approximate area-weighted mean category index over assessed land. Outline width represents the D1 through D4 share. The overview is inferred from NADM polygons, not an NADM-issued regional category; hatching marks partial coverage.',
  wildfire:
    'The wildfire navigation overview first checks current mapped NIFC wildfire perimeters. A zero count does not establish no active wildfire. Only a successful zero-count check permits the USFS Wildfire Hazard Potential 2023 static overview; failed checks remain unavailable. WHP percentages cover classified land in the covered United States portion. Hatching marks partial coverage; desaturation and stippling identify static potential.',
  fire3d: FIRE3D_IDLE_NOTE
};
/** The Wildfire 3D plant-stress ground's full text, while a product is on the map (src/layers/wildfire-dryness.ts). */
let plantStress: PlantStress = null;

export function setMapTechnicalNote(overview: Overview, text: string, sceneActive = false): void {
  notes[overview] = overview === 'fire3d' && !sceneActive ? FIRE3D_IDLE_NOTE : text;
  const node = typeof document === 'undefined' ? null : document.getElementById(`impact-technical-${overview}`);
  if (node) node.textContent = notes[overview];
}

function plantStressHtml(): string {
  if (!plantStress) return '';
  return '<h4>Plant stress ground (Wildfire 3D)</h4>' +
    plantStress.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') +
    (plantStress.disclaimerUrl
      ? `<p><a href="${escapeHtml(plantStress.disclaimerUrl)}" target="_blank" rel="noopener">NOAA STAR product disclaimer</a></p>`
      : '');
}

export function setPlantStressBriefing(briefing: PlantStress): void {
  plantStress = briefing;
  const node = typeof document === 'undefined' ? null : document.getElementById('impact-technical-plant-stress');
  if (node) node.innerHTML = plantStressHtml();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Mirrored literals of src/layers/wildfire-dryness.ts; the request replays the last state when the ground loaded first.
  window.addEventListener('ddm:dryness-ground', (event) =>
    setPlantStressBriefing((event as CustomEvent<{ briefing?: PlantStress } | null>).detail?.briefing ?? null));
  window.dispatchEvent(new Event('ddm:dryness-ground-request'));
}

// vocab-allow: the National Hurricane Center's own definition of its cone, verbatim (nhc.noaa.gov/aboutcone.shtml, read 2026-10-13)
const NHC_CONE_DEFINITION = 'The cone represents the probable track of the center of a tropical cyclone, and is formed by enclosing the area swept out by a set of circles (not shown) along the forecast track (at 12, 24, 36, 48, 60, 72, 96, 120 hours). The size of each circle is set so that two-thirds of historical official forecast errors over a 5-year sample fall within the circle.';

/**
 * What the ENSO "Ocean & atmosphere" control's lines and marks mean
 * (src/layers/enso-flow.ts). The map key keeps the bins and the live state
 * line; these sentences left it for the briefing. Typed here so the briefing
 * imports no flow table into another chunk; tests/terrain-coverage.test.mjs
 * holds the mask sentence to the key's own (FLOW_WORDS.mask).
 */
// DRAFT wording (DR-177): the key's own sentences, unchanged (C-fit DRAFT 6 to 9, 11 and 12), except that the
// bins sentence names the marks it speaks of, since the bins themselves stay in the key.
export const FLOW_TECHNICAL_NOTES: readonly string[] = [
  'Line pace shows relative speed within this field; it is not real time. Lines show the modeled flow at one instant, not the path of anything carried by it.',
  'Marks move the way the primary waves travel, all at one display speed; wave speed is not shown. The water does not travel with the marks. No marks within one grid cell of the coast or where the model has no water value; no marks does not mean calm water.',
  'Model output, not an observation. Line width and brightness, and mark length and brightness, are display bins, not thresholds. This is model context, independently timed from the observed SST map.',
  // ledger: rtofs-currents-producer (the admission's stub; ddm-cite pending)
  // DRAFT wording (DR-177): the currents credit and coverage, from admission rtofs-currents-producer line 11 and its
  // 2026-09-26 true-up (the seam and the gaps stated, a dated frame, not for navigation). The two boxes are the committed
  // frame's own grids; tests/terrain-coverage.test.mjs holds them to public/data/rtofs-surface-currents.json.
  'Ocean currents are surface currents from the NOAA/NCEP Global RTOFS ocean model, re-encoded by DDM (model). The map holds one dated frame, as old as its last update: the state line gives the model run, the instant the frame is valid at and its age. Two model grids are held, each on its own spacing and never joined: 1.0 degree from 40 S to 39 N and 130 E to 111 W, and 0.3 degree from 40 N to 84.7 N and 140 E to 115.3 W. The grid under the centre of the view is drawn. Nothing is drawn between 39 N and 40 N, east of 111 W south of 40 N (the coasts of mainland Mexico and Central America) or west of 130 E. Not for navigation.'
];

export function renderMapTechnicalInformation(): string {
  return `<details class="impact-technical-information">
    <summary>Technical information</summary>
    <h4>Drought navigation overview</h4>
    <p id="impact-technical-drought">${escapeHtml(notes.drought)}</p>
    <h4>Wildfire navigation overview</h4>
    <p id="impact-technical-wildfire">${escapeHtml(notes.wildfire)}</p>
    <h4>Smoke Plumes (HMS)</h4>
    <p>${escapeHtml(HMS_OVERVIEW_QUALIFICATION)}</p>
    <h4>3D Fire context</h4>
    <p id="impact-technical-fire3d">${escapeHtml(notes.fire3d)}</p>
    <p>The 3D view shows published source data as context. It computes no fire behavior and does not show or imply spread, ignition, or an all-clear.</p>
    <p>Wildfire Hazard Potential 2023 reflects landscape conditions as of the end of 2020 (USFS), so areas burned since then still show their earlier class.</p>
    <p>In Wildfire 3D, fuel risk is not drawn inside current fire perimeters (NIFC).</p>
    <div id="impact-technical-plant-stress">${plantStressHtml()}</div>
    <h4>ENSO</h4>
    <p>The map shows current conditions.</p>
    <p>"It is inaccurate to label individual storms or events as a La Niña or El Niño event. Rather, these climate extremes affect the position and intensity of the jet streams, and the normal regions of high and low pressure, which in turn affect the average intensity and track of storms." <a href="https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ensofaq.shtml" target="_blank" rel="noopener">NOAA Climate Prediction Center, ENSO FAQ</a></p>
    <h4>Ocean Temperature Anomaly</h4>
    <p>Surface temperature anomalies are shown for large lakes and inland seas as well as the ocean.</p>
    <p>"The Sea Surface Temperature Anomalies (L4, MUR) layer is created from the Group for High Resolution Sea Surface Temperature (GHRSST) Sea Surface Temperature Level 4, MUR sea surface temperature analysis product, which uses wavelets as basis functions in an optimal interpolation approach on a global 0.011 degree grid." <a href="https://www.earthdata.nasa.gov/news/worldview-image-archive/global-sea-surface-temperature-anomalies" target="_blank" rel="noopener">NASA Earthdata</a></p>
    <h4>Ocean &amp; atmosphere</h4>
    ${FLOW_TECHNICAL_NOTES.map((note) => `<p>${escapeHtml(note)}</p>`).join('')}
    <h4>Active Tropical Cyclones</h4>
    <p>"${NHC_CONE_DEFINITION}" <a href="https://www.nhc.noaa.gov/aboutcone.shtml" target="_blank" rel="noopener">National Hurricane Center, definition of the cone</a></p>
    <p>Basins covered: Atlantic, Eastern North Pacific, Central North Pacific.</p>
    <p>${escapeHtml("Circles are sized by the issuer's wind classes; the issuer's icons are not reproduced.")}</p>
    <p>Times are as the issuer states them; DDM does not read them as full dates.</p>
  </details>`;
}
