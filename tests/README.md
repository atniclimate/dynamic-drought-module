# DDM smoke suite

A Playwright suite that builds the production bundle, serves it with
`vite preview`, drives it in a real browser, and asserts what a user would
see.

## Running it

```powershell
# PowerShell (from the repository root)
npm test                 # build, preview, run the suite headless
npm run test:report      # open the HTML report from the last run
```

The `webServer` block in `playwright.config.ts` runs `npm run build && npm run
preview`, so a stale `dist/` can never be verified and a build failure fails
the run. The general suite uses `http://127.0.0.1:4173/`. A focused
`deployment-subpath.spec.ts` case maps the same production artifact to
`/dynamic-drought-module/`, the GitHub Pages repository seat, and verifies
that its relative entry assets and application boot work there.

Every run owns that preview process. If another process is already listening
on port 4173, the suite fails instead of reusing an unattributed build.

## What it asserts, and what it deliberately does not

Two doctrines shape the coverage.

1. **Production build, never the dev server.** The deployed site serves
   `dist/`; dev-only behavior would be a false pass.

2. **Deterministic backbone only.** The suite asserts structure and behavior
   that do not depend on live agency data:

   - `boot.spec.ts` - the map reaches its WebGL `load` and the sidebar builds.
   - `ux1-surfaces.spec.ts` - the four role groups render in order; condition
     surfaces are mutually exclusive; an old multi-surface link resolves to
     the first surface named; a deactivated surface clears its pill.
   - `ux2-presets.spec.ts` - the five preset chips render in order; a preset
     replaces the active layer set and holds the one-surface-at-a-time rule.
   - `url-state.spec.ts` - region and layers restore from a deep link; a
     toggle round-trips through the URL and a second toggle-on reuses the
     cached lazy-loaded module; embed mode survives a re-sync; expanding the
     sidebar in embed mode deliberately exits embed.
   - `telemetry.spec.ts` - every wired station row reaches a terminal state
     (never stuck on `loading...`); the link-only station stays empty.
   - `conditions-strip.spec.ts` - the three metrics render in order; off
     layers read an honest off state; the drought and fires tiles reflect the
     map when their layers render (the fires assertion skips honestly when
     the upstream is down rather than failing a correct app).
   - `legend.spec.ts` - one unified legend panel: sections order as surface,
     then events, then reference; a surface swap replaces only the surface
     section; the panel hides when the last legend layer turns off.
   - `hover-inspector.spec.ts` - the what-is-under-the-cursor readout names a
     feature from an active layer and clears on mouseout.
   - `fonts.spec.ts` - the brand fonts load from same-origin and no request
     reaches a font CDN (the self-hosting stewardship guarantee, enforced).

**Exact live values stay out of the gate.** Assertions like "Forebay 75.4 ft"
or "83 percent forecast" are flaky against live upstreams and belong in the
manual `ddm-ui-verifier` lane, where a blipping agency endpoint is a human
judgment call rather than a red CI run. The telemetry spec here asserts only
the honest-status contract (terminal, not a specific number), which is what a
regression would actually break.

Pull requests run the deterministic root gate and Worker typecheck (without
deploying the optional Worker) beside the browser suite; the Pages workflow
runs the root gate and build beside the same browser suite, and deploys only
when both have passed. Run
focused affected specs during development and `npm run test:serial` when a
change affects shared navigation, map lifecycle, state, or release readiness.

## How CI runs the suite

`playwright.config.ts` defines two projects. `chromium` holds every spec but
two; `chromium-3d` holds `fire3d-mode.spec.ts` and `view-contracts.spec.ts`,
the two files whose 3D cases build terrain, a sky, a smoke volume, and
context tiles on the software renderer and carry their own 120 to 180 second
budgets (the Node-level cases in `fire3d-mode` and the three non-3D contract
rows ride along; the split is by file, and both projects use the same
browser settings). Locally, `npm test` and `npm run test:serial` run both
projects, so coverage is the same in either seat.

In CI (`.github/workflows/browser-suite.yml`, called by both Validate and the
Pages deploy) each project is sliced with `--shard=i/n` onto its own runners,
one worker each: four shards for `chromium`, three for `chromium-3d`. Each
runner builds and serves its own `dist/`, so no shard reads another's state.
Each page is its own software-GL MapLibre context, so more runners is the
lever; more workers per runner is not (see the `workers` note in the config).
The shard counts were fitted to the 2026-08-28 idle serial baseline (general
16.4 minutes over 798 tests, 3D 13.7 minutes over 32) so every shard lands
near eleven minutes on the 2-core runner; re-fit them when the suite grows.

Every shard writes a job summary (passed, failed, flaky, skipped, and the
`file:line` of each failed or flaky test) from its JSON report through
`scripts/summarize-playwright-shard.mjs`. A shard that fails, or passes only
on retry, also uploads its HTML report (error text, ARIA error context,
stdout and stderr, timings) as a seven-day artifact named for the shard; a
clean shard uploads nothing. Traces and screenshots are off in CI: the
ordinary boot fetches live AIANNH and BIA boundary geometry that the runtime
holds in memory and never writes to disk (the project's hard rule 1; see the
NON-REDISTRIBUTION GUARD in `src/layers/aiannh.ts`), and a trace records
response bodies while a screenshot renders the polygons. The explicit
evidence captures in `fire3d-mode.spec.ts` (`fire3d-evidence/`, gitignored)
are skipped under `CI` for the same reason. Locally, traces, screenshots,
and the evidence captures stay on, in gitignored directories.

When `DDM_BUILD_SHA` or `DDM_BUILD_NONCE` is set in the environment (CI sets
both), `gotoApp` asserts the `<html>` build stamp on every boot it drives,
so each shard proves it exercised the build this run made.

The Node-level specs that deliberately drive a degrade path (a corrupt
archive, three tile errors in the rolling window, a dead fetch) capture the
runtime's `console.warn` through `captureWarnings()` in
`tests/map-harness.ts` and assert the exact list of warnings, so the honest
reason is part of the contract and its stack trace stays out of the shard
log; the captured text is kept as a `console.warn` annotation on the test
result, so a failure still carries the evidence.

## Headless WebGL

MapLibre GL needs a WebGL2 context. Headless Chromium has no GPU, so the
`chromium` project forces ANGLE over SwiftShader (pure-software GL) via launch
flags in `playwright.config.ts`. Without them the map never fires `load` and
the sidebar never builds.

## When you change a config table

The canonical strings the specs assert against (preset labels, role-group
headings, the pill vocabulary, default-on keys) are mirrored in
`tests/helpers.ts`. If you rename a preset or relabel a role group, update the
mirror there; the mismatch will otherwise surface as a failing spec, which is
the point.
