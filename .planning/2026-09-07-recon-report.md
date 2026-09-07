# S03b: reconnaissance before Wave 2

Between S03 (the enso.ts cut plan, fb696d5 and 5792dea) and the first Wave 2 task. Tree: main, HEAD
5792dea at start, dc1a583 after this session's first commit. Nothing under `src/`, `tests/`, `docs/`
or `.claude/` was changed. One Playwright run, in section 3.

Three TRACE repairs landed as dc1a583. A fourth, owner-directed at checkpoint 2, stopped on its own
stated stop condition and is owner call 2. Also owner-directed there, a process fact and not session
work: PID 19028 (`codex.exe`, app-server) and its conhost 30500 were ended; the live parent respawned
it as 22112 within seconds, reported before continuing; PID 25212 (`ChatGPT.exe`) and its whole tree
were then ended, taking 22112 with it, and sweeps of `Get-Process | Where-Object { $_.Name -match
'codex|chatgpt' }` at +6 s and +21 s returned nothing. For the owner's settings, not this session:
25212 was parented to `explorer.exe` and none of the eleven processes held a window, which reads as a
login autostart.

## 1. DDM-D12 count and map

Method: `.planning/tools/edges.py` re-derives task edges from `src/` directly (its lines 47 to 99),
not from `.planning/trace/imports.json`. It drops `import type` at its own `:85-86` and adds dynamic
`import()` at `:96-99`. All numbers below are computed AFTER the three TRACE repairs.

`imports.json` was stale as flagged and was regenerated from `.planning/trace/vite.trace.config.ts`
(`[ddm-trace-imports] moduleParsed: 203; graph sweep: 203; src/ modules: 180; edges: 703`). Dynamic
`import()` IS included, confirmed in that code at `:57` fed by `info.dynamicallyImportedIds` at `:69`
and `:81`. But `import type` is NOT excluded by any code in that generator; it carries no type filter,
and type-only imports are absent only because Vite's TS transform erases them before Rollup records
`importedIds` (`.planning/TRACE.yaml:55`, `caveat_type_only`, says the same from the other side).
Post-regeneration: `heat-horizon` 0 hits, `impact/matrix.ts` 4, `overlap-engine` only under
`src/ui/island/`.

That last claim was then checked empirically, not left as reasoning. Across 139 scanned `src/` files
there are **97 module pairs a file imports ONLY with `import type`** and never as a value; **0 of the
97 appear as an edge in `imports.json`.** Control: of 703 value-import pairs, 701 are present
(99.7%). Both absences are explained and neither is a graph defect. `src/ui/impact-panel.ts:43` is
`typeof import('./impact-panel-runtime')`, a type-position dynamic import that correctly forms no
runtime edge; the naive `import(` regex in `.planning/tools/edges.py:49` counts it as a value edge,
so that scanner over-reports by one here. `src/main.ts:277` sits inside the dev-only
`__ddmResolveIdentity` block, which the production build eliminates. Both target modules are in the
graph by other paths.

**(a) Linter excluded, hub line at twenty. The component is THREE tasks:** ENSO horizons
(DDM-P12-T02), ENSO citations (DDM-P12-T03), briefing matrix (DDM-P7-T02).

Versus the eleven at `docs/ROADMAP.yaml:686-687`: **nothing added, eight removed.** The eight that
leave: cancel layer loads (DDM-P1-T02), split sidebar from search (DDM-P1-T04), heat claims without
the layer (DDM-P7-T05), fire and heat time bar (DDM-P8-T02), honest horizon chips (DDM-P8-T03),
minimap condition text (DDM-P11-T01), startup weight (DDM-P14-T03), RAWS values (DDM-P9-T05). This
reproduces `.planning/2026-09-07-s03-enso-cut-plan.md:68`, "hub line 20, all eleven ... SCC of 3".

**Overlap engine (DDM-P9-T03) does NOT remain in (a).** Its four files after repair two are
`src/impact/fire-context.ts`, `src/impact/sources.ts`, `src/layers/nifc-fires.ts`,
`src/ui/island/overlap-engine.ts`. At hub line twenty it carries edges but closes no cycle: outbound
`DDM-P7-T02 <- DDM-P9-T03` via `hydrate.ts -> sources.ts`, inbound `DDM-P9-T03 <- DDM-P8-T02` via
`sources.ts -> ui/heatrisk-sequence.ts`, nothing returning. **The path repair did not move it:** at
hub line ten with the linter excluded the component is TWELVE, the eleven plus overlap engine, as
`.planning/2026-09-07-s03-enso-cut-plan.md:266` predicted. It is bound in through `sources.ts` and
`fire-context.ts`, not through the file that moved, so correcting the path changed its membership not
at all. The moved file has zero outbound edges in the regenerated graph (`imports.json:754`).

