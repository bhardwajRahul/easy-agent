/**
 * Step 35 - Plugins & Marketplace
 *
 * Executable reference snapshot for the milestone:
 * - package Skills / Agents / Commands / Output Styles / Hooks / MCP together
 * - resolve stable `plugin@marketplace` ids through static catalogs
 * - separate Marketplace, Installed, and Enabled state
 * - preflight executable components and bind confirmation to a fingerprint
 * - install into a versioned cache with multi-scope ownership
 * - build and commit one atomic runtime snapshot
 * - trust-gate Hooks/MCP and reconcile MCP with reload generations
 * - expose progressive `/plugin` command suggestions and operation progress
 *
 * The snapshot is self-contained and uses an in-memory filesystem model. The
 * production implementation under src/plugins/ supplies real filesystem locks,
 * atomic rename/rollback, Git transport, loaders, registries, and Ink views.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// 1. Stable ids and unified namespaces
// -----------------------------------------------------------------------------

export function parsePluginRef(ref) {
  const value = String(ref).trim();
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 1
    ? { pluginName: value.slice(0, at), marketplace: value.slice(at + 1) }
    : { pluginName: value, marketplace: undefined };
}

export function applyNamespace(pluginName, componentName) {
  const prefix = `${pluginName}:`;
  return componentName.startsWith(prefix) ? componentName : `${prefix}${componentName}`;
}

export function splitNamespace(qualified) {
  const idx = qualified.indexOf(":");
  if (idx <= 0) return null;
  return {
    pluginName: qualified.slice(0, idx),
    componentName: qualified.slice(idx + 1),
  };
}

export function mcpServerNamespace(pluginName, serverName) {
  const prefix = `plugin:${pluginName}:`;
  return serverName.startsWith(prefix) ? serverName : `${prefix}${serverName}`;
}

// -----------------------------------------------------------------------------
// 2. Path containment, cache slots, and exact delete boundaries
// -----------------------------------------------------------------------------

export function validateComponentPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return "path must be a non-empty string";
  }
  if (path.isAbsolute(rawPath)) return "path must be relative to the plugin root";
  if (rawPath.split(/[\\/]/).includes("..")) return "path must not contain '..'";
  return null;
}

export function isInsidePlugin(pluginRoot, candidate) {
  const root = path.resolve(pluginRoot);
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Publisher-controlled names and versions become exactly one path segment.
 * Unsafe input keeps a short digest so two different values cannot collapse
 * onto the same cache directory after punctuation replacement.
 */
export function safePathSegment(value) {
  const trimmed = String(value).trim();
  const clean = trimmed
    .replace(/[^a-zA-Z0-9._+-]/g, "-")
    .replace(/^\.+$/, "")
    .slice(0, 120);
  if (clean === trimmed && clean !== "" && clean !== "." && clean !== "..") {
    return clean;
  }
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
  const prefix = clean && clean !== "." && clean !== ".." ? clean : "unknown";
  return `${prefix.slice(0, 100)}-${digest}`;
}

export function getPluginCachePath(cacheRoot, marketplace, pluginName, version) {
  return path.join(
    path.resolve(cacheRoot),
    safePathSegment(marketplace),
    safePathSegment(pluginName),
    safePathSegment(version),
  );
}

/** Broad classification used for diagnostics, never sufficient for deletion. */
export function isManagedPluginPath(cacheRoot, target) {
  const root = path.resolve(cacheRoot);
  const rel = path.relative(root, path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).filter(Boolean).length >= 3;
}

/**
 * Destructive removal requires equality with the path recomputed from trusted
 * record fields. A corrupted installPath that merely points somewhere under
 * cache/<market>/<plugin>/ is rejected.
 */
export function isExactManagedPluginPath(cacheRoot, target, identity) {
  if (!isManagedPluginPath(cacheRoot, target)) return false;
  const expected = getPluginCachePath(
    cacheRoot,
    identity.marketplace,
    identity.name,
    identity.version,
  );
  return path.resolve(target) === path.resolve(expected);
}

