// Variant with NO [[gnu::const]] annotation: a same-TU noinline helper whose memory(none)
// is only inferred by the optimizer (closer to what ordinary runtime code looks like).
#include <cstdio>
__attribute__((noinline)) int sq(int x) { return x * x + 1; }
__attribute__((noinline)) void mayThrow(bool doThrow) { if (doThrow) throw 1; }
__attribute__((noinline)) int test(int x, bool b, bool doThrow) {
  int a = 0;
  if (b) { a = sq(x); } else {
    try { mayThrow(doThrow); a = sq(x); } catch (...) { }
  }
  return a + sq(x);
}
int main(int argc, char**) {
  std::printf("nothrow=%d\n", test(argc + 5, false, false));
  std::printf("throw=%d\n", test(argc + 5, false, true));  // expect 37
  return 0;
}
