import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * DDM-P1-T09 e (M5), repaired for C4R review finding C8
 * (C:/dev/_reviews/dynamic-drought-module/2026-09-26_s30d-c4-session-codex-r1.md).
 * The launch prompt reads "no non-tile sleep remains" as a Tier 1 rule. Read
 * literally it is unachievable: most `waitForTimeout` sites in
 * tests/*.spec.ts are an absence window after releasing stale or aborted
 * work, a pacing gap between synthetic input events, a known app-side
 * debounce, an animation or repaint settle, a sampling loop over a
 * continuous signal, or a window deliberately nested inside a fetch this
 * test wants to keep pending. `whenQuiescent` (src/state/boot-idle.ts, read
 * through `window.__ddm`) cannot stand in for any of those: it resolves on
 * an ABSENCE of pending layers and shared transports, which says nothing
 * about a stale response, a keyboard repeat, a CSS transition, a raster
 * pixel, or a fetch this test is holding open on purpose.
 *
 * What the seam CAN prove: whether a specific named shared transport (for
 * example `us-states-geojson`, `US_STATES_SHARED_KEY` in src/util/fetch.ts)
 * is still in flight. A sleep that exists only to give such a transport time
 * to finish is "seam-observable-non-tile" and belongs on `awaitQuiescence`
 * (tests/helpers.ts) instead of a fixed wait. This inventory enumerates
 * every current site against a declared reason class so:
 *   - a NEW waitForTimeout site with no entry here fails the gate instead of
 *     quietly joining an unread list;
 *   - a declared site whose call text has vanished from its file is caught
 *     rather than silently going stale;
 *   - a declared class that is not one of the vocabulary's own members fails
 *     the gate instead of silently passing;
 *   - the seam-observable-non-tile class is asserted EMPTY: every sleep this
 *     run found in that class has already been migrated onto the seam, and
 *     none may be re-added without failing here first.
 *
 * Discovery (finding C8): the scanner parses a lightweight code/comment mask
 * of each file (comments and string/template contents blanked out, code left
 * in place) so a `waitForTimeout` mention inside a `//` or `/* *\/` comment
 * never counts as a call, then finds the identifier by a word boundary
 * (matching `waitForTimeout (500)` and any other spacing), walks forward to
 * the call's OWN matching closing parenthesis (so a multi-line argument list
 * is captured in full, not just its first line), and walks backward over the
 * property-access chain and an optional leading `await` to the start of the
 * expression. The captured text is the complete call, normalised by
 * collapsing all whitespace (including embedded newlines) to single spaces.
 *
 * Identity (finding C8): a site is keyed by (file, the title string of its
 * nearest lexically enclosing named scope, the normalised full call text,
 * and that tuple's occurrence index within the file), NOT by line number and
 * NOT by file+text alone. "Nearest lexically enclosing named scope" is the
 * smallest span among every `test(...)`, `test.only(...)`, `test.skip(...)`,
 * `test.step(...)`, `test.describe(...)` call (keyed by its own first
 * string-literal argument) and every named `function name(...) {...}`
 * declaration that contains the call; a call with no such enclosing scope is
 * keyed under the literal string '(module scope)'. A shared helper function
 * (for example `waitForStableMarker` in popup-viewport.spec.ts) used by
 * several tests is keyed by its OWN name, not by whichever test happens to
 * call it, since that is the only identity a lexical scan can attach to code
 * that does not live inside any single test body. Moving an identical call
 * from one test into another therefore changes its key, so the OLD key goes
 * missing and the NEW key is unclassified, both caught by the tests below,
 * rather than the old reason silently riding along under a coincidentally
 * matching file+text+occurrence tuple.
 *
 * `line` is kept per entry only as an informational hint for a human reading
 * the table; nothing here enforces it, and it may drift without failing
 * this test (an unrelated edit above a site routinely moves its line without
 * moving its enclosing scope, its call text, or its occurrence within them).
 *
 * tile-dependent sites (fire3d-mode.spec.ts: a live scene and its terrain
 * tiles, which fire3d.ts reports through no registry status the seam can
 * read) are deferred to microtask M7 and stay classified, not migrated,
 * here.
 */

/**
 * @typedef {'absence-window'|'input-pacing'|'debounce'|'animation-settle'|'sampling-window'|'held-fetch-window'|'tile-dependent'|'seam-observable-non-tile'} ReasonClass
 */

/** @type {ReadonlyArray<ReasonClass>} */
const REASON_CLASSES = Object.freeze([
  'absence-window',
  'input-pacing',
  'debounce',
  'animation-settle',
  'sampling-window',
  'held-fetch-window',
  'tile-dependent',
  'seam-observable-non-tile'
]);

