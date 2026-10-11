/**
 * A timeout that counts time the page could listen, in ticks. A frozen main
 * thread (a heavy 3D frame, a backgrounded tab) passes as one tick, so a
 * stall is never read as a source that did not answer. Returns the stop
 * function; `onExpire` runs at most once.
 */
export function listeningTimeout(ms: number, onExpire: () => void): () => void {
  const tickMs = Math.min(250, ms);
  let ticksLeft = Math.ceil(ms / tickMs);
  const timer = setInterval(() => {
    if (--ticksLeft > 0) return;
    clearInterval(timer);
    onExpire();
  }, tickMs);
  return () => clearInterval(timer);
}

/**
 * The shared fetch helper keeps a wall-clock timer, which after a stall can
 * fire on a read the source already answered. A reader under a listening
 * timeout reads again, at most this many times, so a hung source in a hidden
 * tab (where ticks slow to one a minute) is not asked again without end.
 */
export const MAX_STALL_REREADS = 2;
