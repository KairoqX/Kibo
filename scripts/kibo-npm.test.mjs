// npm integration: hook/wrapper units with injected fakes, plus REAL `npm run` end to end against a mock Kibo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MARKER_MAX_AGE_MS, hookPost, hookPre, lifecycleScript, main, markerPath, npmInvocation, runScript, takeMarker,
} from "./kibo-npm.mjs";
import { ACTIVE_ENV, DISABLE_ENV } from "./integrations/core.mjs";
import { cleanEnv, fwd, makeProject, mockKibo, runNpm } from "./testing/helpers.mjs";

const KIBO_NPM = fwd(fileURLToPath(new URL("./kibo-npm.mjs", import.meta.url)));
const sink = () => { const log = []; return { log, send: async (e, o) => { log.push([e, o]); return { ok: true }; } }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kibo-marker-"));
const names = (log) => log.map((l) => l[0]);

/* ------------------------------------------------------------------ units */

test("lifecycleScript: derives the script from pre/post events only", () => {
  assert.equal(lifecycleScript("prebuild", "pre"), "build");
  assert.equal(lifecycleScript("postbuild:app", "post"), "build:app");
  for (const bad of ["pre", "build", "postbuild", undefined, 5]) assert.equal(lifecycleScript(bad, "pre"), null);
});

test("markerPath: stable per (project, script); Windows spellings of a folder agree; contains no path", () => {
  const t = "/tmp";
  const a = markerPath("C:\\Projects\\My App", "build", { tmp: t, platform: "win32" });
  assert.equal(markerPath("c:/projects/my app/", "build", { tmp: t, platform: "win32" }), a);
  assert.notEqual(markerPath("C:\\Projects\\My App", "build:other", { tmp: t, platform: "win32" }), a);
  assert.notEqual(markerPath("C:\\Projects\\Other", "build", { tmp: t, platform: "win32" }), a);
  assert.match(path.basename(a), /^kibo-npm-[0-9a-f]{20}\.json$/);
  assert.equal(a.toLowerCase().includes("projects"), false);
});

test("hooks: pre sends started and records a start; post sends success with the duration, once", async () => {
  const dir = tmp(), { log, send } = sink(); let now = 1_000_000;
  const args = { env: { npm_lifecycle_event: "prebuild" }, cwd: "/p/app", now: () => now, send, tmp: dir, platform: "linux" };
  await hookPre(args);
  now += 42_000;
  await hookPost({ ...args, env: { npm_lifecycle_event: "postbuild" } });
  const again = await hookPost({ ...args, env: { npm_lifecycle_event: "postbuild" } });
  assert.deepEqual(log, [["build_started", { source: "npm" }], ["build_succeeded", { durationMs: 42_000, source: "npm" }]]);
  assert.deepEqual(again, { sent: false, reason: "no-start-recorded" });      // no duplicate success
  assert.deepEqual(fs.readdirSync(dir), []);                                  // marker is gone
  fs.rmSync(dir, { recursive: true });
});

test("hooks: a post with no start, an expired start or a garbage marker never reports success", async () => {
  const dir = tmp(), { log, send } = sink(); let now = 50_000_000;
  const base = { env: { npm_lifecycle_event: "postbuild" }, cwd: "/p/app", now: () => now, send, tmp: dir, platform: "linux" };
  assert.equal((await hookPost(base)).sent, false);                           // never started
  fs.writeFileSync(markerPath("/p/app", "build", { tmp: dir, platform: "linux" }), JSON.stringify({ v: 1, startedAt: now - MARKER_MAX_AGE_MS - 1 }));
  assert.equal((await hookPost(base)).sent, false);                           // too old: an earlier build that never finished
  fs.writeFileSync(markerPath("/p/app", "build", { tmp: dir, platform: "linux" }), "{{{ not json");
  assert.equal((await hookPost(base)).sent, false);
  fs.writeFileSync(markerPath("/p/app", "build", { tmp: dir, platform: "linux" }), JSON.stringify({ v: 1, startedAt: now + 5000 }));
  assert.equal((await hookPost(base)).sent, false);                           // from the future
  assert.equal(log.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test("hooks: a failed build leaves a start with no success; the next run starts clean (no contradiction)", async () => {
  const dir = tmp(), { log, send } = sink(); let now = 1000;
  const a = { cwd: "/p/app", now: () => now, send, tmp: dir, platform: "linux" };
  await hookPre({ ...a, env: { npm_lifecycle_event: "prebuild" } });          // build #1 fails: npm never runs postbuild
  now += 100_000;
  await hookPre({ ...a, env: { npm_lifecycle_event: "prebuild" } });          // build #2 overwrites the stale start
  now += 5_000;
  await hookPost({ ...a, env: { npm_lifecycle_event: "postbuild" } });
  assert.deepEqual(names(log), ["build_started", "build_started", "build_succeeded"]);
  assert.equal(log[2][1].durationMs, 5_000);                                  // measured from build #2, not #1
  fs.rmSync(dir, { recursive: true });
});

test("hooks: silent when nested in another reporter or disabled; refuse to run outside pre/post lifecycle scripts", async () => {
  const dir = tmp(), { log, send } = sink();
  for (const extra of [{ [ACTIVE_ENV]: "1" }, { [DISABLE_ENV]: "1" }]) {
    assert.equal((await hookPre({ env: { npm_lifecycle_event: "prebuild", ...extra }, send, tmp: dir })).sent, false);
    assert.equal((await hookPost({ env: { npm_lifecycle_event: "postbuild", ...extra }, send, tmp: dir })).sent, false);
  }
  assert.equal(log.length, 0); assert.deepEqual(fs.readdirSync(dir), []);     // not even a marker
  assert.equal((await hookPre({ env: { npm_lifecycle_event: "build" }, send, tmp: dir })).reason, "not-a-pre-hook");
  fs.rmSync(dir, { recursive: true });
});

test("takeMarker: consumes the marker exactly once", () => {
  const dir = tmp(), f = path.join(dir, "m.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, startedAt: 1000 }));
  assert.equal(takeMarker(f, 2000), 1000);
  assert.equal(takeMarker(f, 2000), null);
  fs.rmSync(dir, { recursive: true });
});

test("npmInvocation: uses node + npm-cli.js without a shell when npm provides it; falls back to npm (shell on Windows)", () => {
  const env = { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", npm_node_execpath: "C:\\Program Files\\nodejs\\node.exe" };
  assert.deepEqual(npmInvocation(env, "build:kibo", [], "win32"), { cmd: ["C:\\Program Files\\nodejs\\node.exe", env.npm_execpath, "run", "build:kibo"], shell: false });
  assert.deepEqual(npmInvocation(env, "b", ["--mode", "a b"], "win32").cmd.slice(-5), ["run", "b", "--", "--mode", "a b"]);
  assert.deepEqual(npmInvocation({}, "build:kibo", [], "win32"), { cmd: ["npm", "run", "build:kibo"], shell: true });
  assert.deepEqual(npmInvocation({ npm_execpath: "/x/pnpm.cjs" }, "b", [], "linux"), { cmd: ["npm", "run", "b"], shell: false });
});

test("runScript: rejects unsafe names and a script that would call itself (no infinite recursion)", async () => {
  const { log, send } = sink();
  assert.equal(await runScript("build; rm -rf /", [], { env: {}, send }), 2);
  assert.equal(await runScript("", [], { env: {}, send }), 2);
  assert.equal(await runScript("build", [], { env: { npm_lifecycle_event: "build" }, send }), 2);
  assert.equal(log.length, 0);
});

test("main: unknown commands and bad usage exit 2", async () => {
  assert.equal(await main([], {}), 2);
  assert.equal(await main(["explode"], {}), 2);
  assert.equal(await main(["pre"], { npm_lifecycle_event: "build" }), 2);
  assert.equal(await main(["post"], { npm_lifecycle_event: "prebuild" }), 2);
});

/* ------------------------------------------- real npm, real child processes */

const nodeScript = (code) => `node -e ${JSON.stringify(code)}`;
const WRAP = (target) => `node "${KIBO_NPM}" run ${target}`;
const PRE = `node "${KIBO_NPM}" pre`, POST = `node "${KIBO_NPM}" post`;

async function withKibo(scripts, { args = ["run", "build"], env = {}, files } = {}) {
  const k = await mockKibo(), p = makeProject(scripts, files);
  try {
    const r = await runNpm(p.dir, args, cleanEnv({ KIBO_IPC_FILE: k.file, ...env }));
    return { ...r, events: k.events() };
  } finally { k.close(); p.cleanup(); }
}
const shape = (events) => events.map((e) => e.replace(/ duration=\d+/, " duration=N"));

test("npm wrapper, build succeeds: started then succeeded, exit 0", async () => {
  const r = await withKibo({ build: WRAP("build:app"), "build:app": nodeScript("process.exit(0)") });
  assert.equal(r.status, 0);
  assert.deepEqual(shape(r.events), ["build_started source=npm", "build_succeeded duration=N source=npm"]);
});

test("npm wrapper, build fails: started then FAILED (never succeeded), npm exits with the build's code", async () => {
  const r = await withKibo({ build: WRAP("build:app"), "build:app": nodeScript("console.error('SECRET-BUILD-OUTPUT'); process.exit(3)") });
  assert.equal(r.status, 3);
  assert.deepEqual(shape(r.events), ["build_started source=npm", "build_failed duration=N source=npm"]);
  assert.match(r.stderr, /SECRET-BUILD-OUTPUT/);                              // still shown in the terminal ...
  assert.equal(r.events.join("\n").includes("SECRET"), false);                // ... never sent to Kibo
});

test("npm wrapper: the first failing step of `a && b` is what is reported; success only when every step passed", async () => {
  const ok = nodeScript("0"), bad = nodeScript("process.exit(1)");
  const f = await withKibo({ build: WRAP("build:app"), "build:app": `${ok} && ${bad} && ${ok}` });
  assert.notEqual(f.status, 0);
  assert.deepEqual(shape(f.events).map((e) => e.split(" ")[0]), ["build_started", "build_failed"]);
  const g = await withKibo({ build: WRAP("build:app"), "build:app": `${ok} && ${ok}` });
  assert.deepEqual(shape(g.events).map((e) => e.split(" ")[0]), ["build_started", "build_succeeded"]);
});

test("npm wrapper: arguments after -- reach the real script unchanged, including spaces", async () => {
  const out = path.join(os.tmpdir(), `kibo-args-${process.pid}.json`);
  const r = await withKibo(
    { build: WRAP("build:app"), "build:app": `node write-args.js` },
    { args: ["run", "build", "--", "--mode", "two words"], files: { "write-args.js": `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))` } },
  );
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), ["--mode", "two words"]);
  fs.rmSync(out);
});

test("npm wrapper still runs the build (exit code intact) when Kibo is not running or reporting is disabled", async () => {
  const p = makeProject({ build: WRAP("build:app"), "build:app": nodeScript("process.exit(4)") });
  const closed = await runNpm(p.dir, ["run", "build"], cleanEnv({ KIBO_IPC_FILE: path.join(p.dir, "no-such-ipc.json") }));
  assert.equal(closed.status, 4);
  const k = await mockKibo();
  const off = await runNpm(p.dir, ["run", "build"], cleanEnv({ KIBO_IPC_FILE: k.file, [DISABLE_ENV]: "1" }));
  assert.equal(off.status, 4); assert.equal(k.events().length, 0);
  k.close(); p.cleanup();
});

test("npm wrapper pointed at its own script fails fast (exit 2) instead of recursing", async () => {
  const r = await withKibo({ build: WRAP("build") });
  assert.equal(r.status, 2); assert.equal(r.events.length, 0);
  assert.match(r.stderr, /run itself forever/);
});

test("npm wrapper keeps reporting under --ignore-scripts (it IS the script, not a hook)", async () => {
  const r = await withKibo({ build: WRAP("build:app"), "build:app": nodeScript("0") }, { args: ["run", "build", "--ignore-scripts"] });
  assert.deepEqual(shape(r.events).map((e) => e.split(" ")[0]), ["build_started", "build_succeeded"]);
});

test("nested reporters: hooks on the script INSIDE the wrapper stay silent, so there is exactly one start and one result", async () => {
  const ok = await withKibo({ build: WRAP("build:app"), "prebuild:app": PRE, "build:app": nodeScript("0"), "postbuild:app": POST });
  assert.equal(ok.status, 0);
  assert.deepEqual(shape(ok.events), ["build_started source=npm", "build_succeeded duration=N source=npm"]);
  const bad = await withKibo({ build: WRAP("build:app"), "prebuild:app": PRE, "build:app": nodeScript("process.exit(2)"), "postbuild:app": POST });
  assert.equal(bad.status, 2);
  assert.deepEqual(shape(bad.events), ["build_started source=npm", "build_failed duration=N source=npm"]);
});

test("npm lifecycle hooks, build succeeds: started then succeeded", async () => {
  const r = await withKibo({ prebuild: PRE, build: nodeScript("0"), postbuild: POST });
  assert.equal(r.status, 0);
  assert.deepEqual(shape(r.events), ["build_started source=npm", "build_succeeded duration=N source=npm"]);
});

test("npm lifecycle hooks, build FAILS: only started is sent; success is never claimed and failure cannot be known", async () => {
  const r = await withKibo({ prebuild: PRE, build: nodeScript("process.exit(1)"), postbuild: POST });
  assert.notEqual(r.status, 0);
  assert.deepEqual(shape(r.events), ["build_started source=npm"]);
});

test("npm lifecycle hooks are skipped by --ignore-scripts (documented limitation)", async () => {
  const r = await withKibo({ prebuild: PRE, build: nodeScript("0"), postbuild: POST }, { args: ["run", "build", "--ignore-scripts"] });
  assert.equal(r.events.length, 0);
});

test("npm lifecycle hooks: back-to-back builds each report their own pair (no leftover state)", async () => {
  const k = await mockKibo(), p = makeProject({ prebuild: PRE, build: nodeScript("0"), postbuild: POST });
  const env = cleanEnv({ KIBO_IPC_FILE: k.file });
  await runNpm(p.dir, ["run", "build"], env); await runNpm(p.dir, ["run", "build"], env);
  assert.deepEqual(shape(k.events()).map((e) => e.split(" ")[0]), ["build_started", "build_succeeded", "build_started", "build_succeeded"]);
  k.close(); p.cleanup();
});

test("hooks used as a non-hook script fail loudly (exit 2) instead of silently doing nothing", async () => {
  const r = await withKibo({ build: `node "${KIBO_NPM}" pre` });
  assert.equal(r.status, 2); assert.match(r.stderr, /lifecycle script/);
});
