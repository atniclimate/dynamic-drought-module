# 2026-08-02: A community member used the map

## Who and where

- Role and organization type (no names unless agreed): Community member, non-specialist; Scottish resident of Powell River, British Columbia
- Setting (desk, field, meeting, phone, tablet, projector): Informal demonstration on iPad
- Device and browser, if known: iPad, browser unknown
- Which build (date or stamp from the map-information panel), if known: Approximately early August 2026 build; exact stamp not recorded
- What they were trying to learn or decide: General curiosity; no specific decision or task. First exposure to the tool.

## What they did

1. Viewed the default drought display on the iPad. Oriented to the geospatial interface quickly and without guidance.
2. Recognized the drought classification shading and understood it was showing drought severity, though was not certain what the categories meant in practice.
3. Clicked the Wildfire button to switch to the fire view.
4. Zoomed into active fire perimeters. This was where sustained interest was highest.
5. Tried several of the toggle controls in the fire view. Some did not respond as expected, or the interface did not return to its initial state after toggling.
6. Continued exploring despite the toggle issues.

## What they said

- Expressed immediate and strong positive impression of the geospatial display ("immediately impressed").
- No verbatim quotes recorded.
- Did not ask questions about data sources or methodology. Interest was visual and spatial: where are the fires, how close, how big.

## What we infer

- A non-specialist user with no prior exposure to drought or fire mapping tools oriented to the geospatial interface within seconds. The map metaphor and visual encoding are working. Confidence: high.
- The drought classification is visually legible but the practical meaning of the categories is not self-evident to a general audience. The USDM explainers (shipped in 0.3.0) address this, but only in popups; the map key alone was not sufficient for this user. Confidence: medium.
- The fire view is the strongest attention magnet for a general audience. The shift from drought (abstract, slow-moving) to fire (concrete, immediate, personal) is sharp. Confidence: high.
- Toggle state management in the fire view has a visible regression: controls either do not respond or do not reset to their initial state. This was noticeable enough to register with a non-technical user during casual exploration. Confidence: high.
- iPad touch interaction did not surface any blocking usability issues beyond the toggle bug. The user zoomed, panned, and tapped without difficulty. Confidence: medium (single observation, informal setting).

## Where it lands

- Toggle state regression: supports DR-022 (Fire forecast tier) and the broader fire-view stability work. Argues for toggle-state audit as a prerequisite before new fire-view features ship.
- Drought category legibility for general audiences: supports the USDM explainer work already shipped. May argue for surfacing a brief plain-language label on the map key itself (not just in popups). Not currently covered by the plan; low priority but worth noting.
- Fire view as attention magnet: supports the priority ranking of fire features (DR-022, DR-025, DR-026, DR-027) and the 3D fire module (DDM-P0-T03).
- iPad usability: supports DR-036 (tablet band) and the touch-first design direction ratified 2026-09-02.

## Follow-up

- None owed. Informal demonstration, no commitment made.
