module
public import Mathlib.Basic.Real.Basic
-- R10 stock parity (gate block 7): a `module` file, a real Mathlib header (the Mathlib cell).
-- HARDENING #80 on 53cb11e: "Unknown constant `Real`".
def plainDef := 1
public def probeReal : ℝ := 1  -- R10:publicUse
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let realDoc ← findDocString? env ``Real (includeBuiltin := false)
  let plainPrivate := env.constants.map₂.toList.any fun (n, _) => (`plainDef).isSuffixOf n && isPrivateName n
  let pub := env.setExporting true
  let publicScope : Nat := env.constants.map₁.fold (init := 0) fun n c _ =>
    if (pub.find? c (skipRealize := true)).isSome then n + 1 else n
  logInfo m!"PARITY isModule={env.header.isModule} plainPrivate={plainPrivate} importedDocs={doc.isSome} realDocs={realDoc.isSome} publicScope={publicScope} modules={env.header.moduleNames.size}"
