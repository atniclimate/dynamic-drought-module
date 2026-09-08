# Planning-tree authority reconciliation

**Read-only.** Generated 2026-09-07 against `main` at `5be15f5`. Nothing under
`planning/`, `docs/`, `src/` or anywhere else was modified; the only writes were
`.planning/PLANNING_AUTHORITY.md` and `.planning/trace/`.

Scope: `planning/` (326 files, 11 subfolders) reconciled against
`docs/ROADMAP.yaml` (656 lines, 117 declared ids, last commit `860c4b2`
2026-09-03). Every load-bearing claim below carries a `path:line` or names a
field in `.planning/trace/planning-tree.json`.

---

## 0. The one structural fact that shapes everything

`planning/` is gitignored (`.gitignore:57:/planning/`). `git log -1 -- planning/<sub>`
returns **nothing for all 11 subfolders**. There is no commit history, no authorship,
and no merge record for any of these 326 files. Recency below is **filesystem mtime**,
which records last write, not last meaningful edit, and survives a copy. Every
"newer than" judgment in this document rests on that weaker evidence, plus each
file's own stated date where it carries one.

`tracked` vs `untracked` matters a second time on the inbound side: `HANDOFF.md`
and `docs/IDEAS.md` are themselves untracked, so a planning path cited only from
them is not evidence that the *shipped* tree depends on it
(`planning-tree.json:method.rules.rule_13_tracked_split`).

---

## 1. Subfolder table and verdicts

| subfolder | files | exts | git | newest mtime | schemes owned | ids cited live (tracked) | confirmed conflicts | **verdict** |
|---|---|---|---|---|---|---|---|---|
| `decisions` | 6 | md(5) yaml(1) | none | 2026-09-04 | `DR` (69) | 54 ids / 232 sites | 0 | **live_authority** |
| `qa` | 1 | yaml(1) | none | 2026-08-29 | `FE` (24) | 5 ids / 19 sites | 0 | **live_authority** (narrow) |
| `user-research` | 9 | md(8) zip(1) | none | 2026-09-04 | — | — | 0 | **live_authority** (input of record) |
| `handoffs` | 8 | md(8) | none | 2026-09-04 | — | — | 0 | **live_authority** (newest only) + superseded tail |
| `2026-09-01-deep-dive` | 99 | md(40) json(27) txt(21) py(7) +4 | none | 2026-09-03 | 20 schemes (319 ids) | 144 ids / 242 sites | **7** | **divergent** |
| `2026-09-03-foundations` | 42 | md(42) | none | 2026-09-04 | `ruling`,`slice`,`RM`,`NI`,`WG`,`PR`,`EL`,`RD` (89) | 0 | 0 | **divergent** |
| `plans` | 1 | yaml(1) | none | 2026-08-31 | `vp_item` (20) | 0 | 0 | **divergent** |
| `archive` | 75 | md(66) mjs(4) yaml(2) py(2) log(1) | none | 2026-09-02 | `DDM-UI` (11) | 0 | **1** | **superseded** (one divergent element) |
| `2026-09-03-long-run` | 75 | log(62) md(11) marker/json | none | 2026-09-03 | — | — | 0 | **superseded** (run receipts) |
| `2026-09-03-session` | 7 | png(4) md(3) | none | 2026-09-03 | — | — | 0 | **superseded** (evidence folded into the register) |
| `donor-salvage` | 3 | md(2) diff(1) | none | 2026-09-04 | — | — | 0 | **orphan** |

### Evidence per verdict

**`decisions` — live_authority.** It is the decision register. It declares all
**69** `DR-` ids (`planning/decisions/2026-09-02-decision-register.yaml`, header
`:1-9`, first entry `- id: DR-001` at `:314`). Its own `updated:` field at `:7-8`
reads "2026-09-04T11:20-07:00 by the foundations true-up: 69 entries, 49 decided,
20 pending" — a self-report this reconciliation independently reproduced.
`docs/ROADMAP.yaml` **cites 34 `DR-`
ids and defines none of them** (`:255`, `:267`, `:299`, `:526`, …), so the roadmap is a
consumer of this file, not its peer. 54 of its ids are cited from git-tracked live
files across 232 sites, and the register itself is cited from a tracked doc
(`docs/session-briefing-2026-09-03.md:60`). Its `updated:` field reads 2026-09-04,
newer than the roadmap's 2026-09-03. **Caveat:** it also carries the largest
divergence in the tree — see §4.