**(b) Linter included, hub line ten: TWENTY tasks.** The eleven, plus overlap engine (DDM-P9-T03),
fire cells (DDM-P7-T03), the linter itself (DDM-P15-T04), and DDM-P1-T03, DDM-P2-T04, DDM-P7-T04,
DDM-P7-T06, DDM-P9-T02, DDM-P9-T04. The linter attaches 122 `src/` files and fuses seventeen tasks.
Which tasks, and through which files (file-pair count, then one pair as the receipt):

    split sidebar from search (DDM-P1-T04)      40  state/display-snapshot.ts -> ui/island/bridge.ts
    briefing matrix (DDM-P7-T02)                25  impact/briefing.ts -> impact/context.ts
    heat claims without the layer (DDM-P7-T05)  21  impact/heat-synthesis.ts -> impact/point-heat-format.ts
    DDM-P7-T04                                  21  impact/hydrate.ts -> impact/nws-point.ts
    fire cells (DDM-P7-T03)                     15  impact/sources.ts -> impact/category-impacts.ts
    DDM-P7-T06                                  15  impact/sources.ts -> impact/nws-point.ts
    minimap condition text (DDM-P11-T01)        13  state/minimap-drought.ts -> config/framings.ts
    RAWS values (DDM-P9-T05)                    12  layers/nws-alerts.ts -> ui/popups.ts
    cancel layer loads (DDM-P1-T02)             10  layers/aiannh.ts -> impact/context.ts
    fire and heat time bar (DDM-P8-T02)         10  layers/bc-drought.ts -> ui/time-bar.ts
    startup weight (DDM-P14-T03)                 7  state/url.ts -> config/regions.ts
    DDM-P9-T04                                   3  layers/hillshade.ts -> map/layer-order.ts
    DDM-P9-T02                                   3  map/fire3d.ts -> map/gl-capability.ts
    DDM-P1-T03                                   3  state/layer-controller.ts -> map/layer-order.ts
    honest horizon chips (DDM-P8-T03)            2  ui/island/strip-metrics.ts -> state/timeline.ts
    DDM-P2-T04                                   2  ui/island/fire3d-control.tsx -> map/fire3d.ts

Removing the linter alone drops twenty to twelve; raising the hub line to twenty as well drops it to
three.

## 2. The tilt sentences

`tendency()` is at `src/impact/enso.ts:474-503`, under the comment at `:464-473`. It has **THREE
branches, not four.** `docs/ROADMAP.yaml:466` speaks of four Pacific Northwest tilt sentences; which
four is undecided, and this session did not decide it. Every branch carries `source`, `sourceUrl` and
`lineage`, and every URL resolves:

| branch | sentence | source | sourceUrl const | curl -sI |
|---|---|---|---|---|
| `el-nino` | `:479` | USDA Northwest Climate Hub, El Nino in the Northwest (`:481`) | `NW_HUB_EL_NINO_URL` (`:203`) | **200** |
| `la-nina` | `:488` | USDA Northwest Climate Hub, La Nina in the Northwest (`:490`) | `NW_HUB_LA_NINA_URL` (`:205`) | **200** |
| `default` | `:497` | NOAA CPC ENSO temperature, precipitation and snow composites (`:499`) | `CPC_COMPOSITES_URL` (`:207`) | **200** |

Lineage: el-nino `:483` names the NW Hub summary, the Washington State Climate Office and the CPC
composites; la-nina `:492` the first and last of those; neutral `:501` the composites and the CPC
Seasonal Drought Outlook. Two lineage entries have NO url anywhere in the code: the Washington State
Climate Office (`:461`) and the CPC Seasonal Drought Outlook (`:501`).

**Commit 46f98f4.** `git log -L 464,504:src/impact/enso.ts` returns exactly two commits, 46f98f4
(2026-09-02) and the b20489a baseline. 46f98f4 rewrote all three branches and added the citation
apparatus that did not exist before it: the `TendencyRead` fields `source`, `sourceUrl`, `lineage`,
the three lineage constants, and the three per-branch triples.

- **El Nino, reworded and corrected.** Deleted "this tilts the odds toward a warmer, drier winter with
  below-normal snowpack and an earlier melt-out". Added the NW Hub attribution plus snowpack
  counter-evidence naming 1982-83, 1997-98 and 2015-16 as near-normal Washington snowpack;
  `enso.ts:467-470` states the replacement in its own words.
- **La Nina, reworded, and one sentence deleted outright.** Deleted "La Nina is not a blanket
  all-clear for fire: a wet, productive winter can grow abundant fine fuels that cure through summer,
  so an active grass-fire season is still possible, especially east of the Cascades." Nothing replaced
  it; `enso.ts:470-472` gives the reason, "no issuer states it as an ENSO teleconnection (report 13,
  ENSOSCI-09, UNVERIFIED)".
