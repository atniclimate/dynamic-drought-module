/**
 * Retry a failed lazy `import()` under a new URL.
 *
 * Measured fact (director, Chromium 149.0.7827.55): a failed dynamic
 * `import()` is cached in the module map, so a second `import()` of the
 * SAME url rejects again with no new network request. A retry can only
 * succeed by importing a URL the module map has not already marked failed,
 * so every retry here appends a `retry=<n>` query parameter to force a new
 * cache key and a new fetch.
 *
 * A failure can also mean a deploy replaced the hashed chunks under an open
 * tab; then no retry can succeed, and `reloadIfDeployChanged` reloads the page
 * once (the URL holds the display state, so the person keeps their place).
 *
 * No import of a MapLibre, Preact, or app-state module.
 */

import { fetchBufferedWithBudget } from './fetch';

const IMPORT_SPECIFIER = /import\(\s*(['"`])([^'"`]*)\1/;

/**
 * Recover the specifier a built `() => import('./chunk')` importer holds,
 * by reading its own source text. After a Vite build the importer's source
 * still contains the literal chunk path (e.g. `` `./island-Cv_ZPl0o.js` ``),
 * whatever quote style the bundler chose.
 */
export function chunkPathFromImporter(importer: () => unknown): string | null {
  const source = Function.prototype.toString.call(importer);
  const match = IMPORT_SPECIFIER.exec(source);
  return match ? match[2] : null;
}

const URL_TOKEN = /https?:\/\/\S+/;

/**
 * Recover the chunk URL an engine names in a failed dynamic import's error
 * message: Chromium's "Failed to fetch dynamically imported module: <url>",
 * Firefox's "error loading dynamically imported module: <url>". Safari
 * names no URL, so this returns null for it. Any query string on the named
 * URL (for example a prior retry's own `?retry=1`) is stripped, since the
 * caller decides its own retry query fresh.
 */
export function failedChunkUrl(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : null;
  if (!message) return null;
  const match = URL_TOKEN.exec(message);
  if (!match) return null;
  const withoutQuery = match[0].split('?')[0];
  return withoutQuery.endsWith('.js') ? withoutQuery : null;
}

/** Set `retry=<attempt>` on a URL's query string, replacing any prior value. */
export function withRetryQuery(url: string, attempt: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('retry', String(attempt));
  return parsed.toString();
}

/** The sessionStorage key holding when this tab last reloaded for a new deploy. */
export const DEPLOY_RELOAD_KEY = 'ddm-deploy-reload';
/** A second deploy reload inside this window could be a loop, so it is refused. */
export const DEPLOY_RELOAD_WINDOW_MS = 10 * 60 * 1000;

const MODULE_SCRIPT_SRC = /<script\b(?=[^>]*\btype=["']?module\b)[^>]*\bsrc=["']?([^"'\s>]+)/i;

/** The first module script a page's HTML names, resolved against `base`, or null. */
export function entryScriptUrl(html: string, base: string): string | null {
  const src = MODULE_SCRIPT_SRC.exec(html)?.[1];
  if (src === undefined) return null;
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

/**
 * Reload at most once per window, stamped in `storage`. Absent storage, a
 * throwing one, or one that does not keep the stamp refuses: without a stamp
 * that survives the reload, nothing could stop a reload loop.
 */
export function reloadOnce(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now: number,
  reload: () => void
): boolean {
  try {
    if (storage === null) return false;
    const last = Number(storage.getItem(DEPLOY_RELOAD_KEY) ?? Number.NaN);
    if (now - last >= 0 && now - last < DEPLOY_RELOAD_WINDOW_MS) return false;
    storage.setItem(DEPLOY_RELOAD_KEY, String(now));
    if (storage.getItem(DEPLOY_RELOAD_KEY) !== String(now)) return false;
  } catch {
    return false;
  }
  reload();
  return true;
}

let deployCheck: Promise<boolean> | null = null;

/**
 * After a chunk import failed: when the page's own HTML now names a different
 * entry script than the one running, a deploy replaced this build's chunks,
 * so reload once. Same build, an offline read, or a failed read: no reload,
 * and the caller's own failure handling stands. One check runs at a time.
 */
export function reloadIfDeployChanged(): Promise<boolean> {
  if (typeof document === 'undefined' || typeof location === 'undefined') return Promise.resolve(false);
  deployCheck ??= checkDeploy().finally(() => {
    deployCheck = null;
  });
  return deployCheck;
}

async function checkDeploy(): Promise<boolean> {
  try {
    const running = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
    if (!running) return false;
    const page = await fetchBufferedWithBudget(location.pathname, { cache: 'no-store' }, null, 8000, 1024 * 1024);
    if (!page.ok) return false;
    const served = entryScriptUrl(await page.text(), location.href);
    if (served === null || served === running) return false;
    let storage: Storage | null = null;
    try {
      storage = sessionStorage;
    } catch {
      // Blocked storage: no stamp, so reloadOnce refuses.
    }
    return reloadOnce(storage, Date.now(), () => location.reload());
  } catch {
    return false;
  }
}

/**
 * Wrap a lazy `import()` so that after a rejection, later calls retry under
 * a new URL instead of replaying the same cached failure.
 *
 * The first call (and any call before a URL has been recorded) runs
 * `importer()` directly. After any rejection the chunk URL is recorded
 * once: first by reading it out of `importer`'s own source
 * (`chunkPathFromImporter`, resolved against `base`), else out of the
 * engine's own error message (`failedChunkUrl`). The attempt counter
 * advances on every rejection. Once a URL is recorded, every later call
 * imports `withRetryQuery(recordedUrl, attempt)` through `importUrl`
 * (by default a real `import()`). If no URL could ever be recorded, a
 * later call just runs `importer()` again. A success does not reset
 * anything: the loader keeps whatever memory it built.
 *
 * `beforeRetry`, when given, runs before every call that follows a
 * rejection, with the attempt number the retry will use, and the retry
 * waits for it; a rejection from it counts as a failed attempt. A door with
 * stylesheets passes src/util/chunk-stylesheets.ts `askAgainForStylesheets`
 * (owner direction 2026-11-09 (sprint), DR-pending): the retry imports the
 * module alone, so its failed stylesheets must be asked for here.
 */
export function createChunkLoader<T>(
  importer: () => Promise<T>,
  base: string,
  importUrl: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url),
  beforeRetry?: (attempt: number) => Promise<void>
): () => Promise<T> {
  let recordedUrl: string | null = null;
  let attempt = 0;
  let calls = 0;

  const onRejected = (err: unknown): never => {
    if (recordedUrl === null) {
      const specifier = chunkPathFromImporter(importer);
      recordedUrl = specifier ? new URL(specifier, base).toString() : failedChunkUrl(err);
    }
    attempt += 1;
    // A deploy under this open tab fails every retry too; that case reloads once.
    void reloadIfDeployChanged();
    throw err;
  };

  const load = (first: boolean): Promise<T> => {
    if (first || recordedUrl === null) {
      return importer().catch(onRejected);
    }
    return importUrl(withRetryQuery(recordedUrl, attempt)).then(
      (module) => module as T,
      onRejected
    );
  };

  return function loadChunk(): Promise<T> {
    calls += 1;
    const first = calls === 1;
    if (attempt === 0 || beforeRetry === undefined) return load(first);
    return beforeRetry(attempt).then(() => load(first), onRejected);
  };
}
