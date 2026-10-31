import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import { KiboClient, type Status } from "../src/client";
import { FakeClock, mockKibo, tmpFile, TOKEN } from "./helpers";

test("sends an authenticated, whitelisted line to the mock listener", async () => {
  const m = await mockKibo();
  try {
    const c = new KiboClient({ discoveryFile: () => m.file });
    assert.deepEqual(await c.send("build_succeeded", { durationMs: 90, source: "vscode" }), { ok: true });
    assert.deepEqual(m.lines, ["build_succeeded duration=90 source=vscode"]);
    assert.ok(m.rawLines[0].startsWith(`KIBO/1 ${TOKEN} `));
  } finally { await m.close(); }
});

test("Kibo not running: no discovery file -> not-running, no connection attempted", async () => {
  const c = new KiboClient({ discoveryFile: () => "/no/such/ipc.json" });
  assert.deepEqual(await c.send("build_failed"), { ok: false, reason: "not-running" });
});

test("stale discovery (nothing listens on the port) -> not-running, never throws", async () => {
  const m = await mockKibo(); const file = m.file; await m.close();
  const f = tmpFile(JSON.stringify({ v: 1, port: 1, token: TOKEN }));   // port 1: nothing listens
  try {
    const r = await new KiboClient({ discoveryFile: () => f.file, timeoutMs: 500 }).send("build_failed");
    assert.equal(r.ok, false);
  } finally { f.cleanup(); assert.ok(!fs.existsSync(file)); }
});

test("invalid discovery -> invalid-discovery", async () => {
  const f = tmpFile("{broken");
  try { assert.deepEqual(await new KiboClient({ discoveryFile: () => f.file }).send("build_failed"), { ok: false, reason: "invalid-discovery" }); } finally { f.cleanup(); }
});

test("wrong token is reported as unauthorized (stale file) without leaking the token", async () => {
  const m = await mockKibo();
  const f = tmpFile(JSON.stringify({ v: 1, port: m.port, token: "x".repeat(64) }));
  try {
    const r = await new KiboClient({ discoveryFile: () => f.file }).send("build_failed");
    assert.deepEqual(r, { ok: false, reason: "unauthorized" });
    assert.ok(!JSON.stringify(r).includes("x".repeat(64)));
  } finally { f.cleanup(); await m.close(); }
});

test("an event outside the whitelist never reaches the socket", async () => {
  const m = await mockKibo();
  try {
    const r = await new KiboClient({ discoveryFile: () => m.file }).send("diagnostics_error");
    assert.deepEqual(r, { ok: false, reason: "invalid-event" });
    assert.equal(m.connections(), 0);
  } finally { await m.close(); }
});

test("listener that never answers -> timeout", async () => {
  const m = await mockKibo({ reply: () => null });
  try { assert.deepEqual(await new KiboClient({ discoveryFile: () => m.file, timeoutMs: 150 }).send("build_failed"), { ok: false, reason: "timeout" }); } finally { await m.close(); }
});

test("garbage reply is rejected", async () => {
  const m = await mockKibo({ reply: () => "HTTP/1.1 200 OK\n" });
  try { assert.deepEqual(await new KiboClient({ discoveryFile: () => m.file }).send("build_failed"), { ok: false, reason: "bad-reply" }); } finally { await m.close(); }
});

test("backoff: after a failure further events are skipped without touching the network, then retried", async () => {
  const clock = new FakeClock();
  const m = await mockKibo();
  let file = "/no/such/ipc.json";
  try {
    const c = new KiboClient({ discoveryFile: () => file, now: clock.now });
    assert.equal((await c.send("build_failed")).ok, false);
    assert.deepEqual(await c.send("build_failed"), { ok: false, reason: "backoff" });
    file = m.file;                                   // Kibo starts meanwhile
    assert.deepEqual(await c.send("build_failed"), { ok: false, reason: "backoff" });
    assert.equal(m.connections(), 0);
    clock.advance(2_001);
    assert.deepEqual(await c.send("build_failed"), { ok: true });   // rediscovered, new port/token picked up
    assert.equal(m.connections(), 1);
    assert.deepEqual(await c.send("build_succeeded"), { ok: true }); // backoff reset
  } finally { await m.close(); }
});

test("backoff grows exponentially (2 s, 4 s, ... ) and is capped at 60 s", async () => {
  const clock = new FakeClock();
  const c = new KiboClient({ discoveryFile: () => "/no/such/ipc.json", now: clock.now });
  await c.send("build_failed");                         // first real attempt fails -> backoff starts
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    let w = 0;
    for (;;) {                                          // one send per step; a non-"backoff" reason is the next real attempt
      clock.advance(250); w += 250;
      const r = await c.send("build_failed");
      if (!r.ok && r.reason !== "backoff") break;
    }
    waits.push(w);
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test("sendNow (commands) ignores the backoff", async () => {
  const clock = new FakeClock();
  const m = await mockKibo();
  let file = "/no/such/ipc.json";
  try {
    const c = new KiboClient({ discoveryFile: () => file, now: clock.now });
    await c.send("build_failed");
    file = m.file;
    assert.deepEqual(await c.sendNow("system_idle"), { ok: true });
  } finally { await m.close(); }
});

test("status callback fires only on changes (no log spam when Kibo is down)", async () => {
  const clock = new FakeClock(); const seen: string[] = [];
  const c = new KiboClient({ discoveryFile: () => "/no/such/ipc.json", now: clock.now, onStatus: (s: Status, r?: string) => seen.push(`${s}:${r ?? ""}`) });
  for (let i = 0; i < 5; i++) { await c.sendNow("build_failed"); }
  assert.deepEqual(seen, ["unavailable:not-running"]);
});

test("Kibo stopping mid-session: second send fails quietly, restart is picked up", async () => {
  const clock = new FakeClock();
  let m = await mockKibo();
  let file = m.file;
  const c = new KiboClient({ discoveryFile: () => file, now: clock.now });
  assert.deepEqual(await c.send("build_started"), { ok: true });
  await m.close(); file = "/gone/ipc.json";
  assert.equal((await c.send("build_failed")).ok, false);
  m = await mockKibo(); file = m.file; clock.advance(2_001);
  try { assert.deepEqual(await c.send("build_failed"), { ok: true }); } finally { await m.close(); }
});

test("a throwing status callback cannot break sending", async () => {
  const m = await mockKibo();
  try {
    const c = new KiboClient({ discoveryFile: () => m.file, onStatus: () => { throw new Error("log failure"); } });
    assert.deepEqual(await c.send("build_started"), { ok: true });
  } finally { await m.close(); }
});
