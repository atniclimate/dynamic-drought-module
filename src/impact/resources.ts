/**
 * Resource routing for the impact briefing.
 *
 * Turns a boundary selection into an ordered list of public resources, in the
 * stewardship order owned by ddm-tribal-context-threading (#9):
 *
 *   1. The Tribe's own resources (deployer slot, empty by default).
 *   2. Federal regional context (drought.gov, U.S. Drought Monitor, USDA relief).
 *   3. State regional context, plainly attributed to the agency.
 *   4. The Bureau of Indian Affairs (BIA) regional resource, keyed off the
 *      American Indian and Alaska Native Land Area Representation (AIAN-LAR)
 *      REGION field of the clicked feature when present.
 *
 * Stewardship guardrails (verbatim from the skill, review-blocking): Tribal
 * sovereignty is primary; external resources are supplementary. No agency is
 * presented as speaking for or governing a Tribal Nation; every state or
 * federal link-out is plainly attributed to its agency as regional context.
 * The Tribe's-own slot comes first and is empty by default with a clear
 * "populate in data/README.md" affordance; absent a populated slot, the panel
 * degrades gracefully to the regional resources with the framing intact. The
 * module ships no specific Tribe's resource links; the slot is generic and
 * deployer-populated.
 *
 * Every URL below was cataloged and verified by the prior session (see
 * docs/KERNEL_INTEGRATION_CONTINUATION.md section 3); they are link-outs, never
 * scraped, and open in a new tab.
 */

import type { RegionKey } from '../config/regions';
import type { BoundarySelectionContext, ResourceLink } from './types';

/**
 * Two-letter state, district, or territory postal code used for resource
 * routing. Covers the 52 features in the bundled Census cartographic boundary
 * file (public/data/us-states.geojson): the 50 states, the District of
 * Columbia, and Puerto Rico.
 */
export type StateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'FL' | 'GA'
  | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME' | 'MD'
  | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ'
  | 'NM' | 'NY' | 'NC' | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC'
  | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI' | 'WY'
  | 'DC' | 'PR';

/** Federal Information Processing Standards (FIPS) state codes. */
const STATE_FIPS: Record<StateCode, number> = {
  AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, FL: 12, GA: 13,
  HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21, LA: 22, ME: 23,
  MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32,
  NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40, OR: 41,
  PA: 42, RI: 44, SC: 45, SD: 46, TN: 47, TX: 48, UT: 49, VT: 50, VA: 51,
  WA: 53, WV: 54, WI: 55, WY: 56, DC: 11, PR: 72
};

const STATE_LABEL: Record<StateCode, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida',
  GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska',
  NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico'
};

/**
 * Resolve the state for a selection. A clicked state boundary carries its own
 * postal code (`STUSPS` from the Census file); every other boundary kind falls
 * back to the active region framing. The national explore framing has no
 * primary state, so a non-state selection there resolves to null and the
 * routing degrades honestly to the national federal set. (Point-in-state
 * resolution for non-state clicks under the national framing is a tracked
 * follow-up; see TODO.md.)
 */
export function resolveStateCode(
  context: BoundarySelectionContext
): StateCode | null {
  if (context.kind === 'state') {
    const raw = context.properties?.['STUSPS'];
    if (typeof raw === 'string') {
      const code = raw.toUpperCase();
      if (code in STATE_FIPS) return code as StateCode;
    }
  }
  return regionPrimaryState(context.regionKey);
}

/** The FIPS code for a selection's state (USDM Data Services), or null. */
export function contextStateFips(
  context: BoundarySelectionContext
): number | null {
  const code = resolveStateCode(context);
  return code === null ? null : STATE_FIPS[code];
}

/** The display label for a selection's state, or null. */
export function contextStateName(
  context: BoundarySelectionContext
): string | null {
  const code = resolveStateCode(context);
  return code === null ? null : STATE_LABEL[code];
}

/**
 * Map a region key to its primary state for resource framing. The PNW
 * framings are Washington-centric (the deployer context is ATNI Climate);
 * Central Oregon routes to Oregon. The national explore framing has no
 * primary state.
 */
