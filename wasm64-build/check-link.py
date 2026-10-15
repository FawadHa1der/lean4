#!/usr/bin/env python3
"""Check the `lean` link (patch 0039's build check B3); build.sh runs it after the final link.

Usage: check-link.py <make output> <bin dir> <lean_wasm_symtab.c> <allowlist>

The runtime links statically and finds Lean's native code through the table gen-exports.py writes
(lean_wasm_symtab.c). Two failures of that link are silent at link time:
- a table declaration whose signature differs from the definition: wasm-ld binds the reference to
  an `unreachable` stub named `signature_mismatch:<name>` and only warns ("function signature
  mismatch");
- a referenced function that no object defines: under ERROR_ON_UNDEFINED_SYMBOLS=0 it becomes a
  JS stub that aborts ("missing function: …") at its first call, and emcc only warns
  ("undefined symbol: …").

Exit 1 on: a signature mismatch in the make output, or a `signature_mismatch:` function in
bin/lean.js.symbols (the symbol map --emit-symbol-map writes; a missing map fails too); an
undefined symbol that is a table entry; once the allowlist has a `# calibrated-from:` line, an
undefined symbol it does not list; a closure-application entry point of the runtime
(lean_apply_1 … lean_apply_16, lean_apply_m, lean_apply_n) missing from the symbol map, i.e. inlined
into its caller (patch 0041: inlined, lean_apply_16 and lean_apply_m turned lean_apply_n, a frame on
every level of a monadic continuation chain, from 0 into 26 locals; src/CMakeLists.txt caps
Binaryen's one-caller inlining so they stay out of line). Otherwise the undefined symbols are
compared with the allowlist and the differences printed. A make output without the link (nothing to relink) skips
the log checks: the binary is the one an earlier check passed. Exit 2: usage.
"""
import os
import re
import sys

if len(sys.argv) != 5:
    print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
    sys.exit(2)
log_path, bin_dir, table_c, allowlist_path = sys.argv[1:]
problems = []


def say(msg):
    print(f"check-link: {msg}")


# the symbol map: a signature_mismatch stub is a function of the binary, whether or not it was logged
symbols = os.path.join(bin_dir, "lean.js.symbols")
if not os.path.isfile(symbols):
    problems.append(f"no symbol map {symbols} (the link passes --emit-symbol-map)")
else:
    stubs = []
    with open(symbols, errors="replace") as fh:
        for line in fh:
            name = line.rstrip("\n").split(":", 1)[-1]
            if name.startswith("signature_mismatch:"):
                stubs.append(name)
    if stubs:
        problems.append(f"{len(stubs)} signature-mismatch stubs in {symbols}: " + ", ".join(stubs[:10]))
    else:
        say(f"no signature-mismatch stub among the functions of {symbols}")
    # patch 0041: the runtime's closure-application entry points stay functions of their own
    with open(symbols, errors="replace") as fh:
        functions = {line.rstrip("\n").split(":", 1)[-1] for line in fh}
    out_of_line = [f"lean_apply_{i}" for i in range(1, 17)] + ["lean_apply_m", "lean_apply_n"]
    inlined = [n for n in out_of_line if n not in functions]
    if inlined:
        problems.append(f"{len(inlined)} closure-application entry points were inlined into their callers (no longer "
                        f"functions of their own; check the one-caller inline cap in src/CMakeLists.txt): " + ", ".join(inlined))
    else:
        say(f"the {len(out_of_line)} closure-application entry points (lean_apply_*) are functions of their own")

with open(log_path, errors="replace") as fh:
    log = fh.read()
if not re.search(r"Building \S*/bin/lean\.js\b", log):
    say(f"{log_path} shows no `lean` link (nothing to relink): the link log was checked when the binary was linked")
else:
    mismatches = [l.strip() for l in log.splitlines() if re.search(r"signature mismatch", l, re.I)]
    if mismatches:
        problems.append(f"{len(mismatches)} signature-mismatch lines in the link log: " + " | ".join(mismatches[:10]))
    undefined = sorted(set(re.findall(r"undefined symbol: ([^\s(]+)", log)))
    with open(table_c, errors="replace") as fh:
        table = set(re.findall(r"^  \(void\*\)&?([A-Za-z_][A-Za-z0-9_]*),$", fh.read(), re.M))
    if not table:
        problems.append(f"no table entries found in {table_c}")
    in_table = [n for n in undefined if n in table]
    if in_table:
        problems.append(f"{len(in_table)} table entries are undefined in the link: " + ", ".join(in_table[:20]))
    allowed, calibrated = set(), None
    with open(allowlist_path) as fh:
        for line in fh:
            m = re.match(r"#\s*calibrated-from:\s*(.*\S)", line.strip())
            if m:
                calibrated = m.group(1)
            name = line.split("#", 1)[0].strip()
            if name:
                allowed.add(name)
    new = [n for n in undefined if n not in allowed and n not in table]
    gone = sorted(allowed - set(undefined))
    say(f"{len(undefined)} undefined symbols in the link; allowlist {len(allowed)} names"
        + (f", calibrated from {calibrated}" if calibrated else ", NOT CALIBRATED (differences are printed, not failed)"))
    for n in new:
        print(f"  new undefined symbol: {n}")
    for n in gone:
        print(f"  allowlisted, no longer undefined: {n}")
    if calibrated and new:
        problems.append(f"{len(new)} undefined symbols not in {allowlist_path} (each aborts at its first call)")
    elif not calibrated and new:
        say(f"to calibrate: add the {len(new)} names above to {allowlist_path} with a `# calibrated-from: <build>` line")

if problems:
    for p in problems:
        print(f"LINK CHECK FAILED: {p}")
    sys.exit(1)
say("passed")
