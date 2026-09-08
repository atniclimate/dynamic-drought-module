// Draft of I:\dynamic-drought-module\.claude\hooks\no-heredoc.mjs (owner-authored, 2026-09-07).
// The owner installs hooks from this tracked drafts folder; the installed copy is
// gitignored under .claude/. PreToolUse on Bash: deny any command carrying a bash
// heredoc or here-string, which the Bash tool mangles on this machine (CLAUDE.md,
// conduct rule 3). Both supported deny routes are emitted: exit 2 with the reason on
// stderr, and the structured permissionDecision on stdout.
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = JSON.parse(data).tool_input?.command ?? ''; } catch {}
  if (/<<</.test(cmd) || /<<-?\s*['"]?[A-Za-z_]/.test(cmd)) {
    process.stderr.write(
      'BLOCKED by CLAUDE.md: bash heredocs and here-strings hang on this machine. ' +
      'Write the content with the Write tool, or pass it through python -c / node -e.\n'
    );
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'heredoc forbidden by CLAUDE.md'
      }
    }));
    process.exit(2);
  }
  process.exit(0);
});
