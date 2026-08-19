/**
 * Per-feature activation budgets + the eager import-graph assertion
 * (0.8.0 T-P0-7; reworked at its DG-080-REVIEW).
 *
 * WHAT THIS GATE PROVES (and only this; the boundary is stated
 * honestly rather than generously):
 *
 *   1. IMPORT-GRAPH ASSERTION over the INITIAL STATIC SET. The initial
 *      static set is the entry chunk plus the transitive static-import
 *      closure of the entry, computed from the Vite manifest
 *      (dist/.vite/manifest.json; `build.manifest: true` in
 *      vite.config.ts), cross-checked for exact equality against the
 *      chunks dist/index.html actually declares (module script +
 *      modulepreload links). The equality is a PROJECT-CONFIGURATION
 *      INVARIANT of this build (Vite emits modulepreloads for the full
 *      static closure and index.html references nothing else); a
 *      deliberate config change that alters preload emission must
 *      update this gate, and until then disagreement is a hard fail
 *      (the union is still scanned so neither side escapes). Within
 *      that set, named heavy libraries (geotiff, the governed
 *      ZIP-library list) and the future landscape-artifact loader
 *      (src/impact/landscape.ts) must not appear; chunk CONTENTS are
 *      proven from each chunk's sourcemap `sources`
 *      (the manifest gives edges, sourcemaps give what was folded in;
 *      the assertion needs both). A missing, malformed, indexed, or
 *      evidence-empty sourcemap on a non-exempt initial chunk is a
 *      hard fail, never a skip.
 *
 *      RESIDUAL, out of scope by construction (static artifacts cannot
 *      prove execution timing): an unconditional import() executed
 *      during boot, a Worker started during boot, or inline module
 *      code would load AFTER the initial static set without appearing
 *      in it. Runtime boot behavior is owned by the rendered verifier
 *      lane (ddm-ui-verifier), not this gate.
 *
 *   2. PER-FEATURE ACTIVATION BUDGETS. A feature row declares its ROOT
 *      MODULES (manifest keys, e.g. 'src/layers/foo.ts'); the
 *      feature's FIRST-ACTIVATION STATIC CLOSURE is the static-import
 *      closure of those roots minus the initial static set, so a
 *      renamed or newly shared transitive chunk is still counted
 *      (filename patterns are not used; they undercount). Like the
 *      boot-time assertion, this measures the STATIC closure only: a
 *      nested activation-time import() or Worker is outside it (same
 *      runtime residual, owned by the rendered verifier lane).
 *      Statically checkable columns are enforced the moment they carry
 *      a number:
 *        - activationJsGzipKb: summed gzip kB of the closure's chunks
 *          (kB = 1000 bytes, matching the bundle gate and Vite).
 *        - dataAssets[].maxBytes: on-disk size of a bundled asset
 *          file, path-contained under dist/.
 *      networkBytes / requestCount cannot be measured without a live
 *      network: they are DECLARED CONTRACT VALUES printed here and
 *      verified by the T-M0-6 transport spike and the rendered
 *      verifier lane. Every column must be the exact sentinel
 *      'pending-measurement' or a finite number (positive for the JS
 *      budget, since the enforcement line is `total >= budget` and a
 *      zero budget could never pass; non-negative elsewhere); anything
 *      else fails. A numeric JS budget requires declared roots that
 *      exist in the manifest AND resolve to a nonempty closure outside
 *      the initial set (a missing root or an empty resolved closure is
 *      drift, not a pass). The MCO row ships all-pending; T-M0-6
 *      records the first real numbers.
 *
 *   3. ZIP DEPENDENCY TRIPWIRE. The forbidden ZIP rule enforces a
 *      governed, named package list (not "any ZIP library"; a finite
 *      list cannot honestly claim the universal). To keep the list
 *      honest, any package.json dependency or devDependency whose
 *      name looks archive-like (zip/unzip/archiv) and is not on the
 *      governed list fails the gate until the list (or its recorded
 *      exemptions) is extended.
 *
 * EXEMPTIONS, WITH THEIR RESIDUALS STATED:
 *   - rolldown-runtime-* and preload-helper-*: may lack a sourcemap
 *     (generated bundler helpers with no source modules), but only
 *     while they are not the entry chunk and stay under small raw-size
 *     caps. RESIDUAL: these are size-bounded filename exemptions, not
 *     content proofs; a hostile sub-cap chunk planted under either
 *     name would pass, which requires control of the build output and
 *     is accepted as outside this gate's threat model.
 *   - fflate inside the pmtiles-* vendor chunk: allowed only while
 *     that chunk's ENTIRE source list is pmtiles + fflate modules and
 *     actually contains pmtiles (fflate is pmtiles' own
 *     tile-decompression dependency; the D-0.7.0-045 vendor
 *     exemption). Chunk composition alone cannot prove which module
 *     IMPORTS fflate, so ownership is closed at the source level
 *     instead: no first-party module under src/ may import a governed
 *     ZIP package at all (checked below); together the two checks mean
 *     fflate can only arrive via pmtiles. fflate in any other chunk, a
 *     pmtiles-named chunk without pmtiles sources, or first-party code
 *     sharing that chunk fails.
 *
 * SELF-TEST: the case table lives IN THIS FILE (no on-disk fixtures to
 * drift or forged EXPECT files), and the inventory is pinned by NAME in
 * EXPECTED_CASE_NAMES (a deleted or renamed case fails the self-test,
 * not just lowers a count). Each case declares kind 'fail' or 'pass'
 * (anything else fails); each is materialized to a temp directory and
 * run through the same checker as the real tree; fail cases must yield
 * at least one finding and every finding must carry the case's
 * nonempty marker; pass cases must be clean. The self-test runs before
 * every real scan; --self-test runs it alone.
 *
 * The two enforced bundle-size lines (45 kB entry / 100 kB eager app)
 * live in check-bundle-size.mjs and are deliberately untouched here.
 * Portability: plain node:fs/os/path/zlib; no version-specific APIs.
 * Exit 0 = clean; exit 1 = any finding or self-test failure.
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const PENDING = 'pending-measurement';

// The governed ZIP-library list. Extend it (with the tripwire below
// keeping it honest) rather than claiming universality.
const ZIP_PACKAGES = [
  'jszip', 'fflate', 'adm-zip', 'yauzl', 'yazl', 'unzipper', 'unzipit',
  'extract-zip', 'node-stream-zip', 'archiver', 'decompress', 'zip.js', '@zip.js',
];
const ZIP_PATTERN = new RegExp(
  `node_modules/(${ZIP_PACKAGES.map((p) => p.replace(/[.\\]/g, '\\$&')).join('|')})/`
);

const EAGER_FORBIDDEN = [
  {
    name: 'geotiff',
    pattern: /node_modules\/geotiff\//,
    reason: 'COG decoding is a lazy, per-activation cost (U-MCO-SHIP); it must never ride the initial static set.',
  },
  {
    name: 'ZIP library',
    pattern: ZIP_PATTERN,
    reason: 'Archive decoding belongs to build scripts or lazy features, never the initial static set.',
    // Checked allowance, not filename trust: see the header.
    allowances: [{
      chunkName: /^pmtiles-/,
      source: /node_modules\/fflate\//,
      requireSource: /node_modules\/pmtiles\//,
      allowedFamily: /node_modules\/(pmtiles|fflate)\//,
      reason: 'fflate is the pmtiles vendor chunk\'s own dependency; valid only while the chunk bundles exclusively pmtiles + fflate',
    }],
  },
  {
    name: 'landscape-artifact loader',
    pattern: /src\/impact\/landscape\.ts$/,
    reason: 'The T-M0-3 loader is lazy by contract (the import-graph assertion proves the loader stays out of the eager graph). Absent today; this guards it forward.',
  },
  {
    name: 'impact briefing cluster panel runtime',
    pattern: /src\/ui\/impact-panel-runtime\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; its panel runtime must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster primary runtime entry',
    pattern: /src\/ui\/impact-panel-runtime-primary\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; its primary runtime entry must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster recovery runtime entry',
    pattern: /src\/ui\/impact-panel-runtime-recovery\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; its recovery runtime entry must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster location identity',
    pattern: /src\/state\/location-identity\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; location identity resolution must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster point-in-polygon',
    pattern: /src\/util\/point-in-polygon\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; location containment geometry must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster claim renderer',
    pattern: /src\/ui\/claim-render\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; claim evidence rendering must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster chart renderer',
    pattern: /src\/ui\/charts\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing chart rendering must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster boundary context',
    pattern: /src\/impact\/context\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; boundary briefing context must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster composer',
    pattern: /src\/impact\/briefing\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing composition must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster hydration orchestrator',
    pattern: /src\/impact\/hydrate\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; source hydration must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster source fetchers',
    pattern: /src\/impact\/sources\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing source fetchers must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster ENSO analysis',
    pattern: /src\/impact\/enso\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; El Nino / Southern Oscillation analysis must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster evidence helpers',
    pattern: /src\/impact\/evidence\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing evidence helpers must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster resource catalog',
    pattern: /src\/impact\/resource-catalog\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing resource catalog loading must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster resource routing',
    pattern: /src\/impact\/resources\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; briefing resource routing must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster water supply',
    pattern: /src\/impact\/water-supply\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; water-supply analysis must never ride the initial static set.',
  },
  {
    name: 'impact briefing cluster category impacts',
    pattern: /src\/impact\/category-impacts\.ts$/,
    reason: 'The impact briefing cluster is a first-use cost; the category-impact seam must never ride the initial static set. This source-map rule stays dormant when H0 removes the module.',
  },
];

// Exact identities and source matches are checked independently by the
// self-test. Deleting or weakening one governed row must turn the self-test
// red even while another impact-cluster rule still matches.
const IMPACT_EAGER_RULE_CONTRACT = [
  ['impact briefing cluster panel runtime', '../../src/ui/impact-panel-runtime.ts'],
  ['impact briefing cluster primary runtime entry', '../../src/ui/impact-panel-runtime-primary.ts'],
  ['impact briefing cluster recovery runtime entry', '../../src/ui/impact-panel-runtime-recovery.ts'],
  ['impact briefing cluster location identity', '../../src/state/location-identity.ts'],
  ['impact briefing cluster point-in-polygon', '../../src/util/point-in-polygon.ts'],
  ['impact briefing cluster claim renderer', '../../src/ui/claim-render.ts'],
  ['impact briefing cluster chart renderer', '../../src/ui/charts.ts'],
  ['impact briefing cluster boundary context', '../../src/impact/context.ts'],
  ['impact briefing cluster composer', '../../src/impact/briefing.ts'],
  ['impact briefing cluster hydration orchestrator', '../../src/impact/hydrate.ts'],
  ['impact briefing cluster source fetchers', '../../src/impact/sources.ts'],
  ['impact briefing cluster ENSO analysis', '../../src/impact/enso.ts'],
  ['impact briefing cluster evidence helpers', '../../src/impact/evidence.ts'],
  ['impact briefing cluster resource catalog', '../../src/impact/resource-catalog.ts'],
  ['impact briefing cluster resource routing', '../../src/impact/resources.ts'],
  ['impact briefing cluster water supply', '../../src/impact/water-supply.ts'],
  ['impact briefing cluster category impacts', '../../src/impact/category-impacts.ts'],
];

// Map-exemption invariants: pattern + not-the-entry + raw-size cap.
// The real rolldown runtime is ~0.6 kB and Vite's dependency-preload helper
// is ~1.3 kB. Both are generated helpers with no source module map.
const MAP_EXEMPT = [
  {
    pattern: /^rolldown-runtime-/,
    maxRawBytes: 8192,
    reason: 'generated bundler module-runtime helpers; no source modules by construction',
  },
  {
    pattern: /^preload-helper-/,
    maxRawBytes: 4096,
    reason: 'generated Vite dependency-preload helper; no source modules by construction',
  },
];

/* ------------------------------------------------------------------ *
 * The per-feature activation budget table. Row contract is enforced
 * by validateBudgets(); see the header for column semantics.
 * ------------------------------------------------------------------ */
