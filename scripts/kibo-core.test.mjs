// Unit tests for the shared integration core and for `kibo-report run` compatibility. Deterministic: injected clocks and fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_ENV, BuildRun, DISABLE_ENV, WIN_CTRL_C, childEnv, classifyExit, createMultiBuildReporter, exitCodeFor,
  isMainModule, projectKey, quoteWin, reportingMode, spawnAndWait,
} from "./integrations/core.mjs";
import { runWrapped } from "./kibo-report.mjs";
import { cleanEnv, mockKibo } from "./testing/helpers.mjs";

const SCRIPT = fileURLToPath(new URL("./kibo-report.mjs", import.meta.url));
const recorder = () => { const log = []; return { log, send: async (event, opts) => { log.push([event, opts]); return { ok: true }; } }; };
const clock = (...times) => { let i = 0; return () => times[Math.min(i++, times.length - 1)]; };

/* ---------------------------------------------------------------- BuildRun */

test("BuildRun: start then success reports both, with the measured duration", async () => {
  const { log, send } = recorder();
  const run = new BuildRun({ send, now: clock(1000, 4500), source: "npm" });
  await run.start();
  await run.finish("success");
  assert.deepEqual(log, [["build_started", { source: "npm" }], ["build_succeeded", { durationMs: 3500, source: "npm" }]]);
});

test("BuildRun: failure is reported as build_failed, never as success", async () => {
  const { log, send } = recorder();
  const run = new BuildRun({ send, now: clock(0, 10), source: "npm" });
  await run.start();
  await run.finish("failure");
  assert.deepEqual(log.map((l) => l[0]), ["build_started", "build_failed"]);
});

test("BuildRun: duplicate and contradictory events are impossible", async () => {
  for (const [first, second] of [["success", "success"], ["failure", "failure"], ["success", "failure"], ["failure", "success"]]) {
    const { log, send } = recorder();
    const run = new BuildRun({ send, now: clock(0, 5, 9), source: "x" });
    await run.start(); await run.start();                      // second start ignored
    await run.finish(first);
    const again = await run.finish(second);
    assert.equal(again.sent, false, `${first} then ${second}`);
    assert.equal(log.filter((l) => l[0] !== "build_started").length, 1);
    assert.equal(log.filter((l) => l[0] === "build_started").length, 1);
  }
});

test("BuildRun: a finish without a start sends nothing; --no-start style runs may finish", async () => {
  const a = recorder();
  const orphan = new BuildRun({ send: a.send, source: "x" });
  assert.deepEqual(await orphan.finish("success"), { sent: false, reason: "not-started" });
  assert.equal(a.log.length, 0);
  const b = recorder();
  const external = new BuildRun({ send: b.send, source: "x", alreadyStarted: true });
  await external.finish("failure");
  assert.deepEqual(b.log.map((l) => l[0]), ["build_failed"]);
});

test("BuildRun: a cancelled run reports nothing and nothing may follow it", async () => {
  const { log, send } = recorder();
  const run = new BuildRun({ send, source: "x" });
  await run.start();
  assert.equal((await run.finish("cancelled")).reason, "cancelled");
  assert.equal((await run.finish("success")).sent, false);
  assert.deepEqual(log.map((l) => l[0]), ["build_started"]);
});

test("BuildRun: disabled and nested modes are completely silent", async () => {
  for (const mode of ["off", "nested"]) {
    const { log, send } = recorder();
    const run = new BuildRun({ send, source: "x", mode });
    await run.start(); await run.finish("success"); await run.finish("failure");
    assert.equal(log.length, 0, mode);
  }
});

test("BuildRun: the duration is clamped to the protocol maximum and never negative", async () => {
  const { log, send } = recorder();
  const run = new BuildRun({ send, now: clock(0, 999_999_999_999), source: "x" });
  await run.start(); await run.finish("success");
  assert.equal(log[1][1].durationMs, 86_400_000);
  const r2 = recorder();
  const back = new BuildRun({ send: r2.send, now: clock(5000, 1000), source: "x" });   // clock went backwards
  await back.start(); await back.finish("success");
  assert.equal(r2.log[1][1].durationMs, 0);
});

