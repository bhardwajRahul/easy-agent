/**
 * Hooks system types (Stage 22).
 *
 * Mirrors a slim subset of Claude Code's `src/utils/hooks.ts` +
 * `src/entrypoints/agentSdkTypes.ts`. Source defines 25+ event types
 * — we teach 6:
 *
 *   PreToolUse  — fires before each tool execution; can deny / ask / inject context
 *   PostToolUse — fires after each tool execution; can inject context for the model
 *   UserPromptSubmit — fires before each user prompt; can inject context or block
 *   SessionStart — fires once at session boot (or resume); can inject startup context
 *   Stop        — fires when the main agent is about to finish a turn
 *   SubagentStop — fires when a sub-agent / background agent / teammate finishes
 *
 * On-disk shape (under `~/.easy-agent/settings.json` or
 * `<cwd>/.easy-agent/settings.json`):
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash", "hooks": [{ "type": "command",
 *           "command": "./check.sh", "timeout": 30 }] }
 *       ],
 *       "UserPromptSubmit": [
 *         { "hooks": [{ "type": "command", "command": "git status -s" }] }
 *       ]
 *     }
 *   }
 *
 * The on-disk shape mirrors Claude Code's exactly so users that have
 * existing `.claude/settings.json` hook blocks can paste them in.
 *
 * What we deliberately DON'T teach (source has all of these):
 *   - `type: "prompt"` (LLM-based hook) — needs a side query path
 *   - `type: "agent"` (sub-agent hook) — same
 *   - `type: "http"` / `type: "function"` / `type: "callback"`
 *   - Async hook backgrounding (AsyncHookRegistry)
 *   - Plugin-source / managed-source hooks (only user + project here)
 *   - PreCompact / PostCompact / SubagentStart / Setup / ConfigChange /
 *     PermissionDenied / TeammateIdle / TaskCreated / WorktreeCreate
 *     and ~15 other events
 */

// ─── Event names ──────────────────────────────────────────────────────

/** The six hook events Easy Agent ships. */
export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

// ─── On-disk configuration shape ──────────────────────────────────────

/**
 * One executable hook entry. Source supports several `type` values
 * (command / prompt / agent / http / function / callback); we ship
 * only "command" — the shell-exec one — because it covers >90% of
 * real-world hook use cases and stays language-agnostic.
 */
export interface HookCommand {
  type?: "command";
  /** Shell command to execute. Receives JSON hook input on stdin. */
  command: string;
  /**
   * Timeout in seconds (matches source's units — settings.json
   * shipped by Claude Code uses seconds, not ms, in this field).
   * Default 60s.
   */
  timeout?: number;
  /**
   * Optional shell override. Today we only support "bash" (or
   * `sh` on POSIX when bash is unavailable). Source supports
   * "powershell" too — we omit it for simplicity.
   */
  shell?: "bash" | "sh";
}

/**
 * One matcher group — a set of hooks that fires when the inbound
 * event's "match field" satisfies `matcher`. For PreToolUse /
 * PostToolUse the match field is `tool_name`; for SessionStart it's
 * `source` (startup / resume / clear / compact); UserPromptSubmit and
 * Stop have no matcher (matcher is ignored, all hooks fire).
 *
 * Matcher syntax (source-compatible):
 *   - omitted / empty / "*"  →  matches everything
 *   - exact string            →  case-sensitive equality match
 *   - regex literal           →  if the matcher contains regex meta
 *                                 chars (e.g. `Bash|Edit`), we treat
 *                                 it as a regex. Pipe-separated lists
 *                                 like `Bash|Edit|Write` are the most
 *                                 common form, lifted straight from
 *                                 source's user-facing docs.
 */
export interface HookMatcherGroup {
  /** Optional match expression. See "Matcher syntax" above. */
  matcher?: string;
  /** Hooks to run when matcher fires. */
  hooks: HookCommand[];
}

/** Top-level `hooks` block in settings.json. */
export type HooksSettings = Partial<Record<HookEvent, HookMatcherGroup[]>>;

// ─── Hook input (sent to the hook subprocess on stdin) ─────────────────

