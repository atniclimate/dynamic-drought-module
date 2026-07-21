/**
 * Dependency-light charts: hand-authored inline SVG, no charting library.
 *
 * Every chart is a pure function returning an SVG string. The charts are themed
 * with the app's CSS custom properties (inline SVG injected into the page
 * inherits `:root` tokens, so `fill="var(--accent)"` just works), carry a
 * `role="img"` and a `<title>` text alternative, scale via a `viewBox` (no
 * fixed pixel width that would overflow a narrow embed), and use no animation
 * (so `prefers-reduced-motion` is inherently respected). Meaning is never
 * carried by hue alone: every series and segment is directly labeled.
 *
 * Honesty rules (ddm-data-visualization; CLAUDE.md section 6 invariant 6):
 * observations are plotted solid; a probabilistic outlook is rendered as a
 * probability (tercile split), never collapsed to a single deterministic line.
 * A small attribution names the source and, where relevant, the issuance date,
 * so the chart is self-documenting when embedded or screenshotted.
 *
 * Used by the impact panel (DSCI trend, CPC outlook bars, ENSO bars) and the
 * telemetry popup (streamflow sparkline).
 */

import { escapeHtml } from '../util/escape';

/**
 * Wrap chart inner markup in an accessible, responsive SVG. `title` is the text
 * alternative announced by assistive tech. The SVG fills its container width
 * and scales by its `viewBox` aspect ratio.
 */
function svgWrap(w: number, h: number, title: string, inner: string): string {
  return (
    `<svg class="ddm-chart" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="${escapeHtml(title)}" xmlns="http://www.w3.org/2000/svg">` +
    `<title>${escapeHtml(title)}</title>${inner}</svg>`
  );
}

/** A small attribution line at the bottom of a chart. */
function attribution(x: number, y: number, text: string): string {
  return `<text x="${x}" y="${y}" class="ddm-chart-attrib" fill="var(--fg-3)" font-size="8">${escapeHtml(text)}</text>`;
}

// ---------------------------------------------------------------------------
// Sparkline (telemetry popup)
// ---------------------------------------------------------------------------

export interface SparklineOptions {
  /** Text alternative / title. */
  readonly title: string;
  /** Unit label appended to the current-value readout, for example "ft3/s". */
  readonly unit?: string;
  /** Source attribution line. */
  readonly source?: string;
}

/**
 * Render a single numeric series as a sparkline: a thin line with a
 * current-value dot and min and max labels. Legible at a few hundred pixels
 * wide in a narrow popup; tick labels are dropped before the data is. Returns
 * an empty string for fewer than two points (nothing meaningful to draw).
 */
export function sparklineSvg(values: readonly number[], opts: SparklineOptions): string {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return '';

  const w = 240;
  const h = 56;
  const padX = 6;
  const padTop = 6;
  const padBottom = 16;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const plotW = w - padX * 2;
  const plotH = h - padTop - padBottom;

  const x = (i: number): number => padX + (i / (clean.length - 1)) * plotW;
  const y = (v: number): number => padTop + (1 - (v - min) / span) * plotH;

  const points = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastIdx = clean.length - 1;
  const lastVal = clean[lastIdx] as number;
  const unit = opts.unit ? ` ${opts.unit}` : '';

  const inner =
    `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${x(lastIdx).toFixed(1)}" cy="${y(lastVal).toFixed(1)}" r="2.6" fill="var(--accent)"/>` +
    `<text x="${padX}" y="${h - 4}" fill="var(--fg-3)" font-size="8">min ${min.toLocaleString()}</text>` +
    `<text x="${w - padX}" y="${h - 4}" fill="var(--fg-3)" font-size="8" text-anchor="end">max ${max.toLocaleString()}</text>` +
    `<text x="${x(lastIdx).toFixed(1)}" y="${(y(lastVal) - 5).toFixed(1)}" fill="var(--fg-0)" font-size="9" text-anchor="end" font-weight="600">${lastVal.toLocaleString()}${escapeHtml(unit)}</text>` +
    (opts.source ? attribution(padX, h - 4 + 9, opts.source) : '');

  return `<figure class="ddm-chart-fig">${svgWrap(w, h, opts.title, inner)}</figure>`;
}

