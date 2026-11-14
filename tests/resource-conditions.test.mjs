import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Pathways Stage A: the federal program rows carry the hazard modes they answer
 * (`conditions`) and the kind of help they are (`kind`); the briefing lists the
 * rows that answer the active mode first, says the kind beside the agency, and
 * prints the oldest `verified` date once. No row is hidden or reworded.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      !/\.[a-z]+$/i.test(specifier) &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts') &&
      existsSync(fileURLToPath(new URL(`${specifier}.ts`, context.parentURL)))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  }
});

const { HAZARD_CLUSTERS } = await import('../src/config/clusters.ts');
const {
  RESOURCE_KINDS,
  RESOURCE_KIND_LABEL,
  orderFederalByCondition,
  resourceAgencyLine,
  resourcesCheckedLine
} = await import('../src/impact/resources.ts');

const MODES = Object.keys(HAZARD_CLUSTERS);
const federal = JSON.parse(readFileSync(new URL('../public/data/resources/federal.json', import.meta.url), 'utf8'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('every federal row is tagged from the mode table and the kind list', () => {
  assert.ok(federal.resources.length > 0);
  for (const row of federal.resources) {
    assert.ok(Array.isArray(row.conditions) && row.conditions.length > 0, `${row.label}: conditions`);
    if (row.conditions.includes('any')) {
      assert.deepEqual(row.conditions, ['any'], `${row.label}: any stands alone`);
    } else {
      for (const c of row.conditions) assert.ok(MODES.includes(c), `${row.label}: ${c} is not a mode`);
    }
    assert.ok(RESOURCE_KINDS.includes(row.kind), `${row.label}: kind ${row.kind}`);
    assert.ok(RESOURCE_KIND_LABEL[row.kind], `${row.label}: kind label`);
  }
});

const row = (label, conditions, extra = {}) => ({ label, agency: 'A', tier: 'federal', url: `https://x.test/${label}`, conditions, ...extra });

test('the partition is stable for every mode, and a no-op for none or an unknown mode', () => {
  const rows = [
    row('a', ['any']),
    row('b', MODES.slice(0, 1)),
    row('c', MODES.slice(-1)),
    row('d', MODES),
    row('e', ['any'])
  ];
  for (const mode of MODES) {
    const out = orderFederalByCondition(rows, mode);
    assert.equal(out.length, rows.length);
    const hit = (r) => r.conditions.includes(mode);
    assert.deepEqual(out.map((r) => r.label), [...rows.filter(hit), ...rows.filter((r) => !hit(r))].map((r) => r.label), mode);
  }
  const labels = rows.map((r) => r.label);
  assert.deepEqual(orderFederalByCondition(rows, null).map((r) => r.label), labels);
  assert.deepEqual(orderFederalByCondition(rows, 'no-such-mode').map((r) => r.label), labels);
});

test('rows without conditions (the in-code anchors, other tiers) keep their places', () => {
  const anchor = { label: 'anchor', agency: 'A', tier: 'federal' };
  const state = { label: 'state', agency: 'A', tier: 'state', conditions: [MODES[0]] };
  const rows = [row('p', ['any']), anchor, row('q', [MODES[0]]), state];
  const out = orderFederalByCondition(rows, MODES[0]).map((r) => r.label);
  assert.deepEqual(out, ['q', 'anchor', 'p', 'state']);
});

test('the kind reads as quiet text joined to the agency line; no kind renders as today', () => {
  assert.equal(resourceAgencyLine({ agency: 'Bureau of Reclamation', kind: 'technical-assistance' }), 'Technical assistance · Bureau of Reclamation');
  assert.equal(RESOURCE_KIND_LABEL.grant, 'Grant');
  assert.equal(RESOURCE_KIND_LABEL.loan, 'Loan');
  assert.equal(RESOURCE_KIND_LABEL['disaster-program'], 'Disaster program');
  assert.equal(RESOURCE_KIND_LABEL.information, 'Information');
  assert.equal(resourceAgencyLine({ agency: 'Bureau of Reclamation' }), 'Bureau of Reclamation');
  assert.equal(resourceAgencyLine({ agency: 'X', kind: 'nonsense' }), 'X');
});

test('the checked date is the oldest verified date, in words, once; nothing without a date', () => {
  assert.equal(
    resourcesCheckedLine([{ verified: '2026-07-09' }, { verified: '2026-03-02' }, {}]),
    'Program pages checked March 2, 2026.'
  );
  assert.equal(resourcesCheckedLine([{ verified: '2026-12-31' }]), 'Program pages checked December 31, 2026.');
  assert.equal(resourcesCheckedLine([{}, { label: 'x' }]), null);
  assert.equal(resourcesCheckedLine([]), null);
});

test('the briefing uses the helpers and prints the date as the last line of the section', () => {
  const src = read('../src/ui/impact-panel-runtime.ts');
  assert.match(src, /resourceAgencyLine\(resource\)/);
  assert.match(src, /orderFederalByCondition\(/);
  const section = src.slice(src.indexOf('function renderResources'));
  assert.match(section, /resourcesCheckedLine\(resources\)/);
  assert.ok(section.indexOf('${groups}') < section.indexOf('${checked ?'));
  assert.ok(section.indexOf('${checked ?') < section.indexOf('</section>'));
});
