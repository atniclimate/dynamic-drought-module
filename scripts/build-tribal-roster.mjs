/**
 * build-tribal-roster.mjs (U3b, D-STD-012 / D-0.7.0-017)
 *
 * Builds the NAMES-ONLY search index for the "one search" experience's Tribal
 * land-area results, plus a crosswalk audit for the maintainer. Run at build
 * time (like build-states.mjs / build-enso-snapshot.mjs); the browser never
 * makes these calls.
 *
 * Two authoritative sources, both fetched fresh:
 *   1. The Bureau of Indian Affairs (BIA) annual Federal Register notice of
 *      federally recognized Tribes ("Indian Entities Recognized by and Eligible
 *      To Receive Services From the United States Bureau of Indian Affairs").
 *      Auto-discovered via the keyless federalregister.gov REST API, so the
 *      edition is never hardcoded. Names only; each Tribe is one <FP> element.
 *   2. The BIA American Indian and Alaska Native Land Area Representation
 *      (AIAN-LAR) FeatureServer's distinct LARNAME values: the land areas the
 *      live map layer can locate. Names only (returnDistinctValues, no geometry).
 *
 * STEWARDSHIP (CLAUDE.md hard rules 1, 5, 6):
 *   - NO polygons, coordinates, or geometry are ever fetched or written. The
 *     search jumps to a land area by querying the LIVE AIAN-LAR service for its
 *     extent at selection time (U3d); this build produces only NAMES.
 *   - Tribe display names come from the Federal Register verbatim (full formal
 *     names, never abbreviated). A land area whose LARNAME does not match a
 *     roster name keeps the BIA's own land-area label and is FLAGGED for
 *     maintainer review rather than mapped to a guessed Tribe name.
 *   - "Tribe", "Tribal", "Treaty" stay capitalized; no em dashes.
 *
 * CROSSWALK AUTHORITY AND THE SAFE MATCHER (D-0.7.0-026, 2026-07-11):
 *   The maintainer ruled that BIA records are the source of truth and the
 *   crosswalk is automated, safe matches only, with a Codex adversarial
 *   validation instead of a manual row review. The authoritative-source
 *   investigation (recorded in the ruling) found NO published BIA
 *   LAR-to-Tribal-entity association: the AIAN-LAR FeatureServer layer
 *   carries only LARID / LARNAME / CLASSIFICATION / GISACRES / REGION
 *   (LARID is a sequential number, no tribal code; no relationships), the
 *   LAR Supplemental layer adds none, and the BIA Tribal Leaders Directory
 *   service (Hosted/Tribal_Leaders_Directory_new) has entity names but no
 *   LAR key. So the crosswalk derives from NAME evidence alone under these
 *   safety rules (guessing is forbidden):
 *     1. A parenthetical US-state qualifier in a LARNAME (for example
 *        "Kickapoo (Kansas)") is parsed off and used as a CONSTRAINT: the
 *        matched roster name must mention that state. State names are
 *        NEVER dropped as noise (the pre-ruling matcher's failure mode).
 *     2. The remaining base phrase must appear VERBATIM (normalized,
 *        whole-word, contiguous) inside the formal roster name. No token
 *        reordering, no token-subset matching.
 *     3. The base phrase must carry at least one distinctive token (not a
 *        purely organizational word like "tribe" or "reservation").
 *     4. The match must be UNIQUE: exactly one roster name survives rules
 *        1-3. Zero or several candidates route to the honest BIA
 *        land-area label (provenance "lar-label"), exactly like the
 *        unmatched rows; ambiguous candidate sets are listed in the
 *        crosswalk audit for the maintainer's residue review.
 *     5. A maintainer-curated KNOWN_AMBIGUOUS list (D-0.7.0-026a) runs
 *        BEFORE the matcher: a listed LARNAME always keeps the BIA
 *        land-area label because its sovereign attribution hides behind a
 *        historical renaming the uniqueness test cannot see (the premise
 *        is recorded at each entry). Maintainer-only; never automated.
 *     6. A MAINTAINER_CONFIRMED map (D-0.7.0-026b) annotates safe-matched
 *        rows the maintainer explicitly CONFIRMED against a flagged
 *        historical-renaming collision, on the premise that the other
 *        claimant Nation holds its own parallel LAR row. The build
 *        verifies that parallel row still exists and FAILS if it
 *        disappears (the ruling reopens). Maintainer-only.
 *   Every emitted area row carries a `provenance` field ("safe-match" or
 *   "lar-label"; "bia-authoritative" is reserved for a future BIA-published
 *   association). The runtime search (src/ui/search-controller.ts) renders
 *   a Tribal Nation name ONLY for trusted provenance; anything else renders
 *   the BIA land-area label. That gate is structural, not advisory.
 *
 * Outputs (both under public/data/, names only):
 *   - tribal-roster.json         the runtime search index (one entry per
 *                                locatable land area: larName + displayName +
 *                                a normalized search string)
 *   - tribal-larname-crosswalk.json  the audit for the maintainer review:
 *                                matched pairs, LARNAME values with no roster
 *                                match (the mismatch report), and roster names
 *                                with no land area.
 *
 * The console summary IS the mismatch report the maintainer signs off before
 * Tribal search results go fully live.
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'public', 'data');

const FR_SEARCH =
  'https://www.federalregister.gov/api/v1/documents.json' +
  '?conditions%5Bterm%5D=%22Indian+Entities+Recognized%22' +
  '&conditions%5Bagencies%5D%5B%5D=indian-affairs-bureau' +
  '&conditions%5Btype%5D%5B%5D=NOTICE' +
  '&order=newest&per_page=5' +
  '&fields%5B%5D=document_number&fields%5B%5D=publication_date' +
  '&fields%5B%5D=title&fields%5B%5D=full_text_xml_url';

const BIA_LAR_DISTINCT =
  'https://biamaps.geoplatform.gov/server/rest/services/DivLTR/BIA_AIAN_National_LAR' +
  '/FeatureServer/0/query?where=1%3D1&outFields=LARNAME&returnDistinctValues=true' +
  '&returnGeometry=false&orderByFields=LARNAME&f=json';

const FETCH_TIMEOUT_MS = 30_000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** Decode the handful of XML entities that appear in Tribe names. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8217;|&#x2019;/g, '’')
    .replace(/&#8216;|&#x2018;/g, '‘')
    .replace(/&quot;/g, '"');
}

// Hard rule 4 (no U+2014) targets authored prose; verbatim federal and BIA
// source names are otherwise exempt (maintainer, 2026-07-11, to be
// acknowledged in CLAUDE.md at the sprint trueup). The maintainer did rule
// that the two compound names the Federal Register renders with em dashes
// (the Fort Sill and Chickahominy names) ship with hyphens; normalize em
// dashes to hyphens here so a regeneration preserves that rendering. Names
// are otherwise carried verbatim and never abbreviated (hard rule 6). The
// escape keeps this script free of the literal byte (scripts/ is scanned).
function noEmDash(s) {
  // String.fromCharCode keeps the literal U+2014 byte out of this scanned
  // script (the same guard scan-emdash.mjs uses).
  return s.replace(new RegExp(String.fromCharCode(0x2014), 'g'), '-');
}

/** Parse the roster (formal Tribe names) from the Federal Register full-text XML. */
function parseRoster(xml) {
  const names = [];
  for (const m of xml.matchAll(/<FP SOURCE="FP-1"[^>]*>([\s\S]*?)<\/FP>/g)) {
    const name = noEmDash(
      decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    );
    if (!name) continue;
    // "See ..." entries are cross-references to another listing, not a distinct
    // Tribe; skip them so they do not double-count or mislabel.
    if (/^.*\(See /i.test(name) && /\(See [^)]+\)\s*$/i.test(name)) continue;
    names.push(name);
  }
  return names;
}

