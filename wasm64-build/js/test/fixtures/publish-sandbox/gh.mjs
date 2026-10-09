// A FAKE gh for test/publish-sandbox.test.mjs (run through a wrapper the test writes, first on PATH):
// the GitHub releases of ONE sandbox repository, from $FAKE_STATE/gh.json (asset bytes in
// $FAKE_STATE/assets/<id>); its tags are the origin of the fake git ($FAKE_STATE/git.json). It
// refuses any other repository and never touches the network. Every call is appended to
// $FAKE_STATE/calls.log, every change to $FAKE_STATE/events.log.
//   FAKE_GH_NO_DIGEST=<name,…>   GitHub reports no digest for these assets ("*": for every one)
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ST = process.env.FAKE_STATE;
if (!ST) { console.error("fake gh: FAKE_STATE unset"); process.exit(99); }
const SLUG = "sandbox-owner/sandbox-repo";
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(ST, "calls.log"), `gh ${JSON.stringify(argv)}\n`);
const stateFile = path.join(ST, "gh.json");
const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 1));
const die = (m, c = 1) => { console.error(m); process.exit(c); };
const ev = (m) => fs.appendFileSync(path.join(ST, "events.log"), `GH ${m}\n`);
const originTag = (t) => JSON.parse(fs.readFileSync(path.join(ST, "git.json"), "utf8")).origin[`refs/tags/${t}`] ?? null;
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const byTag = (s, tag) => s.releases.find((r) => r.tag_name === tag && !r.draft) ?? s.releases.find((r) => r.tag_name === tag) ?? null;
const noDigest = new Set((process.env.FAKE_GH_NO_DIGEST ?? "").split(",").filter(Boolean));
const shown = (a) => ({ id: a.id, name: a.name, size: a.size, state: a.state, digest: noDigest.has(a.name) || noDigest.has("*") ? null : a.digest });
/** `gh api --paginate --slurp`: an array of pages (two here, so the caller must flatten them). */
const pages = (list) => JSON.stringify([list.slice(0, 2), list.slice(2)]);

if (argv[0] === "--version") { console.log("gh version 0.0.0-fake"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") { console.log("github.com\n  ✓ Logged in to github.com account sandbox (fake)"); process.exit(0); }
if (argv[0] === "api") {
  let method = "GET";
  const rest = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "-X") method = argv[++i];
    else if (argv[i] === "--jq") i++;
    else if (!["--paginate", "--slurp"].includes(argv[i])) rest.push(argv[i]);
  }
  const ep = rest[0] ?? "";
  if (ep === `repos/${SLUG}` && method === "GET") { console.log("true"); process.exit(0); } // --jq .permissions.push
  if (!ep.startsWith(`repos/${SLUG}/`)) die(`fake gh: refusing an endpoint outside the sandbox: ${ep}`, 98);
  const sub = ep.slice(`repos/${SLUG}/`.length).replace(/\?.*$/, "");
  let m;
  if (method === "GET" && (m = /^git\/ref\/tags\/(.+)$/.exec(sub))) { // --jq .object.sha
    const t = originTag(m[1]);
    if (!t) die("gh: Not Found (HTTP 404)");
    console.log(t); process.exit(0);
  }
  const s = load();
  if (method === "GET" && sub === "releases") {
    console.log(pages(s.releases.map((r) => ({ id: r.id, tag_name: r.tag_name, draft: r.draft, name: r.name, assets: r.assets.map(shown) }))));
    process.exit(0);
  }
  if (method === "GET" && (m = /^releases\/(\d+)\/assets$/.exec(sub))) {
    const r = s.releases.find((x) => x.id === Number(m[1]));
    if (!r) die("gh: Not Found (HTTP 404)");
    console.log(pages(r.assets.map(shown))); process.exit(0);
  }
  if (method === "DELETE" && (m = /^releases\/assets\/(\d+)$/.exec(sub))) {
    for (const r of s.releases) {
      const k = r.assets.findIndex((x) => x.id === Number(m[1]));
      if (k < 0) continue;
      if (!r.draft) die("fake gh: deleting an asset of a PUBLISHED release", 97);
      ev(`DELETE asset ${r.assets[k].name} of draft ${r.id}`);
      r.assets.splice(k, 1); save(s); process.exit(0);
    }
    die("gh: Not Found (HTTP 404)");
  }
  die(`fake gh: unsupported api ${method} ${ep}`, 97);
}
if (argv[0] === "release") {
  if (opt("--repo") !== SLUG) die(`fake gh: refusing repository ${opt("--repo")}`, 98);
  const tag = argv[2];
  const s = load();
  if (argv[1] === "create") {
    if (argv.includes("--verify-tag") && !originTag(tag)) die(`tag ${tag} doesn't exist in the repo, aborting due to --verify-tag flag`);
    const r = { id: s.nextId++, tag_name: tag, draft: argv.includes("--draft"), name: opt("--title"), body: fs.readFileSync(opt("--notes-file"), "utf8"), assets: [] };
    s.releases.push(r); save(s);
    ev(`CREATE release ${r.id} (${tag})${r.draft ? " draft" : ""}`); process.exit(0);
  }
  if (argv[1] === "upload") {
    const r = byTag(s, tag);
    if (!r) die("release not found");
    const files = [];
    for (let k = 3; k < argv.length; k++) { if (argv[k] === "--repo") k++; else if (!argv[k].startsWith("--")) files.push(argv[k]); }
    for (const f of files) {
      if (r.assets.some((x) => x.name === path.basename(f))) die(`asset under the same name already exists: [${path.basename(f)}]`);
      const b = fs.readFileSync(f), id = s.nextId++;
      fs.mkdirSync(path.join(ST, "assets"), { recursive: true });
      fs.writeFileSync(path.join(ST, "assets", String(id)), b);
      r.assets.push({ id, name: path.basename(f), size: b.length, state: "uploaded", digest: `sha256:${createHash("sha256").update(b).digest("hex")}` });
      save(s);
      ev(`UPLOAD ${path.basename(f)} to ${r.draft ? "draft" : "PUBLISHED"} ${r.id} (${tag})`);
    }
    process.exit(0);
  }
  if (argv[1] === "edit") {
    const r = byTag(s, tag);
    if (!r) die("release not found");
    if (argv.includes("--draft=false")) {
      if (!originTag(tag)) die("fake gh: publishing a release whose tag GitHub does not have", 97);
      r.draft = false; ev(`PUBLISH release ${r.id} (${tag}), ${r.assets.length} assets`);
    }
    save(s); process.exit(0);
  }
  if (argv[1] === "download") {
    const r = byTag(s, tag);
    if (!r) die("release not found");
    const x = r.assets.find((y) => y.name === opt("--pattern"));
    if (!x) die("no assets match the file pattern");
    fs.copyFileSync(path.join(ST, "assets", String(x.id)), opt("--output"));
    fs.appendFileSync(path.join(ST, "events.log"), `GH READ download ${x.name} of ${tag}\n`);
    process.exit(0);
  }
}
die(`fake gh: unsupported ${JSON.stringify(argv)}`, 97);
