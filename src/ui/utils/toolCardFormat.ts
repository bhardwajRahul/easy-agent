/**
 * Shared formatting helpers for tool-call cards.
 *
 * Used by both the live `ToolCallList` (in-flight cards) and the
 * `ConversationView` (inline cards rendered from committed assistant
 * messages). Keeping them in one place ensures the two views look
 * identical once an in-flight card transitions into history.
 */

import path from "node:path";
import { diffStats } from "./diffFormat.js";
import { classifyBashLabel, shortenCommand } from "./toolClassify.js";

const MAX_ERROR_LINES = 12;
const MAX_ERROR_CHARS = 2000;

/**
 * A one-line tool-card descriptor, shared by the live and history cards so
 * they stay visually identical. `label` is the tool name, `target` the
 * file/pattern, and either `stat` (free text, e.g. "240 lines") OR
 * `added`/`removed` (colored `+N -N`) is shown as a trailing dim hint.
 */
export interface ToolLine {
  label: string;
  target?: string;
  stat?: string;
  added?: number;
  removed?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Collapse an absolute path inside the cwd to a workspace-relative one. */
export function displayPath(p: string | undefined): string {
  if (!p) return "";
  const cwd = process.cwd();
  if (p === cwd) return ".";
  if (p.startsWith(cwd + path.sep)) return p.slice(cwd.length + 1);
  return p;
}

/** Read result → "N lines" (the body is `header\n<numbered lines>`). */
function readStat(result: string): string | undefined {
  const total = result.split("\n").length;
  const body = Math.max(0, total - 1); // drop the "path (… lines)" header
  return body > 0 ? `${body} line${body === 1 ? "" : "s"}` : undefined;
}

/** Grep result → "N matches in M files" (rg emits `path:line:text`). */
function grepStat(result: string): string | undefined {
  if (result.startsWith("No matches")) return "0 matches";
  const lines = result.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;
  const files = new Set(lines.map((l) => l.slice(0, l.indexOf(":"))).filter(Boolean));
  const m = lines.length;
  const f = files.size;
  return `${m} match${m === 1 ? "" : "es"}${f > 0 ? ` in ${f} file${f === 1 ? "" : "s"}` : ""}`;
}

/** Glob result → "N files" (body is `Matched files under …:\n<paths>`). */
function globStat(result: string): string | undefined {
  if (result.startsWith("No files")) return "0 files";
  const n = Math.max(0, result.split("\n").length - 1);
  return n > 0 ? `${n} file${n === 1 ? "" : "s"}` : undefined;
}

/** Strip the model-only `<sandbox_violations>…</sandbox_violations>` block. */
function stripSandboxViolations(text: string): string {
  return text.replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g, "").trim();
}

/**
 * Pull the human-relevant stdout/stderr out of a Bash tool_result, dropping
 * the `Command:/Read-only:/Sandbox:/Exit code:` metadata header and the
 * STDOUT:/STDERR: section labels, and stripping the model-only
 * <sandbox_violations> tag. Returns the trimmed body (may be empty).
 *
 * Kept for callers that just want a single merged blob; richer rendering
 * uses `parseBashResult` to keep stdout and stderr on separate layers.
 */
export function extractBashOutput(content: string): string {
  const withoutTag = stripSandboxViolations(content);
  const lines = withoutTag.split("\n");
  const body: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (line === "STDOUT:" || line === "STDERR:") {
      capturing = true;
      continue;
    }
    if (/^(Command|Read-only|Sandbox|Exit code): /.test(line)) continue;
    if (capturing) body.push(line);
  }
  return body.join("\n").trim();
}

/**
 * Structured view of a Bash tool_result, separating stdout, stderr and the
 * exceptional states (timeout / abort / spawn failure / sandbox violation) so
 * the UI can render each on its own visual layer. Mirrors source's
 * `BashToolResultMessage` split (stdout default, stderr `isError`, warnings
 * dim, sandbox tags stripped before display).
 */
export interface BashResult {
  /** Original command, when present in the metadata header. */
  command?: string;
  stdout: string;
  /** stderr with `<sandbox_violations>` stripped for human display. */
  stderr: string;
  exitCode?: number;
  /** Set when the command timed out (carries a human message to show). */
  timeoutMessage?: string;
  /** A non-structured error (abort, spawn failure) — shown as-is. */
  errorMessage?: string;
  /** True when stderr carried a `<sandbox_violations>` block (now stripped). */
  hadSandboxViolation: boolean;
}

