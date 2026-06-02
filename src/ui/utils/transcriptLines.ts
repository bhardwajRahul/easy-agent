/**
 * Build the full, verbose transcript as a flat array of pre-wrapped terminal
 * rows (each string = exactly one visual line, ANSI included).
 *
 * This is what powers the Ctrl+O transcript overlay (stage 24.1): the inline
 * conversation in <Static> stays condensed, and the overlay re-renders the
 * ENTIRE history verbose so the user can scroll back and expand any tool call
 * retroactively — mirroring Claude Code's `app:toggleTranscript`.
 *
 * We render to *strings* rather than Ink components on purpose: a flat line
 * array makes windowed scrolling (lines.slice(offset, offset+height)) exact
 * and trivial, sidestepping the height-measurement problem you hit when trying
 * to scroll a tree of variable-height React nodes.
 */
import wrapAnsi from "wrap-ansi";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { theme, glyph } from "../theme.js";
import { markdownToAnsi } from "../markdown/markdownToAnsi.js";
import {
  buildToolResultMap,
  extractCommandMarker,
  extractTaskNotification,
  isInternalMessage,
  type ToolResultInfo,
} from "../components/ConversationView.js";
import { computeDiffLines } from "./diffFormat.js";
import {
  extractBashOutput,
  formatErrorBody,
  summarizeTool,
  type ToolLine,
} from "./toolCardFormat.js";

const paint = {
  assistant: chalk.hex(theme.assistant),
  brand: chalk.hex(theme.brand),
  brandLight: chalk.hex(theme.brandLight),
  muted: chalk.hex(theme.muted),
  ok: chalk.hex(theme.ok),
  error: chalk.hex(theme.error),
};

const CORNER = `  ${glyph.resultCorner} `; // "  ⎿ "
const BODY_INDENT = "    "; // 4 cols, aligns under the corner

/** Header line for a tool card: `● Label(target)`. */
function toolHeader(line: ToolLine, isError: boolean): string {
  const dot = paint[isError ? "error" : "ok"](glyph.toolDot);
  const label = chalk.bold(line.label);
  const target = line.target ? paint.muted(`(${line.target})`) : "";
  return `${dot} ${label}${target}`;
}

/** Condensed `⎿` summary (`+N -M` or free-text stat). */
function toolSummary(line: ToolLine): string {
  if (line.added !== undefined || line.removed !== undefined) {
    return paint.muted(CORNER) + `${paint.ok(`+${line.added ?? 0}`)} ${paint.error(`-${line.removed ?? 0}`)}`;
  }
  return paint.muted(CORNER + (line.stat ?? "done"));
}

function pushToolLines(out: string[], name: string, input: Record<string, unknown> | undefined, result: ToolResultInfo): void {
  const line = summarizeTool(name, input, result.content);
  out.push(toolHeader(line, result.isError));

  // Bash → full stdout/stderr under the corner.
  if (name === "Bash") {
    const output = extractBashOutput(result.content);
    if (!output) {
      out.push(toolSummary(line));
      return;
    }
    const color = result.isError ? paint.error : paint.muted;
    const lines = output.split("\n");
    out.push(paint.muted(CORNER) + color(lines[0] ?? ""));
    for (let i = 1; i < lines.length; i++) out.push(BODY_INDENT + color(lines[i] ?? ""));
    return;
  }

  // Errors → full error body.
  if (result.isError) {
    const body = formatErrorBody(result.content);
    const lines = body.split("\n");
    out.push(paint.muted(CORNER) + paint.error(lines[0] ?? ""));
    for (let i = 1; i < lines.length; i++) out.push(BODY_INDENT + paint.error(lines[i] ?? ""));
    return;
  }

  // Edit / Write → colored diff under the summary. Others → summary only.
  const oldStr = typeof input?.old_string === "string" ? (input.old_string as string) : undefined;
  const newStr = typeof input?.new_string === "string" ? (input.new_string as string) : undefined;
  const writeContent = name === "Write" && typeof input?.content === "string" ? (input.content as string) : undefined;

  out.push(toolSummary(line));
  let diff: ReturnType<typeof computeDiffLines> | null = null;
  if (name === "Edit" && oldStr !== undefined && newStr !== undefined) {
    diff = computeDiffLines(oldStr, newStr);
  } else if (writeContent !== undefined) {
    diff = computeDiffLines("", writeContent);
  }
  if (diff) {
    for (const d of diff) {
      if (d.kind === "add") out.push(BODY_INDENT + paint.ok(`+ ${d.text}`));
      else if (d.kind === "del") out.push(BODY_INDENT + paint.error(`- ${d.text}`));
      else out.push(BODY_INDENT + paint.muted(`  ${d.text}`));
    }
  }
}

/** Walk the message log into verbose logical lines (pre-wrap). */
function buildLogicalLines(messages: MessageParam[]): string[] {
  const toolResults = buildToolResultMap(messages);
  const out: string[] = [];

  const blank = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };

  messages.forEach((message) => {
    if (isInternalMessage(message)) return;

    if (message.role === "user") {
      if (typeof message.content === "string") {
        const marker = extractCommandMarker(message);
        if (marker) {
          const display = `/${marker.name.replace(/^\//, "")}` + (marker.args ? ` ${marker.args}` : "");
          blank();
          out.push(`${paint.brand(glyph.userCaret)} ${paint.brandLight(display)}`);
          return;
        }
        const notif = extractTaskNotification(message.content);
        if (notif) {
          blank();
          out.push(`${paint.muted("●")} Sub-agent ${chalk.bold(notif.agentType)} ${notif.status}`);
          return;
        }
        blank();
        for (const l of message.content.split("\n")) {
          out.push(`${paint.brand(glyph.userCaret)} ${l}`);
        }
      }
      return;
    }

    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        if (!message.content) return;
        blank();
        const md = markdownToAnsi(message.content).split("\n");
        out.push(`${paint.assistant(glyph.assistant)} ${md[0] ?? ""}`);
        for (let i = 1; i < md.length; i++) out.push(md[i] ?? "");
        return;
      }
      if (Array.isArray(message.content)) {
        const blocks = message.content as Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
        for (const block of blocks) {
          if (block?.type === "text" && block.text) {
            blank();
            const md = markdownToAnsi(block.text).split("\n");
            out.push(`${paint.assistant(glyph.assistant)} ${md[0] ?? ""}`);
            for (let i = 1; i < md.length; i++) out.push(md[i] ?? "");
            continue;
          }
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const result = toolResults.get(block.id);
            if (!result) continue;
            blank();
            pushToolLines(out, block.name, block.input, result);
          }
        }
      }
    }
  });

  return out;
}

/**
 * Build the transcript as exact terminal rows: every logical line is hard-
 * wrapped to `columns` (ANSI-aware) and flattened, so a window slice maps 1:1
 * to visible rows.
 */
export function buildTranscriptLines(messages: MessageParam[], columns: number): string[] {
  const width = Math.max(20, columns);
  const logical = buildLogicalLines(messages);
  const rows: string[] = [];
  for (const line of logical) {
    if (line === "") {
      rows.push("");
      continue;
    }
    const wrapped = wrapAnsi(line, width, { hard: true, trim: false });
    for (const row of wrapped.split("\n")) rows.push(row);
  }
  return rows;
}
