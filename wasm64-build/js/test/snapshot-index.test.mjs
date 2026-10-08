// snapshot-index.mjs without a bake: the pure parts (imports, validators, entry order, pairing,
// upsert, bytes) and the writer's I/O on a temp dir (read refusals, the lock, copy-first).
// Cases ported from QED64 (MIT, same author) tests/unit/{tool-paths,artifact-discipline}.test.ts at
// 76d5447 (fix/pinned-indexes) where they test the index; relicensed Apache-2.0 by the author.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALIAS_KEYS, CORE_KEYS, INDEX_LOCK_WAIT_MS, IndexLockHeldError, RESERVED_KEYS, SNAPSHOT_INDEX_SCHEMA, SnapshotIndexError,
  acquireIndexLock, createWorkLock, describeIndexLockHolder, describeWorkLockHolder, emptyIndex, importsOf, indexProblem,
  indexText, nameProblem, pairingProblem, parseEntryFields, parseIndex, parseInitialBytes, parseRoots, pidAlive, probeHeader, readIndex,
  releaseLock, snapshotEntry, upsertEntry, upsertIndex, writeIndexFiles,
} from "../snapshot-index.mjs";

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-index-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const ID = "wasm64-0123456789abcdef";
const OTHER = "wasm64-0000000000000000";
const entry = (name, runtime = ID, extra = {}) => ({ name, url: `/snapshots/${name}.x.snapz`, runtime, ...extra });
/** A pid that certainly ran and certainly exited. */
const deadPid = () => { const r = spawnSync(process.execPath, ["-e", "0"]); assert.equal(r.status, 0); return r.pid; };

// ---------- pure ----------

test("importsOf: the header's imports (`import all M` → M, no `private` prefix); scanning stops where the header ends", () => {
  assert.deepEqual(importsOf("#check (2 + 2 : Nat)"), []);
  assert.deepEqual(importsOf("import Mathlib\nimport QED64.Essential\n#check 1"), ["Mathlib", "QED64.Essential"]);
  assert.deepEqual(importsOf("module\n  public import A.B  \nmeta import C\npublic meta import D.«e»\n"), ["A.B", "C", "D.e"]);
  assert.deepEqual(importsOf("module\nimport all Mathlib.Data\nimport all X\nmeta import all Y.Z"), ["Mathlib.Data", "X", "Y.Z"]);
  assert.deepEqual(importsOf("import allX\nimport all_y\nimport all.Foo"), ["allX", "all_y", "all.Foo"]); // identifiers, not the keyword
  assert.deepEqual(importsOf("private import Baz\nimport Q"), []); // not in the grammar: a command, so the header has ended
  assert.deepEqual(importsOf("-- import NotThis\nimports X\n#eval import"), []);
  // the header: `module`, `prelude`, then imports; spaces, newlines, `--` and nested `/- -/` comments between tokens
  assert.deepEqual(importsOf("module\n\nprelude\npublic import Lean.Parser.Command\n\npublic section"), ["Lean.Parser.Command"]);
  assert.deepEqual(importsOf("/- c /- nested import X -/ -/ import A -- import Y\n  import B import C\n#eval 1"), ["A", "B", "C"]);
  assert.deepEqual(importsOf("/-/- one level: Lean never reads the third character -/ import A"), ["A"]);
  assert.deepEqual(importsOf("import\n  A.B\n-- FAKE {}\n#check 1"), ["A.B"]);
  assert.deepEqual(importsOf("import A\r\nimport B\r\n"), ["A", "B"]); // CRLF is read as a newline, as Lean reads it
  assert.deepEqual(importsOf("#lang lean4\nimport A"), ["A"]); // Lean's shell drops a `#lang lean4` line first
  assert.deepEqual(importsOf("import A..B\nimport C"), ["A"]); // `..` is a token: the header ends after A
  // where the header ends: a command, a doc comment, anything else; an import after it is not one
  assert.deepEqual(importsOf("import A\n#check 1\nimport B"), ["A"]);
  assert.deepEqual(importsOf("import A\n/-- doc -/\ndef x := 1\nimport B"), ["A"]);
  assert.deepEqual(importsOf("import A\n/-! module doc -/\nimport B"), ["A"]);
  assert.deepEqual(importsOf("public section\nimport A"), []);
  assert.deepEqual(importsOf("importX\nimport A"), []);
  assert.deepEqual(importsOf("﻿import A"), []); // not Lean whitespace: the header is empty
  assert.deepEqual(importsOf("import A\n #check 1"), ["A"]); // nor is NBSP: it starts the first command
});

