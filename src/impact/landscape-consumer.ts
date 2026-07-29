/**
 * T3-2 landscape-signature briefing consumer.
 *
 * Resolution is deliberately exact and narrow. EPA Omernik Level III and
 * Level IV selections carry the same issuer codes that key the baked
 * signature, so those selections resolve directly. State, Tribal, Treaty,
 * and watershed polygons do not correspond to one ecoregion bundle. This
 * consumer does not substitute a centroid, a click point, or one intersecting
 * ecoregion for those areal selections.
 *
 * The artifact is loaded only after an exact ecoregion key is present. The
 * caller owns cancellation and drops a result after its signal is aborted.
 */

import {
  isFbfm40Signature,
  isLandscapeBundle,
  isLandscapeSource,
  isLandcoverFuelsSignature,
  isLandcoverSignature,
  isSoilSignature,
  isTerrainSignature,
  isWhpSignature,
  loadLandscapeSignatureAtUrl
} from './landscape';
import type {
  LandscapeSignatureResult,
  LandscapeSignatureSnapshot,
  LandscapeSource
} from './landscape';
import type {
  LandscapeContext,
  LandscapeContextFact,
  LandscapeContextSource
} from './types';
import type { LandscapeEcoregionKey } from './landscape-resolution';
import { LANDSCAPE_SIGNATURE_LOCAL_URL } from '../config/landscape-url';

type LandscapeLoader = (
  opts?: Parameters<typeof loadLandscapeSignatureAtUrl>[1]
) => Promise<LandscapeSignatureResult>;

export interface LandscapeConsumerOptions {
  readonly load?: LandscapeLoader;
  readonly signal?: AbortSignal | null;
}

const SOURCE_KEYS_BY_FACT: Readonly<
  Record<LandscapeContextFact['key'], readonly string[]>
> = {
  terrain: ['terrain'],
  soil: ['soilMukey', 'soilSda'],
  landcover: ['landcoverNlcd'],
  fuels: ['fuelsFbfm40', 'hazardWhp']
};

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatPercent(value: number): string {
  return `${formatNumber(value * 100, 1)}%`;
}

function fbfm40Label(code: number): string {
  const families = [
    { min: 101, max: 109, prefix: 'GR', label: 'grass' },
    { min: 121, max: 124, prefix: 'GS', label: 'grass-shrub' },
    { min: 141, max: 149, prefix: 'SH', label: 'shrub' },
    { min: 161, max: 165, prefix: 'TU', label: 'timber understory' },
    { min: 181, max: 189, prefix: 'TL', label: 'timber litter' },
    { min: 201, max: 204, prefix: 'SB', label: 'slash-blowdown' }
  ] as const;
  const family = families.find(
    (candidate) => code >= candidate.min && code <= candidate.max
  );
  if (!family) return `issuer code ${formatNumber(code)}`;
  const ordinal = code - family.min + 1;
  return `${family.label} model ${ordinal} (${family.prefix}${ordinal}; issuer code ${code})`;
}

function terrainFact(bundle: Record<string, unknown>): LandscapeContextFact | null {
  if (!isTerrainSignature(bundle.terrain)) return null;
  const terrain = bundle.terrain;
  const slope =
    terrain.slopeMeanDeg === null
      ? ''
      : ` Mean slope is ${formatNumber(terrain.slopeMeanDeg, 1)} degrees.`;
  return {
    key: 'terrain',
    label: 'Terrain',
    text:
      `Mean elevation is ${formatNumber(terrain.elevMeanM)} m ` +
      `(${formatNumber(terrain.elevMinM)} to ${formatNumber(terrain.elevMaxM)} m).` +
      slope +
      ` Terrain coverage is ${formatNumber(terrain.coveragePct, 1)}%.`
  };
}

