# The wasm64 patch series

**The authoritative, upstream-ready series lives in [`patches/`](patches/):**
twenty-three `git am`-able commits over `cauli/lean4@5732b84` (branch `qed64-wasm64`
in `work/lean4`), each with full rationale and an explicit upstreaming
verdict in its commit message. Summary:

| # | Patch | Upstream? |
|---|---|---|
| 0001 | Emscripten 6.0.5 wasm64 Docker recipe | recipe replaces the i386-stage0 shim |
| 0002 | CMake wasm64 configuration (-m64 end-to-end, memory cache vars, platform target) | plumbing yes; memory values are policy |
| 0003 | `LEAN_SCALAR_PTR_LITERAL` gated on pointer width, not `LEAN_EMSCRIPTEN` | **as-is** |
| 0004 | `llvm_is_declaration` C ABI + `LLVMBindings.lean` `Context` declaration order | **as-is** (live correctness bugs) |
| 0005 | `lean_kernel_diag_is_enabled`: `uint8`, not `uint8*` | **as-is** |
| 0006 | `EM_ASM_PTR` for pointer-returning EM_ASM in `runtime/io.cpp` | **as-is** |
| 0007 | Five missing non-libuv fallback stubs (Std.Net externs) | **as-is** (family of lean4#6817) |
| 0008 | Remove wasm32-era debug instrumentation; `lean_shell_main` 2-arg ABI | arity fix relevant; rest fork hygiene |
| 0009 | Regenerated explicit Emscripten export list (LP64 symbol universe) | regenerate, don't merge |
| 0010 | **`lean_wasm_compile` reports parser diagnostics** (the parse-error fix) | pattern applies to any `processCommand`-loop embedder |
| 0011 | **Compacted-region buffer growth survives multi-GB saves**: `realloc` + null check (a failed growth threw a null-pointer `memcpy` = "memory access out of bounds") + `LEAN_COMPACTOR_RESERVE` to reserve the output buffer up front | null check + realloc **as-is**; the reserve knob matters to any no-mmap embedder saving whole environments |
| 0012 | **Flat open-addressing object table for the compactor** (node-based map cost ~5 GB for the ~10^8 objects of a whole-Mathlib save; flat table ~2 GB, faster walk) | **as-is** (pure memory/perf win on every platform) |
| 0013 | **In-memory snapshot load** (`CompactedRegion.readMem`, `lean_wasm_load_snapshot_mem`): the host streams a region straight into a `malloc` buffer, skipping the MEMFS staging copy (a second multi-GB JS-heap allocation) | applies to any no-mmap host; the shared `finish_region_read` refactor is upstream-neutral |
| 0014 | **Snapshot-load stage timings + streamed init progress**: every load reports region-read vs `[init]`-replay split (plus top-10 module timings when replay >5 s), and streams `[WASM INIT] i/n module` per module so hosts can render live progress through the blocking call | diagnostic; the numbers justify upstream work on initializer execution |
| 0015 | Multi-arch emsdk base image (drops the -arm64 pin so amd64 hosts build natively) | build hygiene |
| 0016 | **Replay-control flags on `lean_wasm_load_snapshot_mem`** (bit 0 = run the `[init]` replay; extension states come from the region, the replay rebuilds process-side registrations) | fork-shaped control surface; useful to any embedder |
| 0017 | **Interpreter dlsym probes gated on the wasm export table**: `lookup_symbol_in_cur_exe` consults a one-time `Set` of export names before calling dlsym | **as-is** for the Emscripten target — turns a 173 s pathology into ~1 s (below). **Superseded by 0039** (an in-module table, no dlsym, no JS) |
| 0018 | **Host-pumped LSP file worker** (`lean_wasm_lsp_init` / `lean_wasm_lsp_send`): drive a single-file server session one message at a time when a blocking stdin is impossible (WASM event-loop hosts); forces `server.reportDelayMs := 0` (timed sleeps on dedicated pthreads do not wake under this build) | experimental (branch `feature/lean4web-frontend`); the embedding shape mirrors the watchdog contract |
| 0019 | **24 preallocated pthread workers, 8 MiB thread stacks**: every `ServerTask` is `prio := .dedicated`, and synchronous `pthread_create` under Emscripten can only claim preallocated workers | needed by any wasm host running the language server |
| 0020 | **Keepalive-guard emscripten's `$checkMailbox`** (build-image patch to emsdk 6.0.5): mailbox servicing ran through `callUserCallback`→`maybeExit`, which `_exit()`s an EXIT_RUNTIME=1 runtime with no keepalives — terminating the pthread blocked in `emscripten_proxy_sync` right after its proxied op executed. Reproduced in 30 lines of pure C on stock wasm32 | **upstream emscripten PR ready** — see docs/EMSDK-BUG-REPORT.md |
| 0021 | **Pre-built header environments** (`Language.Lean.prebuiltHeaderEnvs`, consulted by `processHeader` before the disk import; populated by `lean_wasm_lsp_init` from the wasm env cache): olean reads from elaboration pthreads proxy to the host and stall under WORKERFS | the hook shape is upstream-plausible for any embedder pre-importing on a preferred thread |
| 0022 | **Flush the worker's LSP output after each message**: frame bodies have no trailing newline; a line-buffered host stream held them until the next message, whose bytes a framed reader ate as the missing body | **as-is** — correct for any line-buffered stdout |
| 0023 | **Covering-environment aliasing for worker headers**: `lean_wasm_lsp_init` serves a document from the smallest cached env whose closure covers its imports (snapshot-seeded Init/umbrella envs ⇒ no olean import; exact positions; playground superset semantics) | fork-shaped; pairs with 0021 |

Profile verdict (2026-08-23, superseded 2026-08-24): a whole-Mathlib snapshot
load spent **~0.7 s relocating 2.6 GB and ~114 s in 152 modules' interpreted
`[init]` replay**. A shared-interpreter-context patch (reusing symbol/constant
caches across the replay) was built, measured — no improvement — and reverted;
that experiment concluded "the time is real interpreted work". **It was not.**
A `--profiling-funcs` CPU profile attributed 173 s of a 180 s load to the
JavaScript `dlsym` shim: the interpreter probes for a *native* implementation
of every symbol it touches, no Mathlib symbol exists in the binary, and under
Emscripten every miss crosses into JS and allocates an error string. Patch
0017's export-table gate collapses the replay to **~1.1 s** (total 2.57 GiB
load: 117.5 s → **1.95 s**) and the first full-stress compile from 32–36 s to
**4.3 s** — the same storm was throttling compiles. The wasm64 footgun inside
the fix: EM_JS pointer parameters arrive in JS as BigInt, and `UTF8ToString`
does Number arithmetic — convert first or every probe throws "Cannot mix
BigInt" (the same class of bug as patch 0006).

A note on 0011's diagnosis, kept because the wrong turn is instructive: the
crash trace shows the compactor ~2,500 frames deep in its object recursion,
which reads like a stack overflow. It is not — instrumentation showed the
recursion bounded at 2,501 while 90 million objects streamed out; the process
died precisely as the output crossed 2 GiB, where the buffer tried to double.
A 128 MB main stack and a heap-stacked thread were both tried and discarded
before the counters settled it.

Build deviations from the evidence recipe (documented in
`work/lean4/docker-wasm64/configure-qed64.sh`): declared memory maximum
raised to 16 GiB (embedder-import compatibility), and
`CHECK_OLEAN_VERSION=OFF` (this clone embeds its real githash while the
certified profile packs carry the producer's; compatibility is enforced at
the SHA-256 manifest layer, and no patch touches serialization).

The sections below are the original working notes the series was distilled
from, kept for the reasoning trail.

---

# The wasm64 patch contract (15 files, +78/−307 over reinstate-wasm)

Verified against the successful spike; each item says WHY so the patch can be
re-derived on any future base revision.

## ABI corrections (upstreamable — wrong on every platform)

1. `src/library/llvm.cpp` — `llvm_is_declaration` must return raw `uint8_t`,
   not `lean_object*`: generated C declares `uint8_t (size_t, size_t)`, and
   `lean_box(0)` = 1 reads as `true`. wasm32 masked it (both lower to i32);
   wasm64 fails validation in `l_Lean_LLVM_isDeclaration___boxed`.
2. `src/kernel/environment.cpp:28` — declare
   `extern "C" uint8 lean_kernel_diag_is_enabled(object*)` (not `uint8*`).
   Symptom under wasm64: all modules load, then "Cannot convert 0 to a BigInt"
   from the exception trampoline inside `scoped_diagnostics`.

## Pointer-width gates

3. `src/include/lean/lean.h` — `LEAN_SCALAR_PTR_LITERAL` must select its
   layout from `UINTPTR_MAX == UINT32_MAX`, never `LEAN_EMSCRIPTEN`:
   Emscripten no longer implies 32-bit; the wrong arm silently corrupts
   statically-emitted scalars (e.g. Name hashes).
4. `src/runtime/io.cpp` — pointer-returning `EM_ASM_INT` → `EM_ASM_PTR`
   (`lean_io_getenv`, `lean_io_app_path`): EM_ASM_INT truncates wasm64
   addresses above 4 GiB.
