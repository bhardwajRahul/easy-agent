/**
 * Step 35 - Plugin System & Static Marketplace
 *
 * Goal:
 * - bundle six extension kinds (skills/agents/commands/styles/hooks/mcp) into
 *   one namespaced, version-locked, distributable unit
 * - resolve `plugin@marketplace` ids through a static (offline) catalog
 * - install with atomic rollback + delete-safety
 * - reconcile enabled plugins into the live registries without a restart
 * - trust-gate executable (hooks/MCP) components
 *
 * This snapshot distills the PURE logic (no fs / no network) so each rule is
 * testable in isolation. The production code in src/plugins wires these into
 * the real loaders, git, and registries.
 */

import * as path from "node:path";

// -----------------------------------------------------------------------------
// 1. Unified namespace
// -----------------------------------------------------------------------------
// Every component a plugin ships is exposed as `<plugin>:<name>` so two plugins
// can each define a `review` command without clobbering each other — and so a
// component can always be traced back to (and removed with) its owner.

export function applyNamespace(pluginName, componentName) {
  const prefix = `${pluginName}:`;
  return componentName.startsWith(prefix) ? componentName : `${prefix}${componentName}`;
}

export function splitNamespace(qualified) {
  const idx = qualified.indexOf(":");
  if (idx <= 0) return null;
  return { pluginName: qualified.slice(0, idx), componentName: qualified.slice(idx + 1) };
}

export function mcpServerNamespace(pluginName, serverName) {
  return `plugin:${pluginName}:${serverName}`;
}

// -----------------------------------------------------------------------------
// 2. Path containment
// -----------------------------------------------------------------------------
// A manifest can point component dirs anywhere. Before touching disk we reject
// anything that escapes the plugin root (absolute paths, `..` traversal). The
// real loader ALSO realpath-checks symlinks; here we cover the pure path logic.

export function isInsidePlugin(pluginRoot, candidate) {
  const root = path.resolve(pluginRoot);
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function validateComponentPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return "path must be a non-empty string";
  if (path.isAbsolute(rawPath)) return "path must be relative to the plugin root";
  const parts = rawPath.split(/[\\/]/);
  if (parts.includes("..")) return "path must not contain '..'";
  return null; // ok
}

// -----------------------------------------------------------------------------
// 3. Variable substitution
// -----------------------------------------------------------------------------
// Plugins reference their own files portably: ${EASY_AGENT_PLUGIN_ROOT} (the
// install dir, moves per version) and ${EASY_AGENT_PLUGIN_DATA} (a stable,
// cross-version data dir). Substituted at load time into component bodies,
// allowed-tools, hook commands, and MCP command/args/env. Hook/MCP subprocesses
// receive the same values as real environment variables.

export function substitutePluginVars(value, vars) {
  return value
    .split("${EASY_AGENT_PLUGIN_ROOT}").join(vars.root)
    .split("${EASY_AGENT_PLUGIN_DATA}").join(vars.data);
}

// -----------------------------------------------------------------------------
// 4. Enable state is SCOPED; install is GLOBAL
// -----------------------------------------------------------------------------
// A plugin is installed once (globally), then enabled per scope. Later scopes
// win, and an explicit `false` disables even if an earlier scope enabled it —
// so a project can opt OUT of a user-wide plugin. Missing = inherit.

export function mergeEnableScopes(scopesInOrder) {
  const effective = new Map();
  for (const scope of scopesInOrder) {
    for (const [id, on] of Object.entries(scope ?? {})) effective.set(id, on);
  }
  return new Set([...effective].filter(([, on]) => on).map(([id]) => id));
}

// -----------------------------------------------------------------------------
// 5. Trust gating of executable components
// -----------------------------------------------------------------------------
// Prompt components (skills/agents/commands/styles) are inert text. Hooks and
// MCP servers RUN code. A plugin enabled only via a checked-in project/local
// scope must not run in an untrusted folder — but a user-scope enable is the
// user's own machine-level choice and always runs.

export function shouldRunExecutable({ enableScope, folderTrusted }) {
  if (enableScope === "user") return true;
  return folderTrusted === true;
}

// -----------------------------------------------------------------------------
// 6. Version resolution priority
// -----------------------------------------------------------------------------
// A plugin dir is copied into a version-locked cache dir so two versions can
// coexist and an update can roll back. The version label priority:
//   plugin.json version → marketplace entry version → git commit SHA → unknown

export function resolveVersion({ manifestVersion, entryVersion, commit }) {
  if (manifestVersion && manifestVersion !== "unknown") return manifestVersion;
  if (entryVersion) return entryVersion;
  if (commit) return commit;
  return "unknown";
}

// -----------------------------------------------------------------------------
// 7. Marketplace resolution
// -----------------------------------------------------------------------------
// A "marketplace" is just a marketplace.json catalog (local dir or git repo).
// Its only job: turn a stable `name@marketplace` id into a concrete SOURCE —
// a local path relative to the catalog, or a git URL.

export function toPluginSource(entry, marketplaceRoot) {
  const src = entry.source;
  if (/^[a-z]+:\/\//i.test(src) || /^git@/.test(src)) {
    return { kind: "git", url: src, ...(entry.ref ? { ref: entry.ref } : {}) };
  }
  return { kind: "local", path: path.resolve(marketplaceRoot, src) };
}

export function parsePluginRef(ref) {
  const at = ref.lastIndexOf("@");
  return at > 0
    ? { pluginName: ref.slice(0, at), marketplace: ref.slice(at + 1) }
    : { pluginName: ref, marketplace: undefined };
}

// -----------------------------------------------------------------------------
// 8. MCP reconciliation diff
// -----------------------------------------------------------------------------
// Enabling/disabling/updating a plugin must bring its MCP servers up/down
// live. We diff the previously-applied server map against the desired one so a
// disabled plugin's stdio child process is torn down (never leaked) and a new
// one is started — without restarting the CLI.

export function diffMcpServers(applied, desired) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, cfg] of desired) {
    const prev = applied.get(name);
    if (!prev) added.push(name);
    else if (JSON.stringify(prev) !== JSON.stringify(cfg)) changed.push(name);
  }
  for (const name of applied.keys()) {
    if (!desired.has(name)) removed.push(name);
  }
  return { added, removed, changed };
}

// Every async MCP apply captures a generation. A connection Promise that
// resolves after a newer reload must clean itself up instead of registering
// stale tools.
export function isCurrentGeneration(candidate, current) {
  return candidate === current;
}

// -----------------------------------------------------------------------------
// 9. Delete safety
// -----------------------------------------------------------------------------
// Uninstall only ever deletes a full version slot under the cache root:
// <marketplace>/<plugin>/<version>. Merely being somewhere under the broad
// plugins root is not enough — that would allow a corrupted state record to
// delete a whole marketplace or all versions of a plugin.

export function isManagedPluginPath(cacheRoot, target) {
  const root = path.resolve(cacheRoot);
  const rel = path.relative(root, path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).filter(Boolean).length >= 3;
}

// -----------------------------------------------------------------------------
// 10. Within-plugin conflict rule
// -----------------------------------------------------------------------------
// Namespacing removes CROSS-plugin collisions, but a single plugin declaring
// both a skill and a command that resolve to the same `/name` is ambiguous and
// is a validation error.

export function findPublicNameConflicts(skillNames, commandNames) {
  const skills = new Set(skillNames);
  return commandNames.filter((c) => skills.has(c));
}
