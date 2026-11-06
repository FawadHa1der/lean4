# Lean 4 on WebAssembly Memory64 (wasm64)

This repository is a fork of [Lean 4](https://github.com/leanprover/lean4). Its
branch `qed64-wasm64` adds a **wasm64 toolchain**: the real Lean compiler and
language server, built for WebAssembly Memory64. With it, Lean 4 and Mathlib
run **inside a browser tab**, with no server checking the proofs, and from the
command line under **Node**.

- **Current release:** [`lean-v4.35.0-b081e7c`](https://github.com/FawadHa1der/lean4/releases/tag/lean-v4.35.0-b081e7c)
  (Lean 4.35.0, Mathlib v4.35.0).
- This is an independent fork, not a project of the Lean FRO or of
  `leanprover`. Please do not report problems with the wasm64 toolchain to
  `leanprover/lean4`.
- It started from cauli/lean4's `reinstate-wasm` branch (5732b84), the original
  Emscripten/Memory64 work. See
  [How this branch relates to upstream Lean](#how-this-branch-relates-to-upstream-lean).

Everything about Lean itself (the language, its documentation, native installs)
is upstream's. See [Lean 4 itself](#lean-4-itself) at the end.

## Contents

- [Try it in a browser](#try-it-in-a-browser): use Lean now, with nothing to install
- [What the toolchain is made of](#what-the-toolchain-is-made-of): the terms used below
- [Releases](#releases): what to download, and how to pin it
- [Run Lean under Node](#run-lean-under-node): check Lean files on the command line
- [Use it in your own web page](#use-it-in-your-own-web-page): put Lean and Mathlib in a site
- [Compile your own Lean library for it](#compile-your-own-lean-library-for-it): your own `.olean` files, for Node or a page
- [Build the toolchain from source](#build-the-toolchain-from-source): only to change the runtime itself
- [How this branch relates to upstream Lean](#how-this-branch-relates-to-upstream-lean)
- [Documentation](#documentation)
- [Lean 4 itself](#lean-4-itself)

## Try it in a browser

Two sites run on this toolchain. Nothing needs to be installed:

| Site | What it is |
|---|---|
| [QED64](https://qed64.fawadworkaddress.workers.dev/) | A Lean 4 + Mathlib editor (Monaco and the InfoView), in the spirit of [live.lean-lang.org](https://live.lean-lang.org), except that your proofs are checked in your tab. Source: [FawadHa1der/QED64](https://github.com/FawadHa1der/QED64). |
| [Lean 4 Game](https://lean4game.fawadworkaddress.workers.dev/) | The [lean4game](https://github.com/leanprover-community/lean4game) games, played fully in the tab. Source: [FawadHa1der/lean4game, branch `wasm64-port`](https://github.com/FawadHa1der/lean4game/tree/wasm64-port). |

What your browser and computer need:

- **Browser:** desktop **Chrome or Edge 133+**, or **Firefox 134+**: the
  versions that shipped WebAssembly Memory64, which the runtime needs along
  with `SharedArrayBuffer`. Safari has no Memory64, so Safari and every iOS
  browser are not supported. Lean 4 Game has so far been tested in Chrome and
  Edge only.
- **Memory:** about **2.5 GB of RAM** for a QED64 tab with Mathlib loaded. On
  an 8 GB machine, close other heavy tabs first.
- **Download:** QED64's first Mathlib visit downloads about **460 MB** (the
  runtime and two environment snapshots). A game downloads the 106 MB runtime
  plus 154 to 362 MB for its environment. Later visits load from browser
  storage: QED64 needs about 1.5 GB of it free, and each game 0.6 to 1.3 GB.
- **Limits:** a browser gives Lean far less stack than a native process, so a
  very deeply recursive proof can fail in a tab with a stack error even though
  native Lean accepts it
  ([EMBED-RUNTIME.md §6](wasm64-build/EMBED-RUNTIME.md#6-placement-and-engines)).

## What the toolchain is made of

| Term | Meaning |
|---|---|
| **runtime** | `lean.js` + `lean.wasm` (about 106 MB): Lean's compiler, elaborator and language server as one Memory64 binary. It is the `lean` program only; there is no `lake`. |
| **build id** | `wasm64-` plus the first 16 hex digits of the SHA-256 of `lean.wasm`, e.g. `wasm64-36d7f415704473d9`. It names one exact runtime. |
| **pack** | Compiled `.olean` files for the runtime, shipped as a manifest plus gzip parts. A release has four (see [Releases](#releases)). |
| **snapshot** (`.snapz`) | A memory image of a Lean environment after its imports, so a browser starts in seconds instead of importing thousands of modules. It works **only with the runtime that baked it** (same build id). Releases contain none: QED64 publishes its own, and other sites reuse QED64's or bake theirs. |
| **native64** | A native Linux (arm64) build of the same Lean commit. It writes the `.olean` files the runtime can read. |
| **tools** | The `lean4-wasm64` npm package: fetch and verify a release, run Lean under Node, unpack packs. Node 24 or newer, no dependencies. It is attached to each release and is not on the npm registry. |

## Releases

Each build of this branch that passes the release gate (the automated checks
described in [Build the toolchain from source](#build-the-toolchain-from-source))
and that apps should use is published as a
[GitHub release](https://github.com/FawadHa1der/lean4/releases) of this
repository. A release id is
`lean-<upstream Lean tag>-<first 7 hex digits of the kernel commit>`, with
`-rN` added for a re-cut (for example `lean-v4.34.0-e1a79c1-r3`). Use the
latest. For Lean 4.34.0, the newest is `lean-v4.34.0-53cb11e`.

```
lean-v4.35.0-b081e7c   sha256:5450ccc080ec02cb659a11ef750d4771c155c4d21b62b831df766c1a953c69c7
```

The second value is the release's **digest**, which is also in its release
notes. Always pin a release by its id **and** digest. Every downloaded byte is
checked against the release record, and a file that does not match is refused.
The pin makes sure that the record itself is the published one: without it,
the tools accept any record that is consistent with itself.

What `lean-v4.35.0-b081e7c` contains (2.87 GB in all; sizes are downloads):

| Part | Download | What it is for |
|---|---|---|
| runtime | 106 MB | everything: browser and Node |
| `lean-lib` pack | 588 MB | Node: Init, Std, Lean and Lake (2,546 modules, 2.1 GB unpacked) |
| `lean-core` pack | 120 MB | Init only (653 modules); combined with `mathlib-essential` |
| `mathlib-essential` pack | 1.03 GB | 4,438 modules: 2,432 from Mathlib v4.35.0, plus Std, Lean and Mathlib's other dependencies (3.6 GB unpacked) |
| `mathlib-game-extra` pack | 199 MB | 721 more modules (716 from Mathlib) that the games need, including `Mathlib.Tactic` |
| `native64.tar.gz` | 825 MB | only for compiling your own library (Linux arm64) |
| `lean4-wasm64-4.35.0-b081e7c.tgz` | 165 KB | the tools |
| `release.json`, `SHA256SUMS`, module lists | small | the record, every file's digest, the packs' module lists |

**Mathlib is a subset.** The packs hold the 4,438 modules in
[`essential-modules.txt`](https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/essential-modules.txt)
plus the 721 in
[`extra-modules.txt`](https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/extra-modules.txt),
not all of Mathlib. There is no `Mathlib` umbrella module in them.

**Install each release's own tools.** Older tools refuse a release record that
has fields they do not know, rather than misread it. When you move to a new
release, install its tools first.

## Run Lean under Node

This checks Lean files on the command line, with the wasm64 runtime running in
Node. You need **Node 24 or newer**. You do not need elan or a native Lean.
Plan for about **6 GB of free RAM** while unpacking (8 GB for Mathlib), and
about 3 GB of disk (about 5 GB with Mathlib).

### 1. Install the tools

```bash
mkdir lean-wasm && cd lean-wasm && npm init -y
npm install https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/lean4-wasm64-4.35.0-b081e7c.tgz
npx lean4-wasm64 --version     # 4.35.0-b081e7c
```

Run every later `npx lean4-wasm64` command in this directory, so that `npx`
finds the installed package. The name is not reserved on the npm registry.

### 2. Fetch the runtime and Lean's library (about 0.7 GB)

```bash
npx lean4-wasm64 fetch \
  --from https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/ \
  --id lean-v4.35.0-b081e7c \
  --digest sha256:5450ccc080ec02cb659a11ef750d4771c155c4d21b62b831df766c1a953c69c7 \
  --out toolchain --only runtime,lean-lib
npx lean4-wasm64 unpack --manifest toolchain/profiles/lean-lib.manifest.json --out toolchain/lib/lean
```

`toolchain/bin` now holds `lean.js` and `lean.wasm`, and `toolchain/lib/lean`
holds the Init, Std, Lean and Lake libraries. The unpack needs about 5.5 GB of
free RAM.

### 3. Check a file

```bash
printf 'theorem t : 2 + 2 = 4 := rfl\n#print axioms t\n' > t.lean
npx lean4-wasm64 run --artifact toolchain --work . -- /work/t.lean
# 't' does not depend on any axioms
# The process does not exit by itself: press Ctrl-C once the output stops.
```

Things to know:

- **Name your file `/work/<file>`.** `--work .` mounts the current directory
  at `/work`. A relative path such as `t.lean` is not found.
- **Lean's messages go to stdout**: errors such as
  `/work/t.lean:1:0: error: ...` (or `error(<name>): ...`), warnings, and the
  output of `#eval`, `#check` and `#print`. Stderr carries the
  `[DEBUG:PROGRESS] Loading N modules...` progress lines, and also the error
  for a file that is not found.
- A file that produces no messages prints nothing.
- **There is no exit code.** A script should read stdout and stderr, treat any
  `error` message as a failure, and stop the process itself.

### 4. Use Mathlib (about 1.15 GB more)

`mathlib-essential` has no `Init`, so unpack it together with `lean-core` into
one directory, and pass that directory with `--lib`:

```bash
npx lean4-wasm64 fetch \
  --from https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/ \
  --id lean-v4.35.0-b081e7c \
  --digest sha256:5450ccc080ec02cb659a11ef750d4771c155c4d21b62b831df766c1a953c69c7 \
  --out toolchain --only lean-core,mathlib-essential
npx lean4-wasm64 unpack --slim --manifest toolchain/profiles/lean-core.manifest.json --out mathlib-lib
npx lean4-wasm64 unpack --slim --manifest toolchain/profiles/mathlib-essential.manifest.json --out mathlib-lib

cat > m.lean <<'EOF'
import Mathlib.Data.Nat.Basic
theorem my_add_zero (n : ℕ) : n + 0 = n := by simp
#check Nat.succ_le_iff
EOF
npx lean4-wasm64 run --artifact toolchain --lib mathlib-lib --work . -- /work/m.lean
# Nat.succ_le_iff {m n : ℕ} : m.succ ≤ n ↔ m < n
```

- **Unpacking `mathlib-essential` needs about 8 GB of free RAM** (about 9 GB
  without `--slim`), because the whole pack is inflated in memory. The
  resulting tree is 1.5 GB. `--slim` leaves out the `*.olean.private` files,
  which the commands in this README do not need.
- **`--lib` replaces Lean's library completely**, so the directory must hold
  everything from Init to Mathlib. Without `--lib`, a Mathlib import fails with
  `unknown module prefix 'Mathlib'`. If you only use Mathlib, step 2 can fetch
  `--only runtime` and skip `lean-lib`.
- **Import specific modules.** `import Mathlib` fails, because the packs have
  no umbrella module (see [Releases](#releases)). `import Mathlib.Tactic`
  fails too: it is in `mathlib-game-extra`. Either fetch that pack as well
  (`--only mathlib-game-extra`, 199 MB) and unpack it with `--slim` into
  `mathlib-lib`, or import the tactics you use, such as `Mathlib.Tactic.Ring`.
  For the reals, import `Mathlib.Basic.Real.Basic`: in Mathlib v4.35.0,
  `Mathlib.Data.Real.Basic` is deprecated and only warns.
- `run` does not read the downloaded parts in `toolchain/profiles` (1.6 GB).
  You can delete them once the unpacks are done; fetch again to re-unpack.

On an Apple M4 Max, a file importing `Mathlib.Data.Nat.Basic` took about
2.5 s, and running files used 1.3 to 2.4 GB of memory.

## Use it in your own web page

A web page runs the runtime in a Worker and loads **environment snapshots**,
not packs. Four rules apply whichever route you take:

1. **Serve everything from your own origin**, over HTTPS (or `localhost`), with
   the runtime at `/runtime/` under the origin root. Files from another origin
   are blocked, so you cannot point the page at GitHub. QED64's page starts
   only in a same-origin iframe, so you cannot frame the live QED64 site from
   another site.
2. **Make the page cross-origin isolated.** Send
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` with the page, and
   `Cross-Origin-Resource-Policy: same-origin` with every response. Without
   them there is no shared Memory64. In the browser console,
   `crossOriginIsolated` must be `true`.
3. **Serve the runtime's parts and the snapshots exactly as they are:** no
   `Content-Encoding` (no gzip or brotli from the server or CDN), and a `404`
   rather than an HTML fallback for a missing file. Every part is checked
   against its SHA-256 as served.
4. **Snapshots must match the runtime.** A snapshot works only with the
   runtime build that baked it. Rebake every snapshot whenever you change the
   runtime.

### Route 1 (recommended): QED64

[QED64](https://github.com/FawadHa1der/QED64) is the reference consumer of this
toolchain, and the easiest way to put Lean in a page. You pin it to a commit
(it is not on the npm registry either). It can be used in three ways:

- **QED64's page in a same-origin iframe**, driven by a small page API. You
  build the page from a QED64 checkout at that commit.
- **`qed64/embed` in your own page**, installed as a git dependency: the
  runtime and language server behind an LSP connection that your own editor
  uses. lean4game is built this way.
- **`qed64/edge`**, also from the git dependency: a ready-made Cloudflare
  Worker that serves the files with the right headers.

QED64's [README](https://github.com/FawadHa1der/QED64#use-qed64) and
[`docs/EMBEDDING.md`](https://github.com/FawadHa1der/QED64/blob/main/docs/EMBEDDING.md)
explain each one, with a tested recipe. QED64 also fetches the runtime and its
published snapshots for you. There, `import Mathlib` and `import Mathlib.Tactic`
work: both mean the curated 4,438-module set, which lacks a few tactics such
as `cases'` and `induction'`.

### Route 2: host the runtime yourself

1. **Fetch the runtime in the served layout**, from the directory where you
   installed the tools ([Run Lean under Node](#run-lean-under-node), step 1).
   Use `runtime-chunks`; `runtime` is the Node layout.

   ```bash
   npx lean4-wasm64 fetch \
     --from https://github.com/FawadHa1der/lean4/releases/download/lean-v4.35.0-b081e7c/ \
     --id lean-v4.35.0-b081e7c \
     --digest sha256:5450ccc080ec02cb659a11ef750d4771c155c4d21b62b831df766c1a953c69c7 \
     --out site --only runtime-chunks
   ```

   This writes `site/release.json` and `site/runtime/`: the runtime manifest
   (`runtime-manifest.json`, plus a copy named by the build id) and, under
   `chunks/`, `lean.js` and `lean.wasm` in 16 MiB chunks. Serve `site/runtime/`
   at `/runtime/` on your origin.
2. **Serve it with the right headers.**
   [`HOSTING.md`](wasm64-build/js/formats/HOSTING.md) has every rule, notes on
   hosts, and a 20-line Python server for local testing. GitHub Pages cannot
   send the headers. Cloudflare Pages caps files at 25 MiB, which fits the
   runtime's chunks but not a snapshot of up to about 365 MB.
   `python3 -m http.server` does not work, because it sends no isolation
   headers.
3. **Add snapshots.** Bake them with QED64's
   `pipeline/snapshot/bake-snapshot.mjs` (flags and outputs: QED64's
   [`docs/CLI-CONTRACT.md`](https://github.com/FawadHa1der/QED64/blob/main/docs/CLI-CONTRACT.md#bake-snapshot)),
   and serve them under `/snapshots/`.
4. **Start the runtime in a Worker.** This repository ships no browser code.
   Reuse QED64's workers, or write your own against
   [`EMBED-RUNTIME.md`](wasm64-build/EMBED-RUNTIME.md), the runtime's
   embedding contract (boot, shared memory, snapshots, the resident language
   server).

## Compile your own Lean library for it

The runtime reads only `.olean` files written by this toolchain. **Files from a
stock Lean, from elan or from `lake exe cache get` are refused** with
`incompatible header`, because official Lean builds use GMP for big numbers and
this toolchain does not. So compile your library yourself, against the packs.

**A small library: use the runtime itself, under Node.** QED64 builds its own
umbrella module this way:

```bash
npx lean4-wasm64 run --artifact toolchain --work mylib -- \
  --root=/work -o /work/MyLib.olean -i /work/MyLib.ilean /work/MyLib.lean
```

- `--root=/work` names the module `MyLib`, not `work.MyLib`.
- Lean prints nothing when the compile succeeds. Once `mylib/MyLib.olean` has
  appeared (a few seconds), stop the process. If Lean prints an error, no
  `.olean` is written.
- To compile against Mathlib, put `--lib mathlib-lib` before the `--`. The
  `--slim` tree from [step 4](#4-use-mathlib-about-115-gb-more) is enough.
- To import the module, copy every file Lean wrote for it into your library
  tree (`toolchain/lib/lean`, or the directory you pass with `--lib`):
  `MyLib.olean`, and for a file that starts with `module`, also
  `MyLib.olean.server`, `MyLib.olean.private`, `MyLib.ir` and `MyLib.ir.sig`.
  Without the `.ir` files, `#eval` of the module's definitions fails.

**A larger library: use `native64`**, the native compiler in the release.

- It is a Linux arm64 program that needs glibc 2.38 or newer, libstdc++
  (GCC 13) and libuv. Run it in a `linux/arm64` container such as
  `ubuntu:24.04` with `libuv1t64` installed (lean4game's
  [`wasm/docker/Dockerfile`](https://github.com/FawadHa1der/lean4game/blob/wasm64-port/wasm/docker/Dockerfile)).
- That runs natively on Apple silicon and arm64 Linux. An x86-64 machine
  emulates arm64, several times more slowly. Under Docker Engine on Linux,
  first run `docker run --privileged --rm tonistiigi/binfmt --install arm64`.
- Compile with plain `lean -o`, one module at a time with dependencies first,
  against the packs unpacked without `--slim`. Lake is not used: the packs are
  a plain tree of `.olean` files, not a Lake workspace.
- [lean4game's `compile-pkg.py`](https://github.com/FawadHa1der/lean4game/blob/wasm64-port/wasm/scripts/compile-pkg.py)
  is a short driver that compiles a package in dependency order. Set `LEAN` to
  native64's `lean`, and `LEAN_PATH` to your output directory plus the pack
  tree.

Put your `.olean` files into the same tree as the packs. Lean looks a module up
only in the first `LEAN_PATH` entry that has its top-level directory
(`Mathlib/`, `MyLib/`, …), so modules in a second tree under the same name are
never found.

For a web page, then bake a snapshot of that tree with QED64's
`bake-snapshot.mjs` ([Route 2](#route-2-host-the-runtime-yourself), step 3).

## Build the toolchain from source

Most people never need to: a release already has the gated runtime, the packs
and the tools. Build only to change the runtime itself.

**Requirements**

- **Docker**, running: Docker Desktop, or rootless Docker on Linux. Under
  rootful Docker the build tree ends up owned by root, and `build.sh` stops at
  step 4b, after the long library compile (`chown` the build tree to yourself
  to continue).
- **At least 10 GB of memory for the Docker VM**, with no other build in it.
  With less, the final link is killed silently (exit 137).
- **Disk:** about 6 GB of build directory for a runtime build. The clone and
  the Docker image come on top: GitHub reports the repository at about
  6.5 GiB, and the emsdk image is about 3 GB. A full upstream import, with
  `native64` and Mathlib, takes about 16 GB of build directory; budget 40 GB.
- `git`, `bash`, `python3`, `nm` (Apple's works; on Linux, `llvm-nm`), and
  Node 24 or newer.
- Network on the first run (the `emscripten/emsdk:6.0.5` image, system
  packages, libuv).
- **Time:** 1.5 to 3 hours from cold on a 14-core Apple M-series machine; 10 to
  25 minutes with a warm ccache. The gate takes about 35 minutes.

**Build and gate**

```bash
git clone --branch qed64-wasm64 https://github.com/FawadHa1der/lean4.git wasm64-lean-kernel
cd wasm64-lean-kernel
wasm64-build/build.sh                                                  # builds into ../wasm64-lean-kernel-build
wasm64-build/import-release.sh gate-dir ../wasm64-lean-kernel-build    # the release gate; writes GATE-PASSED
```

- Build from a **clean, committed** tree. `build.sh` records `BUILT-COMMIT`
  only then, and the gate refuses a build without it. For an experiment on
  uncommitted changes, run the gate directly:
  `node --stack-size=8192 wasm64-build/js/gate.mjs --artifact ../wasm64-lean-kernel-build/build/stage1`.
- To build elsewhere, set `QED64_BUILD_DIR` to an absolute path, and pass the
  same directory to `gate-dir`.
- The runtime is `build/stage1/bin/lean.{js,wasm}`, with its library in
  `build/stage1/lib/lean`. Try it with the in-tree tools, which need no
  install:

  ```bash
  mkdir -p ../try && printf 'theorem t : 2 + 2 = 4 := rfl\n#print axioms t\n' > ../try/t.lean
  node wasm64-build/js/cli.mjs run --artifact ../wasm64-lean-kernel-build/build/stage1 --work ../try -- /work/t.lean
  # 't' does not depend on any axioms   (then Ctrl-C: the process does not exit)
  ```
- Treat your build as a **new runtime**. Its build id differs from a
  release's unless its `lean.wasm` is byte-identical (a normal clone also
  embeds its commit hash, which the v4.35.0 release build does not), and
  snapshots baked for another build id will not load on it.

[`wasm64-build/README.md`](wasm64-build/README.md) has the build details.
[`RELEASE-PIPELINE.md`](wasm64-build/RELEASE-PIPELINE.md) covers importing a
new upstream Lean release, including `native64.sh` and `mathlib-tree.sh`.
Anyone can stage a release locally ([`RELEASE.md`](wasm64-build/RELEASE.md));
only the repository owner publishes one. Upstream's
`doc/make/emscripten.md` is an older, unrelated recipe and does not apply.

## How this branch relates to upstream Lean

`qed64-wasm64` is upstream Lean plus a series of wasm64 patches. The series is
the branch's own git history, and
[`wasm64-build/PATCHES.md`](wasm64-build/PATCHES.md) documents every patch in
it.

Upstream stable releases are **merged** into the branch, never rebased, so
published commits stay valid. v4.34.0 and v4.35.0 were merged this way
(v4.34.1 was not imported). The same branch serves QED64 and lean4game: what
differs between them is switched at run time, never by a separate fork.

**Why GitHub shows the branch hundreds of commits "behind".** GitHub compares
it with upstream `master`. Upstream cuts its stable releases on
`releases/vX.Y.0` branches, not on `master`, so `master` holds newer
development work that no release has yet. Compared with the `v4.35.0` tag, the
branch is 0 commits behind:

```bash
git fetch https://github.com/leanprover/lean4 tag v4.35.0
git rev-list --left-right --count v4.35.0...qed64-wasm64    # 0  <commits ahead>
```

## Documentation

| Document | What it covers |
|---|---|
| [`wasm64-build/README.md`](wasm64-build/README.md) | the build, the gate, the outputs |
| [`wasm64-build/js/README.md`](wasm64-build/js/README.md) | the `lean4-wasm64` tools as of this commit. The published 4.35.0-b081e7c package also has `bake` and `snapshot-probe`, and the README inside it is older. `npx lean4-wasm64 <command> --help` is exact for the version you installed. |
| [`wasm64-build/EMBED-RUNTIME.md`](wasm64-build/EMBED-RUNTIME.md) | how a page or Worker embeds the runtime |
| [`wasm64-build/js/formats/HOSTING.md`](wasm64-build/js/formats/HOSTING.md) | serving release files to a browser |
| [`wasm64-build/js/formats/README.md`](wasm64-build/js/formats/README.md) | the formats: release records, build ids, which pack and snapshot fit which runtime |
| [`wasm64-build/RELEASE.md`](wasm64-build/RELEASE.md) | what a release contains, and how it is cut and kept |
| [`wasm64-build/RELEASE-PIPELINE.md`](wasm64-build/RELEASE-PIPELINE.md) | importing a new upstream Lean release |
| [`wasm64-build/PATCHES.md`](wasm64-build/PATCHES.md) | every wasm64 patch |
| [QED64 `docs/EMBEDDING.md`](https://github.com/FawadHa1der/QED64/blob/main/docs/EMBEDDING.md) | embedding Lean in a page with QED64 |

## Lean 4 itself

The toolchain runs the same Lean, v4.35.0, so upstream's documentation
applies:

- [Homepage](https://lean-lang.org)
- [Theorem Proving in Lean 4](https://lean-lang.org/theorem_proving_in_lean4/)
- [Functional Programming in Lean](https://lean-lang.org/functional_programming_in_lean/)
- [Documentation Overview](https://lean-lang.org/learn/)
- [Language Reference](https://lean-lang.org/doc/reference/latest/)
- [Examples](https://lean-lang.org/examples/)
- [Release notes](https://lean-lang.org/doc/reference/latest/releases/), in the Language Reference

**Installing native Lean:** see [Install Lean](https://lean-lang.org/install/)
(elan). The wasm64 toolchain is not installed through elan.

**Building native Lean from source:** see [Building Lean](doc/make/index.md).

**Contributing to Lean itself:** changes to Lean belong upstream, at
[leanprover/lean4](https://github.com/leanprover/lean4). Read its
[Contribution Guidelines](CONTRIBUTING.md) first.

**License:** Apache 2.0 ([LICENSE](LICENSE)).
