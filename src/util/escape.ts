/**
 * Escape HTML-significant characters so user-controlled or third-party
 * strings are safe to interpolate into HTML attribute values and text
 * content. Used by every popup factory and any tooltip that surfaces
 * data from external sources (map feature `name` properties, GeoJSON properties, etc.).
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

/**
 * The one runtime URL check (PF4), for every rendered or stored link: a
 * parsed absolute URL, https only, no userinfo, and the exact hostname when
 * one is mandated (the BC record host, grouping-contract.md:127). Returns the
 * normalized href, or null.
 */
export function checkPopupHref(href: unknown, host?: string): string | null {
  if (typeof href !== 'string') return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (host !== undefined && url.hostname !== host) return null;
  return url.href;
}
