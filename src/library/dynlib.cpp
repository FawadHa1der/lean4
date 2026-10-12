/*
Copyright (c) 2021 Microsoft Corporation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.

Author: Leonardo de Moura, Mac Malone
*/
#include "util/io.h"
#include "runtime/io.h"
#include "runtime/object.h"
#include "runtime/sstream.h"
#include "runtime/exception.h"
#include "library/dynlib.h"

#ifdef LEAN_WINDOWS
#include <windows.h>
#elif !defined(LEAN_EMSCRIPTEN)
#include <dlfcn.h>
#endif

namespace lean {

static lean_external_class * g_dynlib_external_class = nullptr;
static lean_external_class * g_dynlib_symbol_external_class = nullptr;

static void dynlib_finalizer(void * h) {
    // There is no sensible way to handle errors here.
    // The same decision was made in Rust's libloading.
#ifdef LEAN_WINDOWS
    FreeLibrary(static_cast<HMODULE>(h));
#elif defined(LEAN_EMSCRIPTEN)
    (void)h; // never reached: no Dynlib is ever created there (lean_dynlib_load)
#else
    dlclose(h);
#endif
}

static void noop_foreach(void * /* val */, b_obj_arg /* fn */) {
}

static void noop_finalizer(void * h) {
}

void initialize_dynlib() {
    g_dynlib_external_class = lean_register_external_class(dynlib_finalizer, noop_foreach);
    g_dynlib_symbol_external_class = lean_register_external_class(noop_finalizer, noop_foreach);
}

#ifdef LEAN_WINDOWS
static inline obj_res wrap_dynlib(HMODULE h) {
    return alloc_external(g_dynlib_external_class, h);
}
static inline HMODULE dynlib_handle(b_obj_arg dynlib) {
    return static_cast<HMODULE>(lean_get_external_data(dynlib));
}
#elif !defined(LEAN_EMSCRIPTEN)
static inline obj_res wrap_dynlib(void * h) {
    return alloc_external(g_dynlib_external_class, h);
}
static inline void * dynlib_handle(b_obj_arg dynlib) {
    return lean_get_external_data(dynlib);
}
#endif

#ifndef LEAN_EMSCRIPTEN
static inline obj_res wrap_symbol(void * sym) {
    return alloc_external(g_dynlib_symbol_external_class, sym);
}
#endif
static inline void * symbol_ptr(b_obj_arg sym) {
    return lean_get_external_data(sym);
}

/* Dynlib.load : System.FilePath -> IO Dynlib */
extern "C" LEAN_EXPORT obj_res lean_dynlib_load(b_obj_arg path) {
#ifdef LEAN_WINDOWS
    HMODULE h = LoadLibrary(string_cstr(path));
    if (!h) {
        return io_result_mk_error((sstream()
            << "error loading library " << string_cstr(path) << ": " << GetLastError()).str());
    }
    return io_result_mk_ok(wrap_dynlib(h));
#elif defined(LEAN_EMSCRIPTEN)
    // The WebAssembly runtime is one statically linked module (patch 0039): there are no side
    // modules to load, and Emscripten's dlopen/dlsym stubs (or their absence) are no contract.
    // --load-dynlib, --plugin and `Lean.loadDynlib` fail here, with a Lean error.
    return io_result_mk_error((sstream()
        << "error loading library " << string_cstr(path) << ": dynamic libraries are not supported by the WebAssembly runtime").str());
#else
    // Both dynlibs and plugins are loaded with RTLD_GLOBAL.
    // This ensures the interpreter has access to plugin definitions that are also
    // imported (e.g., an environment extension defined with builtin_initialize).
    // In either case, loading the same symbol twice (and thus e.g. running initializers
    // manipulating global `IO.Ref`s twice) should be avoided; the common module
    // should instead be factored out into a separate shared library
    void *h = dlopen(string_cstr(path), RTLD_LAZY | RTLD_GLOBAL);
    if (!h) {
        return io_result_mk_error((sstream()
            << "error loading library, " << dlerror()).str());
    }
    return io_result_mk_ok(wrap_dynlib(h));
#endif
}

/* Dynlib.get? : (dynlib : Dynlib) -> String -> dynlib.Symbol */
extern "C" LEAN_EXPORT obj_res lean_dynlib_get(b_obj_arg dynlib, b_obj_arg name) {
#ifdef LEAN_WINDOWS
    auto sym = reinterpret_cast<void *>(GetProcAddress(dynlib_handle(dynlib), string_cstr(name)));
    if (sym) {
        return mk_option_some(wrap_symbol(sym));
    } else {
        return mk_option_none();
    }
#elif defined(LEAN_EMSCRIPTEN)
    // unreachable: lean_dynlib_load never returns a Dynlib here
    (void)dynlib; (void)name;
    return mk_option_none();
#else
    // The address of a valid Linux symbol can be NULL.
    // Thus, this is the recommended way to validate a symbol.
    dlerror();
    void * sym = dlsym(dynlib_handle(dynlib), string_cstr(name));
    if (dlerror()) {
        return mk_option_none();
    } else {
        return mk_option_some(wrap_symbol(sym));
    }
#endif
}

/* Dynlib.Symbol.runAsInit : {Dynlib} -> Symbol -> IO Unit */
extern "C" LEAN_EXPORT obj_res lean_dynlib_symbol_run_as_init(b_obj_arg /* dynlib */, b_obj_arg sym) {
    auto init_fn = reinterpret_cast<object *(*)(uint8_t)>(symbol_ptr(sym));
    return init_fn(1 /* builtin */);
}

/* Lean.loadDynlib : System.FilePath -> IO Unit */
extern "C" obj_res lean_load_dynlib(obj_arg path);

void load_dynlib(std::string path) {
    consume_io_result(lean_load_dynlib(mk_string(path)));
}

/* Lean.loadPlugin : System.FilePath -> Option String -> IO Unit */
extern "C" obj_res lean_load_plugin(obj_arg path, obj_arg init_fn);

void load_plugin(std::string path) {
    consume_io_result(lean_load_plugin(mk_string(path), box(0)));
}
}
