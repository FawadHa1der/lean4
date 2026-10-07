import Lean
-- patch 0037: a kernel error under `Elab.async` is logged by `addDecl`'s kernel-check task
-- (AddDecl.lean), as patch 0036's "(kernel) … stack is exhausted" errors are; elaboration
-- itself succeeds. Shape of tests/elab/pow_exploit.lean.
open Lean Elab Command in
elab "probe_async_kernel" : command =>
  withScope (fun s => { s with opts := s.opts.setBool `Elab.async true }) do
    liftCoreM <| addDecl <| .thmDecl
      { name := `asyncKernelBad, levelParams := [], type := mkConst ``False, value := mkConst ``True.intro }

probe_async_kernel
