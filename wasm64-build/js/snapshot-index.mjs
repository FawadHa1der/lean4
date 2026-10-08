// The snapshot index a bake upserts into (formats/snapshot-index.md is the
// specification; this is the writer's implementation): <out>/index.json and its
// per-build copy <out>/index.<buildId>.json, the same bytes.
//
//   schema      "qed64.snapshot-index/v1" (a wire name: it never changes with the project's name)
//   entry       name, url, digest, bytes, transfer, imports, runtime   (the core keys, in this order)
//               then roots, label, initialBytes when the bake was given them (--roots, --label,
//               --initial-bytes), then --entry-fields' keys in object order. raw, lib and bakedBy
//               are reserved for this package.
//   pairing     one runtime per index: an entry of another name that names another runtime
//               (foreign) or none (unpaired) refuses the bake
//   bytes       JSON.stringify(index, null, 2), no trailing newline; unknown top-level keys are kept;
//               entries in upsert order (a rebake moves its entry to the end)
//   writer      under <out>/index.json.lock (an exclusive create holding `<pid>\n`, as QED64's bake
//               writes it; never taken over): re-read (only ENOENT is a new index), re-check schema
//               and pairing, write both temps, rename the COPY first and index.json last (index.json
//               is the commit record)
//
// The pure parts (importsOf, the validators, pairingProblem, upsertEntry, snapshotEntry,
// indexText) need no I/O; readIndex, the locks and upsertIndex take an optional `io` (node:fs by
// default) so a test can fail one rename. Types: snapshot-index.d.mts.
//
// Ported from QED64 (MIT, same author) pipeline/snapshot/bake-snapshot.mjs at 76d5447 (fix/pinned-indexes); relicensed Apache-2.0 by the author.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const SNAPSHOT_INDEX_SCHEMA = "qed64.snapshot-index/v1";
/** The core entry keys, in the order every entry carries them. */
export const CORE_KEYS = Object.freeze(["name", "url", "digest", "bytes", "transfer", "imports", "runtime"]);
/** The page fields the bake writes only through its validating flags (--roots, --label, --initial-bytes), in this order. */
export const ALIAS_KEYS = Object.freeze(["roots", "label", "initialBytes"]);
/** Entry keys this package reserves (formats/snapshot-index.md); --entry-fields refuses them. */
export const RESERVED_KEYS = Object.freeze(["raw", "lib", "bakedBy"]);
/** A snapshot name: it is joined into <work>/<name>.snap, <name>.<digest16>.snapz and the entry. */
export const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** One module root of --roots (QED64's rule). */
export const MODULE_ROOT = /^[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*$/;

/** A refusal of the index (unreadable, corrupt, another schema, foreign or unpaired entries). */
export class SnapshotIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotIndexError";
  }
}

export const emptyIndex = () => ({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [] });

// ---------- pure ----------

// ---------- the probe's header ----------
//
// The entry's `imports` are the modules of the probe's header, read with Lean's own lexical rules
// (src/Lean/Parser/Module/Syntax.lean `header`, src/Lean/Parser/Basic.lean `whitespace`,
// `finishCommentBlock`, `identFnAux`; src/Init/Meta/Defs.lean for the identifier characters and
// Name.toString's escaping). A header Lean would not read as written is refused, never guessed at.

const HEADER_KEYWORDS = new Set(["module", "prelude", "public", "meta", "import", "all"]);
const isLetterLike = (c) =>
  (c >= 0x3b1 && c <= 0x3c9 && c !== 0x3bb) || (c >= 0x391 && c <= 0x3a9 && c !== 0x3a0 && c !== 0x3a3) ||
  (c >= 0x3ca && c <= 0x3fb) || (c >= 0x1f00 && c <= 0x1ffe) || (c >= 0x2100 && c <= 0x214f) ||
  (c >= 0x1d49c && c <= 0x1d59f) || (c >= 0xc0 && c <= 0xff && c !== 0xd7 && c !== 0xf7) || (c >= 0x100 && c <= 0x17f);
