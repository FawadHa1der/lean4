/*
Released under Apache 2.0 license as described in the file LICENSE.

The WebAssembly runtime's native-symbol table (patch 0039, wasm64-build/PATCHES.md).

The IR interpreter finds native code by name (`lookup_symbol_in_cur_exe`: boxed wrappers,
@[export] functions, constant cells, module initializers). Natively that is dlsym over the
dynamic symbol table (`lean` links with -rdynamic). Under Emscripten dlsym searched the wasm
EXPORTS, so all ~106k such names were exported, and every pthread Worker's glue bound and
re-registered each of them (~129 MiB of JS heap per Worker; QED64 HARDENING #55). Instead,
wasm64-build/gen-exports.py writes lean_wasm_symtab.c from the build's own C: every name the
interpreter may ask for, sorted bytewise and front-coded (a whole name heads every block of
`lean_wasm_symtab_block` names, each other one is [shared-prefix byte][suffix] NUL), with its kind
and its address — a function's table index or a cell's address, both fixed at link time. It is
linked into `lean` only (src/stdlib.make.in). This file searches it: a binary search over the
block heads, then at most one block's decodes. The data is immutable and needs no initialization,
so a lookup takes no lock, calls no JavaScript and is safe from any thread at any time. The
interpreter caches every answer per declaration (`g_native_symbol_cache`), so each name is looked
up once per process; the counters and the trace below sit on that cold path.
*/
#ifdef LEAN_EMSCRIPTEN
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "runtime/object.h"
#include "library/wasm_symtab.h"

extern "C" { // generated: lean_wasm_symtab.c (wasm64-build/gen-exports.py --symtab)
extern const uint64_t lean_wasm_symtab_count;
extern const uint32_t lean_wasm_symtab_block;
extern const uint32_t lean_wasm_symtab_maxlen;
extern const uint64_t lean_wasm_symtab_fnv;
extern const unsigned char lean_wasm_symtab_names[];
extern const uint32_t lean_wasm_symtab_block_off[];
extern const uint8_t lean_wasm_symtab_kind[];
extern void * const lean_wasm_symtab_addr[];
}

