// What JavaScript may rely on in a built runtime, checked on its files (kernel patch 0039): the
// export contract (src/emscripten-exports.seed.txt; EMBED-RUNTIME.md §2) and the glue internals
// hosts reach into ([GLUE]; QED64's runtime-touch contract). Used by the gate's static checks
// S1, S2 and S6 and by exports-audit.mjs; node built-ins only, nothing here runs the runtime.
//
// Since 0039 the module is linked statically and exports only the contract: Lean's own native
// code is found through a table inside it. At -O3 the raw wasm export names are then minified,
// so an export is checked through the glue's own binding, `Module["_x"]=wasmExports["<raw>"]`,
// and the raw name looked up in lean.wasm's export section.

/**
 * The JavaScript export contract: what hosts call (`patch`: the kernel patch that added the name to
 * the contract, null for one every runtime of this line exports). Kept equal to
 * src/emscripten-exports.seed.txt (a unit test compares them), so the packaged gate checks the
 * documented surface without the repository.
 */
export const CONTRACT = Object.freeze([
  { name: "_main", patch: null }, { name: "_malloc", patch: null }, { name: "_free", patch: null },
  { name: "_lean_initialize_runtime_module", patch: null }, { name: "_lean_initialize", patch: null },
  { name: "_lean_io_mark_end_initialization", patch: null }, { name: "_lean_init_task_manager", patch: null },
  { name: "_lean_init_task_manager_using", patch: null }, { name: "_lean_enable_initializer_execution", patch: null },
  { name: "_lean_init_search_path", patch: null }, { name: "_lean_mk_string", patch: null },
  { name: "_lean_io_result_show_error", patch: null },
  { name: "_lean_wasm_compile", patch: null }, { name: "_lean_wasm_reset", patch: null },
  { name: "_lean_wasm_load_snapshot", patch: null }, { name: "_lean_wasm_load_snapshot_mem", patch: null },
  { name: "_lean_wasm_shell_mark_preinitialized", patch: null }, { name: "_lean_browser64_configure_input_ring", patch: null },
  { name: "_lean_wasm_task_manager_parked_threads", patch: null },
  { name: "_lean_wasm_task_manager_stat", patch: "0038" }, { name: "_lean_wasm_engine_probes", patch: "0038" },
  { name: "_lean_wasm_engine_guard_trips", patch: "0038" },
  { name: "_lean_wasm_symtab_stats", patch: "0039" }, { name: "_lean_wasm_symtab_selfcheck", patch: "0039" },
  // Emscripten built-ins JavaScript reaches (QED64's contract): glue globals on every runtime,
  // also bound on Module since 0039 lists them
  { name: "__emscripten_proxy_main", patch: "0039" }, { name: "__emscripten_check_mailbox", patch: "0039" },
  { name: "_pthread_self", patch: "0039" },
]);

/** The names of a seed file's text (`#` starts a comment, on its own line or after a name). */
export function parseSeed(text) {
  return String(text).split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean);
}

/**
 * The glue's internals hosts reach into ([GLUE]), as S6 checks them: `need` is "REQ" for what a
 * host needs (QED64's worker, this package's node-runner), "TEST" for what only test probes use
 * (reported, never failed). Each `test` takes the glue's text.
 */
