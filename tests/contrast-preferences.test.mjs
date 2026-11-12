import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Two reader preferences the chrome answers through its tokens (owner
 * direction 2026-11-09 (sprint), DR-pending):
 *
 *   prefers-contrast: more   the glass loses its translucency and its blur,
 *                            and outlines and secondary inks go to full
 *                            strength. Tokens only.
 *   forced-colors: active    the surface, glass and ink names take the
 *                            system's canvas and text, and the selected face
 *                            takes the system's selected pair. The system
 *                            does not repaint inside an svg, so without this
 *                            a figure's light ink stayed light on the
 *                            system's canvas.
 *
 * The second has one rule every stylesheet must keep: a rule that draws the
 * selected face also sets `forced-color-adjust: none`. Without it the system
 * puts a canvas plate between the face and its label, and the label, already
 * the selected text colour, cannot be read. That was seen on the camera
 * before this file existed, on the briefing's view switch.
 */

const root = new URL('../src/', import.meta.url);
const sheets = [
  ...readdirSync(new URL('styles/', root)).filter((name) => name.endsWith('.css')).map((name) => `styles/${name}`),
  ...readdirSync(new URL('ui/', root)).filter((name) => name.endsWith('.css')).map((name) => `ui/${name}`)
];
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (path) => strip(readFileSync(fileURLToPath(new URL(path, root)), 'utf8'));
const app = read('styles/app.css');

/** The body of the first `@media (<query>) { :root { ... } }` block. */
function rootBlock(query) {
  const start = app.indexOf(`@media (${query}) {`);
  assert.notEqual(start, -1, `app.css has no @media (${query}) block`);
  const open = app.indexOf(':root {', start);
  const close = app.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1);
  return Object.fromEntries(
    [...app.slice(open, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  );
}

test('more contrast: the glass is solid and unblurred, and no ink is dimmer than before', () => {
  const tokens = rootBlock('prefers-contrast: more');
  for (const name of ['--glass-control', '--glass-fill', '--glass-fill-solid', '--glass-panel', '--glass-panel-solid', '--glass-read']) {
    assert.equal(tokens[name], 'var(--surface-base)', `${name} is the solid surface`);
  }
  assert.equal(tokens['--glass-blur'], '0px');
  assert.equal(tokens['--glass-edge'], 'var(--keyline)', 'outlines at full strength');
  // Inks only move up the scale: each takes the value of the step above it.
  const luminance = (hex) => [1, 3, 5].reduce((sum, i) => sum + Number.parseInt(hex.slice(i, i + 2), 16), 0);
  for (const name of ['--ink', '--ink-soft', '--ink-muted', '--ink-faint']) {
    assert.match(tokens[name], /^#[0-9A-Fa-f]{6}$/, name);
    const first = new RegExp(`${name}\\s*:\\s*(#[0-9A-Fa-f]{6});`).exec(app)[1];
    assert.ok(luminance(tokens[name]) >= luminance(first), `${name} is not dimmer under more contrast`);
  }
  // Tokens only: the block holds one :root rule and nothing else.
  const start = app.indexOf('@media (prefers-contrast: more) {');
  const body = app.slice(start, app.indexOf('\n}\n', start));
  assert.equal([...body.matchAll(/\{/g)].length, 2, 'the media block and one :root rule');
});

test('forced colours: surfaces, glass and inks take the system canvas and text; the selected face takes the selected pair', () => {
  const tokens = rootBlock('forced-colors: active');
  for (const name of ['--surface-base', '--surface-raised', '--surface-overlay', '--glass-fill', '--glass-panel']) {
    assert.equal(tokens[name], 'Canvas', name);
  }
  for (const name of ['--ink-strong', '--ink', '--ink-soft', '--ink-muted', '--ink-faint', '--keyline', '--glass-edge']) {
    assert.equal(tokens[name], 'CanvasText', name);
  }
  assert.equal(tokens['--face-selected'], 'Highlight');
  assert.equal(tokens['--ink-on-selected'], 'HighlightText');
  // No authored colour survives in the block: every value is a system colour.
  for (const [name, value] of Object.entries(tokens)) {
    assert.match(value, /^(?:Canvas|CanvasText|Highlight|HighlightText)$/, `${name}: ${value}`);
  }
});

test('every rule that draws the selected face opts out of the system repaint', () => {
  let faces = 0;
  for (const path of sheets) {
    const css = read(path);
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = rule;
      if (!/background(?:-color)?:\s*var\(--face-selected\)/.test(body)) continue;
      faces += 1;
      assert.match(
        body,
        /forced-color-adjust:\s*none;/,
        `${path}: ${selector.trim().replace(/\s+/g, ' ').slice(0, 90)} draws the selected face without forced-color-adjust: none`
      );
    }
  }
  assert.ok(faces >= 12, `the selected face is drawn in ${faces} rules`);
  // The two faces that name their colours directly: Satellite when on, and the observed evidence plate.
  assert.match(app, /\.basemap-switcher-btn\.active \{\s*forced-color-adjust: none;/);
  assert.match(app, /:root \.basemap-switcher-btn\.active \{\s*background: Highlight !important;\s*color: HighlightText !important;\s*\}/);
  assert.match(app, /\.impact-claim-observed \.impact-claim-badge \{\s*forced-color-adjust: none;/);
  assert.match(read('styles/briefing-lead.css'), /\[data-evidence='observed'\] \.impact-claim-badge \{\s*forced-color-adjust: none;/);
});