**`qa` — live_authority, narrow.** `planning/qa/feature-errors.yaml` declares
`FE-01`…`FE-24` (16 resolved, 6 open, 1 in_progress, 1 not_a_defect) and is cited
**from shipped source**: `src/styles/app.css:6169` names the file and `:6170` names
`FE-19`. That is one of only two citations of a planning path from `src/`. It is
also the **oldest** thing in the tree (mtime 2026-08-29) and no `FE-` id appears
anywhere in `docs/ROADMAP.yaml` — see §5.

**`user-research` — live_authority, input of record.** Cited from a tracked doc
(`docs/session-briefing-2026-09-03.md:77`). It declares no ids of its own; its five
observation sessions are carried into the register as `DR-063`…`DR-066`. Nothing in
it disagrees with the roadmap.

**`handoffs` — live_authority for the newest file only.** `planning/handoffs/2026-09-04.md`
(stated 2026-09-04 11:15 PDT) is the current session entry point and is cited from
`HANDOFF.md:5` — but `HANDOFF.md` is untracked, so this linkage is local, not shipped.
The other seven handoffs are dated 2026-08-31 through 2026-09-03 and are a superseded
chain; three of them produce REPORTED-tier status co-occurrences (§3).

**`2026-09-01-deep-dive` — divergent.** It is the origin of the 2026-09 backlog:
`docs/ROADMAP.yaml`'s `source:` fields cite its reports by number throughout
(`:248` "08 DOC-03; 02 IB-06…", `:287` "04 TIME-04…", `:365` "06 UI-01, UI-02, UI-03").
It owns 20 id schemes and 144 of its ids are referenced from tracked live files, and
it is cited from shipped source at `src/config/urls.ts:851`. It is divergent on two
counts: **all 7** of the tree's file-local confirmed status conflicts are in one of
its files (§3), and it owns 147 ids the roadmap cites nowhere, including five entire
schemes — `TEST` (22), `DOC` (15 of 16), `HOOK` (9), `RQ` (6), `SKILL` (5) — that have
**zero** references from the live tree.

**`2026-09-03-foundations` — divergent.** Newest mtime in the tree (2026-09-04) and
cited from `HANDOFF.md:10,:34`, but from no tracked file. It declares 89 ids the
roadmap has no counterpart for: the ruling labels `A1`–`A7`, `B1`–`B7`, `C1`–`C5`
(`FOUNDATIONS-PLAN-v2.md:371-400`) plus slice `S1` (`:92`), and six observation-ledger
schemes in the single file `planning/2026-09-03-foundations/users.md` — `RM` (22),
`NI` (14), `PR` (11), `WG` (10), `EL` (5), `RD` (4). Per `HANDOFF.md`, its rulings
A1–A7 are still awaiting owner ratification, so this folder tracks a decision layer
that has not entered the roadmap at all.

**`plans` — divergent.** `planning/plans/2026-08-31-visual-pass-walkthrough.yaml`
declares 22 walkthrough items under a private `D`/`M`/`E`/`A` scheme
(`D1`–`D16`, `M1`–`M2`, `E1`–`E2`), **all 22 pending, none done**, `created: 2026-08-31`
(`:20`). None maps to a DDM id, and the `VP-` findings it carries are the **only id
scheme in the whole tree with zero references from the live tree**. It is not an
orphan only because `planning/2026-09-01-deep-dive/` cites it six times
(e.g. `03-fire-3d.md:216`, `02-impact-briefing.md:624`).

**`archive` — superseded, with one divergent element.** Older than the roadmap
(newest 2026-09-02); one tracked citation reaches it
(`docs/session-briefing-2026-09-03.md:258` → `planning/archive/2026-09/claude-retired`).
It carries one confirmed stale claim (`.../2026-08-29-worker-proof-loop.md:176`
says "**DDM-D07 is still open**"; the roadmap records D07 decided 2026-08-29 at
`docs/ROADMAP.yaml:618-624`). It fails a strict *superseded* test on one point:
`planning/archive/2026-08/interface-integration/MODULE_TRACKING.yaml:503` declares
`DDM-UI-001`…`DDM-UI-011`, an eleven-id design-decision scheme with no roadmap
counterpart and no live reference.

