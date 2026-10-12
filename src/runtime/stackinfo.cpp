/*
Copyright (c) 2013 Microsoft Corporation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.

Author: Leonardo de Moura
*/
#include <memory.h>
#include <cstdlib>
#include <iostream>
#include "runtime/thread.h"
#include "runtime/exception.h"
#include "runtime/stackinfo.h"

#if !defined(LEAN_USE_SPLIT_STACK)
#if defined(LEAN_WINDOWS)
    // no extra included needed so far
#elif defined(__APPLE__)
    #include <sys/resource.h> // NOLINT
#else
    #include <sys/time.h> // NOLINT
    #include <sys/resource.h> // NOLINT
#endif

#if defined(LEAN_EMSCRIPTEN)
#include <atomic>
#include <emscripten/stack.h>
#include <emscripten/em_js.h>
#endif

namespace lean {
void throw_get_stack_size_failed() {
    throw exception("failed to retrieve thread stack size");
}

#if defined(LEAN_WINDOWS)
size_t get_stack_size(bool main) {
    if (main) {
        return LEAN_WIN_STACK_SIZE;
    } else {
        return lthread::get_thread_stack_size();
    }
}
#elif defined (__APPLE__)
size_t get_stack_size(bool main) {
    if (main) {
        // Retrieve stack size of the main thread.
        struct rlimit curr;
        if (getrlimit(RLIMIT_STACK, &curr) != 0) {
            throw_get_stack_size_failed();
        }
        return curr.rlim_cur;
    } else {
        return lthread::get_thread_stack_size();
    }
}
#elif defined(LEAN_EMSCRIPTEN)
size_t get_stack_size(bool main) {
    if (main) {
        // the stack grows down: base is its highest address, end its lowest
        return emscripten_stack_get_base() - emscripten_stack_get_end();
    } else {
        return lthread::get_thread_stack_size();
    }
}
#else
size_t get_stack_size(bool main) {
    if (main) {
        // Retrieve stack size of the main thread.
        struct rlimit curr;
        if (getrlimit(RLIMIT_STACK, &curr) != 0) {
            throw_get_stack_size_failed();
        }
        return curr.rlim_cur;
    } else {
        return lthread::get_thread_stack_size();
    }
}
#endif

#ifndef __has_builtin
#define __has_builtin(x) 0 /* for non-clang compilers */
#endif

// taken from https://github.com/llvm/llvm-project/blob/llvmorg-10.0.0-rc1/clang/lib/Basic/Stack.cpp#L24
static void *get_stack_pointer() {
#if __GNUC__ || __has_builtin(__builtin_frame_address)
    return __builtin_frame_address(0);
#elif defined(_MSC_VER)
    return _AddressOfReturnAddress();
#else
    char x = 0;
    char *volatile ptr = &x;
    return ptr;
#endif
}

LEAN_THREAD_VALUE(bool, g_stack_info_init, false);
LEAN_THREAD_VALUE(size_t, g_stack_size, 0);
LEAN_THREAD_VALUE(size_t, g_stack_base, 0);
LEAN_THREAD_VALUE(size_t, g_stack_threshold, 0);

void save_stack_info(bool main) {
    g_stack_info_init = true;
    g_stack_size = get_stack_size(main);
    g_stack_base = reinterpret_cast<size_t>(get_stack_pointer());
    /* g_stack_threshold is a redundant value used to optimize check_stack */
    g_stack_threshold = g_stack_base + LEAN_STACK_BUFFER_SPACE - g_stack_size;
    if (g_stack_threshold > g_stack_base + LEAN_STACK_BUFFER_SPACE) {
        // negative overflow
        g_stack_threshold = 0;
    }
}

size_t get_used_stack_size() {
    size_t curr_stack = reinterpret_cast<size_t>(get_stack_pointer());
    return g_stack_base - curr_stack;
}

size_t get_available_stack_size() {
    size_t sz = get_used_stack_size();
    if (sz > g_stack_size)
        return 0;
    else
        return g_stack_size - sz;
}

// separate definition to allow breakpoint in debugger
void throw_stack_space_exception(char const * component_name) {
    throw stack_space_exception(component_name);
}

void check_stack(char const * component_name) {
    if (!g_stack_info_init)
        save_stack_info(false);
    size_t curr_stack = reinterpret_cast<size_t>(get_stack_pointer());
    if (curr_stack < g_stack_threshold)
        throw_stack_space_exception(component_name);
}
}
#endif  // !LEAN_USE_SPLIT_STACK

