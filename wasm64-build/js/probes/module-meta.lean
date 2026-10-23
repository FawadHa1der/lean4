module
public meta import Lean
-- 0042: a `meta` import into a shared environment first imported without `meta` (the gate's
-- earlier private `import Lean` file): the public `meta` def must reach Lean's elaborator, so the
-- environment's modules must be available at compile time (`irPhases := .all`).
open Lean Elab Tactic
public meta def probeMeta (stx : Syntax) : TacticM Expr := elabTermEnsuringType stx none