test("probeHeader: module names as Lean lexes and prints them; a header Lean would not read as written is a problem", () => {
  // identFnAux's characters (', !, ?, letter-like Unicode, subscripts) and «escapes»; Name.toString's spelling
  assert.deepEqual(probeHeader("import Foo'Bar.baz!.qux?.α₁.ℕ.«bar baz».«Q».«»"), { imports: ["Foo'Bar.baz!.qux?.α₁.ℕ.«bar baz».Q.«»"], problem: null });
  assert.deepEqual(probeHeader("import λ"), { imports: [], problem: "an import without a module name at 1:8" }); // λ is not an identifier letter
  assert.deepEqual(probeHeader("import 𝔸 \t"), { imports: ["𝔸"], problem: "a tab at 1:10" }); // columns count code points
  for (const [source, problem] of [
    ["import\tA", "a tab at 1:7"],
    ["import A\n\n-- c\n\t#check 1", "a tab at 4:1"], // the last import's trailing whitespace
    ["import A\rimport B", "a lone carriage return at 1:9"],
    ["import A\n/- unterminated import B", "an unterminated comment at 2:1"],
    ["import «x", "an unterminated « at 1:8"],
    ["import\n", "an import without a module name at 2:1"],
    ["import  A", "an import without a module name at 1:8"],
    ["import meta", "the keyword meta where a module name goes at 1:8"],
    ["import Foo.\n", "a module name ending in '.' at 1:11"],
    ["\timport A", "a tab at 1:1"],
    // Lean's header errors (parseHeader): the module system's modifiers without `module`
    ["public import A", "`public import` without `module` at 1:1"],
    ["meta import A", "`meta import` without `module` at 1:1"],
    ["import all A", "`import all` without `module` at 1:8"],
    ["module\npublic import all A", "`public import all` at 2:15"],
    ["#lang foo\nimport A", 'an unknown language "foo" in its #lang line at 1:1'],
    // the first token Lean reads for `module`/`prelude` is lexed with its trailing whitespace, even a command's
    ["#check\t1", "a tab at 1:7"],
    ["def\tx := 1", "a tab at 1:4"],
    ["module\n#check\t1", "a tab at 2:7"],
    ["example /- open", "an unterminated comment at 1:9"],
    ["public\timport A", "a tab at 1:7"],
  ]) {
    assert.equal(probeHeader(source).problem, problem, JSON.stringify(source));
  }
  // after the header (past the first token): none of its business
  assert.deepEqual(probeHeader("import A\n#check 1\n\tfoo\r"), { imports: ["A"], problem: null });
  assert.deepEqual(probeHeader("import A\n#check\t1"), { imports: ["A"], problem: null });
  assert.deepEqual(probeHeader("public section\n\timport A"), { imports: [], problem: null });
  assert.deepEqual(probeHeader("prelude\n#check\t1"), { imports: [], problem: null });
  assert.deepEqual(probeHeader("module\nimport A\npublic\timport B"), { imports: ["A"], problem: null }); // inside `many import`: backtracked
  assert.deepEqual(probeHeader("import A.{x}"), { imports: ["A"], problem: null });
  assert.deepEqual(probeHeader("#lang lean4\r\nimport A\r\n"), { imports: ["A"], problem: null });
});

test("nameProblem: ^[A-Za-z0-9][A-Za-z0-9._-]*$ — every current name passes, a path never does", () => {
  for (const ok of ["init", "mathlib", "widgets", "testgame", "knights", "a.b-c_D9", "0"]) assert.equal(nameProblem(ok), null, ok);
  for (const bad of ["", "../x", "a/b", ".hidden", "-x", "_x", "a b", "a\\b", "ü", undefined, 3]) {
    assert.match(nameProblem(bad), /^refusing --name .*: expected \^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$/, String(bad));
  }
});

test("parseRoots / parseInitialBytes: QED64's validation and its refusal text", () => {
  assert.deepEqual(parseRoots("Mathlib,ProofWidgets"), { value: ["Mathlib", "ProofWidgets"] });
  assert.deepEqual(parseRoots(" Game , GameServer.Runner ,"), { value: ["Game", "GameServer.Runner"] });
  assert.deepEqual(parseRoots("A.b'"), { value: ["A.b'"] });
  for (const bad of [",", " , ", "1A", "A..B", "A-B", "A,B C"]) {
    assert.equal(parseRoots(bad).problem, `refusing --roots ${JSON.stringify(bad)}: expected comma-separated module roots (e.g. Mathlib,ProofWidgets)`);
  }
  assert.deepEqual(parseInitialBytes("2147483648"), { value: 2147483648 });
  for (const bad of ["0", "-1", "1.5", "abc", "9007199254740993", ""]) {
    assert.equal(parseInitialBytes(bad).problem, `refusing --initial-bytes ${JSON.stringify(bad)}: expected a positive whole number of bytes`);
  }
});

