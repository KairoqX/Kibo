import { test } from "node:test";
import * as assert from "node:assert/strict";
import { discoveryPath, readDiscovery } from "../src/discovery";
import { tmpFile, TOKEN } from "./helpers";

test("discovery path follows the Kibo reporter conventions", () => {
  assert.equal(discoveryPath({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Local\\dev.kairoqx.kibo\\ipc.json");
  assert.equal(discoveryPath({}, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Local\\dev.kairoqx.kibo\\ipc.json");
  assert.equal(discoveryPath({}, "linux", "/home/a"), "/home/a/.local/share/dev.kairoqx.kibo/ipc.json");
  assert.equal(discoveryPath({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/dev.kairoqx.kibo/ipc.json");
  assert.equal(discoveryPath({ KIBO_IPC_FILE: "/x/y.json" }, "linux", "/h"), "/x/y.json");
});

test("valid discovery data is accepted", () => {
  const f = tmpFile(JSON.stringify({ v: 1, port: 4242, token: TOKEN }));
  try { assert.deepEqual(readDiscovery(f.file), { ok: true, info: { port: 4242, token: TOKEN } }); } finally { f.cleanup(); }
});

test("missing file means Kibo is not running", () => {
  assert.deepEqual(readDiscovery("/definitely/not/here/ipc.json"), { ok: false, reason: "not-running" });
});

const bad: Array<[string, string]> = [
  ["not json", "{nope"],
  ["json array", "[]"],
  ["null", "null"],
  ["wrong version", JSON.stringify({ v: 2, port: 1, token: TOKEN })],
  ["missing version", JSON.stringify({ port: 1000, token: TOKEN })],
  ["port as string", JSON.stringify({ v: 1, port: "1000", token: TOKEN })],
  ["port zero", JSON.stringify({ v: 1, port: 0, token: TOKEN })],
  ["port too large", JSON.stringify({ v: 1, port: 70000, token: TOKEN })],
  ["port fractional", JSON.stringify({ v: 1, port: 10.5, token: TOKEN })],
  ["token missing", JSON.stringify({ v: 1, port: 1000 })],
  ["token too short", JSON.stringify({ v: 1, port: 1000, token: "abc" })],
  ["token with whitespace (field injection)", JSON.stringify({ v: 1, port: 1000, token: TOKEN + " build_failed" })],
  ["token with newline", JSON.stringify({ v: 1, port: 1000, token: TOKEN + "\n" })],
  ["oversized file", JSON.stringify({ v: 1, port: 1000, token: TOKEN, pad: "x".repeat(5000) })],
];
for (const [name, content] of bad) {
  test(`invalid discovery rejected: ${name}`, () => {
    const f = tmpFile(content);
    try {
      const r = readDiscovery(f.file);
      assert.equal(r.ok, false);
      assert.equal((r as { reason: string }).reason, "invalid-discovery");
      assert.ok(!JSON.stringify(r).includes(TOKEN), "the result must never contain the token");
    } finally { f.cleanup(); }
  });
}

test("a host in the discovery file is ignored (only loopback is ever used)", () => {
  const f = tmpFile(JSON.stringify({ v: 1, port: 5000, token: TOKEN, host: "evil.example.com" }));
  try { const r = readDiscovery(f.file); assert.ok(r.ok); assert.ok(!("host" in (r as { info: object }).info)); } finally { f.cleanup(); }
});
