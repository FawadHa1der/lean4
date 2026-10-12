/-!
Thread knobs (kernel gate; patch 0038), through the real task manager. The gate appends this file
to runs with `LEAN4_WASM64_RTSTATS=1`, where node-runner answers every printed `[rtstats?]` with
one `[rtstats] <json>` line of the runtime's counters (EMBED-RUNTIME.md §3.1); it has no imports.

* `knobsNest n` — a pool task blocked in `Task.get` on a pool task blocked on another, `n` deep.
  Each blocked level raises the standard-worker cap by one while it waits (`wait_for`) and starts
  a worker when none is idle, so the burst ends with more workers than the cap. They stay, as
  before 0038, unless `LEAN_WASM_STD_SURPLUS_EXIT=1`: then the surplus exits.
* `knobsBurst n` — `n` dedicated tasks live at once, then done. With `LEAN_WASM_PARKED_DEDICATED`
  their threads park; with `LEAN_WASM_PARKED_IDLE_MS` too, they leave after that idle time.

After each burst the probe samples every 100 ms for 3 s, busy-waiting on `IO.monoMsNow` (timed
sleeps on task threads wake late in this build). A sample is the line
`KNOBS <phase> t=<ms since the burst ended> [rtstats?]`, printed by a pool task: `#eval` gathers
its own thread's output into one message printed when the command ends, while a task's thread
writes to the process's stdout at once.
-/

/-- `n` pool tasks, each blocked in `Task.get` on the next. -/
partial def knobsNest : Nat → Nat
  | 0 => 0
  | n + 1 => (Task.spawn fun _ => knobsNest n).get + 1

/-- Print `line` now (see the module doc). -/
def knobsEmit (line : String) : IO Unit := do
  let t ← IO.asTask do
    let out ← IO.getStdout
    out.putStrLn line
    out.flush
  match ← IO.wait t with
  | .ok () => pure ()
  | .error e => throw e

/-- Samples every `every` ms for `ms` ms after the phase's burst, then one last (`<phase>-end`). -/
def knobsSettle (phase : String) (ms every : Nat) : IO Unit := do
  let t0 ← IO.monoMsNow
  let mut next := t0
  repeat
    let now ← IO.monoMsNow
    if now ≥ t0 + ms then break
    if now ≥ next then
      knobsEmit s!"KNOBS {phase} t={now - t0} [rtstats?]"
      next := now + every
  knobsEmit s!"KNOBS {phase}-end t={(← IO.monoMsNow) - t0} [rtstats?]"

/-- The nest, run in a pool task: `Task.get` raises the cap only in one. -/
def knobsNestPhase (depth : Nat) : IO Nat :=
  IO.wait (Task.spawn fun _ => knobsNest depth)

/-- `n` dedicated tasks, each held until all `n` exist, so their threads are live at once. -/
def knobsBurst (n : Nat) : IO Unit := do
  let go ← IO.Promise.new (α := Unit)
  let ts ← (List.range n).mapM fun i =>
    BaseIO.asTask (prio := .dedicated) do discard <| IO.wait go.result!; return i
  go.resolve ()
  for t in ts do discard <| IO.wait t

#eval show IO Unit from do
  knobsEmit "KNOBS start t=0 [rtstats?]"
  let depth ← knobsNestPhase 8
  knobsEmit s!"KNOBS nest-done depth={depth}"
  knobsSettle "nest" 3000 100
  knobsBurst 6
  knobsSettle "burst" 3000 100
  knobsEmit "KNOBS DONE"