// The 50 US state names, normalized. Used ONLY to recognize a parenthetical
// state qualifier in a LARNAME and apply it as a match CONSTRAINT
// (D-0.7.0-026 rule 1). Never used to drop tokens.
const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming'
]);

// Purely organizational words. Used ONLY for the distinctiveness test
// (D-0.7.0-026 rule 3): a base phrase must carry at least one token outside
// this set before it may match at all. NEVER used to drop tokens from the
// phrase itself, and state names are deliberately NOT in this set.
const GENERIC = new Set([
  'tribe', 'tribes', 'nation', 'nations', 'band', 'bands', 'of', 'the', 'and',
  'indian', 'indians', 'community', 'communities', 'reservation',
  'reservations', 'rancheria', 'pueblo', 'confederated', 'native', 'village',
  'group', 'people', 'peoples', 'colony', 'town', 'tribal', 'a', 'in',
  'trust', 'land', 'lands', 'off'
]);

// MAINTAINER-CURATED known-ambiguous LARNAMEs (D-0.7.0-026a, Patrick,
// 2026-07-11). Each entry names a LARNAME (normalized) whose sovereign
// attribution the safe matcher CANNOT settle honestly from names alone,
// because the collision hides behind a historical renaming the current
// Federal Register roster no longer shows. These rows are forced to the
// honest BIA land-area label (provenance "lar-label") and surfaced in the
// crosswalk audit's ambiguous list with the claimant Nations recorded.
// ONLY the maintainer adds or removes entries, and every entry records its
// premise; automation never guesses.
const KNOWN_AMBIGUOUS = new Map([
  [
    'san juan',
    {
      // Premise (D-0.7.0-026a): the unqualified "San Juan" land area is
      // claimable by two federally recognized Nations. The uniqueness test
      // sees only one candidate because Ohkay Owingeh was previously listed
      // as Pueblo of San Juan and renamed; BIA records associate
      // "M25714 - Ohkay Owingeh (San Juan)" with that Nation.
      candidates: [
        'San Juan Southern Paiute Tribe of Arizona',
        'Ohkay Owingeh, New Mexico (previously listed as Pueblo of San Juan)'
      ]
    }
  ]
]);

