import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { TRIBAL_NATIONS_GROUP } from '../src/config/layer-groups.ts';

// Execute the spec's real helper and Place call site with controlled reads.
// This proves its baseline precondition, not browser effect timing or rendering.
const source = readFileSync(new URL('./studio-url-matrix.spec.ts', import.meta.url), 'utf8');
const helper = source.match(/^    const settledLayers = async[\s\S]*?^    };/m)?.[0];
assert.ok(helper, 'the local settledLayers helper remains present');
const requiredKeys = [...TRIBAL_NATIONS_GROUP.members];
const complete = [...requiredKeys, 'places'].sort();

function harness(frames) {
  let reads = 0;
  let current;
  const expect = {
    poll: (read, options) => {
      assert.equal(options.timeout, undefined, 'the helper keeps the existing default expect budget');
      return { toBe: async (wanted) => {
        for (let attempt = 0; attempt < frames.length; attempt++) {
          if (await read() === wanted) return;
        }
        throw new Error(options.message);
      } };
    }
  };
  const checkedKeys = async (selector) => {
    assert.equal(selector, 'fixture checked rows');
    current = frames[reads++];
    return current.checked;
  };
  const urlLayers = () => current.url;
  const settle = Function('expect', 'checkedKeys', 'urlLayers',
    `${stripTypeScriptTypes(helper)}; return settledLayers;`)(expect, checkedKeys, urlLayers);
  return { settle, reads: () => reads };
}

test('Place baseline waits past matching old state until its reference intents reach rows and URL', async () => {
  const h = harness([
    { checked: ['places'], url: ['places'] },
    { checked: complete, url: ['places'] },
    { checked: complete, url: complete }
  ]);
  assert.deepEqual(await h.settle('fixture checked rows', 'before Place', requiredKeys), complete);
  assert.equal(h.reads(), 3);
});

test('matching rows and URL without the reference intents cannot become a Place baseline', async () => {
  for (const checked of [['places'], ...requiredKeys.map((key) => complete.filter((value) => value !== key))]) {
    const h = harness([{ checked, url: checked }]);
    await assert.rejects(h.settle('fixture checked rows', 'before Place', requiredKeys), /before Place/);
  }
});

test('all reference rows without matching URL still cannot become a baseline', async () => {
  const h = harness([{ checked: complete, url: ['places'] }]);
  await assert.rejects(h.settle('fixture checked rows', 'before Place', requiredKeys), /before Place/);
});

test('Layers studio retains the existing equality-only baseline by default', async () => {
  const h = harness([{ checked: ['places'], url: ['places'] }]);
  assert.deepEqual(await h.settle('fixture checked rows', 'before Layers'), ['places']);
  assert.equal(h.reads(), 1);
});

// Since 046e945 the Place studio URL holds the set-aside display, so the Place
// case cannot wait for rows to equal the URL; it waits for the shipped group.
test('the actual Place baseline is captured only after the shipped reference group is checked', () => {
  const place = source.slice(source.indexOf('    const placeRailWrites = async'));
  const wait = place.indexOf('TRIBAL_NATIONS_GROUP.members.every((key) => rows.includes(key))');
  const capture = place.indexOf('const before = await checkedKeys(sidebarRows);');
  assert.ok(wait > 0, 'the Place case waits for the shipped reference group');
  assert.ok(capture > wait, 'the baseline is captured after that wait');
});

test('the shipped group used by the precondition matches the actual tribe rail reference keys', () => {
  const display = readFileSync(new URL('../src/state/display-snapshot.ts', import.meta.url), 'utf8');
  const table = display.match(/const REFERENCE_KEYS:[\s\S]*?\n};/)?.[0];
  assert.ok(table, 'the runtime reference table remains present');
  const references = Function(`${stripTypeScriptTypes(table)}; return REFERENCE_KEYS;`)();
  assert.deepEqual([...references.tribe].sort(), [...requiredKeys].sort());
  assert.ok(requiredKeys.length > 0);
});
