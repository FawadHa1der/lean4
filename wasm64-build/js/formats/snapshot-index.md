# `qed64.snapshot-index/v1` — the snapshot index

A snapshot is a memory image of one Lean environment: the runtime saves it
(`--incr-header-save`, the compactor) after importing a probe file's header,
and a worker loads it with `lean_wasm_load_snapshot(_mem)` in seconds instead
of importing the modules for minutes (EMBED-RUNTIME.md). It is paired with one
runtime binary, because its closures point into that binary's function table.
The index lists a site's snapshots: what each serves, where its bytes are and
which runtime baked it. Written by `lean4-wasm64 bake` (`bake-snapshot.mjs`,
through `snapshot-index.mjs`; types `snapshot-index.d.mts`); read by browser
shells (QED64's `loadSnapshotIndex`, lean4game's game boot) and by sites'
deploy tools. Snapshots and their index are a site's product, never part of a
toolchain release (RELEASE.md).

```json
{
  "schema": "qed64.snapshot-index/v1",
  "snapshots": [
    {
      "name": "init",
      "url": "/snapshots/init.fcbe485fbee5ea21.snapz",
      "digest": "sha256:fcbe485fbee5ea21486e04445b727317fb207c44ab8bb226cdbf4da855ecc47c",
      "bytes": 122364117,
      "transfer": 32643649,
      "imports": [],
      "runtime": "wasm64-f69cca24d0878a58"
    },
    {
      "name": "mathlib",
      "url": "/snapshots/mathlib.6ca0fa64efdf4705.snapz",
      "digest": "sha256:6ca0fa64efdf4705f908c024dba32fa9c284d0cc21482640645cf07622c058d3",
      "bytes": 1127272685,
      "transfer": 321485011,
      "imports": [
        "QED64.Essential"
      ],
      "runtime": "wasm64-f69cca24d0878a58"
    }
  ]
}
```