/** Parse a Bash/PowerShell tool_result `content` into its structured layers. */
export function parseBashResult(content: string): BashResult {
  const trimmed = content.trim();

  // Non-structured failures emitted by bashTool before/around spawn.
  const timeout = trimmed.match(/^Command timed out after (\d+)ms/);
  if (timeout) {
    const ms = Number(timeout[1]);
    const secs = Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
    return {
      stdout: "",
      stderr: "",
      hadSandboxViolation: false,
      timeoutMessage: secs !== undefined ? `Timed out after ${secs}s` : "Timed out",
    };
  }
  const hasStructure = /^(Command|Exit code): /m.test(trimmed) || /^STDOUT:$/m.test(trimmed);
  if (!hasStructure) {
    return { stdout: "", stderr: "", hadSandboxViolation: false, errorMessage: trimmed };
  }

  const lines = content.split("\n");
  let command: string | undefined;
  let exitCode: number | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let section: "stdout" | "stderr" | null = null;
  for (const line of lines) {
    if (line === "STDOUT:") {
      section = "stdout";
      continue;
    }
    if (line === "STDERR:") {
      section = "stderr";
      continue;
    }
    const cmd = line.match(/^Command: (.*)$/);
    if (cmd && section === null) {
      command = cmd[1];
      continue;
    }
    const code = line.match(/^Exit code: (-?\d+)$/);
    if (code && section === null) {
      exitCode = Number(code[1]);
      continue;
    }
    if (/^(Read-only|Sandbox): /.test(line) && section === null) continue;
    if (section === "stdout") stdout.push(line);
    else if (section === "stderr") stderr.push(line);
  }

  const rawStderr = stderr.join("\n");
  const cleanedStderr = stripSandboxViolations(rawStderr);
  return {
    command,
    stdout: stdout.join("\n").trim(),
    stderr: cleanedStderr,
    exitCode,
    hadSandboxViolation: rawStderr.includes("<sandbox_violations>"),
  };
}

/** Parse the `Exit code: N` line from a Bash/PowerShell result, if present. */
function bashExitCode(result: string): number | undefined {
  const m = result.match(/^Exit code: (-?\d+)$/m);
  return m ? Number(m[1]) : undefined;
}

/** Hostname of a URL, falling back to the raw string. */
function urlHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** WebFetch result → the parenthesized status, e.g. "200 OK". */
function webFetchStat(result: string): string | undefined {
  const m = result.match(/^Fetched .+? \((\d{3} [^,)]+)/);
  return m ? m[1] : undefined;
}

/** WebSearch result → "N results" (counts the `- [..](..)` link lines). */
function webSearchStat(result: string): string | undefined {
  if (result.includes("No results found")) return "0 results";
  const n = (result.match(/^\s*-\s+\[/gm) ?? []).length;
  return `${n} result${n === 1 ? "" : "s"}`;
}

/** ListMcpResources result → "N resources". */
function mcpListStat(result: string): string | undefined {
  if (result.includes("No MCP resources")) return "0 resources";
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) return `${parsed.length} resource${parsed.length === 1 ? "" : "s"}`;
  } catch {
    // not JSON — leave blank
  }
  return undefined;
}

/**
 * Build the one-line descriptor for a tool card. `result` is optional: the
 * live (in-flight) card only knows the input, so Read/Grep counts that need
 * the result body are simply omitted there and fill in once the card lands in
 * history. Edit's `+N -N` is derived from the input alone, so it shows live.
 */
