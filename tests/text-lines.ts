/**
 * Text registration detectors (S30D D1 M27; DDM-P10-T12; design record
 * interface-chrome-popups-text.md section 5, "Orphans" and "Fit").
 *
 * Both detectors read every block they judge in ONE `page.evaluate`, after
 * the caller's settled signal, so a re-render between two reads can never
 * split one measurement. The page-side functions are self-contained (no
 * closure over this module), which is what `page.evaluate` needs.
 *
 * Exported for reuse: `tests/identify-paths.spec.ts` can run the orphan
 * scan over its builder fixtures once M26 lands them.
 */

import type { Page } from '@playwright/test';

/** One orphan or split-word finding, printable on its own. */
export interface TextLineFinding {
  readonly kind: 'orphan' | 'split-word';
  /** The root selector the block was found under. */
  readonly root: string;
  /** A short path to the block: tag#id.class of the block and its parent. */
  readonly block: string;
  /** The block's text, collapsed, first 120 characters. */
  readonly text: string;
  /** The last line's lone word (orphan) or the word that split. */
  readonly word: string;
  readonly lines: number;
  readonly words: number;
}

/** One fit reading for an element that failed it. */
export interface TextFitFinding {
  readonly selector: string;
  readonly element: string;
  readonly text: string;
  /** What failed: scroll overflow, an engaged ellipsis or clamp, or the text drawing outside the box. */
  readonly reason: string;
}

/**
 * The orphan scan (section 5 "Orphans"): a TreeWalker over text nodes, one
 * Range per `\S+` word and the LAST non-empty client rect of each. A word
 * starts a new line when its top is at or below the previous word's bottom
 * minus 1 px. It fails a block of at least 2 lines and at least 3 words
 * whose last line holds exactly one word, and a prose word whose rects sit
 * on 2 or more lines outside the URL and identifier allow-list. It skips
 * hidden and `.sr-only` elements, a block that is nowrap as a whole, form
 * controls and SVG. A nowrap inline run inside a wrapping block (a date or
 * register chip) is one atomic word on the line its last rect sits on, and
 * is never checked for a split.
 *
 * A block is the nearest ancestor whose computed display is not inline (an
 * inline-block, a flex or grid item and a table cell are blocks of their
 * own). A block holding a forced break (`<br>`) is skipped: its last line
 * is authored, not wrapped.
 */
export async function findOrphans(page: Page, roots: readonly string[]): Promise<TextLineFinding[]> {
  return (await scanOrphans(page, roots)).findings;
}

/** What one orphan scan actually read under one root selector (non-vacuity). */
export interface TextScanCoverage {
  readonly root: string;
  /** Elements matching the root selector. */
  readonly found: number;
  /** Of those, how many render (client rects and CSS-visible). */
  readonly rendered: number;
  /** Words the scan measured under the root (skipped blocks excluded). */
  readonly words: number;
}