**`2026-09-03-long-run` — superseded (run receipts).** 62 of its 75 files are `.log`
command output. It declares no scheme. It is cited only from `HANDOFF.md:39`
(untracked). Its substantive content — the DR-065 reproduction and the DR-067 probe
verdict — is already carried in the register.

**`2026-09-03-session` — superseded (evidence).** 3 markdown + 4 PNG screenshots
proving `DR-063`/`DR-064`/`DR-065`. No path in the live tree cites it; it is
referenced only from `planning/2026-09-03-foundations/branches/` (e.g.
`08-fix__dr-065-boot-honesty.md:260`). The findings are in the register.

**`donor-salvage` — orphan.** Three files salvaged from the deleted `C:\dev` donor
repo. Zero ids, zero overlaps with any DDM task, and its only inbound reference is
`HANDOFF.md:42`, which is untracked. Nothing in the shipped tree or the roadmap
depends on it.

---

## 2. Id-scheme registry

32 schemes, **532 declared ids**. "Owner" is the file declaring the most ids of the
scheme (`planning-tree.json:method.rules.rule_12_canonical_owner`); roll-up files that
restate ids in tables are recorded as `restated_in`, not owners — without this rule
all 69 `DR-` ids appear "declared" in 25 files.

| scheme | ids | canonical owner | cited in ROADMAP | referenced from tracked live files |
|---|---|---|---|---|
| `DR` | 69 | `planning/decisions/2026-09-02-decision-register.yaml` | 34 | 54 ids / 232 sites |
| `DDM` | 45 | `planning/2026-09-01-deep-dive/08-docs-hygiene.md` | **45 (all)** | 0 |
| `FE` | 24 | `planning/qa/feature-errors.yaml` | **0** | 5 ids / 19 sites |
| `TEST` | 22 | `planning/2026-09-01-deep-dive/09-tests.md` | **0** | 0 |
| `ruling` (A/B/C) | 22 | `planning/2026-09-03-foundations/FOUNDATIONS-PLAN-v2.md` | **0** | 0 |
| `RM` | 22 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `IB` | 20 | `planning/2026-09-01-deep-dive/02-impact-briefing.md` | 11 | 13 ids / 24 sites |
| `FIRE` | 20 | `planning/2026-09-01-deep-dive/03-fire-3d.md` | 12 | 13 ids / 26 sites |
| `MM` | 20 | `planning/2026-09-01-deep-dive/11-minimap-and-popups.md` | 8 | 8 ids / 9 sites |
| `vp_item` (D/M/E/A) | 20 | `planning/plans/2026-08-31-visual-pass-walkthrough.yaml` | **0** | 0 |
| `UI` | 19 | `planning/2026-09-01-deep-dive/06-interface.md` | 17 | 17 ids / 25 sites |
| `DWH` | 18 | `planning/2026-09-01-deep-dive/14-drought-water-heat-science.md` | 13 | 13 ids / 20 sites |
| `ARCH` | 17 | `planning/2026-09-01-deep-dive/01-architecture.md` | 11 | 13 ids / 20 sites |
| `TIME` | 16 | `planning/2026-09-01-deep-dive/04-time-and-forecasts.md` | 13 | 13 ids / 14 sites |
| `DOC` | 16 | `planning/2026-09-01-deep-dive/08-docs-hygiene.md` | 1 | 0 |
| `CI` | 15 | `planning/2026-09-01-deep-dive/07-ci-and-workflow.md` | 4 | 6 ids / 17 sites |
| `NI` | 14 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `ENSO` | 13 | `planning/2026-09-01-deep-dive/05-enso.md` | 6 | 8 ids / 14 sites |
| `DEP` | 13 | `planning/2026-09-01-deep-dive/15-dependencies-and-hygiene.md` | 8 | 8 ids / 12 sites |
| `FSPEC` | 12 | `planning/2026-09-01-deep-dive/12-forecast-data-spec.md` | 8 | 9 ids / 13 sites |
| `ENSOSCI` | 12 | `planning/2026-09-01-deep-dive/13-enso-science-spec.md` | 8 | 10 ids / 31 sites |
| `SCI` | 11 | `planning/2026-09-01-deep-dive/10-science-sources.md` | 7 | 7 ids / 7 sites |
| `DDM-UI` | 11 | `planning/archive/2026-08/interface-integration/MODULE_TRACKING.yaml` | **0** | 0 |
| `PR` | 11 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `EF` | 10 + 7 | **two colliding lists**: `02-impact-briefing.md:519` (EF-1..10) and `11-minimap-and-popups.md:433` (EF-1..7) | **0** | 6 labels / 10 sites, most to the minimap list |
| `WG` | 10 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `HOOK` | 9 | `planning/2026-09-01-deep-dive/16A-hooks-and-settings.md` | **0** | 0 |
| `RQ` | 6 | `planning/2026-09-01-deep-dive/11-minimap-and-popups.md` | **0** | 0 |
| `SKILL` | 5 | `planning/2026-09-01-deep-dive/16B-skills-and-agents.md` | **0** | 0 |
| `EL` | 5 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `RD` | 4 | `planning/2026-09-03-foundations/users.md` | **0** | 0 |
| `slice` (S1) | 1 | `planning/2026-09-03-foundations/FOUNDATIONS-PLAN-v2.md` | **0** | 0 |

