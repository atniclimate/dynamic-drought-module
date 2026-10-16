/**
 * The tropical cyclones popups (ENSO block B3): a forecast point, and a cone
 * or watch-warning line, as frame models (src/ui/popup-frame.ts). Every label
 * is the service's own field alias or renderer label; every value is the
 * issuer's, shown as given. Issue and valid times are the issuer's zone-stamped
 * text, shown verbatim and never parsed (admission line 7).
 */

import type { GeoJsonProperties } from 'geojson';

import type { IssuedModel, PopupClock, PopupDetail, ValueRow } from './popup-frame';
import {
  TROPICAL_CLASSIFICATIONS,
  TROPICAL_ISSUERS,
  TROPICAL_MISSING,
  TROPICAL_PART_NAMES,
  TROPICAL_STORM_TYPES,
  TROPICAL_WW_CLASSES,
  tropicalBasinName,
  tropicalCentre
} from '../config/tropical-presentation';
import { standingBriefingDoor } from '../state/place-selection';

const PRODUCT_KEY = 'tropical-cyclones';
// The frame requires a per-time explanation; the full note reads in the Impact Briefing (src/ui/map-technical-information.ts).
const SUPPLIED = '(as stated)';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v !== TROPICAL_MISSING ? v : null);

function basinText(value: unknown): string {
  const name = tropicalBasinName(value);
  if (name) return name;
  return `${str(value) ?? 'none given'} (basin code not recognised)`;
}

function issuedClock(p: Record<string, unknown>): PopupClock {
  const issued = str(p['advdate']);
  return issued
    ? { kind: 'point', meaning: 'issued', label: 'Advisory issued', at: { precision: 'supplied', text: issued, explanation: SUPPLIED } }
    : { kind: 'not-stated', label: 'Advisory issued', reason: 'The advisory states no issue time.' };
}

function advisoryRow(p: Record<string, unknown>): ValueRow {
  return { label: 'Advisory Number', text: str(p['advisnum']) ?? 'not stated' };
}

function issuerFor(p: Record<string, unknown>) {
  return TROPICAL_ISSUERS[tropicalCentre(p['binnumber'])];
}

/** The points layer's `stormname` (classification and name), carried to every part by the read. */
function titleFor(p: Record<string, unknown>): string {
  return str(p['ddmTitle']) ?? str(p['stormname']) ?? 'Tropical cyclone';
}

/** The forecast point (tau 0 is the advisory's current position). */
export function buildTropicalPointPopupModel(props: GeoJsonProperties): IssuedModel {
  const p = props ?? {};
  const issuer = issuerFor(p);
  const tcdvlp = str(p['tcdvlp']);
  const stormtype = str(p['stormtype']);
  const classification =
    tcdvlp && TROPICAL_CLASSIFICATIONS.includes(tcdvlp)
      ? tcdvlp
      : `${tcdvlp ?? stormtype ?? 'none given'} (classification not recognised)`;
  const ssnum = num(p['ssnum']);
  const category = ssnum !== null && Number.isInteger(ssnum) && ssnum >= 1 && ssnum <= 5 ? `, Category ${ssnum}` : '';
  const tau = num(p['tau']);
  const valid = str(p['fldatelbl']);
  const clocks: [PopupClock, ...PopupClock[]] = [issuedClock(p)];
  if (valid) {
    clocks.push({
      kind: 'point',
      meaning: 'valid',
      // vocab-allow: the issuer's Forecast Points layer; tau beyond the advisory is its forecast hour
      label: tau === 0 ? 'Position at' : `Forecast position, ${tau ?? '?'} h, at`,
      at: { precision: 'supplied', text: valid, explanation: SUPPLIED }
    });
  }
  const details: PopupDetail[] = [];
  const row = (label: string, value: string | null): void => {
    if (value !== null) details.push({ kind: 'row', label, text: value });
  };
  row('Basin', basinText(p['basin']));
  if (stormtype && !TROPICAL_STORM_TYPES.includes(stormtype)) row('Storm Type', `${stormtype} (code not recognised)`);
  const maxwind = num(p['maxwind']);
  row('Maximum Wind', maxwind === null ? null : `${maxwind} knots`);
  const gust = num(p['gust']);
  row('Wind Gust', gust === null ? null : `${gust} knots`);
  const mslp = num(p['mslp']);
  row('Mean Sea Level Pressure', mslp === null ? null : `${mslp} mb`);
  const dir = num(p['tcdir']);
  row('Storm Direction', dir === null ? null : `${dir} degrees`);
  const spd = num(p['tcspd']);
  row('Storm Speed', spd === null ? null : `${spd} knots`);
  // vocab-allow: the issuer's own field alias for tau; tau 0 is the advisory position, not a forecast hour
  row('Forecast hour (tau)', tau === null || tau === 0 ? null : String(tau));
  return {
    kind: 'event',
    title: titleFor(p),
    issuer: { role: 'issued-by', name: issuer.name, productKey: PRODUCT_KEY },
    value: [{ text: `${classification}${category}` }, advisoryRow(p)],
    clocks,
    source: { link: issuer.link },
    details,
    // A storm is no place: its door opens the briefing for the selected place, else the region's, else Technical information.
    actions: standingBriefingDoor()
  };
}

/** A Forecast Cone polygon or a Watch-Warning line. */
export function buildTropicalAreaPopupModel(props: GeoJsonProperties): IssuedModel {
  const p = props ?? {};
  const issuer = issuerFor(p);
  const part = p['ddmPart'] === 'ww' ? 'ww' : 'cone';
  let value: ValueRow;
  if (part === 'ww') {
    const code = str(p['tcww']);
    const known = TROPICAL_WW_CLASSES.find((c) => c.code === code);
    value = known
      ? { label: 'Warning Type', text: known.label, swatch: { table: 'TROPICAL_WW_CLASSES', classKey: known.code, color: known.color } } // vocab-allow: the issuer's own field alias (tcww)
      : { label: 'Warning Type', text: `${code ?? 'none given'} (code not recognised)` }; // vocab-allow: the issuer's own field alias (tcww)
  } else {
    value = { text: TROPICAL_PART_NAMES.cone };
  }
  return {
    kind: 'event',
    title: titleFor(p),
    issuer: { role: 'issued-by', name: issuer.name, productKey: PRODUCT_KEY },
    value: [value, advisoryRow(p)],
    clocks: [issuedClock(p)],
    source: { link: issuer.link },
    details: [{ kind: 'row', label: 'Basin', text: basinText(p['basin']) }],
    actions: standingBriefingDoor()
  };
}
