# Entering the 3D Fire scene: loading, staging, cancel

Proposed 2026-09-11 (S28) from the owner's rulings of that date, revised the same night after the Codex adversary review (C:\dev\_reviews\dynamic-drought-module\2026-09-11_fire3d-entry-loading-screen.md). The entry contract is not built yet. Decision A below, the pulse cadence while terrain is present, was approved by the owner at 02:45 PDT the same night (DR-087) and is built: 7fcfaa4.

## What the user sees today, and why it is not honest

The scene publishes `active` at the end of activateScene (src/map/fire3d.ts) while the terrain DEM, the 13.5 MB hazard drape, and the structures archive are still streaming. The sidebar then says "Live" over a tilted map that is visibly assembling. The shared loading pill (index.html, src/ui/overlay.ts) is never used by the scene. On a software GPU, a single synchronous readback blocked the page 43 to 62 seconds while the pulse queued frames; with reduced motion, 10 to 16 seconds. The pulse keeps running during this stall (ruling 2), so anything the screen animates must be compositor-driven to keep moving while the main thread is blocked.

## The owner's rulings

1. The first entry reads `loading` until the scene first settles; later tile traffic stays `live`.
2. The wildfire pulse keeps running during entry. It does not pause. (See open decision A on its cadence: "keeps running" is honoured by a continuous clock; the spec proposes fewer paint commits per second while terrain is present, which is not a pause.)
3. The camera tilts only after the terrain relief for the current view has loaded, with an 8 second ceiling after which it tilts anyway.
4. A loading screen: dark semi-transparent blurred cover over the map, "Loading..." in white, a progress bar, a red Cancel button with white text, and no screen when the entry finishes in under a second.
5. Station telemetry stays default-off (already true); a user switches it on in the console or the layer studio.
6. A lighter scene for slow devices waits for real-hardware numbers.

## What the Codex review changed, and why

- Cancel owns the preference. v1 wired Cancel to `setFire3DActive(map, false)`, which aborts a live controller or rolls back an active scene but never touches the preference or the URL (src/map/fire3d.ts:866-880); only `setFire3DPreference` writes the URL (src/state/fire3d-store.ts:42-46), and the button mirrors the preference. v2 routes Cancel and Escape through one `cancelFire3DEntry()` that calls `setFire3DPreference(false)` and lets the existing controller path tear down.
- The activation controller lives through every await. Today it is nulled right after the header probe (fire3d.ts:670-690), before terrain is installed; a terrain wait inserted there could not be aborted and a cancelled entry could revive. v2 keeps one controller and one generation for the whole transaction, cleared in a `finally` the activation owns, with every await racing the same signal.
- The cover is committed before the heavy work. A 1,000 ms JavaScript timer cannot fire through a blocked main thread, and the stall measured tonight starts inside the terrain work. v2 mounts the cover synchronously at the press, opacity 0, pointer-inert, promoted, and reveals it with a CSS `animation-delay: 1000ms`; a sub-second completion removes it before the delay elapses. The deferral stays the fast-machine rule.
- Blur is capability-gated. A full-viewport `backdrop-filter` samples the very canvas that is saturated. v2 keeps the owner's blurred cover on the normal path and falls back to a darker solid scrim (`rgba(0,0,0,0.82)`, no blur) on a known software renderer, on reduced transparency, and where `@supports` fails, following the existing pattern at src/styles/app.css:2536. The user is never told why.
- Named phases plus an indeterminate bar, not six equal segments. Six unequal steps drawn as six equal units would sit at five sixths for most of the wait. v2 shows the phase sentence and an indeterminate bar now; the "N of M currently requested tiles" ledger from MapLibre's sourcedataloading/sourcedata events is a later phase (ideas register).
- Today's order is kept. v1 put context before smoke and ribbon to match a diagram; the code activates smoke, ribbon, then context (fire3d.ts:777, 803, 833). v2 derives phases from the real transaction.
- Cancel is a state. Cancelling mid-tilt in v1 would hide the cover and expose a pitched flat map easing backwards. v2 shows "Cancelling...", disables the button, calls `map.stop()`, aborts, rolls back, restores the saved camera with `jumpTo` on this path only, updates the preference, then closes after the flat frame commits.
- A Preact island, not a plain DOM module. src/ui/island/shell.tsx:1-3 records that new UI surfaces are islands; this surface has a reducer, timers, focus, inert state and live regions. v2 mounts an independent island in `#fire3d-loading-root` inside the map container, so it works in embeds where the shell is absent. fire3d.ts keeps only facts.
- Accessibility restructured. Cancel no longer sits inside a `role="status"`; the stage sentence lives in its own polite, atomic live node; the map canvas and its controls are inerted while the desktop sidebar stays operable; in an embed the cover is the whole surface and traps focus; focus is saved when the cover actually appears and restored only if still connected.

