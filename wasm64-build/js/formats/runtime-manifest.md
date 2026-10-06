# `org.lean-browser64.runtime/v1` — the runtime manifest

Describes one runtime build (`lean.js` + `lean.wasm`) as it is served: whole-file
digests and the 16 MiB chunks each file is cut into. Written by
`chunk-runtime.mjs`; read by browser workers before they fetch a byte of the
runtime, and by `verify-release` / `fetch`.

```json
{
  "schema": "org.lean-browser64.runtime/v1",
  "buildId": "wasm64-3ab1c6a9da03bc29",
  "leanVersion": "4.34.0",
  "sourceRevision": "qed64-wasm64@a8817d01f9 (upstream v4.34.0, …)",
  "target": "wasm64-unknown-emscripten",
  "pointerBits": 64,
  "memory": { "initialBytes": 134217728, "maximumBytes": 17179869184, "shared": true },
  "files": {
    "lean.js":   { "bytes": 48972033,  "sha256": "<64 hex>", "chunks": [ { "url": "/runtime/chunks/lean.js.<sha256[0:20]>.part-000", "bytes": 16777216, "sha256": "<64 hex>" }, … ] },
    "lean.wasm": { "bytes": 109875453, "sha256": "<64 hex>", "chunks": [ … ] }
  }
}
```

## Rules

- Keys appear in the order above; the file is `JSON.stringify(manifest, null, 2)`
  with no trailing newline. (Readers parse it; the byte form matters because
  the manifest is itself a release file with a digest, and because a site's
  per-build manifest name must keep one content — see "Two copies".)
- `buildId === "wasm64-" + files["lean.wasm"].sha256.slice(0, 16)` (the
  runtime/v1 invariant, formats/README.md rule 3). A reader refuses a manifest
  that breaks it.
- Every `sha256` is 64 lowercase hex digits.
- `files` has exactly `lean.js` and `lean.wasm`. For each, the chunks in order
  concatenate to the file: their `bytes` sum to `bytes`, and the
  concatenation's SHA-256 is `sha256`.
- Chunk names are `<file>.<first 20 hex of the chunk's sha256>.part-<NNN>` —
  content-addressed, so `immutable` caching and additive uploads are sound.
  All chunks but the last are exactly 16,777,216 bytes.
- Chunk `url`s are site-absolute (`/runtime/chunks/…`): the runtime is mounted at
  the origin root (HOSTING.md).
- `leanVersion` is the Lean that reads the oleans this runtime mounts; a pack is
  paired with the runtime by it (formats/README.md, pairing rules).
- `sourceRevision` is free text naming the kernel commit and anything notable
  about the build. Nothing pairs on it; it is compared only as part of the
  manifest's bytes (`stage-release.sh --match-runtime`).
- `memory` records what the binary was linked for; a host that supplies its own
  `wasmMemory` must make it `shared`, `address: "i64"`, at least `initialBytes`
  initially and at most `maximumBytes` at most (in 64 KiB pages: 2048 and
  262144; EMBED-RUNTIME.md).

## Two copies

The manifest is written twice, byte-identical: `runtime-manifest.json` (the
mutable pointer a site serves) and `runtime-manifest.<buildId>.json` (pinned by
build id, so a shell built for one runtime keeps booting it while the pointer
moves). Both are served `must-revalidate`: the build id covers `lean.wasm` only,
so a relink that changes only `lean.js` keeps the per-build name.

## Producing one

```bash
lean4-wasm64 chunk --bin <build>/build/stage1/bin --out <release>/runtime \
  --lean-version 4.34.0 --revision 'qed64-wasm64@a8817d01f9 (upstream v4.34.0, …)'
```

The chunks depend only on the binary; the manifest also on the
`--revision` text. Re-chunking the same `bin/` with the **same** sourceRevision
string reproduces a served manifest byte for byte — `stage-release.sh
--match-runtime <served manifest>` takes the string from it and refuses to stage
anything else, so a release never splits one per-build manifest name into two
contents.
