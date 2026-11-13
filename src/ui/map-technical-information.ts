import { HAZARD_CLUSTER_KEYS, TEMPORAL_HORIZON_KEYS } from '../config/clusters';
import { HILLSHADE_COVERAGE_SENTENCE } from '../config/terrain-coverage';
import { WHP_3D_SHADE_QUALIFICATION } from '../config/whp-shade';
import { HMS_OVERVIEW_QUALIFICATION, NIFC_PERIMETER_TECHNICAL_NOTE } from '../config/wildfire-presentation';
import { escapeHtml } from '../util/escape';
import { clusterHorizonReason } from './horizon-reason';
import { getActiveLegends, onLegendChange } from './legend-registry';

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

/**
 * What the recent NOAA satellite imagery covers, and what its edges are.
 *
 * The product is a merged mosaic of the GOES East and West full disks, so
 * its geometry is two circles, not a rectangle: coverage ends near 76
 * degrees north and south AND runs out on the far side of both disks
 * (roughly between the eastern Atlantic and the western Pacific), where the
 * service returns fully transparent pixels and the subdued base map shows
 * through. Probed live 2026-08-19: `exportImage` over central Africa and
 * south Asia returned a 334-byte fully transparent PNG at every sample,
 * while the service's own declared extent claims the whole globe. The
 * declared extent is what the raster source's `bounds` follow, because a
 * single rectangle cannot describe a footprint that wraps the
 * antimeridian; the honest move is to say what the edges mean rather than
 * to cull tiles that might carry data.
 *
 * The daylight boundary is likewise inherent: GeoColor renders the lit and
 * unlit halves differently, so a visible seam crosses the mosaic wherever
 * the terminator falls. Neither edge is a fault to hide.
 */
export const SATELLITE_COVERAGE_NOTE =
  'Coverage is the GOES East and West disks: it ends near 76 degrees north and south, and the base map shows through beyond the disks. The daylight boundary crosses the mosaic as a visible seam.';
/** The imagery's caveat, moved word for word from the SAT button's hidden status text (src/map/satellite.ts). */
export const SATELLITE_CAVEAT_NOTE =
  'Context only; daytime approximate true color, nighttime infrared with static lights; clouds can obscure land and smoke.';
// DRAFT wording (DR-177): new; needs ddm-cite and the owner's read-back. No observation time: no frame is shown.
export const SATELLITE_UNAVAILABLE_NOTE =
  'Recent NOAA satellite imagery is unavailable right now, so the map shows the plain base map.';

/** 'on' while a frame is drawn, 'unavailable' while the plain map stands in for failed imagery, null otherwise. */
type SatelliteImagery = 'on' | 'unavailable' | null;
let satelliteImagery: SatelliteImagery = null;

function satelliteHtml(): string {
  if (satelliteImagery === null) return '';
  const lines = satelliteImagery === 'on' ? [SATELLITE_CAVEAT_NOTE, SATELLITE_COVERAGE_NOTE] : [SATELLITE_UNAVAILABLE_NOTE];
  return `<h4>Satellite imagery</h4>${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}`;
}

export function setSatelliteImageryBriefing(state: SatelliteImagery): void {
  satelliteImagery = state;
  const node = typeof document === 'undefined' ? null : document.getElementById('impact-technical-satellite');
  if (node) node.innerHTML = satelliteHtml();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Mirrored literals of src/map/satellite.ts, a lazy chunk this module stays out of; the request replays its last state.
  window.addEventListener('ddm:satellite-imagery', (event) =>
    setSatelliteImageryBriefing((event as CustomEvent<{ state?: SatelliteImagery } | null>).detail?.state ?? null));
  window.dispatchEvent(new Event('ddm:satellite-imagery-request'));
}

