/**
 * Install / update / uninstall (plan §35.5).
 *
 * Install pipeline (fixed order — safety depends on it):
 *   resolve id → fetch to a TEMP dir → validate manifest/paths/components →
 *   compute version → copy into a version-locked cache dir → atomically update
 *   the install record → enable in the requested scope.
 *
 * Everything before the record update is reversible: a failure deletes the temp
 * (and any half-copied cache dir) and leaves `installed_plugins.json` untouched,
 * so a broken download can never pollute state or leave a loadable half-plugin
 * on disk.
 *
 * Delete safety: uninstall only ever removes a directory it can prove lives
 * under `~/.easy-agent/plugins/cache/`. Local marketplaces, `--plugin-dir`
 * checkouts and external source directories are never deleted.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getPluginCacheDir,
  getPluginDataDir,
  getPluginsRoot,
} from "./paths.js";
import {
  componentPathsFromEntry,
  resolvePlugin,
  type ResolvedPluginEntry,
} from "./marketplace.js";
import { gitClone, gitHeadCommit } from "./git.js";
import { loadPlugin } from "./loader.js";
import {
  readInstalledPlugins,
  removeInstalledPlugin,
  updateInstalledPlugins,
  upsertInstalledPlugin,
} from "./state.js";
import { setPluginEnabled } from "./enable.js";
import type { InstalledPluginRecord, PluginScope } from "./schemas.js";
import type { LoadedPlugin } from "./loadedTypes.js";

export interface InstallResult {
  record: InstalledPluginRecord;
  loaded: LoadedPlugin;
  /** True when hooks/MCP were present and require folder trust to run. */
  requiresTrust: boolean;
}

