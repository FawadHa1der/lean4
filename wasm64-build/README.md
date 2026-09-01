# wasm64 kernel build (branch `qed64-wasm64`)

This branch is Lean 4 (base: cauli/lean4 `reinstate-wasm` @ 5732b84 — the
original Emscripten/Memory64 enablement) plus the QED64 patch series that
makes the compiler + language server run **inside a browser tab**: in-memory
LSP pump entry points, compacted-environment snapshot save/load, covering-env
header aliasing, cancellable session replacement, legacy-olean tolerance for
the lean4game ecosystem, and the Emscripten survival fixes underneath them.
`PATCHES.md` documents every commit; the git history of this branch IS the
series (the former mail-patch files are retired).

## Build

Requires Docker (image builds from `../docker-wasm64`, emsdk 6.0.5) and
~10 GB in the Docker VM.

    wasm64-build/build.sh          # full build (BUILD_DIR defaults to a sibling dir)
    node wasm64-build/gate.mjs --artifact <BUILD_DIR>/build/stage1

The gate must pass before any artifact is used: numBits=64, proof smoke,
error smoke, and THE PARSE GATE (garbage input must diagnose, not succeed).

Outputs: `stage1/bin/lean.{js,wasm}` (the browser runtime) and
`stage0/bin/{lean,lake}` (the fork's native linux compiler — used to compile
Lean packages, e.g. games, whose oleans the runtime loads).

## Consumers

- **QED64 / Lean playground** (`wasm64-lean-fable/qed64`): chunks the runtime
  (`pipeline/toolchain/chunk-runtime.mjs`), bakes environment snapshots
  (binary-paired to the exact runtime — rebake after every rebuild), packs
  olean trees. Its `pipeline/toolchain/setup-source.sh` clones THIS branch.
- **wasm64-lean4game**: consumes the same built runtime + game snapshots.

One branch serves both apps deliberately: app-specific behavior is gated at
runtime (e.g. the legacy-olean tolerance is wasm-target/env-var scoped), never
by kernel forks.
