import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * S30D D1 M9 (DR-101; register owner-1f, DDM-P10-T11): the WCAG 2.x
 * contrast of every colour pair the desktop map chrome relies on, computed
 * here from the D1 token block in src/styles/app.css, never copied.
 *
 * Each row is { what, fg, bg, floor, recorded }. The test asserts the
 * computed ratio meets its floor (4.5 for text, 3.0 for a boundary and
 * other non-text) AND sits within 0.005 of the ratio the design record
 * wrote down (interface-chrome-popups-text.md sections 2.3 and 2.6;
 * palette-tokens.md sections 2 and 3). The second clause is the point: a
 * token edit that still clears the floor shows up as a ratio diff, so a
 * colour cannot move without the record moving with it.
 *
 * Two kinds of number:
 * - A plain ratio: the ink or edge against the surface it sits on.
 * - An any-backdrop floor for a two-tone boundary: a 1px edge between an
 *   opaque face and arbitrary imagery is seen against one or the other,
 *   and the worst case over every possible backdrop is the square root of
 *   the face-to-edge ratio (design record 2.3, "Why these faces").
 *
 * Glass composites blend in sRGB channel space, as a browser paints them,
 * over the stated backdrop. D3 (its M5) extends this file with the whole
 * palette rather than creating a second one (D1.md :295).
 */

const css = await readFile(new URL('../src/styles/app.css', import.meta.url), 'utf8');

function parseColour(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    return {
      rgb: [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)),
      alpha: 1
    };
  }
  const rgba = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(text);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4])
    };
  }
  throw new Error(`not a colour: ${value}`);
}

