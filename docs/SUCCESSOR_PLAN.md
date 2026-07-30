# DDM successor plan

Updated 2026-07-30.

This is the concise product plan for the successor repository. It is not a
phase ledger, review queue, or second implementation clock. Keep it current by
replacing completed priorities with the next user-visible priority. Ordinary
Git history remains the durable record of completed work.

## Product objective

Help a person answer:

> What does this mean for us, here, now?

The module must remain static, embeddable, mobile-first, source-honest, and
maintainable by a small team. Tribal sovereignty, Treaty representation
caveats, source provenance, cancellation, URL state, and the six canonical
layer states remain invariants.

## Current successor state

- Branch: `feature/heatrisk-legibility`.
- The main-screen shell, seven-day HeatRisk sequence, and exact ecoregion
  landscape briefing are committed.
- H2 point heat is implemented, verified, and committed locally in
  `6f90be5 feat: add bounded NWS point heat briefings`.
- The H2 path uses canonical geography, independent per-source capability,
  bounded National Weather Service requests, a completed-response cache,
  richer time series, and issuer-preserving cross-source synthesis.
- Worker readiness is committed locally in
  `665effc feat: prepare NWS proxy for point heat`. It adds only the exact
  `api.weather.gov` host to the existing agency-host allow-list, supplies an
  identifying User-Agent for that host, and reports revision
  `2026-07-29-nws-point-heat-v2` from `/healthz`. The v2 release correction
  caps the Worker's completed-response edge cache at 60 seconds while
  preserving the upstream Cache-Control header returned to clients.
- Worker revision `2026-07-29-nws-point-heat-v2` is deployed at
  `https://ddm-proxy.atniclimate.workers.dev` as Cloudflare version
  `db84d0d3-454f-4fa0-bbb5-6c068025ddf9`.
- Live Worker verification passed for `/healthz`, the revision identifier,
  exact-host rejection, NWS response-body transparency, and Cross-Origin
  Resource Sharing headers. Source-level policy coverage pins the identifying
  User-Agent, redirect revalidation, and 60-second edge-cache ceiling.
- `URLS.nwsApiUseWorker` is now `true` in the verified local application
  release.
- The static successor is deployed and published at
  `https://atniclimate.github.io/dynamic-drought-module/` from GitHub `main`.
  Pages workflow run `30513860839` published `e1a9084`, which contains release
  merge `83fa417` and the corrected publication record.
- The local checkout has no configured Git remote. The existing GitHub Pages
  workflow on `main` remains the publication authority.
- The active continuation brief is
  `docs/ENGINE_PATHWAY_FRESH_SESSION_HANDOFF_2026-07-30.md`.

Latest verification receipts:

- `npm run gate`: passed.
- GitHub Pages host, font, embed-guard, and hillshade coverage: 10 passed.
- GitHub Pages workflow run `30513860839`: build, bundle gate, artifact upload,
  and deployment passed.
- Public live verification: the subpath root and entry asset returned 200, and
  the entry contained exact release receipt `e1a9084`.
- `npm --prefix workers/proxy run typecheck`: passed.
- `npm --prefix workers/proxy audit`: zero findings.
- Critical heat, cancellation, Worker-policy, embed, and URL-state coverage:
  52 passed.
- `npm run test:serial`: 649 passed.
- Root-host and subpath-relative static assets, same-origin fonts, embed
  behavior, URL state, and the bounded byte-identical hillshade fallback:
  16 passed.
- Responsive visual QA passed at desktop `1440x900`, mobile `390x844`, embed
  `400x600`, and the embed width floor `200x600`.
- Dated live NWS conformance on 2026-07-29 passed for Seattle, Fairbanks,
  Honolulu, San Juan, and Hagatna. Pago Pago returned point metadata without
  grid, station, or forecast links and followed the honest no-data path.
- Worker dependency audit: zero findings after the compatible Wrangler 4.115.0
  update.
- Eager application payload: 47.2 kB gzip.
- Point-heat first-activation closure: 24.2 kB gzip under a 25 kB cap.
- Full NWS point-heat, forecast, and alert path: at most six requests in the
  pinned integration test.

## Right sequence

### 1. Maintain the operational release

The reviewed Worker and GitHub Pages artifact are deployed, and the successor
release is published.

For later releases, preserve the same sequence: verify locally, deploy the
Worker only when its revision changes, push the reviewed release to GitHub
`main`, wait for the Pages workflow, then verify the public subpath, embed
operation, URL state, point heat, and exact deployed source receipt.

Use these state words precisely:

