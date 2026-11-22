#!/usr/bin/env node
/**
 * One command before every push: every check a push can meet on this
 * machine, then a plain list of what is left for GitHub (audit of 23 red
 * runs, 2026-11-22: fixes went out without re-running the cases that had
 * just failed, and the local run refused every block).
 *
 *   node scripts/check-push.mjs [--base <ref>] [--block] [--branch <work branch>]
 *
 * In order, stopping at the first that fails:
 *   1. Refuse (exit 2) uncommitted changes the build reads, or nothing to push.
 *   2. Browser-free: `npm run typecheck`, then `npm run check:all` (exit 1).
 *   3. Stale mentions over the range, as `npm run spec:impact` (exit 1).
 *   4. Select: Tier 1 (the tests the range edited, plus the cases of the
 *      branch's last Validate run when it was red), Tier 2 (the file rules),
 *      and the BROAD verdict for a helper change that reaches every boot.
 *   5. Refuse a held 4173 or 4180 (exit 2), then one local run, two workers,
 *      chromium and chromium-interaction, of everything when it fits the
 *      ten-minute estimate, otherwise of Tier 1. A case that fails there runs
 *      once more alone, as GitHub gives a failed case one retry: failing
 *      alone too is exit 1; passing only alone is named as a retry-only pass
 *      (two workers on this laptop timed out two heavy cases, 2026-11-22).
 *   6. Name the remainder (over the limit, chromium-3d, BROAD) and how GitHub
 *      covers it: the open pull request's own run, or the exact command to
 *      run after the push.
 * Exit 0: everything selected ran here and passed, nothing remains. Exit 3:
 * the local part passed, or passed only alone, and the named remainder and
 * any retry-only case are GitHub's to decide.
 *
 * The range is the unpushed commits: from the work branch's origin tip when
 * HEAD contains it, otherwise (or with --block) from the merge base with
 * origin/main. It never pushes and never dispatches; those stay the
 * session's actions.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_LIMIT_SECONDS,
  REPO,
  busyPort,
  costModel,
  describeSelection,
  gather,
  git,
  mergeEntries,
  minutes,
  openPullRequest,
  parseEntry,
  planLocalRun,
  readTimings,
  redSelection,
  runLocally,
  validateRuns,
  workBranch,
  workingTreeRefusal
} from './spec-impact.mjs';

export const EXIT = { passed: 0, failed: 1, refused: 2, remainder: 3 };

/** `{ base, block, branch }` from the command line; throws on a flag without its value. */
export function parseArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[at + 1];
  };
  const known = new Set(['--base', '--block', '--branch']);
  const unknown = argv.filter((arg, i) => arg.startsWith('--') && !known.has(arg) && !['--base', '--branch'].includes(argv[i - 1]));
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(' ')}`);
  return { base: value('--base'), block: argv.includes('--block'), branch: value('--branch') };
}

/**
 * Where the range starts: `--base`, else the pushed tip of the work branch
 * when HEAD contains it (the unpushed commits), else the block's merge base.
 */
export function pushBase({ base, block, pushedTip, containsPushed, mergeBase }) {
  if (base) return base;
  if (!block && pushedTip && containsPushed) return pushedTip;
  return mergeBase;
}

/** Why there is nothing for this command to check, or null. */
export function nothingToPush(ahead, base) {
  return ahead === 0 ? `Nothing to push: HEAD has no commits after ${base}.` : null;
}

/**
 * The red run whose cases join Tier 1: the branch's newest finished Validate
 * run when it failed. A newer pass means its cases have since passed on
 * GitHub, and a cancelled or running one says nothing yet, so it is skipped.
 */
export function lastRedRun(runs) {
  const finished = runs.find((run) => run.status === 'completed' && ['success', 'failure'].includes(run.conclusion));
  return finished?.conclusion === 'failure' ? finished : null;
}

/** The remainder GitHub must cover: `{ over, threeD, broad, any }`. */
export function remainderOf(plan, broad) {
  const remainder = { over: plan.over, threeD: plan.threeD, broad: broad.map(({ broad: reason }) => reason) };
  return { ...remainder, any: remainder.over.length + remainder.threeD.length + remainder.broad.length > 0 };
}

/**
 * What to say about the remainder, as lines. An open pull request's run on
 * the push is full integration and covers all of it; without one, the exact
 * command the session runs after the push (a dispatch is its action, not
 * this command's). `openPull` is null when none is open and undefined when
 * GitHub could not be asked.
 */
export function remainderAdvice(remainder, { openPull, branch, base }) {
  if (!remainder.any) return [];
  const lines = [];
  if (remainder.broad.length > 0) lines.push(...remainder.broad.map((reason) => `BROAD: ${reason}.`));
  if (remainder.threeD.length > 0) lines.push(`chromium-3d, never run locally: ${remainder.threeD.join(' ')}`);
  if (remainder.over.length > 0) lines.push(`Over the ${minutes(LOCAL_LIMIT_SECONDS)} local limit: ${remainder.over.join(' ')}`);
  if (openPull) {
    lines.push(`Pull request #${openPull.number} is open on ${branch}: the push runs the full Validate, which covers this remainder. Do not dispatch.`);
    return lines;
  }
  if (!branch) lines.push('No work branch on origin contains HEAD yet. After pushing one, run the command below on it.');
  else if (openPull === undefined) lines.push(`Whether a pull request is open on ${branch} is unknown: if one is, its run covers this and nothing is dispatched.`);
  lines.push(remainder.broad.length > 0
    ? `After the push, the full run: gh workflow run validate.yml --ref ${branch ?? 'the work branch'} -R ${REPO}`
    : `After the push, the targeted run: npm run spec:impact -- --dispatch --base ${base}`);
  return lines;
}

