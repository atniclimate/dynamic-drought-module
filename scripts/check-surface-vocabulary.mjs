/**
 * Surface-scoped vocabulary lint (0.8.0 T-P0-6; BRIEF L4 mandate, doctrine
 * item 5; hardened per the 2026-07-21 DG-080-REVIEW). DDM-computed surface
 * copy speaks in context and potential; it never calls its own reads a
 * "warning", an "alert", or a "forecast". Those words are reserved for what
 * they verbatim are upstream: National Weather Service (NWS) products, the
 * Northwest River Forecast Center (NWRFC) and its Water Supply Forecast,
 * Storm Prediction Center (SPC) outlooks, and honesty disclaimers that use
 * the word to DENY being one ("not a forecast of outcomes").
 *
 * Scope (the surface-authoring boundary, per the review):
 *   - ALL of src/ (.ts and .tsx): surface prose is authored across impact,
 *     ui, layers, config, and state modules, so no directory is exempt.
 *   - Only STRING LITERALS and JSX TEXT are linted, after comments are
 *     stripped; identifiers and comments are not surface strings.
 *   - Structural exclusions, not directory exclusions, keep non-surface
 *     strings out: lines that construct internal diagnostics
 *     (console.*(...), new Error(...)) are skipped; single-token literals
 *     are linted only when the whole literal is a CAPITALIZED banned word
 *     ('Warning', 'Alerts'): DDM labels are Title Case in this codebase,
 *     while lowercase single tokens are keys, ARIA roles, and CSS classes
 *     ('alert', 'nws-alerts'). That capitalization boundary is a stated
 *     limitation, not an accident.
 *   - In .tsx files, JSX text nodes (text between tags, outside braces) are
 *     extracted and linted too; JSX is an active surface-authoring path.
 *
 * Allowance: a REAL COMMENT TOKEN (line or block; pragma text inside a
 * string literal is ignored, so it cannot be forged from rendered copy)
 * carrying
 *     vocab-allow: <reason>
 * on the literal's anchor line or the line above allows it; the reason is
 * REQUIRED. Multi-line template literals anchor to their first line (a
 * comment inside a template would render). The pragma is the review
 * surface: every allowed use of a banned word is explicit, named, diffable.
 *
 * Self-test: `--self-test` runs the lint against tests/fixtures/vocabulary/.
 * Every fail-*.ts(x) fixture must produce at least one finding, every
 * pass-*.ts(x) fixture must produce none, at least one of EACH class must
 * exist, and any other .ts/.tsx name there fails as unclassified. The gate
 * runs the self-test FIRST, then the real tree.
 *
 * Run: node scripts/check-surface-vocabulary.mjs [--self-test]
 * Wired into `npm run gate` as check:vocabulary (self-test + tree).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCOPE_DIRS = ['src'];
const FIXTURE_DIR = 'tests/fixtures/vocabulary';

// "digital twin" and "simulation" joined the banned list with the 3D Fire
// context work (W-CTX): in the wildfire-visualization field "digital twin"
// is a term of art for systems that bundle physics-based fire simulation
// with rendering (NASA Wildfire Digital Twin, FIRETWIN), and DDM computes
// no simulation, so surface copy claiming either would overclaim exactly
// what the 3D view must disclaim. An upstream product whose verbatim name
// carries the word takes the same vocab-allow pragma as the other rows.
const BANNED = /\b(warning|alert|forecast)s?\b|\bdigital[\s-]?twins?\b|\bsimulat(?:es?|ed|ions?|ing|ors?)\b/gi;
const CAPITALIZED_TOKEN = /^(Warning|Alert|Forecast|Simulation|Simulator|Simulated|Simulating)s?$/;
const PRAGMA = /vocab-allow:\s*(.*?)\s*(?:\*\/.*)?$/;
const DIAGNOSTIC_LINE = /console\.(warn|error|log|info|debug)\s*\(|new\s+Error\s*\(/;

const REGEX_KEYWORDS = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'yield', 'await', 'do', 'else', 'throw'
]);

/** Recursively collect .ts/.tsx files under a directory. */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Decode one escape sequence at src[i] (the char after the backslash);
 * returns [decodedText, nextIndex]. Unicode/hex escapes decode to their
 * character so an escaped spelling cannot evade the banned-word match. */
function decodeEscape(src, i) {
  const c = src[i];
  if (c === 'u') {
    if (src[i + 1] === '{') {
      const end = src.indexOf('}', i + 2);
      if (end > 0) {
        return [String.fromCodePoint(parseInt(src.slice(i + 2, end), 16) || 0), end + 1];
      }
    }
    const hex = src.slice(i + 1, i + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return [String.fromCharCode(parseInt(hex, 16)), i + 5];
    }
  }
  if (c === 'x') {
    const hex = src.slice(i + 1, i + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      return [String.fromCharCode(parseInt(hex, 16)), i + 3];
    }
  }
  if (c === 'n' || c === 'r') return ['\n', i + 1];
  if (c === 't') return [' ', i + 1];
  return [c ?? '', i + 1];
}