test("parseEntryFields: one JSON object; not JSON, not an object, core, alias and reserved keys refused", () => {
  assert.deepEqual(parseEntryFields('{"z":1,"page":{"x":[1]}}'), { value: { z: 1, page: { x: [1] } } });
  assert.deepEqual(parseEntryFields("{}"), { value: {} });
  for (const bad of ["not json", "[1]", "null", '"s"', "3", "true"]) assert.match(parseEntryFields(bad).problem, /^refusing --entry-fields .*: expected a JSON object/, bad);
  for (const key of CORE_KEYS) assert.match(parseEntryFields(JSON.stringify({ ok: 1, [key]: 1 })).problem, new RegExp(`"${key}" is a core entry key`));
  assert.deepEqual(ALIAS_KEYS, ["roots", "label", "initialBytes"]);
  assert.match(parseEntryFields('{"roots":["A"]}').problem, /"roots" goes through --roots/);
  assert.match(parseEntryFields('{"label":"x"}').problem, /"label" goes through --label/);
  assert.match(parseEntryFields('{"initialBytes":1}').problem, /"initialBytes" goes through --initial-bytes/);
  assert.deepEqual(RESERVED_KEYS, ["raw", "lib", "bakedBy"]);
  for (const key of RESERVED_KEYS) assert.match(parseEntryFields(JSON.stringify({ [key]: "x" })).problem, new RegExp(`"${key}" is reserved for lean4-wasm64`));
});

test("snapshotEntry: core keys, then roots/label/initialBytes when given, then --entry-fields in object order", () => {
  const base = { name: "init", file: "init.0123456789abcdef.snapz", sha256: "ab".repeat(32), bytes: 10, transfer: 7, imports: ["A"], runtime: ID };
  const plain = snapshotEntry(base);
  assert.deepEqual(Object.keys(plain), CORE_KEYS);
  assert.equal(plain.url, "/snapshots/init.0123456789abcdef.snapz");
  assert.equal(plain.digest, `sha256:${"ab".repeat(32)}`);
  const full = snapshotEntry({ ...base, roots: ["Game"], label: "Game", initialBytes: 4096, fields: { zeta: 1, alpha: { b: 2 } } });
  assert.deepEqual(Object.keys(full), [...CORE_KEYS, "roots", "label", "initialBytes", "zeta", "alpha"]);
  assert.deepEqual(Object.keys(snapshotEntry({ ...base, label: "L", fields: { x: 0 } })), [...CORE_KEYS, "label", "x"]);
  // QED64's bytes for an entry with the aliases (Q bake-snapshot.mjs :316-328)
  assert.equal(JSON.stringify(snapshotEntry({ ...base, roots: ["A", "B"], label: "L", initialBytes: 5 })),
    `{"name":"init","url":"/snapshots/init.0123456789abcdef.snapz","digest":"sha256:${"ab".repeat(32)}","bytes":10,"transfer":7,"imports":["A"],"runtime":"${ID}","roots":["A","B"],"label":"L","initialBytes":5}`);
});

test("indexProblem / parseIndex: the schema id, a snapshots array, entries with a name", () => {
  assert.equal(SNAPSHOT_INDEX_SCHEMA, "qed64.snapshot-index/v1");
  assert.equal(indexProblem(emptyIndex()), null);
  assert.equal(indexProblem({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [entry("a")], extra: true }), null);
  assert.match(indexProblem([]), /not a JSON object/);
  assert.match(indexProblem(null), /not a JSON object/);
  assert.match(indexProblem({ schema: "other/v1", snapshots: [] }), /schema is "other\/v1"/);
  assert.match(indexProblem({ snapshots: [] }), /schema is undefined/);
  assert.match(indexProblem({ schema: SNAPSHOT_INDEX_SCHEMA }), /no snapshots array/);
  assert.match(indexProblem({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: {} }), /no snapshots array/);
  assert.match(indexProblem({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [entry("a"), null] }), /snapshots\[1\]/);
  assert.match(indexProblem({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [{ url: "x" }] }), /snapshots\[0\]/);
  assert.deepEqual(parseIndex("{not json").problem, "it is not JSON");
  assert.deepEqual(parseIndex(JSON.stringify(emptyIndex())).index, emptyIndex());
});