// -----------------------------------------------------------------------------
// 3. Portable variables and deterministic content fingerprints
// -----------------------------------------------------------------------------

export function substitutePluginVars(value, vars) {
  if (typeof value === "string") {
    return value
      .split("${EASY_AGENT_PLUGIN_ROOT}").join(vars.root)
      .split("${EASY_AGENT_PLUGIN_DATA}").join(vars.data);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePluginVars(item, vars));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substitutePluginVars(item, vars),
      ]),
    );
  }
  return value;
}

/**
 * Fingerprint an already-enumerated package tree. Entries use normalized
 * relative paths and may describe files, directories, or symlinks. Real code
 * obtains this list by walking the fetched temp directory and ignores .git.
 */
export function fingerprintVirtualTree(entries) {
  const hash = createHash("sha256");
  const sorted = [...entries]
    .filter((entry) => !entry.path.split(/[\\/]/).includes(".git"))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const relative = entry.path.split(path.sep).join("/");
    if (entry.type === "dir") {
      hash.update(`dir\0${relative}\0`);
    } else if (entry.type === "link") {
      hash.update(`link\0${relative}\0${entry.target ?? ""}\0`);
    } else {
      hash.update(`file\0${relative}\0${entry.content ?? ""}\0`);
    }
  }
  return hash.digest("hex");
}

export function createInstallPreview({
  pluginId,
  version,
  tree,
  components,
  warnings = [],
  errors = [],
}) {
  const normalized = {
    skills: [...(components.skills ?? [])],
    agents: [...(components.agents ?? [])],
    commands: [...(components.commands ?? [])],
    outputStyles: [...(components.outputStyles ?? [])],
    hooks: [...(components.hooks ?? [])],
    mcpServers: [...(components.mcpServers ?? [])],
  };
  return {
    pluginId,
    version,
    fingerprint: fingerprintVirtualTree(tree),
    components: normalized,
    hasExecutableComponents:
      normalized.hooks.length > 0 || normalized.mcpServers.length > 0,
    warnings,
    errors,
  };
}

export function authorizePluginInstall(preview, options = {}) {
  if (preview.errors.length > 0) {
    throw new Error(`plugin validation failed: ${preview.errors.join("; ")}`);
  }
  if (
    preview.hasExecutableComponents &&
    options.allowExecutableComponents !== true
  ) {
    throw new Error("confirmation required: Hooks/MCP may execute local processes");
  }
  if (
    options.expectedFingerprint &&
    options.expectedFingerprint !== preview.fingerprint
  ) {
    throw new Error("plugin contents changed after confirmation");
  }
  return true;
}

// -----------------------------------------------------------------------------
// 4. Static Marketplace resolution
// -----------------------------------------------------------------------------

export function toPluginSource(entry, marketplaceRoot) {
  const src = entry.source;
  if (/^[a-z]+:\/\//i.test(src) || /^git@/.test(src)) {
    return { kind: "git", url: src, ...(entry.ref ? { ref: entry.ref } : {}) };
  }
  const error = validateComponentPath(src);
  if (error) throw new Error(`invalid marketplace plugin source: ${error}`);
  const resolved = path.resolve(marketplaceRoot, src);
  if (!isInsidePlugin(marketplaceRoot, resolved)) {
    throw new Error("marketplace plugin source escapes the marketplace root");
  }
  return { kind: "local", path: resolved };
}

export function resolveVersion({ manifestVersion, entryVersion, commit }) {
  if (manifestVersion && manifestVersion !== "unknown") return manifestVersion;
  if (entryVersion) return entryVersion;
  if (commit) return commit;
  return "unknown";
}

/**
 * Discover shows catalog entries absent from the authoritative install record.
 * Cache/data directories are deliberately ignored: they may contain orphans.
 */
export function listAvailablePlugins(marketplaces, installedPlugins) {
  return marketplaces
    .flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({
        pluginId: `${plugin.name}@${marketplace.name}`,
        name: plugin.name,
        marketplace: marketplace.name,
        version: plugin.version,
      })),
    )
    .filter((plugin) => installedPlugins[plugin.pluginId] === undefined)
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