// ---------------------------------------------------------------------------
// Trend line (DSCI 0..500)
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** Epoch milliseconds (x). */
  readonly t: number;
  /** Value (y). */
  readonly v: number;
}

export interface TrendOptions {
  readonly title: string;
  /** Y-axis maximum (DSCI is 0..500). */
  readonly yMax: number;
  /** Y-axis label, for example "DSCI". */
  readonly yLabel: string;
  readonly source?: string;
}

/**
 * Render an observed time series as a solid trend line on a zero baseline (the
 * Drought Severity and Coverage Index, DSCI, runs 0 to 500). The full series is
 * observation, so it is drawn solid throughout; the current value is dotted and
 * labeled. Returns an empty string for fewer than two points.
 */
export function trendLineSvg(points: readonly TrendPoint[], opts: TrendOptions): string {
  const clean = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).slice().sort((a, b) => a.t - b.t);
  if (clean.length < 2) return '';

  const w = 280;
  const h = 96;
  const padL = 26;
  const padR = 8;
  const padTop = 10;
  const padBottom = 22;
  const plotW = w - padL - padR;
  const plotH = h - padTop - padBottom;

  const t0 = clean[0]!.t;
  const t1 = clean[clean.length - 1]!.t;
  const tSpan = t1 - t0 || 1;
  const yMax = opts.yMax;

  const x = (t: number): number => padL + ((t - t0) / tSpan) * plotW;
  const y = (v: number): number => padTop + (1 - Math.min(v, yMax) / yMax) * plotH;

  const linePts = clean.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = clean[clean.length - 1]!;

  // Baseline + a single mid gridline at half the axis, both low contrast.
  const baselineY = (padTop + plotH).toFixed(1);
  const midY = y(yMax / 2).toFixed(1);

  const inner =
    `<line x1="${padL}" y1="${baselineY}" x2="${w - padR}" y2="${baselineY}" stroke="var(--line)" stroke-width="1"/>` +
    `<line x1="${padL}" y1="${midY}" x2="${w - padR}" y2="${midY}" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2 3"/>` +
    `<text x="2" y="${(padTop + 4).toFixed(1)}" fill="var(--fg-3)" font-size="8">${opts.yMax}</text>` +
    `<text x="2" y="${baselineY}" fill="var(--fg-3)" font-size="8">0</text>` +
    `<text x="2" y="${(padTop + plotH / 2 + 3).toFixed(1)}" fill="var(--fg-3)" font-size="8">${Math.round(opts.yMax / 2)}</text>` +
    `<polyline points="${linePts}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.8" fill="var(--accent)"/>` +
    `<text x="${(x(last.t) - 3).toFixed(1)}" y="${(y(last.v) - 5).toFixed(1)}" fill="var(--fg-0)" font-size="9" text-anchor="end" font-weight="600">${escapeHtml(opts.yLabel)} ${Math.round(last.v)}</text>` +
    (opts.source ? attribution(padL, h - 4, opts.source) : '');

  return `<figure class="ddm-chart-fig">${svgWrap(w, h, opts.title, inner)}</figure>`;
}

// ---------------------------------------------------------------------------
// Stacked probability bar (shared by CPC outlook terciles and ENSO)
// ---------------------------------------------------------------------------

export interface ProbSegment {
  readonly label: string;
  /** Percent (0..100). */
  readonly pct: number;
  /** Token-based fill: a CSS color or `var(--token)`. */
  readonly fill: string;
  /** True to emphasize this segment (the favored one). */
  readonly emphasis?: boolean;
}

/**
 * Render a horizontal stacked-probability bar with each segment directly
 * labeled by name and percent, so meaning never rests on hue alone. Used for a
 * Climate Prediction Center below/near/above tercile split and for an El Nino /
 * Southern Oscillation (ENSO) probability split. Probabilities are rendered as
 * probabilities, never collapsed to a single value.
 */
