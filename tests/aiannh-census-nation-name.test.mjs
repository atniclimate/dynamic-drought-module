import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Round 4 audit, R4-18: a Census-only Tribal area carries one name. Search
 * titles a Census AIANNH row by the roster's gated name (gatedCensusName,
 * src/state/tribal-roster.ts) with "Census area: <NAME>" beside it, so a map
 * click on the same polygon must title its briefing, its selected-place label
 * and its popup the same way, as the BIA path already does
 * (tests/bia-popup-nation-name.test.mjs). An untrusted (census-label) row
 * keeps the Census name, and until the roster loads the Census name titles it.
 *
 * The Nation's name is read from the shipped roster (public data: the Federal
 * Register roster matched to Census AIANNH names), never written here.
 * Red on 22268b3: the click titles the briefing and the popup "Creek OTSA".
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.endsWith('.ts') &&
        existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  }
});

const context = await import('../src/impact/context.ts');
const { buildAiannhPopupModel } = await import('../src/ui/popups.ts');
const { serializePopupFrame } = await import('../src/ui/popup-frame.ts');
const { gatedCensusName } = await import('../src/state/tribal-roster.ts');

const ROSTER = JSON.parse(readFileSync(new URL('../public/data/tribal-roster.json', import.meta.url), 'utf8'));
const trusted = ROSTER.censusAreas.find((area) => area.name === 'Creek OTSA');
// An area alone on its Census name: a shared area's Census row shares its NAME with each Nation's row.
const untrusted = ROSTER.censusAreas.find(
  (area) => area.provenance === 'census-label' && ROSTER.censusAreas.filter((other) => other.name === area.name).length === 1
);
const CONDITIONS = { head: [{ label: 'Conditions', text: 'Fixture conditions.' }], rows: [], hasWarning: false, warningLabel: null };
const LNG_LAT = { lng: -96, lat: 35.6 };

test('a Census-only Tribal area titles its click as the search titles it, through the roster gate', async () => {
  assert.equal(trusted?.provenance, 'safe-match', 'the finding case is a trusted Census row');
  assert.notEqual(trusted.displayName, trusted.name);
  assert.ok(untrusted, 'the roster carries an untrusted Census row');

  const original = globalThis.fetch;
  let answer;
  const answered = new Promise((resolve) => { answer = resolve; });
  globalThis.fetch = () =>
    answered.then(() => new Response(JSON.stringify(ROSTER), { headers: { 'content-type': 'application/json' } }));
  try {
    const props = { NAME: trusted.name, AIANNHCC: 'D6' };
    // Before the roster lands: the Census name, as before.
    assert.equal(context.resolveBoundaryTitle('aiannh', props), trusted.name);
    assert.equal(context.buildBoundaryContext('aiannh', props, null, LNG_LAT).areaLabel, undefined);
    answer();
    const names = await context.loadCensusNationNames();

    // The briefing and the selected-place label (both context.title) take the search's label.
    const selection = context.buildBoundaryContext('aiannh', props, null, LNG_LAT);
    assert.equal(selection.title, gatedCensusName(trusted));
    assert.equal(selection.title, trusted.displayName);
    assert.equal(selection.areaLabel, `Census area: ${trusted.name}`, "the search's own sublabel");
    assert.equal(selection.kind, 'aiannh', 'the Census source kind (its subtitle) is unchanged');
    assert.equal(context.resolveBoundaryTitle('aiannh', props), selection.title, 'the click label moves with the title');

    // A state-recognized area carries the search row's line on a click too; a federal one carries none.
    for (const area of ROSTER.censusAreas.filter((a) => a.stateArea)) {
      const click = context.buildBoundaryContext('aiannh', { NAME: area.name }, null, LNG_LAT);
      assert.equal(click.landNote, context.stateAreaNote(area.name), `${area.name}: the click carries the state-recognized line`);
    }
    assert.equal(selection.landNote, undefined, 'a federal area carries no state-recognized line');

    const kept = context.buildBoundaryContext('aiannh', { NAME: untrusted.name }, null, LNG_LAT);
    assert.equal(kept.title, untrusted.name, 'an untrusted row keeps the Census name');
    assert.equal(kept.areaLabel, undefined);

    // The popup, given the same map, titles the same name and keeps the Census name as a row.
    const html = serializePopupFrame(buildAiannhPopupModel(props, CONDITIONS, names));
    const title = /data-popup-slot="title"[^>]*>([^<]*)</.exec(html)?.[1];
    assert.equal(title, selection.title.replace(/&/g, '&amp;'));
    assert.match(html, new RegExp(`Census area[\\s\\S]*${trusted.name}`));
    const untitled = serializePopupFrame(buildAiannhPopupModel(props, CONDITIONS));
    assert.equal(/data-popup-slot="title"[^>]*>([^<]*)</.exec(untitled)?.[1], trusted.name, 'without the map: the Census name');
  } finally {
    globalThis.fetch = original;
  }
});