// -----------------------------------------------------------------------------
// 5. Installed ownership and scoped enable state
// -----------------------------------------------------------------------------

function scopeMatches(row, scope, cwd) {
  if (row.scope !== scope) return false;
  return scope === "user" || path.resolve(row.projectPath ?? "") === path.resolve(cwd);
}

export function upsertInstallationScope(current, scope, cwd, installedAt) {
  const next = current.filter((row) => !scopeMatches(row, scope, cwd));
  next.push({
    scope,
    ...(scope === "user" ? {} : { projectPath: path.resolve(cwd) }),
    installedAt,
  });
  return next;
}

export function removeInstallationScope(current, scope, cwd) {
  return current.filter((row) => !scopeMatches(row, scope, cwd));
}

/**
 * Settings layers are already ordered low→high. Explicit false wins over an
 * earlier true. The source map is retained because trust depends on whether
 * the final enable came from user, project, or local scope.
 */
export function mergeEnableState(scopesInOrder) {
  const effective = new Map();
  for (const layer of scopesInOrder) {
    const values = layer.values ?? layer;
    for (const [pluginId, enabled] of Object.entries(values)) {
      effective.set(pluginId, {
        enabled,
        scope: layer.scope ?? "user",
      });
    }
  }
  return {
    enabled: new Set(
      [...effective].filter(([, value]) => value.enabled).map(([pluginId]) => pluginId),
    ),
    bySource: new Map(
      [...effective]
        .filter(([, value]) => value.enabled)
        .map(([pluginId, value]) => [pluginId, value.scope]),
    ),
  };
}

export function mergeEnableScopes(scopesInOrder) {
  return mergeEnableState(scopesInOrder).enabled;
}

export function shouldRunExecutable({ enableScope, folderTrusted }) {
  return enableScope === "user" || folderTrusted === true;
}

/**
 * The returned state is a new value. Callers persist it through a locked
 * temp-file+rename transaction; if any validation throws, the input remains
 * unchanged and therefore acts as the rollback state.
 */
export function commitInstallTransaction(state, request) {
  authorizePluginInstall(request.preview, request.authorization);
  const next = structuredClone(state);
  const {
    pluginId,
    name,
    marketplace,
    version,
    installPath,
    scope,
    cwd,
    now,
  } = request;
  if (
    !isExactManagedPluginPath(request.cacheRoot, installPath, {
      marketplace,
      name,
      version,
    })
  ) {
    throw new Error("refusing to persist an install outside its exact cache slot");
  }

  const prior = next.installedPlugins[pluginId];
  const priorOwners = prior?.installations ?? [];
  next.installedPlugins[pluginId] = {
    pluginId,
    name,
    marketplace,
    version,
    installPath,
    installedAt: prior?.installedAt ?? now,
    updatedAt: now,
    installations: upsertInstallationScope(priorOwners, scope, cwd, now),
  };

  let layer = next.enableScopes.find(
    (candidate) =>
      candidate.scope === scope &&
      (scope === "user" || path.resolve(candidate.cwd ?? "") === path.resolve(cwd)),
  );
  if (!layer) {
    layer = {
      scope,
      ...(scope === "user" ? {} : { cwd: path.resolve(cwd) }),
      values: {},
    };
    next.enableScopes.push(layer);
  }
  layer.values[pluginId] = true;
  return next;
}

export function uninstallScopeTransaction(state, request) {
  const record = state.installedPlugins[request.pluginId];
  if (!record) return { state: structuredClone(state), deleteCachePath: null };
  if (
    !isExactManagedPluginPath(request.cacheRoot, record.installPath, record)
  ) {
    throw new Error("refusing to delete a non-canonical plugin cache path");
  }

  const next = structuredClone(state);
  const current = next.installedPlugins[request.pluginId];
  current.installations = removeInstallationScope(
    current.installations ?? [],
    request.scope,
    request.cwd,
  );
  const layer = next.enableScopes.find(
    (candidate) =>
      candidate.scope === request.scope &&
      (request.scope === "user" ||
        path.resolve(candidate.cwd ?? "") === path.resolve(request.cwd)),
  );
  if (layer) layer.values[request.pluginId] = false;

  if (current.installations.length > 0) {
    return { state: next, deleteCachePath: null };
  }
  delete next.installedPlugins[request.pluginId];
  return { state: next, deleteCachePath: record.installPath };
}

