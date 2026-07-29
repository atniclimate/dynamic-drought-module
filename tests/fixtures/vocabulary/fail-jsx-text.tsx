/** NEGATIVE fixture (T-P0-6): banned words in JSX TEXT NODES must be found;
 * JSX is an active surface-authoring path. */
export function Bad() {
  return (
    <div>
      <h3>Drought forecast for this place</h3>
      <span>DDM warning level high</span>
    </div>
  );
}
