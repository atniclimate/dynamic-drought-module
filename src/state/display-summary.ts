/**
 * The honest prose display-summary derivation (S3; D-0.7.0-041 part 2;
 * the S1 contract in src/types/display-summary.ts; the S3 handoff
 * section 4).
 *
 * PURE: no DOM, no layer-module imports, no controller calls, no
 * registry writes. Inputs only. The summary is STATUS-DERIVED, never
 * checkbox-derived: it considers only the committed `intendedKeys` and,
 * for each, the registry's canonical status as captured in the input
 * snapshot. An intended key with NO recorded status has not rendered
 * anything yet and reads as pending (folded into the loading caveat),
 * never as displayed.
 *
 * Grammar (one "Showing ..." sentence plus at most one caveat string):
 *
 *   ready     included in the Showing sentence (LAYER_DEFS names).
 *   degraded  included nowhere in Showing; named in the caveat as
 *             "live with partial coverage".
 *   loading   excluded; "Loading X" in the caveat.
 *   error     excluded; "X is unavailable".
 *   no-data   excluded; the caveat REUSES the canonical pill wording
 *             (resolveStatusPillText + the layer's noDataLabel) so the
 *             live-zero-feature and deployer-placeholder readings stay
 *             distinct; no invented synonyms.
 *   zoom-in   excluded; "X appears after you zoom in".
 *
 * COVERAGE HONESTY moved OFF this module 2026-09-10 (a DDM fix lane;
 * owner: the minimap's popped-up coverage caption was noise, and the
 * SAME sentence was rendering a second time in this module's own
 * caveat, so it now has exactly one home). The rule it used to apply
 * here still governs, just at the new site (`src/ui/map-key.ts`): when
 * the active framing carries a coverageNote and the display includes
 * ANY US-scoped display layer (a condition surface, an event layer, or
 * the stations; every non-reference role), a viewer must be told the
 * display does not cover the framing (the Mexico framing over the US
 * Drought Monitor, or over the events-only Wildfire display, must say
 * the display does not cover Mexico). A globally-scoped layer (the
 * Ocean Temperature Anomaly) does not trigger the caution. This module
 * still exports `isUsScopeCautionLayer` and `userFacingCoverageClause`
 * so the key applies the identical rule and the identical user-facing
 * text; see their doc comments below.
 *
 * The empty recipe (Extreme Heat at season-ahead) yields an honest
 * "no verified surface" primary, never a silently substituted surface.
 * Labels stay honest everywhere: layers are named by their LAYER_DEFS
 * names (US Drought Monitor, Ocean Temperature Anomaly); nothing here
 * may imply a refined multi-source drought surface or a marine-heatwave
 * product exists.
 */

import { CLUSTER_DISPLAY_NAMES } from '../config/clusters';
import { LAYER_DEFS } from '../config/layers';
import type { LayerDef } from '../config/layers';
import { resolveStatusPillText } from '../ui/island/pill-text';
import type { LayerRole, LayerStatus } from '../types/layer';
import type { DeriveDisplaySummary } from '../types/display-summary';

/** Sentence order: the condition surface leads, then events, stations,
 * and the reference boundaries a person orients by. */
const SENTENCE_ROLE_ORDER: readonly LayerRole[] = [
  'surface',
  'event',
  'stations',
  'reference'
];

/**
 * Display layers for which the framing's generic US-scope caution does not
 * apply. The ocean anomaly is global; NADM is the tri-national continental
 * product. Every other exception needs an explicit coverage contract.
 */
const US_SCOPE_CAUTION_EXEMPT_KEYS: ReadonlySet<string> = new Set([
  'sst-anomaly',
  'nadm-drought'
]);

/**
 * Whether a layer counts toward a framing's US-scope coverage caution: any
 * non-reference role the exemption list above does not name. Exported so
 * the on-map key (`src/ui/map-key.ts`), the sole renderer of the caution
 * since 2026-09-10, applies the SAME rule against the registry's currently
 * active keys that this module used to apply against the committed
 * `intendedKeys`, so the two call sites can never rule differently on the
 * same layer.
 */
export function isUsScopeCautionLayer(def: Pick<LayerDef, 'key' | 'role'>): boolean {
  return def.role !== 'reference' && !US_SCOPE_CAUTION_EXEMPT_KEYS.has(def.key);
}

/**
 * Prose names for layers whose compact catalog labels lead with a bare
 * acronym (the acronym convention: spell out on first use, then
 * abbreviate; DG-080 review finding 7, r2 finding 5). The summary
 * sentence can be the first visible use of CPC, NIFC, or HMS, so the
 * prose expands them fully (including the parent agency: a bare "NOAA"
 * here would itself be an unexpanded first use); the ruled compact
 * visual labels in the catalog stay unchanged.
 */
const PROSE_LAYER_NAMES: Readonly<Record<string, string>> = {
  drought:
    'Drought Outlook (National Oceanic and Atmospheric Administration Climate Prediction Center, CPC)',
  'nifc-fires':
    'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)',
  'hms-smoke': 'Smoke Plumes (Hazard Mapping System, HMS)'
};