// -----------------------------------------------------------------------------
// 6. Prospective runtime snapshot and deterministic conflicts
// -----------------------------------------------------------------------------

export function findPublicNameConflicts(skillNames, commandNames) {
  const skills = new Set(skillNames);
  return commandNames.filter((name) => skills.has(name));
}

function normalizeComponents(plugin) {
  const components = plugin.components ?? {};
  return {
    skills: (components.skills ?? []).map((name) => applyNamespace(plugin.name, name)),
    agents: (components.agents ?? []).map((name) => applyNamespace(plugin.name, name)),
    commands: (components.commands ?? []).map((name) => applyNamespace(plugin.name, name)),
    outputStyles: (components.outputStyles ?? []).map((name) =>
      applyNamespace(plugin.name, name),
    ),
    hooks: [...(components.hooks ?? [])],
    mcpServers: (components.mcpServers ?? []).map((name) =>
      mcpServerNamespace(plugin.name, name),
    ),
  };
}

/**
 * Startup/reload consults only installed records + version cache packages.
 * Marketplace catalogs are intentionally absent, so offline startup cannot
 * perform clone/fetch and removing a marketplace does not break installed code.
 */
export function prepareRuntimeSnapshot({
  installedPlugins,
  packagesByPath,
  enableScopes,
  folderTrusted,
  devPlugins = [],
}) {
  const { enabled, bySource } = mergeEnableState(enableScopes);
  const pluginsByName = new Map();
  const errors = [];

  for (const pluginId of [...enabled].sort()) {
    const record = installedPlugins[pluginId];
    if (!record) {
      errors.push({
        pluginId,
        scope: "io",
        message: "enabled but missing an installation record",
      });
      continue;
    }
    const plugin = packagesByPath[record.installPath];
    if (!plugin) {
      errors.push({
        pluginId,
        scope: "io",
        message: "installed cache package is missing",
      });
      continue;
    }
    const conflict = findPublicNameConflicts(
      plugin.components?.skills ?? [],
      plugin.components?.commands ?? [],
    );
    if (conflict.length > 0) {
      errors.push({
        pluginId,
        scope: "manifest",
        message: `Skill/Command name conflict: ${conflict.join(", ")}`,
      });
      continue;
    }
    const previous = pluginsByName.get(plugin.name);
    if (previous) {
      errors.push({
        pluginId,
        scope: "manifest",
        message: `Plugin name "${plugin.name}" conflicts with ${previous.pluginId}`,
      });
      continue;
    }
    pluginsByName.set(plugin.name, {
      ...plugin,
      pluginId,
      trusted: shouldRunExecutable({
        enableScope: bySource.get(pluginId),
        folderTrusted,
      }),
    });
  }

  // Explicit --plugin-dir roots override installed packages with the same
  // manifest name and are trusted for this process only.
  for (const plugin of [...devPlugins].sort((a, b) =>
    a.pluginId.localeCompare(b.pluginId))) {
    const previous = pluginsByName.get(plugin.name);
    if (previous) {
      errors.push({
        pluginId: previous.pluginId,
        scope: "manifest",
        message: `Overridden by development plugin ${plugin.pluginId}`,
      });
    }
    pluginsByName.set(plugin.name, { ...plugin, trusted: true });
  }

  const active = [...pluginsByName.values()];
  const registries = {
    skills: [],
    agents: [],
    commands: [],
    outputStyles: [],
    hooks: [],
    mcpServers: [],
  };
  for (const plugin of active) {
    const components = normalizeComponents(plugin);
    registries.skills.push(...components.skills);
    registries.agents.push(...components.agents);
    registries.commands.push(...components.commands);
    registries.outputStyles.push(...components.outputStyles);
    if (plugin.trusted) {
      registries.hooks.push(...components.hooks);
      registries.mcpServers.push(...components.mcpServers);
    }
  }

  return {
    plugins: active,
    registries,
    errors,
    summary: {
      enabledPlugins: active.length,
      disabledPlugins: Object.keys(installedPlugins).filter(
        (pluginId) => !enabled.has(pluginId),
      ).length,
      skills: registries.skills.length,
      agents: registries.agents.length,
      commands: registries.commands.length,
      outputStyles: registries.outputStyles.length,
      hooks: registries.hooks.length,
      mcpServers: registries.mcpServers.length,
      errors: errors.length,
    },
  };
}