- **Neutral, reworded.** Deleted "A neutral phase offers little long-range signal ... rather than the
  ocean state." Added the composites framing at `:497`.

Facts about the commit only. Whether ENSO citations (DDM-P12-T03) is therefore done is cut-plan owner
call 5 and stays open.

## 3. Matrix acceptance spec on main

    npx playwright test --workers=1 tests/briefing-matrix.spec.ts
    Running 11 tests using 1 worker
    11 passed (9.7s)

All eleven green, including `the open briefing renders all twelve cells, each with a claim or a named
state` (5.6s). First gate run of briefing matrix (DDM-P7-T02)'s acceptance on main; cut plan section
4 established that no ladder rung had ever executed it.

## 4. Spec audit

Eight Haiku 4.5 subagents read all 113 `tests/*.spec.ts` headers, read-only, writing nothing. Their
task-id column was verified against a full-tree `grep -o -E 'DDM-P[0-9]+-T[0-9]+' tests/*.spec.ts`,
which is authoritative; **three swarm rows were corrected** (heat-h1-heatrisk, heat-h0-integrity,
raster-status each name an id below the header window the agents were told to read). Exactly **eleven
of 113 specs name any DDM task id;** the other 102 name none. All 113 run under `test:serial`
(`package.json:17`, `playwright.config.ts:98 testDir: './tests'`, the three projects at `:213-241`
partition rather than exclude), so that column is uniformly yes.

| spec | task id(s) | header quotes acceptance? | verify:smoke |
|---|---|---|---|
| `tests/boundary-stubs.spec.ts:7` | DDM-P1-T08 | YES, "acceptance, part one" | no |
| `tests/briefing-matrix.spec.ts:3-7` | DDM-P7-T02 briefing matrix | YES, verbatim | **no** |
| `tests/interface-responsive.spec.ts:701-707` | DDM-P10-T01 | YES, "asserted literally" | yes |
| `tests/legend.spec.ts:73-75` | DDM-P13-T03 | YES, restated | yes |
| `tests/temporal-axis.spec.ts:322` | DDM-P8-T05 | YES | yes |
| `tests/fire3d-mode.spec.ts:221,235` | DDM-P9-T02, DDM-P1-T08 | partial, "first acceptance clause" | no |
| `tests/heat-h0-integrity.spec.ts:512` | DDM-P7-T02 | no, historical aside | no |
| `tests/heat-h1-heatrisk.spec.ts:736` | DDM-P7-T02 | no, historical aside | no |
| `tests/raster-status.spec.ts:72` | DDM-P0-T06 | no, log-capture rationale | no |
| `tests/tribal-live-layers.spec.ts:26` | DDM-P1-T08 | no, fixture note | no |
| `tests/worker-proxy-policy.spec.ts:14` | DDM-P0-T05 | no, shared-constant note | no |

**Wave 2 gap list. Ten of the eleven Wave 2 tasks have NO acceptance spec anywhere in `tests/`** that
names them: cancel layer loads (DDM-P1-T02), split sidebar from search (DDM-P1-T04), heat claims
without the layer (DDM-P7-T05), fire and heat time bar (DDM-P8-T02), honest horizon chips
(DDM-P8-T03), RAWS values (DDM-P9-T05), minimap condition text (DDM-P11-T01), ENSO horizons
(DDM-P12-T02), ENSO citations (DDM-P12-T03), startup weight (DDM-P14-T03). The eleventh, briefing
matrix (DDM-P7-T02), has `tests/briefing-matrix.spec.ts`, and it is not in `verify:smoke`
(`package.json:48` names twelve specs; that is not among them).

**Unattached specs, wider than S03 found.** S03 named two. A sweep of every task's `tests:` list in
`.planning/TRACE.yaml` finds **37 of 113 specs attached to no task at all**, five of them in the
gating `verify:smoke` set: `conditions-strip`, `embed-viewport`, `interface-responsive`,
`mobile-sheet`, `ux1-surfaces`. Both specs S03 named are confirmed in the 37:
`tests/briefing-matrix.spec.ts` appears nowhere in TRACE.yaml at all, and
`tests/heat-h0-integrity.spec.ts` only in the orphan census at `.planning/TRACE.yaml:4527` under the
orphan file `src/layers/nws-alerts.ts`, never in a task's `tests:` list. Attaching any of the 37 is an
owner call; none was attached.

## 5. References register seed

