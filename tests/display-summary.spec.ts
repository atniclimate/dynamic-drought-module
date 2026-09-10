import { test, expect } from '@playwright/test';

import {
  deriveDisplaySummary,
  isUsScopeCautionLayer,
  userFacingCoverageClause
} from '../src/state/display-summary';
import type {
  DisplaySummaryInput,
  TimelineSnapshot
} from '../src/types/display-summary';
import type { LayerStatus } from '../src/types/layer';
import { LAYER_DEFS } from '../src/config/layers';
import { FRAMINGS } from '../src/config/framings';
import { STATUS_PILL_TEXT } from '../src/ui/island/pill-text';

/**
 * S3: the pure display-summary derivation (D-0.7.0-041 part 2; the S3
 * handoff section 4). Pure Node assertions in the established
 * s1-substrate / s2-url-migration pattern: the derivation is pure over
 * its input snapshot precisely so the grammar is testable without a
 * browser. (The handoff names Vitest; this repository's one test
 * runner is Playwright, and new dependencies are fenced out, so these
 * ride the same pure-Node describe shape every state module uses.)
 */

const NOW: TimelineSnapshot = {
  usdmWeek: null,
  usdmMode: 'absolute',
  sstDate: null,
  outlookRange: 'seasonal'
};

/** The persistent reference set (default-on, non-surface). */
const REFERENCE_KEYS = LAYER_DEFS.filter(
  (def) => def.defaultOn && def.role !== 'surface'
).map((def) => def.key);
const USDM_NO_DATA_LABEL = LAYER_DEFS.find(
  (def) => def.key === 'usdm'
)?.noDataLabel;
if (!USDM_NO_DATA_LABEL) {
  throw new Error('US Drought Monitor must define its canonical no-data label.');
}

function input(
  keys: readonly string[],
  statuses: Readonly<Record<string, LayerStatus>>,
  overrides: Partial<DisplaySummaryInput> = {}
): DisplaySummaryInput {
  return {
    cluster: 'drought',
    framing: null,
    intendedKeys: new Set(keys),
    statuses: new Map(Object.entries(statuses)),
    timeline: NOW,
    ...overrides
  };
}

/** Every intended key ready. */
function allReady(keys: readonly string[]): Record<string, LayerStatus> {
  const out: Record<string, LayerStatus> = {};
  for (const key of keys) out[key] = 'ready';
  return out;
}

const DROUGHT_KEYS = [...REFERENCE_KEYS, 'usdm'];

test.describe('S3 display summary: the Showing sentence', () => {
  test('everything ready yields one Showing sentence, surface first, and no caveat', () => {
    const summary = deriveDisplaySummary(input(DROUGHT_KEYS, allReady(DROUGHT_KEYS)));
    expect(summary.primary.startsWith('Showing US Drought Monitor with ')).toBe(true);
    expect(summary.primary).toContain('Tribal Lands');
    expect(summary.primary).toContain('Reservation Boundaries');
    expect(summary.primary).toContain('State Boundaries');
    expect(summary.primary.endsWith('.')).toBe(true);
    expect(summary.caveat).toBeNull();
  });

  test('the summary is status-derived, never intent-derived: a non-ready surface never claims Showing', () => {
    for (const status of ['loading', 'error', 'no-data', 'zoom-in'] as const) {
      const summary = deriveDisplaySummary(
        input(DROUGHT_KEYS, { ...allReady(REFERENCE_KEYS), usdm: status })
      );
      expect(summary.primary).not.toContain('US Drought Monitor');
      expect(summary.caveat).not.toBeNull();
    }
  });

  test('an intended key with NO recorded status reads as pending, not displayed', () => {
    const summary = deriveDisplaySummary(input(['usdm'], {}));
    expect(summary.primary).toBe('No layers are displayed yet.');
    expect(summary.caveat).toContain('Loading US Drought Monitor');
  });
});

