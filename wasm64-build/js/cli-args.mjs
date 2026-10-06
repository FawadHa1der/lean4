// The flag contract every lean4-wasm64 tool shares (ported from the CLI
// contract QED64's pipeline used, docs/CLI-CONTRACT.md there, so the moved
// tools behave exactly as before):
//   --help / -h      print the tool's help and exit 0, before any side effect
//   a missing required flag (any one of a group)   print the usage line, exit 2
//   an unknown flag  a WARNING on stderr, then ignored
//   --flag=value     rewritten to the two-token form the tool reads
//   a repeated flag  the first value wins (a warning)
// `spec` = { tool, usage, help, flags: {name: arity 0|1}, required: [[name, …], …],
//            passthrough: null | "explicit" | "implicit", passthroughRequired }.
// It rewrites process.argv in place, so tools read their flags with a plain indexOf.
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

/** Apply the contract to this process's argv (rewriting it in place). */
export function applyCliContract(spec) {
  const args = process.argv.slice(2);
  const normalized = cliContract(spec, args)?.args ?? args;
  if (normalized.join("\0") !== args.join("\0")) process.argv.splice(2, args.length, ...normalized);
}
