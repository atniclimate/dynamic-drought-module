# Reconciliation: docs/ROADMAP.yaml against .planning/TRACE.yaml

Session date 2026-09-07. Sources read: `.planning/TRACE.yaml` (trace_version 2, generated_on
2026-09-07, commit `5be15f5`, TRACE.yaml:1-11), `docs/ROADMAP.yaml` (schema_version 2, updated
2026-09-03), and `.planning/trace/imports.json`, which TRACE.yaml names as its own module graph
(TRACE.yaml:7-8). One source file was opened, to confirm one verdict; it is cited in Finding 2.

Nothing in `docs/ROADMAP.yaml` was modified. Section 9 is a proposed diff, not an applied one.

Three arithmetic notes before anything else, so no number below reads as a silent correction:

- The prompt says 45 orphan files without test coverage. `counts.orphan_files_without_test_coverage`
  is **47** (TRACE.yaml:123), and the list at TRACE.yaml:4831 holds 47 entries. Two of the 47 are
  the workflow files that Section 8 handles separately; **45 are under `src/`**. Section 5 ranks all
  47 and marks the split.
- The prompt says four non-P0 done-claims with no files and no tests. Three of the four have
  neither: DDM-P9-T01, DDM-P10-T02, DDM-P15-T03 (`counts.tasks_with_neither_ids`, TRACE.yaml:74).
  **DDM-P12-T01 has one file** — `src/impact/enso.ts` (TRACE.yaml:3198) — and no test; its
  `coverage` is `files-no-tests`. Section 4 examines it on that footing.
- The prompt says seven workflow-attested P0 claims. Six done P0 tasks are attested **only** by
  files under `.github/` with no test at all (T01, T02, T04, T06, T07, T08). The seventh P0 task
  carrying a workflow file, DDM-P0-T12, also carries two scripts and two real tests
  (TRACE.yaml:711-747). Section 3 applies the instructed verdict to all seven and flags T12.

---

## Finding 1 — the `component_catalog` gap

`counts.orphans_by_component` records **42** orphan files under the key
`(no component_catalog path matches)` (TRACE.yaml:124-130), enumerated at
`orphans_with_no_component_match` (TRACE.yaml:131-173).

The cause is structural, not accidental. `component_catalog` covers `src/` by **directory** for four
areas — `src/state/`, `src/ui/`, `src/map/`, `src/layers/`, `src/impact/` — but covers
`src/config/`, `src/util/` and `src/types/` only by **individually named files**: `layers.ts`,
`presets.ts`, `clusters.ts`, `palette.ts`, `wildfire-presentation.ts`, `capability-matrix.ts`,
`urls.ts`… no, not `urls.ts` (ROADMAP.yaml:60-67). Seven config files, one util file
(`src/util/fetch.ts`, ROADMAP.yaml:61), one types file (`src/types/layer.ts`, ROADMAP.yaml:61).
Every other file in those three directories falls through, because `serves_component` resolves by
longest path prefix and there is no prefix to match (TRACE.yaml:42-43).

**The sharp edge:** `src/config/urls.ts` is named in `authority.runtime_truth` (ROADMAP.yaml:45) as
one of the seven places the roadmap says runtime truth lives — and it matches no
`component_catalog` path at all (TRACE.yaml:144). It is the second-highest in-degree file in the
entire module graph (45 importers; Section 6). The roadmap's own authority block and its own
component catalog disagree about whether that file exists as a component.

### Proposed catalog entries

Two entries close all 42. Existing exact-path entries are unaffected: longest-prefix wins
(TRACE.yaml:42), so `src/config/palette.ts` keeps `map_and_visualization`, `src/util/fetch.ts` keeps
`state_and_lifecycle`, and `src/types/layer.ts` keeps `state_and_lifecycle`.

**Entry A — `declared_catalogs`**, paths `["src/config/", "src/types/"]`.
Concerns: one declared source of truth per catalog; the endpoint catalog and its boot slice; region,
framing and ocean vocabularies; station and place catalogs; source and region capability
declarations; provenance strings.
Absorbs **23** of the 42 (18 config + 5 types):

| # | file | note |
|---|---|---|
| 1 | `src/config/urls.ts` | named in `authority.runtime_truth`, ROADMAP.yaml:45 |
| 2 | `src/config/urls-boot.ts` | the eager boot slice of the same catalog |
| 3 | `src/config/framings.ts` | |
| 4 | `src/config/framing-shapes.ts` | |
| 5 | `src/config/geography.ts` | |
| 6 | `src/config/interaction-ranks.ts` | |
| 7 | `src/config/layer-groups.ts` | |
| 8 | `src/config/minimap-geometry.ts` | |
| 9 | `src/config/oceans.ts` | |
| 10 | `src/config/provenance.ts` | sovereign-representation strings; plan_rules line 56 depends on it |
| 11 | `src/config/region-capability.ts` | |
| 12 | `src/config/regions.ts` | |
| 13 | `src/config/style-expressions.ts` | |
| 14 | `src/config/landscape-url.ts` | |
| 15 | `src/config/place-catalog.ts` | |
| 16 | `src/config/source-capability.ts` | |
| 17 | `src/config/station-registry.ts` | |
| 18 | `src/config/telemetry.ts` | |
| 19 | `src/types/display-summary.ts` | |
| 20 | `src/types/region.ts` | |
| 21 | `src/types/build-sha.d.ts` | build identity; `release_delivery` concern, no path |
| 22 | `src/types/station-network.ts` | |
| 23 | `src/types/station.ts` | |

`src/types/` goes beyond the prompt's `src/config/**` and `src/util/**`. It is included because
those five files are 5 of the 42 and no other proposed entry reaches them. Splitting `src/types/`
into its own third entry is equally defensible — owner's call.

**Entry B — `shared_utilities`**, paths `["src/util/"]`.
Concerns: pure dependency-light helpers; escaping and normalization; geometry and antimeridian
handling; agency payload adapters; motion and fade primitives; archive probing.
Absorbs **19** of the 42:

`src/util/escape.ts`, `guards.ts`, `motion.ts`, `awdb.ts`, `hydromet.ts`, `usgs.ts`, `cwms.ts`,
`nadm.ts`, `nadm-collection.ts`, `antimeridian.ts`, `bbox.ts`, `point-in-polygon.ts`,
`raster-status.ts`, `frame-stepper.ts`, `layer-fade.ts`, `hatch.ts`, `pmtiles-probe.ts`,
`search-fold.ts`, `clipboard.ts`.

23 + 19 = 42. Six of Entry B's files are agency payload adapters (`awdb`, `hydromet`, `usgs`,
`cwms`, `nadm`, `nadm-collection`) that carry issuer semantics, not generic utility; if the owner
prefers, they route to `data_pipelines` instead and `shared_utilities` absorbs 13.

---

## Finding 2 — the `.github/workflows` blind spot

**No edit guard, and none is possible under the current trace method.** `method.test_roots` reads:
"Resolution covers src/, workers/, scripts/ and public/, excluding node_modules, .wrangler, dist and
.venv" (TRACE.yaml:38-40). `.github/` is not a test root. The trace therefore *could not* have
reported a test reaching a workflow file even if one existed. Every "no tests" verdict on a
workflow-attested task is, in part, a statement about the trace's own resolution scope.

**Confirmed separately:** no test asserts on workflow content. Grepping `tests/` for
`.github/(workflows|actions)` returns three hits, all prose in `tests/README.md:229`,
`tests/README.md:246` and `tests/README.md:316`. No `.spec.ts` or `.test.mjs` file references a
workflow path. (This is the one source read taken this session.)

**The exposure.** Seven done P0 claims rest on workflow files. Six of them rest on nothing else:

| task | files (all under `.github/`) | tests | TRACE |
|---|---|---|---|
| DDM-P0-T01 | `actions/playwright-chromium/action.yml`, `workflows/browser-suite.yml` | 0 | :426 |
| DDM-P0-T02 | `workflows/browser-suite.yml`, `workflows/validate.yml` | 0 | :458 |
| DDM-P0-T04 | `workflows/deploy.yml`, `workflows/verify-live.yml` | 0 | :495 |
| DDM-P0-T06 | `workflows/browser-suite.yml` | 0 | :563 |
| DDM-P0-T07 | `dependabot.yml`, `workflows/deploy.yml`, `workflows/validate.yml` | 0 | :579 |
| DDM-P0-T08 | `workflows/browser-suite.yml`, `workflows/deploy.yml`, `workflows/verify-live.yml` | 0 | :611 |
| DDM-P0-T12 | `workflows/source-health.yml` **+ 2 scripts** | **2** | :703 |

DDM-P0-T12 is the exception that shows the shape of the fix: its scripts
(`scripts/lib/source-health.mjs`, `scripts/source-health.mjs`) live inside a test root, so
`tests/source-health.test.mjs` reaches them by import (TRACE.yaml:736-739). Its *workflow half*
remains as unguarded as the other six.

The blind spot is compounded by the trace's own rejected rule: `rejected_rules[key: ci]` was
discarded for matching area words rather than tasks, and its discarded matches show
`scripts/check-upstream-drift.mjs` would have attached to seven P0 and P15 tasks (TRACE.yaml:204-257).
The replacement rule (`script-name`) requires every distinctive filename token to appear in the task
text, which is why five path-rule attachments survive (TRACE.yaml:174-189) and the workflow files
get none.

### What closes the gap

1. **Add `.github/` to `method.test_roots`** in the next trace run. Until that happens, "0 tests" on
   a workflow-attested task is unfalsifiable, not false.
