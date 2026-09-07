# Reads .planning/TRACE.yaml and every .ts/.tsx under src/. Writes $TEMP/ddm-s03/edges.md and prints the SCC re-derivation to stdout.
# Run with the repo root as the working directory: python .planning/tools/edges.py
"""Re-derive the TRACE section-6 task edges against the POST-S02g tree.

Method mirrors .planning/RECONCILIATION.md section 6:
  - direct import edges only
  - the top ten hub files form no edges
  - an edge whose importing file is attached to BOTH endpoints is dropped
Type-only imports are excluded (imports.json excludes them); dynamic
import() IS an edge (imports.json records hydrate.ts -> enso.ts).
"""
import os, re, io, collections, json

ROOT = "."
SRC = os.path.join(ROOT, "src")

HUBS = {
    "src/util/fetch.ts", "src/config/urls.ts", "src/state/registry.ts",
    "src/config/palette.ts", "src/util/escape.ts",
    "src/map/interaction-coordinator.ts", "src/ui/legend-registry.ts",
    "src/config/layers.ts", "src/util/guards.ts",
    "src/config/wildfire-presentation.ts",
}

# ---------- 1. attachments from TRACE.yaml ----------
lines = io.open(os.path.join(ROOT, ".planning/TRACE.yaml"), encoding="utf-8").read().split("\n")
starts = []
for i, ln in enumerate(lines):
    m = re.match(r"^  (DDM-P[0-9]+-T[0-9]+):\s*$", ln)
    if m:
        starts.append((i, m.group(1)))

files_of = collections.defaultdict(set)   # task -> files
tasks_of = collections.defaultdict(set)   # file -> tasks
status_of = {}
for n, (i, tid) in enumerate(starts):
    j = starts[n + 1][0] if n + 1 < len(starts) else len(lines)
    block = lines[i:j]
    for b in block:
        ms = re.match(r"^    status: (\S+)", b)
        if ms:
            status_of[tid] = ms.group(1)
        mm = re.match(r"^\s+- path: (src/\S+)\s*$", b)
        if mm:
            files_of[tid].add(mm.group(1))
            tasks_of[mm.group(1)].add(tid)

# ---------- 2. current imports ----------
IMP_FROM = re.compile(r"""^\s*import\s+(type\s+)?(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]""")
IMP_BARE = re.compile(r"""^\s*import\s*['"]([^'"]+)['"]""")
DYN = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")

def resolve(frm, spec):
    if not spec.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(frm), spec)).replace("\\", "/")
    for cand in (base, base + ".ts", base + ".tsx", base + "/index.ts", base + "/index.tsx"):
        if os.path.isfile(os.path.join(ROOT, cand)):
            return cand
    return None

imports = collections.defaultdict(set)
allfiles = []
for dirpath, _dirs, fnames in os.walk(SRC):
    for fn in fnames:
        if not fn.endswith((".ts", ".tsx")):
            continue
        p = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace("\\", "/")
        allfiles.append(p)
        text = io.open(os.path.join(ROOT, p), encoding="utf-8").read()
        # multi-line import statements: join a statement that opens a brace
        buf, stmts = "", []
        for ln in text.split("\n"):
            if buf:
                buf += " " + ln.strip()
                if "from" in ln and ("'" in ln or '"' in ln):
                    stmts.append(buf); buf = ""
                continue
            s = ln.strip()
            if s.startswith("import ") and " from " not in s and not s.endswith(("'", '"', "';", '";')):
                buf = s
            else:
                stmts.append(ln)
        for s in stmts:
            m = IMP_FROM.match(s)
            if m:
                if m.group(1):          # `import type ... from` -> not an edge
                    continue
                r = resolve(p, m.group(2))
                if r:
                    imports[p].add(r)
                continue
            m = IMP_BARE.match(s)
            if m:
                r = resolve(p, m.group(1))
                if r:
                    imports[p].add(r)
        for m in DYN.finditer(text):
            r = resolve(p, m.group(1))
            if r:
                imports[p].add(r)

