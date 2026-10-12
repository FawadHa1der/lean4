# lean4-wasm64

Tools for the Lean 4 wasm64 (Memory64) toolchain built from
[`FawadHa1der/lean4`](https://github.com/FawadHa1der/lean4) branch
`qed64-wasm64`: fetch and verify a release, run the runtime under Node,
produce the artifacts a release is made of (chunked runtime, library packs),
and bake the environment snapshots a site serves against a release's runtime.

Node ≥ 24, no dependencies. The package version is the release it was cut
with: `4.34.0-e1a79c1-r2` belongs to release `lean-v4.34.0-e1a79c1-r2`.

```bash
npm install https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-e1a79c1-r2/lean4-wasm64-4.34.0-e1a79c1-r2.tgz
```

(It is not on the npm registry: install it from a release, then `npx
lean4-wasm64 …` runs the local copy.)

## Use a release

```bash
# the runtime as an artifact dir: <out>/bin/lean.js, lean.wasm (rebuilt from verified chunks)
npx lean4-wasm64 fetch --from https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-e1a79c1-r2/ \
  --id lean-v4.34.0-e1a79c1-r2 --digest sha256:<the digest in the release notes> --out toolchain --only runtime,lean-lib
# lean-lib = the runtime build's own lib/lean (Init, Std, Lean, Lake): what run/gate/probe expect
npx lean4-wasm64 unpack --manifest toolchain/profiles/lean-lib.manifest.json --out toolchain/lib/lean
echo 'theorem t : 2 + 2 = 4 := rfl' > t.lean
npx lean4-wasm64 run --artifact toolchain --work . -- /work/t.lean   # library: toolchain/lib/lean; --work is /work, Lean's cwd is /
```

`fetch` reads `release.json` first and checks it whole (self-digest, the id
rule, safe paths, …) before writing anything; with `--id` and `--digest` it is
pinned. It then streams every file it selects through SHA-256, keeps a file
only when it matches, and never writes outside `--out` — an interrupted fetch
resumes, a tampered byte fails. `--only` takes `all` (the default: every
release file plus `SHA256SUMS`, a release dir `verify` accepts),
`runtime-chunks`, a pack id, `packs`, `native64`, `lists`, `tools`, and
`runtime` — the artifact layout `<out>/bin`, never part of `all`. `--from`
takes a GitHub release download URL (flat), an R2/site URL or a directory in
the served layout. A re-cut by reference (`release.json` `base`) fetched from
its GitHub release takes every file outside `tools/` from its base's release,
the sibling `…/download/<base id>/`, after checking the base's record against
its own; `--base-from <url|dir>` names another place, such as a local mirror of
the base. Its R2 copy and any mirror are complete. Tools without `base` support
(up to 4.34.0-e1a79c1-r2) refuse such a record.

`verify --release <dir> [--deep]` checks a release directory end to end:
`release.json` and `SHA256SUMS`, every file, the runtime manifest and the
build-id rule, the gate's binary, every pack (streamed inflate to the raw
digest; `--deep` also every artifact). `--base <dir|release.json>` also compares a re-cut by
reference with its base.

## Commands