/**
 * Lex TypeScript source: extract string-literal/template chunks (with
 * recursion into template interpolations) and COMMENT TOKENS (the only
 * place a pragma counts). Small state machine; the regex-vs-division
 * heuristic uses the previous significant char plus a keyword set.
 * Returns { literals: [{ text, line, anchor }], comments: [{ text, line }] }.
 */
function lex(src, baseLine = 1, outerAnchor = null) {
  const literals = [];
  const comments = [];
  let i = 0;
  let line = baseLine;
  const n = src.length;
  let prevSig = '';
  let word = '';
  const sawValue = () => {
    prevSig = ')';
    word = '';
  };
  const push = (text, atLine, anchor = null) => {
    if (text) literals.push({ text, line: atLine, anchor: anchor ?? outerAnchor ?? atLine });
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i += 1;
      comments.push({ text: src.slice(start, i), line });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      comments.push({ text: src.slice(start, i), line: startLine });
      continue;
    }
    if (c === '/') {
      const regexStart =
        prevSig === '' ||
        '=([{,;:!&|?+*%<>~^-'.includes(prevSig) ||
        REGEX_KEYWORDS.has(word);
      if (regexStart) {
        i += 1;
        let inClass = false;
        while (i < n && (inClass || src[i] !== '/') && src[i] !== '\n') {
          if (src[i] === '\\') i += 1;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          i += 1;
        }
        i += 1;
        sawValue();
        continue;
      }
      prevSig = '/';
      word = '';
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const startLine = line;
      let buf = '';
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          const [decoded, next] = decodeEscape(src, i + 1);
          buf += decoded;
          i = next;
          continue;
        }
        if (src[i] === '\n') line += 1;
        buf += src[i];
        i += 1;
      }
      i += 1;
      push(buf, startLine);
      sawValue();
      continue;
    }
    if (c === '`') {
      let buf = '';
      const templateAnchor = outerAnchor ?? line;
      let chunkLine = line;
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') {
          const [decoded, next] = decodeEscape(src, i + 1);
          buf += decoded;
          i = next;
          continue;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          push(buf, chunkLine, templateAnchor);
          buf = '';
          i += 2;
          // Capture the interpolation expression: brace counting skips
          // quoted strings AND comments so a brace inside either cannot
          // desync; the captured text is lexed recursively (literals inside
          // interpolations are surface strings too).
          const exprStart = i;
          const exprLine = line;
          let depth = 1;
          while (i < n && depth > 0) {
            const e = src[i];
            if (e === "'" || e === '"' || e === '`') {
              const q = e;
              i += 1;
              while (i < n && src[i] !== q) {
                if (src[i] === '\\') i += 1;
                else if (src[i] === '\n') line += 1;
                i += 1;
              }
            } else if (e === '/' && src[i + 1] === '/') {
              while (i < n && src[i] !== '\n') i += 1;
              continue;
            } else if (e === '/' && src[i + 1] === '*') {
              i += 2;
              while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') line += 1;
                i += 1;
              }
              i += 1;
            } else if (e === '{') depth += 1;
            else if (e === '}') {
              depth -= 1;
              if (depth === 0) break;
            } else if (e === '\n') line += 1;
            i += 1;
          }
          const inner = lex(src.slice(exprStart, i), exprLine, templateAnchor);
          literals.push(...inner.literals);
          comments.push(...inner.comments);
          i += 1;
          chunkLine = line;
          continue;
        }
        if (src[i] === '\n') {
          line += 1;
          buf += src[i];
          i += 1;
          push(buf, chunkLine, templateAnchor);
          buf = '';
          chunkLine = line;
          continue;
        }
        buf += src[i];
        i += 1;
      }
      i += 1;
      push(buf, chunkLine, templateAnchor);
      sawValue();
      continue;
    }
    if (!/\s/.test(c)) {
      prevSig = c;
      word = /[A-Za-z0-9_$]/.test(c) ? word + c : '';
    }
    i += 1;
  }
  return { literals, comments };
}

/**
 * Extract JSX text nodes from a .tsx source: with strings and comments
 * blanked (preserving line structure), capture text runs between `>` and
 * `<` that contain letters. Code between comparison operators rarely
 * survives the letters requirement AND the banned-word match (identifiers
 * like alertCount have no word boundary), so residual false positives are
 * handled by the same pragma mechanism.
 */
function extractJsxText(src) {
  const blanked = blankNonCode(src);
  const out = [];
  const re = />([^<>{}]*[A-Za-z][^<>{}]*)</g;
  let m;
  while ((m = re.exec(blanked)) !== null) {
    const line = blanked.slice(0, m.index).split('\n').length;
    out.push({ text: m[1], line, anchor: line });
  }
  return out;
}

