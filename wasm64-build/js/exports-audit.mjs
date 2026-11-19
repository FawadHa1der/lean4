#!/usr/bin/env node
// What consumers' JavaScript touches on the runtime, against what the runtime promises (kernel
// patch 0039; RELEASE-PIPELINE.md "Exports"). Run it, read-only, over every consumer tree before
// a release that changes the export list or the glue: QED64, lean4game (client/public/workers too),
// the widgets showcase, the proof sheets.
//
// It finds, in .js/.mjs/.cjs/.ts/.mts/.cts/.tsx/.jsx/.html files (not under node_modules, .git,
// .lake or dist, and not copies of the glue itself):
//  - export names: `_lean_…`, `_malloc`, `__emscripten_…` and the like, read off any object
//    (`M._x`, `self._x`, `Module["_x"]`) or named bare; each must be in the contract
//    (src/emscripten-exports.seed.txt, or the copy in runtime-contract.mjs) or a glue built-in the
//    gate's S6 guards;
//  - glue globals reached by name (`self.X`, `globalThis.X`, `M.X`, `Module.X`, at any link of a
//    chain such as `globalThis.Module.X`, `typeof X`) that the glue declares (--glue <lean.js>: its `var`/`function` names, standard globals left out);
//    each must be one S6 guards ([GLUE], runtime-contract.mjs GLUE_NAMES), a runtime method
//    (RUNTIME_METHODS) or a Module input;
//  - BARE reads of what exists on Module only (runtime-contract.mjs moduleOnly: since emsdk 7 the
//    runtime methods getValue, setValue, ccall, stringToNewUTF8, and every export but _malloc,
//    _pthread_self, __emscripten_proxy_main and __emscripten_check_mailbox have no global binding),
//    in code (comments and string, template and regex literals left out; of an .html file, its
//    <script> elements): such a name read off the global scope (`self.X`, `globalThis.X`,
//    `window["X"]`) or in `typeof X`; an export named bare (`_free(p)`); and, in a file whose code
//    names Module, importScripts or FS, one of the four methods named bare (`getValue(p, "i64")`;
//    elsewhere such a name is the file's own, as a React state setter `setValue`). Named bare is
//    not an object key, a method definition or TS signature, nor a declaration of that name (a
//    `function getValue` of the file's own). A name a host destructured from Module is listed too:
//    judge it;
//  - the members used of PThread, TTY and FS (listed, not judged: those objects are kept whole; with
//    --glue, a member the glue's text never names is marked, e.g. FS.filesystems on emsdk 7, for a
//    human to judge: `PT.` also matches minified third-party code, and a member the previous glue
//    lacked too is no change).
// Exit 0 when every name is known, 1 when one is not (listed as UNKNOWN, UNGUARDED or BARE), 2 usage (a
// missing directory, --glue or --seed file included).
//
// Usage: node exports-audit.mjs [--glue <lean.js>] [--seed <emscripten-exports.seed.txt>] [--json] <dir>…

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT, GLUE_NAMES, MODULE_ONLY_METHODS, RUNTIME_METHODS, moduleOnly, parseSeed } from "./runtime-contract.mjs";

