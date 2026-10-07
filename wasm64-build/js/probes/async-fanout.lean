import Lean
-- patch 0037: one command starts 41 async proofs (and their kernel checks) at once; the shell
-- waits for all of them after the command. One is false and must be reported, once.
open Lean Elab Command in
elab "probe_async_fanout" : command =>
  withScope (fun s => { s with opts := s.opts.setBool `Elab.async true }) do
    for i in List.range 40 do
      let id := mkIdent (Name.mkSimple s!"asyncFan{i}")
      let n := Syntax.mkNatLit (i * 7)
      elabCommand (← `(command| theorem $id:ident : $n:num % 7 = 0 := by decide))
    elabCommand (← `(command| theorem asyncFanBad : 43 % 7 = 0 := by decide))

probe_async_fanout
