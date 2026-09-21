#!/usr/bin/env bash
# Native 64-bit build of the SAME kernel commit the wasm64 runtime was built
# from — the compiler that produces every olean the browser runtime loads
# (Mathlib, games). It is an ordinary linux `lean`, configured to describe
# itself as the wasm target so the oleans it writes are the ones the wasm64
# stage1 would write:
#   STAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten   same System.Platform.target
#   USE_GMP=OFF, USE_MIMALLOC=OFF                           same bignum + object layout
#   STAGE1_USE_GITHASH=OFF, CHECK_OLEAN_VERSION=OFF         olean trust is the SHA-256 manifests
# (recipe: browser64 toolchain/build-mathlib-essential.sh; it has served the
# 4.33 packs since the first release).
#
#   wasm64-build/native64.sh <tag>      # e.g. v4.34.0; needs import-release.sh build <tag> first
#
# Output: <build dir>/native/stage1/{bin/lean,bin/lake,lib/lean}. The source is
# a detached git worktree at the built commit (<build dir>/native-src): CMake
# writes src/lakefile.toml into its source tree, and the wasm and native
# configurations must not overwrite each other's.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: native64.sh <tag>}"
BD="${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$TAG}"
IMG=qed64-toolchain:emsdk-6.0.5
JOBS="${JOBS:-10}"
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
[ -f "$BD/BUILT-COMMIT" ] || { echo "native64: $BD/BUILT-COMMIT missing — run import-release.sh build $TAG first" >&2; exit 1; }
COMMIT="$(cat "$BD/BUILT-COMMIT")"
SRC="$BD/native-src"; OUT="$BD/native"
mkdir -p "$OUT" "$BD/ccache-native"

if [ -d "$SRC" ]; then
  git -C "$SRC" checkout --quiet --detach "$COMMIT"
else
  git -C "$REPO" worktree add --detach "$SRC" "$COMMIT" >/dev/null
fi
echo "=== native64: $COMMIT -> $OUT ==="

run() {
  docker run --rm \
    -e LEAN_CC=/usr/bin/gcc \
    -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -v "$SRC":/lean-src -v "$OUT":/lean-native -v "$BD/ccache-native":/root/.ccache \
    "$IMG" bash -c "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; $1"
}
# PATH is reset INSIDE the container: the image's entrypoint prepends
# /emsdk/upstream/emscripten (overriding -e PATH), where `cmake` is a DIRECTORY,
# and GNU make 4.3 then fails the native-only copy-leantar/copy-cadical steps
# with "cmake: Permission denied".
echo "=== [1/3] configure ==="
run "cmake -S /lean-src -B /lean-native -G 'Unix Makefiles' \
  -DCMAKE_BUILD_TYPE=Release \
  -DSTAGE1_USE_GITHASH=OFF \
  -DCHECK_OLEAN_VERSION=OFF \
  -DSTAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten \
  -DSTAGE1_LEANC_CC=/emsdk/upstream/emscripten/emcc \
  -DUSE_GMP=OFF -DSTAGE0_USE_GMP=OFF -DUSE_MIMALLOC=OFF \
  -DCMAKE_C_COMPILER=/usr/bin/gcc -DCMAKE_CXX_COMPILER=/usr/bin/g++ \
  -DSTAGE0_CMAKE_C_COMPILER=/usr/bin/gcc -DSTAGE0_CMAKE_CXX_COMPILER=/usr/bin/g++"
echo "=== [2/3] build (stage0 + stage1) ==="
run "make -C /lean-native -j$JOBS"
echo "=== [3/3] identity ==="
run "/lean-native/stage1/bin/lean --version"
VER="$(run "/lean-native/stage1/bin/lean --version")"
case "$VER" in *wasm64-unknown-emscripten*) ;; *) echo "native64: lean does not report the wasm64 target: $VER" >&2; exit 1;; esac
printf 'example : System.Platform.numBits = 64 := by decide\n#eval System.Platform.target\n' > "$OUT/abi-smoke.lean"
run "/lean-native/stage1/bin/lean /lean-native/abi-smoke.lean"

# The premise of the whole lane: the core library the native compiler wrote is
# the core library the wasm64 build wrote. Both come from the same stage0, so
# any difference means the two configurations diverged.
python3 - "$BD/build/stage1/lib/lean" "$OUT/stage1/lib/lean" <<'PY'
import os, sys
wasm, native = sys.argv[1], sys.argv[2]
FACETS = (".olean", ".olean.server", ".olean.private", ".ir", ".ir.sig")
def walk(root):
    out = {}
    for r, _, fs in os.walk(root):
        for f in fs:
            if f.endswith(FACETS):
                p = os.path.join(r, f); out[os.path.relpath(p, root)] = p
    return out
a, b = walk(wasm), walk(native)
only_a, only_b = sorted(set(a) - set(b)), sorted(set(b) - set(a))
same = hdr = body = 0; bad = []
for k in sorted(set(a) & set(b)):
    x, y = open(a[k], "rb").read(), open(b[k], "rb").read()
    if x == y: same += 1
    elif len(x) == len(y) and x[80:] == y[80:]: hdr += 1
    else: body += 1; bad.append(k)
print(f"core facets: {same} identical, {hdr} differ only in the 80-byte olean header, {body} differ in the body; "
      f"{len(only_a)} only in wasm, {len(only_b)} only in native")
for k in (bad + only_a + only_b)[:10]: print("  diff:", k)
if body or only_a or only_b:
    sys.exit("native64: the native core library is NOT the wasm64 core library — do not build packs with it")
PY
echo "$COMMIT" > "$OUT/NATIVE-COMMIT"
echo "NATIVE64 COMPLETE — $OUT/stage1"
