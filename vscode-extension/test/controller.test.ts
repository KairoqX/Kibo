import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Controller, explain } from "../src/controller";
import { KiboClient } from "../src/client";
import { mockKibo } from "./helpers";

function rig(opts: { enabled?: boolean; file: string }) {
  const msgs: string[] = []; let enabled = opts.enabled ?? true;
  const client = new KiboClient({ discoveryFile: () => opts.file });
  const c = new Controller({ client, reportingEnabled: () => enabled, setReporting: (on) => { enabled = on; }, ui: { info: (m) => msgs.push(`info:${m}`), warn: (m) => msgs.push(`warn:${m}`) } });
  return { c, msgs, isEnabled: () => enabled };
}

test("test commands map to the existing build events, tagged vscode", async () => {
  const m = await mockKibo();
  try {
    const r = rig({ file: m.file });
    await r.c.testHappy(); await r.c.testError();
    assert.deepEqual(m.lines, ["build_succeeded source=vscode", "build_failed source=vscode"]);
  } finally { await m.close(); }
});

test("Check Connection uses the invisible system_idle event", async () => {
  const m = await mockKibo();
  try { const r = rig({ file: m.file }); await r.c.checkConnection(); assert.deepEqual(m.lines, ["system_idle source=vscode"]); assert.match(r.msgs[0], /^info:Connected/); } finally { await m.close(); }
});

test("Kibo not running: one friendly warning, no exception", async () => {
  const r = rig({ file: "/no/ipc.json" });
  await r.c.checkConnection();
  assert.equal(r.msgs.length, 1); assert.match(r.msgs[0], /^warn:.*not seem to be running/);
});

test("disabled reporting: commands send nothing and say why", async () => {
  const m = await mockKibo();
  try {
    const r = rig({ file: m.file, enabled: false });
    await r.c.checkConnection(); await r.c.testHappy(); await r.c.testError();
    assert.equal(m.connections(), 0);
    assert.ok(r.msgs.every((x) => x.startsWith("warn:") && /disabled/.test(x)));
  } finally { await m.close(); }
});

test("enable / disable toggle the setting", async () => {
  const r = rig({ file: "/x" });
  await r.c.disable(); assert.equal(r.isEnabled(), false);
  await r.c.enable(); assert.equal(r.isEnabled(), true);
});

test("explain() never echoes unexpected reason text", () => {
  assert.match(explain("weird reason with token abc123"), /\(error\)/);
});
