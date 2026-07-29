/** POSITIVE fixture (T-P0-6): JSX with banned words only in comments,
 * braces-bound identifiers, and attributes that are keys; and comparison
 * expressions that must not be misread as JSX text. ZERO findings. */
const alertCount = 2;
const total = 10;

export function Clean() {
  // A forecast warning alert in a comment is fine.
  return (
    <div data-key="nws-alerts">
      <span>{alertCount}</span>
      <span>{total > alertCount ? 'high' : 'low'}</span>
      <em>Conditions in context</em>
    </div>
  );
}
