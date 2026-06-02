import { useEffect, useRef, useState } from "react";
import { spawn } from "node:child_process";
import {
  readStatusLineConfig,
  type StatusLineCommandConfig,
} from "../../utils/settings.js";

/**
 * Context handed to a user-configured status-line command on stdin (as JSON),
 * mirroring source's statusLine hook contract. Scripts read this to render a
 * custom line (e.g. inject git branch, a cost budget, etc.).
 */
export interface StatusLineContext {
  model: string;
  cwd: string;
  permissionMode: string;
  taskMode: string;
  contextPercent?: number;
  tokens?: { input: number; output: number };
}

const DEBOUNCE_MS = 300;
const RUN_TIMEOUT_MS = 2000;

/**
 * useStatusLine — drives the optional custom status line.
 *
 * When the user configures `statusLine` in settings.json, this runs that
 * command (debounced; it can be invoked on every turn), feeding the live
 * context as JSON on stdin and returning its stdout. When unconfigured it
 * returns `{ custom: null }` and the UI falls back to the built-in segments.
 *
 * The command is sandboxed only by the OS — same trust model as hooks; users
 * opt in by editing their own settings file. We cap runtime so a hung script
 * can't freeze the footer.
 */
export function useStatusLine(context: StatusLineContext): { custom: string | null } {
  const [config, setConfig] = useState<StatusLineCommandConfig | null>(null);
  const [custom, setCustom] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load config once on mount (settings change rarely; /clear or restart picks
  // up edits). Failures are swallowed — a broken config just means no custom
  // line, never a crash.
  useEffect(() => {
    let cancelled = false;
    void readStatusLineConfig(context.cwd)
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run the command when the context changes, debounced. Serializing the
  // context into the dep keeps the effect from firing on unrelated re-renders.
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    if (!config) {
      setCustom(null);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const child = spawn(process.env.SHELL || "bash", ["-lc", config.command], {
        cwd: context.cwd,
        env: process.env,
      });
      let out = "";
      const killTimer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
      child.stdout.on("data", (c: Buffer | string) => {
        out += c.toString();
      });
      child.on("error", () => {
        clearTimeout(killTimer);
        setCustom(null);
      });
      child.on("close", () => {
        clearTimeout(killTimer);
        // Use the trimmed output; collapse to first line if multi-line so the
        // footer stays one row (scripts that want multi-line are out of scope).
        const line = out.replace(/\n+$/, "").split("\n")[0] ?? "";
        setCustom(line || null);
      });
      child.stdin.end(contextKey);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, contextKey]);

  return { custom };
}
