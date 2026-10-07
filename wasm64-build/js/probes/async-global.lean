-- patch 0037: `Elab.async` for the whole file, the native frontend's default
-- (Elab/Frontend.lean `Elab.async.setIfNotSet opts true`). Linters then run in a task after the
-- proofs (Elab/Command.lean `runLintersAsync`): the unused-variable warning exists only in that
-- task, and `h`, used only inside an async body, must not be reported.
set_option Elab.async true
theorem asyncUsesH (a b : Nat) (h : a = b) : b = a := h.symm
theorem asyncUnusedH (a : Nat) (h : a = a) : True := trivial
#check asyncUsesH
