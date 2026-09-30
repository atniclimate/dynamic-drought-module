/**
 * Self-test for scripts/check-bundle-size.mjs's third enforced line, the
 * HTML line (DR-158, found-085; RATIFICATION-6 Q7): the built
 * dist/index.html's own gzip size must stay at or under 9,720 B (the
 * ratified 9,000 B measurement plus 8 percent headroom, computed in raw
 * bytes, never a kB rounding of it).
 *
 * Runs under `node --test`. Builds a temporary fixture directory holding a
 * minimal dist/index.html and dist/assets/index-fixture.js, then spawns the
 * checker with that directory as its working directory (DIST inside the
 * script is a relative path, so it already resolves against process.cwd();
 * no change to the script was needed to run it from another cwd).
 *
 * Every fixture's padding is built with a deterministic pseudo-random byte
 * generator (a seeded xorshift32), never Math.random, so the exact-gzip-size
 * fixtures below are reproducible.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/check-bundle-size.mjs', import.meta.url));
const HTML_LINE_B = 9720; // ratified 9,000 B plus 8 percent, DR-158

// The fixture's dist/index.html is HEAD + padding + TAIL. HEAD carries the
// one asset reference the checker's regex needs (assets/index-fixture.js,
// an entry chunk name since it starts with "index-"); TAIL is three bytes
// so it can never gain a spurious LZ77 match from the padding that shrinks
// the compressed size back down.
const HEAD = '<!doctype html><script type="module" src="assets/index-fixture.js"></script><!--';
const TAIL = '-->';

function assembleHtml(padding) {
  return Buffer.concat([Buffer.from(HEAD, 'utf8'), padding, Buffer.from(TAIL, 'utf8')]);
}

function gzipLenAt(fullBytes, len) {
  return gzipSync(assembleHtml(fullBytes.subarray(0, len))).length;
}

/** Deterministic pseudo-random bytes (xorshift32, fixed seed), never Math.random. */
function deterministicBytes(length, seed) {
  let state = seed >>> 0 || 1;
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

// A pool large enough to reach past the 9,720 B line; grown once and
// reused (sliced) by every search below, so no test regenerates bytes.
const BYTE_POOL = deterministicBytes(20_000, 0x2f6e2b31);

/**
 * Finds a padding buffer whose assembled fixture gzips to exactly
 * `target` bytes. Binary-searches the pseudo-random pool for the
 * smallest length whose gzip size is at or over target (gzip size is
 * monotonic non-decreasing as more bytes are appended before a fixed,
 * tiny tail); if that length overshoots the exact target, tries every
 * one-byte value at the final position (the earlier bytes held fixed)
 * to land on it exactly.
 */
function paddingForExactGzip(target) {
  let lo = 0;
  let hi = BYTE_POOL.length;
  assert.ok(gzipLenAt(BYTE_POOL, hi) >= target, `byte pool too short to reach ${target} B gzip`);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (gzipLenAt(BYTE_POOL, mid) < target) lo = mid + 1;
    else hi = mid;
  }
  const size = gzipLenAt(BYTE_POOL, lo);
  if (size === target) return BYTE_POOL.subarray(0, lo);
  assert.ok(lo > 0, `no padding length reaches ${target} B gzip from below`);
  const prefix = BYTE_POOL.subarray(0, lo - 1);
  for (let value = 0; value < 256; value++) {
    const candidate = Buffer.concat([prefix, Buffer.from([value])]);
    if (gzipSync(assembleHtml(candidate)).length === target) return candidate;
  }
  throw new Error(
    `could not build a fixture gzipping to exactly ${target} B (nearest length ${lo} gives ${size} B)`
  );
}

async function makeFixture(padding) {
  const root = await mkdtemp(join(tmpdir(), 'ddm-bundle-size-'));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'dist', 'assets', 'index-fixture.js'), 'export const x = 1;\n');
  await writeFile(join(root, 'dist', 'index.html'), assembleHtml(padding));
  return root;
}

function runChecker(cwd) {
  return spawnSync(process.execPath, [SCRIPT_PATH], { cwd, encoding: 'utf8' });
}

test('a small dist/index.html passes and the checker prints the HTML line', async () => {
  const padding = deterministicBytes(50, 0x13572468);
  const gzipSize = gzipSync(assembleHtml(padding)).length;
  assert.ok(gzipSize < HTML_LINE_B, `fixture must gzip under the line, got ${gzipSize} B`);
  const root = await makeFixture(padding);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, `expected a clean exit, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /index\.html\s+\d+\s*B\s+gzip/, 'stdout must print the HTML line with a byte figure');
    assert.doesNotMatch(result.stdout, /FAIL/, 'a passing run must never print FAIL');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dist/index.html gzipping to exactly the ratified 9,720 B HTML line passes', async () => {
  const padding = paddingForExactGzip(HTML_LINE_B);
  const gzipSize = gzipSync(assembleHtml(padding)).length;
  assert.equal(gzipSize, HTML_LINE_B, 'the fixture itself must gzip to exactly 9,720 B before the checker runs');
  const root = await makeFixture(padding);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 0, `9,720 B is inclusive of the line and must pass, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /index\.html\s+9720\s*B\s+gzip/, 'stdout must print the exact measured HTML byte figure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a dist/index.html gzipping to 9,721 B, one byte over the line, fails and names the HTML line', async () => {
  const target = HTML_LINE_B + 1;
  const padding = paddingForExactGzip(target);
  const gzipSize = gzipSync(assembleHtml(padding)).length;
  assert.equal(gzipSize, target, 'the fixture itself must gzip to exactly 9,721 B before the checker runs');
  const root = await makeFixture(padding);
  try {
    const result = runChecker(root);
    assert.equal(result.status, 1, `9,721 B is one byte over the line and must fail, got ${result.status}`);
    const output = result.stdout + result.stderr;
    assert.match(output, /HTML line/, 'the failure must name the HTML line');
    assert.match(output, /9721/, 'the failure must report the measured 9,721 B figure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
