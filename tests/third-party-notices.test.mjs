// E2-3 NOTICES: the third-party notices file exists, names every bundled
// runtime dependency with its licence, says what the ENSO flowing paths copy
// (nothing), and ships in the published build.
//
// Vite 8 (Rolldown) drops every /*! */ legal comment when it minifies, so a
// licence header in src would not reach dist/assets. The notices file is
// therefore also served from public/, and the build test below asserts that
// copy is in dist/ and identical to the root file.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES = join(root, 'THIRD-PARTY-NOTICES.md');
const PUBLIC_COPY = join(root, 'public', 'THIRD-PARTY-NOTICES.md');

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const readNotices = () => readFileSync(NOTICES, 'utf8');

/** Every file under a directory, as forward-slash paths relative to the repo root. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

/** True when the text carries a /*! legal comment that names the ISC or MIT licence. */
export function hasIscOrMitHeader(text) {
  const comments = text.match(/\/\*![\s\S]*?\*\//g) ?? [];
  return comments.some((c) => /\b(?:ISC|MIT)\b/i.test(c));
}

test('package.json and package-lock.json name no deck.gl, @deck.gl/*, weatherlayers-gl or @weatherlayers/* package', () => {
  const banned = /^(?:deck\.gl|@deck\.gl\/.+|weatherlayers-gl|@weatherlayers\/.+)$/;
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at >= 0) names.add(path.slice(at + 'node_modules/'.length));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(entry[field] ?? {})) names.add(name);
    }
  }
  const hits = [...names].filter((name) => banned.test(name));
  assert.deepEqual(hits, [], `forbidden packages named: ${hits.join(', ')}`);
});

test('every runtime dependency in package.json appears with its licence id', () => {
  const text = readNotices();
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const names = Object.keys(pkg.dependencies ?? {});
  assert.ok(names.length > 0, 'package.json lists no runtime dependencies');
  for (const name of names) {
    const entry = lock.packages?.[`node_modules/${name}`];
    assert.ok(entry?.license, `package-lock.json has no licence id for ${name}`);
    // One list line per package: its name in backticks, then its licence id.
    const line = text.split('\n').find((l) => l.includes(`\`${name}\``) && l.includes('|'));
    assert.ok(line, `THIRD-PARTY-NOTICES.md has no table row for ${name}`);
    assert.ok(
      line.includes(entry.license),
      `the row for ${name} must carry its licence id ${entry.license}: ${line}`,
    );
    assert.ok(
      text.includes(`## ${name}`),
      `THIRD-PARTY-NOTICES.md has no licence section headed "## ${name}"`,
    );
  }
});

test('every source file carrying a /*! ISC or MIT header is listed', () => {
  // The scanner must see a header, or an empty source set would pass for free.
  assert.equal(hasIscOrMitHeader('/*! Copyright (c) 2020 Someone, ISC License */\nx()'), true);
  assert.equal(hasIscOrMitHeader('/*! Released under the MIT licence */'), true);
  assert.equal(hasIscOrMitHeader('/* MIT, but not a legal comment */'), false);
  assert.equal(hasIscOrMitHeader('/*! Apache-2.0 */'), false);

  const text = readNotices();
  const files = walk(join(root, 'src')).filter((f) => /\.(?:ts|tsx|js|mjs|css|glsl|vert|frag)$/.test(f));
  const carrying = files.filter((f) => hasIscOrMitHeader(readFileSync(join(root, f), 'utf8')));
  for (const f of carrying) {
    assert.ok(text.includes(`\`${f}\``), `${f} carries a /*! ISC or MIT header and is not listed`);
  }
});

test('the flow section says no mapbox/webgl-wind or cambecc/earth code is copied and states the verbatim header rule', () => {
  const text = readNotices();
  assert.match(text, /mapbox\/webgl-wind/);
  assert.match(text, /\(ISC\)/);
  assert.match(text, /cambecc\/earth/);
  assert.match(text, /\(MIT\)/);
  assert.match(text, /design reference/i);
  assert.match(text, /No code from mapbox\/webgl-wind or cambecc\/earth is copied/);
  assert.match(text, /verbatim, with its `\/\*! \*\/` header/);
});

