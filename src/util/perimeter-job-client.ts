import { assertPerimeterJobLimits, type PerimeterJobLimits, type PerimeterJobRequest, type PerimeterJobResult } from './perimeter-job-contract';
export interface PerimeterJobWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: PerimeterJobRequest): void;
  terminate(): void;
}
export interface PerimeterJobOptions {
  readonly signal: AbortSignal;
  readonly generation: number;
  readonly deadlineMs: number;
  readonly limits: PerimeterJobLimits;
  readonly createWorker?: () => PerimeterJobWorker;
}
/** One owner/job/Worker. No geometry parsing, identity or measurement on UI thread. */
export async function groupPerimetersInWorker(sourceJson: string, options: PerimeterJobOptions): Promise<PerimeterJobResult> {
  const started = performance.now();
  const aborted = (): DOMException => new DOMException('Aborted', 'AbortError');
  if (options.signal.aborted) throw aborted();
  assertPerimeterJobLimits(options.limits);
  if (!Number.isSafeInteger(options.generation) || options.generation < 0 || !Number.isSafeInteger(options.deadlineMs) ||
    options.deadlineMs <= 0 || options.deadlineMs > 2147483647) throw new RangeError('Invalid perimeter job options.');
  if (typeof sourceJson !== 'string' || sourceJson.length > options.limits.maxInputChars) throw new RangeError('Perimeter input allowance exceeded.');
  const worker = options.createWorker ? options.createWorker() :
    new Worker(new URL('./perimeter-job-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = (): boolean => performance.now() - started >= options.deadlineMs;
    const finish = (result?: PerimeterJobResult, error?: unknown): void => {
      if (settled) return; settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener('abort', cancel);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Preserve settlement. */ }
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const cancel = (): void => finish(undefined, aborted());
    const timeout = (): void => finish(undefined, new DOMException('Perimeter job deadline exceeded.', 'TimeoutError'));
    const fail = (): void => finish(undefined, new Error('Perimeter job failed.'));
    options.signal.addEventListener('abort', cancel, { once: true });
    worker.onerror = event => { event.preventDefault(); fail(); };
    worker.onmessageerror = fail;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (options.signal.aborted) { cancel(); return; }
      if (expired()) { timeout(); return; }
      const reply = event.data as { operation?: unknown; generation?: unknown; ok?: unknown; result?: PerimeterJobResult } | null;
      if (!reply || reply.operation !== 'group-perimeters' || !Number.isSafeInteger(reply.generation)) { fail(); return; }
      if (reply.generation !== options.generation) return;
      if (reply.ok !== true || !reply.result || !Array.isArray(reply.result.graph?.versions) || !Array.isArray(reply.result.sources)) { fail(); return; }
      finish(reply.result);
    };
    if (options.signal.aborted) { cancel(); return; }
    if (expired()) { timeout(); return; }
    timer = setTimeout(timeout, Math.max(1, options.deadlineMs - (performance.now() - started)));
    try { worker.postMessage({ operation: 'group-perimeters', generation: options.generation, sourceJson, limits: options.limits }); }
    catch { fail(); }
  });
}
