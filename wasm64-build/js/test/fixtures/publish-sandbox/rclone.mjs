// A FAKE rclone for test/publish-sandbox.test.mjs (run through a wrapper the test writes, first on
// PATH): the remote "fake-r2:" is the directory $FAKE_STATE/r2, with each object's metadata (content
// type; whether R2 holds an MD5 for it, which a multipart upload does not) in $FAKE_STATE/r2meta.json.
// The subset publish-release.mjs uses: version, listremotes, lsjson, cat, copy (a remote → remote
// copy is server-side and keeps the metadata), check, hashsum. It refuses any other remote. Every
// call is appended to $FAKE_STATE/calls.log, every object written to $FAKE_STATE/events.log.
//   FAKE_R2_NO_MD5=<basename,…>         an upload of these stores no MD5
//   FAKE_RCLONE_CORRUPT_COPY=<path>     a server-side copy of that release path writes other bytes (same size)
//   FAKE_RCLONE_CHECK_EXIT=<n>          `check` gives no answer: no report, exit <n>
//   FAKE_RCLONE_CHECK_NO_COMBINED=1     `check` writes its log but no --combined report
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ST = process.env.FAKE_STATE;
if (!ST) { console.error("fake rclone: FAKE_STATE unset"); process.exit(99); }
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(ST, "calls.log"), `rclone ${JSON.stringify(argv)}\n`);
const ROOT = path.join(ST, "r2");
const metaFile = path.join(ST, "r2meta.json");
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
const saveMeta = () => fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
const die = (m, c = 1) => { console.error(m); process.exit(c); };
const hash = (alg, b) => createHash(alg).update(b).digest("hex");
const ev = (m) => fs.appendFileSync(path.join(ST, "events.log"), `R2 ${m}\n`);
const isRemote = (p) => p.startsWith("fake-r2:");
const remote = (p) => (isRemote(p) ? path.join(ROOT, p.slice("fake-r2:".length)) : die(`fake rclone: refusing a remote outside the sandbox: ${p}`, 98));
const keyOf = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const noMd5 = new Set((process.env.FAKE_R2_NO_MD5 ?? "").split(",").filter(Boolean));
function walk(d, base = d, out = []) {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}
/** rclone filter rules, as far as publish uses them: "/x" anchored, "*" within a segment, "**" across. */
function ruleMatch(pat, rel) {
  const anchored = pat.startsWith("/");
  const re = new RegExp(`^${(anchored ? pat.slice(1) : pat).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
  if (anchored) return re.test(rel);
  const segs = rel.split("/");
  return segs.some((_, i) => re.test(segs.slice(i).join("/")));
}
const included = (filters, rel) => { for (const f of filters) if (ruleMatch(f.slice(2), rel)) return f[0] === "+"; return true; };

const o = { filters: [], header: null, filesFrom: null, combined: null, logFile: null, flags: new Set(), pos: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--filter") o.filters.push(argv[++i]);
  else if (a === "--header-upload") { const m = /^Content-Type:\s*(.*)$/i.exec(argv[++i]); if (m) o.header = m[1]; }
  else if (a === "--files-from-raw") o.filesFrom = fs.readFileSync(argv[++i], "utf8").split("\n").filter(Boolean);
  else if (a === "--combined") o.combined = argv[++i];
  else if (a === "--log-file") o.logFile = argv[++i];
  else if (["--transfers", "--s3-chunk-size", "--checkers"].includes(a)) i++;
  else if (a.startsWith("-")) o.flags.add(a);
  else o.pos.push(a);
}
const cmd = argv[0];
if (cmd === "version") { console.log("rclone v0.0.0-fake"); process.exit(0); }
if (cmd === "listremotes") { console.log("fake-r2:"); process.exit(0); }
if (cmd === "lsjson") {
  const dir = remote(o.pos[0]);
  if (!fs.existsSync(dir)) die("ERROR : : error listing: directory not found", 3);
  console.log(JSON.stringify(walk(dir).map((rel) => ({ Path: rel, Name: path.posix.basename(rel), Size: fs.statSync(path.join(dir, rel)).size,
    MimeType: meta[keyOf(path.join(dir, rel))]?.type ?? "application/octet-stream", IsDir: false }))));
  process.exit(0);
}
if (cmd === "cat") {
  const f = remote(o.pos[0]);
  if (!fs.existsSync(f)) die("ERROR : : error listing: directory not found", 3);
  process.stdout.write(fs.readFileSync(f)); process.exit(0);
}
if (cmd === "copy") {
  const [src, dst] = o.pos;
  const serverSide = isRemote(src) && isRemote(dst);
  const srcRoot = isRemote(src) ? remote(src) : src;
  let errors = 0;
  for (const rel of o.filesFrom ?? walk(srcRoot).filter((r) => included(o.filters, r))) {
    const s = path.join(srcRoot, rel), d = path.join(remote(dst), rel);
    if (!fs.existsSync(s)) { console.error(`ERROR : ${rel}: file not found in source`); errors++; continue; }
    let b = fs.readFileSync(s);
    if (fs.existsSync(d)) {
      const cur = fs.readFileSync(d);
      if (cur.length === b.length && (!o.flags.has("--checksum") || hash("md5", cur) === hash("md5", b))) continue;
      if (o.flags.has("--immutable")) { console.error(`ERROR : ${rel}: Source and destination exist but do not match: immutable file modified`); errors++; continue; }
    }
    if (serverSide && rel === process.env.FAKE_RCLONE_CORRUPT_COPY) { b = Buffer.from(b); b[0] ^= 0xff; }
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, b);
    meta[keyOf(d)] = serverSide ? { ...(meta[keyOf(s)] ?? { type: "application/octet-stream", md5: true }) }
      : { type: o.header ?? "application/octet-stream", md5: !noMd5.has(path.basename(rel)) };
    saveMeta();
    ev(`${serverSide ? "COPY" : "PUT"} ${keyOf(d)} (${meta[keyOf(d)].type}${meta[keyOf(d)].md5 ? "" : ", no md5"})`);
  }
  process.exit(errors ? 1 : 0);
}
if (cmd === "check") {
  const [src, dst] = o.pos;
  if (isRemote(src) || !isRemote(dst)) die("fake rclone: check <local dir> <remote> only", 98);
  if (process.env.FAKE_RCLONE_CHECK_EXIT) die("ERROR : fake: the check could not run", Number(process.env.FAKE_RCLONE_CHECK_EXIT));
  const dstRoot = remote(dst);
  const log = [`2026/10/08 20:00:00 DEBUG : rclone: Version "v0.0.0-fake" starting with parameters ${JSON.stringify(["rclone", ...argv])}`];
  const lines = [];
  let differ = 0, missing = 0, noHash = 0, match = 0;
  for (const rel of o.filesFrom ?? walk(src)) {
    const s = path.join(src, rel), d = path.join(dstRoot, rel);
    if (!fs.existsSync(s)) { lines.push(`- ${rel}`); continue; }
    if (!fs.existsSync(d)) { lines.push(`+ ${rel}`); missing++; log.push(`2026/10/08 20:00:01 ERROR : ${rel}: file not in S3 bucket`); continue; }
    const x = fs.readFileSync(s), y = fs.readFileSync(d);
    if (x.length !== y.length) { lines.push(`* ${rel}`); differ++; log.push(`2026/10/08 20:00:01 ERROR : ${rel}: sizes differ`); continue; }
    if (meta[keyOf(d)]?.md5 === false) { lines.push(`= ${rel}`); match++; noHash++; log.push(`2026/10/08 20:00:01 DEBUG : ${rel}: OK - could not check hash`); continue; }
    if (hash("md5", x) !== hash("md5", y)) { lines.push(`* ${rel}`); differ++; log.push(`2026/10/08 20:00:01 ERROR : ${rel}: md5 differ`); continue; }
    lines.push(`= ${rel}`); match++; log.push(`2026/10/08 20:00:01 DEBUG : ${rel}: OK`);
  }
  const name = `S3 bucket ${dst.slice("fake-r2:".length)}`;
  if (missing) log.push(`2026/10/08 20:00:02 NOTICE: ${name}: ${missing} files missing`);
  log.push(`2026/10/08 20:00:02 NOTICE: ${name}: ${differ + missing} differences found`);
  if (noHash) log.push(`2026/10/08 20:00:02 NOTICE: ${name}: ${noHash} hashes could not be checked`);
  if (match) log.push(`2026/10/08 20:00:02 NOTICE: ${name}: ${match} matching files`);
  if (o.combined && !process.env.FAKE_RCLONE_CHECK_NO_COMBINED) fs.writeFileSync(o.combined, lines.map((l) => `${l}\n`).join(""));
  const text = `${log.filter((l) => o.flags.has("-vv") || !/ DEBUG : /.test(l)).join("\n")}\n`;
  if (o.logFile) fs.appendFileSync(o.logFile, text); else process.stderr.write(text);
  process.exit(differ + missing ? 1 : 0);
}
if (cmd === "hashsum") {
  const dir = remote(o.pos.at(-1));
  const rels = o.filesFrom ?? walk(dir);
  for (const rel of rels) { const f = path.join(dir, rel); if (fs.existsSync(f)) console.log(`${hash("sha256", fs.readFileSync(f))}  ${rel}`); }
  ev(`READ hashsum --download ${rels.length} objects of ${keyOf(dir)}`);
  process.exit(0);
}
die(`fake rclone: unsupported ${JSON.stringify(argv)}`, 97);