const isSubScriptAlnum = (c) => (c >= 0x2080 && c <= 0x2089) || (c >= 0x2090 && c <= 0x209c) || (c >= 0x1d62 && c <= 0x1d6a) || c === 0x2c7c;
const isIdFirst = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || isLetterLike(c);
const isIdRest = (c) => isIdFirst(c) || (c >= 0x30 && c <= 0x39) || c === 0x27 || c === 0x21 || c === 0x3f || isSubScriptAlnum(c);
const cpAt = (s, i) => (i < s.length ? s.codePointAt(i) : undefined);
const cpLen = (c) => (c > 0xffff ? 2 : 1);

/** Name.toString's spelling of one component: bare when it is an identifier part, else «escaped». */
function namePart(part) {
  let ok = part.length > 0 && isIdFirst(cpAt(part, 0));
  for (let i = ok ? cpLen(cpAt(part, 0)) : part.length; ok && i < part.length; i += cpLen(cpAt(part, i))) ok = isIdRest(cpAt(part, i));
  return ok ? part : `«${part}»`;
}

/** The identifier at `i` (identFnAux): { parts, end }, null when none starts there, or { problem, at }. */
function lexIdent(s, i) {
  const parts = [];
  for (;;) {
    const c = cpAt(s, i);
    if (c === 0xab) { // «escaped part», up to the next »
      const close = s.indexOf("»", i + 1);
      if (close < 0) return { problem: "an unterminated «", at: i };
      parts.push(s.slice(i + 1, close));
      i = close + 1;
    } else if (c !== undefined && isIdFirst(c)) {
      let j = i + cpLen(c);
      for (let d = cpAt(s, j); d !== undefined && isIdRest(d); d = cpAt(s, j)) j += cpLen(d);
      parts.push(s.slice(i, j));
      i = j;
    } else {
      return null; // only at the start: a '.' continues an identifier only before a part
    }
    const next = cpAt(s, i + 1);
    if (s[i] !== "." || next === undefined || !(isIdFirst(next) || next === 0xab)) return { parts, end: i };
    i += 1;
  }
}

/**
 * The end of the whitespace and comments at `i` (Lean's `whitespace`): { end } or { problem, at }.
 * Whitespace is ' ' and '\n' (CRLF is read as '\n'); a tab or a lone '\r' is Lean's error. `--`
 * runs to the end of the line; `/-X…-/` (X neither '-' nor '!', which make doc comments: tokens)
 * nests, X itself never opening or closing one.
 */
function trivia(s, i) {
  for (;;) {
    const ch = s[i];
    if (ch === " " || ch === "\n") i += 1;
    else if (ch === "\t") return { problem: "a tab", at: i };
    else if (ch === "\r") return { problem: "a lone carriage return", at: i };
    else if (ch === "-" && s[i + 1] === "-") { const nl = s.indexOf("\n", i); i = nl < 0 ? s.length : nl; }
    else if (ch === "/" && s[i + 1] === "-" && s[i + 2] !== "-" && s[i + 2] !== "!") {
      const open = i;
      let depth = 1;
      for (i = Math.min(i + 3, s.length); depth > 0;) {
        if (i >= s.length) return { problem: "an unterminated comment", at: open };
        if (s[i] === "-" && s[i + 1] === "/") { depth -= 1; i += 2; }
        else if (s[i] === "/" && s[i + 1] === "-") { depth += 1; i += 2; }
        else i += 1;
      }
    } else return { end: i };
  }
}

/**
 * The probe's header: { imports, problem }. `imports` are its modules in source order, each
 * spelled with its parts joined by '.', a part «escaped» only when it is not an identifier part
 * (Name.toString's spelling of an ordinary name): optional `module`, optional `prelude`, then
 * imports, each optional `public`, optional `meta`, `import`, optional `all` (`import all M`
 * records M), the module. The header ends at the first token that is none of these (a command, a
 * doc comment, `private`, …), and an `import` after it is not one of the header's. A first line
 * `#lang lean4` is dropped first, as Lean's shell drops it. `problem` (else null) names what makes
 * Lean reject the header — so that it saves no snapshot — with its 1-based line:column (columns in
 * code points): a tab or lone CR in the header's whitespace (or in the trailing whitespace of the
 * first token Lean reads for `module`/`prelude`), an unterminated comment or «, an import without a
 * module, a module that is a header keyword or ends in a lone '.', `public`/`meta`/`import all`
 * without `module`, `public import all`, or a `#lang` other than lean4. Other header errors are not
 * detected here: the bake then runs and fails with no .snap (exit 1).
 */