const has = (re) => (glue) => re.test(glue);
const all = (...res) => (glue) => res.every((re) => re.test(glue));
/** The text of a top-level `var NAME=…` or `function NAME(…)` definition, `len` characters of it. */
export function glueDefinition(glue, name, len = 1200) {
  const m = new RegExp(`(?:var\\s+${name}\\s*=|function\\s+${name}\\s*\\()`).exec(glue);
  return m ? glue.slice(m.index, m.index + len) : null;
}
export const GLUE_SURFACE = Object.freeze([
  { id: "Module adoption", need: "REQ", test: has(/var Module\s*=\s*typeof Module\s*!=\s*["']undefined["']\s*\?\s*Module\s*:\s*\{\}/),
    what: "a classic script that adopts the host's Module (QED64 sets self.Module before importScripts)" },
  { id: "classic script", need: "REQ", test: (g) => !/^\s*export\s+(default|\{)/m.test(g) && !/\bimport\.meta\b/.test(g),
    what: "not MODULARIZE / EXPORT_ES6" },
  { id: "em-pthread", need: "REQ", test: all(/name\s*:\s*["']em-pthread["']/, /globalThis\.name\s*==\s*["']em-pthread["']/),
    what: 'pthread Workers named "em-pthread", detected through globalThis.name' },
  { id: "runtime methods", need: "REQ",
    test: (g) => ["callMain", "FS", "ENV", "getValue", "setValue", "stringToNewUTF8", "UTF8ToString", "ccall"]
      .every((m) => new RegExp(`Module\\[["']${m}["']\\]\\s*=\\s*${m}\\b`).test(g)),
    what: "Module.callMain, FS, ENV, getValue, setValue, stringToNewUTF8, UTF8ToString, ccall" },
  { id: "Module inputs", need: "REQ",
    test: (g) => ["wasmMemory", "locateFile", "mainScriptUrlOrBlob", "noInitialRun", "onRuntimeInitialized", "onAbort",
      "onExit", "print", "printErr", "preRun", "arguments"].every((k) => g.includes(`Module["${k}"]`)),
    what: "the Module keys hosts set (EMBED-RUNTIME.md §3.1) are read" },
  { id: "wasmMemory", need: "REQ", test: all(/var wasmMemory\b/, /wasmMemory\s*=\s*Module\[["']wasmMemory["']\]/),
    what: "a top-level wasmMemory that adopts Module.wasmMemory" },
  { id: "FS", need: "REQ", test: all(/var FS\s*=\s*\{/, /\bmkdirTree\s*[:(]/, /\bmakedev\s*[:(]/, /\bWORKERFS\b/, /\bNODEFS\b/),
    what: "FS with mkdirTree, makedev, WORKERFS and NODEFS" },
  { id: "TTY", need: "REQ", test: all(/var TTY\s*=\s*\{/, /\bttys\s*:\s*\[\]/, /\.ops\.put_char\(/, /\bfsync\s*[:(]/),
    what: "a top-level TTY whose ttys[…].ops.put_char the stream write calls per byte (QED64 replaces it)" },
  { id: "PThread", need: "REQ",
    test: all(/var PThread\s*=\s*\{/, /\bunusedWorkers\s*:\s*\[\]/, /\bpthreads\s*:\s*\{\}/, /\ballocateUnusedWorker\s*\(\)\s*\{/,
      /\bgetNewWorker\s*\(\)\s*\{/, /\breturnWorkerToPool\s*:/, /PThread\.getNewWorker\(\)/, /PThread\.returnWorkerToPool\(/,
      /PThread\.allocateUnusedWorker\(\)/),
    what: "PThread with unusedWorkers, pthreads, allocateUnusedWorker, getNewWorker, returnWorkerToPool, called as PThread.x()" },
  { id: "proxiedFunctionTable", need: "REQ", test: has(/var proxiedFunctionTable\s*=\s*\[\s*_proc_exit\s*,\s*exitOnMainThread\s*[,\]]/),
    what: "proxiedFunctionTable[0] is _proc_exit and [1] exitOnMainThread" },
  { id: "_proc_exit, exitOnMainThread", need: "REQ", test: all(/(?:var _proc_exit\s*=|function _proc_exit\s*\()/, /(?:var exitOnMainThread\s*=|function exitOnMainThread\s*\()/),
    what: "both top-level, compared by identity with the table's entries" },
  { id: "waitAsyncPolyfilled", need: "REQ", test: (g) => /var waitAsyncPolyfilled\s*=/.test(g) && (g.match(/\bwaitAsyncPolyfilled\b/g) ?? []).length >= 2,
    what: "a mutable top-level var the glue reads when it arms a waiter" },
  { id: "checkMailbox", need: "REQ",
    test: all(/checkMailbox\s*=\s*\(\)\s*=>\s*\{[^}]*runtimeKeepalivePush\(\)/, /__emscripten_check_mailbox\(\)/, /\.then\(\s*checkMailbox\s*\)/),
    what: "checkMailbox holds a keepalive (build-image patch 0020), calls __emscripten_check_mailbox and is looked up by name" },
  { id: "mailbox await", need: "REQ", test: (g) => /pthread_ptr\s*\+\s*\d+/.test(glueDefinition(g, "__emscripten_thread_mailbox_await", 600) ?? ""),
    what: "__emscripten_thread_mailbox_await's source has the literal pthread_ptr+N (QED64 parses it)" },
  { id: "_pthread_self, __emscripten_check_mailbox", need: "REQ",
    test: (g) => ["_pthread_self", "__emscripten_check_mailbox"].every((n) =>
      new RegExp(`(?:^|[;,{\\s])${n}\\s*=\\s*(?:Module\\[["']${n}["']\\]\\s*=\\s*)?(?:makeWrapper_\\w+\\()?wasmExports\\[`, "m").test(g)),
    what: "top-level, reassignable bindings of the wasm exports" },
  { id: "callMain", need: "REQ",
    test: has(/function callMain\s*\([^)]*\)\s*\{\s*var entryFunction\s*=\s*(?:__emscripten_proxy_main|resolveGlobalSymbol\(\s*["']_emscripten_proxy_main["']\s*\)\.sym)\s*;/),
    what: "callMain runs _emscripten_proxy_main (PROXY_TO_PTHREAD)" },
  { id: "runtimeKeepalivePush", need: "REQ", test: has(/(?:var runtimeKeepalivePush\s*=|function runtimeKeepalivePush\s*\()/),
    what: "a top-level function a persistent host calls once" },
  { id: "ABORT", need: "REQ", test: has(/var ABORT\s*=/), what: "a top-level ABORT flag" },
  { id: "ExitStatus", need: "REQ", test: all(/class ExitStatus\s*\{\s*name\s*=\s*["']ExitStatus["']/, /this\.status\s*=\s*status/),
    what: "class ExitStatus with .name and .status" },
  { id: '"unwind"', need: "REQ", test: has(/throw\s*["']unwind["']/), what: 'the thrown string "unwind"' },
  { id: "worker.onerror", need: "REQ", test: has(/worker\.onerror\s*=\s*e\s*=>\s*\{[\s\S]{0,300}?\bthrow\s+e\s*[;}]/),
    what: "a pthread Worker's error is rethrown on the main thread" },
  { id: "spawnThread", need: "REQ", test: all(/(?:var spawnThread\s*=|function spawnThread\s*\()/, /[^.\w]spawnThread\(\s*threadParams\s*\)/),
    what: "a top-level spawnThread the glue calls by name (node-runner's QED64_COUNT_PTHREADS wraps it)" },
  { id: "cleanupThread", need: "TEST", test: has(/(?:var cleanupThread\s*=|function cleanupThread\s*\()/), what: "QED64 thread-storm probe" },
  { id: "proxiedJSCallArgs", need: "TEST", test: has(/var proxiedJSCallArgs\s*=/), what: "QED64 thread-storm probe" },
  { id: "EXITSTATUS, runtimeKeepaliveCounter, runtimeExited", need: "TEST",
    test: all(/var EXITSTATUS\b/, /var runtimeKeepaliveCounter\s*=/, /var runtimeExited\s*=/), what: "QED64 fileworker-exit probe" },
  { id: "ENVIRONMENT_IS_PTHREAD", need: "TEST", test: has(/var ENVIRONMENT_IS_PTHREAD\s*=/), what: "the widgets showcase's UX probes (typeof-guarded)" },
]);

/** The glue's top-level identifiers a host reaches ([GLUE]): what exports-audit knows besides the contract. */
export const GLUE_NAMES = Object.freeze([
  "Module", "FS", "ENV", "TTY", "PThread", "proxiedFunctionTable", "_proc_exit", "exitOnMainThread", "waitAsyncPolyfilled",
  "checkMailbox", "__emscripten_thread_mailbox_await", "_pthread_self", "__emscripten_check_mailbox", "__emscripten_proxy_main",
  "runtimeKeepalivePush", "ABORT", "wasmMemory", "ExitStatus", "spawnThread", "callMain", "getValue", "setValue",
  "stringToNewUTF8", "UTF8ToString", "ccall", "leanPthreadPoolTarget",
  // test probes only
  "cleanupThread", "proxiedJSCallArgs", "EXITSTATUS", "runtimeKeepaliveCounter", "runtimeExited", "ENVIRONMENT_IS_PTHREAD",
]);

/** `Module["<name>"]` bound to `wasmExports["<raw>"]` in the glue: name -> raw export name. */
export function exportBindings(glue) {
  const out = new Map();
  for (const m of String(glue).matchAll(/Module\[["']([^"']+)["']\]\s*=\s*(?:makeWrapper_\w+\()?wasmExports\[["']([^"']+)["']\]/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * The parts of a wasm binary these checks need: custom section names, imports (module, field,
 * kind) and exports (name -> kind: 0 function, 1 table, 2 memory, 3 global, 4 tag). Never throws:
 * `{ ok: false, error }` for bytes it cannot read.
 */
export function readWasm(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let at = 0;
  const fail = (what) => { throw new Error(`${what} at byte ${at}`); };
  const byte = () => (at < b.length ? b[at++] : fail("unexpected end"));
  const uleb = () => { let n = 0, mul = 1, x; do { x = byte(); n += (x & 0x7f) * mul; mul *= 128; } while (x & 0x80); return n; };
  const sleb = () => { let x; do { x = byte(); } while (x & 0x80); };   // skipped (heap types)
  const name = () => { const n = uleb(); if (at + n > b.length) fail("name past the end"); const s = Buffer.from(b.subarray(at, at + n)).toString("utf8"); at += n; return s; };
  const reftype = () => { const t = byte(); if (t === 0x63 || t === 0x64) sleb(); };
  const limits = () => { const f = byte(); uleb(); if (f & 1) uleb(); if (f & 8) uleb(); };
  try {
    if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) fail("no wasm magic");
    at = 8;
    const customs = [], imports = [], exports = new Map();
    while (at < b.length) {
      const id = byte(), size = uleb(), end = at + size;
      if (end > b.length) fail(`section ${id} past the end`);
      if (id === 0) customs.push(name());
      else if (id === 2) {
        for (let n = uleb(); n > 0; n--) {
          const module = name(), field = name(), kind = byte();
          if (kind === 0) uleb(); else if (kind === 1) { reftype(); limits(); } else if (kind === 2) limits();
          else if (kind === 3) { reftype(); byte(); } else if (kind === 4) { byte(); uleb(); } else fail(`import kind ${kind}`);
          imports.push({ module, field, kind });
        }
      } else if (id === 7) {
        for (let n = uleb(); n > 0; n--) { const e = name(), kind = byte(); uleb(); exports.set(e, kind); }
      }
      at = end;
    }
    return { ok: true, customs, imports, exports };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * The contract level of a runtime: "0039" (the native-symbol table), "0038" or "base". 0039 is not
 * read from the export its checks look for alone: every runtime of this line from 0017 to 0038 is
 * a MAIN_MODULE (lean.wasm has a dylink.0 section and GOT imports) whose glue holds 0017's export-set
 * gate (qed64_symbol_exists), and a 0039 runtime has neither. A statically linked lean.wasm, or a
 * glue with 0038's names but without that gate, is 0039 even if its glue lost the binding of
 * _lean_wasm_symtab_stats, so S2 fails on the lost name instead of the runtime being held to an
 * older contract. `wasm`: readWasm's result (null, or unreadable bytes: the glue alone decides).
 */
export function contractLevel(glue, wasm = null) {
  const g = String(glue);
  const has0038 = /Module\[["']_lean_wasm_task_manager_stat["']\]/.test(g) || /var leanPthreadPoolTarget\s*=/.test(g);
  const staticModule = !!wasm?.ok && !wasm.customs.some((c) => c.startsWith("dylink")) && !wasm.imports.some((i) => i.module.startsWith("GOT."));
  if (/Module\[["']_lean_wasm_symtab_stats["']\]/.test(g) || staticModule || (has0038 && !g.includes("qed64_symbol_exists"))) return "0039";
  return has0038 ? "0038" : "base";
}

const LEVELS = { base: 0, "0038": 1, "0039": 2 };
/** The contract names a runtime of `level` must export and bind (`extra`: more names, e.g. a seed's, for 0039). */
export function requiredExports(level, extra = []) {
  const want = CONTRACT.filter((c) => c.patch === null || LEVELS[c.patch] <= LEVELS[level]).map((c) => c.name);
  return level === "0039" ? [...new Set([...want, ...extra])] : want;
}

/**
 * The static checks of the gate on a runtime's files, as `{ ok, label, extra }` lines (a note has
 * `note: true` and never fails):
 *  S1 (0039 on) no generated Lean name is exported or bound, lean.js is small, lean.wasm is not a
 *     dynamically linked module (no dylink.0, no GOT import) and has few exports, the 0017 gate is gone;
 *  S2 every contract name the runtime's level requires is bound on Module to a function export;
 *  S6 the [GLUE] surface (REQ items fail, TEST items are reported).
 * `seed`: the names of src/emscripten-exports.seed.txt when the gate runs from the repository.
 */
export function staticChecks({ glue, wasmBytes, seed = null }) {
  const out = [];
  const wasm = readWasm(wasmBytes);
  const level = contractLevel(glue, wasm);
  const bindings = exportBindings(glue);
  if (level === "0039") {
    const generated = [...bindings.keys()].filter((n) => /^_(?:l_|lp_|initialize_|runtime_initialize_|meta_initialize_)/.test(n));
    out.push({ ok: generated.length === 0, label: "[0039] S1 no generated Lean name is exported (the interpreter's names live in the in-module table)",
      extra: generated.length ? `${generated.length} bound, e.g. ${generated.slice(0, 3).join(", ")}` : "" });
    out.push({ ok: Buffer.byteLength(glue) < 1 << 20, label: "[0039] S1 lean.js is under 1 MiB (no per-export glue)", extra: `${Buffer.byteLength(glue)} bytes` });
    const gone = ["qed64_symbol_exists", "qed64ExportSet"].filter((n) => glue.includes(n));
    out.push({ ok: gone.length === 0, label: "[0039] S1 the export-set gate of 0017 is gone from the glue", extra: gone.join(", ") });
    if (!wasm.ok) out.push({ ok: false, label: "[0039] S1 lean.wasm is a statically linked module", extra: `lean.wasm unreadable: ${wasm.error}` });
    else {
      const dylink = wasm.customs.filter((c) => c.startsWith("dylink"));
      const got = wasm.imports.filter((i) => i.module.startsWith("GOT."));
      out.push({ ok: dylink.length === 0 && got.length === 0 && wasm.exports.size < 1000,
        label: "[0039] S1 lean.wasm is a statically linked module (no dylink.0 section, no GOT import, few exports)",
        extra: `${wasm.exports.size} exports, ${wasm.imports.length} imports${dylink.length ? `, sections ${dylink.join(",")}` : ""}${got.length ? `, ${got.length} GOT imports` : ""}` });
    }
  } else {
    out.push({ note: true, label: `[0039] S1 skipped: a runtime before 0039 (level ${level}; its glue binds the generated exports)` });
  }
  const want = requiredExports(level, seed ?? []);
  const problems = [];
  for (const n of want) {
    const raw = bindings.get(n);
    if (!raw) problems.push(`${n} not bound on Module`);
    else if (wasm.ok && wasm.exports.get(raw) !== 0) problems.push(`${n} -> wasmExports["${raw}"] is not a function export`);
  }
  if (!wasm.ok) problems.push(`lean.wasm unreadable: ${wasm.error}`);
  out.push({ ok: problems.length === 0, label: `S2 the JavaScript contract: ${want.length} names bound on Module to function exports (level ${level}${seed && level === "0039" ? ", with the repository's seed" : ""})`,
    extra: problems.slice(0, 8).join("; ") + (problems.length > 8 ? `; … ${problems.length} in all` : "") });
  const req = GLUE_SURFACE.filter((s) => s.need === "REQ"), test = GLUE_SURFACE.filter((s) => s.need === "TEST");
  const missing = req.filter((s) => !s.test(glue));
  out.push({ ok: missing.length === 0, label: `S6 the [GLUE] surface hosts reach into (${req.length} items: QED64's worker, node-runner)`,
    extra: missing.map((s) => `${s.id}: ${s.what}`).join("; ") });
  const absent = test.filter((s) => !s.test(glue));
  out.push({ note: true, label: `S6 test-probe internals: ${absent.length ? `absent ${absent.map((s) => s.id).join(", ")}` : `all ${test.length} present`}` });
  return { level, results: out };
}
