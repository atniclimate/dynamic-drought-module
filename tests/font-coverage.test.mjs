import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('src/styles/app.css', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('public/fonts/MANIFEST.json', root), 'utf8'));
const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(([, block]) => {
  const value = key => block.match(new RegExp(`${key}\\s*:\\s*([^;]+);`))?.[1].trim();
  const url = value('src')?.match(/url\(['"]?([^'"\)]+)['"]?\)/)?.[1];
  return { family: value('font-family')?.replace(/['"]/g, ''), url, range: value('unicode-range'), weight: value('font-weight') };
});
function inRange(cp, range) {
  if (!range) return true;
  return range.split(',').some(part => {
    const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-');
    return cp >= parseInt(lo, 16) && cp <= parseInt(hi ?? lo, 16);
  });
}
function supports(face, cp) {
  const file = face.url?.split('/').at(-1);
  const record = manifest.files.find(entry => entry.file === file);
  assert.ok(record, `missing cmap receipt for ${file}`);
  return inRange(cp, face.range) && record.codepoints.some(code => parseInt(code.slice(2), 16) === cp);
}
test('every declared local font has a hash-bound cmap and adjacent licence receipt', () => {
  for (const face of faces) {
    assert.match(face.url ?? '', /^\/fonts\/[^/]+\.woff2$/);
    const file = face.url.split('/').at(-1);
    const record = manifest.files.find(entry => entry.file === file);
    assert.ok(record, file);
    const bytes = readFileSync(new URL(`public/fonts/${file}`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, file);
    assert.ok(record.codepoints.length > 0, file);
    assert.ok(readFileSync(new URL(`public/fonts/${record.licence}`, root), 'utf8').length > 100, file);
  }
});
test('every shipped woff2 in public/fonts is loaded by an @font-face or by the map style', () => {
  const loaded = new Set(faces.map(face => face.url?.split('/').at(-1)));
  // The map's own faces (the style's font-faces, src/map/style.ts) are fetched by MapLibre, not by CSS.
  const style = readFileSync(new URL('src/map/style.ts', root), 'utf8');
  for (const [, file] of style.matchAll(/fonts\/([\w-]+\.woff2)/g)) loaded.add(file);
  const shipped = readdirSync(new URL('public/fonts/', root)).filter(name => name.endsWith('.woff2'));
  assert.deepEqual(shipped.filter(name => !loaded.has(name)), []);
});
test('the Nation-name face is hash-bound, licensed, keeps mark positioning and covers every curated name', () => {
  const receipt = JSON.parse(readFileSync(new URL('public/fonts/ddm-nation-names.json', root), 'utf8'));
  const bytes = readFileSync(new URL(`public/fonts/${receipt.file}`, root));
  assert.equal(bytes.length, receipt.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
  assert.ok(readFileSync(new URL(`public/fonts/${receipt.licence}`, root), 'utf8').length > 100);
  for (const feature of ['ccmp', 'mark', 'mkmk']) assert.ok(receipt.layoutFeatures.includes(feature), feature);
  const covered = new Set(receipt.codepoints.map(code => parseInt(code.slice(2), 16)));
  const { rows } = JSON.parse(readFileSync(new URL('public/data/tribal-own-names.json', root), 'utf8'));
  for (const row of rows) {
    for (const char of row.ownName) {
      assert.ok(covered.has(char.codePointAt(0)),
        `${row.nation}: U+${char.codePointAt(0).toString(16).toUpperCase()} is not in the face; re-cut it (scripts/cut-nation-names-font.py)`);
    }
  }
});
test('both adopted stacks cover every public name character and the BC orthography fixture', () => {
  const required = new Set([... '\u0294\u02b7\u1e35\u0313\u0331'].map(char => char.codePointAt(0)));
  for (const file of ['us-places.json', 'tribal-roster.json', 'tribal-larname-crosswalk.json']) {
    const data = JSON.stringify(JSON.parse(readFileSync(new URL(`public/data/${file}`, root), 'utf8')));
    for (const char of data) if (char.codePointAt(0) > 127) required.add(char.codePointAt(0));
  }
  for (const primary of ['Spartan MB', 'DDM Heros']) {
    const stack = faces.filter(face => [primary, 'DDM Glyph Fallback', 'DDM Orthography Fallback'].includes(face.family));
    for (const cp of required) assert.ok(stack.some(face => supports(face, cp)), `${primary}: U+${cp.toString(16).toUpperCase()}`);
  }
});
test('orthography fallback carries whole clusters and positioning; Heros retains numeric features', () => {
  const face = faces.find(entry => entry.family === 'DDM Orthography Fallback');
  assert.ok(face);
  for (const char of 'k\u1e35\u0313\u0331') assert.ok(supports(face, char.codePointAt(0)), char);
  const fallback = manifest.files.find(entry => entry.file === face.url.split('/').at(-1));
  for (const feature of ['mark', 'mkmk']) assert.ok(fallback.positioningFeatures.includes(feature), feature);
  for (const file of ['ddm-heros-regular-latin.woff2', 'ddm-heros-bold-latin.woff2']) {
    const record = manifest.files.find(entry => entry.file === file);
    for (const feature of ['tnum', 'lnum']) assert.ok(record.features.includes(feature), `${file}: ${feature}`);
  }
});
