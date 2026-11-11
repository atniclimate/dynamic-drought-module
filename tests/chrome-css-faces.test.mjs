/**
 * A stylesheet face the look of 2026-11-05 found broken, read from
 * src/styles/app.css itself. Browser-free.
 *
 * - A layer row's status line is a sentence ("no active tropical cyclones
 *   in the Atlantic, Eastern North Pacific or Central North Pacific"), not a
 *   control label, so no rule may hold it to one line: it ran 446px in a
 *   249px row and was cut mid-word.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** Innermost rules as { selector, body }, at-rule wrappers dropped. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].replace(/\s+/g, ' ').trim(),
  body: m[2]
}));

function declaration(body, property) {
  const m = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].replace(/\s*!important\s*$/, '').trim() : null;
}

test('no rule holds a layer row status line to one line', () => {
  const nowrap = rules.filter(
    (r) => /\.layer-toggle-status\b/.test(r.selector) && declaration(r.body, 'white-space') === 'nowrap'
  );
  assert.deepEqual(nowrap.map((r) => r.selector), []);
});