// MAINTAINER-CONFIRMED attributions (D-0.7.0-026b, Patrick, 2026-07-11).
// Each entry names a safe-matched LARNAME (normalized) whose attribution
// the adversarial validation flagged as a possible historical-renaming
// collision and the MAINTAINER CONFIRMED as correct. A confirmation, not a
// curation: the row stays provenance "safe-match" and gains a
// confirmed: "D-0.7.0-026b" annotation in the crosswalk audit. The premise
// of each confirmation is that BIA's own LAR partitioning distinguishes
// the Nations (the other claimant holds its OWN LAR row, named in
// parallelLar); the build VERIFIES that parallel row still exists in the
// live LAR set and FAILS if it disappears, because losing the parallel-LAR
// evidence REOPENS the ruling. ONLY the maintainer adds or removes entries.
const MAINTAINER_CONFIRMED = new Map([
  [
    'winnebago',
    {
      // Premise (D-0.7.0-026b): the Ho-Chunk Nation of Wisconsin was
      // formerly the Wisconsin Winnebago Tribe (65 FR 13298), but it holds
      // its own "Ho-Chunk" LAR row, so BIA's partitioning distinguishes it
      // from the Winnebago Tribe of Nebraska's "Winnebago" row.
      confirmed: 'D-0.7.0-026b',
      parallelLar: 'Ho-Chunk'
    }
  ],
  [
    'sault ste marie',
    {
      // Premise (D-0.7.0-026b): Bay Mills Indian Community was formerly
      // listed as "... of the Sault Ste. Marie Band of Chippewa Indians",
      // but it holds its own "Bay Mills" LAR row, so BIA's partitioning
      // distinguishes it from the Sault Ste. Marie Tribe of Chippewa
      // Indians, Michigan.
      confirmed: 'D-0.7.0-026b',
      parallelLar: 'Bay Mills'
    }
  ]
]);

function norm(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole-word contiguous phrase containment on normalized strings. */
function phraseIn(haystackNorm, phraseNorm) {
  return ` ${haystackNorm} `.includes(` ${phraseNorm} `);
}

/**
 * Split a LARNAME into its base phrase and an optional US-state constraint.
 * A parenthetical qualifier that names a US state becomes the constraint
 * ("Kickapoo (Kansas)" then base "Kickapoo", state "kansas"); any other
 * parenthetical stays part of the base phrase.
 */
function parseLarName(larName) {
  const m = larName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    const qual = norm(m[2]);
    if (US_STATES.has(qual)) return { base: m[1], state: qual };
  }
  return { base: larName, state: null };
}

