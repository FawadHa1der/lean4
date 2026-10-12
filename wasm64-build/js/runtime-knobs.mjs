// The runtime's host knobs and counters (kernel patch 0038), shared by node-runner,
// persistent-probe and snapshot-probe (EMBED-RUNTIME.md §3.1, §3.6).
//
// - poolModuleKeys: LEAN4_WASM64_PTHREAD_POOL=<n> → Module.pthreadPoolSize, the number of
//   pthread Workers the glue creates at load. Passed as the raw string ("" or unset: not
//   passed); the glue clamps it to 0..64 and reads anything else as 24, its default. A runtime
//   before 0038 ignores the key (a pool of 24).
// - forwardWasmEnv: the LEAN_WASM_* variables the runtime's C side reads with getenv, copied
//   from the host environment into Module.ENV. Call it in preRun: the glue replaces any ENV
//   given in the Module literal, and libc's environment is built from ENV once, after preRun.
// - runtimeStats: the counters a runtime exports, as one JSON-able object, with null for what
//   this runtime lacks (feature-detected, so it works on every runtime).
// - symtabStats: the native-symbol table's gauges and a fresh self-check (kernel patch 0039), or
//   null on a runtime without the table.

/** The host variables forwardWasmEnv copies, each read by the runtime once (EMBED-RUNTIME.md §3.1). */
export const FORWARDED_WASM_ENV = Object.freeze([
  "LEAN_WASM_PARKED_DEDICATED", // 0035: idle dedicated threads kept for reuse (default 0)
  "LEAN_WASM_PARKED_IDLE_MS", // 0038: a parked thread leaves after that idle time (default: never)
  "LEAN_WASM_STD_SURPLUS_EXIT", // 0038: 1 = standard workers beyond the cap exit (default: stay)
  "LEAN_WASM_STACK_PROBE_SLOTS", // 0036: the engine-stack probe's headroom, for calibration
  "LEAN_WASM_SYMTAB_TRACE", // 0039: native-symbol lookups to print on stderr (miss|hit|all[:prefixes])
]);

/** Module keys from the host environment ("" counts as unset). */
export function poolModuleKeys(env = process.env) {
  const size = env.LEAN4_WASM64_PTHREAD_POOL;
  return size ? { pthreadPoolSize: size } : {};
}

/** Copy every non-empty FORWARDED_WASM_ENV variable of `env` into `ENV` (Module.ENV); returns `ENV`. */
export function forwardWasmEnv(ENV, env = process.env) {
  for (const name of FORWARDED_WASM_ENV) if (env[name]) ENV[name] = env[name];
  return ENV;
}

/** The keys of lean_wasm_task_manager_stat (object.cpp), in key order. */
export const TASK_MANAGER_STATS = Object.freeze(["liveStd", "stdCap", "liveStdPeak", "stdSurplusExits", "parked", "parkedIdleExits"]);

/**
 * The runtime's thread and engine-guard counters, safe to call on the main JS thread at any time
 * (every export it calls is lock-free):
 *   pool:  {target, unused, live} — the pool size the glue computed from Module.pthreadPoolSize
 *          (null before 0038), the idle pool Workers and the Workers running a thread
 *          (Emscripten's PThread; null without one);
 *   tm:    lean_wasm_task_manager_stat by name (TASK_MANAGER_STATS), each null before there is a
 *          task manager; tm is null before 0038;
 *   guard: {probes, trips: [kernel, Core.checkSystem]} (lean_wasm_engine_probes / _guard_trips;
 *          null before 0038).
 * `g` is the glue's global scope (its top-level `var`s), globalThis for a glue evaluated there.
 */
export function runtimeStats(M, g = globalThis) {
  const fn = (name) => (typeof M?.[name] === "function" ? M[name] : null);
  const num = (v) => (typeof v === "bigint" ? Number(v) : v);
  const PT = M?.PThread ?? g?.PThread ?? null;
  const target = g?.leanPthreadPoolTarget;
  const pool = PT || typeof target === "number" ? {
    target: typeof target === "number" ? target : null,
    unused: Array.isArray(PT?.unusedWorkers) ? PT.unusedWorkers.length : null,
    live: PT?.pthreads ? Object.keys(PT.pthreads).length : null,
  } : null;
  const stat = fn("_lean_wasm_task_manager_stat");
  const tm = stat ? Object.fromEntries(TASK_MANAGER_STATS.map((name, key) => {
    const v = num(stat(key));
    return [name, v >= 0 ? v : null];
  })) : null;
  const probes = fn("_lean_wasm_engine_probes"), trips = fn("_lean_wasm_engine_guard_trips");
  const guard = probes && trips ? { probes: num(probes()), trips: [num(trips(0)), num(trips(1))] } : null;
  return { pool, tm, guard };
}

/** The kinds of the native-symbol table, in the runtime's order (gen-exports.py KIND). */
export const SYMTAB_KINDS = Object.freeze(["boxed", "plain", "export", "cell", "init", "init_rt", "init_meta"]);

/**
 * The native-symbol table of a runtime from kernel patch 0039 on (EMBED-RUNTIME.md §2), or null
 * before it. Call it on the main JS thread once the runtime is initialized:
 *   status:   lean_wasm_symtab_selfcheck now, a full decode of the table (0 intact);
 *   count:    its entries; kinds: its entries by kind (SYMTAB_KINDS), as decoded;
 *   fnv:      the FNV-1a-64 the decode computed (16 hex digits; the build's manifest has the same);
 *   hits:     lookups that found an entry, by its kind; misses: lookups that found none.
 */
export function symtabStats(M) {
  const stats = typeof M?._lean_wasm_symtab_stats === "function" ? M._lean_wasm_symtab_stats : null;
  if (!stats) return null;
  const num = (v) => Number(v);
  const check = typeof M._lean_wasm_symtab_selfcheck === "function" ? num(M._lean_wasm_symtab_selfcheck(0n, 0n)) : null;
  const byKind = (base) => Object.fromEntries(SYMTAB_KINDS.map((k, i) => [k, num(stats(base + i))]));
  const half = (key) => BigInt(num(stats(key))).toString(16).padStart(8, "0");
  return {
    status: check, cachedStatus: num(stats(16)), count: num(stats(8)), kinds: byKind(9), fnv: half(17) + half(18),
    hits: byKind(0), misses: num(stats(7)),
  };
}
