/**
 * Keep a disclosure's summary under the pointer across a toggle. Desktop
 * Brief opens Layer legends upward from the column foot; when the opened
 * content outgrows the free space it pushes the summary down, so the column
 * scrolls by that shift before the next paint. Import-free so plain
 * `node --test` loads it.
 */
export function holdSummarySeat(details: HTMLDetailsElement, scroller: HTMLElement): () => void {
  const summary = details.querySelector('summary');
  if (!summary) return () => {};
  let frame = 0;
  // The click listener runs before the native toggle, so it reads the old seat.
  const onClick = (): void => {
    const before = summary.getBoundingClientRect().top;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      scroller.scrollTop += summary.getBoundingClientRect().top - before;
    });
  };
  summary.addEventListener('click', onClick);
  return () => {
    summary.removeEventListener('click', onClick);
    cancelAnimationFrame(frame);
  };
}
