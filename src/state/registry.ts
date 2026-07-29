import type { LayerStatus } from '../types/layer';

/**
 * In-memory registry of active layer keys and their per-key load status.
 *
 * The vanilla baseline tracked these as two fields on a STATE singleton
 * (`STATE.activeLayers: Set<string>` and `STATE.loadStatus: Record<string,
 * 'idle' | 'loading' | 'ready' | 'error'>`). This class consolidates them
 * behind a small event bus so the URL sync layer (`src/state/url.ts`) and
 * the sidebar pill UI (`src/ui/sidebar.ts`) can subscribe instead of
 * polling, and so future modules (telemetry, hydrography) get a single
 * place to coordinate.
 *
 * See CLAUDE.md section 8 for the named-export contract: this module
 * exports the `LayerRegistry` class and a process-wide singleton
 * `registry` instance. Two events are emitted:
 *
 *   change         fired after `activate` or `deactivate` mutates the
 *                  active set; listeners receive a ReadonlySet snapshot
 *   status-change  fired after `setStatus` updates a key's status;
 *                  listeners receive the key and its new status
 *
 * Listeners receive snapshots (or primitive values) so subscribers cannot
 * mutate registry state through the callback argument.
 */

type ChangeListener = (active: ReadonlySet<string>) => void;
type StatusChangeListener = (key: string, status: LayerStatus) => void;

export class LayerRegistry {
  private readonly active = new Set<string>();
  private readonly statusByKey = new Map<string, LayerStatus>();

  private readonly changeListeners: ChangeListener[] = [];
  private readonly statusChangeListeners: StatusChangeListener[] = [];

  /**
   * Mark `key` as active. Idempotent: a second activate with the same
   * key still emits `change` so subscribers can re-read the snapshot,
   * but the underlying set is unchanged.
   */
  activate(key: string): void {
    this.active.add(key);
    this.emitChange();
  }

  /**
   * Remove `key` from the active set. Safe to call for keys that are
   * not currently active; emits `change` regardless.
   */
  deactivate(key: string): void {
    this.active.delete(key);
    // Clear the recorded load status too, so a `change` subscriber that
    // reads getStatus() after deactivate sees "off" (undefined) rather
    // than the layer's last terminal status (adversarial-review finding,
    // docs/archive/ddm-adversarial-review-activation-spine-2026-07-06.md).
    this.statusByKey.delete(key);
    this.emitChange();
  }

  /**
   * Read-only snapshot of the active layer keys. The returned set is a
   * fresh copy so callers can iterate safely while the registry mutates.
   */
  getActiveKeys(): ReadonlySet<string> {
    return new Set(this.active);
  }

  /**
   * Record the load status for a layer key (loading, ready, error,
   * no-data, or zoom-in). Always emits `status-change`, even when the
   * value is unchanged, so the sidebar pill can re-render in case the
   * caller wants a redraw on the same status (rare but needed when the
   * pill text depends on additional context).
   */
  setStatus(key: string, status: LayerStatus): void {
    this.statusByKey.set(key, status);
    this.emitStatusChange(key, status);
  }

  /**
   * Read a layer's last-recorded status, or undefined if no status has
   * been written for that key yet.
   */
  getStatus(key: string): LayerStatus | undefined {
    return this.statusByKey.get(key);
  }

  /**
   * Subscribe to `change` events. Returns an unsubscribe function; call
   * it to remove the listener. The listener fires synchronously after
   * each activate or deactivate.
   */
  on(event: 'change', listener: ChangeListener): () => void;
  /**
   * Subscribe to `status-change` events. Returns an unsubscribe
   * function. The listener fires synchronously after each setStatus.
   */
  on(event: 'status-change', listener: StatusChangeListener): () => void;
  on(
    event: 'change' | 'status-change',
    listener: ChangeListener | StatusChangeListener
  ): () => void {
    if (event === 'change') {
      const fn = listener as ChangeListener;
      this.changeListeners.push(fn);
      return () => {
        const idx = this.changeListeners.indexOf(fn);
        if (idx >= 0) this.changeListeners.splice(idx, 1);
      };
    }
    const fn = listener as StatusChangeListener;
    this.statusChangeListeners.push(fn);
    return () => {
      const idx = this.statusChangeListeners.indexOf(fn);
      if (idx >= 0) this.statusChangeListeners.splice(idx, 1);
    };
  }

  private emitChange(): void {
    const snapshot = this.getActiveKeys();
    // Iterate a copy of the listener array so a listener that calls
    // its own unsubscribe during dispatch does not skip a sibling.
    for (const listener of this.changeListeners.slice()) {
      listener(snapshot);
    }
  }

  private emitStatusChange(key: string, status: LayerStatus): void {
    for (const listener of this.statusChangeListeners.slice()) {
      listener(key, status);
    }
  }
}

/**
 * Process-wide singleton. Modules should import this rather than
 * constructing their own LayerRegistry so all subscribers see the same
 * event stream.
 */
export const registry = new LayerRegistry();
