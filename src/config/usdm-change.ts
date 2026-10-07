import type { ExpressionSpecification } from 'maplibre-gl';
import { USDM_CHANGE_COLORS } from './palette';

export function usdmChangeColor(dn: unknown): string | undefined {
  if (typeof dn !== 'number' || !Number.isInteger(dn) || dn < -5 || dn > 5) return undefined;
  return USDM_CHANGE_COLORS.find(entry => entry.dn === dn)?.color;
}

/** Existing approved signed-change label template, limited to issuer classes. */
export function usdmChangeLabel(dn: unknown): string {
  if (typeof dn !== 'number' || usdmChangeColor(dn) === undefined) return 'Unknown change class';
  if (dn === 0) return 'No category change';
  const dir = dn > 0 ? 'Worsened' : 'Improved';
  const steps = Math.abs(dn);
  return `${dir} ${steps} ${steps === 1 ? 'category' : 'categories'}`;
}

export function buildUsdmChangeColorExpression(): ExpressionSpecification {
  const [first, ...remaining] = USDM_CHANGE_COLORS;
  return ['match', ['get', 'DN'], first.dn, first.color,
    ...remaining.flatMap(({ dn, color }) => [dn, color]),
    'rgba(0,0,0,0)'];
}

export function usdmChangeLegendItems(): Array<{ color: string; label: string }> {
  return USDM_CHANGE_COLORS.map(({ dn, color }) => ({ color, label: usdmChangeLabel(dn) }));
}
