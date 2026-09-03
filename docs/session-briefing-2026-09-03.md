# Session briefing, 2026-09-03

Prepared 2026-09-02 by a read-only review pass over `integration/2026-09` at
`eb6c4f3`. Every claim below carries a receipt: a `path:line`, a commit, or a
command and its output. Inferences are labeled.

## Status, 2026-09-03 00:20 PDT

Task 3 is done and live. What the 23:00 status below still describes as the
next engineering task has landed:

- **MapLibre GL JS 6.6.0 is on `main` and proven live.** The branch
  `maplibre-6/step-1-style-spec-casts` (cut from `main` at `deb4a61`; commits
  `f8bd2da`, `e11bd83`, `e5b7d38`, `db16277`) landed as merge commit `993f5ca`
  on the owner's go at 23:51, after the docs branch landed as `4cfc3a9`.
  Verified on the branch before landing: typecheck and gate clean, `verify:smoke`
  86 green, `tests/fire3d-mode.spec.ts` 21 green on `chromium-3d`, and the full
  `test:serial` 869 passed in 25.4 minutes. Deploy run 33725341105 and
  verify-live run 33726016220 both succeeded on `993f5ca`, so 6.6.0 is what
  visitors run. The measured cost is recorded on gate `DDM-D01` in
  `docs/ROADMAP.yaml`, and `DDM-P0-T03` is closed against it.
- **What the landing carried.** Every step of section 6.6 (the 70 namespace
  imports, `setWorkerUrl` from a `?worker&url` import, `zoomLevelsToOverscale`
  pinned to `undefined` so the 13 query sites keep their v5 behavior, both
  browser floors as the Vite `build.target`, a renderer-version check in
  `check:all`), plus DR-035 a (a WebGL 2 probe before construction, an 8 s load
  bound, one tokenized notice), DR-025 a (height floor and `webglcontextlost`
  through the failure ladder), DR-008 a (lazy map key and telemetry adapters;
  entry 43.4 to 33.6 kB gzip), and DR-051 a (opt-in evidence capture).
