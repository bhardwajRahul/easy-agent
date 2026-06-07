/**
 * Bash progress store — live mailbox for a running Bash command's output.
 *
 * Same side-channel pattern as `subAgentProgressStore`: while `BashTool.call()`
 * is blocked on `await`-ing the child process, there's no path to yield events
 * back into the parent loop's AsyncGenerator. So the tool publishes stdout /
 * stderr chunks here keyed by the parent's `tool_use.id`, and the UI subscribes
 * to show the command's tail live (last few lines + elapsed + line count),
 * mirroring source's ShellProgressMessage.
 *
 * Throttling: a chatty command (npm install, a test run) emits data in bursts;
 * notifying on every chunk would repaint the whole live frame dozens of times a
 * second. We coalesce notifications to ~10fps (leading + trailing edge) so the
 * UI stays smooth, and always flush on completion.
 */

// Keep only the tail in memory — the model gets the full output from the
// tool's own accumulation; the store exists purely to feed the live preview.
const MAX_TAIL_LINES = 40;
const NOTIFY_INTERVAL_MS = 100;

export interface BashProgress {
  /** Tail of combined stdout+stderr (capped to MAX_TAIL_LINES). */
  output: string;
  /** Total lines seen so far (not just the retained tail). */
  totalLines: number;
  /** Total bytes seen so far. */
  totalBytes: number;
  /** Wall-clock start (ms since epoch) — used to derive elapsed. */
  startTime: number;
  /** Configured timeout (ms) — drives the live `timeout Xs` countdown hint. */
  timeoutMs?: number;
  /** True once the process has exited. */
  done: boolean;
}

type Listener = (toolUseId: string, snapshot: BashProgress | null) => void;

const store = new Map<string, BashProgress>();
const listeners = new Set<Listener>();

// Throttle bookkeeping, per tool id.
const lastNotifyAt = new Map<string, number>();
const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(toolUseId: string, snapshot: BashProgress | null): void {
  for (const l of listeners) l(toolUseId, snapshot);
}

function notifyThrottled(toolUseId: string): void {
  const now = Date.now();
  const last = lastNotifyAt.get(toolUseId) ?? 0;
  const elapsed = now - last;
  if (elapsed >= NOTIFY_INTERVAL_MS) {
    lastNotifyAt.set(toolUseId, now);
    emit(toolUseId, store.get(toolUseId) ?? null);
    return;
  }
  // Within the cooldown — schedule a single trailing notify so the final
  // burst isn't lost (clear any already-scheduled one first).
  if (trailingTimers.has(toolUseId)) return;
  const timer = setTimeout(() => {
    trailingTimers.delete(toolUseId);
    lastNotifyAt.set(toolUseId, Date.now());
    emit(toolUseId, store.get(toolUseId) ?? null);
  }, NOTIFY_INTERVAL_MS - elapsed);
  trailingTimers.set(toolUseId, timer);
}

function clearTimers(toolUseId: string): void {
  const timer = trailingTimers.get(toolUseId);
  if (timer) clearTimeout(timer);
  trailingTimers.delete(toolUseId);
  lastNotifyAt.delete(toolUseId);
}

export function getBashProgress(toolUseId: string): BashProgress | undefined {
  return store.get(toolUseId);
}

export function startBashProgress(toolUseId: string, timeoutMs?: number): void {
  store.set(toolUseId, {
    output: "",
    totalLines: 0,
    totalBytes: 0,
    startTime: Date.now(),
    timeoutMs,
    done: false,
  });
  emit(toolUseId, store.get(toolUseId) ?? null);
}

export function appendBashProgress(toolUseId: string, chunk: string): void {
  const cur = store.get(toolUseId);
  if (!cur) return;
  const combined = cur.output + chunk;
  const lines = combined.split("\n");
  const tail = lines.slice(-MAX_TAIL_LINES);
  const next: BashProgress = {
    ...cur,
    output: tail.join("\n"),
    totalLines: cur.totalLines + (chunk.match(/\n/g)?.length ?? 0),
    totalBytes: cur.totalBytes + Buffer.byteLength(chunk),
  };
  store.set(toolUseId, next);
  notifyThrottled(toolUseId);
}

export function completeBashProgress(toolUseId: string): void {
  const cur = store.get(toolUseId);
  if (!cur) return;
  clearTimers(toolUseId);
  const next: BashProgress = { ...cur, done: true };
  store.set(toolUseId, next);
  emit(toolUseId, next); // force a final flush
}

export function clearBashProgress(toolUseId: string): void {
  if (!store.has(toolUseId)) return;
  clearTimers(toolUseId);
  store.delete(toolUseId);
  emit(toolUseId, null);
}

export function clearAllBashProgress(): void {
  const ids = [...store.keys()];
  for (const id of ids) clearTimers(id);
  store.clear();
  for (const id of ids) emit(id, null);
}

export function subscribeBashProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
