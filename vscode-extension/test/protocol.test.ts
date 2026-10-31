import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { buildLine, EVENTS } from "../src/protocol";

test("buildLine produces the documented wire format", () => {
  assert.equal(buildLine("tok0123456789abcdef", "build_failed"), "KIBO/1 tok0123456789abcdef build_failed\n");
  assert.equal(buildLine("tok0123456789abcdef", "build_succeeded", { durationMs: 1200, source: "vscode" }), "KIBO/1 tok0123456789abcdef build_succeeded duration=1200 source=vscode\n");
});

test("buildLine refuses anything outside the whitelist or the field rules", () => {
  assert.throws(() => buildLine("t", "diagnostics_error"));
  assert.throws(() => buildLine("t", "build_failed", { durationMs: -1 }));
  assert.throws(() => buildLine("t", "build_failed", { durationMs: 1.5 }));
  assert.throws(() => buildLine("t", "build_failed", { durationMs: 86_400_001 }));
  assert.throws(() => buildLine("t", "build_failed", { source: "a b" }));
  assert.throws(() => buildLine("t", "build_failed", { source: "x".repeat(33) }));
  assert.throws(() => buildLine("t", "build_failed", { source: "a\nKIBO/1 x build_failed" }));
});

// Repo-only drift check: skipped (visibly) when the extension is built outside the Kibo repository.
const ipcRs = path.resolve(__dirname, "..", "..", "..", "src-tauri", "src", "ipc.rs");
test("EVENTS matches the whitelist in src-tauri/src/ipc.rs", { skip: fs.existsSync(ipcRs) ? false : "ipc.rs not found (extension built outside the Kibo repo)" }, () => {
  const src = fs.readFileSync(ipcRs, "utf8");
  const block = /const EVENTS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(src);
  assert.ok(block, "could not find EVENTS in ipc.rs");
  const rust = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...EVENTS], rust);
});