async function makeTempDir(label: string): Promise<string> {
  const dir = path.join(getPluginsRoot(), ".tmp", `${label}-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Copy a directory tree; the temp form is same-filesystem so rename is atomic. */
async function copyTree(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, dereference: false });
}

async function fetchToTemp(
  pluginSource: ResolvedPluginEntry["pluginSource"],
): Promise<{ dir: string; commit?: string }> {
  const dir = await makeTempDir("fetch");
  if (pluginSource.kind === "local") {
    // Copy INTO an empty dir (fs.cp needs the dest to not pre-exist as a file).
    await fs.rm(dir, { recursive: true, force: true });
    await fs.cp(pluginSource.path, dir, { recursive: true, dereference: false });
    return { dir };
  }
  // Git: clone into a fresh dir (gitClone requires dest to not exist).
  await fs.rm(dir, { recursive: true, force: true });
  await gitClone(pluginSource.url, dir, pluginSource.ref);
  const commit = await gitHeadCommit(dir);
  return { dir, ...(commit ? { commit } : {}) };
}

/**
 * Version priority: plugin.json → marketplace entry → git SHA → "unknown".
 *
 * The SHA may come from the plugin's own clone or, for a plugin sourced as a
 * path inside a Git marketplace, from that marketplace's checkout — without it
 * such a plugin would install under the literal directory "unknown" and lose
 * version locking entirely.
 */
function resolveVersion(
  loaded: LoadedPlugin,
  entryVersion: string | undefined,
  commit: string | undefined,
): string {
  if (loaded.manifest.version && loaded.manifest.version !== "unknown") {
    return loaded.manifest.version;
  }
  if (entryVersion) return entryVersion;
  if (commit) return commit;
  return "unknown";
}

function hasFatalManifestError(loaded: LoadedPlugin): boolean {
  return loaded.errors.some((e) => e.scope === "manifest");
}

/**
 * Install (or reinstall) a plugin referenced as `name` or `name@marketplace`
 * and enable it in `scope`. Returns the install record + the loaded snapshot
 * (so the caller can display the component manifest / trust prompt).
 */
export async function installPlugin(
  pluginRef: string,
  scope: PluginScope = "user",
): Promise<InstallResult> {
  const resolved = await resolvePlugin(pluginRef);
  const pluginId = `${resolved.entry.name}@${resolved.marketplace.name}`;

  // A catalog entry may opt out of requiring `plugin.json` and describe the
  // component layout itself; both are needed on every later load, so they are
  // resolved once here and persisted with the install record.
  const strict = resolved.entry.strict !== false;
  const componentPaths = componentPathsFromEntry(resolved.entry);
  const loadOpts = {
    pluginId,
    strict,
    nameHint: resolved.entry.name,
    overlay: componentPaths,
  };

  const { dir: tempDir, commit: sourceCommit } = await fetchToTemp(resolved.pluginSource);
  // A plugin living inside a Git marketplace has no clone of its own, so fall
  // back to the marketplace checkout's HEAD to keep the install version-locked.
  const commit =
    sourceCommit ??
    (resolved.marketplace.source.kind === "git"
      ? await gitHeadCommit(resolved.marketplace.installLocation)
      : undefined);
  let installPath: string | null = null;
  try {
    const loaded = await loadPlugin({ root: tempDir, ...loadOpts });
    if (hasFatalManifestError(loaded)) {
      throw new Error(
        `plugin validation failed: ${loaded.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const version = resolveVersion(loaded, resolved.entry.version, commit);
    installPath = getPluginCacheDir(resolved.marketplace.name, resolved.entry.name, version);

    // Copy into the version-locked cache via a pending dir, then swap.
    const pending = `${installPath}.pending-${process.pid}-${Date.now()}`;
    await copyTree(tempDir, pending);
    await fs.rm(installPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(installPath), { recursive: true });
    await fs.rename(pending, installPath);

    // Re-load from the final path so the record + snapshot reflect real paths.
    const finalLoaded = await loadPlugin({ root: installPath, ...loadOpts });
    await fs.mkdir(getPluginDataDir(pluginId), { recursive: true });

    const now = new Date().toISOString();
    const prior = (await readInstalledPlugins()).plugins[pluginId];
    const record: InstalledPluginRecord = {
      pluginId,
      name: resolved.entry.name,
      marketplace: resolved.marketplace.name,
      version,
      ...(commit ? { commit } : {}),
      installPath,
      installedAt: prior?.installedAt ?? now,
      updatedAt: now,
      ...(strict ? {} : { strict: false }),
      ...(Object.keys(componentPaths).length > 0 ? { componentPaths } : {}),
    };
    await updateInstalledPlugins((draft) => upsertInstalledPlugin(draft, record));

    // Retire a superseded version dir (last-known-good kept until here).
    if (prior && prior.installPath !== installPath) {
      await safeRemoveManagedDir(prior.installPath);
    }

    await setPluginEnabled(process.cwd(), pluginId, true, scope);

    return { record, loaded: finalLoaded, requiresTrust: finalLoaded.hasExecutableComponents };
  } catch (error) {
    // Roll back any half-copied cache dir; install record was never written.
    if (installPath) await fs.rm(installPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Update = reinstall from the marketplace (which may resolve a newer version). */
export async function updatePlugin(
  pluginId: string,
  scope: PluginScope = "user",
): Promise<InstallResult> {
  const installed = (await readInstalledPlugins()).plugins[pluginId];
  if (!installed) throw new Error(`plugin not installed: ${pluginId}`);
  return installPlugin(pluginId, scope);
}

export interface UninstallOptions {
  /** Keep the `~/.easy-agent/plugins/data/<id>` dir (default: delete it). */
  keepData?: boolean;
  scope?: PluginScope;
}

/**
 * Uninstall a plugin: drop the install record, disable it in the scope, and
 * delete ONLY the managed cache version dir. Never deletes user-owned dirs.
 */
export async function uninstallPlugin(
  pluginId: string,
  opts: UninstallOptions = {},
): Promise<void> {
  const installed = (await readInstalledPlugins()).plugins[pluginId];
  if (!installed) throw new Error(`plugin not installed: ${pluginId}`);

  await safeRemoveManagedDir(installed.installPath);
  await updateInstalledPlugins((draft) => removeInstalledPlugin(draft, pluginId));
  await setPluginEnabled(process.cwd(), pluginId, null, opts.scope ?? "user");

  if (!opts.keepData) {
    await safeRemoveManagedDir(getPluginDataDir(pluginId));
  }
}

/** True when `p` resolves inside `~/.easy-agent/plugins/` (the deletable zone). */
export function isManagedPluginPath(p: string): boolean {
  const root = path.resolve(getPluginsRoot());
  const rel = path.relative(root, path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Remove a directory ONLY when it lives under the managed plugins root. */
async function safeRemoveManagedDir(dir: string): Promise<void> {
  if (!isManagedPluginPath(dir)) return; // refuse to delete user-owned paths
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