# ---------- 3. task edges ----------
# edge (a <- b): file F attached to a imports file G attached to b
edges = collections.defaultdict(set)   # a -> {b}
why = collections.defaultdict(list)
for F, gs in imports.items():
    if F in HUBS or F not in tasks_of:
        continue
    for G in gs:
        if G in HUBS or G not in tasks_of:
            continue
        for a in tasks_of[F]:
            for b in tasks_of[G]:
                if a == b:
                    continue
                if F in files_of[b]:      # shared-file: no direction
                    continue
                edges[a].add(b)
                why[(a, b)].append("%s -> %s" % (F, G))

OPEN = {t for t, s in status_of.items() if s == "open"}
CYCLE11 = ["DDM-P1-T02","DDM-P1-T04","DDM-P7-T02","DDM-P7-T05","DDM-P8-T02","DDM-P8-T03",
           "DDM-P9-T05","DDM-P11-T01","DDM-P12-T02","DDM-P12-T03","DDM-P14-T03"]

# ---------- 4. SCC over open tasks (Tarjan, iterative) ----------
def sccs(nodes, adj):
    index = {}; low = {}; onstk = {}; stk = []; out = []; counter = [0]
    for root in nodes:
        if root in index:
            continue
        work = [(root, iter(sorted(adj.get(root, ()))))]
        index[root] = low[root] = counter[0]; counter[0] += 1
        stk.append(root); onstk[root] = True
        while work:
            v, it = work[-1]
            advanced = False
            for w in it:
                if w not in nodes:
                    continue
                if w not in index:
                    index[w] = low[w] = counter[0]; counter[0] += 1
                    stk.append(w); onstk[w] = True
                    work.append((w, iter(sorted(adj.get(w, ())))))
                    advanced = True
                    break
                elif onstk.get(w):
                    low[v] = min(low[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                low[work[-1][0]] = min(low[work[-1][0]], low[v])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stk.pop(); onstk[w] = False; comp.append(w)
                    if w == v:
                        break
                out.append(sorted(comp))
    return out

comps = [c for c in sccs(OPEN, edges) if len(c) > 1]

print("=== POST-S02g re-derivation (main 5b40dfb) ===")
print("open tasks with attachments: %d" % len(OPEN))
print()
print("--- non-trivial SCCs among OPEN tasks ---")
for c in comps:
    print("  size %d: %s" % (len(c), ", ".join(c)))
print()
print("--- edges among the eleven DDM-D12 members ---")
for a in CYCLE11:
    ins = sorted(b for b in edges.get(a, ()) if b in CYCLE11)
    print("  %-12s <- %s" % (a, ", ".join(ins) if ins else "(none)"))
print()
print("--- every edge touching P12-T02 / P12-T03 (with receipts) ---")
for (a, b), rs in sorted(why.items()):
    if "DDM-P12-T02" in (a, b) or "DDM-P12-T03" in (a, b):
        print("  %s <- %s   via %s" % (a, b, "; ".join(sorted(set(rs)))))
print()
print("--- edges into/out of DDM-P11-T01 within the eleven ---")
for (a, b), rs in sorted(why.items()):
    if a == "DDM-P11-T01" and b in CYCLE11:
        print("  %s <- %s   via %s" % (a, b, "; ".join(sorted(set(rs)))))

with io.open(os.environ["TEMP"] + "/ddm-s03/edges.md", "w", encoding="utf-8") as fh:
    fh.write("# S03 edge ledger, post-S02g (main 5b40dfb, 2026-09-07)\n\n")
    fh.write("Method: RECONCILIATION.md section 6 rules, re-run on the current tree.\n")
    fh.write("Columns: importer path | imported path | task edge it serves\n\n")
    for (a, b), rs in sorted(why.items()):
        if a in CYCLE11 or b in CYCLE11:
            for r in sorted(set(rs)):
                imp, ed = r.split(" -> ")
                fh.write("- %s | %s | %s <- %s\n" % (imp, ed, a, b))
print()
print("ledger written to %s/ddm-s03/edges.md" % os.environ["TEMP"])
