// Client-side tests for the reporter against a mock listener that implements the same wire rules as
// src-tauri/src/ipc.rs. These do NOT exercise the Rust server itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLine, discoveryPath, report } from "./kibo-report.mjs";

const SCRIPT = fileURLToPath(new URL("./kibo-report.mjs", import.meta.url));
const TOKEN = "t".repeat(64);

// async spawn: the mock listener lives in this process, so the event loop must stay free (spawnSync would block it)
const run = (args, env) => new Promise((res) => {
  const c = spawn(process.execPath, [SCRIPT, ...args], { env });
  let stderr = ""; c.stderr.on("data", (d) => (stderr += d));
  c.on("close", (status) => res({ status, stderr }));
});

function mockKibo() {
  const received = [];
  const server = net.createServer((s) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const parts = buf.trim().split(/\s+/);
      const good = parts[0] === "KIBO/1" && parts[1] === TOKEN && parts[2];
      received.push(buf.trim());
      s.end(good ? "ok\n" : "err unauthorized\n");
    });
  });
  return new Promise((res) => server.listen(0, "127.0.0.1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-"));
    const file = path.join(dir, "ipc.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, port: server.address().port, token: TOKEN }));
    res({ server, file, received, close: () => server.close() });
  }));
}

test("buildLine formats events and rejects bad values", () => {
  assert.equal(buildLine("abc", "build_failed"), "KIBO/1 abc build_failed\n");
  assert.equal(buildLine("abc", "build_succeeded", { durationMs: 12, source: "cargo" }), "KIBO/1 abc build_succeeded duration=12 source=cargo\n");
  assert.throws(() => buildLine("abc", "build_failed", { durationMs: -1 }));
  assert.throws(() => buildLine("abc", "build_failed", { durationMs: 1.5 }));
  assert.throws(() => buildLine("abc", "build_failed", { source: "a b" }));
  assert.throws(() => buildLine("abc", "build_failed", { source: "x".repeat(33) }));
});

test("discoveryPath follows the platform app-data conventions and the override", () => {
  // Each platform's expected path is asserted exactly and independently of the host OS.
  assert.equal(discoveryPath({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\H"), "C:\\L\\dev.kairoqx.kibo\\ipc.json");
  assert.equal(discoveryPath({}, "win32", "C:\\H"), "C:\\H\\AppData\\Local\\dev.kairoqx.kibo\\ipc.json");
  assert.equal(discoveryPath({}, "linux", "/home/u"), "/home/u/.local/share/dev.kairoqx.kibo/ipc.json");
  assert.equal(discoveryPath({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/u"), "/xdg/dev.kairoqx.kibo/ipc.json");
  assert.equal(discoveryPath({}, "darwin", "/Users/u"), "/Users/u/Library/Application Support/dev.kairoqx.kibo/ipc.json");
  assert.equal(discoveryPath({ KIBO_IPC_FILE: "/x/y.json" }, "linux", "/h"), "/x/y.json");
});

test("report delivers an event to a listening Kibo", async () => {
  const k = await mockKibo();
  const r = await report("build_succeeded", { durationMs: 90000, source: "npm" }, { file: k.file });
  k.close();
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(k.received, [`KIBO/1 ${TOKEN} build_succeeded duration=90000 source=npm`]);
});

test("report resolves quietly when Kibo is closed, the file is missing, or the file is garbage", async () => {
  const k = await mockKibo(); k.close();
  assert.equal((await report("build_failed", {}, { file: k.file })).ok, false);           // port closed
  assert.equal((await report("build_failed", {}, { file: "/nonexistent/ipc.json" })).reason, "kibo-not-running");
  const junk = path.join(os.tmpdir(), "kibo-junk.json"); fs.writeFileSync(junk, "{{{");
  assert.equal((await report("build_failed", {}, { file: junk })).ok, false);
});

test("report times out instead of hanging on a silent listener", async () => {
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const file = path.join(os.tmpdir(), "kibo-silent.json");
  fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token: TOKEN }));
  const t0 = Date.now();
  const r = await report("build_failed", {}, { file, timeoutMs: 200 });
  server.close();
  assert.equal(r.reason, "timeout"); assert.ok(Date.now() - t0 < 1500);
});

test("CLI: usage errors exit 2; events exit 0 even when Kibo is not running", () => {
  const env = { ...process.env, KIBO_IPC_FILE: "/nonexistent/ipc.json" };
  assert.equal(spawnSync(process.execPath, [SCRIPT], { env }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "explode"], { env }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "build-failed", "--source", "bad source"], { env }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "build-failed"], { env }).status, 0);
});

test("CLI run: passes through exit codes, reports start + outcome, and never sends the command line", async () => {
  const k = await mockKibo();
  const env = { ...process.env, KIBO_IPC_FILE: k.file };
  const ok = await run(["run", "--source", "test", "--", process.execPath, "-e", "process.exit(0)"], env);
  const bad = await run(["run", "--no-start", "--", process.execPath, "-e", "process.stderr.write('SECRET-OUTPUT'); process.exit(3)"], env);
  k.close();
  assert.equal(ok.status, 0); assert.equal(bad.status, 3);
  assert.equal(bad.stderr.includes("SECRET-OUTPUT"), true);            // output still reaches the terminal
  assert.match(k.received[0], /^KIBO\/1 t+ build_started source=test$/);
  assert.match(k.received[1], /^KIBO\/1 t+ build_succeeded duration=\d+ source=test$/);
  assert.match(k.received[2], /^KIBO\/1 t+ build_failed duration=\d+$/);
  assert.equal(k.received.length, 3);
  assert.equal(k.received.join("\n").includes("SECRET"), false);
  assert.equal(k.received.join("\n").includes("exit"), false);
});

test("CLI run: a command that cannot start fails the same way it would without Kibo", () => {
  const env = { ...process.env, KIBO_IPC_FILE: "/nonexistent/ipc.json" };
  assert.notEqual(spawnSync(process.execPath, [SCRIPT, "run", "--", "definitely-not-a-real-binary-xyz"], { env }).status, 0);
});
