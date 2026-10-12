# wasm64 kernel build (branch `qed64-wasm64`)

This branch is Lean 4 (base: cauli/lean4 `reinstate-wasm` @ 5732b84 — the
original Emscripten/Memory64 enablement) plus the QED64 patch series that
makes the compiler + language server run **inside a browser tab**: the
resident language server over a shared-memory stdin ring,
compacted-environment snapshot save/load, covering-environment header
resolution, legacy-olean tolerance for the lean4game ecosystem, and the
Emscripten survival fixes underneath them (`EMBED-RUNTIME.md` is the
embedding contract).
`PATCHES.md` documents every commit; the git history of this branch IS the
series (the former mail-patch files are retired).

## Build

Requires Docker (image builds from `../docker-wasm64`, emsdk 6.0.5) and
~10 GB in the Docker VM. Since patch 0039 the host writes into the build tree
the container made (the native-symbol table, `lib/temp`): Docker Desktop and
rootless Docker map it to the host user; under rootful Docker on Linux it is
root's, and `build.sh` stops before writing, saying so.

    wasm64-build/build.sh                              # full build (QED64_BUILD_DIR, default a sibling dir)
    wasm64-build/import-release.sh gate-dir <build dir> # the release gate; writes GATE-PASSED

The gate must pass before any artifact is used: numBits=64, proof smoke,
error smoke, module-semantics probes, the task storm, and THE PARSE GATE
(garbage input must diagnose, not succeed). Since patch 0039 it also checks the
runtime's files against the JavaScript export contract and the glue internals
hosts reach into, and the native-symbol table at work.

The link writes `build/stage1/bin/lean.js.symbols` (`index:name` of every wasm
function), which stays in the build tree: since 0039 the module exports only the
JavaScript contract and its raw export names are minified, so a
`wasm-function[N]` in a trace or a profile is named from this map (with
`EMSCRIPTEN_DEBUG=ON`'s `--profiling-funcs` the binary carries the names
itself). `LEAN_WASM_SYMTAB_TRACE` (EMBED-RUNTIME.md §3.1) prints the IR
interpreter's native-symbol lookups, e.g. `LEAN_WASM_SYMTAB_TRACE=miss:
lean4-wasm64 run …` for every name it did not find natively.
`stack-margin.mjs` measures, through the host lock, the smallest pthread stack
each deep-recursion proof needs on a runtime (to compare runtimes).

Outputs: `build/stage1/bin/lean.{js,wasm}` (the browser runtime) and its
`lib/lean`. `native64.sh` builds the same commit as a native linux compiler
(`native/stage1`) — the compiler that writes every Mathlib olean the runtime
loads; `mathlib-tree.sh` builds Mathlib with it. An upstream release goes
through all of it: `RELEASE-PIPELINE.md`.

## Releases

Gated builds are published as versioned, checksummed releases
(`lean-v4.34.0-a8817d0`): runtime, library packs, the native compiler, module
lists and the `lean4-wasm64` tools, as a GitHub Release and an R2 prefix.
Apps pin a release instead of a build directory. `RELEASE.md` is the process;
`js/formats/` the specification; `EMBED-RUNTIME.md` the runtime's embedding
ABI; `js/` the tools (installed from a release's `tools/` tarball: `npx lean4-wasm64 fetch|verify|run|…`).

## Consumers

- **QED64 / Lean playground** (`wasm64-lean-fable/qed64`): serves the runtime
  and the lean-core + mathlib-essential packs, bakes environment snapshots
  (binary-paired to the exact runtime — rebake after every runtime change).
- **wasm64-lean4game**: game snapshots on the line's runtime (it serves a
  4.33 build until its v4.34.0 re-pair) and the mathlib-game-extra pack.
- **widgets showcase**: QED64's runtime and packs under its own origin.

One branch serves every app deliberately: app-specific behavior is gated at
runtime (e.g. the legacy-olean tolerance is wasm-target/env-var scoped), never
by kernel forks.