function regionPrimaryState(regionKey: RegionKey | null): StateCode | null {
  switch (regionKey) {
    case 'central_oregon':
      return 'OR';
    case 'alaska':
      return 'AK';
    case 'hawaii':
      return 'HI';
    case 'national':
      return null;
    default:
      return 'WA';
  }
}

/**
 * drought.gov publishes a per-state page at a hyphenated-name slug. The
 * pattern was spot-verified live on 2026-07-01 (Texas, New Mexico, North
 * Carolina, Alaska, Hawaii all HTTP 200); the District of Columbia page does
 * not exist (HTTP 404) and Puerto Rico is unverified, so both fall back to
 * the national portal.
 */
function droughtGovStateUrl(state: StateCode): string {
  if (state === 'DC' || state === 'PR') return 'https://www.drought.gov/';
  return `https://www.drought.gov/states/${STATE_LABEL[state].toLowerCase().replace(/ /g, '-')}`;
}

/**
 * Federal resources. The drought.gov page is state-aware when a state can be
 * resolved for the selection and falls back to the national portal otherwise;
 * the U.S. Drought Monitor and the United States Department of Agriculture
 * drought-relief hub are national.
 */
function federalResources(state: StateCode | null): ResourceLink[] {
  const droughtGov: ResourceLink = state
    ? {
        label: `Drought.gov: ${STATE_LABEL[state]} state conditions`,
        url: droughtGovStateUrl(state),
        agency: 'National Integrated Drought Information System (NIDIS)',
        tier: 'federal',
        description: 'Federal drought portal: current conditions, outlooks, and impacts for the state.'
      }
    : {
        label: 'Drought.gov: national conditions and outlooks',
        url: 'https://www.drought.gov/',
        agency: 'National Integrated Drought Information System (NIDIS)',
        tier: 'federal',
        description: 'Federal drought portal: national current conditions, outlooks, and impacts.'
      };
  return [
    droughtGov,
    {
      label: 'U.S. Drought Monitor',
      url: 'https://droughtmonitor.unl.edu/',
      agency: 'National Drought Mitigation Center (NDMC / NOAA / USDA)',
      tier: 'federal',
      description: 'Weekly national drought-category map and data.'
    },
    {
      label: 'Drought disaster assistance for producers',
      url: 'https://www.farmers.gov/protection-recovery/drought',
      agency: 'United States Department of Agriculture (Farm Service Agency)',
      tier: 'federal',
      description: 'Federal disaster designations and producer relief programs for drought.'
    }
  ];
}

/**
 * State resources by state code (the SYNC BRIDGE; see below).
 *
 * BRIDGE NOTE (0.6.0 R2, D-0.6.0-004): the SYSTEM OF RECORD for the state tier
 * is now the per-state catalog at `public/data/resources/<code>.json`, loaded
 * by `src/impact/resource-catalog.ts` and documented in
 * `docs/resource-catalog-schema.md`. This inline table remains only because
 * `buildResources` runs synchronously and the catalog is fetched
 * asynchronously; F3 switches the state tier to the async catalog (the
 * open-then-rehydrate path, D-0.6.0-009) and removes this table. Until then
 * WA/OR/ID appear in both places by design; the catalog files are the
 * authoritative record the R3 fill campaign extends (new states are added ONLY
 * as catalog files, never here).
 *
 * Washington is the fully cataloged set (drinking-water emergencies, statewide
 * water-supply conditions, agricultural drought relief); Oregon and Idaho carry
 * their water-resources drought programs. Each is plainly attributed to its
 * agency and is regional context, never framed as governing a Tribal Nation.
 *
 * The table is deliberately partial: only strongly verified state programs
 * enter it. A state without an entry gets no state tier (the drought.gov
 * state page in the federal tier still carries state-specific conditions);
 * this never fabricates a link.
 */