namespace lean {
/* The kinds, numbered as gen-exports.py numbers them (KIND there). */
static constexpr unsigned g_symtab_kinds = 7;
static char const * const g_symtab_kind_name[g_symtab_kinds] = {"boxed", "plain", "export", "cell", "init", "init_rt", "init_meta"};
/* The longest name the decoder takes; the generator refuses longer ones (MAXLEN there). */
static constexpr size_t g_symtab_maxlen_cap = 4096;

/* Lookups that found an entry, by its kind, and lookups that found none (lean_wasm_symtab_stats).
   Relaxed: they order nothing. */
static std::atomic<uint64_t> g_symtab_hits[g_symtab_kinds] = {};
static std::atomic<uint64_t> g_symtab_misses{0};

static char const * symtab_block_head(size_t b) {
    return reinterpret_cast<char const *>(lean_wasm_symtab_names) + lean_wasm_symtab_block_off[b];
}

/* The index of `name` in the table, or -1. Names compare bytewise (strcmp compares unsigned
   chars), the order the generator sorts in. */
static int64_t symtab_find(char const * name) {
    size_t n = static_cast<size_t>(lean_wasm_symtab_count), block = lean_wasm_symtab_block;
    if (n == 0 || block == 0 || strlen(name) > g_symtab_maxlen_cap) return -1;
    if (strcmp(name, symtab_block_head(0)) < 0) return -1;
    size_t lo = 0, hi = (n + block - 1) / block; // head(lo) <= name < head(hi)
    while (hi - lo > 1) {
        size_t mid = lo + (hi - lo) / 2;
        if (strcmp(symtab_block_head(mid), name) <= 0) lo = mid; else hi = mid;
    }
    char buf[g_symtab_maxlen_cap + 1];
    unsigned char const * p = lean_wasm_symtab_names + lean_wasm_symtab_block_off[lo];
    size_t len = strlen(reinterpret_cast<char const *>(p));
    if (len > g_symtab_maxlen_cap) return -1; // a damaged table: the self-check says which way
    memcpy(buf, p, len + 1);
    p += len + 1;
    size_t first = lo * block;
    if (strcmp(buf, name) == 0) return static_cast<int64_t>(first);
    for (size_t j = 1; j < block && first + j < n; j++) {
        size_t shared = *p++;
        size_t suffix = strlen(reinterpret_cast<char const *>(p));
        if (shared > len || shared + suffix > g_symtab_maxlen_cap) return -1;
        memcpy(buf + shared, p, suffix + 1);
        p += suffix + 1;
        len = shared + suffix;
        int c = strcmp(buf, name);
        if (c == 0) return static_cast<int64_t>(first + j);
        if (c > 0) break;
    }
    return -1;
}

/* LEAN_WASM_SYMTAB_TRACE: which lookups to print on stderr, for the gate and for diagnosis.
   Clauses joined by `;`, each `miss`, `hit` or `all` (both), optionally followed by `:` and a
   comma-separated list of name prefixes (none: every name), e.g. `miss:;hit:l_Lean_versionString`.
   Each kind of lookup may be named once. Unset or empty: off. Anything else is not guessed at:
   tracing stays off, with one warning. Read once, at the first lookup (after preRun, where a host
   sets Module.ENV), like 0036's LEAN_WASM_STACK_PROBE_SLOTS. Lines: `[symtab] miss - <name>` and
   `[symtab] hit <kind> <name>`. */
struct symtab_trace {
    bool miss = false, hit = false;
    std::vector<std::string> miss_prefixes, hit_prefixes; // empty: every name
};

static bool symtab_trace_parse(std::string const & spec, symtab_trace & out) {
    if (spec.size() > 4096) return false;
    size_t at = 0;
    while (true) {
        size_t end = spec.find(';', at);
        std::string clause = spec.substr(at, end == std::string::npos ? std::string::npos : end - at);
        size_t colon = clause.find(':');
        std::string mode = clause.substr(0, colon);
        bool miss = mode == "miss" || mode == "all", hit = mode == "hit" || mode == "all";
        if (!miss && !hit) return false;
        if ((miss && out.miss) || (hit && out.hit)) return false;
        std::vector<std::string> prefixes;
        if (colon != std::string::npos && colon + 1 < clause.size()) {
            std::string list = clause.substr(colon + 1);
            size_t from = 0;
            while (true) {
                size_t comma = list.find(',', from);
                std::string prefix = list.substr(from, comma == std::string::npos ? std::string::npos : comma - from);
                if (prefix.empty()) return false;
                for (char ch : prefix)
                    if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_')) return false;
                prefixes.push_back(prefix);
                if (comma == std::string::npos) break;
                from = comma + 1;
            }
        }
        if (miss) { out.miss = true; out.miss_prefixes = prefixes; }
        if (hit) { out.hit = true; out.hit_prefixes = prefixes; }
        if (end == std::string::npos) return true;
        at = end + 1;
    }
}

static symtab_trace const & symtab_trace_config() {
    static symtab_trace const config = [] {
        symtab_trace t;
        char const * env = getenv("LEAN_WASM_SYMTAB_TRACE");
        if (!env || !*env) return t;
        if (!symtab_trace_parse(env, t)) {
            fprintf(stderr, "[symtab] LEAN_WASM_SYMTAB_TRACE=%s is not understood, so nothing is traced "
                    "(miss|hit|all[:prefix,...], clauses joined by ';')\n", env);
            return symtab_trace();
        }
        return t;
    }();
    return config;
}

static bool symtab_traced(std::vector<std::string> const & prefixes, char const * name) {
    if (prefixes.empty()) return true;
    for (std::string const & p : prefixes)
        if (strncmp(name, p.data(), p.size()) == 0) return true;
    return false;
}

void * wasm_symtab_lookup(char const * name) {
    int64_t i = symtab_find(name);
    symtab_trace const & trace = symtab_trace_config();
    if (i < 0) {
        g_symtab_misses.fetch_add(1, std::memory_order_relaxed);
        if (trace.miss && symtab_traced(trace.miss_prefixes, name))
            fprintf(stderr, "[symtab] miss - %s\n", name);
        return nullptr;
    }
    unsigned kind = lean_wasm_symtab_kind[i];
    if (kind < g_symtab_kinds) g_symtab_hits[kind].fetch_add(1, std::memory_order_relaxed);
    if (trace.hit && symtab_traced(trace.hit_prefixes, name))
        fprintf(stderr, "[symtab] hit %s %s\n", kind < g_symtab_kinds ? g_symtab_kind_name[kind] : "?", name);
    return lean_wasm_symtab_addr[i];
}

uint64_t wasm_symtab_size() {
    return lean_wasm_symtab_count;
}

/* Decode the whole table: names strictly increasing, every kind in range, every address set, and
   the FNV-1a-64 over `name NUL kind` in table order equal to the generator's. 0 when intact, else
   the first defect found: 1 no entries, 2 a name longer than the decoder takes, 3 a block that
   does not start at its offset, 4 names out of order, 5 a kind out of range, 6 a null address,
   7 another FNV. `counts` (7 entries) gets the entries per kind and `fnv` the FNV decoded, when
   not null. */
static uint32_t symtab_selfcheck(uint64_t * counts, uint64_t * fnv) {
    uint64_t kinds[g_symtab_kinds] = {};
    uint64_t h = 0xcbf29ce484222325ull;
    size_t n = static_cast<size_t>(lean_wasm_symtab_count), block = lean_wasm_symtab_block;
    uint32_t status = 0;
    char cur[g_symtab_maxlen_cap + 1], prev[g_symtab_maxlen_cap + 1]; // on the shadow stack (linear memory)
    if (n == 0 || block == 0) status = 1;
    else if (lean_wasm_symtab_maxlen > g_symtab_maxlen_cap) status = 2;
    unsigned char const * p = lean_wasm_symtab_names;
    size_t len = 0;
    for (size_t i = 0; status == 0 && i < n; i++) {
        size_t shared = 0;
        if (i % block == 0) {
            if (p != lean_wasm_symtab_names + lean_wasm_symtab_block_off[i / block]) { status = 3; break; }
        } else {
            shared = *p++;
            if (shared > len) { status = 4; break; }
        }
        size_t suffix = strlen(reinterpret_cast<char const *>(p));
        if (shared + suffix > g_symtab_maxlen_cap) { status = 2; break; }
        memcpy(cur + shared, p, suffix + 1);
        p += suffix + 1;
        len = shared + suffix;
        if (i > 0 && strcmp(prev, cur) >= 0) { status = 4; break; }
        uint8_t k = lean_wasm_symtab_kind[i];
        if (k >= g_symtab_kinds) { status = 5; break; }
        if (lean_wasm_symtab_addr[i] == nullptr) { status = 6; break; }
        kinds[k]++;
        for (size_t j = 0; j <= len; j++) { h ^= static_cast<unsigned char>(cur[j]); h *= 0x100000001b3ull; } // the name and its NUL
        h ^= k;
        h *= 0x100000001b3ull;
        memcpy(prev, cur, len + 1);
    }
    if (status == 0 && h != lean_wasm_symtab_fnv) status = 7;
    if (counts) for (unsigned k = 0; k < g_symtab_kinds; k++) counts[k] = kinds[k];
    if (fnv) *fnv = h;
    return status;
}

/* The self-check, run once (at the first question lean_wasm_symtab_stats needs it for). */
struct symtab_check {
    uint32_t status;
    uint64_t counts[g_symtab_kinds];
    uint64_t fnv;
};
static symtab_check const & symtab_checked() {
    static symtab_check const check = [] {
        symtab_check c{};
        c.status = symtab_selfcheck(c.counts, &c.fnv);
        return c;
    }();
    return check;
}
}