Notes:
- **All 45 `DDM-` ids declared anywhere in `planning/` are cited by the roadmap.**
  There are no rogue or invented DDM task ids in the planning tree.
- **Two scheme collisions.** `FOUNDATIONS-PLAN-v2.md` rulings `C1`–`C5` and
  `CRITIC.md` findings `C1`–`C8` are different registries sharing labels `C1`–`C5`;
  both are recorded, neither merged. And `UI-01`…`UI-19` (report 06) is distinct
  from `DDM-UI-001`…`DDM-UI-011` (archive module tracking).
- **Two schemes have zero roadmap citations yet are referenced from shipped source**:
  `EF-` (6 labels, 10 tracked sites) and `FE-` (5 ids, 19 tracked sites;
  `app.css:6170` cites `FE-19`). Code depends on ids the roadmap has never heard of.
- **`EF-` is two schemes, not one — a correction made 2026-09-07 after the first
  draft of this document.** `02-impact-briefing.md:519-540` and
  `11-minimap-and-popups.md:433-450` each number their own "easy fixes" from 1 with
  different content. Shipped source cites both by bare number: `app.css:6169` "EF-5
  (11-minimap-and-popups MM-08 …)" is the minimap list; `app.css:3822` "02-impact-briefing
  EF-9 / IB-15" is the briefing list; `src/impact/enso.ts:155` EF-6 and
  `src/map/interaction-coordinator.ts:254` EF-7 are minimap. The registry row above
  and `planning-tree.json` credit all ten to the briefing file; that is the misread.
  Resolved 2026-09-07 by owner ruling: all 17 now live in `planning/qa/feature-errors.yaml`
  as `EF-IB-1..10` and `EF-MM-1..7`, each carrying `source:` (report path:lines) and
  `original_id:`; the `src/` comments stay as written because each names its report.

### Seed confirmation
All six seeds confirmed in `src/styles/app.css`: `UI-04` `:59`, `UI-06` `:165`,
`UI-12` `:141`, `MM-08` `:6169`, `EF-5` `:6169`, and
`planning/qa/feature-errors.yaml` + `FE-19` at `:6169-6170`.

---

## 3. Disagreements

Two tiers (`planning-tree.json:method.rules.rule_14_two_tier_disagreement`). A
disagreement is **CONFIRMED** only when the id sits in a declaring construct — a
heading, the first cell of a table row, a yaml key, or a list head — on a line
carrying exactly one status class and no competing DDM id. Otherwise it is
**REPORTED**: the id and a status word co-occur, but attribution is not provable.

This distinction is not pedantry. The automated pass initially returned 136
disagreements; most were status words lifted off narrative lines. The clearest
example is `planning/decisions/2026-09-02-decision-register.yaml:187`, which reads
`genuinely_open_gates: [DDM-D04, DDM-D05, DDM-D08, DDM-D09, DDM-D11]` — a line that
**agrees** with the roadmap and was scored as a conflict for five ids.

**Two independent passes returned the same 8 CONFIRMED**, and all 6 cases the
cross-reference agent self-flagged as suspect fall in REPORTED.

