# Reads .planning/TRACE.yaml. Writes no file; prints each task's attached files and tests to stdout.
# Run with the repo root as the working directory: python .planning/tools/attach.py
import re, sys, io

TASKS = ["DDM-P1-T02","DDM-P1-T04","DDM-P7-T02","DDM-P7-T03","DDM-P7-T05","DDM-P8-T02",
         "DDM-P8-T03","DDM-P9-T05","DDM-P11-T01","DDM-P12-T01","DDM-P12-T02","DDM-P12-T03",
         "DDM-P14-T03"]

lines = io.open(".planning/TRACE.yaml", encoding="utf-8").read().split("\n")

# task blocks start at two-space indent "  DDM-...:"
starts = {}
order = []
for i, ln in enumerate(lines):
    m = re.match(r"^  (DDM-P[0-9]+-T[0-9]+):\s*$", ln)
    if m:
        starts[m.group(1)] = i
        order.append((i, m.group(1)))
order.sort()

for tid in TASKS:
    if tid not in starts:
        print("== %s: NOT IN TRACE" % tid)
        continue
    i = starts[tid]
    j = len(lines)
    for (k, t) in order:
        if k > i:
            j = k
            break
    block = lines[i:j]
    files = [re.sub(r"^\s*- path:\s*", "", b) for b in block if re.match(r"^\s+- path: ", b)]
    tests = []
    intests = False
    for b in block:
        if re.match(r"^    tests:", b):
            intests = True
            continue
        if intests:
            if re.match(r"^    [a-z_]+:", b):
                intests = False
                continue
            t = re.sub(r"^\s*- path:\s*", "", b) if "- path:" in b else None
            if t:
                tests.append(t)
    cov = [b.strip() for b in block if b.strip().startswith("coverage:")]
    print("== %s  (%d files, %d tests) %s" % (tid, len(files), len(tests), cov[0] if cov else ""))
    for f in files:
        print("     F %s" % f)
    for t in tests:
        print("     T %s" % t)
