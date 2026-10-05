/**
 * Popup builders for the power infrastructure layer.
 *
 * These live outside `src/ui/popups.ts` deliberately. That module is the
 * shared factory set AND the telemetry hydration path, so importing it
 * pulls the station registry and the sparkline charts along with it: the
 * activation-budget gate measured a power activation at 19.3 kB gzip
 * against a 6 kB budget, almost all of it code a transmission line will
 * never run. Two self-contained builders that import nothing but the
 * frame's types belong in their own file.
 *
 * Since S30D D1 M26b (DDM-P11-T04) each builder returns the popup frame's
 * typed model (src/ui/popup-frame.ts, types only), which the click
 * coordinator paints (DR-178); interface-chrome-popups-text.md 3.5 rows 17
 * and 18. Each head slot holds one line at the narrowest desktop measure,
 * the title two (DR-179's note for M26's builders); the rest is body.
 *
 * Honesty rules both builders share: every value is an issuer field
 * printed as published, nothing is computed or combined across layers,
 * and the issuer's own unknown sentinels stay unknowns rather than being
 * rendered as data.
 */

import type { GeoJsonProperties } from 'geojson';

import type { IssuedModel, PopupClock, PopupDetail } from './popup-frame';
import { escapeHtml } from '../util/escape';

/** The frame's explanation for issuer time text DDM does not parse (PF1; the M25 builders' wording). */
const SUPPLIED_TIME_EXPLANATION = 'As the issuer states it; DDM does not read it as a full date.';

/** The wording these builders have always used for an issuer field left unpublished. */
const NOT_PUBLISHED = 'not published';

const PLANT_NOTE =
  'An inventory location published by the issuer. The symbol marks where a plant is, not what it is generating now, and nameplate capacity is a rated maximum rather than current output.';

const LINE_NOTE =
  'From an archived federal dataset whose last data update was 2024-09-30; the publishing program was discontinued in 2025 and no one maintains it. Records the issuer marks inactive or status-unknown are drawn the same as active ones. Not for siting or safety-critical decisions.';

/**
 * The line's stated source: the archive names no public page
 * (src/config/products.ts names no endpoint for the layer), so the frame's
 * no-source slot carries the layer's own credit sentence, verbatim
 * (src/config/acknowledgements.ts `hifld`, ledger
 * esri-fuc-transmission-lines-host, cite sheet c05; the same line the power
 * key prints, src/layers/power-3d.ts).
 */
const LINE_SOURCE =
  'Transmission lines: U.S. Electric Power Transmission Lines (U.S. Government), archived copy last updated 2024-09-30, via the Esri Federal User Community.';

/** An issuer text field as given, or null when missing, blank or not text (never `String()` on an arbitrary value). */
function issuerText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A finite number from a numeric field (a number or numeric text), or null for a missing, blank or non-numeric value. */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** One detail row, or none when the issuer left the field empty. */
function row(label: string, value: string | null): PopupDetail[] {
  return value === null ? [] : [{ kind: 'row', label, text: value }];
}

/**
 * The issuer's reporting period (`Period`, 'YYYYMM' as published) at month
 * precision, never given a day; other text as supplied; none stated, the
 * absence in these builders' own word.
 */
function periodClock(raw: unknown): PopupClock {
  const label = 'Issuer reporting period';
  const text = issuerText(raw);
  if (text === null) return { kind: 'not-stated', label, reason: NOT_PUBLISHED };
  const ym = /^(\d{4})(\d{2})$/.exec(text);
  if (ym !== null && Number(ym[1]) >= 1000 && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) {
    return { kind: 'point', meaning: 'data-period', label, at: { precision: 'month', month: `${ym[1]}-${ym[2]}` } };
  }
  return { kind: 'point', meaning: 'data-period', label, at: { precision: 'supplied', text, explanation: SUPPLIED_TIME_EXPLANATION } };
}

/**
 * The model for one EIA power plant (interface-chrome-popups-text.md 3.5
 * row 17): the plant's name; "Issued by: U.S. EIA · Forms 860/860M" (the
 * design record's issuer with the legacy agency line's forms); the
 * nameplate capacity with its unit as the value; the issuer's reporting
 * period beside it, because a megawatt number without a vintage invites a
 * reader to treat an inventory figure as today's output; fuel and utility
 * as rows; the inventory note; the EIA Form 860 page.
 */
