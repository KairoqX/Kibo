// Test-only helpers (not shipped as part of the reporter). Mock Kibo listener = same wire rules as src-tauri/src/ipc.rs.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const TOKEN = "t".repeat(64);

/** A listener that accepts valid KIBO/1 lines like the Rust server does. `events()` returns them without the token. */
export function mockKibo() {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-mock-"));
    const file = path.join(dir, "ipc.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1, port: server.address().port, token: TOKEN }));
    res({
      file, received,
      events: () => received.map((l) => l.replace(/^KIBO\/1 t+ /, "")),
      close: () => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    });
  }));
}

/** process.env minus anything that would leak the outer npm / Kibo context into a test child. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_(lifecycle|package|execpath|node_execpath|command)/i.test(k) || /^KIBO_/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/** npm-cli.js of the Node installation running the tests (npm ships with Node). Throws instead of skipping. */
export function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),                 // Windows installer layout
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),    // Unix layout
  ];
  const found = candidates.find((c) => c && /npm-cli\.js$/i.test(c) && fs.existsSync(c));
  if (!found) throw new Error("npm-cli.js not found next to this Node.js; the npm integration tests need npm");
  return found;
}

/** Runs `npm <args>` in `cwd` asynchronously (the mock listener lives in this process, so the loop must stay free). */
export function runNpm(cwd, args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [npmCli(), ...args], { cwd, env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Temp project whose folder name contains a space (a common Windows situation). */
export function makeProject(scripts, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo proj "));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true, scripts }, null, 2));
  for (const [name, text] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, name), text);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const fwd = (p) => p.replace(/\\/g, "/");
