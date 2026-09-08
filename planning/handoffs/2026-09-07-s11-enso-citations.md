# S11 handoff: ENSO citations, cite and correct the regional tilt statements (DDM-P12-T03)

Branch `feature/enso-citations-dr030` from `main` at `bd291d7`, **unpushed and unmerged**. Nothing
was pushed, merged, deployed, tagged, or deleted. Gates: `verify:quick` clean; `verify:smoke`
**119 passed, 1 skipped, 4.9m** (the skip is the same `tests/ux1-surfaces.spec.ts:98` quarantine
from `0121cef` that S10 reported); `check:public-tree` clean.

Commits: `8faa028` the verification and citation work, then the closing ledger commit.

The task was verification and citation completion, not a rewrite. Three sentences, thirty-two
clauses, each checked against the words of its own live page.

## The precondition S10 flagged, answered

S10's handoff said DR-030 "does not yet name the two it calls over-claiming" and called that naming
a precondition for this task's acceptance, not a step inside it. It is answered, and the answer
cost nothing.

**DR-030 names neither of them.** Its rationale says "Two of the four current sentences over-claim"
and stops. Its `source:` pointer, `13-enso-science-spec.md` ENSOSCI-09, repeats the same count in
its own heading (`13:519`, "Every one of the four tilt strings can now be cited, and two of them
over-claim") and also stops. `00-MASTER-FINDINGS.md:90` repeats it a third time and names none.

Reading ENSOSCI-09's per-string bodies settles it. They are the **El Nino** and **La Nina**
sentences:

- **El Nino** (`13:550-561`): three unsupported items, "below-normal snowpack" stated flatly,
  "an earlier melt-out" found in no source, and "tilts the following fire and heat season toward
  elevated risk" reaching a season past any source.
- **La Nina** (`13:594-605`): two, the equal weight given to "cooler" and "wetter" where the Hub
  says the precipitation association "is not as strong as for temperature", and the entire
  fine-fuels sentence, marked **UNVERIFIED**.

Both are sentences `46f98f4` had already narrowed or deleted. **No sentence DR-030 names came into
scope**, so nothing was added to this session's work by the naming. (The neutral sentence had its
own defect, the uncited forecast-skill assertion "offers little long-range signal", `13:640-645`,
also fixed by `46f98f4`. It is not one of the two.)

### What 46f98f4 did, per branch

| Branch | Deleted or narrowed | Replaced with |
| --- | --- | --- |
| El Nino | "tilts the odds toward a warmer, drier winter with **below-normal snowpack and an earlier melt-out**, which strengthens a 'drought persists or develops' read and **tilts the following fire and heat season toward elevated risk**" | The past-events framing, the Hub's warmer-and-drier tendency, and the snowpack **counter-evidence**: the three strongest El Ninos each produced near-normal Washington snowpack |
| La Nina | "tilts the odds toward a cooler, wetter winter with above-normal snowpack ... **La Nina is not a blanket all-clear for fire: a wet, productive winter can grow abundant fine fuels that cure through summer, so an active grass-fire season is still possible, especially east of the Cascades.**" | The past-events framing, "usually run cooler", "some events brought above-normal precipitation", and the Hub's own caveat that the precipitation association is not as strong as the temperature one. The fine-fuels sentence is **gone, not softened** |
| neutral | "A neutral phase **offers little long-range signal** for the Pacific Northwest, so the seasonal tilt rests on the CPC Seasonal Drought Outlook and current conditions" | "there is no warm-phase or cool-phase composite to lean on: CPC publishes composites describing the tendencies of each phase", then the same redirection. The forecast-skill assertion is gone |

## The clause tables

Every verdict is `ddm-science-verifier`'s, with the fetched page text supplied as the evidence
rather than left to the agent to find. All three pages answered HTTP 200 on 2026-09-07.

### El Nino, `NW_HUB_EL_NINO_URL`, USDA Northwest Climate Hub

| Clause | Page quote | Verdict |
| --- | --- | --- |
| the read rests on what past events did | "fall and winter are usually warmer and drier" | SUPPORTED |
| season "fall and winter" | "fall and winter are usually warmer and drier" | SUPPORTED |
| geography Idaho, Oregon and Washington | "In Idaho, Oregon, and Washington, fall and winter" | SUPPORTED |
| strength "have tended to run" | "are usually warmer and drier during El Nino events" | SUPPORTED (weaker than "usually", so safe) |
| "warmer and drier" | "warmer and drier" | SUPPORTED, verbatim |
| "with more precipitation falling as rain than snow" | "a drier, warmer **winter** results in ... more precipitation falling as rain than snow" | **NARROWED**, winter only |
| "associates that combination with decreased runoff" | "These impacts **can lead to** decreased runoff" | **NARROWED**, hedge restored |
| "less summer water availability" | "decreased runoff and summer water availability" | **NARROWED**, same chain |
| "increased wildfire risk" | "which **can contribute to drought and** increased wildfire risk" | **NARROWED**, two steps, drought link restored |
| "Snowpack is the least reliable part of the tendency" | none | **NOT ON THIS PAGE, reported as a STOP, since ruled and replaced** |
| the snowpack counter-evidence | none | NOT ON THIS PAGE, belongs to the Climate Office, now linked |

