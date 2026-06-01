/**
 * Step 23 - Output Styles and user slash commands
 *
 * Goal:
 * - register built-in and custom output styles
 * - load styles from output-styles/*.md
 * - switch style with /output-style
 * - load user-defined slash commands from commands/*.md
 * - substitute $ARGUMENTS / $1 / $ARGUMENTS[n]
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// -----------------------------------------------------------------------------
// 1. Shared frontmatter helpers and paths
// -----------------------------------------------------------------------------

export function getEasyAgentHome() {
  return process.env.EASY_AGENT_HOME || path.join(os.homedir(), ".easy-agent");
}

export function getUserOutputStylesDir() {
  return path.join(getEasyAgentHome(), "output-styles");
}

export function getProjectOutputStylesDir(cwd) {
  return path.join(cwd, ".easy-agent", "output-styles");
}

export function getUserCommandsDir() {
  return path.join(getEasyAgentHome(), "commands");
}

export function getProjectCommandsDir(cwd) {
  return path.join(cwd, ".easy-agent", "commands");
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(content) {
  const match = String(content).match(FRONTMATTER_RE);
  if (!match) return { raw: {}, body: String(content) };
  try {
    const raw = parseYaml(match[1]);
    return { raw: raw && typeof raw === "object" ? raw : {}, body: match[2] };
  } catch (error) {
    return { raw: {}, body: match[2], parseError: error.message };
  }
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim());
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

function fallbackDescription(body, fallback) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line || fallback;
}

// -----------------------------------------------------------------------------
// 2. Output styles registry and loader
// -----------------------------------------------------------------------------

export const DEFAULT_OUTPUT_STYLE_NAME = "default";

const BUILT_IN_STYLES = [
  {
    name: "default",
    description: "Default - concise and professional",
    prompt: "",
    source: "built-in",
    keepCodingInstructions: true,
  },
  {
    name: "Explanatory",
    description: "Explain implementation choices with short Insight blocks",
    source: "built-in",
    keepCodingInstructions: true,
    prompt:
      "Use brief Insight blocks to explain important implementation choices and codebase patterns.",
  },
  {
    name: "Learning",
    description: "Ask the user to write small TODO(human) code sections",
    source: "built-in",
    keepCodingInstructions: true,
    prompt:
      "Help the user learn by pausing for meaningful TODO(human) contributions when appropriate.",
  },
];

const styleRegistry = new Map();
let activeStyleName = DEFAULT_OUTPUT_STYLE_NAME;

function seedBuiltIns() {
  styleRegistry.clear();
  for (const style of BUILT_IN_STYLES) styleRegistry.set(style.name, style);
}
seedBuiltIns();

export function setCustomOutputStyles(styles) {
  seedBuiltIns();
  for (const style of styles) styleRegistry.set(style.name, style);
}

export function getAllOutputStyles() {
  return [...styleRegistry.values()];
}

export function resolveOutputStyle(name) {
  if (styleRegistry.has(name)) return styleRegistry.get(name);
  const lower = String(name).toLowerCase();
  return [...styleRegistry.values()].find((s) => s.name.toLowerCase() === lower);
}

export function setActiveOutputStyle(name) {
  const style = resolveOutputStyle(name);
  if (!style) return false;
  activeStyleName = style.name;
  return true;
}

export function getActiveOutputStyleConfig() {
  const style = styleRegistry.get(activeStyleName);
  return style && style.prompt.trim() ? style : null;
}

function keepCodingInstructions(raw) {
  const value = raw["keep-coding-instructions"] ?? raw.keepCodingInstructions;
  return !(value === false || String(value).toLowerCase() === "false");
}

async function loadStylesFromOneDir(dir, source) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { styles: [], warnings: [] };
    return { styles: [], warnings: ["Failed to read " + dir + ": " + error.message] };
  }

  const styles = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const split = splitFrontmatter(await fs.readFile(filePath, "utf8"));
    if (split.parseError || !split.body.trim()) {
      warnings.push("[output-styles] Skipping " + entry.name);
      continue;
    }
    const filename = entry.name.replace(/\.md$/, "");
    styles.push({
      name: asString(split.raw.name) || filename,
      description:
        asString(split.raw.description) ||
        fallbackDescription(split.body, "Custom " + filename + " output style"),
      prompt: split.body.trim(),
      source,
      keepCodingInstructions: keepCodingInstructions(split.raw),
    });
  }
  return { styles, warnings };
}

export async function loadAllOutputStyles(cwd) {
  const [user, project] = await Promise.all([
    loadStylesFromOneDir(getUserOutputStylesDir(), "user"),
    loadStylesFromOneDir(getProjectOutputStylesDir(cwd), "project"),
  ]);
  const byName = new Map();
  for (const style of [...user.styles, ...project.styles]) byName.set(style.name, style);
  return { styles: [...byName.values()], warnings: [...user.warnings, ...project.warnings] };
}

export function renderOutputStyleSection() {
  const style = getActiveOutputStyleConfig();
  if (!style) return "";
  return ["# Output Style: " + style.name, style.prompt].join("\n\n");
}

// -----------------------------------------------------------------------------
// 3. User-defined slash command loader
// -----------------------------------------------------------------------------

async function collectMarkdownFiles(dir, prefix = "") {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(path.join(dir, entry.name), rel)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(rel);
  }
  return files;
}

async function loadCommandsFromOneDir(dir, source) {
  const commands = [];
  const warnings = [];
  let relPaths = [];
  try {
    relPaths = await collectMarkdownFiles(dir);
  } catch (error) {
    return { commands, warnings: ["Failed to read " + dir + ": " + error.message] };
  }

  for (const rel of relPaths) {
    const filePath = path.join(dir, rel);
    const split = splitFrontmatter(await fs.readFile(filePath, "utf8"));
    if (split.parseError) {
      warnings.push("[commands] Skipping " + rel);
      continue;
    }
    const name = rel.replace(/\.md$/, "").split(/[\\/]/).join(":");
    commands.push({
      name,
      description:
        asString(split.raw.description) ||
        fallbackDescription(split.body, "Custom /" + name + " command"),
      argumentHint: asString(split.raw["argument-hint"] ?? split.raw.argumentHint),
      model: asString(split.raw.model),
      allowedTools: asStringArray(split.raw["allowed-tools"] ?? split.raw.allowedTools),
      body: split.body.trim(),
      filePath,
      source,
    });
  }
  return { commands, warnings };
}

export async function loadAllUserCommands(cwd) {
  const [user, project] = await Promise.all([
    loadCommandsFromOneDir(getUserCommandsDir(), "user"),
    loadCommandsFromOneDir(getProjectCommandsDir(cwd), "project"),
  ]);
  const byName = new Map();
  for (const command of [...user.commands, ...project.commands]) {
    byName.set(command.name, command);
  }
  return { commands: [...byName.values()], warnings: [...user.warnings, ...project.warnings] };
}

const commandRegistry = new Map();

export function setUserCommands(commands) {
  commandRegistry.clear();
  for (const command of commands) commandRegistry.set(command.name, command);
}

export function findUserCommand(name) {
  return commandRegistry.get(name);
}

export function getAllUserCommands() {
  return [...commandRegistry.values()];
}

// -----------------------------------------------------------------------------
// 4. Argument substitution and command execution
// -----------------------------------------------------------------------------

export function parseArguments(args) {
  if (!args || !args.trim()) return [];
  const tokens = [];
  let current = "";
  let quote = null;
  let active = false;

  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      active = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (active) {
        tokens.push(current);
        current = "";
        active = false;
      }
      continue;
    }
    current += ch;
    active = true;
  }
  if (active) tokens.push(current);
  return quote ? args.split(/\s+/).filter(Boolean) : tokens;
}

export function substituteArguments(template, args = "", appendIfNoPlaceholder = true) {
  const parsed = parseArguments(args);
  const original = template;
  let out = template.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => parsed[Number(i)] || "");
  out = out.replace(/\$(\d+)(?!\w)/g, (_, i) => parsed[Number(i) - 1] || "");
  out = out.replaceAll("$ARGUMENTS", args);
  if (out === original && appendIfNoPlaceholder && args.trim()) {
    out += "\n\nARGUMENTS: " + args;
  }
  return out;
}

export async function runUserCommand(name, args) {
  const command = findUserCommand(name);
  if (!command) return { ok: false, error: "Unknown command: /" + name };
  return {
    ok: true,
    prompt: substituteArguments(command.body, args),
    model: command.model,
    allowedTools: command.allowedTools,
  };
}

// -----------------------------------------------------------------------------
// 5. Demo
// -----------------------------------------------------------------------------

export async function demoStep23() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step23-"));
  const cwd = path.join(tmp, "project");
  const prevHome = process.env.EASY_AGENT_HOME;
  process.env.EASY_AGENT_HOME = path.join(tmp, "home", ".easy-agent");

  try {
    await fs.mkdir(path.join(cwd, ".easy-agent", "output-styles"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".easy-agent", "commands", "team"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".easy-agent", "output-styles", "Terse.md"),
      "---\nname: Terse\ndescription: One sentence answers\nkeep-coding-instructions: false\n---\nAnswer in one sentence.",
    );
    await fs.writeFile(
      path.join(cwd, ".easy-agent", "commands", "team", "review.md"),
      "---\ndescription: Review a file\nargument-hint: <file>\nallowed-tools: Read,Grep\n---\nReview $1 with context: $ARGUMENTS",
    );

    const loadedStyles = await loadAllOutputStyles(cwd);
    setCustomOutputStyles(loadedStyles.styles);
    setActiveOutputStyle("Terse");

    const loadedCommands = await loadAllUserCommands(cwd);
    setUserCommands(loadedCommands.commands);
    const command = await runUserCommand("team:review", "src/foo.ts --strict");

    return {
      styleSection: renderOutputStyleSection(),
      styles: getAllOutputStyles().map((s) => s.name),
      commands: getAllUserCommands().map((c) => c.name),
      command,
    };
  } finally {
    if (prevHome === undefined) delete process.env.EASY_AGENT_HOME;
    else process.env.EASY_AGENT_HOME = prevHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