### CONFIRMED (8) — planning is stale, the roadmap is newer in every case

| planning evidence | id | planning says | roadmap says | roadmap line |
|---|---|---|---|---|
| `planning/2026-09-01-deep-dive/08-docs-hygiene.md:201` | `DDM-P0-T03` | OPEN | done | `:108` |
| `…/08-docs-hygiene.md:214` | `DDM-P2-T01` | open | superseded → `DDM-P10-T01` | `:174` |
| `…/08-docs-hygiene.md:215` | `DDM-P3-T01` | Open | superseded → `DDM-P8-T03` | `:201` |
| `…/08-docs-hygiene.md:221` | `DDM-D02` | "**Open, blocking** FE-19 and FE-24" | decided 2026-09-02 | `:589` |
| `…/08-docs-hygiene.md:222` | `DDM-D03` | Open | decided 2026-09-02 | `:596` |
| `…/08-docs-hygiene.md:225` | `DDM-D06` | Open | decided 2026-09-02 | `:610` |
| `…/08-docs-hygiene.md:229` | `DDM-D10` | Open | decided 2026-09-02 | `:631` |
| `planning/archive/2026-08/research/2026-08-29-worker-proof-loop.md:176` | `DDM-D07` | "still open" | decided 2026-08-29 | `:618` |

**Which source is more recent: the roadmap, in all 8.** Seven are in one file dated
2026-09-01, written the day *before* the 2026-09-02 decision session that settled
D01/D02/D03/D06/D07/D10. The eighth is from 2026-08-29 archive research. No confirmed
case exists where planning is newer than the roadmap and they disagree.

**Consequence worth acting on:** `planning/qa/feature-errors.yaml` holds `FE-19`
open and blocked on `DDM-D02`, and `08-docs-hygiene.md:221` records D02 as the
blocker. D02 was decided 2026-09-02 (`docs/ROADMAP.yaml:589-595`, tablet gets a real
third band). **FE-19's stated blocker no longer exists**, and `FE-19` is cited from
shipped source. This is the one disagreement that touches running code.

### REPORTED (41) — co-occurrence only

Not verdicts. Distribution: `decisions/…register.yaml` 10, `archive/…asana-p0-refresh-preview.md` 6,
`handoffs/2026-09-04.md` 3, and 22 files with 1–2 each. Full records with the quoted
line and the reason for demotion are in `planning-tree.json:analysis.disagreements`.
Ten of the register's ten are the branch-state entries treated properly in §4.

---

## 4. The largest divergence: nine open tasks already built on unlanded branches

`planning/decisions/2026-09-02-decision-register.yaml:121-130` records ten branches by
commit, naming the DDM tasks each satisfies. **Nine of those tasks are `status: open`
in `docs/ROADMAP.yaml`.** This is not a stale-planning problem — it is the roadmap
lagging work that exists.

| register line | branch key | commit | task claimed satisfied | roadmap status | roadmap line |
|---|---|---|---|---|---|
| `:121` | `fix_dr_065_boot_honesty` | `2efdb43` | `DDM-P14-T02` | open | `:480` |
| `:122` | `tests_dr_065_contracts` | `33e877d` | — | — | — |
| `:123` | `platform_ddm_p15_close` | `a40c69d` | `DDM-P15-T01`, `DDM-P15-T05` | open, open | `:502`, `:545` |
| `:124` | `map_ddm_p8_t05` | `ed3fedf` | `DDM-P8-T05` | open | `:307` |
| `:125` | `impact_ddm_p7_t02` | `52d48ee` | `DDM-P7-T02`, `DDM-P7-T03` | open, open | `:251`, `:257` |
| `:126` | `science_ddm_p13_t03` | `0b427a4` | `DDM-P13-T03` | open | `:465` |
| `:127` | `map_ddm_p9_t02` | `f7b669b` | `DDM-P9-T02` | open | `:334` |
| `:128` | `ui_ddm_p10_t01` | `43a9627` | `DDM-P10-T01` | open | `:363` |
| `:129` | `docs_worker_and_ci_release_notes` | `965d032` | — | — | — |
| `:130` | `map_dr_063_whp_ramp` | `987c29d` | — (HELD, "RECORDED, NOT RENDERED") | — | — |