5 SUPPORTED, 4 NARROWED, 2 NOT ON THIS PAGE.

### La Nina, `NW_HUB_LA_NINA_URL`, USDA Northwest Climate Hub

| Clause | Page quote | Verdict |
| --- | --- | --- |
| the read rests on what past events did | "the typical effects are not a certainty" | SUPPORTED |
| season "winter" | "the effects of La Nina show up mostly in the winter" | SUPPORTED |
| geography Idaho, Oregon and Washington | "Idaho, Oregon, Washington, and most of Alaska" | SUPPORTED (app drops Alaska, a narrowing) |
| strength "has usually run" | "winter is usually cooler during La Nina events" | SUPPORTED |
| "cooler" | "cooler than average temperatures" | SUPPORTED |
| "some events brought above-normal precipitation" | "Some La Nina events also bring above normal precipitation" | SUPPORTED |
| the precipitation caveat | "the association is not as strong as for temperature" | SUPPORTED |
| "A deeper snowpack **has been associated with** increased runoff" | "A deeper snowpack ... **can lead to** increased runoff" | **NARROWED** |
| "more reliable summer water availability" | "more reliable summer water availability" | **NARROWED**, same verb |
| "reduced drought severity" | "reduced drought severity" | **NARROWED**, same verb |

7 SUPPORTED, 3 NARROWED, 0 unsupported. The page contains **no** fine-fuels, cured-grass or
grass-fire content; the word "fire" does not appear on it. `46f98f4`'s deletion is corroborated,
and the spec now asserts it cannot come back.

### Neutral, `CPC_COMPOSITES_URL`, NOAA CPC composites

| Clause | Page quote | Verdict |
| --- | --- | --- |
| "CPC publishes composites describing the tendencies of each phase" | "El Nino Temperature ... La Nina Precipitation" | SUPPORTED |
| "no warm-phase or cool-phase composite to lean on" | the page lists El Nino and La Nina families and **no third** | SUPPORTED (absence is the strongest support a listing page gives a negative claim) |
| composites cover snow too | "El Nino Snow" / "La Nina Snow" | SUPPORTED |
| "rests on the CPC Seasonal Drought Outlook" | none | NOT ON THIS PAGE, carried by the lineage entry, now linked |
| "and on current conditions (snowpack, soil moisture, USDM)" | none | NOT ON THIS PAGE, the app's own redirection |

3 SUPPORTED, 0 NARROWED, 2 NOT ON THIS PAGE. The verifier confirmed the retired
"offers little long-range signal" skill assertion is gone and nothing replaces it.

## The narrowed sentences, before and after

**El Nino**, one edit covering four clauses:

> BEFORE: ...fall and winter in Idaho, Oregon and Washington have tended to run warmer and drier,
> with more precipitation falling as rain than snow; the USDA Northwest Climate Hub associates that
> combination with decreased runoff, less summer water availability, and increased wildfire risk.

> AFTER: ...fall and winter in Idaho, Oregon and Washington have tended to run warmer and drier, and
> the USDA Northwest Climate Hub states that a drier, warmer winter results in more precipitation
> falling as rain than snow, which can lead to decreased runoff and less summer water availability,
> and can in turn contribute to drought and increased wildfire risk.

**El Nino**, the bound on "on record":

> BEFORE: the three strongest El Ninos on record (1982-83, 1997-98 and 2015-16)
> AFTER: the three strongest El Ninos on record in the modern era (1982-83, 1997-98 and 2015-16)

Both issuers bound it. The cited page says "the strongest El Nino on record **in the modern era**";
the Climate Office's own site says "on record **(since 1950)**" and adds that "Different indices
rank the events differently".

**La Nina**, one verb:

> BEFORE: A deeper snowpack has been associated with increased runoff, more reliable summer water
> availability, and reduced drought severity.
> AFTER: A deeper snowpack can lead to increased runoff, more reliable summer water availability,
> and reduced drought severity.

The object list already matched the page word for word and was not touched.

## The STOP, raised and ruled the same day

