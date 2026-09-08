# S10 handoff: near-term column chrome, closing ENSO horizons (DDM-P12-T02)

Branch `feature/horizon-chrome-dr031` from `main` at `98df11e`, **unpushed and unmerged**. At the
start of this session `main` was fast-forwarded to S09's `98df11e` by owner ruling; S09's branch
`feature/enso-horizons-dr031` is kept until pushed. Gates: `verify:quick` clean; `verify:smoke`
**115 passed, 1 skipped, 4.5m** (the skip is the `tests/ux1-surfaces.spec.ts:98` quarantine from
`0121cef`); `check:public-tree` clean, 545 tracked files.

Commits: `ad0c2f2` one source of truth for the headings, `a7ebcf1` the rename, `322cab3` the spec
assertion, then the closing ledger commit.

## What changed

S09 shipped a near-term ENSO claim whose text says it is not a forecast, and it rendered under a
column titled **"Near-term outlook"** (`src/impact/briefing.ts:40` at the time). DR-031's own risk
line predicted the collision; `ddm-science-verifier` flagged it in S09 as an owner call. The
DDM-P12-T02 acceptance says *"no horizon implies a forecast the app does not have"*, and a heading
is part of the horizon.

- **`src/impact/horizon-chrome.ts`** is new: three `{ title, subtitle }` entries keyed by the
  briefing's `HorizonKey`, one type-only import, no value imports. It is read by the lazy composer
  (`briefing.ts`) and by the eager panel's module-failure path (`impact-panel.ts`). Those two had
  each carried their own copy and had already drifted: near-term read `days to a season` live and
  `days to weeks` on failure; long-range read `season to water year` live and `months` on failure.
- **The headings**, owner-decided exact strings, no hyphen in a title:
  `Current Conditions` / `now`, `Near Term` / `days to weeks`, `Long Range` / `season to water year`.
  Rendered by `impact-panel-runtime.ts:234` as `<h3>` title then subtitle, so the DOM reads
  "Current Conditions now", "Near Term days to weeks", "Long Range season to water year".
- **`tests/enso-horizons.spec.ts`** gained one test: the three DOM headings equal `HORIZON_CHROME`
  exactly, no title or subtitle matches `/outlook|forecast/i`, and no title contains a hyphen.
- **`src/impact/types.ts:192`**: the doc-comment example of a title updated to the new spelling.
- Chrome only. No claim text, no `CELL_ABSENCE` prose, no issuer product name was edited. The CPC
  Seasonal Drought Outlook is an outlook and still says so. `check:vocabulary` was run immediately
  after the rename and passed; no `vocab-allow` was added.

## Why not `TEMPORAL_HORIZON_LABELS`

The prompt named `TEMPORAL_HORIZON_LABELS` in `src/config/clusters.ts` as the single definition.
It is a different table: keyed `current | weeks-ahead | season-ahead` (`clusters.ts:43`), not the
briefing's `current | nearTerm | longRange` (`types.ts:156`); its values are lowercase cadence
fragments for the map shell (`'next seven days'`), not headings; its own comment says it is NOT the
chip labels (`:53`) and that merging it with `TEMPORAL_HORIZON_CHIP_LABELS` "is an owner ruling,
not a refactor" (`:72-78`); and `tests/heat-h1-heatrisk.spec.ts:349` pins `['weeks-ahead']` to
`'next seven days'`. Making it the headings table would have changed a different surface, broken
that pin, and pre-empted a ruling the code says is pending. The prompt's escape clause was taken,
with a key-space reason rather than a cycle. `clusters.ts` and the heatrisk spec are untouched.

The eager panel cannot import `briefing.ts` (forbidden in the initial static set,
`scripts/check-activation-budget.mjs:200-202`) and deliberately does not import `matrix.ts`
(`impact-panel.ts`, the `unavailableCells` comment). A pure constants module is the only home both
readers can share. Bundle after: entry 30.7 kB under 45, eager app 46.4 kB under 100, activation
gate clean.

## The sweep, and what was actually changed

Sweep, before any edit: 8 hits in 4 files, none under `docs/`.

    src/impact/briefing.ts:35,39,40,41      changed
    src/ui/impact-panel.ts:457,458,459      changed
    src/config/clusters.ts:57,72             NOT changed (see above)
    tests/heat-h1-heatrisk.spec.ts:7,349     NOT changed (pins clusters.ts, still green)

