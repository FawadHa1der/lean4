import Lean
-- patch 0037: the Runner shape with a valid proof reports nothing.
open Lean Elab Command in
elab "probe_async_scope_ok" : command => do
  withScope (fun s => { s with opts := s.opts.setBool `Elab.async true }) do
    elabCommand (← `(command| theorem asyncNestedOk (n : Nat) : n + 0 = n := by simp))

probe_async_scope_ok