test("pairingProblem: foreign first, then unpaired, with QED64's lines; the rebaked name is never a sibling", () => {
  const p = "/o/index.json";
  const idx = (...snapshots) => ({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots });
  assert.equal(pairingProblem(idx(), "init", ID, p), null);
  assert.equal(pairingProblem(idx(entry("init", OTHER), entry("mathlib")), "init", ID, p), null); // replaced, whatever its runtime
  assert.equal(pairingProblem(idx(entry("init")), "init", ID, p), null);
  const bare = (name) => ({ name, url: `/snapshots/${name}.x.snapz` }); // no runtime: unpaired
  assert.equal(pairingProblem(idx(entry("mathlib", OTHER), entry("w", OTHER), bare("x")), "init", ID, p),
    `/o/index.json already holds entries for runtime ${OTHER} (mathlib, w) — refusing to mix pairings`);
  const unpaired = pairingProblem(idx(bare("mathlib"), entry("w", "")), "init", ID, p);
  assert.ok(unpaired.startsWith("/o/index.json holds entries with no runtime pairing (mathlib, w) — rebake --name mathlib, --name w against this runtime first, or bake into an empty --out ("), unpaired);
  assert.doesNotMatch(unpaired, /promote/); // QED64's tail named its promote; the package's does not
});

test("upsertEntry: a new name appends, a rebake replaces and moves to the end; the index's other keys stay in place", () => {
  const index = { snapshots: [entry("a"), entry("b"), entry("c")], schema: SNAPSHOT_INDEX_SCHEMA, note: "kept" };
  const b2 = entry("b", ID, { bytes: 2 });
  const next = upsertEntry(index, b2);
  assert.deepEqual(next.snapshots.map((s) => s.name), ["a", "c", "b"]);
  assert.equal(next.snapshots[2], b2);
  assert.deepEqual(Object.keys(next), ["snapshots", "schema", "note"]);
  assert.deepEqual(index.snapshots.map((s) => s.name), ["a", "b", "c"]); // pure: the input is untouched
  assert.deepEqual(upsertEntry(emptyIndex(), entry("init")).snapshots.map((s) => s.name), ["init"]);
  assert.deepEqual(Object.keys(upsertEntry(emptyIndex(), entry("init"))), ["schema", "snapshots"]);
  // the bytes: JSON.stringify(index, null, 2), no trailing newline (QED64's)
  const text = indexText(next);
  assert.equal(text, JSON.stringify(next, null, 2));
  assert.ok(!text.endsWith("\n"));
});

// ---------- read ----------

test("readIndex: only ENOENT is a new index; a corrupt, foreign-schema or unreadable index is refused, never replaced", () => {
  const d = tmp();
  const p = path.join(d, "index.json");
  assert.deepEqual(readIndex(p), { index: emptyIndex(), exists: false });
  assert.deepEqual(readIndex(path.join(d, "absent-dir", "index.json")), { index: emptyIndex(), exists: false });
  fs.writeFileSync(p, JSON.stringify({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [entry("a")] }));
  assert.equal(readIndex(p).exists, true);
  for (const [text, why] of [["{\"schema\": \"qed64.snapshot-index/v1\", \"snapshots\": [", /not JSON/], [JSON.stringify({ schema: "x", snapshots: [] }), /schema is "x"/], ["{}", /schema/], [JSON.stringify({ schema: SNAPSHOT_INDEX_SCHEMA }), /no snapshots array/]]) {
    fs.writeFileSync(p, text);
    assert.throws(() => readIndex(p), (e) => e instanceof SnapshotIndexError && why.test(e.message) && e.message.includes("refusing to replace it"));
    assert.equal(fs.readFileSync(p, "utf8"), text);
  }
  const dirIndex = path.join(d, "sub", "index.json");
  fs.mkdirSync(dirIndex, { recursive: true });
  assert.throws(() => readIndex(dirIndex), (e) => e instanceof SnapshotIndexError && /cannot read .*\(EISDIR\)/.test(e.message));
  const file = path.join(d, "a-file");
  fs.writeFileSync(file, "");
  assert.throws(() => readIndex(path.join(file, "index.json")), (e) => e instanceof SnapshotIndexError && /\(ENOTDIR\)/.test(e.message));
});

