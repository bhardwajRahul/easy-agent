#!/usr/bin/env node

/**
 * Stage 36 snapshot: audit the distributable npm artifact.
 *
 * Run from the easy-agent repository after `npm run build`:
 *   node step/step36.js
 */

import { spawnSync } from "node:child_process";
import { constants, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bundlePath = join(root, "dist", "eagent.js");
const mapPath = `${bundlePath}.map`;
const bundle = readFileSync(bundlePath, "utf8");

let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`✓ ${message}`);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

check(pkg.name === "eagent", "package name is eagent");
check(
  JSON.stringify(pkg.bin) ===
    JSON.stringify({ eagent: "dist/eagent.js", "easy-agent": "dist/eagent.js" }),
  "both public commands point at the same bundle",
);
check(Object.keys(pkg.dependencies ?? {}).length === 0, "runtime dependencies are empty");
check(pkg.engines?.node === ">=22", "package declares Node.js 22+");

check(bundle.startsWith("#!/usr/bin/env node\n"), "bundle has a Node shebang");
check((statSync(bundlePath).mode & constants.S_IXUSR) !== 0, "bundle is executable");
check(statSync(mapPath).size > 0, "source map exists");
check(
  run(process.execPath, [bundlePath, "--version"]).trim() === `eagent ${pkg.version}`,
  "bundle version matches package.json",
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCache = mkdtempSync(join(tmpdir(), "eagent-step36-cache-"));
try {
  const pack = JSON.parse(
    run(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      ...process.env,
      npm_config_cache: npmCache,
    }),
  )[0];
  const packedPaths = pack.files.map((file) => file.path).sort();
  const expectedPaths = [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "dist/eagent.js",
    "dist/eagent.js.map",
    "package.json",
  ];
  check(
    JSON.stringify(packedPaths) === JSON.stringify(expectedPaths),
    "npm tarball contains only the intended release files",
  );
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

console.log(`\nStage 36 snapshot: ${passed} checks passed.`);
