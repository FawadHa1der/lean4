// Loaded into every node process of a test/publish-sandbox.test.mjs run (NODE_OPTIONS=--import):
// replaces fetch. A GitHub release download URL of the sandbox repository is served from the fake
// gh's state ($FAKE_STATE/gh.json: published releases only, as GitHub serves them); every other URL
// is refused. No network. Each request is appended to $FAKE_STATE/events.log.
import fs from "node:fs";
import path from "node:path";

const PREFIX = "https://github.com/sandbox-owner/sandbox-repo/releases/download/";
globalThis.fetch = async function sandboxFetch(url) {
  const u = String(url), ST = process.env.FAKE_STATE;
  if (!ST || !u.startsWith(PREFIX)) throw new Error(`publish sandbox: network blocked (${u})`);
  const [tag, name, ...rest] = u.slice(PREFIX.length).split("/");
  fs.appendFileSync(path.join(ST, "events.log"), `FETCH ${tag}/${name}\n`);
  const s = JSON.parse(fs.readFileSync(path.join(ST, "gh.json"), "utf8"));
  const a = rest.length ? null : s.releases.find((r) => r.tag_name === tag && !r.draft)?.assets.find((x) => x.name === name);
  if (!a) return new Response("Not Found", { status: 404 });
  return new Response(fs.readFileSync(path.join(ST, "assets", String(a.id))), { status: 200 });
};
