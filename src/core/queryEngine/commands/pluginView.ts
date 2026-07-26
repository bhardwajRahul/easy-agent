/**
 * Snapshot builder for the interactive `/plugin` manager (plan §35.6).
 *
 * Mirrors the four tabs the source's PluginSettings drives — Discover /
 * Installed / Marketplaces / Errors — by turning the three separate pieces of
 * durable state (marketplace sources, install records, per-scope enable flags)
 * plus the live runtime snapshot into one flat, render-ready payload.
 *
 * Read-only: this never mutates state, so the overlay can rebuild it after
 * every action to stay in sync.
 */

import {
  getActivePluginErrors,
  getActivePlugins,
  getEnabledPluginState,
  listMarketplaces,
  readInstalledPlugins,
  readMarketplaceManifest,
} from "../../../plugins/index.js";
import { isProjectTrusted } from "../../../config/globalState.js";
import type { PluginScope } from "../../../plugins/index.js";
import type {
  PluginAvailableRow,
  PluginComponentCounts,
  PluginInstalledRow,
  PluginMarketplaceRow,
  PluginViewData,
} from "../types.js";

/**
 * `bySource` reports any settings layer (including `flag` / `policy`), but only
 * the three writable layers are addressable as a plugin scope.
 */
const WRITABLE_SCOPES = new Set<string>(["user", "project", "local"]);
function asPluginScope(source: string | undefined): PluginScope | undefined {
  return source !== undefined && WRITABLE_SCOPES.has(source)
    ? (source as PluginScope)
    : undefined;
}

const EMPTY_COUNTS: PluginComponentCounts = {
  skills: 0,
  agents: 0,
  commands: 0,
  outputStyles: 0,
  hooks: 0,
  mcpServers: 0,
};

export async function buildPluginView(cwd: string): Promise<PluginViewData> {
  const [installedFile, enableState, marketplaces, trusted] = await Promise.all([
    readInstalledPlugins(),
    getEnabledPluginState(cwd),
    listMarketplaces(),
    isProjectTrusted(cwd),
  ]);

  // Component counts + per-plugin errors only exist for plugins the runtime
  // actually loaded (i.e. currently enabled); a disabled plugin reports zeros.
  const active = new Map(getActivePlugins().map((p) => [p.pluginId, p]));

  const installed: PluginInstalledRow[] = Object.values(installedFile.plugins)
    .map((record) => {
      const loaded = active.get(record.pluginId);
      const source = enableState.bySource.get(record.pluginId);
      const scope = asPluginScope(source);
      return {
        pluginId: record.pluginId,
        name: record.name,
        marketplace: record.marketplace,
        version: record.version,
        enabled: enableState.enabled.has(record.pluginId),
        ...(scope ? { scope } : {}),
        components: loaded
          ? {
              skills: loaded.skills.length,
              agents: loaded.agents.length,
              commands: loaded.commands.length,
              outputStyles: loaded.outputStyles.length,
              hooks: loaded.hooks.length,
              mcpServers: loaded.mcpServers.length,
            }
          : { ...EMPTY_COUNTS },
        errorCount: loaded?.errors.length ?? 0,
        // Same rule the runtime applies: user-scope enable is the machine
        // owner's own call and always runs; anything else needs folder trust.
        executablesTrusted: source === "user" ? true : trusted,
      };
    })
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));

  const installedIds = new Set(installed.map((p) => p.pluginId));

  // ── Marketplaces + the catalogued-but-not-installed set ──
  const marketplaceRows: PluginMarketplaceRow[] = [];
  const available: PluginAvailableRow[] = [];
  for (const entry of marketplaces) {
    let pluginCount: number | null = null;
    let readError: string | undefined;
    try {
      const { manifest } = await readMarketplaceManifest(entry.installLocation);
      pluginCount = manifest.plugins.length;
      for (const plugin of manifest.plugins) {
        const pluginId = `${plugin.name}@${entry.name}`;
        if (installedIds.has(pluginId)) continue;
        available.push({
          pluginId,
          name: plugin.name,
          marketplace: entry.name,
          ...(plugin.description ? { description: plugin.description } : {}),
          ...(plugin.version ? { version: plugin.version } : {}),
        });
      }
    } catch (error) {
      readError = (error as Error).message;
    }
    marketplaceRows.push({
      name: entry.name,
      kind: entry.source.kind,
      location: entry.installLocation,
      lastUpdated: entry.lastUpdated,
      pluginCount,
      ...(readError ? { error: readError } : {}),
    });
  }

  available.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  marketplaceRows.sort((a, b) => a.name.localeCompare(b.name));

  return {
    installed,
    available,
    marketplaces: marketplaceRows,
    errors: getActivePluginErrors().map((e) => ({
      pluginId: e.pluginId,
      scope: e.scope,
      message: e.message,
    })),
  };
}
