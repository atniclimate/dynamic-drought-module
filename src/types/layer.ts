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
