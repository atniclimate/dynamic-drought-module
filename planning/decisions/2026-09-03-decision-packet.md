# Decision packet, 2026-09-03

This is the entry document for one decision session: the 46 open entries in
`planning/decisions/2026-09-02-decision-register.yaml`, sorted by what they block. Use it in order: write Part 0
first, decide Part 1 by id, object to Part 2 by id only (silence records the default), then read Parts 3 and 4.

State: `integration/2026-09` landed on `main` as PR 57 and is live at `deb4a61`. This packet was corrected on 2026-09-02 after an adversarial review (`C:/dev/_reviews/dynamic-drought-module/2026-09-02_landing-day-agent-work.md`); corrections are marked "Review correction". The next engineering step is
the MapLibre 6.6.0 migration on its own branch (`docs/session-briefing-2026-09-03.md` section 6).

## Part 0. User experiences first

Many people have used the live map. Write what you saw them do and say before reading further, because it may
reorder everything below: who, on what device, trying to answer what, and where they stopped.

<!-- OWNER PROSE. Begin. -->


<!-- OWNER PROSE. End. -->

These are the open decisions your prose is most likely to overturn (cross-references only: each id keeps its
single decision slot in Parts 1 to 3). Each line is the id, the question in ten words, and the kind of
observation that would flip the recorded default.

- **DR-013** One name on all four briefing doors, or per-screen titles. Flipped by: people calling it something else.
- **DR-014** ENSO and Heat rows when the source misses the place. Flipped by: users outside the Pacific Northwest.
- **DR-017** What the horizon chip does where two recipes repeat. Flipped by: nobody ever pressing it.
- **DR-018** Promote the weekly drought rail out of the popover. Flipped by: users never finding the history.
- **DR-020** Give Fire and Heat a stepping time bar. Flipped by: users reading undated surfaces as current.
- **DR-025** Which devices enter the three-dimensional fire scene. Flipped by: tablet users hitting a blank scene.
- **DR-030** Four Pacific Northwest tilt sentences, cited and rewritten. Flipped by: readers taking tilt as forecast.
- **DR-032** A persistent ENSO state panel on that screen. Flipped by: users asking what ENSO is doing.
- **DR-037** One on-map key on all four hazard screens. Flipped by: users failing to read a color.
- **DR-038** A ten-pixel type floor, minimap labels shortened. Flipped by: anyone reporting unreadable labels.
- **DR-040** Heat and ENSO minimaps carry a real condition. Flipped by: users treating the minimap as data.
- **DR-041** When the national fire minimap turns entirely red. Flipped by: users reading fire season as alarm.
- **DR-042** May a condition click open the Impact Briefing. Flipped by: how people actually reach the briefing.
- **DR-044** Ocean doors on the Drought, Fire, Heat minimaps. Flipped by: accidental screen changes in the field.

## Part 1. Decide now, because they block the next work

Eight decisions: six gate the MapLibre 6 branch or its verification, two gate the first product slice, the
Impact Briefing restructure (DR-012b, already ratified).

### DR-035. Boot tolerance for a stalled renderer

The whole boot, including the sidebar that needs no graphics context, waits on the map `load` event, so a hidden
or graphics-poor window sits at a complete-looking skeleton forever. Should boot tolerate a stalled renderer?

- a. After a bounded wait, boot the chrome without the map, show an honest not-yet-rendering state, add a WebGL probe and a map error handler.
- b. Keep strict boot, add a console-visible watchdog only.
- c. No change.

**Recommended default: a.**
Evidence: `src/main.ts:162-168` awaits a promise with no timeout and no rejection path, so nothing can report a
renderer that never loads. MapLibre 6 introduces a `GPUInitializationError` branch, the same error handler this
decision asks for, so option b or c means building it twice (`docs/session-briefing-2026-09-03.md` section 3).
The hidden-window boot failure has already cost one session (memory `ddm-visual-pass-2026-08-31`).
If you say nothing: a hidden window keeps mimicking a deploy regression.

### DR-008. Entry-chunk budget

The entry chunk sits at 43.47 kB gzip against the 45 kB line ratified in ADR 0002, and the briefing fix pulled
`source-capability.ts` into the eager graph. Make the map key, telemetry adapters and URL catalog lazy, or
raise the line?

- a. Make the three modules lazy, keep the 45 kB line.
- b. Raise the line with a recorded reason.
- c. Leave both and stop adding eager imports.

**Recommended default: a.**
Evidence: `scripts/check-bundle-size.mjs:32` sets `DEFAULT_BUDGET_KB = 45` and `check-bundle-size.mjs:74-75`
exempts the vendor chunks, so version 6's vendor weight is safe, but DR-035's boot error path is eager app code
landing against 1.53 kB of headroom (`docs/session-briefing-2026-09-03.md` section 3), and none of the three
modules is needed for first paint.
If you say nothing: the gate goes red on the next eager import.

### DR-025.

Review note: `docs/ROADMAP.yaml` gate DDM-D03 cites DR-025 but asks about Fire 3D exit behavior after custom demotion, a different question; decide in-session whether to split the gate or widen this ruling. Tablet and phone three-dimensional policy, and `fire3d` in the URL

The three-dimensional gate is a bare width query with no capability probe and no context-loss handling. Should
a landscape phone enter the scene at all, and should `fire3d=true` be stripped when the user leaves the
wildfire cluster?

- a. Width floor plus a capability probe with `webglcontextlost` handling; tablet allowed, landscape phone excluded; `fire3d` stripped on cluster change.
- b. Width only, raised to a tablet floor; `fire3d` kept as a remembered preference.
- c. Explicit opt-in with a warning at small widths.

