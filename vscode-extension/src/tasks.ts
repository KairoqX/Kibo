import { RunTracker, type Outcome } from "./runTracker";

/** The small slice of the VS Code task API used here (structural, so it can be mocked without VS Code). */
export interface TaskLike { name: string; source: string; isBackground: boolean; group?: { id?: string } }
export interface ExecutionLike { task: TaskLike }
export interface Disposable { dispose(): void }
export interface TasksApi {
  onDidStartTaskProcess(l: (e: { execution: ExecutionLike }) => void): Disposable;
  onDidEndTaskProcess(l: (e: { execution: ExecutionLike; exitCode?: number }) => void): Disposable;
  onDidEndTask(l: (e: { execution: ExecutionLike }) => void): Disposable;
}

export type Category = "build" | "test";
export interface TaskSettings { buildEnabled: boolean; buildScope: "buildGroup" | "all"; testsEnabled: boolean }

/**
 * Decides whether a task is a build, a test run, or neither. Only explicit identification counts:
 *  - background/watch tasks never finish -> never reported;
 *  - group "test" -> test run (reported only if test reporting is on; never counted as a build);
 *  - group "build" -> build; with buildScope "all" every other non-background task is a build too.
 */
export function classifyTask(task: TaskLike, s: Pick<TaskSettings, "buildScope">): Category | null {
  if (task.isBackground) return null;
  const g = task.group?.id;
  if (g === "test") return "test";
  if (g === "build") return "build";
  return s.buildScope === "all" ? "build" : null;
}

/** Exit code -> outcome. `undefined` means the task was terminated (by the user or VS Code), i.e. cancelled: no event. */
export const outcomeFor = (exitCode: number | undefined): Outcome => (exitCode === undefined ? "cancelled" : exitCode === 0 ? "success" : "failure");

const ORPHAN_MS = 300;

/**
 * Turns VS Code task lifecycle events into tracker calls. "Started" is sent on process start (not task start), so
 * tasks without a process (pure compound tasks, custom executions) can never produce a start without a result.
 * The result comes only from the real process exit code, never from terminal text.
 */
export class TaskMonitor {
  private ids = new WeakMap<object, string>();
  private seq = 0;
  private open = new Map<string, { category: Category; label: string }>();
  private orphanTimers = new Set<unknown>();

  constructor(
    private api: TasksApi,
    private trackers: Record<Category, RunTracker>,
    private settings: () => TaskSettings,
    private setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  register(): Disposable {
    const subs = [
      this.api.onDidStartTaskProcess((e) => this.onStart(e.execution)),
      this.api.onDidEndTaskProcess((e) => this.onEnd(e.execution, outcomeFor(e.exitCode))),
      this.api.onDidEndTask((e) => this.onTaskEnd(e.execution)),
    ];
    return { dispose: () => { subs.forEach((s) => s.dispose()); this.dispose(); } };
  }

  dispose() { this.orphanTimers.forEach((t) => this.clearTimer(t)); this.orphanTimers.clear(); this.open.clear(); }

  private idOf(ex: ExecutionLike): string {
    let id = this.ids.get(ex);
    if (!id) { id = `x${++this.seq}`; this.ids.set(ex, id); }
    return id;
  }
  private label(t: TaskLike) { return `${t.source}\u0000${t.name}`; }          // matching only; never sent anywhere

  private onStart(ex: ExecutionLike) {
    const s = this.settings();
    const category = classifyTask(ex.task, s);
    if (!category) return;
    if (category === "build" ? !s.buildEnabled : !s.testsEnabled) return;
    const id = this.idOf(ex);
    this.open.set(id, { category, label: this.label(ex.task) });
    this.trackers[category].begin(id);
  }

  private resolve(ex: ExecutionLike): string | null {
    const id = this.ids.get(ex);
    if (id && this.open.has(id)) return id;
    // VS Code handed us a different object for the same execution: accept only an unambiguous match.
    const l = this.label(ex.task);
    const m = [...this.open].filter(([, v]) => v.label === l);
    return m.length === 1 ? m[0][0] : null;
  }

  private onEnd(ex: ExecutionLike, outcome: Outcome) {
    const id = this.resolve(ex);
    if (!id) return;
    const { category } = this.open.get(id)!;
    this.open.delete(id);
    this.trackers[category].end(id, outcome);
  }

  /** Task ended with no process-end event seen (killed, crashed host): treated as cancelled, shortly after in case events arrive out of order. */
  private onTaskEnd(ex: ExecutionLike) {
    const id = this.resolve(ex);
    if (!id) return;
    const h = this.setTimer(() => {
      this.orphanTimers.delete(h);
      if (this.open.has(id)) this.onEnd(ex, "cancelled");
    }, ORPHAN_MS);
    this.orphanTimers.add(h);
  }
}