2. **Add one in-repo guard test** under `tests/` that reads the workflow YAML as text and asserts the
   invariants the six closed sentences already claim: every `uses:` is a 40-hex commit SHA
   (DDM-P0-T07); `DDM_BUILD_SHA` is set in `deploy.yml` (DDM-P0-T04, DDM-P0-T08); artifact upload is
   conditional and `retention-days` is bounded (DDM-P0-T06); the Chromium cache action has separate
   restore and save steps keyed on OS, arch and `@playwright/test` version (DDM-P0-T01). Every one of
   those is already an evidence line the scouts recorded, so the guard writes itself from
   TRACE.yaml:438-444, :450-454, :507-511, :591-595.
   `tests/upstream-drift-contract.test.mjs` and `tests/worker-receipts.test.mjs` already read source
   files as text (TRACE.yaml:547-561), so the pattern exists in the suite.
3. **What the roadmap should say about it.** `component_catalog.release_delivery` lists
   `.github/workflows/` as a path but its `concerns` say nothing about who checks it
   (ROADMAP.yaml:60). `component_catalog.verification` claims "deterministic gate, targeted browser
   tests, serial release suite, live production probes" over `tests/` and two scripts
   (ROADMAP.yaml:66) — the delivery workflows are outside that sentence. The roadmap should state
   plainly that **workflow files are attested by run receipts, not by the repository's own gate**,
   and either accept that (naming the run ids, as DDM-P0-T03 already does) or open a task to add the
   guard. Silence is the current state and it reads as coverage.

---

## 3. Verdict per task

Taxonomy applied: `verified_done` (done, files and tests both present and reaching the closed
sentence), `claimed_not_verified` (done, evidence absent from the trace), `partial` (evidence
present but incomplete or misrouted), `not_started`, `structurally_untestable` (the acceptance
cannot be checked anywhere the trace can see), `verified_externally_only` (attested by a run receipt
outside the repository). Per instruction, the seven workflow-attested P0 claims and DDM-P0-T03 take
`verified_externally_only`.

Superseded tasks receive no verdict: `attachment_guards.rule_3_superseded` makes them ineligible as
attachment targets (TRACE.yaml:24-27), so the trace holds no evidence about them by construction.

### Cross-cutting contradiction found while assigning verdicts

**DDM-P0-T03 is closed on the same event that DDM-P15-T02 is still open for.** T03's closed sentence
says MapLibre 6.6.0 "landed as 993f5ca, and is proven live by deploy 33725341105 and verify-live
33726016220" (ROADMAP.yaml:90-92). T15-T02 remains open, asking that "the manifest, the lockfile,
and the installed tree name the same renderer version… and the gate and the serial suite pass before
it lands" (ROADMAP.yaml:465-472). `decision_gates.DDM-D01.needed_by` lists both, plus DDM-P0-T09,
DDM-P0-T10 and DDM-P9-T04 (ROADMAP.yaml:513); the gate was **decided 2026-09-02**
(ROADMAP.yaml:516-517), yet four of its five dependants are still open. Either T15-T02 is done and
unclosed, or T03 closed early on the same evidence. The trace cannot separate them — both carry
`no-files-no-tests` (TRACE.yaml:492-494, :3728-3730). Unverified which.

### DDM-P0 — Release convergence and platform truth

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P0-T01 | done | `verified_externally_only` | `files` = 2 `.github/` paths, `tests: []`, `coverage: files-no-tests` (TRACE.yaml:426-457); `.github/` outside `method.test_roots` (:38) |
| DDM-P0-T02 | done | `verified_externally_only` | same shape, TRACE.yaml:458-482 |
| DDM-P0-T03 | done | `verified_externally_only` | `files: []`, `tests: []`, `coverage: no-files-no-tests` (TRACE.yaml:492-494). Only evidence is the deploy/verify-live run pair in the closed sentence |
| DDM-P0-T04 | done | `verified_externally_only` | TRACE.yaml:495-524 |
| DDM-P0-T05 | done | **`verified_done`** | 2 files + 3 tests, `files-and-tests` (TRACE.yaml:525-562). Worker source is inside a test root; `tests/worker-receipts.test.mjs:472` reads `workers/proxy/src/index.ts` directly |
| DDM-P0-T06 | done | `verified_externally_only` | TRACE.yaml:563-578 |
| DDM-P0-T07 | done | `verified_externally_only` | TRACE.yaml:579-610 |
| DDM-P0-T08 | done | `verified_externally_only` | TRACE.yaml:611-638 |
| DDM-P0-T09 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:649-651); gate DDM-D01 decided, task untouched |
| DDM-P0-T10 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:662-664) |
| DDM-P0-T11 | open | `partial` | `capability-matrix.ts` + `types/capability-matrix.ts`, 1 test (TRACE.yaml:673-702). Covers the capability half; nothing reaches "deployed build, source commit, and public documentation agree" |
| DDM-P0-T12 | done | `verified_externally_only` *(instructed)* | **Dissent noted:** `coverage: files-and-tests` with 2 real tests (TRACE.yaml:735-744). The workflow half is externally attested; the script half is `verified_done`. Reads more honestly as `partial` |

### DDM-P1 — Network lifecycle and failure honesty

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P1-T01 | open | `partial` | 1 file, 3 tests; `src/util/fetch.ts` `acceptance_testable_here: true` (TRACE.yaml:757-782). No evidence for the "static check catches a header-only fetch" half |
| DDM-P1-T02 | open | `partial` | 8 files, 37 tests (TRACE.yaml:791-1043). Five of eight files carry `acceptance_testable_here: false`; most test links are `via: selector` on one comment line, `src/state/layer-controller.ts:89`, which `caveat_selector` calls the weakest signal (TRACE.yaml:47) |
| DDM-P1-T03 | open | `partial` | 2 files, 30 tests, same selector inflation (TRACE.yaml:1052-1213) |
| DDM-P1-T04 | open | `partial` | 5 files, 19 tests (TRACE.yaml:1222-1371). Four of five files `acceptance_testable_here: false` |
| DDM-P1-T05 | open | `partial` | `src/config/layers.ts` + 9 tests (TRACE.yaml:1380-1432). Acceptance is a *typecheck* claim; no test can prove a compile error |
| DDM-P1-T06 | open | `partial` | `coverage: files-and-tests-but-acceptance-not-directly-testable` (TRACE.yaml:1461) |
| DDM-P1-T07 | open | `partial` | 1 path-rule file, 1 path-ref test, 7 scripts (TRACE.yaml:1470-1492) |
| DDM-P1-T08 | done | **`partial`** | Attached only `src/config/layers.ts` with 9 generic tests (TRACE.yaml:1501-1551) — **none of them the boundary-stub test**. `tests/boundary-stubs.spec.ts` and `tests/boundary-boot-inventory.test.mjs` exist and are listed under DDM-P1-T02 covering `src/layers/aiannh.ts` (TRACE.yaml:865-873). Evidence is real but routed to the wrong task |

### DDM-P2 — Cross-view interaction coherence

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P2-T01 | superseded → DDM-P10-T01 | *(no verdict)* | rule_3_superseded, TRACE.yaml:24 |
| DDM-P2-T02 | done | `verified_done` | 1 file, 3 tests incl. `tests/fire3d-mode.spec.ts` by import (TRACE.yaml:1583-1595); closed sentence names that spec and `tests/view-contracts.yaml`, and `DDM-D03.posture` corroborates (ROADMAP.yaml:537) |
| DDM-P2-T03 | open | `partial` | `src/layers/sst-anomaly.ts`, `tests: []`, `coverage: files-no-tests` (TRACE.yaml:1616-1617) |
| DDM-P2-T04 | open | `partial` | `files-and-tests-but-acceptance-not-directly-testable` (TRACE.yaml:1663) |
| DDM-P2-T05 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:1673-1675); also `dependencies: [DDM-P10-T01]`, which is itself open |
| DDM-P2-T06 | open | **`structurally_untestable`** | `no-files-no-tests` (TRACE.yaml:1685-1687); acceptance requires review "outside emulation on iOS, Android, tablet, and a small iframe" — no repository artifact can satisfy it |

### DDM-P3 — Fire evidence pilots (all title-only; see Section 7)

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P3-T01 | superseded → DDM-P8-T03 | *(no verdict)* | TRACE.yaml:1691-1693 |
| DDM-P3-T02 | open | `not_started` | `no-files-no-tests`. **A scout did attach `src/ui/landscape-context.ts` and it was withheld** by `rule_1_no_statement` because the task states neither acceptance nor closed (`flagged_attachments`, TRACE.yaml:190-200) |
| DDM-P3-T03 | open | `not_started` | TRACE.yaml:1714-1716 |
| DDM-P3-T04 | open | `not_started` | TRACE.yaml:1725-1727 |
| DDM-P3-T05 | open | `not_started` | TRACE.yaml:1736-1738 |
| DDM-P3-T06 | open | `not_started` | TRACE.yaml:1745-1747 |
| DDM-P3-T07 | open | `not_started` | TRACE.yaml:1754-1756 |

### DDM-P4 — ENSO observed-state product

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P4-T01 | open | `not_started` | `no-files-no-tests`, title-only (TRACE.yaml:1765-1767) |
| DDM-P4-T02 | open | `not_started` | TRACE.yaml:1774-1776 |
| DDM-P4-T03 | superseded → DDM-P12-T03 | *(no verdict)* | TRACE.yaml:1781-1783 |
| DDM-P4-T04 | open | `not_started` | TRACE.yaml:1792-1794 |
| DDM-P4-T05 | open | `not_started` | TRACE.yaml:1803-1805. Gate DDM-D06 decided issuer-published-only (ROADMAP.yaml:550-551); the task is the tombstone, not the work |
| DDM-P4-T06 | superseded → DDM-P12-T02 | *(no verdict)* | TRACE.yaml:1810-1812 |