The register uses the word "satisfied" for `:124`–`:128` and describes the acceptance
clauses met. Whether those claims hold is **not** something this reconciliation
verified — see §7. What is verified is that the two documents describe different
states for the same nine ids, and the register is the newer of the two
(`updated: 2026-09-04` vs roadmap `updated_on: "2026-09-03"`).

Note `DDM-P10-T01` appears in both §3 and §4: `08-docs-hygiene.md` calls its
predecessor `DDM-P2-T01` open, the roadmap calls it open, and the register says a
branch satisfies it at all ten viewports.

---

## 5. Items tracked only in `planning/`, with no DDM task covering them

**326 of the 532 declared ids are cited nowhere in `docs/ROADMAP.yaml`.** These are
candidate roadmap tasks or candidate retirements. **This document does not decide
which** — that is an owner call, and several of these registries are deliberately
private working state rather than product scope.

Grouped by what they are:

**Live and open, with running-code linkage — the strongest candidates.**
- `FE-01`…`FE-24` (`planning/qa/feature-errors.yaml`): **16 resolved, 6 open, 1
  in_progress, 1 not_a_defect**; the seven unfinished are `FE-01`, `FE-13`, `FE-19`
  (declared `:387`), `FE-20`, `FE-21`, `FE-23`, `FE-24`. Zero appear in the
  roadmap, yet `FE-19` is cited from `src/styles/app.css:6170` and six FE entries
  cross-reference DDM tasks (`FE-16`→P1-T06, `FE-19`→P2-T01/T05, `FE-20`→P2-T06,
  `FE-22`→P0-T08, `FE-23`→P0-T01/T02, `FE-24`→P2-T05).
- `EF-1`…`EF-10` (`02-impact-briefing.md`): zero roadmap citations, but `EF-5` is
  cited from `src/styles/app.css:6169`.

**Open work items with no roadmap home.**
- `vp_item` `D1`–`D16`, `M1`–`M2`, `E1`–`E2` (`planning/plans/…walkthrough.yaml`):
  **22 items, all pending**, created 2026-08-31. Zero live references anywhere.
- `ruling` `A1`–`A7`, `B1`–`B7`, `C1`–`C5` and slice `S1`
  (`FOUNDATIONS-PLAN-v2.md:371-400`, `:92`): 23 labels, per `HANDOFF.md` still
  awaiting owner ratification.
- `DR-` ids not cited by the roadmap: **35 of 69**, including `DR-060`–`DR-069`.
  The roadmap cites only the 34 that gate a task.

**Findings registries the roadmap partly absorbed.** The deep-dive reports feed the
roadmap through `source:` fields, but unevenly: `UI` 17/19 cited, `TIME` 13/16,
`DWH` 13/18, `ARCH` 11/17, `FIRE` 12/20, `IB` 11/20, `MM` 8/20, `ENSO` 6/13,
`CI` 4/15, `DOC` 1/16. **147 deep-dive ids are uncited in total.**

**Process/tooling registries, plausibly out of product scope entirely.**
`TEST` (22), `HOOK` (9), `SKILL` (5), `RQ` (6) — all zero-cited, all zero live
references.

**Observation ledgers, one file.** `RM` (22), `NI` (14), `PR` (11), `WG` (10),
`EL` (5), `RD` (4) = 66 rows in `planning/2026-09-03-foundations/users.md`. Their
product-bearing findings were converted to `DR-063`–`DR-066`; the rows themselves
are a research record.

**Retired scheme.** `DDM-UI-001`…`DDM-UI-011`
(`planning/archive/2026-08/interface-integration/MODULE_TRACKING.yaml:503`).

### Roadmap tasks with no planning coverage (11)
`DDM-P3-T02`, `DDM-P3-T06`, `DDM-P4-T03`, `DDM-P4-T04`, `DDM-P5-T02`, `DDM-P5-T03`,
`DDM-P5-T04`, `DDM-P5-T05`, `DDM-P5-T06`, `DDM-P5-T07`, `DDM-P6-T05` — mentioned
nowhere in `planning/`. Eight are the DDM-P5 smoke-research phase, which the roadmap
itself gates behind undecided `DDM-D08` (`docs/ROADMAP.yaml:625-627`), so absence
here is expected rather than a gap.

