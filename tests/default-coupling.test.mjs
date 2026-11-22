import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HAZARD_CLUSTERS } from '../src/config/clusters.ts';

/**
 * Browser specs read the app's defaults instead of copying them (the
 * 2026-11-22 default-coupling audit). On 2026-11-16, 17 Drought "now" cases
 * failed because specs had hand-copied which surface a mode draws and which
 * services a default boot reads, and the product's table moved under them.
 * `tests/defaults.ts` now derives those facts from `src/config`; this guard
 * keeps a spec from writing a copy again. Four rules, over every
 * `tests/*.spec.ts` outside the pure lane (the pure lane pins the table's
 * own facts on purpose, `tests/cluster-service.spec.ts` among them):
 *
 * - G1: a string literal that names a stand-in pair's layer (`'usdm'`,
 *   `[data-legend="usdm"]`) in a test that makes a default-set boot (its own,
 *   or its describe's `beforeEach`) and never boots that layer with
 *   `layers=`. Use `DEFAULT_SURFACE` or `modeSurface()`, or boot with
 *   `layers=` and type the key. Marker: `// default-ok: <reason>`. A literal
 *   in module-scope data or a helper is not a boot's claim and is not read.
 * - G2: a `.recipes` read. The table is for `modeLayers`, which maps it
 *   through the geography. Marker: `// default-ok: <reason>`.
 * - G3: a route of a pair's own service that fulfils (no `abort(`, no
 *   `fallback(`, no `isUsdmMapFrameRead`) in a file with a default-set boot,
 *   where it also answers the map's own frame read. Use
 *   `stubUsdmBriefingReads`. Marker: `// own-stub: <why>`.
 * - G4: a blanket route of the weekly map's whole host whose handler names
 *   neither `USDM` nor `fallback(`, in a file with a default-set boot.
 *   Marker: `// own-stub: <why>`.
 *
 * A marker sits on the flagged line or the line above it. Every input is
 * derived: the pair keys from `unitedStatesStandIns`, the pure lane from
 * `playwright.config.ts`, the host from `src/config/urls.ts`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

/** Every key and value of every mode's `unitedStatesStandIns` (today `nadm-drought` and `usdm`). */
const PAIR_KEYS = [
  ...new Set(
    Object.values(HAZARD_CLUSTERS).flatMap((def) =>
      Object.entries(def.unitedStatesStandIns ?? {}).flatMap(([recipe, standIn]) => [recipe, standIn])
    )
  )
];

/** The service path fragments each pair key reads. A new pair key fails the sanity test until it is named here. */
const PAIR_SERVICES = {
  usdm: ['USDM_current', 'USDM_archive'],
  'nadm-drought': ['NADM-current']
};

const URLS_SOURCE = read('src/config/urls.ts');

