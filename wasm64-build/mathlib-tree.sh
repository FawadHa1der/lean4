#!/usr/bin/env bash
# Build the Mathlib olean tree the two apps ship, with the native64 compiler of
# this kernel commit (native64.sh), and stage the "essential" selection as one
# flat olean tree for the release's packs (below).
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
# The release cuts the packs from these trees (js/pack-set.mjs per js/packs.json, run by
# stage-release.sh; RELEASE.md); apps take them from the release.
#
# No `lake exe cache get`: the community cache holds oleans written by the
# official compiler (GMP bignums, another platform target); only oleans written
# by THIS fork's native64 compiler are loadable by the wasm64 runtime.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: mathlib-tree.sh <tag>}"
BD="${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$TAG}"
IMG=qed64-toolchain:emsdk-7.0.0
MATHLIB_URL="${MATHLIB_URL:-https://github.com/leanprover-community/mathlib4}"
MATHLIB_REV="${MATHLIB_REV:-$TAG}"
# Before any git or python3: /usr/bin/git and /usr/bin/python3 are xcrun shims,
# which an unaccepted Xcode licence breaks; the CommandLineTools' copies work.
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
# Roots whose closure is the served profile: mathlib-essential's "roots" in
# js/packs.json, the list pack-set.mjs records in the pack's manifest, read from
# there so the two cannot drift: the first three since the first release, and
# since v4.36.0 five small ones the apps' files import (tactics, norm_num's
# primality, pigeonhole, the reals' topology lemmas). Stage the tree from this
# checkout: pack-set.mjs refuses only a root the tree lacks, so a packs.json
# naming other roots would put them in the manifest of a tree not cut for them.
# For the same reason env MATHLIB_ROOTS (space separated), which overrides the
# list, is for a trial only. Extra roots (the games'; mathlib-extra-roots.txt,
# or env MATHLIB_EXTRA_ROOTS, space separated) are built in the same Lake
# workspace but staged as a separate additive tree.
if [ -z "${MATHLIB_ROOTS:-}" ]; then
  # python3 -I: no module from the cwd, no PYTHON* variable. A root is a module
  # name, dot-separated words: the list goes unquoted into the container's bash.
  MATHLIB_ROOTS="$(python3 -I -c '
import json, re, sys
p = sys.argv[1]
try:
    ess = [d for d in json.load(open(p, encoding="utf-8"))["packs"] if d["id"] == "mathlib-essential"]
    roots = ess[0]["roots"] if len(ess) == 1 else None
    if not (isinstance(roots, list) and roots and all(isinstance(r, str) and re.fullmatch(r"\w+(\.\w+)*", r) for r in roots)
            and len(set(roots)) == len(roots)):
        raise ValueError("want one mathlib-essential pack whose roots are a non-empty list of distinct module names")
except Exception as e:
    sys.exit("mathlib-tree: cannot read the roots of mathlib-essential from %s: %s: %s" % (p, type(e).__name__, e))
print(" ".join(roots))
' "$REPO/wasm64-build/js/packs.json")" || exit 1
fi
# The extra roots are committed (mathlib-extra-roots.txt) so a version import
# carries the games' needs without anyone remembering them; the env overrides.
if [ -z "${MATHLIB_EXTRA_ROOTS+x}" ]; then
  MATHLIB_EXTRA_ROOTS="$(sed -e 's/#.*//' "$REPO/wasm64-build/mathlib-extra-roots.txt" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')"
fi
ROOTS="$MATHLIB_ROOTS ${MATHLIB_EXTRA_ROOTS:-}"
# Core umbrellas selected INTO essential (nothing to build: they are the
# kernel's own library). Until 4.33 they arrived through Mathlib's legacy
# `import Lean`-style headers; module-system Mathlib imports core modules one by
# one, and without these roots `import Lean` / `import Std` in a user's file
# would stop resolving (-504 Lean.*, -276 Std.* modules at v4.34.0).
CORE_ROOTS="${CORE_ROOTS-Lean Std}"
THREADS="${LEAN_NUM_THREADS:-6}"      # fd exhaustion + an 8 GiB Docker VM: keep it modest
NATIVE="$BD/native"
[ -x "$NATIVE/stage1/bin/lean" ] || { echo "mathlib-tree: no native64 compiler in $NATIVE — run native64.sh $TAG" >&2; exit 1; }
# One recipe per import: Lake, git and ProofWidgets' Node build run in HEAD's $IMG, which must be the
# recipe native64 was built with (native64.sh's rule; the image's Node builds ProofWidgets' JS)
NC="$(cat "$NATIVE/NATIVE-COMMIT" 2>/dev/null || true)"
[ -n "$NC" ] && git -C "$REPO" diff --quiet "$NC" HEAD -- docker-wasm64 \
  || { echo "mathlib-tree: docker-wasm64 at HEAD is not native64's recipe (${NC:-no $NATIVE/NATIVE-COMMIT}; $IMG): run this from a checkout of that recipe" >&2; exit 1; }
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
# SELECT_ONLY=1 re-runs just the selection over an existing build
[ -n "${SELECT_ONLY:-}" ] || run "lean --version && lake build $ROOTS -q --log-level=info"

echo "=== [3/4] native smoke ==="
cat > "$W/mathlib4/.qed64-smoke.lean" <<'LEAN'
import Mathlib.Geometry.Manifold.Instances.Sphere
import Mathlib.Analysis.SpecialFunctions.Complex.Circle
example : (2 : ℝ) + 2 = 4 := by norm_num
example (a b : ℕ) : a + b = b + a := by omega
LEAN
[ -n "${SELECT_ONLY:-}" ] || run "lake env lean .qed64-smoke.lean"

SELECT=(python3 "$REPO/wasm64-build/mathlib-select.py")
ARGS=("$ML" "$NATIVE/stage1/lib/lean" "$REPO/src" "$W" "$MATHLIB_ROOTS $CORE_ROOTS" "${MATHLIB_EXTRA_ROOTS:-}")
echo "=== [4a/4] deprecated-module shims ==="
# Old module names survive a Mathlib move only as `deprecated_module` shims that
# nothing imports, so no root pulls them in: build the ones whose target is
# already selected (mathlib-select.py explains the rule). Incremental, minutes.
SHIMS="$("${SELECT[@]}" shims "${ARGS[@]}" | awk '{print $2}' | tr '\n' ' ')"
if [ -n "${SHIMS// /}" ]; then
  run "lake build $SHIMS -q --log-level=warning" || { echo "mathlib-tree: shim build failed" >&2; exit 1; }
fi
echo "=== [4b/4] selection ==="
"${SELECT[@]}" select "${ARGS[@]}"
git -C "$ML" rev-parse HEAD > "$W/MATHLIB-COMMIT"
echo "MATHLIB TREE COMPLETE — $W/essential-tree ($(cat "$W/MATHLIB-COMMIT" | cut -c1-10))"
