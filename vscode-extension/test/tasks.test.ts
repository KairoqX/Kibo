import { test } from "node:test";
import * as assert from "node:assert/strict";
import { RunTracker } from "../src/runTracker";
import { classifyTask, outcomeFor, TaskMonitor, type ExecutionLike, type TaskLike, type TaskSettings, type TasksApi } from "../src/tasks";
import { FakeClock } from "./helpers";

/** Mock of the three vscode.tasks events used. */
function mockApi() {
  const L = { start: [] as Array<(e: never) => void>, end: [] as Array<(e: never) => void>, taskEnd: [] as Array<(e: never) => void> };
  const sub = (arr: Array<(e: never) => void>) => (l: (e: never) => void) => { arr.push(l); return { dispose: () => { arr.splice(arr.indexOf(l), 1); } }; };
  const api = { onDidStartTaskProcess: sub(L.start), onDidEndTaskProcess: sub(L.end), onDidEndTask: sub(L.taskEnd) } as unknown as TasksApi;
  return {
    api, L,
    start: (execution: ExecutionLike) => L.start.forEach((l) => l({ execution } as never)),
    end: (execution: ExecutionLike, exitCode?: number) => L.end.forEach((l) => l({ execution, exitCode } as never)),
    taskEnd: (execution: ExecutionLike) => L.taskEnd.forEach((l) => l({ execution } as never)),
  };
}
const task = (name: string, group?: string, isBackground = false): TaskLike => ({ name, source: "Workspace", isBackground, group: group ? { id: group } : undefined });
const exec = (t: TaskLike): ExecutionLike => ({ task: t });

function rig(over: Partial<TaskSettings> = {}, reporting = true) {
  const clock = new FakeClock(); const sent: Array<[string, string, object]> = [];
  const settings: TaskSettings = { buildEnabled: true, buildScope: "buildGroup", testsEnabled: true, ...over };
  const mk = (source: string) => new RunTracker({ source, enabled: () => reporting, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, send: (e, m) => { sent.push([source, e, m]); } });
  const api = mockApi();
  const mon = new TaskMonitor(api.api, { build: mk("vscode"), test: mk("vscode-test") }, () => settings, clock.setTimer, clock.clearTimer);
  mon.register();
  return { clock, sent, api, settings, mon };
}

test("classification: only explicit build/test groups; background tasks never", () => {
  assert.equal(classifyTask(task("b", "build"), { buildScope: "buildGroup" }), "build");
  assert.equal(classifyTask(task("t", "test"), { buildScope: "buildGroup" }), "test");
  assert.equal(classifyTask(task("x"), { buildScope: "buildGroup" }), null);
  assert.equal(classifyTask(task("x", "clean"), { buildScope: "buildGroup" }), null);
  assert.equal(classifyTask(task("x"), { buildScope: "all" }), "build");
  assert.equal(classifyTask(task("t", "test"), { buildScope: "all" }), "test");     // tests never count as builds
  assert.equal(classifyTask(task("watch", "build", true), { buildScope: "all" }), null);
});

test("exit codes map to outcomes; undefined (terminated) is cancelled", () => {
  assert.equal(outcomeFor(0), "success");
  assert.equal(outcomeFor(1), "failure");
  assert.equal(outcomeFor(-1), "failure");
  assert.equal(outcomeFor(undefined), "cancelled");
});

test("build task success: started on process start, succeeded from exit code 0", () => {
  const { api, sent, clock } = rig();
  const e = exec(task("build", "build"));
  api.start(e); clock.advance(2_000); api.end(e, 0); clock.advance(500);
  assert.deepEqual(sent.map((s) => [s[0], s[1]]), [["vscode", "build_started"], ["vscode", "build_succeeded"]]);
  assert.equal((sent[1][2] as { durationMs: number }).durationMs, 2_000);
});

test("build task failure: non-zero exit code -> build_failed", () => {
  const { api, sent } = rig();
  const e = exec(task("build", "build")); api.start(e); api.end(e, 2);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_failed"]);
});

test("terminated task (exit code undefined) sends only the start, never a result", () => {
  const { api, sent, clock } = rig();
  const e = exec(task("build", "build")); api.start(e); api.end(e, undefined); clock.advance(10_000);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started"]);
});

test("task ended without a process-end event is treated as cancelled (after a short wait for ordering)", () => {
  const { api, sent, clock } = rig();
  const e = exec(task("build", "build")); api.start(e); api.taskEnd(e); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started"]);
});