- **The v6 follow-ups, done on `v6-followups/2026-09-03`.** The 3D toggle in
  `src/ui/island/fire3d-control.tsx` reads the height floor and the shared
  probe result beside the width query (DR-025 a); the URL catalog split
  (DR-008 a's third module) is done through `src/config/urls-boot.ts`; the
  module comment in `src/config/layers.ts` is current; the featured-station
  table loads with the Water & Snow list instead of eagerly; the DEM transfer
  was re-measured and is unchanged (gate DDM-D01). The release notes carry
  the entry. Categorical drape resampling (FIRE-02) is untouched: it is a
  presentation change with its own decision, not a follow-up of the bump.
- **Everything below this line is history.** Section 6's work breakdown is
  recorded as executed; the branch table in the 23:00 status is stale.

## Status, 2026-09-02 23:00 PDT

This briefing was written before the landing day. What changed since, so that
the sections below read as the history they are:

- **Tasks 1 and 2 are done.** `integration/2026-09` landed on `main` as PR 57
  (merge commit `3613335`), live at `deb4a61` with verify-live green; the four
  hooks are installed. Section 4's branch table and the working-tree note about
  `DDM-D01` are history (the gate edit was committed).
- **Every decision Task 3 waited on is settled.** The owner ruled the
  2026-09-03 decision packet on 2026-09-02 at 22:38 PDT: DR-035 a, DR-008 a,
  DR-025 a (with an expansion: 3D terrain is map-level across all four hazard
  views, volumetric smoke is the fire-view default, and the capability probe
  gates terrain at the map level), DR-024 b, DR-051 a, DR-052 b, DR-014 a,
  DR-015 a; all twenty-one Part 2 defaults; DR-061 deferred (no cron jobs before
  the Convention; normalization is updated manually at major landings); and the
  browser floor amended on DR-009 to Safari 15.5 plus Chrome 100 and later on
  Android, with a BrowserStack open-source-grant real-device check per release.
  The record is `planning/decisions/2026-09-02-decision-register.yaml`
  (66 entries, 46 decided, 20 pending).
- **Task 3, the MapLibre 6.6.0 migration, is the next engineering task.** Step 1
  of section 6.6 is done on `maplibre-6/step-1-style-spec-casts` at `f8bd2da`
  (cut from `main` at `deb4a61`, pushed, no pull request). Steps 2 to 8 follow,
  amended below with the rulings.
- **Verification approach, from the DR-052 owner guidance.** Use an Opus 5 agent
  swarm with task-specific skills: the 69 import rewrites, the 13 query sites, and
  the `setWorkerUrl` wiring are each a bounded task with its own gate. The
  sequence is typecheck clean, build clean, `verify:pure` (new fast lane),
  `verify:quick`, then the full `test:serial` including `chromium-3d`; each step
  gates the next, and a failure stops the sequence and reports. `chromium-3d`
  stays in the routine loop. Under DR-051 a, make the fire3d evidence capture
  opt-in (`DDM_CAPTURE_EVIDENCE=1`) and assert build identity locally before the
  repeated migration runs, so the runs are offline-safe and prove the build they
  booted.
- **User research is filed.** Five observation files sit in
  `planning/user-research/` (ignored) and were triaged against the parked
  decisions: no default flipped; the register gained DR-065 (layer and place
  studio stability before the Convention) and DR-066 (wellness and crisis support
  resources beside hazard information).
- **Stale figures in this document.** The perimeter-evidence branch is 182
  behind `main`, not 163; the Node pin is now 24.20.0 on the 24 line (DR-007 b),
  with the local machine on 24.14.1; the `queryRenderedFeatures` count is 13
  (section 6.2), not 18.

## 0. Blockers

**No hard blocker.** The one candidate was checked and cleared:

MapLibre 6 requires WebGL2 and removes WebGL1 (v5-to-v6 migration guide:
"WebGL1 support has been removed; WebGL2 is now required"). WebGL2 is enabled by
default in Safari 15 and iOS Safari 15 (caniuse `webgl2`: "Safari on iOS 15 -
26.5: Supported"; versions 12 to 14.8 were disabled by default). **A Safari 15.5
floor and a WebGL2 requirement do not conflict.** DR-009 is executable as ruled.

Two things that are not blockers but must be seen before the migration starts:

1. **The Safari 15.5 floor is not verified by anything.** All three Playwright
   projects are Chromium (`playwright.config.ts:86,217,229,237`). Pinning
   `build.target` to `safari15.5` makes the floor a build claim, not a tested
   contract. Vite lowers *syntax* to a target; it does not polyfill *runtime
   APIs* (`@vitejs/plugin-legacy` does, and is not installed). MapLibre 6 moved
   its TypeScript target to ES2022 (CHANGELOG 6.0.0), so any ES2022-era runtime
   API it calls reaches an iOS 15.5 device unpolyfilled and fails at runtime, not
   at build time. Inference: this is a real risk, discoverable only on a device
   or a Safari 15.5 emulation, and it is the reason step 2 of the work breakdown
   comes before the version bump.
2. **`README.md:439` is wrong today**: "MapLibre GL JavaScript requires WebGL 1."
   Correct it independently of any upgrade. `README.md:438` promises "Safari 15.5
   or newer" while `vite.config.ts` sets no `build.target` at all (verified by
   reading the whole `build` block: `outDir`, `sourcemap`, `manifest`,
   `rolldownOptions`, `chunkSizeWarningLimit`, nothing else), so Vite 8's default
   `baseline-widely-available` applies and resolves to `safari16.4`, `ios16.4`
   (Vite 8.0.10 `constants.ts`, via Context7).

## 1. The ten decisions, settled

Format follows the owner-decisions convention. Owner additions are preserved
verbatim in quotation marks.

**DR-001, how the September work lands: option b.** Merge commit preserving the
wave commits. Owner addition: *"merge often; do not let integration/2026-09 drift
far from main."*

**DR-002, what CI does after 2026-09-11: option a.** Browser suite advisory on
push; no ruleset on main; refresh-snapshots unchanged; source-health weekly at
snooze expiry; upstream-monitor weekly only after CI-04; verify-live cron stays
off. CI must prove but never block.

**DR-003, the drafted Claude Code hooks: option a.** Install P1, P2, P3, P4 into
`settings.local.json`. The Stop hook may block on machine-checkable rules
(U+2014, typecheck). The push-to-main guard warns, does not block. Asana write
denies added. `DDM_STOP_LEVEL=fast`.

**DR-009, MapLibre version and browser floor: OVERRIDE.** Adopt MapLibre 6.6.0
directly and skip v5. Accepts 69 default imports, `setWorkerUrl`,
`queryRenderedFeatures` review, and a WebGL2 path. Browser floor Safari 15.5,
pinned in `vite.config.ts`.

**DR-012, briefing structure: option b.** Three horizon sections by four hazard
rows; time-leading layout for the field instrument.

**DR-016, what near-term means: option a.** Generic chip wording ("Near-term");
each screen stamps its own validity window from
`HorizonProduct.validity.validLabel`.

**DR-019, CPC monthly and seasonal outlooks: option a.** Adopt for both. ENSO
season-ahead bound with copy stating it is a CPC seasonal outlook, not an ENSO
forecast. Owner addition: *"scout additional issuer products for long-range
context; verify, do not pre-commit."*

**DR-022, a real forecast tier for Fire: option a.** SPC Days 1 to 8 near-term,
NIFC Months 1 to 4 season-ahead. WHP retired from the horizon recipe and kept as
an explicitly static context layer. Live perimeters in every horizon. Owner
addition: *"fire-in-context-of-fuel-conditions (WHP beside a live perimeter) is a
priority use case."*

**DR-029, the three-state ENSO model: option a.** CPC advisory semantics;
conditions lead the headline, the five-season episode rule is secondary;
`enso-indices.json` v2.

**DR-036, the tablet band: option a.** A real third band, 721 to 1024 px, fluid
sidebar, 44 px touch floor. Tablet is touch-first: phone simplest, tablet more
capable but touch-native, desktop full pointer controls.

## 2. The first three tasks, in order

### Task 1. Land `integration/2026-09` on `main` as a merge commit

DR-001b, executed literally: one pull request, merged with `--no-ff` so the nine
domain commits survive. This is the unblocking act; the owner addition ("merge
often") makes it the first thing, not the last.

- Decision dependencies: DR-001 (settled). **Blocked on: DR-045, DR-047, DR-049**
  (see section 3).
- Ladder tier: `npm run test:serial` before the landing (ROADMAP.md posture,
  "for a landing"), then Validate as the only required check on the PR
  (DR-002a), then the post-deploy `verify-live` `workflow_run` proof.
- Owner authorization required (merge, deploy) per the standing rule.

### Task 2. Install the four drafted hooks

DR-003a. Sources are drafted and uninstalled at
`planning/2026-09-01-deep-dive/claude-tooling/hooks/` (six files:
`ddm-guard-bash.py`, `ddm-guard-edit.py`, `ddm-precompact-note.py`,
`ddm-session-start.py`, `ddm-stop-verify.py`, `ddm-subagent-log.py`) with
`install-hooks.ps1`, `install-hooks.sh`, `merge-settings.py`, and
`settings.project.json` beside them.

- Decision dependencies: DR-003 (settled). Needs DR-051 answered if the Stop
  hook is to run anything above `verify:quick`; `DDM_STOP_LEVEL=fast` is already
  ruled, which is the narrow reading.
- Ladder tier: `npm run verify:quick` (5 s) plus a deliberate trip test: a
  scratch edit containing U+2014 must be blocked, and a `git push origin main`
  must warn and proceed.

### Task 3. MapLibre 6.6.0 migration, on its own branch

DR-009 override. Full work breakdown in section 6.

- Decision dependencies: DR-009 (settled). DR-035 a, DR-008 a and DR-025 a
  were settled 2026-09-02 22:38 PDT (see the status section above); nothing
  blocks this task.
- Ladder tier: `npm run gate` after each numbered step; `npm run verify:smoke`
  (about 6 min) at step 8; `npm run test:serial` including the `chromium-3d`
  project before the landing, because terrain, hillshade, and the PMTiles
  protocol are all in the blast radius.

Task 4, not started this session, is DR-012b (the briefing restructure). It is
the largest ratified product change and it should be built on the new renderer,
not migrated onto it.

## 3. Decisions from the remaining fifty that must be answered first

| Needed by | DR | Why it blocks |
| --- | --- | --- |
| Task 1 | DR-045 | Applied on the branch at 02:25 as option **b** (a DDM-convention label plus a date-derived window), not the recommended **a**. Landing ships it. Ratify or change before the merge (register `branch_state.applied_2026_09_02_0225`). |
| Task 1 | DR-047 | The heat-coupling sentence is already removed on the branch; the three briefing sentences are not. Landing ships the half-state. |
| Task 1 | DR-049 | Gridded-index now reads `info.json` (the recommended first step) but the selector expansion is undecided. Landing ships step one only. |
| Task 3 | DR-035 | The v6 `GPUInitializationError` branch **is** DR-035's "WebGL probe and map error handler". Building it twice, or building it under option b or c, wastes the migration's one natural moment to add it. |
| Task 3 | DR-008 | Entry chunk is 43.47 kB gzip against a 45 kB line (`00-SESSION-LOG.md` 04:00; `scripts/check-bundle-size.mjs:32` `DEFAULT_BUDGET_KB = 45`). The vendor chunk is exempt (`check-bundle-size.mjs:74-75`), so v6's extra vendor weight is safe, but a boot-time error path is eager app code and lands against 1.53 kB of headroom. |
| Task 3 | DR-025 | Decides whether the v6 3D re-verification must cover a tablet band and a capability probe, or only desktop. DR-036's "tablet is touch-first" already pushes toward option a. |

Secondary, not blocking: DR-007 was ruled b on 2026-09-02 (`.nvmrc` 24.20.0,
the 24 line); the local machine still runs 24.14.1, which makes any "it built
here" claim in task 3 weaker than it looks until the local install matches.

## 4. Branch state

HEAD of `integration/2026-09` is `eb6c4f3`; `main` is `2e98493`; nine commits
ahead; working tree clean; pushed to origin with **no pull request open**, which
runs zero CI by design.

| Commit | Domain | Files |
| --- | --- | --- |
| `012f0a0` | chore: ignore `fire3d-evidence/` | 1 |
| `46f98f4` | enso: CPC onset and advisory rules, with citations | 6 |
| `1a49bef` | impact: rename to Impact Briefing; issuer dates; honesty guards | 19 |
| `742c96c` | time: time-bar fallbacks, SST prefetch, one horizon label table, `spi` URL parameter, `info.json` valid dates | 11 |
| `d0bf085` | arch: bounded caches and fetches, catalog index, fire-control honesty, `maxPitch`, source notes | 9 |
| `b90b1ab` | ui: design tokens, tablet geometry, contrast, minimap phone gate, ENSO key family, pointer hit box | 5 |
| `55b504e` | tests: verification ladder scripts, 3D case budgets, suite documentation | 5 |
| `28f56dc` | ci: verify-live on the PR 54 contract, bounded stamp poll, advisory suite on push, weekly suite | 8 |
| `eb6c4f3` | docs: roadmap slimmed to a product plan, unreleased notes, standing invariants | 5 |

What the gate reads: `npm run gate` = build, then `check:bundle` (entry line
45 kB gzip, `check-bundle-size.mjs:32`; a separate 100 kB eager-app line), then
`check:activation` (per-feature closures; the point-heat briefing row budgets
`activationJsGzipKb: 25.0` at `scripts/check-activation-budget.mjs:314`), then
`check:all` (14 checks). Last full run, `00-SESSION-LOG.md` 04:00: exit 0,
activation clean, entry chunk 43.47 kB gzip. Note a stale label: the
activation-budget row text still says "24.1 kB" in one place per the 03:10 log
entry, though the enforced number is 25.0.

On the branch, awaiting ratification: DR-029 (`46f98f4`), DR-016's supporting
date carriage (`1a49bef`), DR-001's branch itself, DR-045, DR-047, DR-049, plus
the CI shape of DR-002a (`28f56dc`) and the prunes (four skills and three agents
retired to `planning/archive/2026-09/claude-retired`).

One uncommitted working-tree change is present and is **not** part of the nine
commits: `docs/ROADMAP.yaml` carries a modified `DDM-D01` gate whose `decision`
now records the DR-009 override and moves the 2026-08-29 answer into a
`superseded_answer` block. The tree was clean at `git status` when this review
began; the file's mtime is 2026-09-02 07:45:46 PDT, during the review. It was
written by another process, not by this pass. Commit it deliberately or discard
it deliberately before task 1, but do not let it ride along unnoticed.

## 5. Conflicts and dependency changes

Flagged, not resolved.

| DR | Conflict with what is shipped or in progress | Dependency created or changed | Other decisions moved |
| --- | --- | --- | --- |
| DR-001b | None. Changes ROADMAP.md's "lands as one pull request" posture into repeated merges. | DR-045, DR-047, DR-049 become pre-merge gates. | Strengthens DR-002a and DR-053. Weakens DR-004b: an Asana cadence keyed to one landing no longer fits. |
| DR-002a | None; already implemented in `28f56dc`. | Cron restoration lands 2026-09-11. | Strengthens DR-005. |
| DR-003a | None; the hooks are drafted and uninstalled. | `settings.local.json` is an ignored file, which is DR-055's subject. | Strengthens DR-054. |
| DR-009 | `package.json:63` pins `"maplibre-gl": "^4.7.0"`. `feature/maplibre-v5` (`13ca2da`) becomes a dead branch: do not land it. | Adds `build.target` to `vite.config.ts` (absent today), a `setWorkerUrl` call, and a `GPUInitializationError` path. | Strengthens DR-035a (the error handler stops being optional) and DR-025a (a real capability check replaces a width heuristic). Raises the rebase cost of DR-024 (`feature/nifc-perimeter-evidence`, `905671d`, 182 behind main). |
| DR-012b | **None; strongly congruent.** The briefing is already horizon-led: `src/impact/briefing.ts:37-41` `HORIZON_SPECS`, `src/impact/types.ts:394-396` `{ current, nearTerm, longRange }`. | **New.** `SourcedClaim` (`src/impact/types.ts:90-119`) has no hazard field, and `types.ts:137-138` records that hazard ordering is convention inside a flat `claims` array. Four hazard rows require a hazard discriminant. | Strengthens DR-014 (a non-covering source becomes a per-cell state) and DR-015. |
| DR-016a | **Direct conflict.** `src/config/clusters.ts:84` sets the visible chip to `'Weeks ahead'`, and `clusters.ts:61` sets the cadence label to `'next seven days'`. The comment at `clusters.ts:72-79` parks exactly this as "an owner ruling, not a refactor". DR-016 makes the ruling. | **New.** `HorizonProduct` does not exist in `src/` (grep: 0 hits); it is a proposal at `12-forecast-data-spec.md:787`. DR-016 cannot execute until the type is introduced. | Strengthens DR-017a, DR-020a, DR-021a. Blast radius of the label change: 5 lines across `src/config/clusters.ts`, `src/ui/island/shell.tsx`, `tests/s4-shell.spec.ts`. |
| DR-019a | None. | The owner addition ("scout additional issuer products") inserts a research step ahead of DR-022 and DR-033. | Strengthens DR-014. |
| DR-022a | **Direct conflict.** `src/config/clusters.ts:147` still has `'season-ahead': ['usfs-whp']`, the exact recipe slot DR-022 retires. | WHP must become a catalog context layer rather than a horizon recipe entry. The excluded NIFC 7-day is confirmed by data: every Northwest PSA NW01 to NW12 has `isvalid: 0` (`12-forecast-data-spec.md:210`). | The owner addition (WHP beside a live perimeter as a priority use case) reshapes DR-027, strengthens DR-026 and DR-041, and **raises the urgency of DR-009**, because FIRE-02 shows the WHP drape renders as confetti on 4.7.1 (`03-fire-3d.md:77-92`; `src/layers/whp-3d.ts:139`). |
| DR-029a | None; applied in `46f98f4`. | Residual, from `fixes/I-enso.md` item 5: contract violations are WARNINGS and the runtime consumer still renders from the legacy `phase`. Confirm the headline path reads `state.conditions` before ratifying. | Strengthens DR-030, DR-031, DR-032, DR-034. |
| DR-036a | **Partial.** `src/styles/app.css:3835` already carries `@media (min-width: 721px) and (max-width: 1024px)` from `b90b1ab`, so the band is started. But the census is still 11 rules at `min-width: 721px`, 18 at `max-width: 720px`, one at `max-width: 1024px`, and `--sidebar-w` is still a fixed 340 px. | `--sidebar-w` is baked into `.sidebar-key-host { width: calc(var(--sidebar-w) - 20px) }` and into the s4 spike's measured band arithmetic, so making it fluid forces a re-measure of that spec's prose (`06-interface.md:123-126`). | Strengthens DR-025 (a touch-first tablet must enter 3D by capability, not width), DR-038, DR-037. |

## 6. MapLibre 6 work breakdown

All counts verified by grep on `eb6c4f3` unless marked.

### 6.1 Import inventory: 69 lines, all default imports

`grep -rn "from 'maplibre-gl'" src tests` returns **69** lines. Classification:

| Pattern | Count | v6 form |
| --- | --- | --- |
| `import type maplibregl from 'maplibre-gl';` (type-only default) | 61 | `import type * as maplibregl from 'maplibre-gl';` |
| `import maplibregl from 'maplibre-gl';` (value default) | 8 | `import * as maplibregl from 'maplibre-gl';` or named imports |
| Named (`import { ... }`) | 0 | n/a |
| Namespace (`import * as`) | 0 | n/a |

The eight value-import files are `src/impact/fire-context.ts:23`,
`src/layers/hillshade.ts:26`, `src/layers/hydrography.ts:44`,
`src/layers/telemetry.ts:35`, `src/map/init.ts:1`,
`src/map/interaction-coordinator.ts:30`, `src/state/layer-controller.ts:35`,
`src/ui/sidebar.ts:55`. Between them they construct or call exactly five runtime
members: `maplibregl.Map` (`init.ts:77`), `maplibregl.ScaleControl`
(`init.ts:98,104`), `maplibregl.addProtocol` (`init.ts:21`), `maplibregl.Popup`
(`telemetry.ts:201`, `interaction-coordinator.ts:467`), and `maplibregl.Marker`
(`telemetry.ts:207`). Everything else resolves in type position.

The v6 form is fixed by the migration guide: "If you used the default import
(`import maplibregl from 'maplibre-gl'`), switch to either named imports or a
namespace import," and by the 6.0.0 CHANGELOG: "Switch to an ESM-only
distribution (`maplibre-gl.mjs`). The UMD bundles ... are no longer published."
Confirmed against the published package: `npm view maplibre-gl@6.6.0 exports`
returns only `types` and `import` conditions, with no `default` and no `require`.

The CSS import at `src/main.ts:1`
(`import 'maplibre-gl/dist/maplibre-gl.css'`) **survives unchanged**: 6.6.0 still
ships `/dist/maplibre-gl.css` (jsDelivr file listing) and its `exports` map
includes `'./dist/*': './dist/*'`.

### 6.2 Query sites: 13 real calls, two signatures

`grep -rn "queryRenderedFeatures" src tests` returns 23 lines: **13 real call
sites in `src/`**, 3 stubs in tests, 7 comments. `queryTerrainElevation`:
**0 occurrences**. Correction to the record: `15-dependencies-and-hygiene.md`
DEP-01 says 18 call sites, and the `DDM-D01` gate text in `docs/ROADMAP.yaml`
repeats it in two places. The verified figure is 13.

| Signature | Sites | v6 exposure |
| --- | --- | --- |
| `queryRenderedFeatures(point \| box, { layers })` | 7: `src/impact/fire-context.ts:93`, `src/map/interaction-coordinator.ts:291`, `src/state/location-identity.ts:154`, `src/ui/hover-inspector.ts:83,89,96,106` (plus `:116` chained) | `zoomLevelsToOverscale` default 4 changes which features come back at a given pixel. These arbitrate clicks, hover, and popup identity, so a behavior change is user-visible. |
| `queryRenderedFeatures({ layers })` (viewport-wide, no geometry) | 5: `src/ui/island/strip-metrics.ts:191,247,267,311,329` | Same default; these drive the conditions strip counts, so a change alters a displayed number, not just a hit test. |

Test stubs to update: `tests/drought-semantics.spec.ts:28,52`,
`tests/location-identity.spec.ts:39`.

The migration guide's escape hatch is explicit: set
`zoomLevelsToOverscale: undefined` at map construction to restore v5 behavior.
Recommendation for the first landing: set it to `undefined` in
`src/map/init.ts:77` so the migration changes the renderer and nothing else, then
evaluate the new default as a separate, visible change.

Event classes: the guide says "All events are now classes, it is advised not to
use `instanceof` but instead check the `type` field." There are 38 `instanceof`
uses in `src/` and `tests/`, and **none of them is on a MapLibre event** (they
are `DOMException`, `Error`, `SyntaxError`, `HTMLElement`, `Node`,
`EsriServiceError`). `MapDataEvent` is removed in v6: **0 occurrences**.
`src/layers/ecoregions.ts:444,467` already types on
`maplibregl.MapSourceDataEvent`, which is the v6-correct type.

### 6.3 `setWorkerUrl()`

Required. The guide: "For bundlers (Vite, webpack, esbuild, rspack, Rollup),
`import.meta.url` doesn't reliably resolve to the worker file inside the
bundler's module graph, so each consumer still needs a one-time `setWorkerUrl()`
call." Current occurrences in the tree: **0**.

Where it wires in: `src/map/init.ts`, immediately beside the existing
`maplibregl.addProtocol('pmtiles', protocol.tile)` at `init.ts:21`, which is
already the module's one-time global-registration site (guarded there because
`addProtocol` throws on a second call). Not `vite.config.ts`: this is a runtime
call, not a build option.

Static-host caveat, and the one thing to verify first at execution time. The
6.6.0 worker is `dist/maplibre-gl-worker.mjs`, and the package also ships
`dist/maplibre-gl-shared.mjs` (jsDelivr listing). A plain
`import url from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'` copies one file
without following its import of the shared chunk, which would 404 on GitHub
Pages. The `?worker&url` form makes Vite bundle the worker into a single emitted
asset instead. `vite.config.ts:38` sets `base: './'`, so whichever form is used,
the emitted URL stays relative and works at a domain root and at the
`/dynamic-drought-module/` subpath alike. Inference: `?worker&url` is the correct
choice; confirm by inspecting `dist/assets/` after the first build.

### 6.4 WebGL2, the Safari floor, and `build.target`

Established in section 0: no conflict. WebGL2 is required by v6; iOS Safari 15
and later ship it enabled by default.

`build.target` today: **absent**. Nothing in `vite.config.ts` sets it, and no
`browserslist` key exists in `package.json`. Vite 8's default
`baseline-widely-available` resolves to `chrome111, edge111, firefox114,
safari16.4, ios16.4`. The value that pins the promised floor is
`build: { target: ['es2020', 'safari15.5', 'ios15.5'] }`.

ES2022 and that target: `tsconfig.json` already sets `"target": "ES2022"`, but
`noEmit: true` means TypeScript does no lowering; Vite does, and it does it to
`build.target`. Setting `safari15.5` therefore asks Rolldown to lower MapLibre
6's ES2022 output. Syntax it can lower (class fields, static blocks, private
methods) is fine. Runtime APIs it cannot polyfill are the risk, since
`@vitejs/plugin-legacy` is not installed. Treat step 2 below as a real
verification step with a possible finding, not a config line.

