import { addProtocol } from 'maplibre-gl';
import { shadeImage } from './whp-shade-protocol';

let registered = false;

/** The live ImageServer uses the same white class mapping as the archive. */
export function registerWhpImageShadeProtocol(): void {
  if (registered) return;
  addProtocol('whp-image-shade', async (request, abortController) => {
    const signal = abortController.signal;
    const timer = setTimeout(() => abortController.abort(), 15_000);
    try {
      const response = await fetch(request.url.replace(/^whp-image-shade:\/\//, ''), { signal });
      if (!response.ok) throw new Error(`WHP image HTTP ${response.status}`);
      return { data: await shadeImage(await response.blob(), signal) };
    } finally {
      clearTimeout(timer);
    }
  });
  registered = true;
}