## The entry transaction

`Fire3DStatus` gains `activationId: number`, `phase`, and `settledOnce: boolean`; `transport` stays as landed in 283de57. All stamped on the control as `data-fire3d-phase`, `data-fire3d-settled-once` beside the existing stamps.

| phase | completes when | sentence on the cover |
|---|---|---|
| `probe` | the archive header resolved (deep or bundled) | Checking the terrain archive |
| `terrain` | `setTerrain` done at pitch 0 and the DEM source reports loaded for the flat view, or the 8 s ceiling passed | Loading terrain relief |
| `camera` | the pitch easing's own `moveend` (not a blind timer); instant under reduced motion | Tilting the view |
| `atmosphere` | smoke volume and perimeter ribbon activated or degraded (live (partial) semantics, never a seventh state) | Loading smoke and perimeters |
| `context` | hazard drape and structures activated or degraded | Loading the hazard drape and structures |
| `settled` | `transport` reads settled AND one frame has committed after it (a `requestAnimationFrame` after the settle) | (cover closes) |

The terrain wait listens to that one source, handles an already-loaded source, cleans up on abort, error and timeout, and distinguishes the 8 s "tilt anyway" from a terrain failure (which is `unavailable` as today). Every await checks the generation and races the signal. Optional component failure keeps today's live (partial) meaning.

## The cover

Mounted at the press into `#fire3d-loading-root` (index.html, inside the map container), keyed by `activationId` so a stale timer from activation N can never close N+1.

Appearance: full cover of the map container only; `rgba(0,0,0,0.62)` with `backdrop-filter: blur(6px)` on the normal path, the solid scrim on the fallback paths; centred column: "Loading..." (heading size, white), the phase sentence (body, white), an indeterminate bar (a single translating band, `transform` only), the Cancel button (filled red from the design tokens, white text, at least 44 by 44 px, safe-area aware on phones and tablets).

Reveal: present from the press at opacity 0, `pointer-events: auto` so no gesture leaks to the map, `will-change: opacity, transform`; the reveal is a CSS animation with a 1,000 ms delay and a 200 ms fade; removal before the delay elapses means a fast entry never shows it. Minimum visible 600 ms once revealed. Close: 300 ms fade on settled, on cancel complete, on unavailable. Reduced motion: no fades, no band motion, instant states.

Pre-show: where the renderer string names a known software renderer (SwiftShader, llvmpipe; absent means unknown, never fast), the cover is revealed before `setTerrain`, so Cancel exists before any possible stall. This is the only capability use in this slice; no signal denies or thins the scene (ruling 6).

Cancel and Escape: `cancelFire3DEntry()`; the "Cancelling..." state above; the URL drops `fire3d=true` through the preference; the button reads not pressed; focus returns to the saved element if connected, else the map canvas, else the visible 3D button.

Failure: `unavailable` closes the cover; the existing unavailable sentence appears in the control and the embed note, unchanged.

## Accessibility and words

The island root is a labelled `section` (`aria-label="Loading the 3D scene"`); the phase sentence is in its own `role="status" aria-live="polite" aria-atomic="true"` node; the sidebar's existing live region is not duplicated (the control's line changes once to loading and once to live); the bar is `role="progressbar"` with an accessible name and no value while indeterminate; `aria-busy="true"` on the map region from the press to settled or cancel; map canvas and map controls get `inert` while the cover shows; desktop sidebar stays operable; embed traps focus in the cover.

Words: loading, live, live (partial), unavailable only; no warning, alert, forecast, simulate, digital twin; never a sentence about the device.

## The sidebar line and the truth stamps

