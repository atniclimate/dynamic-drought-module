/** "1:14 AM, Oct 19" on the viewer's clock: when DDM last read a product. "As of", never "Valid": it is DDM's read, not an issuer validity time. */
export function formatSnapshotTime(time: number): string {
  const date = new Date(time);
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return `${clock.format(date)}, ${day.format(date)}`;
}
