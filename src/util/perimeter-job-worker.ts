import { runPerimeterJob } from './perimeter-job';
import type { PerimeterJobRequest, PerimeterJobReply } from './perimeter-job-contract';
const scope = self as unknown as { onmessage: ((event: MessageEvent<PerimeterJobRequest>) => void) | null; postMessage(reply: PerimeterJobReply): void };
scope.onmessage = async event => {
  const request = event.data;
  if (request.operation !== 'group-perimeters') return;
  const base = { operation: 'group-perimeters' as const, generation: request.generation };
  try { scope.postMessage({ ...base, ok: true, result: await runPerimeterJob(request.sourceJson, request.limits) }); }
  catch { scope.postMessage({ ...base, ok: false, reason: 'job-failed' }); }
};
