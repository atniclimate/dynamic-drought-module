# Branch Audit Report

- **Date:** 2026-09-07
- **Main SHA:** 5be15f5 (`Merge branch 'docs/roadmap-gate-transcription-2026-09-03'...`)
- **Method:** For the ten register branches, `npm run verify:quick` was run one branch at a
  time (never two concurrently). Seven of the ten already had a git worktree checked out
  outside this repo at `C:/dev/_wt/<slug>`, pre-existing before this audit started, each with
  its own real (non-junction) `node_modules` already installed. Those were used read-only, in
  place, rather than duplicated — see the "Deviation from the prescribed method" note below.
  The remaining three (`tests/dr-065-contracts`, `docs/worker-and-ci-release-notes-2026-09-03`,
  `map/dr-063-whp-ramp`) had no existing worktree, so each was built fresh under
  `I:/ddm-audit-worktrees/<slug>/`, given a Windows directory junction onto this repo's own
  `node_modules` (`package.json`/`package-lock.json` were unchanged vs. main on all three, so
  `npm ci` was not needed), run, then the junction and the worktree were both removed before
  moving to the next branch. No two `verify:quick` runs overlapped.
- **One-runner-at-a-time rule:** followed throughout; each of the ten runs was started only
  after the previous one's process had exited and, for the three fresh worktrees, only after
  that worktree's junction and worktree removal had completed.

## Deviation from the prescribed method (report as instructed, not silently worked around)

The task said to create all ten worktrees under `I:/ddm-audit-worktrees/`. On inventorying the
repo, seven of the ten register branches were already checked out as worktrees elsewhere
(`C:/dev/_wt/ddm-dr065fix`, `ddm-p10t01`, `ddm-p13t03`, `ddm-p15`, `ddm-p7t02`, `ddm-p8t05`,
`ddm-p9t02` — not created by this audit, not listed in the register, evidently left over from
the session that produced these branches on 2026-09-03). Because a branch already checked out
in one worktree cannot be checked out again in a second worktree (`git worktree add` refuses
it), and because the read-only mandate forbids touching or removing worktrees this audit did
not create, this audit ran `verify:quick` directly in those seven pre-existing worktrees
in place instead of duplicating them under `I:/ddm-audit-worktrees/`. They were left exactly as
found (all seven show clean `git status`, verified before and not modified). Only the three
branches with no pre-existing worktree were built and torn down under
`I:/ddm-audit-worktrees/`, per the letter of the instructions. Everything else in the
instructions (junction-vs-npm-ci decision, serial execution, cleanup, only `BRANCH_REPORT.md`
as durable output inside the repo) was followed as written.

## Table A — all 22 local branches