(QED64's served index for runtime `wasm64-f69cca24d0878a58`, lean-v4.34.0-e1a79c1.)

## Rules

- `schema` is exactly `qed64.snapshot-index/v1`. It is a wire name, like
  `qed64-pack/v1` and `qed64-pack-index/v1` (artifact-manifest.md): it never
  changes with the project's name, because every deployed reader tests it
  literally and treats any other string as a corrupt index.
- The file is `JSON.stringify(index, null, 2)` with no trailing newline. A
  writer keeps any other top-level key in place; it rewrites only `snapshots`.
- `snapshots` is in upsert order: an upsert removes every entry of the new
  entry's name and appends the new one, so a rebake moves its entry to the end.
- **The core keys**, in this order, in every entry:

  | Key | Value |
  |---|---|
  | `name` | the snapshot's name, `^[A-Za-z0-9][A-Za-z0-9._-]*$`, unique in the index |
  | `url` | where its `.snapz` is served: `/snapshots/<file>` (below) |
  | `digest` | `sha256:` + 64 lowercase hex: the SHA-256 of the served `.snapz` bytes |
  | `bytes` | the size of the raw `.snap`: what a loader allocates |
  | `transfer` | the size of the `.snapz`: what a reader expects to download |
  | `imports` | the modules of the header the environment was baked for (below) |
  | `runtime` | the build id (`wasm64-` + 16 hex, formats/README.md rule 2) of the `lean.wasm` that baked it |

- **QED64's page fields** (docs/EMBEDDING.md §8 there; their meaning is
  QED64's), after the core keys, in this order, each only when the bake was
  given it:

  | Key | Value | Bake flag |
  |---|---|---|
  | `roots` | a non-empty array of module roots, each `^[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*$`: the modules the environment serves, on a component boundary | `--roots A,B` |
  | `label` | the entry's human name | `--label <text>` |
  | `initialBytes` | a positive whole number: the initial Memory64 commit when the entry is loaded | `--initial-bytes <n>` |

  They are written only through those validating flags: QED64's reader refuses
  the whole index for one malformed entry.
- **Reserved keys:** `raw`, `lib` and `bakedBy` belong to this package (`raw`
  is meant for the `.snap`'s digest). No other writer uses them, and a reader
  ignores them until this document defines them.
- **Extra keys:** any other key is an extra field, preserved verbatim, its
  meaning the reader's. `lean4-wasm64 bake --entry-fields '<json object>'`
  writes them after the page fields, in the object's order; it refuses a value
  that is not a JSON object, any core key, `roots`, `label`, `initialBytes`
  and the reserved keys.

## `imports` and the environment cache

The runtime never reads `imports`. A load keys its environment cache by the
loaded snapshot's own header (`Shell.lean`, `wasmLoadSnapshot`), through
`qed64HeaderKey` (`src/Lean/Language/Lean.lean`): the header's modules with
`Init` first and duplicates dropped (`qed64NormalizeKey`). The index entry
states the same key from the page's side, so the rule is

    qed64NormalizeKey(entry.imports) == qed64HeaderKey(header of the snapshot's environment)

`imports` lists the header's modules in source order without the implicit
`Init`; `[]` is the environment of a file with no header (`#[Init]`).

The bake reads it from its probe's header with Lean's own lexical rules
(`src/Lean/Parser/Module/Syntax.lean` `header`; `src/Lean/Parser/Basic.lean`
`whitespace`, `finishCommentBlock`, `identFnAux`; `src/Init/Meta/Defs.lean`):

- **Grammar:** optional `module`, optional `prelude`, then the imports, each
  optional `public`, optional `meta`, `import`, optional `all`, the module.
  `import all M` records `M`; there is no `private import`. A keyword is one
  only when the identifier there is exactly it (`all.Foo` is a module). A
  first line `#lang lean4` is dropped first, as Lean's shell drops it.
- **Between tokens:** spaces and newlines (CRLF reads as a newline), `--`
  comments to the end of the line, and `/- … -/` comments, which nest (the
  character after the opening `/-` is never read as part of a delimiter).
- **Where it ends:** at the first token that is none of these — a command, a
  doc comment (`/--`, `/-!`), `private`, any other character (a byte-order
  mark or a no-break space included). An `import` after it is not one of the
  header's.
- **Spelling:** each module's parts (identifier characters as `identFnAux`
  reads them: letters, `_`, digits, `'`, `!`, `?`, letter-like Unicode,
  subscripts; or a `«…»` escape) joined by `.`, a part escaped with `«»` only
  when it is not a plain identifier part: `Name.toString`'s spelling of an
  ordinary name (`import Foo.«Bar»` records `Foo.Bar`).
- **Refused, not guessed at:** a header Lean rejects saves no snapshot, so the
  bake refuses it up front (exit 2, before any side effect), naming the
  problem and its line:column (1-based, columns in code points): a tab or a
  lone carriage return in the header's whitespace — or in the trailing
  whitespace of the first token Lean reads for `module` and `prelude`, even
  when that token begins a command — an unterminated comment or `«`, an
  `import` without a module, a module that is a header keyword or ends in a
  lone `.`, `public`, `meta` or `import all` without `module`, `public import
  all`, and a `#lang` other than `lean4`. A header error the bake does not
  detect ends it with no `.snap` (exit 1); no entry is written for it.

## Files: identity and transport

- **The raw `.snap` is the snapshot's identity**, as the raw pack is a pack's
  (artifact-manifest.md). The same runtime (`lean.js` + `lean.wasm`), library
  tree and probe give the same bytes when they are baked the same way:
  `probe.lean` holds the probe text plus `\n`, and the runner is started as
  `<node> --stack-size=8192 <runner> --work <abs> --artifact <abs> --lib <tree>
  -- --incr-header-save=/work/<name>.snap /work/probe.lean` (this package's
  runner also gets `--exit-with-parent --parent-pid <bake pid>`, first, which
  changes no byte), with
  Lean's cwd at `/` (the main module `work.probe` is recorded in the region)
  and an environment of `PATH`, `HOME`, `TMPDIR`, `LEAN_COMPACTOR_RESERVE`
  (plus `QED64_ALLOW_LEGACY_IMPORTS=1` when asked for and `QED64_PROFILE_INIT`
  when non-empty, neither of which changes a byte) only: an inherited
  `LEAN_PATH` or `LEAN4_WASM64_CWD` would change the bytes. Baked so, QED64's
  runner and this package's give the same `.snap`.
- **The `.snapz` is transport only:** the `.snap` gzipped by Node's zlib at
  level 6 with default options, its header as the zlib build writes it. Like a
  pack's transport it is verifiable but **not reproducible across zlib builds**
  (deflate output depends on the zlib build and CPU features): the same `.snap`
  baked on another host can get another `.snapz` digest, a new transport of
  the same snapshot that costs a reader a download, never a wrong load (its
  cache is keyed by the digest). The bake prints the Node version, the zlib
  version and the shared-zlib flag on a line of its own; record a `.snapz`
  digest together with that line.
- **The file name** is `<name>.<first 16 hex of digest>.snapz`, written into
  the index's directory through a temporary file and a rename. Content-addressed
  names never collide, so an older `.snapz` is never removed by a bake.
- **The `url`** is `/snapshots/<file>`: site-absolute and on the page's own
  origin (HOSTING.md rules 3 and 4). A reader that serves a set elsewhere
  re-roots the `/snapshots/` prefix (QED64's `?snapshots=<dir>`).
- `.snapz` files are served as `application/octet-stream`, without
  `Content-Encoding`, `immutable` (HOSTING.md rules 5, 6 and 8).

## Pairing: one runtime per index

Every entry of an index names the same `runtime`; an entry without one pairs
with none. A writer adding an entry baked by runtime R refuses an index whose
entries of other names name another runtime (foreign) or none (unpaired); the
entry of the same name is replaced whatever its runtime. A reader never loads
an entry whose `runtime` is not the build id it booted (QED64:
`SNAPSHOT_UNPAIRED`).

## The per-build copy

Beside `index.json` the writer keeps `index.<buildId>.json`, where `<buildId>`
is the runtime the index is paired with: **the same bytes**, the index of that
runtime's pairing. A shell built for that runtime reads it when the mutable
`index.json` already names the next runtime (an upload ran ahead of its
deploy). The precedent is the runtime manifest's two copies
(runtime-manifest.md).

- The bake writes both on every successful upsert, and neither when it refuses
  or fails before the first rename ("Writing", step 4: a failure between the
  two renames leaves the copy one version ahead). Another runtime's copy in the
  directory is never touched.
- The bake's copy is its `--out`'s index: it suits a site that serves that
  directory as baked. A site that merges baked entries into a served index
  derives its copy from the merged index (and gives a merge whose entries name
  more than one runtime no copy), with the same writing order.
- On a site the copies are `/snapshots/index.<buildId>.json` and, for a site
  that pins its profile index the same way, `/snapshots/profiles-index.<buildId>.json`
  — both under `/snapshots/`, which is the site's (HOSTING.md rule 4). Both
  revalidate (HOSTING.md rule 8).

## Writing

1. **Read.** A missing `index.json` (ENOENT, and only that) is a new index,
   `{"schema": "qed64.snapshot-index/v1", "snapshots": []}`. Any other read
   error, text that is not JSON, another `schema`, no `snapshots` array or an
   entry without a string `name` is refused: a corrupt index is never replaced
   (that would drop every sibling entry). The bake checks the pairing here too,
   before its runner starts.
2. **Lock.** `index.json.lock` beside the index, created by an exclusive open
   (`O_CREAT|O_EXCL`, which exFAT/FAT and FUSE or SMB mounts support where
   `link(2)` may not), holding the writer's pid and a newline, `<pid>\n`
   (QED64's bake writes the same, and takes the same lock). It is held only
   around steps 3 and 4. **A lock is never taken over**, whatever its holder
   (running, not running, unreadable, empty) or its age: without `link(2)` no
   takeover is race-free (two writers that judge one dead lock can both
   remove it, the second removing the lock the first has just created), a pid
   means nothing on a directory shared between hosts, and another tool's lock
   need not be in this format. A writer that finds it held waits a bounded
   time (the bake: 120 s from before its first attempt), then gives up and
   names the lock and its holder: `pid N (running on this host)`, `pid N (not
   running on this host)`, `a holder it cannot read ("<its first 200
   characters>")`, or, when the lock itself cannot be read, `a holder it
   cannot read (read failed: <error code>)` (a directory; a symbolic link,
   which is not followed where the platform has `O_NOFOLLOW`, Windows aside)
   or `a holder it cannot read (read failed: ENOENT, every time)` (a lock that
   exists for the exclusive create yet vanishes on each of 100 reads). The bake then exits 1 with that line and
   `unindexed entry <json>`; its `.snapz` is in place and neither index is
   touched. Once no writer uses the directory, removing the lock and rerunning
   finishes the upsert. (A bake stopped by a signal after its `.snapz` is in
   place exits 128+n with the same `unindexed entry` line.)
3. **Re-read and re-check** under the lock, with step 1's rules and the
   pairing: a sibling bake may have upserted meanwhile. A refusal here writes
   nothing.
4. **Write.** Both temporary files first, `index.<buildId>.json.<pid>.tmp`
   and `index.json.<pid>.tmp` (written and fsynced; a full disk fails before
   either switches), then the **copy is renamed first and `index.json` last**,
   then the lock is released (only while it still reads this writer's `<pid>\n`).
   `index.json` is the commit record. Every version of either file names one
   runtime, so no order can show a reader a mispaired index, and copy-first
   keeps the copy never older than `index.json`: a failure between the renames
   leaves the copy one version ahead (its `.snapz` already in place), and the
   next bake rewrites both.

## Reading and uploading

This document specifies the writer. How a reader chooses between `index.json`
and a copy, and the order in which a site uploads `.snapz` files, copies,
indexes and shells, are serving rules: HOSTING.md, "Snapshot indexes: the
pinned copies".

## Producing one

```bash
lean4-wasm64 bake --artifact <dir> --lib <olean tree> --work <dir> --out <dir> \
  [--name init] [--probe '#check (2 + 2 : Nat)'] [--reserve <bytes>] \
  [--roots A,B] [--label <text>] [--initial-bytes <n>] [--entry-fields '<json object>']
```

It leaves the raw `<work>/<name>.snap` (kept: the probes load it) and writes
`<out>/<name>.<digest16>.snapz`, `<out>/index.json` and
`<out>/index.<buildId>.json`. `lean4-wasm64 snapshot-probe --snap
<work>/<name>.snap --lib <olean tree> --probe '…'` loads it through the
worker's export and compiles a probe on it.
