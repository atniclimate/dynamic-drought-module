/**
 * The identify-path manifest (S30D D1 M23; DDM-P11-T04; the Codex Tier 2
 * review PF5 and PF6; the N2 brief corrections C3 to C5).
 *
 * BUILDERS is the full source inventory, independent of the runtime
 * registry: the twenty popup builders of interface-chrome-popups-text.md
 * 3.5, one line each, with the layer key that activates each and the EXACT
 * click targets its module registers, written as the coordinator stamps
 * them on `#map-container[data-ddm-click-targets]` (`kind:layerId,layerId`).
 * The census compares the stamp with these lines in both directions.
 *
 * LEGACY_ALLOWANCE is the ONE finite allowance for unframed responses,
 * read by the census, the observer and both sinks alike (PF6): full at
 * M23, each of M24, M25 and M26 deleted the lines of the builders it
 * migrated, and it is empty since M26c (the telemetry station popup, the
 * last line). Every builder must render through the frame
 * (src/ui/popup-frame.ts). The held BC builder never had a line: it is
 * never browser-eligible while DR-160 holds.
 */

export interface BuilderEntry {
  /** Stable builder id (the design record's 3.5 row). */
  readonly id: string;
  /** The LAYER_DEFS key whose first activation registers these targets. */
  readonly layerKey: string;
  /** The exact stamp entries this builder's module registers; none for an external popup. */
  readonly targets: readonly string[];
  /** 'external': adopted through adoptExternalResponse, never a registered target. */
  readonly path: 'coordinated' | 'external';
  /** Set when the builder is not browser-eligible, with the reason. */
  readonly held?: string;
}

export const BUILDERS: readonly BuilderEntry[] = [
  { id: 'state', layerKey: 'states', path: 'coordinated', targets: ['state-boundary:us-states-fill'] },
  { id: 'tribal', layerKey: 'tribal', path: 'coordinated', targets: ['tribal-lands:tribal-lands-fill'] },
  { id: 'bia', layerKey: 'bia-reservations', path: 'coordinated', targets: ['reservation-boundary:bia-reservations-fill'] },
  { id: 'aiannh', layerKey: 'aiannh', path: 'coordinated', targets: ['tribal-lands:aiannh-fill'] },
  { id: 'treaty', layerKey: 'treaty', path: 'coordinated', targets: ['treaty-cession:treaty-areas-outline'] },
  { id: 'ecoregion', layerKey: 'ecoregions', path: 'coordinated', targets: ['ecoregion-watershed:ecoregions-l3-fill,ecoregions-l4-fill'] },
  { id: 'nifc', layerKey: 'nifc-fires', path: 'coordinated', targets: ['point-event:nifc-fires-fill,nifc-prescribed-fill,nifc-other-outline'] },
  { id: 'nws', layerKey: 'nws-alerts', path: 'coordinated', targets: ['point-event:nws-alerts-fill'] },
  { id: 'spc', layerKey: 'spc-fire-weather', path: 'coordinated', targets: ['condition-surface:spc-fire-weather-fill'] },
  { id: 'hms', layerKey: 'hms-smoke', path: 'coordinated', targets: ['condition-surface:hms-smoke-fill'] },
  { id: 'usdm', layerKey: 'usdm', path: 'coordinated', targets: ['condition-surface:usdm-frame-a-fill,usdm-frame-b-fill'] },
  { id: 'usdm-change', layerKey: 'usdm', path: 'coordinated', targets: ['condition-surface:usdm-change-fill'] },
  { id: 'nadm', layerKey: 'nadm-drought', path: 'coordinated', targets: ['condition-surface:nadm-drought-fill'] },
  { id: 'cdm', layerKey: 'cdm-drought', path: 'coordinated', targets: ['condition-surface:cdm-drought-fill'] },
  { id: 'bc-drought', layerKey: 'usdm', path: 'coordinated', targets: ['condition-surface:bc-drought-fill'], held: 'DR-160: BC_BASIN_EDITION_HELD (src/config/layers.ts) forbids selecting, presenting or fetching the Province edition' },
  { id: 'cpc', layerKey: 'drought', path: 'coordinated', targets: ['condition-surface:drought-outlook-fill'] },
  { id: 'power-plant', layerKey: 'power-infrastructure', path: 'coordinated', targets: ['point-event:power-plants'] },
  { id: 'power-line', layerKey: 'power-infrastructure', path: 'coordinated', targets: ['point-event:power-lines,power-lines-unknown'] },
  { id: 'places', layerKey: 'places', path: 'coordinated', targets: ['point-event:us-places-labels'] },
  { id: 'telemetry', layerKey: 'telemetry', path: 'external', targets: [] }
];

