// Draft of I:\dynamic-drought-module\.claude\hooks\no-heredoc.mjs
// (owner-authored 2026-09-07; revised 2026-09-08.)
//
// The owner installs hooks from this tracked drafts folder; the installed copy is
// gitignored under .claude/. PreToolUse on Bash: deny any command carrying a bash
// heredoc (<< delimiter) or here-string (<<<), which the Bash tool mangles on this
// machine (CLAUDE.md, conduct rule 3).
//
// Revision 2026-09-08 -- look for the operator only where bash would read one.
// The first version tested the raw command string, so a command that merely
// CONTAINED the characters was denied even though no redirection was present:
//
//     grep -rn '<<<<<<<' src        (searching for merge-conflict markers)
//     git log --grep='<<Foo'
//
// Both now pass. Instead of a regex over the whole string, heredocOperator()
// walks the command once and skips the spans where bash reads text rather than
// syntax, testing for << only at the positions left over:
//
//     'single-quoted'  "double-quoted"     quoted strings
//     \<  \'  \x                           a backslash escape (both characters)
//     $(( a << b ))   (( a << b ))         arithmetic, where << is a left shift
//
// Command substitution $( ... ) is deliberately NOT skipped, so a heredoc inside
// one is still caught. The operator is judged before its own delimiter is
// skipped, so the quoted and escaped delimiter forms -- <<'EOF' and <<\EOF --
// are caught too.
//
// Two conservative cases remain, both erring toward allowing the command: an
// unbalanced quote (unparseable bash anyway) swallows the rest of the string,
// and a delimiter starting with a digit (`cat <<2`) is not recognized, because
// requiring a letter or underscore is what keeps arithmetic left shifts out.
//
// Revision 2026-09-08 (owner ruling) -- quote-skipping alone let a heredoc hide
// inside the quoted payload of a nested shell or of `node -e`:
//
//     bash -c "cat <<EOF"
//     sh -c 'read x <<<y'
//     node -e "child_process.execSync('cat <<EOF')"
//
// All three eventually run the quoted text as a shell command, so their quoted
// argument is rescanned in invokerHeredocOperator() -- raw, with no quote- or
// arithmetic-skipping of its own, because at that depth the outer shell's
// quoting rules no longer apply and the bias is toward catching a hidden
// operator over missing one. `node -e` / `--eval` is treated as an invoker
// because a JS string literal passed to it commonly reaches execSync/exec;
// `python -c` is deliberately NOT, since its payload is Python source where a
// bare `<<` is ordinarily a left shift, not shell redirection. When an allow
// case and a deny case conflict, deny wins.
//
// Both supported deny routes are emitted: exit 2 with the reason on stderr, and
// the structured permissionDecision on stdout.

import { pathToFileURL } from 'node:url';

// What may follow << for it to be a heredoc: optional -, blanks (never a
// newline; the delimiter sits on the operator's own line), then an optionally
// escaped or quoted word starting with a letter or underscore.
const DELIMITER = /^-?[ \t]*\\?['"]?[A-Za-z_]/;

const QUOTES = "'\"";

/** Index of the quote closing the one at `start`, or the last index if unbalanced. */
function closingQuote(command, start) {
  const quote = command[start];
  let i = start + 1;
  while (i < command.length) {
    // Backslash escapes apply inside double quotes only; in single quotes they are literal.
    if (quote === '"' && command[i] === '\\') {
      i += 2;
      continue;
    }
    if (command[i] === quote) return i;
    i += 1;
  }
  return command.length - 1;
}

/** Index of the )) closing an arithmetic span opened at `start`, or the last index. */
function closingArith(command, start) {
  const found = command.indexOf('))', start);
  return found === -1 ? command.length - 1 : found + 1;
}

// A shell invoker's flag that takes a command string: bash/sh/zsh/dash -c, or
// node's -e/--eval. python -c is deliberately excluded; see the revision note
// above.
const INVOKER = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash)\s+-c\s+|(?:^|[\s;&|(])node\s+(?:-e|--eval)\s+/g;

/** Every invoker-argument's inner text (the quoted span with its quotes stripped). */
function invokerArguments(command) {
  const spans = [];
  for (const match of command.matchAll(INVOKER)) {
    const argStart = match.index + match[0].length;
    if (!QUOTES.includes(command[argStart])) continue;
    const closeAt = closingQuote(command, argStart);
    spans.push(command.slice(argStart + 1, closeAt));
  }
  return spans;
}

/**
 * Raw scan of an invoker's argument text: no quote- or arithmetic-skipping,
 * because at this depth the text is either shell being re-invoked or a
 * foreign language whose own string literals can carry a shell command
 * (node -e's JS string passed to execSync). Every `<<`/`<<<` is judged.
 */
function invokerHeredocOperator(text) {
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('<<', i)) {
      if (text[i + 2] === '<') return 'here-string (<<<)';
      if (DELIMITER.test(text.slice(i + 2))) return 'heredoc (<< delimiter)';
    }
    i += 1;
  }
  return null;
}

/** Name the forbidden operator this command actually carries, or null. */
export function heredocOperator(command) {
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (QUOTES.includes(ch)) {
      i = closingQuote(command, i) + 1;
      continue;
    }
    if (command.startsWith('$((', i)) {
      i = closingArith(command, i + 3) + 1;
      continue;
    }
    if (command.startsWith('((', i)) {
      i = closingArith(command, i + 2) + 1;
      continue;
    }
    if (command.startsWith('<<', i)) {
      if (command[i + 2] === '<') return 'here-string (<<<)';
      if (DELIMITER.test(command.slice(i + 2))) return 'heredoc (<< delimiter)';
    }
    i += 1;
  }
  for (const arg of invokerArguments(command)) {
    const operator = invokerHeredocOperator(arg);
    if (operator) return operator;
  }
  return null;
}

function main() {
  let data = '';
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    let cmd = '';
    try {
      cmd = JSON.parse(data).tool_input?.command ?? '';
    } catch {
      // Unparseable payload: nothing to judge, let the command through.
    }
    const operator = heredocOperator(cmd);
    if (operator) {
      process.stderr.write(
        'BLOCKED by CLAUDE.md: this command carries a bash ' + operator + '. Heredocs and '
        + 'here-strings hang on this machine. Write the content with the Write tool, or pass '
        + 'it through python -c / node -e.\n'
      );
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: operator + ' forbidden by CLAUDE.md',
        },
      }));
      process.exit(2);
    }
    process.exit(0);
  });
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) main();