// vocab-allow: the National Hurricane Center's own definition of its cone, verbatim (nhc.noaa.gov/aboutcone.shtml, read 2026-10-13)
const NHC_CONE_DEFINITION = 'The cone represents the probable track of the center of a tropical cyclone, and is formed by enclosing the area swept out by a set of circles (not shown) along the forecast track (at 12, 24, 36, 48, 60, 72, 96, 120 hours). The size of each circle is set so that two-thirds of historical official forecast errors over a 5-year sample fall within the circle.';

/**
 * What the ENSO "Ocean & atmosphere" control's lines and marks mean
 * (src/layers/enso-flow.ts). The map key keeps the bins and the live state
 * line; these sentences left it for the briefing, and the ocean kinds'
 * navigation disclaimers read here and nowhere else. Every kind the control
 * offers is named by its button's label. Typed here so the briefing
 * imports no flow table into another chunk; tests/terrain-coverage.test.mjs
 * holds the mask sentence to the key's own (FLOW_WORDS.mask).
 */
// DRAFT wording (DR-177): the key's own sentences, unchanged (C-fit DRAFT 6 to 9, 11 and 12), except that the
// bins sentence names the marks it speaks of, since the bins themselves stay in the key. Each paragraph opens by naming
// the kinds it speaks of, and the two winds by the names their state lines give them (FLOW_WORDS.source).
export const FLOW_TECHNICAL_NOTES: readonly string[] = [
  'Atmospheric currents, Jet-level wind and Ocean currents are drawn as lines. Atmospheric currents are the NOAA GFS 10 m wind; Jet-level wind is the NOAA GFS 250 hPa wind. Line pace shows relative speed within this field; it is not real time. Lines show the modeled flow at one instant, not the path of anything carried by it.',
  // DRAFT wording (DR-177): the crest sets as redrawn 2026-11-06 (waves-dynamics design section 5; "primary (peak)
  // wave direction" is M-020's binding wording). Needs ddm-cite and the owner's read-back. The mask sentence stays
  // FLOW_WORDS.mask word for word, and the navigation sentence is kept.
  'Ocean waves are drawn as sets of three curved lines, from NOAA GFS-Wave. Each set lies across the primary (peak) wave direction at the one stated time, averaged over about a degree of ocean where the set appears, with the longest and boldest line in front, the way the waves travel. Set size and brightness show significant wave height. All sets move at one display speed; wave speed is not shown, and the water does not travel with the marks. The spacing and curve of the lines are a drawing convention, not the wavelength or the shape of real wave fronts. Swell crosses ocean basins on nearly straight paths and passes through other swell. Where two wave systems of similar size meet, the model\'s primary direction can switch from one to the other within one model grid cell; no sets are drawn where neighbouring directions disagree. No marks within one grid cell of the coast or where the model has no water value; no marks does not mean calm water. The wave marks are unsuitable for coastal navigation.',
  'Model output, not an observation. Line width and brightness, and wave set size and brightness, are display bins, not thresholds. This is model context, independently timed from the observed SST map.',
  // ledger: rtofs-currents-producer (the admission's stub; ddm-cite pending)
  // DRAFT wording (DR-177): the currents credit and coverage, from admission rtofs-currents-producer line 11 and its
  // 2026-09-26 true-up (the seam and the gaps stated, a dated frame, not for navigation). The two boxes are the committed
  // frame's own grids; tests/terrain-coverage.test.mjs holds them to public/data/rtofs-surface-currents.json.
  // DRAFT wording (DR-177): admission gfs-runtime-nodd, 2026-10-13, product (b). The field is named by the issuer's own
  // `.idx` words and unit (NCEP GRIB2 table 4.2-0-1: "Precipitable Water", kg m-2). No definition of it is given here: one
  // ships only as the issuer's own sentence with its link. It is never called a weather feature, a rain amount or a
  // movement of moisture.
  'Precipitable water is the NOAA GFS field "PWAT: entire atmosphere (considered as a single layer)", in kg m-2 as the issuer gives it: a column total at one model instant, on a 1.0 degree grid. Model output, not an observation. The white shade is drawn by DDM from those values and is not a NOAA image. Its steps are display bins chosen by DDM, not thresholds and not issuer classes. The shade holds still: it does not show rain, and it does not show which way moisture is moving.',
  'Ocean currents are model output: surface currents from the NOAA/NCEP Global RTOFS ocean model, re-encoded by DDM. The map holds one dated frame, as old as its last update: the state line gives the model run, the instant the frame is valid at and its age. Two model grids are held, each on its own spacing and never joined: 1.0 degree from 40 S to 39 N and 130 E to 111 W, and 0.3 degree from 40 N to 84.7 N and 140 E to 115.3 W. The grid under the centre of the view is drawn. Nothing is drawn between 39 N and 40 N, east of 111 W south of 40 N (the coasts of mainland Mexico and Central America) or west of 130 E. Not for navigation.'
];

