/**
 * The interactive permission prompt shown before a guarded tool runs
 * (stage 7 + 24.4 polish). For file-touching tools it now previews the actual
 * change — a colored diff for Edit and the new-file content for Write — the
 * same "show me what you're about to do" UX as Claude Code's
 * FilesystemPermissionRequest, instead of a bare `args: {...}` dump.
 */
import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { StructuredDiff } from "./StructuredDiff.js";
import { displayPath } from "../utils/toolCardFormat.js";
import type { PermissionPromptState } from "../types.js";

// Bound the preview so a huge edit/new file can't push the prompt's action
// line off-screen. Reviewers can read the full change in the Ctrl+O transcript.
const PREVIEW_MAX_LINES = 24;
const BASH_PREVIEW_MAX_LINES = 8;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Title verb + relative path for a file tool, e.g. `Edit  src/foo.ts`. */
function FileTitle({ verb, path }: { verb: string; path: string }): React.ReactNode {
  return (
    <Text>
      <Text bold color={theme.warn}>{verb}</Text>
      <Text>{`  ${displayPath(path)}`}</Text>
    </Text>
  );
}

/** The per-tool body of the prompt: a diff / content / command preview. */
function PermissionPreview({
  toolName,
  input,
  summary,
}: {
  toolName: string;
  input: Record<string, unknown> | undefined;
  summary: string;
}): React.ReactNode {
  const inp = input ?? {};

  if (toolName === "Edit") {
    const path = asString(inp.file_path) ?? "";
    const oldStr = asString(inp.old_string);
    const newStr = asString(inp.new_string);
    return (
      <Box flexDirection="column">
        <FileTitle verb="Edit" path={path} />
        {oldStr !== undefined && newStr !== undefined ? (
          <StructuredDiff oldText={oldStr} newText={newStr} maxLines={PREVIEW_MAX_LINES} />
        ) : null}
      </Box>
    );
  }

  if (toolName === "Write") {
    const path = asString(inp.file_path) ?? "";
    const content = asString(inp.content) ?? "";
    return (
      <Box flexDirection="column">
        <FileTitle verb="Create" path={path} />
        <StructuredDiff oldText="" newText={content} maxLines={PREVIEW_MAX_LINES} />
      </Box>
    );
  }

  if (toolName === "Bash") {
    const command = asString(inp.command) ?? "";
    const lines = command.split("\n").slice(0, BASH_PREVIEW_MAX_LINES);
    return (
      <Box flexDirection="column">
        <Text bold color={theme.warn}>Bash</Text>
        <Box marginLeft={2} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.mdInlineCode}>{`$ ${line}`}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  // Anything else: fall back to the one-line argument summary.
  return (
    <Text>
      <Text bold color={theme.warn}>{toolName}</Text>
      <Text color={theme.muted}>{`  ${summary}`}</Text>
    </Text>
  );
}

/** Phrase the action question to match the operation. */
function actionQuestion(toolName: string): string {
  switch (toolName) {
    case "Edit":
      return "Do you want to make this edit?";
    case "Write":
      return "Do you want to create this file?";
    case "Bash":
      return "Do you want to run this command?";
    default:
      return "Do you want to proceed?";
  }
}

export function PermissionRequestCard({
  prompt,
}: {
  prompt: PermissionPromptState;
}): React.ReactNode {
  return (
    <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>{"\u26A0 Permission required"}</Text>

      <Box marginTop={1}>
        <PermissionPreview toolName={prompt.toolName} input={prompt.input} summary={prompt.summary} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text>{actionQuestion(prompt.toolName)}</Text>
        <Text color={theme.brandLight}>{"  [y] allow once   [n] deny   [a] always allow (session)"}</Text>
        <Text color={theme.muted}>{`  rule: ${prompt.ruleHint}`}</Text>
      </Box>
    </Box>
  );
}