const FEATURE_BUDGETS = [
  {
    key: 'landscape-signature-artifact',
    label: 'Landscape signature briefing consumer (T3-2 measured 3.33 kB gzip in its first-activation static closure and one 531,090-byte bundled artifact request on 2026-07-29; unsupported boundary kinds do not request the artifact)',
    rootModules: ['src/impact/landscape-consumer.ts'],
    activationJsGzipKb: 4.0,
    networkBytes: 531_090,
    requestCount: 1,
    dataAssets: [{
      path: 'data/landscape-signature-pnw.json',
      maxBytes: 560_000,
    }],
  },
  {
    key: 'mco-gridded-index',
    label: 'MCO gridded drought indices (T-M0-6 spike records the first real numbers; U-MCO-SHIP declares roots and enforces)',
    rootModules: [], // no MCO module exists yet; U-MCO-SHIP names it here
    activationJsGzipKb: PENDING,
    networkBytes: PENDING,
    requestCount: PENDING,
    dataAssets: [],
  },
  {
    key: 'heatrisk-days',
    label: 'HeatRisk multi-day selector (JS budget 4.2 kB covers the 4.1 kB shared HeatRisk closure measured after H2 integration; the H0 coverage qualification measured 3.5 kB across three chunks on 2026-07-28; network numbers measured 30,326 bytes / 18 requests at 1280x720 on 2026-07-27)',
    rootModules: ['src/layers/heatrisk.ts'],
    activationJsGzipKb: 4.2,
    networkBytes: 30_326,
    requestCount: 18,
    dataAssets: [],
  },
  {
    key: 'point-heat-briefing',
    label: 'Point heat briefing with bounded NWS discovery, nearby observation, grid time series, point forecast, and alerts (24.1 kB measured first-activation closure, including the shared impact hydrator; six-request ceiling; completed responses use the bounded client cache and the Worker retains its 60-second edge cache)',
    rootModules: ['src/impact/point-heat.ts'],
    activationJsGzipKb: 25.0,
    networkBytes: 3_000_000,
    requestCount: 6,
    dataAssets: [],
  },
  {
    key: 'bc-basin-drought',
    label: 'Province of British Columbia basin drought levels (measured 3,908,396 bytes and one request with the 0.01-degree generalized query on 2026-07-27)',
    rootModules: ['src/layers/bc-drought.ts'],
    activationJsGzipKb: 5.2,
    networkBytes: 4_250_000,
    requestCount: 1,
    dataAssets: [],
  },
  {
    key: 'canadian-drought-monitor-snapshot',
    label: 'Canadian Drought Monitor monthly committed snapshot (June 2026 artifact measured 960,818 bytes on 2026-07-28; S4 shared time-bar closure measured 5,591 gzip bytes on 2026-07-29)',
    rootModules: ['src/layers/cdm-drought.ts'],
    activationJsGzipKb: 5.7,
    networkBytes: 1_000_000,
    requestCount: 1,
    dataAssets: [{
      path: 'data/cdm-drought-areas.json',
      maxBytes: 1_000_000,
    }],
  },
  {
    key: 'north-american-drought-monitor',
    label: 'North American Drought Monitor continental context (measured 616,132 bytes and one direct request on 2026-07-27)',
    rootModules: ['src/layers/nadm-drought.ts'],
    activationJsGzipKb: 5.2,
    networkBytes: 650_000,
    requestCount: 1,
    dataAssets: [],
  },
  {
    key: 'fire3d-mode',
    label: 'Desktop 3D Fire mode: terrain + camera + sky orchestrator, the volumetric smoke companion, and the issuer-published context chunk (measured 6.7 kB gzip across 7 chunks on 2026-08-18 after the context chunk landed; archive transport at 1280x720 the same day measured 2,278,573 terrain bytes over 19 ranged requests plus 1,215,252 fuels-drape bytes over 11; the smoke and context roots are reached via dynamic import from the first root and are invisible to the static closure walk, so ALL roots are declared)',
    rootModules: ['src/map/fire3d.ts', 'src/layers/hms-smoke-volume.ts', 'src/map/fire3d-context.ts'],
    activationJsGzipKb: 8.5,
    networkBytes: 4_200_000,
    requestCount: 36,
    dataAssets: [{
      // MUST equal SIZE_BUDGET_BYTES in scripts/build-fuels-tiles.mjs so a
      // rebake cannot pass the builder and fail this gate (or vice versa).
      path: 'data/fuels-fbfm40-pnw.pmtiles',
      maxBytes: 30_000_000,
    }],
  },
];

