Frozen copies of lean4-wasm64 4.34.0-e1a79c1-r2's `release-record.mjs` and
`artifact-id.mjs` (tools commit 2050a9ca0c), byte for byte: the reader written
before `release.json` had `base`. `test/recut-record.test.mjs` runs it on a
re-cut by reference to prove older readers fail closed (formats/release.md,
"Older readers"). Never edit them.
