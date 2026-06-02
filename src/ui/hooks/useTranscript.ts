/**
 * Keyboard + scroll state for the Ctrl+O transcript overlay (stage 24.1/24.5).
 *
 * Owns the keyboard while the transcript is open (a pager: ↑/↓ line,
 * PgUp/PgDn page, g/G top/bottom, Esc / Ctrl+O / q to close). Returns the
 * current scroll offset, clamped to the content; the overlay slices the line
 * array at this offset to draw a window — that's the "virtual scrolling".
 *
 * Also drives incremental in-transcript search: `/` opens a query line, typing
 * jumps to the first match live, Enter locks it in, and n/N cycle matches.
 */
import { useEffect, useMemo, useState } from "react";
import { useInput } from "ink";

interface UseTranscriptOptions {
  open: boolean;
  /** The full transcript lines (used for scrolling bounds + search matching). */
  lines: string[];
  viewportHeight: number;
  onClose: () => void;
}

export interface TranscriptSearchState {
  /** True while the user is typing a query (`/` mode). */
  active: boolean;
  query: string;
  matchCount: number;
  /** 1-based index of the current match, or 0 when none. */
  matchOrdinal: number;
}

export interface UseTranscriptResult {
  scroll: number;
  search: TranscriptSearchState;
}

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function computeMatches(lines: string[], query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (stripAnsi(lines[i] ?? "").toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

export function useTranscript({
  open,
  lines,
  viewportHeight,
  onClose,
}: UseTranscriptOptions): UseTranscriptResult {
  const totalLines = lines.length;
  const maxScroll = Math.max(0, totalLines - viewportHeight);
  const [scroll, setScroll] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);

  const clamp = (n: number) => Math.max(0, Math.min(maxScroll, n));
  // Position a matched line a couple rows below the header for context.
  const scrollToLine = (line: number) => setScroll(clamp(line - 2));

  const matches = useMemo(() => computeMatches(lines, query), [lines, query]);

  // Open at the bottom (most recent) — that's where the user just was. Also
  // resets any prior search so each open starts clean.
  useEffect(() => {
    if (open) {
      setScroll(Math.max(0, totalLines - viewportHeight));
      setSearching(false);
      setQuery("");
      setMatchIdx(0);
    }
  }, [open, totalLines, viewportHeight]);

  // Incremental jump: as the query changes, hop to the first match.
  useEffect(() => {
    if (!query || matches.length === 0) return;
    setMatchIdx(0);
    scrollToLine(matches[0] ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  useInput(
    (input, key) => {
      // ── Search-entry mode: keystrokes build the query ──────────────────
      if (searching) {
        if (key.escape) {
          setSearching(false);
          setQuery("");
          setMatchIdx(0);
          return;
        }
        if (key.return) {
          // Lock in the query; n/N now cycle. Keep matches highlighted.
          setSearching(false);
          return;
        }
        if (key.backspace || key.delete) {
          setQuery((q) => q.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setQuery((q) => q + input);
          return;
        }
        return;
      }

      // ── Pager mode ─────────────────────────────────────────────────────
      if (key.escape || (key.ctrl && input === "o") || input === "\x0f" || input === "q") {
        onClose();
        return;
      }
      if (input === "/") {
        setSearching(true);
        setQuery("");
        setMatchIdx(0);
        return;
      }
      if (input === "n" && matches.length > 0) {
        const ni = (matchIdx + 1) % matches.length;
        setMatchIdx(ni);
        scrollToLine(matches[ni] ?? 0);
        return;
      }
      if (input === "N" && matches.length > 0) {
        const ni = (matchIdx - 1 + matches.length) % matches.length;
        setMatchIdx(ni);
        scrollToLine(matches[ni] ?? 0);
        return;
      }
      if (key.upArrow || input === "k") {
        setScroll((s) => clamp(s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setScroll((s) => clamp(s + 1));
        return;
      }
      if (key.pageUp || (key.ctrl && input === "b")) {
        setScroll((s) => clamp(s - viewportHeight));
        return;
      }
      if (key.pageDown || (key.ctrl && input === "f") || input === " ") {
        setScroll((s) => clamp(s + viewportHeight));
        return;
      }
      if (input === "g") {
        setScroll(0);
        return;
      }
      if (input === "G") {
        setScroll(maxScroll);
      }
    },
    { isActive: open },
  );

  return {
    scroll: clamp(scroll),
    search: {
      active: searching,
      query,
      matchCount: matches.length,
      matchOrdinal: matches.length > 0 ? matchIdx + 1 : 0,
    },
  };
}
