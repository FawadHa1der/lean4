-- patch 0037: an async theorem's "declaration uses `sorry`" warning is logged inside the proof
-- task's tree (by `addDecl`'s kernel-check task, AddDecl.lean `doAdd` → `warnIfUsesSorry`).
-- A consumer that misses it takes a `sorry` for a proof.
set_option Elab.async true in
theorem asyncSorry : 1 = 2 := sorry
