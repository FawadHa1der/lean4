/-!
Task-manager storm (kernel gate; patch 0035). Every shape of task traffic the language
server produces, at volume, through the real task manager:

* `chain`     — a sequential chain of `.dedicated` tasks whose `.dedicated` bind
                continuations spawn the next step: the shape of `Std.Channel.forAsync`,
                which the FileWorker uses for every LSP output message;
* `fanout`    — one promise releases many `.dedicated` dependents at once, both directly
                and through a sync-priority map (the nested `handle_finished` →
                `enqueue_core` → `run_task` path);
* `ladder`    — `.dedicated` tasks that each block until the NEXT one finishes, all
                spawned before any can finish: needs `n` live dedicated threads at once,
                more than the parked-thread cap. It deadlocks if a dedicated task ever
                waits behind another one;
* `poolWaits` — pool tasks blocking in `IO.wait` on dedicated tasks (the `wait_for`
                compensation path, which may start std workers);
* `anyOf`     — `IO.waitAny` over dedicated tasks.

Rounds repeat so threads park and unpark. Prints one line,
`STORM OK dedicated=<n> checksum=<c> [pthreads?]` (node-runner with
`QED64_COUNT_PTHREADS=1` answers the marker with `[pthreads] created=<k>`), or
`STORM FAIL …`.
-/

def ded := Task.Priority.dedicated

/-- `n` steps; each step is one `.dedicated` task plus one `.dedicated` bind continuation. -/
partial def chain (n acc : Nat) : BaseIO (Task Nat) := do
  if n == 0 then return .pure acc
  let t ← BaseIO.asTask (prio := ded) (pure (acc + n))
  BaseIO.bindTask (prio := ded) t fun v => chain (n - 1) v

/-- `m` dedicated dependents of one promise: half on a shared task, half each through
its own sync map of the promise. -/
def fanout (m : Nat) : BaseIO Nat := do
  let p ← IO.Promise.new (α := Nat)
  let shared := p.result!
  let ts ← (List.range m).mapM fun i =>
    BaseIO.mapTask (prio := ded) (fun v => pure (v + i)) (if i % 2 == 0 then shared else p.result!)
  p.resolve 1
  let mut s := 0
  for t in ts do s := s + (← IO.wait t)
  return s

/-- `n` dedicated tasks, task `k` blocked until task `k-1`'s promise resolves; the first
waits on `top`, which is resolved only after all `n` are spawned. -/
def ladder (n : Nat) : BaseIO Nat := do
  let top ← IO.Promise.new (α := Nat)
  let mut next := top
  let mut ts := #[]
  for _ in [0:n] do
    let mine ← IO.Promise.new (α := Nat)
    let waitOn := next
    let t ← BaseIO.asTask (prio := ded) do
      let v ← IO.wait waitOn.result!
      mine.resolve (v + 1)
      return v
    ts := ts.push t
    next := mine
  top.resolve 0
  let r ← IO.wait next.result!
  for t in ts do discard <| IO.wait t
  return r

/-- `k` pool tasks, each blocked in `IO.wait` on a dedicated task that is itself held
by a gate until all of them exist. -/
def poolWaits (k : Nat) : BaseIO Nat := do
  let gate ← IO.Promise.new (α := Unit)
  let ds ← (List.range k).mapM fun i =>
    BaseIO.asTask (prio := ded) do discard <| IO.wait gate.result!; return i
  let ps ← ds.mapM fun d => BaseIO.asTask (prio := .default) do return (← IO.wait d) * 2
  gate.resolve ()
  let mut s := 0
  for p in ps do s := s + (← IO.wait p)
  return s

/-- `IO.waitAny` over `w` dedicated tasks; 1 if the winner is in range, then waits for all. -/
def anyOf (w : Nat) : BaseIO Nat := do
  let ts ← (List.range w).mapM fun i => BaseIO.asTask (prio := ded) (pure (i + 1))
  match ts with
  | [] => return 0
  | t :: rest =>
    let v ← IO.waitAny (t :: rest)
    for t in t :: rest do discard <| IO.wait t
    return if 1 ≤ v && v ≤ w then 1 else 0

def stormSizes : Nat × Nat × Nat × Nat × Nat × Nat := (800, 120, 24, 12, 24, 3)

#eval show IO Unit from do
  let (nChain, m, n, k, w, rounds) := stormSizes
  let mut got := 0
  let mut want := 0
  let mut dedicated := 0
  let c ← chain nChain 0
  got := got + (← IO.wait c)
  want := want + nChain * (nChain + 1) / 2
  dedicated := dedicated + 2 * nChain
  for _ in [0:rounds] do
    got := got + (← fanout m) + (← ladder n) + (← poolWaits k) + (← anyOf w)
    want := want + (m + m * (m - 1) / 2) + n + k * (k - 1) + 1
    dedicated := dedicated + m + n + k + w
  if got == want then
    IO.println s!"STORM OK dedicated={dedicated} checksum={got} [pthreads?]"
  else
    IO.println s!"STORM FAIL checksum={got} expected={want}"

/-- Thread-reuse fidelity: one dedicated task leaks a stderr redirection (never restores
it); later dedicated tasks print to stderr. Native Lean runs each on a fresh thread, so
nothing reaches the leaked buffer; a reused (parked) thread must behave the same. -/
#eval show IO Unit from do
  let buf ← IO.mkRef ({} : IO.FS.Stream.Buffer)
  let t1 ← IO.asTask (prio := .dedicated) do
    discard <| IO.setStderr (IO.FS.Stream.ofBuffer buf)
  discard <| IO.wait t1
  for _ in [0:20] do
    let t ← IO.asTask (prio := .dedicated) (IO.eprintln "storm-stderr-probe")
    discard <| IO.wait t
  IO.println s!"LEAKED-STDERR bytes={(← buf.get).data.size}"
