/*
Copyright (c) 2013 Microsoft Corporation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.

Author: Leonardo de Moura
*/
#include <limits>
#include "runtime/thread.h"
#include "runtime/interrupt.h"
#include "runtime/exception.h"
#include "runtime/stackinfo.h"
#include "runtime/memory.h"
#include "runtime/object.h"
#include "lean/lean.h"
#include "util/io.h"

namespace lean {
LEAN_THREAD_VALUE(size_t, g_max_heartbeat, 0);
LEAN_THREAD_VALUE(size_t, g_heartbeat, 0);

extern "C" LEAN_EXPORT obj_res lean_internal_get_default_max_heartbeat(lean_obj_arg /* unit */) {
#ifdef LEAN_DEFAULT_MAX_HEARTBEAT
    return lean_box(LEAN_DEFAULT_MAX_HEARTBEAT);
#else
    return lean_box(0);
#endif
}

void inc_heartbeat() { g_heartbeat++; }

void reset_heartbeat() { g_heartbeat = 0; }

void set_max_heartbeat(size_t max) { g_max_heartbeat = max; }

extern "C" LEAN_EXPORT obj_res lean_internal_set_max_heartbeat(usize max) {
    set_max_heartbeat(max);
    return lean_box(0);
}

size_t get_max_heartbeat() { return g_max_heartbeat; }

void set_max_heartbeat_thousands(unsigned max) { g_max_heartbeat = static_cast<size_t>(max) * 1000; }

scope_heartbeat::scope_heartbeat(size_t max):flet<size_t>(g_heartbeat, max) {}
LEAN_EXPORT scope_max_heartbeat::scope_max_heartbeat(size_t max):flet<size_t>(g_max_heartbeat, max) {}

// separate definition to allow breakpoint in debugger
void throw_heartbeat_exception() {
    throw heartbeat_exception();
}

void check_heartbeat() {
    inc_heartbeat();
    if (g_max_heartbeat > 0 && g_heartbeat > g_max_heartbeat)
        throw_heartbeat_exception();
}

LEAN_THREAD_VALUE(size_t, g_max_rec_depth, 0);
LEAN_THREAD_VALUE(size_t, g_rec_depth, 0);

/* The kernel re-checks a fully elaborated term from scratch, without the caching, metavariable
   assignments, and reducibility shortcuts the elaborator uses while building it incrementally. As a
   result the kernel recurses substantially deeper than the elaborator did for the same term (stdlib
   `grind`/`simp` proofs check several thousand levels deep). We therefore let the kernel reach a
   generous multiple of the configured `maxRecDepth` before bailing out, so that code which fits
   within `maxRecDepth` during elaboration is not rejected by the kernel. */
static constexpr size_t g_kernel_rec_depth_factor = 16;

void set_max_rec_depth(size_t max) { g_max_rec_depth = max; }
size_t get_max_rec_depth() { return g_max_rec_depth; }

LEAN_EXPORT scope_max_rec_depth::scope_max_rec_depth(size_t max) :
    m_max(g_max_rec_depth, max), m_curr(g_rec_depth, 0) {}

#if defined(LEAN_EMSCRIPTEN)
/* On WebAssembly the engine's stack (500 KiB in a Chrome Worker) runs out long before the depth
   above (0036). The guard probes it (`engine_stack_has_headroom`, ~4 µs) on a thread's outermost
   level and then every `g_engine_probe_levels` levels deeper: `g_engine_probe_depth` is the next
   depth to probe at. Unwinding lowers it with the depth, since a frame above a probed one has at
   least as much room, so recursion that stays within 16 levels — nearly all of it — costs nothing. */
static constexpr size_t g_engine_probe_levels = 16;
LEAN_THREAD_VALUE(size_t, g_engine_probe_depth, 0);
#endif

LEAN_EXPORT scope_rec_depth::scope_rec_depth() {
    g_rec_depth++;
    if (g_max_rec_depth > 0 && g_rec_depth > g_max_rec_depth * g_kernel_rec_depth_factor) {
        g_rec_depth--;
        throw stack_space_exception("type checker");
    }
#if defined(LEAN_EMSCRIPTEN)
    // A normal C++ exception here unwinds through every landing pad, where running out kills the
    // thread. Plain `exception`: the kernel reports it as `other` ("(kernel) " + this text), not
    // as `deepRecursion`, whose advice (raise maxRecDepth) would not help.
    if (g_rec_depth == 1 || g_rec_depth >= g_engine_probe_depth) {
        if (!engine_stack_has_headroom()) {
            g_rec_depth--;
            throw exception("the WebAssembly engine's stack is exhausted: this proof recurses deeper "
                            "than a browser allows (the same proof may check natively)");
        }
        g_engine_probe_depth = g_rec_depth + g_engine_probe_levels;
    }
#endif
}

LEAN_EXPORT scope_rec_depth::~scope_rec_depth() {
    g_rec_depth--;
#if defined(LEAN_EMSCRIPTEN)
    if (g_rec_depth + g_engine_probe_levels < g_engine_probe_depth)
        g_engine_probe_depth = g_rec_depth + g_engine_probe_levels;
#endif
}

LEAN_THREAD_VALUE(lean_object *, g_cancel_tk, nullptr);

LEAN_EXPORT scope_cancel_tk::scope_cancel_tk(lean_object * o):flet<lean_object *>(g_cancel_tk, o) {}

// `IO.CancelToken` is `structure { promise : IO.Promise Unit; setRef : IO.Ref Bool }`. We read
// the `Bool` flag (field 1) directly: cheaper than walking the promise's task state, and this
// is on the hot `Core.checkInterrupted` path. Must stay in sync with the field order in
// `Init/System/CancelToken.lean`.
static bool cancel_tk_is_set(lean_object * tk) {
    lean_object * setRef = lean_ctor_get(tk, 1);
    return lean_unbox(lean_to_ref(setRef)->m_value) != 0;
}

void check_interrupted() {
    if (g_cancel_tk) {
        // `g_cancel_tk` is owned by the enclosing `scope_cancel_tk`, so it stays alive for the
        // duration of this call without an explicit `inc_ref`.
        if (cancel_tk_is_set(g_cancel_tk) &&
            !std::uncaught_exceptions()) {
            throw interrupted();
        }
    }
}

void check_system(char const * component_name, bool do_check_interrupted) {
    check_stack(component_name);
    check_memory(component_name);
    if (do_check_interrupted) {
        check_interrupted();
        check_heartbeat();
    }
}

void sleep_for(unsigned ms, unsigned step_ms) {
    if (step_ms == 0)
        step_ms = 1;
    unsigned rounds = ms / step_ms;
    chrono::milliseconds c(step_ms);
    chrono::milliseconds r(ms % step_ms);
    for (unsigned i = 0; i < rounds; i++) {
        this_thread::sleep_for(c);
        check_interrupted();
    }
    this_thread::sleep_for(r);
    check_interrupted();
}
}
