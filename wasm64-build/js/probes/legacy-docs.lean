import Lean
-- 0042 (E3): imports at the `.server` level carry the docstrings and declaration ranges of the
-- module-system libraries (in `.olean.server`) where the tree ships them. The `decide` line is a
-- known deviation (no `.private` data: `Nat.toDigits`' body is not exposed), reported, not judged.
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let ranges ← liftCoreM <| findDeclarationRanges? ``List.map
  logInfo m!"isModule={env.header.isModule} importedDocs={doc.isSome} importedRanges={ranges.isSome}"
example : Nat.toDigits 10 123 = ['1', '2', '3'] := by decide
