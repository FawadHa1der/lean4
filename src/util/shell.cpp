/*
Copyright (c) 2013 Microsoft Corporation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.

Author: Leonardo de Moura
*/
#include <iostream>
#include <fstream>
#include <signal.h>
#include <cctype>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>
#include <set>
#include "runtime/stackinfo.h"
#include "runtime/interrupt.h"
#include "runtime/memory.h"
#include "runtime/thread.h"
#include "runtime/debug.h"
#include "runtime/sstream.h"
#include "runtime/array_ref.h"
#include "runtime/object_ref.h"
#include "runtime/option_ref.h"
#include "runtime/utf8.h"
#include "util/timer.h"
#include "util/macros.h"
#include "util/io.h"
#include "util/options.h"
#include "util/option_declarations.h"
#include "library/elab_environment.h"
#include "kernel/kernel_exception.h"
#include "kernel/trace.h"
#include "library/dynlib.h"
#include "library/formatter.h"
#include "library/module.h"
#include "library/time_task.h"
#include "library/util.h"
#include "library/print.h"
#include "initialize/init.h"
#include "library/ir_interpreter.h"
#ifdef _MSC_VER
#include <io.h>
#define STDOUT_FILENO 1
#else
#include <getopt.h>
#include <unistd.h>
#endif
#if defined(LEAN_EMSCRIPTEN)
#include <emscripten.h>
#endif
#include "githash.h" // NOLINT

#ifdef LEAN_WINDOWS
#include <windows.h>
#endif

#ifdef _MSC_VER
// extremely simple implementation of getopt.h
enum arg_opt { no_argument, required_argument, optional_argument };

struct option {
    const char name[20];
    arg_opt has_arg;
    int *flag;
    char val;
};

static char *optarg;
static int optind = 1;

int getopt_long(int argc, char *in_argv[], const char *optstring, const option *opts, int *index) {
    optarg = nullptr;
    if (optind >= argc)
        return -1;

    char *argv = in_argv[optind];
    if (argv[0] != '-') {
        // find first -opt if any
        int i = optind;
        bool found = false;
        for (; i < argc; ++i) {
            if (in_argv[i][0] == '-') {
                found = true;
                break;
            }
        }
        if (!found)
            return -1;
        auto next = in_argv[i];
        // FIXME: this doesn't account for long options with arguments like --foo arg
        memmove(&in_argv[optind + 1], &in_argv[optind], (i - optind) * sizeof(argv));
        argv = in_argv[optind] = next;
    }
    ++optind;

    // long option
    if (argv[1] == '-') {
        auto eq = strchr(argv, '=');
        size_t sz = (eq ? (eq - argv) : strlen(argv)) - 2;
        for (auto I = opts; *I->name; ++I) {
            if (!strncmp(I->name, argv + 2, sz) && I->name[sz] == '\0') {
                assert(!I->flag);
                switch (I->has_arg) {
                case no_argument:
                    if (eq) {
                        std::cerr << in_argv[0] << ": option doesn't take an argument -- " << I->name << std::endl;
                        return '?';
                    }
                    break;
                case required_argument:
                    if (eq) {
                        optarg = eq + 1;
                    } else {
                        if (optind >= argc) {
                            std::cerr << in_argv[0] << ": option requires an argument -- " << I->name << std::endl;
                            return '?';
                        }
                        optarg = in_argv[optind++];
                    }
                    break;
                case optional_argument:
                    if (eq) {
                        optarg = eq + 1;
                    }
                    break;
                }
                if (index)
                  *index = I - opts;
                return I->val;
            }
        }
        return '?';
    } else {
        auto opt = strchr(optstring, argv[1]);
        if (!opt)
            return '?';

        if (opt[1] == ':') {
            if (argv[2] == '\0') {
                if (optind < argc) {
                    optarg = in_argv[optind++];
                } else {
                    std::cerr << in_argv[0] << ": option requires an argument -- " << *opt << std::endl;
                    return '?';
                }
            } else {
                optarg = argv + 2;
            }
        }
        return *opt;
    }
}
#endif

using namespace lean; // NOLINT

