#!/usr/bin/env python3
"""Select the olean trees the apps pack, from a finished Mathlib Lake build.

  mathlib-select.py shims  <mathlib4> <core lib> <core src> <out> "<roots>" "<extra roots>"
      print `<tier> <Module>` for every deprecated_module shim worth shipping
  mathlib-select.py select <mathlib4> <core lib> <core src> <out> "<roots>" "<extra roots>"
      stage <out>/essential-tree (and <out>/extra-tree) + the module lists

essential = import closure of the roots, minus Init and Init.* (the lean-core
pack). extra = closure of the extra roots minus essential: a second, additive
tree for consumers that want it (the games), never paid for by the others.

Shims. When Mathlib moves a module it leaves the old name behind as a
`deprecated_module` file that only imports the new one (148 of them at
v4.34.0, e.g. Mathlib.Data.Real.Basic -> Mathlib.Basic.Real.Basic). NOTHING
imports a shim, so an import closure never contains one — and every user file,
doc snippet and game level written against the old names would be refused,
while stock Lean merely warns. A shim is added to a tier iff everything it
imports is already inside that tier (so it pulls in nothing new and costs a
few hundred bytes); shims whose target lies outside are reported and skipped.
Only shims get this treatment: "any module whose imports are covered" would
quietly grow the pack by whatever happens to be built.
"""
import json
import os
import shutil
import sys

mode, ml, corelib, coresrc, out = sys.argv[1:6]
roots, extra_roots = sys.argv[6].split(), sys.argv[7].split()
FACETS = (".olean", ".olean.server", ".olean.private", ".ir", ".ir.sig")

# (source root, olean root) per origin, in lookup order
origins = [(ml, os.path.join(ml, ".lake/build/lib/lean"))]
pk = os.path.join(ml, ".lake/packages")
for d in sorted(os.listdir(pk)):
    origins.append((os.path.join(pk, d), os.path.join(pk, d, ".lake/build/lib/lean")))
origins += [(coresrc, corelib), (os.path.join(coresrc, "lake"), corelib)]


def rel_of(mod):
    return mod.replace("«", "").replace("»", "").replace(".", "/")


def source_of(mod):
    for src, ol in origins:
        p = os.path.join(src, rel_of(mod) + ".lean")
        if os.path.exists(p):
            return p, ol
    return None, None


def strip_comments(text):
    # Lean block comments NEST (a module doc may quote a whole `/- … -/` header,
    # "import statements*" included), so a flag is not enough: count depth.
    res, i, depth, n = [], 0, 0, len(text)
    while i < n:
        two = text[i:i + 2]
        if two == "/-":
            depth += 1; i += 2
        elif two == "-/" and depth:
            depth -= 1; i += 2
        elif depth:
            i += 1
        elif two == "--":
            j = text.find("\n", i); i = n if j < 0 else j
        else:
            res.append(text[i]); i += 1
    return "".join(res)


def header(path):
    """([imports], prelude?, deprecated_module?) — header grammar:
    [module] [prelude] ([public|private] [meta] import [all] Name)*"""
    toks = strip_comments(open(path, encoding="utf-8", errors="replace").read(20000)).split()
    mods, i, prelude = [], 0, False
    while i < len(toks):
        t = toks[i]
        if t == "module":
            i += 1
        elif t == "prelude":
            prelude = True; i += 1
        elif t in ("public", "private", "meta"):
            i += 1
        elif t == "import":
            i += 1
            if i < len(toks) and toks[i] == "all":
                i += 1
            if i < len(toks):
                mods.append(toks[i]); i += 1
        else:
            break
    return mods, prelude, (i < len(toks) and toks[i] == "deprecated_module")


def closure(start):
    seen, todo, missing = {}, list(start) + ["Init"], []
    while todo:
        m = todo.pop()
        if m in seen:
            continue
        src, ol = source_of(m)
        if src is None:
            missing.append(m); seen[m] = None; continue
        seen[m] = ol
        imps, prelude, _ = header(src)
        if not prelude:
            imps.append("Init")
        todo += imps
    if missing:
        sys.exit(f"mathlib-select: no source for {len(missing)} imported modules, e.g. {missing[:5]}")
    return seen