/* ------------------------------------------------------- exit classification */

test("classifyExit: only exit code 0 is success; every non-zero code is a failure", () => {
  assert.equal(classifyExit(0, null), "success");
  for (const code of [1, 2, 3, 127, 255, 4294967295, -1]) assert.equal(classifyExit(code, null), "failure", String(code));
  assert.equal(classifyExit(null, null), "failure");           // no code and no signal: never claim success
});

test("classifyExit: signals and the Windows Ctrl+C status are cancellations, not failures", () => {
  assert.equal(classifyExit(null, "SIGINT"), "cancelled");
  assert.equal(classifyExit(null, "SIGTERM"), "cancelled");
  assert.equal(classifyExit(WIN_CTRL_C, null), "cancelled");
  assert.equal(WIN_CTRL_C, 3221225786);
});

test("exitCodeFor passes the child's own code through (130 for signals)", () => {
  assert.equal(exitCodeFor(3, null), 3);
  assert.equal(exitCodeFor(0, null), 0);
  assert.equal(exitCodeFor(null, "SIGINT"), 130);
  assert.equal(exitCodeFor(null, null), 1);
});

/* ------------------------------------------------------------ mode / env */

test("reportingMode: kill switch beats nesting; nesting beats on", () => {
  assert.equal(reportingMode({}), "on");
  assert.equal(reportingMode({ [ACTIVE_ENV]: "1" }), "nested");
  assert.equal(reportingMode({ [DISABLE_ENV]: "1" }), "off");
  assert.equal(reportingMode({ [DISABLE_ENV]: "1", [ACTIVE_ENV]: "1" }), "off");
  assert.equal(reportingMode({ [DISABLE_ENV]: "0", [ACTIVE_ENV]: "" }), "on");
  assert.equal(childEnv({ A: "1" })[ACTIVE_ENV], "1");
});

/* ------------------------------------------------- multi-build (Vite SSR etc) */

function fakeTimers() {
  let next = 1; const pending = new Map();
  return {
    setTimer: (fn) => { pending.set(next, fn); return next++; },
    clearTimer: (id) => pending.delete(id),
    fireAll: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn(); } },
    count: () => pending.size,
  };
}

