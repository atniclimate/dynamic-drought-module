import { createChunkLoader } from '../util/chunk-retry';

const loadChunk = createChunkLoader(() => import('./fire3d'), import.meta.url);
let pending: ReturnType<typeof loadChunk> | null = null;

// Boot and the control must share one module instance, including after a retry.
export function loadFire3DController(): ReturnType<typeof loadChunk> {
  pending ??= loadChunk().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