export function probeHeader(source) {
  let s = String(source);
  const imports = [];
  if (s.startsWith("#lang")) {
    const nl = s.indexOf("\n");
    const id = s.slice(5, nl < 0 ? s.length : nl).replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
    if (id !== "lean4") return { imports, problem: `an unknown language ${JSON.stringify(id)} in its #lang line at 1:1` };
    s = " ".repeat(nl < 0 ? s.length : nl) + (nl < 0 ? "" : s.slice(nl)); // Lean drops the line; the positions stay
  }
  s = s.replace(/\r\n/g, "\n");
  const where = (at) => { const line = s.slice(0, at).split("\n"); return `${line.length}:${[...line[line.length - 1]].length + 1}`; };
  const stop = (problem, at) => ({ imports, problem: `${problem} at ${where(at)}` });
  let t = trivia(s, 0);
  if (t.problem) return stop(t.problem, t.at);
  let i = t.end;
  /** The end of keyword `word` at `at` (a token only when the identifier there is exactly it), else -1. */
  const keyword = (at, word) => { const id = lexIdent(s, at); return id?.parts && s.slice(at, id.end) === word ? id.end : -1; };
  /**
   * Lean reads the token at `at` (with its trailing whitespace) for `optional module` and
   * `optional prelude`, outside any `atomic`: a tab, lone CR or open comment after it is a header
   * error even when that token is a command. Only identifier-like tokens (`def`, `public`, `#check`)
   * are measured here.
   */
  const firstToken = (at) => {
    const id = lexIdent(s, s[at] === "#" ? at + 1 : at);
    if (!id || id.problem) return null;
    const u = trivia(s, id.end);
    return u.problem ? stop(u.problem, u.at) : null;
  };
  let isModule = false;
  const m = keyword(i, "module");
  if (m >= 0) {
    isModule = true;
    t = trivia(s, m);
    if (t.problem) return stop(t.problem, t.at);
    i = t.end;
  }
  const pr = keyword(i, "prelude");
  if (pr >= 0) {
    t = trivia(s, pr);
    if (t.problem) return stop(t.problem, t.at);
    i = t.end;
  } else {
    const bad = firstToken(i);
    if (bad) return bad;
  }
  for (;;) {
    // `public`/`meta` belong to the header only before `import` (`public section` ends it)
    let j = i;
    const mods = [];
    for (const word of ["public", "meta"]) {
      const e = keyword(j, word);
      if (e < 0) continue;
      const u = trivia(s, e);
      if (u.problem) return { imports, problem: null }; // not an import: the header ended at i
      mods.push([word, j]);
      j = u.end;
    }
    const e = keyword(j, "import");
    if (e < 0) return { imports, problem: null };
    for (const [word, at] of mods) if (!isModule) return stop(`\`${word} import\` without \`module\``, at);
    t = trivia(s, e);
    if (t.problem) return stop(t.problem, t.at);
    j = t.end;
    const all = keyword(j, "all");
    if (all >= 0) {
      if (!isModule) return stop("`import all` without `module`", j);
      if (mods.some(([word]) => word === "public")) return stop("`public import all`", j);
      t = trivia(s, all);
      if (t.problem) return stop(t.problem, t.at);
      j = t.end;
    }
    const id = lexIdent(s, j);
    if (!id) return stop("an import without a module name", j);
    if (id.problem) return stop(id.problem, id.at);
    const raw = s.slice(j, id.end);
    if (HEADER_KEYWORDS.has(raw)) return stop(`the keyword ${raw} where a module name goes`, j);
    // `Foo.` is a partial name (an error); `..`, `.{` and `.(` are tokens of their own
    if (s[id.end] === "." && !".{(".includes(s[id.end + 1] ?? "\n")) return stop("a module name ending in '.'", id.end);
    imports.push(id.parts.map(namePart).join("."));
    t = trivia(s, id.end);
    if (t.problem) return stop(t.problem, t.at);
    i = t.end;
  }
}

