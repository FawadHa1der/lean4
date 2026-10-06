# lean4-wasm64 formats

The specification of what a lean4-wasm64 toolchain release contains and how its
pieces identify and pair with each other. `artifact-id.mjs` implements the rules
below; `verify-release.mjs` checks every one of them on a release directory.

| Document | Format id | Written by | Read by |
|---|---|---|---|
| [release.md](release.md) | `lean4-wasm64.release/v1` | `release.mjs` | `fetch-release.mjs`, `verify-release.mjs`, every consumer that pins a release |
| [runtime-manifest.md](runtime-manifest.md) | `org.lean-browser64.runtime/v1` | `chunk-runtime.mjs` | browser workers, `verify-release.mjs`, `fetch-release.mjs` |
| [artifact-manifest.md](artifact-manifest.md) | `browser64.artifact-manifest` v1 | `pack.mjs` | browser workers (WORKERFS mounts), `unpack.mjs`, `inspect.mjs`, `verify-release.mjs` |
| [HOSTING.md](HOSTING.md) | — | — | anyone serving release bytes to a browser |

The runtime's embedding ABI (exports, boot sequence, environment, the stdin
ring) is [`../../EMBED-RUNTIME.md`](../../EMBED-RUNTIME.md); the release process
(who cuts, who publishes, retention) is [`../../RELEASE.md`](../../RELEASE.md).

## Identity rules

1. **sha256.** Every digest is SHA-256. In the runtime manifest and in
   `release.json` `files[]` it is written as exactly 64 lowercase hex digits;
   in artifact manifests as `sha256:` + 64 lowercase hex digits. Anything else
   (uppercase, short, prefixed where it should not be) is invalid, not
   "normalized".
2. **Runtime build id.** `wasm64-` + the first 16 hex digits of
   `sha256(lean.wasm)`. Example: `wasm64-3ab1c6a9da03bc29`.
3. **The runtime/v1 invariant.** In every `org.lean-browser64.runtime/v1`
   manifest, `buildId === "wasm64-" + files["lean.wasm"].sha256.slice(0, 16)`.
   A reader that has verified `lean.wasm` against `files["lean.wasm"].sha256`
   can therefore check the build id with a string comparison, without hashing
   again — and must refuse a manifest that fails it (QED64's worker:
   `RUNTIME_MANIFEST_MISMATCH`).
4. **Patch id.** The toolchain's patch level is `NNNN` plus an optional
   lowercase letter (`0034`, `0035`, `0035b`). Order: by the number, then by the
   suffix (`"" < "a" < "b" < …`), so `0034 < 0035 < 0035b < 0036`. Every patch
   entry of `wasm64-build/PATCHES.md` names the commit that completed it:
   `## 0035b — title (a8817d01f9)`. The patch id of a kernel commit C is the
   last such heading whose commit is C or an ancestor of C (`patchIdOf` in
   `artifact-id.mjs`), with PATCHES.md read at the release commit: an entry is
   often written after its code, so PATCHES.md *at C itself* can lack C's own
   entry (a8817d01f9 is 0035b; its own PATCHES.md ends at 0035). A heading that
   names no single commit is an error, never skipped. `release.json` records it as
   `kernel.patch`; a consumer with a floor (`minKernelPatch`) compares with
   `comparePatchIds`.
5. **Release id.** `lean-<upstream tag>-<first 7 hex digits of the kernel
   commit>`, e.g. `lean-v4.34.0-a8817d0`; a tools-only re-cut of the same
   runtime and packs appends `-r2`, `-r3`, …

## Pairing rules (what must match, and what is only recorded)

| Pair | Rule | Why |
|---|---|---|
| snapshot ↔ runtime | snapshot index entry `runtime` === runtime manifest `buildId` | a snapshot is a memory image of one binary's function table |
| pack ↔ runtime | pack manifest `content.lean.version` === runtime manifest `leanVersion` | an olean is readable only by the Lean version that wrote it (the githash check is compiled off; the manifests are the trust root) |
| release ↔ runtime | `release.json` `runtime.buildId` === manifest `buildId`; `gate.wasmSha256` === `files["lean.wasm"].sha256` | the gate must have run on exactly the released binary |

Recorded, never compared: the kernel commit (`kernel.commit`), the commit whose
compiler wrote each pack (`packs[].lean.compiler`), the Mathlib commit, the
Docker image. They are provenance; two builds of the same source are expected to
differ in some of them.

## Layout

A release directory and the R2 prefix `lean4-wasm64/<release id>/` use the
**served layout** (paths as in `release.json` `files[]`):

```
release.json  SHA256SUMS
runtime/      runtime-manifest.json  runtime-manifest.<buildId>.json  chunks/<file>.<sha256[0:20]>.part-NNN  bin/<extras>
profiles/     <pack id>.manifest.json  <pack id>.pack.gzip.<sha256[0:20]>.part-NNN
native64/     native64.tar.gz
lists/        essential-modules.txt  extra-modules.txt  …
tools/        lean4-wasm64-<version>.tgz
```

Every path is safe segments under one of those five directories (no `..`,
dotfiles or escapes; `isReleasePath`). `bin/` and `lib/` are never release
paths — they are the artifact layout `fetch --only runtime` and `unpack`
produce — and `verify` refuses any file a release does not list, so keep that
layout out of a release dir you mean to verify or upload.

The GitHub Release carries the same files **flat**, by basename (every basename
in a release is unique; `release.mjs` refuses otherwise). Chunk and part URLs
inside the manifests are site-absolute — `/runtime/chunks/<name>` and
`/profiles/<name>`, nothing else: a site serves the release by mapping
`/runtime/*` and `/profiles/*` — except its own `/profiles/index.json` — onto
the release prefix under its own origin (HOSTING.md; `release.json`
`hosting.siteOwned`).

## Pinning a release

A record's self-digest proves only that it is consistent — anyone serving a
release.json can recompute it. A consumer pins **id and digest** (`fetch --id
<id> --digest sha256:<hex>`; the tag message and the GitHub release notes carry
the digest), and everything else follows from the record: each file's sha256,
the runtime's build id, each pack's raw digest.
