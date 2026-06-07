/**
 * Visual smoke for P0 #3 — the in-flight tool-card state machine.
 *
 * Renders a live ToolCallList with one card in each phase so you can confirm
 * the dot color + sub-line per state:
 *   - queued              → dim dot, "Waiting…"
 *   - running             → orange dot, no sub-line (Build label from #2)
 *   - running (bash tail)  → orange dot + streaming tail
 *   - waiting-permission  → orange dot, "Waiting for permission…"
 *   - classifier          → orange dot, "Auto classifier checking…"
 *   - done (ok)           → green dot + summary
 *   - done (error)        → red dot + error body
 *
 * Dots that blink are sampled at one instant here (shared blink clock); in the
 * live UI they pulse.
 */
import React from "react";
import { PassThrough } from "node:stream";
import { Box, render } from "ink";
import chalk from "chalk";
import { ToolCallList } from "../ui/components/ToolCallList.js";
import type { ToolCallInfo } from "../ui/types.js";

chalk.level = 3;

const toolCalls: ToolCallInfo[] = [
  { id: "q1", name: "Read", input: { file_path: "src/ui/App.tsx" } }, // queued
  { id: "r1", name: "Bash", input: { command: "npm run build" }, status: "running" },
  {
    id: "b1",
    name: "Bash",
    input: { command: "npm install" },
    status: "running",
    bashProgress: {
      output: "added 42 packages\nbuilding fresh packages…",
      totalLines: 2,
      totalBytes: 48,
      startTime: Date.now() - 4000,
      done: false,
    },
  },
  { id: "p1", name: "Write", input: { file_path: "src/new.ts", content: "x" }, status: "waiting-permission" },
  { id: "cl1", name: "Bash", input: { command: "rm -rf build" }, status: "classifier" },
  { id: "d1", name: "Read", input: { file_path: "package.json" }, resultLength: 120 },
  { id: "e1", name: "Bash", input: { command: "npm test" }, resultLength: 40, isError: true, errorMessage: "1 test failed" },
];

async function main(): Promise<void> {
  const fakeStdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let captured = "";
  (fakeStdout as unknown as PassThrough).on("data", (c) => {
    captured += c.toString();
  });
  (fakeStdout as unknown as { columns: number }).columns = 84;
  (fakeStdout as unknown as { rows: number }).rows = 50;

  const instance = render(
    <Box flexDirection="column" paddingX={1}>
      <ToolCallList toolCalls={toolCalls} />
    </Box>,
    { stdout: fakeStdout, debug: true, exitOnCtrlC: false },
  );
  await new Promise((r) => setTimeout(r, 80));
  instance.unmount();
  instance.cleanup();

  process.stdout.write(captured + "\n");
}

void main();