test.describe('S3 display summary: the six ruled statuses', () => {
  test('ready: included in Showing', () => {
    const summary = deriveDisplaySummary(input(['usdm'], { usdm: 'ready' }));
    expect(summary.primary).toBe('Showing US Drought Monitor.');
    expect(summary.caveat).toBeNull();
  });

  test('degraded: named live with partial coverage in the caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'degraded' })
    );
    expect(summary.caveat).toContain('US Drought Monitor is live with partial coverage');
    expect(summary.primary).not.toContain('US Drought Monitor');
  });

  test('loading: excluded from Showing; Loading X caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'loading' })
    );
    expect(summary.caveat).toContain('Loading US Drought Monitor');
  });

  test('error: X is unavailable', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'error' })
    );
    expect(summary.caveat).toContain('US Drought Monitor is unavailable');
  });

  test('no-data reuses the canonical pill wording: live zero-feature vs deployer placeholder stay distinct', () => {
    // A LIVE viewport-queried layer (usdm carries the live label).
    const live = deriveDisplaySummary(
      input(DROUGHT_KEYS, { ...allReady(DROUGHT_KEYS), usdm: 'no-data' })
    );
    expect(live.caveat).toContain(`US Drought Monitor: ${USDM_NO_DATA_LABEL}`);
    expect(live.caveat).not.toContain('data/README.md');

    // A bundled deployer placeholder keeps the canonical wording.
    const keys = [...DROUGHT_KEYS, 'tribal'];
    const placeholder = deriveDisplaySummary(
      input(keys, { ...allReady(DROUGHT_KEYS), tribal: 'no-data' })
    );
    expect(placeholder.caveat).toContain(
      `Tribal Lands (your own data): ${STATUS_PILL_TEXT['no-data']}`
    );
  });

  test('zoom-in: X appears after you zoom in', () => {
    const keys = [...DROUGHT_KEYS, 'telemetry'];
    const summary = deriveDisplaySummary(
      input(keys, { ...allReady(DROUGHT_KEYS), telemetry: 'zoom-in' })
    );
    expect(summary.caveat).toContain('Monitoring stations appears after you zoom in');
  });

  test('several problems still make ONE caveat string, never a dashboard', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, {
        ...allReady(REFERENCE_KEYS),
        usdm: 'error',
        hillshade: 'loading'
      })
    );
    expect(summary.caveat).toContain('Loading Terrain Shading');
    expect(summary.caveat).toContain('US Drought Monitor is unavailable');
    // One string, semicolon-joined clauses, one terminal period.
    expect(summary.caveat?.endsWith('.')).toBe(true);
    expect(summary.caveat?.indexOf('.')).toBe((summary.caveat?.length ?? 0) - 1);
  });
});

test.describe('S3 display summary: coverage honesty relocated to the on-map key (DDM fix lane, 2026-09-10)', () => {
  // The framing coverage caution used to lead this module's own caveat AND
  // pop up a second time on the minimap's own caption (src/ui/island/minimap.tsx)
  // for the same click: the same sentence, twice, at once. The owner called
  // the popup noise; the fix retired BOTH renderings in favor of one, the
  // on-map key (src/ui/map-key.ts). The tests below now prove the NEGATIVE
  // half of that (this module never re-adds the clause) and unit-test the
  // two exported building blocks (`isUsScopeCautionLayer`,
  // `userFacingCoverageClause`) the key now drives directly, since their
  // only remaining caller is DOM-driven and untestable at this pure layer.

  test('Mexico framing over a ready US-scoped surface adds no caveat here; the on-map key states the caution instead', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'mexico' })
    );
    expect(summary.caveat).toBeNull();
  });

  test('a ready status over an out-of-coverage framing (Boreal & Arctic) also adds no caveat here now', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'boreal-arctic' })
    );
    expect(summary.caveat).toBeNull();
  });

  test('an events-only US-scoped display (wildfire at current) still adds no caveat coverage clause here', () => {
    // The wildfire 'current' recipe has no condition surface, only the
    // NIFC/HMS event pair; NIFC WFIGS is US-scoped, so the retired rule
    // applied to display LAYERS, not only surfaces. The key's own
    // frameCoverageNote (src/ui/map-key.ts) applies the identical rule via
    // the same exported isUsScopeCautionLayer, unit-tested below.
    const keys = [...REFERENCE_KEYS, 'nifc-fires', 'hms-smoke'];
    const summary = deriveDisplaySummary(
      input(keys, allReady(keys), { cluster: 'wildfire', framing: 'mexico' })
    );
    expect(summary.primary).toContain(
      'Current Mapped Fire Perimeters (National Interagency Fire Center, NIFC)'
    );
    expect(summary.caveat).toBeNull();
  });

  test('isUsScopeCautionLayer: the exemption rule the on-map key now applies, unit-tested directly since it no longer drives a caveat here', () => {
    expect(isUsScopeCautionLayer({ key: 'usdm', role: 'surface' })).toBe(true);
    expect(isUsScopeCautionLayer({ key: 'nifc-fires', role: 'event' })).toBe(true);
    expect(isUsScopeCautionLayer({ key: 'telemetry', role: 'stations' })).toBe(true);
    // The two named exceptions: the ocean anomaly is global, NADM is the
    // tri-national continental product.
    expect(isUsScopeCautionLayer({ key: 'sst-anomaly', role: 'surface' })).toBe(false);
    expect(isUsScopeCautionLayer({ key: 'nadm-drought', role: 'surface' })).toBe(false);
    // Reference layers never count, regardless of key.
    expect(isUsScopeCautionLayer({ key: 'hillshade', role: 'reference' })).toBe(false);
  });

  test('userFacingCoverageClause keeps a substantive second clause (Alaska & Northwest) but drops the authoring-guidance tail (Boreal & Arctic), exercised directly now that its only caller is the DOM-driven on-map key', () => {
    const alaskaNote = FRAMINGS['alaska-northwest'].coverageNote;
    if (!alaskaNote) {
      throw new Error('Alaska & Northwest must define a coverageNote for this test.');
    }
    const alaska = userFacingCoverageClause(alaskaNote);
    expect(alaska).toContain('US display layers cover Alaska variably');
    expect(alaska).toContain(
      'Yukon and British Columbia are outside US-scoped sources'
    );

    const borealNote = FRAMINGS['boreal-arctic'].coverageNote;
    if (!borealNote) {
      throw new Error('Boreal & Arctic must define a coverageNote for this test.');
    }
    const boreal = userFacingCoverageClause(borealNote);
    expect(boreal).toContain('Mostly outside US-scoped display sources');
    expect(boreal).not.toContain('per-layer status');
  });

  test('a globally-scoped surface (Ocean Temperature Anomaly) does not trigger the US-coverage caution', () => {
    const keys = [...REFERENCE_KEYS, 'sst-anomaly'];
    const summary = deriveDisplaySummary(
      input(keys, allReady(keys), { cluster: 'enso', framing: 'mexico' })
    );
    expect(summary.primary).toContain('Ocean Temperature Anomaly');
    expect(summary.caveat).toBeNull();
  });

  test('the tri-national NADM surface does not trigger a false Mexico coverage warning', () => {
    const keys = [...REFERENCE_KEYS, 'nadm-drought'];
    const summary = deriveDisplaySummary(
      input(keys, allReady(keys), { framing: 'mexico' })
    );
    expect(summary.primary).toContain('North American Drought Monitor');
    expect(summary.caveat).toBeNull();
  });

  test('a framing without a coverage note adds no caveat', () => {
    const summary = deriveDisplaySummary(
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'arid-west' })
    );
    expect(summary.caveat).toBeNull();
  });
});