export function stackedProbabilityBarsSvg(segments: readonly ProbSegment[], title: string, source?: string): string {
  const total = segments.reduce((s, seg) => s + Math.max(0, seg.pct), 0) || 100;
  const w = 280;
  const h = 54;
  const padX = 6;
  const barY = 8;
  const barH = 16;
  const plotW = w - padX * 2;

  let cursor = padX;
  const rects: string[] = [];
  const labels: string[] = [];
  for (const seg of segments) {
    const segW = (Math.max(0, seg.pct) / total) * plotW;
    rects.push(
      `<rect x="${cursor.toFixed(1)}" y="${barY}" width="${segW.toFixed(1)}" height="${barH}" fill="${seg.fill}" ` +
        `${seg.emphasis ? 'stroke="var(--fg-0)" stroke-width="1"' : 'stroke="var(--bg-1)" stroke-width="0.5"'}/>`
    );
    const cx = cursor + segW / 2;
    if (segW > 26) {
      labels.push(
        `<text x="${cx.toFixed(1)}" y="${barY + barH + 11}" fill="var(--fg-1)" font-size="8.5" text-anchor="middle">${escapeHtml(seg.label)} ${Math.round(seg.pct)}%</text>`
      );
    }
    cursor += segW;
  }

  const inner = rects.join('') + labels.join('') + (source ? attribution(padX, h - 2, source) : '');
  return `<figure class="ddm-chart-fig">${svgWrap(w, h, title, inner)}</figure>`;
}

// ---------------------------------------------------------------------------
// Observed ONI line (El Nino / Southern Oscillation index history)
// ---------------------------------------------------------------------------

export interface OniPoint {
  /** Season label, for example "DJF". */
  readonly seas: string;
  readonly year: number;
  /** ONI anomaly (signed, in degrees Celsius). */
  readonly anom: number;
}

/** A comparison series (for example RONI) plotted dashed alongside the primary. */
export interface OniCompareSeries {
  readonly values: readonly OniPoint[];
  /** Short label, for example "RONI". */
  readonly label: string;
}

export interface OniLineOptions {
  readonly title: string;
  readonly source: string;
  /** Label for the primary series; defaults to "ONI". */
  readonly primaryLabel?: string;
  /** Optional second series (RONI) plotted dashed, with a legend. */
  readonly compare?: OniCompareSeries;
}

