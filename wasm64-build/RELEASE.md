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
| Where | GitHub Release `<id>` on `FawadHa1der/lean4` (flat; a release by reference holds only its own files, `release.json` and `SHA256SUMS`, its other files being its base's assets), and R2 `qed64-artifacts/lean4-wasm64/<id>/` (served layout, always complete) |
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
environment, baked by the app with `lean4-wasm64 bake` against a release's
runtime (`js/formats/snapshot-index.md`).

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
# by reference of the release whose packs, native64 and lists it keeps (below)
QED64_BUILD_DIR=<K'> wasm64-build/build.sh && wasm64-build/import-release.sh gate-dir <K'>
wasm64-build/import-release.sh release v4.34.0 --runtime <K'> --base <mirror of that release> --note …
```

Options: `--packs-from <dir>` copies packs a site already serves (their
transport bytes stay valid in every cache) instead of re-packing them;
`--match-runtime <manifest>` makes staging stop unless the release's runtime
manifest is byte-identical to one a site serves (so nothing baked against it
unpairs); `--note <text>` adds a release note; `--recut <n>` a tools re-cut:
**by reference** with `--base <mirror of the base>` (below), or by value with
`--match-runtime` (only when staging it by reference is refused, e.g. a
`hosting` change); `--base <mirror>` with `--runtime <build dir>` a runtime
release by reference (below). Relative paths are the caller's.

### Cutting a release by reference

A release by reference (js/formats/release.md, "Release by reference") names a
first cut of its tag as its `base` and shares that release's files, except the
ones it owns: a **tools re-cut** `<base>-r<n>` (decision 8) owns `tools/`; a
**runtime release by reference** `lean-<tag>-<kernel7>` owns `runtime/`, its
`lean-lib` pack and `tools/`. The recipe is the same for both:

1. Commit the tools with package version `<v>-<k7>-r<n>` (a tools re-cut) or
   `<v>-<k7>` (a runtime release by reference; `<k7>` is its own kernel
   commit). That commit is `tools.commit`; `stage-release.sh` and
   `publish-release.mjs` run from the working tree.
2. Have a mirror of the base, the first cut `<base>`: its own staged dir, or
   `lean4-wasm64 fetch --from …/download/<base>/ --id <base> --digest <d> --out
   <mirror>`. Its `release.json` must be the record at the base's tag.
3. `wasm64-build/import-release.sh release <tag> --base <mirror> (--recut <n> |
   --runtime <build dir>) --note "<what this release changes>"` (the base's
   notes are appended).

Both clone every file of the base outside `tools/` from the mirror
(copy-on-write where the file system has it, each clone hashed against the
base's record), write the record with `base`, run `verify-release --deep
--base` with the tools the release ships, and refuse unless the record keeps
the equality rules and `SHA256SUMS` differs from the base's only at
`release.json` and the files the release owns. Neither needs the import build
dir or a Docker image, and both run offline. Cut either from the line, or a
tools re-cut from a branch off the base's record commit, as before. Beside the
release dir they leave `<id>.config.json`, `<id>.verify.json` and
`<id>.tools/` (the tarball, extracted).

A **tools re-cut** then packs the tools and gates them on the base's runtime and
`lean-lib` as cloned into the release dir (the hashed clones, not the mirror's
files); its record differs from the base's only in `id`, `base`,
`gate.checks`, `tools`, `notes` and `tools/`. It needs no build dir and no
`GATE-PASSED`, and also leaves `<id>.gate/`, `<id>.gate.log` and what its
printed manual fallback reads: the R2 lists `<id>.r2-objects.txt` /
`<id>.r2-manifests.txt` and `<id>.release-notes.md` (the GitHub release body
`publish` writes).

A **runtime release by reference** releases a new runtime of the same tag — a
kernel-only fix — without its import build dir: the base's import-built packs
(`lean-core`, `mathlib-essential`, `mathlib-game-extra`), `native64` and lists
stay valid when none of the stdlib's sources changed, and are shared. It needs
the runtime's own gated build dir (`GATE-PASSED` for its `BUILT-COMMIT` and
`lean.wasm`, as a release by value; staging does not gate again, and
`gate.checks` counts that build's `gate.log`). Over the clones it chunks that
build's runtime into `runtime/` and packs its own `lib/lean` as `lean-lib`
(`pack-set.mjs --only lean-lib`, which reads nothing outside the build dir and
leaves `<id>.pack-set.json`), then packs the tools. Its record keeps the base's
`docker` (the toolchain image's recipe is checked to be the same) and every
other shared field (E2); `kernel.commit` and `.patch`, `gate`, `runtime` (but
its `target`), the `lean-lib` entry, `tools` and `notes` are its own. The
pairing guards (below) refuse the known ways in which the shared packs would
stop pairing with the new runtime; they are not a proof (a compile flag that
changes the object layout passes them), and QED64's Mathlib bake against the
shared packs remains the end-to-end check.

Staging by reference refuses, besides what any staging refuses (below):

- a base that is not a first cut of the tag or names a base of its own, a
  mirror whose record is not the tag's, or a HEAD that does not descend from
  the base's record commit;
- a mirror that holds a dir staging replaces, or a clone whose bytes are not
  the base's;
- any drift from the base's record, and a `SHA256SUMS` difference outside
  `release.json` and the files the release owns;
- a tools re-cut: a failing gate (exit 31);
- a runtime release by reference: `--recut` with `--runtime`; a build dir
  without a matching `GATE-PASSED` (exit 31); a build of the base's own kernel
  commit (that is a tools re-cut); and the pairing guards, which `publish` runs
  again on the record:
  - a kernel commit that does not descend from the base's;
  - a `docker-wasm64/` recipe at that commit other than the base's
    `docker.recipeCommit`;
  - any change since the base's kernel to the olean format's C++
    (`src/include/lean/lean.h`, `src/runtime/object.h`,
    `src/runtime/compact.{h,cpp}`, `src/library/module.cpp`);
  - staging only: any change to the stdlib's sources (`src/Init`, `src/Std`,
    `src/Lean`, `src/lake`, `stage0`) unless `--stdlib-drift <note>` says why
    it is harmless (the note is recorded; given with no change, it is refused).

The recipe, olean-format and ancestry guards have no override: their fallback
is a full import (RELEASE-PIPELINE.md). `--packs-from`, `--match-runtime` and
`--revision` are by-value options and refused with `--base`.

A re-cut by value (the fallback; every file uploaded again): `--runtime` the
base's build dir, `--match-runtime <base>/runtime/runtime-manifest.json`,
`--packs-from <base>/profiles`; pre-seed `<id>/native64/native64.tar.gz` and
`<id>.native64.stamp` from the base when the stamp still matches; pass the
base's notes again plus one for the re-cut. Then `SHA256SUMS` must differ from
the base's only in `tools/` (and `release.json`).

`stage-release.sh` refuses to stage a runtime without a passing gate for that
commit and that `lean.wasm`, a commit that is not on `qed64-wasm64` or carries
another upstream tag, a dirty `wasm64-build/js`, a package version that does
not name the release, or an already tagged id; by reference also what the
section above lists. It writes `../wasm64-lean-kernel-release/<id>/` and,
beside it, the release config (`<id>.config.json`) and the verification report
(`<id>.verify.json`); a release by value also writes the packs' provenance
(`<id>.pack-set.json`), a runtime release by reference that of its `lean-lib`,
and a tools re-cut none (its packs are the base's); each leaves the files listed
above. A release by value runs `verify-release --deep` last; a release by
reference runs it, then the `SHA256SUMS` check against the base's (a tools
re-cut writes its fallback's files only once both pass). On a failure it removes
`release.json` and `SHA256SUMS`, so nothing half-checked looks cut. It then
prints the commands below, with the record's digest (a tools re-cut also its
manual fallback; a runtime release by reference only the publish command).

```bash
# 3 + 4. record, tag and publish — the repository owner, one command (publish-release.mjs)
wasm64-build/import-release.sh publish <id> --dry-run    # read every state, print what it would do
wasm64-build/import-release.sh publish <id>              # asks before the push and before going public
```

`publish` does, each step only if it is not done yet (so a re-run resumes):
commit `wasm64-build/releases/<id>.json` on the line and tag that commit; push
the tag and the line up to it (an atomic fast-forward; a re-cut recorded on a
branch off its base pushes its tag alone); create ONE GitHub release for the tag as a
draft (or reuse the existing one; two releases for a tag is a stop, with the
command that removes the stray empty draft), upload every file flat by basename
(skipping assets whose SHA-256 already matches; an interrupted, byte-less
upload is replaced on any release, an asset whose bytes differ only on a draft,
never on a published release), verify every
asset's SHA-256, and only then publish; copy to R2 in the served order
(objects, then manifests + `SHA256SUMS`, then `release.json` — js/formats/HOSTING.md)
and verify names, sizes, content types and every object's SHA-256; finally a
consumer's anonymous `fetch --id --digest` of the GitHub release and
`verify --deep`, run with the tools the release ships. Before any step,
whatever `--only` is and under `--dry-run` too, it verifies the staged dir,
then unpacks the staged tools tgz: it must be `tools.package@tools.version`,
and its own `verify` must pass the staged dir (with `--base` for a release by
reference), so no release is published that its own tools cannot read; the
fetch step runs that unpacked reader. `--only record,push,github,r2,fetch`
runs a subset, `--r2-quick` checks R2 by listing only (names, sizes, content
types: no hashing at all), `--fetch-check auto|full|runtime|none` sets the
last step, `--yes` skips the two questions.

For a release by reference, `publish` first — in preflight, before any push,
and whatever `--only` is — reads the base's record at its tag, checks that the
base's GitHub release is published and holds every shared asset (size and
digest), and that the base's R2 prefix holds every shared object with the right
bytes (MD5 against the staged clones) and the base's `release.json`; for a
runtime release by reference it also runs the pairing guards again, on the
record (so a record `release.mjs --base` wrote from a hand-made config gets
them too). It then
uploads only its own assets (a tools re-cut: 3; a runtime release by reference:
its runtime, its `lean-lib` parts and manifest, its tgz, `release.json` and
`SHA256SUMS`). R2 is a server-side copy of the shared paths from
`lean4-wasm64/<base>/` (objects, then manifests), then its own files from the
staged dir (objects, then manifests, by lists `publish` derives from the
record), `SHA256SUMS`, and `release.json` last; it is verified by listing, the
own files' SHA-256 (a download: a few hundred MB for a runtime release) and an
MD5 check of every shared object against the staged clones (objects R2 holds
no MD5 for are download-hashed; `--r2-full` hashes everything). `--r2-quick`
skips both the own files' SHA-256 and that MD5 check of the copied objects:
preflight's check of the base's prefix does not replace it, since it checks
the source of the copy, not what the copy wrote. The fetch check is
`runtime,lists,tools` — the lists are always the base's, so it exercises the
hop to the base's release — run with the staged tgz's own `cli.mjs`
(`--fetch-check full` for everything). `--r2-source local` uploads the shared
files from the staged dir instead of copying them (the fallback if the base
prefix is incomplete or R2's copy misbehaves); `publish <base> --only r2` also
fills a base prefix that lacks objects. For a tools re-cut `stage-release.sh`
also prints the manual counterparts, as a fallback without publish's checks
(no resume, no SHA-256 or R2 verification); a runtime release by reference is
published by `publish` only.

Only `publish` pushes, uploads or publishes, and only the repository owner runs it. A release is immutable
once tagged: the tag, the GitHub assets and the R2 prefix are never rewritten
(until the tag exists, re-running the staging replaces the staged dir). A
mistake is fixed by a new release; a change to the tools alone (same runtime,
same packs) is a tools re-cut `<id>-r<n>` (`--recut <n> --base <mirror>`), and a
new runtime of the same tag a runtime release by reference (`--runtime <build
dir> --base <mirror>`).

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
fit to upload (fetch into a fresh `--out`: a base's tgz left in `tools/` is a
file the release does not list).

A release by reference fetched from its GitHub release takes its own files from
there and every other file from its base's release (the sibling
`…/download/<base>/`, or `--base-from`), after checking the base's record
against its own; its R2 copy is complete. A fetch of its own files alone needs
no base (`--only tools`; for a runtime release by reference also `--only
runtime` or `runtime-chunks,lean-lib,tools`). Install the release's own tools
first: its tgz is always one of its own assets; tools up to 4.34.0-e1a79c1-r2
refuse a record with `base`, and the 4.34.0-e1a79c1-r3 tools a runtime release
by reference (they fail closed). `runtime` (the artifact layout `<out>/bin`) is
never part of `all`; ask for it, and keep such a dir apart from one you verify
or upload.

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
never garbage-collected while any app's pin names the release. A first cut's
tag, GitHub assets and R2 prefix are kept while any release by reference names
it (its by-reference fetches read the assets, and `publish` copies from the
prefix); a release by reference's own R2 prefix is a full copy, independent of
the base's once published.

Reclaiming the build dir of a runtime released by reference has one cost.
Re-releasing that same build with new tools (a tools-only fix) would be an
`-r<N>` runtime release by reference of the same base, since a release by
reference never names another one as its base. The record rules refuse that
today, so it is not supported yet. Once the dir is gone, such a fix can only be
a new runtime: a rebuild, with a new build id that apps re-pair against.
Keeping the dir (several GB) for this is optional.
