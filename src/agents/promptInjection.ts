/**
 * Format the available-agents discovery listing into a <system-reminder>
 * block. Mirrors the budget-aware formatter in services/skills/budget.ts
 * but simpler — agent counts are small (typically < 10), so we don't need
 * the three-tier degradation the skills formatter has.
 *
 * The block goes into the dynamic section of the system prompt so the
 * model knows what `subagent_type` values it can pass to the Agent tool.
 */

import type { AgentDefinition } from "./types.js";

const MAX_DESC_CHARS = 220;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render the "available sub-agents" system-reminder block. Returns an
 * empty string when there are no agents loaded (so callers can
 * unconditionally concatenate without producing trailing whitespace).
 */
export function formatAgentsSystemReminder(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "";

  // Sort built-ins to the top and otherwise alphabetically — gives the
  // model a stable, predictable listing across turns regardless of the
  // order custom agent files were loaded.
  const sorted = [...agents].sort((a, b) => {
    if (a.source === "built-in" && b.source !== "built-in") return -1;
    if (a.source !== "built-in" && b.source === "built-in") return 1;
    return a.agentType.localeCompare(b.agentType);
  });

  const lines = sorted.map((a) => {
    const tag =
      a.source === "built-in"
        ? "built-in"
        : a.source === "project"
          ? "project"
          : "user";
    return `- ${a.agentType} [${tag}]: ${truncate(a.whenToUse, MAX_DESC_CHARS)}`;
  });

  return [
    "<system-reminder>",
    "Available sub-agents you can invoke via the `Agent` tool. Each sub-agent runs in its own context window with its own tool set and returns a concise summary.",
    "Call `Agent(prompt=\"...\", description=\"3-5 word task name\", subagent_type=\"<name>\")` to delegate a focused subtask.",
    "Use sub-agents to keep the main conversation context clean — search-heavy or read-heavy work is a good fit. Do not delegate trivial single-step tasks.",
    "Sub-agents do NOT see the main conversation history, so the `prompt` must be self-contained.",
    "",
    ...lines,
    "</system-reminder>",
  ].join("\n");
}