### DDM-P5 — Smoke altitude and volume research (all title-only)

DDM-P5-T01 … DDM-P5-T07: all `not_started`, all `no-files-no-tests`, TRACE.yaml:1823-1881.

### DDM-P6 — Field capability, coverage, and release readiness

DDM-P6-T01 … T04 and T06: all `not_started`, `no-files-no-tests`, TRACE.yaml:1889-1938.
DDM-P6-T05 superseded → DDM-P15-T01, *(no verdict)*, TRACE.yaml:1924-1925.

### DDM-P7 — Impact Briefing

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P7-T01 | done | `verified_done` | 7 files, 12 tests, `files-and-tests` (TRACE.yaml:1947-2066); six of seven files `acceptance_testable_here: true` |
| DDM-P7-T02 | open | `partial` | 7 files, 12 tests (TRACE.yaml:2077-2193) |
| DDM-P7-T03 | open | `partial` | 3 files, 5 tests (TRACE.yaml:2204-2248) |
| DDM-P7-T04 | open | `partial` | 6 files, 7 tests (TRACE.yaml:2259-2340) |
| DDM-P7-T05 | open | `partial` | 8 files, 8 tests (TRACE.yaml:2351-2454) |
| DDM-P7-T06 | open | `partial` | 3 files, 5 tests (TRACE.yaml:2465-2509) |

T02 through T06 share `src/impact/hydrate.ts`, `src/impact/sources.ts` and
`src/ui/impact-panel-runtime.ts`. That shared triple is why the whole phase collapses into one
cycle in Section 6.

### DDM-P8 — Forecast uniformity and time controls

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P8-T01 | done | `verified_done` | 3 files, 8 tests incl. `tests/temporal-axis.spec.ts` by path-ref (TRACE.yaml:2518-2581) |
| DDM-P8-T02 | open | `partial` | 4 files, 7 tests (TRACE.yaml:2590-2652) |
| DDM-P8-T03 | open | `partial` | 2 files, 6 tests (TRACE.yaml:2664-2709) |
| DDM-P8-T04 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:2719-2721) |
| DDM-P8-T05 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:2730-2732) |
| DDM-P8-T06 | open | `partial` | `files-and-tests-but-acceptance-not-directly-testable` (TRACE.yaml:2756) |

### DDM-P9 — Fire module and 3D

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P9-T01 | done | **`claimed_not_verified`** | `files: []`, `tests: []` (TRACE.yaml:2765-2767). Section 4 |
| DDM-P9-T02 | open | `partial` | 2 files, 2 tests; `src/map/gl-capability.ts` `acceptance_testable_here: true` (TRACE.yaml:2777-2809) |
| DDM-P9-T03 | open | `partial` | 4 files, 6 tests (TRACE.yaml:2819-2878) |
| DDM-P9-T04 | open | `partial` | `files-and-tests-but-acceptance-not-directly-testable` (TRACE.yaml:2903) |
| DDM-P9-T05 | open | `partial` | 1 file, 1 path-ref test (TRACE.yaml:2912-2928) |

### DDM-P10 — Interface balance and motion

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P10-T01 | open | `partial` | `src/config/clusters.ts` + 8 tests (TRACE.yaml:2937-2985). **Note the mismatch:** acceptance is about pixel widths and touch targets; the attached file is a hazard-cluster recipe table. The scout attached a plausible file to an unrelated acceptance |
| DDM-P10-T02 | done | **`verified_done`** *(2026-09-07, TRACE v3)* | Was `structurally_untestable`: `files: []`, `tests: []` (TRACE v2, TRACE.yaml:2994-2996), because `src/styles/app.css` was never scouted (`files_scouted: 196`, neither orphan list). Fixed same day: `trace_version` moved 2 to 3, `method.files_defect_2026-09-07` records the omission, and the styles cluster scout attaches `src/styles/app.css` to this task with `acceptance_testable_here: true` and evidence for four of five closed-sentence clauses (z-index tokens `app.css:141-163`, motion tokens `app.css:165-184`, spinner keyframe `app.css:4268-4279`, ocean-door touch floor `app.css:6169-6186`, muted-foreground token `app.css:59-67`), plus 16 selector-linked tests from `tests.json`. `coverage: files-and-tests`. Section 4 |
| DDM-P10-T03 | open | **`structurally_untestable`** | `no-files-no-tests` (TRACE.yaml:3006-3008); acceptance is a stylesheet property ("every animated rule has a reduced-motion counterpart") and the stylesheet is outside the trace |
| DDM-P10-T04 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3019-3021); acceptance is also unfalsifiable as written (Section 7) |

### DDM-P11 — Minimap and popups

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P11-T01 | open | `partial` | 4 files, 8 tests, all four `acceptance_testable_here: true` (TRACE.yaml:3034-3110). Best-evidenced open task in the backlog |
| DDM-P11-T02 | open | `partial` | `files-and-tests-but-acceptance-not-directly-testable` (TRACE.yaml:3183); both files `acceptance_testable_here: false` |

### DDM-P12 — ENSO and marine

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P12-T01 | done | **`claimed_not_verified`** | 1 file (`src/impact/enso.ts`), `tests: []`, `coverage: files-no-tests` (TRACE.yaml:3197-3207). Section 4 |
| DDM-P12-T02 | open | `partial` | same single file, no tests (TRACE.yaml:3219-3226) |
| DDM-P12-T03 | open | `partial` | same single file, no tests (TRACE.yaml:3237-3244) |
| DDM-P12-T04 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3255-3257) |

`src/impact/enso.ts` is the sole attached file for three tasks and carries zero tests in the trace,
while `tests/enso-observed-state.spec.ts` and `tests/enso-plume-omission.spec.ts` both exist and are
linked elsewhere by selector (TRACE.yaml:2016-2025). This is the `caveat_e2e` case: "some playwright
specs drive the DOM and import nothing" (TRACE.yaml:51-52).

### DDM-P13 — Science defensibility and citations

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P13-T01 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3269-3271) |
| DDM-P13-T02 | open | `partial` | 2 files, 3 tests, both files `acceptance_testable_here: true` (TRACE.yaml:3281-3310) |
| DDM-P13-T03 | open | `partial` | `src/layers/gridded-index.ts`, `tests: []` (TRACE.yaml:3320-3331) |

### DDM-P14 — Boot, architecture, and performance

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P14-T01 | done | `verified_done` | 3 files, 21 tests; `tests/heat-h2-point-heat.spec.ts` imports `src/util/bounded-cache.ts` directly (TRACE.yaml:3386-3389) |
| DDM-P14-T02 | open | `partial` | 3 files, 9 tests; `tests/boot-without-map.spec.ts` reaches `src/ui/renderer-notice.ts` (TRACE.yaml:3505-3508) |
| DDM-P14-T03 | open | `partial` | `src/state/url.ts` + 28 tests (TRACE.yaml:3554-3689). Acceptance is a **bundle-size budget**; not one of the 28 tests measures bytes. `component_catalog.verification` names `scripts/check-bundle-size.mjs` (ROADMAP.yaml:66) and the trace attaches it to nothing |
| DDM-P14-T04 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3700-3702) |

### DDM-P15 — Platform

| task | status | verdict | deciding TRACE evidence |
|---|---|---|---|
| DDM-P15-T01 | open | **`structurally_untestable`** | `no-files-no-tests` (TRACE.yaml:3713-3715); acceptance is "the hosting plan states…", a documentation state with `verification: verify:quick` |
| DDM-P15-T02 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3728-3730). See the cross-cutting contradiction above |
| DDM-P15-T03 | done | **`claimed_not_verified`** | `files: []`, `tests: []` (TRACE.yaml:3739-3741). Section 4 |
| DDM-P15-T04 | open | `not_started` | `no-files-no-tests` (TRACE.yaml:3751-3753) |

### Verdict tally

| verdict | count | which |
|---|---|---|
| `verified_done` | 6 | P0-T05, P2-T02, P7-T01, P8-T01, P14-T01, **P10-T02** *(moved 2026-09-07, TRACE v3)* |
| `verified_externally_only` | 8 | P0-T01, T02, T03, T04, T06, T07, T08, T12 |
| `claimed_not_verified` | 3 | P9-T01, P12-T01, P15-T03 |
| `partial` | 27 | P1-T08 (done) + 26 open |
| `not_started` | 38 | includes all 22 title-only stubs |
| `structurally_untestable` | 3 | P2-T06, P10-T03, P15-T01 |
| *(no verdict — superseded)* | 5 | P2-T01, P3-T01, P4-T03, P4-T06, P6-T05 |

Total 90 (6 + 8 + 3 + 27 + 38 + 3 + 5). Split by status: 18 done, 67 open, 5 superseded.

**Of the 18 done claims: 6 are verified in-repo, 8 are attested only outside the repository, 3 are
unverified, and 1 is partial (P1-T08, evidence misrouted).** Put another way, exactly a third of the
done claims are provable from the tree — up from just over a quarter before the 2026-09-07
styles-cluster fix moved P10-T02 out of `structurally_untestable`.

---

## 4. The four non-P0 done-claims, individually

### DDM-P9-T01 — "Correct the 3D control vocabulary, pitch ceiling, and station ranking"

**What the closed sentence claims** (ROADMAP.yaml:306): three separate corrections — the 3D control
"speaks the six honest layer states"; "the pitch ceiling and coordinate destructuring are
corrected"; "nearest stations carry a distance ceiling and an honest absence".

