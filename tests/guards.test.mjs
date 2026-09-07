/**
 * `isObject` (src/util/guards.ts).
 *
 * The narrowing floor beneath every impact source, the ENSO reader, and the
 * popups module: each parses agency JSON as `unknown` and walks it only after
 * this guard says the value is a property bag. These cases pin exactly which
 * runtime values pass. Arrays, Dates, Maps, and null-prototype objects pass
 * (they are `typeof 'object'`); functions, null, undefined, and every
 * primitive do not. Callers that need "a plain object and not an array" must
 * add that check themselves; this guard does not make it for them.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isObject } from '../src/util/guards.ts';

test('plain objects pass, empty or not', () => {
  assert.equal(isObject({}), true);
  assert.equal(isObject({ a: 1 }), true);
  assert.equal(isObject({ nested: { deep: true } }), true);
});

test('null-prototype objects pass', () => {
  assert.equal(isObject(Object.create(null)), true);
});

test('arrays pass, because they are typeof object', () => {
  assert.equal(isObject([]), true);
  assert.equal(isObject([1, 2, 3]), true);
});

test('other built-in object kinds pass', () => {
  assert.equal(isObject(new Date()), true);
  assert.equal(isObject(new Map()), true);
  assert.equal(isObject(new Set()), true);
  assert.equal(isObject(/re/), true);
  assert.equal(isObject(new Error('e')), true);
  assert.equal(isObject(new String('boxed')), true);
  assert.equal(isObject(new Number(1)), true);
});

test('null and undefined do not pass', () => {
  assert.equal(isObject(null), false);
  assert.equal(isObject(undefined), false);
});

test('primitives do not pass', () => {
  assert.equal(isObject('string'), false);
  assert.equal(isObject(''), false);
  assert.equal(isObject(0), false);
  assert.equal(isObject(1), false);
  assert.equal(isObject(NaN), false);
  assert.equal(isObject(true), false);
  assert.equal(isObject(false), false);
  assert.equal(isObject(10n), false);
  assert.equal(isObject(Symbol('s')), false);
});

test('functions do not pass, because typeof reports function', () => {
  assert.equal(isObject(() => {}), false);
  assert.equal(isObject(function named() {}), false);
  assert.equal(isObject(class C {}), false);
  assert.equal(isObject(Math.max), false);
});

test('JSON.parse output is classified the way a source reader relies on', () => {
  assert.equal(isObject(JSON.parse('{"DM":3,"MapDate":"20260901"}')), true);
  assert.equal(isObject(JSON.parse('[{"DM":3}]')), true);
  assert.equal(isObject(JSON.parse('null')), false);
  assert.equal(isObject(JSON.parse('"text"')), false);
  assert.equal(isObject(JSON.parse('42')), false);
  assert.equal(isObject(JSON.parse('true')), false);
});

test('a passing value can be read as a property bag', () => {
  const value = JSON.parse('{"name":"Yakama Nation","area_sqkm":5680}');
  const name = isObject(value) ? value.name : undefined;
  assert.equal(name, 'Yakama Nation');
  const missing = isObject(value) ? value.absent : undefined;
  assert.equal(missing, undefined);
});

test('the guard does not mutate or unwrap its argument', () => {
  const input = Object.freeze({ a: 1 });
  isObject(input);
  assert.deepEqual(input, { a: 1 });
});