const USAGE = "usage: exports-audit.mjs [--glue <lean.js>] [--seed <emscripten-exports.seed.txt>] [--json] <dir>…";
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`${USAGE}\nWhat consumer trees' JavaScript touches on the runtime (exports, glue globals, PThread/TTY/FS members),\n`
    + "classified against the export contract and the glue surface the gate's S6 guards (kernel patch 0039), and\n"
    + "BARE reads of Module-only names (the Module-only runtime methods and exports) in code, comments and strings\n"
    + "left out: off the global scope or in typeof, an export named bare, a method named bare in a file naming\n"
    + "Module, importScripts or FS. The members a --glue never names are marked, for a human to judge.\n"
    + "--glue: a built lean.js, whose declared names make glue reach-ins recognizable; --seed: the contract (default:\n"
    + "the repository's src/emscripten-exports.seed.txt when this file runs from it, else runtime-contract.mjs's copy).\n"
    + "exit codes: 0 every name known, 1 an UNKNOWN export, an UNGUARDED glue global or a BARE read, 2 usage");
  process.exit(0);
}
const opts = { glue: null, seed: null, json: false, dirs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--glue" || a === "--seed") {
    if (!argv[i + 1]) { console.error(USAGE); process.exit(2); }
    opts[a.slice(2)] = argv[++i];
  } else if (a === "--json") opts.json = true;
  else if (a.startsWith("-")) { console.error(`exports-audit: unknown flag ${a}\n${USAGE}`); process.exit(2); }
  else opts.dirs.push(a);
}
if (!opts.dirs.length) { console.error(USAGE); process.exit(2); }
for (const d of opts.dirs) if (!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory()) { console.error(`exports-audit: ${d} is not a directory`); process.exit(2); }

// the contract: the seed when given or beside this file in the repository, else the packaged copy
const here = path.dirname(fileURLToPath(import.meta.url));
const seedFile = opts.seed ?? path.join(here, "..", "..", "src", "emscripten-exports.seed.txt");
const contract = new Set(fs.existsSync(seedFile) ? parseSeed(fs.readFileSync(seedFile, "utf8")) : CONTRACT.map((c) => c.name));
if (opts.seed && !fs.existsSync(opts.seed)) { console.error(`exports-audit: ${opts.seed} not found`); process.exit(2); }
const glueKnown = new Set(GLUE_NAMES), methods = new Set(RUNTIME_METHODS);
const contractNames = [...contract];
const isModuleOnly = (name) => moduleOnly(name, contractNames);
// what a host may read on Module besides the glue's own: its inputs (EMBED-RUNTIME.md §3.1)
const MODULE_INPUTS = new Set(["wasmMemory", "INITIAL_MEMORY", "noInitialRun", "arguments", "locateFile",
  "mainScriptUrlOrBlob", "print", "printErr", "preRun", "onRuntimeInitialized", "onAbort", "onExit", "setStatus", "ENV"]);

/**
 * The global names a glue script declares: `var` outside every function body (blocks included, as
 * `var` is function-scoped), and `function`/`class`/`let`/`const` at the top level. A small scanner
 * that skips strings, templates, comments and regex literals and tells function bodies (`=>{`,
 * `name(…){`, `function(…){`) from blocks (`if(…){`, `else{`, `try{`, …). Approximate, enough for
 * minified Emscripten glue: it keeps a consumer's own locals (`typeof worker`) from looking like
 * reach-ins.
 */
