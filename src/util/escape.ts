/**
 * Escape HTML-significant characters so user-controlled or third-party
 * strings are safe to interpolate into HTML attribute values and text
 * content. Used by every popup factory and any tooltip that surfaces
 * data from external sources (OSM `name` tags, GeoJSON properties, etc.).
 */
export function escapeHtml(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