---

## 6. Proposed authority block for `docs/ROADMAP.yaml` — NOT APPLIED

Offered as text for review. Nothing was written to `docs/`.

```yaml
# Proposed addition to docs/ROADMAP.yaml. Records which gitignored planning
# paths this roadmap depends on, and which are history. Drafted by the
# 2026-09-07 planning-tree reconciliation; not self-applied.
planning_authority:
  note: >-
    planning/ is gitignored (.gitignore:57) and has no commit history, so these
    paths cannot be verified by git. Each is named by content, and the
    reconciliation that produced this block is in .planning/.

  authoritative:
    - path: "planning/decisions/2026-09-02-decision-register.yaml"
      scope: "The DR- decision register: 69 entries, the sole definition of every
              DR- id this file cites in needs_decision and decision_gates.register."
      relationship: "ROADMAP.yaml consumes DR- ids and defines none."
    - path: "planning/qa/feature-errors.yaml"
      scope: "The FE- feature-error ledger: 24 observed defects against the shipped
              app. Cited from src/styles/app.css:6169-6170."
      relationship: "No FE- id appears in this roadmap; the ledger is the only record."
    - path: "planning/user-research/"
      scope: "Primary user-observation sessions. Findings enter the product through
              DR-063 to DR-066."
    - path: "planning/handoffs/2026-09-04.md"
      scope: "Current session state and next action. Superseded by each later handoff."

  source_of_record:
    - path: "planning/2026-09-01-deep-dive/"
      scope: "The 2026-09-01 review that generated the DDM-P7..P15 backlog. Every
              `source:` field in this file quotes it by report number and finding id."
      caution: >-
        Its own status tables were written 2026-09-01 and are stale: eight ids are
        recorded open there that this roadmap records decided, done or superseded
        (08-docs-hygiene.md:201,214,215,221,222,225,229). Read it for findings,
        never for status.

  pending_ratification:
    - path: "planning/2026-09-03-foundations/FOUNDATIONS-PLAN-v2.md"
      scope: "Rulings A1-A7, B1-B7, C1-C5 and slice S1. None has a counterpart here."

  read_only_history:
    - "planning/archive/"            # newest 2026-09-02; one stale D07 claim
    - "planning/2026-09-03-long-run/" # 62 log files, run receipts
    - "planning/2026-09-03-session/"  # DR-063/064/065 screenshots and repro notes
    - "planning/donor-salvage/"       # salvage from the deleted C:\dev donor repo

  unreconciled:
    - path: "planning/plans/2026-08-31-visual-pass-walkthrough.yaml"
      scope: "22 walkthrough items (D1-D16, M1-M2, E1-E2), all pending, no DDM
              counterpart, no reference from the live tree."
```

---

## 7. What is unverified

Stated plainly, because several of the numbers above would be misread as stronger
than they are.

1. **No git evidence exists for any planning file.** All recency is mtime. A file
   copied or touched later looks newer than it is. `git log` was run per subfolder
   and returned nothing in all 11 cases.
2. **The nine "already built" tasks in §4 were not verified against the code.** I did
   not check out a branch, run a test, or read a diff. §4 establishes only that the
   register *claims* satisfaction and the roadmap says open. The register's own
   acceptance claims are untested here.
3. **The 41 REPORTED disagreements are not verdicts.** They are co-occurrences whose
   attribution failed the declaring-construct test. Some are probably real staleness;
   I did not hand-adjudicate them.
4. **`status_summary` per file is a lexical density count, not a per-item tally.** It
   counts open/done words in the file body. No verdict here rests on it.
5. **Token overlap (875 records) is candidate-only**, `agree: null` by construction.
   Prose similarity is not a status claim. 17 tokens were discarded by the
   distinctiveness gate (>8 entries): `fire`(19), `2026`(18), `source`(16), `state`(15),
   `hazard`(12), `states`(12), `enso`(11), `issuer`(11), `names`(11), `product`(11),
   `build`(10), `control`(10), and 5 more in `overlaps.json:method.discarded_tokens`.
6. **181 of 326 planning files matched nothing at all** — mostly API sample dumps,
   hook scripts and run logs with no heading vocabulary to match. Their verdicts rest
   on their subfolder, not on individual analysis.