const STATE_RESOURCES: Partial<Record<StateCode, ResourceLink[]>> = {
  WA: [
    {
      label: 'Drinking-water drought guidance',
      url: 'https://doh.wa.gov/community-and-environment/drinking-water/drinking-water-emergencies/drought',
      agency: 'Washington State Department of Health (Office of Drinking Water)',
      tier: 'state',
      description: 'Guidance for drinking-water systems during drought and water-supply emergencies.'
    },
    {
      label: 'Statewide water-supply conditions',
      url: 'https://ecology.wa.gov/water-shorelines/water-supply/water-availability/statewide-conditions',
      agency: 'Washington State Department of Ecology',
      tier: 'state',
      description: 'Statewide water availability and drought-declaration status.'
    },
    {
      label: 'Agricultural drought relief',
      url: 'https://agr.wa.gov/services/emergency-management/disasters/drought',
      agency: 'Washington State Department of Agriculture',
      tier: 'state',
      description: 'State agricultural drought emergency information and relief.'
    }
  ],
  OR: [
    {
      label: 'Oregon Drought Watch',
      url: 'https://www.oregon.gov/owrd/programs/climate/droughtwatch/pages/default.aspx',
      agency: 'Oregon Water Resources Department',
      tier: 'state',
      description: 'County drought declarations and statewide water-supply status.'
    }
  ],
  ID: [
    {
      label: 'Idaho water data and drought',
      url: 'https://idwr.idaho.gov/water-data/',
      agency: 'Idaho Department of Water Resources',
      tier: 'state',
      description: 'Streamflow, snowpack, and water-supply data for the state.'
    }
  ]
};

/**
 * The deployer-owned Tribe's-own-resources slot. Always present, always first,
 * empty by default. No specific Tribe's links are shipped; a deployer with
 * authorization populates this slot (documented in data/README.md). The panel
 * renders the empty slot as a "populate" affordance, not a broken link.
 */
function tribeOwnSlot(): ResourceLink {
  return {
    label: "Your Nation's drought, water, and emergency resources",
    agency: 'Deployer-populated',
    tier: 'tribe-own',
    description:
      "Primary: your Nation's own emergency management, water and drinking-water authority, and adaptation or hazard-mitigation plan. Populate this slot for your deployment (see data/README.md)."
  };
}

/**
 * The BIA regional resource, surfaced only for a BIA reservation boundary and
 * keyed off the feature's AIAN-LAR REGION field when present. The BIA OneMap
 * hub links BIA regional resources; we label it with the region from the
 * clicked feature. We do not invent a region-to-resource mapping (the keying
 * doctrine is owned by ddm-tribal-boundary-mapping); we surface the
 * authoritative hub plainly attributed to the BIA.
 */
function biaRegionalResource(
  context: BoundarySelectionContext
): ResourceLink | null {
  if (context.kind !== 'bia-reservation') return null;
  const props = context.properties ?? {};
  const regionRaw = props['REGION'] ?? props['Region'] ?? '';
  const region = typeof regionRaw === 'string' ? regionRaw.trim() : '';
  return {
    label: region ? `BIA ${region} Region resources` : 'BIA regional resources',
    url: 'https://onemap-bia-geospatial.hub.arcgis.com/',
    agency: 'Bureau of Indian Affairs (BIA)',
    tier: 'bia-regional',
    description:
      'The BIA OneMap hub links regional Bureau of Indian Affairs geospatial resources and contacts.'
  };
}

/**
 * Compose the ordered resource list for a selection. Order is the stewardship
 * order: Tribe's-own slot first, then federal, then state (resolved from the
 * clicked state boundary or the region's primary state), then the BIA regional
 * entry for a reservation boundary.
 */
export function buildResources(context: BoundarySelectionContext): ResourceLink[] {
  const state = resolveStateCode(context);
  const out: ResourceLink[] = [tribeOwnSlot(), ...federalResources(state)];
  if (state) out.push(...(STATE_RESOURCES[state] ?? []));
  const bia = biaRegionalResource(context);
  if (bia) out.push(bia);
  return out;
}