interface BaseHookInput {
  hook_event_name: HookEvent;
  /** Session id this hook is firing for. Empty string when unknown. */
  session_id: string;
  /** Current working directory the agent runs from. */
  cwd: string;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop";
  last_assistant_message?: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: "SubagentStop";
  agent_id: string;
  agent_type: string;
  last_assistant_message?: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | StopHookInput
  | SubagentStopHookInput;

// ─── Hook output (parsed from stdout) ─────────────────────────────────

/**
 * Common JSON shape hooks can return on stdout. Mirrors source's
 * `hookJSONOutputSchema` (the relevant fields — we drop the SDK /
 * async / elicitation extensions).
 *
 *   {
 *     "continue": false,                  ← stop further hooks + halt loop
 *     "stopReason": "rate limited",       ← shown to user when continue=false
 *     "decision": "approve" | "block",    ← legacy top-level (still honored)
 *     "reason": "...",                    ← human-readable reason
 *     "systemMessage": "...",             ← shown to user (chat surface)
 *     "suppressOutput": true,             ← hide stdout from chat
 *     "hookSpecificOutput": {
 *       "hookEventName": "PreToolUse",
 *       "permissionDecision": "allow" | "deny" | "ask",
 *       "permissionDecisionReason": "...",
 *       "additionalContext": "...",       ← injected into model context
 *       ...
 *     }
 *   }
 */
export interface HookJSONOutput {
  continue?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName?: HookEvent;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

// ─── Processed / aggregated result ────────────────────────────────────

export type PermissionBehavior = "allow" | "ask" | "deny";

/**
 * Result of running ONE hook command end-to-end (spawn + parse +
 * interpret). The runHooks layer collects an array of these from a
 * matcher group and aggregates them into a single decision for the
 * caller.
 */
export interface HookResult {
  /** The displayed name (e.g. "PreToolUse:Bash"). */
  hookName: string;
  /** The shell command that ran. */
  command: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Subprocess outcome. */
  outcome: "success" | "blocking" | "non_blocking_error" | "cancelled";

  // ─── Capture from the subprocess ─────────────────────────────────
  stdout: string;
  stderr: string;
  exitCode?: number;

  // ─── Decoded effects (set from JSON output OR exit codes) ────────
  /** Override for the permission check (PreToolUse only). */
  permissionBehavior?: PermissionBehavior;
  /** Human-readable reason that pairs with permissionBehavior. */
  permissionDecisionReason?: string;
  /**
   * Text to inject into the model's context. Used by:
   *   - PreToolUse  → prepended to the tool_result the model sees
   *   - PostToolUse → appended to the tool_result the model sees
   *   - UserPromptSubmit → prepended to the user's prompt
   *   - SessionStart    → injected as a system reminder on session boot
   */
  additionalContext?: string;
  /** Text to show to the user (chat surface). */
  systemMessage?: string;
  /**
   * "Hard stop" signal. When true, the calling layer should treat
   * this hook as if it blocked outright — for tool hooks this means
   * the tool does not run; for Stop hooks it means the loop bows out.
   *
   * Source's term is `preventContinuation`; we keep the name.
   */
  preventContinuation?: boolean;
  /** Optional reason that pairs with preventContinuation. */
  stopReason?: string;
  /**
   * Blocking error text. When set, the caller should:
   *   - PreToolUse  → reject the tool call with this as the result
   *   - PostToolUse → surface this to the model as an error attachment
   *   - Stop / SubagentStop → continue the loop with this as
   *     a user-side message so the model can react
   *
   * Triggered by exit code 2 OR JSON `decision: "block"` /
   * `permissionDecision: "deny"`.
   */
  blockingError?: string;
}

/**
 * Aggregated decision returned by `run<Event>Hooks(...)` — the layer
 * the agentic loop / queryEngine actually calls. Each per-hook
 * `HookResult` is still surfaced (for debugging / future UI) but the
 * caller mostly cares about the rolled-up effect.
 */
export interface AggregatedHookOutcome {
  /** Individual hook results, in execution order. */
  results: HookResult[];
  /**
   * Final permission verdict if any hook spoke up. Order of priority:
   *   deny > ask > allow > undefined (no opinion)
   * Source uses the same precedence (deny always wins).
   */
  permissionBehavior?: PermissionBehavior;
  /** Reason that pairs with `permissionBehavior`. */
  permissionDecisionReason?: string;
  /** Concatenated additionalContext from all hooks (in order). */
  additionalContext?: string;
  /** Concatenated systemMessage from all hooks. */
  systemMessage?: string;
  /** True if any hook signaled prevent-continuation. */
  preventContinuation?: boolean;
  /** First stopReason encountered (paired with preventContinuation). */
  stopReason?: string;
  /** First blockingError encountered. */
  blockingError?: string;
}