> **was** "Snowpack is the least reliable part of the tendency"
> **now** "That tendency has not held for snowpack in the largest events"
> `src/impact/enso.ts`, `tendency()`, case `'el-nino'`

**No issuer page stated the old wording.** It ranked snowpack against the tendency's other parts,
temperature and precipitation, and neither the USDA Northwest Climate Hub nor the Washington State
Climate Office makes that comparison. What the Office does support is narrower and different:
because these very strong events "haven't happened very often", it is "hard to say whether they
represent a real pattern or just a small sample size". That is uncertainty about **recurrence**,
not a ranking across components.

Per the session instruction, a clause no page states is not narrowed but reported, so it was
**reported and left standing**, not quietly reworded. It was not a small call: DR-030's own
rationale calls the snowpack qualification "the most important single change ... because the app is
about to make a snowpack claim during exactly the class of event that historically defied it", and
this clause is the hinge that turns the counter-evidence from a stray fact into a reason.

**The owner ruled the same day**, conditionally: replace it, but run the new final clause through
`ddm-science-verifier` first, and if it did not bind, ship the original prefixed
"In this application's reading, " as a labelled DDM presentation choice.

**It binds. Verdict VERIFIED**, so the fallback was not taken. The full replacement:

> That tendency has not held for snowpack in the largest events: the Washington State Climate
> Office notes that the three strongest El Ninos on record in the modern era (1982-83, 1997-98 and
> 2015-16) each produced near-normal Washington snowpack, and that it is hard to say whether that
> is a real pattern or a small sample.

