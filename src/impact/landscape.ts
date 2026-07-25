/**
 * Landscape-signature artifact loader (T-M0-3; the L1c runtime stub).
 *
 * Reads the build-time landscape-signature snapshot
 * (public/data/landscape-signature-pnw.json, built by scripts/landscape
 * and validated at build time against
 * schema/landscape-signature.schema.json) and returns it behind an
 * honest-absence result: the artifact is NOT committed yet, so the
 * shipped behavior of this module is `{ ok: false, reason: 'unavailable' }`
 * (the empty-placeholder pattern; absence is a state, never an error).
 *
 * NO CALLER imports this module yet, by contract: the first consumers are
 * the T-S1 signature adapters and the M-DEMO briefing surface. The T-P0-7
 * activation gate (scripts/check-activation-budget.mjs) bans it from the
 * eager import graph, so it can only ever arrive lazily.
 *
 * Validation boundary (say what the mechanism does, no more): this module
 * performs STRUCTURAL SPOT-CHECKS of the top level only (schemaVersion in
 * the supported range, retrieved a string, sources/bundles plain
 * non-array records). It does NOT validate per-source or per-bundle
 * shapes; consumers narrow individual blocks with the exported type
 * guards, and full validation is the build-time gate on Another JSON
 * Validator (Ajv; JSON = JavaScript Object Notation). The snapshot type
 * tells the same truth: sources and bundles are exposed as `unknown`
 * records, not deeply trusted shapes.
 *
 * Version policy (NAMED: known-minor, not major-tolerant): exactly the
 * 1.2.x line is accepted (SUPPORTED_SCHEMA_VERSIONS). The 1.0->1.1 bump
 * was itself a semantic correction, and no additive-minor evolution rule
 * is ratified, so accepting unreviewed future minors would overclaim; the
 * range is extended deliberately when a reviewed schema lands (T-S1-4).
 *
 * Caching: NONE at module level, deliberately. The artifact is static,
 * but a memoizing stub would freeze an early absence (or an aborted read)
 * for the whole session invisibly; caching policy belongs to the first
 * consumer unit, which knows its refresh semantics.
 */

import { fetchJsonWithBudget } from '../util/fetch';
import { isObject } from '../util/guards';

/** A plain (non-array) record: `isObject` alone admits arrays, which
 * would make the exported `Record<string, unknown>` types lie. */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return isObject(v) && !Array.isArray(v);
}

/** Exactly the reviewed 1.2.x schema line; see the version-policy note. */
const SUPPORTED_SCHEMA_VERSIONS = /^1\.2\.\d+$/;

const TIMEOUT_MS = 6000;

/** Machine-readable failure discriminant. `aborted` is the master-signal
 * cancel (a consumer drops it silently; never a user-facing state). A
 * TIMEOUT maps to `unavailable` deliberately: to the user it is an
 * availability statement about the artifact, not a cancellation. */
export type LandscapeLoadFailureReason =
  | 'aborted'
  | 'unavailable'
  | 'malformed-json'
  | 'invalid-shape'
  | 'unsupported-version';

export interface LandscapeSignatureSnapshot {
  readonly schemaVersion: string;
  readonly retrieved: string;
  readonly analysisCrs: string;
  readonly gridResolutionMeters: number;
  readonly aggregationUnit: string;
  /** Per-family source blocks; narrow with isTerrainSource. */
  readonly sources: Readonly<Record<string, unknown>>;
  /** Per-ecoregion-code bundles; narrow with isLandscapeBundle. */
  readonly bundles: Readonly<Record<string, unknown>>;
}

export type LandscapeSignatureResult =
  | { readonly ok: true; readonly snapshot: LandscapeSignatureSnapshot }
  | {
      readonly ok: false;
      readonly reason: LandscapeLoadFailureReason;
      readonly note: string;
    };

