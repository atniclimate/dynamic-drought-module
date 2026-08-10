# Successor idea bank

Updated 2026-08-10.

This compact bank preserves candidate product opportunities that are not
active implementation commitments. The ordered development direction and the
one current milestone live in `docs/SUCCESSOR_PLAN.md`. Do not add statuses,
phase clocks, review queues, or a second roadmap here.

## Intake screen

Before promoting an idea into the plan, name:

- who acts on it and what decision changes;
- what existing interface or work it displaces;
- the exact source, time, coverage, missing-data, and stewardship contract;
- its behavior on desktop, mobile, `?embed=true`, and the 200-pixel embed;
- the smallest user-visible milestone and deterministic acceptance evidence;
- the explicit non-goal that prevents a score, forecast, all-clear, eligibility
  claim, surveillance feature, or new backend from appearing by implication.

The legacy material reviewed during the 2026-08-10 realignment is an idea
source only. Runtime configuration and code remain authoritative. The old
stage ledger, release phases, process harnesses, automatic write-backs, and
four-state layer vocabulary are not carried forward.

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
- fire: wind and temperature context kept separate from incidents, smoke,
  National Weather Service alerts, and Storm Prediction Center outlooks;
- water: precipitation and the landing page's snow-water-equivalent download
  lead, after resolving its relationship to the four variables documented on
  the tool's description page.

Before any implementation:

- identify and verify the machine endpoint rather than scraping the interactive
  page;
- verify schema, update cadence, valid periods, spatial support, missing data,
  Cross-Origin Resource Sharing posture, redistribution terms, archive
  behavior, and request budget;
- reconcile the description page's four-variable list with the landing page's
  additional snow-water-equivalent download;
- determine whether the calibrated guidance or the official CPC hazards
  products better answer the selected-place question;
- preserve issuer probabilities and thresholds exactly, and do not derive a
  DDM risk or severity score.

The machine-readable candidate record is `docs/SOURCES_CATALOG.yaml`.

## Interface and embed candidates

### Remember this place on this device

Offer an explicit save and forget control for the current canonical selected
place. Store it only on the visitor's device, never prompt for geolocation on
boot, and never send it to a service. First resolve how this composes with the
current `studio=place` and URL state; do not revive the old unratified
`?place=lon,lat` proposal by assumption.

### Offline field mode

Explore a service worker that caches the application shell and only explicitly
approved non-sovereign last-viewed data. Every cached response must retain its
source date and render an unmistakable offline or stale qualification. Census
American Indian, Alaska Native, and Native Hawaiian areas, Bureau of Indian
Affairs land-area representations, Treaty data, deployer-owned sovereign data,
and other sovereign-geography routes must be excluded from persistent cache
reads and writes. This needs a threat, quota, eviction, update, and embed review
before it can become a milestone.

### Downloadable selected-place briefing

Start with one self-contained print or document export before considering a map
PNG, animation, or video. Preserve issuer dates, retrieval and freshness notes,
attribution, evidence classes, uncertainty, resource links, and sovereignty
caveats. The export must not silently simplify `live (partial)`, `unavailable`,
or `no data` into a complete-looking report.

### Opt-in embed messaging

Explore a small versioned `postMessage` contract enabled only by an explicit
URL flag. It may announce or accept validated DDM state such as framing, hazard
view, horizon, and selected place, but never user identity or behavioral data.
Require strict origin handling, message-schema validation, backward
compatibility, and unchanged inert behavior for ordinary `?embed=true` use.

### Zero-tracking problem report

A visible link could open a prefilled issue containing only the shareable DDM
URL state and text the user explicitly enters. It must never submit
automatically, fingerprint the browser, attach network logs, or become
telemetry.

## Drought, vegetation, and water candidates

### Selected-place gridded drought values

Investigate point or bounded-area reads from an issuer-approved gridded product,
including the older Montana Climate Office Cloud-Optimized GeoTIFF lead. Do not
treat that source as adopted: reverify licence, anonymous access, range-request
Cross-Origin Resource Sharing, native time step, units, no-data values,
resolution, and browser cost. Preserve issuer units rather than converting the
value into a DDM drought class.

### Weekly vegetation-stress time surface

