module
import Lean
-- 0042: `Lean` imported privately. `privUse` is fine everywhere. Stock rejects `pubUse`
-- (`Lean.Expr` is Lean's, imported privately); a shared wasm environment imports every root
-- publicly (so a later `public import Lean` file is served correctly) and accepts it: the known
-- superset.
def privUse : Lean.Expr := .bvar 0
public def pubUse : Lean.Expr := .bvar 0