/* ------------------------------------------------------------------ */
const kb = (bytes) => (bytes / 1000).toFixed(1);
const gz = (path) => gzipSync(readFileSync(path)).length;
const isPendingOrBudget = (v) => v === PENDING || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

function extractHtmlEager(html) {
  // Attribute-anchored: only src=/href= values count, so comments or
  // prose mentioning a chunk name cannot create a phantom eager entry.
  return [...new Set(
    [...html.matchAll(/(?:src|href)="[^"]*?assets\/([\w.-]+\.js)"/g)].map((m) => m[1])
  )];
}

function staticClosure(manifest, seedKeys) {
  const seen = new Set(seedKeys.filter((k) => k in manifest));
  const stack = [...seen];
  while (stack.length) {
    const key = stack.pop();
    for (const imp of manifest[key].imports ?? []) {
      if (imp in manifest && !seen.has(imp)) { seen.add(imp); stack.push(imp); }
    }
  }
  return seen;
}

const jsFilesOf = (manifest, keys) =>
  new Set([...keys].map((k) => manifest[k].file)
    .filter((f) => typeof f === 'string' && f.endsWith('.js'))
    .map((f) => f.replace(/^assets\//, '')));

function validateSourcemap(mapPath) {
  let map;
  try {
    map = JSON.parse(readFileSync(mapPath, 'utf8'));
  } catch {
    return { error: 'is not parseable JSON' };
  }
  if (map && typeof map === 'object' && 'sections' in map) {
    return { error: 'is an indexed source map (sections); unsupported here, cannot prove absence' };
  }
  const sources = map?.sources;
  if (!Array.isArray(sources) || sources.some((s) => typeof s !== 'string')) {
    return { error: 'has no valid sources array; cannot prove absence' };
  }
  if (sources.length === 0) {
    return { error: 'has no source evidence (empty sources); cannot prove absence' };
  }
  return { sources: sources.map((s) => s.replaceAll('\\', '/')) };
}

// Source-level ownership closure for the pmtiles/fflate allowance: no
// first-party module may import a governed ZIP package (chunk
// composition cannot prove which module imports fflate; this can).
// (The project's TypeScript 7 devDependency exposes no JS parse API,
// so this is a purpose-built specifier lexer rather than an AST walk;
// its enforcement directions are pinned in the self-test.) It lexes:
// line/block comments (skipped between tokens, so a comment cannot
// hide a specifier); string literals with COOKED escapes (\uXXXX,
// \u{...}, \xXX and the single-char escapes, so an escape-obfuscated
// governed name still trips) consumed as single tokens (prose inside
// a string cannot trip); no-substitution template literals (a legal
// import(`x`) argument) cooked the same way; and regular-expression
// literals via the standard expression-position heuristic (a regex
// body cannot trip). A string/template counts as a specifier only
// when preceded by `from`, by `import(`/`require(`, or by a bare
// `import` that itself sits at a statement boundary (start, ';', '{',
// '}', or after a line terminator, since top-level imports need no
// semicolon under automatic semicolon insertion), which keeps
// same-line JSX text like <p>import "x"</p> from tripping. RESIDUALS,
// stated: a computed dynamic-import argument (a template with
// substitutions, a variable) is not statically resolvable and is out
// of scope; JSX text is NOT fully modeled, so JSX PROSE shaped like
// `from "<governed name>"`, or a JSX text line beginning with
// `import "<governed name>"`, would false-trip CONSERVATIVELY (loud,
// inspected by a human, never a silent pass).
function cookString(raw) {
  // Line continuations (backslash + line terminator) cook to the empty
  // string, exactly as JavaScript does, so a governed name split
  // across a continuation still compares equal.
  return raw.replace(/\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|[\s\S])/g, (_m, esc, brace, u4, x2) => {
    if (brace) return String.fromCodePoint(parseInt(brace, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (esc === '\n' || esc === '\r\n' || esc === '\r' || esc === '\u2028' || esc === '\u2029') return '';
    const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
    return simple[esc] ?? esc;
  });
}

// Significant tokens that put a following `/` in expression position
// (start of a regex, not division), per the standard heuristic.
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '^', '~']);
const REGEX_PRECEDER_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);
// A bare `import 'x'` statement can only follow one of these tokens,
// OR a line terminator (automatic semicolon insertion: top-level
// imports need no explicit semicolon, so a newline is boundary
// evidence too; tracked separately in the scan loop).
const STATEMENT_BOUNDARY = new Set(['', ';', '{', '}']);

const isLineTerm = (ch) => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';

function importSpecifiers(code) {
  const specs = [];
  const n = code.length;
  let i = 0;
  let lastWord = '';
  let lastSig = '';
  let importAtBoundary = false;
  let newlineBefore = false;
  const isSpecifierPosition = () =>
    lastSig === 'word:from' ||
    (lastSig === 'word:import' && importAtBoundary) ||
    (lastSig === '(' && (lastWord === 'import' || lastWord === 'require'));
  while (i < n) {
    const c = code[i];
    // Line comments end at ANY JavaScript line terminator, not just LF.
    if (c === '/' && code[i + 1] === '/') { while (i < n && !isLineTerm(code[i])) i++; continue; }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      let hadTerm = false;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (isLineTerm(code[i])) hadTerm = true;
        i++;
      }
      i += 2;
      // ASI: a line terminator INSIDE a multiline comment is
      // line-terminator evidence for the following token.
      if (hadTerm) newlineBefore = true;
      continue;
    }
    if (c === '/' && (REGEX_PRECEDERS.has(lastSig) || (lastSig.startsWith('word:') && REGEX_PRECEDER_WORDS.has(lastWord)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (inClass || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') inClass = true;
        else if (code[j] === ']') inClass = false;
        j++;
      }
      j++; // closing slash
      while (j < n && /[a-z]/i.test(code[j])) j++; // flags
      lastSig = 'regex';
      i = j;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      let raw = '';
      while (j < n && code[j] !== c) {
        if (code[j] === '\\') {
          // Keep a backslash-CRLF continuation together so cooking
          // removes the whole sequence, not just backslash + CR.
          if (code[j + 1] === '\r' && code[j + 2] === '\n') { raw += '\\\r\n'; j += 3; }
          else { raw += code[j] + (code[j + 1] ?? ''); j += 2; }
        } else { raw += code[j]; j++; }
      }
      const isComputedTemplate = c === '`' && raw.includes('${');
      if (!isComputedTemplate && isSpecifierPosition()) specs.push(cookString(raw));
      lastSig = 'string';
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (word === 'import') importAtBoundary = STATEMENT_BOUNDARY.has(lastSig) || newlineBefore;
      lastWord = word;
      lastSig = `word:${word}`;
      newlineBefore = false;
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      if (isLineTerm(c)) newlineBefore = true;
      i++;
      continue;
    }
    lastSig = c; // '(' keeps lastWord so `import(...)` / `require(...)` resolve
    newlineBefore = false;
    i++;
  }
  return specs;
}

function zipImportFindings(files) {
  const findings = [];
  for (const { path, code } of files) {
    for (const spec of importSpecifiers(code)) {
      if (ZIP_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        findings.push(
          `first-party module ${path} imports governed ZIP package "${spec}"; archive decoding is not a first-party concern (fflate arrives only via pmtiles); remove it or amend the governed rule`
        );
      }
    }
  }
  return findings;
}

function collectSrcFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSrcFiles(p));
    else if (/\.tsx?$/.test(entry.name)) out.push({ path: p.replaceAll('\\', '/'), code: readFileSync(p, 'utf8') });
  }
  return out;
}

