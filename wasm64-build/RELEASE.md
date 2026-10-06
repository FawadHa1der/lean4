# lean4-wasm64 releases

This repository owns the whole wasm64 toolchain: the runtime, the compiler
that writes the oleans it loads, the library packs, and the tools that check
them. Every gated build that apps should use is published as one **release**:
a versioned, checksummed set of files that QED64, lean4game and the widgets
showcase pin by id instead of each re-deriving the toolchain from a build
directory.

| | |
|---|---|
| Release id | `lean-<upstream tag>-<kernel commit, 7 hex>[-rN]`, e.g. `lean-v4.34.0-a8817d0` |
| Record | `release.json` (`lean4-wasm64.release/v1`, `js/formats/release.md`), committed as `wasm64-build/releases/<id>.json` |
| Tag | the release id, an annotated tag on the commit that adds the record |
| Where | GitHub Release `<id>` on `FawadHa1der/lean4` (flat), and R2 `qed64-artifacts/lean4-wasm64/<id>/` (served layout) |
| Tools | the npm package `lean4-wasm64` (`wasm64-build/js`), version `<lean version>-<kernel7>[-rN]`, shipped in the release as `tools/lean4-wasm64-<version>.tgz` |

## What a release contains

| Path | What | From |
|---|---|---|
| `runtime/` | the runtime manifest (twice: mutable name and `runtime-manifest.<buildId>.json`), `lean.js` + `lean.wasm` as 16 MiB chunks, the other files of the build's `bin/` (`leanmake`) | the gated runtime build (`build/stage1/bin`), `chunk-runtime.mjs` |
| `profiles/` | the library packs, manifests + gzip transport parts (`pack-set.mjs` per `js/packs.json`): for browsers `lean-core` (Init) and `mathlib-essential` (Lean, Std, the Mathlib closure), for the games `mathlib-game-extra`; for Node `lean-lib`, the runtime build's own whole `lib/lean` (Init, Std, Lean, Lake, …) — the tree the gate ran on | the import build; `lean-lib` from the runtime build |
| `native64/native64.tar.gz` | the native linux/aarch64 compiler of the same line (`bin/`, `include/`, `share/`, `lib/lean/`) — the compiler that writes every shipped Mathlib olean; it runs in the toolchain image (a native link needs `LEAN_CC=gcc`: the shipped `leanc` defaults to emcc) | `native64.sh` |
| `lists/` | module lists and selection records of the Mathlib packs | `mathlib-tree.sh` |
| `tools/` | the `lean4-wasm64` package tarball | `npm pack` of `wasm64-build/js` at a committed tree |
| `release.json`, `SHA256SUMS` | the record and its digests | `release.mjs` |

Snapshots (`.snapz`) are not in a release: they are memory images of one app's
environment, baked by the app against a release's runtime.

## Cutting a release

After an import (or a kernel-only fix) is built, gated and accepted onto
`qed64-wasm64` (RELEASE-PIPELINE.md):

```bash
# 1. the package version names the release; commit it with any tool changes
#    (wasm64-build/js/package.json "version": "4.34.0-a8817d0")
# 2. stage, record and verify — everything local, nothing published
wasm64-build/import-release.sh release v4.34.0                      # the import's own build dir
# the first release, from the bytes QED64 serves (run from ~/code):
#   wasm64-lean-kernel/wasm64-build/import-release.sh release v4.34.0 \
#     --runtime wasm64-lean-kernel-build-v4.34.0-0035z \
#     --packs-from wasm64-lean-fable/qed64/public/profiles \
#     --match-runtime wasm64-lean-fable/qed64/public/runtime/runtime-manifest.json --note …
# a kernel-only fix: build it (build.sh records BUILT-COMMIT for a clean tree), gate it, release it
QED64_BUILD_DIR=<K'> wasm64-build/build.sh && wasm64-build/import-release.sh gate-dir <K'>
wasm64-build/import-release.sh release v4.34.0 --runtime <K'>        # packs/native64/lists from the import
```

Options: `--packs-from <dir>` copies packs a site already serves (their
transport bytes stay valid in every cache) instead of re-packing them;
`--match-runtime <manifest>` makes staging stop unless the release's runtime
manifest is byte-identical to one a site serves (so nothing baked against it
unpairs); `--note <text>` adds a release note; `--recut <n>` a tools-only re-cut
(it needs `--match-runtime` with the base release's runtime manifest, since a
re-cut keeps the runtime). Relative paths are the caller's.

