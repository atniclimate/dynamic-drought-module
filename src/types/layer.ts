/**
 * The five canonical layer load states surfaced through the sidebar status
 * pill (see CLAUDE.md §6 Architecture invariant 3). The internal value is
 * what code stores; the displayed pill text is the responsibility of the
 * UI layer (src/ui/sidebar.ts).
 *
 *   loading   -> "loading..."
 *   ready     -> "live"
 *   error     -> "unavailable"
 *   no-data   -> "empty placeholder (see data/README.md)"
 *   zoom-in   -> "zoom in to load"
 */
export type LayerStatus = 'loading' | 'ready' | 'error' | 'no-data' | 'zoom-in';

/**
 * Registry entry for a single map layer. The `lazyLoad` reference is invoked
 * on first toggle-on; subsequent toggles flip visibility on a cached source +
 * layer set.
 *
 * `paneLayer` is the MapLibre layer ID this layer should be inserted before.
 * In Leaflet this was a uniquely-named pane with a numeric z-index; in
 * MapLibre layer ordering is determined by insertion order, so the registry
 * tracks the relative positioning explicitly.
 */
export interface LayerDef {
  readonly key: string;
  readonly name: string;
  readonly source: string;
  readonly defaultOn: boolean;
  readonly paneLayer?: string;
  readonly lazyLoad: () => Promise<void>;
}
