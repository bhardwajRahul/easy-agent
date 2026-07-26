/**
 * Static Marketplace (plan §35.4).
 *
 * A "marketplace" is NOT an online store — it's a plain `marketplace.json`
 * catalog that lives in a local directory or a Git repo:
 *
 *   my-marketplace/
 *   ├── .easy-agent-plugin/marketplace.json   (or .claude-plugin/)
 *   └── plugins/<plugin>/.easy-agent-plugin/plugin.json   (or .claude-plugin/)
 *
 * Its only job is to resolve a stable id `plugin@marketplace` into a concrete
 * SOURCE (a local `./path` or a Git URL) and an advisory version. Everything
 * else — download, verify, cache, enable, run — happens locally in the CLI.
 *
 * Three source flavours are supported:
 *   - local directory containing `<manifestDir>/marketplace.json`
 *   - local `marketplace.json` file (referenced in place; never deleted on
 *     remove — it's the user's own file)
 *   - Git URL (cloned into a managed dir under ~/.easy-agent/plugins/marketplaces)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MarketplaceManifestSchema,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type KnownMarketplace,
  type MarketplaceSource,
  type PluginComponentPaths,
} from "./schemas.js";
import {
  getManagedMarketplaceDir,
  getMarketplaceManifestPathCandidates,
  isPluginManifestDir,
  MARKETPLACE_MANIFEST_FILE,
} from "./paths.js";
import {
  readKnownMarketplaces,
  updateKnownMarketplaces,
  upsertMarketplace,
} from "./state.js";
import { gitClone, gitUpdate } from "./git.js";

// ─── manifest reading ─────────────────────────────────────────────────

/** Return the first path that exists as a regular file, or undefined. */
async function firstExistingFile(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  return undefined;
}

export interface MarketplaceReadResult {
  manifest: MarketplaceManifest;
  /** Directory the marketplace root resolves to (where `plugins/...` live). */
  root: string;
}

/**
 * Read + validate a marketplace manifest. Accepts either a directory that
 * contains `.easy-agent-plugin/marketplace.json` or `.claude-plugin/marketplace.json`,
 * or a direct path to a `marketplace.json` file.
 */
