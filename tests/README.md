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
the run. The preview serves at the `base` subpath
(`http://localhost:4173/`).

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

The browser suite is currently a manual release check; it is not run by the
Pages deploy workflow. The deploy runs the root non-browser gate. Run the
focused affected specs during development and `npm run test:serial` when a
change affects shared navigation, map lifecycle, state, or release readiness.

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
