-- PATCHES 0044: both stack-guard errors of 0036 carry the LSP `code` `wasm.stackExhausted`. The gate
-- runs this at a browser's stack (LEAN4_WASM64_PTHREAD_STACK_MB=0.68, as for deep-recursion*.lean).
-- `#lsp_code` elaborates one command, then prints the `code` each of its errors gets from
-- msgToInteractiveDiagnostic, the function the server builds its diagnostics with (publishDiagnostics
-- and the interactive-diagnostics RPC). The Meta and kernel cases are the two deep-recursion probes'
-- theorems; the last case, an ordinary error, must not get the code. The helpers are small top-level
-- definitions on purpose: one `elab` with the whole body nested in `do` exhausts Chrome's stack while
-- it is itself being elaborated.
import Lean
open Lean Elab Command

-- the cases' errors must reach `messages` before `#lsp_code` reads it, not an async task's snapshot
set_option Elab.async false

def codeName : Option Lsp.DiagnosticCode → String
  | some (.string s) => s
  | some (.int i) => toString i
  | none => "none"

def printCode (site : Name) (text : FileMap) (m : Message) : IO Unit := do
  unless m.severity == .error do return
  let d ← Widget.msgToInteractiveDiagnostic text m false
  IO.println s!"LSP CODE {site} {codeName d.code?}"

def elabCaptured (cmd : Syntax) : CommandElabM MessageLog := do
  let saved := (← get).messages
  modify fun s => { s with messages := {} }
  try elabCommand cmd catch ex => logException ex
  let msgs := (← get).messages
  modify fun s => { s with messages := saved ++ msgs }
  return msgs

syntax (name := lspCode) "#lsp_code " ident command : command

@[command_elab lspCode] def elabLspCode : CommandElab := fun stx => do
  let msgs ← elabCaptured stx[2]
  let text ← getFileMap
  msgs.toList.forM (printCode stx[1].getId text ·)

#lsp_code metaSite theorem deepMeta : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide
#lsp_code kernelSite theorem deepKernel : ∀ n : Fin 320, ∀ m : Fin 320, n * m = m * n := by decide +kernel
#lsp_code plain example : (2 : Nat) + 2 = 5 := by decide
#eval "CODES DONE"