function soilFact(bundle: Record<string, unknown>): LandscapeContextFact | null {
  if (!isSoilSignature(bundle.soil)) return null;
  const soil = bundle.soil;
  const depth =
    soil.rootZoneDepthCm === null
      ? ''
      : ` Estimated root-zone depth is ${formatNumber(soil.rootZoneDepthCm)} cm.`;
  const texture =
    soil.dominantTexture === null
      ? ''
      : ` Dominant surface texture is ${soil.dominantTexture}.`;
  const qualifiers = [
    soil.generalized
      ? 'The soil summary is generalized because STATSGO2 supplies most of its area.'
      : '',
    soil.coarse
      ? 'The soil summary is coarse because the effective cell count is below the artifact threshold.'
      : ''
  ].filter(Boolean);
  return {
    key: 'soil',
    label: 'Soil water storage',
    text:
      `Root-zone available water storage is ${formatNumber(soil.awsRootZoneMm)} mm; ` +
      `the within-ecoregion 10th to 90th percentile is ` +
      `${formatNumber(soil.awsP10)} to ${formatNumber(soil.awsP90)} mm.` +
      depth +
      texture +
      ` Soil coverage is ${formatNumber(soil.coveragePct, 1)}%.`,
    ...(qualifiers.length > 0 ? { note: qualifiers.join(' ') } : {})
  };
}

function landcoverFact(
  bundle: Record<string, unknown>
): LandscapeContextFact | null {
  if (!isLandcoverFuelsSignature(bundle.landcoverFuels)) return null;
  const landcover = bundle.landcoverFuels.landcover;
  if (!isLandcoverSignature(landcover)) return null;
  return {
    key: 'landcover',
    label: 'Land cover',
    text:
      `Forest ${formatPercent(landcover.forestFraction)}; ` +
      `cropland ${formatPercent(landcover.croplandFraction)}; ` +
      `wetland ${formatPercent(landcover.wetlandFraction)}; ` +
      `open water ${formatPercent(landcover.openWaterFraction)}. ` +
      `Land-cover coverage is ${formatNumber(landcover.coveragePct, 1)}%.`
  };
}

function fuelsFact(bundle: Record<string, unknown>): LandscapeContextFact | null {
  if (!isLandcoverFuelsSignature(bundle.landcoverFuels)) return null;
  const { fbfm40, whp } = bundle.landcoverFuels;
  const parts: string[] = [];
  const notes: string[] = [];

  if (
    isFbfm40Signature(fbfm40) &&
    fbfm40.dominantCode !== null &&
    fbfm40.dominantFraction !== null
  ) {
    parts.push(
      `The largest modeled surface-fuel share is ${fbfm40Label(
        fbfm40.dominantCode
      )}, at ${formatPercent(fbfm40.dominantFraction)}.`
    );
  }
  if (isWhpSignature(whp)) {
    const fraction = whp.classFractions;
    parts.push(
      `Wildfire Hazard Potential shares are Very Low ${formatPercent(
        fraction['1']
      )}, Low ${formatPercent(fraction['2'])}, Moderate ${formatPercent(
        fraction['3']
      )}, High ${formatPercent(fraction['4'])}, Very High ${formatPercent(
        fraction['5']
      )}, non-burnable ${formatPercent(fraction['6'])}, and water ${formatPercent(
        fraction['7']
      )}. WHP coverage is ${formatNumber(whp.coveragePct, 1)}%.`
    );
    notes.push(
      'Wildfire Hazard Potential is 270 m static landscape context, not a current condition or risk reading.'
    );
    if (whp.coarse) {
      notes.push(
        'The WHP summary is coarse because fewer than 30 effective source cells cover this ecoregion.'
      );
    }
  }

  return parts.length === 0
    ? null
    : {
        key: 'fuels',
        label: 'Surface fuels and long-term hazard potential',
        text: parts.join(' '),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {})
      };
}

function sourceContext(
  key: string,
  value: unknown
): LandscapeContextSource | null {
  if (!isLandscapeSource(value)) return null;
  const source = value as LandscapeSource;
  return {
    key,
    label: source.source,
    ...(source.sourceUrl.startsWith('https://')
      ? { url: source.sourceUrl }
      : {}),
    vintage: source.vintage,
    ...(source.acquired ? { acquired: source.acquired } : {}),
    methodVersion: source.methodVersion
  };
}

