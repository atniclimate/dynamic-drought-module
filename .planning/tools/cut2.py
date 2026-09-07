# Re-executes edges.py from this script's own directory, so it reads .planning/TRACE.yaml and src/ and rewrites $TEMP/ddm-s03/edges.md. Prints per-file, per-arc and per-task seam removals to stdout.
# Run with the repo root as the working directory: python .planning/tools/cut2.py
import io, os, contextlib, collections

here = os.path.dirname(os.path.abspath(__file__))
g = {"__file__": os.path.join(here, "edges.py"), "__name__": "edgesmod"}
with contextlib.redirect_stdout(io.StringIO()):
    exec(io.open(os.path.join(here, "edges.py"), encoding="utf-8").read(), g)
imports, tasks_of, files_of, HUBS, sccs = (
    g["imports"], g["tasks_of"], g["files_of"], g["HUBS"], g["sccs"])

ELEVEN = {"DDM-P1-T02","DDM-P1-T04","DDM-P7-T02","DDM-P7-T05","DDM-P8-T02","DDM-P8-T03",
          "DDM-P9-T05","DDM-P11-T01","DDM-P12-T02","DDM-P12-T03","DDM-P14-T03"}
NINE = ELEVEN - {"DDM-P12-T02", "DDM-P12-T03"}

def build(nodes, banned_files=frozenset(), banned_arcs=frozenset()):
    adj = collections.defaultdict(set)
    rec = collections.defaultdict(set)
    for F, gs in imports.items():
        if F in HUBS or F in banned_files or F not in tasks_of:
            continue
        for G in gs:
            if G in HUBS or G in banned_files or G not in tasks_of:
                continue
            if (F, G) in banned_arcs:
                continue
            for a in tasks_of[F] & nodes:
                for b in tasks_of[G] & nodes:
                    if a == b or F in files_of[b]:
                        continue
                    adj[a].add(b)
                    rec[(a, b)].add("%s -> %s" % (F, G))
    return adj, rec

adj9, rec9 = build(NINE)
print("=== the nine-task remainder after the enso.ts cut: every edge, with receipts ===")
for (a, b) in sorted(rec9):
    print("  %-12s <- %-12s  %s" % (a, b, "; ".join(sorted(rec9[(a, b)]))))

print()
print("=== single-FILE seam removals that shrink the nine-task SCC ===")
seams = sorted({f for f in imports if f in tasks_of and tasks_of[f] & NINE} |
               {G for F in imports for G in imports[F] if G in tasks_of and tasks_of[G] & NINE})
for f in seams:
    a2, _ = build(NINE, banned_files={f})
    comps = [c for c in sccs(NINE, a2) if len(c) > 1]
    big = max((len(c) for c in comps), default=0)
    if big < 9:
        print("  drop %-38s -> largest SCC %d  %s" % (
            f, big, comps[0] if comps else "ACYCLIC"))

print()
print("=== single-ARC removals that shrink the nine-task SCC ===")
arcs = sorted({(F, G) for F in imports for G in imports[F]
               if F in tasks_of and G in tasks_of
               and (tasks_of[F] & NINE) and (tasks_of[G] & NINE)
               and F not in HUBS and G not in HUBS})
for arc in arcs:
    a2, _ = build(NINE, banned_arcs={arc})
    comps = [c for c in sccs(NINE, a2) if len(c) > 1]
    big = max((len(c) for c in comps), default=0)
    if big < 9:
        print("  drop arc %-52s -> largest SCC %d" % ("%s -> %s" % arc, big))

print()
print("=== task removals that shrink the nine-task SCC ===")
for t in sorted(NINE):
    rest = NINE - {t}
    a2, _ = build(rest)
    comps = [c for c in sccs(rest, a2) if len(c) > 1]
    big = max((len(c) for c in comps), default=0)
    print("  lift %-12s -> largest remaining SCC %d %s" % (
        t, big, (comps[0] if comps else "ACYCLIC")))