`stage-release.sh` refuses to stage a runtime without a passing gate for that
commit and that `lean.wasm`, a commit that is not on `qed64-wasm64` or carries
another upstream tag, a dirty `wasm64-build/js`, a package version that does
not name the release, or an already tagged id. It writes
`../wasm64-lean-kernel-release/<id>/` and, beside it, the release config
(`<id>.config.json`), the packs' provenance (`<id>.pack-set.json`) and the
verification report (`<id>.verify.json`). It runs `verify-release --deep` last
(on failure it removes `release.json`, so nothing half-checked looks cut) and
prints the commands below, with the record's digest.

```bash
# 3. the record and the tag (local)
mkdir -p wasm64-build/releases && cp ../wasm64-lean-kernel-release/<id>/release.json wasm64-build/releases/<id>.json
git add wasm64-build/releases/<id>.json && git commit -m "release <id>"
git tag -a <id> -m "lean4-wasm64 <id> (sha256:<digest>)"
# 4. publish — the repository owner, by hand (the commands are printed in full)
git push origin qed64-wasm64 <id>
gh release create <id> --draft … ; gh release upload <id> <every file, flat> ; gh release edit <id> --draft=false
rclone copy … --immutable   # three passes: objects, manifests, release.json (js/formats/HOSTING.md)
```

Nothing in the pipeline pushes, uploads or publishes. A release is immutable
once tagged: the tag, the GitHub assets and the R2 prefix are never rewritten
(until the tag exists, re-running the staging replaces the staged dir). A
mistake is fixed by a new release; a change to the tools alone (same runtime,
same packs) is a re-cut `<id>-r2` (`--recut 2`).

## Consuming a release

```bash
npm install https://github.com/FawadHa1der/lean4/releases/download/<id>/lean4-wasm64-<version>.tgz
# a mirror: every release file, then the end-to-end check
npx lean4-wasm64 fetch --from https://github.com/FawadHa1der/lean4/releases/download/<id>/ \
  --id <id> --digest sha256:<digest> --out <mirror>
npx lean4-wasm64 verify --release <mirror> --deep
# a toolchain for Node: the runtime as an artifact dir plus its own library
npx lean4-wasm64 fetch --from … --id <id> --digest sha256:<digest> --out <tc> --only runtime,lean-lib
npx lean4-wasm64 unpack --manifest <tc>/profiles/lean-lib.manifest.json --out <tc>/lib/lean
```

`fetch` verifies everything it writes. The default `--only all` writes every
release file and `SHA256SUMS` — a release dir `verify` re-checks end to end,
fit to upload. `runtime` (the artifact layout `<out>/bin`) is never part of
`all`; ask for it, and keep such a dir apart from one you verify or upload.

An app pins `<id>` and its digest (or reads `release.json` and pins
`runtime.buildId`), serves `runtime/` and `profiles/` at its own origin root
(HOSTING.md: the browser never fetches another origin; `/profiles/index.json`
stays the site's own), bakes its snapshots against `runtime.buildId`, and
checks the pairing rules of `js/formats/README.md`. The R2 copy is reachable by
browsers only through an app's Worker, which maps `/runtime/*` and
`/profiles/*` (but not `hosting.siteOwned`) onto `lean4-wasm64/<id>/`.

## The first release

`lean-v4.34.0-a8817d0` was cut from bytes already on disk, without a rebuild:
the runtime is the gated `a8817d01f9` build (patch 0035b) that QED64 serves
(`wasm64-3ab1c6a9da03bc29`; staged with `--match-runtime` against QED64's served
manifest, so the release's runtime manifest and every chunk are byte-identical
to what QED64 serves, sourceRevision included). `lean-core` and `mathlib-essential` are the
bytes QED64 serves (`--packs-from`), written by the v4.34.0 import's compilers
(lean-core: wasm `8d91aadcda`; Mathlib: native `857544b439`); re-packing that
import with `js/packs.json` reproduces their raw packs byte for byte, and only
part 000 of each transport differs, in the gzip header's OS byte (QED64's Apple
zlib wrote `0x13`; `pack.mjs` pins `0x03`). `mathlib-game-extra` had never been
served (its only copy, in QED64's staging, had bare part URLs): it is re-cut
from the same tree with `/profiles/` URLs — the same raw pack. `lean-lib` is new:
the `a8817d01f9` build's own `lib/lean`. The four Lean files patch 0034 changed
are older in the browser packs' oleans than in the runtime; this is harmless and
recorded in the release notes.

## Retention

Releases are kept. A build directory can be reclaimed once its runtime is
either released or superseded and no app pins it; R2 objects of a release are
never garbage-collected while any app's pin names the release.
