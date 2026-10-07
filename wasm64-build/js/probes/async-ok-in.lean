-- patch 0037 (qed64 probe-neg P8): a valid async proof scoped by `in` reports nothing.
set_option Elab.async true in
theorem asyncOkIn : 1 + 1 = 2 := by rfl
