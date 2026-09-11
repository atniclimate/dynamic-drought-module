/**
 * The boot-idle seam (DR-052 follow-up, 2026-09-03).
 *
 * `<html data-ddm-boot>` reads `booting` from the first line of `boot()` and
 * flips to `idle` once, when three things hold at the same time:
 *
 *   1. the map has loaded (or boot has decided there will be no map);
 *   2. every layer the boot asked for has left `loading`: for each key the
 *      checkbox bridge holds as checked, the registry either lists it active
 *      with a terminal status, or has recorded its terminal failure;
 *   3. no shared JSON transport is in flight (`pendingSharedTransportCount`).
 *
 * The same transition resolves `window.__ddm.ready`, a promise, for a caller
 * that prefers awaiting a value to polling an attribute. Unlike the
 * `__ddmMap` development handle it survives the production build on
 * purpose: the seam is a statement about the page, not a debugging aid.
 *
 * Why it is derived and never timed: a seam that reaches `idle` before a
 * layer settles turns a visible failure into a silent one, so the tracker
 * counts activations and transports and re-evaluates on their events, with
 * no timer anywhere. Why it flips once: boot is the window this seam
 * describes. A toggle, a preset swap, a region jump, or a cluster change
 * reopens the same shared-fetch and layer-activation race mid-session, and
 * the seam says nothing about those; a spec that drives them owns its own
 * waits, as before.
 *
 * Why it is armed late: the checkbox bridge is seeded and the URL state is
 * applied synchronously inside `buildSidebar`, and the deep link (a
 * `?select=` request) runs after it and may activate more. Arming after
 * the chrome is wired AND the deep-link promise has settled means the
 * pending set is complete before the first evaluation, so an empty registry
 * during the microtasks between seeding and the first `loading` status can
 * never read as idle.
 */

import { registry } from './registry';
import { checkedSnapshot, onCheckedChange } from '../ui/island/bridge';
import {
  onSharedTransportSettled,
  pendingSharedTransportCount
} from '../util/fetch';

export type BootPhase = 'booting' | 'idle';

/**
 * One read of what holds a wait open (DDM-P1-T09 step 1, 2026-09-10).
 * `pendingLayerKeys` is the same computation the boot-idle tracker
 * evaluates; `pendingTransportCount` is `pendingSharedTransportCount()`
 * from src/util/fetch.ts, which until this seam existed no test could read.
 */
export interface DdmSeamSnapshot {
  readonly phase: BootPhase | null;
  readonly pendingLayerKeys: readonly string[];
  readonly pendingTransportCount: number;
}

/**
 * The `window.__ddm` test seam. Read-only: every member reports state and
 * none of them changes a layer, a checkbox, or a transport. It survives the
 * production build for the same reason `ready` does: a spec that boots
 * `dist/` must be able to name what it waited on when the wait fails,
 * rather than infer it from pills and checkboxes.
 */
export interface DdmSeam {
  /** The boot-idle seam's promise form; resolves when the attribute flips. */
  readonly ready: Promise<void>;
  /** The layer keys still owed: checked and not terminal, or active and re-loading. A fresh array. */
  pendingLayerKeys(): string[];
  /** Shared JSON transports in flight right now (never a cached fulfilled entry). */
  pendingTransportCount(): number;
  /** All three readings taken together. */
  snapshot(): DdmSeamSnapshot;
  /**
   * Resolve with a snapshot on the first evaluation, event-driven and never
   * polled, that finds no pending layer and no transport in flight; reject
   * with a `DdmQuiescenceTimeout` naming both readings when `budgetMs`
   * elapses first. Unlike `ready` this is not a boot statement: it answers
   * for whatever the page is doing when it is called, so a spec can await
   * it after a toggle, a preset swap, or a region jump.
   */
  whenQuiescent(budgetMs?: number): Promise<DdmSeamSnapshot>;
}

declare global {
  interface Window {
    __ddm?: DdmSeam;
  }
}

let phase: BootPhase | null = null;
let resolveReady: (() => void) | null = null;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

function stamp(next: BootPhase): void {
  phase = next;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['ddmBoot'] = next;
  }
}

/** Playwright's `expect.timeout` in playwright.config.ts; the seam's default budget matches it. */
const DEFAULT_QUIESCENCE_BUDGET_MS = 10_000;

function snapshotSeam(): DdmSeamSnapshot {
  return {
    phase,
    pendingLayerKeys: [...pendingBootLayers()],
    pendingTransportCount: pendingSharedTransportCount()
  };
}

function describeSnapshot(snapshot: DdmSeamSnapshot): string {
  return (
    `pending layer keys = ${JSON.stringify(snapshot.pendingLayerKeys)}; ` +
    `pending shared transports = ${snapshot.pendingTransportCount}`
  );
}

