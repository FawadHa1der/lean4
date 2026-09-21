#!/usr/bin/env bash
# Build the Mathlib olean tree the two apps ship, with the native64 compiler of
# this kernel commit (native64.sh), and stage the "essential" selection as one
# flat olean tree ready for the apps' packer.
#
#   wasm64-build/mathlib-tree.sh <tag>          # Mathlib at the SAME tag as Lean, e.g. v4.34.0
#
# Selection rule (unchanged since the first release, browser64
# docs/mathlib-essential.md): the import closure of MATHLIB_ROOTS, minus Init
# and Init.* (those are the lean-core pack). Modules come from Mathlib, its Lake
# dependencies and the kernel's own Std/Lean; every selected module must have
# its .olean, and ships every facet that exists (.olean.server, .olean.private,
# .ir, .ir.sig).
#
# Output (under <build dir>/mathlib):
#   mathlib4/            the checkout + .lake build
#   essential-tree/      flat tree: <Module/Path>.olean[.server|.private] + .ir[.sig]
#   essential-modules.txt, essential-selection.json
#   extra-tree/, extra-modules.txt, extra-selection.json   (only with MATHLIB_EXTRA_ROOTS: the
#                        closure of those roots MINUS essential — a second, additive pack)
# Pack it with the consumer's packer, e.g. qed64:
#   node pipeline/artifacts/pack.mjs --lib <essential-tree> --id mathlib-essential --out <dir> \
#        --lean-version <x.y.z> --revision <kernel commit> --roots <MATHLIB_ROOTS, comma separated>
#
# No `lake exe cache get`: the community cache holds oleans written by the
# official compiler (GMP bignums, another platform target); only oleans written
# by THIS fork's native64 compiler are loadable by the wasm64 runtime.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: mathlib-tree.sh <tag>}"
BD="${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$TAG}"
IMG=qed64-toolchain:emsdk-6.0.5
MATHLIB_URL="${MATHLIB_URL:-https://github.com/leanprover-community/mathlib4}"
MATHLIB_REV="${MATHLIB_REV:-$TAG}"
# Three roots whose closure is the served profile. Extra roots (space
# separated, e.g. MATHLIB_EXTRA_ROOTS="Mathlib.Tactic" for the games) are built
# in the same Lake workspace but staged as a separate additive tree.
MATHLIB_ROOTS="${MATHLIB_ROOTS:-Mathlib.Geometry.Manifold.IsManifold.Basic Mathlib.Geometry.Manifold.Instances.Sphere Mathlib.Analysis.SpecialFunctions.Complex.Circle}"
ROOTS="$MATHLIB_ROOTS ${MATHLIB_EXTRA_ROOTS:-}"
THREADS="${LEAN_NUM_THREADS:-6}"      # fd exhaustion + an 8 GiB Docker VM: keep it modest
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
NATIVE="$BD/native"
[ -x "$NATIVE/stage1/bin/lean" ] || { echo "mathlib-tree: no native64 compiler in $NATIVE — run native64.sh $TAG" >&2; exit 1; }
W="$BD/mathlib"; ML="$W/mathlib4"; mkdir -p "$W"

echo "=== [1/4] Mathlib $MATHLIB_REV ==="
if [ ! -d "$ML/.git" ]; then
  git clone --quiet --depth 1 --branch "$MATHLIB_REV" "$MATHLIB_URL" "$ML"
fi
WANT="leanprover/lean4:$TAG"; HAVE="$(tr -d '[:space:]' < "$ML/lean-toolchain")"
[ "$HAVE" = "$WANT" ] || { echo "mathlib-tree: Mathlib $MATHLIB_REV wants $HAVE, the kernel is $WANT" >&2; exit 1; }
# Mathlib refuses to BUILD ProofWidgets' JavaScript (it expects the release
# download, which is keyed to the official toolchain). Allow the source build.
python3 - "$ML/lakefile.lean" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
t = re.sub(r'(require "leanprover-community" / "proofwidgets"[^\n]*\n)(?:  with NameMap\.empty\.insert `errorOnBuild\n(?:    [^\n]*\n)+)', r'\1', s)
if t != s: open(p, "w").write(t); print("lakefile: ProofWidgets errorOnBuild guard removed")
PY

run() {
  docker run --rm \
    -e LEAN_CC=/usr/bin/gcc -e "LEAN_NUM_THREADS=$THREADS" \
    -e "PATH=/native/stage1/bin:/emsdk/node/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -v "$NATIVE":/native:ro -v "$W":/work -w /work/mathlib4 \
    "$IMG" bash -lc "export PATH=/native/stage1/bin:\$PATH; git config --global --add safe.directory '*'; $1"
}
echo "=== [2/4] lake build ($ROOTS) — hours ==="
run "lean --version && lake build $ROOTS -q --log-level=info"

