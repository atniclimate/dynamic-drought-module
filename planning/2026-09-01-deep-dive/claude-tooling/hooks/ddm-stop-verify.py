"""DDM Stop hook: run the cheap rungs of the verification ladder. DR-003.

Installed 2026-09-02 as an adaptation of this draft; the draft was resynced
to the installed copy on 2026-09-07 when the smoke tier was added, so this
file is the source of truth again and install-hooks.ps1 copies it verbatim.

DR-003 ratified that this hook MAY BLOCK a turn, because it catches U+2014
and the other machine-checkable rules, and that DDM_STOP_LEVEL selects the
tier:

  fast (DEFAULT, and what settings.local.json sets)
      `npm run typecheck` then `npm run scan:emdash`. No browser work of any
      kind. Measured together at about 2.3 s on this machine.
  full
      `npm run verify:quick` (adds check:vocabulary and check:coverage;
      measured 6.5 s). Still no browser work. "quick" is accepted as an
      alias, since that was the draft's name for this tier.
  smoke
      `npm run verify:smoke`: the full gate (build, bundle, activation,
      check:all) then twelve Playwright specs at --workers=1, about six
      minutes. The ONLY tier that does browser work. It needs the Stop
      hook's `timeout` in settings raised above the installed 240 s
      (TIMEOUTS below allows 900 s for the subprocess), and it honours the
      one-runner-at-a-time rule: do not select it while another runner is up.
  off
      disabled.

Why Stop and not PostToolUse: a typecheck is 1.5 s, but a single refactor is
five or six sequential edits, and a PostToolUse hook would pay that on every
one of them AND report errors from a tree the agent is halfway through
changing. At Stop the tree is coherent and the cost is paid once per turn.

SKIP RULE (DR-003): it runs only when something under src/, tests/,
scripts/, docs/ or the repository-root markdown files has changed since the
last pass. WORKERS/ IS WATCHED TOO, deliberately: tsconfig includes it, so
skipping a workers-only change would let a red typecheck through. Drop
"workers" from WATCHED_DIRS below if the owner wants the DR-003 list exactly.
State is a digest of HEAD plus the porcelain status of those paths plus the
mtimes of the dirty ones, kept in %TEMP%/ddm-stop-verify/<key>.txt and
written ONLY on green, so a red turn is re-checked next time.

Green: exit 0 with one `systemMessage` line.
Red: exit 2 with the last 25 lines of output on stderr, which per the hooks
reference ("Exit code 2 behavior per event": Stop, "Prevents Claude from
stopping; continues the conversation") stops the turn and hands the failure
back. `stop_hook_active` is honoured so this can never loop.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys

WATCHED_DIRS = ("src/", "tests/", "scripts/", "docs/", "workers/")
LEVELS = {
    "fast": [["run", "typecheck"], ["run", "scan:emdash"]],
    "full": [["run", "verify:quick"]],
    "quick": [["run", "verify:quick"]],
    "smoke": [["run", "verify:smoke"]],
}
# Seconds allowed per npm command. verify:smoke builds and drives a browser.
TIMEOUTS = {"fast": 180, "full": 180, "quick": 180, "smoke": 900}


def npm_executable() -> str:
    """Windows Python cannot CreateProcess a bare `npm`: it is npm.CMD on PATH.

    Verified on this machine: subprocess.run(['npm','--version']) raises
    FileNotFoundError, and the shutil.which() result runs cleanly. Resolving
    the path also keeps shell=False, so nothing in the command is re-parsed.
    """
    return shutil.which("npm") or shutil.which("npm.cmd") or "npm"


def state_path(root: str, session_id: str) -> str:
    base = os.environ.get("TEMP") or os.environ.get("TMPDIR") or "/tmp"
    folder = os.path.join(base, "ddm-stop-verify")
    try:
        os.makedirs(folder, exist_ok=True)
    except Exception:
        return ""
    key = hashlib.sha1((root + "|" + session_id).encode("utf-8")).hexdigest()[:16]
    return os.path.join(folder, key + ".txt")


def head_id(root: str) -> str:
    """Read HEAD from .git without spawning git: the skip path must stay cheap."""
    try:
        git_dir = os.path.join(root, ".git")
        if os.path.isfile(git_dir):  # a worktree: .git is a file pointing elsewhere
            with open(git_dir, "r", encoding="utf-8") as handle:
                git_dir = handle.read().strip().split(":", 1)[1].strip()
        with open(os.path.join(git_dir, "HEAD"), "r", encoding="utf-8") as handle:
            head = handle.read().strip()
        if not head.startswith("ref:"):
            return head
        ref = head.split(":", 1)[1].strip()
        loose = os.path.join(git_dir, *ref.split("/"))
        if os.path.isfile(loose):
            with open(loose, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        packed = os.path.join(git_dir, "packed-refs")
        if os.path.isfile(packed):
            with open(packed, "r", encoding="utf-8") as handle:
                for line in handle:
                    if line.rstrip("\n").endswith(" " + ref):
                        return line.split(" ", 1)[0]
        return ref
    except Exception:
        return ""


def watched(path: str) -> bool:
    """src/, tests/, scripts/, docs/, workers/, or a root-level markdown file."""
    if path.startswith(WATCHED_DIRS):
        return True
    return "/" not in path and path.lower().endswith(".md")


def tree_digest(root: str) -> str:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root, capture_output=True, text=True, timeout=15,
        ).stdout
    except Exception:
        return ""
    stamps = []
    for entry in status.split("\n"):
        path = entry[3:].strip()
        if " -> " in path:  # a rename: the new name is what matters
            path = path.split(" -> ")[-1]
        path = path.strip('"').replace("\\", "/")
        if not path or not watched(path):
            continue
        try:
            stamps.append(path + ":" + str(os.path.getmtime(os.path.join(root, path))))
        except Exception:
            stamps.append(path + ":?")
    return hashlib.sha1(("|".join([head_id(root)] + sorted(stamps))).encode("utf-8")).hexdigest()


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("stop_hook_active") is True:
        return 0
    level = (os.environ.get("DDM_STOP_LEVEL") or "fast").lower()
    if level == "off" or level not in LEVELS:
        return 0

    root = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    if not os.path.isfile(os.path.join(root, "package.json")):
        return 0

    digest = tree_digest(root)
    marker = state_path(root, payload.get("session_id") or "")
    if digest and marker and os.path.isfile(marker):
        try:
            with open(marker, "r", encoding="utf-8") as handle:
                if handle.read().strip() == digest:
                    return 0
        except Exception:
            pass

    npm = npm_executable()
    failures = []
    for args in LEVELS[level]:
        label = "npm " + " ".join(args)
        try:
            result = subprocess.run(
                [npm] + args, cwd=root, capture_output=True, text=True,
                timeout=TIMEOUTS[level], shell=False,
            )
        except Exception as error:
            failures.append(label + " could not run: " + str(error))
            continue
        if result.returncode != 0:
            tail = (result.stdout + "\n" + result.stderr).strip().split("\n")
            failures.append(label + " FAILED:\n" + "\n".join(tail[-25:]))

    if failures:
        sys.stderr.write(
            "The Stop hook .claude/hooks/ddm-stop-verify.py ran the "
            + level + " rungs of the verification ladder and they are red. Fix these"
            " before finishing the turn, or say explicitly that you are leaving them"
            " red and why.\n\n"
            + "\n\n".join(failures) + "\n"
        )
        return 2

    if marker and digest:
        try:
            with open(marker, "w", encoding="utf-8") as handle:
                handle.write(digest)
        except Exception:
            pass
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "systemMessage": "ddm-stop-verify (" + level + "): green.",
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
