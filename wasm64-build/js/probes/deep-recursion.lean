-- qed64 HARDENING #60 (patch 0036). The gate runs this with the runtime's pthread stacks at a
-- browser's size (LEAN4_WASM64_PTHREAD_STACK_MB=0.68 ~ Chrome's 500 KiB Worker stack): Meta's
-- evaluation of this `decide` recurses deeper than that allows. It must end in Lean's
-- max-recursion error while the thread lives on, and at the default stack it must succeed.
theorem deepMeta : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide
#eval "DEEP SURVIVED"
