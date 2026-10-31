/**
 * Event policy: pure decisions, no timers, no DOM, no Tauri.
 * Turns a validated event + settings into a reaction *request*. How that request is drawn is the
 * animation rig's business (via useKibo), so adding an event source never touches the rig.
 */
import type { KiboState } from "../kiboRig.ts";
import type { Settings } from "../settings.ts";
import type { EventType, KiboEvent } from "./types.ts";
import type { MessageKey } from "./messages.ts";

/** Priority scale (higher wins). Direct user interaction (drag/pat/click) is above all of these. */
export const PRIORITY = { ambient: 1, started: 2, outcome: 3, longDone: 4 } as const;

export const LONG_TASK_MS = 60_000;          // a task this long deserves a stronger cheer
export const AWAY_MIN_MS = 5 * 60_000;       // "system active" only counts as "returned" after this much idle
export const DEDUPE_MS = 2_000;              // identical events closer than this are one event

export type CooldownGroup = "started" | "success" | "failure" | "welcome";
export const COOLDOWN_MS: Record<CooldownGroup, number> = {
  started: 10_000, success: 8_000, failure: 6_000, welcome: 60_000,
};
export const QUIET_COOLDOWN_FACTOR = 2;

export type Reaction = {
  state: KiboState;          // existing rig state to request
  ms: number;                // how long the reaction overlays the underlying state
  priority: number;
  group: CooldownGroup;
  message: MessageKey | null;
  /** counts as a "long task" celebration */
  long: boolean;
};

export type DropReason = "disabled" | "ignored" | "trivial" | "quiet" | "short-absence";

const isDev = (t: EventType) => t === "build_started" || t === "build_succeeded" || t === "build_failed" || t === "task_completed";

/** Maps one event to a reaction, or explains why it does not deserve one. Eligibility only. */
export function planReaction(ev: KiboEvent, s: Settings): Reaction | DropReason {
  if (isDev(ev.type) ? !s.devEvents : !s.activityEvents) return "disabled";
  const d = ev.durationMs;
  const isLong = d !== undefined && d >= LONG_TASK_MS;
  const strong = isLong && s.longTaskCelebrate && !s.quiet;

  switch (ev.type) {
    case "build_started":
      if (s.quiet) return "quiet";                       // quiet mode: no "working" flourish
      return { state: "coding", ms: 3000, priority: PRIORITY.started, group: "started", message: null, long: false };
    case "build_succeeded":
    case "task_completed":
      if (ev.type === "task_completed" && !isLong) return "trivial";   // trivial commands never celebrate
      return strong
        ? { state: "achievement", ms: 4200, priority: PRIORITY.longDone, group: "success", message: "long", long: true }
        : { state: "happy", ms: 2800, priority: PRIORITY.outcome, group: "success", message: "success", long: false };
    case "build_failed":
      return { state: "error", ms: 3600, priority: PRIORITY.outcome, group: "failure", message: "failure", long: false };
    case "user_returned":
      return { state: "wave", ms: 3000, priority: PRIORITY.ambient, group: "welcome", message: "welcome", long: false };
    case "system_active":
      if (d === undefined || d < AWAY_MIN_MS) return "short-absence";
      return { state: "wave", ms: 3000, priority: PRIORITY.ambient, group: "welcome", message: "welcome", long: false };
    case "system_idle":
      return "ignored";                                   // reserved: sleep/break logic already handles idling
  }
}
