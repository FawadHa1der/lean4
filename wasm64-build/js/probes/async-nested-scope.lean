import Lean
-- patch 0037 (qed64 probe-neg N7): lean4game's GameServer Runner shape. A command elaborator
-- runs `elabCommand` on a theorem under `withScope` with `Elab.async` switched on.
open Lean Elab Command in
elab "probe_async_scope" : command => do
  withScope (fun s => { s with opts := s.opts.setBool `Elab.async true }) do
    elabCommand (← `(command| theorem asyncNested : 1 = 2 := by exact foo))

probe_async_scope
