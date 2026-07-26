import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadPlugin } from "../plugins/loader.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dbg35-"));
const write = async (p: string, c: string) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, c, "utf-8");
};
const cdemo = path.join(root, "claude-market", "plugins", "cdemo");
await write(path.join(cdemo, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name: "cdemo", version: "2.0.0", description: "claude-style plugin" }, null, 2));
await write(path.join(cdemo, "skills", "wave", "SKILL.md"),
  "---\nname: wave\ndescription: Wave at the user.\n---\nWave hello.\n");

const loaded = await loadPlugin({ root: cdemo, pluginId: "cdemo@claudemp", strict: true });
console.log("ERRORS:", JSON.stringify(loaded.errors, null, 2));
console.log("WARNINGS:", loaded.warnings);
