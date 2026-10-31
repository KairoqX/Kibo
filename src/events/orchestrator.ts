/**
 * EventOrchestrator: sits between event sources and the animation layer.
 *   source -> parseWireEvent -> handle() -> [dedupe, eligibility, hidden, sleep, cooldown,
 *   interaction, priority] -> sink.play(reaction)
 * It never touches the rig, the window or the DOM; everything environmental is injected.
 */
import type { KiboState } from "../kiboRig.ts";
import type { Settings } from "../settings.ts";
import { COOLDOWN_MS, DEDUPE_MS, PRIORITY, QUIET_COOLDOWN_FACTOR, planReaction, type DropReason, type Reaction } from "./policy.ts";
import { MAX_DURATION_MS, type EventType, type KiboEvent } from "./types.ts";

export type PlayRequest = Reaction & { wake: boolean };

export interface OrchestratorEnv {
  now(): number;
  settings(): Settings;
  petState(): KiboState;
  /** the pet window is hidden (tray "Hide"): never reveal it, never queue for later */
  hidden(): boolean;
  /** the user is dragging / pressing Kibo right now */
  interacting(): boolean;
  /** draws the reaction through the existing animation system */
  play(r: PlayRequest): void;
  /** schedules a callback, returns a canceller (injected so tests need no real timers) */
  schedule(fn: () => void, ms: number): () => void;
}

export type Outcome =
  | { status: "played"; reaction: PlayRequest }
  | { status: "deferred" }
  | { status: "dropped"; reason: DropReason | "hidden" | "sleeping" | "duplicate" | "cooldown" | "user-interacting" | "lower-priority" };

export const RETRY_MS = 600;
export const PENDING_TTL_MS = 4_000;

export class EventOrchestrator {
  private lastSeen = new Map<EventType, number>();
  private lastPlayed = new Map<string, number>();
  private started = new Map<string, number>();               // build start times by source (duration inference)
  private active: { priority: number; until: number } | null = null;
  private pending: { ev: KiboEvent; expires: number } | null = null;
  private cancel: (() => void) | null = null;

  private env: OrchestratorEnv;
  constructor(env: OrchestratorEnv) { this.env = env; }

  /** Entry point for every validated event. Never throws. */
  handle(raw: KiboEvent): Outcome {
    try {
      const ev = this.withDuration(raw);
      const prev = this.lastSeen.get(ev.type);
      this.lastSeen.set(ev.type, this.env.now());
      if (prev !== undefined && this.env.now() - prev < DEDUPE_MS) return { status: "dropped", reason: "duplicate" };
      return this.evaluate(ev);
    } catch {
      return { status: "dropped", reason: "ignored" };        // an event must never crash the pet
    }
  }

  dispose() {
    this.cancel?.(); this.cancel = null; this.pending = null;
  }

  /* ---------------------------------------------------------------- core */
  private evaluate(ev: KiboEvent): Outcome {
    const env = this.env, now = env.now(), s = env.settings();
    const plan = planReaction(ev, s);
    if (typeof plan === "string") return { status: "dropped", reason: plan };

    if (env.hidden()) return { status: "dropped", reason: "hidden" };

    const asleep = env.petState() === "sleep";
    if (asleep && !s.eventsWake) return { status: "dropped", reason: "sleeping" };

    const gap = COOLDOWN_MS[plan.group] * (s.quiet ? QUIET_COOLDOWN_FACTOR : 1);
    const last = this.lastPlayed.get(plan.group);
    if (last !== undefined && now - last < gap) return { status: "dropped", reason: "cooldown" };

    if (env.interacting()) {
      if (plan.priority < PRIORITY.outcome) return { status: "dropped", reason: "user-interacting" };
      return this.defer(ev, now);
    }

    if (this.active && now < this.active.until && plan.priority < this.active.priority) {
      return { status: "dropped", reason: "lower-priority" };
    }

    const req: PlayRequest = { ...plan, wake: asleep && s.eventsWake };
    this.lastPlayed.set(plan.group, now);
    this.active = { priority: plan.priority, until: now + plan.ms };
    this.pending = null;
    env.play(req);
    return { status: "played", reaction: req };
  }

  /** Keeps only the most recent important event while the user is busy with Kibo. */
  private defer(ev: KiboEvent, now: number): Outcome {
    this.pending = { ev, expires: now + PENDING_TTL_MS };
    if (!this.cancel) this.cancel = this.env.schedule(this.retry, RETRY_MS);
    return { status: "deferred" };
  }

  private retry = () => {
    this.cancel = null;
    const p = this.pending;
    if (!p) return;
    if (this.env.now() > p.expires || this.env.hidden()) { this.pending = null; return; }
    if (this.env.interacting()) { this.cancel = this.env.schedule(this.retry, RETRY_MS); return; }
    this.pending = null;
    try { this.evaluate(p.ev); } catch { /* ignore */ }
  };

  /** A finish event without a duration borrows it from the matching build_started (same source). */
  private withDuration(ev: KiboEvent): KiboEvent {
    const key = ev.source ?? "";
    if (ev.type === "build_started") { this.started.set(key, this.env.now()); return ev; }
    if (ev.type === "build_succeeded" || ev.type === "build_failed" || ev.type === "task_completed") {
      const t0 = this.started.get(key);
      this.started.delete(key);
      if (ev.durationMs === undefined && t0 !== undefined) {
        const d = this.env.now() - t0;
        if (d >= 0 && d <= MAX_DURATION_MS) return { ...ev, durationMs: d };
      }
    }
    return ev;
  }
}
