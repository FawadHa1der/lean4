// A FAKE git for test/publish-sandbox.test.mjs (run through a wrapper the test writes, first on
// PATH). The repository and its origin are a JSON model in $FAKE_STATE/git.json, never a real
// repository: it answers the read commands publish-release.mjs makes (rev-parse, ls-remote, show,
// merge-base, log, diff, …) and REFUSES every write (add, commit, tag, push, a fetch into a ref), so the
// test can assert from the call log that none was attempted. Every call is appended to
// $FAKE_STATE/calls.log. `-C <dir>` must be $FAKE_REPO, the sandbox's copy of the repository.
//
// git.json: { head: "refs/heads/<line>" | null,
//             commits: [{ sha, subject, adds: { <path>: <text> } }]   (a linear history, oldest first),
//             refs:   { <refname>: <sha> },   origin: { <refname>: <sha> },
//             tags:   { <tag object sha>: <commit sha> } }
import fs from "node:fs";
import path from "node:path";

const ST = process.env.FAKE_STATE;
if (!ST) { console.error("fake git: FAKE_STATE unset"); process.exit(99); }
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(ST, "calls.log"), `git ${JSON.stringify(argv)}\n`);
const die = (m, c = 128) => { console.error(m); process.exit(c); };

if (argv[0] === "--version") { console.log("git version 0.0.0-fake"); process.exit(0); }
let args = argv;
if (args[0] === "-C") {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  if (!real(args[1]) || real(args[1]) !== real(process.env.FAKE_REPO ?? "")) die(`fake git: refusing -C ${args[1]} (the sandbox repository is ${process.env.FAKE_REPO})`, 98);
  args = args.slice(2);
}
const file = path.join(ST, "git.json");
const S = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(S, null, 1));
const at = new Map(S.commits.map((c, i) => [c.sha, i]));
const [cmd, ...a] = args;

