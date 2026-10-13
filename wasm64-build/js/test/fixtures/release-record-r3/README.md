Frozen copies of lean4-wasm64 4.34.0-e1a79c1-r3's `release-record.mjs` and
`artifact-id.mjs` (tools commit fe9f2d6699), byte for byte: the reader that knows
`base` only as a tools re-cut by reference. `test/runtime-recut.test.mjs` runs it
on a runtime release by reference to prove that reader fails closed
(formats/release.md, "Older readers"). Never edit them.