function glueGlobals(src) {
  const names = new Set(), n = src.length, word = /[\w$]/;
  const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);
  const KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
  let i = 0, prev = "op", prevWord = "";
  const stack = [];                 // { ch: "{" | "(" | "[" | "${", fn: bool, control: bool }
  let lastParenControl = false, decl = null;  // decl: { kind, depth } while reading a var/let/const list
  const fnDepth = () => stack.filter((e) => e.fn).length;
  const scanTemplate = () => {      // from just after ` or after a ${…}'s }
    while (i < n) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; prev = "lit"; return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; stack.push({ ch: "${", fn: false }); prev = "op"; return; }
      i++;
    }
  };
  let expectName = false;           // the next word is a declared name
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; prev = "lit"; continue; }
    if (c === "`") { i++; scanTemplate(); continue; }
    if (c === "/" && prev !== "id" && prev !== ")" && prev !== "lit") {   // a regex literal
      i++;
      for (let cls = false; i < n && src[i] !== "\n"; i++) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false; else if (src[i] === "/" && !cls) break;
      }
      i++;
      while (i < n && word.test(src[i])) i++;
      prev = "lit"; continue;
    }
    if (c === "(" || c === "[") { stack.push({ ch: c, control: c === "(" && CONTROL.has(prevWord), fn: false }); i++; prev = "op"; prevWord = ""; continue; }
    if (c === "{") {
      const fn = prev === "=>" || (prev === ")" && !lastParenControl);
      stack.push({ ch: "{", fn });
      i++; prev = "op"; prevWord = ""; continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      i++;
      if (top?.ch === "${") { scanTemplate(); continue; }
      if (c === ")") lastParenControl = !!top?.control;
      prev = c === "}" ? "op" : ")"; prevWord = ""; continue;
    }
    if (c === "=" && src[i + 1] === ">") { i += 2; prev = "=>"; continue; }
    if (c === ";" && decl && stack.length === decl.depth) decl = null;
    if (c === "," && decl && stack.length === decl.depth) expectName = true;
    if (word.test(c)) {
      let j = i;
      while (j < n && word.test(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      if (expectName && /^[A-Za-z_$]/.test(w)) {
        if (decl.kind === "var" ? fnDepth() === 0 : stack.length === 0) names.add(w);
        expectName = false;
      } else if (w === "var" || w === "let" || w === "const") {
        decl = { kind: w, depth: stack.length }; expectName = true;
      } else if ((prevWord === "function" || prevWord === "class") && stack.length === 0) {
        names.add(w);
      }
      prev = KEYWORDS.has(w) ? "op" : "id"; prevWord = w;
      continue;
    }
    i++; prev = "op"; prevWord = "";
  }
  return names;
}

