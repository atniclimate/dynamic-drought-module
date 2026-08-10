# Fresh-session handoff: close H2 in the DDM successor

> Historical handoff. H2 is complete and published. Resume from
> `docs/FIRE_PATHWAY_FRESH_SESSION_HANDOFF_2026-07-29.md`; do not execute the
> stale expected-state or release instructions below.

Resume work in:

`I:\dynamic-drought-module`

The immediate priority is to close H2 point heat as a durable local release
candidate. Do not start the fire expansion. Patrick approved the H2 close and
the improvement directions in `docs/SUCCESSOR_PLAN.md`. That approval includes
local implementation, verification, and coherent local commits. It does not
authorize pushing, deploying the Worker, publishing the app, changing remotes,
or importing the donor process machinery.

## Read first

Read these files completely before acting:

1. `I:\dynamic-drought-module\AGENTS.md`
2. `I:\dynamic-drought-module\docs\SUCCESSOR_PLAN.md`
3. `I:\dynamic-drought-module\POST_MORTEM.md`
4. This handoff

The key operating lesson is that user-visible work and truthful receipts come
before process maintenance. Do not add a harness, phase ledger, review queue,
or a second planning clock.

## Expected repository state

Expected branch and committed head:

- Branch: `feature/heatrisk-legibility`
- HEAD: `0ee9706 feat: add landscape briefing context`
- Parent: `b244645 feat: add HeatRisk legibility sequence`
- Earlier shell commit: `cbcadf8 feat: add main-screen navigation shell`
- Baseline: `b20489a scaffold: establish clean DDM v0.6.24 baseline`

The working tree is intentionally dirty with the uncommitted H2
implementation and the planning artifacts requested by Patrick.

Expected modified files:

- `README.md`
- `docs/COVERAGE_MATRIX.md`
- `scripts/check-activation-budget.mjs`
- `scripts/generate-coverage-matrix.mjs`
- `src/config/urls.ts`
- `src/impact/brief-narrative-selector.ts`
- `src/impact/briefing.ts`
- `src/impact/hydrate.ts`
- `src/impact/sources.ts`
- `src/impact/types.ts`
- `src/styles/app.css`
- `src/ui/impact-panel-runtime.ts`
- `src/ui/impact-panel.ts`
- `src/ui/island/place-studio.tsx`
- `src/ui/mobile-sheet.ts`
- `tests/heat-h0-cancellation.spec.ts`
- `tests/m-breadth-honesty.spec.ts`
- `workers/proxy/src/index.ts`
- `workers/proxy/wrangler.toml`

Expected untracked files:

- `docs/H2_CLOSE_FRESH_SESSION_HANDOFF_2026-07-29.md`
- `docs/SUCCESSOR_PLAN.md`
- `src/config/geography.ts`
- `src/config/source-capability.ts`
- `src/impact/heat-synthesis.ts`
- `src/impact/nws-point.ts`
- `src/impact/point-heat.ts`
- `src/impact/source-policy.ts`
- `src/util/bounded-cache.ts`
- `tests/heat-h2-cancellation.spec.ts`
- `tests/heat-h2-point-heat.spec.ts`
- `tests/worker-proxy-policy.spec.ts`

Start with:

```powershell
Set-Location I:\dynamic-drought-module
git status --short --branch
git log --oneline --decorate -8
git diff --check
```

If the branch, HEAD, or working tree differs beyond the files above, stop
before writing and explain the exact difference. Do not reset, clean, stash,
or discard anything.

This successor has no configured Git remote. The donor repositories remain
read-only.

## What the transition has produced

The successor was rebuilt from a clean v0.6.24 application baseline without
the old harness, process ledgers, handoff archive, or donor Git history.

Committed successor work:

1. Main-screen navigation shell, hazard clusters, minimap, time navigation,
   response summaries, and URL-state integration.
2. Issuer-accurate HeatRisk colors and classes, exact-frame identify, a
   seven-day selected-place sequence, day-specific briefing claims, and
   compact mobile and embed keys.
3. Exact Pacific Northwest Level III and IV ecoregion landscape briefing
   context with dated terrain, soil, land-cover, fuels, provenance, and honest
   absence for boundary kinds without one exact bundle.

Uncommitted H2 work:

1. Canonical selected-place geography for the contiguous United States,
   Alaska, Hawaii, Puerto Rico, served territories, American Samoa, Canada,
   transboundary selections, and unknown geography.
2. Independent per-source capability that allows national NWS point heat
   without activating unvalidated drought, fire, climate, ENSO, water, or
   resource synthesis.
3. Shared NWS point discovery for grid data, station lists, point forecast,
   and alerts.
4. Geometric nearest-station selection, latest observation, station distance,
   timestamp, temperature, relative humidity, and heat index when populated.
5. Bounded current and future grid series for temperature, maximum and minimum
   temperature, apparent temperature, heat index, Wet Bulb Globe Temperature,
   and relative humidity.
6. Exact untouched NWS `validTime` strings plus parsed interval bounds.
7. A six-request full-path ceiling:
   `/points`, grid data, station list, latest observation, point forecast, and
   active alerts.
8. Per-briefing in-flight deduplication and a bounded 48-entry
   completed-response TTL cache. Aborted and failed work is never promoted to
   shared cache.
9. Cross-source heat synthesis that presents issuer reads together without a
   DDM heat class or threshold.
10. Critical-first rendering across desktop, mobile, embed, and Place Studio.
11. Exact `api.weather.gov` Worker allowlisting and an identifying User-Agent.
12. Generated independent heat coverage and a durable note that the same
    source fence should be applied to fire.

