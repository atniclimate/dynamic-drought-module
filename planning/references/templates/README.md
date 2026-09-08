# Templates for adding one observed index to the ENSO briefing

These are skeletons of the pattern S09 used for the CPC weekly Nino 3.4
series (commits 21169d4, 3619d20, 0b2f5d0, fcda17f, 6586493). They exist so a
future index is added the same way, with the same guards, and never by a
session improvising from memory.

Order of use, one candidate at a time:

1. `enso-index-candidate.example-ohc.json` is the shape of a candidate file.
   Copy it to `planning/references/candidates/<slug>.json` and fill it in.
   `enso-index-candidate.schema.json` is the JSON Schema it must satisfy;
   validate with any draft-2020-12 validator before opening a decision
   record. A candidate with any of the five `gates` false does not proceed
   past its decision record.
2. Open the decision record in `planning/decisions/` in that file's own
   schema. The candidate file's `decision_record` field gets the DR id.
3. `register-entry.template.yaml`: add the source to
   `planning/references/register.yaml`. `wired: false` until step 5 lands.
4. `enso-snapshot-series.template.mjs`: the builder fetch and the contract
   validator. Align with `scripts/build-enso-snapshot.mjs` (upstream URLs
   near :60) and `scripts/lib/enso-snapshot-contract.mjs` (`OPTIONAL_SERIES`
   near :304, validators near :481). Regenerate the snapshot; run
   `npm run check:enso`; prove an old snapshot without the block still loads.
5. `enso-index-series.template.ts`: the enso.ts pieces. The guard mirrors
   `isNino34Series`; the load branch mirrors the `nino34` branch in
   `loadEnsoSnapshot`; the claim mirrors the weekly claim S09 added. Run the
   sentence through the `ddm-science-verifier` agent before committing.
6. `enso-index-spec.template.ts`: the acceptance spec, three fixtures, added
   to `verify:smoke` in `package.json`.
7. Ledgers as the conduct rules require: DR, TRACE attachment with a dated
   comment, roster entry, handoff. `npm run check:public-tree` before closing.

Rules the templates encode and a session must not relax:

- The browser reads only the bundled snapshot. No `URLS` entry for an
  upstream CPC file; the builder fetches at build time.
- A block is optional, guarded, and dropped independently when malformed,
  with a `console.warn`. RONI and ONI stay the only required blocks.
- A claim is an observation in the current horizon unless the issuer frames
  the product as an outlook. No forward-looking verb. The forbidden list in
  `tests/enso-forecast-language.ts` is the test.
- Every `sourceUrl` and lineage label resolves through the register.
- Past `HARD_STALE_DAYS`, the claim is withheld the way the tendency claim is.

Placeholders: `__Name__` (PascalCase type stem), `__slug__` (camelCase block
key), `__SLUG__` (register slug, kebab-case), `__ISSUER__`, `__URL__`. The
`.template.ts` and `.template.mjs` files are not compiled or imported; if
`tsc --noEmit` ever picks them up, rename them with a `.txt` suffix rather
than excluding them in tsconfig.
