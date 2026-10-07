import { fetchBufferedWithBudget } from '../util/fetch';
import { PngTileResponseError } from '../map/tile-protocol';

export interface DrynessMetadataLimits {
  readonly timeoutMs: number;
  readonly maxDecodedBytes: number;
  readonly maxTimes: number;
}

function xmlDocument(text: string): XMLDocument {
  // No DTD/entity expansion is needed for the admitted WMS documents.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported dryness XML declaration');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagNameNS('*', 'parsererror').length || !doc.documentElement) {
    throw new Error('Malformed dryness XML');
  }
  return doc;
}

/** Retain exact discrete issuer strings; never expand intervals or invent dates. */
export function parseRelativeGreennessTimes(text: string, maxTimes: number): readonly string[] {
  if (!Number.isSafeInteger(maxTimes) || maxTimes <= 0) throw new RangeError('Invalid TIME allowance');
  const values = text.split(',').map(value => value.trim());
  if (!values.length || values.length > maxTimes) throw new RangeError('TIME allowance exceeded');
  const seen = new Set<number>();
  const dated = values.map(value => {
    if (!/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)) throw new Error('Unsupported RG TIME');
    const date = Date.parse(value);
    if (!Number.isFinite(date) || new Date(date).toISOString() !== value || seen.has(date)) {
      throw new Error('Invalid or duplicate RG TIME');
    }
    seen.add(date);
    return { value, date };
  });
  return dated.sort((a, b) => b.date - a.date).map(row => row.value);
}

export function parseRelativeGreennessCapabilities(text: string, layerName: string, maxTimes: number): readonly string[] {
  const doc = xmlDocument(text);
  if (doc.documentElement.localName !== 'WMS_Capabilities' || doc.documentElement.namespaceURI !== 'http://www.opengis.net/wms' ||
      doc.documentElement.getAttribute('version') !== '1.3.0') {
    throw new Error('Unsupported RG capabilities');
  }
  const children = (element: Element, localName: string): Element[] =>
    Array.from(element.children).filter(child => child.localName === localName && child.namespaceURI === doc.documentElement.namespaceURI);
  const layers = Array.from(doc.getElementsByTagNameNS('*', 'Layer')).filter(layer => {
    const names = children(layer, 'Name');
    return layer.namespaceURI === doc.documentElement.namespaceURI && names.length === 1 && names[0]!.textContent?.trim() === layerName;
  });
  if (!layerName || layers.length !== 1) throw new Error('Missing or ambiguous RG layer');
  const dimensions = children(layers[0]!, 'Dimension').filter(row => row.getAttribute('name') === 'time');
  if (dimensions.length !== 1 || dimensions[0]!.getAttribute('units') !== 'ISO8601') {
    throw new Error('Missing or ambiguous RG TIME');
  }
  return parseRelativeGreennessTimes(dimensions[0]!.textContent ?? '', maxTimes);
}

/** Only a parsed HTTP-200 WMS ServiceException admits the single previous-TIME retry. */
export function isRelativeGreennessServiceException(error: unknown): boolean {
  if (!(error instanceof PngTileResponseError) || error.status !== 200 ||
      !['application/vnd.ogc.se_xml', 'application/xml', 'text/xml'].includes(error.contentType)) return false;
  try {
    const doc = xmlDocument(new TextDecoder('utf-8', { fatal: true }).decode(error.body));
    const root = doc.documentElement;
    const children = Array.from(root.children);
    return root.localName === 'ServiceExceptionReport' && (root.namespaceURI === null || root.namespaceURI === 'http://www.opengis.net/ogc') &&
      children.length > 0 && children.every(child => child.localName === 'ServiceException' && child.namespaceURI === root.namespaceURI && child.children.length === 0);
  } catch { return false; }
}

/** Whole metadata operation is owned, even if fetch ignores its AbortSignal. */
export async function readRelativeGreennessTimes(
  url: string, layerName: string, owner: AbortSignal, limits: DrynessMetadataLimits
): Promise<readonly string[]> {
  if (![limits.timeoutMs, limits.maxDecodedBytes, limits.maxTimes].every(n => Number.isSafeInteger(n) && n > 0) ||
      limits.timeoutMs > 15_000) throw new RangeError('Invalid dryness metadata limits');
  const controller = new AbortController();
  const abort = (): DOMException => new DOMException('Aborted', 'AbortError');
  const timeout = (): DOMException => new DOMException('Dryness metadata timed out', 'TimeoutError');
  const cancel = (): void => controller.abort(abort());
  const deadline = performance.now() + limits.timeoutMs;
  if (owner.aborted) throw abort();
  owner.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), limits.timeoutMs);
  let detach = (): void => {};
  try {
    const work = (async () => {
      let response: Response;
      try {
        response = await fetchBufferedWithBudget(url, null, controller.signal, limits.timeoutMs, limits.maxDecodedBytes);
      } catch (error) {
        if (owner.aborted) throw abort();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof DOMException && error.name === 'AbortError') throw timeout();
        throw error;
      }
      if (!response.ok) throw new Error('RG capabilities HTTP failure');
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!['text/xml', 'application/xml', 'application/vnd.ogc.wms_xml'].includes(mime ?? '')) throw new Error('RG capabilities MIME failure');
      const text = await response.text();
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw timeout();
      const times = parseRelativeGreennessCapabilities(text, layerName, limits.maxTimes);
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw timeout();
      return times;
    })();
    const stopped = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(owner.aborted ? abort() : controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      detach = () => controller.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) onAbort();
    });
    return await Promise.race([work, stopped]);
  } finally {
    detach(); clearTimeout(timer); owner.removeEventListener('abort', cancel); controller.abort();
  }
}
