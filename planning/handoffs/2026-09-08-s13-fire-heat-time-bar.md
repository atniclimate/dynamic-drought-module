# S13 handoff: fire and heat time bar (DDM-P8-T02)

Branch `feature/fire-heat-time-bar-p8t02` from `main` at `5e261a45509722f1ae97cdb90422ab8280d47bc8`,
**unpushed and unmerged**. Commits, oldest first: `630df11` (Step 1, the horizon line on every
stamp), `67bef2e` (NIFC, SPC Day 1, WHP), `a7bf1e2` (the HeatRisk rail and stamp), `7e931b9` (the
observed/outlook step doctrine and the activation-budget rebalance), `b5a4fda` (the acceptance
spec), `0b62a4e` (one boot-idle race in the new spec), then the closing ledger commit. Gates:
`verify:quick` clean; `verify:smoke` **135 passed, 1 skipped, 5.8m** on its second full run (the
skip is the `tests/ux1-surfaces.spec.ts:98` quarantine, as S09 to S12 reported; the first full
run failed one new test on the boot-idle race that `0b62a4e` fixes, the gate half being clean both
times: bundle entry 30.8 kB under 45, eager app 46.4 kB under 100, activation clean);
`check:public-tree` clean, 561 tracked files before this handoff and its negation, 562 and clean
with both staged. Logs: `%TEMP%\ddm-s13\quick.log`, `smoke.log`, `smoke2.log`, `spec-run1.log` to
`spec-run3.log`. Zero U+2014 on added lines (scan below). Nothing pushed, merged, tagged,
published, or scheduled.

## What the four screens say now

Before this session only the drought family and the ocean anomaly surface installed a time bar
(`grep setTimeBar src/` at `5e261a4`: drought.ts:171, usdm.ts:523, nadm-drought.ts:116,
cdm-drought.ts:269, bc-drought.ts:171, sst-anomaly.ts:418 and :435). The Wildfire and Extreme Heat
screens had no time control at any horizon. Every stamp now reads, top to bottom: a horizon line
from `HORIZON_CHROME` (`.time-bar-stamp-horizon[data-horizon]`), a headline that states the period
or says the product carries none, and a detail that names the issuer. The More time detail card
mirrors the horizon line (`.shell-time-detail-horizon`); the embed chip still mirrors the headline
only (R-h below).

