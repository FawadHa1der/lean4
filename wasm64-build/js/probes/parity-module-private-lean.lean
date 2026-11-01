module
import Lean
-- R10 stock parity (gate block 7, the exact cell): a public signature naming a PRIVATELY imported constant. Stock
-- rejects it ("Unknown identifier `Lean.Expr`"); a shared environment accepts it (0042's superset).
def privUse : Lean.Expr := .bvar 0
public def pubUse : Lean.Expr := .bvar 0  -- R10:publicUse
#check Nat  -- R10:reached