function checkZipDependencyNames(depNames) {
  const findings = [];
  for (const name of depNames) {
    if (/zip|archiv/i.test(name) && !ZIP_PACKAGES.includes(name)) {
      findings.push(
        `dependency "${name}" looks like an archive/ZIP package but is not on the governed ZIP list in scripts/check-activation-budget.mjs; extend the list (or record an exemption) before merging`
      );
    }
  }
  return findings;
}

function validateBudgets(budgets) {
  const findings = [];
  const invalidKeys = new Set();
  const keys = new Set();
  for (const f of budgets) {
    const before = findings.length;
    if (!f.key || keys.has(f.key)) findings.push(`budget table: missing or duplicate feature key "${f.key}"`);
    keys.add(f.key);
    for (const col of ['activationJsGzipKb', 'networkBytes', 'requestCount']) {
      if (!isPendingOrBudget(f[col])) {
        findings.push(`feature ${f.key}: invalid ${col} (${String(f[col])}); must be a finite non-negative number or '${PENDING}'`);
      }
    }
    if (f.activationJsGzipKb === 0) {
      // The enforcement line is `total >= budget`; zero could never pass.
      findings.push(`feature ${f.key}: invalid activationJsGzipKb; an enforced JS budget must be positive (use '${PENDING}' to declare without enforcing)`);
    }
    if (!Array.isArray(f.dataAssets)) {
      findings.push(`feature ${f.key}: invalid dataAssets; must be an array (empty is fine)`);
    }
    if (!Array.isArray(f.rootModules) || f.rootModules.some((r) => typeof r !== 'string')) {
      findings.push(`feature ${f.key}: invalid rootModules; must be an array of manifest keys`);
    } else if (typeof f.activationJsGzipKb === 'number' && isPendingOrBudget(f.activationJsGzipKb) && f.rootModules.length === 0) {
      findings.push(`feature ${f.key}: a numeric activation budget needs at least one root module; filename guessing undercounts and is not supported`);
    }
    for (const a of Array.isArray(f.dataAssets) ? f.dataAssets : []) {
      if (typeof a.path !== 'string' || !isPendingOrBudget(a.maxBytes)) {
        findings.push(`feature ${f.key}: invalid dataAssets entry (${JSON.stringify(a)}); needs a path and a numeric or '${PENDING}' maxBytes`);
      }
    }
    if (findings.length > before) invalidKeys.add(f.key);
  }
  return { findings, invalidKeys };
}

/* ------------------------------------------------------------------ *
 * The checker, pure over a dist directory and a config, so the
 * self-test runs the same code path as the real tree.
 * ------------------------------------------------------------------ */
