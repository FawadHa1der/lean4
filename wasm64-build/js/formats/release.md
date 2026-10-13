# `lean4-wasm64.release/v1` — release.json

One record per release, at the root of the release (`release.json`), committed
to the toolchain repository as `wasm64-build/releases/<id>.json` before the tag
is placed on that commit — the pinned tree contains its own digest root.

## Canonical form

- Keys in this order: `schema`, `id`, `base`, `lean`, `kernel`, `gate`,
  `runtime`, `packs`, `native64`, `docker`, `mathlib`, `modules`, `hosting`,
  `tools`, `notes`, `files`, `digest`. `base` is optional: only a release by
  reference has it (below); a record without it has the same order and digest
  as before `base` existed. Unknown keys are invalid.
- The file is `JSON.stringify(record, null, 2)` followed by one newline.
- `digest` = `"sha256:" + sha256(JSON.stringify(record without digest, null, 2))`.
  A reader recomputes it from the parsed object (`JSON.parse` keeps key order).
- `SHA256SUMS` (sha256sum format, sorted by path) lists every file of
  `files[]` plus `release.json` itself.

## Fields

| Field | Type | Meaning | Source when cut |
|---|---|---|---|
| `schema` | string | `"lean4-wasm64.release/v1"` | — |
| `id` | string | release id (formats/README.md rule 5) | upstream tag + kernel commit |
| `base` | object, optional | a release by reference only: `{id, digest}`, the first cut whose files it shares and that release's `release.json` digest (section "Release by reference") | the cutter (`stage-release.sh --base`) |
| `lean.version` | string | the Lean version; equals the runtime manifest's `leanVersion` | runtime manifest |
| `lean.upstreamTag` | string | the `leanprover/lean4` tag merged into the line | the import |
| `kernel.repo`, `kernel.branch` | string | `https://github.com/FawadHa1der/lean4`, `qed64-wasm64` | — |
| `kernel.commit` | 40 hex | the commit the runtime was built from (= its embedded githash) | `BUILT-COMMIT` of the runtime build |
| `kernel.patch` | patch id | the patch id of `kernel.commit` (rule 4: the last PATCHES.md heading whose commit it contains) | `wasm64-build/PATCHES.md` at the release commit |
| `gate.passed` | true | the release gate passed on the released binary | `GATE-PASSED` |
| `gate.commit`, `gate.wasmSha256` | 40 hex, 64 hex | what the gate ran: must equal `kernel.commit` and `lean.wasm`'s sha256. A release by value and a runtime release by reference: the build dir's gate (`GATE-PASSED` binds `kernel.commit` and `lean.wasm`); the staged chunks and `lean-lib` are not gated again. A tools re-cut: the base's | `GATE-PASSED` |
| `gate.checks` | number or null | how many gate lines passed: the build dir's `gate.log` (a release by value, a runtime release by reference); a tools re-cut's own gate, run with its new tools on the shipped runtime and `lean-lib` | `gate.log` |
| `runtime.buildId` | build id | rule 2 | runtime manifest |
| `runtime.manifest` | path | `runtime/runtime-manifest.json` | — |
| `runtime.target`, `runtime.sourceRevision` | string | copied from the runtime manifest | runtime manifest |
| `runtime.files` | object | `{"lean.js"|"lean.wasm": {bytes, sha256, chunks}}` (chunks = count) | runtime manifest |
| `runtime.bin[]` | array | the other files of the build's `bin/` (`leanmake`, …): `{name, path, bytes, sha256}`; `fetch --only runtime` installs them beside lean.js / lean.wasm | the runtime build |
| `packs[]` | array | one entry per library pack, below | pack manifests |
| `native64.commit` | 40 hex | the commit the native compiler was built from | `native/NATIVE-COMMIT` |
| `native64.os`, `.arch` | string | `linux`, `aarch64` — runs in the toolchain image | — |
| `native64.tar` | path | `native64/native64.tar.gz`: `bin/`, `include/`, `share/` and all of `lib/lean` (shared libraries, the native static archives, every olean/ilean/ir facet, Lake traces); GNU tar with sorted names, one mtime (the native commit's), numeric root ownership, `gzip -n -9`. `lean` and `lake` run as they are; the shipped `leanc` defaults to emcc (the line's wasm compiler), so a native link needs `LEAN_CC=gcc` | `native/stage1` |
| `docker.tag`, `.recipeCommit`, `.imageId`, `.base` | string | the toolchain image: tag, last commit to touch `docker-wasm64/`, the local image id it was built as, the pinned base image digest. Identity check = rebuild from `recipeCommit` and compare. A runtime release by reference keeps its base's: staging checks that `recipeCommit` is the recipe at `kernel.commit`; `imageId` is the image the base was built as (the runtime was built from the same recipe, not necessarily as that image) | `docker images`, `git log -- docker-wasm64` |
| `mathlib.commit`, `.tag` | string | the Mathlib the Mathlib packs were built from | `mathlib/MATHLIB-COMMIT` |
| `modules` | object | paths of the module lists (`essential`, `extra`, …) | `mathlib/*-modules.txt` |
| `hosting` | object or null | how the bytes are meant to be served: `layout`, `mount` (site path prefix → release path), `siteOwned` (site paths under those prefixes that are never the release's: `/profiles/index.json`, `/snapshots/`), `crossOriginIsolation`, `contentEncoding`, `spec` (HOSTING.md) | — |
| `tools.package`, `.version`, `.tgz`, `.commit` | string | the `lean4-wasm64` npm package of this release, its tarball path, and the commit it was packed from | `npm pack` of `wasm64-build/js` at a clean tree |
| `notes[]` | strings | honest provenance remarks (e.g. packs written by an earlier commit than the runtime) | the cutter |
| `files[]` | array | every file of the release except `release.json` and `SHA256SUMS`: `{path, bytes, sha256}`, sorted by path | the release directory |
| `digest` | `sha256:` + hex | the self-digest above | — |

### `packs[]` entries

| Field | Meaning |
|---|---|
| `id` | `lean-core`, `mathlib-essential`, `mathlib-game-extra`, `lean-lib` (`js/packs.json`) |
| `manifest` | `profiles/<id>.manifest.json` |
| `release` | the manifest's `content.release` string |
| `modules` | number of modules in the manifest |
| `rawBytes`, `rawSha256` | the raw pack's length and digest (the pack's identity; transport parts are verifiable but host-dependent bytes) |
| `roots` | the manifest's `content.roots` |
| `lean.version` | the manifest's `content.lean.version`; must equal the runtime's `leanVersion` |
| `lean.compiler` | 40 hex: the commit whose compiler wrote these oleans (recorded per pack, never compared, except a runtime release by reference's `lean-lib`: rule S6) |
| `lean.gitRevision` | the manifest's `content.lean.gitRevision` (free text) |
| `mathlib` | optional `{commit, tag}` for Mathlib packs |
| `note` | optional remark (e.g. a transport copied from served bytes rather than re-packed) |

## Release by reference

A release may be cut **by reference**. Its record names a first cut of the
same upstream tag in `base` and shares that release's files, except the ones it
owns. The record stays complete: `files[]` lists every file of the release, the
base's included, so `--id <id> --digest <digest>` pins every byte. There are two
kinds, told apart by `id` and `base.id` alone (`byReferenceKind`; no field
records it):

| Kind | `id` and `base.id` | Owns | Keeps from the base | Must differ |
|---|---|---|---|---|
| Tools re-cut | `<first>-r<N>`, base `<first>` (the same kernel commit) | `tools/` | the tools projection of E2 | `tools.version` |
| Runtime release by reference | `lean-<tag>-<kernel7>`, base a first cut of the tag with another kernel commit | `runtime/`, `profiles/lean-lib.*`, `tools/` | the runtime projection of E2 | `tools.version`, `runtime.buildId` |

What it owns are its own files (`isOwnPath`): its own GitHub assets. Every other
file is the base's. A tools re-cut ships new tools for the base's runtime; a
runtime release by reference ships a new runtime of a later kernel commit with
its own `lean-lib` (that build's `lib/lean`), and keeps the base's
import-built packs (`lean-core`, `mathlib-essential`, `mathlib-game-extra`),
`native64` and lists. Its id is a first cut's, `lean-<tag>-<kernel7>`, never
`-r<N>`: every reader takes `-r<N>` to mean "the first cut's runtime, other
tools", and rule 5 binds the id's kernel to `kernel.commit`. "By reference" is
how a release is hosted and staged, which `base` records; it is not part of
its identity.

### Structure (`checkReleaseRecord`; needs no other record)

When `base` is present:

- **S1** `base` is an object with exactly the keys `id` and `digest`.
- **S2** `base.id` is a first cut of the id's own upstream tag,
  `lean-<tag>-<kernel7>` (never a re-cut). That the base names no base of its
  own is E1, which reads the base's record.
- **S3** A runtime release by reference (any `base.id` other than the id's first
  cut) has a first cut's id, never `-r<N>` (an `-r<N>` release by reference is
  a tools re-cut of its first cut), and its `base.id` is not its own id.
- **S4** `base.digest` is `sha256:` + 64 lowercase hex digits.
- **S5** `tools` is present; `tools.tgz` is
  `tools/<tools.package>-<tools.version>.tgz`; `tools.version` is
  `<lean.version>-<kernel7>[-r<N>]`, as the id; and the only file of `files[]`
  under `tools/` is `tools.tgz`.
- **S6** In a runtime release by reference, the `lean-lib` entry of `packs[]`
  (when there is one) is its own build's `lib/lean`: `lean.compiler` is
  `kernel.commit`, `lean.gitRevision` is its first 12 hex digits, and `release`
  is `lean-lib-<lean.version>-<runtime.buildId>`. That `release` is the only
  binding from `lean-lib` to the runtime.

### Equality with the base (`checkRecutBase(record, base)`; needs the base's `release.json`)

- **E1** The base's `release.json` passes every rule of this document. Its `id`
  is `base.id` and its `digest` is `base.digest`. It names no base of its own.
- **E2** These fields equal the base's, compared key by key as
  `JSON.stringify` text (key order included):
  - a tools re-cut: `schema`, `lean`, `kernel`, `runtime`, `packs`, `native64`, `docker`, `mathlib`, `modules`, `hosting`, `gate.passed`, `gate.commit`, `gate.wasmSha256`.
  - a runtime release by reference: `schema`, `lean`, `native64`, `docker`, `mathlib`, `modules`, `hosting`, `kernel.repo`, `kernel.branch`, `runtime.target`, `packs` (its `lean-lib` entry by `id` only).

  So `packs` covers which packs exist, their order and every shared entry. A
  field that differs is named alone: `<field> differs from the base's`.
- **E3** `tools.package` is the base's; `tools.version` is not. A runtime
  release by reference's `runtime.buildId` is not the base's either.
- **E4** `files[]` outside what the release owns is exactly the base's
  `files[]` outside it: the same paths, and for each path the same `bytes` and
  `sha256`. No path is missing and none is extra.

What a release by reference may change, then — and a change to anything else
needs a full release by value (RELEASE-PIPELINE.md):

- in a tools re-cut: `id`, `base`, `gate.checks`, `tools.version`, `tools.tgz`, `tools.commit`, `notes`, its `tools/` entry of `files[]`, and `digest`.
- in a runtime release by reference: `id`, `base`, `kernel.commit`, `kernel.patch`, `gate`, `runtime.buildId`, `runtime.sourceRevision`, `runtime.files`, `runtime.bin`, `packs[lean-lib]`, `tools.version`, `tools.tgz`, `tools.commit`, `notes`, its own entries of `files[]`, and `digest`.

The rules above bind each of those to the rest: `gate` to `kernel.commit` and
`lean.wasm`, `runtime.buildId` to `lean.wasm`, the `lean-lib` entry to the
kernel and build id (S6), and `tools.version` to the id (S5).

**Notes.** By convention `notes` lists the release's own notes first, then
the base's notes verbatim. A runtime release by reference's staging inserts a
separator between them, which says that what the base's notes say of its packs,
native64 and lists holds for this release, and what they say of its runtime and
`lean-lib` is the base's.

### Where the bytes are

| Copy | Holds |
|---|---|
| GitHub Release `<id>` (the release by reference) | flat: only its own files, `release.json` and `SHA256SUMS` |
| GitHub Release `<base.id>` | flat: every other file of the release (they are the base's own assets) |
| R2 `lean4-wasm64/<id>/` | served, complete: the shared files copied server-side from `lean4-wasm64/<base.id>/`, then its own files (HOSTING.md) |
| a mirror (`fetch --only all`) | served, complete |

`SHA256SUMS` keeps its definition: every file of `files[]`, plus
`release.json`. A release by reference's `SHA256SUMS` therefore names files
that are assets of the base's GitHub Release, not of its own.

### Reading a release by reference

- `fetch` from a **flat** source (a GitHub release download URL, a flat dir):
  `release.json` and its own files come from `--from` (routed by `isOwnPath`);
  every other file comes from the base. The base is at `--base-from <url|dir>`,
  or else at the sibling `<parent of --from>/<base.id>/` when the last path
  segment of `--from` is the release's `id` (a directory sibling's layout is
  inferred from the sibling itself). Before writing anything, fetch reads the
  base's `release.json` there and refuses (exit 1) unless the equality rules
  hold; each file is then verified against the release's `files[]`. Files are
  routed by path, never by falling back after a miss. A fetch that selects only
  its own files needs no base: `--only tools` of a tools re-cut; `--only
  runtime`, or `--only runtime-chunks,lean-lib,tools`, of a runtime release by
  reference.
- `fetch` from a **served** source (an R2 prefix, a mirror dir) reads every
  file from `--from`: that copy is complete under the release's own id.
  `--base-from` adds the equality check.
- `verify --release <dir>` checks a complete dir as it checks any release;
  `--base <dir|release.json>` adds the equality check. Without `--base`, one
  `info` line says that the base was not compared.
- `release.mjs` writes `base` only from `config.base`; it then needs
  `--base <the base's dir or release.json>` and refuses unless the structure
  and equality rules hold.

### Older readers

A reader written before `base` existed (lean4-wasm64 up to and including
4.34.0-e1a79c1-r2) refuses the unknown key (`unknown keys: base`) before it
reads any other file, so it fails closed. The reader of 4.34.0-e1a79c1-r3 knows
only the tools re-cut: it refuses a runtime release by reference with
`base: only a re-cut (lean-<tag>-<kernel7>-rN) names a base, "<id>" is not
one`. A consumer installs the release's own tools first (its tgz is one of the
release's own GitHub assets, `…/download/<id>/<basename of tools.tgz>`), then
reads the record with them.

## Release config (input to `release.mjs`)

What cannot be derived from the release directory is passed as a JSON file:

```json
{
  "upstreamTag": "v4.34.0", "kernelCommit": "<40 hex>", "kernelPatch": "0035b",
  "gate": { "commit": "<40 hex>", "wasmSha256": "<64 hex>", "checks": 13 },
  "packs": [ { "id": "lean-core", "compiler": "<40 hex>" }, … ],
  "native64": { "commit": "<40 hex>", "os": "linux", "arch": "aarch64", "tar": "native64/native64.tar.gz" },
  "docker": { "tag": "…", "recipeCommit": "…", "imageId": "sha256:…", "base": "…@sha256:…" },
  "mathlib": { "commit": "<40 hex>", "tag": "v4.34.0" },
  "modules": { "essential": "lists/essential-modules.txt", "extra": "lists/extra-modules.txt" },
  "tools": { "package": "lean4-wasm64", "version": "…", "tgz": "tools/lean4-wasm64-….tgz" },
  "hosting": { … }, "notes": [ … ],
  "id": "optional; must equal lean-<upstreamTag>-<kernel7>[-rN]", "recut": "optional N",
  "base": "optional { id, digest }: a release by reference — with recut: a tools re-cut; without: a runtime release by reference (its own kernelCommit); release.mjs then needs --base",
  "leanVersion": "4.34.0"
}
```

`release.mjs` refuses (writes nothing) when: the runtime manifest is not
runtime/v1 or breaks the build-id invariant; the per-build manifest copy is
missing or differs; the gate did not run on this commit and this `lean.wasm`;
a pack's Lean version differs from the runtime's; a compiler commit is missing;
the id does not name the tag and kernel commit; a listed asset is missing; two
files share a basename; `lean.js` / `lean.wasm` are staged as files instead of
chunks; a chunk URL is not `/runtime/chunks/<name>` or a part URL not
`/profiles/<name>`; a pack manifest's own digest, gzip encoding or part
lengths are wrong; a chunk or a `profiles/` file is named by no manifest (a
stale part); a file is a dotfile, has an unsafe name or is not a regular file
(a symlink is never uploaded); `runtime/bin` holds `lean.js`, `lean.wasm` or a
`package.json` (in any letter case); or the finished record
fails `checkReleaseRecord` (release-record.mjs) — the same structural check
`fetch` runs before writing anything and `verify` runs first; or, for a release
by reference: a `config.base` without `--base`, a `--base` without
`config.base`, a `--base` record that is not `config.base` (id and digest), or
a finished record that breaks the equality rules with it (`checkRecutBase`).