/** @type {ReadonlyArray<{file: string, line: number, test: string, text: string, occurrence: number, class: ReasonClass, reason: string}>} */
const SITES = [
  {
    file: 'cluster-controller-integration.spec.ts',
    line: 183,
    test: 'rapid A -> B -> A through the shell: stale first-generation work never corrupts the settled display',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so a stale, superseded generation cannot (wrongly) land before the assertion.'
  },
  // deployment-subpath.spec.ts:65 was seam-observable-non-tile; migrated
  // onto `awaitQuiescence` (tests/deployment-subpath.spec.ts) and so no
  // longer contains a `waitForTimeout` call to declare here.
  {
    file: 'fire3d-mode.spec.ts',
    line: 1665,
    test: 'the desktop toggle activates the 3D scene with the volume legend, then exits cleanly',
    text: 'await page.waitForTimeout(4_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'terrain-tile settle before the pitched-scene screenshot; fire3d writes no registry status a seam could read (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 1870,
    test: 'a RAWS station marker in the active 3D scene is a MapLibre-managed marker and carries the same wind glyph as on the flat map',
    text: 'await page.waitForTimeout(2_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'live basemap and camera-driven tile settle before the panel-reveal actionability check (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2023,
    test: 'reduced motion still enters and leaves the 3D scene',
    text: 'await page.waitForTimeout(4_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'scene-tile settle after the camera-fly stamp reaches active, before the evidence capture (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2135,
    test: 'an embed without the flag never activates and never gains it',
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'settle window proving an embed without the flag never activates the scene or its tiles (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2161,
    test: 'a mobile viewport never fetches the 3D chunks',
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'mobile-viewport settle proving no scene chunk request fires (deferred to M7).'
  },
  {
    file: 'fire3d-mode.spec.ts',
    line: 2182,
    test: 'a short desktop window explains its 3D refusal and never enters the scene',
    text: 'await page.waitForTimeout(3_000);',
    occurrence: 1,
    class: 'tile-dependent',
    reason:
      'short-viewport settle proving the scene withdraws rather than mounting tiles (deferred to M7).'
  },
  {
    file: 'heat-h0-integrity.spec.ts',
    line: 432,
    test: 'the NWS layer pauses while hidden and refreshes one stale snapshot on return',
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "past the visibility-driven refresh scheduler's own interval with no clock advance; proves no early second fetch."
  },
  {
    file: 'heat-h0-integrity.spec.ts',
    line: 448,
    test: 'the NWS layer pauses while hidden and refreshes one stale snapshot on return',
    text: 'await page.waitForTimeout(150);',
    occurrence: 2,
    class: 'debounce',
    reason:
      "past the refresh scheduler's window after a repeat visibilitychange with no clock advance; proves no duplicate refetch."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 754,
    test: 'a place change aborts the old point read and keeps the newer briefing current',
    text: 'await page.waitForTimeout(100);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so the superseded station response cannot overwrite the new selection before the assertion.'
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 788,
    test: 'reopening the same briefing reuses completed NWS responses',
    text: 'await page.waitForTimeout(100);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window after reopening a completed briefing, proving the cached NWS responses are reused with no new request.'
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1061,
    test: 'toggling the layer off then on with the briefing open costs no extra identify request',
    text: 'await page.waitForTimeout(700);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window past the fallback's own roughly 500 ms interval, proving no request follows."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1090,
    test: 'toggling the layer off and LEAVING it off: the fallback answers once, past the settle window',
    text: 'await page.waitForTimeout(800);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window past the deactivation fallback's catalog-and-identify interval before reading the claim."
  },
  {
    file: 'heat-h2-point-heat.spec.ts',
    line: 1258,
    test: "(c) a superseded selection renders only the newer selection's claim",
    text: 'await page.waitForTimeout(200);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle so the superseded outlook response cannot add a stale claim before the assertion.'
  },
  {
    file: 'hover-inspector.spec.ts',
    line: 40,
    test: 'names what is under the cursor from an active layer, and clears on mouseout',
    text: 'await page.waitForTimeout(120);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "poll-loop interval inside a hover retry loop, past the inspector's own hover debounce."
  },
  {
    file: 'interaction-coordinator.spec.ts',
    line: 340,
    test: 'the selected place is promoted: a search-selected state wins an in-place click',
    text: 'await page.waitForTimeout(300);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      'lets the overlapping Tribal and reservation fills finish their style repaint before the disclosure is read.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 240,
    test: 'Tribal Lands and Reservation Boundaries toggled off mid-load abort their held queries',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted aiannh responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 290,
    test: 'Hydrography, which had no module seam of its own, aborts a held Overpass query',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted hydrography responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 323,
    test: 'Smoke Plumes toggled off mid-load aborts its held HMS query',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted hms-smoke responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 376,
    test: 'removing the ecoregion source aborts its held tile-data range reads',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after releasing aborted ecoregions responses; proves nothing resurrects the removed layer.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 493,
    test: 'a response released as intent changes to off renders nothing',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'STALE_SETTLE_MS after an uncheck-then-release race on aiannh; proves nothing from the stale response reaches the map.'
  },
  {
    file: 'layer-cancellation.spec.ts',
    line: 499,
    test: 'a response released as intent changes to off renders nothing',
    text: 'await page.waitForTimeout(STALE_SETTLE_MS);',
    occurrence: 2,
    class: 'absence-window',
    reason:
      'a second STALE_SETTLE_MS proving no deferred render arrives even later than the first window.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 272,
    test: 'a late British Columbia response cannot replace the region selected after it',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle after a held BC request, before reading the recovered region and legend state.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 302,
    test: 'No update popup says not measured and never presents value 99 as severity',
    text: 'await page.waitForTimeout(120);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'poll-loop click-retry interval waiting for the popup to paint after each synthetic click.'
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 366,
    test: 'switching an open United States briefing into British Columbia closes it before print',
    text: 'await page.waitForTimeout(250);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window establishing a stable 'before' briefing-resource-request count ahead of the region switch."
  },
  {
    file: 'm-breadth-bc-drought.spec.ts',
    line: 372,
    test: 'switching an open United States briefing into British Columbia closes it before print',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window after the region switch, proving no extra briefing resource request fired.'
  },
  {
    file: 'm-breadth-heatrisk-days.spec.ts',
    line: 354,
    test: 'switching days removes the superseded source before a late raster can paint',
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "post-release settle so the superseded day-1 raster cannot repaint over day-2's already-live pixels."
  },
  {
    file: 'mobile-sheet.spec.ts',
    line: 199,
    test: 'opening a side panel does not add a bottom camera inset',
    text: 'await page.waitForTimeout(350);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      "lets the sheet detent's CSS transition finish before re-measuring the map's south edge."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 244,
    test: 'a pan that stays inside the overscanned envelope issues no second request',
    text: 'await page.waitForTimeout(900);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "past the map's own 400 ms re-query debounce plus moveend and inertial settle."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 287,
    test: 'a jump far outside the envelope re-queries, reporting loading then live, never no-data in between',
    text: 'await page.waitForTimeout(50);',
    occurrence: 1,
    class: 'sampling-window',
    reason:
      '50 ms sampling loop over a fixed 5 s window, collecting every pill class the layer passes through.'
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 427,
    test: 'a pan back inside the still-cached envelope during an in-flight far jump keeps that view, not the far jump’s',
    text: 'await page.waitForTimeout(1_500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "past the reset's fitBounds settle and re-query debounce, proving the cached envelope served with no third request."
  },
  {
    file: 'nifc-query-scope.spec.ts',
    line: 439,
    test: 'a pan back inside the still-cached envelope during an in-flight far jump keeps that view, not the far jump’s',
    text: 'await page.waitForTimeout(1_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "after releasing a superseded response, bounds only that it cannot paint over the newer one within this window (the request-count and popup-identity assertions right after carry the unconditional proof)."
  },
  {
    file: 'place-studio.spec.ts',
    line: 611,
    test: "a Nation selection whose AIAN-LAR response lands after a newer State selection never overwrites that State's emphasis",
    text: 'await page.waitForTimeout(1_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'a deliberate fixed wait after releasing a stale response; bounded proof only, by the file’s own comment.'
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 369,
    test: 'the side panel does not create a bottom inset and the popup remains touch-scrollable',
    text: 'await page.waitForTimeout(30);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      '30 ms spacing between synthetic CDP touchMove steps inside a swipe gesture.'
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 909,
    test: 'waitForStableMarker',
    text: 'await page.waitForTimeout(250);',
    occurrence: 1,
    class: 'debounce',
    reason:
      "250 ms poll interval inside waitForStableMarker, waiting for the marker's DOM position to stop moving between reads."
  },
  {
    file: 'popup-viewport.spec.ts',
    line: 1083,
    test: 'titleAfterClick',
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      "150 ms settle after a click for the popup's synchronous paint before reading the title."
  },
  // popup-viewport.spec.ts:1387 was seam-observable-non-tile; migrated onto
  // `awaitQuiescence` (see the case above, line 1387) and so no longer
  // contains a `waitForTimeout` call to declare here.
  {
    file: 's4-shell.spec.ts',
    line: 786,
    test: 'a terminal replacement failure before first render runs the controller cleanup: checkbox, registry, and URL claim all withdraw',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle proving the withdrawn drought surface is not resurrected by the late stale monthly response.'
  },
  {
    file: 's4-shell.spec.ts',
    line: 919,
    test: 'toggling Drought off while its initial request is held tears down without waiting out the network budget',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-release settle proving the withdrawn studio drought checkbox state is not resurrected by the late stale response.'
  },
  {
    file: 'search-fit.spec.ts',
    line: 46,
    test: 'stateUnderProbe',
    text: 'await page.waitForTimeout(150);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'settle after two small mouse moves, before reading the hover-inspector item under the probe point.'
  },
  {
    file: 'search-fit.spec.ts',
    line: 88,
    test: 'selecting Washington frames the state, not a 480px-padded phantom panel',
    text: 'await page.waitForTimeout(600);',
    occurrence: 1,
    class: 'animation-settle',
    reason:
      'the 600 ms gap between two samples so a still-flying camera cannot read as landed (mid-fly the sampled pixel is still moving).'
  },
  {
    file: 'slim-entry.spec.ts',
    line: 172,
    test: 'a close intent drops a late panel chunk completion',
    text: 'await page.waitForTimeout(500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-response settle after the deferred runtime chunk resolves, before checking the panel never opened.'
  },
  {
    file: 'temporal-axis.spec.ts',
    line: 517,
    test: 'a HeatRisk day change keeps an honest loading state on the map for the whole fetch',
    text: 'await page.waitForTimeout(700);',
    occurrence: 1,
    class: 'held-fetch-window',
    reason:
      "day 2's tiles are deliberately held for this whole window while the continuity sampler runs; whenQuiescent would hang until release, so it cannot substitute."
  },
  {
    file: 'temporal-axis.spec.ts',
    line: 615,
    test: 'a drought horizon change keeps the previous outlook and says it is still loading',
    text: 'await page.waitForTimeout(700);',
    occurrence: 1,
    class: 'held-fetch-window',
    reason:
      'the season-ahead response is deliberately held for this whole window for the same continuity-sampling reason as line 517.'
  },
  {
    file: 'tribal-live-layers.spec.ts',
    line: 135,
    test: 'expectNoPopupAtMapCenter',
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'post-click settle proving no stale boundary popup remains clickable; the shared helper runs after many different layer-toggle scenarios, not one guaranteed transport.'
  },
  {
    file: 'umbrella.spec.ts',
    line: 185,
    test: 'an all-on click is a clean no-op and the button stays enabled and reusable',
    text: 'await page.waitForTimeout(750);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      "settle window after the CTA click, proving a would-be regression's extra live request never fires."
  },
  {
    file: 'url-state.spec.ts',
    line: 140,
    test: 'a bare boot never publishes an empty or partial layers value while the live defaults load (boot layer intent)',
    text: 'await page.waitForTimeout(200);',
    occurrence: 1,
    class: 'sampling-window',
    reason:
      'a 5-iteration, 200 ms-spaced sampling loop proving the boot-window layer set never degrades to empty or partial.'
  },
  {
    file: 'view-contracts.spec.ts',
    line: 185,
    test: 'runStep',
    text: 'await page.waitForTimeout(350);',
    occurrence: 1,
    class: 'input-pacing',
    reason:
      'settle between successive keyboard zoom-out presses so each keystroke registers before the next.'
  },
  {
    file: 'view-mode.spec.ts',
    line: 40,
    test: 'a bare URL opens Brief with NO unsolicited briefing (D-0.7.0-041)',
    text: 'await page.waitForTimeout(2_000);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window with no explicit selection and no deep link, proving the impact panel never auto-opens.'
  },
  {
    file: 'view-mode.spec.ts',
    line: 215,
    test: 'console does not need the minimap: it is hidden and stops the retained analysis fetches; Brief keeps both (owner ask, 2026-09-10)',
    text: 'await page.waitForTimeout(1_500);',
    occurrence: 1,
    class: 'absence-window',
    reason:
      'settle window giving the retained minimap analysis fetch a real chance to have started, before asserting it never did.'
  }
];

function normalizeCallText(text) {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Words after which a following `/` opens a regexp literal rather than
 * dividing (the previous emitted token cannot end an expression).
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'instanceof', 'yield', 'await'
]);

/**
 * Decides whether the `/` at `masked[i]` can open a regexp literal: true
 * unless the nearest previous non-whitespace character already emitted
 * (in `out`, so prior masking is respected) ends an expression, which
 * means an identifier/number that is not one of `REGEX_PRECEDING_KEYWORDS`,
 * a `)`, a `]`, or a closing string/template quote.
 */
function regexCanOpen(out, i) {
  let p = i - 1;
  while (p >= 0 && (out[p] === ' ' || out[p] === '\t' || out[p] === '\r' || out[p] === '\n')) p--;
  if (p < 0) return true;
  const prevChar = out[p];
  if (/[$\w]/.test(prevChar)) {
    let s = p;
    while (s >= 0 && /[$\w]/.test(out[s])) s--;
    const word = out.slice(s + 1, p + 1).join('');
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  if (prevChar === ')' || prevChar === ']' || prevChar === '"' || prevChar === "'" || prevChar === '`') {
    return false;
  }
  return true;
}

/**
 * Returns a same-length string where every character inside a `//` line
 * comment, a `/* *\/` block comment, a regexp literal, a single/double-quoted
 * string, or the static (non `${...}`) portion of a template literal is
 * replaced by a space, so a downstream scan for identifiers, parentheses and
 * keywords never sees comment, regexp or string content, while every
 * remaining column and line number still lines up with the ORIGINAL source.
 * Code nested inside a template-literal `${...}` interpolation is left
 * unmasked. A regexp literal's body (including any quote or `//` it holds)
 * is recognised by context, not mistaken for a comment or a string.
 */
function maskNonCode(source) {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') {
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i;
      out[j] = ' ';
      out[j + 1] = ' ';
      j += 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) {
        if (source[j] !== '\n') out[j] = ' ';
        j++;
      }
      if (j < n) {
        out[j] = ' ';
        out[j + 1] = ' ';
        j += 2;
      }
      i = j;
      continue;
    }
    if (c === '/' && next !== '/' && next !== '*' && regexCanOpen(out, i)) {
      let j = i;
      out[j] = ' ';
      j++;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const cj = source[j];
        if (cj === '\\') {
          out[j] = ' ';
          j++;
          if (j < n && source[j] !== '\n') out[j] = ' ';
          if (j < n) j++;
          continue;
        }
        if (cj === '[') {
          inClass = true;
          out[j] = ' ';
          j++;
          continue;
        }
        if (cj === ']') {
          inClass = false;
          out[j] = ' ';
          j++;
          continue;
        }
        if (cj === '/' && !inClass) {
          out[j] = ' ';
          j++;
          break;
        }
        out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j < n ? j + 1 : j;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && source[j] === '`') {
          j++;
          break;
        }
        if (depth === 0 && source[j] === '$' && source[j + 1] === '{') {
          j += 2;
          depth = 1;
          continue;
        }
        if (depth > 0) {
          if (source[j] === '{') depth++;
          else if (source[j] === '}') {
            depth--;
            if (depth === 0) {
              j++;
              continue;
            }
          }
          j++;
          continue;
        }
        if (source[j] !== '\n') out[j] = ' ';
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Index just past the `)` that balances the `(` at `openParenIndex`. */
function matchingParenEnd(masked, openParenIndex) {
  let depth = 0;
  for (let j = openParenIndex; j < masked.length; j++) {
    const ch = masked[j];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return masked.length;
}

/** Walks backward over a `.identifier` chain preceding `nameStart`. */
function findChainStart(masked, nameStart) {
  let start = nameStart;
  for (;;) {
    let p = start - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p >= 0 && masked[p] === '.') {
      let q = p - 1;
      while (q >= 0 && /\s/.test(masked[q])) q--;
      const idEnd = q + 1;
      while (q >= 0 && /[$\w]/.test(masked[q])) q--;
      const idStart = q + 1;
      if (idStart < idEnd) {
        start = idStart;
        continue;
      }
    }
    break;
  }
  return start;
}

/**
 * Finds every complete `waitForTimeout(...)` call in `original`, using
 * `masked` (the comment/string-blanked twin of `original`) to find
 * boundaries safely. Matches any spacing between the identifier and `(`,
 * and captures a multi-line argument list in full via its own matching
 * closing parenthesis.
 */
function findWaitForTimeoutCalls(original, masked) {
  const calls = [];
  const re = /\bwaitForTimeout\b/g;
  let m;
  while ((m = re.exec(masked))) {
    const nameStart = m.index;
    const nameEnd = nameStart + 'waitForTimeout'.length;
    let k = nameEnd;
    while (k < masked.length && /\s/.test(masked[k])) k++;
    if (masked[k] !== '(') continue; // a mention, not a call
    const openParen = k;
    let end = matchingParenEnd(masked, openParen);
    let k2 = end;
    while (k2 < masked.length && /\s/.test(masked[k2])) k2++;
    if (masked[k2] === ';') end = k2 + 1;

    let start = findChainStart(masked, nameStart);
    {
      let back = start;
      while (back > 0 && /\s/.test(masked[back - 1])) back--;
      const AWAIT = 'await';
      if (back >= AWAIT.length && masked.slice(back - AWAIT.length, back) === AWAIT) {
        const before = back - AWAIT.length - 1;
        if (before < 0 || /[^$\w]/.test(masked[before])) {
          start = back - AWAIT.length;
        }
      }
    }
    const text = original.slice(start, end);
    const line = original.slice(0, nameStart).split('\n').length;
    calls.push({ nameStart, text, line });
  }
  return calls;
}

/**
 * Finds every `test(...)` / `test.only(...)` / `test.skip(...)` /
 * `test.step(...)` / `test.describe(...)` call (by its own first
 * string-literal argument) and every named `function name(...) {...}`
 * declaration, each as a `{start, end, title, kind}` span. `kind` is
 * `'step'`, `'function'`, or the bare/only/skip/describe test call's own
 * label ('test', 'only', 'skip', 'describe').
 */
function findScopes(original, masked) {
  const scopes = [];
  const testCallRe = /\btest(\s*\.\s*(only|skip|describe|step))?\s*\(/g;
  let m;
  while ((m = testCallRe.exec(masked))) {
    const nameStart = m.index;
    const before = nameStart > 0 ? masked[nameStart - 1] : undefined;
    if (before !== undefined && /[$\w.]/.test(before)) continue; // e.g. `foo.test(` or `sometest(`
    const openParen = m.index + m[0].length - 1;
    const callEnd = matchingParenEnd(masked, openParen);
    let p = openParen + 1;
    while (p < original.length && /\s/.test(masked[p])) p++;
    let title = null;
    if (original[p] === '"' || original[p] === "'" || original[p] === '`') {
      const quote = original[p];
      let q = p + 1;
      while (q < original.length && original[q] !== quote) {
        if (original[q] === '\\') {
          q += 2;
          continue;
        }
        q++;
      }
      title = original.slice(p + 1, q).replace(/\\(['"`])/g, '$1');
    }
    if (title !== null) {
      const kind = m[2] ?? 'test';
      scopes.push({ start: nameStart, end: callEnd, title, kind });
    }
  }
  const fnRe = /\bfunction\s+([$\w]+)\s*\(/g;
  while ((m = fnRe.exec(masked))) {
    const nameStart = m.index;
    const fnName = m[1];
    const openParen = m.index + m[0].length - 1;
    const paramEnd = matchingParenEnd(masked, openParen);
    let b = paramEnd;
    while (b < masked.length && masked[b] !== '{') b++;
    if (b >= masked.length) continue;
    let depth = 0;
    let end = b;
    for (let j = b; j < masked.length; j++) {
      if (masked[j] === '{') depth++;
      else if (masked[j] === '}') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    scopes.push({ start: nameStart, end, title: fnName, kind: 'function' });
  }
  return scopes;
}

/**
 * The title of the smallest scope span containing `pos`, or '(module
 * scope)'. When the smallest containing scope is a `test.step(...)`, the
 * identity is prefixed with the next-smallest containing scope's title
 * (`outer > step`), so two steps sharing a title under different tests (or
 * the same step moved between tests) never collapse onto one key. No
 * currently declared SITES entry sits inside a step, so this never rekeys
 * an existing site.
 */
function enclosingIdentity(scopes, pos) {
  const containing = scopes.filter((s) => s.start <= pos && pos < s.end);
  if (containing.length === 0) return '(module scope)';
  containing.sort((a, b) => a.end - a.start - (b.end - b.start));
  const innermost = containing[0];
  if (innermost.kind === 'step' && containing.length > 1) {
    return `${containing[1].title} > ${innermost.title}`;
  }
  return innermost.title;
}

/**
 * Scans one file's source text and returns every `waitForTimeout` call site
 * as `{line, test, text, occurrence}`, with `occurrence` counted within the
 * (enclosing test title, normalised call text) tuple.
 */
function scanSource(source) {
  const masked = maskNonCode(source);
  const scopes = findScopes(source, masked);
  const calls = findWaitForTimeoutCalls(source, masked);
  const occurrenceCounts = new Map();
  const results = [];
  for (const call of calls) {
    const testTitle = enclosingIdentity(scopes, call.nameStart);
    const text = normalizeCallText(call.text);
    const tupleKey = `${testTitle}\u0000${text}`;
    const occurrence = (occurrenceCounts.get(tupleKey) ?? 0) + 1;
    occurrenceCounts.set(tupleKey, occurrence);
    results.push({ line: call.line, test: testTitle, text, occurrence });
  }
  return results;
}

function scanSites() {
  const testsDir = __dirname;
  const files = readdirSync(testsDir).filter((name) => name.endsWith('.spec.ts'));
  /** @type {{file: string, line: number, test: string, text: string, occurrence: number}[]} */
  const found = [];
  for (const file of files) {
    const contents = readFileSync(path.join(testsDir, file), 'utf8');
    for (const site of scanSource(contents)) {
      found.push({ file, ...site });
    }
  }
  return found;
}

function key(site) {
  return `${site.file}::${site.test}::${site.text}::${site.occurrence}`;
}

test('every waitForTimeout site in tests/*.spec.ts is declared with a reason class', () => {
  const actual = scanSites();
  const declaredKeys = new Set(SITES.map(key));

  const unclassified = actual.filter((site) => !declaredKeys.has(key(site)));
  assert.deepEqual(
    unclassified.map((site) => `${site.file}:${site.line} (test: ${site.test})`),
    [],
    `unclassified waitForTimeout site(s), add a SITES entry: ${unclassified
      .map((site) => `${site.file}:${site.line} (test: ${site.test})`)
      .join(', ')}`
  );
});

test('every declared site still exists (by enclosing test, call text and occurrence) in its file', () => {
  const actualKeys = new Set(scanSites().map(key));

  const missing = SITES.filter((site) => !actualKeys.has(key(site)));
  assert.deepEqual(
    missing.map((site) => `${site.file}:${site.line} (test: ${site.test})`),
    [],
    `declared site(s) no longer exist there, update or remove the SITES entry: ${missing
      .map((site) => `${site.file}:${site.line} (test: ${site.test})`)
      .join(', ')}`
  );
});

test('every declared site carries a non-empty one-line reason', () => {
  const bad = SITES.filter(
    (site) => typeof site.reason !== 'string' || site.reason.trim().length === 0 || site.reason.includes('\n')
  );
  assert.deepEqual(
    bad.map((site) => `${site.file}:${site.line}`),
    [],
    `site(s) missing a one-line reason: ${bad.map((site) => `${site.file}:${site.line}`).join(', ')}`
  );
});

test("every declared site's class is a member of the declared reason-class vocabulary", () => {
  const bad = SITES.filter((site) => !REASON_CLASSES.includes(site.class));
  assert.deepEqual(
    bad.map((site) => `${site.file}:${site.line} class=${site.class}`),
    [],
    `site(s) with a class outside REASON_CLASSES: ${bad
      .map((site) => `${site.file}:${site.line} class=${site.class}`)
      .join(', ')}`
  );
});

test('the seam-observable-non-tile class is empty: every such sleep has moved onto whenQuiescent', () => {
  const stillSeamObservable = SITES.filter((site) => site.class === 'seam-observable-non-tile');
  assert.deepEqual(
    stillSeamObservable.map((site) => `${site.file}:${site.line}`),
    [],
    `seam-observable-non-tile site(s) not yet migrated onto awaitQuiescence: ${stillSeamObservable
      .map((site) => `${site.file}:${site.line}`)
      .join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// Self-tests (finding C8): the scanner is exercised directly against small
// in-memory fixtures, not the real tests/*.spec.ts tree, so each claimed
// discovery/identity/validation behavior has its own controlled proof.
// ---------------------------------------------------------------------------

test('self-test: a spaced call, waitForTimeout (500), is discovered', () => {
  const fixture = "test('t', async ({ page }) => {\n  await page.waitForTimeout (500);\n});\n";
  const found = scanSource(fixture);
  assert.equal(found.length, 1, 'the spaced call should be discovered exactly once');
  assert.equal(found[0].text, 'await page.waitForTimeout (500);');
  assert.equal(found[0].test, 't');
});

test('self-test: changing a multi-line call\u2019s later-line argument is detected', () => {
  const before = "test('t', async ({ page }) => {\n  await page.waitForTimeout(\n    500\n  );\n});\n";
  const after = "test('t', async ({ page }) => {\n  await page.waitForTimeout(\n    999\n  );\n});\n";
  const foundBefore = scanSource(before);
  const foundAfter = scanSource(after);
  assert.equal(foundBefore.length, 1);
  assert.equal(foundAfter.length, 1);
  assert.notEqual(
    foundBefore[0].text,
    foundAfter[0].text,
    'the normalised call text must change when a later line of the same call changes'
  );
  assert.equal(foundBefore[0].text, 'await page.waitForTimeout( 500 );');
  assert.equal(foundAfter[0].text, 'await page.waitForTimeout( 999 );');
});

test('self-test: a comment mentioning waitForTimeout( is ignored', () => {
  const fixture =
    "test('t', async ({ page }) => {\n  // see waitForTimeout(500) elsewhere\n  await doSomething();\n});\n";
  const found = scanSource(fixture);
  assert.deepEqual(found, [], 'a comment mention must never be discovered as a call');
});

test('self-test: a block comment mentioning waitForTimeout( is ignored', () => {
  const fixture =
    "test('t', async ({ page }) => {\n  /* legacy: waitForTimeout(500) removed */\n  await doSomething();\n});\n";
  const found = scanSource(fixture);
  assert.deepEqual(found, [], 'a block-comment mention must never be discovered as a call');
});

test('self-test: an invented class fails the vocabulary check', () => {
  const bogusSites = [
    { file: 'x.spec.ts', line: 1, test: 't', text: 'await page.waitForTimeout(1);', occurrence: 1, class: 'made-up-class', reason: 'r' }
  ];
  const bad = bogusSites.filter((site) => !REASON_CLASSES.includes(site.class));
  assert.equal(bad.length, 1, 'an invented class must be rejected by the vocabulary check');
});

test('self-test: an identical call moved into a different test changes its key', () => {
  const inTestA = "test('A', async ({ page }) => {\n  await page.waitForTimeout(500);\n});\n";
  const inTestB = "test('B', async ({ page }) => {\n  await page.waitForTimeout(500);\n});\n";
  const foundA = scanSource(inTestA);
  const foundB = scanSource(inTestB);
  assert.equal(foundA[0].test, 'A');
  assert.equal(foundB[0].test, 'B');
  assert.notEqual(
    `${foundA[0].test}::${foundA[0].text}::${foundA[0].occurrence}`,
    `${foundB[0].test}::${foundB[0].text}::${foundB[0].occurrence}`,
    'the same call text under a different enclosing test must produce a different identity'
  );
});

test('self-test: a call inside a shared helper function is keyed by the function name', () => {
  const fixture =
    "test.describe('D', () => {\n  async function helperFn(page) {\n    await page.waitForTimeout(250);\n  }\n});\n";
  const found = scanSource(fixture);
  assert.equal(found.length, 1);
  assert.equal(found[0].test, 'helperFn');
});

test('self-test: a quote inside a regexp literal does not hide a later real call', () => {
  const apostropheFixture =
    "test('t', async ({ page }) => {\n  const apostrophe = /'/;\n  await page.waitForTimeout(500);\n});\n";
  const foundApostrophe = scanSource(apostropheFixture);
  assert.equal(
    foundApostrophe.length,
    1,
    'the real call after a regexp literal holding an apostrophe must still be discovered'
  );
  assert.equal(foundApostrophe[0].test, 't');
  assert.equal(foundApostrophe[0].text, 'await page.waitForTimeout(500);');

  const backtickFixture =
    "test('t', async ({ page }) => {\n  const backtick = /`/;\n  await page.waitForTimeout(500);\n});\n";
  const foundBacktick = scanSource(backtickFixture);
  assert.equal(
    foundBacktick.length,
    1,
    'the real call after a regexp literal holding a backtick must still be discovered'
  );
  assert.equal(foundBacktick[0].test, 't');
  assert.equal(foundBacktick[0].text, 'await page.waitForTimeout(500);');
});

test('self-test: a regexp ending in an escaped slash pair is not a line comment', () => {
  const fixture = String.raw`test('A', () => {
  expect(String(x)).toMatch(/^pmtiles:\/\//);
});
await page.waitForTimeout(500);
`;
  const found = scanSource(fixture);
  assert.equal(found.length, 1, 'the module-scope call after the regexp must still be discovered');
  assert.equal(found[0].test, '(module scope)');
  assert.equal(found[0].text, 'await page.waitForTimeout(500);');
});

test('self-test: a call inside a test.step is keyed by its enclosing test title, not the step title alone', () => {
  const fixtureA =
    "test('A', async ({ page }) => {\n  await test.step('s', async () => {\n    await page.waitForTimeout(500);\n  });\n});\n";
  const fixtureB =
    "test('B', async ({ page }) => {\n  await test.step('s', async () => {\n    await page.waitForTimeout(500);\n  });\n});\n";
  const foundA = scanSource(fixtureA);
  const foundB = scanSource(fixtureB);
  assert.equal(foundA.length, 1);
  assert.equal(foundB.length, 1);
  assert.equal(foundA[0].test, 'A > s');
  assert.equal(foundB[0].test, 'B > s');
  assert.notEqual(
    `${foundA[0].test}::${foundA[0].text}::${foundA[0].occurrence}`,
    `${foundB[0].test}::${foundB[0].text}::${foundB[0].occurrence}`,
    'moving the same call from one test’s step into another’s step must change its key'
  );
});