let glueDeclared = null, glueText = null;
if (opts.glue) {
  if (!fs.statSync(opts.glue, { throwIfNoEntry: false })?.isFile()) { console.error(`exports-audit: ${opts.glue} not found\n${USAGE}`); process.exit(2); }
  glueText = fs.readFileSync(opts.glue, "utf8");
  glueDeclared = glueGlobals(glueText);
  for (const n of glueDeclared) if (n in globalThis) glueDeclared.delete(n);
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".lake", "dist"]);
const EXTENSIONS = /\.(m?js|cjs|m?ts|cts|tsx|jsx|html)$/;
const RUNTIME_NAME = /^_{1,2}(?:lean_|l_|lp_|initialize_|runtime_initialize_|meta_initialize_|emscripten_|malloc$|free$|main$|pthread_self$|proc_exit$)/;
const isGlueCopy = (text) => /function assignWasmExports\(|var Module\s*=\s*typeof Module\s*!=/.test(text);
// the objects that are the global scope, where a Module-only name has no binding
const GLOBAL_SCOPE = new Set(["self", "globalThis", "window"]);
/** `text` with its comments and its string, template and regex literals blanked, offsets kept: code
 *  alone, for the BARE scans; of an HTML file, its <script> elements alone. A regex literal is one after
 *  `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, `>` (an arrow's `=>`) or `return`:
 *  approximate, as the rest of this audit. Read as code, the `//` of `(s) => /^https?:\/\//` would blank
 *  the rest of its line, and a quote in such a literal would open a string. */
const LITERALS = new RegExp([/\/\/[^\n]*/, /\/\*[\s\S]*?\*\//, /"(?:[^"\\\n]|\\.)*"/, /'(?:[^'\\\n]|\\.)*'/, /`(?:[^`\\]|\\[\s\S])*`/,
  /(?<=(?:[(,=:[!&|?{};>]|\breturn)\s*)\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[A-Za-z]*/].map((r) => r.source).join("|"), "g");
const blank = (m) => m.replace(/[^\n]/g, " ");
const codeOnly = (text, file) => (/\.html$/i.test(file) ? text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|[^\n]/gi, (m) => (m.length > 1 ? m : " ")) : text)
  .replace(LITERALS, blank);
// `name` named bare in code: not read off an object (`.x`), not a key (`x:`, `x?:`), a method definition
// or TS signature (`x(…) {`, `x?(…): T`), nor a declaration of a name of the host's own (`function x`, `const x`)
const namedBare = (name) => new RegExp(String.raw`(?<![\w$.])(?<!\b(?:function|class|var|let|const)\s+)(${name})\b(?!\s*[?!]?\s*:)(?!\s*[?!]?\s*\([^()]*\)\s*[:{])`, "g");
// an export, and one of the four Module-only methods; a method only in a file whose code names Module,
// importScripts or FS (the glue's world): elsewhere the name is the file's own, as a React state setter `setValue`
const BARE_EXPORT = namedBare(String.raw`_{1,2}[A-Za-z]\w*`), BARE_METHOD = namedBare(MODULE_ONLY_METHODS.join("|"));
const NAMES_GLUE = /(?<![\w$])(?:Module|importScripts|FS)(?![\w$])/;

const uses = new Map();   // key -> { kind, name, files: Set }
const note = (kind, name, file) => {
  const key = `${kind}\0${name}`;
  if (!uses.has(key)) uses.set(key, { kind, name, files: new Set() });
  uses.get(key).files.add(file);
};
let files = 0, skippedGlue = 0;
function scanFile(file, shown) {
  const stat = fs.statSync(file);
  if (stat.size > 8 << 20) return;
  const text = fs.readFileSync(file, "utf8");
  if (isGlueCopy(text)) { skippedGlue++; return; }
  files++;
  // the code alone, its offsets those of `text`: a match of `text` is a read (BARE) only where its first word is code
  const code = codeOnly(text, file), inCode = (m, word) => code.startsWith(word, m.index);
  for (const m of text.matchAll(/(?:\??\.|\[\s*["'`]|\b)(_{1,2}[A-Za-z][\w]*)/g)) if (RUNTIME_NAME.test(m[1])) note("export", m[1], shown);
  // a lookahead, so a chain is read at every link: `globalThis.Module.HEAPU8` is Module and HEAPU8. A Module-only
  // name read off the global scope or in typeof is BARE where it is code; in a comment or a string, a name reached
  for (const m of text.matchAll(/\b(?=(self|globalThis|window|M|Module)\??\.([A-Za-z$][\w$]*))/g))
    note(GLOBAL_SCOPE.has(m[1]) && isModuleOnly(m[2]) && inCode(m, m[1]) ? "bare" : "global", m[2], shown);
  for (const m of text.matchAll(/\bModule\[\s*["']([A-Za-z$][\w$]*)["']\s*\]/g)) note("global", m[1], shown);
  for (const m of text.matchAll(/\btypeof\s+([A-Za-z_$][\w$]*)/g)) note(isModuleOnly(m[1]) && inCode(m, "typeof") ? "bare" : "typeof", m[1], shown);
  // Module-only names off the global scope, dotted (an export: `self._free`) or bracketed (`globalThis["_lean_mk_string"]`:
  // the code-only text blanks the string, so this reads the raw text, its object in code)
  for (const m of text.matchAll(/\b(self|globalThis|window)\s*(?:\??\.\s*|\[\s*["'`])(_{1,2}[A-Za-z]\w*|[A-Za-z$][\w$]*)/g))
    if (isModuleOnly(m[2]) && inCode(m, m[1])) note("bare", m[2], shown);
  // named bare in code: a Module-only export (`_free(p)`); in the glue's world, a Module-only method (`getValue(p, "i64")`)
  for (const m of code.matchAll(BARE_EXPORT)) if (isModuleOnly(m[1])) note("bare", m[1], shown);
  if (NAMES_GLUE.test(code)) for (const m of code.matchAll(BARE_METHOD)) note("bare", m[1], shown);
  for (const m of text.matchAll(/\b(PThread|PT|TTY|FS)\??\.([A-Za-z_$][\w$]*)/g)) note("member", `${m[1] === "PT" ? "PThread" : m[1]}.${m[2]}`, shown);
}
function walk(dir, root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, root); }
    else if (e.isFile() && EXTENSIONS.test(e.name)) scanFile(p, `${path.basename(root)}/${path.relative(root, p)}`);
  }
}
for (const d of opts.dirs) walk(path.resolve(d), path.resolve(d));

// classify
const report = { contract: [], glue: [], unknown: [], guarded: [], unguarded: [], bare: [], members: [] };
const where = (u) => [...u.files].slice(0, 3).join(", ") + (u.files.size > 3 ? ` +${u.files.size - 3}` : "");
for (const u of uses.values()) {
  const row = { name: u.name, files: [...u.files] };
  if (u.kind === "export") {
    // a raw wasm export name (`_emscripten_check_mailbox`, in a comment or a wasmExports[…]) counts as its JS name
    if (contract.has(u.name) || contract.has(`_${u.name}`)) report.contract.push(row);
    else if (glueKnown.has(u.name) || glueKnown.has(`_${u.name}`)) report.glue.push(row);
    else report.unknown.push(row);
  } else if (u.kind === "bare") {
    report.bare.push(row);
  } else if (u.kind === "member") {
    // with --glue, a member the glue's text never names (FS.filesystems on emsdk 7) is marked
    if (glueText && !new RegExp(`(?<![\\w$])${u.name.split(".")[1].replace(/\$/g, "\\$")}(?![\\w$])`).test(glueText)) row.absent = true;
    report.members.push(row);
  } else if (!RUNTIME_NAME.test(u.name)) {
    // a non-export name is a reach-in only when the glue declares it (or it is one S6 knows)
    const known = glueKnown.has(u.name) || methods.has(u.name) || MODULE_INPUTS.has(u.name);
    const declared = glueDeclared ? glueDeclared.has(u.name) : known;
    if (!declared && !known) continue;
    if (known) report.guarded.push(row);
    else report.unguarded.push(row);
  }
}
// one row per name (a name reached as `self.X` and as `typeof X` is one reach-in), its files merged
for (const k of Object.keys(report)) {
  const byName = new Map();
  for (const r of report[k]) {
    const prev = byName.get(r.name);
    byName.set(r.name, { ...r, files: [...new Set([...(prev?.files ?? []), ...r.files])] });
  }
  report[k] = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const bad = report.unknown.length + report.unguarded.length + report.bare.length;

if (opts.json) {
  console.log(JSON.stringify({ files, skippedGlueCopies: skippedGlue, contract: [...contract], ...report }, null, 1));
} else {
  const line = (title, rows) => {
    console.log(`${title} (${rows.length})${rows.length ? ":" : ""}`);
    for (const r of rows) console.log(`  ${r.name}   ${where({ files: new Set(r.files) })}`);
  };
  console.log(`exports-audit: ${opts.dirs.length} tree(s), ${files} files read, ${skippedGlue} glue copies skipped; contract ${contract.size} names${opts.glue ? `; glue ${opts.glue}` : "; no --glue: only the [GLUE] names S6 knows are recognized"}`);
  line("exports in the contract", report.contract);
  line("glue built-ins the gate's S6 guards", report.glue);
  line("UNKNOWN exports (neither in the contract nor a guarded glue name)", report.unknown);
  line("glue globals and runtime methods reached by name, guarded by S6 or Module inputs", report.guarded);
  line("UNGUARDED glue globals (the glue declares them; nothing checks they survive a link)", report.unguarded);
  line("BARE reads of Module-only names (no global binding since emsdk 7: read them on Module)", report.bare);
  const byObject = new Map();
  for (const r of report.members) {
    const [o, m] = r.name.split(".");
    byObject.set(o, [...(byObject.get(o) ?? []), r.absent ? `${m} (not in --glue)` : m]);
  }
  for (const [o, ms] of byObject) console.log(`members of ${o}: ${ms.join(", ")}`);
  console.log(bad ? `\nAUDIT: ${bad} name(s) the contract and S6 do not cover, or read bare` : "\nAUDIT: every name is covered");
}
process.exitCode = bad ? 1 : 0;
