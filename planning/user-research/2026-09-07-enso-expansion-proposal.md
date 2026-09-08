# ENSO expansion proposal, received 2026-09-07: verdicts and wiring rule

Status: proposal, not a plan. Nothing here enters Wave 2. Owner filed.

## 1. Provenance

The text in the appendix was supplied to the owner on 2026-09-07 from outside
the repository (author and tool unknown). It is recorded verbatim, lightly
normalized to ASCII (en dashes to hyphens, curly quotes to straight, no
U+2014), so the verdicts below can be checked against what was actually
proposed. It is treated the way the conduct rules treat memory: a lead to
verify, not evidence. Every dataset it names is unverified until a session
fetches the file and records the receipt in `planning/references/register.yaml`.

## 2. The doctrine it is measured against

Four rules already binding on `src/impact/enso.ts`, each with its home:

1. ENSO shifts the odds, it does not set the outcome. Every regional statement
   is a tendency across past events, carries the modulators, and cites the
   issuer that states it. Nino 3.4 never declares a state on its own, and SOI
   never drives it. (`src/impact/enso.ts` header comment.)
2. CPC's own status lives in the ENSO Diagnostic Discussion, which is HTML:
   the module links it and never parses it. The same doctrine removed the
   probabilistic plume scrape on 2026-07-21 (T-P0-1). No scraping, no image
   digitization (DDM-P4-T05).
3. Every visible ENSO horizon activates evidence no other horizon shows, or is
   absent, and no horizon implies a forecast the app does not have.
   (DDM-P12-T02 acceptance, done 2026-09-07; DR-031; the S10 chrome fix.)
