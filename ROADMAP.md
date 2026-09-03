# Dynamic Drought Module roadmap

DDM is an embeddable static web map of drought, wildfire, heat, and ocean
conditions. The next stretch of work finishes what is half-built rather than
adding new hazards: one Impact Briefing that answers four hazards across three
horizons, forecast controls that behave the same on every hazard screen, a
complete Fire module, a real tablet layout, and a citation behind every number
on screen.

The canonical plan, with stable task ids, decision gates, component tags, and
one testable acceptance sentence per task, is
[`docs/ROADMAP.yaml`](docs/ROADMAP.yaml). Completion is recorded there in place:
a finished task carries a one-line closing note and a replaced task names its
successor. Release history is in
[`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md).

## Posture

Work converges on one integration branch and lands as one pull request rather
than as a stream of per-action continuous integration receipts. Verification
runs locally on a ladder (`verify:quick` in seconds, `verify:smoke` in minutes,
`test:serial` for the whole suite before a landing), and hosted
checks confirm what local runs already proved. Owner authorization for merge,
deploy, tag, Worker publication, tracker mutation, and branch deletion is a
standing rule, not a per-task field. GitHub Pages is the current static host; a
local full-service server is the eventual one.

## Delivered foundation

The v0.6.26 source baseline includes the answer-first Brief and console views,
map-first phone controls, URL-governed state, iframe operation, responsive and
accessibility contracts, governed Fire 3D context, a USFS Wildfire Hazard
Potential drape, independent power infrastructure context, a bounded building
structures pilot, and a stylized HMS smoke-density volume. The smoke display is
not measured plume altitude or concentration, and the Fire view is not a
simulation or forecast. Work merged after v0.6.26 has no new version or tag yet
and appears in the release notes under Unreleased.

## Carried-forward phases

- **P0, release convergence and platform truth.** Mostly closed; the renderer
  version is decided and live (MapLibre GL JS 6.6.0), and what remains is globe
  projection and global low-zoom imagery.
- **P1, network lifecycle and failure honesty.** Response bodies under full
  deadlines, a complete cancellation seam, one activation-failure path, core
  controls that survive an optional chunk failure, typed internal layer keys.
- **P2, cross-view interaction coherence.** An honest exit from Fire 3D, a
  shareable Pacific camera for ENSO, and task-based real-device verification.
- **P3, Fire evidence pilots.** The qualified candidates one at a time: AirNow
  monitor points, the VIIRS thermal-anomaly canary, selected-place fire
  evidence, and infrastructure language claiming no damage or jurisdiction.
- **P4, ENSO observed-state product.** The primary user question, an
  index-first card, a Hovmoller prototype, and the probability-source question.
- **P5, smoke altitude research.** One bounded offline HRRR event, compared
  presentations, declared artifact budgets, NEXRAD kept to a case study.
- **P6, field capability and release readiness.** One selected field or
  coverage outcome, measured static delivery, and PMTiles archive limits.

## The 2026-09 backlog

- **P7, Impact Briefing: four hazards by three horizons.** Every one of the
  twelve cells states a sourced claim with its issuer, valid window, and
  geography, or reads unavailable.
- **P8, forecast uniformity and time controls.** A time bar on all four hazard
  screens, horizons that mean something distinct, one stamp grammar, and no
  blank surface across a horizon or day change.
- **P9, Fire module and 3D.** A 3D entry gated on capability rather than
  width, a legible hazard drape with stated terrain coverage, polygon-exact
  fire claims with incident coverage, and RAWS values that are read.
- **P10, interface balance and motion.** A real tablet band, tokenized motion
  covered by reduced motion, and four hazard screens that differ only where
  their evidence differs.
- **P11, minimap and popups.** A named condition on every hazard minimap or an
  honest navigation-only statement, camera feedback, and popups that answer a
  touch and can be dismissed from the keyboard.
- **P12, ENSO and marine.** A headline that matches the issuer's current
  advisory, horizons with distinct sources, cited regional tilt statements,
  and a marine product whose baseline can be cited.
- **P13, science defensibility and citations.** No invented band, cut point,
  or causal tail, and the methods the app already downloads made reachable.
- **P14, boot, architecture, and performance.** A boot that fails visibly, a
  leaner first paint, and rasters that can report `live (partial)`.
- **P15, platform.** The local full-service server end state, the renderer
  version and the browser floor it implies, and a linter for the code and the
  stylesheet.

## Decisions and acceptance

Owner decisions are explicit gates, not hidden implementation assumptions. The
MapLibre version and its cost are decided. The open ones cover the tablet
band, Fire 3D exit behavior, the ENSO camera, the order of the Fire evidence pilots, the ENSO
probability standard, the smoke pilot scope, the P6 outcome, the hosting path,
and the first ENSO question. Each is written out in the `decision_gates`
section of the canonical YAML with the tasks that wait on it.

Every shipped slice preserves source, time, geography, limitations,
accessibility, responsive behavior, URL state, iframe operation, cancellation,
and the six layer states. No slice broadens a claim's geography, time,
completeness, or certainty, and no source is blended into a DDM severity score.