/** The entry's `imports`: probeHeader(source).imports (the bake refuses a probe whose header has a problem). */
export function importsOf(source) {
  return probeHeader(source).imports;
}

/** Null when `name` may name a snapshot, else the refusal (without the tool prefix). */
export function nameProblem(name) {
  return typeof name === "string" && SNAPSHOT_NAME.test(name) ? null
    : `refusing --name ${JSON.stringify(name)}: expected ${SNAPSHOT_NAME.source} (it names <work>/<name>.snap, the .snapz and the index entry)`;
}

/** --roots: comma-separated module roots → { value } or { problem }. */
export function parseRoots(text) {
  const roots = String(text).split(",").map((r) => r.trim()).filter(Boolean);
  if (roots.length === 0 || !roots.every((r) => MODULE_ROOT.test(r))) {
    return { problem: `refusing --roots ${JSON.stringify(text)}: expected comma-separated module roots (e.g. Mathlib,ProofWidgets)` };
  }
  return { value: roots };
}

/** --initial-bytes: a positive whole number of bytes → { value } or { problem }. */
export function parseInitialBytes(text) {
  const n = Number(text);
  if (!(Number.isSafeInteger(n) && n > 0)) return { problem: `refusing --initial-bytes ${JSON.stringify(text)}: expected a positive whole number of bytes` };
  return { value: n };
}

/**
 * --entry-fields: one JSON object whose keys go after the core keys and the aliases, in object
 * order → { value } or { problem }. Refused: not JSON, not an object, a core key, roots / label /
 * initialBytes (only through their validating flags: one malformed entry rejects a reader's whole
 * index), and the package's reserved keys.
 */
export function parseEntryFields(text) {
  const refuse = (why) => ({ problem: `refusing --entry-fields ${JSON.stringify(text)}: ${why}` });
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse("expected a JSON object (it is not JSON)");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("expected a JSON object");
  for (const key of Object.keys(value)) {
    if (CORE_KEYS.includes(key)) return refuse(`${JSON.stringify(key)} is a core entry key, written by the bake`);
    if (ALIAS_KEYS.includes(key)) return refuse(`${JSON.stringify(key)} goes through --${key === "initialBytes" ? "initial-bytes" : key}, which validates it`);
    if (RESERVED_KEYS.includes(key)) return refuse(`${JSON.stringify(key)} is reserved for lean4-wasm64 (formats/snapshot-index.md)`);
  }
  return { value };
}

/**
 * The entry a bake upserts, its keys in the index's order: the core keys, then roots, label and
 * initialBytes when given (truthy), then `fields` (--entry-fields) in object order.
 */
export function snapshotEntry({ name, file, sha256, bytes, transfer, imports, runtime, roots = null, label = null, initialBytes = null, fields = null }) {
  return {
    name,
    url: `/snapshots/${file}`,
    digest: `sha256:${sha256}`,
    bytes,
    transfer,
    imports,
    runtime,
    ...(roots ? { roots } : {}),
    ...(label ? { label } : {}),
    ...(initialBytes ? { initialBytes } : {}),
    ...(fields ?? {}),
  };
}

/** Null when `index` is a snapshot index this writer may extend, else why not. */
export function indexProblem(index) {
  if (!index || typeof index !== "object" || Array.isArray(index)) return "it is not a JSON object";
  if (index.schema !== SNAPSHOT_INDEX_SCHEMA) return `its schema is ${JSON.stringify(index.schema)}, not ${SNAPSHOT_INDEX_SCHEMA}`;
  if (!Array.isArray(index.snapshots)) return "it has no snapshots array";
  const bad = index.snapshots.findIndex((s) => !s || typeof s !== "object" || Array.isArray(s) || typeof s.name !== "string");
  if (bad >= 0) return `snapshots[${bad}] is not an entry with a string name`;
  return null;
}

/** Index text → { index } or { problem } (not JSON, or indexProblem). */
export function parseIndex(text) {
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    return { problem: "it is not JSON" };
  }
  const problem = indexProblem(index);
  return problem ? { problem } : { index };
}

/**
 * The pairing refusal for upserting `name` baked by `buildId` into `index` (QED64's two checks,
 * foreign first), or null. The entry being rebaked is not a sibling: it is replaced whatever its
 * runtime. The text has no tool prefix; the bake prints it after "bake-snapshot: ".
 */
