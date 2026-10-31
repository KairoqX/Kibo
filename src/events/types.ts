/**
 * Kibo event types.
 *
 * Events carry the bare minimum: a type, a timestamp, an optional duration and an optional short
 * source label. They never carry source code, terminal output, command lines or file paths.
 */
export const EVENT_TYPES = [
  "build_started",
  "build_succeeded",
  "build_failed",
  "task_completed",
  "user_returned",
  "system_idle",
  "system_active",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type KiboEvent = {
  type: EventType;
  /** epoch ms, set by Kibo when the event is received (never trusted from the sender) */
  at: number;
  /** how long the build/task ran, or how long the user was away (ms) */
  durationMs?: number;
  /** short label such as "cargo" or "npm" (letters, digits, . _ - only) */
  source?: string;
};

export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_SOURCE_LEN = 32;
const SOURCE_RE = /^[A-Za-z0-9._-]+$/;
const MAX_RAW_LEN = 512;

/**
 * Validates an untrusted payload (the JSON string the Rust listener forwards, or an object) and
 * returns a clean event, or null if anything is wrong. Unknown fields are ignored, not copied.
 */
export function parseWireEvent(raw: unknown, now: number): KiboEvent | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_RAW_LEN) return null;
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const type = o.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) return null;

  const ev: KiboEvent = { type: type as EventType, at: now };

  if (o.durationMs !== undefined) {
    const d = o.durationMs;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > MAX_DURATION_MS) return null;
    ev.durationMs = Math.round(d);
  }
  if (o.source !== undefined) {
    const s = o.source;
    if (typeof s !== "string" || s.length === 0 || s.length > MAX_SOURCE_LEN || !SOURCE_RE.test(s)) return null;
    ev.source = s;
  }
  return ev;
}