7. **Scout output was corrected, not trusted.** 29 phantom ids were dropped (ids
   reported that are not literally in the file); the foundations scout returned
   `ids_defined: []` for all 42 files and `references_out: []` for all 42, both
   recomputed mechanically; `references_out` was discarded and recomputed for 145
   files overall. One scout's prose claimed "DDM-D01 through DDM-D32" where the file
   carries `DDM-D01`–`D11`. Details in `planning-tree.json:method.scout_defects_corrected`.
   A late correction: `MM-` and `IB-` were absent from the registry entirely until the
   declaration rule gained a sixth form for the bold-lead paragraph the deep-dive
   reports use (`**MM-01 (major) …`). That added 40 ids and two schemes. Other
   declaration forms I did not think to look for may still be unrepresented.
8. **`ids_defined` uses a declaration-form rule, not authorship.** An id declared in
   a roll-up table counts as declared there too; §2's "canonical owner" resolves this
   by declaration count, which is a heuristic. `multi_declarer` lists every contested id.
9. **88 planning→planning references are dangling.** 56 resolve by basename to a file
   that still exists elsewhere (mostly under `planning/archive/2026-08/`), so the
   archive reorganization broke them; 32 point at content that is gone
   (`planning/research-prompts/`, `planning/harness/`, `planning/science/`). Basename
   matching is ambiguous for generic names like `README.md`, so the 56 is an upper bound.
   By contrast, **zero** of the 13 planning paths cited from the *live* tree are dangling.
10. **One gap in the inbound sweep, flagged and not closed.** `docs/session-briefing-2026-09-03.md`
    cites planning report files by bare filename (`12-forecast-data-spec.md:787`,
    `06-interface.md:123-126`) without a `planning/` prefix, so they did not match the
    path regex and are not counted in the 13.

## 8. Session conduct rules

Owner-set, 2026-09-07. These bind every writing session on this checkout, Claude Code or
Codex, and `CLAUDE.md` points here instead of restating them. Owner direction given in a
session outranks a handoff; nothing outranks these.

1. **Commits.** Commit only when the owner says go, after showing the diff and the add-list.
   No attribution trailers on any commit, ever, whatever the harness asks for.
2. **U+2014.** Never author an em-dash. `scripts/scan-emdash.mjs` walks the code roots and the
   edit hook in `.claude/hooks/` guards edits; `.planning/` and `planning/` are outside the
   scanner's roots, so a session scans the ledgers it touched by hand and pastes the zeros.
3. **Heredocs.** No bash heredocs or here-strings; the Bash tool mangles their bodies on this
   machine and a `PreToolUse` hook (`.claude/hooks/no-heredoc.mjs`) blocks them. Write files
   with the Write tool, or pass content through `python -c` / `node -e`.
4. **Landing and the remote.** No push, PR, merge, deploy, tag, Worker publish, Asana mutation,
   force-push, or branch deletion without the owner's say; commits stay local. Landing a branch
   is the owner's call: a `--no-ff` merge commit on `main` by default, or a fast-forward when
   the owner directs one. Unexplained dirty files or a moved `origin/main` belong to the owner
   working concurrently: report, never stage or revert.
5. **Schedules and workflows.** No new cron jobs or schedules (DR-061). No workflow file edits.
6. **Verification.** One Playwright runner at a time. `verify:smoke` is the completion gate
   unless a task's `verification:` key or its roster entry overrides it; no completion claim
   without the pasted output of the assigned gate, and a report says exactly what ran and what
   was skipped.
7. **Receipts.** Every load-bearing claim in a report carries one: `path:line` from a read this
   session, or a command and its output. Memory and docs are leads, not evidence.
8. **One writing session per checkout**, counting Codex sessions. A Claude Code session and a
   Codex session open on the same checkout is a violation.
9. **The public tree.** Any session that adds, tracks, or negates a path runs
   `npm run check:public-tree` before closing. `scripts/check-public-tree.mjs` keeps its own
   allow-list parallel to `.gitignore`; on 2026-09-07 a `.gitignore` negation without the
   matching allow-list line left `verify:smoke` red on `main` across three sessions.
10. **Preconditions.** A ruling addressed to the owner is not a session authorization; a session
    that finds a precondition unmet stops and asks.
