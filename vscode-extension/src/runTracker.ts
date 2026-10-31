import type { EventMeta } from "./protocol";
import { MAX_DURATION_MS } from "./protocol";

export type Outcome = "success" | "failure" | "cancelled";
export type Send = (event: "build_started" | "build_succeeded" | "build_failed", meta: EventMeta) => unknown;

export interface TrackerOptions {
  source: string;
  send: Send;
  /** checked when a run begins; a run that began while disabled is ignored for its whole life */
  enabled: () => boolean;
  now?: () => number;
  /** after the last active run ends, wait this long for a follow-up run (dependsOn chains) before reporting success */
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Aggregates any number of concurrent/sequential runs (compound tasks, a test suite split over tasks) into ONE reaction:
 *   first run begins -> one "started"; any failure -> one "failed" immediately; all finished OK -> one "succeeded".
 * All runs cancelled -> nothing. Never a terminal event without a start, never two terminal events per batch.
 */
export class RunTracker {
  private active = new Set<string>();
  private ignored = new Set<string>();
  private batch: { t0: number; lastEnd: number; resolved: boolean; sawSuccess: boolean } | null = null;
  private timer: unknown = null;
  private o: Required<Omit<TrackerOptions, "send" | "enabled" | "source">> & Pick<TrackerOptions, "send" | "enabled" | "source">;

  constructor(opts: TrackerOptions) {
    this.o = {
      now: Date.now, graceMs: 400,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...opts,
    };
  }

  begin(key: string): void {
    if (!this.o.enabled()) { this.ignored.add(key); return; }
    this.cancelTimer();
    if (this.active.has(key)) return;
    if (!this.batch) {                       // a batch waiting out its grace period is continued, not restarted
      this.batch = { t0: this.o.now(), lastEnd: this.o.now(), resolved: false, sawSuccess: false };
      this.safeSend("build_started", { source: this.o.source });
    }
    this.active.add(key);
  }

  end(key: string, outcome: Outcome): void {
    if (this.ignored.delete(key)) return;
    if (!this.active.delete(key) || !this.batch) return;
    const b = this.batch;
    b.lastEnd = this.o.now();
    if (outcome === "failure" && !b.resolved) {
      b.resolved = true; this.cancelTimer();
      this.safeSend("build_failed", { durationMs: this.duration(b.t0), source: this.o.source });
    } else if (outcome === "success") b.sawSuccess = true;
    if (this.active.size > 0) return;
    if (b.resolved || !b.sawSuccess) { this.batch = null; return; }   // already reported, or everything was cancelled
    this.cancelTimer();
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      if (this.active.size === 0 && this.batch === b && !b.resolved) {
        b.resolved = true; this.batch = null;
        this.safeSend("build_succeeded", { durationMs: this.duration(b.t0, b.lastEnd), source: this.o.source });
      }
    }, this.o.graceMs);
  }

  /** true while a started batch has not yet been reported */
  isOpen(key?: string): boolean { return key === undefined ? this.active.size > 0 : this.active.has(key); }

  dispose(): void { this.cancelTimer(); this.active.clear(); this.ignored.clear(); this.batch = null; }

  private duration(t0: number, end: number = this.o.now()) { return Math.max(0, Math.min(Math.round(end - t0), MAX_DURATION_MS)); }
  private cancelTimer() { if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null; } }
  private safeSend(e: Parameters<Send>[0], m: EventMeta) {
    try { const r = this.o.send(e, m); if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => undefined); } catch { /* reporting must never throw into VS Code */ }
  }
}
