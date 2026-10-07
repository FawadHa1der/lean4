# lean4-wasm64

Tools for the Lean 4 wasm64 (Memory64) toolchain built from
[`FawadHa1der/lean4`](https://github.com/FawadHa1der/lean4) branch
`qed64-wasm64`: fetch and verify a release, run the runtime under Node, and
produce the artifacts a release is made of (chunked runtime, library packs).

Node ≥ 24, no dependencies. The package version is the release it was cut
with: `4.34.0-e1a79c1` belongs to release `lean-v4.34.0-e1a79c1`.

```bash
npm install https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-e1a79c1/lean4-wasm64-4.34.0-e1a79c1.tgz
```

(It is not on the npm registry: install it from a release, then `npx
lean4-wasm64 …` runs the local copy.)

## Use a release

```bash
# the runtime as an artifact dir: <out>/bin/lean.js, lean.wasm (rebuilt from verified chunks)
npx lean4-wasm64 fetch --from https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-e1a79c1/ \
  --id lean-v4.34.0-e1a79c1 --digest sha256:<the digest in the release notes> --out toolchain --only runtime,lean-lib
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
the served layout.

`verify --release <dir> [--deep]` checks a release directory end to end:
`release.json` and `SHA256SUMS`, every file, the runtime manifest and the
build-id rule, the gate's binary, every pack (streamed inflate to the raw
digest; `--deep` also every artifact).

## Commands

| Command | Does |
|---|---|
| `fetch` | fetch (parts of) a release and verify every byte |
| `verify` | verify a release directory |
| `release` | write `release.json` + `SHA256SUMS` for a staged release directory |
| `run` | run the wasm64 Lean CLI under Node (`--artifact <dir> [--lib <dir>] [--work <dir>] [--] <lean args>`): Lean's arguments start after `--` or at the first token that is not one of these flags; a repeated flag keeps its first value (a WARNING); `--work` is created only once the artifact checks pass. Lean's cwd is `/` (QED64's runner layout, so bakes are byte-identical to its): name files `/work/<file>`; `LEAN4_WASM64_CWD=work` keeps the older layout where relative paths land in `--work` |
| `gate` | the release gate on a runtime (`--artifact <dir>`) |
| `probe` | the persistent-path probe (`lean_wasm_compile`); `--cases <a.lean,…> [--passes n]` compiles each file n times, one `CASE {json}` line per compile (the gate's 0037 checks); an unknown flag or a stray argument is a WARNING |
| `chunk` | chunk `lean.js` + `lean.wasm`, write the runtime manifest |
| `pack` / `pack-set` | pack an olean tree / cut a release's packs from kernel build dirs (`packs.json`: roots, module lists, import closure) |
| `unpack` / `inspect` | unpack (verifying every part; `--slim` leaves out `*.olean.private`, the tree QED64 bakes on) / inspect and deep-verify a pack |
| `olean-imports` | the `import all` edges of an olean tree (`--audit`, the static half of a slim-bake audit), or one `.olean`'s ModuleData entry counts as a JSON line (`--entries`); as a module, `oleanImportEntries` / `oleanImports` / `oleanExtEntryCounts` over any `Uint8Array` (types: `olean-imports.d.mts`) |
| `id` | print the runtime build id of an artifact dir |

Every command takes `--help`. `run` and `probe` re-exec themselves with
`--stack-size=8192` (same PID) when started without one. As a library,
`import { checkRuntimeManifest, runtimeBuildId, buildIdOfArtifact,
buildIdOfArtifactSync, ensureStackSize, comparePatchIds, releaseDigest, … }
from "lean4-wasm64"` (`buildIdOfArtifactSync(dir)` returns `null` when the
artifact has no `lean.wasm`; the async `buildIdOfArtifact` throws).

## Specification

`formats/` is the contract: identity rules, pairing rules and the release
layout (`formats/README.md`), `release.json` (`formats/release.md`), the runtime
manifest, the pack manifest, and how to serve release bytes to a browser
(`formats/HOSTING.md`). The runtime's embedding ABI is `EMBED-RUNTIME.md` in
the repository's `wasm64-build/`.
