import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYER_DEFS, LAYER_KEYS } from '../src/config/layers';
import { PRODUCTS, PRODUCT_KEYS } from '../src/config/products';
import { URLS } from '../src/config/urls';
import { MATRIX_LANE_KEYS } from '../src/impact/matrix';

/**
 * DDM-P14-T05 microtask 3: the runtime check that keeps `PRODUCTS`
 * (src/config/products.ts), `LAYER_DEFS` (src/config/layers.ts) and every
 * `makeClaim` construction site in `src/impact/*.ts` honest against one
 * another. `tsc` already enforces the two required `product` fields at
 * compile time; this is the runtime belt the design calls for, plus the
 * three informational lists (never a failure) named in the design.
 *
 * Browser-free (`verify:pure`, DR-052 b): no fixture, no boot helper, only
 * imports from src/ and assertions on returned values, plus a read-only
 * scan of the source tree on disk.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Copied from `tests/pure-lane-inventory.test.mjs`'s `stripComments`
 * (DDM-P15-T08), not imported: a `.ts` spec under this project's module
 * resolution cannot cleanly import a named export from a sibling `.test.mjs`
 * node:test module, so the two small regexes are duplicated here instead.
 * Keep the two copies in step by hand if either changes.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `.ts`/`.tsx` file under `dir`, relative to the repo root, forward-slashed. */
async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(full)));
    } else if (entry.isFile() && SRC_EXTENSIONS.has(extname(entry.name))) {
      files.push(relative(ROOT, full).replace(/\\/g, '/'));
    }
  }
  return files;
}

/**
 * Finds the index of the `)` (or `}`/`]`, but for a `makeClaim(` call this
 * is always a `)`) that closes the bracket opened at `source[openIndex]`,
 * skipping over string and template-literal contents so a paren inside a
 * quoted issuer string (for example `"USDM Data Services (NDMC)"`) cannot
 * miscount the depth. Returns -1 if the source ends before the bracket
 * closes (an unbalanced call, which the caller treats as a hard failure,
 * not a silent skip).
 */
function findMatchingClose(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A `makeClaim(` call site: which file, which real (unstripped) line, and whether its argument literal names `product:` (directly, or through a `...name` spread of a same-file declaration that itself names `product:`) before the matching close. */
interface MakeClaimSite {
  readonly file: string;
  readonly line: number;
  readonly hasProduct: boolean;
}

/**
 * A call to `makeClaim(`, never the `export function makeClaim(` declaration
 * itself (the only other thing this literal string matches in the tree, in
 * `src/impact/evidence.ts`).
 */
const MAKE_CLAIM_CALL = /(?<!function )\bmakeClaim\s*\(/g;

/**
 * A `const NAME = { ... }` object-literal declaration, optionally typed
 * (`const NAME: Type = {`); the `as const`/`satisfies X` a declaration may
 * carry after its closing `}` is irrelevant here (this only needs the `{`
 * to hand to `findMatchingClose`).
 */
const OBJECT_DECLARATION = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g;

/**
 * The names of every `const NAME = { ... }` object literal in one
 * (comment-stripped) file whose OWN literal, within its own matching braces,
 * names `product:` (director's follow-up, 2026-09-12: microtask 2 built
 * `shared`/`usdmShared`/`alertShared`/`wsShared` objects in `sources.ts` and
 * `water-supply.ts` that carry `product` once and get spread, `...name`,
 * into more than one `makeClaim(` call, rather than repeating the field at
 * every call site). Scoped per file and per declaration on purpose: a
 * `product:` written anywhere else in the file, or in an unrelated
 * declaration, must never make an unrelated spread look covered.
 */
function declaredProductObjectNames(stripped: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(OBJECT_DECLARATION.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped))) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingClose(stripped, openIndex);
    if (closeIndex === -1) continue; // not a makeClaim( call; not this scan's concern to fail on
    const literal = stripped.slice(openIndex, closeIndex + 1);
    if (/\bproduct\s*:/.test(literal)) {
      names.add(match[1]);
    }
  }
  return names;
}