### 6.5 Other v6 changes, occurrence counts on this tree

| v6 item | Occurrences | Verdict |
| --- | --- | --- |
| `canvasContextAttributes` | 0 | Safe. |
| `antialias`, `preserveDrawingBuffer`, `failIfMajorPerformanceCaveat` | 0 | Safe. |
| `geometry-type` | 0 | Safe. |
| `map.transform` removed | 0 | Safe. |
| `styleimagemissing` notify-only | 0 | Safe. |
| `MapDataEvent` removed | 0 | Safe. |
| `maplibre-gl-csp` | 0 | Safe. |
| `GeoJSONSource.setData` loses its second parameter and its return value | 12 `setData(` calls, all single-argument; 13 `GeoJSONSource` casts | Safe as written; confirm no caller awaits a return. |
| `addProtocol` | 1 call, `src/map/init.ts:21` | Unchanged API; keep the existing double-call guard. |
| Terrain API | 2 real calls: `src/map/fire3d.ts:274` (`setTerrain(null)`), `:344` (`setTerrain({...})`); 1 harness stub at `tests/map-harness.ts:150` | Re-verify visually; not a documented v6 break. |
| `raster-resampling` | 2: `src/layers/whp-3d.ts:139`, `tests/fire3d-mode.spec.ts:288` | **This is the point of the upgrade** (FIRE-02). Expect the drape to change from blended confetti to class regions; the spec's expectation may need to become an assertion of the new behavior. |
| style-spec v25, legacy expressions now throw at warning severity | 9 `as unknown as` casts into style-spec types (DEP-06 list: `wildfire-presentation.ts:292,414,699,758,825,841`, `ecoregions.ts:336`, `nws-alerts.ts:311`, `spc-fire-weather.ts:162`) | **Risk concentrator.** These pass `tsc` silently and would fail at runtime as an unpainted layer. Fix on 4.7.1 first (step 1). |
| Popup and Marker API | 2 `Popup`, 1 `Marker` construction | No documented break; re-verify the telemetry popup and the interaction-coordinator popup. |
| `GPUInitializationError` | 0 today | New code. This is DR-035's map error handler; do not build it twice. |
| Icon scaling with offset disabled | render change | Visual pass required. |

