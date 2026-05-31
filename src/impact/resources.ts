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

/** Two-letter state code used to select state resources and the drought.gov slug. */
export type StateCode = 'WA' | 'OR' | 'ID';

/** Federal Information Processing Standards (FIPS) codes for the PNW states. */
const STATE_FIPS: Record<StateCode, number> = { WA: 53, OR: 41, ID: 16 };

/** The FIPS code for a region's primary state (for the USDM Data Services API). */
export function regionStateFips(regionKey: RegionKey | null): number {
  return STATE_FIPS[regionToStateCode(regionKey)];
}

/** The display label for a region's primary state. */
export function regionStateName(regionKey: RegionKey | null): string {
  return STATE_LABEL[regionToStateCode(regionKey)];
}

/**
 * Map a region key to its primary state for resource framing. Most PNW
 * framings are Washington-centric (the deployer context is ATNI Climate);
 * Central Oregon routes to Oregon. The Columbia and Snake basin spans several
 * states but its resource framing leans Washington, matching the cataloged
 * resource set. Regional generalization (ROADMAP) will broaden this.
 */
function regionToStateCode(regionKey: RegionKey | null): StateCode {
  switch (regionKey) {
    case 'central_oregon':
      return 'OR';
    default:
      return 'WA';
  }
}

/** drought.gov publishes a per-state page; map the state code to its slug. */
const DROUGHT_GOV_SLUG: Record<StateCode, string> = {
  WA: 'washington',
  OR: 'oregon',
  ID: 'idaho'
};

const STATE_LABEL: Record<StateCode, string> = {
  WA: 'Washington',
  OR: 'Oregon',
  ID: 'Idaho'
};

/**
 * Federal resources. The drought.gov page is state-aware; the U.S. Drought
 * Monitor and the United States Department of Agriculture drought-relief hub
 * are national.
 */
function federalResources(state: StateCode): ResourceLink[] {
  return [
    {
      label: `Drought.gov: ${STATE_LABEL[state]} state conditions`,
      url: `https://www.drought.gov/states/${DROUGHT_GOV_SLUG[state]}`,
      agency: 'National Integrated Drought Information System (NIDIS)',
      tier: 'federal',
      description: 'Federal drought portal: current conditions, outlooks, and impacts for the state.'
    },
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
 * State resources by state code. Washington is the fully cataloged set
 * (drinking-water emergencies, statewide water-supply conditions, agricultural
 * drought relief); Oregon and Idaho carry their water-resources drought
 * programs. Each is plainly attributed to its agency and is regional context,
 * never framed as governing a Tribal Nation.
 */
const STATE_RESOURCES: Record<StateCode, ResourceLink[]> = {
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
 * order: Tribe's-own slot first, then federal, then state (by region's primary
 * state), then the BIA regional entry for a reservation boundary.
 */
export function buildResources(context: BoundarySelectionContext): ResourceLink[] {
  const state = regionToStateCode(context.regionKey);
  const out: ResourceLink[] = [tribeOwnSlot(), ...federalResources(state), ...STATE_RESOURCES[state]];
  const bia = biaRegionalResource(context);
  if (bia) out.push(bia);
  return out;
}