export function pairingProblem(index, name, buildId, indexPath) {
  const siblings = index.snapshots.filter((s) => s.name !== name);
  const foreign = siblings.filter((s) => s.runtime && s.runtime !== buildId);
  if (foreign.length) {
    return `${indexPath} already holds entries for runtime ${foreign[0].runtime} (${foreign.map((s) => s.name).join(", ")}) — refusing to mix pairings`;
  }
  const unpaired = siblings.filter((s) => !s.runtime);
  if (unpaired.length) {
    return `${indexPath} holds entries with no runtime pairing (${unpaired.map((s) => s.name).join(", ")}) — rebake ${unpaired.map((s) => `--name ${s.name}`).join(", ")} against this runtime first, or bake into an empty --out (an entry that names no runtime pairs with none: formats/snapshot-index.md)`;
  }
  return null;
}

/** `index` with `entry` upserted: any entry of its name removed, `entry` appended; other keys kept in place. */
export function upsertEntry(index, entry) {
  return { ...index, snapshots: index.snapshots.filter((s) => s.name !== entry.name).concat([entry]) };
}

/** The bytes of index.json and of its copy. */
export const indexText = (index) => JSON.stringify(index, null, 2);

/** The per-build copy beside an index: index.<buildId>.json. */
export const copyPathOf = (indexPath, buildId) => path.join(path.dirname(indexPath), `index.${buildId}.json`);

// ---------- read ----------

/**
 * Read an index. Only ENOENT is a new (empty) index; any other read error, text that is not
 * JSON, another schema or no snapshots array throws SnapshotIndexError: a corrupt index is
 * refused, never replaced (it would drop every sibling entry).
 */
export function readIndex(indexPath, io = fs) {
  let text;
  try {
    text = io.readFileSync(indexPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { index: emptyIndex(), exists: false };
    throw new SnapshotIndexError(`cannot read ${indexPath} (${e?.code ?? e?.message}) — refusing to replace it`);
  }
  const { index, problem } = parseIndex(text);
  if (problem) throw new SnapshotIndexError(`${indexPath} is not a snapshot index: ${problem} — refusing to replace it`);
  return { index, exists: true };
}

// ---------- locks ----------
//
// Both locks the bake takes (<out>/index.json.lock here, <work>/.bake.lock below) are created by
// an exclusive open (O_CREAT|O_EXCL: no link(2), which exFAT/FAT and some FUSE/SMB mounts refuse)
// and hold pid lines. A lock is NEVER taken over, whatever its holder (running, not running,
// unreadable, empty) or its age: without link(2) Node has no race-free takeover (two waiters that
// judge one dead lock can both remove it, the second removing the lock the first has just
// created), a pid means nothing on a directory shared between hosts, and another tool's lock
// (QED64's bake takes the same index lock) need not be in this format. A holder removes its lock
// only while it still reads the lines it wrote; a lock left by a killed holder stays until someone
// who knows no bake uses the directory removes it.

/** Whether `pid` is a process on this host (EPERM: running, as another user). Reported, never acted on. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

const pidLabel = (pid, alive) => `pid ${pid} (${alive(Number(pid)) ? "running" : "not running"} on this host)`;
const unreadableHolder = (what) => `a holder it cannot read (${what})`;

/**
 * Who holds the index lock, from its text (QED64's words): `pid N (running on this host)`,
 * `pid N (not running on this host)`, or `a holder it cannot read ("<its first 200 characters>")`.
 */
export function describeIndexLockHolder(text, alive = pidAlive) {
  const m = /^(\d+)\n$/.exec(text);
  return m ? pidLabel(m[1], alive) : unreadableHolder(JSON.stringify(String(text).slice(0, 200)));
}

/**
 * Who holds a --work lock, from its text: `bake pid N (…)`, then ` and runner pid M (…)` once the
 * runner's pid is recorded, each with whether it runs on this host; or `a holder it cannot read (…)`.
 */
export function describeWorkLockHolder(text, alive = pidAlive) {
  const m = /^(\d+)\n(?:(\d+)\n)?$/.exec(text);
  if (!m) return unreadableHolder(JSON.stringify(String(text).slice(0, 200)));
  return `bake ${pidLabel(m[1], alive)}${m[2] ? ` and runner ${pidLabel(m[2], alive)}` : ""}`;
}

/**
 * Create `lockPath` holding `text` with an exclusive open: the open fd, or null when it exists. A
 * failed write removes it (ours, just created: never left behind for the next holder to wait out).
 */
function createLock(lockPath, text, io) {
  let fd;
  try {
    fd = io.openSync(lockPath, "wx");
  } catch (e) {
    if (e?.code === "EEXIST") return null;
    throw e;
  }
  try {
    io.writeFileSync(fd, text);
  } catch (e) {
    try {
      io.rmSync(lockPath, { force: true });
    } finally {
      try { io.closeSync(fd); } catch { /* the write's error is the one reported */ }
    }
    throw e;
  }
  return fd;
}

/** O_NOFOLLOW where the platform has it (not Windows): a symbolic link at a lock path is read as unreadable (ELOOP), not followed. */
// O_NONBLOCK: a FIFO at a lock path opens at once (and reads as empty) instead of blocking the bake.
const READ_LOCK_FLAG = fs.constants.O_NOFOLLOW ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0) : "r";
/** How many times in a row a lock may vanish between its create (EEXIST) and its read before it is named as unreadable. */
const VANISHING_READS = 100;