`statusLine` (src/ui/island/fire3d-control.tsx): while `active` and not `settledOnce`, "Loading: terrain relief for this view."; then the existing Live and Live (partial) sentences; a later `streaming` keeps Live.

## Decision A: the pulse while terrain is present

Approved by the owner 2026-09-11 02:45 PDT (DR-087) and built as 7fcfaa4: 60 ms on the flat
map, 250 ms with terrain, 500 ms with terrain on a renderer the page classifies as software
(an unknown renderer gets 250, never 500), one continuous clock, reduced motion unchanged.
The proposal as written before the ruling follows.

Proposed: the pulse controller in src/layers/nifc-fires.ts becomes terrain-aware. Its phase stays derived from elapsed time (it never pauses or restarts), but while `map.getTerrain()` is set it commits paint at 250 ms (4 Hz) instead of 60 ms, 500 ms on a known software renderer, and it caches the present target list instead of probing eight layers each tick. Restores 60 ms on the flat map. Numbers to be benchmarked on hardware before the constants are final. This needs the owner's yes because ruling 2 said "keeps running"; the director reads that as no pause, not as 17 terrain repaints per second, and Codex argued the same.

## Where the code goes

- src/map/fire3d.ts: one controller and generation for the whole transaction; `phase`, `activationId`, `settledOnce`; terrain at pitch 0, the bounded terrain wait, the eased camera awaited on its `moveend`, then smoke, ribbon, context as today, then the transport watch, then settled plus one committed frame; `cancelFire3DEntry()`; a partial-safe rollback that removes terrain, sources and listeners whether or not `active` was set.
- src/state/fire3d-store.ts: unchanged API; Cancel goes through `setFire3DPreference`.
- src/ui/island/fire3d-loading.tsx (new island) plus its mount in src/main.ts; the visibility reducer as a pure exported function keyed by activationId.
- index.html: `#fire3d-loading-root` inside the map container.
- src/styles/app.css: the cover, the delayed reveal animation, the band, the scrim fallback under `@supports` and `prefers-reduced-transparency`, reduced motion.
- src/ui/island/fire3d-control.tsx: the loading branch and the new stamps.
- src/config/fire3d-presentation.ts: the 1,000 ms delay, 600 ms minimum, 8 s ceiling, fade durations, the pulse cadences, as named constants.
- src/layers/nifc-fires.ts: the terrain-aware cadence (decision A).
- src/map/gl-capability.ts: the renderer-string classification, session-local, never transmitted, never rendered as a diagnosis.

## Verification

Node: the visibility reducer (never before 1,000 ms; reveal when not settled; 600 ms minimum; close on settled, cancel, unavailable; stale activation ids ignored; reduced motion changes durations only); the cancellation transaction at every await boundary with a fake map and a controlled source-event harness (the existing node harness reads transport as streaming and lacks isSourceLoaded, so the harness gains a scripted source). Browser (tests/fire3d-mode.spec.ts, deep host stubbed): cover committed before a simulated long task and still visible after it; no cover on a fast entry; cover on a delayed terrain route; Cancel and Escape during the terrain wait, mid-tilt, during context, and inside the minimum-visible interval each restore the flat view, the URL, the button and focus, with "Cancelling..." observed; Back during entry; rapid off/on with stale timers; terrain timeout then late tile arrival; optional source failure reads live (partial); embed with no toggle; short tablet viewport and rotation; touch does not leak to the map; no duplicate live announcements; telemetry already on before entry; reduced motion shows no fade. Break-the-fix for each. The fire3d-mode activation row is re-recorded with its reason (DR-085).

## Set aside, and recorded for later

The later phases for 3D Fire scene entry live in docs/IDEAS.md under "3D Fire scene entry: later phases":

- Deck.gl, three.js, CesiumJS: Codex itself says do not build for this slice; agreed.
- A readPixels benchmark as a probe: rejected by Codex and by the measurements; agreed.
- Hardware concurrency, device memory, connection hints as gates: weak evidence; not used.
- The tile ledger and requested-byte progress: later phase, in the ideas register.
- Stations as symbol layers, the Lite URL tier, local diagnostics, the archive validator unified with the PMTiles cache, ribbon slab consolidation, a worker protocol path, an egress-authorised plugin review: later phases, in the ideas register.