`planning/references/register.yaml` created: **22 entries**, plain ASCII YAML, header states it is a
seed. Harvested from `src/impact/enso.ts`, `src/impact/matrix.ts`, the snapshot they read
(`public/data/enso-indices.json`) and the two scripts that build and validate it. The three URLs
resolved in section 2 carry `last_checked: "2026-09-07"`; the other 19 say `unchecked`, which is not a
claim that they are broken. Fifteen entries trace to the ENSO seam (10 owned by ENSO horizons, 5 by
ENSO citations); seven to the briefing matrix (4 by briefing matrix, 2 by fire cells, 1 by heat claims
without the layer). **`src/impact/matrix.ts` carries no `source`, `sourceUrl` or `lineage` field of
its own**; it names issuers in prose inside `CELL_ABSENCE` (`:127-154`), so all seven of its entries
have `url: null`. Ten entries have `url: null` and three are `gap: true`, including the Washington
State Climate Office and the CPC Seasonal Drought Outlook. Three are `wired: false`, matching cells
that say so themselves: SPC Days 1 to 8 (`:141`), NIFC Predictive Services Months 1 to 4 (`:149`), CPC
seasonal temperature outlook (`:151`). Entries are keyed by readable slug; **no DR-, FE-, EF-IB- or
EF-MM- id is minted, reused or redefined.**

## 6. Open owner calls

1. **ENSO horizons (DDM-P12-T02): DR-031 option (a) needs the snapshot builder extended, NOT a new
   URLS entry.** `src/config/urls.ts` holds exactly one ENSO endpoint, `ensoIndicesLocal` at line 985,
   a bundled local snapshot; there is no weekly Nino 3.4 endpoint, and `:1053-1057` is a tombstone for
   a CPC probabilities endpoint removed 2026-07-21. The application never fetches CPC directly, and
   `scripts/build-enso-snapshot.mjs` hardcodes its four upstream URLs at `:60-64` while importing
   nothing from `urls.ts` (`:55-58` are node builtins plus the contract). Option (a) therefore needs a
   new upstream URL beside `:60-64` and a new series in `scripts/lib/enso-snapshot-contract.mjs`
   (`OPTIONAL_SERIES` at `:304`, plus a validator shaped like `isNino34Series` at `:481`). The
   register's `cpc-nino34-detrended-monthly` entry records that the wired product is MONTHLY, not
   weekly. Recorded, not built.
2. **Repair four, and the dangling `covers:`.** `.planning/TRACE.yaml:2435` still reads
   `covers: src/impact/heat-horizon.ts` on `tests/heat-h1-heatrisk.spec.ts` inside heat claims without
   the layer (DDM-P7-T05). The spec does NOT reference `heat-horizon.ts` and has no dynamic `import(`.
   Its seven `src/` references, all of them, are lines 6 to 12: `config/palette`, `config/clusters`,
   `impact/evidence`, `impact/matrix` (value `:9`, type `:10`), `impact/types`,
   `ui/heatrisk-sequence-loader`. **None of those six files is attached to DDM-P7-T05**, so any
   `covers:` value would assert a link the trace's own method (`.planning/TRACE.yaml:40-43`) does not
   support. The near-miss: `heatrisk-sequence-loader.ts` is not `heatrisk-sequence.ts`, and the loader
   imports nothing (`:24-29`, injected `load`), so there is not even a one-hop path. If the entry is
   kept, `covers: src/impact/matrix.ts` is the defensible choice; the alternative is dropping it.
3. **Restating DDM-D12 membership.** `docs/ROADMAP.yaml:686-687` names eleven. Under the accepted cuts
   it is three; under the reconciled hub line of ten with the linter excluded it is twelve.
4. **`tests/briefing-matrix.spec.ts` and the `verify:smoke` list.** It passes and is the only Wave 2
   acceptance spec that exists. Adding it to `package.json:48` is a scripts change; cut plan section 4
   runs it as a per-task extra step instead.
5. **The 37 unattached specs, five of them gating.** Wider than the two S03 named. Unassigned.
6. **The register's id scheme.** Slugs are provisional. A coded scheme would have to be registered in
   `.planning/PLANNING_AUTHORITY.md` section 2 first.
7. **`attached_by: repair:S03b` is a new value** in that field (existing: `scout`,
   `path-rule:script-name`, `path-rule:worker`). **No consumer cares:** `attached_by` appears in one
   file in the repo, `.planning/TRACE.yaml` itself, and nothing under `.planning/tools/`, `scripts/`,
   `tests/`, `src/`, `docs/`, `planning/`, `package.json` or `.claude/` reads it. The two scripts that
   parse TRACE.yaml read four shapes only: the task-id header, `- path:`, `status:` and the `tests:`
   boundary (`attach.py:15,32,36-40`; `edges.py:29,40,43`).
8. **`.planning/TRACE.yaml` header is stale.** `generated_from.commit` at `:5` still reads
   `5be15f50388ff660fa43162996979e699805f6d9`. The three repairs did not touch it.
9. **Four tilt sentences, three branches.** `docs/ROADMAP.yaml:466` says four; `tendency()` has three.
   Restates cut-plan owner call 4; not resolved here.
