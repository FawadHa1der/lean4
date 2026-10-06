# `lean4-wasm64.release/v1` — release.json

One record per release, at the root of the release (`release.json`), committed
to the toolchain repository as `wasm64-build/releases/<id>.json` before the tag
is placed on that commit — the pinned tree contains its own digest root.

## Canonical form

- Keys in this order: `schema`, `id`, `lean`, `kernel`, `gate`, `runtime`,
  `packs`, `native64`, `docker`, `mathlib`, `modules`, `hosting`, `tools`,
  `notes`, `files`, `digest`. Unknown keys are invalid.
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
| `lean.version` | string | the Lean version; equals the runtime manifest's `leanVersion` | runtime manifest |
| `lean.upstreamTag` | string | the `leanprover/lean4` tag merged into the line | the import |
| `kernel.repo`, `kernel.branch` | string | `https://github.com/FawadHa1der/lean4`, `qed64-wasm64` | — |
| `kernel.commit` | 40 hex | the commit the runtime was built from (= its embedded githash) | `BUILT-COMMIT` of the runtime build |
| `kernel.patch` | patch id | the patch id of `kernel.commit` (rule 4: the last PATCHES.md heading whose commit it contains) | `wasm64-build/PATCHES.md` at the release commit |
| `gate.passed` | true | the release gate passed on the released binary | `GATE-PASSED` |
| `gate.commit`, `gate.wasmSha256` | 40 hex, 64 hex | what the gate ran: must equal `kernel.commit` and `lean.wasm`'s sha256 | `GATE-PASSED` |
| `gate.checks` | number or null | how many gate lines passed | `gate.log` |
| `runtime.buildId` | build id | rule 2 | runtime manifest |
| `runtime.manifest` | path | `runtime/runtime-manifest.json` | — |
| `runtime.target`, `runtime.sourceRevision` | string | copied from the runtime manifest | runtime manifest |
| `runtime.files` | object | `{"lean.js"|"lean.wasm": {bytes, sha256, chunks}}` (chunks = count) | runtime manifest |
| `runtime.bin[]` | array | the other files of the build's `bin/` (`leanmake`, …): `{name, path, bytes, sha256}`; `fetch --only runtime` installs them beside lean.js / lean.wasm | the runtime build |
| `packs[]` | array | one entry per library pack, below | pack manifests |
| `native64.commit` | 40 hex | the commit the native compiler was built from | `native/NATIVE-COMMIT` |
| `native64.os`, `.arch` | string | `linux`, `aarch64` — runs in the toolchain image | — |
| `native64.tar` | path | `native64/native64.tar.gz`: `bin/`, `include/`, `share/` and all of `lib/lean` (shared libraries, the native static archives, every olean/ilean/ir facet, Lake traces); GNU tar with sorted names, one mtime (the native commit's), numeric root ownership, `gzip -n -9`. `lean` and `lake` run as they are; the shipped `leanc` defaults to emcc (the line's wasm compiler), so a native link needs `LEAN_CC=gcc` | `native/stage1` |
| `docker.tag`, `.recipeCommit`, `.imageId`, `.base` | string | the toolchain image: tag, last commit to touch `docker-wasm64/`, the local image id it was built as, the pinned base image digest. Identity check = rebuild from `recipeCommit` and compare | `docker images`, `git log -- docker-wasm64` |
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
| `lean.compiler` | 40 hex: the commit whose compiler wrote these oleans (recorded per pack, never compared) |
| `lean.gitRevision` | the manifest's `content.lean.gitRevision` (free text) |
| `mathlib` | optional `{commit, tag}` for Mathlib packs |
| `note` | optional remark (e.g. a transport copied from served bytes rather than re-packed) |

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
  "id": "optional; must equal lean-<upstreamTag>-<kernel7>[-rN]", "recut": "optional N"
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
`fetch` runs before writing anything and `verify` runs first.
