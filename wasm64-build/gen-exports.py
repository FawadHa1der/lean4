#!/usr/bin/env python3
"""Generate the runtime's native-symbol table and its JavaScript export list from THIS build.

Two outputs, both from the build's own compiled Init/Std/Lean (patch 0039):

1. The TABLE (`--symtab <c>`, `--symtab-manifest <json>`): one C translation unit,
   lean_wasm_symtab.c, linked into the `lean` executable only (src/stdlib.make.in). It holds,
   sorted bytewise and front-coded, the name and address of every symbol the IR interpreter
   and runModInitCore may resolve by name; src/library/wasm_symtab.cpp searches it, so
   lookup_symbol_in_cur_exe needs no dlsym, no JavaScript and no wasm export. Its categories
   are CORRECTNESS requirements (the commits that introduced them, as exports, say why):

     boxed   every l_<stem>___boxed wrapper (l_<stem>_00__boxed when the stem ends in `__`,
             as mkMangledBoxedName names it). lookup_symbol tries the boxed wrapper first for
             every call; without it interpreted frames never bottom out in native code and a
             browser worker's stack overflows while interpreting an external package's
             initializers.
     init    every initialize_/runtime_initialize_/meta_initialize_<Module>. runModInitCore
             falls back to INTERPRETING a module's init attributes when the symbol is missing;
             the native initializer already ran at boot and is re-entry guarded, the
             interpreted replay is not ("Option already exists").
     cell    every exported constant cell (a data symbol). The interpreter reads `initialize`
             decls' values from the native cell; a miss re-runs the initializer interpreted
             and diverges from the native state.
     export  every other function the Lean C defines (the @[export] names): lookup_symbol's
             second probe when a decl has no boxed wrapper.
     plain   every l_* function WITHOUT a boxed wrapper: all-object, owned arguments, at most
             16 of them (requiresBoxedVersion is false), so the interpreter may call it as it
             calls a boxed wrapper. lookup_symbol's second probe; with it interpreted code calls
             every core function natively, as native `lean` (-rdynamic) does. In the table
             since 0039b (INCLUDE_PLAIN, below); each prototype must show that shape, or nothing
             is written (a misclassified name, like the `_00__boxed` ones once, is never called).
   l_* functions that HAVE a boxed wrapper are never asked for and stay out.

   Declarations are copied from the defining C file's own LEAN_EXPORT line, so every signature
   is exact (wasm-ld replaces a reference whose signature differs from the definition with an
   `unreachable` stub; build.sh's link check looks for one). Cells become `extern`
   declarations; initializers have the fixed signature lean_object*(uint8_t). The TU includes
   no Lean header: lean_object is an incomplete type there.

   Selection: from the archives that are linked (`--archives libInit.a libStd.a libLean.a`,
   read with an nm that understands wasm objects, `--nm`), cross-checked against the C: both
   must give the same names with the same kinds, or nothing is written (build check B1: C
   that no archive holds is stale, an archive symbol no C declares is a scan gap). Without
   --archives, the C alone. Floors per kind (B2) catch a scan that found far too little.
   The manifest records the count, the kinds, FNV-1a-64 over `name NUL kind` in table order,
   sha256 of the names, the sizes and where the selection came from; import-release.sh's
   --check run compares it with a fresh one.

2. The EXPORT LIST (src/emscripten-exports.txt, gitignored) = the JavaScript contract, i.e.
   src/emscripten-exports.seed.txt: what a host's JavaScript calls (QED64's worker and probes,
   this repository's js/ tools, the glue's own built-ins), one name per line with its callers.
   Nothing is exported for the interpreter any more. A seed name that no source file mentions
   any more is dropped LOUDLY: upstream removing an `@[export lean_*]` would otherwise fail the
   link one name at a time. Check that nothing outside the tree (JS glue, workers) called it.

History: through Lean 4.33 a committed list (`emscripten-exports.wanted.txt`) was filtered; it
never picked up names our own patches introduced and missed v4.34.0's 5,812 new boxed
wrappers. Patch 0032 generated the list from the C instead: seed + boxed + init + cell, about
106k exports that every Worker's glue bound and the dynamic linker re-registered (~129 MiB of
JS heap per Worker). Patch 0039 moved those names into the table, and 0039b added the plain
functions without a wrapper, which no export list had held. The slim (iPhone WebKit)
list (`--slim`) is retired with it: the per-export glue cost it avoided is gone, Safari has no
Memory64, and nothing consumed bin-slim.

Usage: gen-exports.py <stage1/lib/temp> <lean4/src> --symtab-manifest <json>
                      [--symtab <c>] [--archives <libInit.a> <libStd.a> <libLean.a> [--nm <tool>]]
                      [--check]
  Writes <lean4/src>/emscripten-exports.txt, the table and the manifest, each only when its
  content changes: they are prerequisites of the `lean` link, so an unchanged rewrite would
  relink it. Exit 1 on any failed check (nothing written then), 2 on usage.
  --nm: an nm that reads wasm objects (llvm-nm; Apple's nm is LLVM's). Default `auto`: llvm-nm
        on PATH, else nm. An nm that cannot read the archives is an error, never a fallback.
  --check: write nothing. Recompute both, print the counts, compare the export list with the
        one on disk and the table with the manifest at --symtab-manifest (the build's): exit 1
        when either differs.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

GENERATOR = "gen-exports/0039b"
# Patch 0039 shipped the table without the plain functions (r3's resolvable set: boxed, init,
# cell, export); 0039b adds them, its own measured step (stack margins, compile time). False
# rebuilds 0039's table, for an A/B; the gate's EXPECT_PLAIN_NATIVE (js/gate.mjs) goes with it.
INCLUDE_PLAIN = True
BLOCK = 16             # front coding restarts every BLOCK names (a whole name heads each block)
MAXLEN = 4096          # the longest name the runtime's decoder takes (wasm_symtab.cpp)
KIND = {"boxed": 0, "plain": 1, "export": 2, "cell": 3, "init": 4, "init_rt": 5, "init_meta": 6}
# B2: a scan that found far fewer names than v4.34.0 has is broken, not small
# (v4.34.0: boxed 90,208, plain 29,538, export 228, cell 8,295, 2,356 modules)
FLOORS = {"boxed": 80000, "plain": 25000, "export": 100, "cell": 7000}
if not INCLUDE_PLAIN:
    del FLOORS["plain"]
MIN_MODULES = 2000
# A plain function's prototype: owned objects in (1 to closureMaxArgs = 16 of them), an object
# out, the shape the interpreter calls (`curry`, closures) and requiresBoxedVersion promises.
ALL_OBJECT = re.compile(r"LEAN_EXPORT lean_object\* [A-Za-z_][A-Za-z0-9_]*\(lean_object\*(?:, lean_object\*){0,15}\);")
ROOTS = ("Init", "Std", "Lean")
INIT_PREFIXES = ("initialize_", "runtime_initialize_", "meta_initialize_")

ap = argparse.ArgumentParser(prog="gen-exports.py",
                             description="The runtime's native-symbol table and JavaScript export list, from this build.")
ap.add_argument("temp", help="stage1/lib/temp: the compiled Init/Std/Lean C")
ap.add_argument("src", help="the lean4 src/ dir (the seed in, the export list out)")
ap.add_argument("--symtab", help="the table's C translation unit to write")
ap.add_argument("--symtab-manifest", required=True, help="the table's manifest (written; with --check, compared)")
ap.add_argument("--archives", nargs="+", metavar="LIB", help="the linked libInit.a libStd.a libLean.a")
ap.add_argument("--nm", default="auto", help="an nm that reads wasm objects (default auto: llvm-nm on PATH, else nm)")
ap.add_argument("--check", action="store_true", help="write nothing; compare with the list on disk and the manifest")
# the package's unit tests run the generator on a few synthetic C files, far below every floor
ap.add_argument("--no-floors", action="store_true", help=argparse.SUPPRESS)
opts = ap.parse_args()
if opts.no_floors:
    FLOORS, MIN_MODULES = {k: 0 for k in FLOORS}, 1
if not opts.check and not opts.symtab:
    ap.error("--symtab <c> is required (except with --check)")
temp, src = opts.temp, opts.src


def fail(msg):
    print(f"gen-exports: {msg}", file=sys.stderr)
    sys.exit(1)


# ---------- classification (one rule for the C and the archives) ----------

def is_boxed(name):
    """A boxed wrapper as mkMangledBoxedName (NameMangling.lean) names one: stem + `___boxed`,
    or stem + `_00__boxed` for a stem ending in `__`."""
    return name.endswith("___boxed") or (name.endswith("_00__boxed") and name[:-len("_00__boxed")].endswith("__"))


def boxed_of(stem):
    """mkMangledBoxedName: the wrapper the interpreter probes before `stem`."""
    return stem + ("_00__boxed" if stem.endswith("__") else "___boxed")


def classify_function(name):
    if name.startswith("initialize_"):
        return "init"
    if name.startswith("runtime_initialize_"):
        return "init_rt"
    if name.startswith("meta_initialize_"):
        return "init_meta"
    if is_boxed(name):
        return "boxed"
    return "fn" if name.startswith("l_") else "export"


# ---------- the C scan: every LEAN_EXPORT name, its kind and its declaration ----------

LINE = re.compile(r'^LEAN_EXPORT\s+([A-Za-z_][A-Za-z0-9_ \*]*?)\s*\b([A-Za-z_][A-Za-z0-9_]*)\s*(\(|;|=)(.*)$', re.M)
c_kind = {}    # name -> boxed | fn | export | cell | init | init_rt | init_meta
c_decl = {}    # name -> the declaration the table repeats (None until a prototype is seen)
c_where = {}   # name -> the C file that declares it
c_files = 0


def scan(path):
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        text = fh.read()
    for m in LINE.finditer(text):
        ty, name, tok, rest = m.group(1).strip(), m.group(2), m.group(3), m.group(4)
        if tok != "(" and not name.startswith(INIT_PREFIXES):
            kind, decl = "cell", f"extern {ty} {name};"   # a copied tentative definition would be a second one
        else:
            kind = classify_function(name)
            if kind.startswith("init"):
                decl = f"lean_object* {name}(uint8_t);"   # EmitC.lean: LEAN_EXPORT lean_object* initialize_X(uint8_t builtin)
            else:
                # a prototype ends in `);` (a definition carries parameter names and ends in `{`)
                decl = m.group(0).strip() if rest.rstrip().endswith(");") else None
        old = c_kind.get(name)
        # a function sighting wins over a cell one (a cell may be re-declared by its users), and a
        # prototype over a definition line
        if old is None or (old == "cell" and kind != "cell"):
            c_kind[name], c_decl[name], c_where[name] = kind, decl, path
        elif old == kind and c_decl[name] is None and decl is not None:
            c_decl[name] = decl


for root in ROOTS:
    for r, dirs, files in os.walk(os.path.join(temp, root)):
        dirs.sort()
        for f in sorted(files):
            if f.endswith(".c"):
                scan(os.path.join(r, f))
                c_files += 1
    top = os.path.join(temp, root + ".c")
    if os.path.exists(top):
        scan(top)
        c_files += 1
if not c_kind:
    fail(f"no compiled C under {temp} — run make_stdlib first")


# ---------- the archive scan and the cross-check (B1) ----------

def resolve_nm(choice):
    if choice != "auto":
        return choice
    for tool in ("llvm-nm", "nm"):
        found = shutil.which(tool)
        if found:
            return found
    fail("--nm auto: neither llvm-nm nor nm is on PATH (QED64_NM names an nm that reads wasm objects)")


NM_LINE = re.compile(r'^[0-9A-Fa-f]*\s+([A-Za-z])\s+(\S+)$')
FUNCTION_TYPES = set("TW")
DATA_TYPES = set("DBRCVG")   # data, bss, read-only, common, ...: a wasm object's cells are D


def archive_kinds(archives, nm):
    kinds, where = {}, {}
    for lib in archives:
        if not os.path.isfile(lib):
            fail(f"--archives: {lib} does not exist")
        try:
            r = subprocess.run([nm, "--defined-only", "-g", lib], capture_output=True, text=True, errors="surrogateescape")
        except OSError as e:
            fail(f"--nm {nm}: {e}")
        if r.returncode != 0:
            fail(f"{nm} cannot read {lib} (exit {r.returncode}): {r.stderr.strip()[:300]}\n"
                 "  an nm that reads wasm objects is required: llvm-nm, or Apple's nm (QED64_NM)")
        functions = 0
        for line in r.stdout.splitlines():
            m = NM_LINE.match(line.strip())
            if not m:
                continue        # member headers, blank lines
            t, name = m.group(1), m.group(2)
            if t in FUNCTION_TYPES:
                kind = classify_function(name)
                functions += 1
            elif t in DATA_TYPES:
                kind = "cell"
            else:
                fail(f"{lib}: {name} has nm type {t!r}, which this generator does not classify")
            if name in kinds:
                fail(f"{name} is defined in {where[name]} and in {lib}")
            kinds[name], where[name] = kind, lib
        if functions == 0:
            fail(f"{nm} read no function from {lib}: an nm that reads wasm objects is required (QED64_NM)")
    return kinds


source, agreement = "c", None
if opts.archives:
    nm = resolve_nm(opts.nm)
    a_kind = archive_kinds(opts.archives, nm)
    only_c = sorted(set(c_kind) - set(a_kind))
    only_a = sorted(set(a_kind) - set(c_kind))
    differ = sorted(n for n in set(c_kind) & set(a_kind) if c_kind[n] != a_kind[n])
    if only_c or only_a or differ:
        print("gen-exports: the archives and the C disagree (B1) — nothing written", file=sys.stderr)
        for title, names, show in (
                ("in the C, in no archive (stale C under lib/temp? a module upstream removed)", only_c,
                 lambda n: f"{n}   ({os.path.relpath(c_where[n], temp)})"),
                ("in an archive, in no C (a scan gap: LEAN_EXPORT placement or format changed)", only_a, lambda n: n),
                ("kinds differ", differ, lambda n: f"{n}: C {c_kind[n]}, archive {a_kind[n]}")):
            if names:
                print(f"  {title}: {len(names)}", file=sys.stderr)
                for n in names[:20]:
                    print(f"    {show(n)}", file=sys.stderr)
        sys.exit(1)
    source, agreement = "archives", True
    print(f"symtab: the archives ({len(a_kind)} symbols, {nm}) and the C agree")


# ---------- the selection ----------

functions = {n for n, k in c_kind.items() if k != "cell"}
entries, plain_candidates = [], 0
for name, kind in c_kind.items():
    if kind == "fn":
        if boxed_of(name) in functions:
            continue        # the interpreter asks for the wrapper, never for this
        plain_candidates += 1
        if not INCLUDE_PLAIN:
            continue
        kind = "plain"
    if c_decl[name] is None:
        fail(f"no one-line prototype for function {name} ({c_where[name]})")
    if kind == "plain" and not ALL_OBJECT.fullmatch(c_decl[name]):
        fail(f"plain function {name} ({c_where[name]}) does not take 1 to 16 objects and return one, the shape "
             f"the interpreter calls: {c_decl[name]}\n  a boxed wrapper the classification missed (is_boxed)?")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        fail(f"{name!r} is not a C identifier")
    if len(name) > MAXLEN:
        fail(f"{name[:80]}… is {len(name)} bytes long; the runtime's decoder takes at most {MAXLEN}")
    entries.append((name, kind, c_decl[name]))
entries.sort(key=lambda e: e[0].encode())
for a, b in zip(entries, entries[1:]):
    if a[0].encode() >= b[0].encode():
        fail(f"the table is not strictly sorted at {a[0]} / {b[0]}")
counts = {k: sum(1 for e in entries if e[1] == k) for k in KIND}
modules = counts["init"]
low = [f"{k} {counts[k]} < {v}" for k, v in FLOORS.items() if counts[k] < v]
if modules < MIN_MODULES or counts["init_rt"] != modules or counts["init_meta"] != modules or modules != c_files:
    low.append(f"initializers {counts['init']}/{counts['init_rt']}/{counts['init_meta']} for {c_files} C files "
               f"(want one of each kind per module, at least {MIN_MODULES} modules)")
if low:
    fail("the selection is below its floors (B2) — nothing written: " + "; ".join(low))

# front coding: a block's head holds its whole name, every other name [shared-prefix byte][suffix] NUL
blob, block_off, prev, maxlen = bytearray(), [], b"", 0
for i, (name, _, _) in enumerate(entries):
    nb = name.encode()
    maxlen = max(maxlen, len(nb))
    if i % BLOCK == 0:
        block_off.append(len(blob))
        blob += nb + b"\0"
    else:
        shared, lim = 0, min(len(prev), len(nb), 255)
        while shared < lim and prev[shared] == nb[shared]:
            shared += 1
        blob += bytes([shared]) + nb[shared:] + b"\0"
    prev = nb
fnv = 0xcbf29ce484222325
for name, kind, _ in entries:
    for byte in name.encode() + b"\0" + bytes([KIND[kind]]):
        fnv = ((fnv ^ byte) * 0x100000001b3) & 0xffffffffffffffff
manifest = {
    "generator": GENERATOR,
    "count": len(entries),
    "counts": counts,
    "fnv1a64": f"{fnv:016x}",
    "names_sha256": hashlib.sha256(b"\n".join(e[0].encode() for e in entries)).hexdigest(),
    "block": BLOCK,
    "blob_bytes": len(blob),
    "raw_name_bytes": sum(len(e[0]) + 1 for e in entries),
    "maxlen": maxlen,
    "include_plain": INCLUDE_PLAIN,
    "plain_candidates": plain_candidates,
    "modules": modules,
    "c_files": c_files,
    "source": source,
    "archives_agree": agreement,
}
# what --check compares: the table's identity, not how it was produced
IDENTITY = ("count", "counts", "fnv1a64", "names_sha256", "block", "blob_bytes", "maxlen", "include_plain")


def c_bytes(b):
    """A C string literal in ~100-byte pieces; every byte that is not an identifier character as a
    3-digit octal escape (raw bytes >= 128 broke the first prototype)."""
    out, piece = [], []
    for byte in b:
        ch = chr(byte)
        piece.append(ch if byte < 128 and (ch.isalnum() or ch == "_") else "\\%03o" % byte)
        if len(piece) >= 100:
            out.append('"' + "".join(piece) + '"')
            piece = []
    if piece:
        out.append('"' + "".join(piece) + '"')
    return "\n".join(out)


def table_tu():
    o = ["/* GENERATED by wasm64-build/gen-exports.py --symtab from this build's Init/Std/Lean: do not edit.",
         "   The runtime's native-symbol table (patch 0039), searched by src/library/wasm_symtab.cpp. */",
         "#include <stdint.h>", "#include <stddef.h>",
         "typedef struct lean_object lean_object;",
         '#define LEAN_EXPORT __attribute__((visibility("default")))']
    o += [decl for _, _, decl in entries]
    o.append(f"const uint64_t lean_wasm_symtab_count = {len(entries)}u;")
    o.append(f"const uint32_t lean_wasm_symtab_block = {BLOCK}u;")
    o.append(f"const uint32_t lean_wasm_symtab_maxlen = {maxlen}u;")
    o.append(f"const uint64_t lean_wasm_symtab_fnv = 0x{fnv:016x}ull;")
    o.append(f"const uint64_t lean_wasm_symtab_blob_size = {len(blob)}u;")
    o.append("const unsigned char lean_wasm_symtab_names[] =\n" + c_bytes(bytes(blob)) + ";")
    o.append("const uint32_t lean_wasm_symtab_block_off[] = {" + ",".join(map(str, block_off)) + "};")
    o.append("const uint8_t lean_wasm_symtab_kind[] = {" + ",".join(str(KIND[k]) for _, k, _ in entries) + "};")
    o.append("void * const lean_wasm_symtab_addr[] = {")
    o += [f"  (void*)&{n}," if k == "cell" else f"  (void*){n}," for n, k, _ in entries]
    o.append("};")
    return "\n".join(o) + "\n"


# ---------- the export list: the JavaScript contract ----------

def read_list(name):
    """The names of a list file; `#` starts a comment, on its own line or after a name."""
    out = []
    with open(os.path.join(src, name)) as fh:
        for line in fh:
            item = line.split("#", 1)[0].strip()
            if item:
                out.append(item)
    return out


# A seed name must still exist SOMEWHERE in the tree (a C/C++ definition or an @[export] in Lean);
# libc and glue names live in the Emscripten sysroot instead.
SYSROOT = {"_main", "_malloc", "_free", "_calloc", "_realloc", "_memalign", "_posix_memalign", "_pthread_self"}
words = set()
for r, dirs, files in os.walk(src):
    dirs[:] = [d for d in dirs if d not in ("tests", ".lake")]
    for f in files:
        if f.endswith((".cpp", ".h", ".hpp", ".c", ".lean")):
            with open(os.path.join(r, f), errors="ignore") as fh:
                words.update(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', fh.read()))
seed_all = read_list("emscripten-exports.seed.txt")
twice = sorted({s for s in seed_all if seed_all.count(s) > 1})
if twice:
    fail(f"listed twice in emscripten-exports.seed.txt: {', '.join(twice)}")
seed = [s for s in seed_all if s in SYSROOT or s.startswith("_emscripten") or s.startswith("__") or s[1:] in words]
vanished = [s for s in seed_all if s not in seed]
exports_text = "\n".join(seed) + "\n"

print(f"symtab: {len(entries)} entries = " + " + ".join(f"{k} {counts[k]}" for k in KIND)
      + f"; names {len(blob)} B front-coded (raw {manifest['raw_name_bytes']} B), longest {maxlen}, fnv {fnv:016x}"
      + f"; plain functions {'in the table' if INCLUDE_PLAIN else 'left out'}: {plain_candidates}")
print(f"exports: the JavaScript contract, {len(seed)} names (src/emscripten-exports.seed.txt)")
if vanished:
    print(f"SEED NAMES NO LONGER DEFINED ANYWHERE IN src/ — dropped ({len(vanished)}):")
    for v in vanished:
        print("  " + v)
    print("  -> upstream removed them (usually an @[export]); confirm no JS/worker caller used them,")
    print("     then delete them from src/emscripten-exports.seed.txt.")

target = os.path.join(src, "emscripten-exports.txt")


def write_if_changed(path, text):
    """Write `text` to `path` unless the file already holds exactly that: each output is a
    prerequisite of the `lean` link (src/stdlib.make.in), and rewriting one unchanged would
    relink. True when it wrote."""
    try:
        with open(path) as fh:
            if fh.read() == text:
                return False
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as out:
        out.write(text)
    return True


if opts.check:
    bad = []
    try:
        with open(target) as fh:
            on_disk = fh.read()
        if on_disk != exports_text:
            old, new = set(on_disk.split()), set(seed)
            bad.append(f"the export list on disk is not this tree's (+{len(new - old)} -{len(old - new)}): {target}")
    except FileNotFoundError:
        bad.append(f"no export list at {target}")
    try:
        with open(opts.symtab_manifest) as fh:
            built = json.load(fh)
        diff = [k for k in IDENTITY if built.get(k) != manifest[k]]
        if diff:
            bad.append(f"the table differs from the build's manifest {opts.symtab_manifest}: "
                       + ", ".join(f"{k} {built.get(k)} vs {manifest[k]} now" for k in diff))
    except (OSError, ValueError) as e:
        bad.append(f"no readable table manifest at {opts.symtab_manifest}: {e}")
    if bad:
        for b in bad:
            print(f"CHECK FAILED: {b}")
        sys.exit(1)
    print(f"check: the export list and the table (fnv {manifest['fnv1a64']}) are the build's")
    sys.exit(0)

for path, text in ((target, exports_text), (opts.symtab, table_tu()),
                   (opts.symtab_manifest, json.dumps(manifest, indent=1) + "\n")):
    print(f"{'wrote' if write_if_changed(path, text) else 'unchanged'}: {path}")
