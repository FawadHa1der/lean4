-- qed64 HARDENING #60 (patch 0036), kernel side: `decide +kernel` skips Meta's evaluation and the
-- kernel's own check recurses past a browser's stack. It must end in the kernel's error, the
-- thread alive. Sized for 0040 (native Wasm exceptions halved the kernel's stack per level):
-- Fin 120 now checks at Chrome's 0.68 MiB; Fin 320 still exhausts 1.0 MiB (Fin 240 checks at 0.9),
-- so the guard trips at Chrome's stack with room to spare, on JS-EH runtimes all the more.
theorem deepKernel : ∀ n : Fin 320, ∀ m : Fin 320, n * m = m * n := by decide +kernel
#eval "DEEP SURVIVED"