| Branch | Tip SHA | Tip date (local) | Ahead / Behind vs main | Merged into main? | Upstream tracking | Register key |
|---|---|---|---|---|---|---|
| main | 5be15f5 | 2026-09-03 16:17:03 -0700 | 0 / 0 | — (is main) | origin/main | — |
| briefing/dr-024-058-wording | 0aeef0f | 2026-09-03 03:56:22 -0700 | 0 ahead / 11 behind | MERGED | origin/branch, up to date | not in register |
| chore/housekeeping-2026-09-03 | f38575b | 2026-09-03 11:37:14 -0700 | 0 ahead / 7 behind | MERGED | origin/branch, up to date | not in register |
| docs/bookkeeping-2026-09-03 | 7b1b016 | 2026-09-03 00:16:05 -0700 | 0 ahead / 15 behind | MERGED | origin/branch, up to date | not in register |
| docs/decision-session-2026-09-02 | e263499 | 2026-09-02 22:48:45 -0700 | 0 ahead / 23 behind | MERGED | origin/branch, up to date | not in register |
| docs/roadmap-gate-transcription-2026-09-03 | 860c4b2 | 2026-09-03 14:52:22 -0700 | 0 ahead / 7 behind | MERGED | origin/branch, up to date | not in register |
| docs/worker-and-ci-release-notes-2026-09-03 | 965d032 | 2026-09-03 19:29:34 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | docs_worker_and_ci_release_notes |
| feature/nifc-perimeter-evidence | 905671d | 2026-08-18 16:13:41 -0700 | 8 ahead / 206 behind | unmerged | origin/branch, up to date | not in register |
| fix/dr-065-boot-honesty | 2efdb43 | 2026-09-03 17:14:12 -0700 | 2 ahead / 2 behind | unmerged | origin/branch, up to date | fix_dr_065_boot_honesty |
| impact/ddm-p7-t02-briefing-matrix | 52d48ee | 2026-09-03 18:31:36 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | impact_ddm_p7_t02 |
| integration/2026-09 | 4e0e388 | 2026-09-02 08:49:24 -0700 | 0 ahead / 29 behind | MERGED | origin/branch, up to date | not in register |
| map/ddm-p8-t05-surface-continuity | ed3fedf | 2026-09-03 18:22:50 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | map_ddm_p8_t05 |
| map/ddm-p9-t02-capability-honesty | f7b669b | 2026-09-03 19:26:10 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | map_ddm_p9_t02 |
| map/dr-063-whp-ramp | 987c29d | 2026-09-03 12:27:26 -0700 | 1 ahead / 8 behind | unmerged | origin/branch, up to date | map_dr_063_whp_ramp (HELD) |
| map/dr-064-perimeter-ribbon | 4d49192 | 2026-09-03 13:05:57 -0700 | 0 ahead / 7 behind | MERGED | origin/branch, up to date | not in register |
| maplibre-6/step-1-style-spec-casts | db16277 | 2026-09-02 23:53:06 -0700 | 0 ahead / 19 behind | MERGED | origin/branch, up to date | not in register |
| platform/ddm-p15-close | a40c69d | 2026-09-03 17:45:16 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | platform_ddm_p15_close |
| science/ddm-p13-t03-gridded-index | 0b427a4 | 2026-09-03 18:51:32 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | science_ddm_p13_t03 |
| tests/dr-065-contracts | 33e877d | 2026-09-03 16:33:03 -0700 | 1 ahead / 2 behind | unmerged | origin/branch, up to date | tests_dr_065_contracts |
| ui/ddm-p10-t01-tablet-band | 43a9627 | 2026-09-03 19:35:44 -0700 | 1 ahead / 0 behind | unmerged | origin/branch, up to date | ui_ddm_p10_t01 |
| v6-followups/2026-09-03 | c1ed2f1 | 2026-09-03 01:19:40 -0700 | 0 ahead / 13 behind | MERGED | origin/branch, up to date | not in register |
| verify/dr-052-followups | 0a24fd3 | 2026-09-03 04:59:03 -0700 | 0 ahead / 10 behind | MERGED | origin/branch, up to date | not in register |

"Merged into main" = `git merge-base --is-ancestor <branch> main` returns true, i.e. the
branch's own tip commit is reachable from main (these were landed as ordinary merge commits,
not squashes — main's recent log literally contains several of these SHAs as merge-parent
commits, e.g. `860c4b2` and `4d49192`). Every one of the 22 branches has `origin/<name>`
tracking with no ahead/behind marker against its own upstream, i.e. every local branch is in
sync with its pushed remote counterpart.

## Table B — the ten register branches