/** The terrain source block (schema 1.2.0 provenance included). */
export interface TerrainSource {
  readonly source: string;
  readonly sourceUrl: string;
  readonly vintage: string;
  readonly resolutionMeters: number;
  readonly method: string;
  readonly methodVersion: number;
  readonly acquired: string | null;
  readonly materializedRasterSha256: string | null;
}

/** The per-ecoregion stats variant (aspect pair null together; slope may
 * be null beside genuine source nodata). */
export interface TerrainSignature {
  readonly elevMeanM: number;
  readonly elevMinM: number;
  readonly elevMaxM: number;
  readonly slopeMeanDeg: number | null;
  readonly aspectMeanDeg: number | null;
  readonly aspectCardinal: string | null;
  readonly coveragePct: number;
}

/** The explicit-unavailability variant. */
export interface UnavailableSignature {
  readonly unavailable: true;
  readonly reason: string;
}

/** Level-local shapes matching the schema's closed bundle branches: a
 * Level III bundle carries NO Level IV fields; a Level IV bundle carries
 * all three. The guard checks every property these types promise. */
export interface Level3Bundle {
  readonly level: 3;
  readonly usL3Code: string;
  readonly usL3Name: string;
  readonly terrain: TerrainSignature | UnavailableSignature;
}

export interface Level4Bundle {
  readonly level: 4;
  readonly usL3Code: string;
  readonly usL3Name: string;
  readonly usL4Code: string;
  readonly usL4Name: string;
  readonly parent: string;
  readonly terrain: TerrainSignature | UnavailableSignature;
}

export type LandscapeBundle = Level3Bundle | Level4Bundle;

export interface LandscapeLoadOptions {
  /** Override the artifact Uniform Resource Locator (URL); tests use
   * this. Defaults to URLS.landscapeSignatureLocal via a lazy import,
   * see the loader body. */
  readonly url?: string;
  /** Injectable transport with the fetchJsonWithBudget signature. */
  readonly fetchJsonImpl?: typeof fetchJsonWithBudget;
  /** The owning operation's abort signal. */
  readonly signal?: AbortSignal | null;
}

