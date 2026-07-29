/**
 * Copy `text` to the operating system clipboard.
 *
 * Two paths, in order:
 *
 *   1. Modern Clipboard API (`navigator.clipboard.writeText`) when
 *      available AND the page is in a secure context. Required for
 *      Chrome, Firefox, and Safari on HTTPS or localhost. Permission
 *      denial or transient failure falls through silently to path 2
 *      rather than rejecting; this matches the vanilla `app.js`
 *      behavior so the share button remains usable inside sandboxed
 *      iframes that lack clipboard-write permission.
 *
 *   2. Legacy `document.execCommand('copy')` on a hidden, off-screen,
 *      readonly textarea. This still works in the iframe sandbox cases
 *      where the modern API throws; `execCommand` is deprecated but
 *      not yet removed from browsers.
 *
 * Returns `true` when either path succeeded, `false` otherwise. Never
 * throws: a thrown exception in the legacy path is swallowed and
 * reported as `false` so the caller can render a "copy blocked"
 * message.
 *
 * Direct port of the vanilla baseline (`app.js` ~1421-1448).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Path 1: modern Clipboard API (requires secure context)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or transient failure; fall through to path 2.
    }
  }

  // Path 2: legacy execCommand on a hidden textarea
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}