static struct option g_long_options[] = {
    {"version",      no_argument,       0, 'v'},
    {"help",         no_argument,       0, 'h'},
    {"githash",      no_argument,       0, 'g'},
    {"short-version", no_argument,      0, 'V'},
    {"run",          no_argument,       0, 'r'},
    {"o",            optional_argument, 0, 'o'},
    {"i",            optional_argument, 0, 'i'},
    {"stdin",        no_argument,       0, 'I'},
    {"root",         required_argument, 0, 'R'},
    {"memory",       required_argument, 0, 'M'},
    {"trust",        required_argument, 0, 't'},
    {"profile",      no_argument,       0, 'P'},
    {"stats",        no_argument,       0, 'a'},
    {"quiet",        no_argument,       0, 'q'},
    {"deps",         no_argument,       0, 'd'},
    {"src-deps",     no_argument,       0, 'O'},
    {"deps-json",    no_argument,       0, 'N'},
    {"timeout",      optional_argument, 0, 'T'},
    {"c",            optional_argument, 0, 'c'},
    {"bc",           optional_argument, 0, 'b'},
    {"features",     no_argument,       0, 'f'},
    {"exitOnPanic",  no_argument,       0, 'e'},
#if defined(LEAN_MULTI_THREAD)
    {"threads",      required_argument, 0, 'j'},
    {"tstack",       required_argument, 0, 's'},
    {"server",       no_argument,       0, 'S'},
    {"worker",       no_argument,       0, 'W'},
#endif
    {"plugin",       required_argument, 0, 'p'},
    {"load-dynlib",  required_argument, 0, 'l'},
    {"setup",        required_argument, 0, 'u'},
    {"error",        required_argument, 0, 'E'},
    {"json",         no_argument,       0, 'J'},
    {"print-prefix", no_argument,       0, 'x'},
    {"print-libdir", no_argument,       0, 'L'},
    {"incr-save",    required_argument, 0, 'Y'},
    {"incr-load",    required_argument, 0, 'Z'},
    {"incr-header-save", required_argument, 0, 'H'},
#ifdef LEAN_DEBUG
    {"debug",        required_argument, 0, 'B'},
#endif
    {0, 0, 0, 0}
};

static char const * g_opt_str =
    "PdD:o:i:b:c:C:qgvVht:012j:012rR:M:012T:012ap:eE:Y:Z:H:"
#if defined(LEAN_MULTI_THREAD)
    "s:012"
#endif
; // NOLINT

namespace lean {
extern "C" obj_res lean_shell_main(obj_arg args, obj_arg shell_opts);
int run_shell_main(int argc, char* argv[], object_ref const & shell_opts) {
    list_ref<string_ref> args;
    while (argc > 0) {
        argc--;
        args = list_ref<string_ref>(string_ref(argv[argc]), args);
    }
    object * args_obj = args.steal();
    object * opts_obj = shell_opts.to_obj_arg();
    object * result = lean_shell_main(args_obj, opts_obj);
    return get_io_scalar_result<uint32>(result);
}

extern "C" object* lean_init_search_path();
void init_search_path() {
    consume_io_result(lean_init_search_path());
}

extern "C" obj_res lean_shell_options_mk(obj_arg);
object_ref mk_shell_options() {
    return object_ref(lean_shell_options_mk(box(0)));
}

extern "C" obj_res lean_shell_options_process(obj_arg shell_opts, uint32 opt, obj_arg opt_arg);
bool process_shell_option(object_ref & shell_opts, int opt, char const * optarg, int & rc) {
    auto optarg_ref = optarg ? mk_option_some(mk_string(optarg)) : mk_option_none();
    auto r = lean_shell_options_process(shell_opts.steal(), opt, optarg_ref);
    if (io_result_is_ok(r)) {
        shell_opts = object_ref(io_result_get_value(r), true);
        dec_ref(r);
        return false;
    } else {
        rc = unbox(io_result_get_error(r));
        dec_ref(r);
        return true;
    }
}

extern "C" uint8 lean_shell_options_get_run(obj_arg shell_opts);
bool get_shell_run(object_ref const & shell_opts) {
    return lean_shell_options_get_run(shell_opts.to_obj_arg());
}

extern "C" uint8 lean_shell_options_get_profiler(obj_arg shell_opts);
bool get_shell_profiler(object_ref const & shell_opts) {
    return lean_shell_options_get_profiler(shell_opts.to_obj_arg());
}

extern "C" uint32 lean_shell_options_get_num_threads(obj_arg shell_opts);
unsigned get_shell_num_threads(object_ref const & shell_opts) {
    return lean_shell_options_get_num_threads(shell_opts.to_obj_arg());
}
}

