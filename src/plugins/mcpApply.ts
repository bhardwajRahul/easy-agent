/**
 * Plugin MCP reconciliation (plan §35.7).
 *
 * A plugin can ship MCP servers, and enabling/disabling/updating a plugin must
 * bring those servers up/down WITHOUT restarting the CLI. This module diffs the
 * previously-applied plugin MCP set against the desired one and:
 *   - starts servers that are new (or whose config changed)
 *   - tears down servers that are gone (or changed) — closing the stdio child
 *     process via the MCP client's `clearServerCache`, so a disabled plugin
 *     never leaks a running `npx ...` subprocess
 * then refreshes the global tool registry so the model's tool list matches.
 *
 * The diff (`diffMcpServers`) is a pure function so it can be unit-tested
 * without spawning anything.
 */

import type { ScopedMcpServerConfig } from "../types/mcp.js";
import {
  clearServerCache,
  connectToServer,
} from "../services/mcp/client.js";
import { fetchToolsForConnection } from "../services/mcp/fetchTools.js";
import {
  deleteMcpRegistryEntry,
  getMcpRegistry,
  setMcpRegistryEntry,
} from "../services/mcp/registry.js";
import { registerMcpTools } from "../tools/index.js";
import { debugLog } from "../utils/log.js";

export interface McpDiff {
  /** In desired but not applied. */
  added: string[];
  /** In applied but not desired. */
  removed: string[];
  /** In both but the config JSON differs. */
  changed: string[];
}

/** Pure set/JSON diff of two namespaced MCP config maps. */
export function diffMcpServers(
  applied: Map<string, ScopedMcpServerConfig>,
  desired: Map<string, ScopedMcpServerConfig>,
): McpDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
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

/** Flatten the MCP registry into the global Tool registry (mirrors bootstrapMcp). */
function refreshGlobalToolRegistry(): void {
  registerMcpTools(getMcpRegistry().flatMap((entry) => entry.tools));
}

/**
 * Apply the diff: tear down removed/changed servers, then (re)connect
 * added/changed ones. Returns the set of namespaced ids that started / stopped.
 */
export async function applyPluginMcpDiff(
  applied: Map<string, ScopedMcpServerConfig>,
  desired: Map<string, ScopedMcpServerConfig>,
): Promise<{ started: string[]; stopped: string[] }> {
  const { added, removed, changed } = diffMcpServers(applied, desired);

  const stopped: string[] = [];
  for (const name of [...removed, ...changed]) {
    const cfg = applied.get(name);
    if (cfg) {
      try {
        await clearServerCache(name, cfg);
      } catch (error) {
        debugLog("plugins", `[mcp] cleanup failed for ${name}: ${(error as Error).message}`);
      }
    }
    deleteMcpRegistryEntry(name);
    stopped.push(name);
  }

  const started: string[] = [];
  for (const name of [...added, ...changed]) {
    const cfg = desired.get(name);
    if (!cfg) continue;
    try {
      const connection = await connectToServer(name, cfg);
      const tools = connection.type === "connected" ? await fetchToolsForConnection(connection) : [];
      setMcpRegistryEntry(name, connection, tools);
    } catch (error) {
      debugLog("plugins", `[mcp] connect failed for ${name}: ${(error as Error).message}`);
    }
    started.push(name);
  }

  refreshGlobalToolRegistry();
  return { started, stopped };
}
