# 2026-08: ATNI Energy Program Manager used the map

## Who and where

- Role and organization type (no names unless agreed): Reuben Martinez, ATNI Energy Program Manager. Named with ongoing professional collaboration.
- Setting (desk, field, meeting, phone, tablet, projector): Multiple sessions, both desk (desktop) and phone (mobile). At least one session took place during a notably smoky day in Bellingham, Washington, which gave the fire and smoke discussion immediate experiential context.
- Device and browser, if known: Desktop and mobile phone. Specific browsers not recorded.
- Which build (date or stamp from the map-information panel), if known: Various development builds across summer 2026.
- What they were trying to learn or decide: Evaluating the fire module for situational awareness of fires near Tribal lands. Exploring the briefing panel for operational understanding. Assessing whether the tool could support outreach to Tribal communities affected by active fires.

## What they did

1. Explored the fire module extensively across multiple sessions. Zoomed into active fire perimeters near Tribal lands and discussed which communities might be reachable for outreach.
2. Has not yet seen the 3D capabilities in a working state, but has discussed the volumetric smoke concept at length and considers it especially important. This discussion happened during a day when Bellingham was experiencing heavy smoke.
3. Opened the impact briefing panel (slides out from the right side of the screen). Read through the content.
4. Attempted to use the briefing to understand drought and fire forecasts. Found the fire and drought forecasts were not working correctly (data not loading or display errors).
5. Tried the console controls. Several buttons did not respond. Navigation between views was challenging.
6. Attempted to use the place studio and layer studio. Both had inconsistent navigation and did not work correctly.
7. Tried the tool on mobile. Encountered interface crowding: the transparent persistent information box overlapped other content, and navigation buttons were difficult to reach.

## What they said

- On the briefing panel's numbers: noted that long decimal places made the briefing hard to read (this has since been addressed in the codebase).
- On briefing layout: said the briefing panel that slides out from the right would probably be better as a full-screen drawer that comes out from the sidebar, with a button to slide it back. The current slide-out panel does not give enough room for comfortable reading.
- Patrick mentioned that print, email, and share functions would be added to the briefing. Reuben responded positively but did not comment in detail.
- On fire and drought forecasts: could not determine how to use the information he was looking at because the forecasts were not loading or displaying correctly.
- On the console: several buttons did not work, and navigation was challenging. Did not specify which buttons.
- On mobile: observed that the transparent persistent box would work better as a sliding drawer with navigation buttons on the side. Also said it would be cool to have a 3D button he could hold to move the 3D map, because multi-finger gestures (pinch, rotate) did not quite work right.
- On the desktop experience: "This seems really cool for someone who knows what they are doing" (verbatim).
- When asked for ideas on how to improve it, he did not have specific suggestions but recognized how innovative the tool was. He looks forward to seeing an advanced version.
- On volumetric smoke (during the smoky Bellingham day): agreed strongly that this would be extremely important as a feature.

## What we infer

- The briefing panel layout is not working for a non-technical internal user. "Slides out from the right" in a narrow panel is a reading experience that competes with the map rather than complementing it. The full-screen drawer suggestion aligns with the mobile bottom sheet work (0.5.0) and argues for a similar pattern on desktop: when someone opens the briefing, they should be reading it, not squinting at a sliver. Confidence: high (direct feedback from someone trying to use the content).
- The "seems really cool for someone who knows what they are doing" comment is a polite way of saying the interface is not yet accessible to a non-specialist. The gap is not in the data or the analysis; it is in the interaction design. This is the desktop equivalent of the mobile crowding problem. Confidence: high.
- Fire and drought forecast reliability is a repeated failure point. Reuben could not use the forecast information because it was not working. Combined with the toggle issues in observation #1 and the layer studio issues in observations #1 and #2, this is the third observation confirming that core features are unreliable during demonstrations. Confidence: high.
- The layer studio and place studio are now a confirmed pattern of failure across three independent observations (community member, NIDIS partners, internal staff). This is not an edge case. Confidence: high.
- Mobile interface crowding is a real problem for internal staff. The transparent persistent box, the navigation button placement, and the multi-finger gesture handling are all friction points. Confidence: high.
- The volumetric smoke feature has strong internal advocacy. Reuben's reaction during an active smoke event is the most grounded validation this feature has received: not a speculative "that would be cool" but a "we are sitting in smoke right now and this would be extremely important." Confidence: high.
- The briefing content (numbers, forecasts, hazard descriptions) is not self-interpreting for a staff member who works adjacent to but not inside the climate domain. Even after reading through, Reuben was not sure how to use the information. This argues for simpler summary language at the top of each briefing section before the detailed data. Confidence: high.

## Where it lands

- Briefing panel as full-screen drawer: directly supports the 0.5.0 mobile bottom sheet work and argues for extending the full-screen reading pattern to tablet and potentially desktop. Argues against the current right-slide panel as the long-term briefing container. Bears on DR-012 (briefing structure, now ratified as horizon-leading), since the horizon-leading layout should be designed for the full-screen drawer context, not the narrow slide-out.
- "Cool for someone who knows what they are doing": argues for a guided or simplified entry point alongside the current expert interface. Not currently in the plan. Could be addressed by the question-first presets (already shipped) if they are surfaced more prominently, or by a "start here" onboarding moment. Worth noting in IDEAS.md.
- Forecast reliability: supports DR-022 (Fire forecast tier, ratified) and DR-019 (CPC outlooks, ratified). The new forecast products should be the fix: replacing broken or frozen forecasts with working, dated issuer products.
- Layer studio and place studio instability: third confirmation. If these features ship at Convention, they must work. If they cannot be made stable, they should be hidden. Not currently addressed by a specific decision register entry.
- Mobile crowding: supports DR-036 (tablet band, ratified) and the 0.5.0 mobile bottom sheet. The sliding-drawer concept with side navigation buttons is a specific design input for the mobile rebuild.
- 3D button for touch: supports DDM-P0-T03 and the tablet interaction model (DR-036 owner guidance on touch-first design). The "hold to move 3D" concept is a specific interaction pattern for the touch tier.
- Volumetric smoke advocacy: supports DDM-P0-T03. This observation is the strongest user-grounded evidence for the smoke feature.
- Briefing readability for non-specialists: argues for a summary or plain-language lead at the top of each horizon section. Bears on DR-012 (briefing structure) and the impact briefing copy work (IB-02 through IB-05). The data should still be there, but a one-sentence "what this means" lead would help non-technical readers orient.

## Follow-up

- Show Reuben the 3D capabilities when a stable build is available. He has discussed them but has not seen them working.
- When the briefing is rebuilt in the full-screen drawer layout (0.5.0), Reuben is a natural early tester: he represents the "adjacent staff" persona who needs the information but is not a climate specialist.
- Show Reuben the improved version with working forecasts (after DR-022 and DR-019 land) and ask specifically whether the information is now usable.
