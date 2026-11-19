# Embedding the wasm64 runtime

The contract between a released runtime (`lean.js` + `lean.wasm`, identified by
its build id) and the code that hosts it: a browser Worker (QED64's
`public/workers/lean.worker.js`, lean4game's copy of it) or Node
(`js/node-runner.mjs`, `js/persistent-probe.mjs`). Obtaining and verifying the
bytes is `js/formats/`; serving them is `js/formats/HOSTING.md`.

There is no ABI or version export: a host feature-detects
(`typeof M._lean_… === "function"`) and refuses a runtime that lacks what it
needs, naming the patch that added it (listed below). The patch level of a
release is `release.json` `kernel.patch`.

Layers, so a host knows what it may rely on:

- **[RT]** — this runtime's ABI, changed only with a `PATCHES.md` entry;
- **[GLUE]** — Emscripten 7.0.0 glue internals some hosts reach into (6.0.5's in the runtimes released before the
  emsdk 7 move): valid for this toolchain image (`release.json` `docker`), not a promise. Since emsdk 6.0.13 a
  Terser pass compresses the -O3 glue, so a top-level name only a host reads keeps no global binding, and one
  the glue uses once may be folded into its use: reach what §1 lists through `Module`;
- **[HOST]** — what QED64's worker does (policy, not requirement).

## 1. The binary [RT]

| | |
|---|---|
| Target | `wasm64-unknown-emscripten`: Memory64, shared memory, pthreads, `-sPROXY_TO_PTHREAD=1` (`main` runs on a pthread) |
| Memory import | `WebAssembly.Memory({shared: true, address: "i64", initial: ≥ 2048n, maximum: ≤ 262144n})` pages (128 MiB … 16 GiB), passed as `Module.wasmMemory`; the glue puts it in the import object itself (its module and field names are minified since 0039, `env.memory` before). Without a host `wasmMemory` the glue creates `{initial: INITIAL_MEMORY ‖ 128 MiB, maximum: 262144n}`. The runtime manifest records these values (`memory`). |
| Threads | a pool of 24 pthread Workers created at load (0019; from 0038 until the architecture review's D3b a host could size it), growing on demand; 16 MiB main/application stack, 8 MiB per pthread (§3.6) |
| Exit | `-sEXIT_RUNTIME=1` with the keepalive patch 0020 in the build image (§5) |
| Filesystems | MEMFS (root), NODEFS, WORKERFS. Hosts mount the last two as `Module.NODEFS` and `Module.WORKERFS` (exported since the emsdk 7 move). Emsdk 6.0.13 removed `FS.filesystems` (emscripten#27940), which the 6.0.5 runtimes still have: a host that serves both reads `Module.X ?? FS.filesystems.X` |
| Runtime methods | `callMain, FS, ENV, ccall, getValue, setValue, UTF8ToString, stringToNewUTF8, NODEFS, WORKERFS`, read on `Module`: since the emsdk 7 move `getValue`, `setValue`, `ccall` and `stringToNewUTF8` have no global binding (the Terser pass inlines each into its `Module` assignment) |
| Exports | The JavaScript contract (0039): `src/emscripten-exports.seed.txt`, the entry points of §2 plus the Emscripten built-ins hosts reach (§5), and since 0041 two runtime functions no host calls, `_lean_apply_16` and `_lean_apply_m`, exported only so that Binaryen keeps them out of `lean_apply_n` (engine stack per monadic level; PATCHES.md 0041). Reach every export through `Module` (`M._x`): since the emsdk 7 move only `_malloc`, `_pthread_self`, `__emscripten_proxy_main` and `__emscripten_check_mailbox`, which the glue reads itself, keep a global binding; `_free`, `_main` and every `_lean_*` are on `Module` alone (`js/exports-audit.mjs` lists a consumer's bare reads). Lean's own native code is not exported: the IR interpreter finds boxed wrappers, all-object functions without one (since 0039b), `@[export]` functions, constant cells and module initializers in a table linked into the module (`gen-exports.py --symtab`, `library/wasm_symtab.cpp`; until 0039 the others were ~106k exports, and the functions without a wrapper ran interpreted). Interpreted code thus calls every function of Init/Std/Lean natively; package code, and what the C keeps file-local (closed terms), runs through its `.ir` (interpreted). |
| Linking | Static since 0039 (no `MAIN_MODULE`: no `dylink.0` section, no GOT, no side modules — `Dynlib.load` fails with an IO error). At -O3 the raw wasm import and export names are minified (`a`, `b`, …): reach an export through the glue's `Module["_x"]`, never `wasmExports["x"]`. `bin/lean.js.symbols` in the build tree maps every function index to its name (crash triage; not released). |
| Olean trust | githash check compiled off; the SHA-256 manifests and the pack ↔ runtime `leanVersion` rule are the trust root (`js/formats/README.md`) |

The CMake default maximum is 12 GiB; released runtimes are configured by
`docker-wasm64/configure-qed64.sh` with 16 GiB (`maximum: 262144n`), and a host
may import any memory whose maximum is ≤ that.

## 2. Calling convention [RT]

- Every pointer, `size_t` and `usize` parameter is **i64: pass a BigInt** (a
  Number throws `TypeError`); `uint32_t`/`unsigned` are Numbers. i64 results
  come back as BigInt. Exception [GLUE]: `_malloc` and `_free` are wrapped —
  they accept Number or BigInt, and `_malloc` returns a Number (`Module._free`:
  it has no global since the emsdk 7 move).
- `Module.getValue(addr, type)` takes a Number address.
- Lean objects: arguments are owned (consumed) unless the Lean signature says
  `@&`. An `IO α` result is a constructor: tag byte at offset 7 (`0` ok, `1`
  error), field 0 at offset 8. A `UInt32` inside it is a boxed scalar
  `(n << 1) | 1`; decode with `Number(BigInt(M.getValue(ptr + 8, "i64")) >> 1n)`.
  No export takes an IO world argument. `_lean_io_result_show_error(res)` prints
  an error result.

### The entry points

| Export | Signature (JS) | Returns | Since |
|---|---|---|---|
| `_lean_initialize_runtime_module`, `_lean_initialize`, `_lean_io_mark_end_initialization`, `_lean_init_task_manager` | `()` | — | upstream |
| `_lean_init_task_manager_using(n)` | `(u32)` | — : the task manager with `n` standard workers instead of the hardware concurrency | upstream |
| `_lean_io_result_show_error(res)` | `(i64)` | — : prints an `IO` error result | upstream |
| `_lean_enable_initializer_execution` | `()` | `BaseIO Unit` (ignore) | upstream |
| `_lean_init_search_path` | `()` | `IO Unit` — check the tag | upstream |
| `_lean_mk_string(cstr)` | `(i64)` | a Lean `String` (owned) | upstream |
| `_lean_wasm_load_snapshot_mem(ptr, size, flags)` | `(i64, i64, i64)` | `IO UInt32`: 0 loaded, 1 failed (diagnostic on stderr); `flags` is ignored since R11a, pass `1n` | 0013/0014/0016 |
| `_lean_wasm_load_snapshot(path)` | `(i64 String)` | `IO UInt32` — a VFS path; Node tools only | 0013 |
| `_lean_wasm_compile(code, fileName)` | `(i64 String, i64 String)` | `IO UInt32`: 0 no errors, 1 errors (not a count); messages as JSON lines on stdout, every message of the file once, in the native frontend's order — including those of tasks a command started (`Elab.async` proofs, kernel checks, linters); it returns after every task still recorded for a command has finished (one that elaboration discarded, e.g. by backtracking, may still be running), so call it only on a thread that can block (Node's main thread, a DedicatedWorker), never from a proxied or mailbox callback | 0010/0032/0034/0037 |
| `_lean_wasm_shell_mark_preinitialized()` | `()` | — | 0031 |
| `_lean_browser64_configure_input_ring(ptr, capacity)` | `(i64, u32)` | `u32`: 0, or `EINVAL` (28) | 0031 |
| `_lean_wasm_task_manager_parked_threads()` | `()` | `u32`: pthreads parked by the task manager | 0035 |
| `_lean_wasm_symtab_stats(key)` | `(u32)` | `f64`: the native-symbol table's gauges: 0..6 lookups that found an entry of kind boxed, plain, export, cell, init, init_rt, init_meta; 7 lookups that found none; 8 its entries; 9..15 its entries by kind; 16 its self-check's status (0 intact); 17, 18 the high and low 32 bits of the FNV-1a-64 the check decoded (the build's `lib/temp/lean_wasm_symtab.json` has the same); -1 for another key. Keys 9..18 run the self-check once (a few ms) | 0039 |
| `_lean_wasm_symtab_selfcheck(counts, fnv)` | `(i64, i64)` | `u32`: a full decode of the table now (names strictly increasing, kinds in range, every address set, the FNV equal to the generator's): 0 intact, else the first defect (1 empty, 2 a name too long, 3 a block off its offset, 4 out of order, 5 a kind out of range, 6 a null address, 7 another FNV). `counts` (7 × u64) and `fnv` (u64) may be `0n` | 0039 |
| `callMain(args)` | `string[]` | runs `lean_main` on the application pthread | — |

The parked-thread count is lock-free: a host may call it from its main JS thread at any time, also
while Lean threads hold the task manager's lock (which that thread must never wait for). So are the
0039 table's gauges: the table is immutable link-time data, and a lookup takes no lock and calls no
JavaScript. (0038 added three more counters, `_lean_wasm_task_manager_stat`,
`_lean_wasm_engine_probes` and `_lean_wasm_engine_guard_trips`; no host called them, and they left
with the architecture review's D3b. A runtime from 0038 up to the one before D3b still exports them.)

Since 0039 the module also binds on `Module` the three Emscripten built-ins hosts reach
([GLUE], §5): `__emscripten_proxy_main` (what `callMain` runs), `__emscripten_check_mailbox` and
`_pthread_self`. They stay top-level glue bindings as well, which is how QED64 reaches them (in the
emsdk 7 glue they and `_malloc` are the only exports that do).

`_mem` loads: `ptr` is a `_malloc`ed buffer holding a whole `.snap` file of
`size` bytes; on success it becomes the loaded region's memory (never free or
reuse it). Every load replays the `[init]` attributes of the snapshot's
modules. `flags` is ignored since the architecture review's R11a, which removed
0016's switch; pass `1n`, which a runtime before R11a needs (its bit 0 ran that
replay, which compiles need). The signature keeps its three arguments. QED64's
`snapshot-probe --init-flags <n>` passes `n` as `flags`, so that flag does
nothing since R11a. A snapshot is a memory image of one binary: its index
entry's `runtime` must equal this build id, and the runtime itself checks only
the olean header (`"olean"`, version 2/3, flags 0). Each load publishes its
environment to the covering-environment registry the language server's header
resolution consults (0031/0032).

## 3. Boot

### 3.1 Module and environment

Install `Module` **before** the glue is evaluated (browser:
`self.Module = {…}; importScripts(glueUrl)`; Node: `globalThis.Module = {…}`
then `vm.runInThisContext(lean.js)` with `require`, `__filename`, `__dirname`
shims — see `js/node-runner.mjs`). Keys the glue reads:

| Key | Use |
|---|---|
| `wasmMemory` | the shared i64 memory (§1); pthreads receive it |
| `INITIAL_MEMORY` | only without `wasmMemory` |
| `noInitialRun: true` | persistent hosts: do not run `main` at load |
| `arguments` | argv of the implicit `main` (one-shot CLI) |
| `locateFile(path)` | where `lean.wasm` is (QED64: a Blob URL of verified bytes) |
| `mainScriptUrlOrBlob` | the script **every pthread Worker** loads: the glue itself, or a prelude that `importScripts` it in the same global scope |
| `print`, `printErr` | stdout / stderr lines (read once, at glue load) |
| `preRun` | mounts and environment variables — the only safe point for both |
| `onRuntimeInitialized` | the C-API initialization (§3.2) |
| `onAbort(what)` | the runtime is dead |
| `onExit(code)` | fires **only when no keepalive is held** (§5) |

The glue no longer reads `pthreadPoolSize`: from 0038 until the architecture review's D3b it sized
the pool (§3.6), and no host set it.

**`ENV` is not an input.** The glue replaces `Module.ENV` with its own object at
load; an `ENV` passed in the `Module` literal is discarded. Set variables by
mutating `Module.ENV` in `preRun`. Two readers see them:

- Lean's `IO.getEnv` reads the JS `ENV` live (proxied to the main runtime
  thread); an empty string reads as unset.
- C `getenv` reads libc's `environ`, built from `ENV` **once**, during start-up:
  only values present in `preRun` are seen.

| Variable | Reader | Effect on this runtime |
|---|---|---|
| `LEAN_PATH` | Lean | `:`-separated library dirs, prepended to the built-in `/lib/lean` (§3.3) |
| `LEAN_WASM_PARKED_DEDICATED` | C, at task-manager creation | idle dedicated task threads kept for reuse; clamped to 64; **default 0** — parked pthreads outlive a page reload by the browser's ~2 s termination grace, and overlapping the next boot they exhausted V8's pointer-compression cage (0035b) |
| `LEAN_COMPACTOR_RESERVE` | C | bytes reserved up front when saving a snapshot (`--incr-header-save`); a doubling buffer needs old + new at once (bakes use 3.5 GiB). A runtime linked with emsdk 6.0.5's allocator takes less than 4 GiB (4 GiB itself fails: PATCHES.md 0043); since the emsdk 7 move, what the 16 GiB address space holds beside the environment |
| `LEAN_WASM_STACK_PROBE_SLOTS` | C, once | headroom (in 8-byte argument slots, default 16384 = 128 KiB) the engine-stack probe demands (§6); 0 disables it — for calibration only (0036) |
| `LEAN_WASM_SYMTAB_TRACE` | C, at the first native-symbol lookup | diagnosis only (0039): print the IR interpreter's lookups in the native-symbol table on stderr, `[symtab] miss - <name>` and `[symtab] hit <kind> <name>`. `miss`, `hit` or `all`, each optionally `:<prefix>,<prefix>…` (only names with one of these prefixes), clauses joined by `;`: `miss:;hit:l_Lean_versionString`. Unset or empty: off; anything else: off, with one warning. A miss is normal: every lookup of a function without a boxed wrapper first misses the wrapper, and package code (`lp_…`) is never native |
| `LEAN_NAT_MAX_SIZE`, `LEAN_STACK_SIZE_KB` | C | upstream semantics (the latter on the `main` path only) |
| `LEAN_IMPORT_WORKERS` | Lean | parallel region reads of a snapshot with dependency files; not on the in-memory path |
| `LEAN_NUM_THREADS`, `LEAN_MAIN_USE_THREAD`, `LEAN_ABORT_ON_PANIC`, `LEAN_BACKTRACE*` | C | **inert on Emscripten** — not knobs |
| `QED64_ALLOW_LEGACY_IMPORTS` | none since R11a | **no effect**: legacy (non-`module`) imports are always tolerated on wasm targets, and native64 keeps stock's guard (before R11a only native64 read it). QED64's `bake-snapshot --allow-legacy-imports`, which sets it, does nothing either |
| `LEAN_WASM_STD_SURPLUS_EXIT`, `LEAN_WASM_PARKED_IDLE_MS` | none since D3b | **no effect**: 0038's opt-in exits of surplus standard workers and of idle parked threads, which no host turned on, left with the architecture review's D3b (§3.6) |

`LEAN_WASM_PARKED_DEDICATED` takes decimal digits only (since 0038): anything else (`-1`, `1e3`,
` 1`, `true`) is off, with one line on stderr, as unset or empty is.

### 3.2 Persistent initialization (`onRuntimeInitialized`)

1. [HOST] A persistent host that returns to the event loop without `main`
   running pushes one runtime keepalive first (`runtimeKeepalivePush()`):
   otherwise the first proxied call serviced from a pthread ends in
   `maybeExit()` and tears the runtime down mid-call (§5).
2. `_lean_initialize_runtime_module()`, `_lean_initialize()`,
   `_lean_io_mark_end_initialization()`, `_lean_init_task_manager()`,
   `_lean_enable_initializer_execution()`, then `_lean_init_search_path()` —
   check its tag.
3. Snapshots (§2), then either the resident language server (§3.4) or
   persistent compiles (`_lean_wasm_compile`; the first compile of an import
   set pays the import, repeats reuse it).

### 3.3 Filesystem

- `IO.appPath` is `/bin/lean.wasm` in the browser, so the built-in library dir
  is `/lib/lean`; `/bin` must exist (`lean_init_search_path` stats it).
- Each `LEAN_PATH` dir holds `<Module path>.olean` with its `.ir`,
  `.olean.server`, `.olean.private` facets. A host that mounts packs mounts
  each read-only (`Module.WORKERFS`, by the manifest's byte-range table) at its
  own dir. QED64's pages mount none since 2026-11: every environment they load is
  a snapshot.
- WORKERFS works only in a worker, and reads from Lean pthreads are proxied to
  the main runtime thread — olean imports on elaboration threads stall there.
  The resident language server therefore never imports oleans: header
  resolution uses only environments loaded from snapshots (§3.4).
- In `main` (both paths), a browser prologue creates `/home /tmp /workspace
  /bin /lib/lean/library`, `chdir`s to `/workspace` and sets `LEAN_PATH` to
  `/lib/lean/library` if it is empty; the Node prologue copies
  `process.env.LEAN_PATH` and mounts the host's `/home` and `/tmp`.
- Node: on a pthread `__filename` is the host path of `lean.js`, so Node hosts
  mirror the artifact's `bin/` at its own host path (`node-runner.mjs` does —
  only `bin/`: the built-in search entry is `<that>/../lib/lean`, which a host
  with its own library keeps out of reach). On macOS `/tmp` and `/home` are
  symlinks, and the prologue's NODEFS mounts of them only work with their
  targets as roots (`node-runner.mjs` substitutes them).

### 3.4 The resident language server (0031/0032)

1. `_lean_wasm_shell_mark_preinitialized()` — `main` must not initialize (or
   ever finalize) again.
2. `ptr = _malloc(16 + capacity)`; `_lean_browser64_configure_input_ring(ptr,
   capacity)` must return 0 (§4).
3. `callMain(["--worker", "-Dserver.reportDelayMs=0"])`. `reportDelayMs=0` is
   required: the reporter's first act is a timed sleep on a task pthread, and
   timed sleeps on task pthreads do not wake in this build.
4. Write `initialize` and then `textDocument/didOpen` into the ring, nothing
   between them. The FileWorker reads both directly and **never answers
   `initialize`** (a watchdog normally does; QED64 answers it itself). Do not
   send `initialized`.
5. Afterwards only `textDocument/didChange`, `$/cancelRequest`,
   `$/lean/staleDependency`, `$/lean/rpc/release` and `$/lean/rpc/keepAlive`
   notifications are allowed — **any other notification ends the worker**. One
   document per session. Requests are answered on stdout.
6. Header resolution: the exact import set, else the smallest covering
   registered environment, else refused with one error on the header,
   `modules #[…] are not loaded in this session` (consumers match that
   phrase); each resolution sends `$/qed64/headerStatus {version, mode:
   "exact" | "covered" | "refused", key, moduleCount, missing, ms}`, where
   `version` is that of the document whose header setup it reports. A header
   change re-runs setup in place; a body edit reuses the setup and sends no
   status.

The runtime allows re-entering `main` for an in-process session replacement
after the FileWorker exits (a new ring, `callMain` again); QED64 instead runs
one session per Worker.

### 3.5 One-shot CLI (Node)

`Module.arguments = [<lean args>]` without `noInitialRun`: `main` initializes
for real and runs the ordinary CLI (`-o x.olean x.lean`,
`--incr-header-save=<file> x.lean` to bake a snapshot, …). **The process never
exits after `main`** (the keepalive swallows the exit): judge the job by its
output and reap the process, as `gate.mjs` does.

`main`'s Node prologue (`src/util/shell.cpp`), which runs after `preRun`,
copies the HOST `LEAN_PATH` into the VFS environment, mounts the host's `/home`
and `/tmp` (NODEFS) and `chdir`s the VFS to the host cwd. A Node host that wants
its own library therefore sets `process.env.LEAN_PATH` itself, and chooses the
VFS cwd through the host cwd — `node-runner.mjs` pins `LEAN_PATH=/lib/lean`
(the `--lib` tree; with `--lib` it also shadows the artifact's own `lib/lean`
wherever the VFS could reach it, so `--lib` is the only library Lean sees) and
runs Lean at the VFS root `/`, with the work dir mounted at `/work` — QED64's
runner layout. Lean names the main module after the input's path relative to
the cwd (`moduleNameOfFileName`): at `/`, `/work/probe.lean` is `work.probe`
and `-o /work/X.olean /work/X.lean` works; anywhere else the name falls back
to `_stdin` (with `-o`: an error), and the snapshot a bake writes records it,
so only the `/` layout bakes byte-identically to QED64's runner. Relative Lean
paths resolve in the in-memory root: pass `/work/…` paths (`--root=/work`
names `/work/X.lean` `X`). `LEAN4_WASM64_CWD=work` keeps the earlier layout
(the work dir, mirrored at its host path, is the cwd, so relative paths land
in it).

### 3.6 Threads and Workers

Every live pthread holds one Emscripten Worker, and in a browser each Worker is an isolate in the
renderer's one pointer-compression cage (§6).

- **The pool** [RT]: 24 Workers are created, and load the module, while the runtime starts
  (`-sPTHREAD_POOL_SIZE=24`, 0019). A thread then starts on an idle pool Worker; when none is idle
  it gets a new Worker, which boots first. A finished thread's Worker returns to the pool; nothing
  terminates Workers before exit. Hosts count on the 24 (QED64's edit hold: fewer than 6 free pool
  Workers); the gate checks the glue allocates them.
- **Threads** [RT]:
  - Standard workers serve pool tasks. Their cap is the task manager's worker count
    (`_lean_init_task_manager_using(n)`, else the hardware concurrency) plus one per pool task
    blocked in `Task.get`, and such a block starts a worker when none is idle, so a burst of
    nested `Task.get`s leaves workers beyond the cap. They stay for the life of the process, each
    holding a Worker, and the next burst reuses them.
  - Dedicated threads park only with `LEAN_WASM_PARKED_DEDICATED=<n>` (default 0; through
    `Module.ENV` in `preRun`, §3.1; measure a page reload with it before turning it on, §6,
    0035b). A parked thread waits for its next task as long as the runtime lives.
- **Gauges** [RT]: `_lean_wasm_task_manager_parked_threads()` (§2), lock-free. Emscripten's own
  `PThread.unusedWorkers` (idle pool Workers) and `PThread.pthreads` (Workers running a thread)
  [GLUE] count the Workers.
- **Node**: `node-runner.mjs` and `persistent-probe.mjs` copy `LEAN_WASM_PARKED_DEDICATED`,
  `LEAN_WASM_STACK_PROBE_SLOTS` and (0039) `LEAN_WASM_SYMTAB_TRACE` into `Module.ENV`
  (`js/runtime-knobs.mjs`); with `QED64_COUNT_PTHREADS=1`, node-runner answers a printed line
  containing `[pthreads?]` with `[pthreads] created=<n>`.
- **Gone since D3b** (the architecture review's; no host used them): 0038's host-sized pool
  (`Module.pthreadPoolSize`, node-runner's `LEAN4_WASM64_PTHREAD_POOL`), its opt-in exits of
  surplus standard workers (`LEAN_WASM_STD_SURPLUS_EXIT`) and of idle parked threads
  (`LEAN_WASM_PARKED_IDLE_MS`), and its counters (`_lean_wasm_task_manager_stat`,
  `_lean_wasm_engine_probes`, `_lean_wasm_engine_guard_trips`; node-runner's
  `LEAN4_WASM64_RTSTATS`).

## 4. The stdin ring (0031) [RT]

```
ptr+0   u32 READ     consumer cursor (Lean)    [0, capacity)
ptr+4   u32 WRITE    producer cursor (host)    [0, capacity)
ptr+8   u32 CLOSED   0 open; non-zero: EOF after the ring drains
ptr+12  u32 WAKE     producer increments, then notifies (futex word)
ptr+16  u8[capacity] the ring; READ == WRITE is empty, so capacity-1 bytes fit
```

Producer (the host), per whole frame `Content-Length: N\r\n\r\n<UTF-8 JSON>`,
never interleaving two frames:

```
r = Atomics.load(ctrl, READ); w = Atomics.load(ctrl, WRITE)
free = (r - w - 1 + cap) % cap
if free == 0: retry later (setTimeout)            // POLL — never Atomics.wait here
n = min(free, cap - w, remaining); copy; Atomics.store(ctrl, WRITE, (w + n) % cap)
Atomics.add(ctrl, WAKE, 1); Atomics.notify(ctrl, WAKE)
```

The thread that runs the glue is Emscripten's main runtime thread: Lean's
pthreads proxy stdout, file-system calls and `pthread_create` through it, so it
must never block. Re-take `memory.buffer` views on every access (growth
replaces the buffer). Lean fills each read exactly (an LSP body is one read of
`Content-Length` bytes) unless `CLOSED` is seen after the ring drains, and
wakes futex waiters on `READ` after consuming. QED64 uses a 64 MiB ring and
refuses frames over half of it; it never sets `CLOSED` (a session ends with
its Worker).

## 5. stdout, stderr, the mailbox and exit

- **stdout** [RT/GLUE]: every write from a pthread is a synchronous proxied
  `fd_write` to the main runtime thread, then a line-buffered TTY (`print` per
  line, NUL bytes dropped). An LSP frame body has no trailing newline, so the
  last frame of a burst waits in that buffer: QED64 replaces the TTY's
  `put_char` and decodes `Content-Length` frames byte by byte
  (`lsp-frames.js`). The glue does not honour `Module.stdout`.
- **Exit** [GLUE]: with a keepalive held, `_proc_exit` never calls
  `Module.onExit`; a FileWorker exit is visible only by hooking the proxied
  exit functions (QED64 wraps the `proxiedFunctionTable` entries equal to
  `_proc_exit` and `exitOnMainThread`, at any index, since its 58e1918; older
  copies of its worker, lean4game's pin among them, wrap `[0]` and `[1]`).
  Find them by identity, never by position: emsdk 7 sorts the table
  (emscripten#28059, #27995), which starts `[exitOnMainThread, _proc_exit, …]`
  and holds function expressions the Terser pass inlined. A worker that hooks
  `[0]` and `[1]` sees no FileWorker exit on such a runtime: it re-pins first.
- **Mailbox** [GLUE, HARDENING #52 in QED64]: a lost main-thread mailbox
  wakeup can freeze every Lean pthread. QED64 switches the glue to
  postMessage notifications (`waitAsyncPolyfilled = true` in `preRun`) and
  kicks `__emscripten_check_mailbox()` from a 1 s timer. Kernel patch 0035
  narrows the trigger; it does not remove it. Every pthread arms an
  `Atomics.waitAsync` on its own thread block when it starts, unless its own
  realm's `waitAsyncPolyfilled` is true, and a stale one left on a freed block
  can swallow a later wakeup (emscripten#27492). Emsdk 7's glue clears it when
  the thread's Worker returns to the pool (#27501, 6.0.7), but that clear is
  skipped while the runtime thread's `waitAsyncPolyfilled` is true, as in
  QED64's message mode. So QED64 now also sets the flag in every pthread realm,
  in its pthread prelude right after the glue loads (QED64 f4cd57f, HARDENING
  #94): no pthread arms a native waiter. S6's check (the flag present and
  mutable) covers both uses.
- **Growable array buffers** [GLUE]: every emsdk 7 link suggests
  `-sGROWABLE_ARRAYBUFFERS=2` (`-Wpthreads-mem-growth`). The build does not
  follow it: it would raise the floors to Chrome 144, Firefox 145, Safari 26.2
  and Node 26, and it makes `waitAsyncPolyfilled` a constant that the Terser
  pass folds away, which costs QED64 its message mode (#52; its `typeof` guard
  fails and its boot line shows a WARNING).
- **The [GLUE] surface the gate checks** (its S6, `js/runtime-contract.mjs`, on every runtime since
  0039 linked statically and its glue is generated anew; the shapes of emsdk 6.0.5's glue and of
  7.0.0's both pass), in two lines. First, apart from the export contract, the names QED64's worker
  reads (the architecture review's K6: rows 1-4 of QED64's `docs/ARCHITECTURE.md` "Glue internals
  the worker reads"; a named export is only the worker's fallback): a top-level
  `proxiedFunctionTable` with `_proc_exit` and `exitOnMainThread` among its entries, at any index,
  both top-level functions (the exit hook); `waitAsyncPolyfilled` and `checkMailbox` holding a
  keepalive around its callback (0020: pushed before, popped after) and calling
  `__emscripten_check_mailbox()` (message mode); a top-level binding `__emscripten_check_mailbox`
  (the kick); a top-level `PThread` with `unusedWorkers` and `pthreads` (the pool sample behind the
  edit hold). Then the rest: a classic script that adopts the host's `Module` (`!=` in 6.0.5's
  glue, `!==` in 7.0.0's); pthread Workers named `"em-pthread"`; the runtime methods of §1 assigned
  on `Module`, whatever the right-hand side, and the `Module` keys of §3.1; a top-level `wasmMemory`
  that adopts `Module.wasmMemory`; `FS` (`mkdirTree`, `makedev`) with `WORKERFS` and `NODEFS`
  exported on `Module` (emsdk 7) or held in `FS.filesystems` (6.0.5); `TTY` with
  `ttys[…].ops.put_char` called per byte; `callMain` running `_emscripten_proxy_main`;
  `runtimeKeepalivePush`; `ABORT`; `class ExitStatus`; the thrown string `"unwind"`; a pthread
  Worker's `onerror` rethrowing; a top-level `spawnThread` the glue calls by name (node-runner's
  `QED64_COUNT_PTHREADS`); and what QED64's worker before its 58e1918 and R7a (f83bc70) reads, in
  the copy lean4game pins (QED64 73d7f3b): `PThread`'s `allocateUnusedWorker`, `getNewWorker` and
  `returnWorkerToPool` called as `PThread.x()`, `__emscripten_thread_mailbox_await` with a literal
  `pthread_ptr+N`, and a top-level `_pthread_self` (also QED64's thread-storm and liveness lanes).
  That copy also hooks `proxiedFunctionTable[0]` = `_proc_exit` and `[1]` = `exitOnMainThread`,
  which emsdk 7's sorted table cannot keep: a note of its own reports it (present or absent), never
  a failure, and lean4game re-pins past QED64 58e1918 before it runs on such a runtime. Test
  probes' reach-ins (`cleanupThread`, `proxiedJSCallArgs`, `EXITSTATUS`, `runtimeKeepaliveCounter`,
  `runtimeExited`, `ENVIRONMENT_IS_PTHREAD`) are reported, not required. `js/exports-audit.mjs`
  lists what a consumer tree touches against this list and the export contract, and the BARE reads
  of Module-only names (§1) in its code, comments and strings left out: such a name read off the
  global scope (`self.X`, `globalThis["X"]`) or in `typeof X`, an export named bare (`_free(p)`),
  and one of the four methods named bare in a file whose code names `Module`, `importScripts` or
  `FS` (`getValue(p, "i64")`). It marks each `PThread`, `TTY` or `FS` member the given glue never
  names (`FS.filesystems` on 7.0.0), for a human to judge. Re-check the list at an emsdk move, when
  0020 goes upstream, or when the build changes (K6).

**stderr: the lines hosts parse (the progress contract)** [RT]. The runtime prints these lines
itself, and consumers parse them, so their text is frozen: a runtime that changes one is a
breaking change for the consumers named, made only with a `PATCHES.md` entry and after they are
told. Lean prints the first four with `IO.eprintln` (stderr; in a browser, `Module.printErr`,
§3.1, one line each); the compactor text is part of an IO error's message.

| Line, as printed | Printed by (source text) | When | Parsed by |
|---|---|---|---|
| `[DEBUG:PROGRESS] Loading <n> modules...` | `src/Lean/Environment.lean`, `finalizeImport`: `s!"[DEBUG:PROGRESS] Loading {modules.size} modules..."` (the base's line, on stderr since 0031) | once per olean import | the showcase's `scripts/judge-bake.mjs` J2 (`Loading (\d+) modules`: exactly one, `n` the staged tree's module count) |
| `[DEBUG:PROGRESS] <i>/<n>: <module>` | the same: `s!"[DEBUG:PROGRESS] {i + 1}/{modules.size}: {mod.module}"` | modules 1, 51, 101, … and the last | QED64's worker (`public/workers/lean.worker.js`, `/\[DEBUG:PROGRESS\]\s*(\d+)\/(\d+)/`: import progress); `judge-bake.mjs` J2 (an `n/n:` line) |
| `[WASM INIT] <i>/<n> <module>` | `src/Lean/Shell.lean`, `wasmLoadSnapshotMem` (`lean_wasm_load_snapshot_mem`, 0014): `s!"[WASM INIT] {i}/{total} {env.header.modules[modIdx].module}"` | per module of the `[init]` replay (every load since R11a; with `flags` bit 0 before), during that blocking call | QED64's worker (`/^\[WASM INIT\] (\d+)\/(\d+) (.*)$/`: live progress of a snapshot load) |
| `[WASM DEBUG] wasmLoadSnapshotMem: cached env for #[<imports>]`, and `[WASM DEBUG] wasmLoadSnapshot: cached env for #[<imports>]` | `src/Lean/Shell.lean`: `s!"[WASM DEBUG] wasmLoadSnapshotMem: cached env for {key}"` (0013) and `s!"[WASM DEBUG] wasmLoadSnapshot: cached env for {key}"` (the base) | at the end of each successful snapshot load | the showcase's `scripts/headless/exact-header.mjs` (`/cached env for #\[([^\]]*)\]/` on the log of QED64's `snapshot-probe.mjs`, which echoes `[WASM DEBUG]` lines: the key the snapshot seeded) and `scripts/headless/wasm-lsp.mjs` |
| `object compactor: out of memory growing the region buffer to …`, inside the save's IO error `failed to write '<file>': …` | `src/runtime/compact.cpp`, `object_compactor::alloc` (0011): `"object compactor: out of memory growing the region buffer to " << … << " MB (" << … << " MB used); " << "set LEAN_COMPACTOR_RESERVE to reserve the buffer up front"`; the IO error is `lean_compacted_region_save`'s (`src/library/module.cpp`) | when a snapshot save outgrows its region buffer | the showcase's `scripts/bake.sh` (on that substring it rebakes once with 512 MiB more `--reserve`) and `judge-bake.mjs` J1 (any `object compactor:` line fails a bake) |

QED64 freezes the same lines except `[WASM INIT]`, which its worker parses too (its `docs/CLI-CONTRACT.md`,
"Toolchain lines consumers parse"). The
`[WASM DEBUG]` prefix does not make the cached-env line removable. Every other `[WASM DEBUG]`,
`[WASM PROFILE]` and `[WASM LSP]` line is a diagnostic: consumers only filter or log them (the gate
strips them, with these, before it judges Lean's output), and they may change or go. Since R11a the
only other `[WASM DEBUG]` lines are those of a failed snapshot load,
`[WASM DEBUG] wasmLoadSnapshot failed: <error>` and `[WASM DEBUG] wasmLoadSnapshotMem failed: <error>`:
the one place the error's text appears (QED64's `snapshot-probe.mjs` prints a failed load's last lines).

## 6. Placement and engines

**The engine's stack bounds recursion (0036).** Wasm frames run on the stack of the thread that
runs them: a pthread's Worker gets 500 KiB of V8 stack in Chrome (about 1 MiB in Firefox, 4 MiB in
Node), far less than Lean's own guards assume — they measure Emscripten's shadow stack in linear
memory, which deep recursion barely moves. Running out throws a JS `RangeError` that kills the
thread. Since 0036 Lean probes the engine's stack itself (a `Reflect.apply` with a fixed argument
array throws exactly when that much stack is no longer free) at its recursion checkpoints — the
kernel's depth guard and Meta's `Core.checkSystem` — and raises its own error there: Meta's
max-recursion error, or the kernel's "the WebAssembly engine's stack is exhausted". So a proof that
recurses deeper than a browser allows fails with an error, and the session survives; whether it
fits depends on the engine. (0039's runtime alone needed ~5% more stack in a session's first
proofs, from V8's generic wrapper on the C++-exception trampolines; 0040's native exceptions have
no trampolines. PATCHES.md 0039, 0040.) Recursion that passes no checkpoint (the IR interpreter, some
expression traversals) can still overflow, as native Lean can abort there. Headless, the
node-runner knob `LEAN4_WASM64_PTHREAD_STACK_MB=0.68` gives the pthreads Chrome's budget. (From
0038 until the architecture review's D3b the guard also counted its questions and refusals for
hosts, `_lean_wasm_engine_probes()` and `_lean_wasm_engine_guard_trips(site)`; no host read them.
The guard itself is 0036's, unchanged by either.)

- Browser: a classic **DedicatedWorker** (`importScripts`, nested Workers for
  pthreads; a SharedWorker cannot host it), cross-origin isolated (HOSTING.md),
  desktop Chrome/Edge 133+ or Firefox 134+ (Safari has no Memory64). Every
  pthread Worker is a JS isolate against one 4 GiB pointer-compression cage per
  renderer. Until 0039 each cost ~129 MiB of JS heap (the 49 MB glue and the
  per-export bookkeeping of ~106k exports; QED64 HARDENING #55): about 30
  isolates was the ceiling. Since 0039 the glue is under 1 MiB and binds a few
  dozen exports: the cost per Worker in Chrome is to be measured (the
  trimmed-glue experiment measured ~30 MiB). In Node the process with the
  24-Worker pool went from ~10 GB to ~0.96 GB RSS (PATCHES.md 0039).
- Node ≥ 24 (Memory64 without a flag), `node --stack-size=8192`, and
  `bin/package.json` = `{ "type": "commonjs" }` beside `lean.js` (pthreads
  re-load `lean.js` as a CommonJS script; under a `"type": "module"` package
  each dies with `require is not defined`). `lean4-wasm64 fetch --only runtime`
  writes it.

**C++ exceptions are native Wasm exceptions (0040), legacy encoding.** No JS trampolines sit
between the runtime's wasm frames any more. What a host can observe differently from 0039 and
before (PATCHES.md 0040):
- `abort()` escapes as `RuntimeError: unreachable` (was `Aborted(...)`); `onAbort` and its printed
  line are unchanged — classify aborts by `onAbort`, not by the error text.
- A V8 stack overflow still kills only its pthread (no C++ handler runs); an Emscripten `"unwind"`
  or `ExitStatus` now runs C++ destructors on its way out, and one crossing a `noexcept` frame
  aborts the runtime: in persistent mode (`lean_wasm_compile`) a task pthread that overflows while
  the main runtime thread waits in `Task.get` gives `onAbort`, not a survivable `unwind`.
- Firefox logs a legacy-EH deprecation warning each time `lean.wasm` is instantiated (the host's
  worker and each pthread Worker). Browser floors are unchanged (Memory64's).
- An uncaught C++ exception reaches JS as a `WebAssembly.Exception`.

## 7. QED64 behaviour inside the runtime

A toolchain-only embedder inherits two QED64-flavoured details: an
environment importing `QED64.Essential` covers `Mathlib`, `Mathlib.Tactic`,
`Batteries` and `MIL.Common`; and the `$/qed64/headerStatus` notification name.
(Two others are gone: the `QED64_ALLOW_LEGACY_IMPORTS` variable has no reader since R11a, and
since K3 the refused-header diagnostic no longer names QED64's "Load exact imports" action, which
QED64 retired with its library packs, D1.)

**Frozen since 2026-11-01** (architecture review K3). The umbrella's name and its four aliases
(`src/Lean/Language/Lean.lean`, `lookupPrebuiltEnv`: an environment whose closure holds
`QED64.Essential` covers `Mathlib`, `Mathlib.Tactic`, `Batteries` and `MIL.Common`) change only
with a `PATCHES.md` entry. Two changes are parked until an embedder other than QED64 needs them or
a new alias is requested: taking the alias list as data, and renaming `$/qed64/headerStatus` (its
readers bind to the method name, so a rename needs a window that serves both names).

**Since K3** (no protocol bump: the same method and fields). The refused-header text is generic,
`modules #[…] are not loaded in this session`: it lost its ending `— use "Load exact imports"`
and keeps the phrase that consumers match (QED64's e2e; the showcase's C7,
`tests/ux/specs/30-robustness.spec.mjs`). `headerStatus.version` is the version of the document
whose header setup the notification reports (§3.4). Before, every setup carried the document's
first version, because the FileWorker bound `setupImports` to the `DocumentMeta` it started with;
nothing keyed on it.

## Compatibility

Within a release line, a later patch keeps every [RT] entry point and its
semantics, or the change is called out in `PATCHES.md` and in the release's
`notes`. [GLUE] details may change with the toolchain image (`release.json`
`docker`). A host pins a release, or sets a floor on `kernel.patch` (ordered as
in `js/formats/README.md`) and probes for the exports it uses.