echo "=== [3/4] native smoke ==="
cat > "$W/mathlib4/.qed64-smoke.lean" <<'LEAN'
import Mathlib.Geometry.Manifold.Instances.Sphere
import Mathlib.Analysis.SpecialFunctions.Complex.Circle
example : (2 : ℝ) + 2 = 4 := by norm_num
example (a b : ℕ) : a + b = b + a := by omega
LEAN
run "lake env lean .qed64-smoke.lean"

echo "=== [4/4] essential selection ==="
python3 - "$ML" "$NATIVE/stage1/lib/lean" "$REPO/src" "$W" "$MATHLIB_ROOTS" "${MATHLIB_EXTRA_ROOTS:-}" <<'PY'
import json, os, re, shutil, sys
ml, corelib, coresrc, out = sys.argv[1:5]; roots = sys.argv[5].split(); extra_roots = sys.argv[6].split()
FACETS = (".olean", ".olean.server", ".olean.private", ".ir", ".ir.sig")
# (source root, olean root) per origin, in lookup order
origins = [(ml, os.path.join(ml, ".lake/build/lib/lean"))]
pk = os.path.join(ml, ".lake/packages")
for d in sorted(os.listdir(pk)):
    origins.append((os.path.join(pk, d), os.path.join(pk, d, ".lake/build/lib/lean")))
origins += [(coresrc, corelib), (os.path.join(coresrc, "lake"), corelib)]
IMPORT = re.compile(r'(?:^|\s)(?:public\s+|private\s+)?(?:meta\s+)?import\s+(?:all\s+)?([^\s]+)')
def source_of(mod):
    rel = mod.replace("«", "").replace("»", "").replace(".", "/") + ".lean"
    for src, ol in origins:
        p = os.path.join(src, rel)
        if os.path.exists(p): return p, ol
    return None, None
def header_imports(path):
    # the import block ends at the first line that is neither blank, comment, `module`, `prelude` nor an import
    mods, in_block = [], False
    for line in open(path, encoding="utf-8", errors="replace"):
        s = line.strip()
        if in_block:
            if "-/" in s: in_block = False
            continue
        if s.startswith("/-"):
            in_block = "-/" not in s; continue
        if not s or s.startswith("--") or s in ("module", "prelude"): continue
        found = IMPORT.findall(" " + s)
        if not found or not re.match(r'(public\s+|private\s+)?(meta\s+)?import\b', s): break
        mods += found
    return mods
def closure(start):
    seen, todo, missing = {}, list(start) + ["Init"], []
    while todo:
        m = todo.pop()
        if m in seen: continue
        src, ol = source_of(m)
        if src is None: missing.append(m); seen[m] = None; continue
        seen[m] = ol
        imps = header_imports(src)
        if "prelude" not in open(src, encoding="utf-8", errors="replace").read(400): imps.append("Init")
        todo += imps
    if missing: sys.exit(f"mathlib-tree: no source for {len(missing)} imported modules, e.g. {missing[:5]}")
    return seen
def stage(name, selected, where, roots_used):
    tree = os.path.join(out, name + "-tree")
    shutil.rmtree(tree, ignore_errors=True)
    files = 0; lacking = []
    for m in selected:
        rel = m.replace("«", "").replace("»", "").replace(".", "/")
        if not os.path.exists(os.path.join(where[m], rel + ".olean")): lacking.append(m); continue
        for f in FACETS:
            p = os.path.join(where[m], rel + f)
            if os.path.exists(p):
                d = os.path.join(tree, rel + f); os.makedirs(os.path.dirname(d), exist_ok=True)
                try: os.link(p, d)
                except OSError: shutil.copy2(p, d)
                files += 1
    if lacking: sys.exit(f"mathlib-tree: {len(lacking)} selected {name} modules were not built, e.g. {lacking[:5]}")
    open(os.path.join(out, name + "-modules.txt"), "w").write("\n".join(selected) + "\n")
    by = {}
    for m in selected: by[m.split(".")[0]] = by.get(m.split(".")[0], 0) + 1
    json.dump({"roots": roots_used, "modules": len(selected), "files": files, "byTopLevel": by}, open(os.path.join(out, name + "-selection.json"), "w"), indent=1)
    print(f"{name}: {len(selected)} modules, {files} files -> {tree}")
    print("  " + ", ".join(f"{k} {v}" for k, v in sorted(by.items(), key=lambda kv: -kv[1])[:12]))
core = lambda m: m == "Init" or m.startswith("Init.")
ess = closure(roots)
essential = sorted(m for m in ess if not core(m))
stage("essential", essential, ess, roots)
if extra_roots:
    # a SECOND, additive tree: what the extra roots need beyond essential. Packed
    # separately, so consumers that do not want it (the playground) never pay for it.
    wide = closure(roots + extra_roots)
    extra = sorted(m for m in wide if not core(m) and m not in ess)
    stage("extra", extra, wide, extra_roots)
PY
git -C "$ML" rev-parse HEAD > "$W/MATHLIB-COMMIT"
echo "MATHLIB TREE COMPLETE — $W/essential-tree ($(cat "$W/MATHLIB-COMMIT" | cut -c1-10))"