extern "C" object * lean_enable_initializer_execution();

namespace lean {
extern void (*g_lean_report_task_get_blocked_time)(std::chrono::nanoseconds);
}
static bool trace_task_get_blocked = getenv("LEAN_TRACE_TASK_GET_BLOCKED") != nullptr;
static void report_task_get_blocked_time(std::chrono::nanoseconds d) {
    if (has_no_block_profiling_task()) {
        report_profiling_time("blocked (unaccounted)", d);
        exclude_profiling_time_from_current_task(d);
        if (trace_task_get_blocked) {
            sstream ss;
            ss << "Task.get blocked for " << std::chrono::duration_cast<std::chrono::duration<float, std::milli>>(d).count() << "ms";
            // using a panic for reporting is a bit of a hack, but good enough for this
            // `lean`-specific use case
            lean_panic(ss.str().c_str(), /* force stderr */ true);
        }
    }
}

#if defined(LEAN_EMSCRIPTEN)
static bool g_wasm_shell_initialized = false;
static bool g_wasm_shell_task_manager = false;
// The embedder pre-initialized the runtime (and task manager) through the
// C API before calling main — lean_main must not initialize again.
extern "C" LEAN_EXPORT void lean_wasm_shell_mark_preinitialized() {
    g_wasm_shell_initialized = true;
    g_wasm_shell_task_manager = true;
}
#endif

