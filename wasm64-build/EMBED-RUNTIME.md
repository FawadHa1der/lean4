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
- **[GLUE]** — Emscripten 6.0.5 glue internals some hosts reach into: valid for this toolchain image, not a promise;
- **[HOST]** — what QED64's worker does (policy, not requirement).

## 1. The binary [RT]

| | |
|---|---|
| Target | `wasm64-unknown-emscripten`: Memory64, shared memory, pthreads, `-sPROXY_TO_PTHREAD=1` (`main` runs on a pthread) |
| Memory import | `env.memory`: `WebAssembly.Memory({shared: true, address: "i64", initial: ≥ 2048n, maximum: ≤ 262144n})` pages (128 MiB … 16 GiB). Without a host `wasmMemory` the glue creates `{initial: INITIAL_MEMORY ‖ 128 MiB, maximum: 262144n}`. The runtime manifest records these values (`memory`). |
| Threads | a pool of 24 pthread Workers created at load, growing on demand; 16 MiB main/application stack, 8 MiB per pthread |
| Exit | `-sEXIT_RUNTIME=1` with the keepalive patch 0020 in the build image (§5) |
| Filesystems | MEMFS (root), NODEFS, WORKERFS |
| Runtime methods | `callMain, FS, ENV, ccall, getValue, setValue, UTF8ToString, stringToNewUTF8` |
| Exports | `src/emscripten-exports.txt`: the hand-kept seed (`src/emscripten-exports.seed.txt`) plus every boxed wrapper, module initializer and constant cell generated from the build's own C (`gen-exports.py`). Other Lean code runs through the shipped `.ir` (interpreted). |
| Olean trust | githash check compiled off; the SHA-256 manifests and the pack ↔ runtime `leanVersion` rule are the trust root (`js/formats/README.md`) |

The CMake default maximum is 12 GiB; released runtimes are configured by
`docker-wasm64/configure-qed64.sh` with 16 GiB (`maximum: 262144n`), and a host
may import any memory whose maximum is ≤ that.

## 2. Calling convention [RT]

- Every pointer, `size_t` and `usize` parameter is **i64: pass a BigInt** (a
  Number throws `TypeError`); `uint32_t`/`unsigned` are Numbers. i64 results
  come back as BigInt. Exception [GLUE]: `_malloc` and `_free` are wrapped —
  they accept Number or BigInt, and `_malloc` returns a Number.
- `getValue(addr, type)` takes a Number address.
- Lean objects: arguments are owned (consumed) unless the Lean signature says
  `@&`. An `IO α` result is a constructor: tag byte at offset 7 (`0` ok, `1`
  error), field 0 at offset 8. A `UInt32` inside it is a boxed scalar
  `(n << 1) | 1`; decode with `Number(BigInt(getValue(ptr + 8, "i64")) >> 1n)`.
  No export takes an IO world argument. `_lean_io_result_show_error(res)` prints
  an error result.

### The entry points

| Export | Signature (JS) | Returns | Since |
|---|---|---|---|
| `_lean_initialize_runtime_module`, `_lean_initialize`, `_lean_io_mark_end_initialization`, `_lean_init_task_manager` | `()` | — | upstream |
| `_lean_enable_initializer_execution` | `()` | `BaseIO Unit` (ignore) | upstream |
| `_lean_init_search_path` | `()` | `IO Unit` — check the tag | upstream |
| `_lean_mk_string(cstr)` | `(i64)` | a Lean `String` (owned) | upstream |
| `_lean_wasm_load_snapshot_mem(ptr, size, flags)` | `(i64, i64, i64)` | `IO UInt32`: 0 loaded, 1 failed (diagnostic on stderr) | 0013/0014/0016 |
| `_lean_wasm_load_snapshot(path)` | `(i64 String)` | `IO UInt32` — a VFS path; Node tools only | 0013 |
| `_lean_wasm_compile(code, fileName)` | `(i64 String, i64 String)` | `IO UInt32`: 0 no errors, 1 errors (not a count); messages as JSON lines on stdout | 0010/0032/0034 |
| `_lean_wasm_reset()` | `()` | `IO Unit`: clears the environment cache (no current caller) | 0010 |
| `_lean_wasm_shell_mark_preinitialized()` | `()` | — | 0031 |
| `_lean_browser64_configure_input_ring(ptr, capacity)` | `(i64, u32)` | `u32`: 0, or `EINVAL` (28) | 0031 |
| `_lean_wasm_task_manager_parked_threads()` | `()` | `u32`: pthreads parked by the task manager | 0035 |
| `callMain(args)` | `string[]` | runs `lean_main` on the application pthread | — |

