/**
 * Kibo wire protocol, mirrored from src-tauri/src/ipc.rs (the source of truth).
 *   KIBO/1 <token> <event> [duration=<ms>] [source=<label>]\n   ->   "ok\n" | "err <code>\n"
 * This extension never adds event types. test/protocol.test.ts compares EVENTS with ipc.rs when run inside the repo.
 */
export const EVENTS = [
  "build_started", "build_succeeded", "build_failed", "task_completed",
  "user_returned", "system_idle", "system_active",
] as const;
export type KiboEventName = (typeof EVENTS)[number];

export const MAX_DURATION_MS = 86_400_000;
export const SOURCE_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const HOST = "127.0.0.1"; // the only address this extension will ever connect to

export interface EventMeta { durationMs?: number; source?: string }

/** Builds the one-line message. Throws on anything the Rust listener would reject (never sends unvalidated data). */
export function buildLine(token: string, event: string, meta: EventMeta = {}): string {
  if (!(EVENTS as readonly string[]).includes(event)) throw new Error("invalid event");
  let line = `KIBO/1 ${token} ${event}`;
  if (meta.durationMs !== undefined) {
    const d = meta.durationMs;
    if (!Number.isInteger(d) || d < 0 || d > MAX_DURATION_MS) throw new Error("invalid duration");
    line += ` duration=${d}`;
  }
  if (meta.source !== undefined) {
    if (!SOURCE_RE.test(meta.source)) throw new Error("invalid source");
    line += ` source=${meta.source}`;
  }
  return line + "\n";
}