**Recommended default: a.**
Evidence: the gate is `FIRE3D_MIN_WIDTH_QUERY = '(min-width: 721px)'`
(`src/config/fire3d-presentation.ts:96`, consumed at `src/map/fire3d.ts:231-232` and `src/main.ts:215`), which
is width alone. DR-036 is already decided as a touch-first tablet band at 721 to 1024 px, and the migration
briefing records that DR-009 strengthens option a, since a real capability check replaces a width heuristic
(section 5). This decision also sets whether the version 6 re-verification must cover the tablet band.
If you say nothing: any 721 px viewport enters the scene unchecked and the parameter lingers.

### DR-024. The unmerged perimeter-evidence branch

The polygon-exact fire-area fix is finished on `feature/nifc-perimeter-evidence` (8 commits, 20 files, 182 (Review correction; was 163)
behind `main`, backed up on origin at `905671d`). Rebase it into the work, or close it and correct the claim
wording in place, since the briefing calls a 50-record envelope an area?

- a. Rebase onto the current `main` and land it.
- b. Close the branch, correct the wording in place, name perimeters intersecting the area with no area figure.
- c. Leave it open and unmerged.

**Recommended default: b.**
Evidence: the branch is pushed to origin as a backup (register `branch_state.branches_2026_09_02_0830`), so
option b sets aside nothing that is lost. The version 6 migration raises the rebase cost of this branch
(`docs/session-briefing-2026-09-03.md` section 5, DR-009 row), and the claim can be made true today with a
string change that DR-058 already carries.
If you say nothing: the briefing keeps calling a 50-record envelope an area.

### DR-051. What a local run does by default

Should the fire3d evidence capture become opt-in locally, so a routine run stops fetching live Census American
Indian, Alaska Native and Native Hawaiian geometry and Bureau of Indian Affairs geometry and rewriting four
review images? And should local runs assert build identity, so a run proves it booted the build just made?

- a. Both: capture behind `DDM_CAPTURE_EVIDENCE=1`, and build identity asserted locally.
- b. Capture opt-in only.
- c. Neither.

**Recommended default: a.**
Evidence: under DR-002a, hosted checks confirm and the local run is the proof, so a run that is neither
offline-safe nor idempotent cannot carry that weight (register 09-tests D-09-1, D-09-2). The hook install in
Task 2 needs this answered if the Stop hook is ever to run above `verify:quick`
(`docs/session-briefing-2026-09-03.md` section 2, Task 2). The migration is verified by repeated local runs,
which is the worst moment for a loop that rewrites evidence on every pass.
If you say nothing: every local serial run fetches live boundaries and rewrites four images.

### DR-052. The shape of the test suite

What is the accepted local baseline for `chromium-3d`, is the matrix worth rebalancing while that project owns
a 10 to 12 minute critical path, and should the 292 of 852 node-level tests move out of the suite that pays for
a build?

- a. Ratify the 180 s budgets, leave the matrix alone, move node-level tests into a browserless project run by `verify:quick`.
- b. Ratify the budgets only.
- c. Drop `chromium-3d` from the routine loop and run it only before a push.