function runChecks(distDir, { forbidden, mapExempt, budgets }) {
  const findings = [];
  const report = [];
  const assets = join(distDir, 'assets');

  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    return { findings: [`${distDir}/index.html not found; run npm run build first`], report };
  }
  const manifestPath = join(distDir, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { findings: [`${manifestPath} not found; the gate needs the Vite manifest (build.manifest: true in vite.config.ts) for import edges`], report };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { findings: [`${manifestPath} is not parseable JSON; the manifest is the gate's import-edge evidence`], report };
  }

  const entryKeys = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  if (entryKeys.length === 0) {
    return { findings: [`${manifestPath} declares no entry (isEntry); not a built tree`], report };
  }
  const initialKeys = staticClosure(manifest, entryKeys);
  const initialFiles = jsFilesOf(manifest, initialKeys);
  const entryFiles = jsFilesOf(manifest, entryKeys);

  // Cross-check: the manifest's static closure and the HTML-declared
  // set must agree exactly. A closure chunk missing from the HTML
  // would still be fetched at boot (import chain) without being
  // declared; an HTML chunk outside the closure is a stale or foreign
  // preload. Either way the gate's ground truth is broken: fail.
  const htmlEager = extractHtmlEager(readFileSync(indexPath, 'utf8'));
  const closureOnly = [...initialFiles].filter((f) => !htmlEager.includes(f));
  const htmlOnly = htmlEager.filter((f) => !initialFiles.has(f));
  if (closureOnly.length || htmlOnly.length) {
    findings.push(
      `the manifest static-import closure and dist/index.html disagree on the initial set (closure-only: ${closureOnly.join(', ') || 'none'}; html-only: ${htmlOnly.join(', ') || 'none'}); the eager ground truth is broken`
    );
  }
  // Scan the union so neither side of a disagreement escapes scanning.
  const scanSet = [...new Set([...initialFiles, ...htmlEager])];

  const allowed = [];
  for (const name of scanSet) {
    const chunkPath = join(assets, name);
    const mapPath = `${chunkPath}.map`;
    if (!existsSync(mapPath)) {
      const ex = mapExempt.find((e) => e.pattern.test(name));
      if (ex) {
        const size = existsSync(chunkPath) ? statSync(chunkPath).size : Infinity;
        if (entryFiles.has(name)) {
          findings.push(`map-exempt name ${name} is the ENTRY chunk; the exemption covers only the small generated bundler runtime, never the entry`);
        } else if (size > ex.maxRawBytes) {
          findings.push(`map-exempt name ${name} is ${size} bytes, over the ${ex.maxRawBytes} byte exemption cap; a chunk this large must prove its contents with a sourcemap`);
        } else {
          report.push(`  map-exempt chunk ${name} (${size} bytes; ${ex.reason})`);
        }
      } else {
        findings.push(
          `initial chunk ${name} has no sourcemap (${mapPath}); the import-graph assertion needs build.sourcemap: true and cannot prove anything without it`
        );
      }
      continue;
    }
    const { sources, error } = validateSourcemap(mapPath);
    if (error) {
      findings.push(`initial chunk ${name} sourcemap ${error}`);
      continue;
    }
    for (const source of sources) {
      for (const rule of forbidden) {
        if (!rule.pattern.test(source)) continue;
        const allowance = (rule.allowances ?? []).find(
          (a) => a.chunkName.test(name) && a.source.test(source)
        );
        if (!allowance) {
          findings.push(
            `EAGER GRAPH VIOLATION: ${rule.name} (${source}) is bundled into initial chunk ${name}. ${rule.reason}`
          );
        } else if (
          !sources.every((s) => allowance.allowedFamily.test(s)) ||
          !sources.some((s) => allowance.requireSource.test(s))
        ) {
          findings.push(
            `allowance rejected for ${rule.name} in ${name}: the chunk's source composition is not the allowed vendor family (${allowance.reason}); a forged or widened vendor chunk does not inherit the allowance`
          );
        } else {
          allowed.push(`  allowed: ${source} in ${name} (${allowance.reason})`);
        }
      }
    }
  }
  report.push(
    closureOnly.length || htmlOnly.length
      ? `  initial static set     ${scanSet.length} chunks scanned (manifest closure ${initialFiles.size} vs index.html ${htmlEager.length}; DISAGREEMENT reported above)`
      : `  initial static set     ${scanSet.length} chunks (manifest closure = index.html declared set)`
  );
  report.push(...[...new Set(allowed)]);

  // Per-feature activation budgets. Rows that fail contract validation
  // are not measured: garbage in yields one clear validation finding,
  // never a bogus measurement on top of it.
  const { findings: budgetFindings, invalidKeys } = validateBudgets(budgets);
  findings.push(...budgetFindings);
  const distRoot = resolve(distDir);
  for (const feature of budgets) {
    if (invalidKeys.has(feature.key)) continue;
    const jsKb = feature.activationJsGzipKb;
    const roots = Array.isArray(feature.rootModules) ? feature.rootModules : [];
    const missingRoots = roots.filter((r) => !(r in manifest));
    if (missingRoots.length) {
      const msg = `feature ${feature.key}: root module(s) not in the manifest: ${missingRoots.join(', ')}`;
      if (typeof jsKb === 'number') findings.push(`${msg}; an enforced budget with a missing root is drift, not a pass`);
      else report.push(`  ${feature.key}: ${msg} (declared, not enforced)`);
    }
    const presentRoots = roots.filter((r) => r in manifest);
    if (presentRoots.length) {
      const closureKeys = staticClosure(manifest, presentRoots);
      const activationFiles = [...jsFilesOf(manifest, closureKeys)].filter((f) => !initialFiles.has(f));
      const total = activationFiles.reduce((sum, f) => sum + gz(join(assets, f)), 0);
      const line = `first-activation static closure ${kb(total)} kB gzip across ${activationFiles.length} chunk(s): ${activationFiles.join(', ') || '(none beyond the initial set)'}`;
      if (typeof jsKb === 'number' && missingRoots.length === 0) {
        if (activationFiles.length === 0) {
          findings.push(`feature ${feature.key}: the resolved first-activation set is empty (roots resolve inside the initial set or to non-JS); an enforced budget needs a nonempty lazy closure, else a typo or a feature that stopped being lazy passes silently`);
          continue;
        }
        report.push(`  ${feature.key}: ${line}; budget ${jsKb} kB`);
        if (total / 1000 >= jsKb) {
          findings.push(`feature ${feature.key} first-activation JS ${kb(total)} kB gzip is at or over its ${jsKb} kB budget (chunks: ${activationFiles.join(', ')})`);
        }
      } else {
        report.push(`  ${feature.key}: ${line}; budget ${String(jsKb)} (not yet enforced)`);
      }
    } else if (typeof jsKb !== 'number') {
      report.push(`  ${feature.key}: activation JS ${String(jsKb)}; roots undeclared (a later unit declares them)`);
    }

    for (const asset of feature.dataAssets ?? []) {
      if (typeof asset.path !== 'string' || !isPendingOrBudget(asset.maxBytes)) continue; // already a validation finding
      const assetPath = resolve(distRoot, asset.path);
      if (assetPath !== distRoot && !assetPath.startsWith(distRoot + sep)) {
        findings.push(`feature ${feature.key}: data asset path ${asset.path} escapes ${distDir}/; budgets only cover bundled assets`);
        continue;
      }
      if (asset.maxBytes === PENDING) {
        report.push(`  ${feature.key}: data asset ${asset.path} ${PENDING}`);
        continue;
      }
      if (!existsSync(assetPath)) {
        findings.push(`feature ${feature.key}: data asset ${asset.path} has an enforced size but is not in ${distDir}/`);
        continue;
      }
      const stat = statSync(assetPath);
      if (!stat.isFile()) {
        findings.push(`feature ${feature.key}: data asset ${asset.path} is not a regular file; budgets only cover bundled asset files`);
        continue;
      }
      const size = stat.size;
      report.push(`  ${feature.key}: data asset ${asset.path} ${size} bytes, max ${asset.maxBytes}`);
      if (size > asset.maxBytes) {
        findings.push(`feature ${feature.key}: data asset ${asset.path} is ${size} bytes, over its ${asset.maxBytes} byte max`);
      }
    }
  }

  return { findings, report };
}

/* ------------------------------------------------------------------ *
 * Self-test: the pinned case table. Each case is a miniature dist
 * tree; kind is a typed field (no name-based classification to
 * forge), expect is the marker EVERY finding of a fail case must
 * carry. Cases run through runChecks() itself.
 * ------------------------------------------------------------------ */
const M = (sources) => JSON.stringify({ version: 3, file: 'x.js', sources, mappings: '' });
const CLEAN_ENTRY = {
  'assets/index-test.js': 'console.log("entry");',
  'assets/index-test.js.map': M(['../../src/main.ts']),
};
const htmlWith = (...preloads) => [
  '<!doctype html>',
  ...preloads.map((p) => `<link rel="modulepreload" href="/dynamic-drought-module/assets/${p}">`),
  '<script type="module" src="/dynamic-drought-module/assets/index-test.js"></script>',
].join('\n');
const manifestWith = (entryImports, extra = {}) => JSON.stringify({
  'index.html': { file: 'assets/index-test.js', isEntry: true, imports: entryImports },
  ...extra,
});
const SHARED = { '_shared-test.js': { file: 'assets/shared-test.js' } };
const BIG_WORDS = 'export const w = ' + JSON.stringify(
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ')
) + ';';