// DRAFT wording (DR-177): the HeatRisk coverage sentence and the NWS products stamp left the map key for here.
const HEATRISK_COVERAGE_NOTE = 'National Weather Service HeatRisk covers the contiguous United States only.';
// vocab-allow: verbatim NWS product names, quoted source data
const NWS_HEAT_NAME_NOTE = 'Products issued under the former names Excessive Heat Warning and Excessive Heat Watch are drawn in the colours of Extreme Heat Warning and Extreme Heat Watch and share their rows in the key; a product\'s popup gives the name it was issued under.';
const NWS_SNAPSHOT_NOTE = 'National Weather Service products are read about every five minutes; the time beside them in the key is when DDM last read them, not when a product was issued or when it is in effect.';
// DRAFT wording (DR-019): the current-conditions sentence scoped to the horizon it is true at, and the binding's own
// words ("CPC seasonal outlooks that ENSO informs, not an ENSO forecast", decided 2026-09-02) for the Season ahead outlooks, the issuer named in full.
const ENSO_CURRENT_NOTE = 'At Current the map shows current conditions.';
// vocab-allow: honesty disclaimer denying that the CPC seasonal outlooks drawn are an ENSO forecast (DR-019)
const ENSO_SEASON_AHEAD_NOTE = 'At Season ahead the outlooks drawn are NOAA Climate Prediction Center seasonal outlooks that ENSO informs, not an ENSO forecast.';

/**
 * `leadHtml` is a trusted, already-escaped block the briefing puts first in
 * the section (owner direction 2026-11-09 (sprint), DR-pending): the priority
 * view's reading order, rendered from its own table by
 * src/ui/briefing-lead.ts `renderPriorityRule`. It is a parameter, not an
 * import, so that table stays out of this module's chunk, which the map
 * island loads for its notes.
 */
export function renderMapTechnicalInformation(open = false, leadHtml = ''): string {
  return `<details class="impact-technical-information"${open ? ' open' : ''}>
    <summary>Technical information</summary>
    ${leadHtml}
    <h4>Drought navigation overview</h4>
    <p id="impact-technical-drought">${escapeHtml(notes.drought)}</p>
    <h4>Wildfire navigation overview</h4>
    <p id="impact-technical-wildfire">${escapeHtml(notes.wildfire)}</p>
    <h4>Mapped fire perimeters</h4>
    <p>${escapeHtml(NIFC_PERIMETER_TECHNICAL_NOTE)}</p>
    <h4>Smoke Plumes (HMS)</h4>
    <p>${escapeHtml(HMS_OVERVIEW_QUALIFICATION)}</p>
    <h4>3D Fire context</h4>
    <p id="impact-technical-fire3d">${escapeHtml(notes.fire3d)}</p>
    <p>The 3D view shows published source data as context. It computes no fire behavior and does not show or imply spread, ignition, or an all-clear.</p>
    <p>Wildfire Hazard Potential 2023 reflects landscape conditions as of the end of 2020 (USFS), so areas burned since then still show their earlier class.</p>
    <p>${escapeHtml(WHP_3D_SHADE_QUALIFICATION)}</p>
    <p>In Wildfire 3D, fuel risk is not drawn inside current fire perimeters (NIFC).</p>
    <div id="impact-technical-plant-stress">${plantStressHtml()}</div>
    <h4>Extreme Heat</h4>
    <p>${escapeHtml(HEATRISK_COVERAGE_NOTE)}</p>
    <h4>National Weather Service products</h4>
    <p>${escapeHtml(NWS_HEAT_NAME_NOTE)}</p>
    <p>${escapeHtml(NWS_SNAPSHOT_NOTE)}</p>
    <h4>ENSO</h4>
    <p>${escapeHtml(ENSO_CURRENT_NOTE)}</p>
    <p>${escapeHtml(ENSO_SEASON_AHEAD_NOTE)}</p>
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
    <div id="impact-technical-satellite">${satelliteHtml()}</div>
    <h4>Time horizon</h4>
    ${horizonReasonsHtml()}
    <div id="impact-technical-layer-notes">${layerNotesHtml()}</div>
  </details>`;
}

