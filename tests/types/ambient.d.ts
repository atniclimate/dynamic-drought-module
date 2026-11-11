/**
 * DDM-P15-T07: ambient module declarations for the one test-only dependency
 * that ships no types of its own. Typed honestly to the handful of members
 * the suite actually uses (tests/m-breadth-heatrisk-days.spec.ts,
 * tests/satellite-fixture.ts): constructing a PNG, writing one to a Buffer,
 * reading one back, and its `width`/`height`/`data` fields. Nothing wider.
 */
declare module 'pngjs' {
  export class PNG {
    constructor(options?: { readonly width?: number; readonly height?: number });
    width: number;
    height: number;
    data: Buffer;
    static readonly sync: {
      write(png: PNG): Buffer;
      read(buffer: Buffer): PNG;
    };
  }
}

/**
 * The three Cloudflare Workers globals `workers/proxy/src/index.ts` uses,
 * declared here (not imported from `@cloudflare/workers-types`, which
 * `tests/worker-proxy-policy.spec.ts` pulls that file into transitively) so
 * that this project's own `lib: ["...", "DOM", "DOM.Iterable"]` never has to
 * mix with the Workers runtime's ambient types: `@cloudflare/workers-types`
 * declares its own `CacheStorage` as an abstract `class`, which does not
 * merge with DOM lib's `CacheStorage` `interface`, and importing the whole
 * package left `caches.default` still unresolved while the worker's own
 * isolated tsconfig (workers/proxy/tsconfig.json, `lib: ["ES2022"]`, no DOM)
 * has no such collision. Typed to exactly what the worker module reads:
 * `Env.RATE_LIMITER?.limit({ key })`, `ExecutionContext.waitUntil`, and
 * `caches.default`. Do not edit the worker to work around this; it is not
 * owned here (DDM-P15-T07 brief).
 */
interface RateLimit {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface CacheStorage {
  readonly default: Cache;
}
