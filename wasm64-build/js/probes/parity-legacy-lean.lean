import Lean
-- R10 stock parity (gate block 7): a legacy file, `import Lean` (the exact cell).
def plainDef := 1
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let plainPrivate := env.constants.map₂.toList.any fun (n, _) => (`plainDef).isSuffixOf n && isPrivateName n
  logInfo m!"PARITY isModule={env.header.isModule} plainPrivate={plainPrivate} importedDocs={doc.isSome}"
example : Nat.toDigits 10 123 = ['1', '2', '3'] := by decide  -- R10:decide
