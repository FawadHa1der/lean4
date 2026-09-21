#!/usr/bin/env python3
"""Generate src/emscripten-exports.txt from THIS build's compiled C.

The list is the IR interpreter's dlsym contract (MAIN_MODULE=2 +
-sEXPORTED_FUNCTIONS), not a tuning knob. Three generated categories, each of
which is a CORRECTNESS requirement (see the commits that introduced them):

  boxed  every l_<stem>___boxed wrapper. lookup_symbol tries the boxed wrapper
         first for every call; without it interpreted frames never bottom out
         in native code and a browser worker's ~1 MB JS stack overflows while
         interpreting an external package's initializers.
  init   every initialize_/runtime_initialize_/meta_initialize_<Module>.
         runModInitCore falls back to INTERPRETING a module's init attributes
         when the symbol is missing; the native initializer already ran at
         boot and is re-entry guarded, the interpreted replay is not
         ("Option already exists").
  cell   every exported constant cell (l_<stem> data symbol). The interpreter
         reads `initialize` decls' values from the native cell; a miss re-runs
         the initializer interpreted and diverges from the native state.

Plain l_* FUNCTION exports are deliberately absent: ~119k names that block
dead-code stripping (+18 MB wasm) and that the interpreter never needs — it
dispatches through the boxed wrapper.

`seed` (src/emscripten-exports.seed.txt) holds what the compiler does not
emit: the C runtime API (lean_*), libc entry points and the wasm glue. A seed
name that no source file mentions any more is dropped LOUDLY — upstream
removing an `@[export lean_*]` would otherwise fail the link with one name per
attempt. Check that nothing outside the tree (JS glue, workers) called it.

History: through Lean 4.33 this script filtered a committed list
(`emscripten-exports.wanted.txt`, final = seed + wanted & defined). That list
was exactly boxed + init + cell of the 4.33 tree, and "can only shrink" was
wrong for a version import: v4.34.0 added 5,812 boxed wrappers, 168 module
initializers and 213 cells that the filter would never have exported.

Usage: gen-exports.py <stage1/lib/temp> <lean4/src> [--check]
  --check: do not write; print the category counts and the delta against the
           list currently on disk.
"""
import os
import re
import sys

temp, src = sys.argv[1], sys.argv[2]
check = "--check" in sys.argv
ROOTS = ("Init", "Std", "Lean")
PAT = re.compile(
    r'^LEAN_EXPORT\s+[A-Za-z_][A-Za-z0-9_ \*]*?\b'
    r'((?:l_|initialize_|runtime_initialize_|meta_initialize_)[A-Za-z0-9_]+)\s*(\(|;|=)', re.M)
INIT = re.compile(r'^_(?:runtime_|meta_)?initialize_')

kind = {}  # "_name" -> boxed | init | cell | fn


def scan(path):
    with open(path, errors="ignore") as fh:
        for m in PAT.finditer(fh.read()):
            name = "_" + m.group(1)
            if INIT.match(name):
                k = "init"
            elif m.group(2) != "(":
                k = "cell"
            elif name.endswith("___boxed"):
                k = "boxed"
            else:
                k = "fn"
            # a function is also forward-declared with ';' nowhere, but a cell may
            # be re-declared by its users: a function sighting always wins
            if name not in kind or kind[name] == "cell":
                kind[name] = k


for root in ROOTS:
    for r, _, files in os.walk(os.path.join(temp, root)):
        for f in files:
            if f.endswith(".c"):
                scan(os.path.join(r, f))
    top = os.path.join(temp, root + ".c")
    if os.path.exists(top):
        scan(top)
if not kind:
    sys.exit(f"gen-exports: no compiled C under {temp} — run make_stdlib first")


def read_list(name):
    p = os.path.join(src, name)
    return [l.strip() for l in open(p) if l.strip() and not l.startswith("#")]


# seed names must still exist SOMEWHERE in the tree (C/C++ definition or an
# @[export] in Lean); libc/glue names live in the Emscripten sysroot instead.
SYSROOT = {"_main", "_malloc", "_free", "_calloc", "_realloc", "_memalign", "_posix_memalign"}
words = set()
for r, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in ("tests", ".lake")]
    for f in files:
        if f.endswith((".cpp", ".h", ".hpp", ".c", ".lean")):
            with open(os.path.join(r, f), errors="ignore") as fh:
                words.update(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', fh.read()))
seed_all = read_list("emscripten-exports.seed.txt")
seed = [s for s in seed_all if s in SYSROOT or s.startswith("_emscripten") or s.startswith("__") or s[1:] in words]
vanished = [s for s in seed_all if s not in seed]

generated = sorted(n for n, k in kind.items() if k != "fn")
seedset = set(seed)
final = seed + [n for n in generated if n not in seedset]
counts = {k: sum(1 for v in kind.values() if v == k) for k in ("boxed", "init", "cell", "fn")}
print(f"exports: seed {len(seed)} + boxed {counts['boxed']} + init {counts['init']} + cell {counts['cell']} "
      f"= {len(final)}   (plain functions not exported: {counts['fn']})")
if vanished:
    print(f"SEED NAMES NO LONGER DEFINED ANYWHERE IN src/ — dropped ({len(vanished)}):")
    for v in vanished:
        print("  " + v)
    print("  -> upstream removed them (usually an @[export]); confirm no JS/worker caller used them,")
    print("     then delete them from src/emscripten-exports.seed.txt.")

target = os.path.join(src, "emscripten-exports.txt")
if os.path.exists(target):
    old = set(read_list("emscripten-exports.txt"))
    new = set(final)
    print(f"vs the list on disk: +{len(new - old)} -{len(old - new)}")
if check:
    sys.exit(0)
with open(target, "w") as out:
    out.write("\n".join(final) + "\n")
print(f"wrote {target}")
