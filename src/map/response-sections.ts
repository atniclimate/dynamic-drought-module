/**
 * The collection assembly for a group-capable click target (S30D D1 M23;
 * the Codex Tier 2 review's PF2 as amended, DISP PF2 (2): "the
 * collection-assembly step dedupes by resolved group key before rendering
 * sections"). Import-free, so Node can test it.
 *
 * The seam (grouping-contract.md section 12.1, "The coordinator"): the
 * InteractionCoordinator hands a group-capable target EVERY labelled
 * feature of its layers under the click, before its first-feature collapse
 * (`ClickTargetSpec.group`, src/map/interaction-coordinator.ts). The
 * target's own lazy adapter (D2 supplies it; D1 computes no group) runs
 * `assembleSections` over them: two hits in one group make ONE section,
 * and the sections are ordered by group key. They render as sections
 * inside the one response, never as a second popup. The coordinator never
 * imports this module, so the assembly stays off the entry path.
 */

/** One group under the click: its resolved key and its member features. */
export interface ResponseSection<F> {
  readonly key: string;
  readonly features: readonly F[];
}

/**
 * The sections of a group-capable hit: one per resolved group key (a
 * feature whose key resolves to null joins none), ordered by key.
 */
export function assembleSections<F>(
  features: readonly F[],
  groupKey: (feature: F) => string | null
): ResponseSection<F>[] {
  const sections: { key: string; features: F[] }[] = [];
  for (const feature of features) {
    const key = groupKey(feature);
    if (key === null) continue;
    const section = sections.find((s) => s.key === key);
    if (section) section.features.push(feature);
    else sections.push({ key, features: [feature] });
  }
  return sections.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
