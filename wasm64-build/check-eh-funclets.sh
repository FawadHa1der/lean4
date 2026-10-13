#!/bin/bash
# Patch 0040's funclet guard: proves, per build, that LLVM's WinEHPrepare did not turn a call inside
# a C++ catch handler into `unreachable` — the failure mode of two open LLVM bugs under native Wasm
# EH (#226286, GVN scalar PRE; #229448, JumpThreading), silent at compile time and a trap at run time.
# Runs INSIDE the toolchain container (build.sh step 5b):
#
#   check-eh-funclets.sh <stage1 build dir, e.g. /build/stage1> <scratch dir, e.g. /build/eh-funclet-check>
#
# Method: compile the same code twice, as built and with `-mllvm -disable-cleanups` (which switches
# off exactly that rewrite); identical objects mean the rewrite never fired. Covered:
#   1. positive controls (eh-funclet-controls/: the two bugs' shapes) must DIFFER, or the method is blind;
#   2. every C++ translation unit of the stage1 build (its compile_commands.json, exact commands);
#   3. the EH-mode Emscripten system libraries the link uses (libc++, libc++abi, libunwind: rebuilt
#      twice with embuilder; the second build must show the flag in its commands).
# Generated Lean C has no EH IR, so it cannot be affected and is not compiled again.
# Exit 0: clean, or the build is not native-EH (skipped, said so). Exit 1: a difference, a blind
# method or a failed compile. ~1 min for 1-2, a few minutes for 3.
set -euo pipefail
STAGE1="${1:?usage: check-eh-funclets.sh <stage1 build dir> <scratch dir>}"
OUT="${2:?usage: check-eh-funclets.sh <stage1 build dir> <scratch dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CC_JSON="$STAGE1/compile_commands.json"
NOCLN="-mllvm -disable-cleanups"
unset EM_COMPILER_WRAPPER   # no ccache: both compiles must really run
rm -rf "$OUT"; mkdir -p "$OUT"
fail=0
say() { echo "check-eh-funclets: $*"; }

[ -f "$CC_JSON" ] || { say "no $CC_JSON (configure with CMAKE_EXPORT_COMPILE_COMMANDS, src/CMakeLists.txt)"; exit 1; }
if ! grep -q -- '-fwasm-exceptions' "$CC_JSON"; then
  say "the build does not use native Wasm EH (no -fwasm-exceptions in its compile commands): skipped"; exit 0
fi
EHFLAGS="-fwasm-exceptions"; grep -q -- '-sWASM_LEGACY_EXCEPTIONS=1' "$CC_JSON" && EHFLAGS="$EHFLAGS -sWASM_LEGACY_EXCEPTIONS=1"

