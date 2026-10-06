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
# what this build is of: written at the end only if the sources were clean at the
# start and the end, unchanged between the two commits, and the binary embeds that
# commit (a gate and a release name the commit, so a dirty build has none)
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
# what the binary is built from (import-release.sh holds the same list)
SRC_PATHS=(src stage0 docker-wasm64 CMakeLists.txt CMakePresets.json wasm64-build/gen-exports.py)
clean_sources() { [ -z "$(git -C "$REPO" status --porcelain -- "${SRC_PATHS[@]}")" ]; }
START_COMMIT=""; clean_sources && START_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
docker info >/dev/null 2>&1 || { echo "build.sh: Docker is not running (open -a Docker); nothing touched" >&2; exit 30; }
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
# the first step that rewrites the artifact (lib/lean, then bin): its old identity and gate
# stop describing it here — not before, so a failed configure keeps a good build's records
rm -f "$BUILD_DIR/GATE-PASSED" "$BUILD_DIR/BUILT-COMMIT"
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
# docs or tools may be committed during a long build; the sources may not move
EMBEDDED="$(sed -n 's/^#define LEAN_GITHASH "\([0-9a-f]*\)".*/\1/p' "$BUILD_DIR/build/stage1/githash.h" 2>/dev/null || true)"
if [ -n "$START_COMMIT" ] && clean_sources && git -C "$REPO" diff --quiet "$START_COMMIT" HEAD -- "${SRC_PATHS[@]}" \
   && { [ -z "$EMBEDDED" ] || [ "$EMBEDDED" = "$START_COMMIT" ]; }; then
  echo "$START_COMMIT" > "$BUILD_DIR/BUILT-COMMIT"
  echo "BUILD COMPLETE (${START_COMMIT:0:10}) — gate it: wasm64-build/import-release.sh gate-dir $BUILD_DIR"
else
  echo "BUILD COMPLETE from a dirty or moving tree (or the binary embeds ${EMBEDDED:-?}, not ${START_COMMIT:-?}): no BUILT-COMMIT, so it cannot be gated for a release"
  echo "  (try it anyway: node --stack-size=8192 wasm64-build/js/gate.mjs --artifact $BUILD_DIR/build/stage1)"
fi