| Screen | Chip | Owner | Horizon line | Headline | Register |
| --- | --- | --- | --- | --- | --- |
| Wildfire | Current Conditions | nifc-fires (event; owns the bar only while no surface does) | Current Conditions · now | Current perimeters · no single valid time | observed |
| Wildfire | Near Term | spc-fire-weather | Near Term · days to weeks | Outlook valid `<valid>` to `<expire>` (the issuance's own fields, UTC); on an empty issuance "Outlook · valid period not stated by the response" | outlook |
| Wildfire | Long Range | usfs-whp | Long Range · season to water year | Static 2023 edition · not a dated condition | observed (plain), the detail denying outlook |
| Extreme Heat | Current Conditions and Near Term (one recipe) | heatrisk, seven-stop rail | Near Term · days to weeks at every frame | Outlook valid A to B (period not begun, or in progress); Period ended B (period elapsed) | outlook / outlook / observed |
| Extreme Heat | Long Range | none (the recipe is empty by design, clusters.ts:145-148) | the WHEN row's "No dated product is displayed." | | |
| Drought | all three | unchanged owners | Current Conditions (NADM, USDM, CDM, BC) or the CPC range's horizon through `SHELL_HORIZON_KEY[horizonForOutlookRange(range)]` | unchanged | unchanged |
| ENSO | all three | sst-anomaly | Current Conditions · now under every chip | unchanged | observed |

The rendered DOM, fixture-fed, captured from the built app on 2026-09-08 (the throwaway capture
spec was deleted; `git status` clean):

One fire step (`?view=console&cluster=wildfire&horizon=weeks-ahead`, `#time-bar[data-register="outlook"]`):

    <div class="time-bar-stamp" aria-live="polite" aria-atomic="true">
      <span class="time-bar-stamp-horizon" data-horizon="nearTerm">Near Term · days to weeks</span>
      <span class="time-bar-stamp-headline">Outlook valid Sep 8, 2026, 12:00 UTC to Sep 9, 2026, 12:00 UTC</span>
      <span class="time-bar-stamp-detail">NOAA SPC Day 1 Fire Weather Outlook · an outlook of fire-weather conditions favorable for fire spread, not a fire danger rating and not an active fire</span>
    </div>

and after the Current Conditions chip (`data-register="observed"`, no rail, no Play):

    Current Conditions · now / Current perimeters · no single valid time / NIFC WFIGS current
    interagency perimeters · checked for updates about every five minutes; the service states no
    product date and each perimeter carries its own discovery date

One heat step (`?view=console&cluster=heat&heatday=4`, page clock fixed at 2026-07-30 18:00 UTC,
`#time-bar[aria-label="NWS HeatRisk day"][data-register="outlook"]`):

    <input type="range" class="time-bar-rail" min="0" max="6" step="1" value="3"
           aria-valuetext="Day 4 · Jul 31, 2026, 12:00 UTC" aria-label="NWS HeatRisk day date">
    <div class="time-bar-stamp" aria-live="polite" aria-atomic="true">
      <span class="time-bar-stamp-horizon" data-horizon="nearTerm">Near Term · days to weeks</span>
      <span class="time-bar-stamp-headline">Outlook valid Jul 31, 2026, 12:00 UTC to Aug 1, 2026, 12:00 UTC</span>
      <span class="time-bar-stamp-detail">NWS HeatRisk (experimental) · Day 4 of 7 · expected heat impact over a 24-hour period that has not begun</span>
    </div>

## The acceptance clauses, with receipts

`docs/ROADMAP.yaml:322`: "Each of the four hazard screens shows a time control whose stamp names the
issuer and the period the displayed surface covers, or states that the product is undated."

1. **Each of the four hazard screens shows a time control.** `tests/fire-heat-time-bar.spec.ts`,
   all ten tests green in `verify:smoke` (log path below): Wildfire at all three horizons (tests
   1 to 4), Extreme Heat at current, near term and the empty long range (tests 5 to 8, the last
   asserting the WHEN row's "No dated product is displayed." with `#time-bar` hidden, R-g),
   Drought (test 9) and ENSO (test 10). Code: `src/layers/nifc-fires.ts` `armTimeBar`,
   `spc-fire-weather.ts` `installTimeBar`, `usfs-whp.ts` `installTimeBar`, `heatrisk.ts`
   `installTimeBar`.
2. **The stamp names the issuer.** Every `expectStampContract` call asserts the detail contains
   the issuer: "NIFC WFIGS", "NOAA SPC Day 1 Fire Weather Outlook", "USDA Forest Service Wildfire
   Hazard Potential", "NWS HeatRisk", "North American Drought Monitor", "GHRSST MUR".
3. **The stamp names the period the displayed surface covers.** SPC: the headline equals
   "Outlook valid Sep 8, 2026, 12:00 UTC to Sep 9, 2026, 12:00 UTC" from the fixture's own
   `valid`/`expire` (test 2). HeatRisk: "Outlook valid Jul 30, 2026, 12:00 UTC to Jul 31, 2026,
   12:00 UTC" for day 3, day 4 and day 5 from the fixture's `idp_validtime` plus 24 h (tests 5
   and 6), and "Period ended Jul 29, 2026, 12:00 UTC" for an elapsed day (tests 5 and 7).
4. **Or states that the product is undated.** NIFC: "Current perimeters · no single valid time"
   and "the service states no product date" (test 1, with no four-digit year in the headline).
   SPC empty issuance: "Outlook · valid period not stated by the response" (test 3). WHP: "Static
   2023 edition · not a dated condition" (test 4).

Every clause carries a receipt from this session, so `docs/ROADMAP.yaml` DDM-P8-T02 is flipped to
`status: done` with a `closed:` sentence in the closing commit.

## DDM-P8-T03 clause 2, the stamp half S12 assigned here

`docs/ROADMAP.yaml:328`, "every hazard surface states its time in one grammar". S12 satisfied it
for horizon naming (chips, panel headings, panel-foot line) and assigned the on-map stamps here.
Receipt: `TimeBarStamp.horizon` is a required field (`src/ui/time-bar.ts`, the interface at
:59-80; `npm run typecheck` proves every owner declares one), the bar renders it through
`stampHorizonText()` from `HORIZON_CHROME` only (`src/ui/time-bar.ts:394`), and
`tests/fire-heat-time-bar.spec.ts` `expectHorizonLine` pins every rendered horizon line to exactly
one table entry on all four screens, with the S12 chip assertions re-run on the same pages
(`expectChipsStillHonest`). No local label table existed on the time bar (the sweep below), so
nothing was derived or removed; the one-required-field change was the smaller diff. Clauses 1 and
3 of DDM-P8-T03 are as S12 left them; this session did not touch that task's status.

## The doctrine on time steps, and one disagreement the owner should see

The prompt's doctrine: an issuer outlook step is labelled as an outlook, in the issuer's product
terms; an observation step is not; where a bare stamp renders, the text carries the distinction.
As built (every sentence verified by `ddm-science-verifier`, seven runs, receipts in DR-071):

- SPC Day 1: outlook, in the issuer's own product name ("Day 1 Fire Weather Outlook",
  spc.noaa.gov/misc/about.html and MapServer layer 1 "Day 1 Outlook").
