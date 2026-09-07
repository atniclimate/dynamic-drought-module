# 2026-08-28: Climate working group members and Tribal liaisons used the map

## Who and where

- Role and organization type (no names unless agreed): Mixed group across multiple sessions: Bureau of Indian Affairs Tribal Climate Resilience liaisons, Northwest Climate Adaptation Science Center (NW-CASC) staff, ATNI staff members, and members of the Pacific Northwest Climate Change Working Group (CPF Leadership Council). One attendee, a Tribal community leader who has experienced recent wildfire impacts in the Colville and Spokane area, is described by role only.
- Setting (desk, field, meeting, phone, tablet, projector): Primarily video call demonstrations and in-person walk-throughs at working group meetings. Multiple sessions over the summer of 2026.
- Device and browser, if known: Mixed. Some viewed via screen share, some opened the tool independently on their own devices.
- Which build (date or stamp from the map-information panel), if known: Various development builds across summer 2026.
- What they were trying to learn or decide: General orientation to the tool's capabilities. Several attendees were evaluating it as a potential resource for their own Tribal or agency work. The wildfire-impacted attendee was looking at it through the lens of immediate community need.

## What they did

1. Patrick walked through working versions of the DDM with each group, always prefacing with a disclaimer that the tool is in active development.
2. Multiple attendees asked to see the 3D fire module specifically. This was consistently the most-requested demonstration across groups.
3. Patrick pointed out bugs as they appeared during demonstrations rather than hiding them.
4. Some attendees explored the tool independently on their own devices after the demonstration.
5. The wildfire-impacted attendee navigated to the fire view and the resources section.

## What they said

- Multiple attendees across groups expressed being impressed by the tool, even with visible bugs and development-state disclaimers.
- The wildfire-impacted attendee, speaking about communities near the Colville and Spokane fires where people lost homes or were injured: "People need help now." She was grateful that the tool included resources, but said there is a need for trauma, emotional, and mental health resources as well, not just drought and fire information.
- No other verbatim quotes recorded. General reactions ranged from curiosity to enthusiasm, with the 3D fire module consistently generating the strongest response.

## What we infer

- The 3D fire module is the single strongest demonstration feature across all audience types: general community, Tribal leadership, federal liaisons, and academic partners. Every group asks for it. Confidence: high.
- Demonstrating with honesty about the development state (disclaimers, pointing out bugs) does not diminish the audience's impression. It may strengthen trust. Confidence: medium (could be selection bias; these are sympathetic audiences).
- The tool is being evaluated independently after demonstrations. People are opening it on their own devices and exploring. This is a signal of genuine interest, not just meeting politeness. Confidence: medium.
- The wildfire-impacted attendee surfaced a category of need the tool does not currently address: trauma, emotional, and mental health resources for communities affected by fire. This is distinct from the existing resource catalog (which focuses on drought response, agency contacts, and technical assistance). The request is for human-centered care resources alongside the hazard information. Confidence: high (direct statement from a person with lived experience).
- Patrick's concept of a heart-icon button that links to mental health, trauma, and healthcare resources, with the possibility of the icon glowing or pulsing when the user is viewing a fire area, is a design response to this need. The concept pairs hazard awareness with care awareness. Confidence in the need: high. Confidence in the specific design solution: low (untested, needs careful consideration of whether pulsing near fire content could itself be distressing).

## Where it lands

- 3D fire module priority: reinforces DDM-P0-T03 and the decision to keep it open. Every audience group independently validates its importance.
- Mental health and trauma resources: raises something the plan does not currently cover. The resource catalog (0.6.0, E4) is scoped as state-by-state drought and agency contacts. A healthcare and mental health resource layer is a new category. This could be:
  - A simple addition to E4 (a "wellness and support" section in the resource catalog, per state or per region)
  - A dedicated UI element (the heart-icon concept)
  - A contextual affordance tied to the fire view (resources surface when viewing active fire areas near communities)
  - Any of these should be evaluated for sensitivity: a pulsing icon near fire content must be tested with people who have experienced fire trauma before shipping.
- Honest demonstration posture: supports the current approach. No change needed.
- Independent exploration after demos: supports the importance of the layer studio and place studio being stable (they are currently a repeated failure point per observations #1 and #2).

## Follow-up

- The wildfire-impacted attendee's feedback about mental health resources should be carried into the resource catalog planning (0.6.0). At minimum, a note should be added to the E4 scope: "wellness and crisis support resources alongside agency and technical contacts."
- The heart-icon concept should be noted in IDEAS.md as a shaped spark, not scheduled. It needs the full shaping treatment (costs, sensitivity review, coherence gate) before it enters any phase.
- No specific commitments were made to any individual in these sessions.
