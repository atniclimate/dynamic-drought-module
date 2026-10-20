import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const script = readFileSync(new URL('../.github/actions/playwright-chromium/install-deps.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32'
  ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim(), '../../../bin/bash.exe')
  : 'bash';

for (const [name, browserExit, failures, status, attempts] of [
  ['cache or first-install success', 0, 0, 0, 1],
  ['browser failure stops before dependencies', 19, 0, 19, 0],
  ['dependency retry succeeds', 0, 2, 0, 3],
  ['exhausted dependency retries preserve the failure', 0, 3, 17, 3],
]) {
  test(`Chromium provisioning: ${name}`, () => {
    const mock = `
      calls=0
      npx() {
        if [ "$2" = install ]; then return "$BROWSER_EXIT"; fi
        calls=$((calls + 1))
        echo "DEPENDENCY:$calls"
        if [ "$calls" -le "$FAILURES" ]; then return 17; fi
      }
      sleep() { echo "SLEEP:$1"; }
    `;
    const run = spawnSync(bash, ['-c', mock + script], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, BROWSER_EXIT: String(browserExit), FAILURES: String(failures) },
    });
    assert.ifError(run.error);
    assert.equal(run.status, status, run.stderr);
    assert.equal((run.stdout.match(/^DEPENDENCY:/gm) ?? []).length, attempts);
    const sleeps = [...run.stdout.matchAll(/^SLEEP:(\d+)$/gm)].map((match) => Number(match[1]));
    assert.deepEqual(sleeps, [10, 20].slice(0, Math.max(0, attempts - 1)));
  });
}
