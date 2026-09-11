/**
 * The one shared lazy loader for the search-controller chunk (DDM-P1-T04).
 *
 * Every host that mounts search (the console island, the Layers studio, the
 * Brief head, and the mobile sheet) imports the SAME loader instance here,
 * so a failed first attempt from one host and a retry from another share the
 * same recorded chunk URL and attempt count instead of each host racing its
 * own cached module-map failure. See src/util/chunk-retry.ts for the
 * mechanics.
 */

import { createChunkLoader } from '../util/chunk-retry';

export const loadSearchController = createChunkLoader(
  () => import('./search-controller'),
  import.meta.url
);