const refValue = (name) => {
  if (name === "HEAD") return S.head ? S.refs[S.head] ?? null : null;
  for (const r of [name, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`]) if (S.refs[r]) return S.refs[r];
  return at.has(name) || S.tags[name] ? name : null;
};
const peel = (sha) => S.tags[sha] ?? sha;
/** A revision → the object it names (a tag object unless ^{commit} / ^{} peels it); null if unknown. */
const resolve = (rev) => {
  const m = /^(.*)\^\{(?:commit)?\}$/.exec(rev);
  const v = refValue(m ? m[1] : rev);
  return v && m ? peel(v) : v;
};
const commitOf = (rev) => { const v = resolve(rev); const c = v && peel(v); return c && at.has(c) ? c : null; };
const short = (sha) => sha.slice(0, 7);
/** Whether path `p` is named by pathspec `s` (the path itself, or a directory above it). */
const under = (p, s) => p === s || p.startsWith(`${s}/`);
/** The newest commit at or before `tip` that adds `p` (the history is linear). */
const adder = (tip, p) => { for (let i = at.get(tip); i >= 0; i--) if (S.commits[i].adds?.[p] !== undefined) return S.commits[i]; return null; };

const WRITES = ["add", "commit", "tag", "push", "update-ref", "reset", "checkout", "switch", "merge", "rebase", "rm", "mv", "restore", "stash", "worktree", "gc"];
if (WRITES.includes(cmd) || (cmd === "fetch" && a.some((x) => x.includes(":")))) {
  fs.appendFileSync(path.join(ST, "events.log"), `GIT WRITE ${args.join(" ")}\n`);
  die(`fake git: refusing ${cmd} — the sandbox never writes a repository`, 1);
}

if (cmd === "rev-parse") {
  if (a[0] === "--is-shallow-repository") { console.log("false"); process.exit(0); }
  const quiet = a.includes("-q");
  const rev = a.filter((x) => !x.startsWith("-"))[0];
  const v = rev && resolve(rev);
  if (!v) { if (quiet) process.exit(1); die(`fatal: ambiguous argument '${rev}': unknown revision`); }
  console.log(v); process.exit(0);
}
if (cmd === "symbolic-ref") { if (!S.head) process.exit(1); console.log(S.head); process.exit(0); }
if (cmd === "cat-file" && a[0] === "-e") process.exit(commitOf(a[1]) || resolve(a[1]) ? 0 : 1);
if (cmd === "merge-base" && a[0] === "--is-ancestor") {
  const [x, y] = [commitOf(a[1]), commitOf(a[2])];
  if (!x || !y) die(`fatal: Not a valid commit name ${x ? a[2] : a[1]}`);
  process.exit(at.get(x) <= at.get(y) ? 0 : 1);
}
if (cmd === "show") {
  const spec = a[0], i = spec.indexOf(":");
  const rev = spec.slice(0, i), p = spec.slice(i + 1);
  if (rev === "") die(`fatal: path '${p}' does not exist in the index`); // nothing is ever staged
  const c = commitOf(rev);
  if (!c) die(`fatal: invalid object name '${rev}'.`);
  const hit = adder(c, p);
  if (!hit) die(`fatal: path '${p}' does not exist in '${rev}'`);
  process.stdout.write(hit.adds[p]); process.exit(0);
}
if (cmd === "ls-remote" && a[0] === "origin") {
  for (const q of a.slice(1)) {
    const peeled = q.endsWith("^{}"), ref = peeled ? q.slice(0, -3) : q;
    const v = S.origin[ref];
    if (v && !peeled) console.log(`${v}\t${ref}`);
    if (v && peeled && S.tags[v]) console.log(`${S.tags[v]}\t${q}`);
  }
  process.exit(0);
}
if (cmd === "fetch") {
  // a branch from origin updates its remote-tracking ref; a tag or a sha only FETCH_HEAD (nothing here)
  const what = a.filter((x) => !x.startsWith("-"));
  if (what[0] !== "origin") die(`fake git: fetch from ${what[0]}`, 97);
  for (const r of what.slice(1)) if (S.origin[`refs/heads/${r}`]) S.refs[`refs/remotes/origin/${r}`] = S.origin[`refs/heads/${r}`];
  save(); process.exit(0);
}
if (cmd === "log") {
  const one = a.includes("-1"), oneline = a.includes("--oneline");
  const format = a.find((x) => x.startsWith("--format="))?.slice("--format=".length) ?? null;
  const dd = a.indexOf("--");
  const revs = (dd >= 0 ? a.slice(0, dd) : a).filter((x) => !x.startsWith("-"));
  const p = dd >= 0 ? a[dd + 1] : null;
  let from = -1, to;
  if (revs[0]?.includes("..")) { const [x, y] = revs[0].split(".."); from = at.get(commitOf(x)); to = at.get(commitOf(y)); }
  else { const c = commitOf(revs[0] ?? "HEAD"); if (!c) die(`fatal: bad revision '${revs[0]}'`); to = at.get(c); }
  let list = S.commits.slice(from + 1, to + 1).reverse();
  if (p) list = list.filter((c) => Object.keys(c.adds ?? {}).some((q) => under(q, p)));
  if (one) list = list.slice(0, 1);
  const fmt = (c) => (oneline ? `${short(c.sha)} ${c.subject}` : (format ?? "%H").replace("%H", c.sha).replace("%h", short(c.sha)).replace("%s", c.subject));
  for (const c of list) console.log(fmt(c));
  process.exit(0);
}
if (cmd === "diff") {
  // diff <older> <newer> [-- <pathspec>…]: the paths the commits after <older> up to <newer> add
  // (a linear history: an add is a change), --name-only or --quiet
  const dd = a.indexOf("--");
  const revs = (dd >= 0 ? a.slice(0, dd) : a).filter((x) => !x.startsWith("-"));
  const specs = dd >= 0 ? a.slice(dd + 1) : [];
  const [x, y] = revs.map(commitOf);
  if (!x || !y) die(`fatal: bad revision '${x ? revs[1] : revs[0]}'`);
  if (at.get(x) > at.get(y)) die("fake git: diff from a newer commit to an older one is not modeled", 97);
  const changed = [...new Set(S.commits.slice(at.get(x) + 1, at.get(y) + 1).flatMap((c) => Object.keys(c.adds ?? {})))]
    .filter((q) => !specs.length || specs.some((sp) => under(q, sp))).sort();
  if (a.includes("--name-only")) for (const q of changed) console.log(q);
  process.exit(a.includes("--quiet") && changed.length ? 1 : 0);
}
if (cmd === "branch" && a.includes("--contains")) {
  const c = commitOf(a[a.indexOf("--contains") + 1]);
  for (const [r, v] of Object.entries(S.refs)) if (r.startsWith("refs/heads/") && c && at.get(peel(v)) >= at.get(c)) console.log(r.slice("refs/heads/".length));
  process.exit(0);
}
die(`fake git: unsupported ${JSON.stringify(args)}`, 97);