/**
 * The text of an existing lock: { text }, { gone: true } (ENOENT: released meanwhile), or
 * { who } for one it cannot read (`a holder it cannot read (read failed: <code>)`). Symbolic
 * links are not followed: a dangling one would otherwise read as released on every try.
 */
function readLock(lockPath, io) {
  try {
    return { text: io.readFileSync(lockPath, { encoding: "utf8", flag: READ_LOCK_FLAG }) };
  } catch (e) {
    return e?.code === "ENOENT" ? { gone: true } : { who: unreadableHolder(`read failed: ${e?.code ?? e?.message}`) };
  }
}

/** Remove `lockPath` only while it still reads `text` (ours); a read error leaves it in place. */
export function releaseLock(lockPath, text, io = fs) {
  try {
    if (io.readFileSync(lockPath, "utf8") === text) io.rmSync(lockPath, { force: true });
  } catch { /* gone, or unreadable: left */ }
}

/** The default bound on the index lock's wait (QED64's LOCK_WAIT_MS). */
export const INDEX_LOCK_WAIT_MS = 120_000;

/** The index lock still held by another past the wait: the bake names it and exits 1. */
export class IndexLockHeldError extends Error {
  constructor(lockPath, who, waitMs) {
    super(`index lock ${lockPath} is held by ${who} for over ${waitMs} ms; a lock is never taken over: once no bake writes ${path.dirname(lockPath)}, remove it and rerun`);
    this.name = "IndexLockHeldError";
    this.lockPath = lockPath;
    this.who = who;
    this.waitMs = waitMs;
  }
}

/**
 * Take the index lock `lockPath` (QED64's rule): an exclusive create holding `<pid>\n`. A held
 * lock is waited for, polling every `pollMs`, at most `waitMs` counted from before the first
 * attempt, and is never taken over; past the wait this throws IndexLockHeldError naming its holder
 * (a lock released just then is retried at once). `signal` aborts the wait with its reason.
 * Returns { text, release }; release removes the lock only while it still reads `<pid>\n`.
 */
export async function acquireIndexLock(lockPath, { waitMs = INDEX_LOCK_WAIT_MS, pollMs = 50, signal, pid = process.pid, alive = pidAlive, io = fs } = {}) {
  const text = `${pid}\n`;
  const started = Date.now();
  for (let vanished = 0; ;) {
    signal?.throwIfAborted();
    const fd = createLock(lockPath, text, io);
    if (fd !== null) {
      try {
        io.closeSync(fd);
      } catch (e) {
        io.rmSync(lockPath, { force: true }); // ours (our exclusive create), its pid perhaps never written: never left behind
        throw e;
      }
      return { text, release: () => releaseLock(lockPath, text, io) };
    }
    if (Date.now() - started > waitMs) {
      const held = readLock(lockPath, io);
      if (held.gone && (vanished += 1) < VANISHING_READS) continue; // released just then: straight back to the create
      const who = held.gone ? unreadableHolder("read failed: ENOENT, every time") : held.who ?? describeIndexLockHolder(held.text, alive);
      throw new IndexLockHeldError(lockPath, who, waitMs);
    }
    try {
      await delay(pollMs, undefined, { signal });
    } catch (e) {
      signal?.throwIfAborted(); // the signal's own reason, not the timer's AbortError
      throw e;
    }
  }
}