/** WCAG 2.x relative luminance of an sRGB triple (0 to 255 per channel). */
function luminance([r, g, b]) {
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A translucent colour painted over an opaque backdrop. */
function over({ rgb, alpha }, backdrop) {
  return rgb.map((c, i) => alpha * c + (1 - alpha) * backdrop[i]);
}

/** The D1 chrome token block's declarations, name to value. */
function d1Tokens() {
  const start = css.indexOf('D1 CHROME TOKENS');
  assert.notEqual(start, -1, 'app.css has no labelled D1 CHROME TOKENS block');
  const end = css.indexOf('}', start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  return tokens;
}

/** D1.md :295, names and values exactly. */
const D1_BLOCK = {
  '--surface-raised': '#141414',
  '--surface-overlay': '#1E242C',
  '--surface-hover': '#2A3138',
  '--ink-strong': '#FFFFFF',
  '--ink': '#E8ECF0',
  '--ink-soft': '#C6CBD4',
  '--ink-muted': '#98A1B4',
  '--ink-faint': '#8A94A6',
  '--keyline': '#C6CBD4',
  '--rule-strong': '#636363',
  '--focus-inner': '#FFFFFF',
  '--focus-outer': '#010B13',
  '--glass-read': 'rgba(1, 11, 19, 0.72)',
  '--link-on-dark': '#F26B5E'
};

const WHITE = [255, 255, 255];
const TEXT = 4.5;
const NON_TEXT = 3;

test('self-test: #000 on #FFF is 21.00 and #777777 on #FFFFFF is 4.48', () => {
  assert.equal(ratio([0, 0, 0], WHITE).toFixed(2), '21.00');
  assert.equal(ratio(parseColour('#777777').rgb, parseColour('#FFFFFF').rgb).toFixed(2), '4.48');
  // The composite helper: a fully opaque colour over anything is itself.
  assert.deepEqual(over(parseColour('#141414'), WHITE), [20, 20, 20]);
});

test('every D1 chrome pair meets its floor and sits within 0.005 of its recorded ratio', () => {
  const tokens = d1Tokens();
  const c = (name) => {
    const value = tokens.get(name);
    assert.ok(value, `${name} is missing from the D1 block`);
    return parseColour(value);
  };
  const solid = (name) => {
    const colour = c(name);
    assert.equal(colour.alpha, 1, `${name} must be opaque to be a face or an ink`);
    return colour.rgb;
  };
  const glassOverWhite = over(c('--glass-read'), WHITE);
  const s1 = solid('--surface-raised');
  const s2 = solid('--surface-overlay');
  const s3 = solid('--surface-hover');

  const rows = [
    // The cell faces (design record 2.3).
    { what: 'rest glyph and word, T1 on S1', value: ratio(solid('--ink'), s1), floor: TEXT, recorded: 15.52 },
    { what: 'rest edge, any-backdrop floor', value: Math.sqrt(ratio(solid('--keyline'), s1)), floor: NON_TEXT, recorded: 3.36 },
    { what: 'rest face against white imagery', value: ratio(s1, WHITE), floor: NON_TEXT, recorded: 18.42 },
    { what: 'hover glyph and word, T1 on S2', value: ratio(solid('--ink'), s2), floor: TEXT, recorded: 13.16 },
    { what: 'hover edge, any-backdrop floor', value: Math.sqrt(ratio(solid('--keyline'), s2)), floor: NON_TEXT, recorded: 3.10 },
    { what: 'pressed glyph and word, T0 on S3', value: ratio(solid('--ink-strong'), s3), floor: TEXT, recorded: 13.17 },
    { what: 'pressed white edge, any-backdrop floor', value: Math.sqrt(ratio(solid('--ink-strong'), s3)), floor: NON_TEXT, recorded: 3.63 },
    // The focus ring: white ring on a Black BG casing; the better of the
    // pair against any adjacent colour.
    { what: 'focus ring pair, any-backdrop floor', value: Math.sqrt(ratio(solid('--focus-inner'), solid('--focus-outer'))), floor: NON_TEXT, recorded: 4.45 },
    // Glass-read over white imagery (the chip and Key drawer face).
    { what: 'glass-read T0 over white', value: ratio(solid('--ink-strong'), glassOverWhite), floor: TEXT, recorded: 8.28 },
    { what: 'glass-read T1 over white', value: ratio(solid('--ink'), glassOverWhite), floor: TEXT, recorded: 6.98 },
    { what: 'glass-read T2 over white', value: ratio(solid('--ink-soft'), glassOverWhite), floor: TEXT, recorded: 5.09 },
    // Opaque S1 popup inks and the Red on Dark link.
    { what: 'popup T0 on S1', value: ratio(solid('--ink-strong'), s1), floor: TEXT, recorded: 18.42 },
    { what: 'popup T1 on S1', value: ratio(solid('--ink'), s1), floor: TEXT, recorded: 15.52 },
    { what: 'popup T2 on S1', value: ratio(solid('--ink-soft'), s1), floor: TEXT, recorded: 11.31 },
    { what: 'popup T3 on S1', value: ratio(solid('--ink-muted'), s1), floor: TEXT, recorded: 7.10 },
    { what: 'popup link on S1', value: ratio(solid('--link-on-dark'), s1), floor: TEXT, recorded: 6.18 },
    { what: 'keyline on S1', value: ratio(solid('--keyline'), s1), floor: NON_TEXT, recorded: 11.31 },
    // The Map information drawer, opaque S2 (design record 2.6).
    { what: 'drawer T1 on S2', value: ratio(solid('--ink'), s2), floor: TEXT, recorded: 13.16 },
    { what: 'drawer T2 on S2', value: ratio(solid('--ink-soft'), s2), floor: TEXT, recorded: 9.59 },
    { what: 'drawer T3 on S2', value: ratio(solid('--ink-muted'), s2), floor: TEXT, recorded: 6.02 },
    { what: 'drawer T4 on S2', value: ratio(solid('--ink-faint'), s2), floor: TEXT, recorded: 5.11 },
    { what: 'drawer link on S2', value: ratio(solid('--link-on-dark'), s2), floor: TEXT, recorded: 5.24 }
  ];

  const failures = rows.flatMap(({ what, value, floor, recorded }) => {
    const problems = [];
    if (value < floor) problems.push(`${what}: ${value.toFixed(3)} is under the ${floor} floor`);
    if (Math.abs(value - recorded) > 0.005) {
      problems.push(`${what}: computed ${value.toFixed(3)}, recorded ${recorded}`);
    }
    return problems;
  });
  assert.deepEqual(failures, []);
  // Last, so a moved colour reports its ratio first: the block itself is
  // exactly D1.md's list, names and values, and nothing more.
  assert.deepEqual(
    Object.fromEntries(tokens),
    D1_BLOCK,
    'the D1 block must hold exactly the names and values D1.md :295 lists'
  );
});

test('#98A1B4 (2.66) and #8A94A6 (2.45) fail the edge floor', () => {
  // The two edges the earlier proposals used (P1 and the 3D record): as a
  // 1px edge on the S1 face each falls under 3:1 against some backdrop,
  // which is why the cells carry the #C6CBD4 keyline (design record 2.3).
  const s1 = parseColour(d1Tokens().get('--surface-raised') ?? '#141414').rgb;
  for (const [edge, recorded] of [
    ['#98A1B4', 2.66],
    ['#8A94A6', 2.45]
  ]) {
    const floor = Math.sqrt(ratio(parseColour(edge).rgb, s1));
    assert.ok(Math.abs(floor - recorded) <= 0.005, `${edge}: computed ${floor.toFixed(3)}, recorded ${recorded}`);
    assert.ok(floor < NON_TEXT, `${edge} unexpectedly clears the edge floor at ${floor.toFixed(3)}`);
  }
});

// D3 M5 extends D1's actual-CSS contrast checks. These are adopted design values,
// not fresh issuer verification and not permission to recolor hazard consumers.
const ADOPTED_D3_TOKENS = {
  '--surface-base': '#010B13',
  '--surface-raised': '#141414',
  '--surface-band': '#171C20',
  '--surface-overlay': '#1E242C',
  '--surface-hover': '#2A3138',
  '--ink-strong': '#FFFFFF',
  '--ink': '#E8ECF0',
  '--ink-soft': '#C6CBD4',
  '--ink-muted': '#98A1B4',
  '--ink-faint': '#8A94A6',
  '--rule': '#3B3B3B',
  '--rule-strong': '#636363',
  '--rule-control': '#8A94A6',
  '--keyline': '#C6CBD4',
  '--focus-inner': '#FFFFFF',
  '--focus-outer': '#010B13',
  '--glass-read': 'rgba(1, 11, 19, 0.72)',
  '--glass-control': 'rgba(1, 11, 19, 0.48)',
  '--link-on-dark': '#F26B5E'
};

function d3Tokens() {
  const root = /:root\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(root, 'first root block is missing');
  const declarations = [...root.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)];
  const result = new Map();
  for (const name of Object.keys(ADOPTED_D3_TOKENS)) {
    const matches = declarations.filter(row => row[1] === name);
    assert.equal(matches.length, 1, name + ' must be defined exactly once');
    result.set(name, matches[0][2].trim());
  }
  return result;
}

test('D3 adopted token values occur once in first root', () => {
  const tokens = Object.fromEntries(d3Tokens());
  assert.deepEqual(tokens, ADOPTED_D3_TOKENS);
});

test('D3 full ink matrix meets allowed floors and records forbidden combinations', () => {
  const tokens = d3Tokens();
  const color = name => parseColour(tokens.get(name));
  const surfaces = ['--surface-base', '--surface-raised', '--surface-overlay', '--surface-hover'];
  const inks = ['--ink-strong', '--ink', '--ink-soft', '--ink-muted', '--ink-faint'];
  // palette-tokens section 2, T0-T4 across S0-S3, including the banned T4/S3.
  const recorded = [
    [19.84, 18.42, 15.63, 13.17],
    [16.71, 15.52, 13.16, 11.09],
    [12.18, 11.31, 9.59, 8.08],
    [7.64, 7.10, 6.02, 5.07],
    [6.49, 6.02, 5.11, 4.31]
  ];
  for (const [i, ink] of inks.entries()) for (const [s, surface] of surfaces.entries()) {
    const actual = ratio(color(ink).rgb, color(surface).rgb);
    assert.ok(Math.abs(actual - recorded[i][s]) <= 0.005,
      ink + ' on ' + surface + ': ' + actual);
    assert.equal(actual >= TEXT, !(i === 4 && s === 3),
      ink + ' on ' + surface + ' allowed-ink rule');
  }
  const glass = over(color('--glass-read'), WHITE);
  for (const [i, ink] of inks.entries()) {
    assert.equal(ratio(color(ink).rgb, glass) >= TEXT, i <= 2,
      ink + ' on glass-read over white');
  }
  // Muted text and the red link are prohibited on glass. The lighter keyline,
  // rather than the opaque-surface control rule, carries the glass boundary.
  assert.ok(ratio(color('--link-on-dark').rgb, glass) < TEXT);
  assert.ok(ratio(color('--rule-control').rgb, glass) < NON_TEXT);
  assert.ok(ratio(color('--keyline').rgb, glass) >= NON_TEXT);
  for (const surface of surfaces) {
    assert.ok(ratio(color('--rule-control').rgb, color(surface).rgb) >= NON_TEXT);
  }
  // The alternate row is an opaque surface; it accepts T0 through T4.
  for (const ink of inks) assert.ok(ratio(color(ink).rgb, color('--surface-band').rgb) >= TEXT);
  assert.equal(color('--glass-control').alpha, 0.48);
  assert.equal(color('--glass-read').alpha, 0.72);
});

test('D3 legacy opaque aliases resolve to the adopted ramp with readable retained faint ink', () => {
  const block = /:root\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(block, 'first root block exists');
  const declarations = [...block.replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)];
  const aliases = {
    '--bg-0': '--surface-base', '--bg-1': '--surface-raised', '--bg-2': '--surface-overlay',
    '--bg-3': '--surface-hover',
    '--fg-0': '--ink', '--fg-1': '--ink-soft', '--fg-2': '--ink-muted', '--fg-3': '--ink-faint'
  };
  const adopted = d3Tokens();
  for (const [legacy, semantic] of Object.entries(aliases)) {
    const matches = declarations.filter(row => row[1] === legacy);
    assert.equal(matches.length, 1, legacy + ' defined once');
    assert.equal(matches[0][2].trim(), 'var(' + semantic + ')', legacy + ' follows semantic token');
  }
  // Faint ink is permitted only on S0-S2. Actual S3 consumers receive the
  // paired hover correction covered in telemetry-hover-tokens.spec.ts.
  const faint = declarations.find(row => row[1] === '--fg-3');
  assert.ok(faint);
  const faintReference = /^var\((--[a-z0-9-]+)\)$/.exec(faint[2].trim());
  const faintColor = parseColour(faintReference ? adopted.get(faintReference[1]) : faint[2]).rgb;
  for (const surface of ['--surface-base', '--surface-raised', '--surface-overlay']) {
    const background = parseColour(adopted.get(surface)).rgb;
    for (const ink of ['--ink', '--ink-soft', '--ink-muted']) {
      assert.ok(ratio(parseColour(adopted.get(ink)).rgb, background) >= 4.5, ink + '/' + surface);
    }
    assert.ok(ratio(faintColor, background) >= 4.5, 'retained faint ink/' + surface);
  }
});
