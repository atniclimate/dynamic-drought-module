/**
 * Popup factories for the power infrastructure layer.
 *
 * These live outside `src/ui/popups.ts` deliberately. That module is the
 * shared factory set AND the telemetry hydration path, so importing it
 * pulls the station registry and the sparkline charts along with it: the
 * activation-budget gate measured a power activation at 19.3 kB gzip
 * against a 6 kB budget, almost all of it code a transmission line will
 * never run. Two self-contained builders that need nothing but HTML
 * escaping belong in their own file.
 *
 * Honesty rules both builders share: every value is an issuer field
 * printed as published, nothing is computed or combined across layers,
 * and the issuer's own unknown sentinels stay unknowns rather than being
 * rendered as data.
 */

import type { GeoJsonProperties } from 'geojson';

import { escapeHtml } from '../util/escape';

/**
 * Popup for one EIA power plant.
 *
 * Capacity prints with its unit and the issuer's reporting period beside
 * it, because a megawatt number without a vintage invites a reader to
 * treat an inventory figure as today's output.
 */
export function buildPowerPlantPopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const name = p['Plant_Name'] || 'Power plant';
  const source = p['PrimSource'] || '';
  const utility = p['Utility_Na'] || '';
  const megawatts = Number(p['Total_MW']);
  const period = readEiaPeriod(p['Period']);

  return `
    <div class="popup-title">${escapeHtml(String(name))}</div>
    <div class="popup-agency">U.S. Energy Information Administration · Forms 860/860M</div>
    ${source ? `<div class="popup-treaty-meta">Primary energy source: ${escapeHtml(String(source))}</div>` : ''}
    ${
      Number.isFinite(megawatts)
        ? `<div class="popup-treaty-meta">Nameplate capacity: ${escapeHtml(
            megawatts.toLocaleString(undefined, { maximumFractionDigits: 1 })
          )} MW</div>`
        : ''
    }
    ${utility ? `<div class="popup-treaty-meta">Utility: ${escapeHtml(String(utility))}</div>` : ''}
    ${period ? `<div class="popup-treaty-meta">Issuer reporting period: ${escapeHtml(period)}</div>` : ''}
    <div class="popup-description">An inventory location published by the issuer. The symbol marks where a plant is, not what it is generating now, and nameplate capacity is a rated maximum rather than current output.</div>
    <div class="popup-links">
      <a href="https://www.eia.gov/electricity/data/eia860/" target="_blank" rel="noopener">EIA Form 860 documentation</a>
    </div>
  `;
}

/** 'YYYYMM' as published becomes 'YYYY-MM'; anything else prints verbatim. */
function readEiaPeriod(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  return /^\d{6}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * Popup for one archived HIFLD transmission line.
 *
 * The currency caveat is not optional chrome here: this record set
 * stopped being maintained, so a line under the cursor may no longer
 * exist, may have been rebuilt, or may never have been energized.
 */
export function buildPowerLinePopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const voltClass = readHifldValue(p['VOLT_CLASS']);
  const owner = readHifldValue(p['OWNER']);
  const status = readHifldValue(p['STATUS']);
  const type = readHifldValue(p['TYPE']);
  const voltage = Number(p['VOLTAGE']);
  // The issuer writes -999999 for an unknown voltage; printing it would be
  // a fabricated reading.
  const voltageText =
    Number.isFinite(voltage) && voltage > 0
      ? `${voltage.toLocaleString(undefined, { maximumFractionDigits: 0 })} kV`
      : '';

  return `
    <div class="popup-title">Transmission line</div>
    <div class="popup-agency">HIFLD (U.S. Government) · archived, no longer maintained</div>
    <div class="popup-treaty-meta">Voltage class: ${escapeHtml(voltClass || 'not published')}</div>
    ${voltageText ? `<div class="popup-treaty-meta">Voltage: ${escapeHtml(voltageText)}</div>` : ''}
    <div class="popup-treaty-meta">Owner: ${escapeHtml(owner || 'not published')}</div>
    <div class="popup-treaty-meta">Operational status: ${escapeHtml(status || 'not published')}</div>
    ${type ? `<div class="popup-treaty-meta">Type: ${escapeHtml(type)}</div>` : ''}
    <div class="popup-description">From an archived federal dataset whose last data update was 2024-09-30; the publishing program was discontinued in 2025 and no one maintains it. Records the issuer marks inactive or status-unknown are drawn the same as active ones. Not for siting or safety-critical decisions.</div>
  `;
}

/** HIFLD writes 'NOT AVAILABLE' where a value is unknown; keep it an unknown. */
function readHifldValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (value === '' || value.toUpperCase() === 'NOT AVAILABLE') return '';
  return value;
}