4. Issuer products are shown together and never combined into a DDM verdict.
   (`src/impact/heat-synthesis.ts`: "DDM shows them together but does not
   combine them into a new heat class".)

The proposal's stated aim is to turn "a point-index parser into a
multi-dimensional diagnostic pipeline". The module is a reader of issuer
products with a citation rule on purpose: its readers need to trace every
sentence to who said it, and CPC already employs the diagnosticians. Where the
proposal asks DDM to diagnose, it asks DDM to compete with the discussion it
links, with less data and no reviewers.

## 3. Verdicts, item by item

| Proposed item | What it actually is | Verdict | Where it belongs |
|---|---|---|---|
| Upper-ocean heat content anomaly, 0-300 m (NOAA CPC / PSL) | A real leading indicator of ENSO evolution; CPC and PSL publish the equatorial anomaly | CANDIDATE, as an observed index only, under the current horizon, in CPC's own words about what it means. The proposal's "guarantees a phase shift" is the exact claim rule 3 forbids | New decision record (draft in section 6) |
| Multivariate ENSO Index v2 (PSL) | A third phase index beside RONI and ONI | LOW VALUE. RONI is the driver by ruling; MEI can only add a divergence sentence. Skip unless a user asks | Backlog, unscheduled |
| Satellite sea surface height anomalies (GIBS / Copernicus) | A spatial raster layer | NOT enso.ts WORK. This is the marine product question already open | DDM-P12-T04, DR-033 (any anomaly shown names a citable baseline) |
| 850-hPa zonal wind, MJO, westerly wind bursts | CPC's own diagnostic inputs | NO. Restating CPC's diagnosis is what rule 2 prevents | Declined |
| NMME / C3S ensemble feeds for probability plumes | The machine-readable probability source | ALREADY A TASK, behind decision gate DDM-D06. NMME serves gridded forecasts and C3S needs a CDS account; a clean JSON ENSO-probability endpoint is asserted, not shown. The task's first step is research, not wiring | DDM-P4-T05 |
| Nino 1+2, 3 and 4 regions | Already in the CPC weekly file S09 parses | CARRY AS DATA, no claim. No Modoki classifier: "Nino 4 versus Nino 1+2" is not the defined index, and no issuer states a distinct Pacific Northwest consequence for central-Pacific versus eastern-Pacific events, so `tendency()` has nothing citable to say | Backlog, data-only (section 5b) |
| GHRSST MUR SST anomaly WMS layer | A map layer with a citable baseline | ROUTE. Not enso.ts | DR-033 |
| Tropical cyclone teleconnections | Atlantic and East Pacific basins | NO. Out of the tool's geography entirely | Declined |
| Live USDM fed into `tendency()` | Cross-source synthesis | NO. The briefing already carries USDM, CPC outlooks and ENSO side by side; that is the matrix. "Actively exacerbating" is a DDM verdict, not an issuer's (rule 4) | Declined |
| Subsurface leading claims under nearTerm | A forward-looking indicator inside a horizon | NO. Reintroduces the collision S10 removed, from the other side (rule 3) | Declined |

Summary: one candidate, one data-only enrichment, two items already owned by
roadmap tasks, six declined.

## 4. The wiring rule for anything that survives

This is the pattern S09 established for the weekly Nino 3.4 series, written
down so it does not have to be rediscovered. Nothing enters `src/impact/enso.ts`
until all five hold, and the candidate file
(`planning/references/templates/enso-index-candidate.schema.json`) has a field
for each.

1. Machine file. A documented, machine-readable file from the issuer, fetched
   by `scripts/build-enso-snapshot.mjs` at build time, never by the browser.
   Stated base period, stated units, a publication date if the file carries
   one. Recorded in the register with `last_checked`, HTTP status and
   Last-Modified.
2. Issuer meaning. An issuer sentence that says what the index means, so the
   claim can quote (under 15 words) rather than interpret. No sentence, no
   claim; the data may still ride in the snapshot.
3. Observation only. The claim states what the index shows now, in the current
   horizon unless the issuer itself frames the product as an outlook. No
   forward-looking verb about weeks or seasons ahead. The forbidden-language
   list in `tests/enso-forecast-language.ts` applies.
4. Decision record before code. A DR entry with the question, the options and
   the ruling, and the science verifier's receipt on the proposed sentence.
5. User need. A line in `planning/user-research/` naming who asked and for
   what. Every added claim lengthens the ENSO cell for a reader who came for
   drought.

Mechanically, each survivor is: one optional snapshot block with a guard that
drops it independently when malformed; one register entry; one claim with
`source`, `sourceUrl`, `evidence`, `dates`, `lineage`, `uncertainty`, `horizon`;
one acceptance spec with a with-block, without-block and stale fixture, landed
in `verify:smoke`. The templates in `planning/references/templates/` carry the
skeletons.

## 5. Backlog items proposed

(a) DR draft: upper-ocean heat content as an observed index (section 6).
    Not scheduled. Opens only if a user need appears.
(b) Data-only: carry Nino 1+2, Nino 3 and Nino 4 from the weekly file already
    parsed by `scripts/build-enso-snapshot.mjs` into the snapshot beside
    `nino34Weekly`. No claim, no UI. Cheap, and it makes a future ruling on
    regional structure a code change rather than a data-sourcing task.
(c) Route: satellite SSHA and the MUR SST anomaly layer to DR-033 as
    candidates for the marine product it already governs.
(d) Route: probability plumes to DDM-P4-T05, with the note that the first
    step is establishing whether any documented machine feed exists, and
    that the `EnsoProbabilities` shape in enso.ts is retained for it.
(e) Declined, with the reason recorded in section 3: MEI (unless asked),
    winds and MJO, tropical cyclones, USDM fed into `tendency()`, subsurface
    claims under nearTerm.

## 6. Decision record draft: upper-ocean heat content as an observed index

To be transcribed into `planning/decisions/2026-09-02-decision-register.yaml`
in that file's schema when and if it is opened. Draft only; no DR number
minted here.

Question: Should the ENSO briefing carry the equatorial Pacific upper-ocean
heat content anomaly (0-300 m) as an observed index beside RONI, ONI, monthly
and weekly Nino 3.4, and SOI?

Options:
  a. Carry it as an observed index under the current horizon, in CPC's own
     words about what the index is, with no statement about what it implies
     for the weeks or seasons ahead.
  b. Carry the data in the snapshot and show nothing until an issuer sentence
     about its meaning is found and verified.
  c. Do not carry it.

Preconditions for (a), all with receipts in the register:
  - a CPC or PSL machine-readable file, base period and units stated,
    fetched by the builder;
  - an issuer sentence describing the index that the science verifier binds
    to a page;
  - a rendered sentence containing no forbidden forecast language;
  - a named user need.

Risk line: the index is well known as a leading indicator. That is precisely
why the sentence must not say so. If the only honest sentence available is
"CPC uses this to anticipate", the claim is an outlook and does not belong in
the current horizon; that outcome selects (b).

Default ruling if opened: (b) until a user need is named, then (a) if the
preconditions hold.

## 7. Templates delivered with this proposal

Under `planning/references/templates/` (tracked via the existing
`/planning/references/` negation; run `npm run check:public-tree` after adding):

- `README.md`: how the templates fit together and the order to use them.
- `enso-index-candidate.schema.json`: the five gates as a JSON Schema.
- `enso-index-candidate.example-ohc.json`: the OHC candidate with every
  unverified field left null.
- `register-entry.template.yaml`: the register entry shape.
- `enso-snapshot-series.template.mjs`: builder fetch and contract validator
  skeleton for one optional series.
- `enso-index-series.template.ts`: the enso.ts pieces (types, guards, load
  branch, claim builder) for one optional series.
- `enso-index-spec.template.ts`: the acceptance spec skeleton with the three
  fixtures.

Schemas of the existing files the templates mirror were not all visible when
these were written (the contract file, the decision register, the fixture
helpers in `tests/enso-horizons.spec.ts`). Each template names the file and
line it mirrors and must be aligned to that file before use.

## Appendix: the proposal as received (ASCII-normalized)

While enso.ts handles CPC index rules, RONI vs. ONI divergence, and snapshot
staleness cleanly, its ocean-atmosphere view is currently limited to surface
sea surface temperatures (SST) and the Southern Oscillation Index (SOI).
Expanding integration to include subsurface dynamics, satellite altimetry,
multi-region SSTs, and multi-model ensemble APIs would transform this module
from a point-index parser into a multi-dimensional diagnostic pipeline.

Data enrichment opportunities (agency / source; dataset / indicator;
physical and predictive value):

- NOAA PSL / CPC; Upper Ocean Heat Content (OHC) Anomaly (0-300m); subsurface
  precursor; signals downwelling Kelvin waves and heat buildup months before
  SST anomalies register.
- NOAA PSL; Multivariate ENSO Index (MEI.v2); integrates SST, sea level
  pressure, surface winds, and OLR for coupled atmosphere-ocean state
  tracking.
- NASA GIBS / ESA Copernicus; Satellite Sea Surface Height Anomalies (SSHA);
  measures thermal expansion via altimetry (Sentinel-6/SWOT); maps spatial
  propagation of Kelvin/Rossby waves.
- NOAA CPC / TAO Array; 850-hPa Zonal Wind Stress and MJO Activity; tracks
  Westerly Wind Bursts (WWBs) that actively trigger or suppress El Nino
  intensification.
- NMME / Copernicus C3S; Multi-Model Ensemble JSON API Feeds; structured,
  machine-readable replacement for the deprecated CPC HTML plume scraper.

Key code and architectural enhancements:

- Disambiguate Modoki vs. Eastern Pacific events: extend Nino34Series into a
  broader NinoRegions interface incorporating Nino 1+2 (coastal South
  America), Nino 3 (eastern Pacific), and Nino 4 (central Pacific).
  Comparing Nino 4 against Nino 1+2 anomalies allows tendency() to
  distinguish between central Pacific (Modoki) and eastern Pacific
  (canonical) El Nino states, which carry distinct regional precipitation
  patterns.
- Incorporate NASA GIBS / NOAA WMS map layers: add lightweight WMS layer
  descriptors (e.g., NASA GIBS GHRSST_L4_MUR_Sea_Surface_Temperature
  Anomaly) to EnsoSnapshot so UI components can render high-resolution
  spatial maps alongside scalar claims.
- Subsurface leading claims: include Ocean Heat Content (0-300m) in the
  nearTerm horizon claims. Explaining whether a weekly SST move is backed by
  subsurface heat storage helps clarify whether a trend is durable or
  atmospheric noise.
- Restoring probabilistic plumes: replace the removed HTML scraper with
  machine-readable REST/JSON endpoints from the North American Multi-Model
  Ensemble (NMME) or Copernicus C3S to repopulate probabilities and
  ensoPlumeSvg.

Additionally, connecting ENSO index reads directly to hurricane dynamics,
inland drought monitoring, and deep ocean heat transforms the module from a
surface-level index reporter into a comprehensive climate impact engine.

1. Tropical cyclone and wind shear teleconnections. Physical mechanism: El
   Nino increases vertical wind shear across the tropical Atlantic
   (suppressing cyclone formation) while reducing shear in the eastern and
   central Pacific (boosting hurricane intensity). La Nina flips this
   balance. Data sources: NOAA CPC Atlantic/Pacific seasonal hurricane
   outlooks, National Hurricane Center (NHC) tropical weather outlook GIS
   feeds, and NOAA CIRA satellite vertical wind shear products. Code
   integration: implement a tropicalCyclone claim builder inside
   fetchEnsoClaims. When RONI crosses threshold levels, the application can
   emit a localized wind shear claim explaining basin-wide tropical activity
   tendencies.
2. Inland drought and hydrological coupling. Physical mechanism: while
   enso.ts currently cites the CPC Seasonal Drought Outlook and U.S. Drought
   Monitor conceptually, direct API integration allows real-time
   ground-truthing of ENSO tendencies against active soil moisture deficits
   and snowpack depletion. Data sources: NIDIS (Drought.gov) REST API, U.S.
   Drought Monitor (USDM) GeoJSON services, and USDA NRCS SNOTEL automated
   snowpack network. Code integration: feed live USDM drought status into
   the tendency() function. If an El Nino phase is active, the claim
   validates whether predicted regional warmth and lower snowpack are
   actively exacerbating pre-existing drought conditions in target
   watersheds.
3. Deep water heating and subsurface inertia. Physical mechanism: surface
   SST anomalies are lagging indicators. Upper Ocean Heat Content (OHC,
   0-300 meters) tracks sub-surface thermocline anomalies and downwelling
   equatorial Kelvin waves, predicting surface warming or cooling months
   before SSTs react. Data sources: NOAA PMEL TAO/TRITON buoy subsurface
   array, Argo float gridded ocean profiles, and NOAA Ocean Climate
   Laboratory subsurface temperature anomaly series. Code integration: add
   an OceanHeatContentSeries interface to EnsoSnapshot. Produce
   early-warning lead claims under horizon: 'nearTerm' or horizon:
   'longRange' to flag when subsurface heat buildup guarantees a phase
   shift, even while surface RONI remains neutral.

Teleconnection domain; API / data source; architectural addition to enso.ts:
- Tropical cyclones; NOAA CPC hurricane outlook / NHC GIS; adds
  basin-specific vertical wind shear claims.
- Inland drought; NIDIS / USDM REST API / SNOTEL; cross-references
  tendency() text with active regional drought tiers.
- Deep ocean heat; NOAA PMEL TAO buoy array / Argo; adds subsurface heat
  content (0-300m) lead indicators.