# ---------- 1. positive controls ----------
mkdir -p "$OUT/controls"
for f in "$HERE"/eh-funclet-controls/*.cpp; do
  n="$(basename "$f" .cpp)"
  em++ -O2 -m64 -pthread $EHFLAGS -c "$f" -o "$OUT/controls/$n.base.o"
  em++ -O2 -m64 -pthread $EHFLAGS $NOCLN -c "$f" -o "$OUT/controls/$n.nocln.o"
  if cmp -s "$OUT/controls/$n.base.o" "$OUT/controls/$n.nocln.o"; then
    say "CONTROL $n: identical — the method no longer sees the bug class (toolchain changed?)"; fail=1
  else say "control $n: differs, as it must"; fi
done

# ---------- 2. the build's C++ translation units ----------
python3 - "$CC_JSON" "$OUT/tu" "$NOCLN" > "$OUT/tu-jobs.sh" <<'PY'
import json, shlex, sys, os
cc, out, nocln = sys.argv[1], sys.argv[2], sys.argv[3]
for i, e in enumerate(json.load(open(cc))):
    if not e["file"].endswith((".cpp", ".cc", ".cxx")): continue
    args = shlex.split(e["command"]) if "command" in e else list(e["arguments"])
    if "-o" not in args: continue
    k = args.index("-o")
    for mode, extra in (("base", []), ("nocln", nocln.split())):
        o = os.path.join(out, mode, f"{i:04d}-{os.path.basename(e['file'])}.o")
        a = args[:k] + extra + ["-o", o] + args[k + 2:]
        print(f"mkdir -p {shlex.quote(os.path.dirname(o))} && cd {shlex.quote(e['directory'])} && {shlex.join(a)}")
PY
NJOBS="$(grep -c . "$OUT/tu-jobs.sh" || true)"
[ "$NJOBS" -gt 0 ] || { say "no C++ entries in $CC_JSON"; exit 1; }
tr '\n' '\0' < "$OUT/tu-jobs.sh" | xargs -0 -P "$(nproc)" -I{} bash -c '{} || echo "COMPILE FAILED: {}"' > "$OUT/tu-compile.log" 2>&1 || true
if grep -q 'COMPILE FAILED' "$OUT/tu-compile.log"; then say "compiles failed ($OUT/tu-compile.log)"; grep 'COMPILE FAILED' "$OUT/tu-compile.log" | head -3; exit 1; fi
same=0; diffs=0
for o in "$OUT"/tu/base/*.o; do
  if cmp -s "$o" "$OUT/tu/nocln/$(basename "$o")"; then same=$((same+1)); else
    say "DIFFERS: $(basename "$o") — a catch-handler call became unreachable in this TU"; diffs=$((diffs+1)); fi
done
say "build C++: $same translation units identical, $diffs differ"
[ "$diffs" -eq 0 ] || fail=1

# ---------- 3. the EH-mode system libraries ----------
CACHE="$(em-config CACHE)"; LIBDIR="$CACHE/sysroot/lib/wasm64-emscripten"
mkdir -p "$OUT/libs/base" "$OUT/libs/nocln"
printf '#include <string>\n#include <stdexcept>\nint main(int c, char**) { try { if (c > 5) throw std::runtime_error(std::string("x")); } catch (const std::exception &e) { return 1; } return 0; }\n' > "$OUT/libs/t.cpp"
em++ -O3 -m64 -pthread $EHFLAGS "$OUT/libs/t.cpp" -o "$OUT/libs/t.js" > "$OUT/libs/link.log" 2>&1 || { say "the probe link failed ($OUT/libs/link.log)"; exit 1; }
mapfile -t LIBS < <(cd "$LIBDIR" && ls *except*.a 2>/dev/null | grep -v noexcept | sed 's/\.a$//')
[ "${#LIBS[@]}" -gt 0 ] || { say "no EH-mode system library in $LIBDIR after the probe link"; exit 1; }
for l in "${LIBS[@]}"; do
  cp "$LIBDIR/$l.a" "$OUT/libs/base/$l.a"
  EMCC_CFLAGS="$NOCLN" embuilder build "$l" --wasm64 --force -v > "$OUT/libs/$l.nocln.log" 2>&1 || { say "embuilder $l failed"; tail -5 "$OUT/libs/$l.nocln.log"; exit 1; }
  cp "$LIBDIR/$l.a" "$OUT/libs/nocln/$l.a"
  grep -q -- '-disable-cleanups' "$OUT/libs/$l.nocln.log" || { say "$l: the rebuild did not carry $NOCLN (EMCC_CFLAGS ignored?): method blind"; fail=1; continue; }
  for m in base nocln; do mkdir -p "$OUT/libs/$m/$l.x"; (cd "$OUT/libs/$m/$l.x" && emar x "../$l.a"); done
  ld=0; ls=0
  for o in "$OUT/libs/base/$l.x"/*; do
    if cmp -s "$o" "$OUT/libs/nocln/$l.x/$(basename "$o")"; then ls=$((ls+1)); else say "DIFFERS: $l: $(basename "$o")"; ld=$((ld+1)); fi
  done
  say "system library $l: $ls members identical, $ld differ"
  [ "$ld" -eq 0 ] || fail=1
done

if [ "$fail" -eq 0 ]; then say "passed"; else say "FAILED (see above; scratch: $OUT)"; fi
exit "$fail"