export const LEGACY_ALLOWANCE: readonly string[] = [];

/** The browser-eligible builders: every builder but a held one. */
export function eligibleBuilders(): readonly BuilderEntry[] {
  return BUILDERS.filter((builder) => builder.held === undefined);
}

/** The eligible builders that must already render through the frame. */
export function migratedBuilders(): readonly BuilderEntry[] {
  return eligibleBuilders().filter((builder) => !LEGACY_ALLOWANCE.includes(builder.id));
}

/** The layer ids of the allowance's coordinated builders (the observer's legacy pass list). */
export function legacyLayerIds(): string[] {
  return BUILDERS.filter((builder) => LEGACY_ALLOWANCE.includes(builder.id)).flatMap((builder) =>
    builder.targets.flatMap((target) => target.slice(target.indexOf(':') + 1).split(','))
  );
}

// ---------------------------------------------------------------------------
// The static inventory (PF5; M23 repair round 1, Codex ultra finding 2):
// the counted popup boundaries and the scanner tests/identify-paths.spec.ts
// runs over src/. Kept here, beside the allowance, as plain string work
// with no import, so the scanner is exercised by the spec's self-check and
// loads anywhere. Not a parser and not a whole-program proof (PF5); the bar
// is that every named escape is caught.
// ---------------------------------------------------------------------------

export interface SiteCounts {
  /** `new` through a maplibre-gl Popup binding (any alias or namespace). */
  readonly constructions: number;
  /** Identifier mentions of each content setter, whatever the call shape. */
  readonly setHTML: number;
  readonly setDOMContent: number;
  readonly setText: number;
}

export interface SiteScan extends SiteCounts {
  readonly problems: readonly string[];
}

export const NO_POPUP_SITES: SiteCounts = { constructions: 0, setHTML: 0, setDOMContent: 0, setText: 0 };

/**
 * The only files allowed a Popup construction or a content-setter mention,
 * each COUNTED; every other src file allows none. Since M26c the setter
 * mentions in src are exactly two: the coordinator sets its own popup's
 * content; its lazy frame helper sets the adopted station popup's first
 * framed paint (a repaint replaces the frame root in place). telemetry.ts
 * sets no content at all: it constructs the marker's popup and hands the
 * coordinator a model.
 */
export const POPUP_BOUNDARIES: Readonly<Record<string, SiteCounts>> = {
  'src/map/interaction-coordinator.ts': { constructions: 1, setHTML: 0, setDOMContent: 1, setText: 0 },
  'src/ui/popup-frame.ts': { constructions: 0, setHTML: 0, setDOMContent: 1, setText: 0 },
  // The adopted station popup, the one producer outside the registration
  // path: its construction only (the marker binds it).
  'src/layers/telemetry.ts': { constructions: 1, setHTML: 0, setDOMContent: 0, setText: 0 }
};

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The innermost bracket still open at `index` (`(`, `[` or `{`), or null at top level. */
function openBracket(code: string, index: number): { readonly char: string; readonly at: number } | null {
  const closes: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i]!;
    if (c in closes) stack.push(closes[c]!);
    else if (c === '(' || c === '[' || c === '{') {
      if (stack.length === 0) return { char: c, at: i };
      stack.pop();
    }
  }
  return null;
}

