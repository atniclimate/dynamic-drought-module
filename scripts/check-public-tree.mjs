/**
 * Keep local agent, session, and planning artifacts out of the public Git tree.
 * The files may exist in a working copy under .gitignore; only tracked paths
 * are evaluated here.
 */

import { execFileSync } from 'node:child_process';

const tracked = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8'
})
  .split('\0')
  .filter(Boolean);

const forbidden = [
  {
    reason: 'agent or session record',
    pattern: /(?:^|\/)(?:AGENTS|CLAUDE|[^/]*HANDOFF[^/]*|[^/]*POST[_-]MORTEM[^/]*)\.md$/i
  },
  {
    reason: 'root scaffold or kickoff record',
    pattern: /^(?:KICKOFF|ORIGIN)\.md$/i
  },
  {
    reason: 'local process directory',
    pattern: /^(?:\.agent|\.agents|\.claude|\.codex|\.handoff|\.planning|drought-region-maps|planning|post-mortem|research|reviews|skills)\//i
  },
  {
    reason: 'local product planning record',
    pattern: /^docs\/(?:IDEAS\.md|SOURCES_CATALOG\.yaml|SUCCESSOR_PLAN\.md|ROADMAP\.yaml|PROJECT_GUIDE\.md|README-RESUME\.md|session-briefing|claude-|handoffs\/|prompts\/)/i
  },
  {
    reason: 'development roadmap or harness entry point (private since 2026-09-08)',
    pattern: /^(?:ROADMAP\.md|CLAUDE\.md|AGENTS\.md)$/i
  },
  {
    reason: 'execution tracker',
    pattern: /(?:^|\/)MODULE_TRACKING\.yaml$/i
  }
];

// 2026-09-08: nothing under planning/ or .planning/ is tracked any more, and
// neither are the roadmap files, the project guide, the session briefing or
// the root CLAUDE.md: all of it moved to two private repositories that are
// linked into a checkout as directory junctions. The allow-list is therefore
// empty and kept only so the loop below keeps its shape for the next
// exception the owner grants.
const allowed = [];

const problems = [];
for (const path of tracked) {
  if (allowed.some((pattern) => pattern.test(path))) continue;
  for (const rule of forbidden) {
    if (rule.pattern.test(path)) {
      problems.push(`${path}: ${rule.reason}`);
      break;
    }
  }
}

if (problems.length > 0) {
  console.error(`public-tree check: ${problems.length} forbidden tracked path(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`public-tree check: clean (${tracked.length} tracked files)`);