/** Every top-level `...name` spread inside one `makeClaim(` call's argument literal (its dotted continuation, `...name.sub`, still resolves to `name`: the declaration is what is checked, not the sub-path spread from it). */
function spreadNames(args: string): string[] {
  return [...args.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
}

/**
 * Every `makeClaim(` call in one file. Matched twice on purpose: once
 * against the raw file (for real line numbers a reader can open), once
 * against the comment-stripped copy (so a call mentioned only in a comment,
 * or a `product:` mentioned only in a comment near a real call, cannot
 * change the count or the pass/fail read). The two match counts must agree;
 * if they do not, something in a comment reads exactly like a call, which
 * is worth a loud failure rather than a silently wrong pairing.
 *
 * A site passes when its own argument literal names `product:` directly, OR
 * when it spreads (`...name`) a same-file `const name = { ... }` declaration
 * whose own literal names `product:` (`productObjectNames`, built once per
 * file). It does NOT pass merely because `product:` appears somewhere else
 * in the file: only a direct field or a resolved spread counts.
 */
function locateMakeClaimSites(
  file: string,
  original: string,
  stripped: string,
  productObjectNames: ReadonlySet<string>
): MakeClaimSite[] {
  const originalOffsets: number[] = [];
  const originalPattern = new RegExp(MAKE_CLAIM_CALL.source, 'g');
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = originalPattern.exec(original))) {
    originalOffsets.push(rawMatch.index);
  }

  const sites: MakeClaimSite[] = [];
  const strippedPattern = new RegExp(MAKE_CLAIM_CALL.source, 'g');
  let strippedMatch: RegExpExecArray | null;
  let i = 0;
  while ((strippedMatch = strippedPattern.exec(stripped))) {
    const openIndex = strippedMatch.index + strippedMatch[0].length - 1;
    const closeIndex = findMatchingClose(stripped, openIndex);
    if (closeIndex === -1) {
      throw new Error(`${file}: unbalanced makeClaim( call (comment-stripped offset ${openIndex})`);
    }
    const args = stripped.slice(openIndex, closeIndex + 1);
    const originalOffset = originalOffsets[i];
    if (originalOffset === undefined) {
      throw new Error(
        `${file}: the comment-stripped copy has more makeClaim( occurrences than the raw file; investigate`
      );
    }
    const line = original.slice(0, originalOffset).split('\n').length;
    const hasDirectProduct = /\bproduct\s*:/.test(args);
    const hasProductViaSpread = spreadNames(args).some((name) => productObjectNames.has(name));
    sites.push({ file, line, hasProduct: hasDirectProduct || hasProductViaSpread });
    i++;
  }
  if (i !== originalOffsets.length) {
    throw new Error(
      `${file}: the raw file has ${originalOffsets.length} makeClaim( occurrences but the comment-stripped copy has ${i}; a comment must read exactly like a call, investigate`
    );
  }
  return sites;
}

/** The count pinned 2026-09-12 (DDM-P14-T05 microtask 3): a genuinely new construction site should move this number, not silence the assertion below it. */
const EXPECTED_MAKE_CLAIM_SITES = 28;

test('every LayerDef in LAYER_DEFS carries a product field naming a PRODUCT_KEYS member', () => {
  const productKeySet = new Set<string>(PRODUCT_KEYS);
  for (const def of LAYER_DEFS) {
    expect(typeof def.product, `LayerDef "${def.key}" has no product field (src/config/layers.ts)`).toBe('string');
    expect(
      productKeySet.has(def.product),
      `LayerDef "${def.key}" names product "${def.product}", which is not a PRODUCT_KEYS member (src/config/products.ts)`
    ).toBe(true);
  }
});

test('every PRODUCTS entry is keyed by its own .key, and that key is a PRODUCT_KEYS member', () => {
  const productKeySet = new Set<string>(PRODUCT_KEYS);
  for (const [recordKey, def] of Object.entries(PRODUCTS)) {
    expect(def.key, `PRODUCTS["${recordKey}"] is stored under a different string than its own .key field`).toBe(
      recordKey
    );
    expect(productKeySet.has(def.key), `PRODUCTS entry "${def.key}" is not in PRODUCT_KEYS`).toBe(true);
  }
});

test('every product endpointKey, when set, names a real key of URLS', () => {
  const urlsKeySet = new Set<string>(Object.keys(URLS));
  for (const product of Object.values(PRODUCTS)) {
    if (product.endpointKey === null) continue;
    expect(
      urlsKeySet.has(product.endpointKey),
      `product "${product.key}" names endpointKey "${product.endpointKey}", which is not a key of URLS (src/config/urls.ts)`
    ).toBe(true);
  }
});