`_mem` loads: `ptr` is a `_malloc`ed buffer holding a whole `.snap` file of
`size` bytes; on success it becomes the loaded region's memory (never free or
reuse it). `flags` bit 0 replays the `[init]` attributes of the snapshot's
modules — set it. A snapshot is a memory image of one binary: its index
entry's `runtime` must equal this build id, and the runtime itself checks only
the olean header (`"olean"`, version 2/3, flags 0). Each load publishes its
environment to the covering-environment registry the language server's
header resolution consults (0031/0032).

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
| `LEAN_COMPACTOR_RESERVE` | C | bytes reserved up front when saving a snapshot (`--incr-header-save`); a doubling buffer needs old + new at once (bakes use 3.5 GiB) |
| `LEAN_NAT_MAX_SIZE`, `LEAN_STACK_SIZE_KB` | C | upstream semantics (the latter on the `main` path only) |
| `LEAN_IMPORT_WORKERS` | Lean | parallel region reads of a snapshot with dependency files; not on the in-memory path |
| `LEAN_NUM_THREADS`, `LEAN_MAIN_USE_THREAD`, `LEAN_ABORT_ON_PANIC`, `LEAN_BACKTRACE*` | C | **inert on Emscripten** — not knobs |
| `QED64_ALLOW_LEGACY_IMPORTS` | Lean | inert here: legacy (non-`module`) imports are always tolerated on wasm targets; it matters for native64 |

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
  `.olean.server`, `.olean.private` facets. QED64 mounts each pack read-only
  (WORKERFS, by the manifest's byte-range table) at its own dir.
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
   registered environment, else refused with a header diagnostic; each
   resolution sends `$/qed64/headerStatus {version, mode: "exact" | "covered" |
   "refused", key, moduleCount, missing, ms}`. A header change re-runs setup in
   place.

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
its own library therefore sets `process.env.LEAN_PATH` itself and makes the
host cwd a directory reachable at that same path — `node-runner.mjs` pins
`LEAN_PATH=/lib/lean` (the `--lib` tree; with `--lib` it also shadows the
artifact's own `lib/lean` wherever the VFS could reach it, so `--lib` is the
only library Lean sees) and makes the work dir both `/work` and the cwd, so
relative Lean paths land in it. A work dir whose host path overlaps the VFS
layout (`/work`, `/lib`, `/bin`, …) keeps the cwd at `/`: pass `/work/…` paths
there.

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

## 5. stdout, the mailbox and exit

- **stdout** [RT/GLUE]: every write from a pthread is a synchronous proxied
  `fd_write` to the main runtime thread, then a line-buffered TTY (`print` per
  line, NUL bytes dropped). An LSP frame body has no trailing newline, so the
  last frame of a burst waits in that buffer: QED64 replaces the TTY's
  `put_char` and decodes `Content-Length` frames byte by byte
  (`lsp-frames.js`). The glue does not honour `Module.stdout`.
- **Exit** [GLUE]: with a keepalive held, `_proc_exit` never calls
  `Module.onExit`; a FileWorker exit is visible only by hooking the proxied
  exit functions (QED64 wraps `proxiedFunctionTable[0]` and `[1]`).
- **Mailbox** [GLUE, HARDENING #52 in QED64]: a lost main-thread mailbox
  wakeup can freeze every Lean pthread. QED64 switches the glue to
  postMessage notifications (`waitAsyncPolyfilled = true` in `preRun`) and
  kicks `__emscripten_check_mailbox()` from a 1 s timer. Kernel patch 0035
  narrows the trigger; it does not remove it.

## 6. Placement and engines

- Browser: a classic **DedicatedWorker** (`importScripts`, nested Workers for
  pthreads; a SharedWorker cannot host it), cross-origin isolated (HOSTING.md),
  desktop Chrome/Edge 133+ or Firefox 134+ (Safari has no Memory64). Each
  pthread Worker costs ~129 MiB of JS heap against one 4 GiB pointer-compression
  cage per renderer: about 30 isolates is the ceiling.
- Node ≥ 24 (Memory64 without a flag), `node --stack-size=8192`, and
  `bin/package.json` = `{ "type": "commonjs" }` beside `lean.js` (pthreads
  re-load `lean.js` as a CommonJS script; under a `"type": "module"` package
  each dies with `require is not defined`). `lean4-wasm64 fetch --only runtime`
  writes it.

## 7. QED64 behaviour inside the runtime

A toolchain-only embedder inherits four QED64-flavoured details: an
environment importing `QED64.Essential` covers `Mathlib`, `Mathlib.Tactic`,
`Batteries` and `MIL.Common`; the refused-header diagnostic names QED64's
"Load exact imports" action; the `$/qed64/headerStatus` notification name; and
the `QED64_ALLOW_LEGACY_IMPORTS` variable name.

## Compatibility

Within a release line, a later patch keeps every [RT] entry point and its
semantics, or the change is called out in `PATCHES.md` and in the release's
`notes`. [GLUE] details may change with the toolchain image (`release.json`
`docker`). A host pins a release, or sets a floor on `kernel.patch` (ordered as
in `js/formats/README.md`) and probes for the exports it uses.
