-- patch 0037: a term-mode async body (no tactic block): its elaboration errors are reported.
set_option Elab.async true in
theorem asyncTermMismatch : 2 + 2 = 5 := rfl
