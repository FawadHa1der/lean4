import Lean
-- patch 0037: several commands in one file. Every message is reported exactly once (the
-- snapshot tasks are reset per command, as Language/Lean.lean's `doElab` does; the linter task
-- of a global-async command carries the command's messages as already reported), and messages
-- come out command by command, each command's own messages before its tasks'.
open Lean Elab Command in
elab "probe_marker_then_async" : command => do
  logWarning "0037-sync-marker"
  withScope (fun s => { s with opts := s.opts.setBool `Elab.async true }) do
    elabCommand (← `(command| theorem asyncAfterMarker (n : Nat) : n = n + 1 := by skip))

probe_marker_then_async
#check Nat
set_option Elab.async true
theorem asyncGlobalBad : 1 = 2 := by exact foo
#check Nat.succ
