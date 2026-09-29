import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * S30D D1 M9 (register owner-1f, DDM-P10-T11; design record
 * interface-chrome-popups-text.md section 2.1): the desktop column's
 * geometry tokens in src/styles/app.css equal src/config/map-chrome.ts.
 *
 * The stylesheet owns the geometry, but a seat spec needs the numbers to
 * compute each slot's rectangle, and a CSS custom property cannot be read
 * without a browser. MAP_CHROME_TOKENS is that same set of numbers. This
 * file reads app.css as text (a Node test may read the whole file) and
 * fails the moment a token and its mirror disagree, so a retune has to
 * move both, and the seat and icon specs keep measuring the truth.
 *
 * Runs under plain `node --test`: map-chrome.ts is import-free, so Node
 * 24's type stripping loads it with no resolve hook.
 */

const ROOT = new URL('..', import.meta.url);
const {
  MAP_CHROME_TOKENS,
  MAP_CHROME_TOKEN_PROPERTIES,
  MAP_CELL_H_COARSE,
  MAP_CELL_ANATOMY,
  MAP_CHROME_SEATS,
  MAP_CHROME_TABLET_BAND,
  isTabletBand,
  mapChromeCellSize,
  mapChromeSeatRect,
  mapCellIconCentreX
} = await import(new URL('src/config/map-chrome.ts', ROOT).href);

const css = await readFile(new URL('src/styles/app.css', ROOT), 'utf8');
const html = await readFile(new URL('index.html', ROOT), 'utf8');

/** Comments out, so a token named in prose never counts as a declaration. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every `@media (...) { .app-shell:not(.embed) { ... } }` whose first rule
 * is the bare desktop-shell selector: the only shape a chrome token block
 * may take (design record section 2.1: under `@media (min-width: 721px)`
 * and `.app-shell:not(.embed)`).
 */