def core(m):
    return m == "Init" or m.startswith("Init.")


def all_shims():
    """{shim module: ([imports], olean root)} over Mathlib and its Lake packages."""
    found = {}
    for src, ol in origins[:-2]:
        for r, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("test", "tests", "MathlibTest", "Archive", "Counterexamples", "scripts", "docs")]
            for f in files:
                if not f.endswith(".lean"):
                    continue
                p = os.path.join(r, f)
                with open(p, encoding="utf-8", errors="replace") as fh:
                    if "deprecated_module" not in fh.read(20000):
                        continue
                imps, _, dep = header(p)
                if dep:
                    mod = os.path.relpath(p, src)[:-5].replace("/", ".")
                    if source_of(mod)[0] == p:        # not shadowed by an earlier origin
                        found[mod] = (imps, ol)
    return found


ess = closure(roots)
wide = closure(roots + extra_roots) if extra_roots else ess
shims = all_shims()
tier = {}       # shim -> "essential" | "extra"
skipped = []
# shims may chain (old -> older): iterate to a fixed point
changed = True
while changed:
    changed = False
    for s, (imps, _) in shims.items():
        if s in tier or s in ess or s in wide:
            continue
        def inside(scope):
            return all(i in scope or core(i) or tier.get(i) == "essential" or (scope is wide and i in tier) for i in imps)
        if inside(ess):
            tier[s] = "essential"; changed = True
        elif extra_roots and inside(wide):
            tier[s] = "extra"; changed = True
skipped = sorted(s for s in shims if s not in tier and s not in ess and s not in wide)

if mode == "shims":
    for s in sorted(tier):
        print(tier[s], s)
    print(f"# shims: {len(shims)} found; {sum(1 for t in tier.values() if t == 'essential')} -> essential, "
          f"{sum(1 for t in tier.values() if t == 'extra')} -> extra, "
          f"{len([s for s in shims if s in ess or s in wide])} already in a closure, {len(skipped)} skipped (target outside)", file=sys.stderr)
    sys.exit(0)


def stage(name, selected, where, roots_used, shim_list):
    tree = os.path.join(out, name + "-tree")
    shutil.rmtree(tree, ignore_errors=True)
    files, lacking = 0, []
    for m in selected:
        rel = rel_of(m)
        if not os.path.exists(os.path.join(where[m], rel + ".olean")):
            lacking.append(m); continue
        for f in FACETS:
            p = os.path.join(where[m], rel + f)
            if os.path.exists(p):
                d = os.path.join(tree, rel + f); os.makedirs(os.path.dirname(d), exist_ok=True)
                try:
                    os.link(p, d)
                except OSError:
                    shutil.copy2(p, d)
                files += 1
    if lacking:
        sys.exit(f"mathlib-select: {len(lacking)} selected {name} modules were not built, e.g. {lacking[:5]}")
    open(os.path.join(out, name + "-modules.txt"), "w").write("\n".join(selected) + "\n")
    by = {}
    for m in selected:
        by[m.split(".")[0]] = by.get(m.split(".")[0], 0) + 1
    json.dump({"roots": roots_used, "modules": len(selected), "files": files, "byTopLevel": by,
               "deprecatedShims": shim_list}, open(os.path.join(out, name + "-selection.json"), "w"), indent=1)
    print(f"{name}: {len(selected)} modules ({len(shim_list)} deprecated-module shims), {files} files -> {tree}")
    print("  " + ", ".join(f"{k} {v}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:12]))


where = dict(wide)
for s, (_, ol) in shims.items():
    where.setdefault(s, ol)
e_shims = sorted(s for s, t in tier.items() if t == "essential")
x_shims = sorted(s for s, t in tier.items() if t == "extra")
stage("essential", sorted([m for m in ess if not core(m)] + e_shims), where, roots, e_shims)
if extra_roots:
    stage("extra", sorted([m for m in wide if not core(m) and m not in ess] + x_shims), where, extra_roots, x_shims)
if skipped:
    open(os.path.join(out, "shims-skipped.txt"), "w").write("\n".join(skipped) + "\n")
    print(f"shims skipped (their target is outside every closure): {len(skipped)} — {os.path.join(out, 'shims-skipped.txt')}")