/** A ternary `?` (not `?.`, `??` or an optional-parameter `?:`). */
const BARE_QUESTION = /(?<!\?)\?(?![.?:])/;

/**
 * Whether a Popup mention at `index` is in a TYPE position. The set is
 * narrow and stated; every other mention is a value mention:
 *   1. inside `<...>` generic arguments that open directly after an
 *      identifier (`Map<string, maplibregl.Popup>`), with no `||`, `&&`
 *      or closing `>` between;
 *   2. after a `:` that follows an identifier or `)` in a declaration or
 *      parameter: the identifier follows `let`, `const` or `var`, or the
 *      innermost open bracket is a `(` with no ternary `?` since it
 *      (a parameter list), or the `)` closes a return-type position with
 *      no ternary `?` in its statement.
 * An `import type` clause is never read as a binding at all. So
 * `{ ctor: P }`, `f(a, P)`, `x || P` and `c ? a : P` are value mentions.
 */
export function isTypePosition(code: string, index: number): boolean {
  const before = code.slice(Math.max(0, index - 400), index);
  const lt = before.lastIndexOf('<');
  if (lt > 0 && /[\w$]/.test(before[lt - 1]!)) {
    const inside = before.slice(lt + 1);
    if (/^[\w$.,\s|&[\]]*$/.test(inside) && !/\|\||&&/.test(inside)) return true;
  }
  const annotation = /([\w$]+|\))\s*\??\s*:\s*$/.exec(before);
  if (!annotation) return false;
  const start = index - before.length + annotation.index;
  if (annotation[1] !== ')') {
    if (/\b(?:let|const|var)\s+$/.test(code.slice(Math.max(0, start - 12), start))) return true;
    const open = openBracket(code, start);
    return open !== null && open.char === '(' && !BARE_QUESTION.test(code.slice(open.at + 1, index));
  }
  const statement = code.slice(0, start);
  const boundary = Math.max(statement.lastIndexOf(';'), statement.lastIndexOf('{'), statement.lastIndexOf('}'));
  return !BARE_QUESTION.test(code.slice(boundary + 1, index));
}

/**
 * The import-aware inventory of one module: every `maplibre-gl` binding
 * (namespace, default, named `Popup` under any alias); EVERY mention of a
 * Popup binding outside the narrow type set above is a value mention,
 * counted as a construction when `new` precedes it and a problem otherwise
 * (an alias, factory, argument, subclass or operand); a bare namespace
 * passed around as a value; and the identifier mentions of the three
 * content setters, whatever their call shape (`(p.setHTML)(x)`,
 * `p.setHTML?.(x)`, `p.setHTML.call(p, x)`, `const { setHTML } = p`).
 */
