import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { parseAst } from 'rolldown/parseAst';
import { gotoApp, waitForLayerSettled } from './helpers';
import {
  BUILDERS,
  LEGACY_ALLOWANCE,
  NO_POPUP_SITES,
  POPUP_BOUNDARIES,
  eligibleBuilders,
  legacyLayerIds,
  migratedBuilders,
  popupSiteFindings,
  scanPopupSites,
  stripComments
} from './identify-paths-manifest';
import { serializePopupFrame } from '../src/ui/popup-frame';
import type { PopupModel } from '../src/ui/popup-frame';
import { CENSUS_FIXTURES } from './frame-fixtures';
import { MAP_ROOT, PANEL_ROOT, PLACE_FRAME_FIXTURES, bootPlace, expectPlaceFields } from './frame-fixtures-places';

/**
 * S30D D1 M23: "every identify path" (DDM-P11-T04), as the Codex Tier 2
 * review's PF5 and PF6 and the N2 brief corrections C3, C4 and C7 shape it.
 *
 *   1. An import-aware inventory of Popup construction and content setters
 *      over src/, with COUNTED narrow boundaries (the coordinator's one
 *      construction and one setDOMContent; telemetry.ts's one construction
 *      and one setHTML until M26), a self-check that the scan bites, the
 *      declared no-popup modules, and the frame's one caller (S30D
 *      P1-FRAME: the coordinator's one dynamic import; no static value
 *      import of popup-frame anywhere in src/, type-only imports allowed; no
 *      import() with a computed specifier but the retry loader's own; and
 *      main.ts holds the frame in no form, a type query included).
 *   2. The census: `#map-container[data-ddm-click-targets]`, after boots
 *      that activate every browser-eligible builder, EQUALS the manifest's
 *      targets for the activated layers, both ways; every builder outside
 *      LEGACY_ALLOWANCE must yield a frame (none at M23, and the count is
 *      asserted, so the empty branch is declared, not accidental).
 *   3. An init-script MutationObserver over the map popups AND the panel
 *      foot host, failing any response that is neither framed nor an
 *      allowance member: a coordinated response by its stamp, the adopted
 *      external popup by the mark adoptExternalResponse writes (never by a
 *      missing stamp). Every later mutation inside a sink audits it again.
 *   4. Serialized frame payloads stay inert in a booted document, and the
 *      ONE structural frame validator (shared by the observer and every
 *      fixture assertion) accepts a real frame and rejects an empty marker.
 *
 * Offline: every external request is answered 503 by a context route
 * registered before gotoApp, so gotoApp's own context stubs (registered
 * later, checked first) keep their fixtures and no live service decides a
 * result. Registration happens on a layer's first activation, before its
 * fetch, so the census does not depend on any fetch succeeding.
 *
 * Honest limit at M23: no builder is framed yet, so the framed-content
 * coordinator paths (the region split, root ownership, the late door in the
 * actions slot, the host width cap) get their browser proof when M24 and
 * M25 migrate a builder and the migrated branch below starts running.
 */

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. The static inventory
// ---------------------------------------------------------------------------

/** Declared with no click popup (interface-chrome-popups-text.md 3.5), each with its reason. */
const NO_POPUP_MODULES: Readonly<Record<string, string>> = {
  'src/layers/sst-anomaly.ts': 'a no-op bindPopups',
  'src/layers/usfs-whp.ts': 'a no-op bindPopups',
  'src/layers/heatrisk.ts': 'the Key drawer carries it',
  'src/layers/heatrisk-coverage.ts': 'the Key drawer carries it',
  'src/layers/hydrography.ts': 'hover only',
  'src/ui/hover-inspector.ts': 'a hover readout, never a click response'
};

