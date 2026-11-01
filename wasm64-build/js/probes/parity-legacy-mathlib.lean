import Mathlib.Basic.Real.Basic
-- R10 stock parity (gate block 7): a legacy file, a real Mathlib header (the Mathlib cell,
-- --mathlib-lib, and the covered cell at stock's editor level). Check the module's name at each Lean import (gate.mjs R10_MATHLIB_OLEAN).
def plainDef := 1
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let realDoc ← findDocString? env ``Real (includeBuiltin := false)
  let plainPrivate := env.constants.map₂.toList.any fun (n, _) => (`plainDef).isSuffixOf n && isPrivateName n
  logInfo m!"PARITY isModule={env.header.isModule} plainPrivate={plainPrivate} importedDocs={doc.isSome} realDocs={realDoc.isSome} modules={env.header.moduleNames.size}"
example (a b : ℝ) : a + b = b + a := add_comm a b  -- R10:mathlibUse
example : Nat.toDigits 10 123 = ['1', '2', '3'] := by decide  -- R10:decide
#check Nat  -- R10:reached
