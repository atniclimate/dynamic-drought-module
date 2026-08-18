/**
 * Verified resource catalog (0.6.0 unit R2; pathway appendix F; D-0.6.0-004;
 * hardened per the 2026-07-09 Codex adversarial review, D-0.6.0-011).
 *
 * The state-scoped resource links a briefing routes to are DATA, not code:
 * per-state JSON files under `public/data/resources/<code>.json`, fetched only
 * for the state a click resolves to (lazy). This module loads and validates
 * them; the build gate `scripts/check-resource-catalog.mjs` enforces the same
 * schema strictly and is the system of record for it.
 *
 * Stewardship: public resource LINKS are not sovereign data, so the catalog
 * ships in-repo (unlike boundary polygons, which the project never
 * redistributes). The
 * stewardship ORDER (the Tribe's own resources first, then federal, then state,
 * then BIA regional) is owned by the panel composition in `src/impact/`, not by
 * this file; this file supplies the state tier only. A state file's rows are
 * LOCKED to `tier: "state"`: a row claiming any other tier is dropped, so a
 * catalog file can never inject an entry that masquerades as a Nation-owned or
 * federal resource (the top finding of the adversarial review).
 *
 * Honesty: a missing state file (HTTP 404) is not an error, it is "no
 * state-tier catalog for this state yet" and yields an empty list; a malformed
 * file drops the offending rows rather than rendering bad data. The build-time
 * schema check (`scripts/check-resource-catalog.mjs`, run in `npm run gate`) is
 * the strict gate; this runtime validation is the defensive backstop.
 *
 * Cancellation note (a documented deviation from the per-caller abort pattern):
 * the catalog fetch is a small same-origin static-file GET, shared by every
 * caller through the session cache, so it deliberately does NOT take a caller's
 * abort signal (a shared fetch owned by one caller's signal let an aborted
 * click starve a concurrent live one). It is bounded by its own timeout, and
 * callers drop superseded RESULTS via their own signal checks (see
 * `rehydrateResourcesFromCatalog` in `src/ui/impact-panel.ts`). Only a
 * successful load or a definitive 404 is cached; transient failures (a 5xx, a
 * timeout, malformed JSON) evict the entry so a later click retries.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import type { ResourceLink } from './types';
import type { LocationIdentity } from '../state/location-identity';

/** One state's catalog entry. `verified` is the entry-level verification stamp. */
export interface StateResourceCatalog {
  /** Display label, for example "Washington". */
  readonly label: string;
  /** Entry-level verification stamp (ISO date `YYYY-MM-DD`). */
  readonly verified: string;
  readonly resources: readonly ResourceLink[];
}

const FETCH_TIMEOUT_MS = 10_000;

/** The `verified` stamp must be an ISO calendar date (the provenance claim). */
const VERIFIED_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Per-code cache. Keyed by lowercase two-letter code; the value is the
 * in-flight or settled load promise, so concurrent clicks on the same state
 * share one fetch. Only two outcomes stay cached: a valid catalog, or the
 * definitive-404 null ("no file for this state"). Anything transient evicts.
 */
const cache = new Map<string, Promise<StateResourceCatalog | null>>();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** The catalog file kinds and the tier each is locked to. */
type CatalogTier = 'state' | 'federal';

/**
 * Validate and normalize one row; null if it fails the required-field rules.
 * A catalog file's rows are locked to its file kind's tier (`state` for a
 * state file, `federal` for federal.json) and MUST carry an `https://` url:
 * the Tribe's-own link-less affordance and the BIA regional entry are composed
 * in code, never supplied by a catalog file.
 */
function normalizeRow(raw: unknown, expectedTier: CatalogTier): ResourceLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!isNonEmptyString(row['label'])) return null;
  if (!isNonEmptyString(row['agency'])) return null;
  if (row['tier'] !== expectedTier) return null;
  const url = row['url'];
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const description = row['description'];
  return {
    label: row['label'] as string,
    agency: row['agency'] as string,
    tier: expectedTier,
    url,
    ...(isNonEmptyString(description) ? { description: description } : {})
  };
}