function sourceFiles(dir = join(ROOT, 'src'), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function repoPath(full: string): string {
  return relative(ROOT, full).split(sep).join('/');
}

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

test.describe('identify paths: the static inventory', () => {
  test('no Popup construction or content setter outside the counted coordinator and telemetry boundaries', () => {
    const files = sourceFiles().map(repoPath);
    expect(files.length, 'the scan reached src/').toBeGreaterThan(100);
    for (const boundary of Object.keys(POPUP_BOUNDARIES)) {
      expect(files, `the counted boundary ${boundary} exists`).toContain(boundary);
    }
    const findings: string[] = [];
    for (const file of files) {
      findings.push(...popupSiteFindings(file, scanPopupSites(file, readSource(file))));
    }
    expect(findings).toEqual([]);
  });

  test('the inventory scanner catches aliases, factories, subclasses and computed setters (self-check)', () => {
    const cases: ReadonlyArray<{ name: string; source: string; constructions: number; problem: boolean }> = [
      { name: 'aliased named import', source: "import { Popup as P } from 'maplibre-gl';\nexport const make = () => new P({});", constructions: 1, problem: false },
      { name: 'factory in another namespace', source: "import * as ml from 'maplibre-gl';\nexport function popup() { return new ml.Popup(); }", constructions: 1, problem: false },
      { name: 'multi-line named import', source: "import {\n  Popup,\n  Map\n} from 'maplibre-gl';\nexport const p = new Popup();", constructions: 1, problem: false },
      { name: 'default import', source: "import mgl from 'maplibre-gl';\nnew mgl.Popup();", constructions: 1, problem: false },
      { name: 'constructor alias', source: "import * as maplibregl from 'maplibre-gl';\nconst Ctor = maplibregl.Popup;\nnew Ctor();", constructions: 0, problem: true },
      { name: 'subclass', source: "import * as maplibregl from 'maplibre-gl';\nclass Mine extends maplibregl.Popup {}", constructions: 0, problem: true },
      { name: 'namespace alias', source: "import * as maplibregl from 'maplibre-gl';\nconst lib = maplibregl;", constructions: 0, problem: true },
      { name: 'dynamic import', source: "export const lib = () => import('maplibre-gl');", constructions: 0, problem: true },
      { name: 'computed setter', source: "declare const x: Record<string, (v: string) => void>;\nx['setHTML']('y');", constructions: 0, problem: true },
      { name: 'type-only use (clean)', source: "import type * as maplibregl from 'maplibre-gl';\nlet p: maplibregl.Popup | null = null;\nexport function f(q: maplibregl.Popup): maplibregl.Popup { return q; }", constructions: 0, problem: false },
      { name: 'typed value import (one construction)', source: "import * as maplibregl from 'maplibre-gl';\nlet p: maplibregl.Popup | null = null;\nconst o: maplibregl.PopupOptions = {};\nexport const q = new maplibregl.Popup(o);", constructions: 1, problem: false }
    ];
    for (const c of cases) {
      const scan = scanPopupSites(c.name, c.source);
      expect(scan.constructions, `${c.name}: constructions`).toBe(c.constructions);
      expect(scan.problems.length > 0, `${c.name}: flagged`).toBe(c.problem);
    }
    // A second construction in an allowed file breaks its count.
    const coordinator = readSource('src/map/interaction-coordinator.ts');
    const doubled = scanPopupSites('coordinator', `${coordinator}\nconst extra = new maplibregl.Popup({});\n`);
    expect(doubled.constructions).toBe(POPUP_BOUNDARIES['src/map/interaction-coordinator.ts']!.constructions + 1);
    // Setters count by call, whatever the receiver.
    expect(scanPopupSites('setters', 'a.setHTML(x); b . setDOMContent (y); c.setText(z);')).toMatchObject({
      setHTML: 1,
      setDOMContent: 1,
      setText: 1
    });
    // The escapes of the Codex ultra diff review (2026-09-30, finding 2):
    // each is flagged in a file outside the counted boundaries.
    const escapes: ReadonlyArray<{ name: string; source: string }> = [
      {
        name: 'factory object and a parenthesized setter (the review\'s example)',
        source:
          "import { Popup as P } from 'maplibre-gl';\nconst factory = { ctor: P };\nconst popup = new factory.ctor();\n(popup.setHTML)('<b>x</b>').addTo(map);"
      },
      { name: 'the alias passed as an argument', source: "import { Popup as P } from 'maplibre-gl';\nf(a, P);" },
      { name: 'the alias as an operand', source: "import { Popup as P } from 'maplibre-gl';\nconst C = x || P;" },
      { name: 'the namespace Popup in an object literal', source: "import * as ml from 'maplibre-gl';\nconst factory = { ctor: ml.Popup };" },
      { name: 'the alias through a ternary', source: "import { Popup as P } from 'maplibre-gl';\nconst C = flag ? Other : P;" },
      {
        name: 'the namespace in a factory object (the r1 re-check\'s example)',
        source: "import * as maplibregl from 'maplibre-gl';\nconst factory = { lib: maplibregl };\nexport const make = () => new factory.lib.Popup();"
      },
      { name: 'the namespace passed as a second argument', source: "import * as maplibregl from 'maplibre-gl';\nregister(a, maplibregl);" },
      { name: 'a namespace barrel (the r2 re-check\'s example)', source: "export * as ml from 'maplibre-gl';" },
      { name: 'a star barrel', source: "export * from 'maplibre-gl';" },
      { name: 'a namespace barrel with a Unicode alias (the r3 re-check)', source: "export * as mlπ from 'maplibre-gl';" },
      { name: 'a namespace barrel with a string alias (the r3 re-check)', source: "export * as \"ml\" from 'maplibre-gl';" },
      { name: 'a named Popup barrel', source: "export {\n  Popup as P\n} from 'maplibre-gl';" },
      // found-106: a quoted export name that spells a keyword is a string,
      // never the statement's keyword, so both barrels are still flagged.
      { name: 'a namespace barrel whose string alias spells import (found-106)', source: "export * as \"import\" from 'maplibre-gl';" },
      { name: 'a named Popup barrel whose string alias spells import (found-106)', source: "export { Popup as \"import\" } from 'maplibre-gl';" },
      { name: 'an optional-call setter', source: 'popup.setHTML?.(x);' },
      { name: 'a setter through call', source: 'popup.setHTML.call(popup, x);' },
      { name: 'a destructured setter', source: 'const { setHTML } = popup;\nsetHTML(x);' }
    ];
    for (const c of escapes) {
      expect(popupSiteFindings(c.name, scanPopupSites(c.name, c.source), NO_POPUP_SITES), `${c.name}: flagged`).not.toEqual([]);
    }
    // The narrow type set still reads the real tree's annotations as types.
    const typed = scanPopupSites(
      'typed',
      "import * as maplibregl from 'maplibre-gl';\nlet current: maplibregl.Popup | null = null;\nexport function adopt(popup: maplibregl.Popup): void {}\nasync function door(\n  map: maplibregl.Map,\n  popup: maplibregl.Popup,\n  head: HTMLElement\n): Promise<void> {}\nconst all = new Map<string, maplibregl.Popup>();\nexport type { PopupOptions } from 'maplibre-gl';"
    );
    expect(typed.problems).toEqual([]);
    expect(typed.constructions).toBe(0);
  });

  test('the declared no-popup modules register no click target and bind no click', () => {
    const findings: string[] = [];
    for (const [file, reason] of Object.entries(NO_POPUP_MODULES)) {
      const code = stripComments(readSource(file));
      if (/\bregisterClickTarget\s*\(/.test(code)) findings.push(`${file} (${reason}) registers a click target`);
      if (/\.on\(\s*['"]click['"]|addEventListener\(\s*['"]click['"]/.test(code)) {
        findings.push(`${file} (${reason}) binds a click`);
      }
    }
    expect(findings).toEqual([]);
  });

  test('the coordinator is the frame\'s one caller: one dynamic import there, and no value import of popup-frame anywhere in src/', () => {
    // S30D P1-FRAME (2026-10-04): builders hand the coordinator a model and
    // import only the frame's types; the coordinator loads the frame with one
    // dynamic import (it sits in the entry graph, so never a static one).
    const files = sourceFiles().map(repoPath).filter((file) => file !== 'src/ui/popup-frame.ts');
    const dynamicSites: string[] = [];
    const valueImports: string[] = [];
    const unresolvedSites: string[] = [];
    const retryLoaderSites: string[] = [];
    for (const file of files) {
      const found = popupFrameImports(readSource(file), file.endsWith('.tsx') ? 'tsx' : 'ts');
      for (let i = 0; i < found.dynamic; i++) dynamicSites.push(file);
      for (let i = 0; i < found.unresolved; i++) unresolvedSites.push(file);
      for (let i = 0; i < found.retryLoader; i++) retryLoaderSites.push(file);
      if (found.value > 0) valueImports.push(`${file} (${found.value})`);
    }
    expect(valueImports, 'a static value import of popup-frame (a type-only import is fine)').toEqual([]);
    // P1-FRAME repair round 2: an import() the scanner cannot read as static
    // text could load the frame unseen, so none is allowed in src/ but the
    // retry loader's own URL import, by its file and its shape (the default
    // `importUrl = (url) => import(url)` parameter); one of that shape in
    // another file fails here too.
    expect(unresolvedSites, 'a dynamic import whose specifier is not static text (it could load popup-frame unseen)').toEqual([]);
    expect(retryLoaderSites, 'the retry loader\'s one URL import, in src/util/chunk-retry.ts only').toEqual(['src/util/chunk-retry.ts']);
    expect(dynamicSites, 'exactly one dynamic import of popup-frame in src/, in the coordinator').toEqual(['src/map/interaction-coordinator.ts']);
    // "In no form", as at HEAD: a type query counts here too.
    expect(popupFrameImports(readSource('src/main.ts')), 'main.ts imports popup-frame in no form, a type query included').toEqual(counts());
  });

  test('the popup-frame import scanner tells value, type-only and dynamic imports, type queries and computed imports apart (self-check)', () => {
    const cases: ReadonlyArray<{ name: string; source: string; want: ReturnType<typeof popupFrameImports> }> = [
      { name: 'named value import', source: "import { serializePopupFrame } from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'mixed named import', source: "import {\n  serializePopupFrame,\n  type PopupModel\n} from './popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'namespace import', source: "import * as frame from '../ui/popup-frame.ts';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'default import', source: "import frame from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'side-effect import', source: "import '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'value re-export', source: "export { serializePopupFrame } from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'star re-export', source: "export * from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'type-only import', source: "import type { PopupModel } from '../ui/popup-frame';", want: counts({ value: 0, typeOnly: 1, dynamic: 0 }) },
      { name: 'type-only value name', source: "import type { PopupModel, serializePopupFrame } from '../ui/popup-frame';", want: counts({ value: 0, typeOnly: 1, dynamic: 0 }) },
      { name: 'all-type named import', source: "import { type PopupModel, type PopupClock } from '../ui/popup-frame';", want: counts({ value: 0, typeOnly: 1, dynamic: 0 }) },
      { name: 'type-only re-export', source: "export type { PopupModel } from '../ui/popup-frame';", want: counts({ value: 0, typeOnly: 1, dynamic: 0 }) },
      { name: 'dynamic import', source: "const load = () => import('../ui/popup-frame');", want: counts({ value: 0, typeOnly: 0, dynamic: 1 }) },
      { name: 'dynamic import, template literal', source: 'const load = () => import(`../ui/popup-frame`);', want: counts({ value: 0, typeOnly: 0, dynamic: 1 }) },
      { name: 'type query (no import, counted apart)', source: "let f: typeof import('../ui/popup-frame') | null = null;", want: counts({ value: 0, typeOnly: 0, dynamic: 0, typeQuery: 1 }) },
      { name: 'commented out', source: "// import { serializePopupFrame } from '../ui/popup-frame';\n/* import('../ui/popup-frame') */", want: counts({ value: 0, typeOnly: 0, dynamic: 0 }) },
      { name: 'another module', source: "import { serializePopupFrameish } from '../ui/popup-frame-helpers';", want: counts({ value: 0, typeOnly: 0, dynamic: 0 }) },
      // Negative controls of the P1-FRAME repair round (the Codex diff review,
      // finding 3): legal syntax with no whitespace is still a value import,
      // import-shaped text inside a string is no import, and an empty named
      // clause is no type-only import (the bundler keeps it).
      { name: 'compact value import (no whitespace)', source: "import{serializePopupFrame}from'../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'compact star re-export (no whitespace)', source: "export*from'../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'empty named import', source: "import {} from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'empty named re-export', source: "export {} from '../ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'import-equals require', source: "import frame = require('../ui/popup-frame');", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'non-relative specifier (the M23 rule matched any path ending popup-frame)', source: "import { serializePopupFrame } from 'src/ui/popup-frame';", want: counts({ value: 1, typeOnly: 0, dynamic: 0 }) },
      { name: 'dynamic import text in a string literal', source: "const note = \"import('../ui/popup-frame')\";", want: counts({ value: 0, typeOnly: 0, dynamic: 0 }) },
      { name: 'static import text in a template literal', source: "const note = `import { serializePopupFrame } from '../ui/popup-frame'`;", want: counts({ value: 0, typeOnly: 0, dynamic: 0 }) },
      // Negative controls of repair round 2 (the reviewer's confirmation, item
      // 3): an import() whose specifier is not static text could load the
      // frame, so it is counted (and fails the rule) wherever it is, except
      // the retry loader's own URL import, known by its shape; and a type
      // query is counted, so main.ts's "in no form" sees it.
      { name: 'computed specifier: a variable', source: "const p = '../ui/popup-frame'; import(p);", want: counts({ unresolved: 1 }) },
      { name: 'computed specifier: a concatenation', source: "import('../ui/' + 'popup-frame');", want: counts({ unresolved: 1 }) },
      { name: 'computed specifier: an interpolated template', source: "import(`../ui/${'popup-frame'}`);", want: counts({ unresolved: 1 }) },
      { name: 'computed specifier naming another module', source: 'const load = (key: string) => import(`../layers/${key}`);', want: counts({ unresolved: 1 }) },
      { name: 'type query with a qualifier', source: "type Model = import('../ui/popup-frame').PopupModel;", want: counts({ typeQuery: 1 }) },
      { name: 'the retry loader\'s URL import (its default importUrl parameter)', source: 'export function createChunkLoader<T>(importer: () => Promise<T>, base: string, importUrl: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url)) {}', want: counts({ retryLoader: 1 }) },
      { name: 'the retry loader\'s body outside its parameter', source: 'const importUrl = (url: string) => import(/* @vite-ignore */ url);', want: counts({ unresolved: 1 }) },
      { name: 'the retry loader\'s shape under another parameter name', source: 'export function load(fetchUrl = (url: string) => import(url)) {}', want: counts({ unresolved: 1 }) },
      { name: 'the retry loader\'s parameter importing another name', source: 'export function load(importUrl = (url: string, other: string) => import(other)) {}', want: counts({ unresolved: 1 }) }
    ];
    for (const c of cases) expect(popupFrameImports(c.source), c.name).toEqual(c.want);
    // A source the parser cannot read fails loudly, never counts as clean.
    expect(() => popupFrameImports("import { serializePopupFrame from '../ui/popup-frame';"), 'an unparseable source throws').toThrow();
  });
});

/**
 * The specifier names the popup frame: any path ending `popup-frame`, with or
 * without a script extension (the M23 rule matched any specifier ending
 * `popup-frame`; this keeps that reach and adds the extensions).
 */
const FRAME_SPECIFIER = /popup-frame(?:\.[cm]?[jt]sx?)?$/;

type AstNode = { readonly type: string; readonly [key: string]: unknown };

/** A module specifier's static text: a string literal, or a template with no substitution; null otherwise. */
function specifierText(node: unknown): string | null {
  const n = node as AstNode | null | undefined;
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && Array.isArray(n.expressions) && n.expressions.length === 0) {
    const quasis = n.quasis as ReadonlyArray<{ readonly value: { readonly cooked: string | null } }>;
    return quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** Visit every node of an ESTree tree. */
function walkAst(node: unknown, visit: (n: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const n = node as AstNode;
  if (typeof n.type === 'string') visit(n);
  for (const value of Object.values(n)) if (value !== null && typeof value === 'object') walkAst(value, visit);
}

/**
 * Count one source's imports of the popup frame by kind: a static VALUE import
 * (any import, re-export or `import x = require()` the bundler keeps, a bare
 * side-effect import and an empty `{}` clause included), a TYPE-ONLY one
 * (`import type`, `export type`, or a named clause whose every specifier is
 * `type`-marked, which the TypeScript transform elides), and a DYNAMIC
 * `import()` (a `typeof import()` type query is not one).
 *
 * P1-FRAME repair round 1 (the Codex diff review, finding 3): the source is
 * PARSED (the oxc parser Vite's bundler ships, rolldown/parseAst), not
 * matched by pattern, so legal syntax without whitespace is still an import,
 * import-shaped text inside a string, template or comment is none, and a
 * source the parser cannot read throws instead of counting as clean. A
 * dynamic import with a COMPUTED specifier is not resolvable here.
 *
 * Repair round 2 (the reviewer's confirmation, item 3): so it is COUNTED, as
 * `unresolved`, since it could load the frame unseen, and the rule fails on
 * it wherever it is. The one exception is counted apart, as `retryLoader`:
 * the retry loader's URL import, known by its shape, the default value of an
 * `importUrl` parameter written `(url) => import(url)` (src/util/chunk-retry.ts;
 * the rule also pins it to that file). A TYPE QUERY (`typeof import(...)`,
 * `import(...).Name`) naming the frame is counted apart as `typeQuery`: no
 * import, but main.ts may hold the frame in no form, as at HEAD.
 */
function popupFrameImports(source: string, lang: 'ts' | 'tsx' = 'ts'): FrameImportCounts {
  const found = counts();
  const frame = (node: unknown): boolean => FRAME_SPECIFIER.test(specifierText(node) ?? '');
  const retryLoaderImports = new Set<AstNode>();
  walkAst(parseAst(source, { lang }), (n) => {
    if (n.type === 'AssignmentPattern') {
      // Visited before its value, so the import inside is known by then.
      const left = n.left as AstNode;
      const right = n.right as AstNode;
      const params = right.params as ReadonlyArray<AstNode> | undefined;
      const body = right.body as AstNode | undefined;
      const imported = body?.source as AstNode | undefined;
      if (
        left.type === 'Identifier' &&
        left.name === 'importUrl' &&
        right.type === 'ArrowFunctionExpression' &&
        params?.length === 1 &&
        params[0]?.type === 'Identifier' &&
        body?.type === 'ImportExpression' &&
        imported?.type === 'Identifier' &&
        imported.name === params[0].name
      ) {
        retryLoaderImports.add(body);
      }
    } else if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') {
      if (!frame(n.source)) return;
      const kind = n.type === 'ImportDeclaration' ? n.importKind : n.exportKind;
      const specifiers = (n.specifiers ?? []) as ReadonlyArray<AstNode>;
      const elided = kind === 'type' || (specifiers.length > 0 && specifiers.every((s) => (s.importKind ?? s.exportKind) === 'type'));
      if (elided) found.typeOnly += 1;
      else found.value += 1;
    } else if (n.type === 'TSImportEqualsDeclaration') {
      const reference = n.moduleReference as AstNode;
      if (reference.type !== 'TSExternalModuleReference' || !frame(reference.expression)) return;
      if (n.importKind === 'type') found.typeOnly += 1;
      else found.value += 1;
    } else if (n.type === 'ImportExpression') {
      if (specifierText(n.source) === null) {
        if (retryLoaderImports.has(n)) found.retryLoader += 1;
        else found.unresolved += 1;
      } else if (frame(n.source)) {
        found.dynamic += 1;
      }
    } else if (n.type === 'TSImportType') {
      // oxc writes the specifier as `source`; older ESTree-TS shapes as `argument.literal`.
      const argument = n.argument as AstNode | undefined;
      if (frame(n.source ?? argument?.literal)) found.typeQuery += 1;
    }
  });
  return found;
}

interface FrameImportCounts {
  value: number;
  typeOnly: number;
  dynamic: number;
  typeQuery: number;
  unresolved: number;
  retryLoader: number;
}

/** A count with every kind at zero but the ones given. */
function counts(some: Partial<FrameImportCounts> = {}): FrameImportCounts {
  return { value: 0, typeOnly: 0, dynamic: 0, typeQuery: 0, unresolved: 0, retryLoader: 0, ...some };
}

// ---------------------------------------------------------------------------
// Browser checks
// ---------------------------------------------------------------------------

/**
 * Answer every external request 503 on the CONTEXT, registered before the
 * first gotoApp: gotoApp's own context stubs, registered later, are checked
 * first and keep their fixtures; page routes win over both.
 */
async function holdExternalNetwork(page: Page): Promise<void> {
  await page.context().route(
    (url) => url.protocol.startsWith('http') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
    (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic offline response' })
  );
}

interface PopupAudit {
  readonly seen: string[];
  readonly violations: string[];
}

interface AuditWindow {
  __ddmPopupAudit?: PopupAudit;
  __ddmFrameCheck?: (root: Element, sink: Element) => string | null;
}

/**
 * The init-script observer (page context; self-contained). It installs the
 * ONE structural frame validator on `window.__ddmFrameCheck` and audits
 * every map popup and every panel-foot response as it appears, one task
 * after insertion (so an adopted popup's mark, written in a microtask, is
 * in place).
 */
function installPopupAudit(allow: { legacyLayerIds: string[]; external: boolean }): void {
  const audit: PopupAudit = { seen: [], violations: [] };
  const w = window as unknown as AuditWindow;
  w.__ddmPopupAudit = audit;
  const slots = ['title', 'issuer', 'value', 'clock', 'source'];
  const frameCheck = (root: Element, sink: Element): string | null => {
    if (sink.querySelectorAll('[data-popup-frame]').length !== 1) return 'not exactly one frame root';
    if (!root.hasAttribute('data-popup-frame') || root.parentElement !== sink) {
      return 'the displayed response is not the frame root';
    }
    const head = root.children[0];
    const body = root.children[1];
    if (root.children.length !== 2 || !head || !body) return 'the frame root holds other than its two regions';
    // Text counts too (the Codex r2 re-check, finding 3): beside the two
    // regions the root holds only whitespace text.
    for (const node of Array.from(root.childNodes)) {
      if (node === head || node === body) continue;
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
      return 'the frame root holds other than its two regions';
    }
    const coordinated = root.classList.contains('coordinated-response');
    if (head.getAttribute('data-popup-region') !== 'head' || (coordinated && !head.classList.contains('coordinated-response-head'))) {
      return 'the displayed head is not the frame head region';
    }
    if (body.getAttribute('data-popup-region') !== 'body' || (coordinated && !body.classList.contains('coordinated-response-body'))) {
      return 'the displayed body is not the frame body region';
    }
    for (const node of Array.from(sink.childNodes)) {
      if (node === root) continue;
      if (node instanceof Element && node.classList.contains('maplibregl-popup-close-button')) continue;
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
      return 'displayed content sits outside the frame root';
    }
    for (const slot of slots) {
      const el = head.querySelector(`:scope > [data-popup-slot="${slot}"]`);
      if (slot === 'source' && !el) {
        // The head fits (S30D block 3): a feature with no source link has no
        // head source slot; its stated reason stands, linking nowhere, in the
        // body's source-fallback slot.
        const fallback = body.querySelector(':scope > [data-popup-slot="source-fallback"]');
        if (!fallback || (fallback.textContent ?? '').trim() === '' || fallback.querySelector('a[href]')) {
          return 'no head source and no stated no-source reason in the body';
        }
        continue;
      }
      if (!el || (el.textContent ?? '').trim() === '') return `the head slot ${slot} is missing or empty`;
    }
    return null;
  };
  w.__ddmFrameCheck = frameCheck;

  const auditSink = (sink: Element, where: string, external: boolean): void => {
    const shown = Array.from(sink.children).filter((c) => !c.classList.contains('maplibregl-popup-close-button'));
    const root = shown.length === 1 ? shown[0]! : null;
    if (external) {
      if (root?.hasAttribute('data-popup-frame')) {
        const verdict = frameCheck(root, sink);
        if (verdict) audit.violations.push(`${where} external: ${verdict}`);
      } else if (!allow.external) {
        audit.violations.push(`${where}: an unframed adopted external popup outside the legacy allowance`);
      }
      audit.seen.push(`${where}:external`);
      return;
    }
    const layerId = root?.classList.contains('coordinated-response') ? root.getAttribute('data-ddm-response') : null;
    if (!root || !layerId) {
      audit.violations.push(`${where}: a response that is neither a stamped coordinated response nor an adopted external popup`);
      return;
    }
    if (root.hasAttribute('data-popup-frame')) {
      const verdict = frameCheck(root, sink);
      if (verdict) audit.violations.push(`${where} ${layerId}: ${verdict}`);
    } else if (!allow.legacyLayerIds.includes(layerId)) {
      audit.violations.push(`${where}: an unframed response for ${layerId}, outside the legacy allowance`);
    }
    audit.seen.push(`${where}:${layerId}`);
  };

  const pending = new Set<Element>();
  const flush = (): void => {
    for (const el of pending) {
      if (!el.isConnected) continue;
      if (el.classList.contains('maplibregl-popup')) {
        const content = el.querySelector('.maplibregl-popup-content');
        if (content) auditSink(content, 'map', el.hasAttribute('data-ddm-external-response'));
        else audit.violations.push('map: a popup with no content box');
      } else if (el.children.length > 0) {
        auditSink(el, 'panel', false);
      }
    }
    pending.clear();
  };
  const observer = new MutationObserver((records) => {
    const before = pending.size;
    for (const record of records) {
      // Every mutation re-audits the sink it happened in (M23 repair round
      // 1, Codex ultra finding 3): an append, a replaced region or a removed
      // slot inside an already-audited response is audited again with the
      // same validator. A removed node's former parent is `record.target`,
      // so the walk from the target covers removals too. A text edit's
      // target is its text node, so it resolves through the parent element
      // (the Codex r1 re-check, finding 3); an attribute edit's target is
      // the element itself.
      const target = record.target;
      const element = target instanceof Element ? target : target.parentElement;
      const sink = element ? element.closest('.maplibregl-popup, .panel-response-host') : null;
      if (sink) pending.add(sink);
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('maplibregl-popup')) pending.add(node);
        for (const popup of Array.from(node.querySelectorAll('.maplibregl-popup'))) pending.add(popup);
        for (const host of Array.from(node.querySelectorAll('.panel-response-host'))) {
          if (host.children.length > 0) pending.add(host);
        }
      }
    }
    if (pending.size > before) setTimeout(flush, 0);
  });
  // Child lists, text, and the attributes the validator reads: the frame,
  // region and slot markers, the coordinator's and adoption's stamps, and
  // `class` (the coordinated-response classes on a framed root's regions).
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'data-popup-frame', 'data-popup-region', 'data-popup-slot', 'data-ddm-response', 'data-ddm-external-response']
  });
}

async function readAudit(page: Page): Promise<PopupAudit> {
  return page.evaluate(() => {
    const audit = (window as unknown as AuditWindow).__ddmPopupAudit;
    return { seen: [...(audit?.seen ?? [])], violations: [...(audit?.violations ?? [])] };
  });
}

/** Click the map center until the audit has recorded the wanted entry. */
async function clickCenterUntilSeen(page: Page, wanted: string): Promise<void> {
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('map container has no box');
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await readAudit(page)).seen, { timeout: 1500 }).toContain(wanted);
  }).toPass({ timeout: 20_000 });
}

