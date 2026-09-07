# 2026-08-28: NOAA-NIDIS Tribal Engagement Coordinator and Digital Coordinator used the map

## Who and where

- Role and organization type (no names unless agreed): Crystal Stiles, NOAA-NIDIS Tribal Engagement Coordinator, and Kelsey Eigsti, NOAA-NIDIS Digital Coordinator. Both have agreed to be named through ongoing professional collaboration.
- Setting (desk, field, meeting, phone, tablet, projector): Video call (Google Meet). Patrick demonstrated the live site and the GitHub repository via screen share.
- Device and browser, if known: Desktop, viewed via screen share. Unknown whether either opened the tool independently during the call.
- Which build (date or stamp from the map-information panel), if known: The calendar event carried a DDM link to the Washington State region with hillshade, NADM drought, AIANNH, BIA reservations, and states layers.
- What they were trying to learn or decide: Kelsey Eigsti asked specifically how the drought impact briefing language is generated. Crystal Stiles has been tracking the DDM's evolution over time and was sharing the project with her NIDIS colleague.

## What they did

1. Kelsey asked directly about how the impact briefing language was assembled: what produces the sentences, what data feeds them, how the logic works.
2. Patrick shared the GitHub repository and walked through the `src/impact` directory, showing the codebase structure, the data-to-briefing pipeline, and the developer documentation.
3. Kelsey followed the walkthrough and confirmed it made sense to her. The well-documented codebase was itself a legibility tool: the code explained the product.
4. Patrick demonstrated the mobile-optimized interface.
5. Patrick attempted to demonstrate the layer studio and place studio functions. These were not working correctly during the demo.
6. Patrick discussed the DDM's design philosophy: starting from Tribal audiences who predominantly access tools on phones and tablets, while ensuring technical depth for professional use. Referenced drought.gov and d3drought.org as comparison points that are tuned to professional or technical users.
7. Discussion turned to the 3D capabilities, which Crystal and Kelsey found especially striking.
8. Discussion of a potential partnership where NOAA-NIDIS could use parts of the DDM source code, with mutual acknowledgment: ATNI and Patrick credited for the tool development, NOAA credited for the data curation, research, and infrastructure that the tool depends on.
9. Crystal indicated she would share the DDM with the NOAA-NIDIS developer team and explore a path toward NOAA actually using parts of the source code.
10. Crystal mentioned the possibility of meetings with USGS, other NOAA offices, and NASA partners, prompted by the DDM's integration of many data sources.

## What they said

- Kelsey Eigsti, on the mobile-optimized interface: "Oh, we've never done that!" (verbatim, spoken with a tone of inspiration and surprise).
- No other verbatim quotes recorded.
- Kelsey's question about how briefing language is generated was specific and methodological, not casual. She wanted to understand the production chain.
- Crystal expressed excitement about sharing with NIDIS developers and the prospect of NOAA using the source code.
- Patrick stressed that any partnership must acknowledge the data curation, research, and infrastructure work that NOAA does, and that NOAA's greater compute, server, and storage capacity could help advance the direction both organizations are taking.

## What we infer

- The codebase documentation is not just a developer convenience; it is a legibility tool for partners. When Kelsey asked "how is this generated," the answer was the annotated source code itself. Well-structured, well-documented code earns trust with technical partners. Confidence: high.
- Mobile-first design is a genuine differentiator in the federal drought information space. The "we've never done that" reaction from a NIDIS digital coordinator confirms that the phone-and-tablet-first approach is novel in this ecosystem, not just claimed to be. Confidence: high.
- The layer studio and place studio are recurring demo failure points. This is the second observation (after the Powell River iPad demo) where these features did not work during a demonstration. This is a pattern, not an isolated bug. Confidence: high.
- The 3D capabilities carry disproportionate demonstration impact relative to their current functional maturity. People react strongly to them even when they are described rather than fully working. Confidence: high.
- A NOAA-NIDIS partnership built on shared source code is a real possibility, not aspirational. Crystal's offer to share with the developer team and to convene meetings with USGS, other NOAA offices, and NASA is a concrete next step, not a polite expression of interest. Confidence: medium (depends on institutional follow-through).
- The mutual acknowledgment framing (ATNI credited for the tool, NOAA credited for the data and infrastructure) is the correct partnership posture. It frames the relationship as complementary rather than extractive in either direction. Confidence: high.

## Where it lands

- Codebase documentation as partner-facing legibility: supports the investment in developer documentation and code comments. Argues that documentation standards should be maintained not just for successor onboarding but for partner credibility. This strengthens the case for the documentation work in the September roadmap (DR-053, DR-054).
- Mobile-first as differentiator: supports DR-036 (tablet band), DR-059 (preview badge on phones), and the broader mobile/tablet priority in the 0.5.0 bottom sheet work.
- Layer studio and place studio instability: these features are repeated demo failure points. If they are not stable enough to demonstrate, they should either be fixed or hidden behind a development flag before the Convention. Raises a question the plan does not currently address.
- 3D demonstration impact: supports DDM-P0-T03 (MapLibre 5/3D terrain and fire module) and the priority of volumetric smoke. Argues against deferring 3D work past the Convention if any stable subset can be shown.
- NOAA partnership pathway: not currently in the decision register. This is a strategic opportunity that the plan does not cover. It may warrant its own register entry or a note in the post-departure handoff document.

## Follow-up

- Crystal will share the DDM with the NOAA-NIDIS developer team. Patrick should follow up within two weeks to ask whether the developers have looked at it and what questions arose.
- Potential meetings with USGS, other NOAA offices, and NASA: Crystal is the convener. Patrick should confirm timing relative to his departure and ensure the successor maintainer is introduced before any technical meetings occur.
- The mutual acknowledgment and licensing terms (PolyForm Strict 1.0.0 for the repo, CC BY-NC-SA 4.0 for public-facing content) should be stated clearly before any code-sharing proceeds. This is not a blocker for the relationship, but it needs to be explicit.