The verifier was asked point blank whether the new opening is still a comparative ranking of the
kind that failed, and answered no: it makes a **bounded** factual claim about one component in one
class of event, which the page supports directly ("During past 'very strong' El Nino years, though,
things have looked a little different"), rather than a comparison across components that no issuer
makes. The replacement claims no recurrence, predicts no winter, and states no general El Nino
snowpack rule beyond the three named events.

### Two open notes from that verification, neither acted on

1. **A one-word tightening, recommended and not applied.** The page's vocabulary is "very strong",
   "the strongest El Nino on record", "the next strongest El Ninos"; it never says "large" or
   "largest". The verifier recommended `largest` become `strongest`, and was explicit that
   "largest" does **not** broaden the category, because the three named events gloss it
   immediately. Against the change: "strongest" already appears later in the same sentence. The
   owner specified the exact wording and the condition they set was met, so their wording shipped.
   **Theirs to accept or wave off.**
2. **The attribution is indirect by one step.** In the article the near-normal-snowpack statement
   is a direct quotation from the Deputy Washington State Climatologist, but the "hard to say"
   sentence sits **outside** the quotation marks: it is the article's own narration bridging two of
   her quotes. The app uses reported speech, "notes that ... and that it is hard to say ...", so
   nothing is presented as a quote that is not one. The verifier called it fair but loose and
   raised it as a soft flag, not a defect. Recorded so a later reader does not rediscover it.

Both are at DR-030 `stop_raised_and_ruled_2026_09_07` and in the references register.

## The two lineage entries that had no URL, both resolved

**Washington State Climate Office.** The lineage label is "Washington State Climate Office,
University of Washington College of the Environment". The page that states the claim for all three
named events is a UW College of the Environment article quoting the Deputy Washington State
Climatologist, which itself says "The Washington State Climate Office, housed within the UW College
of the Environment". Report 13 had already proposed this URL. The label was **not** changed; a
`WA_CLIMATE_OFFICE_URL` constant now carries the link.

The Office's **own** site (`climate.uw.edu`, which `climate.washington.edu` redirects to) was
searched and does carry a relevant page, "A Review of Winter 2015-2016". It could not be the
primary citation: it states near-normal **snowpack** explicitly for 2015-16 alone, and for 1982/83
and 1997/98 reports **precipitation** outcomes plus the generalization that the three strongest
"have not fit that pattern", where the pattern is drier-than-normal winter conditions. Near-normal
precipitation does not entail near-normal snowpack. It is recorded as corroborating evidence, and
it supplied the "(since 1950)" bound behind the narrowing.

**CPC Seasonal Drought Outlook.** Resolved to the product page, verified, and it is the **same**
`(source, sourceUrl)` pair this app already ships at `src/impact/hydrate.ts:72-73`, so linking it
makes two surfaces agree rather than introducing a source. It is a rolling product whose prose is
rewritten each issuance; the citation is safe because the branch makes a **naming** claim and not a
content claim. If a future edit quotes the page's current wording, that quote needs its own
retrieved stamp.

Both register entries now read `gap: false` with `last_checked: 2026-09-07`.

## The product name, flagged and corrected

The CPC composites page's own `<title>` reads "Climate Prediction Center - ENSO Temperature and
Precipitation Composites" and its section heading "ENSO Temperature & Precipitation Composites";
snow appears only in its six product links ("El Nino Snow", "La Nina Snow"). The app's
neutral-branch `source` string and its `CPC_COMPOSITE_LINEAGE` constant both read "NOAA CPC ENSO
temperature, precipitation and snow composites", presenting a three-variable name as if it were the
issuer's own. The snow composites do exist, so the old label was **not false, only not the
issuer's**.

S11 raised it as a flag rather than fixing it, because editing a `source` string is a rewrite and
not the clause narrowing the task authorized. **The owner then authorized it as a citation
correction.** Both strings now read `NOAA CPC ENSO Temperature and Precipitation Composites`, the
issuer's title with the issuer's name in front of it. The references register keeps its slug
`cpc-enso-composites`; only its `product:` label moved.

Two historical documents quote the old label and are deliberately **not** edited, being the record
of what was found at the time: `planning/2026-09-01-deep-dive/13-enso-science-spec.md:684` and
`.planning/2026-09-07-recon-report.md:96`. DR-030's own `citations:` list still reads
"13#17 CPC per-season composites including snow", which remains accurate about the page's *content*
and is left verbatim as the record of what was asked.

## `check:links`: 7 of 7 green, 19 pre-existing failures left untouched

Every URL this task touched is healthy. `node scripts/check-links.mjs`, 2026-09-07:

    ok  200  https://environment.uw.edu/news/2026/08/what-to-expect-from-a-very-strong-el-nino-in-the-pacific-northwest/
    ok  200  https://www.climatehubs.usda.gov/hubs/northwest/topic/el-nino-northwest-what-can-we-expect
    ok  200  https://www.climatehubs.usda.gov/hubs/northwest/topic/la-nina-northwest-what-can-we-expect
    ok  200  https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso/roni/
    ok  200  https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml
    ok  200  https://www.cpc.ncep.noaa.gov/products/expert_assessment/sdo_summary.php
    ok  200  https://www.cpc.ncep.noaa.gov/products/precip/CWlink/ENSO/composites/

The run as a whole reports **69 of 88 healthy** and exits 1. **OWNER CALL: the 19 failures are
pre-existing and none is attributable to this session.** `src/impact/enso.ts` is the only source
file S11 changed, and none of the 19 URLs appears in it (checked by literal match against the file).
They were not touched, per the owner's instruction. The list, with what each one looks like:

| Status | URL | Looks like |
| --- | --- | --- |
| 400 | `https://tile.openstreetmap.org/{z` | tile template truncated at `{z` by the extractor |
| 403 | `https://a.tile.opentopomap.org/{z`, and the `b.` and `c.` siblings | same, three rows |
| 400 | `https://gibs.earthdata.nasa.gov/.../GoogleMapsCompatible_Level7/{z` | same |
| 400 | `https://gibs.earthdata.nasa.gov/.../default/{TIME` | same, truncated at `{TIME` |
| 404 | `https://tds-proxy.nkn.uidaho.edu/thredds/.../agg_met_spi90d_1979_` | an elided path, the `...` is literal in the source |
| 404 | `https://services2.arcgis.com/.../NOAA_Satellite_Smoke_Detection_(v1` | truncated at the parenthesis |
| 400 | `https://waterservices.usgs.gov/nwis/iv/` | API root, needs query parameters |
| 400 | `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data` | API root, needs parameters |
| 400 | `https://overpass-api.de/api/interpreter`, plus the `kumi.systems` and `openstreetmap.fr` mirrors | API roots, need a POST body; three rows |
| 404 | `https://usdmdataservices.unl.edu/api` | API root |
| 404 | `https://storage.googleapis.com/noaa-nidis-drought-gov-data/current-conditions/tile/v1` | tile root |
| 404 | `https://agriculture.canada.ca/atlas/.../geoJSON/areasofDrought` | worth a real look |
| 404 | `https://atniclimate.github.io` | the project's own Pages root |
| 404 | `https://ddm-proxy.atniclimate.workers.dev` | the Worker root, no route at `/` |
| TypeError | `https://alerts.weather.gov/` | did not resolve on this run |

Most are scanner artifacts: `extractUrls` stops a URL at `{`, `(` or whitespace, so every templated
endpoint is checked as a truncated prefix that cannot answer 200, and every bare API root is checked
without the parameters it requires. Those are not decay. The four worth a human glance are the
Canada drought GeoJSON, the two project-owned roots (`atniclimate.github.io` and the Worker, both of
which may simply have no route at `/`), and the `alerts.weather.gov` resolution failure. `check:links`
is deliberately outside the release gate; `scripts/check-links.mjs:11-13` says so in its own words,
because transient third-party availability must not block a deployment.

## Files changed

- **`src/impact/enso.ts`**: `CITATIONS_VERIFIED` re-stamped `2026-09-07`; two new URL constants,
  `WA_CLIMATE_OFFICE_URL` and `CPC_SEASONAL_DROUGHT_OUTLOOK_URL`; a new exported
  `LINEAGE_SOURCE_URLS` table saying where each lineage label is published, added because
  `noUnusedLocals` is on and because a label and its page should not be able to drift apart. Every
  lineage **string** is unchanged, as instructed. Three sentence narrowings. The comment block above
  `tendency()` records the re-verification, the ruled snowpack framing, and the corrected product
  name.
- **`tests/enso-citations.spec.ts`** (new): names DDM-P12-T03 and quotes its acceptance. Three
  fixtures, one per branch, forced through the snapshot's `roni.state` block. Each asserts the
  long-range claim's source link `href` equals the URL **read from**
  `planning/references/register.yaml` for that branch, a season word, a hedge word, and no forecast
  verb. A fourth test pins the three narrowings and the fine-fuels deletion. In `verify:smoke`.
- **`tests/enso-forecast-language.ts`** (new): the `FORWARD_LOOKING` list lifted unchanged out of
  `tests/enso-horizons.spec.ts` so both specs assert one copy. Not a spec; declares no test.
- **`tests/enso-horizons.spec.ts`**: imports that list instead of defining it. No assertion changed.
- **`package.json`**: the new spec appended to `verify:smoke`.

The season and hedge word lists in the spec are derived from the verified pages and each derivation
is stated in a comment beside it, so a later reader can check the list against the sources rather
than take it on trust.

## Next in this neighbourhood: DDM-P8-T03, honest horizon chips

The natural next task, and S10 left a finding for it that still holds. Its acceptance
(`docs/ROADMAP.yaml:325`):

> A horizon a hazard cannot answer is absent or visibly disabled with its reason, and every hazard
> surface states its time in one grammar with its forecast register visually distinct from its
> observed register.

**S10's carried finding: the shell chips still say "Weeks ahead".** The briefing panel's three
column headings now share one grammar from one table (`src/impact/horizon-chrome.ts`), but the map
shell's chips still read `Current / Weeks ahead / Season ahead`
(`TEMPORAL_HORIZON_CHIP_LABELS`, `src/config/clusters.ts:80-86`), so the same horizon is still
"Near Term / days to weeks" in the briefing and "Weeks ahead" on the shell. The "one grammar"
clause is therefore **not** satisfied across surfaces. Reconciling the two vocabularies is the
ruling `clusters.ts:72-78` explicitly reserves for the owner, not a refactor. The
"forecast register visually distinct from its observed register" clause is likewise unsatisfied and
was never attempted: S10 removed a false forecast register from the chrome; it added no visual
distinction.

Nothing in S11 touched either. `src/config/clusters.ts` and `tests/heat-h1-heatrisk.spec.ts` remain
untouched by S09, S10 and S11 alike.

## Open owner calls from this session

The two substantive calls this session raised, the snowpack framing and the composites product
name, were both **ruled and implemented the same day**. What is left:

1. **`largest` or `strongest`** in the ruled snowpack sentence. The verifier recommended
   `strongest`, the issuer's own word; the owner's exact wording used `largest` and shipped,
   because the condition the ruling set was met and `largest` broadens nothing. One word, one edit,
   whenever you want it. See the STOP section above.
2. **`check:links` exits 1 on 19 pre-existing failures.** None is attributable to S11 and none was
   touched, per instruction. Four are worth a human glance: the Canada drought GeoJSON, the two
   project-owned roots (`atniclimate.github.io` and the Worker), and the `alerts.weather.gov`
   resolution failure. The rest are scanner artifacts. Full table above.
3. **The roster block was renamed `S11-S19` to `S12-S19`** because this session took `S11`. Same
   split as S09 and S10; flagged rather than assumed.
4. **`tests/enso-forecast-language.ts` is attached to no task in `.planning/TRACE.yaml`.** The
   instruction allowed attaching the new spec only. The module is shared by the DDM-P12-T02 and
   DDM-P12-T03 specs; attaching it to either, or to both, is a one-line repair with a dated comment.
5. Still not done as of this session and not touched by it, carried from S10: the `no-heredoc.mjs`
   hook in `.claude/` (the rule was followed without it).
