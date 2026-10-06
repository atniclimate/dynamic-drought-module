/** A test-only clock seam for deterministic deadline and blocked-read proofs. */
export interface AnsweredReadClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: AnsweredReadClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

// Existing fire3d-mode.spec.ts read charge and polling cadence.
const UNANSWERED_READ_CHARGE_MS = 1_000;
const ANSWERED_POLL_INTERVAL_MS = 250;

/**
 * Keep the caller's budget on a responsive page. Only time waiting for a page
 * read is capped, following fire3d-mode.spec.ts's renderer-freeze model.
 * Node pauses are charged in full. A page that never answers remains bounded
 * by its test timeout; read errors propagate unchanged, without retries.
 */
export async function untilAnswered<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  budgetMs: number,
  what: string,
  clock: AnsweredReadClock = REAL_CLOCK
): Promise<T> {
  const startedAt = clock.now();
  let charged = 0;
  let longestRead = 0;
  let value: T | undefined;
  const expired = (): Error => new Error(
    `${what}: still ${JSON.stringify(value)} after ${charged} ms of answered reads ` +
      `(${clock.now() - startedAt} ms on the clock; longest read ${longestRead} ms)`
  );
  for (;;) {
    if (charged >= budgetMs) throw expired();
    const readStartedAt = clock.now();
    value = await read();
    const readMs = clock.now() - readStartedAt;
    longestRead = Math.max(longestRead, readMs);
    charged += Math.min(readMs, UNANSWERED_READ_CHARGE_MS);
    if (charged > budgetMs) throw expired();
    if (accept(value)) return value;
    if (charged >= budgetMs) throw expired();
    const pauseStartedAt = clock.now();
    await clock.sleep(Math.min(ANSWERED_POLL_INTERVAL_MS, budgetMs - charged));
    charged += clock.now() - pauseStartedAt;
  }
}
