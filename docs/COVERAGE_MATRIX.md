# Coverage and capability matrix

<!-- GENERATED FILE. Do not edit by hand: edit src/config/capability-matrix.ts
     and run `npm run build:coverage-matrix`. `npm run gate` fails on drift. -->

What the Dynamic Drought Module (DDM) actually does today for each coverage
family, as recorded in `src/config/capability-matrix.ts` (the source of
truth; this file is generated from it). Levels: **full** (shipped and
verified), **partial** (shipped with the named limitation), **none** (not
supported; the note says why).

| Family | Display | Selectable place | Drought state | Landscape signature | Impact synthesis |
| --- | --- | --- | --- | --- | --- |
| Pacific Northwest (PNW) | full | full | partial | partial | partial |
| Contiguous United States (CONUS) | full | partial | partial | none | none |
| Alaska and Hawaii | partial | partial | none | none | none |
| Canada | partial | none | partial | none | none |
| Transboundary (Columbia Basin) | none | none | none | none | none |

## Notes

### Pacific Northwest (PNW)

- **Display** (full): The shipped framings render the PNW as the primary region.
- **Selectable place** (full): Tribal Nations, states, ecoregions, and watersheds are selectable typed places (watershed lists come from the live USGS WBD service); municipal labels are display-only.
- **Drought state** (partial): US Drought Monitor (USDM) polygons, DSCI, and the NIDIS SPI raster display; no gridded index feeds analysis or the briefing yet (the MCO value path lands in 0.8.0).
- **Landscape signature** (partial): The briefing lazily renders the baked terrain, soil, land-cover, and fuels signature for exact PNW Level III and IV ecoregion selections; other boundary kinds stay explicitly unavailable rather than being remapped to one ecoregion.
- **Impact synthesis** (partial): The shipped briefing composes USDM, outlooks, and telemetry with the evidence contract and shows the signature as separately labeled static ecoregion context; no gridded index input or signature-derived claim yet.

### Contiguous United States (CONUS)

- **Display** (full): The national framing renders CONUS on the same basemap and condition surfaces.
- **Selectable place** (partial): AIANNH/BIA and state selection exist nationally, but the behavior is unproven outside the PNW (N3 owns the proof).
- **Drought state** (partial): USDM polygons and the NIDIS SPI raster display cover CONUS; no gridded index feeds analysis or the briefing.
- **Landscape signature** (none): No signature inputs are baked outside the planned PNW pipeline.
- **Impact synthesis** (none): The briefing synthesis and resource routing are not validated outside the PNW.

### Alaska and Hawaii

- **Display** (partial): The Alaska framing includes the tested Aleutian extent; condition surfaces remain unverified for Alaska and Hawaii.
- **Selectable place** (partial): National AIANNH/BIA selection is unproven for Alaska and Hawaii; no validated catalogs there.
- **Drought state** (none): The shipped drought surfaces are not exercised or verified for Alaska or Hawaii.
- **Landscape signature** (none): No signature inputs exist for Alaska or Hawaii.
- **Impact synthesis** (none): No briefing support for Alaska or Hawaii.

### Canada

- **Display** (partial): British Columbia has a validated live basin display, the Canadian Drought Monitor has a committed monthly national snapshot, and the North American Drought Monitor supplies separate continental context; Canadian place catalogs do not ship.
- **Selectable place** (none): No Canadian place catalogs are wired.
- **Drought state** (partial): Province of British Columbia basin levels display with source dates, the Canadian Drought Monitor snapshot displays its month and class occupancy, and the North American Drought Monitor displays its separate consensus month; no edition is blended with another.
- **Landscape signature** (none): No Canadian signature inputs.
- **Impact synthesis** (none): No Canadian briefing support.

### Transboundary (Columbia Basin)

- **Display** (none): No mixed-edition transboundary frame; N6 requires a tested US/Canada data seam first.
- **Selectable place** (none): No transboundary place catalog exists.
- **Drought state** (none): US and Canadian drought editions differ; no reconciled surface exists.
- **Landscape signature** (none): No transboundary signature inputs.
- **Impact synthesis** (none): No transboundary briefing support.