test('every product layerKey, when set, is a LAYER_KEYS member whose own LayerDef names this product back', () => {
  const layerKeySet = new Set<string>(LAYER_KEYS);
  const defByKey = new Map(LAYER_DEFS.map((def) => [def.key, def] as const));
  for (const product of Object.values(PRODUCTS)) {
    if (product.layerKey === null) continue;
    expect(
      layerKeySet.has(product.layerKey),
      `product "${product.key}" names layerKey "${product.layerKey}", which is not in LAYER_KEYS (src/config/layers.ts)`
    ).toBe(true);
    const def = defByKey.get(product.layerKey);
    expect(
      def?.product,
      `LayerDef "${product.layerKey}" does not name product "${product.key}" back (its own product field is "${String(
        def?.product
      )}")`
    ).toBe(product.key);
  }
});

test('every product lane, when set, is a declared lane in MATRIX_LANE_KEYS', () => {
  const laneSet = new Set<string>(MATRIX_LANE_KEYS);
  for (const product of Object.values(PRODUCTS)) {
    if (product.lane === null) continue;
    expect(
      laneSet.has(product.lane),
      `product "${product.key}" names lane "${product.lane}", which is not in MATRIX_LANE_KEYS (src/impact/matrix.ts)`
    ).toBe(true);
  }
});

test(
  `every makeClaim( call in src/impact/*.ts names product: before its matching close (pinned count ` +
    `${EXPECTED_MAKE_CLAIM_SITES}: DDM-P14-T05 microtask 3, 2026-09-12; a genuinely new construction site ` +
    'should move this number, not silence the assertion)',
  async () => {
    const files = (await listSourceFiles(join(ROOT, 'src', 'impact'))).filter((file) =>
      file.startsWith('src/impact/')
    );
    const allSites: MakeClaimSite[] = [];
    for (const file of files) {
      const original = await readFile(join(ROOT, file), 'utf8');
      const stripped = stripComments(original);
      const productObjectNames = declaredProductObjectNames(stripped);
      allSites.push(...locateMakeClaimSites(file, original, stripped, productObjectNames));
    }
    expect(
      allSites.length,
      `found ${allSites.length} makeClaim( call sites in src/impact/*.ts, expected ${EXPECTED_MAKE_CLAIM_SITES} ` +
        '(pinned; see the comment above this test)'
    ).toBe(EXPECTED_MAKE_CLAIM_SITES);
    const missing = allSites.filter((site) => !site.hasProduct).map((site) => `${site.file}:${site.line}`);
    expect(
      missing,
      'these makeClaim( call sites do not name product: before their matching close ' +
        `(DDM-P14-T05 microtask 2 adds it to every site):\n${missing.join('\n')}`
    ).toEqual([]);
  }
);

test('prints the day-one product-catalog inventory (informational only, never fails)', async () => {
  const productsWithNoVisualization = Object.values(PRODUCTS)
    .filter((product) => product.layerKey === null)
    .map((product) => product.key)
    .sort();
  console.log(
    `product-catalog: products with no visualization (${productsWithNoVisualization.length}): ` +
      productsWithNoVisualization.join(', ')
  );

  const layersWithNoClaim = LAYER_DEFS.filter((def) => {
    const product = PRODUCTS[def.product];
    return product !== undefined && product.lane === null;
  })
    .map((def) => def.key)
    .sort();
  console.log(`product-catalog: layers with no claim (${layersWithNoClaim.length}): ` + layersWithNoClaim.join(', '));

  const srcFiles = await listSourceFiles(join(ROOT, 'src'));
  const strippedSources: string[] = [];
  for (const file of srcFiles) {
    strippedSources.push(stripComments(await readFile(join(ROOT, file), 'utf8')));
  }
  const wholeSource = strippedSources.join('\n');
  const endpointKeysWithNoReader = Object.keys(URLS)
    .filter((key) => {
      const dotted = new RegExp(`\\bURLS\\.${key}\\b`);
      const bootEquivalent = new RegExp(`\\bBOOT_URLS\\.${key}\\b`);
      return !dotted.test(wholeSource) && !bootEquivalent.test(wholeSource);
    })
    .sort();
  console.log(
    `product-catalog: endpoint keys with no reader (${endpointKeysWithNoReader.length}): ` +
      endpointKeysWithNoReader.join(', ')
  );
});