// ---------- locks ----------

const ago = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };

test("describe…Holder / pidAlive: each pid and whether it runs on this host; anything else is a holder it cannot read", () => {
  const dead = deadPid();
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(dead), false);
  assert.equal(describeIndexLockHolder(`${process.pid}\n`), `pid ${process.pid} (running on this host)`);
  assert.equal(describeIndexLockHolder(`${dead}\n`), `pid ${dead} (not running on this host)`);
  assert.equal(describeIndexLockHolder("12\n", () => true), "pid 12 (running on this host)");
  for (const text of ["", "12", "12\n13\n", '{"pid":12}\n', " 12\n"]) {
    assert.equal(describeIndexLockHolder(text, () => true), `a holder it cannot read (${JSON.stringify(text)})`, JSON.stringify(text));
  }
  assert.equal(describeIndexLockHolder("x".repeat(500)), `a holder it cannot read (${JSON.stringify("x".repeat(200))})`);
  assert.equal(describeWorkLockHolder(`${process.pid}\n`), `bake pid ${process.pid} (running on this host)`);
  assert.equal(describeWorkLockHolder(`${dead}\n${process.pid}\n`), `bake pid ${dead} (not running on this host) and runner pid ${process.pid} (running on this host)`);
  for (const text of ["", "12", "12\n13", "12\n13\n14\n", '{"pid":12}']) {
    assert.equal(describeWorkLockHolder(text), `a holder it cannot read (${JSON.stringify(text)})`, JSON.stringify(text));
  }
});

