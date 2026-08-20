#!/bin/sh
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
  -DCHECK_OLEAN_VERSION=ON \
  -DLEAN_INSTALL_SUFFIX=-linux_wasm64 \
  -DSTAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten \
  -DEMSCRIPTEN_INITIAL_MEMORY=134217728 \
  -DEMSCRIPTEN_MAXIMUM_MEMORY=12884901888
