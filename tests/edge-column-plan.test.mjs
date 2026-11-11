import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The phone shell's right-edge column (owner direction 2026-11-09 (sprint),
 * DR-pending): the pure planner in src/config/edge-column.ts and its mirror
 * in src/styles/edge-column.css.
 *
 * The planner is the no-overlap contract. Every right-edge control rides one
 * flow, so two controls cannot share pixels; what this file proves is the
 * other half: for every height a phone can present, the arrangement the
 * planner returns really fits the room it was given (or is the final
 * arrangement and says so), never shrinks a touch target under 44 px, and
 * never drops a group. The heights are recomputed here from the plan, not
 * read back from the planner's own `height` field.
 *
 * Runs under plain `node --test`: edge-column.ts is import-free, so Node
 * 24's type stripping loads it with no resolve hook.
 */

const ROOT = new URL('..', import.meta.url);
const {
  EDGE_COLUMN_TOKENS,
  EDGE_COLUMN_PROPERTIES,
  EDGE_GROUP_ORDER,
  EDGE_CONDITIONAL_SEATS,
  EDGE_GROUP_NAMES,
  EDGE_TWO_TRACK_SEATS,
  conditionalReserve,
  planEdgeColumn
} = await import(new URL('src/config/edge-column.ts', ROOT).href);

const css = (await readFile(new URL('src/styles/edge-column.css', ROOT), 'utf8')).replace(
  /\/\*[\s\S]*?\*\//g,
  ''
);

/** The control counts a phone can show: Map information waits while a panel is open; later seats add view tools. */
const DEMANDS = [];
for (const utility of [2, 3]) {
  for (const view of [1, 2, 3]) {
    DEMANDS.push([
      { id: 'utility', count: utility },
      { id: 'panels', count: 4 },
      { id: 'hazards', count: 4 },
      { id: 'view', count: view }
    ]);
  }
}
const WIDTHS = [320, 360, 375, 390, 412, 430, 568, 667, 720];

function recomputeTrackHeights(plan, groups, badge) {
  const count = new Map(
    groups.map((group) => [group.id, group.count > 0 ? Math.max(group.count, group.reserve ?? 0) : 0])
  );
  return plan.tracks.map((ids, index) => {
    let cells = 0;
    for (const id of ids) {
      const n = count.get(id) ?? 0;
      cells += plan.folded.includes(id) && n > 1 ? 1 : n;
    }
    const gaps = Math.max(0, ids.length - 1) * plan.gap;
    const badgeBlock = badge && plan.badgeTrack === index ? EDGE_COLUMN_TOKENS.badgeBlock : 0;
    return cells * plan.size + gaps + badgeBlock;
  });
}

test('the stylesheet declares the planner defaults it mirrors', () => {
  const declared = (property) => {
    const match = css.match(new RegExp(`${property}\\s*:\\s*([^;]+);`));
    assert.ok(match, `edge-column.css does not declare ${property}`);
    return match[1].trim();
  };
  assert.equal(declared(EDGE_COLUMN_PROPERTIES.size), `${EDGE_COLUMN_TOKENS.sizes[0]}px`);
  assert.equal(declared(EDGE_COLUMN_PROPERTIES.gap), `${EDGE_COLUMN_TOKENS.gap}px`);
  assert.equal(declared('--edge-inset'), `${EDGE_COLUMN_TOKENS.inset}px`);
  assert.equal(declared('--edge-badge-block'), `${EDGE_COLUMN_TOKENS.badgeBlock}px`);
  // Every older reservation of the control column reads the column's real width.
  assert.equal(declared('--mobile-map-control-size'), `var(${EDGE_COLUMN_PROPERTIES.width})`);
});

test('every cell size the planner may choose clears the 44 px touch floor', () => {
  for (const size of EDGE_COLUMN_TOKENS.sizes) assert.ok(size >= EDGE_COLUMN_TOKENS.minTarget);
  assert.equal(EDGE_COLUMN_TOKENS.minTarget, 44);
});

test('every group has a name, a folded name and a two-track seat', () => {
  for (const id of EDGE_GROUP_ORDER) {
    assert.ok(EDGE_GROUP_NAMES[id].group.length > 0);
    assert.ok(EDGE_GROUP_NAMES[id].fold.length > 0);
    assert.ok(EDGE_TWO_TRACK_SEATS[id] === 0 || EDGE_TWO_TRACK_SEATS[id] === 1);
  }
});

