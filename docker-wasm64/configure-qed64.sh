#!/bin/sh
# QED64 clean-room configure: identical to configure.sh except
#  * EMSCRIPTEN_MAXIMUM_MEMORY=17179869184 (16 GiB) — the certified runtime's
#    declared maximum; an embedder may import any memory whose maximum is <=
#    this, so 16 GiB keeps every worker configuration type-compatible;
#  * CHECK_OLEAN_VERSION=OFF — this build embeds its real githash while the
#    certified profile packs carry the original producer's; the patch series
#    changes no serialization, and artifact trust lives in the SHA-256
#    manifest layer, so the strict-equality githash gate must stay off.
set -eu
cmake /lean4 --preset release -B /build \
  -DCMAKE_C_COMPILER_WORKS=1 \
  -DCMAKE_TOOLCHAIN_FILE=/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake \
  -DCMAKE_C_FLAGS=-m64 \
  -DCMAKE_CXX_FLAGS=-m64 \
  -DCMAKE_AR=/emsdk/upstream/emscripten/emar \
  -DSTAGE0_CMAKE_C_COMPILER=/usr/bin/gcc \
  -DSTAGE0_CMAKE_CXX_COMPILER=/usr/bin/g++ \
  -DSTAGE0_CMAKE_EXECUTABLE_SUFFIX= \
  -DSTAGE0_USE_GMP=OFF \
  -DSTAGE0_MMAP=OFF \
  -DUSE_GMP=OFF \
  -DMMAP=OFF \
  -DUSE_MIMALLOC=OFF \
  -DCHECK_OLEAN_VERSION=OFF \
  -DLEAN_INSTALL_SUFFIX=-linux_wasm64 \
  -DSTAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten \
  -DEMSCRIPTEN_INITIAL_MEMORY=134217728 \
  -DEMSCRIPTEN_MAXIMUM_MEMORY=17179869184
