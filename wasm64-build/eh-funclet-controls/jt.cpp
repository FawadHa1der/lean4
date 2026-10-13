// LLVM #229448 shape (x86_64-windows-msvc report), rewritten here independently.
#include <cstdio>
struct E {};
__attribute__((noinline)) void mayThrow(int x) { if (x & 1) throw E(); }
__attribute__((noinline)) void record(int) { }
static inline bool probe(int x) {
  try { mayThrow(x); } catch (E&) { return false; }
  return true;
}
__attribute__((noinline)) int run(int n) {
  int bad = 0;
  for (int i = 0; i < n; ++i)
    if (probe(i) != ((i & 1) == 0)) { record(i); ++bad; }
  return bad;
}
int main() { int b = run(6); std::printf("bad=%d (expect 0)\n", b); return 0; }
