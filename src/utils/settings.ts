/**
 * Safe JSON config-file reader, shared by every loader that consumes a
 * settings.json (currently: MCP servers + permission rules).
 *
 * What "safe" means here:
 *   - File missing  → returns { raw: null } silently. settings.json is
 *     optional; users without one should still get a working CLI.
 *   - Invalid JSON  → returns { raw: null, parseError: "..." } so the
 *     caller can decide whether to log a warning, abort startup, or
 *     fall back to defaults. The raw JSON parse error message is
 *     included verbatim so the user can find the offending line.
 *   - Other I/O err → returns { raw: null, parseError: "..." } likewise,
 *     prefixed with "Failed to read".
 *
 * What this DOES NOT do:
 *   - Schema validation. Every consumer (MCP / permissions / future
 *     settings) has its own schema and merge semantics, and they should
 *     own that logic. This util is just the file-reading primitive.
 *   - Caching. Settings change rarely and the file is small; the loaders
 *     above this layer can cache if they want.
 *   - Merging across scopes. The user/project merge logic lives in the
 *     caller because the rules differ per feature (MCP overrides per
 *     server name, permissions concatenate arrays, etc.).
 *
 * Reference: this consolidates the two near-identical
 * `readSettingsFile()` helpers that lived in `services/mcp/config.ts`
 * and `permissions/permissions.ts`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectSettingsPath, getUserSettingsPath } from "./paths.js";

export interface SettingsFileResult<T = unknown> {
  /** Parsed JSON object, or null if missing / unreadable / invalid. */
  raw: T | null;
  /** Human-readable error if the file existed but couldn't be parsed. */
  parseError?: string;
}

/**
 * Read and JSON-parse a settings file. Never throws — the caller decides
 * how to surface failures (log a warning, fall back to defaults, etc.).
 *
 * @param filePath Absolute path to the settings file. Use the path
 *   helpers in `./paths.ts` to construct this; do NOT inline-build it.
 */
export async function readJsonSettingsFile<T = unknown>(
  filePath: string,
): Promise<SettingsFileResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { raw: null };
    return {
      raw: null,
      parseError: `Failed to read ${filePath}: ${(error as Error).message}`,
    };
  }

  try {
    const parsed = JSON.parse(text) as T;
    return { raw: parsed };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        raw: null,
        parseError: `Invalid JSON in ${filePath}: ${error.message}`,
      };
    }
    return {
      raw: null,
      parseError: `Failed to parse ${filePath}: ${(error as Error).message}`,
    };
  }
}

/**
 * Read-merge-write a shallow patch into the USER settings file
 * (`~/.easy-agent/settings.json`). Used by `/output-style` (and future
 * `/config`) to persist a top-level preference like `outputStyle`.
 *
 * Semantics:
 *   - Missing / unparseable file → starts from `{}` (we don't want a single
 *     malformed character to make a preference un-persistable; the original
 *     bad content is overwritten with the merged result).
 *   - Shallow merge only — nested objects are replaced, not deep-merged.
 *     That's all the current callers need.
 *   - Creates `~/.easy-agent/` if it doesn't exist yet.
 */
export async function updateUserSettings(
  patch: Record<string, unknown>,
): Promise<void> {
  const filePath = getUserSettingsPath();
  const { raw } = await readJsonSettingsFile<Record<string, unknown>>(filePath);
  const merged = { ...(raw ?? {}), ...patch };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Resolved status-line command config. `null` means "no custom command —
 * render the built-in segmented status line".
 */
export interface StatusLineCommandConfig {
  command: string;
  /** Optional left padding (columns) the user can request. */
  padding?: number;
}

/**
 * Read the `statusLine` setting, merging user + project (PROJECT wins). Accepts
 * two shapes for ergonomics, mirroring how source treats `statusLine`:
 *   - a bare string  → treated as the command
 *   - an object       → { type?: "command", command: string, padding?: number }
 * Returns null when unset or malformed (the UI then shows its default line).
 */
export async function readStatusLineConfig(
  cwd: string,
): Promise<StatusLineCommandConfig | null> {
  const [user, project] = await Promise.all([
    readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath()),
    readJsonSettingsFile<Record<string, unknown>>(getProjectSettingsPath(cwd)),
  ]);
  const raw = project.raw?.["statusLine"] ?? user.raw?.["statusLine"];
  if (!raw) return null;
  if (typeof raw === "string") {
    return raw.trim() ? { command: raw.trim() } : null;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const command = typeof obj["command"] === "string" ? obj["command"].trim() : "";
    if (!command) return null;
    const padding = typeof obj["padding"] === "number" ? obj["padding"] : undefined;
    return padding !== undefined ? { command, padding } : { command };
  }
  return null;
}

/**
 * Read a single top-level string setting, merging user + project scopes
 * with PROJECT winning (project overrides user — same precedence as the
 * MCP / permissions loaders). Returns undefined when the key is absent or
 * not a string in both scopes.
 */
export async function readMergedStringSetting(
  cwd: string,
  key: string,
): Promise<string | undefined> {
  const [user, project] = await Promise.all([
    readJsonSettingsFile<Record<string, unknown>>(getUserSettingsPath()),
    readJsonSettingsFile<Record<string, unknown>>(getProjectSettingsPath(cwd)),
  ]);
  const projectVal = project.raw?.[key];
  if (typeof projectVal === "string" && projectVal.trim()) return projectVal.trim();
  const userVal = user.raw?.[key];
  if (typeof userVal === "string" && userVal.trim()) return userVal.trim();
  return undefined;
}
