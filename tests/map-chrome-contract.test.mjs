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
const shellSrc = await readFile(new URL('src/ui/island/shell.tsx', ROOT), 'utf8');

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

  // The cell holds the widest word with its designed right inset. "Share"
  // measured 39.0 px in DDM Heros at 1920x943, 2026-11-12 ("Reset" 38.1), so
  // the need is edge + padding + icon + gap + word + padding + edge = 87 px;
  // the check keeps 5 px of room for a zoomed or wider face.
  const SHARE_WORD_PX = 44;
  const need = edge + paddingInline + iconColumn + iconGap + SHARE_WORD_PX + paddingInline + edge;
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
    4: /<button id="share-btn"[^>]*data-map-slot="4"/
  };
  for (const seat of MAP_CHROME_SEATS) {
    assert.match(html, slotMarkup[seat.slot], `index.html lost slot ${seat.slot} (${seat.key})`);
  }
  // Share is slot 4's own box, as Reset is slot 1's: no empty reserve under it.
  assert.equal(
    MAP_CHROME_SEATS.find((seat) => seat.slot === 4)?.slotSelector,
    '.map-overlay-controls > #share-btn'
  );
  assert.doesNotMatch(html, /map-spine-reserve/, 'the retired slot 4 reserve span is gone');
  assert.doesNotMatch(css, /map-spine-reserve/, 'no stylesheet rule for the retired reserve span');

  // Share keeps slot 4 in Brief too (owner 2026-10-19): no sidebar Share seat
  // in the markup and no Share entry in the Brief rehost table.
  assert.doesNotMatch(html, /id="shell-share-host"/, 'the sidebar Share seat is gone');
  assert.doesNotMatch(shellSrc, /nodeId:\s*'share-btn'/, 'Share is not rehosted');
});

