/**
 * Shared reader for the Cloudflare Worker's `WORKER_REVISION` string
 * constant (DDM-P0-T05 slice 1).
 *
 * `scripts/check-upstream-drift.mjs` (the daily upstream-drift monitor's
 * expected revision) and `tests/worker-proxy-policy.spec.ts` (the policy
 * spec's expected `/healthz` revision) both import THIS module instead of
 * each carrying an independent hand-copied literal, so the two copies
 * cannot silently desync from each other or from
 * `workers/proxy/src/index.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** Absolute path to the Worker source file both readers extract from. */
export const WORKER_SOURCE_PATH = join(REPO_ROOT, 'workers', 'proxy', 'src', 'index.ts');

/** A repo-relative form of WORKER_SOURCE_PATH for error messages, so the
 * path in prose and the path actually read can never independently drift. */
const WORKER_SOURCE_DISPLAY = relative(REPO_ROOT, WORKER_SOURCE_PATH).replaceAll('\\', '/');

/**
 * Extracts the `WORKER_REVISION` string constant from Worker source text.
 * THROWS (does not warn, does not fall back) when the constant is missing or
 * matched more than once, so a renamed or removed constant fails loudly
 * instead of silently disarming a downstream tripwire. Takes source text
 * rather than a path so callers can probe it with fixture text.
 */
export function readWorkerRevision(sourceText) {
  const matches = [...sourceText.matchAll(/^\s*const\s+WORKER_REVISION\s*=\s*["']([^"']+)["']\s*;/gm)];
  if (matches.length === 0) {
    throw new Error(
      `WORKER_REVISION constant not found in ${WORKER_SOURCE_DISPLAY}; ` +
        'the Worker source has drifted and the expected revision cannot be ' +
        'derived. This tripwire is disarmed until the constant is restored.'
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `WORKER_REVISION matched ${matches.length} times in ` +
        `${WORKER_SOURCE_DISPLAY}; the pattern must resolve to exactly one ` +
        'value or the expected revision is ambiguous.'
    );
  }
  return matches[0][1];
}

/** Reads workers/proxy/src/index.ts from disk and extracts WORKER_REVISION
 * in one call: what both the drift monitor and the policy spec want. */
export function readCurrentWorkerRevision() {
  return readWorkerRevision(readFileSync(WORKER_SOURCE_PATH, 'utf8'));
}
