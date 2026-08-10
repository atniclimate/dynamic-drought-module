# Release notes

## v0.6.25

`v0.6.25` is the current published application. The interface release was
merged to `main` in `9c35bbf` and deployed to GitHub Pages on 2026-08-10.

The checkpoint integrates Drought and Wildfire into one responsive Brief rail,
while preserving URL state, mobile behavior, embeds, sidebar controls, and the
six honest layer states. It adds disclosed EOX Sentinel-2 2016 historical
ground over an OpenStreetMap fallback, a Natural Earth physical-land framing
minimap, an approximate North American Drought Monitor navigation summary, and
a source-fenced Wildfire overview. The Wildfire overview checks current mapped
National Interagency Fire Center perimeter representations first and may show
qualified static 2023 Wildfire Hazard Potential context only after a verified
zero count. It never treats a failed perimeter request as an all-clear.

Recent NOAA GeoColor imagery remains contextual and opt-in. Hazard Mapping
System smoke keeps its own source time and meaning. Follow-up fixes scoped
raster settlement to the selected source, kept the mobile imagery disclosure
clear of controls, and prevented late HeatRisk hydration from overwriting a
user-selected day.

The feature runtime was accepted at
`7b19a9b733c65ed1fe8eeed69427461997fe3f70`. The merged `main` release passed
`npm ci`, `npm run gate`, and `npm run test:serial -- --reporter=dot` with 746
passed, 1 intentionally skipped, and 0 failed across 747 tests in 101 files.
The GitHub Pages workflow repeated the release gate before deployment.

This checkpoint includes regional NIFC framing counts but not the deferred
selected-place NIFC briefing engine. Opening that engine remains a separate
`v0.7.0` decision after explicit closure of the `0.6.x` interface line.