/** The host that serves the weekly map, taken from its own URL in `src/config/urls.ts`. */
const USDM_HOST = /https:\/\/([^/'"]+)\/[^'"]*USDM_current\/FeatureServer/.exec(URLS_SOURCE)?.[1] ?? null;

/** The pure lane, parsed from `playwright.config.ts`'s `PURE_SPECS` block. */
function pureSpecs() {
  const config = read('playwright.config.ts');
  const block = /export const PURE_SPECS = \[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
  return new Set([...block.matchAll(/'tests\/([^']+\.spec\.ts)'/g)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// Source reading: comments and strings, with positions kept
// ---------------------------------------------------------------------------

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await'
]);

function regexCanOpen(out, i) {
  let p = i - 1;
  while (p >= 0 && /\s/.test(out[p])) p--;
  if (p < 0) return true;
  const prev = out[p];
  if (/[$\w]/.test(prev)) {
    let s = p;
    while (s >= 0 && /[$\w]/.test(out[s])) s--;
    return REGEX_PRECEDING_KEYWORDS.has(out.slice(s + 1, p + 1).join(''));
  }
  return !(prev === ')' || prev === ']' || prev === '"' || prev === "'" || prev === '`');
}

/**
 * Read one source: `code` is the same text with every comment, regexp literal
 * and string (the static parts of a template) blanked, so columns still line
 * up; `strings` lists every string literal and template static part with its
 * offset and its text. The masking follows `tests/sleep-inventory.test.mjs`'s
 * `maskNonCode`, which carries the reasoning for each case.
 */
function readSource(source) {
  const out = source.split('');
  const strings = [];
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (source[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && regexCanOpen(out, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      strings.push({ start: i + 1, value: source.slice(i + 1, j) });
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let segment = j;
      let depth = 0;
      while (j < n) {
        if (depth === 0) {
          if (source[j] === '\\') {
            j += 2;
            continue;
          }
          if (source[j] === '`') {
            strings.push({ start: segment, value: source.slice(segment, j) });
            blank(segment, j);
            j++;
            break;
          }
          if (source[j] === '$' && source[j + 1] === '{') {
            strings.push({ start: segment, value: source.slice(segment, j) });
            blank(segment, j);
            depth = 1;
            j += 2;
            continue;
          }
          j++;
          continue;
        }
        if (source[j] === '{') depth++;
        else if (source[j] === '}') {
          depth--;
          if (depth === 0) segment = j + 1;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return { code: out.join(''), strings };
}

function matchingParenEnd(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '(') depth++;
    else if (code[j] === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return code.length;
}

/** Every `test(...)`-family call with a literal title, as `{start, end, kind}`. */
function testScopes(source, code) {
  const scopes = [];
  for (const m of code.matchAll(/\btest(\s*\.\s*(only|skip|describe|step|beforeEach|fixme))?\s*\(/g)) {
    if (m.index > 0 && /[$\w.]/.test(code[m.index - 1])) continue;
    const open = m.index + m[0].length - 1;
    scopes.push({ start: m.index, end: matchingParenEnd(code, open), kind: m[2] ?? 'test' });
  }
  return scopes;
}

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

function marked(lines, line, marker) {
  return [lines[line - 1], lines[line - 2]].some((text) => text !== undefined && text.includes(marker));
}

/** The keys a text's `layers=` lists name, literal or encoded commas. */
function layersNamed(text) {
  const keys = new Set();
  for (const m of text.matchAll(/layers=([^&'"`\s)]*)/g)) {
    for (const key of m[1].split(/,|%2C/i)) if (key) keys.add(key);
  }
  return keys;
}

/**
 * A default-set boot: a `gotoApp` whose address is absent or a whole literal
 * that lists no `layers=` and names no mode but Drought. A computed address is
 * not counted (the count is a floor).
 */
function hasDefaultBoot(source, code) {
  for (const m of code.matchAll(/\bgotoApp\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const call = source.slice(open + 1, matchingParenEnd(code, open) - 1);
    const callCode = code.slice(open + 1, matchingParenEnd(code, open) - 1);
    const comma = callCode.indexOf(',');
    if (comma < 0) return true;
    const rest = call.slice(comma + 1).trim();
    const literal = /^(['"])([^'"]*)\1/.exec(rest)?.[2] ?? /^`([^`$]*)`/.exec(rest)?.[1];
    if (literal === undefined) {
      if (rest === '' || rest.startsWith('{') || rest.startsWith('undefined')) return true;
      continue;
    }
    if (/[?&]layers=/.test(literal)) continue;
    const cluster = /[?&]cluster=([^&]*)/.exec(literal)?.[1];
    if (cluster !== undefined && cluster !== 'drought') continue;
    return true;
  }
  return false;
}

/**
 * A blanket route whose host is interpolated over the weekly map's own domain
 * (`https://${host}.arcgis.com/**` in a loop that names `services5`).
 */
function blanketComputedHost(host, pattern) {
  const domain = host.slice(host.indexOf('.'));
  return pattern.includes('${') && pattern.includes(`${domain}/**`);
}

/** Scan one spec's source; returns `{rule, line, text}` for every unmarked hit. */
function scanSpec(rawSource, { pairKeys = PAIR_KEYS, services = PAIR_SERVICES, host = USDM_HOST } = {}) {
  const source = rawSource.replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const { code, strings } = readSource(source);
  const scopes = testScopes(source, code);
  const defaultBoot = hasDefaultBoot(source, code);
  const hits = [];
  const hit = (rule, offset) => {
    const line = lineOf(source, offset);
    hits.push({ rule, line, text: lines[line - 1].trim() });
  };

  // G1: a pair key typed as a literal.
  for (const { start, value } of strings) {
    for (const key of pairKeys) {
      const attribute = new RegExp(`=["']?${key.replace(/[-]/g, '\\-')}["']?\\]`);
      if (value !== key && !attribute.test(value)) continue;
      const line = lineOf(source, start);
      if (marked(lines, line, '// default-ok:')) continue;
      const containing = scopes.filter((s) => s.start <= start && start < s.end);
      const inTest = containing.filter((s) => s.kind === 'test' || s.kind === 'only' || s.kind === 'skip' || s.kind === 'fixme');
      inTest.sort((a, b) => a.end - a.start - (b.end - b.start));
      const own = inTest[0];
      const describes = containing.filter((s) => s.kind === 'describe');
      describes.sort((a, b) => a.end - a.start - (b.end - b.start));
      const outer = describes[0] ?? { start: 0, end: source.length };
      const hooks = scopes.filter(
        (s) => s.kind === 'beforeEach' && s.start >= outer.start && s.end <= outer.end
      );
      const boots = [own, ...hooks].filter(Boolean);
      const meansThisLayer = boots.some((s) => layersNamed(source.slice(s.start, s.end)).has(key));
      const defaultBooted = boots.some((s) => hasDefaultBoot(source.slice(s.start, s.end), code.slice(s.start, s.end)));
      if (defaultBooted && !meansThisLayer) hit('G1', start);
    }
  }

  // G2: the mode table's recipes read directly.
  for (const m of code.matchAll(/\.recipes\b/g)) {
    if (!marked(lines, lineOf(source, m.index), '// default-ok:')) hit('G2', m.index);
  }

  // G3 and G4: own routes of the pair's services, or of the weekly map's whole host.
  if (defaultBoot) {
    const fragments = Object.values(services).flat();
    for (const m of code.matchAll(/\.route\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const end = matchingParenEnd(code, open);
      const call = source.slice(open, end);
      const callCode = code.slice(open, end);
      const comma = callCode.indexOf(',');
      const pattern = comma < 0 ? call : call.slice(0, comma);
      const handler = comma < 0 ? '' : call.slice(comma);
      const line = lineOf(source, m.index);
      if (marked(lines, line, '// own-stub:')) continue;
      if (fragments.some((fragment) => pattern.includes(fragment))) {
        if (/\babort\(|\bfallback\(|isUsdmMapFrameRead/.test(handler)) continue;
        hit('G3', m.index);
      } else if (host !== null && (pattern.includes(`${host}/**`) || blanketComputedHost(host, pattern))) {
        if (/USDM|\bfallback\(/.test(handler)) continue;
        hit('G4', m.index);
      }
    }
  }
  return hits;
}

const MESSAGES = {
  G1: 'names the default surface by id; use DEFAULT_SURFACE or modeSurface(), or boot with layers=',
  G2: 'reads the mode table recipes; use modeLayers() or modeSurface(), which map them through the geography',
  G3: 'stubs a default surface service in a file with a default boot; use stubUsdmBriefingReads, or mark it // own-stub:',
  G4: 'stubs the weekly map host whole in a file with a default boot; scope the route, or mark it // own-stub:'
};

function scanTree() {
  const pure = pureSpecs();
  const found = [];
  for (const file of readdirSync(__dirname).filter((name) => name.endsWith('.spec.ts')).sort()) {
    if (pure.has(file)) continue;
    for (const site of scanSpec(readFileSync(path.join(__dirname, file), 'utf8'))) {
      found.push(`${file}:${site.line} ${site.rule} ${MESSAGES[site.rule]}: ${site.text}`);
    }
  }
  return found;
}

test('the derived inputs are present: pair keys, their services in urls.ts, the pure lane, the weekly map host', () => {
  assert.ok(PAIR_KEYS.length > 0, 'unitedStatesStandIns names at least one pair');
  for (const key of PAIR_KEYS) {
    assert.ok(PAIR_SERVICES[key]?.length, `${key} is a stand-in pair key: name its service fragments in PAIR_SERVICES`);
    for (const fragment of PAIR_SERVICES[key]) {
      assert.ok(URLS_SOURCE.includes(fragment), `${fragment} no longer appears in src/config/urls.ts`);
    }
  }
  assert.ok(USDM_HOST, 'the weekly map host is read from src/config/urls.ts');
  const pure = pureSpecs();
  assert.ok(pure.size > 10, 'the PURE_SPECS block parses');
  assert.ok(pure.has('cluster-service.spec.ts'), 'the stand-in rule stays pinned in the pure lane');
});

test('no browser spec copies the default surface, the recipes or the default stubs', () => {
  assert.deepEqual(scanTree(), []);
});

// ---------------------------------------------------------------------------
// Self-tests: each rule fires, and each exemption holds
// ---------------------------------------------------------------------------

const opts = { pairKeys: ['usdm', 'nadm-drought'], services: PAIR_SERVICES, host: 'services5.arcgis.com' };
const rules = (source) => scanSpec(source, opts).map((h) => `${h.rule}:${h.line}`);

test('self-test G1: a typed surface after a default boot fires; a layers= boot, a marker and a comment do not', () => {
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await gotoApp(page);\n  await waitForLayerSettled(page, 'usdm');\n});"), ['G1:3']);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await gotoApp(page, '?view=console');\n  await expect(page.locator('[data-legend=\"usdm\"]')).toBeVisible();\n});"), ['G1:3']);
  assert.deepEqual(rules("test.describe('d', () => {\n  test.beforeEach(async ({ page }) => { await gotoApp(page); });\n  test('a', async ({ page }) => {\n    await waitForLayerSettled(page, 'usdm');\n  });\n});"), ['G1:4']);
  assert.deepEqual(rules("const FIXTURE = { productKey: 'usdm' };\ntest('a', async ({ page }) => {\n  await gotoApp(page, `?select=${place}`);\n  await waitForLayerSettled(page, 'usdm');\n});"), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await gotoApp(page, '?layers=usdm,aiannh');\n  await waitForLayerSettled(page, 'usdm');\n});"), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  // default-ok: a hand toggle of this layer\n  await layerCheckbox(page, 'usdm').click();\n});"), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  // the surface is 'usdm' here\n  await gotoApp(page);\n});"), []);
  assert.deepEqual(rules("test.describe('d', () => {\n  test.beforeEach(async ({ page }) => { await gotoApp(page, '?layers=usdm'); });\n  test('a', async ({ page }) => {\n    await waitForLayerSettled(page, 'usdm');\n  });\n});"), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await gotoApp(page, `?layers=${DEFAULT_SURFACE}`);\n});"), []);
});

test('self-test G2: a recipes read fires unless marked', () => {
  assert.deepEqual(rules('const r = HAZARD_CLUSTERS.drought.recipes.current;'), ['G2:1']);
  assert.deepEqual(rules('// default-ok: pins the raw table\nconst r = HAZARD_CLUSTERS.drought.recipes.current;'), []);
});

test('self-test G3: a fulfilling route of the pair services fires only beside a default boot', () => {
  const route = "await page.route('**/USDM_current/**', (route) => route.fulfill({ body: '{}' }));";
  assert.deepEqual(rules(`test('a', async ({ page }) => {\n  ${route}\n  await gotoApp(page, '?view=console');\n});`), ['G3:2']);
  assert.deepEqual(rules(`test('a', async ({ page }) => {\n  ${route}\n  await gotoApp(page, '?layers=usdm');\n});`), []);
  assert.deepEqual(rules(`test('a', async ({ page }) => {\n  ${route}\n  await gotoApp(page, '?cluster=heat');\n});`), []);
  assert.deepEqual(rules(`test('a', async ({ page }) => {\n  // own-stub: a map frame fixture\n  ${route}\n  await gotoApp(page);\n});`), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await page.route('**/NADM-current.geojson', (route) => route.abort());\n  await gotoApp(page);\n});"), []);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await page.route('**/USDM_current/**', (route) => isUsdmMapFrameRead(route.request().method(), new URL(route.request().url())) ? route.fallback() : route.fulfill({}));\n  await gotoApp(page);\n});"), []);
});

test('self-test G4: a blanket route of the weekly map host fires beside a default boot unless it names USDM or falls back', () => {
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await page.route('https://services5.arcgis.com/**', (route) => route.fulfill({ body: '{}' }));\n  await gotoApp(page);\n});"), ['G4:2']);
  assert.deepEqual(rules("test('a', async ({ page }) => {\n  await page.route('https://services5.arcgis.com/**', (route) => route.request().url().includes('USDM') ? route.fallback() : route.fulfill({}));\n  await gotoApp(page);\n});"), []);
  // The layer-cancellation shape: the host interpolated in a loop.
  assert.deepEqual(rules("async function stubCommon(page) {\n  for (const host of ['services5', 'services3']) {\n    await page.route(`https://${host}.arcgis.com/**`, (route) => route.fulfill({ body: '{}' }));\n  }\n}\ntest('a', async ({ page }) => {\n  await gotoApp(page, '?view=console');\n});"), ['G4:3']);
});
