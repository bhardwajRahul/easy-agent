/**
 * Hook executor — spawns one shell command per configured hook, pipes
 * the event's JSON payload to stdin, captures stdout / stderr / exit
 * code, and interprets the result per Claude Code's hook protocol.
 *
 * Source mirror: `claude-code-source-code/src/utils/hooks.ts` →
 *   - `execCommandHook` (the spawn + capture mechanics, lines 830+)
 *   - `processHookJSONOutput` (decoding JSON into HookResult fields)
 *
 * Hook protocol summary (what the user-authored shell script gets):
 *   - stdin = JSON.stringify(hookInput)
 *   - env.EASY_AGENT_PROJECT_DIR = absolute cwd
 *   - exit 0 → success; stdout text is shown to the user (unless
 *     `suppressOutput: true` in JSON)
 *   - exit 2 → "block": stderr text is fed back to the model so it
 *     can adapt. Same convention Claude Code uses.
 *   - any other non-zero → "non-blocking error": surfaced as a
 *     warning but the loop continues
 *   - JSON stdout (parseable by `JSON.parse`) → richer control:
 *       { continue: false }                       → stop the loop
 *       { decision: "block", reason: "..." }      → block
 *       { systemMessage: "..." }                  → show to user
 *       { hookSpecificOutput: { permissionDecision: "deny" / "ask" / "allow",
 *                                additionalContext: "...", ... } }
 *
 * The Anthropic SDK + agentic loop don't care about most of these
 * fields — they care about three outputs:
 *   1. blockingError (rejects a tool call OR ends a turn)
 *   2. permissionBehavior (overrides the permission check)
 *   3. additionalContext (injected verbatim into the model's context)
 *
 * Everything else (systemMessage / suppressOutput / continue) is
 * still surfaced via HookResult so the UI layer can render it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  HookCommand,
  HookEvent,
  HookInput,
  HookJSONOutput,
  HookResult,
} from "./types.js";

const DEFAULT_TIMEOUT_SEC = 60;

/**
 * Run one shell-command hook and return its raw subprocess result.
 *
 * Why we don't use exec/execFile:
 *   - Hooks need stdin piping (the JSON payload)
 *   - We want streaming stdout/stderr capture with abort support
 *   - The shell flag matters (some hooks rely on `$VAR` expansion)
 *
 * We spawn `bash -c "<command>"` (or `sh -c` if the entry asked for
 * `shell: "sh"`). On Windows this still uses bash via Git Bash if
 * present; we don't bother supporting cmd.exe / PowerShell to keep
 * the teaching version small. The README will note this.
 */
async function runShellCommand(
  hook: HookCommand,
  jsonInput: string,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted: boolean;
  timedOut: boolean;
  durationMs: number;
}> {
  const shellBin = hook.shell === "sh" ? "sh" : "bash";
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(shellBin, ["-c", hook.command], {
      cwd,
      env: {
        ...process.env,
        // Source exposes CLAUDE_PROJECT_DIR; we follow the same
        // pattern with the Easy Agent prefix so hooks can resolve
        // their working tree without re-doing process.cwd() (which
        // may differ for sub-agents running in a worktree).
        EASY_AGENT_PROJECT_DIR: cwd,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort; process may have already exited.
      }
    };

    if (signal?.aborted) {
      // Already aborted before spawn finished — bail synchronously.
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      // Spawn failed (e.g. shell binary missing). Synthesize a
      // non-blocking error result.
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr: stderr || `Hook spawn failed: ${err.message}`,
        exitCode: 1,
        aborted,
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (aborted ? 130 : 1),
        aborted,
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });

    // Feed the event payload over stdin and close.
    try {
      child.stdin.end(jsonInput);
    } catch {
      // Race: child exited before stdin write finished. The 'close'
      // handler will resolve us with whatever we captured so far.
    }
  });
}

// ─── Output parsing + interpretation ──────────────────────────────────

/**
 * Try to parse stdout as JSON. Returns the parsed object if it looks
 * like a hook output payload (an object — primitives don't count);
 * otherwise undefined and the caller treats stdout as plain text.
 *
 * We do NOT throw on parse failure — many hooks legitimately return
 * plain text (e.g. `git status -s` for SessionStart context injection).
 */
function tryParseJsonOutput(stdout: string): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookJSONOutput;
    }
  } catch {
    // Not JSON — treat as plain text.
  }
  return undefined;
}

/**
 * Decode a parsed JSON output into the relevant HookResult fields.
 *
 * Mirror: source's `processHookJSONOutput` (utils/hooks.ts line 569).
 * Source has many more branches (`SubagentStart`, `PermissionDenied`,
 * `Elicitation`, …); we ship the four event-specific branches that
 * actually flow control in Easy Agent.
 */
