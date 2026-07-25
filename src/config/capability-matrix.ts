/**
 * The coverage/capability matrix (0.8.0 T-P0-3): today's truth about what
 * the module does for each coverage family, as data. This module is the ONE
 * source; docs/COVERAGE_MATRIX.md is GENERATED from it
 * (scripts/generate-coverage-matrix.mjs, drift-checked in `npm run gate`)
 * and tests/capability-matrix.spec.ts enforces the consistency rules:
 * impactSynthesis never exceeds droughtState, and no axis is 'full' where
 * display is 'none'.
 *
 * Update discipline: when a unit lands or retires a capability, update the
 * affected cells IN THE SAME UNIT and regenerate the doc
 * (`npm run build:coverage-matrix`); the gate fails on drift. Notes are one
 * line, honest, and name the limiting fact (not aspiration).
 *
 * Nothing in the APPLICATION imports this module at runtime yet: the
 * T-M0-4 honest-disablement hook is `regionCapabilityLevel()` in
 * src/config/region-capability.ts (a separate module so this one stays
 * import-free for the coverage-matrix generator's native type-stripping
 * import, src/config/regions.ts stays metadata-only, and the matrix stays
 * out of the eager entry graph), and that hook has no runtime caller
 * either; the first behavioral consumer is the honest-disablement work in
 * the breadth track (M-BREADTH: disable unsupported analyses per this
 * matrix rather than failing quietly). (Wording amended at T-M0-4 from
 * "Nothing imports this module at runtime yet": tests import it, and the
 * hook module now exists.)
 */

import type {
  CapabilityAxisKey,
  CapabilityLevel,
  CapabilityMatrix,
  CoverageFamilyKey
} from '../types/capability-matrix';

/** Family order for iteration and doc rendering. */
export const COVERAGE_FAMILY_KEYS: readonly CoverageFamilyKey[] = [
  'pnw',
  'conus',
  'ak-hi',
  'canada',
  'transboundary'
];

/** Axis order for iteration and doc rendering. */
export const CAPABILITY_AXIS_KEYS: readonly CapabilityAxisKey[] = [
  'display',
  'selectablePlace',
  'droughtState',
  'landscapeSignature',
  'impactSynthesis'
];

/** Display names; acronyms spelled out per the repo convention. */
export const COVERAGE_FAMILY_LABELS: Readonly<
  Record<CoverageFamilyKey, string>
> = {
  pnw: 'Pacific Northwest (PNW)',
  conus: 'Contiguous United States (CONUS)',
  'ak-hi': 'Alaska and Hawaii',
  canada: 'Canada',
  transboundary: 'Transboundary (Columbia Basin)'
};

export const CAPABILITY_AXIS_LABELS: Readonly<
  Record<CapabilityAxisKey, string>
> = {
  display: 'Display',
  selectablePlace: 'Selectable place',
  droughtState: 'Drought state',
  landscapeSignature: 'Landscape signature',
  impactSynthesis: 'Impact synthesis'
};

/**
 * Ordering for the consistency rules: a capability "exceeds" another when
 * its rank is higher.
 */
export const CAPABILITY_LEVEL_RANK: Readonly<Record<CapabilityLevel, number>> =
  {
    none: 0,
    partial: 1,
    full: 2
  };

/**
 * Initial values ratified in the 0.8.0 WORKPLAN (T-P0-3, "today's truth" as
 * of 2026-07-21). Every cell carries the limiting fact in its note.
 */
export const CAPABILITY_MATRIX: CapabilityMatrix = {
  pnw: {
    display: {
      level: 'full',
      note: 'The shipped framings render the PNW as the primary region.'
    },
    selectablePlace: {
      level: 'full',
      note: 'Tribal Nations, states, ecoregions, and watersheds are selectable typed places (watershed lists come from the live USGS WBD service); municipal labels are display-only.'
    },
    droughtState: {
      level: 'partial',
      note: 'US Drought Monitor (USDM) polygons, DSCI, and the NIDIS SPI raster display; no gridded index feeds analysis or the briefing yet (the MCO value path lands in 0.8.0).'
    },
    landscapeSignature: {
      level: 'none',
      note: 'The P9 signature pipeline is design and evidence only; no baked artifact ships yet.'
    },
    impactSynthesis: {
      level: 'partial',
      note: 'The shipped briefing composes USDM, outlooks, and telemetry with the evidence contract; no gridded or signature inputs yet.'
    }
  },
  conus: {
    display: {
      level: 'full',
      note: 'The national framing renders CONUS on the same basemap and condition surfaces.'
    },
    selectablePlace: {
      level: 'partial',
      note: 'AIANNH/BIA and state selection exist nationally, but the behavior is unproven outside the PNW (N3 owns the proof).'
    },
    droughtState: {
      level: 'partial',
      note: 'USDM polygons and the NIDIS SPI raster display cover CONUS; no gridded index feeds analysis or the briefing.'
    },
    landscapeSignature: {
      level: 'none',
      note: 'No signature inputs are baked outside the planned PNW pipeline.'
    },
    impactSynthesis: {
      level: 'none',
      note: 'The briefing synthesis and resource routing are not validated outside the PNW.'
    }
  },
  'ak-hi': {
    display: {
      level: 'partial',
      note: 'The Alaska framing stops short of the Aleutians; the antimeridian contract is pending (N2).'
    },
    selectablePlace: {
      level: 'partial',
      note: 'National AIANNH/BIA selection is unproven for Alaska and Hawaii; no validated catalogs there.'
    },
    droughtState: {
      level: 'none',
      note: 'The shipped drought surfaces are not exercised or verified for Alaska or Hawaii.'
    },
    landscapeSignature: {
      level: 'none',
      note: 'No signature inputs exist for Alaska or Hawaii.'
    },
    impactSynthesis: {
      level: 'none',
      note: 'No briefing support for Alaska or Hawaii.'
    }
  },
  canada: {
    display: {
      level: 'none',
      note: 'Camera framings cross into Canada but every condition source is US-scoped there (the framings carry that coverage note); validated Canadian display is the N-track and U7.'
    },
    selectablePlace: {
      level: 'none',
      note: 'No Canadian place catalogs are wired.'
    },
    droughtState: {
      level: 'none',
      note: 'The Canadian Drought Monitor endpoint is qualified (T-V0-5 evidence) but nothing is wired.'
    },
    landscapeSignature: {
      level: 'none',
      note: 'No Canadian signature inputs.'
    },
    impactSynthesis: {
      level: 'none',
      note: 'No Canadian briefing support.'
    }
  },
  transboundary: {
    display: {
      level: 'none',
      note: 'No mixed-edition transboundary frame; N6 requires a tested US/Canada data seam first.'
    },
    selectablePlace: {
      level: 'none',
      note: 'No transboundary place catalog exists.'
    },
    droughtState: {
      level: 'none',
      note: 'US and Canadian drought editions differ; no reconciled surface exists.'
    },
    landscapeSignature: {
      level: 'none',
      note: 'No transboundary signature inputs.'
    },
    impactSynthesis: {
      level: 'none',
      note: 'No transboundary briefing support.'
    }
  }
};
