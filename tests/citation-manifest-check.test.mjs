import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

/**
 * scripts/check-citation-manifest.mjs cuts each ledger entry out with a
 * pattern that must end at the next "- id:" line or at the end of the text.
 * An entry that is last, or that holds a capital Z (a timestamp, "Zone"),
 * must still read as a match; a moved url must still fail.
 */

const SCRIPT = resolve('scripts', 'check-citation-manifest.mjs');
const MANIFEST = JSON.stringify({
  entries: [
    { id: 'first', url: 'https://a.example/one', title: 'One' },
    { id: 'last', url: 'https://a.example/last', title: 'Last' }
  ]
});

function run(ledgerFixture) {
  const dir = mkdtempSync(join(tmpdir(), 'ddm-citation-'));
  try {
    mkdirSync(join(dir, 'tests', 'fixtures'), { recursive: true });
    mkdirSync(join(dir, 'planning', 'references'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'fixtures', 'citation-manifest.json'), MANIFEST);
    copyFileSync(
      resolve('tests', 'fixtures', ledgerFixture),
      join(dir, 'planning', 'references', 'register.yaml')
    );
    return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a correct ledger passes with a last entry and a capital Z in an entry', () => {
  const r = run('citation-ledger-ok.yaml');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean \(2 entries/);
});

test('a moved url in the last entry still fails', () => {
  const r = run('citation-ledger-wrong.yaml');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"last" disagrees/);
});
