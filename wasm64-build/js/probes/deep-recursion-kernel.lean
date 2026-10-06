-- qed64 HARDENING #60 (patch 0036), kernel side: `decide +kernel` skips Meta's evaluation and the
-- kernel's own check recurses past a browser's stack. It must end in the kernel's error, the
-- thread alive.
theorem deepKernel : ∀ n : Fin 120, ∀ m : Fin 120, n * m = m * n := by decide +kernel
#eval "DEEP SURVIVED"
