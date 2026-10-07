-- patch 0037, informational (not gated): with the option scoped by `in`, the surrounding command
-- is synchronous, so its linters run before the proof task and see a `.hole` for the body
-- (Elab/Command.lean `runLintersAsync`, sync branch). A false "Variable name `h` is not
-- explicitly referenced" here is upstream mixed-mode behaviour, not a reporting defect.
set_option Elab.async true in
theorem asyncMixedUsesH (a b : Nat) (h : a = b) : b = a := h.symm