const TOKEN_BLOCKS = [
  ...code.matchAll(/@media\s+([^{]+?)\s*\{\s*\.app-shell:not\(\.embed\)\s*\{([^}]*)\}/g)
].map((m) => ({ media: m[1].replace(/\s+/g, ' '), body: m[2] }));

/** The one token block declaring `property`, which must sit under `media`. */
function tokenRuleBody(property, media) {
  const blocks = TOKEN_BLOCKS.filter((block) => new RegExp(`${property}\\s*:`).test(block.body));
  assert.ok(blocks.length > 0, `no .app-shell:not(.embed) token block declares ${property}`);
  const found = blocks.find((block) => block.media === media);
  assert.ok(
    found,
    `${property} is declared under ${blocks.map((b) => b.media).join(', ')}, not ${media}`
  );
  return found.body;
}

function declarations(body) {
  const out = new Map();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/** One CSS rule's declaration text, found by its exact selector. */
function ruleBody(selector) {
  const at = code.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `app.css has no rule for ${selector}`);
  const open = code.indexOf('{', at);
  const close = code.indexOf('}', open);
  return code.slice(open + 1, close);
}

test('the chrome tokens in app.css equal MAP_CHROME_SEATS', () => {
  const fine = declarations(tokenRuleBody('--chrome-inset', '(min-width: 721px)'));
  const names = Object.keys(MAP_CHROME_TOKENS);
  assert.equal(names.length, 9, 'the D1 geometry set is nine tokens (D1.md :295)');

  for (const name of names) {
    const property = MAP_CHROME_TOKEN_PROPERTIES[name];
    assert.ok(property, `${name} has no CSS property in MAP_CHROME_TOKEN_PROPERTIES`);
    assert.equal(
      fine.get(property),
      `${MAP_CHROME_TOKENS[name]}px`,
      `${property} in app.css disagrees with MAP_CHROME_TOKENS.${name}`
    );
    // Declared once: a second definition anywhere would let the CSS drift
    // from the mirror while this block still read true.
    const declared = [...code.matchAll(new RegExp(`${property}\\s*:`, 'g'))].length;
    // --map-cell-h also has its coarse value and the tablet band's;
    // --map-cell-w also has the tablet band's. The next case pins both.
    const expected = property === '--map-cell-h' ? 3 : property === '--map-cell-w' ? 2 : 1;
    assert.equal(declared, expected, `${property} is declared ${declared} times in app.css`);
  }

  // The coarse-pointer height is the touch floor, through its token.
  const coarse = declarations(
    TOKEN_BLOCKS.find(
      (block) =>
        block.media === '(min-width: 721px) and (pointer: coarse)' &&
        /--map-cell-h\s*:/.test(block.body)
    )?.body ?? ''
  );
  assert.equal(coarse.get('--map-cell-h'), 'var(--touch-target)');
  const touch = /--touch-target\s*:\s*([0-9.]+)px\s*;/.exec(code);
  assert.ok(touch, 'app.css declares no --touch-target');
  assert.equal(Number(touch[1]), MAP_CELL_H_COARSE, '--touch-target disagrees with MAP_CELL_H_COARSE');

  // The seat table: four slots in order, one key each, and the formula
  // the seat spec measures against.
  assert.deepEqual(
    MAP_CHROME_SEATS.map((seat) => seat.slot),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    MAP_CHROME_SEATS.map((seat) => seat.key),
    ['reset', 'satellite', 'help', 'share']
  );
  assert.deepEqual(
    MAP_CHROME_SEATS.filter((seat) => !seat.alwaysSeated).map((seat) => seat.key),
    ['share'],
    'only Share leaves its slot (the Brief rehost, R2 a)'
  );
  // The formula at the 1280x720 open-sidebar container (W 940), every
  // number derived from the table: x = W - inset - cell width, y = inset +
  // (slot - 1) * (height + gap).
  const VIEWPORT = 1280;
  const W = 940;
  const { chromeInset, mapCellW, mapCellH, mapCellGap } = MAP_CHROME_TOKENS;
  for (const { slot } of MAP_CHROME_SEATS) {
    assert.deepEqual(mapChromeSeatRect(slot, W, VIEWPORT), {
      x: W - chromeInset - mapCellW,
      y: chromeInset + (slot - 1) * (mapCellH + mapCellGap),
      width: mapCellW,
      height: mapCellH
    });
    assert.deepEqual(mapChromeSeatRect(slot, W, VIEWPORT, true), {
      x: W - chromeInset - mapCellW,
      y: chromeInset + (slot - 1) * (MAP_CELL_H_COARSE + mapCellGap),
      width: mapCellW,
      height: MAP_CELL_H_COARSE
    });
  }
  const { edge, paddingInline, iconColumn, iconGap } = MAP_CELL_ANATOMY;
  assert.equal(
    mapCellIconCentreX(W, VIEWPORT),
    W - chromeInset - mapCellW + edge + paddingInline + iconColumn / 2
  );

  // The cell holds the widest word with its designed right inset. The
  // director's probe, 2026-09-27 (1280x900 and 1440x900, ?view=console,
  // Lexend): "Share view" is about 78.4 px wide, so the need is
  // edge + padding + icon + gap + word + padding + edge = 126.4 px.
  const SHARE_VIEW_WORD_PX = 78.4;
  const need = edge + paddingInline + iconColumn + iconGap + SHARE_VIEW_WORD_PX + paddingInline + edge;
  assert.ok(mapCellW >= need, `--map-cell-w ${mapCellW}px is under the measured need of ${need}px`);
});

test('the tablet band gives the family 44 px icon squares on the app\'s own tablet query, open or collapsed', () => {
  const { minViewport, maxViewport, cell } = MAP_CHROME_TABLET_BAND;
  const query = `(min-width: ${minViewport}px) and (max-width: ${maxViewport}px)`;

  // The band reuses the app's existing tablet query (DDM-P10-T01), the one
  // that wraps the fluid --sidebar-w, rather than a number of its own.
  const tablet = /@media\s+([^{]+?)\s*\{\s*:root\s*\{\s*--sidebar-w\s*:\s*clamp\(/.exec(code);
  assert.ok(tablet, 'app.css lost the tablet band --sidebar-w rule');
  assert.equal(tablet[1].replace(/\s+/g, ' '), query, 'the mirror disagrees with the app\'s tablet query');

  // One token rule in that query: the 44 px square, both sides through the
  // touch floor token.
  const bandTokens = TOKEN_BLOCKS.filter(
    (block) => block.media === query && /--map-cell-[wh]\s*:/.test(block.body)
  );
  assert.equal(bandTokens.length, 1, `expected one chrome token rule under ${query}`);
  const size = declarations(bandTokens[0].body);
  assert.equal(size.get('--map-cell-w'), 'var(--touch-target)');
  assert.equal(size.get('--map-cell-h'), 'var(--touch-target)');
  const touch = /--touch-target\s*:\s*([0-9.]+)px\s*;/.exec(code);
  assert.equal(Number(touch?.[1]), cell, '--touch-target disagrees with the band\'s cell');

  // The same block centres the icon and hides the word the .sr-only way
  // (never display: none, so the name and the text both stay).
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(
    `@media\\s+${esc(query)}\\s*\\{\\s*\\.app-shell:not\\(\\.embed\\)\\s*\\{[^}]*\\}` +
      '\\s*\\.app-shell:not\\(\\.embed\\) \\.map-overlay-controls \\.map-cell\\s*\\{([^}]*)\\}' +
      '\\s*\\.app-shell:not\\(\\.embed\\) \\.map-overlay-controls \\.map-cell > span\\s*\\{([^}]*)\\}'
  ).exec(code);
  assert.ok(block, `the band's cell and word rules are missing under ${query}`);
  for (const line of ['grid-template-columns: 20px', 'place-items: center', 'padding: 0']) {
    assert.ok(block[1].includes(line), `the band's cell rule lost "${line}"`);
  }
  for (const line of ['position: absolute', 'width: 1px', 'height: 1px', 'clip: rect(0, 0, 0, 0)']) {
    assert.ok(block[2].includes(line), `the band's word rule lost "${line}"`);
  }
  assert.ok(!/display\s*:\s*none/.test(block[2]), 'the band hides the word with display: none');

  // The mirror: a viewport rule with inclusive edges, one table.
  assert.equal(isTabletBand(minViewport - 1), false);
  assert.equal(isTabletBand(minViewport), true);
  assert.equal(isTabletBand(maxViewport), true);
  assert.equal(isTabletBand(maxViewport + 1), false);
  const { chromeInset, chipW, mapCellW, mapCellGap } = MAP_CHROME_TOKENS;
  for (const coarse of [false, true]) {
    assert.deepEqual(mapChromeCellSize(maxViewport, coarse), { width: cell, height: cell });
    assert.equal(mapChromeCellSize(maxViewport + 1, coarse).width, mapCellW);
    for (const { slot } of MAP_CHROME_SEATS) {
      assert.deepEqual(mapChromeSeatRect(slot, 500, minViewport, coarse), {
        x: 500 - chromeInset - cell,
        y: chromeInset + (slot - 1) * (cell + mapCellGap),
        width: cell,
        height: cell
      });
    }
  }
  assert.equal(mapCellIconCentreX(500, minViewport), 500 - chromeInset - cell / 2);

  // Sidebar open is the tightest map: at every band width the icon column
  // clears the 288 px chip at x 12 by at least the 4 px gap. The open
  // sidebar's width comes from the same clamp the tablet query holds.
  const clamp = /--sidebar-w\s*:\s*clamp\(\s*([0-9.]+)px\s*,\s*calc\(\s*([0-9.]+)vw\s*\+\s*([0-9.]+)px\s*\)\s*,\s*([0-9.]+)px\s*\)/.exec(code);
  assert.ok(clamp, 'app.css lost the tablet --sidebar-w clamp');
  const [floor, vw, add, cap] = [clamp[1], clamp[2], clamp[3], clamp[4]].map(Number);
  for (let viewport = minViewport; viewport <= maxViewport; viewport += 1) {
    const sidebar = Math.min(cap, Math.max(floor, (vw / 100) * viewport + add));
    const map = viewport - sidebar;
    const gap = mapChromeSeatRect(1, map, viewport, true).x - (chromeInset + chipW);
    assert.ok(gap >= mapCellGap, `at ${viewport}px with the sidebar open the column is ${gap}px from the chip`);
  }
});

test('the column rules read the tokens, and index.html carries every slot', () => {
  const column = ruleBody('.app-shell:not(.embed) .map-overlay-controls');
  for (const line of [
    'top: var(--chrome-inset)',
    'right: var(--chrome-inset)',
    'grid-template-columns: var(--map-cell-w)',
    'grid-template-rows: repeat(4, var(--map-cell-h))',
    'gap: var(--map-cell-gap)'
  ]) {
    assert.ok(column.includes(line), `the column rule lost "${line}"`);
  }

  const cell = ruleBody('.app-shell:not(.embed) .map-overlay-controls .map-cell');
  const { edge, paddingInline, iconColumn, iconGap, labelFontPx } = MAP_CELL_ANATOMY;
  for (const line of [
    `grid-template-columns: ${iconColumn}px 1fr`,
    `column-gap: ${iconGap}px`,
    `padding: 0 ${paddingInline}px`,
    `border: ${edge}px solid var(--keyline)`,
    `font-size: ${labelFontPx}px`,
    'border-radius: 0'
  ]) {
    assert.ok(cell.includes(line), `the cell rule disagrees with MAP_CELL_ANATOMY: "${line}"`);
  }

  // Each slot's box exists in the shipped markup with its slot number.
  const slotMarkup = {
    1: /<button id="reset-btn"[^>]*data-map-slot="1"/,
    2: /<div id="basemap-switcher-overlay-host"[^>]*data-map-slot="2"/,
    3: /<div id="map-info-seat"[^>]*data-map-slot="3"/,
    4: /<span class="map-spine-reserve" data-map-slot="4"/
  };
  for (const seat of MAP_CHROME_SEATS) {
    assert.match(html, slotMarkup[seat.slot], `index.html lost slot ${seat.slot} (${seat.key})`);
  }
});