### 6.6 Numbered work breakdown

1. **Prep on 4.7.1, no version change.** Replace the nine style-spec
   `as unknown as` casts with typed builders. Verify: `npm run verify:quick`.
   Rationale: after this, any new type error under v6 is a real spec change.
2. **Pin the floor, on 4.7.1.** Add `build.target` to `vite.config.ts` covering
   both ruled floors (Safari 15.5 / iOS 15.5 and Chrome 100 and later on Android,
   DR-009 as amended 2026-09-02); correct `README.md:438-439` to state both
   floors and WebGL 2. Verify: `npm run gate`, and read the emitted bundle for
   lowering failures. A finding here changes DR-009's floor, so it comes before
   the bump.
3. **Bump.** `package.json:63` to `6.6.0`; `npm ci`. Add the renderer-version
   assertion to the gate that `03-fire-3d.md:352-354` asked for after the
   node_modules drift incident.
4. **Rewrite the 69 imports.** Mechanical and scriptable; 61 type-only, 8 value.
5. **Wire `setWorkerUrl`** in `src/map/init.ts` beside `addProtocol`; confirm the
   emitted worker asset in `dist/assets/`.
6. **Add the `GPUInitializationError` branch** to boot, per DR-035 a: after a
   bounded wait the chrome boots without the map and shows an honest
   not-yet-rendering state; a WebGL probe and a map error handler are added
   once. The same probe is DR-025 a's capability check (WebGL2 context creation,
   `webglcontextlost` handling with a fallback to 2D, never a frozen viewport),
   and it gates 3D terrain at the map level, not only the fire scene. The boot
   error path is eager app code, so DR-008 a (map key, telemetry adapters and URL
   catalog made lazy) lands beside it to keep the entry chunk under 45 kB.
