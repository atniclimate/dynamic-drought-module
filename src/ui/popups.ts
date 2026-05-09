import type { GeoJsonProperties } from 'geojson';
import { pickTreatyEntry } from '../config/palette';
import { escapeHtml } from '../util/escape';

/**
 * Popup HTML factories. Each takes either a pre-extracted name (where the
 * caller has already done property fallback) or the raw GeoJSON properties
 * object and returns a self-contained HTML string. Every interpolated value
 * passes through `escapeHtml`.
 *
 * Telemetry popup factories live alongside in M5 (src/ui/popups.ts grows;
 * see kickoff Phase B step 5).
 */

export function buildEcoregionPopupHtml(name: string): string {
  return `
    <div class="popup-title">${escapeHtml(name)}</div>
    <div class="popup-agency">EPA · Level III Ecoregion</div>
    <div class="popup-description">Ecoregions denote areas of general similarity in ecosystems and in the type, quality, and quantity of environmental resources.</div>
    <div class="popup-links">
      <a href="https://www.epa.gov/eco-research/level-iii-and-iv-ecoregions-continental-united-states" target="_blank" rel="noopener">EPA Ecoregions</a>
    </div>
  `;
}

export function buildTribalPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p.LARName || p.LARNAME || p.NAME || p.name || p.TRIBE || p.RESERV_NAM || 'Tribal Land Area';
  const govt = p.LARGovernment || p.GOVT || p.tribe || '';
  const type = p.LARType || p.TYPE || '';
  const acresRaw = p.GISAcres || p.ACRES || '';

  const acresNumber = acresRaw === '' || acresRaw === null || acresRaw === undefined
    ? null
    : Number(acresRaw);
  const acresStr = acresNumber !== null && Number.isFinite(acresNumber)
    ? acresNumber.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : '';

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">Tribal Land</div>
    ${govt ? `<div class="popup-description"><strong>Government:</strong> ${escapeHtml(String(govt))}</div>` : ''}
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(String(type))}</div>` : ''}
    ${acresStr ? `<div class="popup-treaty-meta">Acres: ${escapeHtml(acresStr)}</div>` : ''}
    <div class="popup-links">
      <a href="https://catalog.data.gov/dataset/american-indian-and-alaska-native-areas" target="_blank" rel="noopener">BIA AIAN-LAR (data.gov)</a>
      <a href="https://geo.wa.gov/" target="_blank" rel="noopener">WA Geospatial Open Data</a>
    </div>
  `;
}

export function buildTreatyPopupHtml(props: GeoJsonProperties, featureName: string): string {
  const p = props ?? {};
  const year = p.treaty_year || p.TREATY_DAT || p.TREATY_DATE || p.SIGNED_DAT || p.YEAR_SIGNED || p.year || '';
  const dataTribe = p.tribe || p.TRIBE_NAME || p.TRIBE || '';
  const entry = pickTreatyEntry(featureName);
  // Prefer the formal Tribe name from TREATY_COLORS over the (possibly
  // abbreviated) value in the source GeoJSON; fall back to the source value
  // for Treaty-location keys signed by multiple Tribes.
  const tribe: string = (entry && entry.tribe) || String(dataTribe || '');

  return `
    <div class="popup-title">${escapeHtml(featureName)}</div>
    <div class="popup-agency">Historical Treaty Area</div>
    ${year ? `<div class="popup-treaty-meta">Signed: ${escapeHtml(String(year))}</div>` : ''}
    ${tribe ? `<div class="popup-treaty-meta">Tribe: ${escapeHtml(tribe)}</div>` : ''}
    <div class="popup-description">Agency polygons are a representation of Treaty cession areas, not a definitive depiction of Tribal jurisdiction. Treaty rights and Tribal sovereignty are matters of sovereign authority.</div>
    <div class="popup-links">
      <a href="https://wisaard.dahp.wa.gov/" target="_blank" rel="noopener">WA DAHP WISAARD</a>
      <a href="https://native-land.ca/" target="_blank" rel="noopener">Native Land Digital</a>
    </div>
  `;
}