- **implemented locally**: code exists in the working tree;
- **verified**: the named checks passed against that code;
- **committed**: the verified code is in ordinary Git history;
- **deployed**: the external Worker or static artifact changed;
- **published**: users can reach the successor release.

### 2. Expand the fire module

After H2 is released, apply the same source fence to fire:

- canonical selected-place geography;
- independent per-source capability;
- explicit temporal and spatial support;
- cancellable, time-bounded requests;
- bounded completed-response caching;
- issuer-preserving synthesis;
- critical-first mobile and embed reporting.

Keep the fire products semantically separate:

- active fire perimeters are observed incidents;
- smoke plumes are satellite-derived observations or interpretations;
- NWS and Storm Prediction Center products are alerts or outlooks;
- Wildfire Hazard Potential is long-term modeled context;
- drought, vegetation, and fuels are contributing conditions, not ignition
  predictions.

Do not create a DDM fire-risk score. Do not promote a broad regional
capability merely to activate one nationally supported source.

First bounded milestone: **selected-place active fire perimeters**.

Outcome: when a user opens a selected place, a concise fire block reports the
observed NIFC active perimeters supported by that place independently of the
regional drought-impact capability. The block appears before longer heat,
landscape, and drought context so the current incident read stays visible on
mobile and in embeds.

Acceptance criteria:

- Resolve NIFC capability from the existing canonical geography and shared
  per-source policy. Do not activate drought, smoke, alerts, outlooks, or
  long-term hazard context as a side effect.
- State the queried spatial support and the source's current-perimeter temporal
  meaning. A point fallback must be labeled as an area around the point, not as
  the selected boundary.
- Keep the request cancellable and time-bounded through response-body
  consumption. Cache only completed validated responses in a bounded,
  short-lived cache; do not promote failed or aborted work.
- Validate the issuer response before absence becomes `no data`. Report a
  transfer limit or otherwise incomplete selection as partial, never as an
  exact count.
- Drop results from a superseded selection. Report unsupported geography and
  source failure as `unavailable`; describe zero intersecting mapped perimeters
  as `no data`, not as an all-clear.
- Preserve NIFC perimeters as observed incidents. Do not blend them with HMS
  smoke, NWS alerts, SPC outlooks, Wildfire Hazard Potential, drought,
  vegetation, or fuels, and do not create a DDM severity or risk class.
- Verify the dedicated fire block at the established desktop, mobile, embed,
  and 200-pixel embed-width viewports, with focused cancellation, cache,
  partial-response, absence, and source-isolation coverage.

### 3. Continue the engine-first successor pathway

The selected-place NIFC milestone remains the only active implementation
priority. After it closes, choose the next bounded user-visible milestone from
the engine directions below based on source readiness and user consequence.
This is a directional product backlog, not a phase clock or authorization to
develop the engines in parallel.

Drought engine:

- Give USDM, DSCI, gridded drought indices, CPC outlooks, and international
  drought editions independent source capability instead of inheriting one
  broad regional synthesis flag.
- Add a selected-place gridded-index value or area read only after its spatial
  support, native time step, missing-value behavior, and transport are verified.
  Preserve index duration, valid time, and issuer units rather than converting
  the result into a DDM drought class.
- Keep USDM, the Canadian Drought Monitor, the North American Drought Monitor,
  Province of British Columbia levels, vegetation stress, and rapid-onset
  guidance as distinct products with distinct editions and meanings.

Heat engine:

- Preserve the existing separation among NWS observations, grid guidance,
  forecasts, active alerts, and HeatRisk.
- Complete the comprehension seam: show local human-readable time before the
  raw issuer interval, test unit presentation, and make the first read point to
  an appropriate action or resource without hiding provenance.
- Evaluate week-2 CPC calibrated extremes guidance only after its machine
  transport, schema, cadence, coverage, and issuer qualifications are verified.
  Maximum temperature, minimum temperature, and official hazards products must
  stay separate from HeatRisk and from any DDM-authored severity.

Fire engine:

- After the NIFC observed-perimeter block, source-fence NWS fire-weather alerts,
  HMS smoke, SPC outlooks, and Wildfire Hazard Potential independently.
- Keep incident, smoke, alert, outlook, fuels, vegetation, drought, and
  long-term hazard context in separate source rows with their own spatial and
  temporal support.
- Let a missing source remain unavailable or no data. Do not infer ignition,
  containment, exposure, or an all-clear from the absence of one product.

Water engine:

- Correct the water-supply parser before expanding its role: blank numeric
  fields must not become zero, echoed request dates must not be labeled as
  issuer dates, and malformed rows must not become observations.
