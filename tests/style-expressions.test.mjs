/**
 * `matchExpression` (src/config/style-expressions.ts).
 *
 * The helper exists because the Style Spec types `match` as
 * ['match', input, label, output, ...rest, default]: the first label/output
 * pair sits in fixed tuple slots, so every palette-driven builder has to split
 * its pair list into a head pair and a tail. These cases pin the emitted array
 * for the shapes the four call sites actually produce, and pin the one case
 * the split alone gets wrong: an empty palette, where destructuring binds
 * `undefined` to both head slots and emits an expression MapLibre rejects.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { matchExpression } from '../src/config/style-expressions.ts';

test('one pair emits the head pair in the fixed tuple slots', () => {
  assert.deepEqual(
    matchExpression(['get', 'k'], [['only', '#111111']], '#000000'),
    ['match', ['get', 'k'], 'only', '#111111', '#000000']
  );
});

test('seven pairs flatten in palette order, fallback last', () => {
  const pairs = [
    ['UNDER 100', 0.6],
    ['100-161', 1.0],
    ['220-287', 1.4],
    ['345', 1.8],
    ['500', 2.2],
    ['DC', 1.8],
    ['NOT AVAILABLE', 0.6]
  ];

  const expression = matchExpression(['get', 'VOLT_CLASS'], pairs, 0.6);

  assert.deepEqual(expression, [
    'match',
    ['get', 'VOLT_CLASS'],
    'UNDER 100',
    0.6,
    '100-161',
    1.0,
    '220-287',
    1.4,
    '345',
    1.8,
    '500',
    2.2,
    'DC',
    1.8,
    'NOT AVAILABLE',
    0.6,
    0.6
  ]);
  // 'match' + input + 2 per pair + default.
  assert.equal(expression.length, 2 + pairs.length * 2 + 1);
});

test('an empty palette throws and names the palette', () => {
  assert.throws(
    () => matchExpression(['get', 'k'], [], '#000000', 'ECOREGION_COLORS'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ECOREGION_COLORS is empty/);
      assert.match(err.message, /at least one label\/output pair/);
      return true;
    }
  );

  // Without a palette name the error still fires, so no caller can slip an
  // empty palette through by omitting the fourth argument.
  assert.throws(
    () => matchExpression(['get', 'k'], [], '#000000'),
    /the palette is empty/
  );
});

test('numeric labels and nested expression inputs survive unchanged', () => {
  assert.deepEqual(
    matchExpression(
      ['get', 'dn'],
      [
        [5, '#ffc966'],
        [8, '#ff6666'],
        [10, '#ff66ff']
      ],
      '#9ca3af'
    ),
    ['match', ['get', 'dn'], 5, '#ffc966', 8, '#ff6666', 10, '#ff66ff', '#9ca3af']
  );

  const keyExpr = ['coalesce', ['get', 'US_L3NAME'], ['get', 'name'], ''];
  assert.deepEqual(matchExpression(keyExpr, [['Cascades', '#3f6f52']], '#5a6b7d'), [
    'match',
    keyExpr,
    'Cascades',
    '#3f6f52',
    '#5a6b7d'
  ]);
});

test('a label list sharing one output stays a list', () => {
  assert.deepEqual(
    matchExpression(
      ['get', 'prod_type'],
      [
        [['Extreme Heat Warning', 'Excessive Heat Warning'], '#c81e1e'],
        ['Heat Advisory', '#f97316']
      ],
      '#9ca3af'
    ),
    [
      'match',
      ['get', 'prod_type'],
      ['Extreme Heat Warning', 'Excessive Heat Warning'],
      '#c81e1e',
      'Heat Advisory',
      '#f97316',
      '#9ca3af'
    ]
  );
});

test('the returned expression does not alias the caller palette', () => {
  const pairs = [['a', '#111111']];
  const expression = matchExpression(['get', 'k'], pairs, '#000000');
  pairs.push(['b', '#222222']);
  assert.equal(expression.length, 5);
});