function sourceRows(
  snapshot: LandscapeSignatureSnapshot,
  facts: readonly LandscapeContextFact[]
): LandscapeContextSource[] {
  const wanted = new Set(
    facts.flatMap((fact) => SOURCE_KEYS_BY_FACT[fact.key])
  );
  const rows: LandscapeContextSource[] = [];
  for (const key of wanted) {
    const row = sourceContext(key, snapshot.sources[key]);
    if (row) rows.push(row);
  }
  return rows;
}

function missingFamilyNote(
  bundle: Record<string, unknown>,
  facts: readonly LandscapeContextFact[]
): string | undefined {
  const present = new Set(facts.map((fact) => fact.key));
  const missing = [
    !present.has('terrain') ? 'terrain' : '',
    !present.has('soil') ? 'soil' : '',
    !present.has('landcover') ? 'land cover' : '',
    !present.has('fuels') ? 'fuels and Wildfire Hazard Potential' : ''
  ].filter(Boolean);
  if (missing.length === 0) return undefined;
  const ledger = Array.isArray(bundle.unavailable)
    ? bundle.unavailable.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const ledgerText =
    ledger.length > 0 ? ` Artifact ledger: ${ledger.join(', ')}.` : '';
  return `This bundle has no readable ${missing.join(', ')} context.${ledgerText}`;
}

/**
 * Resolve and compose the landscape context for one exact ecoregion key.
 * Never throws for artifact absence.
 */
export async function resolveLandscapeContext(
  selected: LandscapeEcoregionKey,
  opts: LandscapeConsumerOptions = {}
): Promise<LandscapeContext> {
  const load =
    opts.load ??
    ((loadOpts) =>
      loadLandscapeSignatureAtUrl(
        LANDSCAPE_SIGNATURE_LOCAL_URL,
        loadOpts
      ));
  const loaded = await load({ signal: opts.signal ?? null });
  if (!loaded.ok) {
    return {
      status: 'unavailable',
      note: loaded.note,
      facts: [],
      sources: []
    };
  }

  const rawBundle = loaded.snapshot.bundles[selected.code];
  if (!isLandscapeBundle(rawBundle)) {
    return {
      status: 'unavailable',
      note:
        `No valid Level ${selected.level === 3 ? 'III' : 'IV'} landscape-signature bundle is available for ecoregion ${selected.code}.`,
      facts: [],
      sources: []
    };
  }
  const bundleCode =
    rawBundle.level === 4 ? rawBundle.usL4Code : rawBundle.usL3Code;
  if (rawBundle.level !== selected.level || bundleCode !== selected.code) {
    return {
      status: 'unavailable',
      note:
        'The landscape-signature bundle did not match the selected ecoregion level and code.',
      facts: [],
      sources: []
    };
  }

  const rawRecord = rawBundle as unknown as Record<string, unknown>;
  const facts = [
    terrainFact(rawRecord),
    soilFact(rawRecord),
    landcoverFact(rawRecord),
    fuelsFact(rawRecord)
  ].filter((fact): fact is LandscapeContextFact => fact !== null);
  if (facts.length === 0) {
    return {
      status: 'unavailable',
      note:
        'The selected ecoregion bundle contains no readable terrain, soil, land-cover, or fuels context.',
      facts: [],
      sources: []
    };
  }

  const levelLabel = rawBundle.level === 3 ? 'Level III' : 'Level IV';
  const name =
    rawBundle.level === 4 ? rawBundle.usL4Name : rawBundle.usL3Name;
  const partialNote = missingFamilyNote(rawRecord, facts);
  return {
    status: 'ready',
    ...(partialNote ? { note: partialNote } : {}),
    ecoregion: {
      level: rawBundle.level,
      code: bundleCode,
      name
    },
    support:
      `This signature summarizes the full EPA Omernik ${levelLabel} ecoregion ` +
      `on a ${formatNumber(loaded.snapshot.gridResolutionMeters)} m analysis grid. ` +
      'It is static landscape context, not current conditions or a point reading.',
    artifactDate: loaded.snapshot.retrieved,
    analysisCrs: loaded.snapshot.analysisCrs,
    gridResolutionMeters: loaded.snapshot.gridResolutionMeters,
    facts,
    sources: sourceRows(loaded.snapshot, facts)
  };
}
