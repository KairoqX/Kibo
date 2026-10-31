// Vite integration: hook sequencing with fakes, and REAL `vite build` runs (the repo's own vite) against a mock Kibo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import kibo, { createHooks } from "./integrations/vite.mjs";
import { ACTIVE_ENV, DISABLE_ENV } from "./integrations/core.mjs";
import { cleanEnv, mockKibo } from "./testing/helpers.mjs";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function harness(extra = {}) {
  const log = []; let n = 1; const timers = new Map();
  const hooks = createHooks({
    send: async (e, o) => { log.push([e, o]); return { ok: true }; },
    setTimer: (fn) => { timers.set(n, fn); return n++; }, clearTimer: (id) => timers.delete(id),
    ...extra,
  });
  return { log, hooks, names: () => log.map((l) => l[0]), fire: async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await flush(); } };
}

test("vite hooks: a normal build reports start, then success after the grace period", async () => {
  const h = harness();
  await h.hooks.buildStart(); await h.hooks.buildEnd(undefined); await h.hooks.closeBundle();
  assert.deepEqual(h.names(), ["build_started"]);                 // success is not sent until the grace period passed
  await h.fire();
  assert.deepEqual(h.names(), ["build_started", "build_succeeded"]);
  assert.equal(h.log[0][1].source, "vite");
});

test("vite hooks: buildEnd(error) reports failure at once; the closeBundle that Rollup still calls cannot add a success", async () => {
  const h = harness();
  await h.hooks.buildStart(); await h.hooks.buildEnd(new Error("boom")); await h.hooks.closeBundle(); await h.fire();
  assert.deepEqual(h.names(), ["build_started", "build_failed"]);
});

test("vite hooks: an error while writing/rendering (renderError) is a failure even though buildEnd had no error", async () => {
  const h = harness();
  await h.hooks.buildStart(); await h.hooks.buildEnd(undefined); await h.hooks.renderError(new Error("minify")); await h.hooks.closeBundle(); await h.fire();
  assert.deepEqual(h.names(), ["build_started", "build_failed"]);
});

test("vite hooks: client + SSR sub-builds are one build (one start, one success)", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) { await h.hooks.buildStart(); await h.hooks.buildEnd(undefined); await h.hooks.closeBundle(); }
  await h.fire();
  assert.deepEqual(h.names(), ["build_started", "build_succeeded"]);
});

test("vite hooks: silent when a Kibo wrapper owns the build, or when disabled", async () => {
  for (const env of [{ [ACTIVE_ENV]: "1" }, { [DISABLE_ENV]: "1" }]) {
    const h = harness({ env });                  // mode derives from the env passed in
    await h.hooks.buildStart(); await h.hooks.buildEnd(new Error("x")); await h.hooks.closeBundle(); await h.fire();
    assert.equal(h.log.length, 0);
  }
});

test("vite plugin: build only, and never in watch mode", async () => {
  const p = kibo();
  assert.equal(p.apply, "build"); assert.equal(p.name, "kibo-report");
  p.configResolved({ build: { watch: {} } });                     // `vite build --watch`
  // hooks must be inert: no throw and no network (Kibo is not reachable in this process anyway)
  assert.equal(await p.buildStart(), undefined); assert.equal(await p.buildEnd(new Error("x")), undefined);
  assert.equal(p.closeBundle(), undefined);
});

/* ----------------------------------------------------------- real vite build */

const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin", "vite.js");
const pluginUrl = pathToFileURL(new URL("./integrations/vite.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).href;

async function viteBuild(files, env = {}) {
  const k = await mockKibo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo vite "));
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), t);
  fs.writeFileSync(path.join(dir, "vite.config.mjs"), `import kibo from ${JSON.stringify(pluginUrl)};
export default { logLevel: "silent", build: { rollupOptions: { input: "main.js" }, minify: false }, plugins: [kibo()] };`);
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [viteBin, "build"], { cwd: dir, env: cleanEnv({ KIBO_IPC_FILE: k.file, ...env }) });
    let stderr = ""; c.stderr.on("data", (d) => (stderr += d)); c.on("close", (status) => res({ status, stderr }));
  });
  const events = k.events().map((e) => e.replace(/ duration=\d+/, " duration=N"));
  k.close(); fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, events };
}

test("real vite build, success: started then succeeded (exit 0)", async () => {
  const r = await viteBuild({ "main.js": "console.log(1 + 1);" });
  assert.equal(r.status, 0);
  assert.deepEqual(r.events, ["build_started source=vite", "build_succeeded duration=N source=vite"]);
});

test("real vite build, unresolved import: started then FAILED, non-zero exit, no success", async () => {
  const r = await viteBuild({ "main.js": 'import "./does-not-exist.js";' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.events, ["build_started source=vite", "build_failed duration=N source=vite"]);
});

test("real vite build, syntax error: started then FAILED, non-zero exit, no success", async () => {
  const r = await viteBuild({ "main.js": "const = ;" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.events, ["build_started source=vite", "build_failed duration=N source=vite"]);
});

test("real vite build inside a Kibo wrapper or with the kill switch: no events, same exit code", async () => {
  for (const env of [{ [ACTIVE_ENV]: "1" }, { [DISABLE_ENV]: "1" }]) {
    const ok = await viteBuild({ "main.js": "1;" }, env), bad = await viteBuild({ "main.js": "const = ;" }, env);
    assert.equal(ok.status, 0); assert.notEqual(bad.status, 0);
    assert.deepEqual([ok.events, bad.events], [[], []]);
  }
});
