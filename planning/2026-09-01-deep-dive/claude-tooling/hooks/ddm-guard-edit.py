"""DDM PreToolUse hook (matcher: Write|Edit|MultiEdit|NotebookEdit). DRAFT.

Three jobs, one process:

  1. HARD RULE 9. Refuse new content containing U+2014, naming the offending
     line. `npm run scan:emdash` already enforces this, but only inside
     `npm run gate`, which costs a build. Catching it at the keystroke is
     free. Verbatim upstream data is exempt by the rule itself, so
     public/data/ and the binary extensions the project's own scanner skips
     are out of scope, and DDM_ALLOW_EMDASH=1 is the escape hatch.
     The payload is read as bytes and decoded as UTF-8 explicitly. On
     Windows, `json.load(sys.stdin)` decodes the console code page (cp1252)
     instead, where the 0x97 byte inside many UTF-8 sequences (U+65E5 among
     them) reads as U+2014 and the scan false-positives. A payload that is
     not valid UTF-8 is denied with the decode error named, never replaced.
  2. PROTECTED PATHS. fire3d-evidence/ is preserved untracked evidence that
     HANDOFF.md says must never be staged, deleted, moved, or modified by
     hand. dist/ and node_modules/ are build output. .claude/settings.json
     and .claude/settings.local.json are the files that configure these
     hooks and the permission rules; an agent that can edit them can switch
     them off, so they are closed. .github/workflows/ is attested by run
     receipts, not by the gate, and no test reads it; the owner edits it.
  3. SUBAGENT WRITES TO THE CONTRACT FILES. AGENTS.md and HANDOFF.md are
     the owner's contract and handoff. The hooks reference documents that a
     hook payload carries `agent_id` and `agent_type` when the call comes
     from inside a subagent, so this IS detectable: the hook refuses those
     two paths when `agent_id` is present and passes them through in the
     main session. It fails OPEN (no `agent_id` means no block), so a future
     schema change loosens the rule rather than breaking the session.

Contract: reads the PreToolUse JSON on stdin; on a violation prints a
permission decision of "deny" and exits 0; otherwise nothing, exit 0.
Never raises.
"""
import json
import os
import re
import sys

EM_DASH = chr(0x2014)

PROTECTED = (
    ("fire3d-evidence/",
     "fire3d-evidence/ is preserved untracked evidence. HANDOFF.md: never stage,"
     " delete, move, or modify it by hand."),
    (".claude/settings.json",
     "This file configures the project's hooks and permission rules. Editing it from"
     " inside a session would let the session disable its own guardrails. The owner"
     " edits it, or runs claude-tooling/install-hooks.ps1."),
    (".claude/settings.local.json",
     "This file configures the session's own permission rules. The owner edits it."),
    (".claude/hooks/",
     "These are the installed guardrails themselves. Edit the SOURCE draft under"
     " planning/2026-09-01-deep-dive/claude-tooling/hooks/ and have the owner re-run"
     " install-hooks.ps1, so the installed copy is never the one that drifts."),
    (".github/workflows/",
     "The delivery workflows are attested by run receipts, not by this repository's"
     " gate (docs/ROADMAP.yaml component_catalog.release_delivery). Seven done P0"
     " claims rest on these files and no test reads them. The owner edits them, or"
     " DDM-P15-T05 lands the in-repo guard test first."),
    ("dist/", "dist/ is build output. Change the source and rebuild."),
    ("node_modules/", "node_modules/ is installed by npm. Change package.json instead."),
)

CONTRACT_FILES = ("agents.md", "handoff.md")

# Extensions the project's own scan-emdash.mjs skips: bytes, not prose.
BINARY_EXT = (
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".pmtiles",
    ".zip", ".exe", ".pdf", ".tif", ".tiff", ".gpkg",
)


def deny(reason: str) -> int:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    return 0


def relative_path(file_path: str, cwd: str) -> str:
    """Lowercased, forward-slashed path relative to cwd when it sits under it.

    Note for anyone editing this: do NOT reach for lstrip('./'). lstrip takes a
    SET of characters, so it turns '.claude/settings.json' into
    'claude/settings.json' and the protected-path check silently stops firing.
    That bug was caught by the test harness before this was ever installed.
    """
    norm = (file_path or "").replace("\\", "/")
    root = (cwd or "").replace("\\", "/").rstrip("/")
    if root and norm.lower().startswith(root.lower() + "/"):
        norm = norm[len(root) + 1:]
    while norm.startswith("./"):
        norm = norm[2:]
    return norm.lstrip("/").lower()


def new_texts(tool_name: str, tool_input: dict):
    """Yield (label, text) for every piece of content this call would write."""
    if tool_name == "Write":
        yield "content", tool_input.get("content") or ""
    elif tool_name == "Edit":
        yield "new_string", tool_input.get("new_string") or ""
    elif tool_name == "MultiEdit":
        for i, edit in enumerate(tool_input.get("edits") or []):
            yield "edits[" + str(i) + "].new_string", (edit or {}).get("new_string") or ""
    elif tool_name == "NotebookEdit":
        yield "new_source", tool_input.get("new_source") or ""


def main() -> int:
    try:
        raw = sys.stdin.buffer.read()
    except Exception:
        return 0
    try:
        payload = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as error:
        return deny(
            "BLOCKED by .claude/hooks/ddm-guard-edit.py: the hook payload is not valid"
            " UTF-8 (" + str(error) + "), so the em-dash scan cannot run on it. Retry the"
            " write; if it repeats, report it to the owner rather than working around it."
        )
    except Exception:
        return 0
    tool_name = payload.get("tool_name") or ""
    if tool_name not in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        return 0
    tool_input = payload.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    rel = relative_path(file_path, payload.get("cwd") or "")

    for prefix, why in PROTECTED:
        if rel == prefix.lower().rstrip("/") or rel.startswith(prefix.lower()):
            return deny(
                "BLOCKED by .claude/hooks/ddm-guard-edit.py: " + file_path + " is protected. " + why
            )

    if rel in CONTRACT_FILES and payload.get("agent_id"):
        return deny(
            "BLOCKED by .claude/hooks/ddm-guard-edit.py: " + file_path + " is the owner's"
            " contract file and this call comes from a subagent (agent_type="
            + str(payload.get("agent_type")) + "). Report the needed change to the"
            " orchestrator in your return message instead; the main session edits it."
        )

    if os.environ.get("DDM_ALLOW_EMDASH") == "1":
        return 0
    if rel.startswith("public/data/") or rel.endswith(BINARY_EXT):
        return 0

    for label, text in new_texts(tool_name, tool_input):
        if EM_DASH not in text:
            continue
        lines = [
            str(i + 1) + ": " + line.strip()[:120]
            for i, line in enumerate(text.split("\n")) if EM_DASH in line
        ]
        return deny(
            "BLOCKED by .claude/hooks/ddm-guard-edit.py: hard rule 9 forbids authoring"
            " U+2014 (the em dash). " + str(len(lines)) + " line(s) in `" + label
            + "` carry it, numbered within the new content:\n  "
            + "\n  ".join(lines[:8])
            + "\nUse a comma, a colon, a semicolon, or two sentences. If this is"
            " VERBATIM upstream data, which the rule exempts, set DDM_ALLOW_EMDASH=1"
            " and say so in your report."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
