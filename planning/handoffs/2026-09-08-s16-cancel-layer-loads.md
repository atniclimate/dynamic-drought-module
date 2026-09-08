# S16 handoff: cancel layer loads (2026-09-08)

Session S16 on branch `feature/cancel-layer-loads-p1t02` from `0c09081` (main, the S14
merge, pushed 2026-09-08; deploy and verify-live green per the owner, run ids not
supplied). Unpushed. Nothing merged, tagged, published, or scheduled. The concurrent
session S15 wrote in `I:\dynamic-drought-module-wt\acceptance-proposals` on
`planning/stub-acceptances-2026-09-08`; S16 touched none of its three paths.

## Next action

Owner: rule DR-073 (or let its default stand), then land
`feature/cancel-layer-loads-p1t02` on `main` by a `--no-ff` merge commit (eight commits:
one per step, the close, and the docs commit after it). The branch changes product behavior in one place a user can notice: a layer
turned off while its first request is still in flight now aborts that request at once, for
every one of the four seam layers, instead of Hydrography waiting out its 12 s Overpass
mirror budget first.

## Commits, in order

| Step | Commit | Subject |
|---|---|---|
| 1 | 18d0d33 | plan: record the S14 owner rulings |
| 3 | d673b80 | layers: the controller owns one abort signal per activation (DDM-P1-T02) |
| 4 | 7b1f540 | layers: the four seam layers take the activation signal; viewport discovery aborts on supersession (DDM-P1-T02) |
| 5 | 776d445 | tests: layer cancellation acceptance joins verify:smoke (DDM-P1-T02) |
| 6 | 9b6d0fb | tests: the viewport supersession case observes both boundary refreshes (DDM-P1-T02) |
| 7 | 296316c | plan: close S16 (cancel layer loads) |
| after | 5da4577 | docs: project guide, and pointers from README, ROADMAP.md and CLAUDE.md (owner request after the close: `docs/PROJECT_GUIDE.md` maps the planning files and how a session runs; the local `docs/README-RESUME.md` was updated with S16's outcome) |

## The seam, in one paragraph

`src/state/layer-controller.ts` keeps one `AbortController` per key in `attempts`. It is
created inside the activation op after the chunk import (`beginAttempt`), handed to the
module as `LayerActivation { signal, generation }` through an optional second parameter on
`LayerModule.activate` (`src/config/layers.ts`), aborted first thing in `deactivateInternal`
(ahead of the existing `cancelActivation` seam and the serialized teardown), superseded by
the next `beginAttempt` for the same key, and closed by `endAttempt` on the stand-down and
error-status paths and by `abortAttempt` on a thrown activation. `endAttempt` compares the
signal identity, so it never closes a newer attempt. The four modules (`aiannh.ts`,
`bia-reservations.ts`, `hms-smoke.ts`, `hydrography.ts`) store the signal and link each
controller they create to it through `linkAbort` (`src/util/fetch.ts`), unlinking on every
exit path; each drops a response whose request token is no longer current and says so once
at debug level. No export was renamed, no existing signature changed; `registry.ts`,
`popups.ts` and `layer-toggle-command.ts` needed no edit.

## Per-clause receipts

Rule (owner R6): DDM-P1-T02 flips only when every clause has a receipt from
`tests/layer-cancellation.spec.ts`. Logs are under `%TEMP%\ddm-s16\`.

| Clause | Code | Spec | Receipt |
|---|---|---|---|
| Held JSON requests abort promptly | `layer-controller.ts` `abortAttempt` in `deactivateInternal`; `aiannh.ts:446`, `bia-reservations.ts:432`, `hms-smoke.ts` and `hydrography.ts` `linkAbort` at fetch start | tests 1 to 3 (boundary pair, Hydrography, Smoke Plumes): `requestfailed` within 10 s of the uncheck | spec-run1.log 7 passed; spec-repeat3.log 21 passed |
| Held PMTiles requests abort promptly | MapLibre 6.6.0 `removeSource` -> `TileManager.onRemove` -> `clearTiles` -> `abortTile`; pmtiles 4.4.1 `tilev4` passes the signal into the tile-data range read | test 4: tile-data reads held by `tileDataOffset`, aborted on uncheck | same logs; DR-073 records the header-read gap |
| Viewport discovery aborts on supersession | `aiannh.ts` and `bia-reservations.ts` abort the in-flight request at the top of `fetchAndApply`; `hydrography.ts` at the top of `runFetchForCurrentViewport` | test 5: both boundary refreshes held after a region change, both aborted by the next region change, both layers stay on | spec-viewport-both.log 2 passed |
| A late response cannot render after intent changes | request tokens compared before render in all four modules; controller stand-down after `mod.activate` | tests 6 and 7: off/on while held (first aborted, second settles live); a response released as intent flips to off renders nothing | same logs |

Negative control (spec-negative-control-2.log): with the base commit's controller and
hydrography restored, the Hydrography test fails with the abort at 11892 ms, the per-mirror
timeout; the other six pass because those modules already carried `cancelActivation` and
MapLibre owns the tile abort. The first version of that test (spec-negative-control.log)
passed on the old code because it held a refresh rather than the activation; it now boots at
`?region=central_oregon` so the held query is the activation's own.

## Rendered behavior on one cancelled activation

Turn Tribal Lands on from the console catalog while its Census query is in flight, then off.
The checkbox clears and the pill goes from `loading...` to empty at once; the query shows as
aborted in the browser's network panel within the same second; the URL drops `aiannh`; a
response arriving afterwards changes nothing, and one `console.debug` line names the dropped
request. No new status is written and nothing is announced beyond the existing "Tribal
Lands: off".

## Gates, with log paths

| Gate | Result | Log |
|---|---|---|
| verify:quick baseline and after every step | exit 0 each time | quick-baseline.log, quick-step3.log, quick-step4.log, quick-close.log |
| npm run lint (for the DDM-P15-T04 flip) | exit 0, 179 files, no diagnostics | lint.log |
| check:bundle, check:activation (R4) | entry 30.9 kB under 45; every activation row under its line | budgets.log |
| spec alone, x3, viewport x2 | 7, 21, 2 passed | spec-run1.log, spec-repeat3.log, spec-viewport-both.log |
| verify:smoke once | exit 0, 142 passed, 1 skipped (the tests/ux1-surfaces.spec.ts:98 quarantine), 6.1 m; the seven cancellation tests among the 142 | smoke.log |
| check:public-tree (rule 9, paths added) | clean, 565 tracked files | public-tree.log |

## DR-073 (session-proposed, pending)

Which PMTiles requests the cancellation clause covers. pmtiles 4.4.1 passes MapLibre's
per-tile abort signal only into the tile-data range read; the archive header and directory
reads (the first 16 kB, cached for the session) are issued without a signal and cannot be
aborted by any installed API. Default: option a, tile-data reads are the requests the clause
names, and the spec proves that path. If the owner rules b, the task reopens on the PMTiles
clause with a protocol wrapper as the residual.

## Owner calls

1. DR-073 above (register, `G-session-2026-09-08-s16`): ratify a or rule b.
2. `.planning/SESSION_ROSTER.yaml:39` `handoff_entry` read `planning/handoffs/2026-09-04.md`
   while `docs/ROADMAP.yaml:61` had said "the folder, newest by filename date" since S14; S16
   set the roster line to the folder form. Refute if the file form was deliberate.
3. The verifier's clause-5 reading: in this controller two activations of one key can never
   overlap (ops are serialized per key), so "a superseding activate aborts the earlier
   attempt" is only ever exercised through the off/on cycle test 6 drives; `beginAttempt`'s
   own supersession abort is defensive. Recorded here, no code change.

## Ledger edits in the closing commit

- `docs/ROADMAP.yaml`: DDM-P1-T02 status done with a closed sentence (DDM-P15-T04 was flipped
  in 18d0d33).
- `.planning/TRACE.yaml`: DDM-P1-T02 done, the spec attached by repair:S16, counts 56 open
  and 29 done.
- `.planning/SESSION_ROSTER.yaml`: S16 entry (done), the cycle block renumbered S17-S21 with
  DDM-P1-T02 removed, `handoff_entry`.
- `planning/decisions/2026-09-02-decision-register.yaml`: DR-073 added; header 73 entries,
  52 decided, 21 pending.
- `.gitignore`: this handoff negated by name (the public-tree allow-list already covers the
  folder).

U+2014 hand scan of every ledger and code file touched: zero in each.
