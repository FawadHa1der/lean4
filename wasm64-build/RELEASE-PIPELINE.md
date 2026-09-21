# Importing an upstream Lean release, end to end

What happens between "leanprover/lean4 tagged vX.Y.Z" and "both apps serve it".
The kernel line (`qed64-wasm64`) is the root of the dependency chain; each app
owns the lanes inside its own repository. This file is the map and the order.

```
 upstream tag vX.Y.Z ─┐
 Mathlib   tag vX.Y.Z ─┤   (watch: both must exist)
                       ▼
 [K1] import   merge the tag on import/vX.Y.Z            import-release.sh import   ── judgment: conflicts
 [K2] drift    review files both sides changed           import-release.sh drift    ── judgment: review
 [K3] build    wasm64 stage1 in Docker (own build dir)   import-release.sh build    1.5–3 h cold
 [K4] gate     numBits / proof / error / PARSE / resident import-release.sh gate     ~8 min
 [K5] native64 same commit, native linux, wasm64 target  native64.sh                ~1 h
 [K6] mathlib  Mathlib@vX.Y.Z with [K5], essential tree  mathlib-tree.sh            hours
                       ▼
 [Q]  QED64        packs → manifests → umbrella → bump-chain.sh stage-artifact → test pyramid → promote
 [G]  lean4game    closure sync → build-from-source.sh (core,trees,compat,games,bake,bundle) → cypress
                       ▼
 [S]  SHIP GATE — run by the repository owner, never by the pipeline:
        git push (kernel line first), upload-artifacts.sh, deploy-app.sh — per app
```

Everything up to [S] is local and reversible. Nothing in this pipeline pushes,
uploads or deploys.

## Why a merge, and why a tag

The line is real git history on top of upstream, so an import is
`git merge vX.Y.Z` on a branch `import/vX.Y.Z` cut from `qed64-wasm64`.
Merging (not rebasing) keeps every published commit id valid — both apps pin
the kernel by commit and refuse a pin that is not on `origin/qed64-wasm64`.
Stable tags live on upstream's `releases/vX.Y.0` branches, not on `master`;
merging consecutive tags re-merges the backports, which git resolves as
identical changes. `rerere` is switched on so a resolution is remembered.
Only stable tags are imported: Mathlib and Batteries tag each stable Lean
release, and the apps need all three at the same version.

`stage0/` is upstream's bootstrap compiler and is never merged: the import
takes upstream's files and re-applies `stage0-line-edits.patch` (two
pointer-width gates for a 32-bit native stage0). If that patch stops applying,
check whether upstream absorbed the gates, then refresh it with
`git diff --text vX.Y.Z HEAD -- stage0 > wasm64-build/stage0-line-edits.patch`.

## Judgment points (where automation stops)

1. **Conflicts** — `import` exits 20 and leaves the merge in the tree. v4.34.0
   had five single-hunk conflicts; see that merge commit's message for the
   reasoning pattern (take upstream's structure, keep the port's behaviour
   under `LEAN_EMSCRIPTEN`).
2. **Drift review** — `drift` lists files changed on both sides. A clean
   textual merge proves nothing: upstream may have added a second code path
   that bypasses a wasm guard, renamed something a patch calls, or moved the
   logic a hook sat in. Review at least `Lean/Server/FileWorker.lean`
   (`setupImports`, the resident resolver), `Lean/Language/Lean.lean`,
   `Lean/Environment.lean` + `Lean/Elab/Import.lean` (legacy-import tolerance,
   `irPhases`), `library/module.cpp` (non-mmap read path), `runtime/io.cpp`
   (stdin ring), `util/shell.cpp` (no second thread under Emscripten).
3. **Build breaks / gate failures** — fix on the import branch as ordinary
   commits on top of the merge. Never amend the merge once anyone has seen it.
4. **Exports** — the export list is generated from the build's own C (every
   boxed wrapper, module initializer and constant cell; `gen-exports.py` says
   why each is a correctness requirement), so new upstream modules are covered
   without anyone remembering to. What needs a human is the *seed*: when
   upstream removes an `@[export lean_*]`, the generator drops the name loudly
   instead of failing the link — confirm no JS/worker caller used it, then
   delete it from `src/emscripten-exports.seed.txt` (v4.34.0 removed 23).
5. **Library ports** — game patches and `wasm/compat` sources in lean4game were
   validated against one Mathlib commit; expect a re-port pass per bump.

