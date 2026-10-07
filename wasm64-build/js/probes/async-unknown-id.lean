-- patch 0037 (qed64 probe-neg N6): an `Elab.async` theorem's proof is elaborated in a task whose
-- messages live in `Command.State.snapshotTasks`, not `messages`. lean_wasm_compile must report
-- the unknown identifier exactly once, at `foo`.
set_option Elab.async true in
theorem asyncUnknownId : 1 = 2 := by exact foo