test("multi-build: sequential sub-builds produce one start and one success after the grace period", async () => {
  const { log, send } = recorder(); const t = fakeTimers();
  const r = createMultiBuildReporter({ send, source: "vite", setTimer: t.setTimer, clearTimer: t.clearTimer });
  await r.begin(); r.end();                                     // client build
  assert.equal(t.count(), 1);                                   // success is only scheduled
  await r.begin(); r.end();                                     // ssr build starts inside the grace period
  assert.equal(t.count(), 1);                                   // the first schedule was cancelled
  t.fireAll(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(log.map((l) => l[0]), ["build_started", "build_succeeded"]);
});

test("multi-build: a failure is immediate and no success can follow it", async () => {
  const { log, send } = recorder(); const t = fakeTimers();
  const r = createMultiBuildReporter({ send, source: "vite", setTimer: t.setTimer, clearTimer: t.clearTimer });
  await r.begin(); await r.fail(); r.end();                     // buildEnd(error) then closeBundle, like Rollup
  t.fireAll(); await Promise.resolve();
  assert.deepEqual(log.map((l) => l[0]), ["build_started", "build_failed"]);
});

test("multi-build: a failing second sub-build after a first success reports only the failure", async () => {
  const { log, send } = recorder(); const t = fakeTimers();
  const r = createMultiBuildReporter({ send, source: "vite", setTimer: t.setTimer, clearTimer: t.clearTimer });
  await r.begin(); r.end(); await r.begin(); await r.fail(); r.end();
  t.fireAll(); await Promise.resolve();
  assert.deepEqual(log.map((l) => l[0]), ["build_started", "build_failed"]);
});

test("multi-build: silent when nested or disabled", async () => {
  for (const mode of ["nested", "off"]) {
    const { log, send } = recorder(); const t = fakeTimers();
    const r = createMultiBuildReporter({ send, source: "vite", mode, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await r.begin(); await r.fail(); r.end(); t.fireAll();
    assert.equal(log.length, 0); assert.equal(t.count(), 0);
  }
});

/* ------------------------------------------------------- Windows behaviour */

test("projectKey: Windows spellings of one folder collapse to one key; other platforms stay case-sensitive", () => {
  const k = projectKey("C:\\Projects\\My App", "win32");
  assert.equal(projectKey("c:/projects/my app/", "win32"), k);
  assert.equal(projectKey("C:\\PROJECTS\\MY APP\\", "win32"), k);
  assert.notEqual(projectKey("C:\\Projects\\Other", "win32"), k);
  assert.notEqual(projectKey("/home/u/App", "linux"), projectKey("/home/u/app", "linux"));
});

test("quoteWin quotes spaces and cmd metacharacters, leaves plain arguments alone", () => {
  assert.equal(quoteWin("plain-arg_1.0"), "plain-arg_1.0");
  assert.equal(quoteWin("C:\\Program Files\\nodejs\\node.exe"), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(quoteWin("a&b"), '"a&b"');
  assert.equal(quoteWin('say "hi"'), '"say \\"hi\\""');
});

function fakeSpawn(result) {
  const calls = [];
  const impl = (...args) => { calls.push(args); const c = new EventEmitter(); setImmediate(() => result.error ? c.emit("error", new Error("x")) : c.emit("close", result.code ?? 0, result.signal ?? null)); return c; };
  return { calls, impl };
}

test("spawnAndWait: Windows goes through a shell with one quoted command string; POSIX passes an argv array", async () => {
  const w = fakeSpawn({ code: 0 });
  await spawnAndWait(["C:\\Program Files\\nodejs\\node.exe", "a b.js"], { platform: "win32", spawnImpl: w.impl, env: { X: "1" } });
  assert.equal(w.calls[0][0], '"C:\\Program Files\\nodejs\\node.exe" "a b.js"');
  assert.equal(w.calls[0][2].shell, true);
  assert.equal(w.calls[0][2].stdio, "inherit");                  // output is inherited, never read
  const p = fakeSpawn({ code: 0 });
  await spawnAndWait(["/usr/bin/node", "a b.js"], { platform: "linux", spawnImpl: p.impl });
  assert.deepEqual([p.calls[0][0], p.calls[0][1]], ["/usr/bin/node", ["a b.js"]]);
  assert.equal(p.calls[0][2].shell, undefined);
  const s = fakeSpawn({ code: 0 });                              // real executables on Windows can skip the shell
  await spawnAndWait(["C:\\n\\node.exe", "x.js"], { platform: "win32", shell: false, spawnImpl: s.impl });
  assert.deepEqual([s.calls[0][0], s.calls[0][1]], ["C:\\n\\node.exe", ["x.js"]]);
});

test("spawnAndWait: a command that cannot start resolves as exit 127 (never throws)", async () => {
  assert.deepEqual(await spawnAndWait(["x"], { platform: "linux", spawnImpl: fakeSpawn({ error: true }).impl }), { code: 127, signal: null });
});

test("isMainModule: matches the real entry file, ignores other modules and bad input", () => {
  const here = new URL("./kibo-core.test.mjs", import.meta.url).href;
  assert.equal(isMainModule(here, fileURLToPath(here)), true);
  assert.equal(isMainModule(here, fileURLToPath(new URL("./kibo-report.mjs", import.meta.url))), false);
  assert.equal(isMainModule(here, undefined), false);
  assert.equal(isMainModule(here, "/definitely/not/here.mjs"), false);
  // Windows drive-letter / case differences must not turn a wrapper into a silent no-op
  assert.equal(isMainModule(here, fileURLToPath(here).toUpperCase(), "win32") || process.platform !== "win32", true);
});

/* ------------------------------------- manual reporter: `run` compatibility */

test("runWrapped (manual `run`): reports start and outcome and passes the exit code through", async () => {
  const ok = recorder(), bad = recorder();
  const env = cleanEnv();
  assert.equal(await runWrapped([process.execPath, "-e", "process.exit(0)"], { source: "t" }, { doReport: ok.send, env }), 0);
  assert.equal(await runWrapped([process.execPath, "-e", "process.exit(7)"], { source: "t" }, { doReport: bad.send, env }), 7);
  assert.deepEqual(ok.log.map((l) => l[0]), ["build_started", "build_succeeded"]);
  assert.deepEqual(bad.log.map((l) => l[0]), ["build_started", "build_failed"]);
});

test("runWrapped: --no-start only reports the outcome", async () => {
  const r = recorder();
  assert.equal(await runWrapped([process.execPath, "-e", "process.exit(2)"], {}, { noStart: true, doReport: r.send, env: cleanEnv() }), 2);
  assert.deepEqual(r.log.map((l) => l[0]), ["build_failed"]);
});

test("runWrapped: the child inherits the 'a reporter owns this build' marker; a nested run and the kill switch stay silent", async () => {
  const seen = [];
  const code = await runWrapped([process.execPath, "-e", `process.exit(process.env.${ACTIVE_ENV} === "1" ? 0 : 9)`], {}, { doReport: async (e) => { seen.push(e); return { ok: true }; }, env: cleanEnv() });
  assert.equal(code, 0);
  for (const env of [cleanEnv({ [ACTIVE_ENV]: "1" }), cleanEnv({ [DISABLE_ENV]: "1" })]) {
    const r = recorder();
    assert.equal(await runWrapped([process.execPath, "-e", "process.exit(4)"], {}, { doReport: r.send, env }), 4);
    assert.equal(r.log.length, 0);
  }
});

test("CLI `run` end to end: unchanged wire output, inner reporters are silent", async () => {
  const k = await mockKibo();
  const env = cleanEnv({ KIBO_IPC_FILE: k.file });
  // the wrapped command itself runs `kibo-report run`: the inner one must not report again
  const inner = `require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(SCRIPT)}, "run", "--", process.execPath, "-e", "0"], { stdio: "inherit" })`;
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [SCRIPT, "run", "--source", "outer", "--", process.execPath, "-e", inner], { env });
    c.on("close", (status) => res({ status }));
  });
  k.close();
  assert.equal(r.status, 0);
  assert.deepEqual(k.events().map((e) => e.split(" ")[0]), ["build_started", "build_succeeded"]);
});

test("CLI `run` with Kibo closed or KIBO_REPORT_DISABLE=1: still runs the command, exit code intact", () => {
  const base = { KIBO_IPC_FILE: "/nonexistent/ipc.json" };
  assert.equal(spawnSync(process.execPath, [SCRIPT, "run", "--", process.execPath, "-e", "process.exit(5)"], { env: cleanEnv(base) }).status, 5);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "run", "--", process.execPath, "-e", "process.exit(6)"], { env: cleanEnv({ ...base, [DISABLE_ENV]: "1" }) }).status, 6);
});

test("Windows only: `run` wraps a cmd.exe command and keeps its exit code", { skip: process.platform !== "win32" && "cmd.exe exists only on Windows" }, () => {
  const env = cleanEnv({ KIBO_IPC_FILE: "C:\\nonexistent\\ipc.json" });
  assert.equal(spawnSync(process.execPath, [SCRIPT, "run", "--", "cmd", "/c", "exit 3"], { env }).status, 3);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "run", "--", "cmd", "/c", "exit 0"], { env }).status, 0);
});
