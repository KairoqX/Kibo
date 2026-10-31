/**
 * Diagnostics observer. PRIVACY: reads only per-severity COUNTS. Messages, file paths/URIs and code are never read or stored.
 *
 * STATUS: observe-only. Kibo's protocol (ipc.rs EVENTS) has no diagnostics event, and mapping "errors exist" to build_failed
 * would break the rule that an editor diagnostic never means a build failed. So `mapTransition` returns null for every
 * transition and nothing is sent. The debounce/dedupe machinery is kept (and tested) so that a future protocol event
 * can be wired in by changing only `mapTransition`.
 */
export interface Counts { errors: number; warnings: number }
export type Transition = "errors-appeared" | "errors-cleared" | "errors-reduced" | "warnings-appeared";

/** No whitelisted Kibo event can express a diagnostics reaction. Returns null on purpose; see the file header. */
export function mapTransition(_t: Transition): null { return null; }

export function describeTransition(prev: Counts, next: Counts): Transition | null {
  if (next.errors > 0 && prev.errors === 0) return "errors-appeared";
  if (next.errors === 0 && prev.errors > 0) return "errors-cleared";
  if (next.errors < prev.errors) return "errors-reduced";
  if (next.errors === 0 && next.warnings > 0 && prev.warnings === 0) return "warnings-appeared";
  return null;
}

export interface DiagnosticsOptions {
  /** returns the current totals across the workspace (counts only) */
  read: () => Counts;
  onTransition: (t: Transition, counts: Counts) => void;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export class DiagnosticsTracker {
  private last: Counts | null = null;
  private timer: unknown = null;
  private o: Required<DiagnosticsOptions>;
  constructor(opts: DiagnosticsOptions) {
    this.o = { debounceMs: 1500, setTimer: (f, m) => setTimeout(f, m), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>), ...opts };
  }

  /** call on every onDidChangeDiagnostics; bursts collapse into one evaluation after the quiet period */
  notify(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => { this.timer = null; this.evaluate(); }, this.o.debounceMs);
  }

  private evaluate() {
    const next = this.o.read();
    const prev = this.last;
    this.last = next;
    if (!prev) return;                                                     // first sample is a baseline, never a reaction
    if (prev.errors === next.errors && prev.warnings === next.warnings) return;   // unchanged -> nothing
    const t = describeTransition(prev, next);
    if (t) this.o.onTransition(t, next);
  }

  dispose() { if (this.timer !== null) this.o.clearTimer(this.timer); this.timer = null; this.last = null; }
}
