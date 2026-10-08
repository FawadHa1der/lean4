/** The snapshot index writer (formats/snapshot-index.md): index.json and its per-build copy index.<buildId>.json. */

export const SNAPSHOT_INDEX_SCHEMA: "qed64.snapshot-index/v1";
/** The core entry keys, in entry order: name, url, digest, bytes, transfer, imports, runtime. */
export const CORE_KEYS: readonly string[];
/** roots, label, initialBytes: written only through the bake's validating flags, after the core keys. */
export const ALIAS_KEYS: readonly string[];
/** raw, lib, bakedBy: reserved for lean4-wasm64. */
export const RESERVED_KEYS: readonly string[];
/** ^[A-Za-z0-9][A-Za-z0-9._-]*$ */
export const SNAPSHOT_NAME: RegExp;
/** One module root of --roots. */
export const MODULE_ROOT: RegExp;

/** One index entry. Keys beyond the core and the aliases are a reader's page fields, kept verbatim. */
export interface SnapshotEntry {
  name: string;
  /** /snapshots/<name>.<digest16>.snapz */
  url: string;
  /** sha256:<64 hex> of the served gzip bytes */
  digest: string;
  /** the raw .snap's size */
  bytes: number;
  /** the .snapz's size */
  transfer: number;
  /** the bake probe's import modules, in source order */
  imports: string[];
  /** the build id of the runtime that baked it: wasm64-<16 hex> */
  runtime: string;
  roots?: string[];
  label?: string;
  initialBytes?: number;
  [field: string]: unknown;
}
export interface SnapshotIndex {
  schema: "qed64.snapshot-index/v1";
  snapshots: SnapshotEntry[];
  [key: string]: unknown;
}

/** An index refused: unreadable, not JSON, another schema, no snapshots array, foreign or unpaired entries. Nothing was written. */
export class SnapshotIndexError extends Error {}
/** The index lock still held, by anyone, past the wait (a lock is never taken over). Nothing was written. */
export class IndexLockHeldError extends Error {
  lockPath: string;
  /** describeIndexLockHolder's text, or `a holder it cannot read (read failed: <error code>)` / `(read failed: ENOENT, every time)` when the lock cannot be read */
  who: string;
  /** the bound waited (ms) */
  waitMs: number;
}

export function emptyIndex(): SnapshotIndex;

// ---------- pure ----------

/**
 * The probe's header as Lean lexes it: its modules in source order (parts joined by '.', a part
 * «escaped» only when it is not an identifier part), and `problem` (else null): what makes Lean
 * reject the header, with its 1-based line:column in code points. formats/snapshot-index.md, imports.
 */
export function probeHeader(source: string): { imports: string[]; problem: string | null };
/** probeHeader(source).imports. */
export function importsOf(source: string): string[];
/** Null when `name` matches SNAPSHOT_NAME, else the refusal text. */
export function nameProblem(name: unknown): string | null;
export type Parsed<T> = { value: T; problem?: undefined } | { value?: undefined; problem: string };
export function parseRoots(text: string): Parsed<string[]>;
export function parseInitialBytes(text: string): Parsed<number>;
/** One JSON object; core, alias and reserved keys refused. */
export function parseEntryFields(text: string): Parsed<Record<string, unknown>>;
/** The entry in index key order: core keys, then roots/label/initialBytes when truthy, then `fields` in object order. */
export function snapshotEntry(e: {
  name: string;
  /** the .snapz file name */
  file: string;
  /** hex sha256 of the .snapz bytes */
  sha256: string;
  bytes: number;
  transfer: number;
  imports: string[];
  runtime: string;
  roots?: string[] | null;
  label?: string | null;
  initialBytes?: number | null;
  fields?: Record<string, unknown> | null;
}): SnapshotEntry;
/** Null when `index` is a snapshot index this writer may extend, else why not. */
export function indexProblem(index: unknown): string | null;
export function parseIndex(text: string): { index: SnapshotIndex; problem?: undefined } | { index?: undefined; problem: string };
/** The foreign-then-unpaired refusal for upserting `name` (baked by `buildId`), or null. No tool prefix. */
export function pairingProblem(index: SnapshotIndex, name: string, buildId: string, indexPath: string): string | null;
/** A new index: `entry` replaces its name's entry and moves to the end; other keys kept in place. */
export function upsertEntry(index: SnapshotIndex, entry: SnapshotEntry): SnapshotIndex;
/** JSON.stringify(index, null, 2): the bytes of index.json and of its copy (no trailing newline). */
export function indexText(index: SnapshotIndex): string;
/** <dir of indexPath>/index.<buildId>.json */
export function copyPathOf(indexPath: string, buildId: string): string;

