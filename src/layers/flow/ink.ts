/**
 * Flow ink (design/moving-paths.md section 6; DR-101): hue-free achromatic
 * tokens, so hue stays with the surface underneath. Each class steps width
 * with luminance because adjacent classes differ only weakly in luminance.
 * A cased mark clears 3:1 over any ground: the worst ground makes core and
 * casing equally contrasting, which is sqrt(core-to-casing contrast).
 */
import type { FlowClass } from './field';

export type FlowInkName = 'light' | 'dark';

export interface FlowInk {
  /** Core colour per class: slow, middle, fast. */
  readonly core: readonly [string, string, string];
  readonly casing: string;
}

export const FLOW_INK: Readonly<Record<FlowInkName, FlowInk>> = {
  // --flow-ink-1..3 and --flow-casing, light ink (default)
  light: { core: ['#C6CBD4', '#E8ECF0', '#FFFFFF'], casing: '#010B13' },
  // dark ink (flowink=dark)
  dark: { core: ['#3B3B3B', '#1E242C', '#010B13'], casing: '#FFFFFF' }
};

/** Core line width in CSS px per class. */
export const FLOW_CORE_WIDTH_PX: readonly [number, number, number] = [1.0, 1.5, 2.0];
/** Casing width in CSS px on each side of the core. */
export const FLOW_CASING_WIDTH_PX = 0.75;
/** Casing alpha as a fraction of the core alpha. */
export const FLOW_CASING_ALPHA = 0.8;
/** Head alpha of a moving ribbon; it falls linearly to 0 at the tail. */
export const FLOW_HEAD_ALPHA = 0.95;

export function coreWidth(cls: FlowClass): number {
  return FLOW_CORE_WIDTH_PX[cls];
}

/** '#RRGGBB' as sRGB channels in 0..1, for shader uniforms. */
export function inkRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** WCAG 2.x relative luminance of '#RRGGBB'. */
export function relativeLuminance(hex: string): number {
  const lin = inkRgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] as number) + 0.7152 * (lin[1] as number) + 0.0722 * (lin[2] as number);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