test("acquireIndexLock: an exclusive create holding `<pid>\\n` (QED64's format); released only while it still reads that", async () => {
  const d = tmp();
  const lock = path.join(d, "index.json.lock");
  const l = await acquireIndexLock(lock);
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`);
  assert.equal(l.text, `${process.pid}\n`);
  l.release();
  assert.equal(fs.existsSync(lock), false);
  const l2 = await acquireIndexLock(lock);
  fs.writeFileSync(lock, "4242\n"); // someone removed it and another holder took it: not ours to remove
  l2.release();
  assert.equal(fs.readFileSync(lock, "utf8"), "4242\n");
  releaseLock(lock, "not this text");
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock);
  // a failed pid write: the lock (ours, just created) is removed and the write's error rethrown, even when the close fails too
  const failing = { ...fs, writeFileSync: (f, t, o) => { if (typeof f === "number") { const e = new Error("ENOSPC: no space left on device, write"); e.code = "ENOSPC"; throw e; } return fs.writeFileSync(f, t, o); } };
  await assert.rejects(acquireIndexLock(lock, { io: failing }), /ENOSPC/);
  assert.equal(fs.existsSync(lock), false);
  const closeFails = { ...failing, closeSync: (fd) => { fs.closeSync(fd); const e = new Error("EIO: i/o error, close"); e.code = "EIO"; throw e; } };
  await assert.rejects(acquireIndexLock(lock, { io: closeFails }), /ENOSPC/);
  assert.throws(() => createWorkLock(lock, { io: closeFails }), /ENOSPC/);
  assert.equal(fs.existsSync(lock), false);
  // the pid written but the close failing: the acquire fails and leaves no lock behind
  const onlyCloseFails = { ...fs, closeSync: (fd) => { fs.closeSync(fd); const e = new Error("EIO: i/o error, close"); e.code = "EIO"; throw e; } };
  await assert.rejects(acquireIndexLock(lock, { io: onlyCloseFails }), /EIO/);
  assert.equal(fs.existsSync(lock), false);
  // a cached write that never reached the file (NFS/SMB: the close reports it): the empty lock is removed too
  const lostWrite = { ...fs, writeFileSync: (f, t, o) => (typeof f === "number" ? undefined : fs.writeFileSync(f, t, o)), closeSync: onlyCloseFails.closeSync };
  await assert.rejects(acquireIndexLock(lock, { io: lostWrite }), /EIO/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(INDEX_LOCK_WAIT_MS, 120_000);
});

test("acquireIndexLock: never taken over — a running, dead, JSON or empty holder, however old, is waited for, then named", async () => {
  const d = tmp();
  const lock = path.join(d, "index.json.lock");
  const dead = deadPid();
  const holders = [
    [`${process.pid}\n`, `pid ${process.pid} (running on this host)`],
    [`${dead}\n`, `pid ${dead} (not running on this host)`],
    [`${JSON.stringify({ pid: dead, host: os.hostname(), start: "s", version: "v" })}\n`, null],
    ["", 'a holder it cannot read ("")'],
  ];
  for (const [text, who] of holders) {
    fs.writeFileSync(lock, text);
    ago(lock, 10 * 60_000); // ten minutes old: age is never a reason either
    const t0 = Date.now();
    await assert.rejects(acquireIndexLock(lock, { waitMs: 250 }), (e) => {
      assert.ok(e instanceof IndexLockHeldError, e.stack);
      assert.equal(e.who, who ?? `a holder it cannot read (${JSON.stringify(text)})`);
      assert.equal(e.message, `index lock ${lock} is held by ${e.who} for over 250 ms; a lock is never taken over: once no bake writes ${d}, remove it and rerun`);
      assert.deepEqual([e.lockPath, e.waitMs], [lock, 250]);
      return true;
    });
    assert.ok(Date.now() - t0 >= 250);
    assert.equal(fs.readFileSync(lock, "utf8"), text, "the lock is untouched");
  }
  // released while waiting: taken at once
  fs.writeFileSync(lock, `${process.pid}\n`);
  setTimeout(() => fs.rmSync(lock), 150);
  const l = await acquireIndexLock(lock, { waitMs: 5000, pid: 777 });
  assert.equal(fs.readFileSync(lock, "utf8"), "777\n");
  l.release();
  assert.equal(fs.existsSync(lock), false);
});

test("acquireIndexLock: released between the bound and the read → taken; an unreadable lock path is named, not spun on", { timeout: 20_000 }, async () => {
  const d = tmp();
  const lock = path.join(d, "index.json.lock");
  fs.writeFileSync(lock, "1\n");
  // the read past the bound finds ENOENT (released just then): straight back to the create, which succeeds
  let reads = 0;
  const io = { ...fs, readFileSync: (f, o) => { if (f === lock && reads++ === 0) { fs.rmSync(lock); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return fs.readFileSync(f, o); } };
  const l = await acquireIndexLock(lock, { waitMs: 0, io });
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`);
  l.release();
  // a directory where the lock goes: the create says EEXIST, the read EISDIR — named, after the bound
  fs.mkdirSync(lock);
  await assert.rejects(acquireIndexLock(lock, { waitMs: 100 }), (e) => e instanceof IndexLockHeldError && e.who === "a holder it cannot read (read failed: EISDIR)");
  assert.ok(fs.statSync(lock).isDirectory());
  fs.rmdirSync(lock);
  // a dangling symbolic link: the create says EEXIST, a read that followed it ENOENT forever; it is not followed
  fs.symlinkSync(path.join(d, "nowhere"), lock);
  await assert.rejects(acquireIndexLock(lock, { waitMs: 100 }), (e) => e instanceof IndexLockHeldError && e.who === "a holder it cannot read (read failed: ELOOP)");
  assert.deepEqual(createWorkLock(lock), { taken: false, who: "a holder it cannot read (read failed: ELOOP)" });
  assert.equal(fs.readlinkSync(lock), path.join(d, "nowhere"));
  // a FIFO: opened without blocking, read as an empty holder
  fs.rmSync(lock);
  if (process.platform !== "win32" && spawnSync("mkfifo", [lock]).status === 0) {
    await assert.rejects(acquireIndexLock(lock, { waitMs: 50 }), (e) => e.who === 'a holder it cannot read ("")');
    assert.deepEqual(createWorkLock(lock), { taken: false, who: 'a holder it cannot read ("")' });
  }
  // a lock that vanishes on every read (a platform without O_NOFOLLOW): named after 100 tries, not spun on
  fs.rmSync(lock, { force: true });
  fs.writeFileSync(lock, "1\n");
  const vanishing = { ...fs, readFileSync: (f, o) => { if (f === lock) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return fs.readFileSync(f, o); } };
  await assert.rejects(acquireIndexLock(lock, { waitMs: 0, io: vanishing }), (e) => e.who === "a holder it cannot read (read failed: ENOENT, every time)");
  assert.equal(createWorkLock(lock, { io: vanishing }).who, "a holder it cannot read (read failed: ENOENT, every time)");
});