5. `src/util/shell.cpp` — delete the debug argv walker that indexed `HEAPU32`
   with a 4-byte stride, and the stale 3-argument `lean_shell_main`
   declaration (generated ABI has 2 arguments).

## Build system

6. `src/CMakeLists.txt` — `-m64` in C/CXX flags (outer + stage1 + generated-C
   `leanc` + patched libuv), INITIAL/MAXIMUM memory as cache variables
   (128 MiB / 16 GiB), `STAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten`
   (without it the binary *works* but reports a wasm32 target string).
7. stage0 = plain native 64-bit; drop `-m32 -msse2 -mfpmath=sse` and the i386
   OpenSSL install. LP64 stage0 artifacts are directly compatible with the
   wasm64 runtime.

## Link completeness

8. `src/runtime/uv/tcp.cpp`, `udp.cpp` — five non-libuv fallback stubs
   (`tcp_wait_readable`, `tcp_cancel_recv`, `tcp_try_accept`,
   `udp_wait_readable`, `udp_cancel_recv`) that `lean_always_assert(false)`;
   they close the link, they are NOT network support.
9. `src/emscripten-exports.txt` — regenerate for the 64-bit symbol universe.
   Since 0039 it is the JavaScript contract only (`src/emscripten-exports.seed.txt`);
   what the IR interpreter resolves by name is the generated in-module table
   (`lean_wasm_symtab.c`), which must be linked into `lean` and nothing else.

## Explicitly unchanged

- ~~JS-exception mode stays (`-sDISABLE_EXCEPTION_CATCHING=0`);
  `-fwasm-exceptions` is a known miscompile on this tree under emsdk 6.~~
  Replaced by 0040: native Wasm exceptions, legacy encoding. The "miscompile" was wasm-ld's
  signature-mismatch stubs (fixed by aaa039aec9 and b6b649fe64), which trap in every EH mode.
- ~~`MAIN_MODULE=2` + explicit exports stays (the interpreter's dlsym contract).~~
  Replaced by 0039: a static link, the native-symbol table for the interpreter,
  and exports that are the JavaScript contract.
- `USE_GMP=OFF` stays: the olean header's GMP flag must match between the
  artifact producer and this runtime.

## Known defect in runtime `wasm64-02e0ac24cced25d8` (fix on next rebuild)

**Parse errors are silently dropped by `lean_wasm_compile`.** Empirically
characterized (see the persistent probe): garbage text, bare identifiers, and
unterminated declarations produce `scalar=0`, zero diagnostics; elaboration
errors (type mismatches, failed tactics, false proofs) report correctly.

Cause: `Shell.lean`'s `wasmCompile` collects `commandState.messages` AFTER
`Frontend.processCommand`, but `elabCommandTopLevel` (Lean ≥ 4.33 incremental
frontend) resets the log at the start of each command — parser messages are
attached BEFORE elaboration and are lost to that reset.

Fix for the next runtime build: inline the parse step in the collect loop so
parser messages are captured between parse and elaboration —

```lean
-- replace `done := (← Elab.Frontend.processCommand)` with:
Elab.Frontend.updateCmdPos
let cmdState ← Elab.Frontend.getCommandState
let ictx := inputCtx
let pstate ← Elab.Frontend.getParserState
let scope := cmdState.scopes.head!
let pmctx := { env := cmdState.env, options := scope.opts,
               currNamespace := scope.currNamespace, openDecls := scope.openDecls }
let (cmd, ps, parseMessages) :=
  Parser.parseCommand ictx pmctx pstate cmdState.messages
acc := acc ++ parseMessages            -- ← the messages the reset would eat
Elab.Frontend.setParserState ps
Elab.Frontend.setMessages parseMessages
Elab.Frontend.elabCommandAtFrontend cmd
done := Parser.isTerminalCommand cmd
```

Gate the rebuild on: garbage input → ≥1 error diagnostic; the defect test in
`tests/integration/persistent-path.test.ts` flips red when this lands.

24. **0024-wasm-cancellable-session-replacement-save-exception.patch** —
    three fixes in one: (a) `FileWorker.teardownForReplacement` + call in
    `wasmLspInit` — cancels the replaced session's reporter and pending
    requests and re-arms the once-per-process import guard whose neutered
    `forceExit(2)` silently wedged every second worker init in a process
    (the header-switch wedge); (b) `lean_compacted_region_save` surfaces
    compactor-construction and write-path throws as IO errors instead of
    wasm aborts; (c) `lean_compacted_region_read` non-mmap path reads each
    olean ONCE (was header-read + lseek + full re-read); Shell covering
    check accepts umbrella aliases (Mathlib/Mathlib.Tactic/Batteries/
    MIL.Common). Runtime wasm64-b59deba0cfa73d9c; both slim snapshots
    rebaked byte-stable (raw sizes identical to the 0fdfd698 bakes).

25. **0025-wasm-grow-cached-environments-extension-arrays.patch** — an env
    loaded from a snapshot predates extensions registered by a LATER
    snapshot's `[init]` replay; serving it then panics every generic
    extension access ("invalid environment extension has been accessed" —
    the PANIC-flood garbage on Init docs in umbrella sessions).
    `Environment.ensureExtensionsSizeForWasm` (the resize
    `finalizePersistentExtensions` already does) is applied at both env-
    cache choke points. Output now matches live.lean-lang.org exactly.
26. **0026-exports-drop-stale-specialization.patch** — export-list refresh
    forced by 0025's reshaped loop. Runtime wasm64-284a58df5421c4f4.

27. **0027-wasmLspInit-resolve-header-before-replacing.patch** — typing an
    import line sent every settled keystroke through a session replacement
    that only then discovered the half-typed module cannot resolve.
    Resolution now runs FIRST; unresolvable returns 2 with the live session
    untouched (the page shows a calm "imports incomplete" note, live-parity)
    and teardown happens only when the header resolves. Runtime
    wasm64-31aef224f49e8385.

28. **0028-HeaderSyntax.imports-degrade-gracefully.patch** — error-recovered
    headers (unterminated block comment opening the file, non-identifier
    module names) hit `unreachable!` → "PANIC ... unreachable code has been
    reached" and then elaborated WITHOUT the intended imports. Found by the
    adversarial corpus; skip malformed import nodes instead. Upstream-worthy.
29. **0029-exports-drop-stale-imports-specialization.patch** — export-list
    refresh forced by 0028's filterMap reshape. Runtime
    wasm64-dca2763359db27e7.

## 0030 — wasm: tolerate legacy (non-`module`) oleans in the exported-level env cache (2d75ec14cf)

The lean4game ecosystem (GameServer + every published game) is legacy-mode
Lean; its oleans are self-contained. Under the wasm target (or
`QED64_ALLOW_LEGACY_IMPORTS` natively), `importModulesCore` skips the
non-`module` guard, and admitted legacy modules get `irPhases := .all` so
their parsers/initializers/tactics evaluate (the meta gate otherwise refuses).
Both branches are unreachable in stock configurations. Enables the whole
wasm64-lean4game port: game envs bake into snapshots and Runner-checked
levels run in the browser.

## 0031 — wasm: resident stdin ring + PROXY_TO_PTHREAD (browser64 transport port) (8407585c65)

Runs the real `lean --worker` loop on the application pthread; stdin becomes a
futex ring in shared memory (`lean_browser64_configure_input_ring`), stdout
keeps the normal proxied path. `MAIN_THREAD_EM_ASM` for `lean_main`'s FS setup
and the getenv shim; a once-guard (`lean_wasm_shell_mark_preinitialized`) so an
embedder that pre-initialized the runtime can re-enter `main`, with the
initializer and the task manager never finalized on wasm. EMBED-RUNTIME.md §4.

## 0032 — wasm: resident header resolver, one environment registry, generated exports (992dc94b2d)

`FileWorker.setupImports` is the only header resolver on wasm: the exact import
set, else the smallest registered environment whose closure covers the header,
else refused with one header diagnostic; snapshot loads publish into that one
registry. `$/qed64/headerStatus` reports each resolution. Exports are generated
from the build's own C (`gen-exports.py`). QED64's `minKernelPatch` floor.

## 0033 — wasm: retire the host-pumped LSP entry points (37c3fc3adf)

Deletes `lean_wasm_lsp_init` / `lean_wasm_lsp_send` and the pump session code
(the code of 0018, 0023, 0027 and parts of 0021/0025): the resident transport
(0031/0032) is the only transport.

## Upstream import: Lean v4.34.0 (branch `import/v4.34.0`)

The line's base moves from `ecf55de08b` (4.33.0-pre) to the `v4.34.0` tag by a
merge (330 upstream commits); `wasm64-build/RELEASE-PIPELINE.md` is the
procedure and `wasm64-build/import-release.sh` drives it. What the import
changed in the series itself:

- **Conflict resolutions** are recorded in the merge commit's message
  (CMake leanc-args split, `run_with_thread_stack` kept off the Emscripten
  path, stdin ring vs the errno→libuv rewrite, FileWorker frame writer,
  stage0 gates re-applied over upstream's stage0).
- **Exports are generated by category, the committed `wanted` list is gone.**
  `emscripten-exports.wanted.txt` held nothing but {`___boxed` wrappers} ∪
  {module initializers} ∪ {constant cells} of cauli's 4.33 tree (no plain
  function), and "seed ∪ (wanted ∩ defined)" could only shrink — it had
  already missed 70 names our own patches 0030–0033 introduced (67 wrappers +
  3 cells in Shell, Language/Lean, Environment, FileWorker, …; found by the
  QED64 session on the 0033 tree), and v4.34.0 would have linked
  without 5,812 boxed wrappers, 168 module initializers (56 new modules) and
  213 cells — each a runtime correctness contract of the interpreter (see
  `gen-exports.py`), none a build failure. The generator now emits the three
  categories from the build's own C.
- **23 seed names removed**: upstream dropped their `@[export lean_*]`; no C++
  or JS caller remained (grep workers/front door/pipeline scripts against
  this list when syncing an app): `lean_add_alias`,
  `lean_attribute_application_time`, `lean_erase_macro_scopes`,
  `lean_expr_has_mvar`, `lean_get_reducibility_status`,
  `lean_has_match_pattern_attribute`, `lean_has_out_params`,
  `lean_internal_get_default_options`, `lean_is_attribute`, `lean_is_class`,
  `lean_is_inaccessible_user_name`, `lean_is_matcher`, `lean_is_out_param`,
  `lean_is_private_name`, `lean_mk_empty_environment`,
  `lean_mk_outparam_args_implicit`, `lean_mk_projection_info`,
  `lean_mk_syntax_ident`, `lean_private_prefix`, `lean_private_to_user_name`,
  `lean_projection_info_from_class`, `lean_set_reducibility_status`,
  `lean_simp_macro_scopes`. They are reachable through their boxed wrappers like
  any other Lean function.
- `wasm64-build/{gate,node-runner,persistent-probe}.mjs` re-synced from the
  QED64 pipeline (resident transport; one-shot CLI checks judged by output).
- **Seed gains six runtime entry points** (`lean_inc_ref_huge_n`,
  `lean_internal_get_option_overrides`, `lean_nat_size_in_bytes`,
  `lean_string_utf8_extract_fast`, `lean_system_platform_linux` — new in
  v4.34.0 — and our own `lean_compacted_region_read_mem`); the generator now
  reports any `extern "C" LEAN_EXPORT lean_*` definition the seed lacks.
- **The slim (iPhone) list is generated too** (`gen-exports.py --slim`): seed +
  initializers + cells + only the boxed wrappers with no unboxed body. The
  committed `emscripten-exports-slim.txt` had 123 stale names after the import
  and is deleted; CI's slim relink calls the generator. (Retired with its CI
  step by 0039.)
