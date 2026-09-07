/**
 * `escapeHtml` (src/util/escape.ts).
 *
 * Every popup factory and every tooltip that renders an agency-supplied
 * string (OSM `name` tags, GeoJSON properties, ArcGIS attributes) passes it
 * through this one function before interpolating into HTML. These cases pin
 * the five substitutions, the order they run in (ampersand first, so an
 * entity already present in the input is re-escaped rather than passed
 * through), the null and undefined blanking, and the characters that are
 * deliberately left alone.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { escapeHtml } from '../src/util/escape.ts';

test('null and undefined become the empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('the empty string stays empty', () => {
  assert.equal(escapeHtml(''), '');
});

test('each of the five HTML-significant characters is replaced by its entity', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#039;');
});

test('every occurrence is replaced, not just the first', () => {
  assert.equal(escapeHtml('<<>>'), '&lt;&lt;&gt;&gt;');
  assert.equal(escapeHtml('a & b & c'), 'a &amp; b &amp; c');
  assert.equal(escapeHtml(`""''`), '&quot;&quot;&#039;&#039;');
});

test('a markup fragment comes out with no live tag, attribute, or quote', () => {
  assert.equal(
    escapeHtml(`<a href="x" onclick='go()'>Tom & Jerry's</a>`),
    '&lt;a href=&quot;x&quot; onclick=&#039;go()&#039;&gt;Tom &amp; Jerry&#039;s&lt;/a&gt;',
  );
});

test('ampersand is escaped first, so entities already in the input are re-escaped', () => {
  // If '<' ran before '&', the '&' introduced by '&lt;' would then be escaped
  // to '&amp;lt;' anyway; the distinguishing case is an entity in the INPUT,
  // which must not survive as a working entity.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml('&#039;'), '&amp;#039;');
  assert.equal(escapeHtml('&<'), '&amp;&lt;');
});

test('escaping is not idempotent: a second pass escapes the first pass', () => {
  const once = escapeHtml('<');
  assert.equal(escapeHtml(once), '&amp;lt;');
});

test('the output never contains a raw <, >, ", or \', and every & starts one of the five entities', () => {
  const adversarial = [
    '<script>alert(1)</script>',
    '" onmouseover="alert(1)',
    "' onmouseover='alert(1)",
    '<img src=x onerror=alert(1)>',
    '&lt;script&gt;',
    '&&&<<<>>>"""\'\'\'',
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const input of adversarial) {
    const out = escapeHtml(input);
    assert.doesNotMatch(out, /[<>"']/, `raw HTML character survived in ${JSON.stringify(out)}`);
    const stripped = out.replaceAll(/&(amp|lt|gt|quot|#039);/g, '');
    assert.doesNotMatch(stripped, /&/, `bare ampersand survived in ${JSON.stringify(out)}`);
  }
});

test('characters outside the five pass through unchanged', () => {
  const cases = [
    'Confederated Tribes of the Umatilla Indian Reservation',
    'Nimíipuu (Nez Perce)',
    'Séliš u Ql̓ispé',
    'path/with/slashes',
    'back`tick',
    'line\nbreak\ttab',
    '=+-_.,;:!?()[]{}|~^%$#@*',
  ];
  for (const input of cases) {
    assert.equal(escapeHtml(input), input);
  }
});

test('only null and undefined are blanked; other non-string values are stringified', () => {
  // The signature is typed as string, but the body coerces with String(),
  // so a caller that slips a number through a loosely typed property bag
  // gets '0', not ''. Pinned so a future tightening is a deliberate change.
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(false), 'false');
  assert.equal(escapeHtml(12.5), '12.5');
});

test('escaping is length-preserving for safe input and only grows for unsafe input', () => {
  const safe = 'Spokane Tribe of Indians';
  assert.equal(escapeHtml(safe).length, safe.length);
  const unsafe = '<&>';
  assert.ok(escapeHtml(unsafe).length > unsafe.length);
});