- Replace silent representative-point substitution with explicit selected-basin
  or named-station support. Keep observed telemetry, snow water equivalent,
  precipitation, soil moisture, reservoir state, and water-supply forecasts
  semantically separate.
- Give each water source independent geography, capability, request budget,
  completed-response cache, and honest absence. Do not create a blended DDM
  water score.

Shared usability outcome:

- Render the most consequential current source first on mobile and in embeds,
  followed by short independently qualified source rows.
- Keep local time and plain units visible, with raw intervals, time series,
  provenance, uncertainty, and source links in progressive disclosure.
- Preserve accessible source states and connect the briefing to an appropriate
  next action or stewardship-ordered resource where the evidence supports one.
- Validate comprehension with Tribal natural resource staff, emergency
  managers, and agency users after the engine seams are stable.

The CPC Week-2 Probabilistic Extremes Tool is logged only as a candidate in
`docs/SOURCES_CATALOG.yaml` and `docs/IDEAS.md`. Candidate status does not add
runtime support, Worker access, capability, or a release commitment.

### 4. Keep comprehension and maintainability inside engine work

These improvements are approved directions, not one release-blocking
refactor. Apply only the smallest comprehension or code-health correction
needed when engine work reaches the relevant seam.

User comprehension:

- Show a local human-readable time before the exact issuer ISO interval, while
  retaining the raw interval in progressive disclosure.
- Test unit presentation and critical-first wording with Tribal natural
  resource staff, emergency managers, and agency users.
- Keep the first visible read concise; keep raw time series and provenance
  available in the full report.
- Evaluate whether the briefing helps a user identify an appropriate next
  action or resource, not merely understand a value.

Source architecture:

- Evolve one shared source contract containing geography, spatial support,
  temporal meaning, capability state, provenance, request budget, cache
  lifetime, and honest absence.
- Reuse the heat contract for fire. Do not create a separate fire framework.
- Reconcile the broad family capability matrix and per-source policy
  incrementally so their responsibilities stay obvious and do not drift.

Code health:

- Extract owned seams from large files such as `src/ui/sidebar.ts`,
  `src/ui/island/place-studio.tsx`, `src/config/urls.ts`, and
  `src/styles/app.css` only when a user-visible change already touches them.
- Avoid a broad cleanup campaign.
- Preserve strict TypeScript, named contracts, lazy activation, and output
  escaping at every upstream-data rendering boundary.

Operations:

- Resolve or explicitly accept Worker dependency audit findings before
  deployment.
- Extend scheduled upstream checks to validate NWS response shape and Worker
  health without asserting changing live values.
- Consider a privacy-preserving local diagnostic export containing source
  statuses, request timing, and qualifications. It must not add analytics,
  telemetry, credentials, or persistent user tracking.

Development workflow:

- One user-visible milestone at a time.
- One ordinary issue with outcome and acceptance criteria, not a harness.
- Small, coherent commits at durable checkpoints.
- Fast direct tests during implementation, affected Playwright coverage next,
  the project gate near completion, and the full serial suite once at final
  closeout.
- Concise progress updates during long work.
- Screenshots, live-conformance notes, and test output are receipts, not a new
  review ecosystem.
- Do not carry a large uncommitted cross-cutting change into the next
  milestone.

## Confidence and validation focus

High confidence:

- fixture-backed regression safety;
- cancellation and stale-result protection;
- heat-source isolation from unrelated regional drought and fire work;
- observation and grid separation;
- no DDM-authored heat classification.

Needs more evidence:

- nationwide selection flows outside the Pacific Northwest;
- NWS schema variation across offices and territories;
- real payload sizes and cache effectiveness;
- real-user comprehension of cross-source heat wording;
- real-device behavior at the full responsive viewport matrix.

Treat a green test suite as evidence for code behavior, not as proof of
upstream reliability, production configuration, or user comprehension.

## Current boundaries

- Complete one user-visible engine milestone at a time, beginning with the
  selected-place NIFC active-perimeter read.
- No broad visual redesign, navigation rewrite, CSS cleanup, or additional
  publication until the underlying drought, heat, fire, and water engine seams
  are further developed. Small semantic and accessibility corrections required
  to understand an engine milestone remain in scope.
- No activation of the CPC extremes candidate until a separate source
  verification establishes transport, schema, cadence, coverage, terms, and
  honest absence.
- No new DDM threshold, severity class, blended hazard score, ignition
  prediction, or all-clear.
- No new national place catalog or general refactor of the largest modules
  unless a bounded user-visible engine milestone requires that seam.
- No harness, phase clock, review queue, change ledger, or parallel status
  system.
- No push, deployment, publication, or remote change without explicit
  authorization.