/**
 * The census boots: one surface per boot (surfaces are exclusive) and
 * every other eligible layer in the first. The held BC edition is never
 * asked for (DR-160); its target must never be stamped.
 */
const CENSUS_BOOTS: readonly (readonly string[])[] = [
  ['usdm', 'states', 'aiannh', 'bia-reservations', 'tribal', 'treaty', 'ecoregions', 'nifc-fires', 'nws-alerts', 'hms-smoke', 'places', 'power-infrastructure', 'telemetry'],
  ['nadm-drought'],
  ['cdm-drought'],
  ['drought'],
  ['spc-fire-weather']
];

test.describe('identify paths: the census', () => {
  test('the stamped click targets equal the manifest targets of the activated layers, both ways', async ({
    page,
    context
  }) => {
    // The five registration boots, then one minute per migrated builder's fixture.
    test.setTimeout(180_000 + 60_000 * migratedBuilders().length);
    const booted = new Set(CENSUS_BOOTS.flat());
    expect(
      eligibleBuilders()
        .filter((b) => b.path === 'coordinated' && !booted.has(b.layerKey))
        .map((b) => b.id),
      'every browser-eligible coordinated builder is activated by a census boot'
    ).toEqual([]);
    expect(BUILDERS.filter((b) => b.held !== undefined && LEGACY_ALLOWANCE.includes(b.id)).map((b) => b.id), 'a held builder holds no allowance line').toEqual([]);
    expect(LEGACY_ALLOWANCE.filter((id) => !BUILDERS.some((b) => b.id === id)), 'every allowance line names a builder').toEqual([]);

    await holdExternalNetwork(page);
    let stamped = 0;
    const readStamp = async (): Promise<string[]> =>
      ((await page.locator('#map-container').getAttribute('data-ddm-click-targets')) ?? '')
        .split(' ')
        .filter((entry) => entry !== '')
        .sort();
    for (const layers of CENSUS_BOOTS) {
      // Registration runs on each layer's first activation, BEFORE its fetch,
      // so the census waits on the stamp itself rather than on every fetch
      // settling (bootIdle: false; the stamp is polled to its final value).
      await gotoApp(page, `?region=washington_state&view=console&layers=${layers.join(',')}`, { bootIdle: false });
      const expected = eligibleBuilders()
        .filter((b) => layers.includes(b.layerKey))
        .flatMap((b) => b.targets)
        .sort();
      await expect
        .poll(readStamp, { message: `the stamp after layers=${layers.join(',')}`, timeout: 20_000 })
        .toEqual(expected);
      stamped += (await readStamp()).length;
    }
    expect(stamped, 'the census read a nonzero number of stamped targets').toBeGreaterThan(0);

    // Builders outside the allowance must yield a frame: each migrated
    // builder runs its click fixture from tests/frame-fixtures.ts, which
    // asserts window.__ddmFrameCheck on its response (the four non-empty
    // head slots, and a link-bearing head source or, with no link, the
    // body's stated no-source reason; the frame owns the displayed content).
    // Each fixture gets a fresh page with the observer installed, so one
    // fixture's routes and viewport never reach the next; each boots through
    // gotoApp's stubs. Network isolation: every fixture page opens in THIS
    // context, so the catch-all 503 backstop holdExternalNetwork installed
    // on the context above, before the first boot, answers each fixture
    // page's unrouted external requests too; gotoApp's context stubs,
    // registered later, and each fixture's page routes keep precedence over
    // it. (A second backstop registered here, after those boots, would
    // outrank gotoApp's context stubs, which is why none is added.) The
    // count is asserted, so an empty loop is declared.
    const migrated = migratedBuilders();
    expect(migrated.length).toBe(eligibleBuilders().length - LEGACY_ALLOWANCE.length);
    for (const builder of migrated) {
      const fixture = CENSUS_FIXTURES[builder.id];
      if (!fixture) throw new Error(`${builder.id} left LEGACY_ALLOWANCE without a census click fixture`);
      const fixturePage = await context.newPage();
      try {
        await fixturePage.addInitScript(installPopupAudit, {
          legacyLayerIds: legacyLayerIds(),
          external: LEGACY_ALLOWANCE.includes('telemetry')
        });
        await fixture(fixturePage, { clickCenterUntilSeen, readAudit });
      } finally {
        await fixturePage.close();
      }
    }
  });
});

