-- patch 0037: `#guard_msgs` collects AND clears the tasks in `Command.State.snapshotTasks`
-- (Elab/GuardMsgs.lean `runAndCollectMessages`). The shell must not report the guarded error
-- again, and, with the per-command reset, the second guard must not collect the unguarded
-- theorem's task (it would fail with a mismatch).
/-- error: Unknown identifier `foo` -/
#guard_msgs in
set_option Elab.async true in
theorem asyncGuarded : 1 = 2 := by exact foo
set_option Elab.async true in
theorem asyncBeforeGuard : 1 = 2 := by exact foo
/-- info: 2 -/
#guard_msgs in
#eval 1 + 1
