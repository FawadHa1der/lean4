# `qed64.snapshot-index/v1` — the snapshot index

The snapshot index is QED64's format. QED64 owns the format, its writer (the
bake `pipeline/snapshot/bake-snapshot.mjs`) and the snapshot probe
`pipeline/snapshot/snapshot-probe.mjs` (architecture review D4 (a),
2026-11-01). This package writes no `.snapz` and no index (the gate's R10 cell
bakes a raw `.snap` for its own use only).

The specification is QED64's `docs/SNAPSHOT-INDEX.md`, which will hold the
writer rules (the entry keys and their order, the upsert, the locks, the
per-build copy). Until it lands there, the previous full specification is this
path at kernel commit `66e4f0c431` (last changed in `271abbf1ef`).

What stays in this package: the pairing rule (an entry's `runtime` is the
runtime manifest's `buildId`: [README.md](README.md), pairing rules) and how a
site serves the index, its `.snapz` files and the per-build copies
([HOSTING.md](HOSTING.md), "Snapshot indexes: the pinned copies"). Snapshots
and their index are a site's product, never part of a toolchain release
([`../../RELEASE.md`](../../RELEASE.md)).
