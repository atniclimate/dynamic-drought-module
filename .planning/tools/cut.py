# Re-executes edges.py from this script's own directory, so it reads .planning/TRACE.yaml and src/ and rewrites $TEMP/ddm-s03/edges.md. Prints the cut comparison to stdout.
# Run with the repo root as the working directory: python .planning/tools/cut.py
import io, os, contextlib, collections

here = os.path.dirname(os.path.abspath(__file__))
src = io.open(os.path.join(here, "edges.py"), encoding="utf-8").read()
g = {"__file__": os.path.join(here, "edges.py"), "__name__": "edgesmod"}
with contextlib.redirect_stdout(io.StringIO()):
    exec(src, g)
edges, OPEN, sccs = g["edges"], g["OPEN"], g["sccs"]

ELEVEN = {"DDM-P1-T02","DDM-P1-T04","DDM-P7-T02","DDM-P7-T05","DDM-P8-T02","DDM-P8-T03",
          "DDM-P9-T05","DDM-P11-T01","DDM-P12-T02","DDM-P12-T03","DDM-P14-T03"}

def report(label, nodes, adj):
    comps = [c for c in sccs(nodes, adj) if len(c) > 1]
    print(label)
    if not comps:
        print("   NO cycle among these nodes")
    for c in comps:
        print("   SCC size %d: %s" % (len(c), ", ".join(c)))
    print()

def drop_nodes(adj, gone):
    out = collections.defaultdict(set)
    for a, bs in adj.items():
        if a in gone:
            continue
        out[a] = {b for b in bs if b not in gone}
    return out

def drop_edges(adj, pairs):
    out = collections.defaultdict(set)
    for a, bs in adj.items():
        out[a] = {b for b in bs if (a, b) not in pairs}
    return out

# 0. baseline restricted to the eleven only
report("0. baseline, the eleven DDM-D12 members only:", ELEVEN, edges)

# 1. whole open set minus the whole-tree linter task
noP15 = OPEN - {"DDM-P15-T04"}
report("1. all open tasks, DDM-P15-T04 (122 files, whole-tree linter) excluded:",
       noP15, drop_nodes(edges, {"DDM-P15-T04"}))

# 2. CUT A: lift P12-T02 and P12-T03 out of the graph entirely
report("2. CUT A: the eleven minus P12-T02 and P12-T03 (ENSO planned as its own unit):",
       ELEVEN - {"DDM-P12-T02", "DDM-P12-T03"}, edges)

# 3. CUT B: keep all eleven, delete only the hydrate.ts -> enso.ts arc
cutB = {("DDM-P7-T02","DDM-P12-T02"), ("DDM-P7-T02","DDM-P12-T03"),
        ("DDM-P7-T05","DDM-P12-T02"), ("DDM-P7-T05","DDM-P12-T03")}
report("3. CUT B: all eleven, the hydrate.ts -> enso.ts arc removed:",
       ELEVEN, drop_edges(edges, cutB))

# 4. CUT C: keep all eleven, delete only the enso.ts -> charts.ts arc
cutC = {("DDM-P12-T02","DDM-P7-T02"), ("DDM-P12-T03","DDM-P7-T02")}
report("4. CUT C: all eleven, the enso.ts -> src/ui/charts.ts arc removed:",
       ELEVEN, drop_edges(edges, cutC))

# 5. what remains after CUT A, as a DAG order
rest = ELEVEN - {"DDM-P12-T02", "DDM-P12-T03"}
print("5. in-edges within the CUT A remainder:")
for t in sorted(rest):
    print("   %-12s <- %s" % (t, ", ".join(sorted(b for b in edges.get(t, ()) if b in rest)) or "(none)"))
