/**
 * Durable state for the plugin subsystem (plan §35.4).
 *
 * Two JSON files under `~/.easy-agent/plugins/` track the two lower layers of
 * the three-layer plugin model (the third — ENABLED per scope — lives in
 * settings.json, see enable.ts):
 *
 *   known_marketplaces.json   ← which marketplace sources are registered
 *   installed_plugins.json    ← which plugin versions are in the local cache
 *
 * Durability contract (plan §35.4/§35.5):
 *   - Every mutation runs inside a process-wide critical section (a
 *     `proper-lockfile` lock on a sentinel in the plugins root) so two
 *     concurrent `install`/`marketplace add` calls can't interleave and
 *     corrupt the file.
 *   - Writes go temp-file → fsync → atomic rename, so a crash mid-write can
 *     never leave a half-written JSON that the next startup would choke on.
 *   - A missing / unparseable / wrong-version file fails soft to an empty
 *     document; we never throw on read so a corrupt state file degrades to
 *     "nothing installed" rather than bricking the CLI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import {
  getInstalledPluginsPath,
  getKnownMarketplacesPath,
  getPluginsRoot,
} from "./paths.js";
import {
  PLUGIN_STATE_VERSION,
  type InstalledPluginRecord,
  type InstalledPluginsFile,
  type KnownMarketplace,
  type KnownMarketplacesFile,
} from "./schemas.js";

// ─── low-level atomic IO ──────────────────────────────────────────────

async function ensurePluginsRoot(): Promise<void> {
  await fs.mkdir(getPluginsRoot(), { recursive: true });
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

async function readJsonSoft<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding the plugins-root lock. The lock target is a sentinel
 * file (`.lock`) we touch first — proper-lockfile refuses to lock a path that
 * doesn't exist. Serializes ALL state mutations across the process.
 */
export async function withPluginStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensurePluginsRoot();
  const sentinel = path.join(getPluginsRoot(), ".lock");
  try {
    await fs.writeFile(sentinel, "", { flag: "wx" });
  } catch {
    // Already exists — fine.
  }
  const release = await lockfile.lock(sentinel, {
    retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 400 },
    stale: 20_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ─── known_marketplaces.json ──────────────────────────────────────────

function emptyMarketplaces(): KnownMarketplacesFile {
  return { version: PLUGIN_STATE_VERSION, marketplaces: {} };
}

export async function readKnownMarketplaces(): Promise<KnownMarketplacesFile> {
  const parsed = await readJsonSoft<KnownMarketplacesFile>(getKnownMarketplacesPath());
  if (!parsed || parsed.version !== PLUGIN_STATE_VERSION || typeof parsed.marketplaces !== "object") {
    return emptyMarketplaces();
  }
  return { version: PLUGIN_STATE_VERSION, marketplaces: parsed.marketplaces ?? {} };
}

/**
 * Read-modify-write the marketplaces file under the state lock. The updater
 * mutates the draft in place; the merged result is written atomically.
 */
export async function updateKnownMarketplaces(
  update: (draft: KnownMarketplacesFile) => void,
): Promise<KnownMarketplacesFile> {
  return withPluginStateLock(async () => {
    const current = await readKnownMarketplaces();
    const draft: KnownMarketplacesFile = {
      version: PLUGIN_STATE_VERSION,
      marketplaces: { ...current.marketplaces },
    };
    update(draft);
    await atomicWriteJson(getKnownMarketplacesPath(), draft);
    return draft;
  });
}

export function upsertMarketplace(
  draft: KnownMarketplacesFile,
  entry: KnownMarketplace,
): void {
  draft.marketplaces[entry.name] = entry;
}

// ─── installed_plugins.json ───────────────────────────────────────────

function emptyInstalled(): InstalledPluginsFile {
  return { version: PLUGIN_STATE_VERSION, plugins: {} };
}

export async function readInstalledPlugins(): Promise<InstalledPluginsFile> {
  const parsed = await readJsonSoft<InstalledPluginsFile>(getInstalledPluginsPath());
  if (!parsed || parsed.version !== PLUGIN_STATE_VERSION || typeof parsed.plugins !== "object") {
    return emptyInstalled();
  }
  return { version: PLUGIN_STATE_VERSION, plugins: parsed.plugins ?? {} };
}

export async function updateInstalledPlugins(
  update: (draft: InstalledPluginsFile) => void,
): Promise<InstalledPluginsFile> {
  return withPluginStateLock(async () => {
    const current = await readInstalledPlugins();
    const draft: InstalledPluginsFile = {
      version: PLUGIN_STATE_VERSION,
      plugins: { ...current.plugins },
    };
    update(draft);
    await atomicWriteJson(getInstalledPluginsPath(), draft);
    return draft;
  });
}

export function upsertInstalledPlugin(
  draft: InstalledPluginsFile,
  record: InstalledPluginRecord,
): void {
  draft.plugins[record.pluginId] = record;
}

export function removeInstalledPlugin(draft: InstalledPluginsFile, pluginId: string): void {
  delete draft.plugins[pluginId];
}