// Owner 2026-10-19: controls stay put across modes. The Console strip sits
// below the hazard buttons and the ENSO buttons above the mode-sized view
// details. Owner 2026-11-13 (items 11 and 13): desktop Brief seats the strip
// on the map under the Key chip, and the sidebar's foot dock with Layer
// legends is gone.
test('sidebar seats: no mode-sized block sits above a control', () => {
  const at = (s) => {
    const i = html.indexOf(s);
    assert.ok(i >= 0, `index.html lost ${s}`);
    return i;
  };
  assert.ok(at('id="shell-panel"') < at('id="conditions-strip-home"'), 'the Console strip home sits below the hazard buttons');
  assert.match(html, /<span id="conditions-strip-home" hidden><\/span>\s*<section[^>]*id="conditions-strip"/);
  // syncTimeBarHost reseats the bar right after the shell panel at runtime, so
  // the static band order is shell, bar, then Brief display; the strip home
  // marker is not adjacent to either and no spec may assume it is.
  assert.ok(
    at('id="shell-panel"') < at('id="time-bar"') && at('id="time-bar"') < at('id="brief-display"'),
    'the time bar sits between the shell panel and Brief display'
  );
  assert.ok(
    at('id="brief-display"') < at('id="enso-flow-controls"') && at('id="enso-flow-controls"') < at('id="shell-details-panel"'),
    'the ENSO buttons sit above the variable view details'
  );
  const indicator = html.slice(at('id="map-condition-indicator"'), at('id="hover-inspector"'));
  const keyHost = indicator.indexOf('id="map-key-overlay-host"');
  const strip = indicator.indexOf('id="conditions-strip-dock"');
  assert.ok(keyHost >= 0 && strip > keyHost, 'the strip seat follows the Key chip in the floating window');
  assert.doesNotMatch(html, /sidebar-bottom-dock|sidebar-legend-disclosure|sidebar-key-host|legend-panel-home/, 'the foot dock and Layer legends are gone');
  assert.match(html, /id="legend-panel"/, 'Console keeps its legend panel');
  assert.match(code, /#app\.view-brief:not\(\.embed\) #legend-panel \{ display: none; \}/, 'Brief hides the Console legend panel');
  assert.doesNotMatch(shellSrc, /legend-panel|holdSummarySeat|--dock-h/);
  assert.doesNotMatch(code, /sidebar-bottom-dock|sidebar-legend-disclosure|--dock-h/, 'no rule for the retired dock');
  assert.match(code, /#app\.view-brief:not\(\.embed\) \.sidebar-scroll \{ display: flex; flex-direction: column; \}/);
});

// The Key's door buttons (Nino 3.4, one per storm) inherit 11 px text with no
// padding; the desktop census measures with the drawer closed, so the floor is
// held here.
test('the Key door buttons keep the 24 px pointer floor', () => {
  assert.match(ruleBody('.map-key-door'), /min-height:\s*var\(--pointer-target\);/);
});

// The 3D reveal scrolls the sidebar; the horizon row sticks under the sticky
// mode row instead of sliding beneath it. The mode row's height is measured.
test('the Brief horizon row sticks under the mode row', () => {
  const when = ruleBody('#app.view-brief:not(.embed) .shell-when');
  assert.match(when, /position:\s*sticky;/);
  assert.match(when, /top:\s*calc\(var\(--shell-view-h\) - 4px\);/);
  assert.match(when, /background:\s*var\(--bg-1\);/);
  assert.match(shellSrc, /setProperty\('--shell-view-h', `\$\{view\.offsetHeight\}px`\)/);
});

// A control reached by Tab scrolls only to the scroller's edge; the scroll
// padding keeps its focus ring clear of the sticky rows (WCAG 2.4.11).
test('the Brief column scroll padding clears the sticky rows', () => {
  assert.match(
    code,
    /#app\.view-brief:not\(\.embed\) \.sidebar-scroll \{\s*scroll-padding-top:\s*calc\(var\(--shell-view-h, 0px\) \+ var\(--shell-when-h, 0px\)\);/
  );
  assert.match(shellSrc, /setProperty\('--shell-when-h', `\$\{when\.offsetHeight\}px`\)/);
  // Custom properties inherit downward only: the scroller itself must carry them.
  assert.match(shellSrc, /const scroller = shell\.closest<HTMLElement>\('\.sidebar-scroll'\) \?\? shell;/);
});

// Owner 2026-11-13 (item 11 and "one single box"): in desktop Brief the Key chip
// carries the mode's own lead Conditions-in-view reading as its title; the strip
// is parked unseen in the dock and is still the page's one region of that name.
test('Conditions in view leads the Key chip in one box', async () => {
  const stripSrc = await readFile(new URL('src/ui/island/conditions-strip.tsx', ROOT), 'utf8');
  const keySrc = await readFile(new URL('src/ui/map-key.ts', ROOT), 'utf8');
  const timeSrc = await readFile(new URL('src/ui/island/time-popover.tsx', ROOT), 'utf8');
  assert.match(html, /id="conditions-strip" aria-label="Conditions in view"/);
  assert.doesNotMatch(shellSrc, />Conditions in view</, 'the shell summary is not a second region of the same name');
  const indicators = (await readFile(new URL('src/styles/hazard-indicators.css', ROOT), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(indicators, /#conditions-strip-dock \{\s*display: none;\s*\}/, 'the strip is parked unseen');
  assert.match(indicators, /(^|\})\s*#map-condition-indicator \.map-key \{/, 'the Key chip glass, with no reading line beside it');
  assert.doesNotMatch(indicators, /#map-condition-indicator \.conditions-metric/);
  const chipText = indicators.match(/\.map-key-chip-text \{([^}]*)\}/);
  assert.ok(chipText, 'the chip text rule');
  assert.match(chipText[1], /white-space:\s*nowrap;/);
  assert.match(chipText[1], /text-overflow:\s*ellipsis;/);
  assert.doesNotMatch(code, /#conditions-strip-dock \./, 'no rule for the retired reading line');
  assert.match(stripSrc, /setConditionsHeadline\(/);
  assert.match(keySrc, /onConditionsHeadline\(/);
  assert.match(html, /<span id="map-key-reading-status" class="sr-only" role="status"/);
  // Console still shows its status line when no tile renders.
  assert.match(stripSrc, /<p class="conditions-empty">[^<]+<\/p>\s*<\/>/, 'the status line renders last');
  assert.match(code, /\.conditions-metric ~ \.conditions-empty \{ display: none; \}/);
  // The WHEN line's freshness square keeps a gap from the horizon words.
  assert.match(timeSrc, /class="shell-time-headline-horizon"[^\n]*\n\s*\{spec\.stamp\.freshness \? \(\s*<span class="feed-current"/);
  assert.match(ruleBody('.shell-time-headline .feed-current'), /margin-left:\s*\d+px;/);
});

// Owner 2026-11-13 (items 8, 10 and 14): Brief carries no loading or
// availability ledger and no date line; Console draws both, the date line as
// the column's very last element.
test('Brief clips the display caveat and the date line is the Console column foot', () => {
  // The caveat stays a mounted polite live region, clipped in Brief, never display:none.
  assert.match(shellSrc, /<p class="shell-summary-caveat" id="shell-summary-caveat" aria-live="polite">/);
  const clip = ruleBody('#app.view-brief .shell-summary-caveat');
  assert.match(clip, /clip:\s*rect\(0, 0, 0, 0\);/);
  assert.doesNotMatch(clip, /display:\s*none/);
  assert.match(ruleBody('#app.view-brief #shell-details-island > .shell-summary'), /margin-block:\s*0;/);

  // One date line, rendered into its own host after the credit, at the end of the scroll column.
  assert.match(
    html,
    /<\/footer>\s*<!--[\s\S]*?-->\s*<div id="shell-time-island" class="shell-time-foot"><\/div>\s*<\/div>\s*<!-- The S4c panel-foot/
  );
  assert.equal(shellSrc.match(/<TimeCompact /g)?.length, 1, 'exactly one date line (one id="shell-time")');
  const shellBody = shellSrc.slice(shellSrc.indexOf('function Shell('), shellSrc.indexOf('function ShellDetails('));
  assert.doesNotMatch(shellBody, /<TimeCompact/, 'the horizon row no longer carries the date line');
  assert.match(shellSrc, /getElementById\('shell-time-island'\)/);
  assert.match(shellSrc, /render\(<ShellTimeFoot /);
  assert.match(ruleBody('.shell-time-foot'), /display:\s*none;/);
  assert.match(ruleBody('#app.view-console:not(.embed) .shell-time-foot'), /display:\s*block;/);
});

// Owner 2026-11-13 (items 7, 8 and 15): the four map cells and the desktop
// briefing drawer wear the Key's glass and blur, by token.
test('the map cells and the briefing drawer wear the Key glass', () => {
  const cell = ruleBody('.app-shell:not(.embed) .map-overlay-controls .map-cell');
  assert.match(cell, /background:\s*var\(--glass-read\) !important;/);
  assert.match(cell, /(?:^|[^-])backdrop-filter:\s*blur\(var\(--rich-black-blur\)\);/);
  assert.match(ruleBody('.app-shell:not(.embed) .map-overlay-controls .map-cell:hover'), /var\(--glass-press\)[^;]*var\(--glass-read\) !important;/);
  const drawer = ruleBody('.impact-panel:not(.sheet-hosted)');
  assert.match(drawer, /background:\s*var\(--glass-read\);/);
  assert.match(drawer, /(?:^|[^-])backdrop-filter:\s*blur\(var\(--rich-black-blur\)\);/);
  // The opaque base stays the fallback where the browser cannot blur.
  assert.match(ruleBody('.impact-panel'), /background:\s*var\(--bg-1\);/);
  assert.match(code, /@supports \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{\s*@media screen and \(min-width: 721px\) \{\s*\.impact-panel:not\(\.sheet-hosted\) \{/);
});

// The camera pad that keeps a framed place clear of the briefing drawer follows the drawer's own width formula.
// It stopped at 480 px while the drawer grew to 38vw, which left a picked place's east edge under the drawer at
// 1440 px (browser look, 2026-11-13).
test('the briefing camera pad follows the drawer width formula in the stylesheet', async () => {
  assert.match(code, /--impact-panel-w-min:\s*440px;/);
  assert.match(code, /--impact-panel-w:\s*clamp\(var\(--impact-panel-w-min\),\s*38vw,\s*880px\);/);
  const deepLink = (await readFile(new URL('src/state/deep-link.ts', ROOT), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(deepLink, /Math\.min\(Math\.max\(440,\s*Math\.round\(window\.innerWidth \* 0\.38\)\),\s*880\)/);
  assert.match(deepLink, /right:\s*panelWillOpen \? Math\.min\(drawer \+ 40,/);
});
