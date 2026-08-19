# Release notes

## v0.6.25

`v0.6.25` remains the package version. The August 18 application runtime was
merged as `eed7967dea2e9f34214794ca158eb65eebc30113` and successfully deployed
through the normal Pages workflow. Repository release tags currently stop at
`v0.6.23`; neither the August 13 nor August 18 refinement assigned a new tag
or package version.

### 2026-08-19: power infrastructure context for the 3D Fire view

[Pull request 14](https://github.com/atniclimate/dynamic-drought-module/pull/14)
added the second issuer-published context layer set to the desktop 3D Fire
mode: transmission lines baked from the archived federal HIFLD dataset plus
live EIA power plants, riding the same `fire3d` activation as non-fatal
companions of the fuels drape.

- The transmission lines are a bundled 2,580,885-byte vector PMTiles archive
  (6,941 features, z0-10), a one-time bake of the ARCHIVED HIFLD dataset via
  the public Esri Federal User Community copy (the HIFLD Open program was
  discontinued 2025-08-26; the item states it is archived, unmaintained,
  last updated 2024-09-30). The in-app qualification carries the mandatory
  currency caveat, the mixed operational-status disclosure, and the honest
  absence statement for substations and distribution lines. Line width
  follows the issuer's seven voltage classes in a single color; unknown
  voltage draws dashed at the thinnest width so missing issuer data never
  reads as a definite low-voltage line.
- Power plants come live from the independently maintained EIA layer in one
  bounded, cancellable request, and the legend prints the issuer's reporting
  Period computed across all features, never the word "live". The EIA layer
  joined the upstream-drift monitor with a content tripwire.
- Every disclosure is composed from what actually rendered: a partial
  degrade names only its live half, in the legend and the embed chip alike.
  Both surfaces seat in a new context-overlay band between condition
  surfaces and event overlays.
- A California-only CPUC High Fire Threat District layer was evaluated and
  declined on license and framing grounds, recorded in
  [`design/fire3d-context.md`](design/fire3d-context.md).

Validation: `npm run gate` clean; the fire3d and wildfire-source-semantics
specs passed 35/35 serially; the full serial browser run at the stack head
reported 792 passed with only the known SPC preset flake, recorded on the
pull request before merge.

### 2026-08-18: LANDFIRE fuel-model drape for the 3D Fire view

[Pull request 12](https://github.com/atniclimate/dynamic-drought-module/pull/12)
added the first issuer-published context layer to the desktop 3D Fire mode
(itself merged earlier the same day in `5679477`): a LANDFIRE 2024 Scott and
Burgan 40 fuel-model (FBFM40) drape over the 3D terrain.

- The drape is a bundled 25,749,464-byte PNG PMTiles archive (z0-8, 512 px)
  whose pixels were rendered by the LANDFIRE ImageServer's own class colors;
  the module chooses no palette and computes nothing from the classes. The
  in-app legend lists the issuer's full 44-class key with a
  snapshot-not-a-prediction qualification, and the bake refuses
  all-opaque-black tiles (the unpopulated-mosaic signature that made LF2025
  unsafe to bake before its December 2026 completion).
- Context layers ride the existing `fire3d` activation as non-fatal
  companions; the active set is observable at `data-ddm-fire3d-context`.
- The 3D Fire control now carries an always-visible non-prediction
  disclosure beside the coverage note, and "digital twin" and "simulation"
  joined the surface-vocabulary banned list. The durable honesty doctrine
  for the context view is tracked in
  [`design/fire3d-context.md`](design/fire3d-context.md).

Validation: `npm run gate` clean; the fire3d and wildfire-source-semantics
specs passed (17 and 15 tests); the full serial browser run before merge is
recorded on the pull request.

### 2026-08-18: mobile map interface refinement

[Pull request 7](https://github.com/atniclimate/dynamic-drought-module/pull/7)
merged the owner-annotated phone refinement to `main` as `eed7967`.

- The mobile Fire key is now a safe-area-aware `#004040` glass card with
  stacked source categories and an overflow-only disclosure.
- Share and Reset form the upper utility stack. ENSO, Fire, Drought, Heat,
  and the one authoritative Satellite control form the lower quick-view
  spine without introducing parallel state.
- The two live MapLibre scale calculations remain dynamic but now read as
  transparent rulers. A non-modal information region derives its content
  from active key, source, status, basemap, and governed Tribal-geography
  state.
- Current Wildfire and Wildfire Complex perimeters share one restrained
  layer-level color pulse. Prescribed and other or unclassified perimeters
  remain static, and reduced motion uses the static midpoint color.

Validation passed `npm run gate`; the serial browser run reported 761 tests
passed plus four geometry checks; and the focused mobile, information,
Satellite, responsive, and wildfire matrix reported 36 tests passed. The
implementation run itself did not deploy. After the pull request merged, the
normal Pages workflow successfully deployed `eed7967` in run
[`32158224612`](https://github.com/atniclimate/dynamic-drought-module/actions/runs/32158224612).

### 2026-08-13: annotated interface refinement

[Pull request 6](https://github.com/atniclimate/dynamic-drought-module/pull/6)
merged two owner-annotation rounds to `main` as `300703e`.

- The Brief shell removes redundant visible summary copy, keeps the current
  condition receipt pinned, and exposes the categorical map key through a
  compact keyboard-accessible disclosure.
- The framing minimap uses hazard-specific fills for both cluster and granular
  URL compositions, keeps Hawaii legible, and presents the drought mean and
  affected-share channels distinctly.
- Recent NOAA GeoColor became the product-default basemap. An absent
  `basemap` parameter selects satellite, while `basemap=default` records the
  explicit satellite-off choice and leaves subdued OpenStreetMap visible.
  This superseded the initial v0.6.25 historical EOX ground treatment.
- Metric and imperial scale controls were joined visually while retaining
  MapLibre's live distance calculations.

Validation passed `npm run gate` and the serial browser run reported 748
passed with 1 intentionally skipped, followed by visual review at desktop,
compact desktop, and phone viewports.

### 2026-08-10: interface integration publication

The initial `v0.6.25` interface release was merged to `main` in `9c35bbf` and
deployed to GitHub Pages on 2026-08-10.

That checkpoint integrated Drought and Wildfire into one responsive Brief rail,
while preserving URL state, mobile behavior, embeds, sidebar controls, and the
six honest layer states. It added disclosed EOX Sentinel-2 2016 historical
ground over an OpenStreetMap fallback, a Natural Earth physical-land framing
minimap, an approximate North American Drought Monitor navigation summary, and
a source-fenced Wildfire overview. The Wildfire overview checks current mapped
National Interagency Fire Center perimeter representations first and may show
qualified static 2023 Wildfire Hazard Potential context only after a verified
zero count. It never treats a failed perimeter request as an all-clear.

At that initial publication, recent NOAA GeoColor imagery was contextual and
opt-in. Hazard Mapping System smoke kept its own source time and meaning.
Follow-up fixes scoped
raster settlement to the selected source, kept the mobile imagery disclosure
clear of controls, and prevented late HeatRisk hydration from overwriting a
user-selected day.

The feature runtime was accepted at
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`. The merged `main` release passed
`npm ci`, `npm run gate`, and `npm run test:serial -- --reporter=dot` with 746
passed, 1 intentionally skipped, and 0 failed across 747 tests in 101 files.
The GitHub Pages workflow repeated the release gate before deployment.

The published application includes regional NIFC framing counts but not the
deferred selected-place NIFC briefing engine. Opening that engine remains a
separately authorized product milestone.
