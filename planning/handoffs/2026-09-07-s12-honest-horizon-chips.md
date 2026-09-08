# S12 handoff: honest horizon chips (DDM-P8-T03)

Branch `feature/horizon-chips-p8t03` from `main` at `c07ec915eaa0086d9dcd4de7a9f4bac7d6feb786`,
**unpushed and unmerged**. Gates: `verify:quick` clean; `verify:smoke` **125 passed, 1 skipped,
4.8m** (the skip is the `tests/ux1-surfaces.spec.ts:98` quarantine from `0121cef`, as S09-S11
reported); `check:public-tree` clean, 558 tracked files. Zero U+2014 on added lines (scanned by
hand below, `planning/` and `.planning/` being outside `scripts/scan-emdash.mjs`'s roots).

## Precondition 1, as re-run mid-session

`git status --porcelain` was **not** empty at session start: one dirty, unstaged file,
`planning/2026-09-01-deep-dive/claude-tooling/hooks/no-heredoc.mjs` (130 insertions, 24 deletions),
your in-progress hardening of the heredoc-detection scanner. Per conduct rule 4 and the standing
note that unexplained dirty `planning/` files are yours, this session stopped and asked rather than
staging, stashing, or reverting it. You ruled it accepted with one condition: run the 13-case table
against `heredocOperator()`, fix any deny case that failed, then commit the draft alone on `main`
(not on this feature branch) with no trailers.

**The table found 3 real failures**, all deny cases passing through a nested quote a shell invoker
would itself read as code: `bash -c "cat <<EOF"`, `sh -c 'read x <<<y'`, and
`node -e "child_process.execSync('cat <<EOF')"`. The fix adds `invokerArguments()` /
`invokerHeredocOperator()`: it finds a `bash|sh|zsh|dash -c` or `node -e`/`--eval` invoker's quoted
argument and rescans it RAW (no quote- or arithmetic-skipping of its own), because at that depth the
outer shell's quoting no longer applies and a hidden operator should be caught rather than missed.
`python -c` is deliberately excluded, matching your instruction, since its payload is Python source
where `<<` is ordinarily a left shift. All 13 cases pass (0 failures), and the structured
`permissionDecision` deny plus exit 2 still accompanies every deny case (verified via
`child_process.spawnSync`, not the Bash tool directly: my first attempt to pipe a JSON test payload
containing the literal substring `<<EOF` into the hook tripped the **currently-installed** (still
old, naive-regex) hook on my own Bash tool call, live-demonstrating the exact false-positive class
this draft fixes). `check:public-tree` clean. Committed alone on `main` as `c07ec915eaa0086d9dcd4de7a9f4bac7d6feb786`,
no trailers, `.claude/` untouched (not installed, per your instruction that `.claude/` is yours).
Precondition 1 then held (clean tree, `bf444b1` an ancestor, HEAD = `c07ec915`, 1 local commit
ahead of `origin/main` as expected since nothing is pushed), and this session's own branch was cut
from that commit.

## What R1-R4 mean and why they resolve what S10/S11 left open

S10 (`2026-09-07-s10-horizon-chrome.md`) built `src/impact/horizon-chrome.ts` as the briefing
panel's one heading table and explicitly punted the harder question: the map shell's chips
(`src/ui/island/shell.tsx`) and the panel-foot response line (`src/ui/island/panel-response.tsx`)
still read a **separate** table, `TEMPORAL_HORIZON_CHIP_LABELS` in `src/config/clusters.ts`
(`"Current"` / `"Weeks ahead"` / `"Season ahead"`), whose own doc comment (`clusters.ts:72-78`)
said reconciling the two vocabularies "is an owner ruling, not a refactor." S11 carried the same
finding forward, untouched. Today's prompt is that ruling.

### The sweep, before any edit (precondition 4)

    src/config/clusters.ts:57-63     TEMPORAL_HORIZON_LABELS (cadence prose "next seven
                                      days"), zero production consumers -> removed
    src/config/clusters.ts:80-86     TEMPORAL_HORIZON_CHIP_LABELS ("Current"/"Weeks
                                      ahead"/"Season ahead") -> removed
    src/ui/island/shell.tsx:47,427   the shell's horizon chip row -> now reads
                                      HORIZON_CHROME via SHELL_HORIZON_KEY
    src/ui/island/panel-response.tsx:46,82   the panel-foot "<view> · <horizon>" line ->
                                      same table, title only
    tests/heat-h1-heatrisk.spec.ts:7,349   the only real consumer of
                                      TEMPORAL_HORIZON_LABELS, a test pin -> re-pointed
    src/impact/horizon-chrome.ts:23-27   its own comment naming TEMPORAL_HORIZON_LABELS
                                      as deliberately separate -> rewritten
    src/impact/briefing.ts, src/ui/impact-panel.ts   already read HORIZON_CHROME (S10);
                                      untouched, still correct
    src/config/presets.ts:97-99, tests/helpers.ts:111   VIEW_PRESETS' "Season ahead"
                                      scene chip -> a DIFFERENT feature (question-first
                                      quick views), not a temporal horizon; coincidental
                                      word overlap only; NOT renamed, NOT in scope; the
                                      acceptance spec's DOM sweep excludes `.preset-chip`
                                      by name rather than being defeated or falsely
                                      flagging it

Every shell-chip site's content, for R1's STOP condition (an issuer's own product term):
`current` routes each hazard's CURRENT recipe (USDM, NIFC perimeters, active alerts, SST anomaly);
`weeks-ahead` routes the near-term recipe (CPC extended outlooks, HeatRisk, SPC fire weather, SST
anomaly again); `season-ahead` routes the long-range recipe (CPC seasonal outlook, WHP, SST
anomaly again). None of the three chip words is itself an issuer's product name (unlike, say, "CPC
Seasonal Drought Outlook", which lives in claim text, not chip text); the STOP condition did not
fire.

### R1: one grammar

`horizon-chrome.ts` gained `SHELL_HORIZON_KEY: Record<TemporalHorizonKey, HorizonKey>`
(`current->current`, `weeks-ahead->nearTerm`, `season-ahead->longRange`), the map shell's routing
keys stay untouched (recipes, URL tokens, `TEMPORAL_HORIZON_KEYS` all still key on
`TemporalHorizonKey`; only the DISPLAY text moved). `shell.tsx`'s chip row now renders
`HORIZON_CHROME[SHELL_HORIZON_KEY[key]].title` and `.subtitle` as two stacked lines
(`.shell-horizon-btn-title` / `.shell-horizon-btn-sub`); `panel-response.tsx`'s inline
`"<view> · <horizon>"` line reads the same table's title only. `TEMPORAL_HORIZON_CHIP_LABELS` is
deleted outright (its only readers were exactly those two files).

`TEMPORAL_HORIZON_LABELS` (the separate cadence-prose table, `'next seven days'` etc.) had **zero
production consumers** by 2026-09-07 (grep confirmed: only its own definition, `horizon-chrome.ts`'s
disambiguating comment, and the `heat-h1-heatrisk.spec.ts:349` test pin). Between "derived view over
`HORIZON_CHROME`" and "removed", removed is the smaller diff by a wide margin: `HORIZON_CHROME`'s
existing values (`'days to weeks'` etc.) are not the same strings as the cadence table's
(`'next seven days'`), so a "derived view" preserving the pinned value would have meant extending
`HORIZON_CHROME`'s shape for an export nothing renders. Removed.

**R2**, the `:349` pin: it tested `TEMPORAL_HORIZON_LABELS['weeks-ahead']` (`'next seven days'`),
not `TEMPORAL_HORIZON_CHIP_LABELS`. With the table gone, the pin is re-pointed at the actual new
single source, `HORIZON_CHROME.nearTerm.subtitle` (`'days to weeks'`), same strength
(`toBe`, exact string equality), test renamed to describe what it now verifies. No assertion was
weakened or dropped; the value it pins changed because the table it pinned no longer exists.

Shell-chip CSS: the pill (`border-radius: 999px`, `flex: 1`) previously held one short word. Two
stacked lines needed `flex-direction: column` and a `.shell-horizon-btn-sub` rule (9px, matching
the codebase's existing 9px floor elsewhere pending DR-038's separate 10px-floor ruling; not a new
size below what already ships). No new color: the subtitle inherits the button's own `color`. The
existing `min-height: var(--touch-target)` rule at the coarse-pointer tablet breakpoint
(`app.css:7046`) still applies and was not touched; `tests/interface-responsive.spec.ts:612` (the
44px floor check) passed in `verify:smoke`.

### R3 and R4: the observed/outlook tag

**The inventory** (every `makeClaim` call site feeding the 4x3 matrix, by hazard/horizon):

| Hazard | Horizon | Lane(s) | Evidence | Tag |
| --- | --- | --- | --- | --- |
| drought | current | usdm | analyzed, derived (wildfire companion) | observed, observed |
| drought | current | dsci | analyzed | observed |
| drought | nearTerm | cpcExtended | outlook | outlook |
| drought | longRange | waterSupply | observed, outlook | observed, outlook |
| drought | longRange | cpcSeasonal | outlook (fixed prose) | outlook |
| fire | current | nifc, nwsAlerts | observed, observed | observed, observed |
| fire | nearTerm, longRange | (none) | -- | CELL_ABSENCE, no tag |
| heat | current | nwsAlerts | observed | observed |
| heat | nearTerm | heatRisk, nwsForecast | classified, outlook | observed, outlook |
| heat | longRange | (none) | -- | CELL_ABSENCE, no tag |
| enso | current | enso | derived, analyzed x2 | observed, observed, observed |
| enso | nearTerm | enso | analyzed (the DR-031 weekly claim) | observed |
| enso | longRange | enso | derived, outlook (probabilities) | observed, outlook |

Five evidence classes are actually used: `observed`, `analyzed`, `classified`, `derived`,
`outlook`. `modeled` and `modeled-analysis` are unused anywhere in `src/` as of this ruling.

R3's literal rule covers three: `outlook -> outlook`, `analyzed -> observed`,
`derived -> observed`. `observed -> observed` is the trivial identity case. **`classified` is not
named in R3.** It renders `observed` by extension: `EVIDENCE_PRESENTATION` already gives it the
`'observation'` tone (an issuer's own classification of a currently valid state, HeatRisk's 0-4
class at the selected point and frame, not a forecast), and its one call site's text
(`sources.ts:251-330`, `fetchHeatRiskClaims`) confirms this: "an issuer-published 0-4
classification; no DDM category is calculated." Recorded in `src/impact/evidence.ts`'s own comment
and in decision-register entry `DR-070`.

**No claim needed R3's suppression escape hatch.** Every `derived` claim's text was read against
the "would this tag misdescribe it" test: the USDM wildfire companion ("Drought raises the odds...
it does not by itself start fires", a present-tense inference, not a probability), the ENSO
index-state read ("an index-state read of the season now in progress"), and the ENSO tendency read
(the DR-030/S11-cited El Nino/La Nina/neutral sentences, which explicitly deny being a forecast),
none reads as an issuer outlook. No per-claim override field was added to `SourcedClaim`; if a
future claim needs one, `CLAIM_REGISTER_TAG` in `src/impact/evidence.ts` is a plain
`Record<EvidenceClass, ...>` and would need a claim-level exception mechanism added at that time,
not before.

**Where it renders.** `src/ui/claim-render.ts`'s `renderClaim()` appends
`<span class="impact-claim-register">${tag}</span>` to the existing source-line paragraph,
after the date, matching the existing `.impact-claim-date`'s middle-dot separator convention. CSS:
two small rules in `app.css`, no new color (inherits `.impact-claim-source`'s `var(--fg-2)`), no
motion. **R4** (absence cells carry no tag) is true by construction, not by a special case:
`CELL_ABSENCE` prose renders through `cell.note` in `impact-panel-runtime.ts`'s `renderCell()`,
never through `renderClaim()`.

## The acceptance spec, and what it proves live versus at the model level

`tests/horizon-chips.spec.ts`, in `verify:smoke`, six tests:

1. Every shell chip's title and subtitle equal `HORIZON_CHROME[SHELL_HORIZON_KEY[key]]` (live
   browser), and no "Weeks ahead"/"Season ahead" survives anywhere in the DOM except
   `.preset-chip` (VIEW_PRESETS, excluded by name, a different feature).
2. R3's literal mapping, asserted directly against `CLAIM_REGISTER_TAG`.
3. Every one of the five used evidence classes, run through `makeClaim` + `renderClaim`, renders
   exactly one `.impact-claim-register` matching the ruled tag (model-level, no browser).
4. No tag word contains "forecast".
5. Live in the browser (the bundled ENSO fixture, adapted from `tests/enso-horizons.spec.ts`): all
   three ENSO horizons render the correct tag on every real claim. `longRange` shows only
   `observed` with this fixture, because the bundled snapshot carries no `probabilities` block (no
   CPC-odds claim activates); `outlook`'s correctness is proven by test 3 instead, against every
   evidence class the app actually builds, not just what one fixture happens to populate.
6. R4 live: `fire`/`nearTerm`, `fire`/`longRange`, `heat`/`longRange` (the three lane-less cells
   with the other lanes stubbed empty) render `CELL_ABSENCE` prose and zero register tags.

## The acceptance clauses, with receipts, and why ROADMAP was not flipped

`docs/ROADMAP.yaml:325`, three clauses:

1. **"A horizon a hazard cannot answer is absent or visibly disabled with its reason."** Not
   touched this session. This is `shell.tsx`'s pre-existing `customHorizonDisabledReason` /
   `aria-disabled` behaviour (S3-era), unchanged by R1-R4. No fresh receipt from this session;
   carried, not re-verified.
2. **"every hazard surface states its time in one grammar."** Satisfied for horizon **naming**:
   the shell chips, the panel-foot line, and the briefing panel headings now all read
   `HORIZON_CHROME` (receipt: `tests/horizon-chips.spec.ts:112` and
   `tests/enso-horizons.spec.ts:237`, both green in the `verify:smoke` run above). **Not**
   satisfied for on-map validity **stamps**: each hazard layer sets its own stamp text through
   `src/ui/time-bar.ts` (`setTimeBar`/`clearTimeBar`, called from `src/layers/drought.ts`,
   `usdm.ts`), a separate system this session did not read or touch. That stamp work is
   **DDM-P8-T02's** ("Give Fire and Extreme Heat a time bar"), which owns `time-bar.ts`; it is
   assigned there, not left ambiguous. The task's own title says "every horizon chip **and every
   stamp**"; if DDM-P8-T03's own "one grammar" clause is meant to reach stamps too, that half
   waits on DDM-P8-T02.
3. **"forecast register visually distinct from its observed register."** Satisfied for every
   claim rendered in the briefing panel (receipt: `tests/horizon-chips.spec.ts`, all six tests
   green). Genuinely open: whether "hazard surface" in this sentence means the claim text
   specifically, or also the MAP LAYERS themselves (for example, a visual distinction between an
   observed and an outlook layer on the map face, independent of the briefing panel). This session
   read it as the former (the briefing panel is where DDM's own per-hazard statements live) but did
   not find text settling the question either way, and did not touch any layer styling.

**`docs/ROADMAP.yaml` was NOT edited.** Per the session's own instruction ("done ONLY if every
numbered acceptance clause has a receipt... otherwise leave the status alone"), and given clause 1
carries no fresh receipt and clause 2 is only half-satisfied, DDM-P8-T03 stays at its existing
(unset/open) status. No ROADMAP line was touched.

## Ledgers

- **`planning/decisions/2026-09-02-decision-register.yaml`**: new group `G-session-2026-09-07`,
  entry `DR-070`, recording R1 and R3 as owner rulings of 2026-09-07, citing this session and this
  handoff. `yaml.safe_load` re-run clean.
- **`.planning/TRACE.yaml`**: `src/impact/horizon-chrome.ts` attached to `DDM-P8-T03` (it was
  already attached to `DDM-P12-T02`; a file may serve two tasks), dated comment,
  `attached_by: repair:S12`. `tests/horizon-chips.spec.ts` attached as a new test, same tag.
  `status: open` left unchanged, matching ROADMAP. `yaml.safe_load` re-run clean.
- **`.planning/SESSION_ROSTER.yaml`**: `DDM-P8-T03` pulled out of the `S12-S19` block into its own
  `S12` entry (matching how S09, S10, S11 were each pulled out), `status: partial`, full outcome
  recorded. The block below renamed `S12-S19` to `S13-S19`, its `DDM-P8-T03` `per_task_tier` line
  replaced with a comment pointing at the new `S12` entry, same pattern S09-S11 left behind.

## Sweep versus files changed

Every sweep hit was either changed (with the reason recorded above) or explicitly left alone
(`presets.ts` / `helpers.ts`, a different feature). Files touched, beyond the sweep:
`src/impact/evidence.ts` (new `CLAIM_REGISTER_TAG`), `src/ui/claim-render.ts` (renders it),
`src/styles/app.css` (two small rules, `.impact-claim-register` and the shell chip's two-line
layout), `tests/horizon-chips.spec.ts` (new), `package.json` (added to `verify:smoke`).

## `scan-emdash` on the ledgers touched by hand

`.planning/` and `planning/` sit outside `scripts/scan-emdash.mjs`'s roots (conduct rule 2), so
each ledger this session touched was scanned by hand for U+2014 and the count is zero on every
added line:

    planning/decisions/2026-09-02-decision-register.yaml   0
    .planning/TRACE.yaml                                    0
    .planning/SESSION_ROSTER.yaml                           0
    docs/ROADMAP.yaml                                       0 (untouched this session)
    this handoff                                            0

## Open owner calls

1. **Clause 1**, quoted: *"A horizon a hazard cannot answer is absent or visibly disabled with
   its reason."* Not touched or freshly verified this session; carried from `shell.tsx`'s
   pre-existing `customHorizonDisabledReason` behaviour (S3-era). No receipt from S12 either way.
2. **Clause 3**, quoted: *"[with] its forecast register visually distinct from its observed
   register."* Satisfied for claim text (the observed/outlook tag, R3). Open: whether "hazard
   surface" also means the MAP LAYERS themselves, independent of the briefing panel. Read as claim
   text only here; not settled either way.
3. **The stamp half of clause 2** is now assigned, not open: `src/ui/time-bar.ts` and its per-layer
   validity stamps belong to **DDM-P8-T02** ("Give Fire and Extreme Heat a time bar"), which owns
   that file. DDM-P8-T03's own "one grammar" clause is satisfied for horizon naming; whether it
   also needs the stamp grammar DDM-P8-T02 will build is that task's question to answer when it
   runs, not an open call here.
4. **DR-017, DR-021, DR-037** (ROADMAP's `needs_decision` for this task): DR-021 was already
   decided 2026-09-02 and is unrelated to the chip rename (it is about the console outlook card's
   badge and the outlook bar's jump-chip wording, a different surface). DR-017 (the chip when two
   horizons share one recipe, e.g. Heat and ENSO where `weeks-ahead` and `season-ahead` render the
   same layer) and DR-037 (the on-map key for all four hazards or none) remain open; neither was
   touched or re-litigated by R1-R4, which answered a different question (which vocabulary the chip
   TEXT uses, not what the chip DOES when two horizons share a recipe).
5. The shell chip pill's two-line layout is a real visual change (title + subtitle where one short
   word stood before). Verified in `verify:smoke`'s existing 44px-touch-target and tablet-band
   checks (all green), but a from-scratch responsive/visual pass across the breakpoint matrix
   (DDM-P10-T01's own territory) was not run; worth a `ddm-frontend-specialist` look if the owner
   wants one before this lands.
