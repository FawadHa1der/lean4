/-!
The native-symbol table (kernel gate; patch 0039). The gate appends this file to its legacy run,
which imports Lean, with `LEAN_WASM_SYMTAB_TRACE` = `miss:;hit:` and the names below: the runtime
then prints, as `[symtab] …` lines on stderr, every lookup that found no native code and the
lookups that found these names. Every line this file prints starts with `SYMTAB`; none may contain
the word the legacy checks reject.

* G4, cells: interpreted code reads a constant from its native cell. `#eval` compiles its term and
  the interpreter, running it, loads `Lean.versionString` (a constant) and `Lean.Meta.simpExtension`
  (a `builtin_initialize` cell) through the table: `[symtab] hit cell l_Lean_versionString` and
  `[symtab] hit cell l_Lean_Meta_simpExtension`.
* G5, plain functions: `symtabProbe`'s IR calls `Lean.Name.append` (and `List.range`), all-object
  core functions without a boxed wrapper (`l_Lean_Name_append`, kind plain). With the plain
  functions in the table the call runs native (`[symtab] hit plain l_Lean_Name_append`); without
  them it is interpreted, after a miss on `l_Lean_Name_append___boxed` and on `l_Lean_Name_append`.
* G6, timing (informational): `symtabProbe 20000`, timed with `IO.monoMsNow`.
-/

/-- The names `x0`, …, `x(n-1)` appended one by one: `x0.x1.….x(n-1)`. -/
def symtabProbe (n : Nat) : Lean.Name :=
  (List.range n).foldl (fun acc i => Lean.Name.append acc (Lean.Name.mkSimple s!"x{i}")) .anonymous

-- G4: two constants the interpreter reads from their cells
#eval IO.println s!"SYMTAB G4 versionString {Lean.versionString}"
#eval show Lean.CoreM Unit from do
  let simp := Lean.Meta.simpExtension.getState (← Lean.getEnv)
  IO.println s!"SYMTAB G4 simpExtension has Nat.add_zero: {simp.lemmaNames.contains (.decl ``Nat.add_zero)}"
-- G5: an interpreted function calling plain core functions
#eval IO.println s!"SYMTAB G5 {symtabProbe 3}"
-- G6: the same, 20,000 times. The count depends on `t0` and runs inside `IO.lazyPure`, or the
-- compiler would hoist the call out as a closed term, computed before the clock is read.
#eval show IO Unit from do
  let t0 ← IO.monoMsNow
  let parts ← IO.lazyPure fun _ => (symtabProbe (20000 + t0 % 1)).getNumParts
  let t1 ← IO.monoMsNow
  IO.println s!"SYMTAB G6 parts={parts} ms={t1 - t0}"
