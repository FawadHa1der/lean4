#!/usr/bin/env bash
# Relink bin/lean.js locally from a CI "linkkit" artifact, so link-flag
# experiments cost minutes instead of a full CI cycle. emsdk links the same
# wasm objects on any host, so this runs natively on macOS/arm64 — the qemu
# problem only ever applied to *building* the 32-bit stage0.
#
#   1. gh run download <run-id> -R cauli/lean4 -n "linkkit-Web Assembly"
#      && tar --zstd -xf linkkit.tar.zst
#   2. docker-wasm/relink-local.sh <linkkit-dir> <out-dir> [extra emcc flags...]
#
# The flag set below mirrors the `lean` exe link in src/CMakeLists.txt (the
# EMSCRIPTEN_SETTINGS / EMSCRIPTEN_LINK_SETTINGS blocks and the
# LEAN_EXE_LINKER_FLAGS append). If a relink behaves differently from CI,
# diff against the real rule captured in the kit's stdlib.make.txt.
# Requires emsdk active (`emcc` on PATH) at the SAME version as CI
# (.github/workflows/build-template.yml, setup-emsdk step).
# NOTE: these flags are the link before wasm64 patch 0039 (MAIN_MODULE=2, an export
# list the IR interpreter's dlsym searched). The wasm64 `lean` link is static since,
# and takes the generated native-symbol table (lean_wasm_symtab.c,
# wasm64-build/gen-exports.py --symtab) as an input; it is built by
# wasm64-build/build.sh. CI's slim step, this script's other user, is retired.
set -euo pipefail

KIT=${1:?usage: relink-local.sh <linkkit-dir> <out-dir> [extra emcc flags...]}
OUT=${2:?usage: relink-local.sh <linkkit-dir> <out-dir> [extra emcc flags...]}
shift 2
mkdir -p "$OUT"

emcc -o "$OUT/lean.js" \
  "$KIT/libleanmain.a" \
  "$KIT/libleanshell.a" \
  -L "$KIT" -lleancpp -lInit -lStd -lLean -lnodefs.js -lleanrt "$KIT/libuv.a" -lstdc++ \
  -sDISABLE_EXCEPTION_CATCHING=0 -pthread \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINCOMING_MODULE_JS_API=print,printErr,setStatus,locateFile,mainScriptUrlOrBlob,INITIAL_MEMORY,wasmMemory,noInitialRun,preRun,onRuntimeInitialized,onAbort,onExit,arguments,ENV \
  -s EXIT_RUNTIME=1 -s MAIN_MODULE=2 -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS=@"$KIT/emscripten-exports.txt" \
  -sEXPORTED_RUNTIME_METHODS=ccall,callMain,FS,ENV,getValue,setValue,stringToNewUTF8,UTF8ToString \
  -s STACK_SIZE=16777216 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 -sPTHREAD_POOL_SIZE=4 \
  "$@"

ls -la "$OUT"/lean.js "$OUT"/lean.wasm
echo "githash of kit: $(cat "$KIT/githash.txt" 2>/dev/null || echo unknown)"
echo "NOTE: snapshots are function-table-paired — rebake init.snap against this exact output."