/** Format a signed anomaly with a leading sign, for example "+0.11" or "-0.48". */
function signedAnom(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/**
 * Render the observed Oceanic Nino Index (ONI) history as a centered signed
 * line with the El Nino (+0.5) and La Nina (-0.5) threshold guides and a zero
 * line. This is observation (a measured index), so it is drawn solid; the
 * current value is dotted. An optional comparison series (the Relative ONI,
 * RONI) is plotted dashed so the warming-adjusted reading can be seen against
 * the raw index; a small legend carries each series and its current value, so
 * meaning never rests on line style alone. Threshold guides are dashed and
 * directly labeled. Returns an empty string for fewer than two points.
 */
export function oniLineSvg(values: readonly OniPoint[], opts: OniLineOptions): string {
  const pts = values.filter((p) => Number.isFinite(p.anom));
  if (pts.length < 2) return '';
  const cmp = opts.compare ? opts.compare.values.filter((p) => Number.isFinite(p.anom)) : [];
  const primaryLabel = opts.primaryLabel ?? 'ONI';

  const w = 280;
  const h = 120;
  const padL = 22;
  const padR = 8;
  const padTop = 22; // room for the legend row
  const padBottom = 24;
  const plotW = w - padL - padR;
  const plotH = h - padTop - padBottom;

  // Symmetric y range covering both series and the thresholds, clamped to a
  // sensible minimum so a quiet neutral stretch is not over-magnified.
  const maxAbs = Math.max(1.5, ...pts.map((p) => Math.abs(p.anom)), ...cmp.map((p) => Math.abs(p.anom)));
  const xOf = (i: number, n: number): number => padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number): number => padTop + (1 - (v + maxAbs) / (2 * maxAbs)) * plotH;

  const zeroY = y(0).toFixed(1);
  const elY = y(0.5).toFixed(1);
  const laY = y(-0.5).toFixed(1);

  const primaryPts = pts.map((p, i) => `${xOf(i, pts.length).toFixed(1)},${y(p.anom).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1] as OniPoint;

  const guides =
    `<line x1="${padL}" y1="${zeroY}" x2="${w - padR}" y2="${zeroY}" stroke="var(--line-strong)" stroke-width="0.7"/>` +
    `<line x1="${padL}" y1="${elY}" x2="${w - padR}" y2="${elY}" stroke="var(--warn)" stroke-width="0.6" stroke-dasharray="3 3"/>` +
    `<line x1="${padL}" y1="${laY}" x2="${w - padR}" y2="${laY}" stroke="var(--accent)" stroke-width="0.6" stroke-dasharray="3 3"/>` +
    `<text x="${w - padR}" y="${(Number(elY) - 2).toFixed(1)}" fill="var(--warn)" font-size="7.5" text-anchor="end">El Nino +0.5</text>` +
    `<text x="${w - padR}" y="${(Number(laY) + 8).toFixed(1)}" fill="var(--accent)" font-size="7.5" text-anchor="end">La Nina -0.5</text>`;

  // Legend (top-left): a solid swatch for the primary, a dashed swatch for the
  // comparison, each with its current value.
  let legend =
    `<line x1="${padL}" y1="6" x2="${padL + 12}" y2="6" stroke="var(--fg-0)" stroke-width="1.6"/>` +
    `<text x="${padL + 16}" y="9" fill="var(--fg-1)" font-size="8">${escapeHtml(primaryLabel)} ${signedAnom(last.anom)}</text>`;
  let comparePoly = '';
  let compareDot = '';
  if (cmp.length >= 2) {
    const cmpLast = cmp[cmp.length - 1] as OniPoint;
    const cmpPts = cmp.map((p, i) => `${xOf(i, cmp.length).toFixed(1)},${y(p.anom).toFixed(1)}`).join(' ');
    comparePoly = `<polyline points="${cmpPts}" fill="none" stroke="var(--fg-2)" stroke-width="1.2" stroke-dasharray="4 2" stroke-linejoin="round"/>`;
    compareDot = `<circle cx="${xOf(cmp.length - 1, cmp.length).toFixed(1)}" cy="${y(cmpLast.anom).toFixed(1)}" r="2.4" fill="var(--fg-2)"/>`;
    legend +=
      `<line x1="${padL + 110}" y1="6" x2="${padL + 122}" y2="6" stroke="var(--fg-2)" stroke-width="1.4" stroke-dasharray="4 2"/>` +
      `<text x="${padL + 126}" y="9" fill="var(--fg-1)" font-size="8">${escapeHtml(opts.compare!.label)} ${signedAnom(cmpLast.anom)}</text>`;
  }

  const firstLabel = `${pts[0]!.seas} ${pts[0]!.year}`;
  const lastLabel = `${last.seas} ${last.year}`;

  const inner =
    guides +
    legend +
    comparePoly +
    `<polyline points="${primaryPts}" fill="none" stroke="var(--fg-0)" stroke-width="1.4" stroke-linejoin="round"/>` +
    compareDot +
    `<circle cx="${xOf(pts.length - 1, pts.length).toFixed(1)}" cy="${y(last.anom).toFixed(1)}" r="2.8" fill="var(--fg-0)"/>` +
    `<text x="${padL}" y="${h - 12}" fill="var(--fg-3)" font-size="7.5">${escapeHtml(firstLabel)}</text>` +
    `<text x="${w - padR}" y="${h - 12}" fill="var(--fg-3)" font-size="7.5" text-anchor="end">${escapeHtml(lastLabel)}</text>` +
    attribution(padL, h - 2, opts.source);

  return `<figure class="ddm-chart-fig">${svgWrap(w, h, opts.title, inner)}</figure>`;
}

// ---------------------------------------------------------------------------
// ENSO probability plume (DORMANT since 2026-07-21, T-P0-1: the CPC HTML
// scrape that fed it was removed per the anti-scrape doctrine, so no current
// snapshot carries a probabilities block and this chart never renders. The
// machinery is reserved for a documented machine feed or an explicitly-labeled
// modeled NMME ensemble (workplan T-V0-3 / U-ENSO-REPAIR).
// ---------------------------------------------------------------------------

export interface EnsoPlumePoint {
  /** Overlapping three-month season code, for example "MJJ". */
  readonly seas: string;
  /** Integer percent chance of La Nina. */
  readonly laNina: number;
  /** Integer percent chance of ENSO-neutral. */
  readonly neutral: number;
  /** Integer percent chance of El Nino. */
  readonly elNino: number;
}

export interface EnsoPlumeOptions {
  readonly title: string;
  readonly source: string;
}

/**
 * The ENSO probability plume: three probability lines (chance of El Nino,
 * neutral, and La Nina) across the CPC outlook's overlapping three-month
 * seasons. Odds, never outcomes: the y axis is percent probability, every
 * line is labeled with its terminal value, and guides sit at 25/50/75 so
 * "likely" reads against an explicit scale rather than an impression. Warm
 * amber for El Nino, cool cyan for La Nina, grey for neutral, matching the
 * tilt-color language used in the outlook bars.
 */
export function ensoPlumeSvg(
  seasons: readonly EnsoPlumePoint[],
  opts: EnsoPlumeOptions
): string {
  const pts = seasons.filter(
    (p) =>
      Number.isFinite(p.laNina) && Number.isFinite(p.neutral) && Number.isFinite(p.elNino)
  );
  if (pts.length < 2) return '';

  const w = 280;
  const h = 130;
  const padL = 26;
  const padR = 8;
  const padTop = 22;
  const padBottom = 24;
  const plotW = w - padL - padR;
  const plotH = h - padTop - padBottom;

  const xOf = (i: number): number => padL + (i / (pts.length - 1)) * plotW;
  const y = (pct: number): number => padTop + (1 - pct / 100) * plotH;

  const line = (read: (p: EnsoPlumePoint) => number): string =>
    pts.map((p, i) => `${xOf(i).toFixed(1)},${y(read(p)).toFixed(1)}`).join(' ');

  const lastPt = pts[pts.length - 1]!;
  const series = [
    { label: 'El Nino', color: 'var(--warn)', points: line((p) => p.elNino), last: lastPt.elNino, dash: '' },
    { label: 'Neutral', color: 'var(--fg-2)', points: line((p) => p.neutral), last: lastPt.neutral, dash: ' stroke-dasharray="4 2"' },
    { label: 'La Nina', color: 'var(--accent)', points: line((p) => p.laNina), last: lastPt.laNina, dash: ' stroke-dasharray="2 2"' }
  ];

  const guides = [25, 50, 75]
    .map((pct) => {
      const gy = y(pct).toFixed(1);
      return (
        `<line x1="${padL}" y1="${gy}" x2="${w - padR}" y2="${gy}" stroke="var(--line-strong)" stroke-width="0.6" stroke-dasharray="3 3"/>` +
        `<text x="${padL - 3}" y="${(Number(gy) + 2.5).toFixed(1)}" fill="var(--fg-3)" font-size="7" text-anchor="end">${pct}%</text>`
      );
    })
    .join('');

  const legend = series
    .map(
      (s, i) =>
        `<line x1="${padL + i * 88}" y1="6" x2="${padL + i * 88 + 12}" y2="6" stroke="${s.color}" stroke-width="1.6"${s.dash}/>` +
        `<text x="${padL + i * 88 + 16}" y="9" fill="var(--fg-1)" font-size="8">${escapeHtml(s.label)} ${s.last}%</text>`
    )
    .join('');

  const polylines = series
    .map(
      (s) =>
        `<polyline points="${s.points}" fill="none" stroke="${s.color}" stroke-width="1.4" stroke-linejoin="round"${s.dash}/>`
    )
    .join('');

  const inner =
    guides +
    legend +
    polylines +
    `<text x="${padL}" y="${h - 12}" fill="var(--fg-3)" font-size="7.5">${escapeHtml(pts[0]!.seas)}</text>` +
    `<text x="${w - padR}" y="${h - 12}" fill="var(--fg-3)" font-size="7.5" text-anchor="end">${escapeHtml(lastPt.seas)}</text>` +
    attribution(padL, h - 2, opts.source);

  return `<figure class="ddm-chart-fig">${svgWrap(w, h, opts.title, inner)}</figure>`;
}

// ---------------------------------------------------------------------------
// CPC outlook diverging bars (below / near / above terciles)
// ---------------------------------------------------------------------------

export interface CpcOutlookInput {
  /** "temperature" or "precipitation". */
  readonly variable: string;
  /** "Above", "Below", or "Normal" (the favored category). */
  readonly cat: string;
  /** Probability of the favored category (percent). */
  readonly prob: number;
  /** Window label, for example "6-10 day". */
  readonly window: string;
}

/**
 * Build a below/near/above tercile bar from a CPC favored category and its
 * probability. The favored tercile gets `prob`; the near-normal tercile is held
 * near climatology (33%); the opposite tercile takes the remainder. The favored
 * segment is toned by its drought meaning, not by an arbitrary hue: amber when
 * the tilt is toward drier or hotter (worsening), green when toward wetter or
 * cooler (easing), grey when near climatology. Every segment is labeled.
 */
export function cpcOutlookBarsSvg(input: CpcOutlookInput): string {
  const p = Number.isFinite(input.prob) ? input.prob : 33.3;
  const near = 33.3;
  const favored = Math.max(near, p);
  const opposite = Math.max(0, 100 - favored - near);

  // Worsening = above-normal temperature or below-normal precipitation.
  const isTemp = input.variable.toLowerCase().startsWith('temp');
  const worseningCat = isTemp ? 'Above' : 'Below';
  const favoredTone =
    input.cat === 'Normal'
      ? 'var(--fg-3)'
      : input.cat === worseningCat
        ? 'var(--warn)'
        : 'var(--good)';

  let below: number;
  let above: number;
  if (input.cat === 'Above') {
    above = favored;
    below = opposite;
  } else if (input.cat === 'Below') {
    below = favored;
    above = opposite;
  } else {
    // Normal favored: the Near segment carries `favored`, so Below and Above
    // split the remainder evenly and the three terciles sum to 100.
    below = Math.max(0, (100 - favored) / 2);
    above = below;
  }

  const segments: ProbSegment[] = [
    {
      label: 'Below',
      pct: below,
      fill: input.cat === 'Below' ? favoredTone : 'var(--bg-3)',
      ...(input.cat === 'Below' ? { emphasis: true } : {})
    },
    {
      label: 'Near',
      pct: input.cat === 'Normal' ? favored : near,
      fill: input.cat === 'Normal' ? favoredTone : 'var(--bg-3)',
      ...(input.cat === 'Normal' ? { emphasis: true } : {})
    },
    {
      label: 'Above',
      pct: above,
      fill: input.cat === 'Above' ? favoredTone : 'var(--bg-3)',
      ...(input.cat === 'Above' ? { emphasis: true } : {})
    }
  ];

  const favoredPhrase = input.cat === 'Normal' ? 'near-normal favored' : `${input.cat} normal favored`;
  const title = `CPC ${input.window} ${input.variable} outlook: ${favoredPhrase} at ${Math.round(p)} percent`;
  return stackedProbabilityBarsSvg(segments, title, 'NOAA CPC');
}