| Command | Does |
|---|---|
| `fetch` | fetch (parts of) a release and verify every byte |
| `verify` | verify a release directory |
| `release` | write `release.json` + `SHA256SUMS` for a staged release directory |
| `run` | run the wasm64 Lean CLI under Node (`--artifact <dir> [--lib <dir>] [--work <dir>] [--exit-with-parent [--parent-pid <pid>]] [--] <lean args>`): Lean's arguments start after `--` or at the first token that is not one of these flags; a repeated flag keeps its first value (a WARNING); `--work` is created only once the artifact checks pass. Lean's cwd is `/` (QED64's runner layout, so bakes are byte-identical to its): name files `/work/<file>`; `LEAN4_WASM64_CWD=work` keeps the older layout where relative paths land in `--work`; `--exit-with-parent [--parent-pid <pid>]` (runner flags, not Lean's) exits once the process that started it is gone; `--parent-pid` is the pid of the process that spawns `node-runner.mjs` itself (so `node <package>/node-runner.mjs`, not `lean4-wasm64 run` or npx, which add a process); the bake passes both, with its own pid |
| `gate` | the release gate on a runtime (`--artifact <dir>`; `--baseline-exports <lean.wasm or list>`: an earlier runtime's exports, none of which a native-symbol lookup may miss) |
| `probe` | the persistent-path probe (`lean_wasm_compile`); `--cases <a.lean,…> [--passes n]` compiles each file n times, one `CASE {json}` line per compile (the gate's 0037 checks); an unknown flag or a stray argument is a WARNING |
| `bake` | bake an environment snapshot (`--lib <tree> --work <dir> --out <dir>` required; `--artifact <dir>`, else `LEAN4_WASM64_ARTIFACT`, else `QED64_LEAN_ARTIFACT`, required too; `--name`, `--probe`, `--reserve`, `--roots`/`--label`/`--initial-bytes`, `--entry-fields <json object>`, `--reap-quiet-ms`/`--reap-stable-ms`, `--allow-legacy-imports`, `--runner`): runs the runner (default: this package's `node-runner.mjs`) on `/work/probe.lean` with `--incr-header-save`, reaps its kept-alive exit, gzips the `.snap` to the content-addressed `<name>.<digest16>.snapz` and upserts `index.json` and its per-build copy `index.<buildId>.json` under `index.json.lock` (`formats/snapshot-index.md`; QED64's bake takes the same lock). **No lock is ever taken over**: a held `index.json.lock` is waited for at most 120 s, then the bake exits 1 naming it and its holder, with `unindexed entry <json>` (the `.snapz` kept, neither index touched); one bake per `--work`: `<work>/.bake.lock` holds the bake's pid and then its runner's, and a held one refuses the bake at once (exit 2, nothing changed). Remove a lock only once no bake uses its directory; a rerun then finishes. The runner's environment is exactly `PATH`, `HOME`, `TMPDIR`, `LEAN_COMPACTOR_RESERVE`, `QED64_ALLOW_LEGACY_IMPORTS=1` when asked for and `QED64_PROFILE_INIT` when non-empty. The probe's header is read as Lean reads it (one Lean rejects is refused, exit 2). Exit 0 baked, 1 the job failed (every refusal after the runner started), 2 refused before any side effect, 128+n a signal it received (passed to the runner; no index write; a `.snapz` already written is kept and its entry printed). Stop a bake with SIGTERM, which it passes to its runner and which releases its locks; a SIGKILL leaves `<work>/.bake.lock` behind (and `<out>/index.json.lock` when it lands during the index write); the package's runner, started with `--exit-with-parent --parent-pid <bake pid>`, exits by itself, another `--runner` keeps running until stopped. A closed stdout never stops a bake; a bake that crashes with its runner running kills it and keeps `.bake.lock` |
| `snapshot-probe` | load a baked `.snap` through the worker's export (`--via-mem`: the browser's path) and compile a probe on it (`(--snap <file> \| --fresh-import) --lib <tree> (--probe-file <file> \| --probe <source>)`): `SNAPSHOT PROBE PASS` / `SNAPSHOT PROBE FAIL: …`; a watchdog thread SIGKILLs the probe past `--watchdog-ms` |
| `chunk` | chunk `lean.js` + `lean.wasm`, write the runtime manifest |
| `pack` / `pack-set` | pack an olean tree / cut a release's packs from kernel build dirs (`packs.json`: roots, module lists, import closure) |
| `unpack` / `inspect` | unpack (verifying every part; `--slim` leaves out `*.olean.private`, the tree QED64 bakes on) / inspect and deep-verify a pack |
| `olean-imports` | the `import all` edges of an olean tree (`--audit`, the static half of a slim-bake audit), or one `.olean`'s ModuleData entry counts as a JSON line (`--entries`); as a module, `oleanImportEntries` / `oleanImports` / `oleanExtEntryCounts` over any `Uint8Array` (types: `olean-imports.d.mts`) |
| `id` | print the runtime build id of an artifact dir |

Every command takes `--help`. `run`, `probe` and `snapshot-probe` re-exec
themselves with `--stack-size=8192` (same PID) when started without one.

The runtime's knobs (`runtime-knobs.mjs`; EMBED-RUNTIME.md §3.6): `run`, `probe`
and `snapshot-probe` pass `LEAN4_WASM64_PTHREAD_POOL=<n>` as
`Module.pthreadPoolSize` (the pthread Workers created at load, 0..64, default 24;
kernel patch 0038 on) and copy `LEAN_WASM_PARKED_DEDICATED`,
`LEAN_WASM_PARKED_IDLE_MS`, `LEAN_WASM_STD_SURPLUS_EXIT`,
`LEAN_WASM_STACK_PROBE_SLOTS` and `LEAN_WASM_SYMTAB_TRACE` into the runtime's
environment. Under `run`, `LEAN4_WASM64_RTSTATS=1` answers every printed line
containing `[rtstats?]` with `[rtstats] <json>`: the pool, task-manager and
engine-guard counters (`null` where the runtime predates them).
`LEAN_WASM_SYMTAB_TRACE` (kernel patch 0039) prints the runtime's native-symbol
lookups on stderr, as `[symtab] miss - <name>` and `[symtab] hit <kind> <name>`:
`miss`, `hit` or `all`, each optionally `:<prefix>,<prefix>…`, clauses joined by
`;` (`miss:;hit:l_Lean_versionString` = every miss and that name's hits); anything
else is refused with one warning and traces nothing. `probe` prints the table's
self-check and counters as `SYMTAB {json}` (`runtime-knobs.mjs` `symtabStats`).

Two tools are not commands: `exports-audit.mjs [--glue <lean.js>] <dir>…` lists
what consumer trees' JavaScript touches on the runtime (exports, glue globals,
`PThread`/`TTY`/`FS` members) and fails on any name the export contract and the
gate's glue checks do not cover (`runtime-contract.mjs`; run it over every app
before a release that changes either); `runtime-contract.mjs` is the contract
itself, as the gate checks it on a runtime's files (S1, S2, S6).
`lean4-wasm64 bake` and `lean4-wasm64 snapshot-probe` replace the dispatcher
(`process.execve`), so the tool runs in the PID its caller started — a caller
that SIGKILLs or measures that PID gets the tool itself; where execve cannot
work (Windows, a Worker, a `fork()` IPC channel, `--permission`) one WARNING,
and they run as its child like every other command. `npx lean4-wasm64 …` adds
a process of its own above the dispatcher: a caller that needs the tool's PID
runs `node <package>/bake-snapshot.mjs` (or `node --stack-size=8192
<package>/snapshot-probe.mjs`). As a library,
`import { checkRuntimeManifest, runtimeBuildId, buildIdOfArtifact,
buildIdOfArtifactSync, ensureStackSize, comparePatchIds, releaseDigest, … }
from "lean4-wasm64"` (`buildIdOfArtifactSync(dir)` returns `null` when the
artifact has no `lean.wasm`; the async `buildIdOfArtifact` throws); the
snapshot index writer is `lean4-wasm64/snapshot-index.mjs` (types:
`snapshot-index.d.mts`).

## Specification

`formats/` is the contract: identity rules, pairing rules and the release
layout (`formats/README.md`), `release.json` (`formats/release.md`), the runtime
manifest, the pack manifest, the snapshot index (`formats/snapshot-index.md`),
and how to serve release bytes to a browser (`formats/HOSTING.md`). The
runtime's embedding ABI is `EMBED-RUNTIME.md` in the repository's
`wasm64-build/`.

## License

Apache-2.0 (`LICENSE`). `bake-snapshot.mjs`, `snapshot-probe.mjs` and
`snapshot-index.mjs` were ported from QED64 (MIT, same author) and relicensed
Apache-2.0 by the author; each says so in its header.