/** Validate and normalize a whole catalog entry; null if unusable. */
function normalizeCatalog(raw: unknown, expectedTier: CatalogTier): StateResourceCatalog | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj['label'])) return null;
  // The verified stamp is the provenance claim; a malformed one invalidates
  // the file rather than rendering rows under a stamp that means nothing.
  if (!isNonEmptyString(obj['verified']) || !VERIFIED_RE.test(obj['verified'] as string)) {
    return null;
  }
  if (!Array.isArray(obj['resources'])) return null;
  const resources = obj['resources']
    .map((row) => normalizeRow(row, expectedTier))
    .filter((r): r is ResourceLink => r !== null);
  return {
    label: obj['label'] as string,
    verified: obj['verified'] as string,
    resources
  };
}

/**
 * Load and cache one catalog file by its basename (`wa`, `federal`, ...).
 * Resolves to null (never a throw) when there is no usable catalog: a 404 (no
 * file; cached as definitive), a transient failure (5xx, timeout, malformed
 * JSON; NOT cached, so a later click retries), or a file the runtime
 * validation rejects (not cached; the build gate should have caught it).
 */
function loadCatalogFile(
  key: string,
  expectedTier: CatalogTier
): Promise<StateResourceCatalog | null> {
  const existing = cache.get(key);
  if (existing) return existing;

  const load = (async (): Promise<StateResourceCatalog | null> => {
    try {
      const response = await fetchWithBudget(
        `${URLS.resourcesLocalBase}${key}.json`,
        null,
        null,
        FETCH_TIMEOUT_MS
      );
      if (response.status === 404) return null; // definitive: no file; stays cached
      if (!response.ok) {
        cache.delete(key); // transient (5xx and friends): allow a later retry
        return null;
      }
      const catalog = normalizeCatalog(await response.json(), expectedTier);
      if (!catalog) cache.delete(key); // shape-invalid: do not pin a bad read
      return catalog;
    } catch (err) {
      // Network failure or timeout: transient, evict so a later click retries.
      cache.delete(key);
      console.warn(`[resource-catalog] failed to load ${key}.json`, err);
      return null;
    }
  })();

  cache.set(key, load);
  return load;
}

/**
 * Load the catalog entry for a state by its two-letter code (case-insensitive).
 */
export function loadStateResourceCatalog(code: string): Promise<StateResourceCatalog | null> {
  return loadCatalogFile(code.toLowerCase(), 'state');
}

/**
 * The national federal-tier rows from `public/data/resources/federal.json`
 * (D-0.6.0-012): the actionable federal program, assistance, and funding set,
 * Tribal-specific entries first. An empty list when the file is missing or
 * unusable; the in-code federal info anchors (the state-aware drought.gov
 * page, the U.S. Drought Monitor, the USDA drought hub) render regardless, so
 * the federal tier never disappears outright.
 */
export async function loadFederalResources(): Promise<ResourceLink[]> {
  const catalog = await loadCatalogFile('federal', 'federal');
  return catalog ? [...catalog.resources] : [];
}

/**
 * The state-tier resource rows for a resolved location identity: the catalog
 * entry for `identity.state`, or an empty list when there is no resolved state
 * or no catalog file for it. Composition with the other tiers (Tribe's-own,
 * federal, BIA regional) and the stewardship order stay with the panel. The
 * caller guards its own supersede/abort semantics (see the cancellation note
 * in the module header).
 */
export async function resourcesForIdentity(identity: LocationIdentity): Promise<ResourceLink[]> {
  const code = identity.state?.code;
  if (!code) return [];
  const catalog = await loadStateResourceCatalog(code);
  return catalog ? [...catalog.resources] : [];
}