#if defined(LEAN_EMSCRIPTEN)
/* On WebAssembly, recursion is bounded by the ENGINE's stack, not by the stack `check_stack`
   measures. Wasm frames live on the stack of the thread running them — for a pthread in a browser,
   a Web Worker, which Chrome gives 500 KiB — while `get_stack_pointer` above sees Emscripten's
   shadow stack in linear memory, which deep recursion barely moves. Running out of the engine's
   stack throws a JS RangeError that kills the thread (qed64 HARDENING #60). No API reports how much
   of it is left, but a call with N arguments needs N stack slots up front in every engine tier, so
   `Reflect.apply` with a fixed argument array throws exactly when less than that is free. The sink
   takes one formal parameter: reading `arguments` would copy all N into a heap object per probe. */
EM_JS(int, lean_wasm_engine_stack_has, (int slots), {
    var a = globalThis.__leanStackProbeArgs;
    if (!a || a.length !== slots) a = globalThis.__leanStackProbeArgs = new Array(slots).fill(0);
    var sink = globalThis.__leanStackProbeSink;
    if (!sink) sink = globalThis.__leanStackProbeSink = function (x) { globalThis.__leanStackProbeN = x; };
    try { Reflect.apply(sink, null, a); return 1; }
    catch (e) { if (e instanceof RangeError || (e && e.name === "InternalError")) return 0; throw e; }
});

namespace lean {
/* 16384 slots (128 KiB) of headroom cover the 16 levels a caller may pass unprobed (a Meta level
   measured ~2.5 KiB of engine stack) plus the unwinding that follows. `LEAN_WASM_STACK_PROBE_SLOTS`
   overrides it (0 disables the probe), for calibration. */
static int engine_probe_slots() {
    static int slots = [] {
        char const * env = getenv("LEAN_WASM_STACK_PROBE_SLOTS");
        return env ? atoi(env) : 16384;
    }();
    return slots;
}

bool engine_stack_has_headroom() {
    int slots = engine_probe_slots();
    return slots <= 0 || lean_wasm_engine_stack_has(slots) != 0;
}

/* 0038: how often the guard asked and refused, process-wide (lean_wasm_engine_probes,
   lean_wasm_engine_guard_trips below). The two guard sites count around their call of
   `engine_stack_has_headroom`, which, like the probe, is left exactly as above: a probe is a
   question asked (with LEAN_WASM_STACK_PROBE_SLOTS=0 it is still counted, and never refused);
   a trip is a refusal, after which the site throws. No decision reads them: every one stays
   0036's. One relaxed atomic add per question (a question costs ~4 µs), one more per trip. */
static std::atomic<uint64_t> g_engine_probes{0};
static std::atomic<uint64_t> g_engine_guard_trips[2] = {}; // 0 kernel scope_rec_depth, 1 Core.checkSystem
void note_engine_probe() {
    g_engine_probes.fetch_add(1, std::memory_order_relaxed);
}
void note_engine_guard_trip(unsigned site) {
    if (site < 2) g_engine_guard_trips[site].fetch_add(1, std::memory_order_relaxed);
}

/* Lean code has no depth to go by, so `Core.checkSystem` probes on every 16th call of a thread. */
static constexpr unsigned g_native_probe_every = 16;
LEAN_THREAD_VALUE(unsigned, g_native_probe_tick, 0);
static bool native_stack_ok() {
    if (++g_native_probe_tick % g_native_probe_every != 0) return true;
    note_engine_probe();
    if (engine_stack_has_headroom()) return true;
    note_engine_guard_trip(1);
    return false;
}
}
#else
namespace lean {
bool engine_stack_has_headroom() { return true; }
static bool native_stack_ok() { return true; }
}
#endif

/* `Lean.Core.nativeStackOk` (Core.checkSystem): false when the stack the code really runs on is
   nearly exhausted, so the elaborator reports an error while it can still unwind. */
extern "C" LEAN_EXPORT uint8_t lean_wasm_native_stack_ok() {
    return lean::native_stack_ok();
}

#if defined(LEAN_EMSCRIPTEN)
/* 0038, for hosts and the gate: the guard's questions, and its refusals by site (0 the kernel's
   `scope_rec_depth`, 1 `Core.checkSystem`; any other site reads 0), since the process started.
   Lock-free, so the host's main JS thread may call them at any time. Doubles, exact to 2^53. */
extern "C" LEAN_EXPORT double lean_wasm_engine_probes() {
    return static_cast<double>(lean::g_engine_probes.load(std::memory_order_relaxed));
}
extern "C" LEAN_EXPORT double lean_wasm_engine_guard_trips(unsigned site) {
    return site < 2 ? static_cast<double>(lean::g_engine_guard_trips[site].load(std::memory_order_relaxed)) : 0;
}
#endif