// ---------- I/O ----------

/** The calls of node:fs the writer makes (node:fs itself by default; a test may substitute one). */
export interface IndexIO {
  /** readIndex passes "utf8"; the locks pass { encoding: "utf8", flag } (O_NOFOLLOW|O_NONBLOCK where the platform has them) */
  readFileSync(path: string, options: "utf8" | { encoding: "utf8"; flag?: string | number }): string;
  openSync(path: string, flags: string): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options?: { force?: boolean }): void;
}

/** Only ENOENT is a new index (exists: false); anything else unreadable or malformed throws SnapshotIndexError. */
export function readIndex(indexPath: string, io?: IndexIO): { index: SnapshotIndex; exists: boolean };

// ---------- locks: exclusive create, pid lines, never taken over ----------

/** Whether `pid` is a process on this host (EPERM counts as running). Reported only, never acted on. */
export function pidAlive(pid: number): boolean;
/** `pid N (running on this host)` / `pid N (not running on this host)` for `<digits>\n`, else `a holder it cannot read ("<first 200 chars>")`. */
export function describeIndexLockHolder(text: string, alive?: (pid: number) => boolean): string;
/** `bake pid N (…)[ and runner pid M (…)]` for `<digits>\n[<digits>\n]`, else `a holder it cannot read (…)`. */
export function describeWorkLockHolder(text: string, alive?: (pid: number) => boolean): string;
/** Remove the lock only while it still reads `text`; a read error leaves it. */
export function releaseLock(lockPath: string, text: string, io?: IndexIO): void;
/** 120000: the default bound on the index lock's wait. */
export const INDEX_LOCK_WAIT_MS: number;
/**
 * Take the index lock (exclusive create holding `<pid>\n`), waiting at most waitMs (from before the
 * first attempt) for whoever holds it; never taken over. Throws IndexLockHeldError past the wait,
 * the signal's reason itself when it is aborted, or the I/O error of a failed create, pid write
 * or close (the lock then removed). `release` removes it only while it still reads `<pid>\n`.
 */
export function acquireIndexLock(lockPath: string, opts?: {
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  pid?: number;
  alive?: (pid: number) => boolean;
  io?: IndexIO;
}): Promise<{ text: string; release(): void }>;
/**
 * Take a --work lock (exclusive create holding `<pid>\n`): never waited for, never taken over.
 * Throws the I/O error of a failed create or pid write (the lock then removed).
 * `addPid` appends `<pid>\n` through the creating fd; `release` removes the lock only while it
 * still reads every line written.
 */
export function createWorkLock(lockPath: string, opts?: { pid?: number; alive?: (pid: number) => boolean; io?: IndexIO }):
  | { taken: false; who: string }
  | { taken: true; readonly text: string; addPid(pid: number): void; release(): void };
/** Both temps, then the copy's rename, then index.json's; temps removed on every path. */
export function writeIndexFiles(w: { indexPath: string; copyPath: string; text: string; io?: IndexIO; pid?: number }): void;
/** Under <out>/index.json.lock: re-read, re-check schema and pairing, upsert, write the copy then index.json. */
export function upsertIndex(u: {
  out: string;
  buildId: string;
  entry: SnapshotEntry;
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  io?: IndexIO;
}): Promise<{ index: SnapshotIndex; text: string; indexPath: string; copyPath: string }>;