7. **Set `zoomLevelsToOverscale: undefined`** at construction; land the migration
   without a query-behavior change; file the new default as a separate item.
8. **Re-verify**, in the DR-052 sequence: typecheck, build, `verify:pure`,
   `verify:quick`, `npm run verify:smoke`, then `test:serial` with `chromium-3d`.
   Re-measure DEM bytes and request count on the same 3D view before and after
   the bump, and re-verify the clear-sky literal in the distributed bundle.
   Cascading-breakage risk by area, highest first: 3D terrain and the WHP drape
   (the resampling change is intended and will move pixels); hillshade
   (`src/layers/hillshade.ts` is a value importer with a local-then-fallback
   path); the PMTiles protocol (one registration, low risk); popups (three
   construction sites, low risk); the fake map harness (`tests/map-harness.ts`,
   370 lines, plus 5 `as unknown as maplibregl.Map` casts across the specs, which
   compile through any shape change and therefore fail late rather than at
   `tsc`).

**Session cost: 3 to 4 focused sessions.** Step 1 is one session on its own and
is safe to land separately. Steps 2 to 7 are one session if step 2 finds nothing.
Step 8 is one session, and one more should be held for the 3D and drape fallout,
which is the only area where the upgrade is meant to change what the user sees.
This is an estimate, not a measurement.