/** The name a layer carries in summary prose. */
function proseName(def: LayerDef): string {
  return PROSE_LAYER_NAMES[def.key] ?? def.name;
}

/** Natural-language list: "A", "A and B", "A, B, and C". */
function listNames(defs: readonly LayerDef[]): string {
  const names = defs.map(proseName);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** The Showing sentence body: "A", "A with B", "A with B, C, and D". */
function showingNames(defs: readonly LayerDef[]): string {
  const names = defs.map(proseName);
  if (names.length === 1) return names[0] as string;
  const rest = names.slice(1);
  if (rest.length === 1) return `${names[0]} with ${rest[0]}`;
  return `${names[0]} with ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
}

/*
 * `userFacingCoverageClause` and its AUTHORING_CLAUSE_RE lived here until
 * 2026-09-10. They split a framing's single `coverageNote` string on
 * semicolons and dropped the clauses that matched an authoring-guidance
 * pattern, which was the best available answer while the note WAS one
 * string. Codex adversarial review finding 5 showed why that shape could not
 * be made honest: the clauses inside a note describe the display, the
 * minimap, and place selection, and those are true under different
 * conditions, so no filter over one joined string can render the right
 * subset. `FramingDef.coverage` now carries them as separate fields and
 * `frameCoverageNote` in src/ui/map-key.ts gates each one; a regex that
 * guessed at sentence boundaries has nothing left to do.
 */

/** Strip a trailing period so clauses join cleanly with semicolons. */
function unterminated(clause: string): string {
  return clause.replace(/\.\s*$/, '');
}

export const deriveDisplaySummary: DeriveDisplaySummary = (input) => {
  // Deterministic ordering: LAYER_DEFS order within the role buckets.
  // Unknown intended keys (a stale deep link) carry no definition and are
  // ignored here exactly as the registry rejects them downstream.
  const intended = LAYER_DEFS.filter((def) => input.intendedKeys.has(def.key));

  // An intended key with no recorded status has rendered nothing yet:
  // it reads as pending (loading), never as displayed.
  const statusOf = (def: LayerDef): LayerStatus =>
    input.statuses.get(def.key) ?? 'loading';

  const withStatus = (wanted: LayerStatus): LayerDef[] =>
    intended.filter((def) => statusOf(def) === wanted);

  const ready: LayerDef[] = [];
  for (const role of SENTENCE_ROLE_ORDER) {
    for (const def of intended) {
      if (def.role === role && statusOf(def) === 'ready') ready.push(def);
    }
  }

  // The primary sentence.
  const hazardIntended = intended.filter((def) => def.role !== 'reference');
  let primary: string;
  if (input.cluster !== 'custom' && hazardIntended.length === 0) {
    // The empty recipe (deliberate honesty, src/config/clusters.ts): no
    // verified surface exists for the committed cluster at this horizon,
    // so the display is the reference set and says so; nothing is faked.
    const clusterName = CLUSTER_DISPLAY_NAMES[input.cluster];
    // "Reference layers", not "reference boundaries": the surviving
    // reference set includes Terrain Shading, which is not a boundary
    // (DG-080 review finding 6).
    primary = `No verified ${clusterName} surface is available at this horizon; showing reference layers only.`;
  } else if (ready.length === 0) {
    primary = 'No layers are displayed yet.';
  } else {
    primary = `Showing ${showingNames(ready)}.`;
  }

  // The caveat: at most ONE string; clauses joined with semicolons,
  // never a second status dashboard. Coverage honesty no longer leads
  // here: it rendered a second time (this caveat and the minimap's own
  // caption said the same sentence at once), so it was relocated to the
  // on-map key (src/ui/map-key.ts), the ONE site now, per the framings.ts
  // and S4 handoff contract. `isUsScopeCautionLayer` above is exported
  // so the key applies the identical exemption rule against its own
  // active-layer set.
  const clauses: string[] = [];

  const degraded = withStatus('degraded');
  if (degraded.length > 0) {
    clauses.push(
      `${listNames(degraded)} ${degraded.length > 1 ? 'are' : 'is'} live with partial coverage`
    );
  }

  const loading = withStatus('loading');
  if (loading.length > 0) {
    clauses.push(`Loading ${listNames(loading)}`);
  }

  const unavailable = withStatus('error');
  if (unavailable.length > 0) {
    clauses.push(
      `${listNames(unavailable)} ${unavailable.length > 1 ? 'are' : 'is'} unavailable`
    );
  }

  // no-data reuses the canonical pill wording per layer (the wording
  // differs by design between live zero-feature layers and the bundled
  // deployer placeholders), so each layer gets its own clause.
  for (const def of withStatus('no-data')) {
    clauses.push(
      unterminated(`${proseName(def)}: ${resolveStatusPillText('no-data', def.noDataLabel)}`)
    );
  }

  const zoomGated = withStatus('zoom-in');
  if (zoomGated.length > 0) {
    clauses.push(
      `${listNames(zoomGated)} ${zoomGated.length > 1 ? 'appear' : 'appears'} after you zoom in`
    );
  }

  const caveat = clauses.length > 0 ? `${clauses.join('; ')}.` : null;

  return { primary, caveat };
};