async function main() {
  console.log('[tribal-roster] discovering the current Federal Register notice...');
  const search = await getJson(FR_SEARCH);
  const doc = search.results?.[0];
  if (!doc?.full_text_xml_url) {
    throw new Error('Federal Register search returned no full_text_xml_url');
  }
  console.log(
    `[tribal-roster] edition ${doc.document_number} (${doc.publication_date}): ${doc.title}`
  );

  const xml = await getText(doc.full_text_xml_url);
  const roster = parseRoster(xml);
  if (roster.length < 500 || roster.length > 700) {
    throw new Error(`roster count ${roster.length} is outside the expected 500-700 band`);
  }
  console.log(`[tribal-roster] roster: ${roster.length} federally recognized Tribes (names only)`);

  console.log('[tribal-roster] fetching distinct AIAN-LAR land-area names (no geometry)...');
  const larJson = await getJson(BIA_LAR_DISTINCT);
  const larNames = (larJson.features ?? [])
    .map((f) => f.attributes?.LARNAME)
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => noEmDash(n.trim()));
  if (larJson.exceededTransferLimit) {
    throw new Error('AIAN-LAR distinct query hit the transfer limit; paginate before trusting it');
  }
  console.log(`[tribal-roster] land areas: ${larNames.length} distinct LARNAME values`);

  // Pre-normalize the roster for phrase matching.
  const rosterNorm = roster.map((name) => ({ name, norm: norm(name) }));

  const areas = [];
  const larLabelFallback = [];
  const ambiguous = [];
  const matchedPairs = [];
  const matchedRoster = new Set();

  for (const larName of larNames) {
    // The maintainer-curated known-ambiguous gate runs FIRST
    // (D-0.7.0-026a): a listed LARNAME never reaches the matcher. It keeps
    // the honest BIA land-area label and its claimant Nations go to the
    // audit's ambiguous list.
    const curated = KNOWN_AMBIGUOUS.get(norm(larName));
    if (curated) {
      larLabelFallback.push(larName);
      ambiguous.push({
        larName,
        candidates: curated.candidates,
        rule: 'known-ambiguous (maintainer-curated, D-0.7.0-026a)'
      });
      areas.push({ larName, displayName: larName, provenance: 'lar-label' });
      continue;
    }

    // The SAFE MATCHER (D-0.7.0-026; the four rules in the header).
    const { base, state } = parseLarName(larName);
    const baseNorm = norm(base);
    const baseToks = baseNorm.split(' ').filter(Boolean);
    const distinctive = baseToks.some((t) => t.length > 2 && !GENERIC.has(t));

    let candidates = [];
    if (baseNorm && distinctive) {
      candidates = rosterNorm.filter((r) => phraseIn(r.norm, baseNorm));
      if (state) candidates = candidates.filter((r) => phraseIn(r.norm, state));
    }

    let match = null;
    if (candidates.length === 1) {
      match = candidates[0];
      matchedRoster.add(match.name);
      const pair = {
        larName,
        tribe: match.name,
        rule: state ? 'unique-containment+state' : 'unique-containment'
      };
      // The maintainer-confirmed annotation (D-0.7.0-026b): verify the
      // parallel-LAR premise still holds in the live source, then annotate.
      const confirmation = MAINTAINER_CONFIRMED.get(norm(larName));
      if (confirmation) {
        if (!larNames.includes(confirmation.parallelLar)) {
          throw new Error(
            `MAINTAINER_CONFIRMED premise broken: the parallel LAR row ` +
              `"${confirmation.parallelLar}" for "${larName}" is no longer in ` +
              `the live AIAN-LAR set; the ${confirmation.confirmed} ruling is ` +
              `REOPENED. Surface to the maintainer; do not ship this build.`
          );
        }
        pair.confirmed = confirmation.confirmed;
        pair.parallelLar = confirmation.parallelLar;
      }
      matchedPairs.push(pair);
    } else {
      larLabelFallback.push(larName);
      if (candidates.length > 1) {
        ambiguous.push({ larName, candidates: candidates.map((c) => c.name) });
      }
    }

    // Names only. The search component normalizes larName + displayName at
    // runtime for matching, so "yakama" and "confederated ... yakama nation"
    // both hit without storing a duplicate haystack here (keeps the fetched
    // index lean for rural connections). `provenance` is the STRUCTURAL gate
    // the runtime enforces: only "safe-match" (or a future
    // "bia-authoritative") may render a Tribal Nation name; the audit detail
    // (which rule matched, the ambiguous candidate sets) lives in the
    // crosswalk file, keeping this index lean.
    areas.push({
      larName,
      displayName: match ? match.name : larName,
      provenance: match ? 'safe-match' : 'lar-label'
    });
  }

  const rosterNoLar = roster.filter((name) => !matchedRoster.has(name));

  areas.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const generated = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const rosterOut = {
    _comment:
      'NAMES ONLY search index for Tribal land areas (U3b, D-STD-012; safe matcher and ' +
      'provenance gate per D-0.7.0-026). No polygons or coordinates: a search selection ' +
      'queries the live AIAN-LAR service for the extent at selection time. provenance ' +
      'safe-match: displayName is the formal Federal Register Tribe name, matched under ' +
      'the safety rules in scripts/build-tribal-roster.mjs. provenance lar-label: ' +
      'displayName is the BIA land-area label verbatim (no Tribe mapping is guessed). ' +
      'Regenerate with `npm run build:tribal-roster`.',
    meta: {
      rosterSource: `Federal Register ${doc.document_number} (${doc.publication_date})`,
      landAreaSource: 'BIA AIAN-LAR FeatureServer (distinct LARNAME)',
      matcher:
        'safe-match v2 (D-0.7.0-026): unique whole-phrase containment, state-constrained, ' +
        'distinctive-token guard; plus the maintainer-curated known-ambiguous gate (D-0.7.0-026a)',
      generated,
      rosterCount: roster.length,
      landAreaCount: larNames.length,
      safeMatchCount: matchedPairs.length,
      larLabelCount: larLabelFallback.length
    },
    areas
  };

  const crosswalkOut = {
    _comment:
      'Crosswalk audit for maintainer review (U3b; safe matcher per D-0.7.0-026). ' +
      'matched: land area LARNAME to the formal Federal Register Tribe name, with the ' +
      'safety rule that matched it; rows carrying a confirmed field were explicitly ' +
      'maintainer-confirmed against a flagged historical-renaming collision on the ' +
      'parallel-LAR premise (D-0.7.0-026b; parallelLar names the LAR row held by ' +
      'the other claimant Nation). larLabel: land areas that keep the BIA land-area ' +
      'label (no unambiguous match; NOT mapped to a guessed Tribe name, per hard rules ' +
      '5 and 6 and D-0.7.0-026); this is the maintainer residue list. ambiguous: the ' +
      'subset of larLabel rows where several roster names contained the LARNAME phrase ' +
      'OR the maintainer curated the row as known-ambiguous (D-0.7.0-026a; curated ' +
      'rows carry a rule field naming that ruling; the candidates are listed; ' +
      'automation refuses to pick). rosterNoLar: federally ' +
      'recognized Tribes with no matched land area in AIAN-LAR (landless Tribes, Alaska ' +
      'Native villages, or differently-named areas).',
    meta: rosterOut.meta,
    matched: matchedPairs,
    larLabel: larLabelFallback,
    ambiguous,
    rosterNoLar
  };

  // The runtime index ships in public/data (fetched lazily on first search).
  await writeFile(
    resolve(DATA_DIR, 'tribal-roster.json'),
    JSON.stringify(rosterOut, null, 2) + '\n',
    'utf8'
  );
  // The crosswalk audit ships alongside the roster in public/data. It is a
  // transparency artifact (how each land area maps to a federally recognized
  // Tribe). Names are carried from the Federal Register and BIA verbatim and
  // never abbreviated (hard rule 6); the only normalization is noEmDash
  // (above), which renders the em-dash compound names with hyphens per the
  // maintainer ruling (2026-07-11). public/ stays out of the em-dash scan
  // because that scan targets authored prose, not verbatim source data (a
  // rule-4 refinement to be acknowledged in CLAUDE.md at the sprint trueup).
  await writeFile(
    resolve(DATA_DIR, 'tribal-larname-crosswalk.json'),
    JSON.stringify(crosswalkOut, null, 2) + '\n',
    'utf8'
  );

  // The mismatch report (console).
  console.log('\n===== TRIBAL ROSTER / LARNAME CROSSWALK: MISMATCH REPORT =====');
  console.log(`Roster (Federal Register ${doc.document_number}): ${roster.length} Tribes`);
  console.log(`Land areas (AIAN-LAR distinct LARNAME): ${larNames.length}`);
  console.log(
    `Safe-matched land areas: ${matchedPairs.length} / ${larNames.length} ` +
      `(${Math.round((matchedPairs.length / larNames.length) * 100)}%)`
  );
  console.log(
    `\nLand areas keeping the BIA label (${larLabelFallback.length}; the maintainer residue list):`
  );
  console.log('  ' + larLabelFallback.join('\n  '));
  if (ambiguous.length > 0) {
    console.log(`\nAmbiguous (several roster candidates; automation refused to pick): ${ambiguous.length}`);
    for (const a of ambiguous) {
      console.log(`  ${a.larName}:`);
      for (const c of a.candidates) console.log(`    - ${c}`);
    }
  }
  console.log(
    `\nFederally recognized Tribes with no matched land area: ${rosterNoLar.length} ` +
      '(landless / Alaska Native villages / differently-named; expected, not an error).'
  );
  console.log(
    '\nWrote public/data/tribal-roster.json and public/data/tribal-larname-crosswalk.json'
  );
}

main().catch((err) => {
  console.error('[tribal-roster] FAILED:', err.message);
  process.exit(1);
});
