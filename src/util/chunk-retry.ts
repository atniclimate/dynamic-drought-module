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
 * Pure and DOM-free: no import of a MapLibre, Preact, or app-state module.
 */

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
 */
export function createChunkLoader<T>(
  importer: () => Promise<T>,
  base: string,
  importUrl: (url: string) => Promise<unknown> = (url) => import(/* @vite-ignore */ url)
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
    throw err;
  };

  return function loadChunk(): Promise<T> {
    calls += 1;
    if (calls === 1 || recordedUrl === null) {
      return importer().catch(onRejected);
    }
    return importUrl(withRetryQuery(recordedUrl, attempt)).then(
      (module) => module as T,
      onRejected
    );
  };
}
