module
import Mathlib.Basic.Real.Basic
-- R10 stock parity (gate block 7): a public signature naming a privately imported Mathlib constant
-- (the Mathlib and covered cells).
-- Stock rejects it ("Unknown constant `Real`"); a shared environment accepts it (0042's superset).
def privReal : ℝ := 1
public def pubReal : ℝ := 1  -- R10:publicUse
#check Nat  -- R10:reached