/**
 * S30D D1 M24: "every place-kind click target yields the frame" (D1.md:424),
 * in BOTH sinks (the Codex Tier 2 review :220, "frame root owns content in
 * map and panel sinks": a missing or empty marker, a lost title
 * announcement, host overflow or detached regions must fail). One test per
 * place builder of tests/frame-fixtures-places.ts (never migratedBuilders():
 * the surfaces have no panel sink). Each part boots offline with the
 * observer installed, so a response is audited as it appears, then the ONE
 * validator (window.__ddmFrameCheck) runs on the displayed root and the
 * builder's named fields are read from it.
 *
 * Red on a94eee5 once the six allowance lines are deleted: the observer
 * reports "map: an unframed response for <layer id>, outside the legacy
 * allowance" and no [data-popup-frame] root is displayed.
 */
function frameVerdict(selector: string): string | null {
  const root = document.querySelector(selector);
  const sink = root?.parentElement;
  const check = (window as unknown as AuditWindow).__ddmFrameCheck;
  if (!root || !sink) return `no framed response at ${selector}`;
  return check ? check(root, sink) : 'the observer is not installed';
}

test.describe('identify paths: every place builder yields the frame in both sinks (D1 M24)', () => {
  for (const fixture of Object.values(PLACE_FRAME_FIXTURES)) {
    test(`${fixture.id} yields the frame in the map popup and the panel foot`, async ({ page }) => {
      test.setTimeout(180_000);
      expect(migratedBuilders().map((b) => b.id), `${fixture.id} has left LEGACY_ALLOWANCE`).toContain(fixture.id);
      await holdExternalNetwork(page);
      await page.addInitScript(installPopupAudit, {
        legacyLayerIds: legacyLayerIds(),
        external: LEGACY_ALLOWANCE.includes('telemetry')
      });
      await fixture.prepare(page);
      for (const target of fixture.targets) {
        const label = `${fixture.id} ${target.layerId}`;
        // The map sink (console).
        await bootPlace(page, fixture, target, 'console');
        await clickCenterUntilSeen(page, `map:${target.layerId}`);
        expect((await readAudit(page)).violations, `${label}: map audit`).toEqual([]);
        expect(await page.evaluate(frameVerdict, MAP_ROOT), `${label}: map frame check`).toBeNull();
        await expectPlaceFields(page.locator(MAP_ROOT), target.expected, `${label} map`);
        if (!target.panel) continue;

        // The panel-foot sink (desktop Brief).
        await bootPlace(page, fixture, target, 'brief');
        await clickCenterUntilSeen(page, `panel:${target.layerId}`);
        expect((await readAudit(page)).violations, `${label}: panel audit`).toEqual([]);
        expect(await page.evaluate(frameVerdict, PANEL_ROOT), `${label}: panel frame check`).toBeNull();
        const title = await expectPlaceFields(page.locator(PANEL_ROOT), target.expected, `${label} panel`);
        // The sink's title announcement is built from the frame's title slot
        // (src/ui/island/panel-response.tsx).
        await expect(page.locator('#panel-response [aria-live="polite"]')).toHaveText(
          `Map selection response: ${title}. The response is at the foot of the panel.`
        );
        // The host caps the frame: neither the frame nor its content runs past the host.
        const fit = await page.evaluate((selector) => {
          const frame = document.querySelector(selector);
          const host = frame?.parentElement;
          if (!frame || !host) return null;
          const f = frame.getBoundingClientRect();
          const h = host.getBoundingClientRect();
          return { left: f.left - h.left, right: h.right - f.right, overflow: host.scrollWidth - host.clientWidth };
        }, PANEL_ROOT);
        expect(fit, `${label}: the panel host`).not.toBeNull();
        expect(fit!.left, `${label}: the frame starts outside the host`).toBeGreaterThanOrEqual(-0.5);
        expect(fit!.right, `${label}: the frame runs past the host`).toBeGreaterThanOrEqual(-0.5);
        expect(fit!.overflow, `${label}: the host overflows`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('identify paths: the observer over both sinks', () => {
  test('the observer passes only framed responses, stamped allowance responses and the adopted external popup', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, {
      legacyLayerIds: legacyLayerIds(),
      external: LEGACY_ALLOWANCE.includes('telemetry')
    });

    // The map sink: a coordinated FRAMED response (BIA left the allowance at
    // D1 M24), audited through __ddmFrameCheck. Each boot re-runs the init
    // script, so each part reads its own audit.
    await gotoApp(page, '?region=washington_state&view=console&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterUntilSeen(page, 'map:bia-reservations-fill');
    expect((await readAudit(page)).violations).toEqual([]);

    // The map sink again: the adopted station popup, identified by the mark
    // adoptExternalResponse writes (C4), never by a missing stamp.
    await gotoApp(page, '?region=washington_state&view=console&layers=telemetry');
    await waitForLayerSettled(page, 'telemetry');
    const marker = page.locator('.telemetry-marker[data-telemetry-station-id="ihr"]');
    await expect(marker).toHaveCount(1);
    await expect(async () => {
      await marker.click();
      await expect.poll(async () => (await readAudit(page)).seen, { timeout: 1500 }).toContain('map:external');
    }).toPass({ timeout: 20_000 });
    expect((await readAudit(page)).violations).toEqual([]);

    // The panel-foot sink: a place-bearing click in the Brief shell.
    await gotoApp(page, '?region=washington_state&view=brief&layers=bia-reservations');
    await waitForLayerSettled(page, 'bia-reservations');
    await clickCenterUntilSeen(page, 'panel:bia-reservations-fill');
    await expect(page.locator('#panel-response .panel-response-host > .coordinated-response')).toHaveCount(1);
    const panelAudit = await readAudit(page);
    expect(panelAudit.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Inert payloads and the shared validator
// ---------------------------------------------------------------------------

const PAYLOAD = '"><img src=x onerror="window.__ddmPwned=1"><svg onload="window.__ddmPwned=2">';

const PAYLOAD_MODEL: PopupModel = {
  kind: 'surface',
  title: PAYLOAD,
  issuer: { role: 'issued-by', name: `Fish & Wildlife ${PAYLOAD}`, productKey: 'usdm' },
  value: [{ label: PAYLOAD, text: PAYLOAD, items: [PAYLOAD], issuer: PAYLOAD }],
  clocks: [
    { kind: 'point', meaning: 'observed', label: PAYLOAD, at: { precision: 'supplied', text: PAYLOAD, explanation: PAYLOAD } }
  ],
  source: { link: { label: PAYLOAD, href: 'https://droughtmonitor.unl.edu/' } },
  details: [
    { kind: 'row', label: PAYLOAD, text: PAYLOAD },
    { kind: 'chart', label: PAYLOAD, chartKey: PAYLOAD, summary: PAYLOAD, data: [1, 2], options: { title: PAYLOAD }, unit: PAYLOAD, attribution: PAYLOAD }
  ],
  qualifications: [PAYLOAD],
  actions: [{ kind: 'briefing', place: PAYLOAD }]
};

const GROUP_MODEL: PopupModel = {
  kind: 'group',
  group: {
    groupKey: 'g:0001',
    computedAt: Date.UTC(2026, 8, 26, 21, 5),
    zone: 'America/Los_Angeles',
    issuers: ['nifc', 'bcws'],
    records: [
      {
        key: PAYLOAD,
        issuer: 'bcws',
        identifier: PAYLOAD,
        sizes: [{ label: PAYLOAD, text: PAYLOAD }],
        status: { from: 'issuer', text: PAYLOAD },
        clocks: [{ kind: 'not-stated', label: PAYLOAD, reason: PAYLOAD }],
        links: [{ label: PAYLOAD, href: 'https://wildfiresituation.nrs.gov.bc.ca/map' }]
      },
      {
        key: 'NIFC-A',
        issuer: 'nifc',
        identifier: '2026-WAFIX-000123',
        sizes: [],
        clocks: [{ kind: 'not-stated', label: 'Perimeter date', reason: 'Fixture reason.' }],
        links: []
      }
    ]
  }
};

test.describe('identify paths: inert payloads and the shared validator', () => {
  test('text and attribute payloads stay inert, and the frame validator accepts a frame and rejects an empty marker', async ({
    page
  }) => {
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: true });
    await gotoApp(page, '?region=washington_state&view=console&layers=states');
    const markups = [serializePopupFrame(PAYLOAD_MODEL), serializePopupFrame(GROUP_MODEL)];
    const result = await page.evaluate(async (htmls) => {
      const w = window as unknown as AuditWindow & { __ddmPwned?: number };
      const check = w.__ddmFrameCheck!;
      const hosts = htmls.map((html) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        return host;
      });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const text = hosts.map((host) => host.textContent ?? '').join(' ');
      const inert = {
        pwned: w.__ddmPwned ?? 0,
        unsafe: hosts.reduce((n, host) => n + host.querySelectorAll('img, svg, script, iframe, [onerror], [onload]').length, 0),
        literal: text.includes('<img src=x onerror='),
        ampersand: text.includes('Fish & Wildlife'),
        doubleEscaped: text.includes('&lt;') || text.includes('&amp;') || text.includes('&quot;'),
        hrefs: hosts.flatMap((host) => Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href')))
      };

      // The validator, on the frame as the coordinator presents it: the
      // article is the displayed root and its regions carry the classes.
      const present = (html: string): { sink: HTMLElement; root: Element } => {
        const sink = document.createElement('div');
        sink.innerHTML = html;
        const root = sink.firstElementChild!;
        root.classList.add('coordinated-response');
        root.children[0]!.classList.add('coordinated-response-head');
        root.children[1]!.classList.add('coordinated-response-body');
        return { sink, root };
      };
      const good = present(htmls[0]!);
      const stray = present(htmls[0]!);
      stray.sink.appendChild(document.createElement('p')).textContent = 'stray unframed content';
      const emptySlot = present(htmls[0]!);
      emptySlot.root.querySelector('[data-popup-slot="title"]')!.textContent = '';
      const marker = document.createElement('div');
      marker.innerHTML = '<div class="coordinated-response"><div class="popup-title">Legacy</div><span data-popup-frame></span></div>';
      for (const host of hosts) host.remove();
      return {
        inert,
        verdicts: {
          good: check(good.root, good.sink),
          stray: check(stray.root, stray.sink),
          emptySlot: check(emptySlot.root, emptySlot.sink),
          emptyMarker: check(marker.firstElementChild!, marker)
        }
      };
    }, markups);

    expect(result.inert.unsafe, 'an executable node or handler attribute was parsed from a payload').toBe(0);
    expect(result.inert.pwned, 'a payload handler ran').toBe(0);
    expect(result.inert.literal, 'the payload shows as its own text').toBe(true);
    expect(result.inert.ampersand, 'an ampersand shows once').toBe(true);
    expect(result.inert.doubleEscaped, 'an entity shows double-escaped').toBe(false);
    expect(result.inert.hrefs).toEqual(['https://droughtmonitor.unl.edu/', 'https://droughtmonitor.unl.edu/', 'https://wildfiresituation.nrs.gov.bc.ca/map']);
    expect(result.verdicts.good).toBeNull();
    expect(result.verdicts.stray).not.toBeNull();
    expect(result.verdicts.emptySlot).not.toBeNull();
    expect(result.verdicts.emptyMarker).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Later mutations (M23 repair round 1, Codex ultra finding 3)
// ---------------------------------------------------------------------------

test.describe('identify paths: the observer re-audits later mutations', () => {
  test('a stray node, root text, an emptied title or a removed region marker after the first audit fails; the late door and a telemetry hydration pass', async ({ page }) => {
    await holdExternalNetwork(page);
    await page.addInitScript(installPopupAudit, { legacyLayerIds: legacyLayerIds(), external: true });
    await gotoApp(page, '?region=washington_state&view=console&layers=states');
    const layerId = legacyLayerIds()[0]!;
    const seenCount = async (): Promise<number> => (await readAudit(page)).seen.length;

    // Three map-popup fixtures, shaped as the coordinator and telemetry
    // present them: a framed coordinated response, a legacy (allowance)
    // coordinated response, and an adopted external popup.
    await page.evaluate(
      ({ framed, layer }) => {
        const popup = (html: string, fixture: string, external = false): HTMLElement => {
          const el = document.createElement('div');
          el.className = 'maplibregl-popup';
          el.dataset.fixture = fixture;
          if (external) el.setAttribute('data-ddm-external-response', '');
          el.innerHTML = `<div class="maplibregl-popup-content">${html}<button class="maplibregl-popup-close-button" type="button">x</button></div>`;
          return el;
        };
        const framedPopup = popup(framed, 'framed');
        const root = framedPopup.querySelector('[data-popup-frame]')!;
        root.classList.add('coordinated-response');
        root.setAttribute('data-ddm-response', layer);
        root.children[0]!.classList.add('coordinated-response-head');
        root.children[1]!.classList.add('coordinated-response-body');
        const legacyPopup = popup(
          `<div class="coordinated-response" data-ddm-response="${layer}"><div class="coordinated-response-head"><h3 class="popup-title">Fixture legacy title</h3></div><div class="coordinated-response-body"><p>Fixture body</p></div></div>`,
          'legacy'
        );
        const externalPopup = popup('<div class="fixture-telemetry">Fixture skeleton</div>', 'external', true);
        const host = document.createElement('div');
        host.append(framedPopup, legacyPopup, externalPopup);
        document.body.appendChild(host);
      },
      { framed: serializePopupFrame(PAYLOAD_MODEL), layer: layerId }
    );
    await expect
      .poll(async () => (await readAudit(page)).seen.filter((s) => s === `map:${layerId}` || s === 'map:external').length)
      .toBe(3);
    expect((await readAudit(page)).violations, 'the three fixtures pass their first audit').toEqual([]);

    // The two legitimate later changes: the late briefing door (the framed
    // actions slot; the legacy head directly after the title) and a
    // telemetry hydration of the adopted popup. Each is audited again and
    // none reports a violation.
    const before = await seenCount();
    await page.evaluate(() => {
      const door = (): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'popup-impact-btn';
        button.setAttribute('data-ddm-impact-trigger', '');
        button.textContent = 'Fixture door';
        return button;
      };
      document.querySelector('[data-fixture="framed"] [data-popup-slot="actions"]')!.appendChild(door());
      document.querySelector('[data-fixture="legacy"] .popup-title')!.after(door());
      const hydrated = document.createElement('p');
      hydrated.textContent = 'Fixture hydrated reading';
      document.querySelector('[data-fixture="external"] .fixture-telemetry')!.appendChild(hydrated);
    });
    await expect.poll(seenCount, { message: 'each later change is audited again' }).toBeGreaterThanOrEqual(before + 3);
    expect((await readAudit(page)).violations, 'the late door and a hydration are legitimate').toEqual([]);

    // A stray node inside the already-audited frame: re-audited and failed.
    await page.evaluate(() => {
      const stray = document.createElement('p');
      stray.textContent = 'Fixture stray unframed content';
      document.querySelector('[data-fixture="framed"] [data-popup-frame]')!.appendChild(stray);
    });
    await expect
      .poll(async () => (await readAudit(page)).violations)
      .toContain(`map ${layerId}: the frame root holds other than its two regions`);
    const strayOnly = (await readAudit(page)).violations.length;

    // A text edit and an attribute edit after the first audit (the Codex r1
    // re-check, finding 3), each on a fresh framed fixture that first passes.
    const seenBefore = await seenCount();
    await page.evaluate(
      ({ framed, layer }) => {
        const host = document.createElement('div');
        for (const fixture of ['framed-title', 'framed-region', 'framed-text']) {
          const el = document.createElement('div');
          el.className = 'maplibregl-popup';
          el.dataset.fixture = fixture;
          el.innerHTML = `<div class="maplibregl-popup-content">${framed}<button class="maplibregl-popup-close-button" type="button">x</button></div>`;
          const root = el.querySelector('[data-popup-frame]')!;
          root.classList.add('coordinated-response');
          root.setAttribute('data-ddm-response', layer);
          root.children[0]!.classList.add('coordinated-response-head');
          root.children[1]!.classList.add('coordinated-response-body');
          host.appendChild(el);
        }
        document.body.appendChild(host);
      },
      { framed: serializePopupFrame(PAYLOAD_MODEL), layer: layerId }
    );
    await expect.poll(seenCount, { message: 'the fresh fixtures are audited' }).toBeGreaterThanOrEqual(seenBefore + 3);
    expect((await readAudit(page)).violations.length, 'the fresh fixtures pass their first audit').toBe(strayOnly);

    await page.evaluate(() => {
      const title = document.querySelector('[data-fixture="framed-title"] [data-popup-slot="title"]')!;
      (title.firstChild as Text).data = '';
      document.querySelector('[data-fixture="framed-region"] [data-popup-region="head"]')!.removeAttribute('data-popup-region');
      // Visible text directly under the frame root, outside both regions.
      document.querySelector('[data-fixture="framed-text"] [data-popup-frame]')!.append(document.createTextNode('Fixture unframed visible text'));
    });
    await expect
      .poll(async () => (await readAudit(page)).violations)
      .toEqual(
        expect.arrayContaining([
          `map ${layerId}: the head slot title is missing or empty`,
          `map ${layerId}: the displayed head is not the frame head region`
        ])
      );
    // The stray-element fixture reported this once; the root text is the second.
    await expect
      .poll(async () => (await readAudit(page)).violations.filter((v) => v === `map ${layerId}: the frame root holds other than its two regions`).length)
      .toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// S30D D1 M26a (block 4; register owner-1k, DDM-P11-T04): the NIFC perimeter
// (with its fire context) and the place-label targets have left
// LEGACY_ALLOWANCE. The census above runs their fixtures with every other
// migrated builder's; this case runs only these two, so their verdict reads
// on its own. Imported here, beside the case, so the block is an append.
// ---------------------------------------------------------------------------
import { FIRE_LABEL_CENSUS_FIXTURES } from './frame-fixtures-fires-labels';

/**
 * Red on 4c2afb4 once the 'nifc' and 'places' allowance lines are deleted:
 * the observer reports "map: an unframed response for nifc-fires-fill (or
 * us-places-labels), outside the legacy allowance" and the frame validator
 * finds no [data-popup-frame] root ("not exactly one frame root").
 */
test.describe('identify paths: the NIFC and place-label targets yield the frame (D1 M26a)', () => {
  for (const id of ['nifc', 'places'] as const) {
    test(`the census yields [data-popup-frame] for the ${id} target`, async ({ page }) => {
      test.setTimeout(120_000);
      expect(LEGACY_ALLOWANCE, `${id} has left LEGACY_ALLOWANCE`).not.toContain(id);
      expect(migratedBuilders().map((b) => b.id), `${id} is a migrated builder`).toContain(id);
      expect(Object.keys(CENSUS_FIXTURES), `${id} is registered in tests/frame-fixtures.ts`).toContain(id);
      await holdExternalNetwork(page);
      await page.addInitScript(installPopupAudit, {
        legacyLayerIds: legacyLayerIds(),
        external: LEGACY_ALLOWANCE.includes('telemetry')
      });
      await FIRE_LABEL_CENSUS_FIXTURES[id]!(page, { clickCenterUntilSeen, readAudit });
    });
  }
});