test("acquireIndexLock: the wait is aborted by its signal", async () => {
  const d = tmp();
  const lock = path.join(d, "x.lock");
  fs.writeFileSync(lock, `${process.pid}\n`);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("received SIGTERM")), 100);
  const reason = new Error("received SIGTERM");
  ac.signal.addEventListener("abort", () => {}, { once: true });
  await assert.rejects(acquireIndexLock(lock, { waitMs: 60_000, signal: ac.signal }), (e) => e.message === "received SIGTERM" && e === ac.signal.reason); // the reason itself
  assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`);
});

test("createWorkLock: `<bake pid>\\n`, then `<runner pid>\\n` appended through its fd; never waited for, never taken over", () => {
  const d = tmp();
  const lock = path.join(d, ".bake.lock");
  const w = createWorkLock(lock, { pid: 111 });
  assert.equal(w.taken, true);
  assert.equal(fs.readFileSync(lock, "utf8"), "111\n");
  w.addPid(222);
  assert.equal(fs.readFileSync(lock, "utf8"), "111\n222\n");
  assert.equal(w.text, "111\n222\n");
  // held: refused at once, whoever holds it and however old, the lock untouched
  const dead = deadPid();
  for (const [text, who] of [
    ["111\n222\n", "bake pid 111 (not running on this host) and runner pid 222 (not running on this host)"],
    [`${process.pid}\n`, `bake pid ${process.pid} (running on this host)`],
    [`${dead}\n${process.pid}\n`, `bake pid ${dead} (not running on this host) and runner pid ${process.pid} (running on this host)`],
    ["", 'a holder it cannot read ("")'],
  ]) {
    const other = path.join(d, `held-${text.length}.lock`);
    fs.writeFileSync(other, text);
    ago(other, 10 * 60_000);
    assert.deepEqual(createWorkLock(other, { alive: (p) => p === process.pid }), { taken: false, who });
    assert.equal(fs.readFileSync(other, "utf8"), text);
  }
  w.release();
  assert.equal(fs.existsSync(lock), false);
  // removed under it and re-created by another bake: addPid writes the unlinked file, release leaves the new one
  const w2 = createWorkLock(lock, { pid: 333 });
  fs.rmSync(lock);
  fs.writeFileSync(lock, "444\n");
  w2.addPid(555);
  assert.equal(fs.readFileSync(lock, "utf8"), "444\n");
  w2.release();
  assert.equal(fs.readFileSync(lock, "utf8"), "444\n");
  w2.release(); // twice: harmless
});

// ---------- write ----------

test("writeIndexFiles: the copy is switched FIRST; a failed index.json rename leaves the copy ahead, never behind, and no temp", () => {
  const d = tmp();
  const indexPath = path.join(d, "index.json");
  const copyPath = path.join(d, `index.${ID}.json`);
  const order = [];
  const io = { ...fs, renameSync: (from, to) => { order.push(path.basename(to)); return fs.renameSync(from, to); } };
  writeIndexFiles({ indexPath, copyPath, text: "v1", io });
  assert.deepEqual(order, [`index.${ID}.json`, "index.json"]);
  assert.equal(fs.readFileSync(indexPath, "utf8"), "v1");
  assert.equal(fs.readFileSync(copyPath, "utf8"), "v1");
  const failing = { ...fs, renameSync: (from, to) => { if (path.basename(to) === "index.json") { const e = new Error("EIO: i/o failure, rename"); e.code = "EIO"; throw e; } return fs.renameSync(from, to); } };
  assert.throws(() => writeIndexFiles({ indexPath, copyPath, text: "v2", io: failing }), /EIO/);
  assert.equal(fs.readFileSync(copyPath, "utf8"), "v2");
  assert.equal(fs.readFileSync(indexPath, "utf8"), "v1");
  assert.deepEqual(fs.readdirSync(d).sort(), [`index.${ID}.json`, "index.json"].sort());
  // a full disk at the temps: neither file switches
  const full = { ...fs, writeFileSync: (f, t, o) => { if (typeof f === "number" && t === "v3") { const e = new Error("ENOSPC: no space left on device, write"); e.code = "ENOSPC"; throw e; } return fs.writeFileSync(f, t, o); } };
  assert.throws(() => writeIndexFiles({ indexPath, copyPath, text: "v3", io: full }), /ENOSPC/);
  assert.equal(fs.readFileSync(copyPath, "utf8"), "v2");
  assert.equal(fs.readFileSync(indexPath, "utf8"), "v1");
  assert.deepEqual(fs.readdirSync(d).sort(), [`index.${ID}.json`, "index.json"].sort());
  // only index.json's temp fails: the copy (whose temp was fine) does not switch either
  const files = new Map();
  const second = { ...fs, openSync: (f, fl) => { const fd = fs.openSync(f, fl); files.set(fd, path.basename(String(f))); return fd; },
    writeFileSync: (f, t, o) => { if (typeof f === "number" && files.get(f)?.startsWith("index.json.")) { const e = new Error("ENOSPC"); e.code = "ENOSPC"; throw e; } return fs.writeFileSync(f, t, o); } };
  assert.throws(() => writeIndexFiles({ indexPath, copyPath, text: "v4", io: second }), /ENOSPC/);
  assert.equal(fs.readFileSync(copyPath, "utf8"), "v2");
  assert.equal(fs.readFileSync(indexPath, "utf8"), "v1");
  // the order of the calls: both temps written and fsynced, then the copy renamed, then index.json
  const calls = [];
  const fdName = new Map();
  const traced = { ...fs,
    openSync: (f, fl) => { const fd = fs.openSync(f, fl); fdName.set(fd, path.basename(String(f)).replace(/\.\d+\.tmp$/, ".tmp")); return fd; },
    writeFileSync: (f, t, o) => { if (typeof f === "number") calls.push(`write ${fdName.get(f)}`); return fs.writeFileSync(f, t, o); },
    fsyncSync: (fd) => { calls.push(`fsync ${fdName.get(fd)}`); return fs.fsyncSync(fd); },
    renameSync: (from, to) => { calls.push(`rename ${path.basename(String(to))}`); return fs.renameSync(from, to); } };
  writeIndexFiles({ indexPath, copyPath, text: "v5", io: traced });
  assert.deepEqual(calls, [`write index.${ID}.json.tmp`, `fsync index.${ID}.json.tmp`, "write index.json.tmp", "fsync index.json.tmp", `rename index.${ID}.json`, "rename index.json"]);
});

test("upsertIndex: both files the same bytes, another runtime's copy untouched, the lock released; refusals write nothing", async () => {
  const out = tmp();
  const otherCopy = path.join(out, `index.${OTHER}.json`);
  fs.writeFileSync(otherCopy, "another runtime's copy: never touched");
  const e1 = entry("init");
  const r1 = await upsertIndex({ out, buildId: ID, entry: e1 });
  assert.equal(r1.copyPath, path.join(out, `index.${ID}.json`));
  assert.equal(r1.indexPath, path.join(out, "index.json"));
  const text = fs.readFileSync(r1.indexPath, "utf8");
  assert.equal(text, JSON.stringify({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [e1] }, null, 2));
  assert.equal(r1.text, text);
  assert.deepEqual(fs.readFileSync(r1.copyPath), fs.readFileSync(r1.indexPath));
  await upsertIndex({ out, buildId: ID, entry: entry("mathlib") });
  await upsertIndex({ out, buildId: ID, entry: entry("init", ID, { bytes: 2 }) });
  const index = JSON.parse(fs.readFileSync(r1.indexPath, "utf8"));
  assert.deepEqual(index.snapshots.map((s) => s.name), ["mathlib", "init"]);
  assert.deepEqual(fs.readFileSync(r1.copyPath), fs.readFileSync(r1.indexPath));
  assert.equal(fs.readFileSync(otherCopy, "utf8"), "another runtime's copy: never touched");
  assert.deepEqual(fs.readdirSync(out).sort(), [`index.${OTHER}.json`, `index.${ID}.json`, "index.json"].sort());
  // refused under the lock: a foreign sibling, an unpaired one, a corrupt index — nothing written, lock released
  for (const [text2, why] of [
    [JSON.stringify({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [entry("mathlib", OTHER)] }), /already holds entries for runtime wasm64-0{16} \(mathlib\) — refusing to mix pairings$/],
    [JSON.stringify({ schema: SNAPSHOT_INDEX_SCHEMA, snapshots: [{ name: "mathlib" }] }), /holds entries with no runtime pairing \(mathlib\) — rebake /],
    ["{corrupt", /is not a snapshot index: it is not JSON — refusing to replace it$/],
  ]) {
    const o = tmp();
    fs.writeFileSync(path.join(o, "index.json"), text2);
    await assert.rejects(upsertIndex({ out: o, buildId: ID, entry: entry("init") }), (e) => e instanceof SnapshotIndexError && why.test(e.message));
    assert.deepEqual(fs.readdirSync(o), ["index.json"]);
    assert.equal(fs.readFileSync(path.join(o, "index.json"), "utf8"), text2);
  }
});
