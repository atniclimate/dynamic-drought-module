/**
 * Cancellable fetch helpers.
 *
 * Direct ports of `fetchWithBudget` and `sleepUnlessAborted` from the
 * vanilla `app.js` v0.1.x baseline (lines ~1374 to 1413). These are the
 * primitives behind the project's cancellation
 * invariant: every non-trivial network operation must respect a master
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
async function readBodyBytes(
  response: Response,
  signal: AbortSignal
): Promise<ArrayBuffer | null> {
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const cancelBody = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelBody);

  try {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }

    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (chunk.done) break;
      chunks.push(chunk.value);
      byteLength += chunk.value.byteLength;
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } finally {
    signal.removeEventListener('abort', cancelBody);
    reader.releaseLock();
  }
}

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

  const onMasterAbort = (): void => ctrl.abort();
  if (masterSignal) masterSignal.addEventListener('abort', onMasterAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...(opts ?? {}), signal: ctrl.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const bytes = await readBodyBytes(response, ctrl.signal);
    return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as unknown;
  } finally {
    clearTimeout(timer);
    if (masterSignal) masterSignal.removeEventListener('abort', onMasterAbort);
  }
}

/**
 * Fetch a response and retain cancellation ownership until its exact body bytes
 * have arrived. Use this when callers need status and headers before parsing;
 * unlike `fetchWithBudget`, the timeout cannot expire between headers and body.
 */
export async function fetchBufferedWithBudget(
  url: string,
  opts: RequestInit | null,
  masterSignal: AbortSignal | null,
  timeoutMs: number
): Promise<Response> {
  const ctrl = new AbortController();
  if (masterSignal?.aborted) {
    ctrl.abort();
    throw new DOMException('Aborted', 'AbortError');
  }
  const onMasterAbort = (): void => ctrl.abort();
  masterSignal?.addEventListener('abort', onMasterAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...(opts ?? {}), signal: ctrl.signal });
    const body = await readBodyBytes(response, ctrl.signal);
    if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } finally {
    clearTimeout(timer);
    masterSignal?.removeEventListener('abort', onMasterAbort);
  }
}

interface SharedJsonRequest {
  promise: Promise<unknown>;
  controller: AbortController | null;
  consumers: number;
}

const sharedJsonRequests = new Map<string, SharedJsonRequest>();

/**
 * How many shared transports are in flight right now (DR-052 follow-up, the
 * boot-idle seam). A fulfilled entry stays in `sharedJsonRequests` for the
 * page lifetime by design, so "the map is empty" can never mean "nothing is
 * pending" after the first success; this counter can. It rises when a
 * transport is created and falls when its promise settles either way,
 * including an abort from `invalidateSharedJsonRequest`, and never counts a
 * cached fulfilled entry.
 */
let pendingSharedTransports = 0;
const sharedTransportListeners = new Set<() => void>();

function settleSharedTransport(): void {
  pendingSharedTransports = Math.max(0, pendingSharedTransports - 1);
  for (const listener of sharedTransportListeners) listener();
}

/** The number of shared JSON transports still in flight. */
export function pendingSharedTransportCount(): number {
  return pendingSharedTransports;
}

/**
 * Subscribe to shared-transport settlements. Fires once per settlement (a
 * success, a failure, or an abort); read `pendingSharedTransportCount()`
 * inside the listener. Returns an unsubscribe function.
 */
export function onSharedTransportSettled(listener: () => void): () => void {
  sharedTransportListeners.add(listener);
  return () => {
    sharedTransportListeners.delete(listener);
  };
}

/**
 * Drop a shared artifact after a consumer rejects its payload shape. A
 * fulfilled transport is otherwise retained for the page lifetime, so schema
 * validation failures must explicitly make the next activation fetch again.
 */
export function invalidateSharedJsonRequest(key: string): void {
  const request = sharedJsonRequests.get(key);
  if (request === undefined) return;
  sharedJsonRequests.delete(key);
  request.controller?.abort();
}

/**
 * Share one page-lifetime JSON artifact across concurrent consumers. Each
 * caller can cancel its own wait; the transport is cancelled when its final
 * consumer leaves before completion. Failed requests are evicted for retry.
 */
export function fetchSharedJsonWithBudget(
  key: string,
  url: string,
  opts: RequestInit | null,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  let request = sharedJsonRequests.get(key);
  if (request === undefined) {
    const controller = new AbortController();
    const next: SharedJsonRequest = {
      promise: Promise.resolve(undefined),
      controller,
      consumers: 0,
    };
    pendingSharedTransports += 1;
    next.promise = fetchJsonWithBudget(
      url,
      opts,
      controller.signal,
      timeoutMs,
    ).then(
      (value) => {
        next.controller = null;
        settleSharedTransport();
        return value;
      },
      (error: unknown) => {
        if (sharedJsonRequests.get(key) === next) {
          sharedJsonRequests.delete(key);
        }
        next.controller = null;
        settleSharedTransport();
        throw error;
      },
    );
    sharedJsonRequests.set(key, next);
    request = next;
  }
  request.consumers++;

  return new Promise<unknown>((resolve, reject) => {
    let finished = false;
    const finish = (error: unknown, value?: unknown): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      request.consumers = Math.max(0, request.consumers - 1);
      if (request.consumers === 0 && request.controller !== null) {
        if (sharedJsonRequests.get(key) === request) {
          sharedJsonRequests.delete(key);
        }
        request.controller.abort();
      }
      if (error === null) resolve(value);
      else reject(error);
    };
    const onAbort = (): void =>
      finish(new DOMException('Aborted', 'AbortError'));

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else void request.promise.then((value) => finish(null, value), finish);
  });
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