/* For hosts and the gate (G2): a full decode of the table, now; 0 when intact, else the defect
   (above). `counts` (7 x u64) and `fnv` (u64) may be null. A few ms, from any thread. */
extern "C" LEAN_EXPORT uint32_t lean_wasm_symtab_selfcheck(uint64_t * counts, uint64_t * fnv) {
    return lean::symtab_selfcheck(counts, fnv);
}

/* The table's gauges, as doubles (exact to 2^53), -1 for an unknown key: 0..6 lookups that found
   an entry of that kind (boxed, plain, export, cell, init, init_rt, init_meta), 7 lookups that
   found none, 8 the table's entries, 9..15 its entries per kind and 16 the self-check's status
   (0 intact), 17 and 18 the high and low 32 bits of the FNV it decoded. Keys 0..8 are lock-free
   reads; the first of keys 9..18 runs the self-check once (a few ms). */
extern "C" LEAN_EXPORT double lean_wasm_symtab_stats(unsigned key) {
    if (key < lean::g_symtab_kinds) return static_cast<double>(lean::g_symtab_hits[key].load(std::memory_order_relaxed));
    switch (key) {
    case 7: return static_cast<double>(lean::g_symtab_misses.load(std::memory_order_relaxed));
    case 8: return static_cast<double>(lean_wasm_symtab_count);
    default: break;
    }
    if (key > 18) return -1;
    lean::symtab_check const & c = lean::symtab_checked();
    if (key < 16) return static_cast<double>(c.counts[key - 9]);
    if (key == 16) return c.status;
    return static_cast<double>(key == 17 ? c.fnv >> 32 : c.fnv & 0xffffffffull);
}
#endif