export function summarizeTool(
  name: string,
  input: Record<string, unknown> | undefined,
  result?: string,
): ToolLine {
  const inp = input ?? {};
  switch (name) {
    case "Edit": {
      const target = displayPath(asString(inp.file_path));
      const oldStr = asString(inp.old_string);
      const newStr = asString(inp.new_string);
      if (oldStr !== undefined && newStr !== undefined) {
        const { added, removed } = diffStats(oldStr, newStr);
        return { label: "Edit", target, added, removed };
      }
      return { label: "Edit", target };
    }
    case "Write": {
      const target = displayPath(asString(inp.file_path));
      const content = asString(inp.content) ?? "";
      const n = content ? content.split("\n").length : 0;
      const verb = result?.startsWith("Created")
        ? "created"
        : result?.startsWith("Updated")
          ? "updated"
          : undefined;
      const stat = `${verb ? `${verb}, ` : ""}${n} line${n === 1 ? "" : "s"}`;
      return { label: "Write", target, stat };
    }
    case "Read":
      return { label: "Read", target: displayPath(asString(inp.file_path)), stat: result ? readStat(result) : undefined };
    case "Grep": {
      const pat = asString(inp.pattern);
      return { label: "Grep", target: pat ? `"${pat}"` : undefined, stat: result ? grepStat(result) : undefined };
    }
    case "Glob":
      return { label: "Glob", target: asString(inp.pattern), stat: result ? globStat(result) : undefined };
    case "Bash": {
      const cmd = asString(inp.command);
      // Classify the command into a semantic label (Build/Test/Git/Search/
      // List) so a wall of Bash cards reads as recognizable actions; falls
      // back to a plain `Bash(command)`.
      const { label, target } = cmd ? classifyBashLabel(cmd) : { label: "Bash", target: undefined };
      const code = result ? bashExitCode(result) : undefined;
      const stat = code !== undefined && code !== 0 ? `exit ${code}` : undefined;
      return { label, target, stat };
    }
    case "PowerShell": {
      const cmd = asString(inp.command);
      const target = cmd ? shortenCommand(cmd) : undefined;
      const code = result ? bashExitCode(result) : undefined;
      const stat = code !== undefined && code !== 0 ? `exit ${code}` : undefined;
      return { label: "PowerShell", target, stat };
    }
    case "MultiEdit": {
      const target = displayPath(asString(inp.file_path));
      const edits = Array.isArray(inp.edits) ? inp.edits.length : undefined;
      const stat = edits !== undefined ? `${edits} edit${edits === 1 ? "" : "s"}` : undefined;
      return { label: "MultiEdit", target, stat };
    }
    case "WebFetch":
      return { label: "WebFetch", target: urlHost(asString(inp.url)), stat: result ? webFetchStat(result) : undefined };
    case "WebSearch": {
      const q = asString(inp.query);
      return { label: "WebSearch", target: q ? `"${q}"` : undefined, stat: result ? webSearchStat(result) : undefined };
    }
    case "ListMcpResources":
      return { label: "ListMcpResources", target: asString(inp.server) ?? "all servers", stat: result ? mcpListStat(result) : undefined };
    case "ReadMcpResource":
      return { label: "ReadMcpResource", target: asString(inp.uri), stat: asString(inp.server) };
    default:
      return { label: name };
  }
}

/**
 * Clamp a (potentially long) error message to a bounded number of lines
 * and characters so it stays readable in the terminal without scrolling
 * off everything else.
 */
export function formatErrorBody(raw: string): string {
  let text = raw.trim();
  if (text.length > MAX_ERROR_CHARS) {
    text = `${text.slice(0, MAX_ERROR_CHARS)}\n… (truncated, ${raw.length} chars total)`;
  }
  const lines = text.split("\n");
  if (lines.length > MAX_ERROR_LINES) {
    const keep = lines.slice(0, MAX_ERROR_LINES);
    keep.push(`… (+${lines.length - MAX_ERROR_LINES} more lines)`);
    return keep.join("\n");
  }
  return text;
}

/**
 * Build a compact one-line preview of a tool's input for debug display.
 * Keeps the first ~120 characters of each value and truncates long strings.
 */
export function formatToolInputPreview(
  input: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const [key, value] of entries) {
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.length > 120 ? `${value.slice(0, 120)}…` : value;
      rendered = rendered.replace(/\s+/g, " ");
      rendered = JSON.stringify(rendered);
    } else if (value === null || value === undefined) {
      rendered = String(value);
    } else if (typeof value === "object") {
      const json = JSON.stringify(value);
      rendered = json.length > 120 ? `${json.slice(0, 120)}…` : json;
    } else {
      rendered = String(value);
    }
    parts.push(`${key}=${rendered}`);
  }
  const joined = parts.join(", ");
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}
