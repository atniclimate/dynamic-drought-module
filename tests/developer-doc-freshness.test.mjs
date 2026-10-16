import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const doc = readFileSync(new URL('../DEVELOPER.md', import.meta.url), 'utf8');

// A hand-copied Worker revision or Cloudflare version id in DEVELOPER.md went
// two publishes stale once; the doc points at /healthz and WORKER_REVISION instead.
test('DEVELOPER.md names no hard-coded Worker revision or Cloudflare version id', () => {
  const revisions = doc.match(/\b\d{4}-\d{2}-\d{2}-[a-z0-9-]+-v\d+\b/g) ?? [];
  const versionIds = doc.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g) ?? [];
  assert.deepEqual(revisions, []);
  assert.deepEqual(versionIds, []);
});

// The verify-live budgets the doc quotes must match the workflow it describes.
test('DEVELOPER.md quotes the verify-live job ceiling the workflow sets', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/verify-live.yml', import.meta.url),
    'utf8',
  );
  const jobCeiling = workflow.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1];
  assert.ok(jobCeiling, 'verify-live.yml job timeout-minutes not found');
  const phrase = `\`verify-live.yml\` gives the job ${jobCeiling} minutes`;
  assert.ok(doc.includes(phrase), `DEVELOPER.md should say: ${phrase}`);
});
