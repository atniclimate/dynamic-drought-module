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

declare global {
  interface Window {
    /** The boot-idle seam's promise form; resolves when the attribute flips. */
    __ddm?: { readonly ready: Promise<void> };
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

/** The first line of boot: say the page is booting and publish the promise. */
export function markBooting(): void {
  if (phase !== null) return;
  stamp('booting');
  if (typeof window !== 'undefined') {
    window.__ddm = { ready };
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
    const unsubscribe: Array<() => void> = [];
    const evaluate = (): void => {
      if (phase === 'idle') return;
      if (pendingBootLayers().length > 0) return;
      if (pendingSharedTransportCount() > 0) return;
      stamp('idle');
      resolveReady?.();
      for (const off of unsubscribe) off();
    };
    unsubscribe.push(registry.on('change', evaluate));
    unsubscribe.push(registry.on('status-change', evaluate));
    unsubscribe.push(onCheckedChange(evaluate));
    unsubscribe.push(onSharedTransportSettled(evaluate));
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