- **Merge audit** (34 agents, every both-sides file + four cross-file systems,
  each finding adversarially verified): no lost hunk, no orphaned hook — the
  resident resolver is still on the only header path, legacy-import tolerance
  and `irPhases := .all` are intact, the non-mmap olean read path is untouched,
  the errno→libuv switch has no duplicate case under musl and uses only
  constants of the pinned libuv 1.48.0. Every real finding was in the export
  lists. Snapshot layouts changed (`Command.State.prevLinterStates`,
  `DynamicSnapshot`): every `.snap` must be rebaked with the new binary.
- **Known limitation (found by the QED64 session on the staged pairing): a FAT
  umbrella bake of the 4.34 essential tree (with `*.olean.private`, 5,004
  modules) fails in the compactor** — "object compactor: out of memory growing
  the object table to 268435456 slots". The flat table (0012) grows by
  doubling at 70% load; a slot is 16 bytes on wasm64, so 2²⁷ → 2²⁸ slots is a
  4 GiB fresh table coexisting with the 2 GiB old one during the rehash, next
  to the 4 GiB `LEAN_COMPACTOR_RESERVE` region buffer and the live fat
  environment: more than the 16 GiB address space. The 4.33 fat bake (2,755 MB
  raw) stayed just under 0.7 × 2²⁷ ≈ 94 M objects; 4.34's crossed it. The slim
  bake (what ships: 1,127 MB raw) is unaffected. If a fat pairing is ever
  wanted, the kernel needs a knob — presize the table from the environment
  (`LEAN_COMPACTOR_TABLE_SLOTS`, removes the 2 GiB transient only), or a
  12-byte slot (a `uint32` offset; fat regions can exceed 4 GiB, so it must
  be guarded). Deliberately NOT changed in this import: a runtime change would
  re-pair every snapshot the staged 4.34 pairing was tested with.

## 0034 — wasm: a file's module flag is its header's, not the import level's (df1362243c)

