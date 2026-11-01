-- R10 stock parity (gate block 7): a legacy file, Init only (the exact, snapshot and resident cells;
-- the resident one at stock's editor level, -DElab.inServer=true). Without
-- `import Lean` there is no meta API: a `-- R10:<fact>` line is judged by its messages (gate.mjs
-- r10FactsOf): `print` the privacy `#print` shows, `doc` the warning `@[inherit_doc]` gives a legacy
-- file when the imported docstring is absent, any other fact true when the line has no error.
-- `attrUse`: a legacy file may add a compile-time attribute without `meta` (HARDENING #51).
def plainDef := 1
#print plainDef  -- R10:print
@[inherit_doc List.map] def plainMap := @List.map  -- R10:doc
example : Nat.toDigits 10 123 = ['1', '2', '3'] := by decide  -- R10:decide
@[app_unexpander List.nil] def unexpandNil : Lean.PrettyPrinter.Unexpander  -- R10:attrUse
  | `($_) => `([])
#check Nat  -- R10:reached