/** The exit code of a finished check. A retry-only pass is never a clean 0. */
export function exitCode({ localFailed, retryOnly = false, remainder }) {
  if (localFailed) return EXIT.failed;
  return remainder.any || retryOnly ? EXIT.remainder : EXIT.passed;
}

function npm(script) {
  console.log(`\n> npm run ${script}`);
  // npm is a .cmd on Windows, which Node only starts through a shell.
  return spawnSync(`npm run ${script}`, { stdio: 'inherit', shell: true }).status ?? 1;
}

const heading = (text) => console.log(`\n== ${text}`);

async function main(argv) {
  const args = parseArgs(argv);

  heading('1. Refusals');
  const dirty = workingTreeRefusal();
  if (dirty) {
    console.error(dirty);
    return EXIT.refused;
  }
  const branch = args.branch ?? workBranch();
  const pushedTip = branch ? git(['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0].trim() || null : null;
  const containsPushed = Boolean(pushedTip) && spawnSync('git', ['merge-base', '--is-ancestor', pushedTip, 'HEAD']).status === 0;
  const base = pushBase({ ...args, pushedTip, containsPushed, mergeBase: git(['merge-base', 'HEAD', 'origin/main']).trim() });
  const nothing = nothingToPush(Number(git(['rev-list', '--count', `${base}..HEAD`]).trim()), base);
  if (nothing) {
    console.error(nothing);
    return EXIT.refused;
  }
  console.log(`Work branch: ${branch ?? 'none on origin yet'}. Range ${base}..HEAD.`);

  heading('2. Browser-free checks');
  for (const script of ['typecheck', 'check:all']) {
    if (npm(script) !== 0) {
      console.error(`npm run ${script} failed.`);
      return EXIT.failed;
    }
  }

  heading('3. Stale mentions');
  const picked = gather(base);
  const stale = picked.mentions.filter(({ absent }) => !absent);
  for (const { file, line, text } of stale) console.log(`${file}:${line}  ${JSON.stringify(text)}`);
  if (stale.length > 0) {
    console.error(`${stale.length} spec lines name a string the range removed and HEAD no longer has.`);
    return EXIT.failed;
  }
  console.log('None.');

  heading('4. Selection');
  const reason = (error) => String(error.stderr || error.message).trim();
  let openPull = null;
  let red = null;
  if (branch) {
    try {
      openPull = openPullRequest(branch);
    } catch (error) {
      openPull = undefined;
      console.log(`Could not ask GitHub for an open pull request on ${branch}: ${reason(error)}`);
    }
    try {
      const run = lastRedRun(validateRuns(branch));
      if (run) red = redSelection(run.databaseId, picked.specs);
    } catch (error) {
      // The last red is an addition to the selection, not a gate: say it was
      // not read, so a missing case is never mistaken for a pass.
      console.log(`Could not read ${branch}'s last Validate run, so its red cases are not in this selection: ${reason(error)}`);
    }
  }
  if (red) {
    console.log(`Validate run ${red.run} on ${branch} was red: ${red.failed.length} failed cases join Tier 1.`);
    for (const { file, line, title } of red.unmatched) console.log(`  not found at HEAD (renamed or removed?): ${file}:${line} "${title}"`);
  }
  const redBrowser = (red?.entries ?? []).filter((entry) => !picked.pureOnly.has(parseEntry(entry).file));
  // A red pure case already ran in check:all, in the pure lane.
  const tier1 = mergeEntries([...redBrowser, ...picked.tier1]);
  const plan = planLocalRun({ tier1, tier2: picked.tier2, fire3d: picked.fire3d, cost: costModel(readTimings()) });
  for (const line of describeSelection({ ...picked, tier1 }, plan)) console.log(line);

  heading('5. Local run');
  let localFailed = false;
  let retryOnly = false;
  if (plan.run.length === 0) {
    console.log('Nothing selected for a local run.');
  } else {
    const port = await busyPort();
    if (port) {
      console.error(`Port ${port} is already listening on 127.0.0.1: one browser runner at a time. Stop it first.`);
      return EXIT.refused;
    }
    localFailed = runLocally(plan.run) !== 0;
    if (localFailed) {
      console.log('\nA case failed at two workers. On GitHub a failed case gets one retry; here it gets one run alone.');
      localFailed = runLocally(plan.run, { workers: 1, lastFailed: true }) !== 0;
      retryOnly = !localFailed;
      if (retryOnly) console.log('Passed only alone: the failed cases above are retry-only passes on this machine, not passes. Name them with the push; GitHub\'s run decides.');
    }
  }

  heading('6. Remainder');
  const remainder = remainderOf(plan, picked.broad);
  const advice = remainderAdvice(remainder, { openPull, branch, base });
  console.log(advice.length > 0 ? advice.join('\n') : 'None: everything selected ran here.');
  const code = exitCode({ localFailed, retryOnly, remainder });
  const passedPart = retryOnly ? 'The local part passed, some cases only alone (named above)' : 'The local part passed';
  console.log(`\n${{ 0: 'Passed, nothing remains.', 1: 'A local case failed, alone too.', 3: `${passedPart}; the remainder above is GitHub\'s.` }[code]}`);
  return code;
}

// Not import.meta.main: it is undefined before Node 24.2, and engines admits 24.0.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = EXIT.refused;
  }
}