Found by the QED64 session on the served 4.34 pairing while testing the
first user widget (HARDENING #51): every LEGACY user file elaborated with
module-system semantics — plain `def`s private by default, `@[server_rpc_method]`,
`attribute [tactic …]`, `@[app_unexpander]` rejected ("must be marked as
`meta`"). Cause: on Emscripten every import happens at `OLeanLevel.exported`
(the only facets the wasm build ships), and `importModules` derived
`header.isModule` from the level (`isModule := level != .private`). Latent
since the `.exported` patch; 4.34 hangs the module system off the flag, and
no test asked the environment for its own facts (the e2e/battery corpora
exercise messages, not semantics). Fix: `importModules` takes `isModule`
explicitly and `processHeaderCore` passes the header's; new
`Environment.setIsModule` (mirror of `setMainModule`) lets a shared
registry/snapshot environment take the buffer's flag — the resident
prebuilt-env branch sets `setup.isModule`, `wasmCompile` its parsed header's.
Gate: four module-semantics probes (`wasm64-build/probes/`). A post-import
kernel-only fix: the apps re-pair (rebake) against the new runtime with their
packs unchanged; the pack's oleans of the four modules lag the compiled code
until the next full import (harmless: native dispatch wins). Upstream-worthy
as the explicit-`isModule` parameter; the wasm `.exported` policy is ours.

## 0035 — wasm: no thread creation under the task manager's lock; dedicated tasks reuse parked threads (6b3a491f76)

The served 4.34 pairing froze for good about once per 4,400 edits: every Lean
pthread stopped at once, the worker's JS thread alive (qed64 HARDENING #52; root
cause by the widgets lane). Under Emscripten `pthread_create` from a pthread is
a synchronous round trip to the main JS thread, and the task manager made it
while holding `m_mutex` — for every `.dedicated` task, i.e. every LSP output
message, request and request continuation (~153 per edit cycle). One round trip
that never completes then stops every thread at its next task-manager call.

Wasm only; the native branch (and so the native64 compiler) is unchanged:
threads are created with the lock released; a dedicated task goes to a parked
dedicated thread when one exists (≤ 8 parked — a parked thread keeps its
Emscripten Worker, and 8 keeps app + std pool + parked within the 24
preallocated Workers); a reused thread gets the heartbeat limit and std streams
a fresh one would; waiters on a finished task are woken before its dependents
are handed off; nothing proxies to the main thread under `m_mutex` (the
`wait_for` panic included); `lean_wasm_task_manager_parked_threads` reports the
parked count lock-free for host gauges of live pthreads.

Drafted by the QED64 session; five-lens adversarial review (hand-off protocol
proved; every lock-drop caller; thread-locals; Emscripten proxies; design). New
gates: `probes/task-storm.lean` (forAsync chain, fan-out, a ladder of 24
dedicated tasks blocking on each other — beyond the cap — pool waits, waitAny;
must complete) and thread reuse (≤ 1 pthread per 4 dedicated tasks, counted by
`node-runner.mjs` with `QED64_COUNT_PTHREADS=1`). The same storm creates 2,956
pthreads on the served 0034 runtime.

Not a cure for a lost main-thread mailbox wakeup: every LSP frame is still a
synchronous `fd_write` proxy, and a notification stuck PENDING is not re-sent by
later proxies. The host-side periodic `checkMailbox` and a request-level
liveness probe stay the primary defence; an stdout ring (mirroring 0031's stdin
ring) would remove the per-frame proxy. Pool-change liveness heuristics are
invalid after 0035: a healthy runtime no longer creates a thread per frame.

## 0035b — wasm: dedicated-thread parking off by default (a8817d01f9)

The promoted 0035 runtime crashed the renderer on page reload (qed64
HARDENING #53, "L9": "V8 javascript OOM (Scavenger: semi-space copy)" in a
DedicatedWorker ~2.2 s after the reload; 0035 crashed 4 of 6 trials, 0034 0 of
5). A parked dedicated thread is a Worker blocked in a futex wait inside wasm;
Blink tears such a Worker down only after a ~2 s forcible-termination grace,
so 8 parked threads kept their isolates alive into the next page's boot
(pool at ready: running 19 vs 11) and exhausted the renderer's shared
pointer-compression cage.

The park cap is `m_max_parked_dedicated`, DEFAULT 0: a finished dedicated
thread exits and its Worker returns to the pool idle, as in 0034. Everything
else of 0035 stays (thread creation outside `m_mutex`, notify before hand-off,
the unlocked panic print, fresh streams and heartbeat on reuse, the parked
export, which reads 0). Opt-in: environment variable
`LEAN_WASM_PARKED_DEDICATED=<n>`, read once at task-manager creation, clamped
to 64 — tunable without a new runtime or a snapshot rebake, but only after a
reload-storm measurement. The gate runs the storm at the default (2,961
pthreads: parking off) and at 8 (163: reuse works). Served as runtime
`wasm64-3ab1c6a9da03bc29`; live reload storm 0 of 3 crashed (2026-10-02).

## 0036 — wasm: deep recursion fails with an error at the engine's stack limit (41ec56530d)

A proof that recursed deeply killed its thread in a browser (qed64 HARDENING
#60, found by lean4game): `RangeError: Maximum call stack size exceeded` in a
pthread Worker, and the session never answered again. Wasm frames run on the
stack of the thread running them — the engine's, not the shadow stack in
linear memory that `check_stack` measures and that deep recursion barely
moves. A Chrome Worker gets 500 KiB of it (V8's fixed worker limit; Firefox
about 1 MiB, Node 4 MiB), while Lean's guards assume the 8 MiB of the pthread
attribute: Meta's `decide` on `∀ n m : Fin 40, n * m = m * n` and the
kernel's on `Fin 120` (`decide +kernel`) both overflowed it.

No engine reports how much stack is left, but a call with N arguments needs N
slots up front in every tier, so `Reflect.apply` with a fixed argument array
throws (RangeError in V8 and JSC, InternalError in SpiderMonkey) exactly when
less than that is free. `engine_stack_has_headroom()` (stackinfo.cpp) runs
that probe — 16384 slots, 128 KiB of headroom, ~4 µs; the sink takes a formal
parameter so no arguments object is built — at the two places deep recursion
passes:

- the kernel's depth guard `scope_rec_depth` probes on a thread's outermost
  level and then every 16 levels deeper (the next probe depth falls back as
  the recursion unwinds, since a frame above a probed one has more room), so
  recursion that stays within 16 levels costs nothing. It throws a plain
  `exception`, reported as `(kernel) the WebAssembly engine's stack is
  exhausted: …` — not `deepRecursion`, whose advice (raise `maxRecDepth`)
  would not help;
- `Core.checkSystem` (CoreM.lean) calls the new `@[extern
  "lean_wasm_native_stack_ok"] Core.nativeStackOk` first, which probes on
  every 16th call of a thread (Lean code has no depth to go by), and throws
  "maximum recursion depth has been reached: the WebAssembly runtime's stack
  is exhausted (…; raising maxRecDepth does not help, …)", tagged
  `runtime.maxRecDepth` so it is a runtime exception that no `try`/`first`
  catches and retries.

Native builds: no probe; the extern returns `true`. `LEAN_WASM_STACK_PROBE_SLOTS`
overrides the headroom (0 disables the probe), for calibration; the
node-runner forwards it. Also `get_stack_size(main)` on Emscripten is now
`base - end` (the stack grows down; it was negative).

The CoreM change adds two functions and no stored type. A runtime-only release
pairs this runtime with the v4.34.0 import's stdlib and Mathlib oleans: their
`Lean.CoreM` lacks `nativeStackOk` and `checkNativeStack` and holds the old
`checkSystem` body until the next full import. Harmless: only compiled code
calls them (native dispatch wins, as for 0034); interpreted callers of
`checkSystem` reach the compiled one, which probes; naming
`Lean.Core.nativeStackOk` in user code reports an unknown constant.

Recursion that passes neither checkpoint (the IR interpreter's own recursion,
some expression traversals) can still overflow, as native Lean can abort
there. The node-runner knob `LEAN4_WASM64_PTHREAD_STACK_MB=0.68` gives the
pthreads Chrome's budget (Node keeps ~192 KiB back); the gate runs both probes
(`js/probes/deep-recursion*.lean`) at it — each must end in Lean's error with
the thread alive — and the Meta one at the default stack, where it must still
check. Measured 2026-10-06 (host Node 26.3): the same holds with the v4.34.0
Mathlib packs (`import Mathlib.Data.ZMod.Defs`, Meta and kernel), where 0035b
dies with the RangeError; the overhead on kernel-heavy (`decide +kernel`),
Meta-heavy (`decide`, `simp`, `omega`) and Mathlib-tactic (`ring`, `linarith`,
`norm_num`, `positivity`) files is within run-to-run noise (≤ 3%, against 0035b
and against `LEAN_WASM_STACK_PROBE_SLOTS=0`). Of the stdlib's generated C only
`Lean/CoreM.c` changed (names added, none removed or renumbered).

## 0037 — wasm: lean_wasm_compile reports the messages of elaboration tasks (c8db69fdd3)

A false proof compiled with errors=0 through `lean_wasm_compile` whenever it
was elaborated with `Elab.async` (lean4game's report; QED64's probe-neg N6,
N6b, N7): `set_option Elab.async true in theorem bad : 1 = 2 := by exact foo`,
or a command elaborator running `elabCommand` under `withScope` with the
option on — lean4game's GameServer `Runner`, so its `--verify-snapshots` and
QED64's snapshot-probe and compiler battery passed wrong level proofs. The
native CLI and the browser FileWorker were right: they report the whole
snapshot tree. Under `Elab.async` a theorem's body, its kernel check,
compilation and the linters run in tasks whose messages live only in
`Command.State.snapshotTasks`; `wasmCompile`'s synchronous loop read only
`messages`. Even without the option, `realizeConst`/`realizeValue` report
through tasks, and the tasks piled up across commands (nothing cleared them),
so a later async linter or `#guard_msgs` took in earlier commands' tasks; the
old comment's "the synchronous loop creates no tasks" was wrong.

`wasmCompile` now resets each command's `messages`, trace state and snapshot
tasks before elaborating it, as `Language.Lean`'s `doElab` does, then waits
for the tasks it started (`IO.wait`, each tree's `getAll` in preorder) and
adds their UNREPORTED messages — a task starts from its parent's log marked
reported, so `reported` would repeat messages already collected. Every
message is reported once, in the native frontend's order (per command: parse
messages, the command's own, then its tasks'). The call returns after every
task still recorded for a command has finished; a task elaboration itself
discarded (a tactic backtrack restoring a saved state, `liftCommandElabM`) is
neither reported nor awaited, as natively, and can finish after the call
(review, e1a79c1ce9). Contract change for embedders: the call waits for its
tasks, so a task that never finishes now hangs it instead of leaking — supervise
it with a wall-clock limit outside the blocked thread.

Gate: 13 async probes (`js/probes/async-*.lean`: unknown identifier, unsolved
goals, term-mode mismatch, file-wide async with linters, a valid proof, sorry,
`#guard_msgs`, the Runner shape valid and invalid, several commands, a kernel
error from the async kernel check, 41 proofs fanned out by one command, and
an informational mixed-mode lint case), each with a synchronous twin, twice in
one resident runtime (`persistent-probe.mjs --cases`): exact messages, parity
with the twin, no duplicates, the same output on the second pass, and plain
compiles afterwards. Calibrated on 0036 before the build: the twins matched
every expectation and the async cases failed (11 checks); the new loop, run
verbatim via `#eval` on 0036, already gave every async case its twin's
messages. Measured 2026-10-06 on the gated build (runtime
wasm64-f69cca24d0878a58, gate 33/33): the 26 synchronous and reuse compiles
print the same messages on 0036 and 0037 (1087 vs 940 ms in all); 41 async
proofs fanned out by one command are joined in ~0.45 s (sync twin ~0.26 s);
`sleep 1000` inside an async proof returned after 18 s — timed sleeps on task
pthreads wake late here — rather than hanging. Of the stdlib's generated C only
`Lean/Shell.c` changed (its private specializations renumbered; none reused,
none referenced elsewhere), so the v4.34.0 packs pair with this runtime.

## 0038 — wasm: the host sizes the pthread pool; surplus and idle threads may leave; engine-guard counters (40ea397b15)

(Named before a release records the gate's numbers: the patch-id rule, `js/artifact-id.mjs`, places
a build by the commits the headings name, so an entry left unnamed would stage a 0038-0039b build
as 0037; `stage-release.sh` refuses a heading spelled `## Unreleased: …`. The fixes from the
review of 0038-0039b (r0038) are a later commit; these entries describe the result.)

Every live pthread holds an Emscripten Worker, and in a browser each Worker is a V8 isolate of
~129 MiB in a renderer whose pointer-compression cage fits about 30 of them (EMBED-RUNTIME.md §6;
qed64 HARDENING #55, #69, #70). This patch gives the host the size of the pool and two opt-in ways
for an idle thread to give its Worker back, and counts the engine-stack guard of 0036. Every
default is 0037's; only the counters are new.

- **The pool size is the host's.** `-sPTHREAD_POOL_SIZE` is a JS expression that emsdk emits
  verbatim into the glue's pool loop. It now names a variable of `src/emscripten-pthread-pool.js`,
  a `--js-library` of the `lean` link pinned to emsdk 6.0.5 (another emsdk fails the link there):
  `Module.pthreadPoolSize`, read once when the glue is evaluated, an integer clamped to 0..64,
  else 24, the pool since 0019. A thread beyond the pool gets a Worker of its own when it starts,
  as before. node-runner, persistent-probe and snapshot-probe pass `LEAN4_WASM64_PTHREAD_POOL`.
- **`LEAN_WASM_STD_SURPLUS_EXIT=1`**: a standard worker exits while more of them live than the
  cap. `Task.get` in a pool task raises the cap by one while it waits and starts a worker when
  none is idle; without the knob the workers of such a burst stay for the life of the process. A
  worker leaves only at its idle wait (nothing queued) or its throttle wait, where the queue
  waits for the busy workers exactly as the throttled one would have (the argument, including
  `wait_any` waiters and workers not started yet, is in `object.cpp`). With the knob, a raise
  starts no worker when the live ones already fill the raised cap: it could only wait throttled
  and would leave at once, where before 0038 it stayed asleep (a busy worker that finishes takes
  the queue, as that sleeper would have). There is no hysteresis: a pool task that `Task.get`s
  again and again while every worker is busy starts a worker for each get, which leaves after it
  (each start a synchronous `pthread_create` round trip to the main JS thread), where without the
  knob the first such worker stays and is reused; key 6 of the counters below counts the starts,
  for the measurement that decides whether a host turns the knob on. On wasm, standard workers
  are now counted instead of kept as joinable handles, and created detached like dedicated
  threads: nothing ever joined them there, so this changes nothing until a worker exits.
- **`LEAN_WASM_PARKED_IDLE_MS=<ms>`**: a parked dedicated thread (`LEAN_WASM_PARKED_DEDICATED`,
  0035b) exits after that long without a task (clamped to an hour). A hand-off racing the deadline
  is safe: the task is set and the slot taken under the lock, and the woken thread runs it. The
  wait is one timed futex wait; timed sleeps on task threads have woken late in this build (0037
  measured 18 s for `sleep 1000`), so the gate measures how soon the idle threads leave.
- **The knobs are decimal digits.** `LEAN_WASM_STD_SURPLUS_EXIT`, `LEAN_WASM_PARKED_IDLE_MS` and
  0035's `LEAN_WASM_PARKED_DEDICATED` take digits only (then clamped); anything else (`-1`, `1e3`,
  ` 1`, `true`) is off, with one line on stderr. `strtoul` alone read `-1` as its maximum (an
  hour's timeout, 64 parked threads) and `1e3` as 1.
- **Counters, always on, observation only.** `lean_wasm_task_manager_stat(key)`: 0 standard
  workers live, 1 their cap, 2 the most ever live, 3 surplus exits, 4 parked threads, 5 idle exits,
  6 standard workers started; -1 for another key or before the task manager exists.
  `lean_wasm_engine_probes()` counts the questions the guard's two sites ask (the kernel's
  `scope_rec_depth` on its probe levels, `Core.checkSystem` on every 16th call; with
  `LEAN_WASM_STACK_PROBE_SLOTS=0` they are still counted, and never refused),
  `lean_wasm_engine_guard_trips(site)` the refusals at site 0 (the kernel) and 1
  (`Core.checkSystem`). The sites count around their own call of
  `engine_stack_has_headroom`, so that function, the probe, its interval, its headroom and every
  decision stay 0036's; the two callers' wasm frames may differ by a few bytes, nothing against the
  128 KiB of headroom. One relaxed atomic add per question (a question costs ~4 µs). All three
  are lock-free doubles, safe from the host's main JS thread; they are seeded exports.
- **Relinking.** The JS library and the export list are prerequisites of the `lean` link
  (`LEAN_EXE_LINK_DEPS`, `src/stdlib.make.in`), so an edit to either relinks, and `gen-exports.py`
  rewrites its outputs only when their content changes, so the dependency is a true one. The link
  still runs on every build: the Emscripten build's dummy shared-library targets touch
  `libleanshared*` each time (`src/CMakeLists.txt`), and those are prerequisites too.

**Dropped from the design after review** (r0038): a soft ceiling on the pool with held-back
thread starts, its overflow timer, shrinking the pool back to its initial size,
`Module.pthreadPoolStats()`, and the "pool pressure" cell that would have stopped threads from
parking. A held-back start can be released only from the main JS thread's event loop, so a host
that blocks that thread in a wasm call — QED64 does, at boot (`lean_wasm_load_snapshot_mem`) and in
its blocking `compile()` — could deadlock on a thread it held back; and shrinking on every release
churned Worker boots in exactly the band such a host configures. The native-symbol table (0039) is
expected to make each Worker cheap enough that the ceiling is not needed now (0039 measures it).
Also left out: `lean_wasm_compile` elaborating with `Elab.async` on unless the file says otherwise,
as native `lean` does. That changes a default, with thread and stack effects of its own, and
needs a decision of its own.

Gate, folded into the existing runs (the gate still boots 11 runtimes; on a runtime before 0038
every 0038 check is skipped with a note): the glue's pool loop reads the library's variable and the
three counters are exported (static); `LEAN4_WASM64_PTHREAD_POOL` -3, 4 and abc give pools of 0, 4
and 24; with the knobs on (the false-proof run, `--threads=2`, `js/probes/thread-knobs.lean`) the
standard workers of a `Task.get` burst fall back to the cap and parked threads leave within the
idle time plus 1 s, while with every knob unset (the smoke run, `--threads=2`, the same probe) the
workers of the same burst, past the cap, all stay and no thread parks, as before; the guard's
refusals are counted at Chrome's stack (kernel and Meta), and at the default stack it asks and
refuses nothing. Node: `LEAN4_WASM64_RTSTATS=1` makes node-runner answer a printed `[rtstats?]`
with `[rtstats] <json>` (`js/runtime-knobs.mjs`). Measured numbers: from the first gated build.

For hosts: a pool of other than 24 moves thresholds keyed to it, such as QED64's edit hold
(`lib/edit-coalescer.ts` holds while fewer than 6 pool Workers are free, "6 of the runtime's 24");
the two exits are for a host that has measured its reload behaviour with them (EMBED-RUNTIME.md
§3.1, §3.6).

## 0039 — wasm: native symbols through an in-module table; static link; exports = the JS contract (5343f2dfe9)

(Named before the gate's numbers, as 0038.)

The IR interpreter finds native code by name (`lookup_symbol_in_cur_exe`): a decl's boxed wrapper,
its `@[export]` name, a constant cell, a module initializer. Natively that is `dlsym` over the
dynamic symbol table (`lean` links with `-rdynamic`). On wasm `dlsym` searched the module's
EXPORTS, under `-sMAIN_MODULE=2`, so `gen-exports.py` exported every such name: 106,368 exports.
Each cost JavaScript in every Worker, main runtime and pthreads alike: a 49 MB glue
(`assignWasmExports` alone 37 MB), the dynamic linker's per-export bookkeeping and table growth
(`updateGOT`), ~129 MiB of JS heap per isolate (qed64 HARDENING #55; a renderer's 4 GiB
pointer-compression cage held about 30), a 2.4 s boot in Node. And every `dlsym` hit went
through JavaScript (`Object.keys(…).indexOf` over the exports, under the dynamic linker's lock).

- **The table.** `gen-exports.py --symtab` writes `lib/temp/lean_wasm_symtab.c` from the build's
  own C: every name the interpreter may ask for, sorted bytewise and front-coded (a whole name
  heads each block of 16, then `[shared-prefix byte][suffix] NUL`), with its kind and its address
  (a function pointer — a table index — or a cell's address, both fixed at link time), and the
  declarations copied from each defining file's own `LEAN_EXPORT` prototype, so every signature is
  exact. The selection comes from the archives the link uses (`--archives`, read with an nm that
  reads wasm objects), cross-checked against the C (B1: any difference stops the build), with
  per-kind floors (B2); the outputs are rewritten only when they change, with a manifest (count,
  kinds, FNV-1a-64 over `name NUL kind`, sha256 of the names). On the v4.34.0 tree (the 0037
  build, whose binary is r3's): boxed 90,208, export 228, cell 8,295, initializers 3 × 2,356 —
  105,799 entries, names 3,999,813 bytes front-coded (11,415,120 raw), the longest 1,554, FNV
  `b02d6ef8a9143ae4`; host clang compiles it for wasm64 in 1.3 s without a warning, and each of its
  97,504 function references has the signature of its definition in the archives (checked
  against the objects' own types). `mkMangledBoxedName` names the wrapper of a stem ending in
  `__` `…_00__boxed`, which the old classification missed: those 6 wrappers are boxed entries now
  (r3 exported none of them, so their decls ran interpreted), and their unboxed siblings — one
  with scalar parameters — are not "plain".
- **The plain functions stay out** (`INCLUDE_PLAIN = False`): the 29,538 all-object `l_*`
  functions without a boxed wrapper, which the interpreter would call natively once in the table,
  are their own measured step (0039b, below). This patch resolves exactly what r3 resolved:
  every name r3 exported for the interpreter is in the table but `initialize_libuv` (no Lean
  module names it), plus `lake_environment_add` (an `@[export]` the old seed lacked) and the 6
  wrappers above.
- **The lookup** (`src/library/wasm_symtab.cpp`): a binary search over the block heads, then at
  most one block's decodes, in C — no lock (the data is immutable), no JavaScript, no
  initialization, safe from any thread; ~330 ns a hit and ~210 ns a miss on the host over the full
  table. `lookup_symbol_in_cur_exe` calls it under `LEAN_EMSCRIPTEN`, with no fallback; 0017's
  EM_JS export `Set` is deleted. `initialize_ir_interpreter` asserts the table is not empty.
  Relaxed counters by kind; `LEAN_WASM_SYMTAB_TRACE` (`miss|hit|all[:prefix,…]`, clauses joined by
  `;`, strictly parsed: anything else traces nothing, with one warning) prints lookups on stderr;
  its parsed form is never freed, so a lookup on a detached thread during `exit()` reads no freed
  prefix.
  Exports `lean_wasm_symtab_stats(key)` (doubles, lock-free; EMBED-RUNTIME.md §2) and
  `lean_wasm_symtab_selfcheck(counts, fnv)` (a full decode: order, kinds, addresses, FNV).
- **The link is static** (no `-sMAIN_MODULE=2`). Nothing loads side modules, so the dynamic
  linking emcc calls experimental with pthreads goes, with its GOT, its per-thread `dlsync` and
  `dylink.0`; a missing table is a link error. `lean_dynlib_load` returns an IO error under
  `LEAN_EMSCRIPTEN` before any `dlopen` (`--load-dynlib`, `--plugin`, `Lean.loadDynlib`).
  `-sALLOW_TABLE_GROWTH=1` keeps what MAIN_MODULE set; `--emit-symbol-map` writes
  `bin/lean.js.symbols` (`index:name` of every function: the crash-triage map now that functions
  have no export names), which stays in the build tree (`stage-release.sh` leaves it out). At -O3
  the raw wasm import and export names are now minified; `Module["_x"]` names do not change.
  `-fPIC` stays: PIC objects already linked into MAIN_MODULE=2's fixed-address module, and
  dropping it changes every object (a cold build) for a gain to be measured separately. The table
  is an input and a prerequisite of the `lean` rule alone (`src/stdlib.make.in`): the linker flags
  are shared by every executable rule.
- **The export list is the JavaScript contract**, `src/emscripten-exports.seed.txt`, one name per
  line with its callers (QED64's runtime-touch contract): the 17 Lean/C entry points QED64 calls,
  `_main`, `_lean_wasm_reset`, the 0038 and 0039 gauges, and the three Emscripten built-ins hosts
  reach (`__emscripten_proxy_main`, `__emscripten_check_mailbox`, `_pthread_self`, now also bound
  on `Module`): 27 names. 749 names left it: 221 `@[export]` names (table entries now), 527 C++
  `lean_*` functions no JavaScript calls (the interpreter's keys are never C names: an
  `@[extern]` decl is reached through its boxed wrapper), and `initialize_libuv`. The generator's
  "runtime API defined but not in the seed" report is retired: "every `lean_*` C symbol is
  exported" serves nothing any more. `EXPORTED_RUNTIME_METHODS` is unchanged (QED64's contract
  needs `callMain`, `FS`, `ENV`, `getValue`, `stringToNewUTF8`; `ccall`, `setValue`,
  `UTF8ToString` stay).
- **The slim (iPhone) variant is retired**: CI's "Link slim (iOS) wasm variant" step and
  `gen-exports.py --slim`. The per-export glue it avoided is gone, Safari has no Memory64, nothing
  consumed `bin-slim`.

**Build checks** (`build.sh`): B1 and B2 in the generator (step 4b; `QED64_NM` names the nm; it
runs on the host and now writes into `lib/temp`, which make creates in the container, so the host
user must be able to write there: Docker Desktop maps the bind mount to that user, while rootful
Docker on Linux leaves it root's, and `build.sh` then stops before the generator with the reason);
B3 after the link (`check-link.py`): a `signature mismatch` in the link log or a
`signature_mismatch:` function in `lean.js.symbols`, or a table entry left undefined, fails the
build; other undefined symbols are compared with `link-undefined-allowlist.txt`, which the first
0039 link calibrated (empty; with its `# calibrated-from:` line any difference fails the build).
`import-release.sh build`'s `gen-exports.py --check` recomputes the selection and fails (exit 1)
when it differs from the build's manifest or the export list on disk.

**Gate**, folded into the existing runs (still 11 runtimes; on a runtime before 0039 every 0039
check is skipped with a note; a runtime is 0039 by its statically linked `lean.wasm`, or a glue
with 0038's names but without 0017's export-set gate, not only by the export S2 looks for): static
S1 (no generated name bound on `Module`, `lean.js` under 1 MiB, no `dylink.0`, no GOT import, few
exports, no trace of 0017), S2 (every contract name bound
on `Module` to a function export, through the glue's own bindings; from the repository with the
seed, packaged with `js/runtime-contract.mjs`'s copy), S6 (the [GLUE] surface QED64's worker and
node-runner reach into, EMBED-RUNTIME.md §5), and that `callMain` ran `main`; G2 (the persistent
probe's `SYMTAB` line: a fresh self-check, the kinds and FNV against the build's manifest, lookups
made), G3 (no Init/Std/Lean initializer missed in the legacy and `module` runs, no replay), G4
(`Lean.versionString` and `Lean.Meta.simpExtension` read from their cells), G5 (a function calling
plain core functions computes its value; whether `Lean.Name.append` ran native is reported, and
required since 0039b adds the plain functions), G6 (timing, informational), G7 (no lookup in any
run missed a `lean_*` name; with `--baseline-exports <r3's lean.wasm>`, none missed a name r3
exported). `js/probes/symtab.lean` rides on the legacy run. `js/exports-audit.mjs` lists what
consumer trees touch against the contract and S6, reading a chain such as `globalThis.Module.X` at
every link: over lean4game (client, served worker, relay) and the widgets showcase it reports
every name covered (`ENVIRONMENT_IS_PTHREAD`, the showcase's typeof-guarded UX probes, is a test
reach-in S6 reports); over QED64 (worker, pipeline, lib, tests, embedding) and the proof sheets,
one name, `HEAPU8`, in `globalThis.Module.HEAPU8?.buffer` (QED64 `pipeline/snapshot/resident-probe.mjs`,
the proof sheets' `scripts/browser-check.mjs`): the last fallback after `Module.wasmMemory` and
`wasmMemory`, and dead, as no glue of this line sets `Module.HEAPU8` (it is not a runtime method
the link exports). It is left UNGUARDED rather than listed: the consumers can drop it.

**Snapshots**: every table index and static address moves, so every `.snap` is rebaked for the
new build id (as for any build). Init replay should get cheaper: `runModInitCore` lookups (2.4k–4.7k
per import with extensions) no longer cross into JavaScript.

**Explicitly unchanged**: 0036's engine-stack guard (no edit to `stackinfo.cpp`,
`interrupt.cpp`, `CoreM.lean`, the probe, its slots or the stack sizes). The link can still move
native frame sizes — 537 C++ functions are no longer exported and may now be inlined
(`lean_wasm_native_stack_ok` among them) — so `stack-margin.mjs` measures, per deep-recursion
probe (Fin 40 `decide`, nested `have`, a `<;>` chain, `decide +kernel`), the smallest pthread
stack it survives and passes with: r3 against the first build below.

**Measured** on the first build, which is 0039b's runtime (570d16f926, build id
`wasm64-992464a0796331dc`, 2026-10-12; 0039 alone was never built), against r3, host Node 26.3:

- **Sizes.** `lean.js` 146,441 bytes (r3 48,975,090). `lean.wasm` 108,059,248 (r3 109,885,165);
  its code section 95,052,459 bytes in 159,336 functions (r3 91,353,467 in 146,246: +3.70 MB,
  +13,090 functions, the ones the table now keeps that wasm-opt could inline into an only caller
  and drop before). The link reports no undefined symbol; `link-undefined-allowlist.txt` is
  calibrated from it (empty).
- **Node boot**, default 24-Worker pool, two runs each: `--version` printed after 0.58–0.61 s
  (r3 3.04–3.20 s); the process's RSS 15 s later 0.95–0.96 GB (r3 9.95–10.17 GB).
- **Stack margins** (`stack-margin.mjs`, smallest `LEAN4_WASM64_PTHREAD_STACK_MB` in MiB, ±0.02;
  a Chrome Worker is 0.68):

  | probe | r3 survives | r3 passes | 0039b survives | 0039b passes |
  |---|---|---|---|---|
  | `decide`, Fin 40 × Fin 40 | 0.427 | 0.998 | 0.427 | 0.998 |
  | 25 nested `have … := by` | 0.69 | 2.771 | 0.661 | 2.917 |
  | `<;>` chain of 25 `trivial` | 0.427 | 1.115 | 0.427 | 1.174 |
  | `decide +kernel`, Fin 120 × Fin 120 | 0.427 | 1.233 | 0.427 | 1.233 |

  At Chrome's 0.68 the nested `have` now ends in Lean's error where r3 lost the thread; the two
  elaborator probes need ~5% more stack to pass. That 5% is V8's, not the code's (overflow traces
  at a fixed stack with the guard's probe off, `node --stack-trace-limit`): both builds overflow
  through the same functions, the same 34.8 frames per `evalTactic` level, and each of those
  functions is byte-identical between them but for addresses and call indices; no interpreter
  frame appears in either. What differs is how V8 enters wasm from JavaScript: each level passes
  through one C++-exception trampoline (`invoke_jjj`, JS) that calls the wasm function by its
  table index, and V8 makes that call through its generic JS-to-wasm wrapper, whose frame is
  larger, until that function has been entered so 1,000 times (`--wasm-wrapper-tiering-budget`),
  unless the wrapper for its signature was compiled when the module was instantiated, as V8 does
  for exported functions. r3 exported ~106k functions, so every signature had a compiled wrapper
  from the start; 0039 exports 27. With `--wasm-wrapper-tiering-budget=1` or
  `--no-wasm-generic-wrapper` the two builds reach the same depth (25 nested `have` at 2.0 MiB:
  206 and 206 levels with default tiering, 194 and 194 Liftoff-only; the chain at 0.9 MiB: 90 and
  90), against 206 / 195 and 90 / 84 without. So only the first ~1,000 entries of a function
  through a trampoline cost the extra stack: the first proofs of a session. Left as it is in
  0039; 0040 (native Wasm exceptions) removes the trampolines, and with them this effect.
- **Gate**: G6 `symtabProbe 20000` 24 ms (0039b: native `Lean.Name.append`).

**Still to be measured**: the per-Worker JS heap and renderer RSS in Chrome (QED64's HARDENING #55
method; EMBED-RUNTIME.md §6); persistent compile and snapshot init-replay timings against r3.

For hosts: the contract and every `Module["_x"]` name are as before. Do not reach a raw
`wasmExports["x"]` (minified now); expect `Dynlib.load` to fail; rebake snapshots.

## 0039b — wasm: all-object core functions run native from interpreted code (84ffd48cb1)

(Named before the gate's numbers, as 0038.)

0039's table holds what r3 resolved. One kind of name was never there: an `l_*` function without a
boxed wrapper. `lookup_symbol` probes the wrapper first and then the plain stem, and natively
`dlsym` finds the stem (`lean` links with `-rdynamic`), so native `lean`'s interpreter calls the
compiled function. On wasm none was ever exported (all ~119k plain `l_*` functions would have
added ~18 MB of wasm), so interpreted code — package code, `#eval`, the `[init]` replay of
package modules — interpreted every such core function it called, from the shipped `.ir`.

- **The table holds them** (`gen-exports.py` `INCLUDE_PLAIN = True`), kind `plain`.
  `requiresBoxedVersion` (LCNF `ExplicitBoxing`) is false exactly when a function has parameters
  none of which is scalar, borrowed or void, no scalar result, is not `extern` and has at most 16
  parameters: each plain function takes owned objects and returns one, the ABI `call` (`curry`),
  `PAp` and `call_boxed` (closures) already use for a wrapper, and with no borrowed parameter
  `call`'s fix-up for wrappers does not apply. No interpreter code changes (two comments do). The
  generator refuses a plain entry whose prototype is not `lean_object* f(lean_object*, …)` with 1
  to 16 parameters — a wrapper the classification missed, as the `_00__boxed` ones once were — and
  B2 gains a plain floor (25,000).
- **On v4.34.0** (the 0037 tree): 29,538 plain functions (the design's 29,550 counted the 6
  `_00__boxed` wrappers and their 6 unboxed siblings, which 0039 classifies correctly), every
  prototype all-object with 1 to 16 parameters; 135,337 entries (boxed 90,208, plain 29,538,
  export 228, cell 8,295, initializers 3 × 2,356), names 4,825,216 bytes front-coded (14,273,595
  raw), FNV `04f6ca09e96eac38`. The 47.8 MB TU compiles for wasm64 in 1.6 s (538 MB RSS) without
  a warning; its object's data grows from 4.98 to 6.08 MB and its element segment from 0.28 to
  0.36 MB; each of its 127,042 function references has the signature of its definition in the
  archives. On the host every name resolves to its own entry, ~290 ns a hit, ~105 ns a miss.

What changes for interpreted code:

- **Speed.** Its calls into these functions are native, as with native `lean`: init replay and
  package compiles should get faster (to be measured: G6, the persistent compile and snapshot
  replay timings).
- **Heartbeats and cancellation** (review N3). Every interpreted call runs `check_system`, which
  counts one heartbeat and checks for an interrupt; a native callee does neither. Interpreted
  code that calls core functions spends fewer heartbeats (`maxHeartbeats` outcomes and
  `count_heartbeats` can move at the margin), and inside a core function a cancellation is
  noticed only where its compiled code checks for one — both as with native `lean`.
- **Stack** (review B2). A native frame takes far less engine stack than the interpreter's
  `eval_body` → `call` recursion, so interpreted recursion through core functions gains headroom.
  But the table takes the address of 29,538 more functions, so wasm-opt can no longer inline one
  into its only caller and drop it: a native path can gain a frame. 0036's guard is unchanged
  (no edit to `stackinfo.cpp`, `interrupt.cpp`, `CoreM.lean`, the probe or the stack sizes).
  Measured with 0039 (above, one build for both): +3.70 MB of code against r3 (estimated at most
  4.8 MB); on the paths of the four deep probes no frame was gained (the same frames per level).
- **Snapshots.** A partial application of such a function made by interpreted code is a closure
  over its native address now, not an interpreter stub carrying the declaration, so snapshot bytes
  differ (they are rebaked for the new build id anyway).
- **Name collisions** (review r0038). Lookups are by mangled name, so an interpreted declaration
  whose name mangles to a plain core function's — a file that does not import the defining
  Std/Lean module and defines the same name (without a package its declarations get the bare
  `l_` prefix) — now resolves to the core's native code: the core body runs, a call with another
  arity traps in `call_indirect`, and a constant of that name reads the function's table index
  as a cell. Native `lean` does the same (`dlsym` finds these symbols), and r3 had it already for
  boxed wrappers and cells; 0039b widens it by 29,538 names. With N3 above: adversarial input can
  reach core native code by a name collision, as natively; nothing guards against it.
- **Pairing with an import's oleans.** A runtime-only release requires that the stdlib's
  generated C changed no function other code reaches by name (0036 added names to
  `Lean/CoreM.c`; 0037 renumbered only private specializations of `Lean/Shell.c`). The rule now
  covers these functions too: before, a changed one ran from the oleans' IR.

**Gate**: `EXPECT_PLAIN_NATIVE = true` in `js/gate.mjs` (the switch that goes with
`INCLUDE_PLAIN`): G2 requires plain entries in the running table (and the build manifest's counts),
G5 requires `[symtab] hit plain l_Lean_Name_append` and `x0.x1.x2` from `symtabProbe 3`; G6 times
`symtabProbe 20000` (informational: r3 and 0039 interpret `Lean.Name.append`, 0039b calls it
natively). Every other check must pass unchanged; a moved heartbeat limit in their output is a
finding to explain (above), not to recalibrate away.

**Measured** with 0039 (above; 0039 alone was not built, so its share of the code section is not
separate): G6 24 ms; the stack margins, whose overflow traces show no interpreter frame, so 0039b
does not move them. **Still to be measured**: the persistent compile and init replay timings
against r3, QED64's compiler battery.

## 0040 — wasm: native Wasm exceptions (legacy encoding), with a per-build funclet guard (45f3669d64)

The runtime's C++ (kernel, IR interpreter, task manager, compactor, libc++) is compiled with
`-fwasm-exceptions -sWASM_LEGACY_EXCEPTIONS=1` instead of Emscripten's JS-based exceptions
(`-sDISABLE_EXCEPTION_CATCHING=0`). Under the JS mode every call out of a C++ frame with a landing
pad (a destructor or a `catch`; 6,124 call sites in 679 functions of the 0039b binary) went
wasm → JS `invoke_<sig>` trampoline → JS-to-wasm → callee, ~40 ns and three extra engine frames
each, with BigInt conversion of every 64-bit argument; a C++ throw was a JS throw caught by the
nearest trampoline. Now a throw is a wasm `throw` with the C++ tag and the engine unwinds. Generated
Lean C has no EH and compiles to the same objects (only function indices shift in the link).
Research and measurements behind the decision (2026-10-13, scratch relinks of 0039b's tree, Node
26.3): interpreted code ~6x, elaboration ~2.4x and `decide +kernel` ~3.4x faster, import unchanged;
glue −26 KB, `lean.wasm` −1.8%; 95 `invoke_*` and 13 EH-helper imports gone.

**Why the legacy encoding.** It keeps the floors (Chrome/Edge 95+, Firefox 100+, Node 17+; this
runtime's own floor stays Memory64's: Chrome 133, Firefox 134, Node 24); exnref, the standardised
encoding, would raise Chrome/Edge to 137 and Node to 24.15, and Emscripten's maintainers call it less
mature. Legacy is "deprecated" in the spec but shipped by V8 and SpiderMonkey with no removal date;
SpiderMonkey logs a deprecation warning per instantiation (console noise). The flag is pinned so
an Emscripten default flip cannot move the floor; a later move to exnref is a recompile of the C++.

**The old "miscompile"** (the comment this patch replaces; PATCHES "Explicitly unchanged"): both
recorded traps — `initialize_Lean_Shell` (upstream 1aa6036d1f, 2026-01) and
`readModuleDataPartsOfMod` (780a1d556f, 2026-07) — were direct calls from generated C to externs
with another arity. wasm-ld binds such a call to a `signature_mismatch:` stub whose body is
`unreachable` (a warning, not an error) and Binaryen inlines it at -O3; that traps in every EH mode
and was fixed by correcting the externs (aaa039aec9, b6b649fe64). Native EH was not retried after.
0039's check-link (B3) fails a build on such a stub, and today's tree has none.

**The funclet guard** (`check-eh-funclets.sh`, build.sh step 5b). Wasm EH uses LLVM's funclet IR,
where WinEHPrepare rewrites a call inside a catch handler that lacks its funclet bundle into
`unreachable`; two open LLVM bugs create such calls (#226286 GVN scalar PRE, #229448 JumpThreading;
both reproduce on emsdk 6.0.5 at -O2/-O3, silently). The guard compiles every C++ translation unit
of the build (exact commands from `compile_commands.json`, now exported) and the EH-mode system
libraries (libc++, libc++abi, libunwind via embuilder) a second time with `-mllvm -disable-cleanups`,
which switches that rewrite off: the objects must be identical, and three positive controls
(`eh-funclet-controls/`, the two bugs' shapes) must differ, or the build fails. Workaround flags
exist (`-mllvm -enable-scalar-pre=false`, `-mllvm -jump-threading-threshold=0`) if it ever fires.

**What changes on failure paths** (hosts: EMBED-RUNTIME.md §6):
- A V8 stack overflow (`RangeError`) is unchanged: V8 marks it uncatchable by wasm, so no C++
  handler or destructor runs and the pthread dies as before; traps likewise.
- A catchable JS exception crossing C++ frames — Emscripten's `"unwind"` (a pthread's `exit()`, a
  thread woken after another thread crashed) or `ExitStatus` — now runs the destructors of the frames
  it crosses (it passed through untouched before); `catch (...)` still does not catch it.
- Such an exception crossing a `noexcept` frame now ends in `std::terminate` → `abort()`. Measured:
  in persistent mode (`lean_wasm_compile` on the main runtime thread, 0037), a task pthread that
  overflows while the main thread waits in `Task.get` (libc++ `condition_variable::wait`, noexcept)
  now aborts the runtime (`onAbort`) where it ended in `unwind` before. QED64 decided (2026-10-13)
  to report it as a runtime abort (its persistent mode runs only the header compile in the browser).
- `abort()` escapes as `RuntimeError: unreachable` instead of `RuntimeError: Aborted(...)`;
  `onAbort` and its printed line are unchanged. An uncaught C++ exception reaches JS as a
  `WebAssembly.Exception` (before: Emscripten's `CppException`), both without a message.
- An indirect call with the wrong arity traps in `call_indirect`; through a JS trampoline surplus
  arguments used to be dropped silently.
- 0036's engine-stack probe catches its own RangeError in JS and is unaffected; unwinding a C++
  throw near the limit needs ~0.6 KB instead of 25–47 KB, so the guard's 128 KiB reserve only gains.

**Gate**: the kernel deep-recursion probe (`js/probes/deep-recursion-kernel.lean`) no longer
overflowed Chrome's stack at Fin 120 — the kernel's check got ~2x cheaper in stack — so it is
Fin 320 now (on 0040: Fin 160-320 trip the guard at 0.68 MiB, Fin 240 checks at 0.9, Fin 320 still
trips at 1.0), and the two kernel checks (the kernel's error; the kernel guard's counted refusal)
keep testing the guard. Every other check passes unchanged.

**Measured** on the first build (64d6ebb7b4, build id `wasm64-086ef19b1135d43b`, 2026-10-13, host
Node 26.3), against 0039b's (570d16f926):
- Sizes: `lean.wasm` 106,335,440 bytes (108,059,248), `lean.js` 119,980 (146,441). The link adds no
  undefined symbol; the funclet guard passed: 3 controls differ; 123 C++ translation units, libc++
  57, libc++abi 19 and libunwind 1 sources identical. Gate: 56 checks passed.
- Speed (one file, `Elab.async false`, 3 alternating runs each, phases by `IO.monoMsNow`; same
  output): interpreted `#eval fib 27` 948-951 ms → 164-167 ms; 30 `omega` + 2 `simp` + `decide`
  over Fin 6 1112-1124 → 452-503 ms; `decide +kernel` over Fin 60 × Fin 60 2182-2219 → 644 ms (one
  run 1058); the whole run 7.4-8.8 s → 4.0-4.6 s. Boot and `import Lean` unchanged.
- Stack margins (`stack-margin.mjs`, MiB, survives / passes; Chrome 0.68):

  | probe | 0039b | 0040 |
  |---|---|---|
  | `decide`, Fin 40 × Fin 40 | 0.427 / 0.998 | 0.427 / 1.042 |
  | 25 nested `have … := by` | 0.661 / 2.917 | 0.661 / 2.683 |
  | `<;>` chain of 25 `trivial` | 0.427 / 1.174 | 0.427 / 1.086 |
  | `decide +kernel`, Fin 120 × Fin 120 | 0.427 / 1.233 | 0.427 / 0.647 |

  The guard's floor does not move; the kernel check now fits Chrome's stack at that size; the
  elaborator probes need 7-8% less; the Meta `decide` probe 4% more (deterministic; not explained).
- Persistent mode (`persistent-probe --cases ok, task overflow, ok`): 0039b ends the overflow case
  in `unwind` and goes on; 0040 aborts (`ABORT:`), as described above.

**Still to be measured** (by the hosts, on the staged release): Chrome and Firefox (QED64), the
lean4game lanes, the proof sheets' Chrome lane.

## 0041 — wasm: keep the closure-application entry points out of line (engine stack per monadic level) (53cb11e6d6)

**What happened.** Binaryen's post-link optimizer inlines a function that has a single caller,
whatever its size. In r3's `MAIN_MODULE` link every `lean_*` runtime function was exported, which
kept them out of line. Since 0039's static link nothing exports them, and `lean_apply_n` became the
only caller of `lean_apply_16` and `lean_apply_m`. Both were folded into it: `lean_apply_n` went
from 0 locals and 913 bytes to 26 locals and 4,037 bytes. `lean_apply_n` runs at every level of a
monadic continuation chain (EIO `bind` → `lean_apply_2` → `lean_apply_n` → `lean_apply_1` →
`bind` …), the shape a generic `for`/`forM` over a monad takes when it is not specialized, e.g. in
interpreted package code. Every r3-exported function was compared by its locals: `lean_apply_n` is
the only runtime function whose frame grew this way.

**How it showed.** The proof sheets' bake of a 4,824-module entry (WaterproofGenre, Verbose,
Bewijzen.Customlib): `finalizeImport` runs an interpreted extension's import handler whose loop
nests one level per imported module, and it overflowed Node's default 4 MB pthread stack
(`RangeError` in post-import setup) on 0039b and 0040, where e1a79c1 gets through. Not native
exceptions: 0039b (JS exceptions) fails the same way. The browser never runs that handler for the
proof sheets (every sheet boots from a snapshot of its exact import closure).

**The fix.** No source change: `lean_apply_16` and `lean_apply_m` are exported, in their own
section of `src/emscripten-exports.seed.txt` ("kept out of line", not called from JavaScript; the
contract copy in `js/runtime-contract.mjs` tags them 0041, which only the repository's seed
requires, since no glue marker tells 0041 from 0040). An exported function is never inlined into
its caller, as in r3. Two other approaches were measured and dropped: calling `lean_apply_m`
through a volatile pointer (C++) left `lean_apply_16` inlined and moved nothing; a global cap on
one-caller inlining (`--one-caller-inline-max-function-size` at 20, 100 or 400) fixed the chain but
made the elaborator probes need 3-11% more stack (fin 1.071, have 2.874-3.005, chain 1.159-1.203
MiB), because inlining large single-caller Lean functions saves frames there.

**Guard.** `check-link.py` (build.sh, after the link) fails the build when any of `lean_apply_1` …
`lean_apply_16`, `lean_apply_m`, `lean_apply_n` is missing from `lean.js.symbols`, i.e. inlined
into its caller: it fails on the 0040 binary (`lean_apply_16`, `lean_apply_m`) and passes on 0041.

**Measured** on the first build (53cb11e6d6, build id `wasm64-5650321f3f58aeb0`, 2026-10-15, host Node 26.3):
- Sizes: `lean.wasm` 106,335,445 bytes, `lean.js` 120,123 (two more bindings). `lean_apply_n` 0
  locals and 913 bytes, as r3; EIO `bind` inlined into its boxed wrapper, as in r3 and 0040.
- The proof sheets' entry (their probe, QED64's node-runner, a `worker_threads` stack wrapper; full
  traces): bytes per chain level and the entry at Node's default 4 MB:

  | runtime | bytes per level | entry at 4 MB |
  |---|---|---|
  | e1a79c1 (r3 era) | ~637 (3,292 levels in 2 MB) | passes (needs 2-3 MB) |
  | 0039b | ~909 | overflows (passes at 6 MB) |
  | 0040 | ~1,002 | overflows |
  | 0041 | ~706 (2,970 levels in 2 MB) | passes |

  The ~70 B per level still above e1a79c1 are 0040's native-exception frames.
- Stack margins (`stack-margin.mjs`, survives / passes, MiB; Chrome 0.68): identical to 0040's —
  fin 0.427 / 1.042, have 0.661 / 2.683, chain 0.427 / 1.086, kernel 0.427 / 0.647. Interpreted
  recursion (`sumTo`, deepest at 0.68 MiB): 812, as 0040 (e1a79c1: 412).
- Speed (0040's perf file, 3 alternating rounds against 0040): the same within noise.
- Gate: 56 checks passed (deep recursion at Chrome's stack: the Meta and kernel errors, the thread alive).