/** `findOrphans` plus what each root contributed, so a caller can fail a scan that read nothing. */
export async function scanOrphans(
  page: Page,
  roots: readonly string[]
): Promise<{ findings: TextLineFinding[]; coverage: TextScanCoverage[] }> {
  return page.evaluate((rootSelectors: readonly string[]) => {
    const coverage: { root: string; found: number; rendered: number; words: number }[] = [];
    const findings: {
      kind: 'orphan' | 'split-word';
      root: string;
      block: string;
      text: string;
      word: string;
      lines: number;
      words: number;
    }[] = [];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'NOSCRIPT']);
    const URL_OR_ID = /^(https?:|www\.)|[/@]|^[\w.-]*\d[\w.-]*$|^[\w-]*_[\w-]*$/;

    const label = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className.trim() !== ''
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    const blockOf = (el: Element): Element => {
      let current: Element = el;
      while (current.parentElement) {
        const display = getComputedStyle(current).display;
        if (display !== 'inline' && display !== 'contents') return current;
        current = current.parentElement;
      }
      return current;
    };
    const visible = (el: Element): boolean => {
      const probe = el as Element & { checkVisibility?: (options?: object) => boolean };
      if (typeof probe.checkVisibility === 'function') {
        return probe.checkVisibility({ checkVisibilityCSS: true });
      }
      return el.getClientRects().length > 0;
    };
    const noWrap = (e: Element): boolean => {
      const style = getComputedStyle(e);
      const ws = style.whiteSpace;
      return style.getPropertyValue('text-wrap-mode') === 'nowrap' || ws === 'nowrap' || ws === 'pre';
    };
    const skipped = (el: Element, block: Element, root: Element): boolean => {
      if (el.closest('svg, .sr-only, [hidden], [aria-hidden="true"]')) return true;
      if (!visible(el)) return true;
      // A block that is nowrap as a whole (or a nowrap root) is a token or a
      // control label, judged by the fit scan instead. A nowrap run INSIDE
      // a wrapping block is not skipped: `nowrapAtom` makes it one word.
      if (noWrap(block) || noWrap(root)) return true;
      for (let e: Element | null = el; e; e = e.parentElement) {
        if (SKIP_TAGS.has(e.tagName)) return true;
        if (e === root) break;
      }
      return false;
    };
    /**
     * The outermost nowrap inline element between the text's parent and its
     * block (both ends exclusive of the block), or null. Such a run (a date
     * or register chip inside a source line) cannot break, so it is ONE
     * atomic word on the line its last rect sits on; it is never checked for
     * a split, since it cannot split.
     */
    const nowrapAtom = (el: Element, block: Element, root: Element): Element | null => {
      let atom: Element | null = null;
      for (let e: Element | null = el; e && e !== block && e !== root; e = e.parentElement) {
        if (noWrap(e)) atom = e;
      }
      return atom;
    };

    for (const rootSelector of rootSelectors) {
      const rootEls = Array.from(document.querySelectorAll(rootSelector));
      const cover = { root: rootSelector, found: rootEls.length, rendered: 0, words: 0 };
      coverage.push(cover);
      for (const root of rootEls) {
        if (root.getClientRects().length > 0 && visible(root)) cover.rendered += 1;
        const blocks = new Map<Element, { top: number; bottom: number; word: string }[]>();
        const atomsSeen = new Set<Element>();
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? '';
          if (text.trim() === '') continue;
          const parent = node.parentElement;
          if (!parent) continue;
          const block = blockOf(parent);
          if (skipped(parent, block, root)) continue;
          if (block.querySelector('br')) continue;
          const words = blocks.get(block) ?? [];
          const atom = nowrapAtom(parent, block, root);
          if (atom) {
            // One word for the whole nowrap run, counted once (at its first
            // text node, so document order holds), on its last rect's line.
            if (!atomsSeen.has(atom)) {
              atomsSeen.add(atom);
              const rects = Array.from(atom.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
              const last = rects[rects.length - 1];
              if (last) {
                words.push({ top: last.top, bottom: last.bottom, word: (atom.textContent ?? '').replace(/\s+/g, ' ').trim() });
                cover.words += 1;
              }
            }
            blocks.set(block, words);
            continue;
          }
          for (const match of text.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index ?? 0);
            range.setEnd(node, (match.index ?? 0) + match[0].length);
            const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
            if (rects.length === 0) continue;
            const tops = new Set(rects.map((r) => Math.round(r.top)));
            // A compound that breaks at its own hyphen or slash is ordinary
            // wrapping, not a split word.
            const breaksAtOwnMark = /[-‐-–/]/.test(match[0]);
            if (
              tops.size >= 2 &&
              !breaksAtOwnMark &&
              !URL_OR_ID.test(match[0]) &&
              !parent.closest('a[href], code, .tok-id')
            ) {
              findings.push({
                kind: 'split-word',
                root: rootSelector,
                block: `${label(block)} < ${block.parentElement ? label(block.parentElement) : ''}`,
                text: (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
                word: match[0],
                lines: tops.size,
                words: 1
              });
            }
            const last = rects[rects.length - 1]!;
            words.push({ top: last.top, bottom: last.bottom, word: match[0] });
            cover.words += 1;
          }
          blocks.set(block, words);
        }

        for (const [block, words] of blocks) {
          if (words.length < 3) continue;
          let lines = 1;
          let lastLineWords = 1;
          for (let i = 1; i < words.length; i += 1) {
            if (words[i]!.top >= words[i - 1]!.bottom - 1) {
              lines += 1;
              lastLineWords = 1;
            } else {
              lastLineWords += 1;
            }
          }
          if (lines >= 2 && lastLineWords === 1) {
            findings.push({
              kind: 'orphan',
              root: rootSelector,
              block: `${label(block)} < ${block.parentElement ? label(block.parentElement) : ''}`,
              text: (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
              word: words[words.length - 1]!.word,
              lines,
              words: words.length
            });
          }
        }
      }
    }
    return { findings, coverage };
  }, roots);
}

/**
 * How many lines each matching element's text takes, by the same line rule
 * as the orphan scan (a control label that must read on one line, codex C1:
 * "Current Conditions" has two words, so the three-word floor never sees it).
 */
