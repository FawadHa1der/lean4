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
 [K7] release  stage + record + verify lean-vX.Y.Z-<k7>  import-release.sh release  ~20 min (RELEASE.md)
                       ▼
 [Q]  QED64        adopt-release.sh: fetch → umbrella → both bakes → promote (isolated tree) → test pyramid
 [G]  lean4game    re-pin → build-from-source.sh (preflight,release,trees,games,bake,bundle) → cypress
                       ▼
 [S]  SHIP GATE — run by the repository owner, never by the pipeline:
        import-release.sh publish <id> (record + tag, atomic push, GitHub, R2, each verified),
        then upload-artifacts.sh, deploy-app.sh — per app
```

Everything up to [S] is local and reversible. Nothing in this pipeline pushes,
uploads or deploys; `publish` (the owner's command) is the one step that does.

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
pointer-width gates for a 32-bit native stage0). They are not needed: this
line's stage0 is native 64-bit, and each gate changes only a native 32-bit
build (its Emscripten and 64-bit branches are stock's). The next import drops
the patch and this step once one build confirms it. Until then, if the patch
stops applying, check whether upstream absorbed the gates, then refresh it with
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
4. **Exports** — what the IR interpreter resolves by name (every boxed wrapper,
   all-object function without one, `@[export]` function, module initializer
   and constant cell; `gen-exports.py` says why each is there) is not exported
   since patch 0039: it is a table generated from the build's own C and the
   archives the link uses, cross-checked against each other (the build fails if
   they disagree, if a category falls below its floor, or if the link binds a
   table entry to a signature-mismatch stub or leaves it undefined —
   `check-link.py`). New upstream modules are covered without anyone
   remembering to. What needs a human is the *JavaScript contract*,
   `src/emscripten-exports.seed.txt`: the names hosts call, one per line with
   its callers. When upstream removes an `@[export lean_*]` the generator drops
   the name loudly instead of failing the link — confirm no JS/worker caller
   used it, then delete it from the seed; adding a name means a host calls it.
   Before a release that changes the seed or the glue, run
   `node wasm64-build/js/exports-audit.mjs --glue <the new lean.js> <consumer
   trees>` over QED64, lean4game, the widgets showcase and the proof sheets: it
   must report every name covered, but for one known and dead reach-in,
   `globalThis.Module.HEAPU8` in QED64's resident probe and the proof sheets'
   browser check (PATCHES.md, 0039). `link-undefined-allowlist.txt` is
   calibrated (from the first 0039 link: empty): a link that leaves a symbol
   undefined fails until the name is reviewed and added there.
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
wasm64-build/mathlib-tree.sh v4.34.0            # Mathlib@v4.34.0 → <build dir>/mathlib/{essential,extra}-tree
wasm64-build/import-release.sh accept v4.34.0   # LOCAL fast-forward of qed64-wasm64; prints the push command
wasm64-build/import-release.sh release v4.34.0  # stage + verify the release; prints record/tag/publish commands
```

The release (`RELEASE.md`) is what the apps consume: runtime chunks, the
three library packs (`js/packs.json` — the pack cut moved here from QED64's
`import-packs.sh`, with the same mounts, roots and release strings), the
native compiler, module lists and the `lean4-wasm64` tools, each byte under a
digest in `release.json`.

`mathlib-tree.sh` builds one Lake workspace and stages two trees:
`essential-tree` = import closure of the three profile roots + `CORE_ROOTS`
(`Lean Std` — module-system Mathlib no longer pulls the core umbrellas in, and
`import Lean` must keep resolving) minus `Init.*`; `extra-tree` = closure of
the games' roots (`mathlib-extra-roots.txt`, committed with who needs each;
env `MATHLIB_EXTRA_ROOTS` overrides) minus essential, an additive pack only
the games mount (`mathlib-game-extra`). Both get the `deprecated_module` shims whose target is
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

## QED64 (`wasm64-lean-fable/qed64`) — see its docs/REBUILD.md §3 and §3b

```sh
pipeline/release/adopt-release.sh --id <lean-vX.Y.Z-hash> --digest sha256:<hex> \
  --from https://github.com/FawadHa1der/lean4/releases/download/<id>/ \
  --public <isolated served tree> --rebuild-umbrella      # --dry-run prints the plan
```

