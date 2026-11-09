/**
 * The settle spring (owner direction 2026-11-09 (sprint), DR-pending).
 *
 * A surface the hand moves (a sheet, a drawer, a card) should finish the
 * gesture the hand started: it leaves the finger at the finger's speed and
 * comes to rest on a damped spring. This module is that spring in closed
 * form, so a value at any time is exact and a test can check it without a
 * frame loop.
 *
 * ONE SPRING. `SETTLE_SPRING` is the stiffness and damping every phone
 * surface shares. The stylesheet's `--ease-spring` timing function is the
 * same curve sampled for declarative transitions, and
 * tests/spring.test.mjs fails when the two drift apart.
 *
 * REDUCED MOTION. `runSpring` lands on the end value at once when the
 * reader asks for reduced motion: same end state, same meaning, no travel.
 *
 * Kept import-free on purpose, so `node --test` can load it with Node's type
 * stripping and no resolve hook.
 */

export interface SpringConfig {
  /** Force per unit of displacement. */
  readonly stiffness: number;
  /** Force per unit of velocity. */
  readonly damping: number;
  /** Defaults to 1. */
  readonly mass?: number;
}

/**
 * Damping ratio about 0.83: under 1 percent overshoot, at rest (within a
 * thousandth) in about 0.43 s. Mirrors --spring-stiffness and
 * --spring-damping in src/styles/app.css.
 */
export const SETTLE_SPRING: SpringConfig = { stiffness: 420, damping: 34 };

/** The settle spring's declared duration in ms; mirrors --dur-settle. */
export const SETTLE_DURATION_MS = 430;

interface Solved {
  /** Displacement from rest at time t (s): 0 means at rest. */
  displacement(t: number): number;
  velocity(t: number): number;
}

/**
 * Solve a unit spring released one unit below rest (displacement -1) with
 * velocity `v0` in units per second, positive toward and past rest.
 */
function solve(v0: number, config: SpringConfig): Solved {
  const mass = config.mass ?? 1;
  const w0 = Math.sqrt(config.stiffness / mass);
  const zeta = config.damping / (2 * Math.sqrt(config.stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = -1;
    const b = (v0 + zeta * w0 * a) / wd;
    return {
      displacement: (t) => Math.exp(-zeta * w0 * t) * (a * Math.cos(wd * t) + b * Math.sin(wd * t)),
      velocity: (t) => {
        const decay = Math.exp(-zeta * w0 * t);
        const cos = Math.cos(wd * t);
        const sin = Math.sin(wd * t);
        return decay * ((b * wd - zeta * w0 * a) * cos - (a * wd + zeta * w0 * b) * sin);
      }
    };
  }
  if (zeta === 1) {
    const a = -1;
    const b = v0 + w0 * a;
    return {
      displacement: (t) => Math.exp(-w0 * t) * (a + b * t),
      velocity: (t) => Math.exp(-w0 * t) * (b - w0 * (a + b * t))
    };
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  const c1 = (v0 + r2) / (r1 - r2);
  const c2 = -1 - c1;
  return {
    displacement: (t) => c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t),
    velocity: (t) => c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t)
  };
}

/**
 * Progress of a spring from 0 toward 1 at `t` seconds, released with
 * `v0` progress units per second. May pass 1 slightly before settling.
 */
export function springProgress(t: number, v0 = 0, config: SpringConfig = SETTLE_SPRING): number {
  if (t <= 0) return 0;
  return 1 + solve(v0, config).displacement(t);
}

/** Seconds until the spring stays within `tolerance` of rest. */
export function springSettleTime(
  config: SpringConfig = SETTLE_SPRING,
  v0 = 0,
  tolerance = 0.001
): number {
  const solved = solve(v0, config);
  const step = 1 / 240;
  let last = 0;
  // Walk back from a generous bound to the last moment outside tolerance.
  for (let t = 0; t <= 4; t += step) {
    if (Math.abs(solved.displacement(t)) > tolerance) last = t;
  }
  return last + step;
}

export interface SpringRun {
  /** Stop where it is. `onRest` is not called. */
  stop(): void;
}

export interface SpringRunOptions {
  readonly from: number;
  readonly to: number;
  /** Release velocity in the value's own units per second (px/s for a drag). */
  readonly velocity?: number;
  readonly config?: SpringConfig;
  readonly onUpdate: (value: number) => void;
  readonly onRest?: () => void;
  /** Land on `to` at once. Pass `prefersReducedMotion()`. */
  readonly reducedMotion?: boolean;
}

/**
 * Drive a value from `from` to `to` on the spring, one update per animation
 * frame, handing over the release velocity. Always ends by reporting `to`
 * exactly. Returns a handle that can stop it (a new gesture takes over).
 */
export function runSpring(options: SpringRunOptions): SpringRun {
  const { from, to, onUpdate, onRest } = options;
  const distance = to - from;
  if (
    distance === 0 ||
    options.reducedMotion === true ||
    typeof requestAnimationFrame !== 'function'
  ) {
    onUpdate(to);
    onRest?.();
    return { stop: () => {} };
  }
  const config = options.config ?? SETTLE_SPRING;
  const v0 = (options.velocity ?? 0) / distance;
  const solved = solve(v0, config);
  const settle = springSettleTime(config, v0);
  let frame = 0;
  let start: number | null = null;
  let stopped = false;
  const tick = (now: number): void => {
    if (stopped) return;
    if (start === null) start = now;
    const t = (now - start) / 1000;
    if (t >= settle) {
      onUpdate(to);
      onRest?.();
      return;
    }
    onUpdate(from + distance * (1 + solved.displacement(t)));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
    }
  };
}

/**
 * The settle spring as a CSS `linear()` timing function over
 * `SETTLE_DURATION_MS`, sampled at `points` evenly spaced stops.
 */
export function springLinearEasing(points = 24, config: SpringConfig = SETTLE_SPRING): string {
  const duration = SETTLE_DURATION_MS / 1000;
  const stops: string[] = [];
  for (let i = 0; i <= points; i += 1) {
    const value = i === points ? 1 : springProgress((i / points) * duration, 0, config);
    stops.push(String(Math.round(value * 1000) / 1000));
  }
  return `linear(${stops.join(', ')})`;
}