export function scanPopupSites(file: string, source: string): SiteScan {
  const code = stripComments(source);
  const problems: string[] = [];
  const namespaces = new Set<string>();
  const direct = new Set<string>();
  const importSpans: [number, number][] = [];
  for (const m of code.matchAll(/\bimport\s+(type\s+)?([^;]*?)\s*from\s*['"]maplibre-gl['"]/g)) {
    importSpans.push([m.index, m.index + m[0].length]);
    if (m[1]) continue;
    const clause = (m[2] ?? '').trim();
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns?.[1]) namespaces.add(ns[1]);
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def?.[1]) namespaces.add(def[1]);
    const named = /\{([^}]*)\}/.exec(clause);
    for (const part of (named?.[1] ?? '').split(',')) {
      const item = part.trim();
      if (item === '' || item.startsWith('type ')) continue;
      const [original, alias] = item.split(/\s+as\s+/);
      if (original?.trim() === 'Popup') direct.add((alias ?? original).trim());
    }
  }
  const inImport = (index: number): boolean => importSpans.some(([a, b]) => index >= a && index < b);
  if (/\b(?:import|require)\s*\(\s*['"]maplibre-gl['"]\s*\)/.test(code)) {
    problems.push(`${file}: a dynamic maplibre-gl import`);
  }
  // A value re-export (`export *`, `export * as <any name>`, `export { ... }`)
  // hands the library to another module under a name this scan cannot
  // follow (the Codex r2 and r3 re-checks, finding 2); src has none. The
  // clause grammar does not matter: every `from 'maplibre-gl'` belongs to
  // the nearest `import` or `export` keyword before it, and one that belongs
  // to an `export` other than `export type` is a problem. Keywords are read
  // with every quoted string blanked (found-106): a quoted export name that
  // spells a keyword (`export * as "import"`, `export { Popup as "import" }`)
  // is a string, never the statement's keyword.
  const unquoted = code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (s) => ' '.repeat(s.length));
  for (const m of code.matchAll(/\bfrom\s*['"]maplibre-gl['"]/g)) {
    const keywords = [...unquoted.slice(0, m.index).matchAll(/\b(?:import|export)\b/g)];
    const statement = keywords[keywords.length - 1];
    if (statement?.[0] === 'export' && !/^export\s+type\b/.test(code.slice(statement.index))) {
      problems.push(`${file}: a maplibre-gl value re-export (a barrel)`);
    }
  }
  let constructions = 0;
  const classify = (index: number, what: string): void => {
    if (/\bnew\s*$/.test(code.slice(Math.max(0, index - 12), index))) constructions += 1;
    else if (!isTypePosition(code, index)) problems.push(`${file}: ${what} used as a value (an alias, factory, argument or subclass)`);
  };
  // A bare namespace (not followed by `.`) takes the same narrow type set as
  // a Popup mention, so `{ lib: maplibregl }` and `f(a, maplibregl)` are
  // values (the Codex r1 re-check, finding 2). src has no bare mention of a
  // value-imported maplibre-gl namespace at all (M23 r1, counted).
  for (const ns of namespaces) {
    for (const m of code.matchAll(new RegExp(`\\b${escapeRegExp(ns)}\\s*\\.\\s*Popup\\b`, 'g'))) {
      classify(m.index, `${ns}.Popup`);
    }
    for (const m of code.matchAll(new RegExp(`(?<![.\\w$])${escapeRegExp(ns)}\\b(?!\\s*\\.)`, 'g'))) {
      if (inImport(m.index)) continue;
      if (!isTypePosition(code, m.index)) {
        problems.push(`${file}: the maplibre-gl namespace ${ns} used as a bare value`);
      }
    }
  }
  for (const name of direct) {
    for (const m of code.matchAll(new RegExp(`(?<![.\\w$])${escapeRegExp(name)}\\b`, 'g'))) {
      if (!inImport(m.index)) classify(m.index, name);
    }
  }
  if (/\[\s*['"`](?:setHTML|setDOMContent|setText)['"`]\s*\]/.test(code)) {
    problems.push(`${file}: a popup content setter reached by computed access`);
  }
  const count = (pattern: RegExp): number => [...code.matchAll(pattern)].length;
  return {
    constructions,
    setHTML: count(/\bsetHTML\b/g),
    setDOMContent: count(/\bsetDOMContent\b/g),
    setText: count(/\bsetText\b/g),
    problems
  };
}

/** A scan's findings against its file's pinned allowance (NO_POPUP_SITES outside the boundaries). */
export function popupSiteFindings(file: string, scan: SiteScan, allowed: SiteCounts = POPUP_BOUNDARIES[file] ?? NO_POPUP_SITES): string[] {
  const findings = [...scan.problems];
  for (const key of ['constructions', 'setHTML', 'setDOMContent', 'setText'] as const) {
    if (scan[key] !== allowed[key]) findings.push(`${file}: ${scan[key]} ${key}, allowed ${allowed[key]}`);
  }
  return findings;
}