export async function readMarketplaceManifest(sourcePath: string): Promise<MarketplaceReadResult> {
  const stat = await fs.stat(sourcePath).catch(() => null);
  let manifestPath: string;
  let root: string;
  if (stat?.isFile()) {
    manifestPath = sourcePath;
    // A bare marketplace.json: root is its grandparent when it sits in a
    // conventional manifest dir (`.easy-agent-plugin/` or `.claude-plugin/`),
    // else its own directory.
    const parent = path.dirname(sourcePath);
    root = isPluginManifestDir(path.basename(parent)) ? path.dirname(parent) : parent;
  } else {
    // A directory: accept `.easy-agent-plugin/` or `.claude-plugin/`.
    const candidates = getMarketplaceManifestPathCandidates(sourcePath);
    manifestPath =
      (await firstExistingFile(candidates)) ?? candidates[0];
    root = sourcePath;
  }

  const text = await fs.readFile(manifestPath, "utf-8");
  const json = JSON.parse(text);
  const result = MarketplaceManifestSchema.safeParse(json);
  if (!result.success) {
    throw new Error(
      `invalid ${MARKETPLACE_MANIFEST_FILE}: ${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return { manifest: result.data, root };
}

// ─── add / list / update / remove ─────────────────────────────────────

/**
 * Register a marketplace source. For Git sources this CLONES into a managed
 * directory (the only place remove is allowed to delete). For local sources it
 * references the user's directory in place.
 */
export async function addMarketplace(source: MarketplaceSource): Promise<KnownMarketplace> {
  if (source.kind === "local") {
    const { manifest } = await readMarketplaceManifest(source.path);
    const entry: KnownMarketplace = {
      name: manifest.name,
      source,
      installLocation: source.path,
      lastUpdated: new Date().toISOString(),
    };
    await updateKnownMarketplaces((draft) => upsertMarketplace(draft, entry));
    return entry;
  }

  // Git: clone into a temp dir, validate, then atomically move into place.
  const tmp = getManagedMarketplaceDir(`.pending-${process.pid}-${Date.now()}`);
  await gitClone(source.url, tmp, source.ref);
  let manifest: MarketplaceManifest;
  try {
    ({ manifest } = await readMarketplaceManifest(tmp));
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw error;
  }
  const dest = getManagedMarketplaceDir(manifest.name);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(tmp, dest);

  const entry: KnownMarketplace = {
    name: manifest.name,
    source,
    installLocation: dest,
    lastUpdated: new Date().toISOString(),
  };
  await updateKnownMarketplaces((draft) => upsertMarketplace(draft, entry));
  return entry;
}

export async function listMarketplaces(): Promise<KnownMarketplace[]> {
  const { marketplaces } = await readKnownMarketplaces();
  return Object.values(marketplaces);
}

export async function getMarketplace(name: string): Promise<KnownMarketplace | undefined> {
  const { marketplaces } = await readKnownMarketplaces();
  return marketplaces[name];
}

/** Re-fetch a Git marketplace / re-stamp a local one. */
export async function updateMarketplace(name: string): Promise<KnownMarketplace> {
  const existing = await getMarketplace(name);
  if (!existing) throw new Error(`marketplace not found: ${name}`);
  if (existing.source.kind === "git") {
    await gitUpdate(existing.installLocation, existing.source.ref);
  } else {
    // Local: just re-validate so a broken edit surfaces now.
    await readMarketplaceManifest(existing.installLocation);
  }
  const updated: KnownMarketplace = { ...existing, lastUpdated: new Date().toISOString() };
  await updateKnownMarketplaces((draft) => upsertMarketplace(draft, updated));
  return updated;
}

/**
 * Remove a marketplace source. A MANAGED Git clone is deleted from disk; a
 * LOCAL source is only de-registered — the user's own directory is never
 * touched (plan §35.5 safety boundary).
 */
export async function removeMarketplace(name: string): Promise<void> {
  const existing = await getMarketplace(name);
  if (!existing) throw new Error(`marketplace not found: ${name}`);
  if (existing.source.kind === "git") {
    await fs.rm(existing.installLocation, { recursive: true, force: true });
  }
  await updateKnownMarketplaces((draft) => {
    delete draft.marketplaces[name];
  });
}

// ─── plugin resolution ────────────────────────────────────────────────

export interface ResolvedPluginEntry {
  marketplace: KnownMarketplace;
  entry: MarketplacePluginEntry;
  /** How to obtain the plugin's files. */
  pluginSource:
    | { kind: "local"; path: string }
    | { kind: "git"; url: string; ref?: string };
}

/**
 * Resolve `name@marketplace` (or `name` when exactly one marketplace has it)
 * into a concrete plugin source. The stable id is all the user ever types; the
 * Git URL / local path is an implementation detail owned by the manifest.
 */
export async function resolvePlugin(pluginRef: string): Promise<ResolvedPluginEntry> {
  const at = pluginRef.lastIndexOf("@");
  const pluginName = at > 0 ? pluginRef.slice(0, at) : pluginRef;
  const marketplaceName = at > 0 ? pluginRef.slice(at + 1) : undefined;

  const all = await listMarketplaces();
  const candidates = marketplaceName
    ? all.filter((m) => m.name === marketplaceName)
    : all;
  if (candidates.length === 0) {
    throw new Error(
      marketplaceName
        ? `marketplace not found: ${marketplaceName}`
        : `no marketplaces registered — add one with /plugin marketplace add`,
    );
  }

  const matches: ResolvedPluginEntry[] = [];
  for (const marketplace of candidates) {
    const { manifest, root } = await readMarketplaceManifest(marketplace.installLocation);
    const entry = manifest.plugins.find((p) => p.name === pluginName);
    if (!entry) continue;
    matches.push({ marketplace, entry, pluginSource: toPluginSource(entry, root) });
  }

  if (matches.length === 0) {
    throw new Error(`plugin "${pluginName}" not found in ${marketplaceName ?? "any registered marketplace"}`);
  }
  if (matches.length > 1) {
    const where = matches.map((m) => m.marketplace.name).join(", ");
    throw new Error(
      `plugin "${pluginName}" exists in multiple marketplaces (${where}); qualify it as ${pluginName}@<marketplace>`,
    );
  }
  return matches[0];
}

/**
 * Extract the inline component paths a catalog entry declares. A marketplace
 * may describe the layout of a plugin that ships no manifest of its own (e.g.
 * `"skills": ["./"]` for a bare skill folder), so these are carried into the
 * loader and persisted with the install record.
 */
export function componentPathsFromEntry(entry: MarketplacePluginEntry): PluginComponentPaths {
  const paths: PluginComponentPaths = {};
  if (entry.skills !== undefined) paths.skills = entry.skills;
  if (entry.agents !== undefined) paths.agents = entry.agents;
  if (entry.commands !== undefined) paths.commands = entry.commands;
  if (entry.outputStyles !== undefined) paths.outputStyles = entry.outputStyles;
  if (entry.hooks !== undefined) paths.hooks = entry.hooks;
  if (entry.mcpServers !== undefined) paths.mcpServers = entry.mcpServers;
  return paths;
}

function toPluginSource(
  entry: MarketplacePluginEntry,
  marketplaceRoot: string,
): ResolvedPluginEntry["pluginSource"] {
  const src = entry.source;
  // A Git URL is either scp-like (git@host:...) or has a scheme.
  if (/^[a-z]+:\/\//i.test(src) || /^git@/.test(src)) {
    return { kind: "git", url: src, ...(entry.ref ? { ref: entry.ref } : {}) };
  }
  // Otherwise a path relative to the marketplace root.
  return { kind: "local", path: path.resolve(marketplaceRoot, src) };
}
