# Release notes

## v0.6.25

`v0.6.25` is a 0.6.x stabilization checkpoint. It preserves the current
successor interface, source capabilities, URL state, mobile behavior, and embed
contract without adding a new engine or data source. Later 0.6.x releases will
continue the evidence-driven interface tweaks and adjustments.

The checkpoint audit found no runtime interface correction that was supported by
reproducible evidence. It fixed one date-sensitive point-heat browser test so
the fixture continues to exercise its intended current-or-future interval, and
it aligned the package metadata, lockfile metadata, and application footer at
`0.6.25`, `0.6.25`, and `v0.6.25`, respectively.

This checkpoint does not include National Interagency Fire Center work and
does not authorize `v0.7.0`. That work remains deferred until the `0.6.x`
interface line is explicitly closed.

Local release-candidate verification passed `npm run gate`,
`npm run test:serial` with 649 tests, a focused two-test rerun, and the
standard and 200-pixel embed viewport specification with five tests, and the
root/subpath static-host specification with one test. These receipts do not
claim publication, tagging, or a new visual browser inspection.