export function isUnavailableSignature(
  value: unknown
): value is UnavailableSignature {
  return (
    isObject(value) &&
    (value as { unavailable?: unknown }).unavailable === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

export function isTerrainSignature(value: unknown): value is TerrainSignature {
  if (!isObject(value)) return false;
  const v = value as Record<string, unknown>;
  const numberOrNull = (x: unknown): boolean =>
    x === null || typeof x === 'number';
  return (
    typeof v.elevMeanM === 'number' &&
    typeof v.elevMinM === 'number' &&
    typeof v.elevMaxM === 'number' &&
    numberOrNull(v.slopeMeanDeg) &&
    numberOrNull(v.aspectMeanDeg) &&
    (v.aspectCardinal === null || typeof v.aspectCardinal === 'string') &&
    (v.aspectMeanDeg === null) === (v.aspectCardinal === null) &&
    typeof v.coveragePct === 'number'
  );
}

export function isTerrainSource(value: unknown): value is TerrainSource {
  if (!isObject(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.source === 'string' &&
    typeof v.sourceUrl === 'string' &&
    typeof v.vintage === 'string' &&
    typeof v.resolutionMeters === 'number' &&
    typeof v.method === 'string' &&
    typeof v.methodVersion === 'number' &&
    (v.acquired === null || typeof v.acquired === 'string') &&
    (v.materializedRasterSha256 === null ||
      typeof v.materializedRasterSha256 === 'string')
  );
}

export function isLandscapeBundle(value: unknown): value is LandscapeBundle {
  if (!isPlainRecord(value)) return false;
  const v = value;
  const common =
    typeof v.usL3Code === 'string' &&
    typeof v.usL3Name === 'string' &&
    (isTerrainSignature(v.terrain) || isUnavailableSignature(v.terrain));
  if (!common) return false;
  if (v.level === 3) {
    return (
      v.usL4Code === undefined &&
      v.usL4Name === undefined &&
      v.parent === undefined
    );
  }
  if (v.level === 4) {
    return (
      typeof v.usL4Code === 'string' &&
      typeof v.usL4Name === 'string' &&
      typeof v.parent === 'string'
    );
  }
  return false;
}

/**
 * Load the landscape-signature artifact. Never throws for absence, shape,
 * or version problems: every failure is `{ ok: false, reason, note }`.
 * A response that completes after the master signal aborted is reported
 * as 'aborted', never returned as success (late responses to superseded
 * operations are dropped; CLAUDE.md section 6 rule 5).
 */
export async function loadLandscapeSignature(
  opts?: LandscapeLoadOptions
): Promise<LandscapeSignatureResult> {
  const signal = opts?.signal ?? null;
  const fetchJson = opts?.fetchJsonImpl ?? fetchJsonWithBudget;

  let url = opts?.url;
  if (url === undefined) {
    // Lazy so this module stays importable in pure-Node specs: config/urls
    // evaluates import.meta.env at module scope, which only exists under
    // the Vite bundle. Production callers take this branch; tests inject
    // `url`.
    const { URLS } = await import('../config/urls');
    url = URLS.landscapeSignatureLocal;
  }

  let payload: unknown;
  try {
    payload = await fetchJson(
      url,
      { headers: { Accept: 'application/json' } },
      signal,
      TIMEOUT_MS
    );
  } catch (err) {
    // The master abort wins over error classification: whatever the
    // transport threw (an AbortError, a TypeError from a torn stream, a
    // SyntaxError from a truncated body), a superseded operation is
    // reported 'aborted' and its outcome dropped, never surfaced as an
    // availability or parse statement (CLAUDE.md section 6 rule 5).
    if (signal?.aborted) {
      return {
        ok: false,
        reason: 'aborted',
        note: 'The landscape-signature load was cancelled.'
      };
    }
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        reason: 'malformed-json',
        note: 'The landscape-signature artifact is not parseable JSON.'
      };
    }
    // Hypertext Transfer Protocol (HTTP) error status, network failure,
    // or per-call timeout: to the
    // user these are one availability statement (see the reason-type doc).
    return {
      ok: false,
      reason: 'unavailable',
      note:
        'The landscape-signature artifact is unavailable (not built for ' +
        'this deployment, or the network read failed).'
    };
  }
  if (signal?.aborted) {
    return {
      ok: false,
      reason: 'aborted',
      note: 'The landscape-signature load was superseded.'
    };
  }

  if (
    !isPlainRecord(payload) ||
    typeof (payload as { schemaVersion?: unknown }).schemaVersion !==
      'string' ||
    typeof (payload as { retrieved?: unknown }).retrieved !== 'string' ||
    typeof (payload as { analysisCrs?: unknown }).analysisCrs !== 'string' ||
    typeof (payload as { gridResolutionMeters?: unknown })
      .gridResolutionMeters !== 'number' ||
    typeof (payload as { aggregationUnit?: unknown }).aggregationUnit !==
      'string' ||
    !isPlainRecord((payload as { sources?: unknown }).sources) ||
    !isPlainRecord((payload as { bundles?: unknown }).bundles)
  ) {
    return {
      ok: false,
      reason: 'invalid-shape',
      note:
        'The landscape-signature artifact does not have the expected ' +
        'top-level shape.'
    };
  }

  const snapshot = payload as unknown as LandscapeSignatureSnapshot;
  if (!SUPPORTED_SCHEMA_VERSIONS.test(snapshot.schemaVersion)) {
    return {
      ok: false,
      reason: 'unsupported-version',
      note:
        `The landscape-signature artifact declares schemaVersion ` +
        `${snapshot.schemaVersion}; this build supports the 1.2.x line ` +
        `only.`
    };
  }

  return { ok: true, snapshot };
}
