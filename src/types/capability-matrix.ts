/**
 * Coverage/capability matrix types (0.8.0 T-P0-3). The matrix records, as
 * data rather than prose, what the module can actually do for each coverage
 * family across five capability axes. It exists so honesty about coverage is
 * checkable: the consistency spec (tests/capability-matrix.spec.ts) enforces
 * the cross-axis rules and the generated doc (docs/COVERAGE_MATRIX.md) is
 * gate-checked against the source module, never hand-edited.
 */

/**
 * The five coverage families, matching the 0.8.0 BRIEF's breadth track
 * (PNW / CONUS / AK-HI / Canada / transboundary). Keys are durable
 * identifiers; display names live in COVERAGE_FAMILY_LABELS.
 */
export type CoverageFamilyKey =
  | 'pnw'
  | 'conus'
  | 'ak-hi'
  | 'canada'
  | 'transboundary';

/**
 * The five capability axes:
 * - display: shipped, validated condition surfaces render for the
 *   geography (a camera framing alone does not qualify; several framings
 *   deliberately show geography whose condition sources are US-scoped);
 * - selectablePlace: places there can be selected and identified;
 * - droughtState: a drought condition surface is available there;
 * - landscapeSignature: baked terrain/soil/fuels context exists there;
 * - impactSynthesis: the briefing composes an impact read there.
 */
export type CapabilityAxisKey =
  | 'display'
  | 'selectablePlace'
  | 'droughtState'
  | 'landscapeSignature'
  | 'impactSynthesis';

/** Ordered capability levels; 'partial' always carries a qualifying note. */
export type CapabilityLevel = 'full' | 'partial' | 'none';

/** One cell: the level plus a one-line honest note (never empty). */
export interface CapabilityCell {
  readonly level: CapabilityLevel;
  readonly note: string;
}

/** One family's read across every axis. */
export type CapabilityRow = Readonly<Record<CapabilityAxisKey, CapabilityCell>>;

/** The whole matrix: every family, every axis, no holes (typechecked). */
export type CapabilityMatrix = Readonly<
  Record<CoverageFamilyKey, CapabilityRow>
>;