| Branch | Register key | Commit confirmed? | Tasks claimed | Ahead / Behind main | verify:quick | Files changed vs main | Touches RELEASE_NOTES.md | Touches app.css |
|---|---|---|---|---|---|---|---|---|
| fix/dr-065-boot-honesty | fix_dr_065_boot_honesty | YES, tip = 2efdb43 | DDM-P14-T02 | 2 ahead / 2 behind | PASS, 4s | 5 files, +443/-26 | YES | YES |
| tests/dr-065-contracts | tests_dr_065_contracts | YES, tip = 33e877d | (tests only) | 1 ahead / 2 behind | PASS, 3s | 2 files, +534/-0 | no | no |
| platform/ddm-p15-close | platform_ddm_p15_close | YES, tip = a40c69d | DDM-P15-T01, DDM-P15-T05 | 1 ahead / 0 behind | PASS, 3s | 11 files, +680/-37 | YES | no |
| map/ddm-p8-t05-surface-continuity | map_ddm_p8_t05 | YES, tip = ed3fedf | DDM-P8-T05 | 1 ahead / 0 behind | PASS, 3s | 5 files, +458/-12 | YES | no |
| impact/ddm-p7-t02-briefing-matrix | impact_ddm_p7_t02 | YES, tip = 52d48ee | DDM-P7-T02, DDM-P7-T03 | 1 ahead / 0 behind | PASS, 3s | 17 files, +1101/-300 | YES | YES |
| science/ddm-p13-t03-gridded-index | science_ddm_p13_t03 | YES, tip = 0b427a4 | DDM-P13-T03 | 1 ahead / 0 behind | PASS, 3s | 5 files, +221/-23 | YES | no |
| map/ddm-p9-t02-capability-honesty | map_ddm_p9_t02 | YES, tip = f7b669b | DDM-P9-T02 | 1 ahead / 0 behind | PASS, 3s | 4 files, +227/-11 | YES | no |
| ui/ddm-p10-t01-tablet-band | ui_ddm_p10_t01 | YES, tip = 43a9627 | DDM-P10-T01 | 1 ahead / 0 behind | PASS, 3s | 3 files, +578/-27 | YES | YES |
| docs/worker-and-ci-release-notes-2026-09-03 | docs_worker_and_ci_release_notes | YES, tip = 965d032 | (docs only) | 1 ahead / 0 behind | PASS, 2s | 1 file, +22/-0 | YES | no |
| map/dr-063-whp-ramp | map_dr_063_whp_ramp | YES, tip = 987c29d | (HELD; "RECORDED, NOT RENDERED") | 1 ahead / 8 behind | PASS, 3s | 6 files, +203/-1 | YES | no |

All ten `verify:quick` runs passed cleanly (`tsc --noEmit`, `scan:emdash`, `check:vocabulary`,
`check:coverage` all clean, no failures anywhere) with no `npm ci` needed on any of the three
freshly built worktrees — `package.json`/`package-lock.json` are unchanged vs. main on all ten
branches, including `platform/ddm-p15-close`, whose register text describes dependency-related
work (the Overture pin, biome bump) but which does not touch either lockfile relative to main.

Note beyond what the register called out: `fix/dr-065-boot-honesty` also touches
`src/styles/app.css` — a third branch in that set, alongside the two the register already
flags (`ui/ddm-p10-t01-tablet-band` and `impact/ddm-p7-t02-briefing-matrix`). This matters
only if `fix/dr-065-boot-honesty` lands before those two are resolved; per the suggested order
below it lands last, after both.

## Owner's suggested landing order (quoted verbatim)

From `planning/decisions/2026-09-02-decision-register.yaml`, lines 113-120
(`suggested_landing_order`, under `awaiting_go_2026_09_03_pm`):

> Lowest conflict first: docs/worker-and-ci-release-notes-2026-09-03, then
> platform/ddm-p15-close, then map/ddm-p9-t02-capability-honesty, then
> science/ddm-p13-t03-gridded-index, then map/ddm-p8-t05-surface-continuity, then
> impact/ddm-p7-t02-briefing-matrix, then ui/ddm-p10-t01-tablet-band (conflicts with the
> briefing branch in src/styles/app.css), then fix/dr-065-boot-honesty with
> tests/dr-065-contracts immediately after it. The last three are the only ones needing
> real thought.

(`map/dr-063-whp-ramp` is not in this order — line 130 records it as HELD by the owner
separately from the nine "awaiting go" branches, and the register's own note at lines 107-108
says nine, not ten, are in this landing queue.)

## One session from closed

Nine of the ten register branches PASSED verify:quick, are NOT held, and their tasks are
`open` in docs/ROADMAP.yaml. Of those nine, seven are ahead of main with **zero** commits
behind (main did not move since their base) and are the closest to a clean land:

- **docs/worker-and-ci-release-notes-2026-09-03** — docs only, 0 behind, PASS
- **platform/ddm-p15-close** — DDM-P15-T01, DDM-P15-T05, 0 behind, PASS
- **map/ddm-p9-t02-capability-honesty** — DDM-P9-T02, 0 behind, PASS
- **science/ddm-p13-t03-gridded-index** — DDM-P13-T03, 0 behind, PASS
- **map/ddm-p8-t05-surface-continuity** — DDM-P8-T05, 0 behind, PASS
- **impact/ddm-p7-t02-briefing-matrix** — DDM-P7-T02, DDM-P7-T03, 0 behind, PASS
- **ui/ddm-p10-t01-tablet-band** — DDM-P10-T01, 0 behind, PASS (conflicts with the briefing
  branch in `src/styles/app.css`, per the register — land in the suggested order)

Two more PASSED but are NOT at zero-behind, so "one session from closed" for these also means
resolving a rebase/merge against 2-8 newer main commits first, not just a conflict-free land:

- **fix/dr-065-boot-honesty** — DDM-P14-T02, PASS, but 2 behind main (based on 2835091, not
  5be15f5)
- **tests/dr-065-contracts** — tests only, PASS, but 2 behind main (same base as above)

**map/dr-063-whp-ramp** PASSED verify:quick and is technically buildable, but it is explicitly
HELD by the owner ("RECORDED, NOT RENDERED" — landing it was a flat stop condition for the
2026-09-03 run) and is 8 behind main, so it is excluded from "one session from closed" despite
the clean test run.

## Needs work first

No register branch FAILED verify:quick — nothing in this section on that basis. The two
items that need more than a trivial land, ordered by how much main has moved past their base:

- **map/dr-063-whp-ramp**: 8 behind main, HELD by owner decision (not a technical blocker —
  see above).
- **fix/dr-065-boot-honesty** and **tests/dr-065-contracts**: each 2 behind main; the register
  itself calls these "the last three [with tests/dr-065-contracts] ... the only ones needing
  real thought" for landing order, separate from the rebase gap noted here.

## Not in the register

11 branches were not claimed by any register key (the task text anticipated 12; the actual
count of non-register branches among the 22 total is 11 — 21 non-main branches minus the 10
register branches). Guesses at what each is are marked GUESS and based only on branch name and
tip commit subject; none of these were opened or diffed in depth for this audit.

| Branch | Merged? | Guess (flagged as guess) |
|---|---|---|
| briefing/dr-024-058-wording | MERGED | GUESS: wording fix for DR-024/DR-058 in the briefing panel — naming a bounding box and rephrasing perimeter-lineage language in plain language. |
| chore/housekeeping-2026-09-03 | MERGED | GUESS: the 2026-09-03 housekeeping sweep (Overture pin, Worker dependency watch/compat pin) referenced in MEMORY as merged into main via ebdfe82. |
| docs/bookkeeping-2026-09-03 | MERGED | GUESS: Asana/roadmap bookkeeping — closes DDM-P0-T03 and records the MapLibre 6.6.0 landing; likely the source of the 2026-08-29/09-02 Asana refresh described in memory. |
| docs/decision-session-2026-09-02 | MERGED | GUESS: writes up the 2026-09-02 evening decision-register rulings and closes two roadmap items — likely the branch that produced `planning/decisions/2026-09-02-decision-register.yaml` itself. |
| docs/roadmap-gate-transcription-2026-09-03 | MERGED | Confirmed, not a guess: this is 860c4b2, main's own second-most-recent commit ("docs: transcribe three decided gates and clear their needs_decision blocks"), per `git log` on main. |
| feature/nifc-perimeter-evidence | unmerged, 8 ahead / 206 behind | GUESS: an old, stale NIFC fire-perimeter evidence/UI branch (tip about closing a superseded panel before a cancellation reopen) dated 2026-08-18, far behind current main — likely superseded by `map/dr-064-perimeter-ribbon`, which did land. |
| integration/2026-09 | MERGED | GUESS: the September integration wave's release-notes/merge branch described in memory as "integration/2026-09 (10 commits at 508e1c7...) + landing by merge commit" — now folded into main. |
| map/dr-064-perimeter-ribbon | MERGED | Confirmed, not a guess: this is 4d49192, main's own commit ("map: the mapped fire perimeter stands up as a ribbon in the 3D scene"), per `git log` on main and per MEMORY. |
| maplibre-6/step-1-style-spec-casts | MERGED | GUESS: an early step of the MapLibre 6 migration (style-spec type casts) that recorded the measured 6.6.0 cost against gate DDM-D01; consistent with memory's account of the MapLibre 6.6.0 landing (993f5ca) being merged in stages. |
| v6-followups/2026-09-03 | MERGED | GUESS: post-MapLibre-6-landing follow-up work (3D control vs. gate agreement, URL catalog entry-chunk change) — matches memory's "v6 migration on its own branch after the first landing" note. |
| verify/dr-052-followups | MERGED | GUESS: DR-052 verification follow-ups — a pure test lane, a boot-idle seam fix, a consolidated NADM verdict, and a dedupe bound; likely test-infrastructure hardening merged alongside the other September work. |