**What in the tree would prove it.** All three targets exist and are visible to the trace:

- *Six honest layer states* → `src/ui/island/pill-text.ts`, which "resolves the six canonical layer
  status texts (loading, live, live (partial), unavailable, no data, zoom in to load)"
  (TRACE.yaml:4588-4591), consumed by `src/ui/island/fire3d-control.tsx` (TRACE.yaml:1638-1652).
  `pill-text.ts` carries four tests.
- *Pitch ceiling* → `src/config/fire3d-presentation.ts`, which "Holds all tuning constants… camera
  pitch" (TRACE.yaml:1573-1581) and is attached with three tests to DDM-P2-T02.
- *Nearest stations, distance ceiling* → `src/impact/fire-context.ts`, "nearest telemetry stations"
  (TRACE.yaml:2820-2822), and `src/config/station-registry.ts` (TRACE.yaml:4880-4883).

**Should the claim stand?** Yes — but not on this evidence. Every proving file exists and three of
them carry tests; the trace simply routed none of them here. `rule_1_no_statement` did **not** block
it: the guard exempts "a done task closing on a `closed` sentence" (TRACE.yaml:21-22), and no entry
for DDM-P9-T01 appears in `flagged_attachments` (TRACE.yaml:190-200). This is scout
under-attachment, not a structural block. **Keep the claim; add an `evidence:` list naming the four
files.** A reader auditing the roadmap today has no path from the sentence to the code.

### DDM-P10-T02 — "Land the token layers the design had none of"

**What the closed sentence claims** (ROADMAP.yaml:344-345): motion and z-index tokens declared; the
briefing spinner keyframe added; two dead rules removed; minimap ocean doors reach the touch floor;
the muted foreground token raised — followed by an admission: "it clears 4.5:1 on three of the four
backgrounds; **the fourth remains open**".

**What in the tree would prove it.** `src/styles/app.css` and nothing else. Four of the five clauses
are literally CSS declarations. The catalog names that file under `interface` (ROADMAP.yaml:62), and
it appears **nowhere in TRACE.yaml** — not in `files_scouted: 196` (TRACE.yaml:120), not in
`orphan_files_with_test_coverage`, not in `orphan_files_without_test_coverage`. Its only trace
appearance is inside a code comment quoted as evidence for a different file
(`src/ui/island/minimap.tsx:227`, TRACE.yaml:3077-3078). The whole stylesheet is invisible to the
method.

**Should the claim stand?** **Not as written.** Two independent problems:

1. It is `structurally_untestable` under this trace, and will stay so until the scouts read
   `src/styles/app.css` or a contrast/token test is added.
2. **A done claim carries an unfinished clause.** "the fourth remains open" is scope that is not
   done, closed inside a `closed:` sentence, tracked by nothing. That residue needs its own open
   task — the contrast floor also appears in DDM-P10-T04's acceptance ("every control boundary and
   text size meets its contrast and legibility floor", ROADMAP.yaml:357), so it may already be
   absorbed there, but the roadmap does not say so.

**Recommendation:** keep `status: done` for the four completed clauses, strip the parenthetical, and
name the fourth-background contrast residue explicitly as a dependency of DDM-P10-T04.

### DDM-P12-T01 — "Lead the ENSO headline with advisory semantics"

**What the closed sentence claims** (ROADMAP.yaml:385): shipped in `46f98f4` (PR 57); the headline
states current conditions by CPC onset and advisory rules with citations; the episode classification
is secondary and labeled; **"the snapshot validator enforces the contract"**. It further records
that "The DR-032 state panel was never part of this acceptance; it stays parked in the register" —
a clean, well-scoped closure note.

**What in the tree would prove it.** Unlike P9-T01, this task *has* a file:
`src/impact/enso.ts`, whose evidence lines quote "Three CPC rules, three answers (2026-09-02, report
13 ENSOSCI-01)" (TRACE.yaml:3202-3204). That is a direct textual match to the closed sentence and it
is `acceptance_testable_here: true`. What is missing is the *validator*: a snapshot validator would
live in `scripts/` or `tests/`, and the trace attaches neither. The `rejected_rules[key: pipeline]`
block shows the trace **considered and discarded** attaching twelve `scripts/` files to this exact
task, including `scripts/validate-landscape-artifact.mjs` (TRACE.yaml:388-404) — a rejection that is
correct in method (those are landscape scripts, not ENSO) but leaves the validator unnamed.
Separately, `tests/enso-observed-state.spec.ts` and `tests/enso-plume-omission.spec.ts` exist in the
suite (TRACE.yaml:2016-2025) and no link reaches `enso.ts`.

**Should the claim stand?** **Yes.** This is the strongest of the four: a real commit, a real PR, a
file whose header text matches the claim clause by clause, and a scoped exclusion of DR-032. The
gap is naming, not substance. **Add `evidence:` naming `src/impact/enso.ts` and the validator's
actual path**, and add an import-level assertion to one of the two existing ENSO specs so the
`files-no-tests` reading stops being true. Note that the same file is the sole evidence for two
still-open tasks (P12-T02, P12-T03) — one uncovered file is carrying a done claim and two open ones.

### DDM-P15-T03 — "Quiet and stabilize the delivery workflows"

**What the closed sentence claims** (ROADMAP.yaml:476-477): four things — the live embed-corner proof
matches the shipped credits surface; the live-build resolver retries and ends green on an API
outage; build-tier drift stops failing on a non-proving probe; the unreachable light path is gone.

**What in the tree would prove it.** Every clause maps to a file the trace can see or names:

- *embed-corner proof, live-build resolver* → `.github/workflows/verify-live.yml`, whose evidence
  lines include `:649 --expect-nonce $DEPLOY_RUN_NONCES` and `:704 Keep the receipt`
  (TRACE.yaml:517-521), plus `scripts/lib/live-receipts.mjs`.
- *build-tier drift on a non-proving probe* → `.github/workflows/upstream-monitor.yml`, "Scheduled
  upstream liveness probe with **tiered failure handling that distinguishes runtime-blocking drift
  from build-tier and candidate warnings**" (TRACE.yaml:4844-4846) — a clause-for-clause match — and
  `scripts/check-upstream-drift.mjs`, which has a real test,
  `tests/upstream-drift-contract.test.mjs` (TRACE.yaml:547-551).

**Should the claim stand?** **Yes, but the roadmap is actively hiding its own evidence.** The trace
did not merely fail to find these — it found them and threw them away twice:
`rejected_rules[key: ci]` lists `scripts/check-upstream-drift.mjs → DDM-P15-T03` as a discarded
match (TRACE.yaml:252-257), and `rejected_rules[key: pipeline]` lists twelve scripts for the same
task (TRACE.yaml:405-421). Both rejections are methodologically right (they matched area words), and
both point at the same real file. The replacement `script-name` rule requires every distinctive
filename token in the task text — the task text says "delivery workflows", so `check-upstream-drift`
never matches. **Keep the claim; name `verify-live.yml` and `upstream-monitor.yml` in an `evidence:`
key**, which simultaneously closes Section 8's first half.

---

## 5. Orphan files without test coverage, ranked by in-degree

In-degree computed from `.planning/trace/imports.json` (production resolution via
`.planning/trace/vite.trace.config.ts`, vite 8.1.3 / rolldown 1.1.4, TRACE.yaml:7-8). "Gates" =
an **open DDM-P1 / P7 / P8** task has an attached file that directly imports this orphan; those are
the regression risks the roster must gate. "Any open" = the same over all open tasks.

The five zero-in-degree rows at the bottom are not unused: two are workflow files, which carry no
module edges at all, and three are type-only modules erased before bundling — `caveat_type_only`
(TRACE.yaml:50). Their in-degree is a method artifact, not a fact about the code.