Key implementation files:

- `src/config/geography.ts`
- `src/config/source-capability.ts`
- `src/impact/source-policy.ts`
- `src/impact/nws-point.ts`
- `src/impact/point-heat.ts`
- `src/impact/heat-synthesis.ts`
- `src/impact/hydrate.ts`
- `src/ui/impact-panel-runtime.ts`
- `src/impact/brief-narrative-selector.ts`
- `src/util/bounded-cache.ts`

## Latest verification receipts

The latest code state passed:

- `npm run gate`
- `npm --prefix workers/proxy run typecheck`
- 26 focused HeatRisk, point-heat, and cancellation tests
- 62 affected heat, mobile, embed, navigation, landscape, accessibility, and
  Worker-policy tests
- `npm run test:serial`: 641 passed

Latest measurements:

- Eager app payload: 47.2 kB gzip.
- Point-heat first-activation closure: 24.2 kB gzip.
- Enforced point-heat cap: 25 kB gzip.
- Full NWS request ceiling: six requests.

The final serial run was clean. Expected console messages came from tests that
deliberately inject raster failures and listener exceptions.

## What is not complete

1. H2 is not committed.
2. Full manual H2 visual QA is incomplete. Playwright covered mobile and embed,
   and one desktop failure screenshot was inspected, but the in-app Browser
   was unavailable. Exercise `1440x900`, `390x844`, `400x600`, and `200x600`
   deliberately.
3. Post-implementation live conformance across representative NWS offices and
   territories is incomplete. Fixture coverage is strong but is not proof of
   every live office shape.
4. The Worker dependency install reported three high-severity audit findings.
   They were not automatically modified.
5. The Worker allowlist revision is not deployed.
6. `URLS.nwsApiUseWorker` is intentionally `false`.
7. The successor has not been published and has no configured remote.
8. Fire expansion is a documented follow-on only.

## Required sequence for this session

### A. Reconstruct and review

1. Read the required files.
2. Inspect the complete diff, not only the new adapters.
3. Confirm that:
   - explicit selected-place identity wins over camera framing;
   - independent point heat does not run unrelated regional sources;
   - observation and grid values remain separate;
   - null values never become zero or an all-clear;
   - raw valid intervals survive unchanged;
   - every non-trivial request is time-bounded and cancellable through body
     consumption;
   - stale frame or place work cannot overwrite current synthesis;
   - all upstream-rendered strings are escaped;
   - no DDM heat or fire class is introduced.

Make only evidence-driven corrections. Do not redesign working H2 behavior.

### B. Adopt the immediate improvements

1. Inspect the Worker audit findings. Prefer a narrow compatible update or a
   documented deferral. Never run a broad automatic audit fix.
2. Add a deterministic Worker revision identifier to `/healthz` and cover it
   with a focused test. Do not deploy it.
3. Recheck the point-heat activation measurement and its limited headroom.
   Improve the boundary only if the change is natural, small, and measurable.
   Do not begin a bundler or briefing refactor merely to reduce the number.
4. Preserve `docs/SUCCESSOR_PLAN.md` as the concise priority source. Do not
   create another planning file unless Patrick explicitly asks.

### C. Complete H2 evidence

Use deterministic fixtures for assertions and dated live checks for
conformance.

Required responsive QA:

- desktop `1440x900`;
- mobile `390x844`;
- embed `400x600`;
- embed width floor `200x600`.

Required behavior coverage:

- one contiguous United States place;
- Alaska or Hawaii;
- a reachable territory when practical;
- American Samoa no-grid fixture;
- Canada unavailable fixture;
- null optional fields;
- slow or stalled response body;
- place change during hydration;
- repeat briefing open;
- embed and URL restoration.

Do not add new place catalogs to make a territory reachable. State fixture-only
coverage plainly.

Verification order:

```powershell
npm run typecheck
npm run scan:emdash
$env:CI = '1'
npx playwright test <focused H2 and affected specs> --workers=1
npm run gate
npm --prefix workers/proxy run typecheck
npm run test:serial
```

Run the full serial suite once after the final code change, not after every
small edit.

### D. Commit and report

When the H2 closeout is clean, make a small number of coherent local commits.
Do not rewrite the three successor commits. Do not push.

Report:

- user-visible outcome;
- architecture and geography behavior;
- exact files and commits;
- request accounting and activation measurements;
- targeted, gate, Worker, and full serial results;
- visual QA viewports;
- dated live-conformance findings;
- Worker audit disposition;
- known limitations;
- final Git status;
- confirmation that no donor, remote, deployment, or published site changed.

Stop after the local release candidate and request explicit authorization
before Worker deployment or successor publication.

## What follows H2

After an authorized operational release:

1. Apply the same canonical geography, per-source policy, temporal support,
   bounded cache, and issuer-preserving synthesis to fire.
2. Keep active incidents, smoke, alerts and outlooks, Wildfire Hazard
   Potential, drought, and fuels semantically separate.
3. Do not create a DDM fire score.
4. Refine local-time presentation, unit legibility, and critical-first wording
   with real users.
5. Evolve one shared source contract incrementally. Do not build a generalized
   framework before a real source needs it.
6. Extract seams from large modules only when visible product work already
   touches them.
7. Establish one simple successor publication path without importing the
   donor harness or release bureaucracy.

The complete approved direction and confidence gaps are in
`docs/SUCCESSOR_PLAN.md`.