/**
 * Take a --work lock `lockPath`: an exclusive create holding `<pid>\n`, never waited for and never
 * taken over. Held by anyone: { taken: false, who } (describeWorkLockHolder), and the caller
 * refuses. Else { taken: true, addPid, release, text }: addPid(p) appends `<p>\n` through the fd
 * that created the lock (so a lock someone removed and another bake re-created is never written);
 * release closes it and removes the lock only while it still reads every line this process wrote.
 */
export function createWorkLock(lockPath, { pid = process.pid, alive = pidAlive, io = fs } = {}) {
  let text = `${pid}\n`;
  for (let vanished = 0; ;) {
    const fd = createLock(lockPath, text, io);
    if (fd === null) {
      const held = readLock(lockPath, io);
      if (held.gone && (vanished += 1) < VANISHING_READS) continue; // released between the create and the read
      return { taken: false, who: held.gone ? unreadableHolder("read failed: ENOENT, every time") : held.who ?? describeWorkLockHolder(held.text, alive) };
    }
    let open = true;
    return {
      taken: true,
      get text() { return text; },
      addPid(p) {
        const line = `${p}\n`;
        io.writeFileSync(fd, line);
        text += line;
      },
      release() {
        if (open) {
          open = false;
          try { io.closeSync(fd); } catch { /* closed */ }
        }
        releaseLock(lockPath, text, io);
      },
    };
  }
}

// ---------- write ----------

function writeDurably(file, text, io) {
  const fd = io.openSync(file, "w");
  try {
    io.writeFileSync(fd, text);
    io.fsyncSync(fd);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * Write `text` to the copy and to index.json: both temps first (a full disk fails before either
 * switches), then the COPY's rename, then index.json's. Every version of either file names one
 * runtime, so no order shows a reader a mispaired index; copy-first keeps the copy never older
 * than index.json (a failure between the renames leaves it one version ahead, never behind).
 * Temps are removed on every path.
 */
export function writeIndexFiles({ indexPath, copyPath, text, io = fs, pid = process.pid }) {
  const writes = [copyPath, indexPath].map((to) => ({ to, tmp: `${to}.${pid}.tmp` }));
  try {
    for (const { tmp } of writes) writeDurably(tmp, text, io);
    for (const { to, tmp } of writes) io.renameSync(tmp, to);
  } finally {
    for (const { tmp } of writes) io.rmSync(tmp, { force: true });
  }
}

/**
 * Upsert `entry` (baked by `buildId`) into <out>/index.json and write the copy
 * index.<buildId>.json, under <out>/index.json.lock: re-read (only ENOENT is a new index),
 * re-check the schema and the pairing, upsert, write both. Throws SnapshotIndexError (a refused
 * index: nothing written), IndexLockHeldError (the lock still held past `waitMs`: nothing
 * written), or the I/O error of a failed write. Another runtime's copy in <out> is never touched.
 */
export async function upsertIndex({ out, buildId, entry, waitMs = INDEX_LOCK_WAIT_MS, pollMs = 50, signal, io = fs }) {
  const indexPath = path.join(out, "index.json");
  const copyPath = copyPathOf(indexPath, buildId);
  const lock = await acquireIndexLock(`${indexPath}.lock`, { waitMs, pollMs, signal, io });
  try {
    const { index } = readIndex(indexPath, io);
    const pairing = pairingProblem(index, entry.name, buildId, indexPath);
    if (pairing) throw new SnapshotIndexError(pairing);
    const next = upsertEntry(index, entry);
    const text = indexText(next);
    writeIndexFiles({ indexPath, copyPath, text, io });
    return { index: next, text, indexPath, copyPath };
  } finally {
    lock.release();
  }
}
