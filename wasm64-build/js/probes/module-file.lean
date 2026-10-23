module
public import Lean
-- 0042: public declarations resolve imported names. Served a shared environment imported for a
-- legacy file (wasmCompile's cache, a snapshot), the public constant map was empty
-- ("Unknown identifier `Lean.Name`"). `publicScope` is that map's size; imported docs and ranges
-- come from the `.olean.server` facets (the `.server` import level).
public def probeName : Lean.Name := Lean.Name.anonymous
public def probeExpr : Lean.Expr := .bvar 0  -- outside Init
public theorem probeThm : (2 : Nat) + 2 = 4 := rfl
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let doc ← findDocString? env ``List.map (includeBuiltin := false)
  let ranges ← liftCoreM <| findDeclarationRanges? ``List.map
  -- `constants` is the private map; `find?` on an exporting environment reads the public one
  let pub := env.setExporting true
  let publicScope : Nat := env.constants.map₁.fold (init := 0) fun n c _ =>
    if (pub.find? c (skipRealize := true)).isSome then n + 1 else n
  logInfo m!"isModule={env.header.isModule} publicScope={publicScope} importedDocs={doc.isSome} importedRanges={ranges.isSome}"