extern "C" LEAN_EXPORT int lean_main(int argc, char ** argv) {
#ifdef LEAN_EMSCRIPTEN
    // Set up the virtual filesystem based on the runtime environment.
    // Node.js: Use NODEFS to access the real filesystem.
    // Browser: Use MEMFS (default) with pre-created directories.
    MAIN_THREAD_EM_ASM(
        var isNode = (typeof process !== "undefined") && 
                     (process.release && process.release.name === "node");
        
        if (isNode) {
            // Node.js environment: mount real filesystem
            var lean_path = process.env["LEAN_PATH"];
            if (lean_path) {
                ENV["LEAN_PATH"] = lean_path;
            }
            // We cannot mount /, see https://github.com/emscripten-core/emscripten/issues/2040
            FS.mount(NODEFS, { root: "/home" }, "/home");
            FS.mount(NODEFS, { root: "/tmp" }, "/tmp");
            // On macOS, /tmp is a symlink to /private/tmp, but process.cwd()
            // returns the resolved path. Normalize it for the WASM VFS.
            var cwd = process.cwd();
            if (cwd.startsWith("/private/tmp/")) {
                cwd = cwd.replace("/private/tmp/", "/tmp/");
            } else if (cwd === "/private/tmp") {
                cwd = "/tmp";
            }
            FS.chdir(cwd);
        } else {
            // Browser environment: use MEMFS (Emscripten's default in-memory filesystem)
            // Create necessary directories if they don't exist
            // Note: /home, /tmp, /dev, /proc are often pre-created by Emscripten
            function mkdirSafe(path) {
                try { FS.mkdir(path); }
                catch (e) {
                    if (e.errno !== 20) { // 20 = EEXIST, ignore if already exists
                        console.log("Error creating " + path + ": " + (e.message || e));
                    }
                }
            }
            
            mkdirSafe("/home");
            mkdirSafe("/tmp");
            mkdirSafe("/workspace");
            mkdirSafe("/bin");  // For fake app path "/bin/lean.wasm"
            mkdirSafe("/lib");
            mkdirSafe("/lib/lean");
            mkdirSafe("/lib/lean/library");
            
            FS.chdir("/workspace");
            
            // Set default LEAN_PATH for browser if not already configured
            // The standard library .olean files should be preloaded at this path
            if (!ENV["LEAN_PATH"]) {
                ENV["LEAN_PATH"] = "/lib/lean/library";
            }
            
        }
    );
#elif defined(LEAN_WINDOWS)
    // "best practice" according to https://docs.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-seterrormode
    SetErrorMode(SEM_FAILCRITICALERRORS);
    // properly formats Unicode characters on the Windows console
    // see https://github.com/leanprover/lean4/issues/4291
    SetConsoleOutputCP(CP_UTF8);
#endif
    auto init_start = std::chrono::steady_clock::now();
#if defined(LEAN_EMSCRIPTEN)
    // Resident-embedding contract (patch 0031): the embedder may pre-
    // initialize Lean (snapshot seeding runs before main) and re-enter main
    // for in-process session replacement, so initialization is once per
    // process and finalization never happens. First CLI entry initializes as
    // before; an embedder that pre-initialized marks readiness via
    // lean_wasm_shell_mark_preinitialized().
    if (!g_wasm_shell_initialized) {
        g_wasm_shell_initialized = true;
        new lean::initializer(); // deliberately leaked: resident runtime
    }
#else
    lean::initializer init;
#endif
    second_duration init_time = std::chrono::steady_clock::now() - init_start;

    try {
        // Remark: This currently runs under `IO.initializing = true`.
        init_search_path();
    } catch (lean::throwable & ex) {
        std::cerr << "error: " << ex.what() << std::endl;
        return 1;
    }
    lean_enable_initializer_execution();

    // Default the configured thread stack size from the environment as in `lean_run_main`;
    // `--tstack` below overrides it.
    set_thread_stack_size_from_env();

    int rc;
    object_ref shell_opts;
    try {
        shell_opts = mk_shell_options();
        for (;;) {
            int c = getopt_long(argc, argv, g_opt_str, g_long_options, NULL);
            if (c == -1)
                break; // end of command line
            if (process_shell_option(shell_opts, c, optarg, rc))
                return rc; // option processing triggered an early exit
            if (get_shell_run(shell_opts))
                break; // stop consuming arguments after `--run`
        }
    } catch (lean::throwable & ex) {
        std::cerr << "error: " << ex.what() << std::endl;
        return 1;
    }

    lean::io_mark_end_initialization();

    if (get_shell_profiler(shell_opts)) {
        g_lean_report_task_get_blocked_time = report_task_get_blocked_time;
        report_profiling_time("initialization", init_time);
    }

#if defined(LEAN_EMSCRIPTEN)
    // Once per process, never torn down (see the initializer note above); a
    // pre-initialized embedder brought its own task manager.
    if (!g_wasm_shell_task_manager) {
        g_wasm_shell_task_manager = true;
        new scoped_task_manager(get_shell_num_threads(shell_opts)); // leaked
    }
#else
    scoped_task_manager scope_task_man(get_shell_num_threads(shell_opts));
#endif

    int shell_rc = 1;
    auto run = [&]() {
        try {
            shell_rc = run_shell_main(argc - optind, argv + optind, shell_opts);
        } catch (lean::throwable & ex) {
            std::cerr << ex.what() << "\n";
        } catch (std::bad_alloc & ex) {
            std::cerr << "out of memory" << std::endl;
        } catch (std::exception & ex) {
            std::cerr << "exception: " << ex.what() << std::endl;
        } catch (...) {
            std::cerr << "unknown exception" << std::endl;
        }
    };
#if defined(LEAN_EMSCRIPTEN)
    // The application thread already is a pthread with an explicit stack
    // (PROXY_TO_PTHREAD + STACK_SIZE). Hopping to a second `lthread` would
    // halve that stack (LEAN_DEFAULT_THREAD_STACK_SIZE is 8MB here), pin one
    // more pool worker for the life of the resident FileWorker, and leave the
    // application thread parked in a join it can never be woken from.
    run();
#else
    // Do not rely on OS thread stack size, as for Lean executables
    run_with_thread_stack(run);
#endif
    return shell_rc;
}