test.describe('S3 display summary: the empty recipe and honest labels', () => {
  test('the empty heat/season-ahead recipe yields the honest no-verified-surface primary', () => {
    const summary = deriveDisplaySummary(
      input(REFERENCE_KEYS, allReady(REFERENCE_KEYS), { cluster: 'heat' })
    );
    expect(summary.primary).toBe(
      'No verified Extreme Heat surface is available at this horizon; showing reference layers only.'
    );
  });

  test('honest labels only: never a marine-heatwave or refined multi-source claim, no em dashes', () => {
    const scenarios: DisplaySummaryInput[] = [
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS)),
      input(DROUGHT_KEYS, allReady(DROUGHT_KEYS), { framing: 'mexico' }),
      input(REFERENCE_KEYS, allReady(REFERENCE_KEYS), { cluster: 'heat' }),
      input([...REFERENCE_KEYS, 'sst-anomaly'], allReady([...REFERENCE_KEYS, 'sst-anomaly']), {
        cluster: 'enso'
      }),
      input(DROUGHT_KEYS, { ...allReady(REFERENCE_KEYS), usdm: 'error', hillshade: 'zoom-in' })
    ];
    for (const scenario of scenarios) {
      const summary = deriveDisplaySummary(scenario);
      for (const text of [summary.primary, summary.caveat ?? '']) {
        expect(text).not.toContain('\u2014');
        expect(text.toLowerCase()).not.toContain('marine heatwave');
        expect(text.toLowerCase()).not.toContain('multi-source');
      }
    }
  });

  test('first-use acronym expansion in prose: CPC, NIFC, and HMS spell out (DG-080 finding 7, r2 finding 5)', () => {
    const droughtOutlook = deriveDisplaySummary(
      input([...REFERENCE_KEYS, 'drought'], allReady([...REFERENCE_KEYS, 'drought']))
    );
    // The parent agency spells out too: a bare "NOAA" would itself be an
    // unexpanded first use in the summary prose.
    expect(droughtOutlook.primary).toContain(
      'Drought Outlook (National Oceanic and Atmospheric Administration Climate Prediction Center, CPC)'
    );
    expect(droughtOutlook.primary).not.toContain('(NOAA Climate');
    const smoke = deriveDisplaySummary(
      input(['hms-smoke'], { 'hms-smoke': 'ready' }, { cluster: 'custom' })
    );
    expect(smoke.primary).toContain('Smoke Plumes (Hazard Mapping System, HMS)');
  });

  test('cluster custom with nothing intended is honest about an empty display', () => {
    const summary = deriveDisplaySummary(input([], {}, { cluster: 'custom' }));
    expect(summary.primary).toBe('No layers are displayed yet.');
    expect(summary.caveat).toBeNull();
  });
});