| # | in-deg | file | gated by open P1/P7/P8 | any open task |
|---|---|---|---|---|
| **1** | **24** | `src/util/escape.ts` | **P1-T02, P1-T04, P1-T06, P7-T02, P7-T03, P7-T04, P7-T05, P7-T06, P8-T02, P8-T03, P8-T06** | +P13-T02, P13-T03, P9-T03, P9-T05 |
| **2** | **17** | `src/util/guards.ts` | **P7-T02, P7-T03, P7-T04, P7-T05, P7-T06, P8-T02** | +P12-T02, P12-T03, P13-T03, P9-T03, P9-T04 |
| **3** | **10** | `src/ui/overlay.ts` | **P1-T02, P1-T03, P1-T04** | +P2-T03 |
| **4** | **10** | `src/util/motion.ts` | **P1-T04, P1-T06** | +P11-T01, P2-T03, P9-T03 |
| **5** | 5 | `src/state/map-store.ts` | **P7-T02…T06** | +P14-T02 |
| **6** | 4 | `src/state/region-store.ts` | **P1-T04, P7-T04, P8-T06** | — |
| 7 | 4 | `src/ui/tribal-nations-action.ts` | — | — |
| 8 | 4 | `src/util/pmtiles-probe.ts` | — | P9-T04 |
| 9 | 3 | `src/config/station-registry.ts` | — | P9-T03, P9-T05 |
| **10** | 3 | `src/ui/search-controller.ts` | **P1-T04** | — |
| **11** | 3 | `src/util/awdb.ts` | **P1-T04** | +P9-T05 |
| 12 | 3 | `src/util/search-fold.ts` | — | — |
| 13 | 2 | `src/config/landscape-url.ts` | — | — |
| 14 | 2 | `src/config/source-capability.ts` | — | — |
| **15** | 2 | `src/config/telemetry.ts` | **P1-T04** | — |
| **16** | 2 | `src/layers/ecoregions.ts` | **P1-T05** | — |
| **17** | 2 | `src/ui/island/popover-discipline.ts` | **P1-T04** | — |
| **18** | 2 | `src/ui/map-control-seat.ts` | **P8-T03** | — |
| **19** | 2 | `src/util/frame-stepper.ts` | **P7-T04, P8-T06** | +P2-T03 |
| **20** | 2 | `src/util/hydromet.ts` | **P1-T04** | +P9-T05 |
| **21** | 2 | `src/util/layer-fade.ts` | **P1-T02, P1-T03** | — |
| **22** | 2 | `src/util/usgs.ts` | **P1-T04** | +P9-T05 |
| 23 | 1 | `src/config/place-catalog.ts` | — | — |
| **24** | 1 | `src/impact/category-impacts.ts` | **P7-T02…T06** | +P9-T03 |
| **25** | 1 | `src/impact/resource-catalog.ts` | **P7-T02…T06** | — |
| **26** | 1 | `src/layers/bc-drought.ts` | **P7-T04, P8-T06** | — |
| **27** | 1 | `src/layers/cdm-drought.ts` | **P1-T05** | — |
| 28 | 1 | `src/layers/hms-smoke-volume.ts` | — | — |
| **29** | 1 | `src/layers/places.ts` | **P1-T05** | — |
| **30** | 1 | `src/layers/states.ts` | **P1-T05** | — |
| 31 | 1 | `src/layers/structures-3d.ts` | — | — |
| 32 | 1 | `src/layers/whp-3d.ts` | — | — |
| 33 | 1 | `src/map/init.ts` | — | P14-T02 |
| 34 | 1 | `src/state/display-snapshot.ts` | — | — |
| 35 | 1 | `src/state/watershed-geometry.ts` | — | — |
| 36 | 1 | `src/ui/impact-panel-runtime-primary.ts` | — | — |
| 37 | 1 | `src/ui/impact-panel-runtime-recovery.ts` | — | — |
| **38** | 1 | `src/ui/island/panel-response.tsx` | **P1-T04** | — |
| 39 | 1 | `src/ui/sheet-alerts.ts` | — | — |
| 40 | 1 | `src/util/clipboard.ts` | — | — |
| **41** | 1 | `src/util/hatch.ts` | **P7-T04, P8-T02** | — |
| 42 | 1 | `src/util/nadm.ts` | — | P11-T01 |
| 43 | 0† | `.github/workflows/refresh-snapshots.yml` | — | — |
| 44 | 0† | `.github/workflows/upstream-monitor.yml` | — | — |
| 45 | 0‡ | `src/types/build-sha.d.ts` | — | — |
| 46 | 0‡ | `src/types/station-network.ts` | — | — |
| 47 | 0‡ | `src/types/station.ts` | — | — |

† not a module; carries no edges. ‡ type-only, erased before bundling (`caveat_type_only`).

**26 of the 47 are gated by an open P1/P7/P8 task.** The roster must gate those before touching the
importing task. Four deserve singling out:

- **`src/util/escape.ts` (24 importers, 11 gating tasks)** — HTML-safe escaping for
  "user-controlled and third-party strings interpolated into HTML attributes and text content"
  (TRACE.yaml:5138-5141). Untested, and it is the single highest-in-degree file in the entire graph
  that is not attached to any task. Every one of the 24 importers renders agency-supplied strings.
  This is the top regression risk in the repository and it should be the roster's first gate.
- **`src/util/guards.ts` (17 importers, 6 gating tasks)** — "Type-narrowing guards for defensive JSON
  payload validation across impact sources and popup modules" (TRACE.yaml:5154-5156). It is the
  validation floor beneath every DDM-P7 briefing source.
- **`src/ui/overlay.ts` (10, 3 gating)** — loading and toast state, imported by
  `src/state/layer-controller.ts`. DDM-P1-T03's acceptance requires "the unavailable state visible
  and **announced once**"; the announcing surface is this untested file.
- **`src/util/motion.ts` (10, 2 gating)** — the shared `prefers-reduced-motion` check. DDM-P10-T03's
  acceptance ("every animated rule has a reduced-motion counterpart") depends on it, and P10-T03 is
  already `structurally_untestable` for the CSS half. Both halves of that task are currently
  unverifiable.

---

## 6. Proposed dependency order for the 67 open tasks

Edges are **direct import edges only**: task A depends on task B when a file attached to A imports a
file attached to B, in `imports.json`. Two exclusions, both required to get a usable graph:

1. **The top ten hub files are excluded from edge formation**, per the brief. Without this, every
   task depends on every other through `urls.ts` and the fetch layer.
2. **Shared-file edges are dropped.** When the importing file is attached to *both* A and B, the
   edge carries no direction. Without this, DDM-P7-T02…T06 form a complete mutual clique purely
   because they share `hydrate.ts`, `sources.ts` and `impact-panel-runtime.ts`.

### Top ten hub files (excluded from ordering)

| rank | in-degree | file | catalog component |
|---|---|---|---|
| 1 | 46 | `src/util/fetch.ts` | `state_and_lifecycle` (ROADMAP.yaml:61) |
| 2 | 45 | `src/config/urls.ts` | **none** — Finding 1 |
| 3 | 41 | `src/state/registry.ts` | `state_and_lifecycle` |
| 4 | 27 | `src/config/palette.ts` | `map_and_visualization` |
| 5 | 24 | `src/util/escape.ts` | **none** — Finding 1; untested, Section 5 |
| 6 | 20 | `src/map/interaction-coordinator.ts` | `map_and_visualization` |
| 7 | 18 | `src/ui/legend-registry.ts` | `interface` |
| 8 | 17 | `src/config/layers.ts` | `state_and_lifecycle` |
| 9 | 17 | `src/util/guards.ts` | **none** — Finding 1; untested, Section 5 |
| 10 | 12 | `src/config/wildfire-presentation.ts` | `map_and_visualization` |

The brief named `urls.ts` and `app.css` as the offenders. `urls.ts` is confirmed at rank 2.
**`src/styles/app.css` is not in the module graph at all** — it appears nowhere in TRACE.yaml
(Section 4, DDM-P10-T02). Its true hub status is *unverified*; a stylesheet import graph would be a
separate artifact from `imports.json`.

Next ten, for the owner's judgement on where to draw the line: `src/impact/context.ts` (10),
`src/state/place-selection.ts` (10), `src/ui/overlay.ts` (10), `src/util/motion.ts` (10),
`src/map/layer-order.ts` (9), `src/state/cluster-service.ts` (9), `src/state/timeline.ts` (9),
`src/ui/island/bridge.ts` (9), `src/ui/layer-toggle-command.ts` (9), `src/ui/popups.ts` (9).
Three of those four ten-degree files are themselves untested orphans.

### The 19 surviving task edges

```
DDM-P1-T02  <- P1-T04, P9-T05
DDM-P1-T04  <- P1-T02, P1-T03, P2-T04, P7-T02, P8-T02, P8-T03,
               P9-T02, P10-T01, P11-T01, P11-T02, P14-T03
DDM-P2-T03  <- P8-T02, P8-T03
DDM-P7-T02  <- P1-T02, P1-T04, P8-T02, P8-T03, P10-T01, P12-T02, P12-T03, P13-T02
DDM-P7-T03  <- P8-T02, P12-T02, P12-T03, P13-T02
DDM-P7-T04  <- P1-T02, P7-T02, P8-T02, P8-T03, P12-T02, P12-T03, P13-T02
DDM-P7-T05  <- P12-T02, P12-T03, P13-T02
DDM-P7-T06  <- P8-T02, P12-T02, P12-T03, P13-T02
DDM-P8-T02  <- P1-T02, P7-T02, P8-T03, P14-T03
DDM-P8-T03  <- P2-T04, P7-T05, P8-T02
DDM-P8-T06  <- P1-T02, P7-T02, P8-T02, P8-T03
DDM-P9-T03  <- P8-T02, P13-T02
DDM-P9-T05  <- P7-T02, P13-T02
DDM-P11-T01 <- P7-T02, P12-T02, P12-T03
DDM-P12-T02 <- P7-T02, P13-T02
DDM-P12-T03 <- P7-T02, P13-T02
DDM-P13-T03 <- P14-T03
DDM-P14-T02 <- P1-T04, P8-T03, P9-T02, P14-T03
DDM-P14-T03 <- P7-T02, P8-T03, P10-T01
```

### Proposed order

**Wave 1 — 48 tasks, no inbound import dependency.** Orderable by owner priority, not by the graph.

`P0-T09, P0-T10, P0-T11, P1-T01, P1-T03, P1-T05, P1-T06, P1-T07, P2-T04, P2-T05, P2-T06, P3-T02,
P3-T03, P3-T04, P3-T05, P3-T06, P3-T07, P4-T01, P4-T02, P4-T04, P4-T05, P5-T01…P5-T07,
P6-T01…P6-T04, P6-T06, P8-T04, P8-T05, P9-T02, P9-T04, P10-T01, P10-T03, P10-T04, P11-T02,
P12-T04, P13-T01, P13-T02, P14-T04, P15-T01, P15-T02, P15-T04`

Six of these are load-bearing for Wave 2 and should be sequenced **first within the wave**:
**P13-T02, P10-T01, P2-T04, P9-T02, P11-T02, P1-T03**.

**Wave 2 — one irreducible cycle of 11 tasks.** These form a single strongly-connected component;
no import evidence orders them internally, and no amount of hub exclusion breaks it.