- NIFC perimeters and WHP: not outlooks; the WHP text denies it explicitly ("not an outlook"),
  which the spec's register check treats as a denial, the same rule the shared forbidden list
  applies to "forecast".
- HeatRisk: the issuer describes every value as a forecast ("provides a forecast of the potential
  level of risk for heat-related impacts to occur over a 24-hour period", calculated "from the
  current date through seven days in the future", HeatRisk v2.6 Overview PDF). So a frame whose
  24-hour period has not begun AND the frame in progress are outlooks in force; only a period
  that has ended leaves the outlook register ("Period ended B", plain register). The phase is read
  against the page clock at install time; no calendar date is written into any stamp.

**The disagreement.** DR-070 (S12) tags the briefing's HeatRisk claim `classified -> observed`
on the reasoning that it is "an issuer's own classification of a currently valid state, not a
forecast" (src/impact/evidence.ts:75-78; src/impact/sources.ts:278, a DDM-P7-T03 file this
session did not touch). The issuer's own words above call every HeatRisk value a forecast. From
this session on, the time bar says outlook for a HeatRisk frame in force while the briefing's
claim for the same frame says observed. DR-071 records both honest resolutions (extend DR-070 for
HeatRisk, or accept that the briefing tags the classification while the bar tags the step);
neither is this session's to make.

**The register word.** NWS says forecast; the interface says Outlook. `check:vocabulary` bans
"forecast" outside a `vocab-allow` and this session could not add one (STOP c), so "Outlook" in
the HeatRisk headline is the interface's cross-hazard register word (DR-070's grammar) and the
HeatRisk detail asserts only issuer terms ("expected heat impact over ... 24-hour period"). The
verifier flagged the gap; the owner decides whether HeatRisk's strings may carry the issuer's
word under a `vocab-allow`.

## Sweep versus files changed

The precondition-5 sweep (the ledger, `%TEMP%\ddm-s13\ledger.md`) found no DDM horizon name in
any existing stamp string: every stamp used issuer product terms and register verbs (Valid /
Issued / Observed / Consensus month / Source date), and no local horizon label table existed on
the time bar. Files changed, all inside the sweep or the task:

- `src/ui/time-bar.ts` (required `horizon`, `stampHorizonText`, the horizon span),
  `src/ui/island/time-popover.tsx` (the detail card mirrors it), `src/styles/app.css` (two
  rules, no new color: `.time-bar-stamp-horizon`, `.shell-time-detail-horizon`).
- The six existing owners declare a horizon: `usdm.ts`, `drought.ts` (through
  `SHELL_HORIZON_KEY[horizonForOutlookRange(range)]`), `sst-anomaly.ts`, `nadm-drought.ts`,
  `cdm-drought.ts`, `bc-drought.ts`.
- New owners: `src/layers/nifc-fires.ts`, `spc-fire-weather.ts`, `usfs-whp.ts`, `heatrisk.ts`.
- `scripts/check-activation-budget.mjs` (the heatrisk-days row, below), `package.json`
  (`verify:smoke`), `tests/fire-heat-time-bar.spec.ts` (new).
- Left alone, with reasons: the map key's "Day N · date" options and "Valid date" select
  (`src/ui/map-key.ts:338-344`) and the dock sequence's "Day N" and "Valid ... to ..." strings
  (`heatrisk-sequence.ts:279-321`) are issuer time-step terms, not horizon names, and the on-map
  key is DR-037's open question; the `TemporalHorizonKey` routing tokens in `timeline.ts` and
  `clusters.ts` stay as S12 ruled; the DDM-P7-T03 files were read and not changed; no held-branch
  content was used.

**The activation budget.** `check:activation` failed after the heat commit: the heatrisk-days
first-activation closure measured 9.5 kB gzip against 7.5 kB, because the shared time-bar chunk
(2.1 kB, already inside every drought closure) now enters it and the layer grew by the rail and
stamp. The row was rebalanced the way its own label records four earlier rebalances, to 10.0 kB
(measurement plus the same 0.5 kB headroom) with the 2026-09-08 reason prepended. This is a gate
threshold change and is reported as one; a nested `import()` to keep time-bar out of the static
closure was rejected as dodging a gate whose header says it measures the static closure only.
`check:bundle`: entry 30.8 kB under 45 (S10 recorded 30.7), eager app 46.5 kB under 100 (S10
46.4). Commit `a7bf1e2` alone is red on `check:activation` (the rebalance rides `7e931b9`);
noted for bisect honesty.

