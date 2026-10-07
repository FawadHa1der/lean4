-- patch 0037 (qed64 probe-neg N6b): unsolved goals of an async tactic proof, reported once.
set_option Elab.async true in
theorem asyncUnsolved (n : Nat) : n = n + 1 := by skip
