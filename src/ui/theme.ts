/**
 * Shared UI theme — a single source of truth for the colors and glyphs the
 * terminal UI uses, so the welcome banner, conversation, input box and status
 * line stay visually consistent instead of each component hard-coding its own
 * "magenta"/"green"/"cyan". Values mirror Claude Code's dark theme palette
 * (utils/theme.ts) closely enough to feel familiar.
 */

export const theme = {
  // Brand orange — the assistant accent, spinner star, prompt caret.
  brand: "#D77757",
  brandLight: "#F59575",

  // Conversation roles.
  assistant: "#D77757",
  // Subtle full-width bar behind a user prompt (dark-terminal friendly).
  userBarBg: "#34343A",
  userBarText: "#FFFFFF",

  // Chrome.
  border: "#5A5A66",
  borderDim: "#3A3A42",
  muted: "#8A8A94",

  // Tool result / notice states.
  ok: "#5BB98C",
  error: "#E5484D",
  warn: "#E2A336",
  info: "#7AA2D6",

  // Markdown accents — kept in the warm/brand family so formatted replies
  // read as one palette instead of clashing cyan/blue defaults.
  mdHeading: "#D77757",
  mdHeadingSub: "#F59575",
  mdInlineCode: "#E5B07A",
  mdLink: "#7AA2D6",
  mdQuote: "#8A8A94",
} as const;

export const glyph = {
  assistant: "\u25CF", // ● filled dot for the assistant
  toolDot: "\u25CF", // ● tool-call status dot (colored by state)
  resultCorner: "\u23BF", // ⎿ result/continuation corner under a tool call
  userCaret: "\u203A", // › the user prompt caret inside the bar
  promptCaret: "\u203A", // › the input box caret
  bullet: "\u00B7", // · tip bullet
} as const;