test("out-of-order events (task end before process end) still report the real exit code", () => {
  const { api, sent, clock } = rig();
  const e = exec(task("build", "build")); api.start(e); api.taskEnd(e); api.end(e, 1); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_failed"]);
});

test("a different object for the same execution is matched only when unambiguous", () => {
  const { api, sent } = rig();
  const a = task("build", "build"); api.start(exec(a)); api.end(exec(a), 1);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_failed"]);
});

test("ambiguous duplicate executions are not guessed", () => {
  const { api, sent, clock } = rig();
  const t = task("build", "build");
  api.start(exec(t)); api.start(exec(t));
  api.end(exec(t), 1); clock.advance(1_000);                  // new object, two candidates -> ignored
  assert.deepEqual(sent.map((s) => s[1]), ["build_started"]);
});

test("non-build tasks and background tasks send nothing", () => {
  const { api, sent, clock } = rig();
  const a = exec(task("lint")); api.start(a); api.end(a, 1);
  const b = exec(task("watch", "build", true)); api.start(b); api.end(b, 1);
  clock.advance(2_000);
  assert.equal(sent.length, 0);
});

test("buildScope 'all' reports any non-background task", () => {
  const { api, sent } = rig({ buildScope: "all" });
  const a = exec(task("lint")); api.start(a); api.end(a, 1);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_failed"]);
});

test("build reporting disabled independently of tests", () => {
  const { api, sent, clock } = rig({ buildEnabled: false });
  const b = exec(task("build", "build")); api.start(b); api.end(b, 1);
  const t = exec(task("test", "test")); api.start(t); clock.advance(100); api.end(t, 0); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => [s[0], s[1]]), [["vscode-test", "build_started"], ["vscode-test", "build_succeeded"]]);
});

test("test reporting disabled: test-group tasks are silent (and not treated as builds)", () => {
  const { api, sent, clock } = rig({ testsEnabled: false, buildScope: "all" });
  const t = exec(task("test", "test")); api.start(t); api.end(t, 1); clock.advance(1_000);
  assert.equal(sent.length, 0);
});

test("master switch off: nothing at all is sent", () => {
  const { api, sent, clock } = rig({}, false);
  const b = exec(task("build", "build")); api.start(b); api.end(b, 1);
  const t = exec(task("test", "test")); api.start(t); api.end(t, 1); clock.advance(2_000);
  assert.equal(sent.length, 0);
});

test("test suite split over many test tasks aggregates to a single reaction", () => {
  const { api, sent, clock } = rig();
  const ts = Array.from({ length: 50 }, (_, i) => exec(task(`suite${i}`, "test")));
  ts.forEach((t) => api.start(t));
  ts.forEach((t, i) => api.end(t, i === 20 ? 1 : 0));
  clock.advance(2_000);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_failed"]);
  assert.ok(sent.every((s) => s[0] === "vscode-test"));
});

test("test run all passing -> one start, one success; sequential suites within the grace window merge", () => {
  const { api, sent, clock } = rig();
  const a = exec(task("unit", "test")), b = exec(task("integration", "test"));
  api.start(a); clock.advance(500); api.end(a, 0); clock.advance(50); api.start(b); clock.advance(500); api.end(b, 0); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => s[1]), ["build_started", "build_succeeded"]);
});

test("build and test batches are independent", () => {
  const { api, sent, clock } = rig();
  const b = exec(task("build", "build")), t = exec(task("test", "test"));
  api.start(b); api.start(t); api.end(b, 0); api.end(t, 1); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => `${s[0]}:${s[1]}`).sort(), ["vscode-test:build_failed", "vscode-test:build_started", "vscode:build_started", "vscode:build_succeeded"]);
});

test("disposing the monitor unsubscribes from every event", () => {
  const clock = new FakeClock(); const api = mockApi(); const sent: string[] = [];
  const t = new RunTracker({ source: "vscode", enabled: () => true, send: (e) => { sent.push(e); }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const mon = new TaskMonitor(api.api, { build: t, test: t }, () => ({ buildEnabled: true, buildScope: "buildGroup", testsEnabled: true }), clock.setTimer, clock.clearTimer);
  mon.register().dispose();
  assert.equal(api.L.start.length + api.L.end.length + api.L.taskEnd.length, 0);
  api.start(exec(task("b", "build")));
  assert.equal(sent.length, 0);
});