const PENDING_COLS = { networkBytes: PENDING, requestCount: PENDING, dataAssets: [] };
const SELF_TEST_CASES = [
  {
    name: 'fail-eager-geotiff', kind: 'fail', expect: 'EAGER GRAPH VIOLATION: geotiff',
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]),
      'assets/index-test.js': 'console.log("entry+geotiff");',
      'assets/index-test.js.map': M(['../../src/main.ts', '../../node_modules/geotiff/dist-module/geotiff.js']),
    },
  },
  {
    name: 'fail-eager-landscape', kind: 'fail', expect: 'landscape',
    files: {
      'index.html': htmlWith('shared-test.js'), '.vite/manifest.json': manifestWith(['_shared-test.js'], SHARED),
      ...CLEAN_ENTRY,
      'assets/shared-test.js': 'console.log("shared");',
      'assets/shared-test.js.map': M(['../../src/util/fetch.ts', '../../src/impact/landscape.ts']),
    },
  },
  {
    name: 'fail-eager-impact-briefing-cluster', kind: 'fail', expect: 'impact briefing cluster',
    files: {
      'index.html': htmlWith('shared-test.js'), '.vite/manifest.json': manifestWith(['_shared-test.js'], SHARED),
      ...CLEAN_ENTRY,
      'assets/shared-test.js': 'console.log("shared");',
      'assets/shared-test.js.map': M([
        '../../src/ui/impact-panel-runtime.ts',
        '../../src/ui/impact-panel-runtime-primary.ts',
        '../../src/ui/impact-panel-runtime-recovery.ts',
        '../../src/state/location-identity.ts',
        '../../src/util/point-in-polygon.ts',
        '../../src/ui/claim-render.ts',
        '../../src/ui/charts.ts',
        '../../src/impact/context.ts',
        '../../src/impact/briefing.ts',
        '../../src/impact/hydrate.ts',
        '../../src/impact/sources.ts',
        '../../src/impact/enso.ts',
        '../../src/impact/evidence.ts',
        '../../src/impact/resource-catalog.ts',
        '../../src/impact/resources.ts',
        '../../src/impact/water-supply.ts',
        '../../src/impact/category-impacts.ts',
      ]),
    },
  },
  {
    name: 'fail-eager-zip', kind: 'fail', expect: 'ZIP library',
    files: {
      'index.html': htmlWith('shared-test.js'), '.vite/manifest.json': manifestWith(['_shared-test.js'], SHARED),
      ...CLEAN_ENTRY,
      'assets/shared-test.js': 'console.log("shared");',
      'assets/shared-test.js.map': M(['../../node_modules/fflate/esm/browser.js']),
    },
  },
  {
    name: 'fail-missing-map', kind: 'fail', expect: 'has no sourcemap',
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]),
      'assets/index-test.js': 'console.log("no map");',
    },
  },
  {
    name: 'fail-empty-sources', kind: 'fail', expect: 'no source evidence',
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]),
      'assets/index-test.js': 'console.log("entry");',
      'assets/index-test.js.map': M([]),
    },
  },
  {
    name: 'fail-indexed-map', kind: 'fail', expect: 'indexed source map',
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]),
      'assets/index-test.js': 'console.log("entry");',
      'assets/index-test.js.map': JSON.stringify({ version: 3, sections: [] }),
    },
  },
  {
    name: 'fail-runtime-oversize', kind: 'fail', expect: 'map-exempt',
    files: {
      'index.html': htmlWith('rolldown-runtime-test.js'),
      '.vite/manifest.json': manifestWith(['_rt.js'], { '_rt.js': { file: 'assets/rolldown-runtime-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/rolldown-runtime-test.js': 'x'.repeat(9000),
    },
  },
  {
    name: 'fail-preload-helper-oversize', kind: 'fail', expect: 'map-exempt',
    files: {
      'index.html': htmlWith('preload-helper-test.js'),
      '.vite/manifest.json': manifestWith(['_preload.js'], { '_preload.js': { file: 'assets/preload-helper-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/preload-helper-test.js': 'x'.repeat(5000),
    },
  },
  {
    name: 'fail-forged-vendor-no-pmtiles', kind: 'fail', expect: 'allowance rejected',
    files: {
      'index.html': htmlWith('pmtiles-test.js'),
      '.vite/manifest.json': manifestWith(['_pm.js'], { '_pm.js': { file: 'assets/pmtiles-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/pmtiles-test.js': 'console.log("forged vendor");',
      'assets/pmtiles-test.js.map': M(['../../node_modules/fflate/esm/browser.js']),
    },
  },
  {
    name: 'fail-vendor-firstparty-share', kind: 'fail', expect: 'allowance rejected',
    files: {
      'index.html': htmlWith('pmtiles-test.js'),
      '.vite/manifest.json': manifestWith(['_pm.js'], { '_pm.js': { file: 'assets/pmtiles-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/pmtiles-test.js': 'console.log("widened vendor");',
      'assets/pmtiles-test.js.map': M(['../../node_modules/pmtiles/dist/index.js', '../../node_modules/fflate/esm/browser.js', '../../src/main.ts']),
    },
  },
  {
    name: 'fail-manifest-html-mismatch', kind: 'fail', expect: 'disagree',
    files: {
      'index.html': htmlWith(), // shared chunk NOT declared in the HTML
      '.vite/manifest.json': manifestWith(['_shared-test.js'], SHARED),
      ...CLEAN_ENTRY,
      'assets/shared-test.js': 'console.log("undeclared");',
      'assets/shared-test.js.map': M(['../../src/util/fetch.ts']),
    },
  },
  {
    name: 'fail-no-manifest', kind: 'fail', expect: 'manifest',
    files: { 'index.html': htmlWith(), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-budget-over', kind: 'fail', expect: 'kB budget',
    budgets: [{ key: 'fx', rootModules: ['src/features/fixture.ts'], activationJsGzipKb: 0.05, ...PENDING_COLS }],
    files: {
      'index.html': htmlWith(),
      '.vite/manifest.json': manifestWith([], { 'src/features/fixture.ts': { file: 'assets/feature-big.js', isDynamicEntry: true, imports: [] } }),
      ...CLEAN_ENTRY,
      'assets/feature-big.js': BIG_WORDS,
    },
  },
  {
    name: 'fail-budget-root-missing', kind: 'fail', expect: 'root module',
    budgets: [{ key: 'fx', rootModules: ['src/features/nope.ts'], activationJsGzipKb: 10, ...PENDING_COLS }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-budget-no-roots', kind: 'fail', expect: 'root module',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: 10, ...PENDING_COLS }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-budget-invalid-value', kind: 'fail', expect: 'invalid',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: Number.NaN, ...PENDING_COLS }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-data-asset-over', kind: 'fail', expect: 'over its',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: PENDING, requestCount: PENDING, dataAssets: [{ path: 'data/big.json', maxBytes: 10 }] }],
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY,
      'data/big.json': JSON.stringify({ padding: 'x'.repeat(100) }),
    },
  },
  {
    name: 'fail-data-asset-escape', kind: 'fail', expect: 'escapes',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: PENDING, requestCount: PENDING, dataAssets: [{ path: '../outside.json', maxBytes: 10 }] }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-budget-empty-closure', kind: 'fail', expect: 'first-activation set is empty',
    budgets: [{ key: 'fx', rootModules: ['src/features/fixture.ts'], activationJsGzipKb: 5, ...PENDING_COLS }],
    files: {
      'index.html': htmlWith(),
      // The root's file IS the entry file: the closure resolves entirely inside the initial set.
      '.vite/manifest.json': manifestWith([], { 'src/features/fixture.ts': { file: 'assets/index-test.js', isDynamicEntry: true, imports: [] } }),
      ...CLEAN_ENTRY,
    },
  },
  {
    name: 'fail-budget-zero', kind: 'fail', expect: 'invalid',
    budgets: [{ key: 'fx', rootModules: ['src/features/fixture.ts'], activationJsGzipKb: 0, ...PENDING_COLS }],
    files: {
      'index.html': htmlWith(),
      '.vite/manifest.json': manifestWith([], { 'src/features/fixture.ts': { file: 'assets/feature-big.js', isDynamicEntry: true, imports: [] } }),
      ...CLEAN_ENTRY,
      'assets/feature-big.js': BIG_WORDS,
    },
  },
  {
    name: 'fail-budget-invalid-network', kind: 'fail', expect: 'invalid',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: -1, requestCount: PENDING, dataAssets: [] }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-budget-duplicate-key', kind: 'fail', expect: 'duplicate',
    budgets: [
      { key: 'fx', rootModules: [], activationJsGzipKb: PENDING, ...PENDING_COLS },
      { key: 'fx', rootModules: [], activationJsGzipKb: PENDING, ...PENDING_COLS },
    ],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-data-assets-not-array', kind: 'fail', expect: 'invalid dataAssets',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: PENDING, requestCount: PENDING, dataAssets: 'nope' }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-data-asset-missing', kind: 'fail', expect: 'is not in',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: PENDING, requestCount: PENDING, dataAssets: [{ path: 'data/absent.json', maxBytes: 10 }] }],
    files: { 'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY },
  },
  {
    name: 'fail-data-asset-directory', kind: 'fail', expect: 'regular file',
    budgets: [{ key: 'fx', rootModules: [], activationJsGzipKb: PENDING, networkBytes: PENDING, requestCount: PENDING, dataAssets: [{ path: 'data', maxBytes: 10 }] }],
    files: {
      'index.html': htmlWith(), '.vite/manifest.json': manifestWith([]), ...CLEAN_ENTRY,
      'data/inner.json': '{}',
    },
  },
  {
    name: 'pass-clean-with-lazy-geotiff', kind: 'pass',
    files: {
      'index.html': htmlWith('shared-test.js'),
      '.vite/manifest.json': manifestWith(['_shared-test.js'], {
        ...SHARED,
        'src/lazy/geo.ts': { file: 'assets/geotiff-lazy.js', isDynamicEntry: true, imports: [] },
      }),
      ...CLEAN_ENTRY,
      'assets/shared-test.js': 'console.log("shared");',
      'assets/shared-test.js.map': M(['../../src/util/fetch.ts']),
      'assets/geotiff-lazy.js': 'console.log("lazy geotiff, allowed");',
    },
  },
  {
    name: 'pass-runtime-exempt', kind: 'pass',
    files: {
      'index.html': htmlWith('rolldown-runtime-test.js'),
      '.vite/manifest.json': manifestWith(['_rt.js'], { '_rt.js': { file: 'assets/rolldown-runtime-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/rolldown-runtime-test.js': 'var e=Object.create;',
    },
  },
  {
    name: 'pass-preload-helper-exempt', kind: 'pass',
    files: {
      'index.html': htmlWith('preload-helper-test.js'),
      '.vite/manifest.json': manifestWith(['_preload.js'], { '_preload.js': { file: 'assets/preload-helper-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/preload-helper-test.js': 'const seen = new Map;',
    },
  },
  {
    name: 'pass-vendor-allowance', kind: 'pass',
    files: {
      'index.html': htmlWith('pmtiles-test.js'),
      '.vite/manifest.json': manifestWith(['_pm.js'], { '_pm.js': { file: 'assets/pmtiles-test.js' } }),
      ...CLEAN_ENTRY,
      'assets/pmtiles-test.js': 'console.log("real vendor");',
      'assets/pmtiles-test.js.map': M(['../../node_modules/pmtiles/dist/index.js', '../../node_modules/fflate/esm/browser.js']),
    },
  },
  {
    name: 'pass-budget-under-closure', kind: 'pass',
    budgets: [{ key: 'fx', rootModules: ['src/features/fixture.ts'], activationJsGzipKb: 10, ...PENDING_COLS }],
    files: {
      'index.html': htmlWith(),
      '.vite/manifest.json': manifestWith([], {
        'src/features/fixture.ts': { file: 'assets/feature-big.js', isDynamicEntry: true, imports: ['_feature-shared.js'] },
        '_feature-shared.js': { file: 'assets/feature-shared.js' },
      }),
      ...CLEAN_ENTRY,
      'assets/feature-big.js': BIG_WORDS,
      'assets/feature-shared.js': 'export const shared = true;',
    },
  },
];

// The pinned inventory: a deleted, renamed, or extra case fails the
// self-test outright; a new case must be added HERE as well.
const EXPECTED_CASE_NAMES = [
  'fail-eager-geotiff', 'fail-eager-landscape', 'fail-eager-zip',
  'fail-eager-impact-briefing-cluster',
  'fail-missing-map', 'fail-empty-sources', 'fail-indexed-map',
  'fail-runtime-oversize', 'fail-preload-helper-oversize',
  'fail-forged-vendor-no-pmtiles',
  'fail-vendor-firstparty-share', 'fail-manifest-html-mismatch',
  'fail-no-manifest', 'fail-budget-over', 'fail-budget-root-missing',
  'fail-budget-no-roots', 'fail-budget-invalid-value',
  'fail-data-asset-over', 'fail-data-asset-escape',
  'fail-budget-empty-closure', 'fail-budget-zero',
  'fail-budget-invalid-network', 'fail-budget-duplicate-key',
  'fail-data-assets-not-array', 'fail-data-asset-missing',
  'fail-data-asset-directory',
  'pass-clean-with-lazy-geotiff', 'pass-runtime-exempt',
  'pass-preload-helper-exempt',
  'pass-vendor-allowance', 'pass-budget-under-closure',
];

function runSelfTest() {
  let ok = true;
  const fails = SELF_TEST_CASES.filter((c) => c.kind === 'fail').length;
  const passes = SELF_TEST_CASES.filter((c) => c.kind === 'pass').length;
  const names = SELF_TEST_CASES.map((c) => c.name);
  if (new Set(names).size !== names.length) {
    console.error('  self-test FAIL: duplicate case names');
    ok = false;
  }
  const missing = EXPECTED_CASE_NAMES.filter((n) => !names.includes(n));
  const unexpected = names.filter((n) => !EXPECTED_CASE_NAMES.includes(n));
  if (missing.length || unexpected.length) {
    console.error(`  self-test FAIL: case inventory drifted from EXPECTED_CASE_NAMES (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
    ok = false;
  }
  const impactRules = EAGER_FORBIDDEN.filter((rule) =>
    rule.name.startsWith('impact briefing cluster ')
  );
  const impactRuleNames = impactRules.map((rule) => rule.name);
  const expectedImpactRuleNames = IMPACT_EAGER_RULE_CONTRACT.map(([name]) => name);
  if (
    impactRuleNames.length !== expectedImpactRuleNames.length ||
    impactRuleNames.some((name, i) => name !== expectedImpactRuleNames[i])
  ) {
    console.error(`  self-test FAIL: impact eager-rule identities drifted (expected: ${expectedImpactRuleNames.join(', ')}; actual: ${impactRuleNames.join(', ')})`);
    ok = false;
  }
  for (const [expectedName, source] of IMPACT_EAGER_RULE_CONTRACT) {
    const matches = impactRules
      .filter((rule) => rule.pattern.test(source))
      .map((rule) => rule.name);
    if (matches.length !== 1 || matches[0] !== expectedName) {
      console.error(`  self-test FAIL: impact eager-rule source ${source} must match only ${expectedName}; matched: ${matches.join(', ') || 'none'}`);
      ok = false;
    }
  }
  for (const c of SELF_TEST_CASES) {
    if (c.kind !== 'fail' && c.kind !== 'pass') {
      console.error(`  self-test FAIL ${c.name}: kind must be exactly 'fail' or 'pass', got ${JSON.stringify(c.kind)}`);
      ok = false;
    }
    if (c.kind === 'fail' && (typeof c.expect !== 'string' || c.expect.length === 0)) {
      console.error(`  self-test FAIL ${c.name}: fail cases need a nonempty expect marker`);
      ok = false;
    }
  }
  // Source-level ZIP import directions (pure, no dist tree needed).
  // Trip cases include the comment-interleaved legal syntax the r2
  // review demonstrated as regex bypasses.
  const mustTrip = [
    { path: 'src/x.ts', code: 'import { unzipSync } from "fflate";' },
    { path: 'src/x.ts', code: "import/* ownership-bypass */'fflate';" },
    { path: 'src/x.ts', code: "export { unzipSync } from /* ownership-bypass */ 'fflate';" },
    { path: 'src/x.ts', code: "const decoder = await import(/* ownership-bypass */ 'fflate');" },
    { path: 'src/x.ts', code: 'const z = require(/* ownership-bypass */ "fflate");' },
    { path: 'src/x.ts', code: "import sub from 'fflate/esm/browser.js';" },
    { path: 'src/x.ts', code: 'const t = await import(`fflate`);' },
    { path: 'src/x.ts', code: "import 'ffl\\u0061te';" },
    { path: 'src/x.ts', code: 'import z = require("fflate");' },
    { path: 'src/x.ts', code: "import 'pmtiles'\nimport 'fflate'\n" },
    { path: 'src/x.ts', code: "import 'ffl\\\nate';" },
    { path: 'src/x.ts', code: "import 'ffl\\\r\nate';" },
    { path: 'src/x.ts', code: "// note\rimport 'fflate'\n" },
    { path: 'src/x.ts', code: "// note\u2028import 'fflate'\n" },
    { path: 'src/x.ts', code: "const x = 1 /* a\nb */ import 'fflate'\n" },
  ];
  const mustNotTrip = [
    { path: 'src/x.ts', code: "import { PMTiles } from 'pmtiles';\nconst note = 'fflate';" },
    { path: 'src/x.ts', code: '// import "fflate"  (commented-out code is not an import)' },
    { path: 'src/x.ts', code: 'const prose = "import \'fflate\' is forbidden here";' },
    { path: 'src/x.ts', code: "const arr = ['fflate'];" },
    { path: 'src/x.ts', code: 'const re = /import "fflate"/;' },
    { path: 'src/x.tsx', code: 'export const C = () => <p>import "fflate" here</p>;' },
  ];
  for (const file of mustTrip) {
    if (zipImportFindings([file]).length !== 1) {
      console.error(`  self-test FAIL: ZIP import parse missed a real import: ${file.code}`);
      ok = false;
    }
  }
  for (const file of mustNotTrip) {
    if (zipImportFindings([file]).length !== 0) {
      console.error(`  self-test FAIL: ZIP import parse false-tripped on: ${file.code}`);
      ok = false;
    }
  }
  // Pure-function directions that need no dist tree.
  if (checkZipDependencyNames(['node-stream-zip']).length !== 0) {
    // node-stream-zip IS on the governed list; it must NOT trip.
    console.error('  self-test FAIL: governed ZIP package tripped the dependency tripwire');
    ok = false;
  }
  if (checkZipDependencyNames(['some-new-zip-lib']).length !== 1 || checkZipDependencyNames(['preact', 'vite']).length !== 0) {
    console.error('  self-test FAIL: ZIP dependency tripwire direction broken');
    ok = false;
  }

  const root = mkdtempSync(join(tmpdir(), 'ddm-activation-selftest-'));
  try {
    for (const testCase of SELF_TEST_CASES) {
      const dir = join(root, testCase.name);
      for (const [rel, content] of Object.entries(testCase.files)) {
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
      const { findings } = runChecks(dir, {
        forbidden: EAGER_FORBIDDEN,
        mapExempt: MAP_EXEMPT,
        budgets: testCase.budgets ?? [],
      });
      if (testCase.kind === 'fail') {
        if (findings.length === 0) {
          console.error(`  self-test FAIL ${testCase.name}: expected findings containing "${testCase.expect}", got none`);
          ok = false;
        } else if (!findings.every((f) => f.includes(testCase.expect))) {
          console.error(`  self-test FAIL ${testCase.name}: every finding must contain "${testCase.expect}"; got: ${findings.join(' | ')}`);
          ok = false;
        }
      } else if (findings.length > 0) {
        console.error(`  self-test FAIL ${testCase.name}: expected clean, got: ${findings.join(' | ')}`);
        ok = false;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`activation gate: self-test ${ok ? 'passed' : 'FAILED'} (${fails} fail + ${passes} pass cases, pinned in-script)`);
  return ok;
}

/* ------------------------------------------------------------------ */
const selfTestOnly = process.argv.includes('--self-test');
const distArgAt = process.argv.indexOf('--dist');
const distDir = distArgAt !== -1 ? process.argv[distArgAt + 1] : 'dist';
if (!distDir) {
  console.error('activation gate: --dist needs a directory argument');
  process.exit(1);
}

if (!runSelfTest()) process.exit(1);
if (selfTestOnly) process.exit(0);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const depFindings = checkZipDependencyNames([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
const srcImportFindings = existsSync('src') ? zipImportFindings(collectSrcFiles('src')) : [];

const { findings, report } = runChecks(distDir, {
  forbidden: EAGER_FORBIDDEN,
  mapExempt: MAP_EXEMPT,
  budgets: FEATURE_BUDGETS,
});
findings.push(...depFindings, ...srcImportFindings);

console.log(`activation gate (${distDir}/; initial set = manifest static closure cross-checked against index.html; contents from sourcemaps)`);
for (const line of report) console.log(line);
if (findings.length) {
  for (const f of findings) console.error(`activation gate: FAIL; ${f}`);
  process.exit(1);
}
console.log('activation gate: clean (initial static set free of forbidden modules; all enforced budgets met)');
