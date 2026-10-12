/*
Released under Apache 2.0 license as described in the file LICENSE.

The WebAssembly runtime's native-symbol table (patch 0039, wasm64-build/PATCHES.md).
*/
#pragma once
#ifdef LEAN_EMSCRIPTEN
#include <cstdint>

namespace lean {
/* The native code a name stands for (a boxed wrapper, an all-object function without one, an
   @[export] function, a module initializer: its function pointer; a constant cell: its address),
   or nullptr. Searches the table linked into the module (wasm_symtab.cpp); lock-free, from any
   thread, before lean_initialize too. */
void * wasm_symtab_lookup(char const * name);
/* The table's entry count (a `lean` linked without its table does not link). */
uint64_t wasm_symtab_size();
}
#endif