function decodeJsonOutput(
  json: HookJSONOutput,
  hookEvent: HookEvent,
  commandLabel: string,
): Partial<HookResult> {
  const out: Partial<HookResult> = {};

  // ─── Continue / stop the loop ─────────────────────────────────────
  if (json.continue === false) {
    out.preventContinuation = true;
    if (json.stopReason) out.stopReason = json.stopReason;
  }

  // ─── Legacy top-level `decision` (still supported by source) ─────
  if (json.decision === "approve") {
    out.permissionBehavior = "allow";
  } else if (json.decision === "block") {
    out.permissionBehavior = "deny";
    out.blockingError =
      json.reason || `Blocked by ${hookEvent} hook (${commandLabel})`;
  }

  if (json.systemMessage) out.systemMessage = json.systemMessage;

  // ─── hookSpecificOutput overrides (most specific, runs last) ─────
  const spec = json.hookSpecificOutput;
  if (spec) {
    if (
      spec.hookEventName &&
      spec.hookEventName !== hookEvent
    ) {
      // Source validates this — we keep it loose and just log via
      // stderr; the easy-agent uses console for diagnostics elsewhere.
      // We DO honor the spec block regardless so a stray name field
      // doesn't tank an otherwise valid hook.
    }

    if (hookEvent === "PreToolUse" && spec.permissionDecision) {
      switch (spec.permissionDecision) {
        case "allow":
          out.permissionBehavior = "allow";
          break;
        case "ask":
          out.permissionBehavior = "ask";
          break;
        case "deny":
          out.permissionBehavior = "deny";
          out.blockingError =
            spec.permissionDecisionReason ||
            json.reason ||
            `Blocked by PreToolUse hook (${commandLabel})`;
          break;
      }
      if (spec.permissionDecisionReason) {
        out.permissionDecisionReason = spec.permissionDecisionReason;
      }
    }

    if (spec.additionalContext && typeof spec.additionalContext === "string") {
      out.additionalContext = spec.additionalContext;
    }
  }

  if (
    out.permissionBehavior !== undefined &&
    out.permissionDecisionReason === undefined &&
    json.reason
  ) {
    out.permissionDecisionReason = json.reason;
  }

  return out;
}

// ─── Public entry point ───────────────────────────────────────────────

/**
 * Run one hook end-to-end and return a fully decoded HookResult.
 * Never throws — every failure path is captured into the returned
 * `outcome` + `stderr` fields so the caller can render them.
 */
export async function executeHookCommand(params: {
  hook: HookCommand;
  hookEvent: HookEvent;
  hookName: string;
  hookInput: HookInput;
  cwd: string;
  signal?: AbortSignal;
}): Promise<HookResult> {
  const { hook, hookEvent, hookName, hookInput, cwd, signal } = params;
  const jsonInput = JSON.stringify(hookInput);
  const commandLabel = hook.command;

  const run = await runShellCommand(hook, jsonInput, signal, cwd);

  // ─── Aborted by signal (parent loop interrupted) ─────────────────
  if (run.aborted) {
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "cancelled",
      stdout: run.stdout,
      stderr: run.stderr || "Hook cancelled before completion",
      exitCode: run.exitCode,
    };
  }

  // ─── Timeout (synthesize a non-blocking error) ───────────────────
  if (run.timedOut) {
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "non_blocking_error",
      stdout: run.stdout,
      stderr:
        run.stderr ||
        `Hook timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_SEC}s`,
      exitCode: run.exitCode,
    };
  }

  // ─── JSON output path (richer control) ───────────────────────────
  const json = tryParseJsonOutput(run.stdout);
  if (json) {
    const decoded = decodeJsonOutput(json, hookEvent, commandLabel);
    // exit code 2 still beats JSON `decision: "approve"` — source
    // says blocking errors always win — but JSON `decision: "block"`
    // already set `blockingError`, so no special case needed here.
    if (run.exitCode === 2 && !decoded.blockingError) {
      decoded.blockingError =
        run.stderr.trim() || `Hook returned exit code 2 (${commandLabel})`;
      decoded.permissionBehavior ??= "deny";
    }
    const outcome: HookResult["outcome"] = decoded.blockingError
      ? "blocking"
      : run.exitCode === 0
        ? "success"
        : "non_blocking_error";
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      ...decoded,
    };
  }

  // ─── Plain-text path (no JSON) ───────────────────────────────────
  if (run.exitCode === 0) {
    // For UserPromptSubmit / SessionStart / PostToolUse, source treats
    // any non-empty stdout from a successful hook as additionalContext.
    // It's the most common pattern in the wild — `git status -s` or
    // `cat ENV.md` style hooks.
    const stdoutTrimmed = run.stdout.trim();
    const additionalContext =
      stdoutTrimmed &&
      (hookEvent === "UserPromptSubmit" ||
        hookEvent === "SessionStart" ||
        hookEvent === "PostToolUse")
        ? stdoutTrimmed
        : undefined;
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "success",
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      ...(additionalContext ? { additionalContext } : {}),
    };
  }

  if (run.exitCode === 2) {
    // Source's special "blocking" exit code.
    return {
      hookName,
      command: commandLabel,
      durationMs: run.durationMs,
      outcome: "blocking",
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      permissionBehavior: "deny",
      blockingError:
        run.stderr.trim() || `Hook returned exit code 2 (${commandLabel})`,
    };
  }

  // Any other non-zero — surface as a warning, but don't block.
  return {
    hookName,
    command: commandLabel,
    durationMs: run.durationMs,
    outcome: "non_blocking_error",
    stdout: run.stdout,
    stderr: run.stderr || `Hook exited with code ${run.exitCode}`,
    exitCode: run.exitCode,
  };
}

/**
 * Generate a fresh tool-use-id-like correlator. Used as the hook
 * payload's `tool_use_id` field when the caller doesn't already have
 * one (UserPromptSubmit / SessionStart / Stop).
 */
export function newHookCorrelationId(): string {
  return randomUUID();
}