## Unverified

- **Whether the seven pre-existing `C:/dev/_wt/*` worktrees' installed `node_modules` are
  fully current** for their branch (e.g. whether `npm ci`/`npm install` was re-run there after
  each branch's last commit) was not independently re-verified beyond confirming `git status`
  was clean and `node_modules/` exists as a real directory dated at or after each branch's tip
  commit time. `verify:quick` itself does not touch `node_modules` beyond what's already
  resolved, so a stale install would most likely show up as a `tsc`/script failure, and none
  did — but this audit did not diff those installs against `package-lock.json`.
- **Why nine "awaiting go" branches ballooned to ten** with `map/dr-063-whp-ramp` added: the
  register's own note (lines 107-108) says nine branches are pushed and unlanded, and the
  suggested landing order names only nine; `map/dr-063-whp-ramp` is separately described at
  line 130 as HELD from the morning. This audit did not attempt to adjudicate whether it
  should be treated as a tenth candidate for landing or purely held — that is an owner
  decision already recorded as HELD, not something this audit can resolve further.
- **The exact reason the task prompt expected 12 non-register branches** where this audit
  found 11: not established. Every one of the 22 local branches was enumerated and matched
  (10 register + 11 not-in-register + main = 22), so this audit is confident in the count of
  22 and in the 10/11 split, but cannot explain the discrepancy against the prompt's "12."
- **DDM-P15-T05's exact roadmap status** (it is described in the register as a task the
  `platform/ddm-p15-close` branch itself *created* in docs/ROADMAP.yaml, rather than one that
  pre-existed as open) was not cross-checked against the current on-disk docs/ROADMAP.yaml
  content in this audit beyond the prompt's own statement that all nine claimed tasks are
  `status: open`.

## Final state confirmation

`git worktree list` (only the main tree remains from anything this audit created; the seven
`C:/dev/_wt/*` entries are pre-existing and were not touched):

```
I:/dynamic-drought-module 5be15f5 [main]
C:/dev/_wt/ddm-dr065fix   2efdb43 [fix/dr-065-boot-honesty]
C:/dev/_wt/ddm-p10t01     43a9627 [ui/ddm-p10-t01-tablet-band]
C:/dev/_wt/ddm-p13t03     0b427a4 [science/ddm-p13-t03-gridded-index]
C:/dev/_wt/ddm-p15        a40c69d [platform/ddm-p15-close]
C:/dev/_wt/ddm-p7t02      52d48ee [impact/ddm-p7-t02-briefing-matrix]
C:/dev/_wt/ddm-p8t05      ed3fedf [map/ddm-p8-t05-surface-continuity]
C:/dev/_wt/ddm-p9t02      f7b669b [map/ddm-p9-t02-capability-honesty]
```

`git status --porcelain` (matches the pre-existing state noted at the top of this task —
nothing else was written under the repo):

```
 M docs/ROADMAP.yaml
?? .planning/
```
