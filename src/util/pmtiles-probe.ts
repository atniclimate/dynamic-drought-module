/**
 * Shared PMTiles archive-header probe (extracted from the hillshade module
 * for the 3D Fire context layers, which each bundle their own archive).
 *
 * Probe the archive HEADER before trusting it (the stage-5 adversarial
 * major 7: a 200 HTML fallback, a corrupt file, or a server that ignores
 * Range would otherwise pass and fail later as a silent style error).
 * Requires the response to be OK, reads only the leading bytes, and
 * validates the PMTiles v3 magic ("PMTiles", 0x50 4D 54 69 6C 65 73) plus
 * spec version 3 at byte 7. A 206 is the expected shape; a 200 is
 * tolerated (some dev servers ignore Range) because only the first bytes
 * are read from the stream before cancelling.
 */

import { fetchWithBudget } from './fetch';

/** Budget for the archive-header probe (same-origin, first bytes only). */
const PROBE_TIMEOUT_MS = 10_000;

export async function probeArchiveHeader(
  url: string,
  signal: AbortSignal
): Promise<void> {
  const response = await fetchWithBudget(
    url,
    { headers: { Range: 'bytes=0-127' } },
    signal,
    PROBE_TIMEOUT_MS
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unreadable response body');
  let bytes = new Uint8Array(0);
  while (bytes.length < 8) {
    const { done, value } = await reader.read();
    if (done) break;
    const merged = new Uint8Array(bytes.length + value.length);
    merged.set(bytes);
    merged.set(value, bytes.length);
    bytes = merged;
  }
  void reader.cancel().catch(() => undefined);
  const magic = String.fromCharCode(...bytes.slice(0, 7));
  if (magic !== 'PMTiles' || bytes[7] !== 3) {
    throw new Error('not a PMTiles v3 archive (magic mismatch)');
  }
}
