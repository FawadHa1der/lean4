# `qed64.snapshot-index/v1` — the snapshot index

The snapshot index is QED64's format. QED64 owns the format, its writer (the
bake `pipeline/snapshot/bake-snapshot.mjs`) and the snapshot probe
`pipeline/snapshot/snapshot-probe.mjs` (architecture review D4 (a),
2026-11-01). This package writes no `.snapz` and no index (the gate's R10 cell
bakes a raw `.snap` for its own use only).

The specification is QED64's `docs/SNAPSHOT-INDEX.md`, with the writer rules
(the entry keys and their order, the upsert, the locks, the per-build copy).

What stays in this package: the pairing rule (an entry's `runtime` is the
runtime manifest's `buildId`: [README.md](README.md), pairing rules) and how a
site serves the index, its `.snapz` files and any per-build copies
([HOSTING.md](HOSTING.md), "Snapshot indexes: served from the deploy, or pinned
by copies"). Snapshots
and their index are a site's product, never part of a toolchain release
([`../../RELEASE.md`](../../RELEASE.md)).