**Recommended default: b (Review correction: Appendix A supersedes the register's a).** The register and the
first draft of this section recommended a; Appendix A measured today's run and found pure cases cost 9 s of
1674 s, so the migration in (a) buys nothing. Record b, plus a `verify:pure` fast lane. Baseline note: the
register's "292 of 852" and Appendix A's "255 of 856" come from different classifiers and commits; the
Appendix A classifier and its log are in the 2026-09-02 session scratchpad, not the repository, and the
current tree has one more pure case (the clear-sky pin) than that run.
Evidence: the migration ladder ends at `npm run test:serial` including `chromium-3d`, because terrain, hillshade
and the PMTiles protocol are all in the blast radius (`docs/session-briefing-2026-09-03.md` section 2, Task 3).
The two cases that failed on budgets now pass at 180 s locally, and 34 percent of the suite needs no browser at
all (register 09-tests D-09-3, D-09-5). Option c would hide the regressions this migration is likeliest to cause.
If you say nothing: the fast rung keeps paying for a build and two three-dimensional cases stay locally red.

### DR-014. Rows whose source does not cover the selection

When a selection falls outside the Pacific Northwest, should the ENSO row read unavailable or show a
national-scale ENSO state with the regional tilt prose removed? And may the near-term heat claim fetch HeatRisk
independently so it does not vanish when the map layer is off?

- a. National ENSO state with tilt prose removed, and heat fetches independently with its own status and stamp.
- b. ENSO reads unavailable outside the region; heat stays bound to the display.
- c. National ENSO state; heat stays bound to the display.

**Recommended default: a.**
Evidence: DR-012b is ratified, and the briefing records that it turns a non-covering source into a per-cell
state, which is this question (`docs/session-briefing-2026-09-03.md` section 5, DR-012b row). Two roadmap tasks
name this as their gate (`docs/ROADMAP.yaml:253` and `docs/ROADMAP.yaml:259`), so the restructure cannot fill
two of twelve cells without it, and a briefing that changes on a layer toggle describes the map, not the place.
If you say nothing: the ENSO row keeps speaking for the Pacific Northwest everywhere, and heat vanishes when
the layer is off.

### DR-015. Where the overlap engine lives

The Place Studio overlap engine sits in `src/impact/`, which otherwise holds claim construction. Does it stay,
or move to `src/ui/island/`?

- a. Move it to `src/ui/island/`.
- b. Leave it where it is.

**Recommended default: a.**
Evidence: the restructure already rewrites these types, because `SourcedClaim` (`src/impact/types.ts:90`) has
no hazard field and four hazard rows require a hazard discriminant
(`docs/session-briefing-2026-09-03.md` section 5), so the move is nearly free while the files are open and
costly afterwards. It also keeps the briefing dependency graph reviewable, which is what DR-008 is spending
headroom on.
If you say nothing: it stays where it is.

## Part 2. Defaults, recorded unless you object

Actionable within the next two or three landings. Object by id; anything you do not name is recorded as
written. Defaults follow the register's own recommendation except where the note below says otherwise.

| DR | Topic | Default we record | What it unblocks | Cost of waiting |
| --- | --- | --- | --- | --- |
| DR-004 | Asana role under the posture | b: phase-level only, refreshed at each landing, description corrected off v0.6.22 | post-landing bookkeeping, DR-053 | the tracker keeps naming v0.6.22 |
| DR-005 | Dependabot and Worker audit | a, minus the merged half: extend to `workers/proxy` and `.github/actions`, add the Worker audit step | the one deployed surface nothing watches | the relay lockfile stays unaudited |
| DR-006 | One origin, app and relay | a: record the same-origin end state in the roadmap now | gate DDM-D10, the DDM-P15-T01 seam | the seam keeps being shaped for a remote shim |
| DR-010 | Worker `no_nodejs_compat` flag | a: set it, republish, record the rollback handle | the next Worker publish | a Node surface enabled by a date, not a decision |
| DR-011 | Overture buildings pin expiry | a: re-pin to the current release before 2026-09-21 | the Fire three-dimensional buildings layer | the layer expires while nobody is present |
| DR-021 | Outlook badge and jump chip | a: badge the card OUTLOOK, rename the chip to name its destination | VP-15, one stamp grammar | one Climate Prediction Center product keeps two register words |
| DR-028 | A free federal key under rule 3 | a: no, the National Aeronautics and Space Administration Fire Information for Resource Management System stays out, the invariant stands | closes a recurring question | the question returns a fourth time |
| DR-030 | Pacific Northwest tilt sentences | a: adopt all four with a source URL on each | the ENSO row, DR-029 copy | uncited tilt prose ships during a very strong event |
| DR-031 | Weekly Nino 3.4 observation | a: wire it, labeled an observation and not a forecast | the ENSO near-term cell | three ENSO horizons keep showing one raster |
| DR-034 | ENSO snapshot and transcription | a: add the Multivariate ENSO Index v2 and the Pacific Decadal Oscillation, no transcription, the plume tombstone stands | gate DDM-D06, DR-029 schema work | the probability question is asked a fourth time |
| DR-043 | Completeness sentence, two popups | a: add it to the deployer Tribal-Lands popup and the Treaty popup | consistency across three Tribal-geography surfaces | two of three keep omitting the limit |
| DR-046 | Water-supply percent bands | a: drop the invented bands, keep the number and its uncertainty | DWH-04 defensibility | a 74 percent and a 20 percent forecast share one sentence |
| DR-048 | Drought Monitor impact strings | a: relabel derived with an archive citation, link the state impacts tool | DWH-16 | a claim keeps citing a page that no longer says it |
| DR-050 | Completeness on two rasters | a: adopt on gridded-index and sea-surface anomaly | ARCH-04, the six-state invariant | two surfaces keep saying live off their coverage |
| DR-053 | Roadmap and release-notes shape | a, ratifying what `eb6c4f3` already did, plus product-led release notes | DOC-04, DOC-05, handoff readability | the release notes keep reading as a job log |
| DR-054 | Skills, agents, shared commands | a: dormant files marked dormant, a project-local pickup wrapper, no automated merge | the `.claude` tree's clarity | a dormant skill stays invocable and listed as current |
| DR-055 | Where ignored artifacts live | a: installers beside the settings they install, a tracked dated citation table under `docs/` | the ddm-cite workflow, the G9 record | the verification work dies with the workspace |
| DR-056 | Tile scope, zero during load | a: a visible in-view qualifier and a loading state in place of the 0 | FE-21, the tiles' first read | a tile keeps claiming zero perimeters before counting |
| DR-057 | Studio toggle and labeling | a: fix all four, the satellite toggle state, the caption, the dots, the two source lines | studio first read, attribution reachability | a licence obligation sits two disclosures deep |
| DR-058 | Two briefing sentences | a: plain-language lineage kept machine-readable in an attribute, one fire count with its source | briefing readability, the wording half of DR-024 | internal identifiers stay in public text |
| DR-059 | Preview badge in embeds | b: keep bottom center on desktop only | embed and phone chrome | none, b is the current behavior |

Note on DR-005: the register recommends merging Dependabot 48 and 49, but both merged behind PR 57 (register
`branch_state.landing`). Only the scope extension and the Worker audit step remain open.
Note on DR-053: `docs/ROADMAP.yaml` was already slimmed on the branch in `eb6c4f3`, so option a is now mostly a
ratification plus the release-notes half.

## Part 3. Parked

Nothing here is asked of you today. Each waits for the MapLibre 6 landing or for the prose in Part 0.

| DR | Topic | Wait for what |
| --- | --- | --- |
| DR-013 | The briefing name on every door | the prose: what people call the panel |
| DR-017 | Horizon chip where two recipes repeat | the prose: whether anyone presses it |
| DR-018 | Promoting the weekly drought rail | the prose, plus the DR-036 tablet band landing |
| DR-020 | Fire and Heat time bars | the version 6 landing, plus the DR-022 fire tier |
| DR-023 | Incident points beside perimeters | the version 6 landing; every count string is restated with it |
| DR-026 | Fire basemap and perimeter contrast | the version 6 landing; the drape and the frame both change |
| DR-027 | Fire context layer scope | DR-022's hazard-beside-perimeter use case landing first |
| DR-032 | A persistent ENSO state panel | the prose, plus gate DDM-D11's first ENSO question |
| DR-033 | Sea-surface source and marine heatwaves | the DR-019 issuer-product scouting result |
| DR-037 | Hazard screen uniformity, key, naming | the prose: where a reader failed to read a color |
| DR-038 | The ten-pixel type floor | the prose: field legibility reports |
| DR-039 | Motion on the big overlays | the version 6 landing; the popup clamp is in the blast radius |
| DR-040 | Heat and ENSO minimap metrics | the prose: whether the minimap is read as data |
| DR-041 | Fire minimap red threshold | the prose: whether a red national view reads as alarm |
| DR-042 | Condition clicks opening the briefing | the prose: how people reach the briefing today |
| DR-044 | Ocean doors on three minimaps | the prose: accidental screen changes in the field |
| DR-060 | Six uncovered walkthrough looks | the version 6 landing, then one agent capture pass |

## Part 4. Process diet, for ratification

Review correction: these five proposals are registered together as **DR-062** so the session decides them by id like
everything else.

These five are the reviewer's suggestions, not rulings, and they exist because "process is outrunning product"
is a fair criticism. Accept, amend, or reject each by number.

1. **An open-decision cap of ten.** When the register holds more than ten open entries, the excess is recorded
   at its default and closed. New questions displace old ones instead of accumulating beside them.
2. **One entry document per session.** A session opens with exactly one document, and a report is archived the
   moment a briefing or packet folds it in, so no reader has to reconcile two live accounts.
3. **Decision by default unless objected in-session.** A recorded default becomes a decision when the session
   ends without an objection, and the register says so on its face rather than staying pending forever.
4. **One landing per session before new planning.** Every session lands one user-visible change or one
   engineering change on `main` and verifies it live before any new planning artifact is written.
5. **Subagent reports capped at 600 words.** Each must end in either a decision to record or a diff to apply.
   A report that ends in neither is not delivered.

## Appendix A. Browser suite shape

**Question.** The 2026-09-02 serial run was 854 passed, 2 failed in 28.7 minutes on one worker, and both failures were spec problems rather than product regressions. Are the browser projects carrying work that needs no browser, and can boot-timing races be closed at the source instead of one spec at a time?

**Method.** Every count and duration below comes from one pass over that run's line-reporter log (`.../scratchpad/test-serial.log`, produced by `npm run test:serial`) with the classifier `python .../scratchpad/classify.py`, which maps each reported `spec:line` back to its source body; the pattern counts in section 3 come from `grep -rn` over `src/` and `tests/`. Case durations are the reporter's own per-case figures. They sum to 1673.7 s against the 28.7 min wall clock (97 percent); the remainder is the build, preview startup, and per-file collection.

### 1. Where the 28.7 minutes goes

| project | files | passed | case seconds | share | mean |
| --- | --- | --- | --- | --- | --- |
| `chromium` | 101 | 780 | 1086.7 (18.1 min) | 64.9% | 1.39 s |
| `chromium-interaction` | 4 | 42 | 120.7 (2.0 min) | 7.2% | 2.87 s |
| `chromium-3d` | 2 | 32 | 466.3 (7.8 min) | 27.9% | 14.57 s |
| total | 107 | 854 | 1673.7 (27.9 min) | 100% | 1.96 s |

Both failures sit in `chromium`. The header line declares 856 tests; 854 passed plus 2 failed.

Ten slowest cases, all in `chromium-3d`:

| # | spec:line | seconds | case |
| --- | --- | --- | --- |
| 1 | `tests/fire3d-mode.spec.ts:641` | 56.8 | desktop toggle activates the 3D scene with the volume legend |
| 2 | `tests/fire3d-mode.spec.ts:781` | 46.3 | a shared fire3d link boots active |
| 3 | `tests/fire3d-mode.spec.ts:1001` | 45.8 | one extra reference layer keeps the scene |
| 4 | `tests/fire3d-mode.spec.ts:1045` | 36.1 | switching clusters exits the scene |
| 5 | `tests/view-contracts.spec.ts:319` | 32.0 | a-reloaded-3d-share-boots-back-into-the-same-view |
| 6 | `tests/fire3d-mode.spec.ts:812` | 29.5 | reduced motion still enters and leaves the 3D scene |
| 7 | `tests/view-contracts.spec.ts:319` | 23.5 | the-power-toggle-governs-the-3d-scene-too |
| 8 | `tests/fire3d-mode.spec.ts:889` | 22.8 | an empty smoke read says so in the 3D control |
| 9 | `tests/view-contracts.spec.ts:319` | 21.7 | a-region-jump-preserves-the-3d-preference |
| 10 | `tests/view-contracts.spec.ts:319` | 19.4 | leaving-3d-clears-the-scene-and-the-parameter |

Heaviest files overall: `fire3d-mode.spec.ts` 278.3 s in 20 cases, `view-contracts.spec.ts` 188.0 s in 12, `tribal-live-layers.spec.ts` 74.9 s in 21, `s4-shell.spec.ts` 52.5 s in 18, `heat-h0-integrity.spec.ts` 45.9 s in 14. The two `chromium-3d` files hold 27.9 percent of case time in 3.7 percent of cases.

### 2. Pure-logic cases running in browser projects

255 of 856 cases (29.8 percent) never touch `page`, `browser`, `context`, `request`, or `gotoApp`. They import from `src/` and assert on returned values. They cost **9.1 s of 1673.7 s (0.54 percent)**. Playwright creates no browser or page for a case that does not request the fixture, so these already run at browser-free speed inside the browser projects; what they cost is category confusion, not wall clock. By project: 253 in `chromium`, 2 in `chromium-3d` (`fire3d-mode.spec.ts:58` and `:95`, both URL-token parsing), 0 in `chromium-interaction`.

Ten wholly pure files (80 cases, 1.7 s total): `display-summary.spec.ts` 21, `capability-matrix.spec.ts` 14, `s1-substrate.spec.ts` 12, `minimap-wildfire.spec.ts` 11, `minimap-drought.spec.ts` 7, `point-in-polygon.spec.ts` 6, `satellite-source.spec.ts` 4, `umbrella-config.spec.ts` 3, `location-identity.spec.ts` 1, `usfs-whp.spec.ts` 1.

Top mixed files by pure-case count (26 files, 175 pure cases, 7.4 s): `antimeridian.spec.ts` 28 of 34, `landscape-loader.spec.ts` 18 of 29, `overlap-engine.spec.ts` 16 of 22, `worker-proxy-policy.spec.ts` 16 of 23, `wildfire-source-semantics.spec.ts` 14 of 19, `cluster-service.spec.ts` 12 of 15, `evidence-contract.spec.ts` 12 of 15, `raster-status.spec.ts` 12 of 26, `layer-order.spec.ts` 11 of 12, `s2-url-migration.spec.ts` 8 of 21.

Today's second failure, `wildfire-source-semantics.spec.ts:876`, is one of these pure cases: a stale `resolveMapKeyFamily` assertion that needed a 28.7-minute browser run to surface.

Counting rule: a case is pure when its body, taken from its reported line to the next reported line in the same file, mentions none of `page`, `browser`, `context`, `request`, `browserName`, `gotoApp`, `newPage`, `newContext`, and its file declares no fixture-taking hook. The 12 YAML-driven `view-contracts.spec.ts` cases share one reported line, so they are counted as browser cases.

### 3. Timing-sensitive patterns

| pattern | where | count | note |
| --- | --- | --- | --- |
| shared fetch key with more than one consumer | `'nadm-current'` | 2 consumers | `src/layers/nadm-drought.ts:237` and `src/state/minimap-drought.ts:557`. It is the only key in the codebase: `fetchSharedJsonWithBudget` has 5 matches in `src/`, being 1 definition, 2 imports, 2 calls |
| invalidation of that key | the same two modules | 2 sites | `nadm-drought.ts:246`, `minimap-drought.ts:583`. Either consumer's bad payload evicts the fulfilled entry (Review correction: no transport is aborted; `controller` is already null by then, `fetch.ts:216-220`), so a consumer arriving after the eviction fetches again, which is today's first failure |
| `test.setTimeout` raise | `fire3d-mode.spec.ts` | 6 | 120 s to 180 s, against the 60 s config default |
| `test.setTimeout` raise | `view-contracts.spec.ts:320` | 1 dynamic | driven by 10 `timeout_ms` rows in `tests/view-contracts.yaml` |
| per-assertion `timeout:` override | 49 spec files | 205 literals | heaviest: `popup-viewport` 28, `s4-shell` 18, `umbrella` 13, `fire3d-mode` 13, `enso-observed-state` 12, `tribal-live-layers` 10 |
| `waitForTimeout` | 19 spec files | 32 sites | 31 literal sleeps summing 28.6 s; 1 computed (`popup-viewport.spec.ts:313`) |

### 4. A boot-idle seam

`src/main.ts` already stamps `<html>` at the top of `boot()` (`dataset.ddmBuildSha`, `dataset.ddmBuildNonce`) and `gotoApp` already reads that stamp in `assertBuildIdentity`, so a third stamp needs no new mechanism. Sketch: `boot()` sets `document.documentElement.dataset.ddmBoot = 'booting'` before `createMap`, and a small tracker flips it to `idle` once three conditions hold. First, the existing map `load` promise has resolved. Second, every layer the deep link activated has left `loading` in the registry, which `src/state/registry.ts` already announces through the `status-change` event `setStatus` fires per key. Third (Review correction), every shared JSON transport has settled: `src/util/fetch.ts` keeps a fulfilled entry in
`sharedJsonRequests` for the page lifetime by design (`fetch.ts:175-178`), so "map is empty" would never hold after
a successful fetch; the seam needs a pending-transport counter that decrements on settlement and leaves fulfilled
entries intact. Expose the same transition as `window.__ddm.ready`, a promise, for specs that prefer awaiting a value to polling an attribute; unlike the `__ddmMap` handle it has to survive the production build, so it belongs outside the `import.meta.env.DEV` block.

`gotoApp` then gains one line after its existing assertions: `await expect(page.locator('html')).toHaveAttribute('data-ddm-boot', 'idle')`, at the config's 10 s expect budget. No existing assertion changes; the seam only moves the moment they run.

What it would not fix: any race that opens after boot idle. A toggle, a preset swap, a region jump, or a cluster change reopens the same shared-fetch and layer-activation window mid-run, and today's first failure, `m-breadth-nadm-drought.spec.ts:206`, is exactly that shape. The spec asserts an `unavailable` pill that the minimap's competing `nadm-current` consumer repairs to `live` before the assertion stops polling (the call log shows 22 reads of `live`). A boot-idle attribute is also worse than nothing if it flips early: a seam that reaches `idle` before a layer settles turns a visible failure into a silent one, so the tracker must count activations, not wait out a timer.

### 5. Decision

**(a) Move pure cases to `node --test` under `check:all`, plus the seam.** Measured wall-time saving is 9.1 s of 28.7 min, 0.5 percent, because Playwright already creates no browser for a case that does not request the fixture. The cost is real: 255 cases across 36 files, 26 of them mixed, so it is a per-case split rather than ten file moves; Playwright's `expect` has to become `node:assert` or an equivalent, and the pure specs use `toContain`, `toBeGreaterThan`, `toHaveLength` and eight other matchers; and running `.ts` under `node --test` depends on type stripping, which needs erasable syntax across the whole import graph, where `src/layers/nifc-fires.ts:107` and `src/util/frame-stepper.ts:93` use constructor parameter properties today. Risk: a large mechanical rewrite whose only measured payoff is category clarity.

**(b) Only the seam.** Cost is one boot tracker plus one `gotoApp` line. It saves no wall time and may cost a little, since `gotoApp` would wait for real idle rather than for the preset chips. Its payoff is the failure class expected to recur: 1 of today's 2 failures, and `playwright.config.ts` records an earlier cluster of about 35 of 53 named flake events on four interaction files. Risk: an idle signal that flips early, which trades a loud flake for a quiet one, mitigated by deriving it from registry status transitions and the `sharedJsonRequests` map rather than from elapsed time.

**(c) Leave as is.** Zero cost today. Risk: every boot change reopens the same triage, and the suite answers 28.7 minutes at a time.

**Recommendation: (b).** The wall-time case for (a) does not survive the log. Pure cases are 29.8 percent of the suite by count and 0.54 percent by time, so moving them buys nine seconds for a 255-case rewrite. The real complaint behind (a) is feedback latency, and that is cheaper to fix inside the current runner: the ten wholly pure files run in 1.7 s, so a `verify:pure` script listing them, or a Playwright `--grep` tag, gives the fast lane with no migration, and today's stale-assertion failure would have surfaced there in seconds rather than after 28.7 minutes. Spend the effort on the seam, the only option that touches the failure class that will recur, and revisit the wall clock where the time actually is: `fire3d-mode.spec.ts` and `view-contracts.spec.ts` hold 466.3 s, 27.9 percent of case time, in 32 of 856 cases.


## Appendix B. Pre-processing pipeline

Review corrections, 2026-09-02: (1) the decision at the end of this appendix is registered as **DR-061** so it has one
slot like every other; (2) the counts "16 live, 7 Worker-proxied, 13 committed" count external source families used
by `src/layers` only; they omit live consumers in `src/impact/sources.ts`, `src/state/watershed-geometry.ts`,
`src/config/station-registry.ts`, and `src/impact/nws-point.ts`, group multi-endpoint families, and exclude the two
deployer placeholders, the legacy ecoregion placeholder, and the six resource catalogs under `public/data/resources/`;
(3) issuer facts in the source table (publishers, cadence, lags, publication days, service behavior) cite repository
code only and are evidence-grade, not citation-grade: nothing here changes product wording without `/ddm-cite`.

Would a nightly GitHub Actions normalization job publishing normalized JSON to Pages move most of the
browser-side data honesty upstream now, ahead of the local full-service server (`docs/ROADMAP.yaml`
DDM-P15-T01, DDM-P14-T04)? Today: 16 live browser fetches, 7 Worker-proxied reads, 13 `public/data/` artifacts.

### B.1 Sources and the honesty edge cases the client carries

| Source | Issuer | Today | Cadence | Client-side honesty work |
| --- | --- | --- | --- | --- |
| USDM current, archive | NDMC, NOAA, USDA | live | weekly Thu AM ET | newest valid Tuesday derived live from `MapDate`, never assumed (`src/layers/usdm.ts:8`, `:810`); two validity field spellings across the two services (`:268`) |
| USDM DSCI trend | NDMC | Worker | weekly | issuer stopped sending CORS 2026-07-14, route moved to the Worker (`src/config/urls.ts:522`; `src/impact/sources.ts:550`) |
| CPC drought outlooks, 6-10, 8-14 | NOAA CPC | live | monthly, seasonal, daily | HTTP 200 error envelope throws rather than reading as absence (`src/impact/sources.ts:125`, `:174`, `:186`) |
| NIDIS gridded SPI | NOAA NIDIS | live | per window, uneven | per-product `info.json` read at activation and window change; the 365 day raster was 62 days old unnoticed (`src/layers/gridded-index.ts:26`, `:284`) |
| NWS HeatRisk | NWS WPC | live | rolling 7 day | `idp_validtime` granules read every activation; an omitted `time` silently returns the wrong day (`src/layers/heatrisk.ts:6`, `:121`) |
| NWS WWA alerts (live), NWS point API (Worker) | NWS | both | 5 minutes | a malformed HTTP 200 must not become a clean zero (`src/layers/nws-alerts.ts:220`); User-Agent identity needs the Worker (`src/impact/nws-point.ts:45`) |
| SPC fire weather | NOAA SPC | live | up to 5x daily | empty FeatureCollection is a real result, not an error (`src/layers/spc-fire-weather.ts:17`); `valid` and `expire` read per feature (`:88`) |
| NIFC WFIGS perimeters | NIFC | live | ~5 minutes | 15 s budget after a 42.75 MB, 41.6 s breach (`src/layers/nifc-fires.ts:34`, `:209`) |
| NOAA HMS smoke | NOAA | live | sub-daily passes | Julian `YYYYDDD HHMM` strings parsed client-side (`src/layers/hms-smoke.ts:11`) |
| USFS WHP raster | USDA FS | Worker | static 2023 | intermittent CORS on `exportImage`; no Worker means `unavailable`, never a pretend direct fetch (`src/layers/usfs-whp.ts:40`, `:162`) |
| NADM continental | NCEI, tri-national | live | monthly, 2-3 wk lag | invalid `YEAR_MONTH` throws (`src/layers/nadm-drought.ts:74`); no polygon means no coverage, not class zero (`:167`) |
| BC basin drought | Province of B.C. | live | weekly in season | value 99 renders `No update`, never on the severity ramp (`src/layers/bc-drought.ts:8`, `:232`) |
| CDM areas | AAFC | snapshot | monthly, by hand | stewardship term grep before write (`scripts/build-cdm-snapshot.mjs`); an absent class means absent, not failed |
| ENSO indices | NOAA CPC | snapshot | weekly job | 45 day prose hedge, 120 day hard degrade (`src/impact/enso.ts:242`, `:304`); refreshed by `.github/workflows/refresh-snapshots.yml` |
| GIBS SST anomaly | NASA | live | daily, gapped | time domain enumerated live, gaps preserved and never interpolated (`src/layers/sst-anomaly.ts:185`) |
| Census AIANNH, BIA AIAN-LAR | Census, BIA | live only | continuous | non-redistribution guard, session-only, `cache: 'no-store'` (`src/layers/aiannh.ts:22`, `:442`); error envelope handled (`:364`, `src/layers/bia-reservations.ts:329`) |
| AWDB, Hydromet, AgriMet, NWRFC | NRCS, USBR, NWRFC | Worker | daily | an empty `workerProxy` fails honestly rather than blind-fetching (`src/util/hydromet.ts:106`; `src/impact/water-supply.ts:189`; `src/util/awdb.ts:90`) |

Tombstoned, not fetched: WaterWatch, the legacy NADM MapServer, the CPC ENSO probabilities scrape (`src/config/urls.ts:144`, `:1029`, `:1178`).

### B.2 What a nightly job would publish, and how the six states would read it

One document per source, identical shape: `source`, `issuer`, `issued`, `validStart`, `validEnd`,
`expectedNextIssue`, `fetchedAt`, a machine-readable `state` of `ok` / `issuer-error` / `unreachable` /
`no-data`, the issuer's own message verbatim when it sent one, a `provenance` block (URL, bytes, run id),
and the payload. Six states exist: `loading`, `live`, `live (partial)`, `unavailable`, `no data`, `zoom in
to load` (`docs/design/README.md:61`).

- Can honestly say `live` from a nightly file: USDM current and archive index, USDM DSCI, the CPC monthly,
  seasonal, 6-10 and 8-14 outlooks, NIDIS per-window valid dates, NADM, CDM, ENSO, BC basins, USFS WHP
  (static), EIA plants. Each has an issuer cadence of a day or slower, so a file built after the issuer's
  own publication carries the claim the browser would have fetched.
- Cannot: NWS WWA alerts and the NWS point API, NIFC WFIGS perimeters, SPC Day 1, HMS smoke, USGS
  instantaneous values, Overpass hydrography (viewport-shaped, not a fixed document). Census AIANNH and BIA AIAN-LAR are excluded by the current session-only product policy (public/data/README.md lines 10 to 28), not by cadence and not by hard rule 1 (Review correction).
- `live (partial)` is unaffected: a coverage judgment about the current view (DDM-P14-T04), not freshness.

Staleness would be computed against the issuer's clock, not the file's: `now > validEnd`, or
`now > expectedNextIssue + grace`. The load-bearing finding is that there is no `stale` state to render it
into; adding one is a seventh state and a contract change to `src/state/layer-controller.ts`. The precedent
is ENSO, which holds the state at `live` and degrades the prose in two steps (`src/impact/enso.ts:242`, `:304`).

### B.3 What shrinks, what must stay

Shrinks for a moved source: ArcGIS error-envelope detection (`src/impact/sources.ts:152` to `:190`), the
per-activation metadata reads (`gridded-index.ts:284`, the HeatRisk catalog read, the SST DescribeDomains
read), the Wednesday-versus-Thursday derivation at `usdm.ts:810`, and five of the seven Worker source families
(AWDB, Hydromet, AgriMet, NWRFC, plus USDM DSCI), because a normalizer in Node has no CORS problem at all.

Must stay: every sub-daily live source above; the cancellation and budget primitives in
`src/util/fetch.ts`, which then guard the fetch of the normalized file instead of the issuer;
user-triggered retry, since a night that failed to build is exactly when a person wants the issuer
directly; the `unavailable` versus `no data` distinction; and the Worker, because `usfs-whp` tiles and the
NWS User-Agent identity are per-request, not per-night (`src/layers/usfs-whp.ts:40`).

### B.4 Costs

- Actions minutes: none. The repository is public, and Actions on standard GitHub-hosted runners is free
  and unlimited for public repositories. The budget is wall clock and Pages builds. A job shaped like
  `refresh-snapshots.yml` runs a few minutes; a nightly one dispatching a full Pages deploy also churns
  `main` and burns one of ten Pages builds per hour.
- Size: attribute-only documents are single-digit kB and effectively free. Geometry is not. A national USDM
  week is about 440 kB even generalized (`src/config/urls.ts:540`), NADM current is 616 kB (`:1183`), the
  committed CDM snapshot is 960,819 bytes. Committing geometry nightly adds roughly 1 to 2 MB a night to a
  pack that is 89.6 MiB today. Publish dates, windows and statistics; leave geometry on its current cadence.
- Freshness loss: bounded by the interval, near zero for weekly and monthly issuers. The named risk is USDM,
  published Thursday morning Eastern: a fixed-hour job serves the new week up to 24 hours late unless the
  client keeps reading the current `MapDate` live.
- Sovereignty (Review correction): hard rule 1 protects Tribally-held or Tribally-sourced boundary data. Census
  AIANNH and BIA AIAN-LAR are federal public cartographic representations that sit outside TSDF tiering and may
  appear in CI artifacts (`AGENTS.md` rule 1 as amended 2026-08-29). Keeping them live and session-only in the
  runtime is a deliberate current product choice, not a consequence of the rule
  (`src/layers/aiannh.ts:22`, `:442`; `public/data/README.md:11`). `waEcologyCededLands`, a Treaty-cession
  representation, is likewise off limits to any build (`src/config/urls.ts:741`). The two deployer slots
  stay empty. Federal public products (USDM, NADM, CPC, NIFC, WHP, EIA) may enter a build and an artifact.
  Any Canadian archive keeps the CDM builder's stewardship term grep before write.

### B.5 Relation to the local full-service server

The normalizer is the server's first module, not a throwaway. Fetch, parse, validate and emit is
host-agnostic Node, and the repository already separates builder from consumer contract
(`scripts/build-enso-snapshot.mjs` plus `scripts/validate-enso-snapshot.mjs`), with `refresh-snapshots.yml`
thin plumbing around them. Throwaway is only that plumbing: the cron trigger, the commit to `main`, the
Pages dispatch. The server replaces the schedule and the publish target, keeps the normalizer, and under
DR-006 option a (one origin) also retires the Worker. Building it now is work the server inherits, and it
gives DDM-P15-T01 a seam list instead of a paragraph.

### B.6 Decision framing

- (a) Nightly job now for every daily-or-slower source. Broadest gain, but adds a nightly commit to
  `main`, a nightly Pages deploy, and a staleness concept the six-state contract cannot express.
- (b) Wait for the server. No new plumbing, but the browser carries every edge case above through the whole
  2026-09 briefing build, and DDM-P15-T01 stays prose.
- (c) Narrower: normalize only the worst-edge-case sources, publish dates and windows without geometry, keep
  the existing weekly workflow shape.

**Recommendation: (c).** The honesty debt is concentrated, not spread evenly, and the geometry-free subset
costs almost nothing while proving the normalizer the server inherits. First three to move:

1. **USDM week index and DSCI.** The only source whose newest valid stop is derived live and is
   Thursday-fragile (`src/layers/usdm.ts:8`, `:810`), and its DSCI companion already rides the Worker
   because issuer CORS drifted (`src/config/urls.ts:522`). A nightly index of valid Tuesdays with
   `ValidStart` and `ValidEnd`, plus the DSCI series, removes both and one Worker route; geometry stays live.
2. **NIDIS per-window valid dates.** Five slugs, five dates, a few hundred bytes. The 365 day raster sat
   62 days old unnoticed until 2026-09-01 (`src/layers/gridded-index.ts:26`); a nightly table makes every
   window's age comparable at a glance and drops a per-activation read.
3. **CPC monthly and seasonal drought outlooks.** DDM-P7-T04 needs their validity windows, and their host
   is the one that answers HTTP 200 with an error envelope (`src/impact/sources.ts:125`). Capturing issued
   date, target and window nightly lets an outage say which issue is shown and that it could not be
   refreshed, instead of going blank.

NADM and CDM are the natural fourth and fifth, but carry geometry, so they are a separate size call.


## Appendix C. The Safari floor

Review note, 2026-09-02: this appendix is implementation evidence for decided DR-009, not a new decision. The used-hardware
price range and the WebKit install-hang anecdote below are uncited; the WebKit 26.5 bundling fact is verified in
`node_modules/playwright-core/browsers.json`.

**Question.** DR-009 pins a Vite `build.target` of `['es2020','safari15.5','ios15.5']`, and README.md promises "Safari 15.5 or newer," but all three Playwright projects (`chromium`, `chromium-interaction`, `chromium-3d`) run Chromium only. Can the 15.5 floor be tested, and at what cost?

### 1. Playwright's bundled WebKit is not a pinnable Safari version
Playwright ships one WebKit build per release, tracking the current Safari / Safari Technology Preview line, not a chosen historical version. Playwright 1.61.1 bundles WebKit 26.5 (playwright.dev/docs/release-notes; github.com/microsoft/playwright/releases/tag/v1.61.1). Under Apple's 2025 year-based renumbering (Safari 18.x moved to 26.x, aligned to iOS/macOS 26), that lines up with Apple's own "Safari 26.5 Release Notes" (developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes), a 2026 release. Safari 15.5 shipped in 2022. A `webkit` project tests roughly today's Safari, not the 15.5 floor, and Playwright offers no supported way to pin an older WebKit build.

### 2. Real-Safari-15.5 options: cost and effort, one line each
- BrowserStack open source program: free, all products (Automate, Live, Percy), 5 users / 5 parallel sessions, apply with a project URL; real iOS devices span old builds, e.g. an iPhone 13 on iOS 15.x (browserstack.com/open-source, browserstack.com/test-on-safari-browser). Effort: apply, wait for approval, wire one Automate job into CI.
- Sauce Labs open source program: free real-device cloud for approved OSS projects, apply via opensource@saucelabs.com; specific OS-version and parallelism limits are not published (opensource.saucelabs.com/docs). Effort: similar application plus integration.
- GitHub Actions macOS runner + Xcode simulators: not viable for 15.5. `macos-14`'s oldest bundled simulator is iOS 17.0 (Xcode 15.0.1); GitHub keeps only the three most-recently-installed Xcode runtimes (github.com/actions/runner-images, images/macos/macos-14-Readme.md). No current hosted runner can boot an iOS 15.5 simulator, and macOS minutes bill several times Linux minutes.
- Real device: keep hardware still on iOS 15.5, drive it manually or via Appium/WebDriverAgent from a Mac. One-time cost (roughly $150-400 for used hardware), then a manual check per release.

### 3. Cost of adding a `webkit` project to the existing Ubuntu CI
`npx playwright install --with-deps webkit` is quick once cached, but Ubuntu GitHub runners have a documented webkit-specific install hang (community reports put it near a quarter of installs, 10-14+ minutes). More importantly, headless WebKit does not do hardware-accelerated WebGL, and there is no documented Linux-WebKit equivalent of the `--use-gl=angle --use-angle=swiftshader` flags this repo already needs for headless Chromium (playwright.config.ts, `CHROMIUM_USE`). A `webkit` project would likely need `xvfb-run`, and WebGL2 support for MapLibre on that path is unproven, so it could only be trusted for non-map DOM assertions, not the map itself.

### 4. What `build.target` guarantees
Vite's docs state: "Vite only handles syntax transforms and does not cover polyfills" (vite.dev/guide/build). `build.target` lowers emitted JS syntax to parse on the named engines; Vite's own default is `'baseline-widely-available'`, i.e. `['chrome111','edge111','firefox114','safari16.4','ios16.4']` (vite.dev/config/build-options), confirming DR-009's note that Vite's out-of-box target already exceeds 15.5. Setting `['es2020','safari15.5','ios15.5']` only proves the emitted syntax parses on those engines; it says nothing about runtime APIs (fetch behavior, WebGL2, ResizeObserver, structuredClone, etc.) existing or behaving correctly at 15.5. Those need manual verification or a plugin-legacy-style polyfill, not the build target.

### Recommendation: (c), scoped honestly
Do both, and do not conflate them. The build-target pin is close to free and is real syntax evidence; pair it with one verified check per release on an actual Safari 15.5 or iOS 15.5 surface, cheapest via BrowserStack's open source grant (free, one-time application). Add a `webkit` Playwright project on Ubuntu CI too, but label it in tests/README.md as "current WebKit regression, not the 15.5 floor," and expect it to skip or soft-fail the WebGL-dependent map specs. Neither layer substitutes for the other; together they make "Safari 15.5 or newer" defensible rather than aspirational.


Decided already, for reference: DR-001, DR-002, DR-003, DR-007, DR-009, DR-012, DR-016, DR-019, DR-022, DR-029, DR-036, DR-045, DR-047, DR-049.
