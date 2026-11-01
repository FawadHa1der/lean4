module
public import Lean
-- R10 stock parity (gate block 7): a `module` file, `public import Lean` (the exact cell).
-- `publicScope`: the imported constants a public signature can name.
def plainDef := 1
public def probeName : Lean.Name := Lean.Name.anonymous  -- R10:publicUse
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let plainPrivate := env.constants.map₂.toList.any fun (n, _) => (`plainDef).isSuffixOf n && isPrivateName n
  let pub := env.setExporting true
  let publicScope : Nat := env.constants.map₁.fold (init := 0) fun n c _ =>
    if (pub.find? c (skipRealize := true)).isSome then n + 1 else n
  logInfo m!"PARITY isModule={env.header.isModule} plainPrivate={plainPrivate} importedDocs={doc.isSome} publicScope={publicScope}"
#check Nat  -- R10:reached