/** Replace string/template/comment contents with spaces, keeping newlines,
 * so JSX scanning never reads inside them. */
function blankNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += ' ';
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += ' ';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Strip HTML tags from a literal: complete tags, plus a trailing UNCLOSED
 * tag only when it starts like one (`<span ...`), so comparison copy like
 * "Forecast < 20" keeps its text. */
function stripMarkup(text) {
  return text.replace(/<\/?[A-Za-z][^>]*>/g, ' ').replace(/<\/?[A-Za-z][^>]*$/, ' ');
}

/** Lint one file; returns findings [{ file, line, word, text }]. */
function lintFile(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const srcLines = src.split(/\r?\n/);
  const { literals, comments } = lex(src);
  const findings = [];

  // Pragmas come from REAL comment tokens only (a "// vocab-allow:" inside
  // a rendered string cannot allow anything). A block comment spanning
  // lines registers at its start line.
  const pragmaByLine = new Map();
  for (const cm of comments) {
    const m = cm.text.match(PRAGMA);
    if (m) pragmaByLine.set(cm.line, m[1].trim().length > 0 ? 'ok' : 'empty');
  }
  const allowedAt = (lineNo) =>
    pragmaByLine.get(lineNo) ?? pragmaByLine.get(lineNo - 1) ?? null;

  const candidates = [...literals];
  if (absPath.endsWith('.tsx')) candidates.push(...extractJsxText(src));

  for (const lit of candidates) {
    const prose = stripMarkup(lit.text);
    // Single tokens: lint only a whole-literal CAPITALIZED banned word (a
    // DDM label like 'Warning'); lowercase tokens are keys/roles/classes.
    if (!prose.trim().includes(' ')) {
      if (!CAPITALIZED_TOKEN.test(prose.trim())) continue;
    }
    // Group 1 exists only for the original word family; the phrase and
    // simulation alternatives report their whole match.
    const words = [...prose.matchAll(BANNED)].map((m) => (m[1] ?? m[0]).toLowerCase());
    if (words.length === 0) continue;
    const anchorSrcLine = srcLines[lit.anchor - 1] ?? '';
    if (DIAGNOSTIC_LINE.test(anchorSrcLine)) continue;
    const allowed = allowedAt(lit.anchor);
    if (allowed === 'ok') continue;
    findings.push({
      file: relative(ROOT, absPath).replace(/\\/g, '/'),
      line: lit.line,
      word: [...new Set(words)].join(', '),
      text: lit.text.length > 90 ? `${lit.text.slice(0, 87)}...` : lit.text,
      emptyReason: allowed === 'empty'
    });
  }
  return findings;
}

function lintTree() {
  const files = SCOPE_DIRS.flatMap((d) => collect(join(ROOT, d)));
  return files.flatMap(lintFile);
}

function selfTest() {
  const dir = join(ROOT, FIXTURE_DIR);
  const failures = [];
  let passCount = 0;
  let failCount = 0;
  for (const name of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
    const findings = lintFile(join(dir, name));
    if (name.startsWith('fail-')) {
      failCount += 1;
      if (findings.length === 0) failures.push(`${name}: expected at least one finding, got none`);
    } else if (name.startsWith('pass-')) {
      passCount += 1;
      if (findings.length > 0) {
        failures.push(
          `${name}: expected no findings, got ${findings.length} (first: line ${findings[0].line} "${findings[0].text}")`
        );
      }
    } else {
      failures.push(`${name}: unclassified fixture (name must start with pass- or fail-)`);
    }
  }
  if (passCount === 0) failures.push('no pass-* fixtures found (the fixture set is broken)');
  if (failCount === 0) failures.push('no fail-* fixtures found (the fixture set is broken)');
  return failures;
}

const selfTestOnly = process.argv.includes('--self-test');

const selfFailures = selfTest();
if (selfFailures.length > 0) {
  console.error('surface-vocabulary SELF-TEST FAILED (the lint itself is broken):');
  for (const f of selfFailures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('surface-vocabulary self-test: clean (fixtures prove both directions)');
if (selfTestOnly) process.exit(0);

const findings = lintTree();
if (findings.length > 0) {
  console.error(
    'surface-vocabulary check FAILED: DDM-computed surface copy must not call its own reads a warning, alert, or forecast (BRIEF L4). For a VERBATIM upstream product name or an honesty disclaimer, add a real comment `vocab-allow: <reason>` on or above the line.'
  );
  for (const f of findings) {
    console.error(
      `  ${f.file}:${f.line} [${f.word}]${f.emptyReason ? ' (vocab-allow present but the reason is empty)' : ''} "${f.text}"`
    );
  }
  process.exit(1);
}
console.log('surface-vocabulary check: clean');