/**
 * Legend sections whose notes this briefing already carries above (the NWS products
 * note, the GHRSST paragraph and the 3D Wildfire hazard shade qualification), so
 * they are not read out twice.
 */
const NOTES_CARRIED_ABOVE: ReadonlySet<string> = new Set(['nws-alerts', 'sst-anomaly', 'whp-2023']);

// A layer can come or go while the briefing is open (phone sheet, desktop drawer, a late load): refresh in place.
onLegendChange(() => {
  const node = typeof document === 'undefined' ? null : document.getElementById('impact-technical-layer-notes');
  if (node) node.innerHTML = layerNotesHtml();
});
const LEGEND_NOTE = /<p class="([^"]*\blegend-note\b[^"]*)"[^>]*>([\s\S]*?)<\/p>/g;
const LEGEND_TITLE = /<h3 class="legend-section-title">([\s\S]*?)<\/h3>/;

/**
 * The notes, qualifications and credits of the layers on the map. The one-box Key
 * leaves every `.legend-note` out (src/ui/map-key.ts), so they read here: each
 * shown legend section is rendered by its own builder (src/ui/legend-registry.ts),
 * so no sentence is retyped and a layer added later is covered. The RAWS notice
 * (`legend-ddm-notice`) stays in Acknowledgements, where DR-159 puts it; ids are
 * dropped so the copy never doubles one in the legend panel.
 */
function layerNotesHtml(): string {
  if (typeof document === 'undefined') return '';
  const blocks: string[] = [];
  for (const { key, spec } of getActiveLegends()) {
    if (NOTES_CARRIED_ABOVE.has(key)) continue;
    const body = document.createElement('div');
    spec.render(body);
    const html = body.innerHTML;
    const notes = [...html.matchAll(LEGEND_NOTE)]
      .filter(([, classes]) => !classes!.includes('legend-ddm-notice'))
      .map(([, , inner]) => inner!.replace(/ id="[^"]*"/g, ''));
    if (notes.length === 0) continue;
    const title = LEGEND_TITLE.exec(html)?.[1];
    blocks.push(notes.map((note, index) => `<p>${index === 0 && title ? `<strong>${title}.</strong> ` : ''}${note}</p>`).join(''));
  }
  return blocks.length ? `<h4>Notes for the layers on the map</h4>${blocks.join('')}` : '';
}

/** Each mode's disabled-chip reasons, which left the sidebar for here (the chips keep them as their titles). */
function horizonReasonsHtml(): string {
  return HAZARD_CLUSTER_KEYS.map((cluster) => TEMPORAL_HORIZON_KEYS.map((key) => clusterHorizonReason(cluster, key))
    .filter((reason) => reason !== null).join(' '))
    .filter((text) => text !== '')
    .map((text) => `<p>${escapeHtml(text)}</p>`)
    .join('');
}
