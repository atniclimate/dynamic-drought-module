/**
 * Cancellable fetch helpers.
 *
 * Direct ports of `fetchWithBudget` and `sleepUnlessAborted` from the
 * vanilla `app.js` v0.1.x baseline (lines ~1374 to 1413). These are the
 * primitives behind the architectural invariant in CLAUDE.md section 6
 * rule 5: every non-trivial network operation must respect a master
 * cancellation signal AND a per-call timeout, and late-arriving responses
 * to superseded operations are dropped rather than rendered.
 *
 * Browser support note. Modern browsers expose `AbortSignal.any()` for
 * composing multiple signals, but Safari 14 and older WebKit builds do
 * not. README declares Safari 14 as the floor, so the master signal is
 * composed manually with `addEventListener('abort', ...)` and a hand-
 * rolled timer rather than via `AbortSignal.any()`.
 */

/**
 * `fetch()` wrapper that respects an external "master" cancellation
 * signal AND a per-call timeout. The two are composed manually so this
 * works on Safari 14 plus where `AbortSignal.any()` is not available.
 *
 * Returns the Response. Throws an AbortError on either user-cancel
 * (master signal aborted) or timeout (per-call budget elapsed).
 *
 * @param url          Target URL passed straight to `fetch`.
 * @param opts         Standard `RequestInit`, or `null` for a default GET.
 * @param masterSignal The owning operation's abort signal, or `null` to
 *                     run with timeout-only cancellation.
 * @param timeoutMs    Per-call timeout in milliseconds. After this many
 *                     ms the inner controller aborts.
 */
export async function fetchWithBudget(
  url: string,
  opts: RequestInit | null,
  masterSignal: AbortSignal | null,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  if (masterSignal && masterSignal.aborted) {
    ctrl.abort();
    throw new DOMException('Aborted', 'AbortError');
  }
  const onMasterAbort = (): void => ctrl.abort();
  if (masterSignal) masterSignal.addEventListener('abort', onMasterAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(opts ?? {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (masterSignal) masterSignal.removeEventListener('abort', onMasterAbort);
  }
}

/**
 * Fetch and parse a JSON response while retaining the owning cancellation
 * signal and timeout through response-body consumption.
 *
 * This is intentionally separate from `fetchWithBudget`, whose contract ends
 * when response headers arrive. The response body is read through an explicit
 * reader so an abort can cancel a stalled stream before JSON parsing finishes.
 */
export async function fetchJsonWithBudget(
  url: string,
  opts: RequestInit | null,
  masterSignal: AbortSignal | null,
  timeoutMs: number
): Promise<unknown> {
  const ctrl = new AbortController();
  if (masterSignal && masterSignal.aborted) {
    ctrl.abort();
    throw new DOMException('Aborted', 'AbortError');
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const cancelBody = (): void => {
    void reader?.cancel().catch(() => undefined);
  };
  const onMasterAbort = (): void => ctrl.abort();
  if (masterSignal) masterSignal.addEventListener('abort', onMasterAbort);
  ctrl.signal.addEventListener('abort', cancelBody);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...(opts ?? {}), signal: ctrl.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) return response.json() as Promise<unknown>;

    reader = response.body.getReader();
    if (ctrl.signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }

    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener('abort', cancelBody);
    if (masterSignal) masterSignal.removeEventListener('abort', onMasterAbort);
    reader?.releaseLock();
  }
}

/**
 * Sleep for `ms` milliseconds, but resolve early if the signal aborts.
 * Resolves rather than rejects on abort so callers can re-check
 * `signal.aborted` and bail cleanly without a try/catch wrapper.
 *
 * @param ms     Sleep duration in milliseconds.
 * @param signal Abort signal that short-circuits the sleep, or `null`
 *               to run an uninterruptable timer.
 */
export function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | null
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }
  });
}