test('the file contains no planning path', () => {
  // The forbidden set of scripts/check-public-tree.mjs, as text patterns.
  const forbidden = [
    /\.planning[\\/]/i,
    /(?:^|[^A-Za-z0-9_-])planning[\\/]/i,
    /HANDOFF/i,
    /\bAGENTS\.md\b/,
    /\bCLAUDE\.md\b/,
    /\bROADMAP\b/,
    /\bI:[\\/]/,
    /\bC:[\\/]/,
    /\bH:[\\/]/,
  ];
  const files = [NOTICES];
  if (existsSync(PUBLIC_COPY)) files.push(PUBLIC_COPY);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative(root, file)} matches ${pattern}`);
    }
    assert.ok(!text.includes('\u2014'), `${relative(root, file)} contains U+2014`);
  }
});

test('the notices file opens with the DRAFT wording marker', () => {
  const first = readNotices().split('\n', 1)[0];
  assert.equal(
    first,
    "<!-- DRAFT wording (DR-177): the whole file is for the owner's read-back at the landing that carries E2 -->",
  );
});

test('public/THIRD-PARTY-NOTICES.md is a byte-identical copy of the root file', () => {
  assert.ok(existsSync(PUBLIC_COPY), 'public/THIRD-PARTY-NOTICES.md is missing');
  assert.equal(readFileSync(PUBLIC_COPY, 'utf8'), readNotices());
});

const distDir = join(root, 'dist');
const hasDist = existsSync(join(distDir, 'assets')) && existsSync(join(distDir, 'index.html'));
const skipNoDist = hasDist ? false : 'no dist/: run `npm run build` first (this test runs in check:all after the build)';

test(
  'after vite build, every /*! licence comment in src survives in dist/assets, or the notices file ships from public/',
  { skip: skipNoDist },
  () => {
    // Settled 2026-10-05 against Vite 8.1.3: the minifier drops /*! */ comments,
    // so the notices file must ship from public/. Prove the shipped copy first.
    const shipped = join(distDir, 'THIRD-PARTY-NOTICES.md');
    assert.ok(existsSync(shipped), 'dist/THIRD-PARTY-NOTICES.md is missing: it must ship from public/');
    assert.equal(readFileSync(shipped, 'utf8'), readNotices());

    // Any /*! licence comment in src must either survive in dist/assets or be
    // listed in the notices file (the copy in dist/ is what then carries it).
    const text = readNotices();
    const files = walk(join(root, 'src')).filter((f) => /\.(?:ts|tsx|js|mjs)$/.test(f));
    const bundle = readdirSync(join(distDir, 'assets'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(distDir, 'assets', f), 'utf8'))
      .join('\n');
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf8');
      for (const comment of src.match(/\/\*![\s\S]*?\*\//g) ?? []) {
        if (!/\b(?:ISC|MIT|BSD|Apache|licen[cs]e|copyright)\b/i.test(comment)) continue;
        assert.ok(
          bundle.includes(comment) || text.includes(`\`${f}\``),
          `${f}: a /*! licence comment neither survives in dist/assets nor is listed in the notices file`,
        );
      }
    }
  },
);

test(
  'after vite build, every node_modules package in the source maps is named in the notices file',
  { skip: skipNoDist },
  () => {
    const text = readNotices();
    const found = new Set();
    for (const f of readdirSync(join(distDir, 'assets'))) {
      if (!f.endsWith('.map')) continue;
      const map = JSON.parse(readFileSync(join(distDir, 'assets', f), 'utf8'));
      for (const source of map.sources ?? []) {
        const path = source.split('\\').join('/');
        const at = path.lastIndexOf('node_modules/');
        if (at < 0) continue;
        const parts = path.slice(at + 'node_modules/'.length).split('/');
        found.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
      }
    }
    assert.ok(found.size > 0, 'no node_modules package found in the source maps; the sourcemap setting changed');
    for (const name of found) {
      assert.ok(text.includes(`\`${name}\``), `${name} reaches dist/ and is not named in THIRD-PARTY-NOTICES.md`);
    }
  },
);