export async function lineCounts(
  page: Page,
  selector: string
): Promise<{ text: string; lines: number }[]> {
  return page.evaluate((sel: string) => {
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => (el as HTMLElement).getClientRects().length > 0)
      .map((el) => {
        const tops: { top: number; bottom: number }[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? '';
          for (const match of text.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index ?? 0);
            range.setEnd(node, (match.index ?? 0) + match[0].length);
            const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
            const last = rects[rects.length - 1];
            if (last) tops.push({ top: last.top, bottom: last.bottom });
          }
        }
        let lines = tops.length > 0 ? 1 : 0;
        for (let i = 1; i < tops.length; i += 1) {
          if (tops[i]!.top >= tops[i - 1]!.bottom - 1) lines += 1;
        }
        return { text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), lines };
      });
  }, selector);
}

/**
 * The fit scan (section 5 "Fit"; codex C3): for every visible element
 * matching each selector, `scrollWidth` and `scrollHeight` are within the
 * client size plus 0.5 px, no ellipsis or line clamp is engaged, and the
 * text's own rendered rectangle (a Range over the element's contents)
 * lies inside the element's border box within 0.5 px on every side.
 */
export async function findFitFailures(page: Page, selectors: readonly string[]): Promise<TextFitFinding[]> {
  return (await scanFit(page, selectors)).findings;
}

/**
 * `findFitFailures` plus, per selector, how many visible elements with text
 * the scan actually measured, so a caller can fail a scan that read nothing.
 */
export async function scanFit(
  page: Page,
  selectors: readonly string[]
): Promise<{ findings: TextFitFinding[]; measured: Record<string, number> }> {
  return page.evaluate((sels: readonly string[]) => {
    const TOL = 0.5;
    const out: { selector: string; element: string; text: string; reason: string }[] = [];
    const measured: Record<string, number> = {};
    for (const selector of sels) {
      let count = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        if (el.getClientRects().length === 0) continue;
        const probe = el as HTMLElement & { checkVisibility?: (options?: object) => boolean };
        if (typeof probe.checkVisibility === 'function' && !probe.checkVisibility({ checkVisibilityCSS: true })) {
          continue;
        }
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text === '') continue;
        count += 1;
        const style = getComputedStyle(el);
        const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).trim().split(/\s+/).join('.')}`;
        const reasons: string[] = [];
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + TOL) {
          reasons.push(
            `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` +
              (style.textOverflow === 'ellipsis' ? ' (ellipsis engaged)' : '')
          );
        }
        if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + TOL) {
          const clamp = style.getPropertyValue('-webkit-line-clamp');
          reasons.push(
            `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}` +
              (clamp && clamp !== 'none' ? ' (line clamp engaged)' : '')
          );
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const textBox = range.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        if (textBox.width > 0 && textBox.height > 0) {
          // A line-height smaller than the font's own content area lets the
          // content area hang past the line box by half the difference, on
          // each side, by CSS's own rule (negative half-leading); that much
          // is not the text leaving its box. A trimmed box gets no such
          // allowance: its line-height is not what sets its edges.
          const lineRects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
          const contentArea = lineRects.length > 0 ? lineRects[0]!.height : textBox.height;
          const lineHeight = Number.parseFloat(style.lineHeight);
          const trimmed = (style.getPropertyValue('text-box-trim') || 'none') !== 'none';
          const leading =
            !trimmed && Number.isFinite(lineHeight) ? Math.max(0, (contentArea - lineHeight) / 2) : 0;
          const out4 = {
            left: box.left - textBox.left,
            top: box.top - textBox.top - leading,
            right: textBox.right - box.right,
            bottom: textBox.bottom - box.bottom - leading
          };
          const over = Object.entries(out4).filter(([, v]) => v > TOL);
          if (over.length > 0) {
            reasons.push(
              `text ${textBox.left.toFixed(1)},${textBox.top.toFixed(1)},${textBox.right.toFixed(1)},${textBox.bottom.toFixed(1)} ` +
                `outside box ${box.left.toFixed(1)},${box.top.toFixed(1)},${box.right.toFixed(1)},${box.bottom.toFixed(1)} ` +
                `(${over.map(([k, v]) => `${k} ${v.toFixed(1)} px`).join(', ')})`
            );
          }
        }
        if (reasons.length > 0) out.push({ selector, element: name, text: text.slice(0, 80), reason: reasons.join('; ') });
      }
      measured[selector] = count;
    }
    return { findings: out, measured };
  }, selectors);
}

/** A one-line-per-finding rendering for an assertion message. */
export function describeFindings(findings: readonly (TextLineFinding | TextFitFinding)[]): string {
  return findings
    .map((f) =>
      'kind' in f
        ? `${f.kind} under ${f.root}: ${f.block} "${f.text}" -> "${f.word}" (${f.lines} lines, ${f.words} words)`
        : `${f.selector}: ${f.element} "${f.text}": ${f.reason}`
    )
    .join('\n');
}
