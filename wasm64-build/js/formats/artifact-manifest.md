# `browser64.artifact-manifest` v1 — library packs

A pack is an olean tree (every `.olean`, `.olean.server`, `.olean.private`,
`.ir`, `.ir.sig`) concatenated into one raw file, shipped as a gzip stream cut
into 16 MiB parts, and mounted in the browser as a read-only WORKERFS
directory whose files are byte ranges of the raw pack. Written by `pack.mjs`
(the release's packs: `pack-set.mjs` from `packs.json`); read by browser
workers, `unpack.mjs`, `inspect.mjs`, `verify-release`.

## The manifest

```json
{
  "format": "browser64.artifact-manifest",
  "version": 1,
  "digest": "sha256:<sha256 of JSON.stringify(content)>",
  "content": {
    "release": "lean-core-4.34.0-wasm64-36a96239e08fd2e0",
    "lean": { "version": "4.34.0", "target": "wasm64-unknown-emscripten", "gitRevision": "8d91aadcda8a" },
    "pack": {
      "url": "/profiles/lean-core.pack.gzip",
      "digest": "sha256:<raw pack>", "byteLength": 390065102,
      "indexOffset": 389469832, "indexLength": 595270,
      "transport": {
        "encoding": "gzip",
        "digest": "sha256:<whole gzip stream>", "byteLength": 119947064,
        "parts": [ { "url": "/profiles/lean-core.pack.gzip.<sha256[0:20]>.part-000", "digest": "sha256:<64 hex>", "byteLength": 16777216 }, … ]
      }
    },
    "modules": {
      "Init.Prelude": {
        "imports": [],
        "artifacts": {
          "olean": { "digest": "sha256:<64 hex>", "byteLength": 3397608, "encoding": "identity", "filename": "Init/Prelude.olean" },
          "olean.server": { … }, "olean.private": { … }, "ir": { … }, "ir.sig": { … }
        }
      }, …
    },
    "roots": ["Init"],
    "workerfs": {
      "mountPoint": "/lib/lean/library",
      "metadata": { "files": [ { "filename": "/Init/Prelude.olean", "start": 6040, "end": 11928 }, … ] }
    }
  }
}
```

- `digest` = `"sha256:" + sha256(JSON.stringify(content))` — the manifest's own
  identity.
- `content.lean.version` is the pairing key: it must equal the runtime
  manifest's `leanVersion`. `gitRevision` is provenance (free text).
- `modules[M].imports` are `M`'s direct imports, read from its `.olean`. A pack
  without `Init` omits the implicit `Init` edge (explicit `Init.X` imports
  stay).
- `workerfs.metadata.files` maps every packed file to `[start, end)` in the raw
  pack; WORKERFS mounts them at `mountPoint` without copying.
- `roots` are the modules the pack was cut for (may be empty).

## The raw pack

| Offset | Content |
|---|---|
| 0 | 80-byte header: ASCII `qed64-pack/v1\0`, then zeros |
| 80 … | each artifact's bytes, every artifact starting at a multiple of 8 (zero padding between) |
| `indexOffset` | JSON `{"format":"qed64-pack-index/v1","entries":[{path, facet, start, byteLength, digest}, …]}`, `indexLength` bytes, to the end |

The format identifiers `qed64-pack/v1`, `qed64-pack-index/v1` and
`browser64.artifact-manifest` are wire names and never change with the project's
name.

## Identity and transport

The **raw pack is the pack's identity**: `pack.digest` and `byteLength`, plus
every artifact's digest. It is fully deterministic — re-packing the same tree
with the same flags reproduces it byte for byte (verified for all three v4.34.0
packs).

The **transport** (the gzip stream and its parts) is verifiable but not
reproducible across machines: deflate output depends on the zlib build and CPU
features. `pack.mjs` pins the one host-dependent header byte (gzip OS, byte 9)
to `0x03`; Apple's zlib writes `0x13`, which is what the v4.34.0 packs served
by QED64 carry in part 000. A consumer that re-packs gets the same raw pack and
possibly different part names; that is a new transport of the same pack.

Parts are content-addressed (`<id>.pack.gzip.<sha256[0:20]>.part-NNN`), all but
the last exactly 16,777,216 bytes, served **without** `Content-Encoding` (the
browser inflates the stream itself; HOSTING.md). Part `url`s are either
site-absolute (`/profiles/…`, `--url-prefix /profiles/`: what a browser loader
fetching URLs verbatim needs, and the only form a release accepts) or bare names
that the tools resolve beside the manifest (a pack used only locally).
