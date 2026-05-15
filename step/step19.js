/**
 * Step 19 - Sub-agent
 *
 * Goal:
 * - load built-in / custom agent definitions
 * - inject available agents into the system prompt
 * - filter a child agent's tool pool
 * - run a child agent with isolated messages
 * - expose the flow as an Agent tool
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// -----------------------------------------------------------------------------
// 1. Agent definition loading
// -----------------------------------------------------------------------------

export function getUserAgentsDir() {
  return path.join(os.homedir(), ".easy-agent", "agents");
}

export function getProjectAgentsDir(cwd) {
  return path.join(cwd, ".easy-agent", "agents");
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(content) {
  const match = String(content).match(FRONTMATTER_RE);
  if (!match) return { raw: {}, body: String(content) };

  try {
    const parsed = parseYaml(match[1]);
    return {
      raw: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {},
      body: match[2],
    };
  } catch (error) {
    return { raw: {}, body: match[2], parseError: error.message };
  }
}

function asString(value) {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim());
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

function asPositiveInt(value) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function loadFromOneDir(dir, source) {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { agents: [], warnings: [] };
    return { agents: [], warnings: ["Failed to read " + dir + ": " + error.message] };
  }

  const agents = [];
  const warnings = [];

  for (const entry of dirents) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(dir, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    const split = splitFrontmatter(raw);

    const name = asString(split.raw.name);
    const description = asString(split.raw.description);
    const systemPrompt = split.body.trim();

    if (split.parseError || !name || !description || !systemPrompt) {
      warnings.push("[agents] Skipping " + entry.name + ": invalid agent definition");
      continue;
    }

    const tools = asStringArray(split.raw.tools);
    const disallowedTools = asStringArray(
      split.raw.disallowedTools ?? split.raw.disallowed_tools,
    );
    const model = asString(split.raw.model);
    const maxTurns = asPositiveInt(split.raw.maxTurns ?? split.raw.max_turns);
    const permissionMode = asString(split.raw.permissionMode ?? split.raw.permission_mode);

    agents.push({
      agentType: name,
      whenToUse: description,
      ...(tools.length ? { tools } : {}),
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(model ? { model } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      source,
      filePath,
      getSystemPrompt: () => systemPrompt,
    });
  }

  return { agents, warnings };
}

export async function loadAllCustomAgents(cwd) {
  const [user, project] = await Promise.all([
    loadFromOneDir(getUserAgentsDir(), "user"),
    loadFromOneDir(getProjectAgentsDir(cwd), "project"),
  ]);

  return {
    agents: [...user.agents, ...project.agents],
    warnings: [...user.warnings, ...project.warnings],
  };
}

// -----------------------------------------------------------------------------
// 2. Built-ins, registry, prompt injection
// -----------------------------------------------------------------------------

export const EXPLORE_AGENT = {
  agentType: "Explore",
  whenToUse: "Read-only code search and exploration agent.",
  disallowedTools: ["Write", "Edit", "MemoryWrite"],
  source: "built-in",
  getSystemPrompt: () => `You are a read-only code exploration sub-agent.

Do not modify files. Use Read, Grep, Glob, and read-only Bash only.
Return a concise report with relevant paths, patterns, and gotchas.`,
};

export const GENERAL_PURPOSE_AGENT = {
  agentType: "general-purpose",
  whenToUse: "General-purpose sub-agent for focused multi-tool subtasks.",
  source: "built-in",
  getSystemPrompt: () => `You are a general-purpose sub-agent.

Complete the delegated task in your own context window.
Return a concise, factual summary for the main agent.`,
};

const agentRegistry = new Map();

export function setAgents(agents) {
  agentRegistry.clear();
  for (const agent of agents) agentRegistry.set(agent.agentType, agent);
}

export function getAllAgents() {
  return [...agentRegistry.values()];
}

export function findAgent(agentType) {
  return agentRegistry.get(agentType);
}

export async function bootstrapAgents(cwd) {
  const builtIns = [EXPLORE_AGENT, GENERAL_PURPOSE_AGENT];
  const { agents: custom, warnings } = await loadAllCustomAgents(cwd);

  // Built-ins first, then user/project agents. Map overwrite means
  // project > user > built-in for same-name definitions.
  setAgents([...builtIns, ...custom]);

  return { builtInCount: builtIns.length, customCount: custom.length, warnings };
}

export function formatAgentsSystemReminder(agents) {
  if (!agents.length) return "";

  const lines = [...agents]
    .sort((a, b) => {
      if (a.source === "built-in" && b.source !== "built-in") return -1;
      if (a.source !== "built-in" && b.source === "built-in") return 1;
      return a.agentType.localeCompare(b.agentType);
    })
    .map((agent) => "- " + agent.agentType + " [" + agent.source + "]: " + agent.whenToUse);

  return [
    "<system-reminder>",
    "Available sub-agents can be invoked with the `Agent` tool.",
    'Call Agent with `prompt`, `description`, and optional `subagent_type`.',
    "The prompt must be self-contained because sub-agents do not see parent history.",
    "",
    ...lines,
    "",
    "Custom agents live at `<cwd>/.easy-agent/agents/<name>.md` with YAML frontmatter:",
    "`name`, `description`, optional `tools`, `disallowedTools`, `model`, `maxTurns`.",
    "</system-reminder>",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 3. Tool resolution
// -----------------------------------------------------------------------------

export function resolveAgentTools(agent, availableTools) {
  const disallowed = new Set(["Agent", ...(agent.disallowedTools || [])]);
  const base = availableTools.filter((tool) => !disallowed.has(tool.name));

  if (!agent.tools || agent.tools.length === 0 || agent.tools.includes("*")) {
    return { resolvedTools: base, invalidTools: [] };
  }

  const byName = new Map(base.map((tool) => [tool.name, tool]));
  const resolvedTools = [];
  const invalidTools = [];

  for (const name of agent.tools) {
    const tool = byName.get(name);
    if (tool) resolvedTools.push(tool);
    else invalidTools.push(name);
  }

  return { resolvedTools, invalidTools };
}

export function toolToApiParam(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.inputSchema || { type: "object", properties: {} },
  };
}

// -----------------------------------------------------------------------------
// 4. Child agent runner
// -----------------------------------------------------------------------------

export const DEFAULT_AGENT_MAX_TURNS = 30;

function extractFinalAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "(Sub-agent completed but produced no text output.)";
}

function countToolUses(messages) {
  return messages.reduce((count, message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return count;
    return count + message.content.filter((block) => block.type === "tool_use").length;
  }, 0);
}

export async function* mockQueryRunner(params) {
  yield { type: "text", text: "Working in child context..." };
  yield {
    type: "done",
    reason: "completed",
    usage: { input_tokens: 120, output_tokens: 40 },
    turnCount: 1,
    messages: [
      ...params.messages,
      {
        role: "assistant",
        content: "Child agent final summary: relevant files found and patterns summarized.",
      },
    ],
  };
}

export async function runChildAgent(params) {
  const start = Date.now();
  const agent = params.agentDefinition;
  const { resolvedTools, invalidTools } = resolveAgentTools(agent, params.availableTools);
  const queryRunner = params.queryRunner || mockQueryRunner;

  const subSessionId =
    (params.parentToolContext?.sessionId || "session") +
    "/agent-" +
    agent.agentType +
    "-" +
    Date.now().toString(36);

  const initialMessages = [{ role: "user", content: params.prompt }];
  let finalMessages = initialMessages;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let turnCount = 0;
  let reason = "completed";

  for await (const event of queryRunner({
    messages: initialMessages,
    systemPrompt: agent.getSystemPrompt(),
    tools: resolvedTools.map(toolToApiParam),
    model: params.model,
    maxTurns: agent.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    toolContext: {
      ...params.parentToolContext,
      sessionId: subSessionId,
      getPermissionMode: () => agent.permissionMode ?? params.permissionMode ?? "default",
    },
  })) {
    if (event.type === "done") {
      finalMessages = event.messages;
      usage = event.usage || usage;
      turnCount = event.turnCount || turnCount;
      reason = event.reason || reason;
    }
    params.onProgress?.(event);
  }

  return {
    agentType: agent.agentType,
    finalText: extractFinalAssistantText(finalMessages),
    messages: finalMessages,
    totalToolUseCount: countToolUses(finalMessages),
    totalDurationMs: Date.now() - start,
    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    turnCount,
    reason,
    ...(invalidTools.length
      ? { warnings: ["Unknown tools ignored: " + invalidTools.join(", ")] }
      : {}),
  };
}

// -----------------------------------------------------------------------------
// 5. Agent tool and small progress store
// -----------------------------------------------------------------------------

const progressStore = new Map();

export function getSubAgentProgress(toolUseId) {
  return progressStore.get(toolUseId);
}

function setProgress(toolUseId, patch) {
  if (!toolUseId) return;
  progressStore.set(toolUseId, { ...(progressStore.get(toolUseId) || {}), ...patch });
}

function formatAgentResult(agentType, description, result) {
  return [
    "Sub-agent '" + agentType + "' completed.",
    description ? "task: " + description : "",
    "turns: " + result.turnCount + " | tools used: " + result.totalToolUseCount,
    "tokens: " + result.totalTokens,
    result.warnings?.length ? "warnings: " + result.warnings.join("; ") : "",
    "",
    "<sub_agent_result>",
    result.finalText,
    "</sub_agent_result>",
  ].filter(Boolean).join("\n");
}

export function createAgentTool({
  getAllTools,
  runAgent = runChildAgent,
  queryRunner = mockQueryRunner,
  defaultModel = "claude-sonnet-4-5",
} = {}) {
  return {
    name: "Agent",
    description:
      "Delegate a focused subtask to a sub-agent with isolated context.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        subagent_type: { type: "string" },
        model: { type: "string" },
      },
      required: ["prompt", "description"],
      additionalProperties: false,
    },

    async call(input, context = {}) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const description = typeof input.description === "string" ? input.description : "";
      const agentType =
        typeof input.subagent_type === "string" && input.subagent_type.trim()
          ? input.subagent_type.trim()
          : "general-purpose";

      if (!prompt) return { content: "Error: prompt is required.", isError: true };

      const agent = findAgent(agentType);
      if (!agent) {
        return {
          content:
            "Error: unknown sub-agent '" +
            agentType +
            "'. Available: " +
            getAllAgents().map((a) => a.agentType).join(", "),
          isError: true,
        };
      }

      setProgress(context.toolUseId, {
        agentType,
        description,
        status: "running",
        startedAt: Date.now(),
      });

      const result = await runAgent({
        agentDefinition: agent,
        prompt,
        availableTools: getAllTools ? await getAllTools() : [],
        model: input.model || agent.model || context.defaultModel || defaultModel,
        parentToolContext: context,
        permissionMode: context.getPermissionMode?.(),
        queryRunner,
      });

      setProgress(context.toolUseId, {
        status: result.reason === "completed" ? "completed" : "error",
        durationMs: result.totalDurationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
      });

      return {
        content: formatAgentResult(agentType, description, result),
      };
    },

    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  };
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export const DEMO_TOOLS = [
  { name: "Read", description: "Read a file" },
  { name: "Grep", description: "Search files" },
  { name: "Glob", description: "Find files" },
  { name: "Write", description: "Write a file" },
  { name: "Edit", description: "Edit a file" },
  { name: "Agent", description: "Delegate to a child agent" },
];

export async function demoStep19(cwd = process.cwd()) {
  await bootstrapAgents(cwd);

  const agentTool = createAgentTool({ getAllTools: async () => DEMO_TOOLS });
  const result = await agentTool.call(
    {
      prompt: "Find the sandbox implementation and summarize it.",
      description: "Explore sandbox",
      subagent_type: "Explore",
    },
    {
      cwd,
      sessionId: "demo-session",
      toolUseId: "toolu_demo_agent",
      getPermissionMode: () => "default",
    },
  );

  return {
    reminder: formatAgentsSystemReminder(getAllAgents()),
    progress: getSubAgentProgress("toolu_demo_agent"),
    result,
  };
}
