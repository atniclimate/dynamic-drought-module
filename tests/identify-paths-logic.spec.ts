// The static-inventory and model cases of identify-paths.spec.ts, moved here because they open no page and so run in the pure lane.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test, expect } from './offline-test';
import { parseAst } from 'rolldown/parseAst';
import {
  NO_POPUP_SITES,
  POPUP_BOUNDARIES,
  popupSiteFindings,
  scanPopupSites,
  stripComments
} from './identify-paths-manifest';
import { serializePopupFrame } from '../src/ui/popup-frame';
import { LINE_SOURCE_STATEMENT } from './frame-fixtures-events-stations';
import type { TelemetryStation } from '../src/types/station';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. The static inventory
// ---------------------------------------------------------------------------

/** Declared with no click popup (interface-chrome-popups-text.md 3.5), each with its reason. */
const NO_POPUP_MODULES: Readonly<Record<string, string>> = {
  'src/layers/usfs-whp.ts': 'a no-op bindPopups',
  'src/layers/heatrisk.ts': 'the Key drawer carries it',
  'src/layers/heatrisk-coverage.ts': 'the Key drawer carries it',
  'src/layers/hydrography.ts': 'hover only',
  'src/layers/forests.ts': 'the name is on the map',
  'src/layers/railroads.ts': 'a line for context, nothing to read',
  'src/layers/dams.ts': 'the name is on the map at close zoom',
  'src/layers/public-lands.ts': 'the unit name is on the map at street zoom',
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
  test('no Popup construction or content setter outside the counted coordinator, frame and telemetry boundaries', () => {
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

/** The frame's markup reduced to its text, whitespace (U+00A0 too) collapsed. */
function frameText(markup: string): string {
  return markup.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/**
 * The builders' issuer words, printed as the issuer publishes them, on the
 * models the click coordinator paints (no page). The modules are imported in
 * the case, so this file still loads where a builder is missing: red on
 * bd8c1aa ("buildPowerPlantPopupModel is not a function", and the same for
 * each builder), where the layers still answer the legacy markup.
 */
test.describe('identify paths: the NWS, SPC and power models print the issuer words (D1 M26b)', () => {
  test('a power plant model names capacity, fuel, utility and the reporting month, and states an absent capacity', async () => {
    const { buildPowerPlantPopupModel } = await import('../src/ui/power-popups');
    const markup = serializePopupFrame(
      buildPowerPlantPopupModel({ Plant_Name: 'Synthetic Falls', PrimSource: 'hydroelectric', Total_MW: 24, Utility_Na: 'Synthetic Power', Period: '202502' })
    );
    const text = frameText(markup);
    expect(markup).toContain('data-popup-kind="infrastructure"');
    expect(text).toContain('Synthetic Falls');
    expect(text).toContain('Issued by: U.S. EIA · Forms 860/860M');
    expect(text).toContain('Nameplate capacity: 24 MW');
    expect(text).toContain('Primary energy source hydroelectric');
    expect(text).toContain('Utility Synthetic Power');
    // The issuer's reporting period at month precision, never given a day.
    expect(markup).toContain('<time datetime="2025-02">');
    expect(text).toContain('Issuer reporting period Feb 2025');
    // A nameplate rating is not current output, and the popup says so.
    expect(text).toContain('rated maximum');
    expect(markup).toContain('href="https://www.eia.gov/electricity/data/eia860/"');

    // A missing capacity is stated, never read as zero.
    const absent = frameText(serializePopupFrame(buildPowerPlantPopupModel({ Plant_Name: 'Synthetic Falls', Total_MW: null })));
    expect(absent).toContain('Nameplate capacity: not published');
    expect(absent).not.toContain('0 MW');
    expect(absent).toContain('Issuer reporting period not published');
  });

  test('a power line model never prints the issuer unknown sentinels and states the archive and its source', async () => {
    const { buildPowerLinePopupModel } = await import('../src/ui/power-popups');
    const unknown = serializePopupFrame(
      buildPowerLinePopupModel({ VOLT_CLASS: 'NOT AVAILABLE', OWNER: 'NOT AVAILABLE', STATUS: 'IN SERVICE', TYPE: 'AC', VOLTAGE: -999999 })
    );
    const text = frameText(unknown);
    // -999999 is the issuer's unknown marker; 'NOT AVAILABLE' is an absence.
    expect(text).not.toContain('-999999');
    expect(text).not.toContain('999,999');
    expect(text).not.toContain('NOT AVAILABLE');
    expect(text).toContain('Transmission line');
    expect(text).toContain('Issued by: HIFLD (U.S. Government)');
    expect(text).toContain('Voltage class: not published');
    expect(unknown).toContain('<dt>Owner</dt><dd>not published</dd>');
    expect(unknown).toContain('<dt>Operational status</dt><dd>IN SERVICE</dd>');
    expect(unknown).toContain('<dt>Type</dt><dd>AC</dd>');
    // The archive's currency, in the head and in the caveat.
    expect(unknown).toContain('<time datetime="2024-09-30">');
    expect(text).toContain('no one maintains it');
    // No public page: the stated source in the body, linking nowhere.
    expect(unknown).not.toContain('<a ');
    expect(unknown).toContain(`<p data-popup-slot="source-fallback">${LINE_SOURCE_STATEMENT}</p>`);

    const known = frameText(
      serializePopupFrame(buildPowerLinePopupModel({ VOLT_CLASS: '500', OWNER: 'BONNEVILLE POWER ADMINISTRATION', STATUS: 'IN SERVICE', VOLTAGE: 500 }))
    );
    expect(known).toContain('Voltage class: 500');
    expect(known).toContain('Voltage 500 kV');
    expect(known).toContain('BONNEVILLE POWER ADMINISTRATION');
  });

  test('an NWS alert model prints the product name verbatim with its swatch, the office, and From and Until with their zone', async () => {
    const { buildNwsAlertPopupModel } = await import('../src/layers/nws-alerts');
    const onset = Date.UTC(2026, 7, 11, 15, 0);
    // The map feature's properties are the reader's NormalizedAlert fields (src/layers/nws-alerts.ts).
    const markup = serializePopupFrame(
      buildNwsAlertPopupModel({ event: 'Red Flag Warning', onset, ends: '2026-08-12T20:00:00-07:00', issuer: 'KSEW' })
    );
    const text = frameText(markup);
    expect(markup).toContain('data-popup-kind="event"');
    expect(text).toContain('National Weather Service alert');
    expect(text).toContain('Issued by: NOAA NWS, office SEW');
    expect(text).toContain('Red Flag Warning');
    expect(markup).toContain('data-swatch-table="NWS_ALERT_COLORS" data-swatch-class="Red Flag Warning" style="--popup-swatch: #ff1493"');
    // An epoch onset is read (the legacy popup printed an empty From line for it).
    expect(markup).toContain(`<time datetime="${new Date(onset).toISOString()}">`);
    expect(markup).toContain(`<time datetime="${new Date('2026-08-12T20:00:00-07:00').toISOString()}">`);
    expect(text).toMatch(/From Aug 1[01], 2026, \d\d:\d\d \S+/);
    expect(text).toMatch(/Until Aug 1[23], 2026, \d\d:\d\d \S+/);
    expect(markup).toContain('href="https://alerts.weather.gov/"');
    // The heat-safety page rides the heat products only, never a fire weather one (the look at 6748f25, P3-30).
    expect(markup).not.toContain('href="https://www.weather.gov/safety/heat"');

    // Issuer time text DDM does not read is shown as supplied; no office, no office line.
    const odd = frameText(serializePopupFrame(buildNwsAlertPopupModel({ event: 'Heat Advisory', ends: 'Tonight' })));
    expect(serializePopupFrame(buildNwsAlertPopupModel({ event: 'Heat Advisory', ends: 'Tonight' }))).toContain('href="https://www.weather.gov/safety/heat"');
    expect(odd).toContain('Issued by: NOAA NWS ');
    expect(odd).not.toContain('office');
    expect(odd).toContain('Until Tonight As the issuer states it; DDM does not read it as a full date.');

    // An ENSO product: its own swatch, an end it does not state said so, and no description or link of its own.
    const floodMarkup = serializePopupFrame(buildNwsAlertPopupModel({ event: 'Flood Warning', onset, ends: null, issuer: 'KDVN' }));
    const flood = frameText(floodMarkup);
    expect(flood).toContain('Issued by: NOAA NWS, office DVN');
    expect(flood).toContain('End not stated');
    expect(flood).not.toContain('unavailable');
    expect(floodMarkup).toContain('data-swatch-class="Flood Warning" style="--popup-swatch: #00ff00"');
    expect(flood).not.toContain('forecast-zone shapes');
    expect(flood).not.toContain('heat or fire weather');
    expect(floodMarkup).not.toContain('https://www.weather.gov/safety/heat');
    expect(floodMarkup).toContain('href="https://alerts.weather.gov/"');
  });

  test('an SPC outlook model prints the category word verbatim with its swatch and the valid period in UTC', async () => {
    const { buildSpcFireWeatherPopupModel } = await import('../src/ui/popups');
    const markup = serializePopupFrame(
      buildSpcFireWeatherPopupModel('Extremely Critical', { dn: 10, valid: '202610051200', expire: '202610061200' }, {
        table: 'SPC_FIREWX_CATEGORIES',
        classKey: '10',
        color: '#ff00ff'
      })
    );
    const text = frameText(markup);
    expect(markup).toContain('data-popup-kind="surface"');
    expect(text).toContain('SPC Fire Weather Outlook, Day 1');
    expect(text).toContain('Issued by: NOAA Storm Prediction Center');
    expect(text).toContain('Extremely Critical');
    expect(markup).toContain('data-swatch-class="10"');
    expect(markup).toContain('<time datetime="2026-10-05T12:00:00.000Z">');
    expect(text).toContain('From Oct 5, 2026, 12:00 UTC');
    expect(text).toContain('Until Oct 6, 2026, 12:00 UTC');
    expect(text).toContain('not a fire danger rating and not an active fire');

    // An unknown category keeps its honest label and no swatch; odd time text is shown as supplied.
    const odd = serializePopupFrame(buildSpcFireWeatherPopupModel('Category 7', { dn: 7, valid: '2026-10-05', expire: null }, null));
    expect(odd).not.toContain('popup-swatch');
    expect(frameText(odd)).toContain('From 2026-10-05 As the issuer states it; DDM does not read it as a full date.');
    expect(frameText(odd)).not.toContain('Until');
  });
});

test.describe('identify paths: the telemetry station popup joins the frame (D1 M26c)', () => {
  test('a station model states loading, custody, unavailable and no data, keeps a genuine zero with each reading\'s own time and its sparkline, and keeps the RAWS words', async () => {
    const { buildTelemetryPopupModel, rawsStationRead } = await import('../src/ui/popups');
    const { stationCustody } = await import('../src/config/station-registry');
    const base = {
      name: 'Fixture Snow Course',
      coords: [47, -121] as const,
      region: 'cascades',
      type: 'snotel',
      agency: 'NRCS',
      color: '#06b6d4',
      description: 'Fixture station description.',
      links: [
        { label: 'Fixture script link', url: 'javascript:alert(1)' },
        { label: 'Fixture userinfo link', url: 'https://user:pw@example.org/' },
        { label: 'Fixture station page', url: 'https://wcc.sc.egov.usda.gov/' },
        { label: 'Fixture report', url: 'https://www.nrcs.usda.gov/' }
      ]
    };
    const live: TelemetryStation = { ...base, id: 'fixture-snotel', awdbStation: '999:WA:SNTL' };

    // Before its live read lands: the six-state word, and the station page.
    const loading = serializePopupFrame(buildTelemetryPopupModel(live));
    expect(loading).toContain('data-popup-kind="station" data-popup-product="telemetry"');
    expect(frameText(loading)).toContain('Fixture Snow Course Issued by: NRCS');
    expect(loading).toContain('<span data-state>loading</span>');
    expect(loading).toContain('<p data-popup-slot="source"><a href="https://wcc.sc.egov.usda.gov/" target="_blank" rel="noopener">Fixture station page</a></p>');
    expect(loading).toContain('<a href="https://www.nrcs.usda.gov/" target="_blank" rel="noopener">Fixture report</a>');
    expect(loading).not.toContain('javascript:');
    expect(loading).not.toContain('user:pw');
    expect(frameText(loading)).toContain('Fixture station description.');

    // A station DDM does not read in the browser is never left loading.
    const coops: TelemetryStation = { ...base, id: 'fixture-coops', noaaCoopsId: '9440910' };
    const custody = stationCustody(coops);
    expect(custody, 'the fixture station has a custody network').not.toBeNull();
    const custodyMarkup = serializePopupFrame(buildTelemetryPopupModel(coops));
    expect(custodyMarkup).not.toContain('data-state');
    expect(frameText(custodyMarkup)).toContain('Live readings open at the source link below.');
    expect(frameText(custodyMarkup)).toContain(`Updates ${custody!.cadence}`);

    // A failed read and a read with no values, each with its state word.
    const unavailable = serializePopupFrame(buildTelemetryPopupModel(live, { kind: 'unavailable' }));
    expect(unavailable).toContain('<span data-state>unavailable</span>');
    expect(frameText(unavailable)).toContain('Live data unavailable in-browser. Open the source link for current values.');
    // A station with no public page (every viewport-discovered SNOTEL and
    // SCAN station carries `links: []`) never points to a source link (the
    // block 6 review, B6b): its failed read says only the first sentence.
    const noPage = serializePopupFrame(buildTelemetryPopupModel({ ...live, id: 'fixture-no-page', links: [] }, { kind: 'unavailable' }));
    expect(frameText(noPage)).toContain('This station lists no public page.');
    expect(frameText(noPage)).toContain('Live data unavailable in-browser.');
    expect(frameText(noPage)).not.toContain('source link');
    const none = serializePopupFrame(buildTelemetryPopupModel(live, { kind: 'no data', text: 'No recent NRCS values for this station.' }));
    expect(none).toContain('<span data-state>no data</span>');
    expect(frameText(none)).toContain('No recent NRCS values for this station.');

    // A genuine zero, each reading with its own issuer and time, the stale
    // note on the reading past its window, the retrieval time, the chart.
    const zero = serializePopupFrame(
      buildTelemetryPopupModel(live, {
        kind: 'live',
        retrievedAt: Date.UTC(2026, 9, 5, 16, 0),
        readings: [
          { label: 'Snow water equivalent', text: '0 in', issuer: 'NRCS AWDB', observed: { precision: 'date', date: '2026-10-04' } },
          { label: 'Snow depth', text: '0 in', issuer: 'NRCS AWDB', observed: { precision: 'date', date: '2026-10-03' }, stale: true }
        ],
        chart: { data: [0, 0, 1.5], title: 'Snow water equivalent over the past 7 days (NRCS SNOTEL)', unit: 'in', source: 'NRCS AWDB, past 7 days' }
      })
    );
    const split = zero.indexOf('<div data-popup-region="body">');
    const zeroHead = zero.slice(0, split);
    const zeroBody = zero.slice(split);
    expect(frameText(zeroHead)).toContain('Snow water equivalent 0 in NRCS AWDB');
    expect(zeroHead).toContain('<time datetime="2026-10-04">');
    expect(zeroHead).not.toContain('data-state');
    expect(zeroBody).toContain('<dl data-detail="reading"><dt>Snow depth</dt><dd>0 in (stale) <span data-reading-issuer>NRCS AWDB</span>');
    expect(zeroBody).toContain('<time datetime="2026-10-03">');
    expect(frameText(zeroBody)).toContain('Retrieved on');
    expect(zeroBody).toContain('data-popup-chart="station-sparkline" data-chart-values="0,0,1.5" data-chart-unit="in"');

    // The RAWS readings keep the issuer's words (DDM-P9-T05, DDM-P9-T06).
    const rawsMarkup = (read: ReturnType<typeof rawsStationRead>): string =>
      frameText(serializePopupFrame(buildTelemetryPopupModel({ ...base, id: 'fixture-raws', agency: 'NIFC RAWS', rawsStationId: '999' }, read)));
    const conditions = {
      relativeHumidity: '21 %',
      windSpeed: '5 mph',
      windDirection: '295 degrees',
      windGustSpeed: null,
      windGustDirection: null,
      fuelMoisture: null,
      observedAtIso: '2026-10-05T15:00:00Z'
    };
    const happy = rawsMarkup(rawsStationRead(conditions, Date.UTC(2026, 9, 5, 16, 0)));
    expect(happy).toContain('Relative humidity 21 % NIFC RAWS');
    expect(happy).toContain('Wind 5 mph from 295 degrees NIFC RAWS');
    expect(happy).toContain('Fuel moisture Station reported none NIFC RAWS');
    const peak = rawsMarkup(rawsStationRead({ ...conditions, windSpeed: '3 mph', windDirection: null, windGustSpeed: '11 mph', windGustDirection: '212 degrees' }, 0));
    expect(peak).toContain('Wind 3 mph, peak 11 mph from 212 degrees over the previous 60 minutes');
    expect(rawsMarkup(rawsStationRead(null, 0))).toContain('No recent NIFC RAWS values for this station.');
  });
});
