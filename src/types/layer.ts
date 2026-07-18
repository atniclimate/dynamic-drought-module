/**
 * The six canonical layer load states surfaced through the sidebar status
 * pill (see CLAUDE.md §6 Architecture invariant 3). The internal value is
 * what code stores; the displayed pill text is the responsibility of the
 * UI layer (src/ui/sidebar.ts).
 *
 *   loading   -> "loading..."
 *   ready     -> "live"
 *   degraded  -> "live (partial)"
 *   error     -> "unavailable"
 *   no-data   -> "no data (see data/README.md)"
 *   zoom-in   -> "zoom in to load"
 *
 * `degraded` was added for 0.7.0 H4 (the honest-status gap the pre-open
 * assessment confirmed): a layer that merges several sources must not
 * report an unqualified "live" when one of them failed.
 */
export type LayerStatus = 'loading' | 'ready' | 'degraded' | 'error' | 'no-data' | 'zoom-in';

/**
 * The four layer roles of the UX track (ROADMAP "The UX track", UX-1). The
 * map distinguishes place from state: reference boundaries are the tactile
 * anchor that tells a person where they are and whose land they are looking
 * at; condition surfaces describe what state that place is in.
 *
 *   surface     a condition raster or polygon fill that paints the whole
 *               viewport (USDM, gridded SPI, outlook, HeatRisk, WHP, SPC
 *               fire weather); exactly one renders at a time
 *   reference   a place boundary or line network a person orients by
 *               (states, ecoregions, Tribal, Treaty, reservations, rivers)
 *   event       a discrete, dated occurrence overlaid on the surface
 *               (active wildfires, weather alerts)
 *   stations    point telemetry markers
 *
 * References, events, and stations stack freely over the active surface;
 * surfaces are mutually exclusive (see resolveExclusiveSurface in
 * src/config/layers.ts and the sidebar's radio-style enforcement).
 */
export type LayerRole = 'surface' | 'reference' | 'event' | 'stations';
