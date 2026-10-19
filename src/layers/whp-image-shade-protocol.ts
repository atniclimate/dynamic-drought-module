import { addProtocol, type AddProtocolAction } from 'maplibre-gl';
import { fetchBufferedWithBudget } from '../util/fetch';
import { clearWhpNoData, shadeImage } from './whp-shade-protocol';

let registered = false;

/** A live ImageServer tile, read whole within 15 s, decoded through the archive's white class mapping or, given `pixels`, that pixel function. */
const loadImageTile = (scheme: string, pixels?: (data: Uint8ClampedArray) => void): AddProtocolAction =>
  async (request, abortController) => {
    const signal = abortController.signal;
    const response = await fetchBufferedWithBudget(request.url.slice(`${scheme}://`.length), null, signal, 15_000);
    if (!response.ok) throw new Error(`WHP image HTTP ${response.status}`);
    return { data: await shadeImage(await response.blob(), signal, pixels) };
  };

/** Fuel risk's white shading (`whp-image-shade://`) and the issuer-colours row (`whp-image-classes://`), which clears only the issuer's opaque-black NoData. */
export function registerWhpImageShadeProtocol(): void {
  if (registered) return;
  addProtocol('whp-image-shade', loadImageTile('whp-image-shade'));
  addProtocol('whp-image-classes', loadImageTile('whp-image-classes', clearWhpNoData));
  registered = true;
}
