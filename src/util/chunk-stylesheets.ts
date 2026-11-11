/**
 * A lazy door's stylesheets, after a failed load (owner direction 2026-11-09
 * (sprint), DR-pending).
 *
 * Measured on the sprint camera (Chrome for Testing 153, production build):
 * the bundler's preload attaches a lazy chunk's stylesheets as
 * `<link rel="stylesheet">` before it imports the chunk, remembers every
 * address it has attached, and never attaches one again. When a stylesheet
 * fails, the import rejects; the retry under a new URL (src/util/chunk-retry.ts)
 * then imported the module alone, and the door drew with no styles: the
 * Locate card off the top of the screen, the 3D card in the page's flow under
 * the sheet, the ENSO guide's buttons in the browser's grey.
 *
 * So a door with stylesheets asks for them again before it retries
 * (`askAgainForStylesheets`, passed to `createChunkLoader`), and its chunk
 * refuses to draw without them (`requireStylesheetMark`, the studios' check:
 * src/ui/island/place-studio.tsx `requireStudioStyles`), which lands in the
 * door's own failure line instead of an unstyled surface.
 */

import { withRetryQuery } from './chunk-retry';

/**
 * A stylesheet link that failed. Measured in Chromium: a failed stylesheet
 * keeps a sheet whose rules cannot be read, which for a sheet from this
 * origin happens only on failure. A sheet from another origin hides its
 * rules even when it loaded, so it is never counted as failed here.
 */
function failed(link: HTMLLinkElement): boolean {
  const sheet = link.sheet;
  if (sheet === null) return true;
  try {
    return sheet.cssRules.length === 0;
  } catch {
    return typeof location !== 'undefined' && new URL(link.href, location.href).origin === location.origin;
  }
}

function askAgain(link: HTMLLinkElement, attempt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (): void => {
      link.removeEventListener('load', onLoad);
      link.removeEventListener('error', onError);
    };
    const onLoad = (): void => {
      settle();
      resolve();
    };
    const onError = (): void => {
      settle();
      reject(new Error(`[chunk-stylesheets] ${link.href} did not load.`));
    };
    link.addEventListener('load', onLoad);
    link.addEventListener('error', onError);
    // The same element keeps its place in the cascade; the new address is a
    // new request (the failed one is not asked for again by the browser).
    link.href = withRetryQuery(link.href, attempt);
  });
}

/**
 * Point every failed stylesheet link at a fresh address (`retry=<attempt>`)
 * and wait until each has loaded. Rejects if any fails again. Without a
 * document, or with nothing failed, it resolves at once.
 */
export function askAgainForStylesheets(attempt: number): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const links = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
  ).filter(failed);
  return Promise.all(links.map((link) => askAgain(link, attempt))).then(() => undefined);
}

/**
 * NO STYLESHEET, NO CHROME. A lazy chunk's stylesheet marks `element` with
 * `property: 1`; throw unless that mark is there, before anything is drawn.
 */
export function requireStylesheetMark(element: Element, property: string, who: string): void {
  if (getComputedStyle(element).getPropertyValue(property).trim() === '1') return;
  throw new Error(`[${who}] its stylesheet is not loaded.`);
}