test('for every phone height the returned arrangement fits, keeps 44 px cells and drops nothing', () => {
  let checked = 0;
  for (const viewportWidth of WIDTHS) {
    for (const groups of DEMANDS) {
      for (const badge of [true, false]) {
        for (let viewportHeight = 240; viewportHeight <= 1000; viewportHeight += 1) {
          const availableHeight = viewportHeight - 2 * EDGE_COLUMN_TOKENS.inset;
          const plan = planEdgeColumn({ availableHeight, viewportWidth, viewportHeight, groups, badge });
          const where = `${viewportWidth}x${viewportHeight} ${JSON.stringify(groups.map((g) => g.count))} badge=${badge}`;
          assert.ok(plan.size >= EDGE_COLUMN_TOKENS.minTarget, `cell under 44 px at ${where}`);
          assert.ok(plan.tracks.length >= 1 && plan.tracks.length <= 2, `track count at ${where}`);
          const placed = plan.tracks.flat();
          assert.deepEqual([...placed].sort(), [...EDGE_GROUP_ORDER].sort(), `a group was dropped at ${where}`);
          const heights = recomputeTrackHeights(plan, groups, badge);
          const tallest = Math.max(...heights);
          assert.equal(plan.height, tallest, `reported height disagrees at ${where}`);
          if (plan.fits) {
            assert.ok(tallest <= availableHeight, `plan claims a fit it does not have at ${where}`);
          } else {
            // Only the final arrangement may admit it does not fit.
            assert.equal(plan.tracks.length, 2, `gave up before two tracks at ${where}`);
            assert.equal(
              plan.folded.length,
              groups.filter((group) => group.count > 1).length,
              `gave up before folding every group at ${where}`
            );
          }
          assert.equal(
            plan.width,
            plan.tracks.length * plan.size + (plan.tracks.length - 1) * plan.gap,
            `reported width at ${where}`
          );
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 80_000);
});

test('the arrangement is the largest one with everything displayed, in the documented order', () => {
  const groups = [
    { id: 'utility', count: 3 },
    { id: 'panels', count: 4 },
    { id: 'hazards', count: 4 },
    { id: 'view', count: 1 }
  ];
  const at = (viewportWidth, viewportHeight) =>
    planEdgeColumn({
      availableHeight: viewportHeight - 2 * EDGE_COLUMN_TOKENS.inset,
      viewportWidth,
      viewportHeight,
      groups,
      badge: true
    });

  // Tall phone: the full 52 px cells, one track, nothing folded.
  let plan = at(390, 844);
  assert.deepEqual([plan.size, plan.tracks.length, plan.folded], [52, 1, []]);
  // Narrower than 380 px never takes 52 px cells, to keep the map wide.
  plan = at(360, 900);
  assert.equal(plan.size, 48);
  // The short phone of the owner's ask (375 by 667): still everything displayed.
  plan = at(375, 667);
  assert.deepEqual([plan.tracks.length, plan.folded], [1, []]);
  assert.ok(plan.size >= 44);
  // The same phone with browser chrome showing: the map tools fold first.
  plan = at(375, 553);
  assert.deepEqual([plan.size, plan.tracks.length, plan.folded], [44, 1, ['utility']]);
  // A landscape phone inside the phone shell: two tracks, nothing folded.
  plan = at(667, 375);
  assert.deepEqual([plan.size, plan.tracks.length, plan.folded], [44, 2, []]);
  assert.deepEqual(plan.tracks, [
    ['panels', 'view'],
    ['utility', 'hazards']
  ]);
});

/** Every mode the conditional table names, plus one it does not (a mode that seats nothing extra). */
const MODES = [...new Set(['drought', ...EDGE_CONDITIONAL_SEATS.flatMap((seat) => seat.modes)])];
const ALWAYS = { utility: 3, panels: 4, hazards: 4, view: 1 };

/** The demand a phone shows in `mode`: the always-present cells plus that mode's own seats. */
function demandFor(mode, { reserve }) {
  return EDGE_GROUP_ORDER.map((id) => {
    const own = EDGE_CONDITIONAL_SEATS.filter((seat) => seat.group === id && seat.modes.includes(mode)).length;
    return { id, count: ALWAYS[id] + own, ...(reserve ? { reserve: ALWAYS[id] + conditionalReserve(id) } : {}) };
  });
}

test('the reserve of a group is the most conditional cells any one mode seats there', () => {
  assert.ok(MODES.length >= 3, 'the table should name more than one mode');
  for (const id of EDGE_GROUP_ORDER) {
    const perMode = MODES.map(
      (mode) => EDGE_CONDITIONAL_SEATS.filter((seat) => seat.group === id && seat.modes.includes(mode)).length
    );
    assert.equal(conditionalReserve(id), Math.max(...perMode), id);
  }
  // Today: the ENSO Guide door in panels, the 3D entry in view; nothing else is conditional.
  assert.deepEqual(
    EDGE_GROUP_ORDER.map((id) => conditionalReserve(id)),
    [0, 1, 0, 1]
  );
  assert.equal(new Set(EDGE_CONDITIONAL_SEATS.map((seat) => `${seat.group}:${seat.order}`)).size, EDGE_CONDITIONAL_SEATS.length);
});

test('a mode that adds a cell never changes the plan: every always-present cell keeps its place', () => {
  let differsWithoutReserve = 0;
  for (const viewportWidth of WIDTHS) {
    for (let viewportHeight = 240; viewportHeight <= 1000; viewportHeight += 1) {
      const availableHeight = viewportHeight - 2 * EDGE_COLUMN_TOKENS.inset;
      const plans = (reserve) =>
        MODES.map((mode) =>
          JSON.stringify(
            planEdgeColumn({ availableHeight, viewportWidth, viewportHeight, groups: demandFor(mode, { reserve }), badge: true })
          )
        );
      assert.equal(new Set(plans(true)).size, 1, `plan moved between modes at ${viewportWidth}x${viewportHeight}`);
      if (new Set(plans(false)).size > 1) differsWithoutReserve += 1;
    }
  }
  // The same sweep without the reserve does move, so the assertion above has teeth.
  assert.ok(differsWithoutReserve > 0);
});

test('the union folds the map tools in every mode at 360 by 640, as the fullest mode alone would', () => {
  for (const mode of MODES) {
    const plan = planEdgeColumn({
      availableHeight: 640 - 2 * EDGE_COLUMN_TOKENS.inset,
      viewportWidth: 360,
      viewportHeight: 640,
      groups: demandFor(mode, { reserve: true }),
      badge: true
    });
    assert.deepEqual([plan.size, plan.tracks.length, plan.folded], [44, 1, ['utility']], mode);
  }
});

test('a reserve never gives room to an empty group, and never lowers a count', () => {
  const plan = planEdgeColumn({
    availableHeight: 900,
    viewportWidth: 390,
    viewportHeight: 916,
    groups: [
      { id: 'utility', count: 0, reserve: 3 },
      { id: 'panels', count: 5, reserve: 2 },
      { id: 'hazards', count: 4 },
      { id: 'view', count: 1, reserve: 2 }
    ],
    badge: false
  });
  assert.ok(!plan.tracks.flat().includes('utility'));
  // 5 + 4 + 2 cells at 52 px, two gaps of 8.
  assert.equal(plan.height, 11 * 52 + 2 * 8);
});

test('the stylesheet holds each group open to its reserve and keeps the empty slot off the map', () => {
  assert.equal(EDGE_COLUMN_PROPERTIES.reserve, '--edge-reserve');
  assert.match(
    css,
    /\.edge-group\s*\{[^}]*min-block-size:\s*calc\(var\(--edge-size\)\s*\*\s*var\(--edge-reserve,\s*0\)\s*\+\s*2px\)/
  );
  assert.match(css, /\.edge-group\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.edge-body,\s*\.edge-fold\s*\{\s*pointer-events:\s*auto/);
});

test('a framed page keeps its studio link-outs on a phone, beside the column', () => {
  // Only the empty seats go; the pair, the one route to the studios in a frame, stays.
  assert.match(
    css,
    /#app\[data-sheet-detent\] \.map-overlay-controls > :not\(\.studio-linkout-pair\)\s*\{\s*display:\s*none;/
  );
  assert.doesNotMatch(css, /#app\[data-sheet-detent\] \.map-overlay-controls\s*\{\s*display:\s*none/);
  const shifted = css.match(/#app\[data-sheet-detent\] \.map-overlay-controls\s*\{([^}]*)\}/);
  assert.ok(shifted && /right:[^;]*var\(--edge-column-w\)/.test(shifted[1]), 'the pair must clear the column');
});

test('a group with one control is never folded, and an empty group takes no room', () => {
  const plan = planEdgeColumn({
    availableHeight: 150,
    viewportWidth: 360,
    viewportHeight: 166,
    groups: [
      { id: 'utility', count: 1 },
      { id: 'panels', count: 4 },
      { id: 'hazards', count: 0 },
      { id: 'view', count: 1 }
    ],
    badge: false
  });
  assert.ok(!plan.folded.includes('utility'));
  assert.ok(!plan.folded.includes('view'));
  assert.ok(!plan.tracks.flat().includes('hazards'));
});
