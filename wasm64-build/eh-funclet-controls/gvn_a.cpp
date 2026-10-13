// LLVM #226286 shape, written independently (two TUs): pure call PRE'd into a catch handler.
#include <cstdio>
[[gnu::const]] int id();
void mayThrow(bool doThrow);
__attribute__((noinline)) int test(bool b, bool doThrow) {
  int a = 0;
  if (b) { a = id(); } else {
    try { mayThrow(doThrow); a = id(); } catch (...) { }
  }
  return a + id();
}
int main() {
  std::printf("nothrow=%d\n", test(false, false));
  std::printf("throw=%d\n", test(false, true));   // expect 42
  return 0;
}
