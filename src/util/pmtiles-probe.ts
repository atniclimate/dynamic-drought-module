/**
 * Shared PMTiles archive-header probe (extracted from the hillshade module
 * for the 3D Fire context layers, which each bundle their own archive).
 *
 * Probe the archive HEADER before trusting it (the stage-5 adversarial
 * major 7: a 200 HTML fallback, a corrupt file, or a server that ignores
 * Range would otherwise pass and fail later as a silent style error).
 *
 * What it proves, since 2026-09-10 (DR-083 step 2, Codex finding S1): the
 * probe used to request 128 bytes and accept after eight, so any object
 * that began with the seven-byte magic and a version byte passed, including
 * a truncated upload. A truncated archive then passed the probe, was
 * installed as a source, and failed on its first real tile read, which in
 * the 3D scene tears the scene down instead of falling back to the bundled
 * copy that was never tried. Now the probe reads the whole 127-byte v3
 * header, parses it, and checks the archive's own declared extent (tile
 * data offset plus tile data length, the last section of a v3 archive)
 * against the size the server declares in Content-Range. An object shorter
 * than its header claims is rejected here, where every caller already has
 * a fallback, rather than discovered later where none does.
 *
 * The parsed header is returned so a caller can disclose what actually
 * resolved (the 3D coverage sentence names the depth of the archive that
 * answered, DR-083 step 1). It is never fed back into a MapLibre source as a
 * declared zoom: a declared option wins over the archive header permanently
 * (src/map/fire3d.ts, the raster-dem source), so the header stays the
 * archive's own statement and the source keeps reading it directly.
 *
 * The budget covers the body. `fetchWithBudget` ends at headers (Codex
 * finding S2); a server that answered 206 and then stalled would have held
 * this probe open for as long as the stream stayed silent. The timer here
 * spans the whole read, and an abort of the owning signal cancels the
 * stream.
 *
 * A 206 is the expected shape; a 200 is tolerated (some dev servers ignore
 * Range) because only the leading bytes are read from the stream before
 * cancelling, and its Content-Length stands in for the Content-Range total
 * when present.
 */

import { linkAbort } from './fetch';

/** Budget for the archive-header probe (same-origin, first bytes only). */
const PROBE_TIMEOUT_MS = 10_000;

/** A PMTiles v3 header is exactly 127 bytes (spec section "Header"). */
export const PMTILES_HEADER_BYTES = 127;

/**
 * The header fields the application reads. Offsets per the PMTiles v3
 * specification, all little-endian: tile data offset at 56 and length at 64
 * (uint64), min and max zoom at 100 and 101 (uint8). The bounding box
 * (bytes 102 to 117) and the tile type (byte 99) are deliberately not
 * parsed: no caller reads them, and this chunk sits inside two
 * first-activation budgets (scripts/check-activation-budget.mjs), so every
 * field here is one somebody uses.
 */
export interface PmtilesHeader {
  readonly tileDataOffset: number;
  readonly tileDataLength: number;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** Parse a v3 header from its leading bytes; throws on any malformation. */
export function parsePmtilesHeader(bytes: Uint8Array): PmtilesHeader {
  // Magic first whenever there is enough to read it: an HTML page served in
  // place of the archive is "not an archive", which says more than "short".
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (bytes.length >= 8 && (magic !== 'PMTiles' || bytes[7] !== 3)) {
    throw new Error('not a PMTiles v3 archive (magic mismatch)');
  }
  if (bytes.length < PMTILES_HEADER_BYTES) {
    throw new Error(
      `short PMTiles header (${bytes.length} of ${PMTILES_HEADER_BYTES} bytes)`
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    tileDataOffset: Number(view.getBigUint64(56, true)),
    tileDataLength: Number(view.getBigUint64(64, true)),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101)
  };
  if (header.maxZoom < header.minZoom || header.tileDataLength === 0) {
    throw new Error('PMTiles header declares impossible zooms or no tile data');
  }
  return header;
}

/**
 * The object size the response declares, or null when it declares none.
 * A 206 must carry a Content-Range that starts at byte 0 (RFC 9110 section
 * 14.4); its total is the object size. A 200 that ignored the Range header
 * declares the size in Content-Length, when it sends one at all.
 */
function declaredObjectSize(response: Response): number | null {
  if (response.status === 206) {
    const match = /^bytes 0-\d+\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
    if (!match) throw new Error('a 206 without a usable Content-Range from byte 0');
    return Number(match[1]);
  }
  const contentLength = response.headers.get('Content-Length');
  if (contentLength === null) return null;
  const size = Number(contentLength);
  return Number.isFinite(size) ? size : null;
}

/**
 * Read the stream until `wanted` bytes have arrived or it ends, then cancel
 * it. The abort listener is not redundant with the fetch's own signal: a
 * body handed over as a ready Response (a test stub, a service worker) is
 * not tied to that signal, and only an explicit cancel frees a pending
 * read of it.
 */
async function readLeadingBytes(
  response: Response,
  wanted: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('unreadable response body');
  const cancelBody = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelBody, { once: true });
  let bytes = new Uint8Array(0);
  try {
    while (bytes.length < wanted) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (done) break;
      const merged = new Uint8Array(bytes.length + value.length);
      merged.set(bytes);
      merged.set(value, bytes.length);
      bytes = merged;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancelBody);
    cancelBody();
  }
}

/**
 * Prove an archive is a whole PMTiles v3 object before any source reads it.
 * Resolves with the parsed header; rejects with the reason, or with an
 * AbortError when `signal` aborts or the budget runs out.
 */
export async function probeArchiveHeader(
  url: string,
  signal: AbortSignal,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<PmtilesHeader> {
  const ctrl = new AbortController();
  const unlink = linkAbort(ctrl, signal);
  if (ctrl.signal.aborted) {
    unlink();
    throw new DOMException('Aborted', 'AbortError');
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${PMTILES_HEADER_BYTES - 1}` },
      signal: ctrl.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const declaredSize = declaredObjectSize(response);
    const bytes = await readLeadingBytes(response, PMTILES_HEADER_BYTES, ctrl.signal);
    const header = parsePmtilesHeader(bytes);
    const extent = header.tileDataOffset + header.tileDataLength;
    if (declaredSize !== null && declaredSize !== extent) {
      throw new Error(
        `the archive declares ${extent} bytes but the server holds ${declaredSize}: a truncated or foreign object`
      );
    }
    return header;
  } finally {
    clearTimeout(timer);
    unlink();
  }
}
