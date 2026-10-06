// lean4-wasm64 as a library: the identity rules and the release record.
// The tools themselves are scripts (cli.mjs dispatches them); import paths
// "lean4-wasm64/<script>.mjs" resolve too (package.json exports "./*").
export * from "./artifact-id.mjs";
export * from "./release-record.mjs";
export { cliContract, applyCliContract } from "./cli-args.mjs";
