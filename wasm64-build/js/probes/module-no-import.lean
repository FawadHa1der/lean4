module
-- 0042: Init alone (the implicit import): `Nat` must resolve in a public signature, and an
-- exported `rfl` theorem unfolds an `@[expose]`d definition.
@[expose] public def pubN : Nat := 4
public theorem pubT : pubN = 4 := rfl
