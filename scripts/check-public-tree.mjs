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
    pattern: /^(?:\.agent|\.agents|\.claude|\.codex|\.handoff|drought-region-maps|planning|post-mortem|research|reviews|skills)\//i
  },
  {
    reason: 'local product planning record',
    pattern: /^docs\/(?:IDEAS\.md|SOURCES_CATALOG\.yaml|SUCCESSOR_PLAN\.md|handoffs\/|prompts\/)/i
  },
  {
    reason: 'execution tracker',
    pattern: /(?:^|\/)MODULE_TRACKING\.yaml$/i
  }
];

// docs/ROADMAP.yaml:57-61 names four planning/ folders as repository authority
// and .gitignore negates them; the hook source drafts are tracked so the
// installed guardrails have a reviewable origin. Everything else under
// planning/ stays forbidden.
const allowed = [
  // planning/references/ joined the tracked ledgers on 2026-09-07 by owner
  // ruling (the S03b references register). That ruling added the matching
  // .gitignore negation; this list is the second half of it, because this
  // script keeps its own allow-list rather than reading .gitignore.
  /^planning\/(?:decisions|qa|user-research|handoffs|references)\//i,
  /^planning\/2026-09-01-deep-dive\/claude-tooling\/hooks\//i
];

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
