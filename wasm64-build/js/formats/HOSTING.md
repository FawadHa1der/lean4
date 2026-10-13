# Hosting a lean4-wasm64 release

What a host must do so a browser can boot the runtime and mount the packs of a
release, and what the headless (Node) path needs. Every rule here is enforced
somewhere by a consumer that exists today (QED64, lean4game, the widgets
showcase); a host that breaks one gets a refusal, not a slow page.

## The rules

1. **Cross-origin isolation.** Every HTML document that boots the runtime is
   served with `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`. Without them there is no
   `SharedArrayBuffer`, hence no shared Memory64, and the worker fails closed
   (`CAPABILITY_MISSING`). Send `Cross-Origin-Resource-Policy: same-origin` on
   every response as well (all three sites do).
2. **A secure context.** HTTPS, or `http://localhost` / `127.0.0.1`. Cross-origin
   isolation, OPFS and Web Locks exist only there.
3. **One origin.** The page, its workers, `/runtime/*`, `/profiles/*` and
   `/snapshots/*` are on the page's own origin. Under COEP `require-corp` with
   CORP `same-origin`, an artifact on another origin is blocked as served — and
   the consumers refuse off-origin artifact URLs in code anyway (an artifact's
   origin decides which code runs next to the user's editor and storage), so
   CORS does not help. **A site that uses a shared release proxies the release
   bytes under its own origin**; the browser is never pointed at R2, GitHub, or
   another site.
4. **Mounted at the origin root.** Every URL inside the manifests is
   root-absolute: runtime chunks `/runtime/chunks/<file>`, pack parts
   `/profiles/<file>`. A site serves a release by mapping its files under
   `/runtime/` and `/profiles/` onto the release's `runtime/` and `profiles/`.
   No manifest is rewritten. The **site's own mutable pointers stay the site's**
   and are never in a release: `/profiles/index.json` (which packs the page
   offers — QED64 lists lean-core + mathlib-essential, lean4game lean-core only)
   and `/snapshots/*` — the snapshot index, its `.snapz` files and the per-build
   index copies `/snapshots/index.<buildId>.json` and
   `/snapshots/profiles-index.<buildId>.json` ([snapshot-index.md](snapshot-index.md);
   the profile index's copy lives under `/snapshots/` too, because every other
   `/profiles/*` path is the release's). So a Worker routes `/profiles/index.json`
   to the site's prefix and the rest of `/profiles/*` and `/runtime/*` to the
   release (or tries the site first and falls back to the release).
5. **Bytes are served exactly.** No `Content-Encoding` and no transformation on
   `*.part-NNN` (runtime chunks, pack parts) or `*.snapz`: they are verified at
   their served length and SHA-256, and a chunk that arrives encoded is refused.
   Store and serve them as `application/octet-stream`, a type CDNs do not
   compress on the fly (Cloudflare compresses JSON and JS to `br` — harmless,
   those are parsed, not hashed).
6. **Content types.** `*.json` → `application/json` (the pinned
   `runtime-manifest.<buildId>.json` is used only when its type contains
   `json`; otherwise QED64 silently falls back to the mutable manifest);
   `*.js`/`*.mjs` → `text/javascript`; `*.wasm` → `application/wasm` (only for
   consumers of an unchunked `lean.wasm`; a wrong type costs streaming
   compilation); `*.part-NNN`, `*.snapz` → `application/octet-stream`. HTML is
   never an acceptable answer to an artifact URL.
7. **Missing is 404, never an SPA fallback.** A cached HTML fallback under a
   digest-named URL poisons `force-cache` for a year. Do not cache errors
   (`Cache-Control: no-store` on every status ≥ 400).
8. **The cache rule** (QED64's `isImmutable`, shared by every consumer):

   ```js
   const IMMUTABLE  = "public, max-age=31536000, immutable";
   const REVALIDATE = "public, max-age=0, must-revalidate";
   function isImmutable(pathname) {
     if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/(?:profiles-)?index(\.[^/]*)?\.json$/.test(pathname)) return false;
     return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname);
   }
   ```

   Digest-named files are immutable. Every `runtime-manifest*.json` revalidates
   — the per-build one too, because the build id covers `lean.wasm` only and a
   relink that changes `lean.js` keeps the name — and so does every index:
   `index.json`, the per-build snapshot index copy `index.<buildId>.json` and a
   site's profile index copy `profiles-index.<buildId>.json`
   ([snapshot-index.md](snapshot-index.md)). A rebake for the same runtime
   rewrites a copy under the same name, and the 16 hex digits of its build id
   would otherwise make it immutable for a year (a 404 before its upload stays
   uncached by rule 7). Everything else revalidates. The regex matches 16+ hex
   digits **anywhere in the path**: never put a build id or a full digest in a
   directory name above a manifest (a release prefix
   `lean4-wasm64/lean-v4.34.0-a8817d0/` carries only 7, which is why release ids
   use 7).
9. **Range** (recommended, not required): a single `bytes=` range with strong
   `If-Range`, `416` + `Content-Range: bytes */size` + `no-store` when
   unsatisfiable. The browser cache uses it to resume large `.snapz` downloads.
   HEAD should answer `Content-Length`.
10. **Embedding.** A same-origin iframe inherits isolation. A cross-origin iframe
    needs `allow="cross-origin-isolated"` (plus `clipboard-read;
    clipboard-write` for the editor). A host CSP, if any, must allow `blob:` in
    `connect-src`, `script-src` and `worker-src`: the glue fetches the wasm from
    a `blob:` URL and starts its pthreads from `blob:` scripts.

## Size limits, and why everything is chunked

| Limit | Value |
|---|---|
| Cloudflare Pages / Workers static assets, per file | 25 MiB |
| GitHub Pages, per file | 100 MB, no custom headers (cannot isolate: unusable as the page host) |
| GitHub Release asset | < 2 GiB each, ≤ 1000 per release |
| `wrangler r2 object put` | ~300 MiB per object (use rclone for more) |

`lean.js` (~49 MB) and `lean.wasm` (~110 MB) exceed 25 MiB, so both ship as
16 MiB (16,777,216 B) parts, and so does every pack's gzip transport. Snapshots
(`.snapz`, up to ~365 MB) are single objects and need an object store or a host
without a per-file cap; they are a site's product, not part of a toolchain
release (baked with `lean4-wasm64 bake`, indexed as
[snapshot-index.md](snapshot-index.md) specifies).

## Where a release lives

| Copy | Layout | Reachable by browsers? |
|---|---|---|
| GitHub Release `lean-<tag>-<kernel7>[-rN]` on `FawadHa1der/lean4` | flat, by basename (a release by reference: only its own files, `release.json` and `SHA256SUMS`; the rest are its base's assets) | No (other origin, no isolation headers). It is the public download for tools and CI: `lean4-wasm64 fetch --from https://github.com/FawadHa1der/lean4/releases/download/<id>/` |
| R2 `qed64-artifacts/lean4-wasm64/<id>/` | served, complete for every release | Only through a site's own Worker, under the site's origin. The bucket is private; never enable its `r2.dev` URL |
| a site's origin | served, mapped at `/runtime/*`, `/profiles/*` (but `/profiles/index.json`: the site's) | Yes |

The R2 prefix holds only immutable names (the release's own files; the mutable
per-site pointers — `profiles/index.json`, `snapshots/index.json`, the per-build
copies `snapshots/index.<buildId>.json` and `snapshots/profiles-index.<buildId>.json`,
the site's choice of runtime — stay in the site's prefix), so it is uploaded with
`rclone copy --immutable --s3-no-check-bucket --checksum`, never `sync`, digest-named objects first
and `release.json` last:

```bash
R2=qed64-r2:qed64-artifacts/lean4-wasm64/<id>/
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '- *.json' --filter '- SHA256SUMS' \
  --header-upload "Content-Type: application/octet-stream" --transfers 4 --s3-chunk-size 64M
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '- /release.json' --filter '+ *.json' \
  --filter '+ /SHA256SUMS' --filter '- *' --header-upload "Content-Type: application/json"
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '+ /release.json' --filter '- *' \
  --header-upload "Content-Type: application/json"
```

(rclone applies filter rules in order, first match wins: hence `--filter` rather
than mixed `--include`/`--exclude`. `--s3-no-check-bucket`: an object-scoped R2
token may not create buckets, and without it rclone tries to — a single-file
copy then fails with 403 AccessDenied on CreateBucket. `release.json` goes up
with `copy` and a filter, not `copyto`: `copyto` ignores `--immutable` and would
replace a different `release.json`. `wasm64-build/import-release.sh publish
<id>` runs these passes and verifies them.)

`SHA256SUMS` rides the JSON pass only for simplicity; tools read it, not
browsers. An object uploaded earlier with a wrong type keeps it — `--checksum`
skips equal bytes — and `--immutable` refuses to rewrite it: a release prefix
is uploaded right the first time.)

A release by reference (release.md) gets a complete prefix of its own. The files
it shares with its base are copied **server-side** from the base's prefix (same
remote: S3 CopyObject; without `-M` rclone keeps each object's metadata,
Content-Type included), then its own files go up by content type (objects, then
manifests), then `SHA256SUMS`, `release.json` last. `wasm64-build/import-release.sh
publish <id>` derives every list from the record (`isOwnPath`), runs these passes
and verifies them; a runtime release by reference is published only that way.
For a tools re-cut, whose only own file is its tgz, staging also prints the
passes as a manual fallback:

```bash
B=qed64-r2:qed64-artifacts/lean4-wasm64/<base>/
R2=qed64-r2:qed64-artifacts/lean4-wasm64/<base>-r<N>/
# <id>.r2-objects.txt / <id>.r2-manifests.txt (written by staging a tools re-cut): files[] outside tools/, by content type
rclone copy $B $R2 --files-from-raw <id>.r2-objects.txt --immutable --s3-no-check-bucket --checksum --transfers 8
rclone copy $B $R2 --files-from-raw <id>.r2-manifests.txt --immutable --s3-no-check-bucket --checksum
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '+ /tools/**' --filter '- *' \
  --header-upload "Content-Type: application/octet-stream"
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '+ /SHA256SUMS' --filter '- *' \
  --header-upload "Content-Type: application/json"
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '+ /release.json' --filter '- *' \
  --header-upload "Content-Type: application/json"
```

Never copy the base's `release.json`, `SHA256SUMS` or a file of the kind the
release owns (`tools/`; for a runtime release by reference also `runtime/` and
`profiles/lean-lib.*`): under `--immutable`, a copied base `release.json` would
block the release's own, and a base tgz, chunk or `lean-lib` part would be an
object its record does not list (the base's `runtime/runtime-manifest.json`
would even block its own). `publish` checks the copy against the staged clones
(MD5), not only against the base's prefix.

A site whose Worker serves one R2 prefix today needs a per-route prefix to
serve `/runtime/*` and `/profiles/*` from `lean4-wasm64/<id>/` while its
snapshots and its `profiles/index.json` stay in its own prefix.

## Snapshot indexes: the pinned copies

A site's snapshot index names the runtime its entries were baked for, and a
shell built for another runtime refuses them. So the index is pinned like the
runtime manifest: beside the mutable `/snapshots/index.json` the site serves
`/snapshots/index.<buildId>.json`, the same bytes, for every runtime a deployed
shell may be paired with (and, for a site that pins its profile index the same
way, `/snapshots/profiles-index.<buildId>.json`). `lean4-wasm64 bake` writes the
copy beside the `index.json` it upserts; a site that merges baked entries into
its served index publishes a copy derived from the merged index instead.

- **Reading.** A shell paired with build id B:
  1. reads the mutable `index.json` (revalidating: `cache: "no-cache"` in a
     browser) and checks it: the `schema`, a `snapshots` array, every entry
     well formed (`name` and `url` strings, `imports` an array, `runtime` a
     string when present, the page fields as snapshot-index.md defines them)
     and every `url` on the page's origin;
  2. only when B has the runtime/v1 shape `^wasm64-[0-9a-f]{16}$` (any other
     paired id is ignored, and then no copy is ever read) and an entry's
     `runtime` is a string other than B, reads the copy `index.<B>.json` from
     the same directory (the index URL's query and fragment dropped), with
     step 1's checks, and **uses it only if it has entries and every one names
     B**; a `404`, HTML, a network error, a malformed body, an empty copy or a
     copy naming any other runtime keeps the mutable index;
  3. loads only entries whose `runtime` is B (formats/README.md, pairing).

  Mutable first, not copy first: an index paired with the shell costs no
  second request, so a site that publishes no copies never logs a `404` for
  one (a failed resource load, which breaks console allowlists) while it stays
  paired. QED64 implements this as `loadSnapshotIndex(url, { pairedBuildId })`
  (`pairedCopyOr`).
- **Uploading, an invariant:** the copy for runtime R reaches the server before
  any mutable index that names R, and before a shell paired to R is deployed;
  the outgoing index's copy is pinned first if it is missing. The order
  `.snapz` files, copies, mutable indexes, deploy (QED64's) meets it and keeps
  every shell that reads the copies on its pairing. The stricter order
  `.snapz` files, copies, deploy, `index.json` last also keeps a deployed shell
  that reads only the mutable index (one older than the copies) clear of the
  window in which that index names a runtime it does not run — provided the
  newly deployed shell reads the copies.
- **Caching:** the copies revalidate like `index.json` (rule 8); a request for
  a copy that is not there yet is a `404` with `no-store` (rule 7), never a
  cached miss and never an HTML fallback.

## A minimal isolated static host

`python3 -m http.server` gets every content type right and sends none of the
isolation headers; it cannot boot the runtime. Twenty lines fix that (tested):

```python
import http.server, re, sys
IMMUTABLE = re.compile(r"(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})")
MUTABLE = re.compile(r"/runtime-manifest(\.[^/]*)?\.json$|/(?:profiles-)?index(\.[^/]*)?\.json$")
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript",
                      ".json": "application/json", ".snapz": "application/octet-stream"}
    def send_response(self, code, message=None):
        self._code = code; super().send_response(code, message)
    def end_headers(self):
        p = self.path.split("?", 1)[0]
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        imm = not MUTABLE.search(p) and IMMUTABLE.search(p)
        cc = "no-store" if getattr(self, "_code", 200) >= 400 else (
             "public, max-age=31536000, immutable" if imm else "public, max-age=0, must-revalidate")
        self.send_header("Cache-Control", cc); super().end_headers()
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8000), H).serve_forever()
```

Run it from the site's root: `runtime/` a symlink to the release's `runtime/`,
and `profiles/` a directory of the site's own holding its `index.json` beside
symlinks to the release's pack files (never a symlink to the release's
`profiles/` itself — the site's `index.json` must not land in the release dir,
where `verify` would refuse it). It has no Range support. nginx/Caddy equivalents: set
the three isolation headers with `always` (nginx repeats inherited `add_header`s
in every `location` that adds one), `gzip off` for octet-stream, `try_files $uri
=404`, and the cache rule above.

## Node (headless)

- **Node ≥ 24.** Memory64 and shared Memory64 need no flag there (measured on
  v26.3.0). The glue builds its memory with the final JS-API spelling
  `address: "i64"`; older engines need more than a flag.
- A browser runs the runtime's pthreads in Workers with a small engine stack (Chrome 500 KiB),
  and deep recursion is bounded by it (EMBED-RUNTIME.md §6). Node's are 4 MiB; to test at a
  browser's budget headlessly, `LEAN4_WASM64_PTHREAD_STACK_MB=0.68 lean4-wasm64 run …` (Chrome).
- The thread knobs (kernel patch 0038, EMBED-RUNTIME.md §3.6) reach a Node runtime through the
  environment of `run`, `probe` and `snapshot-probe`: `LEAN4_WASM64_PTHREAD_POOL=<n>` sizes the
  pool of pthread Workers created at load (0..64, default 24), and `LEAN_WASM_PARKED_DEDICATED`,
  `LEAN_WASM_PARKED_IDLE_MS`, `LEAN_WASM_STD_SURPLUS_EXIT`, `LEAN_WASM_STACK_PROBE_SLOTS` and
  `LEAN_WASM_SYMTAB_TRACE` (kernel patch 0039: native-symbol lookups on stderr) are copied into the
  runtime's own environment. `LEAN4_WASM64_RTSTATS=1 lean4-wasm64 run …` answers a printed
  `[rtstats?]` with `[rtstats] <json>` (pool, task manager, engine guard).
- **`node --stack-size=8192`** for anything that boots the runtime in its own
  process (`node-runner`, `persistent-probe`, `gate`; `lean4-wasm64 run|gate|probe`
  add it, and `node-runner` / `persistent-probe` started without it re-exec
  themselves with it, same PID — under a `fork()` IPC channel they print one
  WARNING instead).
- **`bin/package.json` = `{ "type": "commonjs" }`** beside `lean.js`. The glue is
  CommonJS and every pthread re-loads `lean.js` as a Worker script; under a
  `"type": "module"` package.json (this package's own, if a runtime lands inside
  `node_modules/lean4-wasm64/`) each pthread dies with `require is not defined`.
  `lean4-wasm64 fetch --only runtime` writes it.
- The artifact layout `node-runner` expects: `--artifact <dir>` with
  `bin/lean.js`, `bin/lean.wasm` and `lib/lean` (or `--lib <dir>`). Lean's cwd
  is the VFS root `/` and the work dir is `/work`: name files `/work/<file>`
  (`/work/x.lean` is module `work.x`, as under QED64's runner; a snapshot baked
  through either runner is byte-identical). `LEAN4_WASM64_CWD=work` makes the
  work dir the cwd instead (relative paths land there; bakes then differ in the
  main module name).
- The one-shot CLI does not exit on its own (patches 0020/0031): judge a job by
  its output and reap the process, as `gate.mjs` does.
- Browsers, for completeness: desktop Chrome/Edge 133+ or Firefox 134+; Safari
  has no Memory64. A tab with Mathlib loaded needs about 8–9 GB.