export function buildPowerPlantPopupModel(props: GeoJsonProperties): IssuedModel {
  const p = props ?? {};
  const megawatts = finiteNumber(p['Total_MW']);
  return {
    kind: 'infrastructure',
    title: issuerText(p['Plant_Name']) ?? 'Power plant',
    issuer: { role: 'issued-by', name: 'U.S. EIA · Forms 860/860M', productKey: 'power-infrastructure' },
    value: [
      {
        text: `Nameplate capacity: ${
          megawatts === null ? NOT_PUBLISHED : `${megawatts.toLocaleString('en-US', { maximumFractionDigits: 1 })} MW`
        }`
      }
    ],
    clocks: [periodClock(p['Period'])],
    details: [...row('Primary energy source', issuerText(p['PrimSource'])), ...row('Utility', issuerText(p['Utility_Na']))],
    source: { link: { label: 'EIA Form 860 documentation', href: 'https://www.eia.gov/electricity/data/eia860/' } },
    qualifications: [PLANT_NOTE]
  };
}

/**
 * The model for one archived HIFLD transmission line (row 18): "Transmission
 * line"; "Issued by: HIFLD (U.S. Government)"; the issuer's voltage class as
 * the value; the archive's last data update as the clock; the published
 * voltage, owner, operational status and type as rows; the currency caveat,
 * which is not optional chrome here (this record set stopped being
 * maintained, so a line under the cursor may no longer exist, may have been
 * rebuilt, or may never have been energized); and the stated source, since
 * the archive has no public page.
 */
export function buildPowerLinePopupModel(props: GeoJsonProperties): IssuedModel {
  const p = props ?? {};
  const voltage = finiteNumber(p['VOLTAGE']);
  // The issuer writes -999999 for an unknown voltage; printing it would be
  // a fabricated reading.
  const voltageText = voltage !== null && voltage > 0 ? `${voltage.toLocaleString('en-US', { maximumFractionDigits: 0 })} kV` : null;
  return {
    kind: 'infrastructure',
    title: 'Transmission line',
    issuer: { role: 'issued-by', name: 'HIFLD (U.S. Government)', productKey: 'power-infrastructure' },
    value: [{ text: `Voltage class: ${readHifldValue(p['VOLT_CLASS']) || NOT_PUBLISHED}` }],
    clocks: [{ kind: 'point', meaning: 'edition', label: 'Last data update', at: { precision: 'date', date: '2024-09-30' } }],
    details: [
      ...row('Voltage', voltageText),
      { kind: 'row', label: 'Owner', text: readHifldValue(p['OWNER']) || NOT_PUBLISHED },
      { kind: 'row', label: 'Operational status', text: readHifldValue(p['STATUS']) || NOT_PUBLISHED },
      ...row('Type', readHifldValue(p['TYPE']) || null)
    ],
    source: { none: LINE_SOURCE },
    qualifications: [LINE_NOTE]
  };
}

// ---------------------------------------------------------------------------
// The legacy markup, kept only for tests/power-layer.spec.ts
// ---------------------------------------------------------------------------

/*
 * The two HTML builders below are the pre-frame popups, unchanged. No src
 * module imports them (src/layers/power-3d.ts paints the models above
 * through the frame, and the build drops these as unused); they stay only
 * because tests/power-layer.spec.ts, outside D1 M26b's files, still pins its
 * plant and line wording through them. The same honesty rules are pinned on
 * the models in tests/identify-paths.spec.ts ("the NWS, SPC and power models
 * print the issuer words"). Retire both when that spec moves to the models.
 */

/** The pre-frame plant popup (see above). */
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
    <div class="popup-description">${PLANT_NOTE}</div>
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

/** The pre-frame line popup (see above). */
export function buildPowerLinePopupHtml(props: GeoJsonProperties): string {
  const p = props ?? {};
  const voltClass = readHifldValue(p['VOLT_CLASS']);
  const owner = readHifldValue(p['OWNER']);
  const status = readHifldValue(p['STATUS']);
  const type = readHifldValue(p['TYPE']);
  const voltage = Number(p['VOLTAGE']);
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
    <div class="popup-description">${LINE_NOTE}</div>
  `;
}

/** HIFLD writes 'NOT AVAILABLE' where a value is unknown; keep it an unknown. */
function readHifldValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (value === '' || value.toUpperCase() === 'NOT AVAILABLE') return '';
  return value;
}
