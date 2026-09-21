#!/bin/bash
# Clean-room wasm64 (Memory64) toolchain build for this branch.
# Expected wall-clock on a 14-core M-series: 1.5-3 h cold, ~10-25 min warm.
# Build tree and ccache live OUTSIDE the repo (BUILD_DIR, default sibling
# <repo>-build) so the checkout stays clean.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build}"
IMG=qed64-toolchain:emsdk-6.0.5
mkdir -p "$BUILD_DIR/build" "$BUILD_DIR/ccache"
echo "=== [1/5] docker image ==="
docker build -t "$IMG" "$REPO/docker-wasm64"
run() {
  docker run --rm \
    -v "$REPO":/lean4 \
    -v "$BUILD_DIR/build":/build \
    -v "$BUILD_DIR/ccache":/root/.ccache \
    -e EM_COMPILER_WRAPPER=ccache \
    "$IMG" bash -lc "git config --global --add safe.directory /lean4 && $1"
}
echo "=== [2/5] configure (outer) ==="
run "/lean4/docker-wasm64/configure-qed64.sh"
echo "=== [3/5] stage1-configure (builds native stage0 first) ==="
run "make -C /build stage1-configure -j12"
echo "=== [4/5] stage1 libraries ==="
run "make -C /build/stage1 libuv leanrt leanrt_initial-exec leancpp leanshell kernel library -j12"
# The stdlib compile (.lean -> lib/temp/*.c) must precede the export scan:
# without it the generator reads the PREVIOUS build's C and a name that a
# commit deleted could still be exported.
run "make -C /build/stage1 make_stdlib -j12"
echo "=== [4b/5] exports generated from the compiled C ==="
# final = seed + (wanted & defined): a specialization upstream renamed drops
# out of the export list (the interpreter interprets it) instead of failing
# the link. See gen-exports.py; src/emscripten-exports.txt is gitignored.
python3 "$REPO/wasm64-build/gen-exports.py" "$BUILD_DIR/build/stage1/lib/temp" "$REPO/src"
echo "=== [5/5] final lean link ==="
run "make -C /build/stage1 leaninitialize lean -j12"
ls -la "$BUILD_DIR/build/stage1/bin/" | grep -E "lean\.(js|wasm)"
echo "BUILD COMPLETE — gate it: node wasm64-build/gate.mjs --artifact $BUILD_DIR/build/stage1"
