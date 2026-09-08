# S09 handoff: ENSO horizons (DDM-P12-T02)

Branch `feature/enso-horizons-dr031`, nine commits, **unpushed and unmerged**. Base `c8473db` on
main. Gate: `npm run verify:smoke` green, **114 passed, 1 skipped, 5.1m**. The skip is the
pre-existing `tests/ux1-surfaces.spec.ts:98` quarantine from `0121cef`, not this work.

## What changed

DR-031 was ratified option (a), "wire the weekly Nino 3.4 observation, labeled an observation and
not a forecast". S02g had shipped option (b) behaviour instead: no ENSO claim carried
`horizon: 'nearTerm'` at all, and the cell held a permanent named absence. Both are gone.

- **`scripts/build-enso-snapshot.mjs`** fetches a fifth CPC file and emits an optional
  `nino34Weekly` series: 52 weeks, `year/month/day/total/anom`. Two column headers are asserted,
  not one, so a reordered region fails the build rather than silently reading Nino 3 as Nino 3.4.
  The date is stripped before numeric-token extraction, because the row's `02SEP2026` would
  otherwise contribute two spurious numbers to the same fused-column parse the SOI block already
  uses for `20.6-0.1`.
- **`scripts/lib/enso-snapshot-contract.mjs`** validates it (`isNino34WeeklySeries`, at least two
  points because the claim is a trajectory between two observations) and lists it in
  `OPTIONAL_SERIES`. **`scripts/validate-enso-snapshot.mjs`** gained three pinned self-test
  fixtures, one pass and two red; the self-test went from 24 cases to 27.
- **`src/impact/enso.ts`** mirrors the guard and drops the block independently when malformed,
  with the same `console.warn` shape as the `nino34` and `soi` blocks, and adds one claim with
  `horizon: 'nearTerm'`, withheld past `HARD_STALE_DAYS` exactly as the tendency claim is.
- **`src/impact/matrix.ts`** adds `'nearTerm'` to `LANE_PLACEMENT.enso` and rewrites
  `CELL_ABSENCE.nearTerm.enso`, whose old prose ("the ENSO reads this briefing carries are a
  current index state and a season-ahead tendency") became false the moment the claim existed.
- **`tests/enso-horizons.spec.ts`** is new, three fixtures, added to `verify:smoke`.
  `tests/briefing-matrix.spec.ts` was added to `verify:smoke` first, as a guard before matrix.ts
  was touched; it had never been in the list despite carrying DDM-P7-T02's acceptance verbatim.

**`src/config/urls.ts` gained nothing.** The browser reads only the bundled snapshot, so the
endpoint belongs to the builder, which hardcodes its upstream URLs.

## The source trap, reproduced

The session prompt's lead named `wksst8110.for` as the historical weekly file. DR-031's own
citation list already flagged it: *"the frozen wksst8110.for file, not to be used"*. Verified live
on 2026-09-07 rather than taken on trust:

    wksst9120.for   HTTP 200   Last-Modified Mon, 07 Sep 2026 07:00:14 GMT   148164 bytes   WIRED
    wksst8110.for   HTTP 200   Last-Modified Tue, 09 Feb 2021 18:00:06 GMT   102362 bytes   FROZEN

The frozen file's last data row is `27JAN2021`. Choosing it would have shipped a five-year-old
number behind a healthy status code.

## The near-term sentence, exactly as rendered

> Across the last 4 weekly observations the Nino 3.4 sea surface temperature anomaly went from
> +2.6 to +2.7 degrees Celsius, a change of +0.10 degrees Celsius measured against this
> application's own 0.2 degree band for calling a trajectory rather than noise, so across those
> weeks it is little changed (week centred 2 September 2026, the newest week CPC has posted; this
> file dates each week at its centre). These are observations of what the ocean surface has already
> done. They do not declare an ENSO phase, which CPC declares from three-month averages and not
> from single weeks, and they are not a forecast: they say nothing about the weeks ahead.

`ddm-science-verifier`, 2026-09-07: **5 VERIFIED, 1 flagged.** Verified: the file dates weeks at
their centre (the file's own first line), Nino 3.4 is the third region pair so +2.7 is not Nino 3
or Nino 4, the 1991-2020 base period, CPC declaring phase from three-month averages, and the
0.2 band correctly self-attributed to this application rather than to NOAA. The verifier's
precision note, that the file publishes to one decimal so a 2.6-to-2.7 move sits at the resolution
limit, was folded into the claim's `uncertainty` text.

## Open owner calls

1. **The column title collides with the claim.** The claim renders under a horizon titled
   **"Near-term outlook"** (`src/impact/briefing.ts:40`). DR-031's own risk line predicted exactly
   this: *"a weekly observation inside a register named weeks ahead reads as a forecast unless the
   label says otherwise."* The claim text says otherwise; the column chrome does not. Renaming that
   horizon touches all four hazard rows, so it was left alone. This is the one thing that would
   make me hesitate to call DDM-P12-T02 fully closed.
2. **`verify:smoke` was RED on main before this session** and nobody had noticed.
   `scripts/check-public-tree.mjs` failed on two tracked paths unrelated to this task: `CLAUDE.md`,
   tracked deliberately by `5b40dfb`, and `planning/references/register.yaml`, tracked by S03b under
   owner ruling. That script keeps its own allow-list parallel to `.gitignore`, and the S03b ruling
   updated only `.gitignore`. Both are fixed here by owner ruling. Worth asking how a gate stayed
   red across three sessions.

## What ENSO citations (DDM-P12-T03) verifies next

It is the second task of group 1 and the natural successor. Its whole subject is
`src/impact/enso.ts:474-503`, `tendency()`, which this session did not touch.

- **Three tilt sentences and three URLs.** All three resolved HTTP 200 on 2026-09-07:
  `NW_HUB_EL_NINO_URL` (`enso.ts:203`), `NW_HUB_LA_NINA_URL` (`:205`), `CPC_COMPOSITES_URL`
  (`:207`), backing the branches at `:479`, `:488` and `:497`.
- **Re-stamp `CITATIONS_VERIFIED`**, `enso.ts:198`, still `'2026-09-02'`. The module's own comment
  at `:195-196` says to re-stamp it whenever those pages are re-read.
- **Two lineage entries with no URL anywhere in the code**: the Washington State Climate Office
  (`enso.ts:461`) and the CPC Seasonal Drought Outlook (`:501`). Both carry `gap: true` in
  `planning/references/register.yaml`.
- **The count does not match.** `docs/ROADMAP.yaml:466` and DR-030 both say *four* Pacific
  Northwest tilt sentences; `tendency()` has *three* branches. Which four are meant is undecided,
  and DR-030 still does not name the two sentences it calls over-claiming. That naming is a
  precondition for DDM-P12-T03's acceptance, not a step inside it.

## Ledgers touched

`planning/decisions/2026-09-02-decision-register.yaml` (DR-031 `implementation_2026_09_07`, no
renumbering), `.planning/TRACE.yaml` (three edits: the DR-031 build-time files and the acceptance
spec attached to DDM-P12-T02; the `heat-h1-heatrisk` entry moved from DDM-P7-T05 to DDM-P7-T02
against `matrix.ts`; `repairs_through` added beside the untouched `5be15f5`),
`.planning/SESSION_ROSTER.yaml` (S09 split out, block renamed S10-S19),
`planning/references/register.yaml` (`cpc-nino34-weekly`, `wired: true`).
