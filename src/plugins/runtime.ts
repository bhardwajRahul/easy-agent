/**
 * Plugin Runtime (plan §35.7).
 *
 * The single orchestrator that turns "which plugins are installed + enabled"
 * into live registry state. It owns registry population for the four
 * markdown-based subsystems (skills / agents / commands / output styles) so it
 * can layer plugin components on top of the built-in + user + project base in a
 * single, idempotent pass — call `refreshActivePlugins(cwd)` again any time
 * (install / enable / disable / update) and the registries converge to match.
 *
 * Component precedence (plan §35.2):
 *   built-in  →  plugin  →  user  →  project      (later wins on bare-name
 * collisions). In practice plugin components are namespaced (`plugin:foo`) so
 * they never collide with a user/project component — the ordering only matters
 * for the theoretical un-namespaced case.
 *
 * Executable components (hooks / MCP servers) are TRUST-GATED: a plugin enabled
 * only via project/local scope in an untrusted folder contributes its prompt
 * components but NOT its hooks/MCP, mirroring how project hooks + statusLine are
 * gated. A user-scope-enabled plugin is the user's own machine-level choice and
 * always runs.
 */

import { loadAllSkills } from "../services/skills/loadSkillsDir.js";
import { setSkills } from "../services/skills/registry.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { loadAllCustomAgents } from "../agents/loadAgentsDir.js";
import { setAgents } from "../agents/registry.js";
import { loadAllUserCommands } from "../commands/userCommands/loadCommandsDir.js";
import { setUserCommands } from "../commands/userCommands/registry.js";
import { loadAllOutputStyles } from "../styles/loadOutputStylesDir.js";
import { setCustomOutputStyles } from "../styles/registry.js";
import { isProjectTrusted } from "../config/globalState.js";
import type { HooksSettings } from "../hooks/types.js";
import type { ScopedMcpServerConfig } from "../types/mcp.js";
import { readInstalledPlugins } from "./state.js";
import { getEnabledPluginState } from "./enable.js";
import { loadPlugin } from "./loader.js";
import { applyPluginMcpDiff } from "./mcpApply.js";
import type { LoadedPlugin } from "./loadedTypes.js";
import type { PluginError } from "./schemas.js";

export interface RefreshOptions {
  /** Extra dev plugin roots from `--plugin-dir` (lenient, always trusted). */
  pluginDirs?: string[];
  /** Skip the (network/subprocess) MCP apply — used by headless tests. */
  applyMcp?: boolean;
}

export interface RefreshResult {
  plugins: LoadedPlugin[];
  errors: PluginError[];
  /** Namespaced MCP server ids that were (re)started this refresh. */
  mcpStarted: string[];
  /** Namespaced MCP server ids that were torn down this refresh. */
  mcpStopped: string[];
}

// ─── module state ─────────────────────────────────────────────────────

let activePlugins: LoadedPlugin[] = [];
let activeErrors: PluginError[] = [];
let activeHooks: HooksSettings = {};

/** Snapshot of the plugin MCP configs currently applied (namespaced name → cfg). */
let appliedMcp = new Map<string, ScopedMcpServerConfig>();

export function getActivePlugins(): LoadedPlugin[] {
  return activePlugins;
}

export function getActivePluginErrors(): PluginError[] {
  return activeErrors;
}

/** Plugin-contributed hooks, in the same shape the hook executor consumes. */
export function getActivePluginHooks(): HooksSettings {
  return activeHooks;
}

/** Test seam: forget all applied plugin state (does NOT touch registries). */
export function _resetPluginRuntimeForTesting(): void {
  activePlugins = [];
  activeErrors = [];
  activeHooks = {};
  appliedMcp = new Map();
}

// ─── discovery ────────────────────────────────────────────────────────

/**
 * Load every enabled + installed plugin plus any `--plugin-dir` dev roots.
 * A single plugin that fails to load contributes its `errors` but never aborts
 * the others (plan §35.2 fail-soft).
 */
