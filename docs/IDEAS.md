# Successor idea bank

Updated 2026-07-30.

This compact bank preserves candidate product opportunities that are not
active implementation commitments. The ordered development direction and the
one current milestone live in `docs/SUCCESSOR_PLAN.md`. Do not add statuses,
phase clocks, review queues, or a second roadmap here.

## Candidate source: CPC Week-2 Probabilistic Extremes Tool

Potential source:
`https://www.cpc.ncep.noaa.gov/products/predictions/threats/extremesTool.php`

NOAA's Climate Prediction Center describes this as calibrated Global Ensemble
Forecast System model guidance for the week-2 period. The official description
names maximum temperature, minimum temperature, accumulated precipitation, and
maximum wind guidance, with probabilities for issuer-defined percentiles and
absolute thresholds. CPC says the guidance helps inform, but is not identical
to, its official hazards outlooks.

Potential successor uses:

- heat: separately labeled maximum-temperature and warm-night guidance after
  source verification;
- drought: precipitation-extreme context and possible comparison with official
  rapid-onset drought products, without treating the guidance as drought state;
- fire: wind and temperature context kept separate from incidents, smoke, NWS
  alerts, and SPC outlooks;
- water: precipitation and the landing page's snow-water-equivalent download
  lead, after resolving its relationship to the four variables documented on
  the tool's description page.

Before any implementation:

- identify and verify the machine endpoint rather than scraping the interactive
  page;
- verify schema, update cadence, valid periods, spatial support, missing data,
  Cross-Origin Resource Sharing posture, redistribution terms, and archive
  behavior;
- reconcile the description page's four-variable list with the landing page's
  additional snow-water-equivalent download;
- determine whether the calibrated guidance or the official CPC hazards
  products better answer the selected-place question;
- preserve issuer probabilities and thresholds exactly, and do not derive a
  DDM risk or severity score.

The machine-readable candidate record is `docs/SOURCES_CATALOG.yaml`.

## Engine usability ideas to retain

These are acceptance qualities for future engine milestones, not separate
design projects:

- a concise critical-first selected-place read on desktop, mobile, and embeds;
- independent source rows with honest unavailable, no-data, and partial states;
- local human-readable time before raw issuer intervals;
- plain units with raw values and provenance available in disclosure;
- next-action and stewardship-ordered resource routing where supported;
- real-user comprehension checks after the underlying engine behavior is
  stable.

Broad design work and publication remain deferred as recorded in the active
successor plan.
