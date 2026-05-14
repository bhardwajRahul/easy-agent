import React from "react";
import { Box, Text } from "ink";
import type { ToolCallInfo } from "../types.js";
import { formatErrorBody } from "../utils/toolCardFormat.js";
import { SubAgentCard } from "./SubAgentCard.js";

interface ToolCallListProps {
  toolCalls: ToolCallInfo[];
}

export function ToolCallList({ toolCalls }: ToolCallListProps): React.ReactNode {
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={0}>
      {toolCalls.map((toolCall, index) => {
        const label = toolCall.displayName ?? toolCall.name;
        const pending = toolCall.resultLength === undefined;
        const key = toolCall.id || `tc${index}`;

        // Agent tool always uses the rich SubAgentCard renderer — both
        // while running (live counters from the progress store) and
        // after completion (final stats baked into the snapshot).
        // Falls back to the basic card if no snapshot is attached.
        if (toolCall.name === "Agent" && toolCall.subAgentProgress) {
          return <SubAgentCard key={key} toolCall={toolCall} />;
        }

        if (pending) {
          return (
            <Box key={key} marginLeft={2}>
              <Text color="yellow">{"  \u26A1 Using tool: "}{label}</Text>
            </Box>
          );
        }

        if (toolCall.isError) {
          return (
            <Box key={key} marginLeft={2} flexDirection="column">
              <Text color="red">
                {"  \u2717 "}{label}
                {toolCall.inputPreview ? (
                  <Text dimColor>{"  "}({toolCall.inputPreview})</Text>
                ) : null}
                <Text color="red">{" — error"}</Text>
              </Text>
              {toolCall.errorMessage ? (
                <Box marginLeft={4} flexDirection="column">
                  <Text color="red">{formatErrorBody(toolCall.errorMessage)}</Text>
                </Box>
              ) : null}
            </Box>
          );
        }

        return (
          <Box key={key} marginLeft={2}>
            <Text>
              <Text color="green">{"  \u2713 "}{label}</Text>
              {toolCall.displayHint ? (
                <Text dimColor>{"  "}{toolCall.displayHint}</Text>
              ) : toolCall.inputPreview ? (
                <Text dimColor>{"  "}({toolCall.inputPreview})</Text>
              ) : (
                <Text dimColor> ({toolCall.resultLength} chars)</Text>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
