// The runtime's host knobs and gauges, shared by node-runner and persistent-probe
// (EMBED-RUNTIME.md §3.1):
//
// - forwardWasmEnv: the LEAN_WASM_* variables the runtime's C side reads with getenv, copied
//   from the host environment into Module.ENV. Call it in preRun: the glue replaces any ENV
//   given in the Module literal, and libc's environment is built from ENV once, after preRun.
// - symtabStats: the native-symbol table's gauges and a fresh self-check (kernel patch 0039), or
//   null on a runtime without the table.
// - glueFilesystem, vfsExists: the glue's NODEFS (or WORKERFS) and a path lookup, for the tools'
//   preRun mounts, on the glue of either emsdk this line has used (6.0.5, 7.0.0).
//
// Kernel patch 0038's pool size (LEAN4_WASM64_PTHREAD_POOL), thread-exit knobs and counters
// (runtimeStats, node-runner's [rtstats?]) left with the architecture review's D3b: no host used them.

/** The host variables forwardWasmEnv copies, each read by the runtime once (EMBED-RUNTIME.md §3.1). */
export const FORWARDED_WASM_ENV = Object.freeze([
  "LEAN_WASM_PARKED_DEDICATED", // 0035: idle dedicated threads kept for reuse (default 0)
  "LEAN_WASM_STACK_PROBE_SLOTS", // 0036: the engine-stack probe's headroom, for calibration
  "LEAN_WASM_SYMTAB_TRACE", // 0039: native-symbol lookups to print on stderr (miss|hit|all[:prefixes])
]);

/** Copy every non-empty FORWARDED_WASM_ENV variable of `env` into `ENV` (Module.ENV); returns `ENV`. */
export function forwardWasmEnv(ENV, env = process.env) {
  for (const name of FORWARDED_WASM_ENV) if (env[name]) ENV[name] = env[name];
  return ENV;
}

/**
 * The glue's filesystem `name` ("NODEFS" or "WORKERFS"), for FS.mount in preRun: Module[name], which
 * the kernel's link exports from emsdk 7 on (EXPORTED_RUNTIME_METHODS; emsdk 6.0.13 removed
 * FS.filesystems, emscripten#27940); else FS.filesystems[name] (emsdk 6.0.5's glue); else the
 * glue's top-level var, a property of `g` when the glue was evaluated there (vm.runInThisContext).
 * Throws when none has it: a glue linked without -l<name>.js, or one that keeps it in none of them.
 */
export function glueFilesystem(M, name, g = globalThis) {
  const fsys = M?.[name] ?? M?.FS?.filesystems?.[name] ?? g?.[name];
  if (fsys) return fsys;
  throw new Error(`the runtime's glue exposes no ${name}: not as Module.${name} (exported from emsdk 7 on), `
    + `FS.filesystems.${name} (emsdk 6) or a global ${name} (is lean.js linked with -l${name.toLowerCase()}.js?)`);
}

/**
 * Whether `p` exists in the glue's FS, a final symbolic link followed: FS.analyzePath(p).exists
 * where the glue has it (emsdk 6.0.5; 7.0.0 keeps it unless built with -sSTRICT, deprecated by
 * emscripten#27765), else whether FS.lookupPath(p, { follow: true }) resolves, which is what
 * analyzePath decides `exists` by in both versions (libfs.js).
 */
export function vfsExists(FS, p) {
  if (typeof FS.analyzePath === "function") return !!FS.analyzePath(p).exists;
  try {
    FS.lookupPath(p, { follow: true });
    return true;
  } catch {
    return false;
  }
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
