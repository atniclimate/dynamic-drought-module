# Launch rulings, 2026-09-03

Owner: Patrick Freeland. Issued 2026-09-03, before the long run of that afternoon.

**Provenance, stated plainly.** This file was TRANSCRIBED from the owner's long-run
launch prompt of 2026-09-03 by the orchestrator at 15:55 PDT, not authored separately
by the owner at a keyboard. The prompt named this path as the `ruling_source` for the
entries below and described the file as already placed; it was not on disk when the run
started. The owner was asked and answered "make the best determination and proceed", so
the rulings are reproduced here from the prompt's own words, unedited in substance, and
this note stands in place of any rationale the owner's own copy may have carried beyond
what the prompt states. If the owner's copy appears later, it supersedes this file.

Cited as `ruling_source` by DR-067, DR-068 and DR-069 in
`2026-09-02-decision-register.yaml`.

---

## 1. DR-067, how the hazard ramp reaches the screen. Option b, CONDITIONAL

The ramp reaches the screen by sending a rendering rule to the issuer's ImageServer
`exportImage` call and carrying the new route through the Worker allowlist, so the flat
layer and the 3D drape keep one color language.

**The condition.** A read-only probe must first prove the issuer's service accepts a
rendering rule for this layer.

**If the probe fails, do NOT fall through to option a.** Record the finding, leave
DR-067 decided-but-unexecutable with the evidence attached, and stop the ramp work.

Option a, for the record, was to recolor the regional PMTiles archive at bake time,
which would leave the flat map and the 3D drape speaking different color languages
until the 2D path followed.

## 2. DR-068, Water and Non-burnable. Option b

Water and Non-burnable get a treatment visibly outside the lightness sequence, named in
the legend as carrying no hazard level.

Not drawn as nothing. Not placed on the ramp.

## 3. DR-069, production source maps. NEW ENTRY

This is the clause of gate DDM-D10 that the gate transcription found nobody had ever
answered. DDM-D10 asks two things: the path from GitHub Pages to a local full-service
server, and whether production source maps stay public in the meantime. DR-006 answers
only the first.

**Ruling: production builds publish no source maps while GitHub Pages is the host.**

If the current build emits any, remove them and record the reason in `DEVELOPER.md`.
Revisit when the local full-service server lands.

Created in group `G-session-2026-09-03`, source
`gate_drift_2026_09_03.unanswered_clause_found`, with DDM-P15-T01 in `blocks`.

## 4. The map-free sidebar question. YES, BOUNDED

The owner queue asked whether a sidebar that builds without the map is wanted. It is.

The generated sidebar controls and the preset chips build from the static layer registry
at DOM ready and do not wait on map load. Map-dependent behavior stays disabled with an
honest reason until the map is ready, then enables.

This is the shared root of DR-065 mode 1, DR-065 mode 2, the no-WebGL-2 shell gap, and
the DDM-P14 boot watchdog, which is why it is ruled once here rather than four times.

**Blast-radius guard.** If this cannot be done inside the sidebar build path, the boot
seam, and the stylesheet, stop and report what else it would take. Do not begin a wider
refactor.

## 5. Asana. PREPARE ONLY

Do not mutate Asana. Prepare the exact `C:\dev\asana-sync\asana.ps1` command lines and
the exact strings for the owner to run. The MCP tools are read-only.

---

## Limits the same prompt placed on this run, recorded here because they bound the above

- DR-067 option b ends in a Worker publish, which is a stop condition for the run that
  received these rulings. The ramp branch `map/dr-063-whp-ramp` does not land in that
  run even though DR-068 is now ruled and DR-067 is ruled conditionally.
- Version stays 0.6.26. Work goes under Unreleased in `docs/RELEASE_NOTES.md` and never
  gets a version heading.
- No cron or scheduled workflow is added (DR-061). DR-002 a's restoration applies only
  to the existing snoozed schedules and only after 2026-09-11.
- Nineteen register entries remain pending and out of bounds: DR-013, DR-017, DR-018,
  DR-020, DR-023, DR-026, DR-027, DR-032, DR-033, DR-037, DR-038, DR-039, DR-040,
  DR-041, DR-042, DR-044, DR-060, DR-062, DR-066. Seventeen carry an
  `owner_leaning_2026_09_02`. A leaning is not a ruling.