## Kernel side

```sh
wasm64-build/import-release.sh watch            # 0 up to date · 10 ready · 11 waiting for Mathlib/Batteries
wasm64-build/import-release.sh run v4.34.0      # import → build → gate, stops at the first judgment point
wasm64-build/import-release.sh drift v4.34.0
wasm64-build/native64.sh v4.34.0                # after build: the compiler that writes every shipped olean
wasm64-build/mathlib-tree.sh v4.34.0            # Mathlib@v4.34.0 → <build dir>/mathlib/essential-tree
wasm64-build/import-release.sh accept v4.34.0   # LOCAL fast-forward of qed64-wasm64; prints the push command
```

Build directory: `../wasm64-lean-kernel-build-<tag>` (override `QED64_BUILD_DIR`).
It is never an app's build tree — a stage1 rebuild unpairs every snapshot baked
against the old binary. Docker's VM needs ≥ 10 GB for the final `wasm-metadce`
link and must not be shared with another build (silent rc-137 OOM kills).

`native64.sh` refuses to continue unless the native build's core library is
the wasm64 build's core library (every `.olean*`/`.ir*` compared) — that
equality is what makes natively compiled Mathlib loadable in the browser.

## QED64 (`wasm64-lean-fable/qed64`) — see its docs/REBUILD.md § 3b

```sh
K=<build dir>; ART=$K/build/stage1; V=4.34.0; REV=$(cat $K/BUILT-COMMIT)
# packs (5 facets) from the two olean trees
node pipeline/artifacts/pack.mjs --lib $ART/lib/lean/Init* …          # lean-core: Init closure, roots Init
node pipeline/artifacts/pack.mjs --lib $K/mathlib/essential-tree --id mathlib-essential \
     --out <staging>/profiles --lean-version $V --revision $REV --roots <the three roots>
# tree + umbrella: unpack both packs → lib tree; QED64/Essential.lean = one import per manifest module,
# compiled BY THE NEW RUNTIME (node-runner.mjs --artifact $ART --lib <tree> -- -o /work/Essential.olean …)
QED64_ARTIFACT=$ART QED64_LIB_TREE=<tree> QED64_SLIM=<scratch> QED64_SNAP_WORK=<scratch> \
QED64_LEAN_VERSION=$V pipeline/release/bump-chain.sh stage-artifact
# pyramid on the staged pairing (one gate at a time), KERNEL-PIN, then
pipeline/release/bump-chain.sh promote
```

Packs, runtime and snapshots are promoted together: the page boots from
`public/profiles`, and a runtime served with the previous version's packs is a
broken site.

## lean4game (`wasm64-lean4game`) — see its wasm/KERNEL.md

```sh
scripts/sync-qed64.sh <qed64 commit>                       # vendored closure must match the runtime's transport
KERNEL_DIR=<kernel checkout> BUILD_DIR=<build dir> MATHLIB_PACK_DIR=<new pack dir> \
  wasm/build-from-source.sh --lanes core,trees,compat,games,bake,bundle --verify-snapshots
```

`wasm/compat/**` is regenerated from the new Mathlib commit and the new pack's
module list; `wasm/catalog.json` `expectedRaw` values are re-recorded (the
bake prints them); `LEAN_VERSION` in `build-from-source.sh` is bumped.

## Ship gate (repository owner)

```sh
git -C wasm64-lean-kernel push origin qed64-wasm64       # first: the apps' pins must name a pushed commit
# QED64
scripts/upload-artifacts.sh && scripts/deploy-app.sh && git push
# lean4game
scripts/upload-artifacts.sh && scripts/deploy-app.sh && git push      # + gh release create <tag> … for the bundles
```

## Scheduling

`import-release.sh watch` is cheap (three `git ls-remote`s) and has distinct exit
codes, so any scheduler can poll it. The heavy stages need this machine
(Docker, ~40 GB disk, hours of CPU; a hosted CI runner cannot fit the Mathlib
build) and the judgment points need a reviewer. The driver in use is a weekly
scheduled agent session (`lean-release-watch`, Mondays 09:00): it runs
`watch`; on exit code 10 it performs the trial `import`, reports conflicts and
the drift list, leaves a conflicted checkout exactly as it found it, and stops
— the hours-long stages (which also need an otherwise idle Docker VM) start
only when the owner says go, and end at the ship gate above.