async function discoverPlugins(cwd: string, pluginDirs: string[]): Promise<{
  plugins: LoadedPlugin[];
  trustedById: Map<string, boolean>;
}> {
  const trusted = await isProjectTrusted(cwd);
  const { enabled, bySource } = await getEnabledPluginState(cwd);
  const installed = (await readInstalledPlugins()).plugins;

  const plugins: LoadedPlugin[] = [];
  const trustedById = new Map<string, boolean>();

  for (const pluginId of enabled) {
    const record = installed[pluginId];
    if (!record) continue; // enabled but not installed → silently skip
    try {
      // Replay the load options captured at install time, so a plugin whose
      // identity/layout is described by its marketplace still resolves after a
      // restart (or after that marketplace has been removed).
      const loaded = await loadPlugin({
        root: record.installPath,
        pluginId,
        strict: record.strict !== false,
        nameHint: record.name,
        ...(record.componentPaths ? { overlay: record.componentPaths } : {}),
      });
      plugins.push(loaded);
      // user-scope enable → always trusted; project/local → gated by folder trust.
      const scope = bySource.get(pluginId);
      trustedById.set(pluginId, scope === "user" ? true : trusted);
    } catch (error) {
      activeErrors.push({ pluginId, scope: "io", message: (error as Error).message });
    }
  }

  // Dev plugin dirs: lenient manifest, always fully trusted (explicit CLI flag).
  for (const dir of pluginDirs) {
    const pluginId = `${devName(dir)}@dev`;
    try {
      const loaded = await loadPlugin({ root: dir, pluginId, strict: false });
      plugins.push(loaded);
      trustedById.set(pluginId, true);
    } catch (error) {
      activeErrors.push({ pluginId, scope: "io", message: (error as Error).message });
    }
  }

  return { plugins, trustedById };
}

function devName(dir: string): string {
  const base = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "plugin";
  return base.replace(/[^a-zA-Z0-9_-]/g, "-") || "plugin";
}

// ─── apply ────────────────────────────────────────────────────────────

/**
 * Reconcile the live registries with the current install/enable state. Safe to
 * call repeatedly. Returns the loaded plugins + a summary of MCP churn.
 */
export async function refreshActivePlugins(
  cwd: string,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  activeErrors = [];
  const { plugins, trustedById } = await discoverPlugins(cwd, opts.pluginDirs ?? []);
  activePlugins = plugins;
  for (const p of plugins) activeErrors.push(...p.errors);

  // ── Base (built-in + user + project) reloaded fresh each time ──
  const [baseSkills, customAgents, baseCommands, baseStyles] = await Promise.all([
    loadAllSkills(cwd),
    loadAllCustomAgents(cwd),
    loadAllUserCommands(cwd),
    loadAllOutputStyles(cwd),
  ]);

  // ── Merge plugin components on top (namespaced → no real collisions) ──
  const pluginSkills = plugins.flatMap((p) => p.skills);
  const pluginAgents = plugins.flatMap((p) => p.agents);
  const pluginCommands = plugins.flatMap((p) => p.commands);
  const pluginStyles = plugins.flatMap((p) => p.outputStyles);

  setSkills([...pluginSkills, ...baseSkills.skills]);
  setAgents([...getBuiltInAgents(), ...pluginAgents, ...customAgents.agents]);
  setUserCommands([...pluginCommands, ...baseCommands.commands]);
  setCustomOutputStyles([...pluginStyles, ...baseStyles.styles]);

  // ── Executable components (trust-gated) ──
  activeHooks = buildPluginHooksSettings(plugins, trustedById);

  const desiredMcp = new Map<string, ScopedMcpServerConfig>();
  for (const p of plugins) {
    if (!trustedById.get(p.pluginId)) continue;
    for (const server of p.mcpServers) {
      desiredMcp.set(server.namespacedName, server.config);
    }
  }

  let mcpStarted: string[] = [];
  let mcpStopped: string[] = [];
  if (opts.applyMcp !== false) {
    const churn = await applyPluginMcpDiff(appliedMcp, desiredMcp);
    mcpStarted = churn.started;
    mcpStopped = churn.stopped;
    // Only record the applied snapshot when we actually reconciled processes —
    // a prompt-only refresh (applyMcp:false) must leave the prior snapshot so a
    // later real apply still sees these servers as "to start".
    appliedMcp = desiredMcp;
  }

  return { plugins, errors: activeErrors, mcpStarted, mcpStopped };
}

/** Collect trust-gated plugin hooks into the executor's HooksSettings shape. */
function buildPluginHooksSettings(
  plugins: LoadedPlugin[],
  trustedById: Map<string, boolean>,
): HooksSettings {
  const settings: HooksSettings = {};
  for (const p of plugins) {
    if (!trustedById.get(p.pluginId)) continue;
    for (const entry of p.hooks) {
      const groups = settings[entry.event] ?? (settings[entry.event] = []);
      groups.push({ hooks: entry.hooks, ...(entry.matcher ? { matcher: entry.matcher } : {}) });
    }
  }
  return settings;
}