## Overlap with held branches (read-only, nothing merged, rebased or cherry-picked)

- `feature/nifc-perimeter-evidence` (8 commits): shares `package.json` (it adds a test script and
  a gate step; this branch adds one spec to `verify:smoke`) and `src/styles/app.css` (it adds 54
  lines of evidence-section CSS; this branch adds two stamp rules), different hunks in both.
- `map/dr-063-whp-ramp` (987c29d): shares `src/layers/usfs-whp.ts` (it adds a header comment at
  :67-79; this branch adds `installTimeBar` and the two calls in activate/deactivate), different
  hunks.

## Ledgers

- `planning/decisions/2026-09-02-decision-register.yaml`: new group `G-session-2026-09-08`,
  entry `DR-071`, `status: pending` (session-proposed, awaiting the owner), recording the nine
  design readings R-a to R-i, the DR-070 disagreement, the register word, and the budget
  rebalance; the header `updated:` line bumped to 71 entries, 50 decided, 21 pending.
  `yaml.safe_load` clean.
- `docs/ROADMAP.yaml`: DDM-P8-T02 `status: done` with a `closed:` sentence naming this branch and
  the spec.
- `.planning/TRACE.yaml`: `tests/fire-heat-time-bar.spec.ts` attached to DDM-P8-T02
  (`attached_by: repair:S13`, dated comment); `status: open` left for the owner's landing pass
  as S09 to S12 did. `spc-fire-weather.ts` and `usfs-whp.ts` remain in
  `orphan_files_with_test_coverage` although they now serve this task: attaching existing files
  was outside this session's authorization (an owner call). `yaml.safe_load` clean.
- `.planning/SESSION_ROSTER.yaml`: DDM-P8-T02 pulled out of the `S13-S19` block into its own
  `S13` entry (the block renamed `S14-S19`, its per-task line replaced with a pointer), matching
  S09 to S12. `yaml.safe_load` clean.
- `.gitignore`: this handoff negated by name. FINDING: the S12 handoff
  (`planning/handoffs/2026-09-07-s12-honest-horizon-chips.md`) is tracked but carries no
  negation line; `scripts/check-public-tree.mjs:53` allows `planning/handoffs/` wholesale so the
  public-tree check is green either way. Not repaired here (outside this task); one line if the
  owner wants the file to match S09 to S11.

## scan-emdash on the ledgers touched by hand

`.planning/` and `planning/` sit outside `scripts/scan-emdash.mjs`'s roots (conduct rule 2), so
each ledger this session touched was scanned by hand for U+2014; the count is zero on every added
line:

    planning/decisions/2026-09-02-decision-register.yaml   0
    .planning/TRACE.yaml                                    0 on added lines (one pre-existing at
                                                            :3059, present on main, not touched)
    .planning/SESSION_ROSTER.yaml                           0
    docs/ROADMAP.yaml                                       0 (also inside scan-emdash's roots)
    .gitignore                                              0
    this handoff                                            0

## Open owner calls

1. **DR-071**, session-proposed, pending ratification: the nine readings, above all R-b.
2. **DR-070 versus the issuer**: the briefing's `classified -> observed` tag for HeatRisk rests on
   a sentence the issuer contradicts; correcting it touches `src/impact/evidence.ts` or
   `sources.ts` (DDM-P7-T03).
3. **The register word for HeatRisk**: "Outlook" (the interface's grammar) or the issuer's
   "forecast" under a `vocab-allow`.
4. **heatrisk-days budget** 7.5 to 10.0 kB gzip: ratify or direct the nested-import alternative.
5. **TRACE**: attach `spc-fire-weather.ts` and `usfs-whp.ts` to DDM-P8-T02 (orphans that now
   serve it); `nifc-fires.ts` already serves DDM-P1-T06 and DDM-P9-T03 and could carry a third.
6. **NIFC currency field**: the issuer publishes `poly_DateCurrent` ("date time the source polygon
   record was last edited") and `poly_PolygonDateTime`; the layer requests neither
   (`NIFC_OUT_FIELDS`, wildfire-presentation.ts:905). A perimeter-currency stamp would be an
   enhancement, not a correction; the current stamp is honest about what it shows.
7. **WHP input vintage**: the issuer notes the 2023 edition's inputs reflect landscape conditions
   as of end of 2020 (LANDFIRE 2020); the stamp names the issuer's edition year only.
8. **DR-017 stays open**: under the Current Conditions chip the heat stamp reads Near Term and
   the ENSO stamp reads Current Conditions under Long Range. Both are the truth about the surface;
   whether the chips should say so is DR-017's question, not answered here.
9. **The S12 `.gitignore` negation** (finding above).
