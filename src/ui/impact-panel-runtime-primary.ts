/**
 * Primary impact-panel runtime entry.
 *
 * The facade uses a distinct recovery entry after a transient failure so the
 * browser does not retry a failed module-map URL.
 */
export * from './impact-panel-runtime';
