/**
 * Shared MapLibre Style Spec expression builders.
 *
 * `match` is the one operator this module builds by hand often enough to be
 * worth centralizing. The Style Spec types it as
 * `['match', input, label, output, ...rest, default]`, so the FIRST
 * label/output pair sits in fixed tuple slots that a spread of a plain
 * (non-tuple) array cannot fill. Every palette-driven layer therefore has to
 * split its pair list into a head pair and a tail before `tsc` will accept the
 * literal without an `as unknown as` escape.
 *
 * That split is correct for every palette with at least one pair and wrong for
 * an empty one: destructuring an empty list binds `undefined` to both head
 * slots and emits `['match', input, undefined, undefined, default]`. MapLibre
 * rejects that at style-load time, far from the palette that caused it, with an
 * error that names the layer rather than the constant. (The pre-split code was
 * no better: it emitted `['match', input, default]`, which MapLibre also
 * rejects. Neither shape is usable, so nothing here preserves the empty-palette
 * behavior of either.)
 *
 * Palettes in this module's callers are module-level constants, so an empty one
 * is a configuration defect rather than a runtime state. `matchExpression`
 * throws on it, naming the palette, at the point where the defect exists.
 */

import type maplibregl from 'maplibre-gl';

/** Scalar accepted in a Style Spec expression slot. */
type ExpressionInput = string | number | boolean;

/** A `match` label: one scalar, or a list of scalars sharing one output. */
export type MatchLabel = ExpressionInput | ExpressionInput[];

/** A `match` output: a scalar, or a nested expression. */
export type MatchOutput = ExpressionInput | maplibregl.ExpressionSpecification;

/** One label/output pair of a `match` expression. */
export type MatchPair = readonly [MatchLabel, MatchOutput];

/**
 * Build a Style Spec `match` expression from a palette of label/output pairs.
 *
 * @param input The expression (or scalar) whose value is matched.
 * @param pairs Label/output pairs, in emission order. Must not be empty.
 * @param fallback The `default` output used when no label matches.
 * @param paletteName Name of the source constant, quoted in the empty-palette
 *   error so the failure points at the palette rather than at this helper.
 * @throws Error when `pairs` is empty, because no valid `match` exists for a
 *   palette with no cases.
 */
export function matchExpression(
  input: ExpressionInput | maplibregl.ExpressionSpecification,
  pairs: readonly MatchPair[],
  fallback: MatchOutput,
  paletteName = 'the palette'
): maplibregl.ExpressionSpecification {
  if (pairs.length === 0) {
    throw new Error(
      `matchExpression: ${paletteName} is empty. A Style Spec \`match\` needs ` +
        'at least one label/output pair, so an empty palette cannot produce a ' +
        'valid expression. Populate the palette constant.'
    );
  }
  const [[firstLabel, firstOutput], ...rest] = pairs;
  return [
    'match',
    input,
    firstLabel,
    firstOutput,
    ...rest.flatMap(([label, output]) => [label, output]),
    fallback
  ];
}