### 6.7 Where the migration lands in the sequence

**Recommendation: at a specific point. Its own single-purpose branch, cut from
`main` immediately after task 1 lands, and completed before the DR-012 and DR-022
product work begins.** Not first, not parallel.

- Not first: `integration/2026-09` is nine commits of gate-green work built and
  measured against 4.7.1. Putting a renderer change under it makes every one of
  those measurements ambiguous again. DR-001's "merge often" addition points the
  same way: land what is proven, then change the floor beneath it.
- Not parallel: one machine holds one `node_modules`. A 4.7.1 feature branch and
  a 6.6.0 branch worked in parallel reproduce ARCH-02 and FIRE-03 exactly, where
  the tree held 5.24.0 against a 4.7.1 lock and "every earlier local result
  described an unshipped renderer" (`00-MASTER-FINDINGS.md` section 2). Under a
  local-first verification posture that is the most expensive failure available.
- Before the product work: FIRE-02 (categorical drape resampling) and the tablet
  3D arm of DR-025 both wait on the new renderer
  (`docs/ROADMAP.yaml` DDM-P9-T04 `needs_decision`, DDM-P9-T02). Every DR-012,
  DR-016, DR-019, DR-022, and DR-036 change is UI built on the renderer. Doing
  the migration second means re-verifying nine commits once, rather than
  re-verifying every subsequent feature twice.
