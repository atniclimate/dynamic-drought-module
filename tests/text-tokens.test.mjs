/**
 * `dateTok` (src/util/text-tokens.ts).
 *
 * The time door's dates (found-015; R5 a, `interface-chrome-popups-text.md`
 * section 10): a month-name date, the zone always named, tied with U+00A0
 * (section 4.2) so the token never breaks across a line. These cases pin
 * the format, the named zone, the NBSP tie, and the default-zone fallback
 * when no `timeZone` is given.
 *
 * It registers no Playwright tests: it runs under `node --test` beside the
 * other `*.test.mjs` files, wired into `check:all`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classTok, dateTok, idTok, qtyTok } from '../src/util/text-tokens.ts';

const NBSP = ' ';

test('a UTC instant renders as a month-name, 24-hour, zone-named token', () => {
  const result = dateTok('2026-09-26T08:00:00Z', 'UTC');
  assert.equal(result, `Sep${NBSP}26,${NBSP}2026,${NBSP}08:00${NBSP}UTC`);
});

test('every space in the token is U+00A0, never a breakable space', () => {
  const result = dateTok('2026-09-26T08:00:00Z', 'UTC');
  assert.equal(result.includes(' '), false, 'a plain space would let the token break');
  assert.equal(result.split(NBSP).length, 5, 'four NBSP ties join five parts');
});

test('midnight renders 00:00, never 24:00 (the Intl h23 pitfall)', () => {
  const result = dateTok('2026-01-01T00:00:00Z', 'UTC');
  assert.match(result, /00:00/);
  assert.doesNotMatch(result, /24:00/);
});

test('a named zone other than UTC is used and named, not silently dropped', () => {
  const result = dateTok('2026-09-26T08:00:00Z', 'America/Los_Angeles');
  assert.match(result, /PDT|PST/);
  assert.match(result, /^Sep 26, 2026, 01:00 PDT$/);
});

test('a numeric instant (ms since epoch) formats the same as its ISO string', () => {
  const iso = '2026-09-26T08:00:00Z';
  const ms = Date.parse(iso);
  assert.equal(dateTok(ms, 'UTC'), dateTok(iso, 'UTC'));
});

test('single-digit day and hour are still two-digit clock, one-digit day (Intl default)', () => {
  const result = dateTok('2026-01-05T03:05:00Z', 'UTC');
  assert.equal(result, `Jan${NBSP}5,${NBSP}2026,${NBSP}03:05${NBSP}UTC`);
});

test('with no timeZone argument the runtime zone is used and still named', () => {
  const result = dateTok('2026-09-26T08:00:00Z');
  assert.match(result, /\d{2}:\d{2} [A-Za-z+\-\d:]+$/, 'a named (or offset) zone trails the token');
});

// S30D D1 M27: `qtyTok`, `classTok` and `idTok` (interface-chrome-popups-
// text.md section 4.2). Each ties with U+00A0 and never rewords its input:
// untying the result (NBSP back to a plain space) gives back exactly the
// text the app already renders.

const untie = (text) => text.replace(/ /g, ' ');

test('qtyTok ties "9,108 acres" into one U+00A0 token', () => {
  assert.equal(qtyTok(9108, 'acres'), `9,108${NBSP}acres`);
  assert.equal(qtyTok(9108, 'acres').includes(' '), false, 'a plain space would let the token break');
});

test('qtyTok keeps a string amount and the unit exactly as given', () => {
  assert.equal(qtyTok('9,108', 'acres'), `9,108${NBSP}acres`);
  assert.equal(untie(qtyTok('about 12.5', 'square miles')), 'about 12.5 square miles');
  assert.equal(qtyTok(0.25, 'in'), `0.25${NBSP}in`);
});

test('classTok ties "D1 Moderate" when it fits its slot and leaves a longer label breakable', () => {
  assert.equal(classTok('D1 Moderate'), `D1${NBSP}Moderate`);
  assert.equal(classTok('D1 Moderate', 11), `D1${NBSP}Moderate`);
  assert.equal(classTok('D4 Exceptional Drought', 10), 'D4 Exceptional Drought');
  assert.equal(untie(classTok('D4 Exceptional Drought')), 'D4 Exceptional Drought');
});

test('idTok ties an identifier and changes no other character', () => {
  assert.equal(idTok('HUC 17110005'), `HUC${NBSP}17110005`);
  assert.equal(idTok('2026-WAOWF-000123'), '2026-WAOWF-000123');
  assert.equal(untie(idTok('Station 12345 A')), 'Station 12345 A');
});
