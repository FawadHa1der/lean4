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
5. **Library ports** — game patches in lean4game were validated against one
   Mathlib commit; expect a re-port pass per bump. Moved modules are the usual
   churn: rewrite imports to the new names rather than rely on shims (the
   deprecation warning renders to players).

## Kernel side

```sh
wasm64-build/import-release.sh watch            # 0 up to date · 10 ready · 11 waiting for Mathlib/Batteries
wasm64-build/import-release.sh run v4.34.0      # import → build → gate, stops at the first judgment point
wasm64-build/import-release.sh drift v4.34.0
wasm64-build/native64.sh v4.34.0                # after build: the compiler that writes every shipped olean
MATHLIB_EXTRA_ROOTS="Mathlib.Tactic …" \
wasm64-build/mathlib-tree.sh v4.34.0            # Mathlib@v4.34.0 → <build dir>/mathlib/{essential,extra}-tree
wasm64-build/import-release.sh accept v4.34.0   # LOCAL fast-forward of qed64-wasm64; prints the push command
```

`mathlib-tree.sh` builds one Lake workspace and stages two trees:
`essential-tree` = import closure of the three profile roots + `CORE_ROOTS`
(`Lean Std` — module-system Mathlib no longer pulls the core umbrellas in, and
`import Lean` must keep resolving) minus `Init.*`; `extra-tree` = closure of
`MATHLIB_EXTRA_ROOTS` minus essential, an additive pack only the games mount
(`mathlib-game-extra`). Both get the `deprecated_module` shims whose target is
already inside them (`mathlib-select.py`): Mathlib moves modules and leaves
the old name as a shim nothing imports, so a closure never contains one, and
without them every file written against a pre-move name is refused where
stock Lean only warns (v4.34.0: 80 + 4 shims added, 72 skipped, listed in
`shims-skipped.txt`; `*-selection.json` carries `deprecatedShims`). Names
whose shim upstream already deleted stay gone. `SELECT_ONLY=1` re-runs the
selection over an existing build in seconds.

Build directory: `../wasm64-lean-kernel-build-<tag>` (override `QED64_BUILD_DIR`).
It is never an app's build tree — a stage1 rebuild unpairs every snapshot baked
against the old binary. Docker's VM needs ≥ 10 GB for the final `wasm-metadce`
link and must not be shared with another build (silent rc-137 OOM kills).

`native64.sh` refuses to continue unless the native build's core library is
the wasm64 build's core library (every `.olean*`/`.ir*` compared) — that
equality is what makes natively compiled Mathlib loadable in the browser.

## QED64 (`wasm64-lean-fable/qed64`) — see its docs/REBUILD.md § 3b

```sh
pipeline/release/import-packs.sh <build dir> --lean-version 4.34.0   # --dry-run validates the contract; --from <step> resumes
```

The lane reads the contract above (`build/stage1`, `BUILT-COMMIT`,
`mathlib/{essential-tree,essential-modules.txt,MATHLIB-COMMIT}`, optional
`mathlib/extra-tree`): packs lean-core + mathlib-essential (+ mathlib-game-extra
into `work/staging/<buildId>/extra/`, never promoted), checks the two packs form
one import-closed library, unpacks into a fresh tree, regenerates and compiles
the `QED64.Essential` umbrella with the new runtime, then
`bump-chain.sh stage-artifact` (gate → chunk → slim trees → both bakes). The
pyramid runs on the staged pairing with `?profiles=` so it sees the staged
packs, then KERNEL-PIN (the `BUILT-COMMIT`, which must already be on
`origin/qed64-wasm64`) and `bump-chain.sh promote`, which moves packs,
manifests, runtime and snapshots in one step. The promote commit is the
qed64 commit lean4game syncs to.

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