/**
 * Subscribe `evaluate` to every event that can move a seam reading: an
 * activation or deactivation, a status write, a checkbox write, and a
 * shared-transport settlement. Returns one function that unsubscribes all.
 */
function watchSeamInputs(evaluate: () => void): () => void {
  const unsubscribe = [
    registry.on('change', evaluate),
    registry.on('status-change', evaluate),
    onCheckedChange(evaluate),
    onSharedTransportSettled(evaluate)
  ];
  return () => {
    for (const off of unsubscribe) off();
  };
}

function whenQuiescent(budgetMs: number = DEFAULT_QUIESCENCE_BUDGET_MS): Promise<DdmSeamSnapshot> {
  return new Promise<DdmSeamSnapshot>((resolve, reject) => {
    if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs <= 0) {
      reject(new RangeError(`whenQuiescent budget must be a positive finite number of ms, received ${String(budgetMs)}`));
      return;
    }
    let settled = false;
    let stopWatching: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      settled = true;
      if (timer !== null) clearTimeout(timer);
      stopWatching?.();
    };
    const evaluate = (): void => {
      if (settled) return;
      const snapshot = snapshotSeam();
      if (snapshot.pendingLayerKeys.length > 0) return;
      if (snapshot.pendingTransportCount > 0) return;
      finish();
      resolve(snapshot);
    };
    timer = setTimeout(() => {
      if (settled) return;
      const snapshot = snapshotSeam();
      finish();
      const error = new Error(
        `quiescence not reached within ${budgetMs} ms: ${describeSnapshot(snapshot)}`
      );
      error.name = 'DdmQuiescenceTimeout';
      reject(error);
    }, budgetMs);
    stopWatching = watchSeamInputs(evaluate);
    // The first look runs on its own macrotask, as the boot tracker's does,
    // so an operation queued just before the call has posted its `loading`.
    setTimeout(evaluate, 0);
  });
}

const seam: DdmSeam = Object.freeze({
  ready,
  pendingLayerKeys: (): string[] => [...pendingBootLayers()],
  pendingTransportCount: (): number => pendingSharedTransportCount(),
  snapshot: snapshotSeam,
  whenQuiescent
});

/** The first line of boot: say the page is booting and publish the seam. */
export function markBooting(): void {
  if (phase !== null) return;
  stamp('booting');
  if (typeof window !== 'undefined') {
    window.__ddm = seam;
  }
}

/** Current phase, for readers that cannot see the attribute. */
export function bootPhase(): BootPhase | null {
  return phase;
}

/**
 * The layers still owed by the boot: checked in the bridge, and neither
 * active with a terminal status nor recorded as a terminal failure. A key
 * that is active but re-loading also counts, whether or not it is checked.
 */
export function pendingBootLayers(): readonly string[] {
  const active = registry.getActiveKeys();
  const pending: string[] = [];
  for (const [key, checked] of checkedSnapshot()) {
    const status = registry.getStatus(key);
    if (active.has(key)) {
      if (status === 'loading') pending.push(key);
      continue;
    }
    if (!checked) continue;
    // Checked and not active: the activation is queued (no status yet) or
    // in flight (`loading`). A terminal `error` here is a failed activation
    // the controller has already unchecked or is about to; it is settled.
    if (status === undefined || status === 'loading') pending.push(key);
  }
  for (const key of active) {
    if (registry.getStatus(key) === 'loading' && !pending.includes(key)) {
      pending.push(key);
    }
  }
  return pending;
}

let armed = false;

/**
 * Arm the tracker once the chrome is wired and the boot's deep link (if
 * any) has settled. Flips to `idle` on the first evaluation that finds no
 * pending layer and no pending transport, then unsubscribes: the seam is a
 * boot statement and does not track the session.
 */
export function armBootIdle(deepLink: Promise<void>): void {
  if (armed) return;
  armed = true;
  if (phase === null) markBooting();
  if (phase === 'idle') return;

  void deepLink.catch(() => undefined).then(() => {
    let stopWatching: (() => void) | null = null;
    const evaluate = (): void => {
      if (phase === 'idle') return;
      if (pendingBootLayers().length > 0) return;
      if (pendingSharedTransportCount() > 0) return;
      stamp('idle');
      resolveReady?.();
      stopWatching?.();
    };
    stopWatching = watchSeamInputs(evaluate);
    // The first look runs on its own macrotask, after the queued layer
    // operations have posted their first `loading` status.
    setTimeout(evaluate, 0);
  });
}

/**
 * Boot decided there will be no map (no WebGL 2 context, or a GPU
 * initialization error): nothing will load, so the boot is idle now.
 */
export function settleBootIdleWithoutMap(): void {
  if (phase === null) markBooting();
  if (phase === 'idle') return;
  stamp('idle');
  resolveReady?.();
}