QED64 adopts the published release; it packs and chunks nothing itself (its
`import-packs.sh` and `bump-chain.sh` are gone). `adopt-release.sh` fetches the
release pinned by `--id` and `--digest`, checks `kernel.patch` against its
`minKernelPatch` floor, unpacks the slim trees, regenerates and compiles the
`QED64.Essential` umbrella with the new runtime (`--rebuild-umbrella`; a
runtime-only release reuses the served one, `--umbrella`), optionally runs this
package's gate (`--gate`), bakes both snapshots with its own
`pipeline/snapshot/bake-snapshot.mjs`, and promotes the staging into the
isolated served tree. QED64's resident gate then runs on that tree; the
landing steps (its tracked release record, `embedding/base-tree.json`, the
manifests) are printed, not performed. The kernel commit must already be on
`origin/qed64-wasm64`.

## lean4game (`wasm64-lean4game`) — see its wasm/KERNEL.md

```sh
wasm/build-from-source.sh --plan                  # every step, nothing run
wasm/build-from-source.sh --verify-snapshots      # a full run: preflight,release,trees,games,bake,bundle
```

lean4game pins one published release, as QED64 does: the root `package.json`
devDependency is the release's own tools tgz, and `wasm/lean4-wasm64-release.json`
is a byte copy of its `release.json` (the id and digest every fetch is checked
against; the lanes read the runtime build id, the Lean version and the native
compiler from it, and `scripts/stage-workers.sh` its `kernel.patch` floor). A
re-pin changes those two files; the lanes then unpack the release's packs,
compile the games with its `native64`, bake with QED64's bake and bundle.
`wasm/catalog.json` `expectedRaw` values are re-recorded for the new pairing
(the bake prints them).

## A kernel-only fix after an import

A fix that touches the runtime but not what the packs contain (v4.34.0:
patch 0034) is built in its own dir (`QED64_BUILD_DIR=<K'> wasm64-build/build.sh`
from a clean, committed tree — it then records `BUILT-COMMIT`; warm ccache. Since
v4.35 the stage1 stdlib build rebuilds a module's dependents only when its exported
interface changes: 0042's `Environment.lean` change, private bodies only, rebuilt 126
of 5,116 steps in 5 min; a changed exported signature still re-elaborates its
dependents, up to ~1 h), gated
(`import-release.sh gate-dir <K'>`, which writes `GATE-PASSED`; the gate also
asks the environment for its own facts: `isModule`, default privacy, meta
attributes), released by value (RELEASE.md: by value only since 2026-11-01;
`import-release.sh release vX.Y.Z --runtime <K'> --packs-from <dir of the kept
browser packs> --note …`: its runtime and its `lean-lib` from K', native64 and
the lists from the tag's import build dir, which must still exist, the browser
packs copied byte for byte), and handed to QED64 as a
KERNEL-ONLY bump: `adopt-release.sh` in its runtime-only mode (every served
pack's raw digest is in the release's `packs`) with `--umbrella` (oleans and
umbrella are reused), rebake, pyramid, promote (~500 MB upload: runtime chunks
+ two snapshots). lean4game re-pairs its game snapshots the same way.

A change since the import to the stdlib's sources (`src/Init`,
`src/Std`, `src/Lean`, `src/lake`; `stage0`, the compiler that compiles them)
makes the kept packs' oleans of those modules lag the compiled code until the
next full import: say in a `--note` why that is harmless (the runtime runs its
own compiled code for them), as `lean-v4.34.0-41ec565` and
`lean-v4.34.0-e1a79c1` do. A change to the olean format's C++ (`lean.h`,
`object.h`, `compact.{h,cpp}`, `module.cpp`) needs a full import: the kept
packs would no longer pair with the runtime. (Staging by reference refused the
first without `--stdlib-drift <note>` and the second always, as it did a Docker
recipe change and a kernel that does not descend from the base's: RELEASE.md.)

## Ship gate (repository owner)

```sh
wasm64-lean-kernel/wasm64-build/import-release.sh publish <release id> --dry-run   # then without --dry-run (RELEASE.md)
# first: the apps' pins must name a pushed commit and a published release. It commits and tags the record,
# pushes the line and the tag atomically, publishes ONE GitHub release (every asset SHA-256-verified before
# it goes public) and copies to R2 in the served order, verified. Manual fallback: the commands
# `import-release.sh release` prints (push --atomic …), without those checks.
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
