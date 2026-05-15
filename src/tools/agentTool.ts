/**
 * Agent tool — the model's "delegate to a sub-agent" handle.
 *
 * Reference: claude-code-source-code/src/tools/AgentTool/AgentTool.tsx.
 * The source's AgentTool input schema is huge (prompt, description,
 * subagent_type, model, run_in_background, name, team_name, mode,
 * isolation, cwd, …). Stage 19 implements just the four fields the
 * tutorial needs: prompt, description, subagent_type, model.
 *
 * Flow:
 *   1. Validate input + look up the AgentDefinition by name.
 *   2. Resolve the model (explicit override → agent default → parent's).
 *   3. Pull the parent's permission infrastructure off ToolContext (set
 *      by QueryEngine on the per-submit enriched context).
 *   4. Call runChildAgent — it runs an isolated agentic loop and returns
 *      the sub-agent's final text plus stats.
 *   5. Format the result so the parent model sees a structured summary.
 *
 * Plan-mode behavior: Agent declares `isReadOnly: true` (mirroring source
 * — the actual permission decisions happen on the sub-agent's individual
 * tool calls). However the permissions.ts plan-mode branch denies any
 * tool not in PLAN_ALLOWED_TOOLS, so Agent cannot be spawned during
 * planning anyway. This is intentional — sub-agents shouldn't run while
 * the user is iterating on a plan they haven't approved.
 */

import { findAgent, getAllAgents } from "../agents/registry.js";
import type { AgentRunResult } from "../agents/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { DEFAULT_MODEL } from "../services/api/client.js";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRuleSet,
  PermissionSettings,
} from "../permissions/permissions.js";
import {
  completeSubAgentProgress,
  startSubAgentProgress,
  updateSubAgentProgress,
} from "../state/subAgentProgressStore.js";

// agentTool MUST avoid statically importing anything in the
// tools/* ↔ core/agenticLoop ↔ tools/* chain — otherwise the
// `tools/index.ts → BUILTIN_TOOLS includes agentTool → runAgent →
// agenticLoop → tools/index.ts` cycle hits a TDZ on `agentTool` itself
// before index.ts can finish initializing the BUILTIN_TOOLS array.
//
// Both helpers below dynamically import their dependencies at call-time,
// which breaks the cycle: by the time `agentTool.call()` runs, every
// module on the chain has finished evaluating its top-level code.
async function loadAllTools(): Promise<Tool[]> {
  const { getAllTools } = await import("./index.js");
  return getAllTools();
}

async function loadRunChildAgent(): Promise<
  typeof import("../agents/runAgent.js")["runChildAgent"]
> {
  const mod = await import("../agents/runAgent.js");
  return mod.runChildAgent;
}

interface AgentInput {
  prompt: string;
  description?: string;
  subagent_type?: string;
  model?: string;
}

function readInput(raw: Record<string, unknown>): AgentInput {
  const prompt = typeof raw["prompt"] === "string" ? raw["prompt"] : "";
  const description = typeof raw["description"] === "string" ? raw["description"] : undefined;
  const subagent_type =
    typeof raw["subagent_type"] === "string" ? raw["subagent_type"].trim() : undefined;
  const model = typeof raw["model"] === "string" ? raw["model"].trim() : undefined;
  return { prompt, description, subagent_type, model };
}

function formatResult(args: {
  agentType: string;
  description?: string;
  result: AgentRunResult;
}): string {
  const { agentType, description, result } = args;
  const headerLines = [
    `Sub-agent '${agentType}' completed.`,
    description ? `task: ${description}` : "",
    `turns: ${result.turnCount} | tools used: ${result.totalToolUseCount} | duration: ${result.totalDurationMs}ms`,
    `tokens: ${result.totalTokens} (input ${result.inputTokens}, output ${result.outputTokens})`,
    result.reason !== "completed" ? `stop reason: ${result.reason}` : "",
    result.warnings && result.warnings.length > 0
      ? `warnings:\n${result.warnings.map((w) => `  - ${w}`).join("\n")}`
      : "",
  ].filter(Boolean);

  return [
    headerLines.join("\n"),
    "",
    "<sub_agent_result>",
    result.finalText,
    "</sub_agent_result>",
  ].join("\n");
}

