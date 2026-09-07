# Re-executes edges.py from this script's own directory, so it reads .planning/TRACE.yaml and src/ and rewrites $TEMP/ddm-s03/edges.md. Prints the matrix.ts robustness check to stdout.
# Run with the repo root as the working directory: python .planning/tools/cut4.py
"""Does the cut survive if DDM-P12-T02 must also touch src/impact/matrix.ts
(DR-031 a wires the weekly Nino 3.4 into the ENSO near-term cell, which means
LANE_PLACEMENT.enso and CELL_ABSENCE.nearTerm.enso change too)?"""
import io, os, contextlib, collections

here = os.path.dirname(os.path.abspath(__file__))
g = {"__file__": os.path.join(here, "edges.py"), "__name__": "edgesmod"}
with contextlib.redirect_stdout(io.StringIO()):
    exec(io.open(os.path.join(here, "edges.py"), encoding="utf-8").read(), g)
imports, tasks_of, files_of, HUBS, sccs = (
    g["imports"], g["tasks_of"], g["files_of"], g["HUBS"], g["sccs"])

NEXT10 = {"src/impact/context.ts", "src/state/place-selection.ts", "src/ui/overlay.ts",
          "src/util/motion.ts", "src/map/layer-order.ts", "src/state/cluster-service.ts",
          "src/state/timeline.ts", "src/ui/island/bridge.ts",
          "src/ui/layer-toggle-command.ts", "src/ui/popups.ts"}
ELEVEN = {"DDM-P1-T02","DDM-P1-T04","DDM-P7-T02","DDM-P7-T05","DDM-P8-T02","DDM-P8-T03",
          "DDM-P9-T05","DDM-P11-T01","DDM-P12-T02","DDM-P12-T03","DDM-P14-T03"}

# widen: matrix.ts joins P12-T02 (and P7-T02, which owns the composer it belongs to)
tasks_of["src/impact/matrix.ts"] = {"DDM-P12-T02", "DDM-P7-T02"}
files_of["DDM-P12-T02"].add("src/impact/matrix.ts")
files_of["DDM-P7-T02"].add("src/impact/matrix.ts")

def build(nodes, banned):
    adj = collections.defaultdict(set)
    rec = collections.defaultdict(set)
    for F, gs in imports.items():
        if F in banned or F not in tasks_of:
            continue
        for G in gs:
            if G in banned or G not in tasks_of:
                continue
            for a in tasks_of[F] & nodes:
                for b in tasks_of[G] & nodes:
                    if a == b or F in files_of[b]:
                        continue
                    adj[a].add(b)
                    rec[(a, b)].add("%s -> %s" % (F, G))
    return adj, rec

print("src/impact/matrix.ts value imports (post-widen):",
      sorted(imports.get("src/impact/matrix.ts", ())) or "NONE (type-only imports)")
print()
for label, banned, nodes in [
    ("E. matrix.ts attached to P12-T02; hub line 10; all eleven", HUBS, ELEVEN),
    ("F. matrix.ts attached to P12-T02; hub line 20; all eleven", HUBS | NEXT10, ELEVEN),
    ("G. matrix.ts attached to P12-T02; hub line 20; enso.ts cut (nine)",
     HUBS | NEXT10, ELEVEN - {"DDM-P12-T02", "DDM-P12-T03"}),
]:
    adj, _ = build(nodes, banned)
    comps = [c for c in sccs(nodes, adj) if len(c) > 1]
    print(label)
    print("   " + ("; ".join("SCC %d: %s" % (len(c), ", ".join(c)) for c in comps)
                   if comps else "ACYCLIC"))
    print()
print("in-edges of the ENSO group members under the widened attachment, hub line 20:")
adj, rec = build(ELEVEN, HUBS | NEXT10)
for t in ("DDM-P12-T02", "DDM-P12-T03"):
    print("  %-12s <- %s" % (t, ", ".join(sorted(adj.get(t, ()))) or "(none)"))
    for (a, b) in sorted(rec):
        if a == t:
            print("      via %s" % "; ".join(sorted(rec[(a, b)])))
