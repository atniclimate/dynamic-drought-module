/** Build-time terrain writer. The existing in-memory writer stays unchanged. */
import { open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { packDirectories } from './pmtiles-writer.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
async function writeAll(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (!bytesWritten) throw Error('Terrain archive write made no progress');
    offset += bytesWritten;
  }
}
async function readAll(file, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(bytes, offset, length - offset, position + offset);
    if (!bytesRead) throw Error('Truncated terrain tile store');
    offset += bytesRead;
  }
  return bytes;
}

/**
 * tiles is a sorted (async) iterable of {tileId,path,sha256} from a persistent
 * resumable tile store. Each expected id must appear once. Payload memory is
 * bounded by maxTileBytes and copyBufferBytes, not total archive size. Directory
 * and identity metadata remain O(tile count). All allowances are caller supplied.
 * Output and scratch use exclusive creation and never replace an existing file.
 */
export async function writeTerrainPmtiles({ outputPath, tiles, plannedTileIds,
  minZoom, maxZoom, bounds, center, metadata, maxTiles, maxTileBytes, copyBufferBytes,
  signal }) {
  if (![maxTiles, maxTileBytes, copyBufferBytes].every(n => integer(n) && n > 0)) throw RangeError('Invalid writer allowances');
  if (!Array.isArray(plannedTileIds) || !plannedTileIds.length || plannedTileIds.length > maxTiles ||
      plannedTileIds.some((id, i) => !integer(id) || (i > 0 && id <= plannedTileIds[i - 1]))) throw Error('Invalid planned tile ids');
  if (!integer(minZoom) || !integer(maxZoom) || minZoom > maxZoom || maxZoom > 26 ||
      !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85.05112878 || bounds[3] > 85.05112878 ||
      bounds[0] >= bounds[2] || bounds[1] >= bounds[3] ||
      !Array.isArray(center) || center.length !== 3 || !center.every(Number.isFinite) ||
      center[0] < bounds[0] || center[0] > bounds[2] || center[1] < bounds[1] || center[1] > bounds[3] ||
      !integer(center[2]) || center[2] < minZoom || center[2] > maxZoom) throw Error('Invalid terrain archive extent');
  if (metadata?.encoding !== 'terrarium' || metadata?.tile_size !== 512 ||
      typeof metadata.attribution !== 'string' || !metadata.attribution.trim() ||
      typeof metadata.retrieved !== 'string' || !metadata.retrieved.trim() ||
      typeof metadata.modifications !== 'string' || !metadata.modifications.trim() ||
      !Array.isArray(metadata.missing_cells) || !metadata.missing_cells.every(x => typeof x === 'string')) throw Error('Incomplete terrain provenance');
  const lowId = (4 ** minZoom - 1) / 3, highId = (4 ** (maxZoom + 1) - 1) / 3;
  if (plannedTileIds[0] < lowId || plannedTileIds.at(-1) >= highId) throw Error('Planned id outside declared zooms');
  const checkAbort = () => signal?.throwIfAborted();
  checkAbort();
  const scratchPath = outputPath + '.tile-data.tmp';
  const scratch = await open(scratchPath, 'wx+');
  let output, outputOwned = false, complete = false, failed = false;
  try {
    const entries = [], hashes = new Map();
    let tileBytes = 0, uniqueCount = 0;
    for await (const tile of tiles) {
      checkAbort();
      if (entries.length >= plannedTileIds.length || tile.tileId !== plannedTileIds[entries.length]) throw Error('Tile store does not match planned ids');
      if (typeof tile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(tile.sha256)) throw Error('Tile requires a SHA256 receipt');
      const file = await open(tile.path, 'r');
      let bytes;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || !integer(stat.size) || stat.size < 1 || stat.size > maxTileBytes) throw Error('Tile byte allowance exceeded');
        bytes = await readAll(file, stat.size, 0);
        if ((await file.stat()).size !== stat.size) throw Error('Tile changed during read');
      } finally { await file.close(); }
      checkAbort();
      if (digest(bytes) !== tile.sha256) throw Error('Tile receipt mismatch');
      let offset;
      // Hash identifies candidates only. Byte comparison prevents hash-only equality.
      for (const old of hashes.get(tile.sha256) ?? []) {
        if (old.length === bytes.length && (await readAll(scratch, old.length, old.offset)).equals(bytes)) { offset = old.offset; break; }
      }
      if (offset === undefined) {
        offset = tileBytes;
        if (!Number.isSafeInteger(tileBytes + bytes.length)) throw Error('Archive offset exceeds safe integer');
        await writeAll(scratch, bytes, tileBytes); tileBytes += bytes.length; uniqueCount++;
        const list = hashes.get(tile.sha256) ?? [];
        list.push({offset, length: bytes.length}); hashes.set(tile.sha256, list);
      }
      entries.push({tileId: tile.tileId, offset, length: bytes.length, runLength: 1});
    }
    if (entries.length !== plannedTileIds.length) throw Error('Missing planned tile');
    checkAbort();
    const {rootGz, leavesGz, leafCount, leafSize} = packDirectories(entries);
    const metadataGz = gzipSync(Buffer.from(JSON.stringify(metadata)));
    const metadataOffset = 127 + rootGz.length, leafOffset = metadataOffset + metadataGz.length;
    const dataOffset = leafOffset + leavesGz.length;
    if (!Number.isSafeInteger(dataOffset + tileBytes)) throw Error('Archive length exceeds safe integer');
    const header = Buffer.alloc(127); header.write('PMTiles', 0, 'ascii'); header[7] = 3;
    for (const [at,value] of [[8,127],[16,rootGz.length],[24,metadataOffset],[32,metadataGz.length],
      [40,leafOffset],[48,leavesGz.length],[56,dataOffset],[64,tileBytes],[72,entries.length],
      [80,entries.length],[88,uniqueCount]]) header.writeBigUInt64LE(BigInt(value),at);
    header[96] = 1; header[97] = 2; header[98] = 1; header[99] = 2;
    header[100] = minZoom; header[101] = maxZoom;
    bounds.forEach((value,i) => header.writeInt32LE(Math.round(value * 1e7),102 + i * 4));
    header[118] = center[2]; header.writeInt32LE(Math.round(center[0] * 1e7),119); header.writeInt32LE(Math.round(center[1] * 1e7),123);
    output = await open(outputPath, 'wx'); outputOwned = true;
    let position = 0;
    for (const bytes of [header,rootGz,metadataGz,leavesGz]) { await writeAll(output,bytes,position); position += bytes.length; }
    while (position - dataOffset < tileBytes) {
      checkAbort();
      const at = position - dataOffset;
      const bytes = await readAll(scratch,Math.min(copyBufferBytes,tileBytes-at),at);
      await writeAll(output,bytes,position); position += bytes.length;
    }
    checkAbort(); await output.sync(); checkAbort(); complete = true;
    return {bytes:position,addressedTiles:entries.length,tileContents:uniqueCount,leafCount,leafSize,
      tileDataOffset:dataOffset,tileDataLength:tileBytes,headerHex:header.toString('hex')};
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const cleanupErrors = [];
    const attempt = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    if (output) await attempt(() => output.close());
    await attempt(() => scratch.close());
    await attempt(() => unlink(scratchPath));
    if (outputOwned && !complete) await attempt(() => unlink(outputPath));
    if (!failed && cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Terrain archive cleanup failed');
  }
}
