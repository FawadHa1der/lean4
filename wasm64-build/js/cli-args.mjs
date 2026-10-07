// The flag contract every lean4-wasm64 tool shares (ported from the CLI
// contract QED64's pipeline used, docs/CLI-CONTRACT.md there, so the moved
// tools behave exactly as before):
//   --help / -h      print the tool's help and exit 0, before any side effect
//   a missing required flag (any one of a group)   print the usage line, exit 2
//   an unknown flag  a WARNING on stderr, then ignored
//   --flag=value     rewritten to the two-token form the tool reads
//   a repeated flag  the first value wins (a warning)
//   --stack-size     a tool that boots the runtime in its own process re-execs
//                    itself with --stack-size=8192 when started without one
//                    (ensureStackSize, below)
// `spec` = { tool, usage, help, flags: {name: arity 0|1}, required: [[name, …], …],
//            passthrough: null | "explicit" | "implicit", passthroughRequired }.
// It rewrites process.argv in place, so tools read their flags with a plain indexOf.
import path from "node:path";
import { isMainThread } from "node:worker_threads";

export function cliContract(spec, args, io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }) {
  const values = {};
  const warnings = [];
  const normalized = [];
  let passthrough = [];
  let help = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--help" || token === "-h") { help = true; continue; }
    if (token === "--" && spec.passthrough) { passthrough = args.slice(i + 1); normalized.push(...args.slice(i)); break; }
    const m = /^--([^=]+)(=[\s\S]*)?$/.exec(token);
    const arity = m && Object.hasOwn(spec.flags, m[1]) ? spec.flags[m[1]] : -1;
    if (arity < 0 || (arity === 0 && m[2] !== undefined)) {
      if (spec.passthrough === "implicit") { passthrough = args.slice(i); normalized.push(...passthrough); break; }
      warnings.push(token.startsWith("-") ? `unknown flag ${token} ignored` : `unexpected argument ${token} ignored`);
      normalized.push(token);
      continue;
    }
    const name = m[1];
    const repeated = Object.hasOwn(values, name);
    let value = true;
    if (arity === 1) {
      value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
      if (value === "--help" || value === "-h") help = true;
      if (!repeated) normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
      if (!value) warnings.push(`flag --${name} has no value; ignored`);
    } else normalized.push(token);
    if (!repeated) values[name] = value ?? "";
    else if (arity === 1) warnings.push(`flag --${name} repeated; the first value wins`);
  }
  if (help) { io.out(spec.help); io.exit(0); return null; }
  for (const w of warnings) io.err(`${spec.tool}: WARNING — ${w}`);
  for (const name of Object.keys(values)) if (values[name] === "") delete values[name];
  const missing = (spec.required || []).some((group) => !group.some((name) => Object.hasOwn(values, name)));
  if (missing || (spec.passthroughRequired && passthrough.length === 0)) { io.err(`usage: ${spec.usage}`); io.exit(2); return null; }
  return { values, passthrough, args: normalized };
}

/**
 * Apply the contract to this process's argv (rewriting it in place) and return
 * cliContract's result, { values, passthrough, args }: `values` holds each
 * flag's FIRST non-empty value (booleans as true), `passthrough` the arguments
 * after `--` (or, "implicit", from the first token that is not a flag of the
 * spec). Tools may keep reading process.argv with indexOf instead; the return
 * value is what a parser that must not misread a value spelled like a flag
 * (`--cases --artifact`) uses. Null only when an injected io.exit returned.
 */
export function applyCliContract(spec, io = undefined) {
  const args = process.argv.slice(2);
  const result = cliContract(spec, args, io);
  const normalized = result?.args ?? args;
  if (normalized.join("\0") !== args.join("\0")) process.argv.splice(2, args.length, ...normalized);
  return result;
}

const STACK_SIZE_FLAG = /^--stack[-_]size(=|$)/;

/**
 * The tools that boot the wasm runtime in their own process (node-runner,
 * persistent-probe) need V8's --stack-size=8192 (formats/HOSTING.md). Started
 * without any --stack-size, this replaces the process with itself plus that
 * flag through process.execve: the same PID, the same stdin/stdout/stderr, the
 * new image's exit code, nothing printed, so a supervisor that pipes and
 * SIGKILLs the PID (QED64's supervised-run and bake-snapshot, the gate's
 * timeout) sees one process. The new image's execArgv holds the flag, so there
 * it returns "present": no loop, no environment guard. An explicit
 * --stack-size of any size (either spelling) is respected. Where execve cannot
 * work (Windows, os400, a Worker, --permission without --allow-child-process)
 * or would drop an IPC channel (a fork()ed tool), one WARNING says how to run
 * the tool and it continues as before; a call that fails anyway adds Node's own
 * ExperimentalWarning to that WARNING.
 * Call it FIRST, before anything is printed or process.argv is rewritten: the
 * re-executed image runs everything again, so a line printed before it would
 * print twice. Ported from QED64 pipeline/toolchain/artifact-paths.mjs
 * (ensureStackSize), plus the platform guard above.
 */
export function ensureStackSize(tool, kib = 8192, proc = process) {
  if (proc.execArgv.some((a) => STACK_SIZE_FLAG.test(a))) return "present";
  const how = `run it as node --stack-size=${kib} ${path.basename(proc.argv[1] ?? tool)} (formats/HOSTING.md)`;
  // execve cannot work there (Windows, os400, a Worker, --permission without
  // --allow-child-process): say so once, before Node's own call would queue its
  // ExperimentalWarning next to ours
  if (typeof proc.execve !== "function" || proc.channel || proc.platform === "win32" || proc.platform === "os400"
      || (proc === process && !isMainThread) || proc.permission?.has?.("child") === false) {
    console.error(`${tool}: WARNING — started without --stack-size and cannot re-exec itself with it; ${how}`);
    return "absent";
  }
  try {
    proc.execve(proc.execPath, [proc.execPath, ...proc.execArgv, `--stack-size=${kib}`, ...proc.argv.slice(1)], { ...proc.env });
  } catch (e) {
    console.error(`${tool}: WARNING — started without --stack-size and the re-exec failed (${e?.code ?? e?.message}); ${how}`);
  }
  return "absent";
}