> **{ P1-T02, P1-T04, P7-T02, P7-T05, P8-T02, P8-T03, P11-T01, P12-T02, P12-T03, P14-T03, P9-T05 }**

The cycle is real, not an artifact. `P7-T02 ↔ P8-T02 ↔ P8-T03` circulate through the briefing and
time-bar modules; `P12-T02/T03 → P7-T02 → P12-T02` circulate through `src/impact/enso.ts`, the
single file all three name; `P1-T02 ↔ P1-T04` circulate through the sidebar/island seam. **This
cluster is one work item, or the owner cuts it by hand.** The natural cut is `src/impact/enso.ts`:
it is the sole attached file for P12-T01 (done), P12-T02 and P12-T03, and separating the ENSO
horizons from the briefing composer would drop three tasks out of the cycle.

**Wave 3 — 8 tasks, strictly downstream of Wave 2.**

`P2-T03, P7-T03, P7-T04, P7-T06, P8-T06, P9-T03, P13-T03, P14-T02`

**Honesty note.** 42 of the 67 open tasks have no import edge in either direction — 22 of those are
the title-only stubs with no acceptance to attach files to (`rule_1_no_statement`, TRACE.yaml:19-22),
and most of the rest have no files at all. **This ordering therefore governs 25 tasks, not 67.** For
the other 42 the trace is silent, and no import-derived order exists.

---

## 7. Acceptance sentences that cannot be verified as written

Twelve individual sentences, plus the 22 stubs as one item. Rewrites are one line each and change no
scope.

**A. Self-satisfying disjunctions — the acceptance passes either way**

| task | problem | rewrite |
|---|---|---|
| DDM-P0-T09 (ROADMAP.yaml:110) | "…are each verified after the change, **or** the decline records the measured reason" — the second branch is satisfied by writing a paragraph; also "are verified" defines verification as verification | Split into two outcomes: **"Globe projection is either shipped with terrain, Fire 3D, URL, embed, phone, tablet, desktop and reduced-motion cases each under a named test, or DDM-D01 records a dated decline naming the measured cost, and no current capability is removed either way."** |
| DDM-P0-T10 (ROADMAP.yaml:114) | same disjunction | **"The GIBS layer either ships carrying its own status, timestamp, qualification and legend and asserting no fire detection or drought assessment, or DDM-D01 records a dated decline naming the measured source, performance or product reason."** |
| DDM-P14-T03 (ROADMAP.yaml:447) | "The entry chunk sits inside its declared budget with the budget unchanged, **or** the budget moves in a recorded decision" — raising the budget always passes | **"`scripts/check-bundle-size.mjs` passes against the budget recorded in the tree at the start of this task; if the budget changes, the diff names the byte delta and the module that caused it."** (This also gives the task a file — see Section 3, P14-T03 has 28 tests and none measures bytes.) |

**B. Process rules dressed as state assertions — nothing about the tree can falsify them**

| task | problem | rewrite |
|---|---|---|
| DDM-P1-T06 (ROADMAP.yaml:144) | "no scope change is made without a measured transfer and record-count benefit" — a rule for the author, not a property of the result | **"Outside the current request never renders as no data, and the scope change is accompanied by a recorded before/after transfer and record count."** |
| DDM-P1-T07 (ROADMAP.yaml:147) | "any fixture or public-artifact change is explicit and source-qualified" — "explicit" is unfalsifiable | **"`scripts/validate-landscape-artifact.mjs` rejects a mosaic whose coverage is phased or incomplete, and every fixture in the tree carries its source and edition in the file."** |
| DDM-P2-T05 (ROADMAP.yaml:172) | "…are verified with keyboard, screen reader, reduced motion, high contrast, and safe-area cases represented" — "represented" sets no bar | **"Each of the seven tasks has at least one test for keyboard operation and one for reduced motion, and the high-contrast and safe-area cases are each named by a test or recorded as declined."** |
| DDM-P2-T06 (ROADMAP.yaml:176) | "every finding is filed or accepted with evidence" — process; also structurally untestable (real devices) | **"A dated field-pass record names the four device classes exercised and lists every finding as filed with an id or accepted with a reason."** Keep it explicitly outside the automated gate. |
| DDM-P15-T01 (ROADMAP.yaml:462) | "no hosting change is made without range, cache, privacy, cost, and rollback evidence" — governs a future action | **"`docs/` states that GitHub Pages is the interim static host, names each seam a local server would replace, and lists the five evidence classes any hosting change must supply."** (`verification: verify:quick` cannot check prose; note that.) |
| DDM-P15-T02 (ROADMAP.yaml:470) | "the gate and the serial suite pass **before it lands**" — a temporal claim about a past event, unverifiable from a tree | **"`package.json`, `package-lock.json` and the installed tree name the same MapLibre version, and `vite.config.ts` and the public browser requirements state one browser floor."** Move the gate/suite clause to `verification:` where it belongs (it is already `test:serial`). |

**C. Subjective or unenumerated predicates**

| task | problem | rewrite |
|---|---|---|
| DDM-P2-T03 (ROADMAP.yaml:165) | "open on **visible** Pacific evidence" — visible to whom, at what zoom | **"In each of the six cases the committed camera bounds contain the Niño 3.4 region and at least one ENSO surface reports a status other than unavailable."** |
| DDM-P9-T04 (ROADMAP.yaml:325) | "keeps perimeters **legible** above it" — subjective | **"The perimeter layer is ordered above the hazard drape in `src/map/layer-order.ts`, and the drape uses nearest-neighbour resampling so no intermediate category colour is produced."** |
| DDM-P10-T04 (ROADMAP.yaml:357) | "The four hazard screens **differ only where a hazard's evidence differs**" — unfalsifiable; no enumeration of permitted differences | **"The four hazard screens present the same control set in the same order, differing only in the rows a hazard has no source for, and every control boundary and text size meets the ratified contrast and type floors."** |
| DDM-P12-T03 (ROADMAP.yaml:397) | "with **the two over-claiming sentences** narrowed" — the two are never identified in the roadmap | **"Each of the four Pacific Northwest tilt sentences cites a published source with its season and probabilistic strength; the two DR-030 names as over-claiming are narrowed to what their source supports."** Requires DR-030 to name them. |
| DDM-P13-T01 (ROADMAP.yaml:414) | "no claim carrying observed evidence contains a **DDM-authored causal tail**" — the class is undefined, so nothing enumerates the set to check | **"Every claim string carrying `EvidenceClass` observed is present in a reviewed inventory, and each entry in that inventory is either sourced or marked a DDM presentation choice."** Requires the inventory to exist. |

**D. The 22 title-only stubs in P3 to P6 — one item, for the owner**

No acceptance is invented for these. They are listed so the item is resolvable in one pass:

- **DDM-P3** (6): T02, T03, T04, T05, T06, T07
- **DDM-P4** (4): T01, T02, T04, T05
- **DDM-P5** (7): T01, T02, T03, T04, T05, T06, T07
- **DDM-P6** (5): T01, T02, T03, T04, T06

Consequences the owner should weigh when resolving them, all from the trace:
`attachment_guards.rule_1_no_statement` withholds every attachment from a task stating neither an
acceptance nor a closed sentence (TRACE.yaml:19-22), so these 22 **cannot gain files or tests** until
they gain an acceptance. One attachment has already been withheld on this ground —
`src/ui/landscape-context.ts` from DDM-P3-T02 (TRACE.yaml:190-199). All 22 currently inherit
`default_verification: verify:smoke` (ROADMAP.yaml:6), which will run against nothing. 12 of the 22
are gated on undecided gates DDM-D05, DDM-D08, DDM-D09, DDM-D11 — for those, an acceptance sentence
may be premature and a `blocked_on` marker is the honest state instead.

---

## 8. The two orphan workflows

`.github/workflows/refresh-snapshots.yml` and `.github/workflows/upstream-monitor.yml` are the only
two non-`src/` entries in `orphan_files_without_test_coverage` (TRACE.yaml:4832-4853). Both already
resolve to `serves_component: release_delivery` by the `.github/workflows/` prefix
(ROADMAP.yaml:60) — they are orphans in the **task** sense (no task claims them), not the component
sense.

**Verdict: claim both under `release_delivery`. Retire neither.**

**`upstream-monitor.yml` — claim it; it is already load-bearing for a closed claim.** Its `owns`
line reads "Scheduled upstream liveness probe with tiered failure handling that distinguishes
runtime-blocking drift from build-tier and candidate warnings" (TRACE.yaml:4845-4846). DDM-P15-T03's
closed sentence claims "build-tier drift stops failing on a non-proving probe" (ROADMAP.yaml:476-477).
Those are the same behaviour. Retiring this workflow would silently withdraw the evidence for a done
claim. It is further corroborated by `scripts/check-upstream-drift.mjs`, which the catalog already
names under `release_delivery` (ROADMAP.yaml:60) and which carries a real test,
`tests/upstream-drift-contract.test.mjs` (TRACE.yaml:547-551). The workflow is the scheduled half of
a mechanism whose script half is already claimed and tested; claiming only the script is the
inconsistency.

**`refresh-snapshots.yml` — claim it; it is the currency mechanism behind DDM-P12.** Its `owns` line
reads "Scheduled rebuild and commit of ENSO data snapshot with staleness hedge enforcement and
dispatched Pages publication" (TRACE.yaml:4833-4834). DDM-P12-T01 is closed on "the snapshot
validator enforces the contract" (ROADMAP.yaml:385), and DDM-P12-T02 is open on DR-031, "wire the
weekly Niño 3.4 file to Weeks ahead" (ROADMAP.yaml:390). The bundled ENSO snapshot that
`src/impact/enso.ts` reads (TRACE.yaml:3199-3200) goes stale without this workflow, and a stale
snapshot silently falsifies DDM-P12-T01's acceptance, "The app's stated ENSO condition matches the
issuer's current advisory status **for the same date**" (ROADMAP.yaml:384). Retiring it would turn a
verified claim into a decaying one with no alarm. The "staleness hedge enforcement" in its `owns`
line is precisely the guard that acceptance needs.

