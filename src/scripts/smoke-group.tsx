/**
 * Visual smoke for Read/Grep/Glob run collapsing (stage 24.4). Renders a
 * ConversationView whose assistant turn calls 4 Reads + 2 Greps in a row; they
 * should collapse into a single grouped card, while a lone Edit stays its own
 * card.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ConversationView } from "../ui/components/ConversationView.js";

chalk.level = 3;

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use" as const, id, name, input };
}
function toolResult(id: string, content: string) {
  return { type: "tool_result" as const, tool_use_id: id, content, is_error: false };
}

const messages: MessageParam[] = [
  { role: "user", content: "analyze the project" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look around." },
      toolUse("r1", "Read", { file_path: "package.json" }),
      toolUse("r2", "Read", { file_path: "tsconfig.json" }),
      toolUse("r3", "Read", { file_path: "src/ui/App.tsx" }),
      toolUse("r4", "Read", { file_path: "src/core/agenticLoop.ts" }),
      toolUse("g1", "Grep", { pattern: "TODO" }),
      toolUse("g2", "Grep", { pattern: "FIXME" }),
      toolUse("e1", "Edit", { file_path: "src/ui/theme.ts", old_string: "a", new_string: "b" }),
    ] as unknown as MessageParam["content"],
  },
  {
    role: "user",
    content: [
      toolResult("r1", "63 lines"),
      toolResult("r2", "22 lines"),
      toolResult("r3", "300 lines"),
      toolResult("r4", "780 lines"),
      toolResult("g1", "12 matches"),
      toolResult("g2", "3 matches"),
      toolResult("e1", "edited"),
    ] as unknown as MessageParam["content"],
  },
];

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = Number(process.env.SMOKE_COLS) || 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(
    <Box flexDirection="column" paddingX={1}>
      <ConversationView messages={messages} />
    </Box>,
    { stdout: fakeStdout, debug: true, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
