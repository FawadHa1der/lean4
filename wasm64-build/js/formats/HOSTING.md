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
   and `/snapshots/*`. So a Worker routes `/profiles/index.json` to the site's
   prefix and the rest of `/profiles/*` and `/runtime/*` to the release (or tries
   the site first and falls back to the release).
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
     if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/index\.json$/.test(pathname)) return false;
     return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname);
   }
   ```

   Digest-named files are immutable; every `runtime-manifest*.json` — the
   per-build one too, because the build id covers `lean.wasm` only and a relink
   that changes `lean.js` keeps the name — and every `index.json` revalidate;
   everything else revalidates. The regex matches 16+ hex digits **anywhere in
   the path**: never put a build id or a full digest in a directory name above a
   manifest (a release prefix `lean4-wasm64/lean-v4.34.0-a8817d0/` carries only
   7, which is why release ids use 7).
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
release.

## Where a release lives

| Copy | Layout | Reachable by browsers? |
|---|---|---|
| GitHub Release `lean-<tag>-<kernel7>` on `FawadHa1der/lean4` | flat, by basename | No (other origin, no isolation headers). It is the public download for tools and CI: `lean4-wasm64 fetch --from https://github.com/FawadHa1der/lean4/releases/download/<id>/` |
| R2 `qed64-artifacts/lean4-wasm64/<id>/` | served | Only through a site's own Worker, under the site's origin. The bucket is private; never enable its `r2.dev` URL |
| a site's origin | served, mapped at `/runtime/*`, `/profiles/*` (but `/profiles/index.json`: the site's) | Yes |

The R2 prefix holds only immutable names (the release's own files; the mutable
per-site pointers — `profiles/index.json`, `snapshots/index.json`, the site's
choice of runtime — stay in the site's prefix), so it is uploaded with
`rclone copy --immutable --s3-no-check-bucket --checksum`, never `sync`, digest-named objects first
and `release.json` last:

```bash
R2=qed64-r2:qed64-artifacts/lean4-wasm64/<id>/
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '- *.json' --filter '- SHA256SUMS' \
  --header-upload "Content-Type: application/octet-stream" --transfers 4 --s3-chunk-size 64M
rclone copy <release dir> $R2 --immutable --s3-no-check-bucket --checksum --filter '- /release.json' --filter '+ *.json' \
  --filter '+ /SHA256SUMS' --filter '- *' --header-upload "Content-Type: application/json"
rclone copyto <release dir>/release.json ${R2}release.json --immutable --s3-no-check-bucket --header-upload "Content-Type: application/json"
```

(rclone applies filter rules in order, first match wins: hence `--filter` rather
than mixed `--include`/`--exclude`. `--s3-no-check-bucket`: an object-scoped R2
token may not create buckets, and without it rclone tries to — a single-file
`copyto` then fails with 403 AccessDenied on CreateBucket.

`SHA256SUMS` rides the JSON pass only for simplicity; tools read it, not
browsers. An object uploaded earlier with a wrong type keeps it — `--checksum`
skips equal bytes — and `--immutable` refuses to rewrite it: a release prefix
is uploaded right the first time.)

A site whose Worker serves one R2 prefix today needs a per-route prefix to
serve `/runtime/*` and `/profiles/*` from `lean4-wasm64/<id>/` while its
snapshots and its `profiles/index.json` stay in its own prefix.

## A minimal isolated static host

`python3 -m http.server` gets every content type right and sends none of the
isolation headers; it cannot boot the runtime. Twenty lines fix that (tested):

```python
import http.server, re, sys
IMMUTABLE = re.compile(r"(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})")
MUTABLE = re.compile(r"/runtime-manifest(\.[^/]*)?\.json$|/index\.json$")
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
