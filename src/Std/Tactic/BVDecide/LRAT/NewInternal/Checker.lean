/-
Copyright (c) 2026 Lean FRO, LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Henrik Böving
-/
module

prelude
public import Std.Sat.CNF.Basic
public import Std.Data.HashMap
public import Std.Tactic.BVDecide.LRAT.Actions
import Init.Omega

public section

namespace Std.Tactic.BVDecide.LRAT.NewInternal

open Std.Sat

structure Pos where
  val : Nat
  hpos : 0 < val

instance : Inhabited Pos where
  default := { val := 1, hpos := by omega }

structure State where
  formula : Array (Option (CNF.Clause Pos))

def State.delete (s : State) (ids : Array Nat) : State :=
  ids.foldl (init := s) fun s idx =>
    let ⟨clauses⟩ := s
    -- TODO: unsound
    ⟨clauses.setIfInBounds (idx - 1) none⟩

def State.add (s : State) (clause : CNF.Clause Pos) : State :=
  { s with formula := s.formula.push (some clause) }

structure Assignment where
  assign : Std.HashMap Nat Bool := {}

@[inline]
def Assignment.get? (a : Assignment) (lit : Nat) : Option Bool :=
  a.assign[lit]?

@[inline]
def Assignment.insert (a : Assignment) (lit : Nat) (b : Bool) : Assignment :=
  { a with assign := a.assign.insert lit b }

def State.checkRup (s : State) (clause : CNF.Clause Pos) (rupHints : Array Nat) : Bool := Id.run do
  --dbg_trace s!"Preparing propagation of {clause.literals.map fun (a, p) => (a.1, p)} into {rupHints.map fun idx => s.formula[idx-1]!.map (·.literals.map fun (a, p) => (a.1, p))}"
  let some assignment := prepareAssignment clause | return true
  go assignment rupHints 0
where
  prepareAssignment (clause : CNF.Clause Pos) : Option Assignment := Id.run do
    let mut assign := Assignment.mk {}
    -- TODO: iterator over clauses
    for (atom, pol) in clause.literals do
      if let some value := assign.get? atom.val then
        if value == pol then
          continue
        else
          return none
      else
        assign := assign.insert atom.val !pol
    return some assign

  go (assign : Assignment) (rupHints : Array Nat) (idx : Nat) : Bool := Id.run do
    if h : idx < rupHints.size then
      let hint := rupHints[idx]
      let some (some hintClause) := s.formula[hint - 1]? | return false
      let mut unit : Option Nat := none
      let mut assign := assign
      for (atom, pol) in clause.literals do
        if let some value := assign.get? atom.val then
          if value == pol then
            if unit == some atom.val then
              continue
            else
              return go assign rupHints (idx + 1)
          else
            continue
        else
          if unit.isSome then
            return false
          else
            unit := some atom.val
          assign := assign.insert atom.val pol
      if unit.isNone then
        return true
      else
        return go assign rupHints (idx + 1)
    else
      return false

def State.checkEmpty (s : State) (rupHints : Array Nat) : Bool :=
  s.checkRup .empty rupHints

def check (formula : CNF Nat) (proof : Array IntAction) : Bool :=
  let state := { formula := convertFormula formula }
  go state proof 0
where
  go (state : State) (proof : Array IntAction) (idx : Nat) : Bool :=
    if h : idx < proof.size then
      let step := proof[idx]
      match step with
      | .addEmpty id rupHints => state.checkEmpty rupHints
      | .addRup id clause rupHints =>
        let clause := convertClause clause
        if state.checkRup clause rupHints then
          go (state.add clause) proof (idx + 1)
        else
          false
      | .addRat .. => false -- TODO
      | .del ids => go (state.delete ids) proof (idx + 1)
    else
      false

  convertClause (clause : Array Int) : CNF.Clause Pos :=
    ⟨clause.toList.filterMap fun int =>
      if int > 0 then
        some (⟨int.natAbs, sorry⟩, true)
      else if int < 0 then
        some (⟨int.natAbs, sorry⟩, false)
      else
        none
    ⟩

  convertFormula (cnf : CNF Nat) : Array (Option (CNF.Clause Pos)) :=
    cnf.clauses.map fun clause => some <| ⟨clause.literals.map fun (atom, pol) => (⟨atom + 1, by omega⟩, pol)⟩

end Std.Tactic.BVDecide.LRAT.NewInternal