**Precedent.** `.github/workflows/source-health.yml` is a third scheduled workflow and it *is*
claimed — by DDM-P0-T12 (TRACE.yaml:712-720). The roadmap already accepts scheduled workflows as
claimable delivery machinery. These two are the unclaimed remainder of the same class, and nothing
distinguishes them except that no task text happened to contain their filename tokens.

**Caveat, stated as unverified.** Whether either workflow currently runs on schedule, is disabled,
or has been superseded by a manual process is **not knowable from TRACE.yaml or ROADMAP.yaml**. The
trace records what the files declare, not whether GitHub is executing them. If the owner has since
disabled scheduled runs, the correct move is to retire `refresh-snapshots.yml` **and** re-open
DDM-P12-T01, because its acceptance is date-coupled. That is a decision the trace cannot make.

---

## 9. Proposed diff to `docs/ROADMAP.yaml`

Not applied. Covers items 1, 4, 7 and 8. Line anchors are from the file as read this session.

```diff
--- a/docs/ROADMAP.yaml
+++ b/docs/ROADMAP.yaml
@@ -22,6 +22,11 @@
 # Task keys: `title`; then `status` with `closed` or `superseded_by`, or
 # `acceptance` for open work. The 2026-09 backlog (DDM-P7 onward) also carries
 # `source` (the 2026-09-01 deep-dive review, by report number and finding id),
+# `evidence` (added 2026-09-07: the repository paths that prove a `closed`
+# sentence, present ONLY on done tasks whose closure the 2026-09-07
+# reconciliation could not trace to a file; a done task carrying neither
+# `evidence` nor traced files is an unverified claim), and `acceptance_pending`
+# (a task with no acceptance sentence yet; it can hold no files by trace rule),
 # `effort` (S, M, L), `needs_decision` (the 2026-09-02 owner decision register
 # id, with the review's own decision label in parentheses), and
 # `verification`, present ONLY where a task differs from `default_verification`
@@ -57,13 +62,22 @@
   - "Do not add proprietary providers, credentials, tracking, analytics, or telemetry."
 
 component_catalog:
-  release_delivery: {paths: [".github/workflows/", "vite.config.ts", "scripts/check-upstream-drift.mjs", "workers/proxy/"], concerns: ["GitHub Pages", "Cloudflare Worker", "build identity", "range-safe static delivery"]}
+  # Item 8, 2026-09-07: refresh-snapshots.yml and upstream-monitor.yml are
+  # claimed here, not retired. upstream-monitor.yml is the scheduled half of the
+  # drift mechanism whose script half this entry already names, and it attests
+  # one clause of DDM-P15-T03. refresh-snapshots.yml keeps the bundled ENSO
+  # snapshot current, which DDM-P12-T01's date-coupled acceptance depends on.
+  # Neither is reachable by any test: `.github/` is outside the trace's test
+  # roots and no spec asserts on workflow content (tests/README.md:229 is prose).
+  release_delivery: {paths: [".github/workflows/", "vite.config.ts", "scripts/check-upstream-drift.mjs", "workers/proxy/"], concerns: ["GitHub Pages", "Cloudflare Worker", "build identity", "range-safe static delivery", "scheduled snapshot refresh and upstream liveness", "workflow files are attested by run receipts, not by this repository's gate"]}
   state_and_lifecycle: {paths: ["src/state/", "src/util/fetch.ts", "src/config/layers.ts", "src/types/layer.ts"], concerns: ["URL state", "activation and cancellation", "status semantics", "late-response protection"]}
   interface: {paths: ["src/ui/", "src/styles/app.css", "src/config/presets.ts", "src/config/clusters.ts"], concerns: ["desktop, tablet, phone, and embed", "keyboard and assistive technology", "reduced motion", "source and time receipts"]}
   map_and_visualization: {paths: ["src/map/", "src/layers/", "src/config/palette.ts", "src/config/wildfire-presentation.ts"], concerns: ["MapLibre lifecycle", "layer ordering", "2D and 3D presentation", "accessible legends"]}
   impact_and_place: {paths: ["src/impact/", "src/config/capability-matrix.ts", "src/state/typed-place.ts"], concerns: ["selected-place evidence", "regional coverage", "ENSO interpretation", "resource routing"]}
   data_pipelines: {paths: ["scripts/", "public/data/"], concerns: ["source vetting", "static artifacts", "PMTiles", "snapshot provenance", "artifact budgets"]}
+  # Item 1, 2026-09-07: before these two entries, 42 scouted files matched no
+  # catalog path, including src/config/urls.ts, which authority.runtime_truth
+  # above names as runtime truth. Resolution is longest-prefix, so the six
+  # per-file config entries and src/util/fetch.ts keep their current components.
+  declared_catalogs: {paths: ["src/config/", "src/types/"], concerns: ["one declared source of truth per catalog", "the endpoint catalog and its eager boot slice", "region, framing, and ocean vocabularies", "station and place catalogs", "source and region capability declarations", "sovereign-representation provenance strings"]}
+  shared_utilities: {paths: ["src/util/"], concerns: ["pure dependency-light helpers", "HTML escaping and payload type guards", "geometry, bbox, and antimeridian handling", "agency payload adapters", "motion, fade, and frame stepping", "archive header probing"]}
   verification: {paths: ["tests/", "scripts/check-activation-budget.mjs", "scripts/check-bundle-size.mjs"], concerns: ["strict TypeScript", "deterministic gate", "targeted browser tests", "serial release suite", "live production probes"]}
   documentation: {paths: ["README.md", "DEVELOPER.md", "ROADMAP.md", "docs/", "public/data/README.md"], concerns: ["public behavior and source qualifications", "planned scope", "maintainer and release evidence"]}
 
@@ -108,7 +122,7 @@
       - id: "DDM-P0-T09"
         title: "Prove or decline globe projection"
-        acceptance: "Terrain, Fire 3D, URL, embed, phone, tablet, desktop, and reduced-motion behavior are each verified after the change, or the decline records the measured reason and removes no current capability."
+        acceptance: "Globe projection is either shipped with terrain, Fire 3D, URL, embed, phone, tablet, desktop, and reduced-motion cases each under a named test, or DDM-D01 records a dated decline naming the measured cost; no current capability is removed either way."
         decision_gate: "DDM-D01"
       - id: "DDM-P0-T10"
         title: "Prove or decline global low-zoom NASA GIBS imagery"
-        acceptance: "The layer carries its own status, timestamp, qualification, and legend and never implies current fire detection or drought assessment, or the decline records the measured source, performance, or product reason."
+        acceptance: "The GIBS layer either ships carrying its own status, timestamp, qualification, and legend and asserting no fire detection or drought assessment, or DDM-D01 records a dated decline naming the measured source, performance, or product reason."
         decision_gate: "DDM-D01"
@@ -142,7 +156,7 @@
       - id: "DDM-P1-T06"
         title: "Align Fire data-query scopes"
-        acceptance: "Outside the current request never reads as no data, and no scope change is made without a measured transfer and record-count benefit."
+        acceptance: "Outside the current request never renders as no data, and the scope change is accompanied by a recorded before-and-after transfer size and record count."
       - id: "DDM-P1-T07"
         title: "Update landscape-signature source pins"
-        acceptance: "A phased or incomplete upstream mosaic cannot become the national default, and any fixture or public-artifact change is explicit and source-qualified."
+        acceptance: "scripts/validate-landscape-artifact.mjs rejects a mosaic whose upstream coverage is phased or incomplete, and every landscape fixture in the tree names its source and edition in the file."
         github_issues: [13]
@@ -163,7 +177,7 @@
       - id: "DDM-P2-T03"
         title: "Give ENSO a shareable Pacific camera contract"
-        acceptance: "Fire-to-ENSO, share, reload, reset, phone, and desktop cases all open on visible Pacific evidence under one explicit basemap policy."
+        acceptance: "In each of the six cases (Fire-to-ENSO, share, reload, reset, phone, desktop) the committed camera bounds contain the Nino 3.4 region and at least one ENSO surface reports a status other than unavailable, under one declared basemap policy."
         decision_gate: "DDM-D04"
@@ -170,11 +184,11 @@
       - id: "DDM-P2-T05"
         title: "Complete task-based responsive verification"
-        acceptance: "Select, hazard switch, status read, share, reset, information, and mode-exit tasks are verified with keyboard, screen reader, reduced motion, high contrast, and safe-area cases represented."
+        acceptance: "Each of the seven tasks (select, hazard switch, status read, share, reset, information, mode exit) has at least one keyboard test and one reduced-motion test, and the screen-reader, high-contrast, and safe-area cases are each named by a test or recorded as declined."
         dependencies: ["DDM-P10-T01"]
       - id: "DDM-P2-T06"
         title: "Run a real-device field ergonomics pass"
-        acceptance: "Touch, scrolling, orientation, and iframe behavior are reviewed outside emulation on iOS, Android, tablet, and a small iframe, and every finding is filed or accepted with evidence."
+        acceptance: "A dated field-pass record names the four device classes exercised outside emulation (iOS, Android, tablet, small iframe) and lists every touch, scrolling, orientation, and iframe finding as filed with an id or accepted with a reason."
+        # Not reachable by any automated gate; verified by the dated record only.
+        verification: "none (owner-run field pass)"
 
   # ---- Phases DDM-P3 through DDM-P6: 22 tasks carry a title and no acceptance.
   # The 2026-09-07 reconciliation flags them as ONE item for the owner. No
@@ -302,6 +316,12 @@
       - id: "DDM-P9-T01"
         title: "Correct the 3D control vocabulary, pitch ceiling, and station ranking"
         status: done
+        # Item 4, 2026-09-07: the trace attached no file and no test to this
+        # claim, though every proving file exists and three carry tests. Not a
+        # structural block (rule_1 exempts a task with a closed sentence);
+        # scout under-attachment. Claim stands on this evidence.
+        evidence: ["src/ui/island/pill-text.ts", "src/ui/island/fire3d-control.tsx",
+                   "src/config/fire3d-presentation.ts", "src/impact/fire-context.ts",
+                   "src/config/station-registry.ts"]
         closed: "2026-09-01: the 3D control speaks the six honest layer states, the pitch ceiling and coordinate destructuring are corrected, and nearest stations carry a distance ceiling and an honest absence."
@@ -320,7 +340,7 @@
       - id: "DDM-P9-T04"
         title: "State the coverage of terrain shading and keep the hazard drape legible"
-        acceptance: "Terrain shading names the extent of the elevation data it uses, and the hazard drape keeps perimeters legible above it without resampling categories into intermediate colors."
+        acceptance: "Terrain shading names the extent of the elevation data it uses, the perimeter layer is ordered above the hazard drape in src/map/layer-order.ts, and the drape resamples by nearest neighbour so no intermediate category colour is produced."
@@ -341,8 +361,14 @@
       - id: "DDM-P10-T02"
         title: "Land the token layers the design had none of"
         status: done
-        closed: "2026-09-01: motion and z-index tokens declared, the briefing spinner keyframe added, two dead rules removed, the minimap ocean doors reach the touch floor, and the muted foreground token was raised (it clears 4.5:1 on three of the four backgrounds; the fourth remains open)."
+        # Item 4, 2026-09-07: proof lives entirely in src/styles/app.css, which
+        # this catalog names but which appears nowhere in the trace's scouted
+        # files or orphan lists. Structurally untestable until a token or
+        # contrast test exists. The residual fourth background was closed inside
+        # a done sentence and is moved to DDM-P10-T04, where the contrast floor
+        # already lives.
+        evidence: ["src/styles/app.css"]
+        closed: "2026-09-01: motion and z-index tokens declared, the briefing spinner keyframe added, two dead rules removed, the minimap ocean doors reach the touch floor, and the muted foreground token was raised to clear 4.5:1 on three of the four backgrounds. The fourth background is carried by DDM-P10-T04."
@@ -352,7 +378,7 @@
       - id: "DDM-P10-T04"
         title: "Unify the four hazard screens"
-        acceptance: "The four hazard screens differ only where a hazard's evidence differs, and every control boundary and text size meets its contrast and legibility floor."
+        acceptance: "The four hazard screens present the same control set in the same order, differing only in the rows a hazard has no source for, and every control boundary and text size meets the ratified contrast and type floors, including the fourth background carried over from DDM-P10-T02."
@@ -378,6 +404,11 @@
       - id: "DDM-P12-T01"
         title: "Lead the ENSO headline with advisory semantics"
         status: done
+        # Item 4, 2026-09-07: one attached file, no test. The claim stands on
+        # commit 46f98f4 and on src/impact/enso.ts, whose header states the same
+        # three CPC rules the sentence claims. The named snapshot validator is
+        # not traced to a path; name it here, and give one of the two existing
+        # ENSO specs an import-level assertion on src/impact/enso.ts.
+        evidence: ["src/impact/enso.ts", "tests/enso-observed-state.spec.ts"]
         source: "05 ENSO-01, ENSO-03; 13 ENSOSCI-01, ENSOSCI-04"
@@ -392,7 +423,7 @@
       - id: "DDM-P12-T03"
         title: "Cite and correct the regional tilt statements"
-        acceptance: "Each regional tilt sentence traces to a published source and states the season and the probabilistic strength that source supports, with the two over-claiming sentences narrowed."
+        acceptance: "Each of the four Pacific Northwest tilt sentences cites a published source and states the season and probabilistic strength that source supports; the two DR-030 names as over-claiming are narrowed to what their source supports."
@@ -409,7 +440,7 @@
       - id: "DDM-P13-T01"
         title: "Replace or label the invented bands, cut points, and causal tails"
-        acceptance: "The DSCI trend band and the water-supply classes either cite a published basis or are labeled a DDM presentation choice, no claim carrying observed evidence contains a DDM-authored causal tail, and no positional array index is described as a number of weeks."
+        acceptance: "The DSCI trend band and the water-supply classes each cite a published basis or are labeled a DDM presentation choice; every claim string carrying EvidenceClass observed appears in a reviewed inventory with each entry sourced or marked a DDM presentation choice; and no positional array index is described as a number of weeks."
@@ -442,7 +473,7 @@
       - id: "DDM-P14-T03"
         title: "Take the first paint down to what it needs"
-        acceptance: "The entry chunk sits inside its declared budget with the budget unchanged, or the budget moves in a recorded decision that names what grew."
+        acceptance: "scripts/check-bundle-size.mjs passes against the entry budget recorded in the tree at the start of this task, or the diff that moves the budget names the byte delta and the module that grew."
@@ -458,7 +489,7 @@
       - id: "DDM-P15-T01"
         title: "Record the local full-service server end state and the seams it needs"
-        acceptance: "The hosting plan states that GitHub Pages is the current static host and names the seams a local server would replace, and no hosting change is made without range, cache, privacy, cost, and rollback evidence."
+        acceptance: "docs/ states that GitHub Pages is the interim static host, names each seam a local server would replace, and lists the five evidence classes (range, cache, privacy, cost, rollback) any hosting change must supply before it is made."
         decision_gate: "DDM-D10"
-        verification: "verify:quick"
+        verification: "none (documentation state; verify:quick asserts nothing here)"
@@ -465,7 +496,7 @@
       - id: "DDM-P15-T02"
         title: "Land the renderer version the gate selects and declare the browser floor it implies"
-        acceptance: "The manifest, the lockfile, and the installed tree name the same renderer version, the build target and the published browser and graphics requirements state the same floor in one place, and the gate and the serial suite pass before it lands."
+        acceptance: "package.json, package-lock.json, and the installed tree name the same MapLibre version, and vite.config.ts and the published browser and graphics requirements state one browser floor in one place. (The gate and serial suite are the `verification` below, not part of the acceptance.)"
+        # 2026-09-07: reconcile with DDM-P0-T03, which is closed on the same
+        # landing (993f5ca, deploy 33725341105). Either this task is done and
+        # unclosed, or T03 closed early. DDM-D01 is decided and four of its five
+        # dependants remain open.
@@ -473,6 +508,11 @@
       - id: "DDM-P15-T03"
         title: "Quiet and stabilize the delivery workflows"
         status: done
+        # Item 4, 2026-09-07: no file, no test. The trace found the proving
+        # files twice and discarded both attachments as area-word matches
+        # (rejected_rules `ci` and `pipeline`). Claim stands; name the files.
+        evidence: [".github/workflows/verify-live.yml", ".github/workflows/upstream-monitor.yml",
+                   "scripts/lib/live-receipts.mjs", "scripts/check-upstream-drift.mjs"]
         closed: "2026-09-01: the live embed-corner proof matches the shipped credits surface, the live-build resolver retries and ends green on an API outage, build-tier drift stops failing on a non-proving probe, and the unreachable light path is gone."
@@ -483,3 +523,15 @@
         acceptance: "One lint command runs over the TypeScript and the stylesheet and passes on the current tree, and the gate names it."
         verification: "verify:quick"
+      - id: "DDM-P15-T05"
+        title: "Guard the delivery workflows from the repository's own gate"
+        source: "2026-09-07 reconciliation, findings 1 and 2"
+        effort: S
+        acceptance: "One test under tests/ reads the workflow YAML as text and fails when an action is not pinned to a 40-hex commit, when deploy.yml does not set DDM_BUILD_SHA, when an artifact upload is unconditional or unbounded in retention, or when the Chromium cache action loses its separate restore and save steps; and the two scheduled workflows named in release_delivery are each reached by it."
+        verification: "verify:quick"
```

---

## What is unverified

Stated plainly, so none of the above reads as more settled than it is.

- Whether any test asserts on `.github/workflows` content: **confirmed no** (the one source read;
  `tests/README.md:229`, `:246`, `:316` are prose). Whether the workflows themselves currently run
  on schedule: **unverified** — outside both files.
- Whether `src/styles/app.css` is a hub, how large it is, or what it currently declares:
  **unverified** — it appears nowhere in TRACE.yaml.
- Whether DDM-P15-T02 is in fact complete: **unverified**. Both it and DDM-P0-T03 carry
  `no-files-no-tests`; the trace cannot separate them.
- Whether the ENSO snapshot validator named in DDM-P12-T01's closed sentence exists at a path:
  **unverified** — no attachment, and the `pipeline` rule's discarded matches contain only
  landscape scripts.
- Whether the 22 title-only stubs *should* have acceptance sentences, or are correctly parked behind
  undecided gates: **owner's call**. No acceptance was invented.
- The dependency order in Section 6 governs 25 of 67 open tasks. For the other 42 the trace holds no
  import evidence and **no order exists**.