/** A failed candidate build keeps the previous snapshot as last-known-good. */
export function atomicRefresh(currentSnapshot, buildCandidate) {
  try {
    return {
      snapshot: buildCandidate(),
      keptLastKnownGood: false,
      error: null,
    };
  } catch (error) {
    return {
      snapshot: currentSnapshot,
      keptLastKnownGood: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// -----------------------------------------------------------------------------
// 7. MCP diff, cleanup, and reload generations
// -----------------------------------------------------------------------------

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function diffMcpServers(applied, desired) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, config] of desired) {
    const previous = applied.get(name);
    if (!previous) added.push(name);
    else if (canonicalJson(previous) !== canonicalJson(config)) changed.push(name);
  }
  for (const name of applied.keys()) {
    if (!desired.has(name)) removed.push(name);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

export function isCurrentGeneration(candidate, current) {
  return candidate === current;
}

/**
 * Removed/changed servers stop first. Added/changed connections may resolve in
 * parallel, but a stale generation is immediately cleaned and never registered.
 */
export async function applyMcpGeneration({
  applied,
  desired,
  registry,
  generation,
  isCurrent,
  connect,
  disconnect,
}) {
  const diff = diffMcpServers(applied, desired);
  const stopped = [...diff.removed, ...diff.changed].sort();
  await Promise.all(
    stopped.map(async (name) => {
      await disconnect(name);
      if (isCurrent(generation)) registry.delete(name);
    }),
  );

  const started = [];
  await Promise.all(
    [...diff.added, ...diff.changed].sort().map(async (name) => {
      const connection = await connect(name, desired.get(name));
      if (!isCurrent(generation)) {
        await connection.cleanup();
        return;
      }
      registry.set(name, connection);
      started.push(name);
    }),
  );
  return { started: started.sort(), stopped, diff };
}

// -----------------------------------------------------------------------------
// 8. Progressive command palette and async feedback
// -----------------------------------------------------------------------------

const PLUGIN_ACTIONS = [
  ["install", true],
  ["list", false],
  ["marketplace", true],
  ["enable", true],
  ["disable", true],
  ["update", true],
  ["uninstall", true],
  ["validate", true],
  ["reload", false],
];

const MARKETPLACE_ACTIONS = [
  ["add", true],
  ["list", false],
  ["update", true],
  ["remove", true],
];

function commandRows(prefix, actions, partial) {
  return actions
    .filter(([token]) => token.startsWith(partial.toLowerCase()))
    .map(([token, completionOnly]) => ({
      command: `${prefix} ${token}`,
      completionOnly,
    }));
}

export function pluginCommandSuggestions(input) {
  if (!String(input).startsWith("/")) return null;
  const trailingSpace = /\s$/.test(input);
  const tokens = String(input).trim().split(/\s+/);
  const root = (tokens[0] ?? "").toLowerCase();

  if (root === "/marketplace") {
    if (tokens.length === 1) {
      return trailingSpace ? commandRows(root, MARKETPLACE_ACTIONS, "") : null;
    }
    if (tokens.length === 2 && !trailingSpace) {
      return commandRows(root, MARKETPLACE_ACTIONS, tokens[1] ?? "");
    }
    return [];
  }

  if (root !== "/plugin" && root !== "/plugins") return null;
  if (tokens.length === 1) {
    return trailingSpace ? commandRows(root, PLUGIN_ACTIONS, "") : null;
  }
  if (tokens.length === 2 && !trailingSpace) {
    return commandRows(root, PLUGIN_ACTIONS, tokens[1] ?? "");
  }
  if (["marketplace", "market"].includes((tokens[1] ?? "").toLowerCase())) {
    const prefix = `${root} ${tokens[1]}`;
    if (tokens.length === 2 && trailingSpace) {
      return commandRows(prefix, MARKETPLACE_ACTIONS, "");
    }
    if (tokens.length === 3 && !trailingSpace) {
      return commandRows(prefix, MARKETPLACE_ACTIONS, tokens[2] ?? "");
    }
  }
  return [];
}

export async function* runPluginOperation(title, work) {
  yield {
    type: "command_progress",
    title,
    message: `${title}…`,
    spinnerLabel: title,
  };
  try {
    const message = await work();
    yield { type: "command", kind: "info", message };
  } catch (error) {
    yield {
      type: "command",
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// -----------------------------------------------------------------------------
// 9. Runnable milestone demo
// -----------------------------------------------------------------------------

export async function demoStep35() {
  const cacheRoot = path.resolve("/tmp/easy-agent/plugins/cache");
  const projectCwd = path.resolve("/work/review-app");
  const marketplace = {
    name: "team-tools",
    root: path.resolve("/catalog/team-tools"),
    plugins: [
      {
        name: "review",
        version: "1.0.0",
        source: "./plugins/review",
      },
    ],
  };
  const entry = marketplace.plugins[0];
  const pluginId = `${entry.name}@${marketplace.name}`;
  const version = resolveVersion({ entryVersion: entry.version });
  const installPath = getPluginCachePath(
    cacheRoot,
    marketplace.name,
    entry.name,
    version,
  );
  const tree = [
    { type: "file", path: ".easy-agent-plugin/plugin.json", content: "{}" },
    { type: "file", path: "skills/review/SKILL.md", content: "Review $ARGUMENTS" },
    { type: "file", path: "hooks/hooks.json", content: '{"PreToolUse":[]}' },
    { type: "file", path: ".mcp.json", content: '{"local":{"command":"node"}}' },
  ];
  const components = {
    skills: ["review"],
    agents: ["reviewer"],
    commands: ["review-pr"],
    outputStyles: ["review-notes"],
    hooks: ["PreToolUse:Bash"],
    mcpServers: ["local"],
  };
  const preview = createInstallPreview({
    pluginId,
    version,
    tree,
    components,
  });
  const initialState = {
    installedPlugins: {},
    enableScopes: [
      { scope: "user", values: {} },
      { scope: "project", cwd: projectCwd, values: {} },
      { scope: "local", cwd: projectCwd, values: {} },
    ],
  };

  // A changed package cannot mutate state because authorization runs before
  // the transaction draft is returned.
  let fingerprintRejected = false;
  try {
    commitInstallTransaction(initialState, {
      cacheRoot,
      pluginId,
      name: entry.name,
      marketplace: marketplace.name,
      version,
      installPath,
      scope: "project",
      cwd: projectCwd,
      now: "2026-07-26T00:00:00.000Z",
      preview,
      authorization: {
        allowExecutableComponents: true,
        expectedFingerprint: "changed-after-confirmation",
      },
    });
  } catch {
    fingerprintRejected = true;
  }

  const installedState = commitInstallTransaction(initialState, {
    cacheRoot,
    pluginId,
    name: entry.name,
    marketplace: marketplace.name,
    version,
    installPath,
    scope: "project",
    cwd: projectCwd,
    now: "2026-07-26T00:00:00.000Z",
    preview,
    authorization: {
      allowExecutableComponents: true,
      expectedFingerprint: preview.fingerprint,
    },
  });
  const multiScopeState = commitInstallTransaction(installedState, {
    cacheRoot,
    pluginId,
    name: entry.name,
    marketplace: marketplace.name,
    version,
    installPath,
    scope: "user",
    cwd: projectCwd,
    now: "2026-07-26T00:01:00.000Z",
    preview,
    authorization: {
      allowExecutableComponents: true,
      expectedFingerprint: preview.fingerprint,
    },
  });
  const afterProjectUninstall = uninstallScopeTransaction(multiScopeState, {
    cacheRoot,
    pluginId,
    scope: "project",
    cwd: projectCwd,
  });
  const packagesByPath = {
    [installPath]: {
      pluginId,
      name: entry.name,
      version,
      components,
    },
  };

  // Untrusted project scope loads prompt components but not local processes.
  const untrusted = prepareRuntimeSnapshot({
    installedPlugins: installedState.installedPlugins,
    packagesByPath,
    enableScopes: installedState.enableScopes,
    folderTrusted: false,
  });
  const trusted = prepareRuntimeSnapshot({
    installedPlugins: installedState.installedPlugins,
    packagesByPath,
    enableScopes: installedState.enableScopes,
    folderTrusted: true,
  });

  // A late generation-1 MCP connection is cleaned after generation 2 wins.
  let currentGeneration = 1;
  let staleConnectionCleaned = false;
  const registry = new Map();
  const lateApply = applyMcpGeneration({
    applied: new Map(),
    desired: new Map([["plugin:review:local", { command: "node" }]]),
    registry,
    generation: 1,
    isCurrent: (generation) => generation === currentGeneration,
    connect: async () => {
      await Promise.resolve();
      currentGeneration = 2;
      return {
        async cleanup() {
          staleConnectionCleaned = true;
        },
      };
    },
    disconnect: async () => {},
  });
  await lateApply;

  const operationEvents = [];
  for await (const event of runPluginOperation(
    "Adding marketplace",
    async () => "Marketplace added: team-tools",
  )) {
    operationEvents.push(event.type);
  }

  return {
    pluginId,
    source: toPluginSource(entry, marketplace.root),
    cachePath: installPath,
    installed: installedState.installedPlugins[pluginId] !== undefined,
    multiScopeCachePreserved:
      afterProjectUninstall.state.installedPlugins[pluginId] !== undefined &&
      afterProjectUninstall.deleteCachePath === null,
    discoverCountAfterInstall: listAvailablePlugins(
      [marketplace],
      installedState.installedPlugins,
    ).length,
    fingerprintRejectedWithoutMutation:
      fingerprintRejected && Object.keys(initialState.installedPlugins).length === 0,
    untrustedPromptComponents: untrusted.summary.skills,
    untrustedExecutableComponents:
      untrusted.summary.hooks + untrusted.summary.mcpServers,
    trustedExecutableComponents: trusted.summary.hooks + trusted.summary.mcpServers,
    namespacedSkill: trusted.registries.skills[0],
    exactDeleteBoundary: isExactManagedPluginPath(
      cacheRoot,
      installPath,
      installedState.installedPlugins[pluginId],
    ),
    staleConnectionCleaned,
    staleConnectionRegistered: registry.size > 0,
    marketplaceSuggestions: pluginCommandSuggestions("/plugin marketplace ").map(
      (row) => row.command,
    ),
    operationEvents,
  };
}

export function verifyStep35(result) {
  const checks = {
    installed: result.installed === true,
    installedIsNotDiscoverable: result.discoverCountAfterInstall === 0,
    fingerprintPreventsMutation: result.fingerprintRejectedWithoutMutation === true,
    multiScopeCacheOwnership: result.multiScopeCachePreserved === true,
    untrustedPromptStillLoads: result.untrustedPromptComponents === 1,
    untrustedExecutablesAreGated: result.untrustedExecutableComponents === 0,
    trustedExecutablesRun: result.trustedExecutableComponents === 2,
    namespaceApplied: result.namespacedSkill === "review:review",
    deletionIsExact: result.exactDeleteBoundary === true,
    staleMcpIsCleaned:
      result.staleConnectionCleaned === true &&
      result.staleConnectionRegistered === false,
    progressiveCommandFeedback:
      result.operationEvents.join(",") === "command_progress,command",
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Step 35 verification failed: ${failed.join(", ")}`);
  }
  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoStep35()
    .then((result) => {
      verifyStep35(result);
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
