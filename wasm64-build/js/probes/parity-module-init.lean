module
-- R10 stock parity (gate block 7): a `module` file, Init only (the exact, snapshot and resident
-- cells; the resident one at stock's editor level, -DElab.inServer=true).
-- `publicUse`: a public signature resolves an imported name (53cb11e: "Unknown identifier `Nat`").
-- `attrUse`: an attribute that runs code at compile time needs `meta` in a module file (stock refuses it).
def plainDef := 1
#print plainDef  -- R10:print
public def pubN : Nat := 4  -- R10:publicUse
@[app_unexpander List.nil] def unexpandNil : Lean.PrettyPrinter.Unexpander  -- R10:attrUse
  | `($_) => `([])
#check Nat  -- R10:reached
