# DDM successor plan

Updated 2026-07-29.

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
  `665effc feat: prepare NWS proxy for point heat`. It allowlists only
  `api.weather.gov`, supplies an identifying User-Agent, and reports revision
  `2026-07-29-nws-point-heat-v2` from `/healthz`. The v2 release correction
  caps the Worker's completed-response edge cache at 60 seconds while
  preserving the upstream Cache-Control header returned to clients.
- Neither H2 commit is deployed or published.
- `URLS.nwsApiUseWorker` remains `false` until the Worker revision is deployed
  and verified.
- This successor repository has no Git remote and no automatic publication
  workflow.

Latest verification receipts:

- `npm run gate`: passed.
- `npm --prefix workers/proxy run typecheck`: passed.
- Affected heat, mobile, embed, navigation, landscape, accessibility, and
  Worker-policy coverage: 101 passed.
- `npm run test:serial`: 646 passed.
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

### 1. Complete the operational release

Deployment and publication are separate from local H2 close and require
explicit authorization.

After authorization:

1. Deploy the reviewed Worker revision.
2. Verify `/healthz`, the revision identifier, the exact NWS host allowlist,
   the identifying User-Agent, response-body transparency, redirect guards,
   and the 60-second edge-cache policy.
3. Set `URLS.nwsApiUseWorker` to `true` in the same release.
4. Rebuild and rerun the critical heat, cancellation, Worker-policy, embed,
   and URL-state checks.
5. Establish one simple, reviewable publication path for the successor. Do not
   import the donor harness or its process-only release machinery.
6. Publish only after the deployed Worker and static artifact have matching
   receipts.

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

### 3. Refine comprehension and maintainability

These improvements are approved directions, not one release-blocking
refactor. Apply them incrementally as product work reaches the relevant seam.

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
- real-device behavior at the full responsive viewport matrix;
- deployed Worker and successor publication behavior.

Treat a green test suite as evidence for code behavior, not as proof of
upstream reliability, production configuration, or user comprehension.

## Explicit non-goals for H2 close

- No fire implementation.
- No new national place catalog.
- No Canadian heat-source research.
- No new heat thresholds, severity class, or blended heat score.
- No broad briefing redesign.
- No general refactor of the largest modules.
- No harness, phase clock, review queue, change ledger, or parallel status
  system.
- No push, deployment, publication, or remote change without explicit
  authorization.
