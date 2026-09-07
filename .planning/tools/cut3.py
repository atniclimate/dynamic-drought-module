# Re-executes edges.py from this script's own directory, so it reads .planning/TRACE.yaml and src/ and rewrites $TEMP/ddm-s03/edges.md. Prints in-degree, the hub-line comparison and topological layers to stdout.
# Run with the repo root as the working directory: python .planning/tools/cut3.py
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

# RECONCILIATION.md:604-608, the "next ten" it offered for the owner's judgement
NEXT10 = {"src/impact/context.ts", "src/state/place-selection.ts", "src/ui/overlay.ts",
          "src/util/motion.ts", "src/map/layer-order.ts", "src/state/cluster-service.ts",
          "src/state/timeline.ts", "src/ui/island/bridge.ts",
          "src/ui/layer-toggle-command.ts", "src/ui/popups.ts"}

# in-degree in the CURRENT tree, to confirm the next-ten still are what they were
indeg = collections.Counter()
for F, gs in imports.items():
    for G in gs:
        indeg[G] += 1
print("=== current in-degree of the RECONCILIATION 'next ten' (post-S02g) ===")
for f in sorted(NEXT10, key=lambda x: -indeg[x]):
    print("  %-38s %d" % (f, indeg[f]))
print()
print("=== current top 20 by in-degree ===")
for f, n in indeg.most_common(20):
    print("  %-38s %d   %s" % (f, n, "HUB(top10)" if f in HUBS else ("next-ten" if f in NEXT10 else "")))

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

for label, banned, nodes in [
    ("A. hub line at 10 (as reconciled), all eleven", HUBS, ELEVEN),
    ("B. hub line at 10, enso.ts cut (nine)", HUBS, NINE),
    ("C. hub line at 20, all eleven", HUBS | NEXT10, ELEVEN),
    ("D. hub line at 20, enso.ts cut (nine)", HUBS | NEXT10, NINE),
]:
    adj, rec = build(nodes, banned)
    comps = [c for c in sccs(nodes, adj) if len(c) > 1]
    print()
    print(label)
    if comps:
        for c in comps:
            print("   SCC size %d: %s" % (len(c), ", ".join(c)))
    else:
        print("   ACYCLIC")
        # topological layers
        rem = dict((n, {b for b in adj.get(n, ()) if b in nodes}) for n in nodes)
        layer, done, out = 0, set(), []
        while len(done) < len(nodes):
            ready = sorted(n for n in nodes if n not in done and rem[n] <= done)
            if not ready:
                break
            out.append((layer, ready))
            done |= set(ready)
            layer += 1
        for lv, ns in out:
            print("     layer %d: %s" % (lv, ", ".join(ns)))
        print("   edges:")
        for (a, b) in sorted(rec):
            if a in nodes and b in nodes:
                print("     %-12s <- %-12s  %s" % (a, b, "; ".join(sorted(rec[(a, b)]))))