export const agentTool: Tool = {
  name: "Agent",
  description:
    "Delegate a focused subtask to a specialized sub-agent. The sub-agent runs in its own context window with its own tool set, completes the task, and returns a concise summary. " +
    "Use this when the subtask requires multiple tool calls (search, read many files, etc.) and you want to keep the main conversation context clean. " +
    "Choose `subagent_type` based on the available sub-agent definitions listed in the system prompt's <system-reminder> block. Defaults to 'general-purpose' if omitted. " +
    "The sub-agent does NOT see the main conversation history — write a self-contained `prompt`.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Self-contained task description for the sub-agent. The sub-agent has no access to the main conversation, so include all the context it needs.",
      },
      description: {
        type: "string",
        description: "A short (3-5 word) name for the task, shown in the UI.",
      },
      subagent_type: {
        type: "string",
        description:
          "Which sub-agent definition to use (e.g. 'general-purpose', 'Explore', or a custom name from .easy-agent/agents/). Defaults to 'general-purpose'.",
      },
      model: {
        type: "string",
        description:
          "Optional model override for this sub-agent. If omitted, the agent definition's `model` is used; if that is also omitted, the parent's model is used.",
      },
    },
    required: ["prompt", "description"],
    additionalProperties: false,
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { prompt, description, subagent_type, model } = readInput(input);

    if (!prompt || !prompt.trim()) {
      return {
        content: "Error: 'prompt' is required and must be a non-empty string.",
        isError: true,
      };
    }

    const agentType = subagent_type || "general-purpose";
    const def = findAgent(agentType);
    if (!def) {
      const available = getAllAgents()
        .map((a) => a.agentType)
        .join(", ");
      return {
        content: `Error: sub-agent type '${agentType}' is not registered. Available types: ${available || "(none)"}.`,
        isError: true,
      };
    }

    // Sub-agent's tool pool is filtered from the parent's full pool.
    // resolveAgentTools (called inside runChildAgent) strips the Agent
    // tool itself and applies the agent's allow/deny lists. Loaded
    // lazily to avoid the tools/index.ts ↔ tools/agentTool.ts cycle.
    const allTools = await loadAllTools();

    // Model resolution (most specific wins):
    //   1. Per-call override (input.model)
    //   2. Agent definition's `model` field
    //   3. Parent's active model (set by QueryEngine on the context)
    //   4. DEFAULT_MODEL (env or hard-coded fallback)
    const resolvedModel =
      model || def.model || context.defaultModel || DEFAULT_MODEL;

    const permissionMode = context.getPermissionMode?.() as PermissionMode | undefined;
    const permissionSettings = context.permissionSettings as PermissionSettings | undefined;
    const sessionPermissionRules = context.sessionPermissionRules as
      | PermissionRuleSet
      | undefined;
    const onPermissionRequest = context.onPermissionRequest as
      | ((request: PermissionRequest) => Promise<PermissionDecision>)
      | undefined;

    // The parent's tool_use id is our key into the sub-agent progress
    // store. UI subscribes to that store and merges live updates into
    // the matching ToolCallInfo. Without an id we can't correlate, so
    // we silently fall back to "no progress UI" — the tool still works.
    const progressKey = context.toolUseId;
    if (progressKey) {
      startSubAgentProgress(progressKey, {
        agentType,
        ...(description ? { description } : {}),
      });
    }

    // Map AgentProgressEvent (from the sub-agent's own loop) onto the
    // store's update API. We track tool count via tool_use_done (not
    // _start) to mirror the source's behavior of only counting completed
    // calls — avoids an inflated mid-call number flickering on the UI.
    const onProgress = progressKey
      ? (event: import("../agents/runAgent.js").AgentProgressEvent): void => {
          switch (event.type) {
            case "tool_use_start":
              // Optimistic update — show "running: <toolName>" the
              // moment the model emits the call, even before it
              // resolves. Count is incremented at done so it matches
              // the final tool-use total.
              updateSubAgentProgress(progressKey, {
                lastToolName: event.toolName,
                lastToolIsError: false,
              });
              break;
            case "tool_use_done":
              updateSubAgentProgress(progressKey, {
                lastToolName: event.toolName,
                lastToolIsError: event.isError === true,
              });
              break;
            case "turn_usage": {
              // Push the running token total to the store so the
              // SubAgentCard can render "28.0k tokens" live (matches
              // Claude Code's per-agent token line). We surface the
              // FULL accumulated cost — input + output + cache reads
              // + cache creation — because that's what the user
              // pays for and what the source counts in
              // calculateAgentStats (UI.tsx).
              const u = event.cumulativeUsage;
              const totalTokens =
                u.input_tokens +
                u.output_tokens +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0);
              updateSubAgentProgress(progressKey, {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                totalTokens,
              });
              break;
            }
            default:
              break;
          }
        }
      : undefined;

    try {
      const runChildAgent = await loadRunChildAgent();
      const result = await runChildAgent({
        agentDefinition: def,
        prompt,
        availableTools: allTools,
        model: resolvedModel,
        parentToolContext: context,
        permissionMode,
        permissionSettings,
        sessionPermissionRules,
        onPermissionRequest,
        abortSignal: context.abortSignal,
        ...(onProgress ? { onProgress } : {}),
      });

      if (progressKey) {
        completeSubAgentProgress(progressKey, {
          reason: result.reason,
          durationMs: result.totalDurationMs,
          totalTokens: result.totalTokens,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          toolUseCount: result.totalToolUseCount,
        });
      }

      return { content: formatResult({ agentType, description, result }) };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (progressKey) {
        // model_error is the closest LoopTerminationReason for "the
        // sub-agent threw" — runChildAgent itself didn't return because
        // the agentic loop crashed. The store maps this (with isError
        // also set) onto status: "error" for the UI.
        completeSubAgentProgress(progressKey, {
          reason: "model_error",
          durationMs: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolUseCount: 0,
          isError: true,
        });
      }
      return {
        content: `Error: sub-agent '${agentType}' failed to complete: ${msg}`,
        isError: true,
      };
    }
  },

  isReadOnly(): boolean {
    // Mirrors source: the Agent tool itself has no side effects — its
    // sub-agent's individual tool calls each go through their own
    // permission checks. Plan-mode still rejects Agent because plan
    // mode's allow-list only contains Read/Grep/Glob.
    return true;
  },

  isEnabled(): boolean {
    return true;
  },

  /**
   * Mirrors source (`AgentTool.tsx → isConcurrencySafe()` returns true).
   * Each sub-agent runs in its own isolated context and the only shared
   * state it touches — the parent's permission settings + session rules
   * + the per-call entry in subAgentProgressStore — is keyed by the
   * tool_use id, so two concurrent Agent invocations cannot collide.
   * This is the change that lets the model fan out N independent
   * sub-agents in a single assistant turn (e.g. "review code" + "audit
   * security" in parallel) instead of waiting on each one in series.
   */
  isConcurrencySafe(): boolean {
    return true;
  },
};
