/**
 * Step 22 - Hooks lifecycle system
 *
 * Goal:
 * - load hooks from user/project settings.json
 * - match hooks by event + matcher
 * - execute command hooks with JSON stdin and timeout
 * - interpret exit codes and JSON output
 * - aggregate permission decisions and additional context
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Settings and matcher selection
// -----------------------------------------------------------------------------

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
];

const DEFAULT_TIMEOUT_SEC = 60;

export function getEasyAgentHome() {
  return process.env.EASY_AGENT_HOME || path.join(os.homedir(), ".easy-agent");
}

export function getUserSettingsPath() {
  return path.join(getEasyAgentHome(), "settings.json");
}

export function getProjectSettingsPath(cwd) {
  return path.join(cwd, ".easy-agent", "settings.json");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeHookCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type || "command";
  if (type !== "command") return null;
  if (typeof raw.command !== "string" || !raw.command.trim()) return null;
  return {
    type: "command",
    command: raw.command,
    timeout:
      typeof raw.timeout === "number" && raw.timeout > 0
        ? raw.timeout
        : DEFAULT_TIMEOUT_SEC,
    ...(raw.shell === "sh" || raw.shell === "bash" ? { shell: raw.shell } : {}),
  };
}

function normalizeMatcherGroup(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.hooks)) return null;
  const hooks = raw.hooks.map(normalizeHookCommand).filter(Boolean);
  if (!hooks.length) return null;
  return {
    ...(typeof raw.matcher === "string" && raw.matcher ? { matcher: raw.matcher } : {}),
    hooks,
  };
}

function normalizeHooksBlock(rawHooks) {
  const out = {};
  if (!rawHooks || typeof rawHooks !== "object") return out;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(rawHooks[event])
      ? rawHooks[event].map(normalizeMatcherGroup).filter(Boolean)
      : [];
    if (groups.length) out[event] = groups;
  }
  return out;
}

export async function loadHooksSettings(cwd) {
  const [user, project] = await Promise.all([
    readJson(getUserSettingsPath()),
    readJson(getProjectSettingsPath(cwd)),
  ]);
  const userHooks = normalizeHooksBlock(user.hooks);
  const projectHooks = normalizeHooksBlock(project.hooks);
  const merged = {};
  for (const event of HOOK_EVENTS) {
    const list = [...(userHooks[event] || []), ...(projectHooks[event] || [])];
    if (list.length) merged[event] = list;
  }
  return merged;
}

function isRegexMatcher(matcher) {
  return /[*.?+()[\]{}|^$\\]/.test(matcher);
}

function matcherFires(matcher, matchField) {
  if (!matcher || matcher === "*") return true;
  if (!matchField) return true;
  if (!isRegexMatcher(matcher)) return matcher === matchField;
  try {
    return new RegExp("^(?:" + matcher + ")$").test(matchField);
  } catch {
    return false;
  }
}

export function findMatchingHooks(settings, event, matchField) {
  const groups = settings[event] || [];
  return groups.flatMap((group) => (matcherFires(group.matcher, matchField) ? group.hooks : []));
}

// -----------------------------------------------------------------------------
// 2. Hook executor
// -----------------------------------------------------------------------------

async function runShellCommand(hook, hookInput, cwd, signal) {
  const shellBin = hook.shell === "sh" ? "sh" : "bash";
  const timeoutMs = (hook.timeout || DEFAULT_TIMEOUT_SEC) * 1000;
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn(shellBin, ["-c", hook.command], {
      cwd,
      env: { ...process.env, EASY_AGENT_PROJECT_DIR: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const done = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    };

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr ||= error.message;
      done(1);
    });
    child.on("close", (code) => done(code ?? 1));

    child.stdin.end(JSON.stringify(hookInput));
  });
}

function tryParseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJsonOutput(json, hookEvent, command) {
  const out = {};
  if (json.continue === false) {
    out.preventContinuation = true;
    out.stopReason = json.stopReason;
  }
  if (json.decision === "approve") out.permissionBehavior = "allow";
  if (json.decision === "block") {
    out.permissionBehavior = "deny";
    out.blockingError = json.reason || "Blocked by hook: " + command;
  }
  if (json.systemMessage) out.systemMessage = json.systemMessage;

  const specific = json.hookSpecificOutput || {};
  if (hookEvent === "PreToolUse" && specific.permissionDecision) {
    out.permissionBehavior =
      specific.permissionDecision === "deny" ? "deny" : specific.permissionDecision;
    out.permissionDecisionReason = specific.permissionDecisionReason;
    if (specific.permissionDecision === "deny") {
      out.blockingError = specific.permissionDecisionReason || "Blocked by PreToolUse hook";
    }
  }
  if (typeof specific.additionalContext === "string") {
    out.additionalContext = specific.additionalContext;
  }
  return out;
}

export async function executeHookCommand({ hook, hookEvent, hookName, hookInput, cwd, signal }) {
  const run = await runShellCommand(hook, hookInput, cwd, signal);

  if (run.aborted) {
    return { hookName, command: hook.command, outcome: "cancelled", ...run };
  }
  if (run.timedOut) {
    return {
      hookName,
      command: hook.command,
      outcome: "non_blocking_error",
      ...run,
      stderr: run.stderr || "Hook timed out",
    };
  }

  const json = tryParseJson(run.stdout);
  if (json) {
    const decoded = decodeJsonOutput(json, hookEvent, hook.command);
    if (run.exitCode === 2 && !decoded.blockingError) {
      decoded.permissionBehavior = "deny";
      decoded.blockingError = run.stderr.trim() || "Hook exited with code 2";
    }
    return {
      hookName,
      command: hook.command,
      outcome: decoded.blockingError ? "blocking" : run.exitCode === 0 ? "success" : "non_blocking_error",
      ...run,
      ...decoded,
    };
  }

  if (run.exitCode === 0) {
    const additionalContext =
      ["UserPromptSubmit", "SessionStart", "PostToolUse"].includes(hookEvent) &&
      run.stdout.trim()
        ? run.stdout.trim()
        : undefined;
    return {
      hookName,
      command: hook.command,
      outcome: "success",
      ...run,
      ...(additionalContext ? { additionalContext } : {}),
    };
  }

  if (run.exitCode === 2) {
    return {
      hookName,
      command: hook.command,
      outcome: "blocking",
      ...run,
      permissionBehavior: "deny",
      blockingError: run.stderr.trim() || "Hook exited with code 2",
    };
  }

  return { hookName, command: hook.command, outcome: "non_blocking_error", ...run };
}

// -----------------------------------------------------------------------------
// 3. Per-event runners and aggregation
// -----------------------------------------------------------------------------

function aggregate(results) {
  const out = { results };
  const priority = { allow: 1, ask: 2, deny: 3 };
  const contexts = [];
  const messages = [];

  for (const result of results) {
    if (
      result.permissionBehavior &&
      priority[result.permissionBehavior] > (priority[out.permissionBehavior] || 0)
    ) {
      out.permissionBehavior = result.permissionBehavior;
      out.permissionDecisionReason = result.permissionDecisionReason;
    }
    if (result.blockingError && !out.blockingError) out.blockingError = result.blockingError;
    if (result.preventContinuation) {
      out.preventContinuation = true;
      out.stopReason ||= result.stopReason;
    }
    if (result.additionalContext) contexts.push(result.additionalContext);
    if (result.systemMessage) messages.push(result.systemMessage);
  }

  if (contexts.length) out.additionalContext = contexts.join("\n\n");
  if (messages.length) out.systemMessage = messages.join("\n\n");
  return out;
}

async function runHooksForEvent({ event, matchField, hookInput, cwd, signal }) {
  if (process.env.EASY_AGENT_DISABLE_HOOKS) return { results: [] };
  const settings = await loadHooksSettings(cwd);
  const hooks = findMatchingHooks(settings, event, matchField);
  const results = await Promise.all(
    hooks.map((hook) =>
      executeHookCommand({
        hook,
        hookEvent: event,
        hookName: event + (matchField ? ":" + matchField : ""),
        hookInput,
        cwd,
        signal,
      }),
    ),
  );
  return aggregate(results);
}

export function runPreToolUseHooks(params) {
  return runHooksForEvent({
    event: "PreToolUse",
    matchField: params.toolName,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "PreToolUse",
      session_id: params.sessionId || "",
      cwd: params.cwd,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
    },
  });
}

export function runUserPromptSubmitHooks(params) {
  return runHooksForEvent({
    event: "UserPromptSubmit",
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "UserPromptSubmit",
      session_id: params.sessionId || "",
      cwd: params.cwd,
      prompt: params.prompt,
    },
  });
}

export function runSessionStartHooks(params) {
  return runHooksForEvent({
    event: "SessionStart",
    matchField: params.source,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SessionStart",
      session_id: params.sessionId || "",
      cwd: params.cwd,
      source: params.source,
    },
  });
}

export function runSubagentStopHooks(params) {
  return runHooksForEvent({
    event: "SubagentStop",
    matchField: params.agentType,
    cwd: params.cwd,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SubagentStop",
      session_id: params.sessionId || "",
      cwd: params.cwd,
      agent_id: params.agentId,
      agent_type: params.agentType,
      last_assistant_message: params.lastAssistantMessage,
    },
  });
}

// -----------------------------------------------------------------------------
// 4. Demo
// -----------------------------------------------------------------------------

export async function demoStep22() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step22-"));
  const cwd = path.join(tmp, "project");
  const prevHome = process.env.EASY_AGENT_HOME;
  process.env.EASY_AGENT_HOME = path.join(tmp, "home", ".easy-agent");
  await fs.mkdir(path.join(cwd, ".easy-agent"), { recursive: true });

  try {
    await fs.writeFile(
      path.join(cwd, ".easy-agent", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    command:
                      "node -e \"console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'No Bash today'}}))\"",
                  },
                ],
              },
            ],
            UserPromptSubmit: [{ hooks: [{ command: "echo injected-context" }] }],
          },
        },
        null,
        2,
      ),
    );

    const pre = await runPreToolUseHooks({
      toolName: "Bash",
      toolInput: { command: "rm -rf tmp" },
      toolUseId: "toolu_demo",
      cwd,
      sessionId: "demo",
    });
    const prompt = await runUserPromptSubmitHooks({
      prompt: "hello",
      cwd,
      sessionId: "demo",
    });
    return { pre, prompt };
  } finally {
    if (prevHome === undefined) delete process.env.EASY_AGENT_HOME;
    else process.env.EASY_AGENT_HOME = prevHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
