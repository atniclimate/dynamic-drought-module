/**
 * Two stylesheet faces the look of 2026-11-05 found broken, read from
 * src/styles/app.css itself. Browser-free.
 *
 * - SAT (the basemap switcher) outside the desktop column: MapLibre paints
 *   its control group white (#fff in maplibre-gl.css), and the pressed face
 *   was the 8 percent white accent tint with white type, so the Layer
 *   studio header, the embed corner and the phone seat showed a blank white
 *   box. The group must not paint, and the pressed face must hold 4.5:1
 *   against the worst backdrop, white.
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

function ruleFor(selector) {
  const found = rules.filter((r) => r.selector === selector);
  assert.equal(found.length, 1, `exactly one rule for ${selector}`);
  return found[0].body;
}

/** The first :root definition of a token. */
function token(name) {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  assert.ok(m, `token ${name}`);
  return m[1].trim();
}

const resolve = (value) => value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => token(name));

function parseColour(text) {
  const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (hex) return { rgb: [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16)), alpha: 1 };
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text.trim());
  assert.ok(rgba, `not a colour: ${text}`);
  return { rgb: [rgba[1], rgba[2], rgba[3]].map(Number), alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
}

/** Top-level comma split (commas inside parentheses stay). */
function layers(value) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out;
}

/** A CSS background (flat gradients and colours) painted over an opaque backdrop. */
function paint(background, backdrop) {
  let rgb = backdrop;
  for (const layer of layers(resolve(background)).reverse()) {
    const flat = /^linear-gradient\((.+)\)$/.exec(layer);
    const stops = flat ? layers(flat[1]) : [layer];
    assert.ok(stops.every((s) => s === stops[0]), `only flat layers: ${layer}`);
    const { rgb: c, alpha } = parseColour(stops[0]);
    rgb = c.map((v, i) => alpha * v + (1 - alpha) * rgb[i]);
  }
  return rgb;
}

function luminance([r, g, b]) {
  const ch = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the SAT control group does not paint MapLibre\'s white card behind the button', () => {
  const background = declaration(ruleFor('.maplibregl-ctrl-group:has(.basemap-switcher-btn)'), 'background');
  assert.ok(background === 'none' || background === 'transparent', `group background ${background}`);
});

test('the pressed SAT face keeps its type at 4.5:1 over a white backdrop', () => {
  const body = ruleFor('.basemap-switcher-btn.active');
  const face = paint(declaration(body, 'background'), [255, 255, 255]);
  const ink = parseColour(resolve(declaration(body, 'color'))).rgb;
  const ratio = contrast(face, ink);
  assert.ok(ratio >= 4.5, `pressed SAT contrast ${ratio.toFixed(2)}:1`);
});

test('no rule holds a layer row status line to one line', () => {
  const nowrap = rules.filter(
    (r) => /\.layer-toggle-status\b/.test(r.selector) && declaration(r.body, 'white-space') === 'nowrap'
  );
  assert.deepEqual(nowrap.map((r) => r.selector), []);
});
