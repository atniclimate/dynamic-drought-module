/**
 * Verified resource catalog (0.6.0 unit R2; pathway appendix F; D-0.6.0-004).
 *
 * The state-scoped resource links a briefing routes to are DATA, not code:
 * per-state JSON files under `public/data/resources/<code>.json`, fetched only
 * for the state a click resolves to (lazy). This module loads and validates
 * them; the schema and the routing doctrine are documented in
 * `docs/resource-catalog-schema.md`, which is the system of record.
 *
 * Stewardship: public resource LINKS are not sovereign data, so the catalog
 * ships in-repo (unlike boundary polygons; CLAUDE.md hard rule 1). The
 * stewardship ORDER (the Tribe's own resources first, then federal, then state,
 * then BIA regional) is owned by the panel composition in `src/impact/`, not by
 * this file; this file supplies the state tier only.
 *
 * Honesty: a missing state file (HTTP 404) is not an error, it is "no
 * state-tier catalog for this state yet" and yields an empty list; a malformed
 * file drops the offending rows rather than rendering bad data. The build-time
 * schema check (`scripts/check-resource-catalog.mjs`, run in `npm run gate`) is
 * the strict gate; this runtime validation is the defensive backstop.
 */

import { URLS } from '../config/urls';
import { fetchWithBudget } from '../util/fetch';
import type { ResourceLink, ResourceTier } from './types';
import type { LocationIdentity } from '../state/location-identity';

/** One state's catalog entry. `verified` is the entry-level verification stamp. */
export interface StateResourceCatalog {
  /** Display label, for example "Washington". */
  readonly label: string;
  /** Entry-level verification stamp (ISO date), for example "2026-07-09". */
  readonly verified: string;
  readonly resources: readonly ResourceLink[];
}

const FETCH_TIMEOUT_MS = 10_000;

const VALID_TIERS: ReadonlySet<ResourceTier> = new Set<ResourceTier>([
  'tribe-own',
  'federal',
  'state',
  'bia-regional'
]);

/**
 * Per-code load cache. Keyed by lowercase two-letter code; the value is the
 * in-flight or settled load promise, so concurrent clicks on the same state
 * share one fetch.
 */
const cache = new Map<string, Promise<StateResourceCatalog | null>>();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Validate and normalize one row; null if it fails the required-field rules. */
function normalizeRow(raw: unknown): ResourceLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (!isNonEmptyString(row['label'])) return null;
  if (!isNonEmptyString(row['agency'])) return null;
  const tier = row['tier'];
  if (typeof tier !== 'string' || !VALID_TIERS.has(tier as ResourceTier)) return null;
  // `url` is optional (the Tribe's-own slot is link-less); when present it must
  // be https:// so the panel never renders a mixed-content or insecure link.
  const url = row['url'];
  if (url !== undefined) {
    if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  }
  const description = row['description'];
  return {
    label: row['label'] as string,
    agency: row['agency'] as string,
    tier: tier as ResourceTier,
    ...(typeof url === 'string' ? { url } : {}),
    ...(isNonEmptyString(description) ? { description: description } : {})
  };
}

/** Validate and normalize a whole state entry; null if unusable. */
function normalizeCatalog(raw: unknown): StateResourceCatalog | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj['label'])) return null;
  if (!isNonEmptyString(obj['verified'])) return null;
  if (!Array.isArray(obj['resources'])) return null;
  const resources = obj['resources']
    .map(normalizeRow)
    .filter((r): r is ResourceLink => r !== null);
  return {
    label: obj['label'] as string,
    verified: obj['verified'] as string,
    resources
  };
}

/**
 * Load the catalog entry for a state by its two-letter code (case-insensitive),
 * fetching `public/data/resources/<code>.json` once and caching the result. A
 * missing file (404) or any failure resolves to null (no state-tier catalog),
 * never a throw.
 */
export function loadStateResourceCatalog(
  code: string,
  signal?: AbortSignal
): Promise<StateResourceCatalog | null> {
  const key = code.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  const load = (async (): Promise<StateResourceCatalog | null> => {
    try {
      const response = await fetchWithBudget(
        `${URLS.resourcesLocalBase}${key}.json`,
        null,
        signal ?? null,
        FETCH_TIMEOUT_MS
      );
      if (!response.ok) return null;
      return normalizeCatalog(await response.json());
    } catch (err) {
      // An aborted fetch is a superseded click, not a real failure: forget it
      // so a later click can try again.
      if (signal?.aborted) {
        cache.delete(key);
        return null;
      }
      console.warn(`[resource-catalog] failed to load ${key}.json`, err);
      return null;
    }
  })();

  cache.set(key, load);
  return load;
}

/**
 * The state-tier resource rows for a resolved location identity: the catalog
 * entry for `identity.state`, or an empty list when there is no resolved state
 * or no catalog file for it. Composition with the other tiers (Tribe's-own,
 * federal, BIA regional) and the stewardship order stay with the panel.
 */
export async function resourcesForIdentity(
  identity: LocationIdentity,
  signal?: AbortSignal
): Promise<ResourceLink[]> {
  const code = identity.state?.code;
  if (!code) return [];
  const catalog = await loadStateResourceCatalog(code, signal);
  return catalog ? [...catalog.resources] : [];
}