Reassess Vegetation Drought Response Index first and Quick Drought Response
Index separately against the existing time controls. Keep either product a
named observed vegetation-stress surface, not a replacement drought
classification. Old unwired endpoints are leads only and require fresh service,
licence, cadence, archive, mask, and client-transport verification.

### Snow-drought typing

Research a selected-place explanation that distinguishes warm snow drought
from dry snow drought. Promote it only if the required precipitation,
temperature, and snow-water-equivalent inputs and classification rules are
issuer-backed or independently audited. It must explain the evidence and must
not infer future water supply.

### Drought declarations and program routing

Determine whether maintainable authoritative declaration and program sources
exist before designing a surface. Keep observed drought, an official
declaration, program availability, and individual eligibility separate. Never
infer that a selected person, Tribe, land area, or operation qualifies.

### Telemetry densification

Consider viewport-bounded discovery across additional open station networks
only after each network's custody, licence, cadence, quality flags, pagination,
and request budget are verified. More stations are useful only if the interface
can name the network, nearest support, units, and freshness without implying
that sparse coverage means no condition.

## Fire candidates

### Issuer-published seven-day significant fire potential

Research an issuer-published multi-day product that could fill the gap between
the current Day 1 fire-weather outlook and long-term Wildfire Hazard Potential.
Verify its machine endpoint, category meaning, cadence, coverage, licence,
archive, Cross-Origin Resource Sharing, and missing-data behavior. Keep it
separate from NIFC perimeters, smoke, alerts, drought, fuels, and the static
2023 Wildfire Hazard Potential. Do not compute a DDM fire-risk score.

### Daily fire-perimeter history

First verify whether stable incident identity and honest historical editions
exist. A time stepper must not be inferred from the publication cadence of a
current-only feed, and changing geometry must not be presented as fire spread
without source-supported time semantics.

### Slow-variable fire context

After selected-place fire evidence is stable, consider a source-separated read
of current drought, vegetation, fuels, and landscape context. Show the inputs
independently and link to authoritative incident and warning products. Do not
blend them into ignition, containment, tactical guidance, an all-clear, or a
DDM score.

## Ocean and compound-condition research

### Marine heatwave category

Evaluate an issuer-operated marine-heatwave category product as a separate
observed ocean driver beside, not inside, ENSO. Verify category vocabulary,
cadence, licence, land and ice masks, source time, archive, and client-safe
transport. It must not be described as a drought forecast or a proven local
causal chain.

### Compound-condition flags

Explore whether the interface can state that independently sourced conditions
co-occur for a selected place and time. Every component must keep its own
issuer, clock, coverage, and state. Do not collapse the combination into a
severity score, alert, forecast, or causal claim.

### Deployer-owned community observations

Preserve the configuration idea for observations held and governed by a
deployer or participating sovereign authority. Require explicit custody,
authorization, provenance, and local deployment decisions. Do not centrally
aggregate the observations or bundle sovereign polygons.

## Ideas already absorbed or superseded

Do not reopen these as new work without a new bounded user-visible problem:

- the unified Drought and Wildfire interface, four hazard views, Place
  Selection Studio, framing minimap, horizon controls, briefing depth, and URL
  state are implemented;
- weekly United States Drought Monitor stepping and signed change presentation
  are implemented;
- Canadian Drought Monitor, North American Drought Monitor, and Province of
  British Columbia drought surfaces are registered separately;
- minimum temperature is part of current point-heat synthesis;
- current Wildfire presentation already keeps recent NOAA imagery, NIFC
  perimeters, Hazard Mapping System smoke, Storm Prediction Center outlooks,
  and Wildfire Hazard Potential distinct;
- League Spartan and Lexend are self-hosted. Do not import the old Google Fonts
  recommendation or its global two-pixel-radius and no-blue styling rules; and
- old wildfire and unified-interface prototypes informed the accepted
  integration. Their module trackers, promotion gates, and review ledgers are
  historical evidence, not a new planning system.

## Engine usability qualities to retain

These are acceptance qualities for future engine milestones, not separate
design projects:

- a concise critical-first selected-place read on desktop, mobile, and embeds;
- independent source rows with honest unavailable, no-data, and partial states;
- local human-readable time before raw issuer intervals;
- plain units with raw values and provenance available in disclosure;
- next-action and stewardship-ordered resource routing where supported; and
- real-user comprehension checks after the underlying engine behavior is
  stable.
