/-
Copyright (c) 2025 Lean FRO. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Leonardo de Moura, Mac Malone
-/
module

prelude
import Lean.Elab.Frontend
import Lean.Elab.ParseImportsFast
import Lean.Server.Watchdog
import Lean.Server.FileWorker
import Lean.Compiler.LCNF.EmitC
import Init.System.Platform
import Lean.Compiler.Options
import Lean.Compiler.InitAttr  -- for `runInitAttrsForModules` on snapshot load

/-  Lean companion to  `shell.cpp` -/

open System

namespace Lean

/--
Decodes an array of bytes that encode a string as [UTF-8](https://en.wikipedia.org/wiki/UTF-8) into
the corresponding string. Invalid UTF-8 characters in the byte array are replaced with `U+FFFD`
(the unicode replacement character) in the resulting string.

This is used instead of the standard `String` functions because Lean is expected to not immediately
abort on files with invalid UTF-8.
-/
@[extern "lean_decode_lossy_utf8"]
opaque decodeLossyUTF8 (a : @& ByteArray) : String

/- Runs the `main` function of the module with `args` using the Lean interpreter. -/
@[extern "lean_eval_main"]
opaque runMain (env : @& Environment) (opts : @& Options) (args : @& List String) : BaseIO UInt32

/--
Initializes the LLVM subsystem.
If Lean lacks LLVM support, this function will fail with an assertion violation.
-/
@[extern "lean_init_llvm"]
opaque initLLVM : IO Unit

/--
Emits LLVM bitcode for the module.
Before calling this function, the LLVM subsystem must first be successfully initialized.
-/
@[extern "lean_emit_llvm"]
opaque emitLLVM (env : Environment) (modName : Name) (filepath : FilePath) : IO Unit

/-! ## WASM API

These functions provide a WASM-friendly API that caches the environment
between calls, avoiding the slow re-import of Init modules on each compile.
-/

/-- Cache of import-set → environment. Each distinct set of header imports gets
its own cached environment, so `import Std …` (or any imports) is slow only on
its first compile and fast on every repeat, just like Init-only code. -/
private initialize wasmEnvCache : IO.Ref (Array (Array Name × Environment)) ← IO.mkRef #[]

/-- Patch 0032 (K1b): the environment cache IS the registry the resident
resolver reads; registered once, at process initialization. -/
builtin_initialize Language.Lean.registerPrebuiltEnvSource wasmEnvCache.get

/-- Get or create the cached WASM environment for the given header `imports`.
The first compile with a given import set imports it (slow); later compiles with
the same set reuse the cached environment (fast). -/
def getOrCreateWasmEnvFor (imports : Array Import) : IO Environment := do
  let key := Language.Lean.qed64HeaderKey imports
  for (k, env) in (← wasmEnvCache.get) do
    if k == key then
      IO.eprintln "[WASM DEBUG] getOrCreateWasmEnvFor: returning cached env"
      -- A cached env may predate extensions registered by a later snapshot's
      -- [init] replay; grow its extension array or generic extension access
      -- panics ("invalid environment extension has been accessed").
      let env ← env.ensureExtensionsSizeForWasm
      wasmEnvCache.modify (·.map fun (k', e) => if k' == key then (k', env) else (k', e))
      return env
  IO.eprintln s!"[WASM DEBUG] getOrCreateWasmEnvFor: cache miss, importing {key}…"
  -- Mirror the frontend's header import (`processHeaderCore`, Elab/Import.lean):
  --  * `loadExts := true` loads the environment extensions — parser notation
  --    (e.g. `+`) and the instance database (e.g. `OfNat`). Without it (the
  --    default `false`), `#check 2 + 2` fails with "OfNat" / "unexpected '+'".
  --  * `level := .exported` matches the only data the WASM build ships (base
  --    `.olean`); the default `.private` expects absent private/server data.
  --  * `leakEnv := true` keeps the compacted regions alive. Environments are
  --    cached and reused across compiles; with the default (regions freed after
  --    import) a later compile dereferences freed regions and fails. Freeing is
  --    also unsafe once extensions are loaded (see `withImportModules`).
  -- `withImporting` (inside `importModules`) clears the initializer-execution
  -- flag when it returns, and a `loadExts := true` import refuses to run
  -- without it — so every cache-miss import after the first would throw.
  -- Re-enable it each time, as `runFrontend` does after `--incr-load`.
  unsafe enableInitializersExecution
  let env ← importModules imports {} 0
    (level := .exported) (loadExts := true) (leakEnv := true)
  IO.eprintln "[WASM DEBUG] getOrCreateWasmEnvFor: importModules completed"
  wasmEnvCache.modify (·.push (key, env))
  return env

/--
Compile Lean code using a cached environment.

This is the main WASM entry point. The first call will import Init modules (slow),
but subsequent calls reuse the cached environment (fast).

The `fileName` parameter is optional - it's only used as a label in error messages,
not for actual file I/O. The `code` string is processed directly in memory.

Returns 0 on success, 1 on error. Output is written to stdout as JSON.
-/
@[export lean_wasm_compile]
def wasmCompile (code : String) (fileName : String := "<input>") : IO UInt32 := do
  IO.eprintln s!"[WASM DEBUG] wasmCompile called with code length={code.length}, fileName={fileName}"
  IO.eprintln "[WASM DEBUG] Creating input context..."
  let inputCtx := Parser.mkInputContext code fileName
  -- Parse the file's header (its `import` lines) and import that closure into a
  -- per-import-set cached environment, then elaborate the body against it. This
  -- is what lets user code `import Std …` (or any modules) work and stay fast on
  -- repeat. `headerToImports` includes `Init` implicitly unless the file is
  -- `prelude`, matching the normal frontend.
  let (header, parserState, headerMessages) ← Parser.parseHeader inputCtx
  IO.eprintln "[WASM DEBUG] Getting or creating environment for header imports..."
  let env ← getOrCreateWasmEnvFor (Elab.headerToImports header)
  IO.eprintln "[WASM DEBUG] Environment ready"

  let opts : Options := {}
  let cmdState := Elab.Command.mkState env headerMessages opts

  -- Elaborate synchronously with `Frontend.processCommands` — a plain loop over
  -- `Command.elabCommandTopLevel` — rather than `Elab.IO.processCommands`. The
  -- latter drives elaboration through the language-server snapshot/task
  -- infrastructure, which spawns elaboration tasks. In the single-threaded WASM
  -- worker those tasks are never drained, leaving the runtime in a state where
  -- the *next* `lean_wasm_compile` call fails immediately. The synchronous loop
  -- creates no tasks, so the cached environment stays reusable across compiles.
  let frontendCtx : Elab.Frontend.Context := { inputCtx }
  -- Start parsing commands right after the header, so the header's `import` lines
  -- are not re-parsed as commands (they aren't commands and would error).
  let frontendState : Elab.Frontend.State :=
    { commandState := cmdState, parserState := parserState, cmdPos := parserState.pos }
  -- `Command.elabCommandTopLevel` resets `commandState.messages` at the start of
  -- every command, so the final state holds only the last command's messages.
  -- Collecting after each command recovers ELABORATION messages, but PARSER
  -- messages (garbage text, unterminated declarations) are attached before
  -- elaboration and were silently lost to that reset. Inline the parse step of
  -- `Frontend.processCommand` so parse diagnostics reach the log directly:
  --  * `parseCommand` gets an EMPTY log, so its result is exactly the new
  --    parse errors, which we append to `acc` before elaborating;
  --  * the command state is seeded with an empty log before elaboration, so
  --    the post-command collection is exactly that command's elaboration
  --    messages regardless of whether `elabCommandTopLevel` restores its
  --    incoming log (behavior that has changed across toolchains).
  let collect : Elab.Frontend.FrontendM MessageLog := do
    let mut acc : MessageLog := headerMessages
    let mut done := false
    while !done do
      Elab.Frontend.updateCmdPos
      let cmdState ← Elab.Frontend.getCommandState
      let pstate ← Elab.Frontend.getParserState
      let scope := cmdState.scopes.head!
      let pmctx : Parser.ParserModuleContext :=
        { env := cmdState.env, options := scope.opts,
          currNamespace := scope.currNamespace, openDecls := scope.openDecls }
      let (cmd, ps, parseMessages) := Parser.parseCommand inputCtx pmctx pstate {}
      acc := acc ++ parseMessages
      modify fun s => { s with commands := s.commands.push cmd }
      Elab.Frontend.setParserState ps
      Elab.Frontend.setMessages {}
      Elab.Frontend.elabCommandAtFrontend cmd
      acc := acc ++ (← Elab.Frontend.getCommandState).messages
      done := Parser.isTerminalCommand cmd
    return acc
  let (msgLog, _s) ← StateRefT'.run (ReaderT.run collect frontendCtx) frontendState

  -- Output messages as JSON
  let messages := msgLog.toList
  IO.eprintln s!"[WASM DEBUG] Processing {messages.length} messages..."
  for msg in messages do
    -- Convert to interactive diagnostic, then to plain diagnostic for JSON
    let interactiveDiag ← Widget.msgToInteractiveDiagnostic inputCtx.fileMap msg false
    let diag := interactiveDiag.toDiagnostic
    -- Add extra fields for WASM consumers
    let json := Json.mkObj [
      ("fileName", Json.str msg.fileName),
      ("pos", Json.mkObj [("line", msg.pos.line), ("column", msg.pos.column)]),
      ("endPos", match msg.endPos with
        | some p => Json.mkObj [("line", p.line), ("column", p.column)]
        | none => Json.null),
      ("severity", match msg.severity with
        | .error => "error" | .warning => "warning" | .information => "information"),
      ("caption", msg.caption),
      ("data", diag.message),
      ("isSilent", msg.isSilent),
      ("keepFullRange", msg.keepFullRange),
      ("kind", Json.str msg.kind.toString)
    ]
    IO.println json.compress

  -- Return success/failure
  let hasErrors := messages.any (·.severity == .error)
  IO.eprintln s!"[WASM DEBUG] Done, hasErrors={hasErrors}"
  return if hasErrors then 1 else 0

/--
Reset the WASM environment cache.
Call this if you need to re-import modules (e.g., after changing search paths).
-/
@[export lean_wasm_reset]
def wasmReset : IO Unit := do
  wasmEnvCache.set #[]
  IO.println "[WASM] Environment cache cleared"

/--
Seed the WASM environment cache from a `--incr-header-save` snapshot file,
so the first compile with that header import set skips the multi-minute
`loadExts` import entirely.

The snapshot must have been saved by this same binary: its closure relocation
(the base-0 "wasm-main" pseudo-library) is the identity, which is only correct
against this build's function table. The cache key is read back out of the
loaded environment's header, so the file needs no naming convention.

Returns 0 on success, 1 on failure — the next compile then just falls back to
a regular import.
-/
@[export lean_wasm_load_snapshot]
def wasmLoadSnapshot (path : String) : IO UInt32 := do
  try
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshot: loading {path}"
    let (cmdState, initModIdxs) ← unsafe Elab.loadHeaderSnapshotCmdState ⟨path⟩
    let env := cmdState.env.setMainModule .anonymous
    -- Replay the `[init]` attributes the imported modules would have run.
    -- `runInitAttrsForModules` requires initializer execution to be enabled,
    -- and `withImporting` clears the flag when it returns, so enable on both
    -- sides (the same restore `runFrontend` performs after `--incr-load`).
    unsafe enableInitializersExecution
    withImporting do
      unsafe runInitAttrsForModules env initModIdxs {}
    unsafe enableInitializersExecution
    let key := Language.Lean.qed64HeaderKey env.header.imports
    wasmEnvCache.modify (·.push (key, env))
    -- The resident FileWorker (patch 0031) runs the REAL header-processing
    -- path, which consults this cache through the registry (patch 0032):
    -- every snapshot load publishes here so the resolver sees covering envs.
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshot: cached env for {key}"
    return 0
  catch e =>
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshot failed: {e}"
    return 1

/--
`wasmLoadSnapshot` for a snapshot the host streamed straight into the wasm heap: `ptr` is a
`malloc`-allocated buffer of `size` bytes holding the whole `.snap` file. Skips the MEMFS
staging copy, which for a multi-GB region is a second multi-GB allocation in the host's JS heap.
-/
@[export lean_wasm_load_snapshot_mem]
def wasmLoadSnapshotMem (ptr size flags : USize) : IO UInt32 := do
  try
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshotMem: loading {size} bytes (flags {flags})"
    let t0 ← IO.monoMsNow
    let (cmdState, initModIdxs) ← unsafe Elab.loadHeaderSnapshotCmdStateMem ptr size
    let t1 ← IO.monoMsNow
    let env := cmdState.env.setMainModule .anonymous
    let t2 ← IO.monoMsNow
    unsafe enableInitializersExecution
    -- Per-module timing: `runInitAttrsForModules` is a plain loop over the
    -- indices, so singleton calls preserve order and semantics exactly. The
    -- replay dominates whole-Mathlib loads (measured 106 s of a 107 s load,
    -- versus 0.7 s for the 2.6 GB relocation walk), so name the offenders
    -- whenever it is slow enough to matter.
    -- flags bit 0: run the [init] attribute replay. Extension states live in
    -- the env and are restored by the region itself; the replay rebuilds
    -- process-side registrations, and a host that knows its workload does not
    -- need them can skip it.
    let replayModIdxs := if flags &&& 1 == 1 then initModIdxs else #[]
    if replayModIdxs.isEmpty && !initModIdxs.isEmpty then
      IO.eprintln s!"[WASM PROFILE] init replay SKIPPED ({initModIdxs.size} modules)"
    let total := replayModIdxs.size
    let initTimes ← withImporting do
      let mut slow : Array (Nat × Nat) := #[]
      let mut i := 0
      for modIdx in replayModIdxs do
        i := i + 1
        -- Streamed through printErr DURING the otherwise-blocking load call, so
        -- the host can show real per-module progress for the ~2-minute replay.
        if h : modIdx < env.header.modules.size then
          IO.eprintln s!"[WASM INIT] {i}/{total} {env.header.modules[modIdx].module}"
        let s ← IO.monoMsNow
        unsafe runInitAttrsForModules env #[modIdx] {}
        let d := (← IO.monoMsNow) - s
        if d > 0 then slow := slow.push (modIdx, d)
      return slow
    let t3 ← IO.monoMsNow
    if t3 - t2 > 5000 then
      for (modIdx, d) in (initTimes.qsort (·.2 > ·.2))[:10] do
        if h : modIdx < env.header.modules.size then
          IO.eprintln s!"[WASM PROFILE] init {env.header.modules[modIdx].module}: {d} ms"
    unsafe enableInitializersExecution
    let key := Language.Lean.qed64HeaderKey env.header.imports
    wasmEnvCache.modify (·.push (key, env))
    -- The RESIDENT FileWorker (patch 0031) resolves headers through the
    -- registry that reads this cache (patch 0032); without this publish the
    -- covering environment is never found and the header imports its whole
    -- closure on the elaboration thread (629 Init modules ≈ 17 s per switch).
    -- The non-mem loader already published; the browser uses THIS path.
    let t4 ← IO.monoMsNow
    IO.eprintln s!"[WASM PROFILE] snapshot load stages: region read+materialize {t1-t0} ms · setMainModule {t2-t1} ms · init replay ({replayModIdxs.size} modules) {t3-t2} ms · cache {t4-t3} ms"
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshotMem: cached env for {key}"
    return 0
  catch e =>
    IO.eprintln s!"[WASM DEBUG] wasmLoadSnapshotMem failed: {e}"
    return 1

/-- Whether Lean was built with an address sanitizer enabled. -/
@[extern "lean_internal_has_address_sanitizer"]
opaque Internal.hasAddressSanitizer (_ : Unit) : Bool

/-- Whether Lean was built with multithread support (i.e., `LEAN_MULTI_THREAD`). -/
@[extern "lean_internal_is_multi_thread"]
opaque Internal.isMultiThread (_ : Unit) : Bool

/-- Whether Lean was built in debug mode (i.e., `LEAN_DEBUG`). -/
@[extern "lean_internal_is_debug"]
opaque Internal.isDebug (_ : Unit) : Bool

/-- Returns the mode Lean was built in (i.e., `LEAN_BUILD_TYPE`). -/
@[extern "lean_internal_get_build_type"]
opaque Internal.getBuildType (_ : Unit) : String

/--
Returns the default max memory (in megabytes) Lean was built with
(i.e., `LEAN_DEFAULT_MAX_MEMORY`).
-/
@[extern "lean_internal_get_default_max_memory"]
opaque Internal.getDefaultMaxMemory (_ : Unit) : Nat

/-- Sets Lean's internal maximum memory (in bytes) for the C runtime. -/
@[extern "lean_internal_set_max_memory"]
opaque Internal.setMaxMemory (max : USize) : BaseIO Unit

/--
Returns the default max heartbeats (in thousands) Lean was built with
(i.e., `LEAN_DEFAULT_MAX_HEARTBEAT`).
-/
@[extern "lean_internal_get_default_max_heartbeat"]
opaque Internal.getDefaultMaxHeartbeat (_ : Unit) : Nat

/-- Sets Lean's internal maximum heartbeats for the C runtime. -/
@[extern "lean_internal_set_max_heartbeat"]
opaque Internal.setMaxHeartbeat (max : USize) : BaseIO Unit

/-- Returns whether Lean was built as verbose by default (i.e., `LEAN_DEFAULT_VERBOSE`). -/
@[extern "lean_internal_get_default_verbose"]
opaque Internal.getDefaultVerbose (_ : Unit) : Bool

/-- Sets whether Lean aborts when a panic occurs. -/
@[extern "lean_internal_set_exit_on_panic"]
opaque Internal.setExitOnPanic (exit : Bool) : BaseIO Unit

/-- Sets the stack size (in bytes) of a Lean thread. -/
@[extern "lean_internal_set_thread_stack_size"]
opaque Internal.setThreadStackSize (sz : USize) : BaseIO Unit

/-- Enables debug assertions with the given tag. -/
@[extern "lean_internal_enable_debug"]
opaque Internal.enableDebug (tag : @& String) : BaseIO Unit

/--
Lean's short version string (i.e., what is printed by `lean --short-version`).

This is the Lean equivalent of of the C++ `LEAN_VERSION_STRING` / `g_short_version_string`.
-/
def shortVersionString : String :=
  if version.specialDesc ≠ "" then
    s!"{versionStringCore}-{version.specialDesc}"
  else if !version.isRelease then
    s!"{versionStringCore}-pre"
  else
    versionStringCore

/-- The full Lean version header (i.e, what is printed by `lean --version`). -/
def versionHeader : String := Id.run do
  let mut ver := shortVersionString
  if Platform.target ≠ "" then
    ver := s!"{ver}, {Platform.target}"
  if githash ≠ "" then
    ver := s!"{ver}, commit {githash}"
  s!"Lean (version {ver}, {Internal.getBuildType ()})"

/--
A string containing the list of additional features Lean was built with.

This is printed by `lean --features`.
-/
def featuresString :=
  if Internal.hasLLVMBackend () then
    "[LLVM]"
  else "[]"

/-- Print the Lean CLI help message. -/
def displayHelp (useStderr : Bool) : IO Unit := do
  let out ← if useStderr then IO.getStderr else IO.getStdout
  out.putStrLn    versionHeader
  out.putStrLn    "Miscellaneous"
  out.putStrLn    "  -h, --help             display this message"
  out.putStrLn    "      --features         display features compiler provides (eg. LLVM support)"
  out.putStrLn    "  -v, --version          display version information"
  out.putStrLn    "  -V, --short-version    display short version number"
  out.putStrLn    "  -g, --githash          display the git commit hash number used to build this binary"
  out.putStrLn    "      --run <file>       call the 'main' definition in the given file with the remaining arguments"
  out.putStrLn    "  -o, --o=oname          create olean file"
  out.putStrLn    "  -i, --i=iname          create ilean file"
  out.putStrLn    "  -c, --c=fname          name of the C output file"
  out.putStrLn    "  -b, --bc=fname         name of the LLVM bitcode file"
  out.putStrLn    "      --stdin            take input from stdin"
  out.putStrLn    "  -R, --root=dir         set package root directory from which the module name\n"
  out.putStrLn    "                         of the input file is calculated\n"
  out.putStrLn    "                         (default: current working directory)\n";
  out.putStrLn    "  -t, --trust=num        trust level (default: max) 0 means do not trust any macro,\n"
  out.putStrLn    "                         and type check all imported modules\n";
  out.putStrLn    "  -q, --quiet            do not print verbose messages"
  out.putStrLn    "  -M, --memory=num       maximum amount of memory that should be used by Lean"
  out.putStrLn    "                         (in megabytes)"
  out.putStrLn    "  -T, --timeout=num      maximum number of memory allocations per task"
  out.putStrLn    "                         this is a deterministic way of interrupting long running tasks"
  if Internal.isMultiThread () then
    out.putStrLn  "  -j, --threads=num      number of threads used to process lean files"
    out.putStrLn  "  -s, --tstack=num       thread stack size in Kb"
    out.putStrLn  "      --server           start lean in server mode"
    out.putStrLn  "      --worker           start lean in server-worker mode"
  out.putStrLn    "      --plugin=file[=fn] load and initialize Lean shared library for registering linters etc."
  out.putStrLn    "      --load-dynlib=file load shared library to make its symbols available to the interpreter"
  out.putStrLn    "      --setup=file       JSON file with module setup data (supersedes the file's header)"
  out.putStrLn    "      --json             report Lean output (e.g., messages) as JSON (one per line)"
  out.putStrLn    "  -E, --error=kind       report Lean messages of kind as errors"
  out.putStrLn    "      --deps             just print dependencies of a Lean input"
  out.putStrLn    "      --src-deps         just print dependency sources of a Lean input"
  out.putStrLn    "      --print-prefix     print the installation prefix for Lean and exit"
  out.putStrLn    "      --print-libdir     print the installation directory for Lean's built-in libraries and exit"
  out.putStrLn    "      --profile          display elaboration/type checking time for each definition/theorem"
  out.putStrLn    "      --stats            display environment statistics"
  out.putStrLn    "      --incr-save=file   EXPERIMENTAL: save a full incremental snapshot of post-elaboration state at end of run"
  out.putStrLn    "      --incr-load=file   EXPERIMENTAL: reuse a snapshot saved by `--incr-(header-)save` at start of run"
  out.putStrLn    "      --incr-header-save=file"
  out.putStrLn    "                         EXPERIMENTAL: like `--incr-save`, but save only the header (state after importing)"
  if Internal.isDebug () then
    out.putStrLn  "      --debug=tag        enable assertions with the given tag"
  out.putStrLn    "      -D name=value      set a configuration option (see set_option command)"

inductive ShellComponent
| frontend
| watchdog
| worker

private builtin_initialize maxMemory : Lean.Option Nat ←
  Lean.Option.register `max_memory {defValue := Internal.getDefaultMaxMemory ()}

private builtin_initialize timeout : Lean.Option Nat ←
  Lean.Option.register `timeout {defValue := Internal.getDefaultMaxHeartbeat ()}

private builtin_initialize verbose : Lean.Option Bool ←
  Lean.Option.register `verbose {defValue := Internal.getDefaultVerbose ()}

/-- Returns any option overrides Lean was built with (i.e., those set in `stdlib_flags.h`). -/
@[extern "lean_internal_get_option_overrides"]
opaque Internal.getOptionOverrides (_ : Unit) : Options

/--
Returns the believer trust level of the Lean environment (i.e., `LEAN_BELIEVER_TRUST_LEVEL`).

If an environment is created with a trust level greater than this, then we can add declarations
to it without type checking them.
-/
@[extern "lean_internal_get_believer_trust_level"]
opaque Internal.getBelieverTrustLevel (_ : Unit) : UInt32

/-- Returns the shell's default trust level. -/
def defaultTrustLevel : UInt32 :=
  Internal.getBelieverTrustLevel () + 1

/-- Returns the default number of threads for the shell's task manager. -/
def defaultNumThreads : UInt32 :=
  if Internal.isMultiThread () then
    Platform.Internal.getHardwareConcurrency ()
  else 0

structure ShellOptions where
  leanOpts : Options := {}
  forwardedArgs : Array String := #[]
  component : ShellComponent := .frontend
  printPrefix : Bool := false
  printLibDir : Bool := false
  useStdin : Bool := false
  onlyDeps : Bool := false
  onlySrcDeps : Bool := false
  depsJson : Bool := false
  opts : Options := {}
  trustLevel : UInt32 := defaultTrustLevel
  numThreads : UInt32 := defaultNumThreads
  rootDir? : Option System.FilePath := none
  setupFileName? : Option System.FilePath := none
  oleanFileName? : Option System.FilePath := none
  ileanFileName? : Option System.FilePath := none
  cFileName? : Option System.FilePath := none
  bcFileName? : Option System.FilePath := none
  jsonOutput : Bool := false
  errorOnKinds : Array Name := #[]
  printStats : Bool := false
  run : Bool := false
  incrSaveFileName? : Option System.FilePath := none
  incrLoadFileName? : Option System.FilePath := none
  incrHeaderSaveFileName? : Option System.FilePath := none

@[export lean_shell_options_mk]
def mkShellOptions (_ : Unit) : ShellOptions := {}

@[export lean_shell_options_get_run]
def ShellOptions.getRun (opts : ShellOptions) : Bool :=
  opts.run

@[export lean_shell_options_get_profiler]
def ShellOptions.getProfiler (opts : ShellOptions) : Bool :=
  profiler.get opts.leanOpts

@[export lean_shell_options_get_num_threads]
def ShellOptions.getNumThreads (opts : ShellOptions) : UInt32 :=
  opts.numThreads

def checkOptArg (optName : String) (optArg? : Option String) : IO String := do
  if let some arg := optArg? then
    return arg
  else
    throw <| .userError s!"argument missing for option '-{optName}'"

def setConfigOption (opts : Options) (arg : String) : IO Options := do
  let pos := arg.find '='
  if h : pos.IsAtEnd then
    throw <| .userError "invalid -D parameter, argument must contain '='"
  else
    let name := arg.sliceTo pos |>.toName
    let val := arg.sliceFrom (pos.next h) |>.copy
    if let some decl := (← getOptionDecls).find? name then
      Language.Lean.setOption opts decl name val
    else
      -- More options may be registered by imports, so we leave validating them to the elaborator.
      -- This (minor) duplication may be resolved later.
      return opts.set name val

/--
Process a command-line option parsed by the C++ shell.

Runs under `IO.initializing` and without a task manager.
-/
@[export lean_shell_options_process]
def ShellOptions.process (opts : ShellOptions)
    (opt : Char) (optArg? : Option String) : EIO UInt32 ShellOptions := do
  have : MonadLift IO (EIO UInt32) := ⟨liftIO⟩
  match opt with
  | 'e' => -- undocumented
    Internal.setExitOnPanic true
    return opts
  | 'j' => -- `-j, --threads=num`
    let arg ← checkOptArg "j" optArg?
    let some numThreads := arg.toNat?
      | throwExpectedNumeric "j"
    if h : numThreads < UInt32.size then
      let numThreads := UInt32.ofNatLT numThreads h
      let forwardedArgs := opts.forwardedArgs.push s!"-j{arg}";
      return {opts with forwardedArgs, numThreads}
    else
      throwTooLarge "j"
  | 'v' => --- `-v, --version`
    IO.println Lean.versionHeader
    throw 0
  | 'V' => --- `-V, --short-version`
    IO.println Lean.shortVersionString
    throw 0
  | 'g' => -- `-g, --githash`
    IO.println Lean.githash
    throw 0
  | 'h' => -- `-h, --help`
    displayHelp (useStderr := false)
    throw 0
  | 'f' => -- `--features`
    IO.println Lean.featuresString
    throw 0
  | 'c' => -- `-c, --c=fname`
    return {opts with cFileName? := ← checkOptArg "c" optArg?}
  | 'b' => -- `-b, --bc=fname`
    return {opts with bcFileName? := ← checkOptArg "b" optArg?}
  | 's' => -- `-s, --tstack=num`
    let arg ← checkOptArg "s" optArg?
    let some stackSize := arg.toNat?
      | throwExpectedNumeric "s"
    let stackSize := stackSize / 4 * 4 * 1024
    if h : stackSize < USize.size then
      let stackSize := USize.ofNatLT stackSize h
      Internal.setThreadStackSize stackSize
      let forwardedArgs := opts.forwardedArgs.push s!"-s{arg}"
      return {opts with forwardedArgs}
    else
      throwTooLarge "s"
  | 'I' => -- `-I, --stdin`
    return {opts with useStdin := true}
  | 'r' => -- `--run`
    return {opts with
      run := true
      -- can't get IR if it's postponed
      leanOpts := Compiler.compiler.postponeCompile.set opts.leanOpts false }
  | 'o' => -- `--o, olean=fname`
    return {opts with oleanFileName? := ← checkOptArg "o" optArg?}
  | 'i' => -- `--i, ilean=fname`
    return {opts with ileanFileName? := ← checkOptArg "i" optArg?}
  | 'R' => -- `-R, --root=dir`
    let arg ← checkOptArg "R" optArg?
    let forwardedArgs := opts.forwardedArgs.push s!"-R{arg}"
    return {opts with forwardedArgs, rootDir? := arg}
  | 'M' => -- `-M, --memory=num`
    let arg ← checkOptArg "M" optArg?
    let some val := arg.toNat?
      | throwExpectedNumeric "M"
    let leanOpts := maxMemory.set opts.leanOpts val
    let forwardedArgs := opts.forwardedArgs.push s!"-M{arg}"
    return {opts with forwardedArgs, leanOpts}
  | 'T' => -- `-T, --timeout=num`
    let arg ← checkOptArg "T" optArg?
    let some val := arg.toNat?
      | throwExpectedNumeric "T"
    let leanOpts := timeout.set opts.leanOpts val
    let forwardedArgs := opts.forwardedArgs.push s!"-T{arg}"
    return {opts with forwardedArgs, leanOpts}
  | 't' => -- `--trust=num`
    let arg ← checkOptArg "t" optArg?
    let some trustLevel := arg.toNat?
      | throwExpectedNumeric "t"
    if h : trustLevel < UInt32.size then
      let trustLevel := UInt32.ofNatLT trustLevel h
      let forwardedArgs := opts.forwardedArgs.push s!"-t{arg}";
      return {opts with forwardedArgs, trustLevel}
    else
      throwTooLarge "t"
  | 'q' =>
    return {opts with leanOpts := verbose.set opts.leanOpts false}
  | 'd' => -- `--deps`
    return {opts with onlyDeps := true}
  | 'O' => -- `--src-deps`
    return {opts with onlySrcDeps := true}
  | 'N' => -- `--deps-json`
    return {opts with onlyDeps := true, depsJson := true}
  | 'J' => -- `--json`
    return {opts with jsonOutput := true}
  | 'a' => -- `--stats`
    return {opts with printStats := true}
  | 'x' =>  -- `--print-prefix`
    return {opts with printPrefix := true}
  | 'L' =>  -- `--print-libdir`
    return {opts with printLibDir := true}
  | 'D' => -- `-D name=value`
    let arg ← checkOptArg "D" optArg?
    let leanOpts ← setConfigOption opts.leanOpts arg
    let forwardedArgs := opts.forwardedArgs.push s!"-D{arg}"
    return {opts with forwardedArgs, leanOpts}
  | 'S' => -- `--server`
    return {opts with component := .watchdog}
  | 'W' => -- `--worker`
    return {opts with component := .worker}
  | 'P' => -- `--profile`
    return {opts with leanOpts := profiler.set opts.leanOpts true}
  | 'B' => -- `--debug=tag`
    if Internal.isDebug () then
      let arg ← checkOptArg "B" optArg?
      Internal.enableDebug arg
      return opts
    -- if not `LEAN_DEBUG`, fall through to unknown option
  | 'p' => -- `--plugin=file[=fn]`
    let arg ← checkOptArg "p" optArg?
    let (path, fn?) :=
      let pos := arg.find '='
      if h : pos.IsAtEnd then
        (FilePath.mk arg, none)
      else
        let path := arg.sliceTo pos
        let initFn := arg.sliceFrom (pos.next h)
        (FilePath.mk path.copy, some initFn.copy)
    Lean.loadPlugin path fn?
    let forwardedArgs := opts.forwardedArgs.push s!"-p{arg}"
    return {opts with forwardedArgs}
  | 'l' => -- `--load-dynlib=file`
    let arg ← checkOptArg "l" optArg?
    Lean.loadDynlib arg
    let forwardedArgs := opts.forwardedArgs.push s!"-l{arg}"
    return {opts with forwardedArgs}
  | 'u' => -- `--setup=file`
    return {opts with setupFileName? := ← checkOptArg "u" optArg?}
  | 'E' => -- `-E, --error=kind`
    let arg ← checkOptArg "E" optArg?
    let errorOnKinds := opts.errorOnKinds.push arg.toName
    return {opts with errorOnKinds}
  | 'Y' => -- `--incr-save=file`
    return {opts with incrSaveFileName? := ← checkOptArg "Y" optArg?}
  | 'Z' => -- `--incr-load=file`
    return {opts with incrLoadFileName? := ← checkOptArg "Z" optArg?}
  | 'H' => -- `--incr-header-save=file`
    return {opts with incrHeaderSaveFileName? := ← checkOptArg "H" optArg?}
  | _ =>
    pure ()
  eprint "Unknown command line option\n"
  displayHelp (useStderr := true)
  throw 1
where
  @[inline] eprint msg := do
    IO.eprint msg |>.catchExceptions fun _ => pure ()
  @[inline] liftIO {α} (x : IO α) := do
    match (← x.toBaseIO) with
    | .ok a =>
      return a
    | .error e =>
      eprint s!"error: "
      eprint (toString e)
      eprint "\n"
      throw 1
  @[inline] throwExpectedNumeric opt := do
    eprint s!"error: expected numeric argument for option '-{opt}'\n"
    throw 1
  @[inline] throwTooLarge opt := do
    eprint s!"error: argument value for '-{opt}' is too large\n"
    throw 1

@[export lean_shell_main]
def shellMain (args : List String) (opts : ShellOptions) : IO UInt32 := do
  let opts := { opts with leanOpts := opts.leanOpts.mergeBy (fun _ _ v => v) (Internal.getOptionOverrides ()) }
  if opts.printPrefix then
    IO.println (← getBuildDir)
    return 0
  if opts.printLibDir then
    IO.println (← getLibDir (← getBuildDir))
    return 0
  let maxMemory := maxMemory.get opts.leanOpts
  if maxMemory != 0 then
    Internal.setMaxMemory (maxMemory.toUSize * 1024 * 1024)
  let timeout := timeout.get opts.leanOpts
  if timeout != 0 then
    Internal.setMaxHeartbeat (timeout.toUSize * 1000)
  match opts.component with
  | .frontend =>
    pure ()
  | .watchdog =>
    return ← Server.Watchdog.watchdogMain opts.forwardedArgs.toList
  | .worker =>
    return ← Server.FileWorker.workerMain opts.leanOpts
  if opts.onlyDeps && opts.depsJson then
    let fns ←
      if opts.useStdin then
        (← IO.getStdin).lines
      else
        pure args.toArray
    printImportsJson fns
    return 0
  let (fileName?, args) :=
    match args with
    | fileName :: args => (some fileName, args)
    | [] => (none, args)
  if !opts.run && !args.isEmpty then
    IO.eprintln "Expected exactly one file name"
    displayHelp (useStderr := true)
    return 1
  let fileName ←
    if let some fileName := fileName? then
      pure fileName
    else if opts.useStdin then
      pure "<stdin>"
    else
      IO.eprintln "Expected exactly one file name"
      displayHelp (useStderr := true)
      return 1
  let contents ← decodeLossyUTF8 <$> do
    if opts.useStdin then
      (← IO.getStdin).readBinToEnd
    else
      IO.FS.readBinFile fileName
  if opts.onlyDeps then
    Elab.printImports contents fileName
    return 0
  if opts.onlySrcDeps then
    Elab.printImportSrcs contents fileName
    return 0
  -- Quick and dirty `#lang` support
  ---TODO: make it extensible, and add `lean4md`
  let contents ←
    if let some contents := contents.dropPrefix? "#lang" then
      let endLinePos := contents.find '\n'
      let langId := contents.sliceTo endLinePos |>.trimAscii
      if langId == "lean4" then
        pure () -- do nothing for now
      else
        IO.eprintln s!"unknown language '{langId}'\n";
        return 1
      -- Remove up to `\n`
      pure (contents.sliceFrom endLinePos).copy
    else
      pure contents
  let setup? ← opts.setupFileName?.mapM ModuleSetup.load
  let mainModuleName ←
    if let some setup := setup? then
      pure setup.name
    else if let some fileName := fileName? then
      try moduleNameOfFileName fileName opts.rootDir? catch e =>
        if opts.oleanFileName?.isNone && opts.cFileName?.isNone then
          pure `_stdin
        else
          throw e
    else
      pure `_stdin
  let env? ← Elab.runFrontend contents opts.leanOpts fileName mainModuleName
    opts.trustLevel opts.oleanFileName? opts.ileanFileName? opts.jsonOutput opts.errorOnKinds
    #[] opts.printStats setup?
    (incrSaveFileName? := opts.incrSaveFileName?)
    (incrLoadFileName? := opts.incrLoadFileName?)
    (incrHeaderSaveFileName? := opts.incrHeaderSaveFileName?)
  if let some env := env? then
    if opts.run then
      return ← runMain env opts.leanOpts args
    if let some c := opts.cFileName? then
      let .ok out ← IO.FS.Handle.mk c .write |>.toBaseIO
        | IO.eprintln s!"failed to create '{c}'"
          return 1
      profileitIO "C code generation" opts.leanOpts do
        let data ← Compiler.LCNF.emitC mainModuleName
          |>.toIO' { fileName, fileMap := default } { env }
        out.write data.toUTF8
    if let some bc := opts.bcFileName? then
      initLLVM
      profileitIO "LLVM code generation" opts.leanOpts do
        emitLLVM env mainModuleName bc
  displayCumulativeProfilingTimes
  if Internal.hasAddressSanitizer () then
    return if env?.isSome then 0 else 1
  else
    -- When not using the address/leak sanitizer, we interrupt execution without garbage collecting.
    -- This is useful when profiling improvements to Lean startup time.
    IO.Process.exit <| if env?.isSome then 0 else 1