Also changed, outside the sweep: `src/impact/horizon-chrome.ts` (new), `src/impact/types.ts:192`
(comment), `tests/enso-horizons.spec.ts` (assertion). After the rename the old strings survive only
in one history comment, `horizon-chrome.ts:10`. Microtask 4 had nothing to do: no user-facing doc
carried the strings. `docs/session-briefing-2026-09-03.md:143` mentions "Near-term" in a DR-016
chip-wording note about the map shell, not the briefing column, and stays.

## DDM-P8-T03 (honest horizon chips): what this touches, without flipping it

Its acceptance, `docs/ROADMAP.yaml:325`:

> A horizon a hazard cannot answer is absent or visibly disabled with its reason, and every
> hazard surface states its time in one grammar with its forecast register visually distinct
> from its observed register.

- *"absent or visibly disabled with its reason"*: not touched. That is cell behaviour
  (`CELL_ABSENCE`, `fillCell`), which S02g and S09 shaped and this session did not edit.
- *"states its time in one grammar"*: **satisfied for the briefing panel's three column headings
  only**, which now share one grammar from one table. It is NOT satisfied across hazard surfaces:
  the map shell's chips still read `Current / Weeks ahead / Season ahead`
  (`TEMPORAL_HORIZON_CHIP_LABELS`, `clusters.ts:80-86`) and the on-map stamps keep their own
  wording, so the same horizon is still "Near Term / days to weeks" in the briefing and "Weeks
  ahead" on the shell. Reconciling those is the ruling `clusters.ts:72-78` reserves.
- *"forecast register visually distinct from its observed register"*: not satisfied and not
  attempted. This session removed a false forecast register from the chrome; it added no visual
  distinction between forecast and observed reads.

DDM-P8-T03 stays open. The fragment above is recorded so the task's own session does not re-derive
it.

## ENSO citations (DDM-P12-T03), carried from the S09 handoff

The natural next task, second in group 1. Its subject is `src/impact/enso.ts:474-503`,
`tendency()`, untouched by S09 and S10.

- Three tilt sentences, three URLs, all HTTP 200 on 2026-09-07: `NW_HUB_EL_NINO_URL`
  (`enso.ts:203`), `NW_HUB_LA_NINA_URL` (`:205`), `CPC_COMPOSITES_URL` (`:207`), backing the
  branches at `:479`, `:488`, `:497`.
- Re-stamp `CITATIONS_VERIFIED` (`enso.ts:198`, still `'2026-09-02'`) per its own comment at
  `:195-196`.
- Two lineage entries with no URL in the code: the Washington State Climate Office (`:461`) and
  the CPC Seasonal Drought Outlook (`:501`); both `gap: true` in
  `planning/references/register.yaml`.
- The count does not match: `docs/ROADMAP.yaml:466` and DR-030 say four tilt sentences,
  `tendency()` has three branches, and DR-030 does not yet name the two it calls over-claiming.
  That naming is a precondition for DDM-P12-T03's acceptance, not a step inside it.

## Open owner calls from this session

1. **`src/impact/horizon-chrome.ts` is attached to no task in `.planning/TRACE.yaml`.** The
   instruction allowed only a status flip and a conditional `clusters.ts` attachment (which the
   sweep ruled out). The new module is the headings' only home; attaching it to DDM-P12-T02, or to
   DDM-P8-T03 as the chrome grammar's owner, is a one-line repair with a dated comment.
2. **The roster block was renamed `S10-S19` to `S11-S19`** because this session took `S10`. Same
   split as S09; flagged rather than assumed.
3. **Two horizon vocabularies still coexist**: the briefing headings here and the shell chips in
   `clusters.ts`. That is the ruling `clusters.ts:72-78` reserves for the owner and DDM-P8-T03's
   "one grammar" clause depends on it.
4. From your notes, still not done as of this session's start and not touched by it: the
   `no-heredoc.mjs` hook in `.claude/` (I followed the rule without it), and the planning commit
   (D12 restated to three, the references ledger in the ROADMAP authority block, four tilt
   sentences to three, DDM-P7-T02 done, the `.gitignore:58` "four" comment, and a tracked home for
   the conduct rules). This session touched exactly one ROADMAP line as instructed, so those edits
   remain to be made.
